import { loadConfig, validatePatch } from "./config.mjs";
import {
  blockedBy,
  canAnalyze,
  cleanURL,
  documentKey,
  feedbackLookup,
  httpURL,
  makeDNR,
} from "./rules.mjs";
import { classify, probe } from "./ai.mjs";
import { resolveSearch } from "./search.mjs";

export class FocusEngine {
  constructor(api, enqueue, now = () => Date.now(), ai = classify) {
    this.api = api;
    this.enqueue = enqueue;
    this.now = now;
    this.ai = ai;
    this.runtime = {
      autoSessionId: "auto:" + crypto.randomUUID(),
      contextToken: null,
      active: null,
      observed: null,
      diagnostics: null,
      calls: [],
      lastAI: 0,
      judgment: null,
      cache: [],
      error: "",
      notice: "",
    };
    this.session = null;
    this.feedback = [];
    this.config = loadConfig();
    this.pending = null;
  }
  async init() {
    const [local, volatile] = await Promise.all([
      this.api.storage.local.get([
        "focusConfig",
        "focusSession",
        "focusFeedback",
      ]),
      this.api.storage.session.get("focusRuntime"),
    ]);
    this.config = loadConfig(local.focusConfig);
    this.session = local.focusSession || null;
    this.feedback = (local.focusFeedback || [])
      .filter((r) => r.created > this.now() - this.config.retentionDays * 864e5)
      .slice(-200);
    Object.assign(this.runtime, volatile.focusRuntime || {});
    if (
      typeof this.runtime.autoSessionId !== "string" ||
      !this.runtime.autoSessionId.startsWith("auto:")
    )
      this.runtime.autoSessionId = "auto:" + crypto.randomUUID();
    this.runtime.calls = Array.isArray(this.runtime.calls)
      ? this.runtime.calls.filter(
          (t) => Number.isFinite(t) && t > this.now() - 36e5 && t <= this.now()
        )
      : [];
    this.runtime.cache = Array.isArray(this.runtime.cache)
      ? this.runtime.cache.slice(0, 50)
      : [];
    if (
      !this.session ||
      typeof this.session.id !== "string" ||
      typeof this.session.goal !== "string" ||
      !Number.isFinite(this.session.ends)
    )
      this.session = null;
    this.api.idle.setDetectionInterval(this.config.idleSeconds);
    await this.syncRules();
    // Session DNR rules survive worker suspension. Reconcile them against their
    // leases after every wake so an interrupted write cannot leave an allow.
    const { focusPasses = [] } = await this.api.storage.session.get(
      "focusPasses"
    );
    const liveIds = new Set(
      focusPasses.filter((p) => p.until > this.now()).map((p) => p.ruleId)
    );
    const oldSessionRules =
      await this.api.declarativeNetRequest.getSessionRules();
    await this.api.declarativeNetRequest.updateSessionRules({
      removeRuleIds: oldSessionRules
        .filter((r) => !liveIds.has(r.id))
        .map((r) => r.id),
    });
    await this.api.alarms.create("focus-check", { periodInMinutes: 0.5 });
    // Startup can be caused by a read-only popup state request. Restore local
    // state without using the NAS; normal browser/alarm events run analysis.
    await this.reconcile({ analyze: false });
  }
  async saveRuntime() {
    await this.api.storage.session.set({ focusRuntime: this.runtime });
  }
  async syncRules() {
    const rules = makeDNR(this.config, this.api.runtime.getURL(""));
    for (const r of rules) {
      const supported = await this.api.declarativeNetRequest.isRegexSupported({
        regex: r.condition.regexFilter,
        isCaseSensitive: false,
      });
      if (!supported.isSupported)
        throw new Error("浏览器不支持此网址规则，请缩短路径");
    }
    const previous = await this.api.declarativeNetRequest.getDynamicRules();
    await this.api.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: previous.map((r) => r.id),
      addRules: rules,
    });
  }
  cancelPending() {
    this.pending?.controller.abort();
    this.pending = null;
  }
  effectiveContext() {
    if (this.session?.ends > this.now())
      return { mode: "task", id: this.session.id, goal: this.session.goal };
    if (this.config.autoClassify)
      return { mode: "auto", id: this.runtime.autoSessionId, goal: "" };
    return null;
  }
  contextKey(context, url, title) {
    // Remembered feedback may apply to the same task text in a later session,
    // but automatic work/learning judgments never share the task key space.
    return documentKey(
      JSON.stringify([context.mode, context.goal]),
      url,
      title
    );
  }
  matchesContext(row, context = this.effectiveContext()) {
    if (!row || !context) return false;
    return row.contextId
      ? row.contextId === context.id && row.mode === context.mode
      : context.mode === "task" && row.sessionId === context.id;
  }
  classificationStatus() {
    const context = this.effectiveContext(),
      active = this.runtime.active,
      now = this.now();
    const base = { mode: context?.mode || "off" };
    const status = (code, message, waitSeconds) => ({
      ...base,
      code,
      message,
      ...(waitSeconds
        ? { waitSeconds: Math.max(1, Math.ceil(waitSeconds)) }
        : {}),
    });
    if (!this.config.aiEnabled)
      return status("disabled", "AI 内容判断已关闭，网址规则仍生效。");
    if (!context)
      return status(
        "waiting-task",
        "自动判断已关闭；开始研究任务后才判断网页内容。"
      );
    if (!active)
      return status("no-page", "仅判断前台、非无痕且处于活跃状态的网页。");
    if (!canAnalyze(active.url, this.config))
      return status(
        "excluded",
        "此页面属于搜索结果、隐私页面或未选择的网站，不发送给 AI。"
      );
    if (this.pending)
      return status(
        "checking",
        context.mode === "auto"
          ? "正在判断工作学习或娱乐用途…"
          : "正在结合研究目标判断当前网页…"
      );
    if (this.runtime.error)
      return status(
        "error",
        "AI 连接失败，当前网页保持开放；请检查下方错误与连接设置。"
      );
    const key = this.contextKey(context, active.url, active.title);
    if (this.runtime.judgment?.key === key)
      return status("judged", "已判断当前网页；可纠正结果。");
    const dwell = this.config.dwellSeconds - (now - active.since) / 1000;
    if (dwell > 0)
      return status(
        "dwelling",
        "停留片刻后自动判断；手动检查仍遵守 NAS 请求限额。",
        dwell
      );
    const calls = this.runtime.calls.filter((t) => now - t < 36e5);
    if (calls.length >= this.config.requestsPerHour)
      return status(
        "hour-limit",
        "本小时 AI 请求额度已用完，当前网页保持开放。",
        (Math.min(...calls) + 36e5 - now) / 1000
      );
    const interval =
      this.config.intervalSeconds - (now - this.runtime.lastAI) / 1000;
    if (interval > 0)
      return status(
        "interval",
        "正在等待 NAS 请求间隔，当前网页暂时保持开放。",
        interval
      );
    return status(
      "ready",
      context.mode === "auto"
        ? "自动识别工作学习与娱乐，等待下一次检查。"
        : "等待下一次研究内容检查。"
    );
  }
  async tabRemoved(tabId) {
    const { focusPasses = [] } = await this.api.storage.session.get(
      "focusPasses"
    );
    const removed = focusPasses.filter((p) => p.tabId === tabId);
    if (removed.length) {
      await this.api.declarativeNetRequest.updateSessionRules({
        removeRuleIds: removed.map((p) => p.ruleId),
      });
      await this.api.storage.session.set({
        focusPasses: focusPasses.filter((p) => p.tabId !== tabId),
      });
    }
    await this.api.storage.session.remove("aiBlock:" + tabId);
    await this.reconcile();
  }
  async aiBlock(tabId, raw) {
    const context = this.effectiveContext();
    if (
      !context ||
      !this.config.aiEnabled ||
      this.config.aiAction !== "block" ||
      !canAnalyze(raw, this.config)
    )
      return null;
    const key = "aiBlock:" + tabId;
    const row = (await this.api.storage.session.get(key))[key];
    if (!row || row.url !== raw || !this.matchesContext(row, context))
      return null;
    const correction = feedbackLookup(
      this.feedback,
      this.contextKey(context, row.url, row.title || ""),
      context.id,
      this.config,
      this.now()
    );
    return correction?.label === "related" ? null : row;
  }
  async maintenance() {
    const now = this.now();
    const context = this.effectiveContext();
    const token = context ? JSON.stringify([context.mode, context.id]) : null;
    if (this.runtime.contextToken !== token) {
      this.cancelPending();
      this.runtime.judgment = null;
      this.runtime.contextToken = token;
      await this.api.action.setBadgeText({ text: "" });
    }
    if (!this.config.aiEnabled) {
      this.cancelPending();
      this.runtime.judgment = null;
      await this.api.action.setBadgeText({ text: "" });
    }
    await this.expirePasses();
    if (this.session?.ends <= now && !this.session.notified) {
      this.cancelPending();
      this.runtime.judgment = null;
      this.session.notified = true;
      await this.api.storage.local.set({ focusSession: this.session });
      this.runtime.notice = this.config.autoClassify
        ? "这次研究计时结束，资料页会保留；自动工作学习与娱乐判断继续运行。"
        : "这次研究时间到了。可以继续研究、续时，或结束任务，资料页会保留。";
      await this.notify("研究计时结束", this.runtime.notice);
    }
    const { focusPasses = [] } = await this.api.storage.session.get(
      "focusPasses"
    );
    const deadlines = focusPasses.map((p) => p.until).filter((t) => t > now);
    if (this.session?.ends > now) deadlines.push(this.session.ends);
    if (deadlines.length)
      await this.api.alarms.create("focus-expiry", {
        when: Math.min(...deadlines),
      });
    else await this.api.alarms.clear("focus-expiry");
  }
  async foreground() {
    const diagnostics = {
      code: "checking",
      message: "正在读取当前普通浏览器窗口。",
      windowId: null,
      windowFocused: null,
      idleState: null,
      tabId: null,
      hasURL: false,
      checkedAt: this.now(),
      eligible: false,
    };
    const finish = (code, message, tab = null) => {
      this.runtime.diagnostics = {
        ...diagnostics,
        code,
        message,
        eligible: code === "ready",
      };
      this.runtime.observed = tab
        ? { url: cleanURL(tab.url), title: (tab.title || "").slice(0, 300) }
        : null;
      return code === "ready" ? tab : null;
    };
    let stage = "window";
    try {
      // The API otherwise includes popup browser windows. An extension/tool
      // popup is not a replacement for the user's normal browsing window.
      const win = await this.api.windows.getLastFocused({
        windowTypes: ["normal"],
      });
      if (!win || !Number.isInteger(win.id))
        return finish(
          "no-window",
          "没有找到普通浏览器窗口。请在普通窗口打开网页。"
        );
      diagnostics.windowId = win.id;
      diagnostics.windowFocused = win.focused === true;
      if (win.incognito)
        return finish(
          "incognito",
          "无痕窗口不参与内容判断，也不读取页面信息。"
        );
      if (win.type && win.type !== "normal")
        return finish(
          "unsupported-window",
          "当前返回的是弹出式或工具窗口，尚未取得普通网页。"
        );
      stage = "tabs";
      const tabs = await this.api.tabs.query({
        active: true,
        windowId: win.id,
      });
      const tab = Array.isArray(tabs) ? tabs[0] : null;
      if (!tab)
        return finish(
          "no-tab",
          "普通窗口未返回当前标签页。请切换到网页后重新打开面板。"
        );
      diagnostics.tabId = Number.isInteger(tab.id) ? tab.id : null;
      if (tab.incognito)
        return finish(
          "incognito",
          "无痕标签页不参与内容判断，也不读取页面信息。"
        );
      diagnostics.hasURL = typeof tab.url === "string" && !!tab.url;
      if (!diagnostics.hasURL)
        return finish(
          "missing-url",
          "浏览器没有返回当前标签页网址。请检查扩展的网站访问权限，并刷新网页。"
        );
      if (!httpURL(tab.url))
        return finish(
          "unsupported-page",
          "当前是新标签页、扩展设置或浏览器内部页面；请在普通网页中打开工具栏面板。"
        );
      if (!Number.isInteger(tab.id))
        return finish(
          "missing-tab-id",
          "浏览器未返回有效标签页编号，暂时不能检查此页面。"
        );
      stage = "idle";
      diagnostics.idleState = await this.api.idle.queryState(
        this.config.idleSeconds
      );
      if (!diagnostics.windowFocused)
        return finish(
          "unfocused",
          "已找到最近普通窗口的网页，但该窗口当前没有焦点；回到网页后才自动判断。",
          tab
        );
      if (diagnostics.idleState !== "active")
        return finish(
          "idle",
          diagnostics.idleState === "locked"
            ? "电脑处于锁定状态，暂不判断网页。"
            : "浏览器检测到电脑暂时空闲；回到网页操作后继续判断。",
          tab
        );
      return finish(
        "ready",
        "已取得当前普通窗口网页，满足前台与活跃条件。",
        tab
      );
    } catch {
      // Do not persist an API exception that might embed a page URL or other
      // sensitive data. The failing API stage remains explicit and actionable.
      return finish(
        "api-error",
        `读取${
          { window: "普通窗口", tabs: "当前标签页", idle: "电脑活跃状态" }[
            stage
          ]
        }失败（${stage} API）。请重新加载扩展后再试。`
      );
    }
  }
  updateActive(tab) {
    if (!tab) {
      this.cancelPending();
      this.runtime.active = null;
      this.runtime.judgment = null;
      return;
    }
    const identity = JSON.stringify([tab.id, tab.url, tab.title || ""]);
    if (this.runtime.active?.identity !== identity) {
      this.cancelPending();
      this.runtime.judgment = null;
      this.runtime.active = {
        identity,
        tabId: tab.id,
        url: tab.url,
        title: (tab.title || "").slice(0, 300),
        since: this.now(),
      };
    }
  }
  async refreshCurrentPage() {
    // Deliberately no saveRuntime: popup polling plus storage.onChanged would
    // otherwise form a read -> write -> read loop. No AI or navigation here.
    const tab = await this.foreground();
    this.updateActive(tab);
  }
  async reconcile({ analyze = true } = {}) {
    const now = this.now();
    // Expiry enforcement must also run when Chrome is unfocused, idle, or the
    // foreground is an extension/new-tab page.
    await this.maintenance();
    let tab;
    try {
      tab = await this.foreground();
    } catch {
      tab = null;
    }
    const old = this.runtime.active;
    if (!tab) {
      this.cancelPending();
      this.runtime.active = null;
      this.runtime.judgment = null;
      await this.api.action.setBadgeText({ text: "" });
      await this.saveRuntime();
      return;
    }
    // Exact-page passes are session rules, never whole-site exceptions.
    const pass = await this.currentPass(tab.id, tab.url);
    const block = blockedBy(tab.url, this.config);
    const aiBlock = await this.aiBlock(tab.id, tab.url);
    if ((block || aiBlock) && !pass) {
      this.cancelPending();
      this.runtime.active = null;
      this.runtime.judgment = null;
      await this.api.tabs.update(tab.id, {
        url:
          this.api.runtime.getURL("blocked.html") +
          (aiBlock ? "#ai" : "#url=" + encodeURIComponent(tab.url)),
      });
      await this.saveRuntime();
      return;
    }
    const identity = JSON.stringify([tab.id, tab.url, tab.title || ""]);
    if (old?.identity !== identity) {
      this.cancelPending();
      this.runtime.judgment = null;
      this.runtime.active = {
        identity,
        tabId: tab.id,
        url: tab.url,
        title: (tab.title || "").slice(0, 300),
        since: now,
      };
      await this.api.action.setBadgeText({ text: "" });
    }
    if (analyze) this.maybeAI();
    await this.saveRuntime();
  }
  async currentPass(tabId, raw) {
    const { focusPasses = [] } = await this.api.storage.session.get(
      "focusPasses"
    );
    return focusPasses.some(
      (p) => p.tabId === tabId && p.url === raw && p.until > this.now()
    );
  }
  async expirePasses() {
    const { focusPasses = [] } = await this.api.storage.session.get(
      "focusPasses"
    );
    const keep = [];
    for (const pass of focusPasses) {
      if (pass.until > this.now()) {
        keep.push(pass);
        continue;
      }
      await this.api.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [pass.ruleId],
      });
      try {
        const tab = await this.api.tabs.get(pass.tabId);
        if (tab.url === pass.url) {
          const aiBlock = await this.aiBlock(tab.id, tab.url);
          if (blockedBy(tab.url, this.config) || aiBlock)
            await this.api.tabs.update(tab.id, {
              url:
                this.api.runtime.getURL("blocked.html") +
                (aiBlock ? "#ai" : "#url=" + encodeURIComponent(tab.url)),
            });
        }
      } catch {
        /* closed tab */
      }
    }
    if (keep.length !== focusPasses.length)
      await this.api.storage.session.set({ focusPasses: keep });
  }
  async contextIsCurrent(context, active) {
    const current = this.effectiveContext();
    if (!current || current.id !== context.id || current.mode !== context.mode)
      return false;
    let tab;
    try {
      tab = await this.foreground();
    } catch {
      return false;
    }
    return (
      !!tab &&
      JSON.stringify([tab.id, tab.url, tab.title || ""]) === active.identity
    );
  }
  async applyJudgment(result, active, context, key, notify = true) {
    await this.api.action.setBadgeBackgroundColor({
      color: result.label === "unrelated" ? "#b76725" : "#386e59",
    });
    await this.api.action.setBadgeText({
      text: {
        related: context.mode === "auto" ? "学" : "研",
        unrelated: context.mode === "auto" ? "娱" : "偏",
        uncertain: "?",
      }[result.label],
    });
    if (
      result.label !== "unrelated" ||
      result.confidence < this.config.threshold
    )
      return;
    if (notify)
      await this.notify(
        context.mode === "auto"
          ? "这一页可能属于娱乐消遣"
          : "这一页可能偏离了研究目标或属于娱乐",
        result.reason
      );
    if (
      this.config.aiEnabled &&
      this.config.aiAction === "block" &&
      !(await this.currentPass(active.tabId, active.url))
    ) {
      await this.api.storage.session.set({
        ["aiBlock:" + active.tabId]: {
          url: active.url,
          title: active.title,
          reason: result.reason,
          key,
          sessionId: context.id,
          contextId: context.id,
          mode: context.mode,
          source: result.source || "ai",
        },
      });
      await this.api.tabs.update(active.tabId, {
        url: this.api.runtime.getURL("blocked.html") + "#ai",
      });
    }
  }
  reuseJudgment(result, active, context) {
    this.runtime.judgment = result;
    // Reusing a result must preserve enforcement on a later visit/new tab, not
    // silently turn cached entertainment into an allowed page.
    this.enqueue(async () => {
      if (!(await this.contextIsCurrent(context, active))) return;
      await this.applyJudgment(result, active, context, result.key, false);
      await this.saveRuntime();
    });
  }
  maybeAI(force = false) {
    const now = this.now(),
      active = this.runtime.active,
      context = this.effectiveContext();
    this.runtime.calls = this.runtime.calls.filter((t) => now - t < 36e5);
    if (
      !active ||
      !context ||
      !this.config.aiEnabled ||
      !canAnalyze(active.url, this.config)
    )
      return;
    if (
      (!force && now - active.since < this.config.dwellSeconds * 1000) ||
      this.pending
    )
      return;
    const key = this.contextKey(context, active.url, active.title);
    const correction = feedbackLookup(
      this.feedback,
      key,
      context.id,
      this.config,
      now
    );
    if (correction) {
      this.reuseJudgment(
        {
          label: correction.label,
          confidence: 1,
          reason:
            context.mode === "auto"
              ? "采用你对此页面工作学习用途的纠正"
              : "采用你对此任务和此页面的纠正",
          source: "human",
          mode: context.mode,
          key,
          created: now,
        },
        active,
        context
      );
      return;
    }
    const cached = this.runtime.cache.find(
      (r) => r.key === key && now - r.created < this.config.cacheMinutes * 6e4
    );
    if (cached && !force) {
      this.reuseJudgment(cached, active, context);
      return;
    }
    // Manual checks also respect NAS budget; no unbounded button bypass.
    if (
      now - this.runtime.lastAI < this.config.intervalSeconds * 1000 ||
      this.runtime.calls.length >= this.config.requestsPerHour
    )
      return;
    this.runtime.lastAI = now;
    this.runtime.calls.push(now);
    this.runtime.error = "";
    const controller = new AbortController(),
      pending = {
        controller,
        identity: active.identity,
        key,
        contextId: context.id,
        mode: context.mode,
      };
    this.pending = pending;
    const config = structuredClone(this.config);
    const timeout = setTimeout(() => controller.abort(), 25000);
    this.readAndClassify(config, context, active, controller.signal)
      .then((result) =>
        this.enqueue(async () => {
          if (!(await this.isCurrent(pending))) return;
          this.runtime.judgment = {
            ...result,
            key,
            mode: context.mode,
            created: this.now(),
          };
          this.runtime.cache = [
            this.runtime.judgment,
            ...this.runtime.cache.filter((r) => r.key !== key),
          ].slice(0, 50);
          await this.applyJudgment(result, active, context, key);
          await this.saveRuntime();
        })
      )
      .catch((error) =>
        this.enqueue(async () => {
          if (!(await this.isCurrent(pending))) return;
          this.runtime.error =
            error.name === "AbortError"
              ? "AI 请求已超时；资料页保持开放，网址规则继续生效。"
              : "AI 暂不可用，当前网页保持开放：" +
                String(error.message || error).slice(0, 160);
          this.runtime.judgment = null;
          await this.saveRuntime();
        })
      )
      .finally(() => {
        clearTimeout(timeout);
        if (this.pending === pending) this.pending = null;
      });
  }
  async isCurrent(pending) {
    const context = this.effectiveContext();
    if (
      this.pending !== pending ||
      !context ||
      context.id !== pending.contextId ||
      context.mode !== pending.mode
    )
      return false;
    return this.contextIsCurrent(context, pending);
  }
  async readAndClassify(config, goal, active, signal) {
    let page = {
      url: active.url,
      title: active.title,
      excerpt: "",
      method: "metadata",
    };
    if (config.contentMode === "summary") {
      try {
        await this.api.scripting.executeScript({
          target: { tabId: active.tabId },
          files: ["extractor.js"],
        });
        const [row] = await this.api.scripting.executeScript({
          target: { tabId: active.tabId },
          func: (max) => globalThis.__focusTabExtract(max),
          args: [config.excerptChars],
        });
        if (row?.result?.url !== active.url) throw new Error("页面已切换");
        page = row.result;
      } catch (error) {
        if (error.message === "页面已切换") throw error;
        // Restricted pages/injection errors don't imply unrelated content.
      }
    }
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const result = await this.ai(config, goal, page, signal);
    return {
      ...result,
      input: {
        title: page.title,
        url: cleanURL(page.url),
        method: page.method,
        excerptLength: page.excerpt?.length || 0,
      },
    };
  }
  async notify(title, message) {
    try {
      await this.api.notifications.create("focus-notice", {
        type: "basic",
        iconUrl: "icons/icon-128.png",
        title,
        message,
      });
    } catch {
      /* A denied OS notification must not interrupt enforcement. */
    }
  }
  async snapshot() {
    const active = this.runtime.active;
    return {
      config: this.config,
      session: this.session,
      status: this.classificationStatus(),
      current:
        this.runtime.observed ||
        (active ? { url: cleanURL(active.url), title: active.title } : null),
      diagnostics: this.runtime.diagnostics,
      version: this.api.runtime.getManifest?.().version || "dev",
      judgment: this.runtime.judgment,
      error: this.runtime.error,
      notice: this.runtime.notice,
      calls: this.runtime.calls.length,
      feedback: this.feedback
        .filter((r) => r.active)
        .map(({ id, label, created, remember }) => ({
          id,
          label,
          created,
          remember,
        })),
      extensionOrigin: this.api.runtime.getURL("").replace(/\/$/, ""),
      checking: !!this.pending,
    };
  }
  async dispatch(message, sender) {
    if (
      !message ||
      typeof message.type !== "string" ||
      !message.type.startsWith("focus:") ||
      (message.payload !== undefined &&
        (!message.payload ||
          typeof message.payload !== "object" ||
          Array.isArray(message.payload)))
    )
      throw new Error("消息格式无效");
    if (JSON.stringify(message).length > 40000) throw new Error("消息过长");
    const { type, payload = {} } = message;
    if (type === "focus:state") {
      await this.refreshCurrentPage();
      return this.snapshot();
    }
    if (type === "focus:config") {
      const patch = validatePatch(payload);
      const before = this.config;
      this.config = { ...before, ...patch };
      try {
        await this.syncRules();
        await this.api.storage.local.set({ focusConfig: this.config });
      } catch (error) {
        this.config = before;
        await this.syncRules();
        throw error;
      }
      this.cancelPending();
      this.runtime.cache = [];
      this.runtime.judgment = null;
      this.runtime.error = "";
      this.api.idle.setDetectionInterval(this.config.idleSeconds);
      await this.reconcile();
      return this.snapshot();
    }
    if (type === "focus:start" || type === "focus:search") {
      if (type === "focus:start" && typeof payload.goal !== "string")
        throw new Error("请填写 1–200 字研究目标");
      let goal = String(payload.goal || "").trim(),
        target;
      if (type === "focus:search") {
        target = resolveSearch(payload.query || "");
        goal = target.goal;
      }
      if (!goal || goal.length > 200)
        throw new Error("请填写 1–200 字研究目标");
      const minutes = payload.minutes ?? this.config.sessionMinutes;
      validatePatch({ sessionMinutes: minutes });
      if (
        type === "focus:start" ||
        this.config.newTaskPerSearch ||
        !this.session ||
        this.session.ends <= this.now()
      ) {
        this.cancelPending();
        this.runtime.cache = [];
        this.runtime.judgment = null;
        this.runtime.notice = "";
        this.session = {
          id: crypto.randomUUID(),
          goal,
          started: this.now(),
          ends: this.now() + minutes * 6e4,
          notified: false,
        };
        await this.api.storage.local.set({ focusSession: this.session });
      }
      await this.saveRuntime();
      await this.maintenance();
      return target ? { url: target.url } : this.snapshot();
    }
    if (type === "focus:end") {
      this.cancelPending();
      this.session = null;
      this.runtime.judgment = null;
      this.runtime.notice = "";
      await this.api.storage.local.remove("focusSession");
      await this.maintenance();
      await this.saveRuntime();
      return this.snapshot();
    }
    if (type === "focus:extend") {
      if (!this.session) throw new Error("请先开始一次研究");
      if (this.session.ends <= this.now()) this.cancelPending();
      this.session.ends =
        Math.max(this.now(), this.session.ends) +
        this.config.extendMinutes * 6e4;
      this.session.notified = false;
      this.runtime.notice = "";
      await this.api.storage.local.set({ focusSession: this.session });
      await this.maintenance();
      return this.snapshot();
    }
    if (type === "focus:probe") return probe(this.config);
    if (type === "focus:check") {
      await this.reconcile();
      this.maybeAI(true);
      await this.saveRuntime();
      return this.snapshot();
    }
    if (type === "focus:feedback") {
      let a = this.runtime.active;
      const context = this.effectiveContext();
      if (payload.ai && Number.isInteger(sender.tab?.id)) {
        a = null;
        const key = "aiBlock:" + sender.tab.id;
        const row = (await this.api.storage.session.get(key))[key];
        if (this.matchesContext(row, context))
          a = { ...row, tabId: sender.tab.id };
      } else if (a) {
        const tab = await this.foreground();
        if (
          !tab ||
          JSON.stringify([tab.id, tab.url, tab.title || ""]) !== a.identity
        )
          a = null;
      }
      if (!a || !context || !canAnalyze(a.url, this.config))
        throw new Error("当前没有可纠正的内容页面");
      if (
        !["related", "unrelated", "uncertain"].includes(payload.label) ||
        typeof payload.remember !== "boolean"
      )
        throw new Error("反馈格式无效");
      const key = this.contextKey(context, a.url, a.title);
      this.cancelPending();
      this.runtime.cache = this.runtime.cache.filter((r) => r.key !== key);
      this.feedback.push({
        id: crypto.randomUUID(),
        key,
        label: payload.label,
        remember: payload.remember,
        sessionId: context.id,
        mode: context.mode,
        created: this.now(),
        active: true,
      });
      this.feedback = this.feedback
        .filter(
          (r) => r.created > this.now() - this.config.retentionDays * 864e5
        )
        .slice(-200);
      await this.api.storage.local.set({ focusFeedback: this.feedback });
      this.runtime.judgment = {
        label: payload.label,
        confidence: 1,
        reason:
          context.mode === "auto"
            ? "采用你对此页面工作学习用途的纠正"
            : "采用你对此任务和此页面的纠正",
        source: "human",
        mode: context.mode,
        key,
        created: this.now(),
      };
      if (
        payload.label === "unrelated" &&
        this.config.aiEnabled &&
        this.config.aiAction === "block" &&
        !(await this.currentPass(a.tabId, a.url))
      ) {
        await this.api.storage.session.set({
          ["aiBlock:" + a.tabId]: {
            url: a.url,
            title: a.title,
            reason:
              context.mode === "auto"
                ? "你已将此页面标记为娱乐消遣"
                : "你已将此页面标记为与当前研究无关",
            key,
            sessionId: context.id,
            contextId: context.id,
            mode: context.mode,
            source: "human",
          },
        });
        await this.api.tabs.update(a.tabId, {
          url: this.api.runtime.getURL("blocked.html") + "#ai",
        });
      }
      await this.saveRuntime();
      return this.snapshot();
    }
    if (type === "focus:undo") {
      const row = [...this.feedback].reverse().find((r) => r.active);
      if (row) row.active = false;
      this.runtime.cache = [];
      this.runtime.judgment = null;
      await this.api.storage.local.set({ focusFeedback: this.feedback });
      await this.saveRuntime();
      return this.snapshot();
    }
    if (type === "focus:clear") {
      this.cancelPending();
      this.feedback = [];
      this.runtime.cache = [];
      this.runtime.judgment = null;
      await this.api.storage.local.remove("focusFeedback");
      await this.saveRuntime();
      return this.snapshot();
    }
    if (type === "focus:blocked" || type === "focus:pass") {
      const tabId = sender.tab?.id;
      if (!Number.isInteger(tabId)) throw new Error("请在被拦截的标签页执行");
      let original = httpURL(payload.url)?.href;
      const stored = (await this.api.storage.session.get("aiBlock:" + tabId))[
        "aiBlock:" + tabId
      ];
      if (payload.ai) original = stored?.url;
      if (
        !original ||
        (payload.ai
          ? !this.matchesContext(stored)
          : !blockedBy(original, this.config))
      )
        throw new Error("没有可放行的页面");
      if (type === "focus:blocked")
        return {
          url: cleanURL(original),
          title: payload.ai ? stored.title : "",
          reason: payload.ai
            ? stored.reason
            : blockedBy(original, this.config)?.name,
          ai: !!payload.ai,
          source: payload.ai ? stored.source || "ai" : "rule",
          mode: payload.ai ? stored.mode || "task" : null,
          minutes: this.config.allowMinutes,
        };
      const { focusPasses = [] } = await this.api.storage.session.get(
        "focusPasses"
      );
      const ruleId = 100000 + tabId;
      // URL fragments never reach the network; matching them in a DNR regex
      // would make a seemingly granted pass fail on its first navigation.
      const networkURL = new URL(original);
      networkURL.hash = "";
      const exact =
        "^" + networkURL.href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$";
      const supported = await this.api.declarativeNetRequest.isRegexSupported({
        regex: exact,
        isCaseSensitive: true,
      });
      if (!supported.isSupported)
        throw new Error("网址太长，无法精确放行；请从检索页查找资料");
      await this.api.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [ruleId],
        addRules: [
          {
            id: ruleId,
            priority: 10,
            action: { type: "allow" },
            condition: {
              tabIds: [tabId],
              regexFilter: exact,
              isUrlFilterCaseSensitive: true,
              resourceTypes: ["main_frame"],
            },
          },
        ],
      });
      try {
        await this.api.storage.session.set({
          focusPasses: [
            ...focusPasses.filter((p) => p.tabId !== tabId),
            {
              tabId,
              ruleId,
              url: original,
              until: this.now() + this.config.allowMinutes * 6e4,
            },
          ],
        });
      } catch (error) {
        await this.api.declarativeNetRequest.updateSessionRules({
          removeRuleIds: [ruleId],
        });
        throw error;
      }
      await this.maintenance();
      await this.api.tabs.update(tabId, { url: original });
      return { ok: true };
    }
    throw new Error("不支持的操作");
  }
}

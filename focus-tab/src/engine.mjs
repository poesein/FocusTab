import { loadConfig, validatePatch } from "./config.mjs";
import {
  blockedBy,
  canAnalyze,
  explainAnalysisEligibility,
  cleanURL,
  documentKey,
  feedbackLookup,
  httpURL,
  makeDNR,
} from "./rules.mjs";
import { classify, probe } from "./ai.mjs";
import { resolveSearch } from "./search.mjs";
import {
  pageIdentity,
  samePageURL,
  semanticPageTitle,
  semanticPageURL,
} from "./page-identity.mjs";
import { applyInitialActionPreset } from "./deployment.mjs";
import {
  describePassBudget,
  normalizePassBudget,
  reservePass,
} from "./pass-budget.mjs";

export class FocusEngine {
  constructor(
    api,
    enqueue,
    now = () => Date.now(),
    ai = classify,
    timers = globalThis
  ) {
    this.api = api;
    this.enqueue = enqueue;
    this.now = now;
    this.ai = ai;
    this.timers = timers;
    this.aiTimer = null;
    this.aiTimerAt = null;
    this.aiAlarmAt = null;
    this.scheduleLoaded = false;
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
    this.passBudgetRecord = normalizePassBudget(null, this.now());
    this.pending = null;
    this.popupFocus = null;
    this.focusTransition = null;
    this.focusTimer = null;
    this.lastEngaged = null;
    this.currentCandidate = null;
  }
  async init() {
    const [stored, volatile] = await Promise.all([
      this.api.storage.local.get([
        "focusConfig",
        "focusSession",
        "focusFeedback",
        "focusPassBudget",
      ]),
      this.api.storage.session.get("focusRuntime"),
    ]);
    const local = await applyInitialActionPreset(this.api, stored);
    this.config = loadConfig(local.focusConfig);
    this.passBudgetRecord = normalizePassBudget(
      local.focusPassBudget,
      this.now()
    );
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
    // Maintenance reconciles native rules with their leases on every wake,
    // including orphan allows from a worker interrupted during a grant.
    const heartbeat = await this.api.alarms.get?.("focus-check");
    if (!heartbeat)
      await this.api.alarms.create("focus-check", { periodInMinutes: 0.5 });
    // Startup can be caused by a read-only popup state request. Restore local
    // state without using the NAS; normal browser/alarm events run analysis.
    await this.reconcile({ analyze: false });
  }
  async saveRuntime() {
    await this.syncAnalysisSchedule();
    await this.api.storage.session.set({ focusRuntime: this.runtime });
  }
  analysisPlan() {
    const now = this.now(),
      active = this.runtime.active;
    const context = this.effectiveContext();
    if (
      !active ||
      !context ||
      !this.config.aiEnabled ||
      this.pending ||
      !canAnalyze(active.url, this.config)
    )
      return null;
    const key = this.contextKey(context, active.url, active.title);
    const dwellAt = active.since + this.config.dwellSeconds * 1000;
    const correction = feedbackLookup(
      this.feedback,
      key,
      context.id,
      this.config,
      now
    );
    if (correction) {
      const applied =
        this.runtime.judgment?.key === key &&
        this.runtime.judgment.source === "human" &&
        this.runtime.judgment.label === correction.label;
      return {
        at: applied
          ? correction.created + this.config.retentionDays * 864e5
          : Math.max(now, dwellAt),
        reason: applied ? "feedback" : "dwelling",
      };
    }
    const cached = this.runtime.cache.find(
      (r) => r.key === key && now - r.created < this.config.cacheMinutes * 6e4
    );
    if (
      cached &&
      !(
        this.runtime.judgment?.key === key &&
        this.runtime.judgment.created === cached.created
      )
    ) {
      return { at: Math.max(now, dwellAt), reason: "dwelling" };
    }
    let at = Math.max(now, dwellAt),
      reason = "dwelling";
    if (cached) {
      at = Math.max(at, cached.created + this.config.cacheMinutes * 6e4);
      reason = "cache";
    }
    const intervalAt = this.runtime.lastAI + this.config.intervalSeconds * 1000;
    if (intervalAt > at) {
      at = intervalAt;
      reason = "interval";
    }
    const calls = this.runtime.calls
      .filter((t) => now - t < 36e5)
      .sort((a, b) => a - b);
    if (calls.length >= this.config.requestsPerHour) {
      const quotaAt = calls[calls.length - this.config.requestsPerHour] + 36e5;
      if (quotaAt > at) {
        at = quotaAt;
        reason = "hour-limit";
      }
    }
    return { at, reason };
  }
  async syncAnalysisSchedule() {
    if (!this.scheduleLoaded) {
      const existing = await this.api.alarms.get?.("focus-ai-deadline");
      this.aiAlarmAt = existing?.scheduledTime ?? null;
      this.scheduleLoaded = true;
    }
    const plan = this.analysisPlan();
    this.runtime.nextCheckAt = plan?.at ?? null;
    if (!plan) {
      if (this.aiTimer !== null) this.timers.clearTimeout(this.aiTimer);
      this.aiTimer = null;
      this.aiTimerAt = null;
      if (this.aiAlarmAt !== null)
        await this.api.alarms.clear("focus-ai-deadline");
      this.aiAlarmAt = null;
      return;
    }
    // Short timers meet dwell deadlines while the worker is naturally awake.
    // Long deadlines use alarms; no polling or calls to keep the worker alive.
    const delay = Math.max(1, plan.at - this.now());
    const timerAt = delay <= 25000 ? plan.at : null;
    if (this.aiTimerAt !== timerAt) {
      if (this.aiTimer !== null) this.timers.clearTimeout(this.aiTimer);
      this.aiTimer = null;
      this.aiTimerAt = timerAt;
      if (timerAt !== null) {
        this.aiTimer = this.timers.setTimeout(() => {
          this.aiTimer = null;
          this.aiTimerAt = null;
          this.enqueue(() => this.reconcile());
        }, delay);
        this.aiTimer?.unref?.();
      }
    }
    // A new worker restores this deadline from normal state calculation. Never
    // replace an identical native alarm on every heartbeat (that can delay it).
    if (this.aiAlarmAt !== plan.at) {
      const existing = await this.api.alarms.get?.("focus-ai-deadline");
      if (!existing || existing.scheduledTime !== plan.at)
        await this.api.alarms.create("focus-ai-deadline", { when: plan.at });
      this.aiAlarmAt = plan.at;
    }
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
  acceptUIFocus(message, sender) {
    if (
      sender.id !== this.api.runtime.id ||
      sender.url !== this.api.runtime.getURL("popup.html") ||
      (Number.isInteger(sender.frameId) && sender.frameId !== 0) ||
      ![
        "focus:state",
        "focus:check",
        "focus:feedback",
        "focus:ui-state",
      ].includes(message.type)
    )
      return false;
    const proof = message.uiFocus;
    if (
      !proof ||
      typeof proof.focused !== "boolean" ||
      typeof proof.visible !== "boolean"
    )
      return false;
    const now = this.now();
    if (proof.focused && proof.visible) {
      if (!Number.isInteger(proof.windowId) || proof.windowId < 0) return false;
      this.popupFocus = {
        windowId: proof.windowId,
        documentId: sender.documentId || null,
        receivedAt: now,
        until: now + 2500,
      };
      this.focusTransition = null;
      clearTimeout(this.focusTimer);
      return true;
    }
    // A late blur message from a previously closed popup cannot revoke a new
    // popup's proof. Never trust a timestamp supplied by the document itself.
    if (
      this.popupFocus?.documentId &&
      sender.documentId &&
      this.popupFocus.documentId !== sender.documentId
    )
      return false;
    if (
      this.popupFocus?.until > now &&
      this.lastEngaged?.windowId === this.popupFocus.windowId
    ) {
      this.focusTransition = { ...this.lastEngaged, until: now + 1000 };
      clearTimeout(this.focusTimer);
      this.focusTimer = setTimeout(() => {
        this.enqueue(() => this.refreshCurrentPage());
      }, 1010);
      this.focusTimer?.unref?.();
    }
    this.popupFocus = null;
    return true;
  }
  sameFocusTransition(tab = this.currentCandidate) {
    const transition = this.focusTransition;
    return (
      !!tab &&
      transition?.until > this.now() &&
      transition.windowId === tab.windowId &&
      transition.identity === pageIdentity(tab) &&
      this.runtime.diagnostics?.idleState === "active" &&
      canAnalyze(tab.url, this.config)
    );
  }
  preservePendingDuringTransition() {
    const context = this.effectiveContext();
    return (
      !!this.pending &&
      this.sameFocusTransition() &&
      this.pending.identity === this.focusTransition.identity &&
      this.pending.contextId === context?.id &&
      this.pending.mode === context?.mode
    );
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
      semanticPageURL(url),
      semanticPageTitle(title, url)
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
    const plan = this.analysisPlan();
    const base = {
      mode: context?.mode || "off",
      nextCheckAt: plan?.at ?? null,
      waitSeconds: plan ? Math.max(0, Math.ceil((plan.at - now) / 1000)) : 0,
    };
    const status = (code, message) => ({
      ...base,
      code,
      message,
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
    const eligibility = explainAnalysisEligibility(active.url, this.config);
    if (!eligibility.eligible)
      return {
        ...status("excluded", eligibility.message),
        exclusionCode: eligibility.code,
      };
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
    if (
      this.runtime.judgment?.key === key &&
      ["cache", "feedback"].includes(plan?.reason)
    )
      return status("judged", "已判断当前网页；可纠正结果。");
    if (plan?.at > now && plan.reason === "dwelling")
      return status(
        "dwelling",
        "停留片刻后自动判断；手动检查仍遵守 NAS 请求限额。"
      );
    if (plan?.at > now && plan.reason === "hour-limit")
      return status(
        "hour-limit",
        "本小时 AI 请求额度已用完，当前网页保持开放。"
      );
    if (plan?.at > now && plan.reason === "interval")
      return status(
        "interval",
        "正在等待 NAS 请求间隔，当前网页暂时保持开放。"
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
  async foreground({ allowTransition = false } = {}) {
    this.currentCandidate = null;
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
      popupFocused: false,
      focusSource: "none",
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
      this.currentCandidate = tab;
      stage = "idle";
      diagnostics.idleState = await this.api.idle.queryState(
        this.config.idleSeconds
      );
      diagnostics.popupFocused =
        this.popupFocus?.windowId === win.id &&
        this.popupFocus.until > this.now();
      diagnostics.focusSource = diagnostics.windowFocused
        ? "window"
        : diagnostics.popupFocused
        ? "popup"
        : "none";
      if (!diagnostics.windowFocused && !diagnostics.popupFocused) {
        // This grace can only finish an already-started same-page operation.
        // It is never used when deciding to send a new request to the NAS.
        if (
          allowTransition &&
          diagnostics.idleState === "active" &&
          this.focusTransition?.until > this.now() &&
          this.focusTransition.windowId === win.id &&
          this.focusTransition.identity === pageIdentity(tab) &&
          canAnalyze(tab.url, this.config)
        ) {
          diagnostics.focusSource = "transition";
          return finish(
            "ready",
            "弹窗关闭后的短暂焦点切换；仅保留同一网页的在途判断。",
            tab
          );
        }
        return finish(
          "unfocused",
          "已找到最近普通窗口的网页，但该窗口当前没有焦点；回到网页后才自动判断。",
          tab
        );
      }
      if (diagnostics.idleState !== "active")
        return finish(
          "idle",
          diagnostics.idleState === "locked"
            ? "电脑处于锁定状态，暂不判断网页。"
            : "浏览器检测到电脑暂时空闲；回到网页操作后继续判断。",
          tab
        );
      this.lastEngaged = {
        windowId: win.id,
        identity: pageIdentity(tab),
      };
      return finish(
        "ready",
        diagnostics.focusSource === "popup"
          ? "专注弹窗当前有焦点，已确认其所属普通窗口的当前网页。"
          : "已取得当前普通窗口网页，满足前台与活跃条件。",
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
    const identity = pageIdentity(tab);
    if (
      this.runtime.active?.identity !== identity &&
      (!this.runtime.active || pageIdentity(this.runtime.active) !== identity)
    ) {
      this.cancelPending();
      this.runtime.judgment = null;
      this.runtime.active = {
        identity,
        tabId: tab.id,
        url: tab.url,
        title: (tab.title || "").slice(0, 300),
        since: this.now(),
      };
    } else {
      // Tracking/branding changes do not reset dwell or cancel the semantic
      // document, but exact URL passes and any navigation retain the live URL.
      this.runtime.active.url = tab.url;
      this.runtime.active.title = (tab.title || "").slice(0, 300);
      this.runtime.active.identity = identity;
    }
  }
  async refreshCurrentPage() {
    // Deliberately no saveRuntime: popup polling plus storage.onChanged would
    // otherwise form a read -> write -> read loop. No AI or navigation here.
    const tab = await this.foreground();
    if (tab || !this.preservePendingDuringTransition()) this.updateActive(tab);
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
      if (this.preservePendingDuringTransition()) {
        await this.saveRuntime();
        return;
      }
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
    const changed = old?.identity !== pageIdentity(tab);
    this.updateActive(tab);
    if (changed) {
      await this.api.action.setBadgeText({ text: "" });
    }
    if (analyze) this.maybeAI();
    await this.saveRuntime();
  }
  async currentPass(tabId, raw) {
    if (!this.config.temporaryPassEnabled) return false;
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
    const keep = focusPasses.filter(
      (p) => this.config.temporaryPassEnabled && p.until > this.now()
    );
    const liveIds = new Set(keep.map((p) => p.ruleId));
    const rules = await this.api.declarativeNetRequest.getSessionRules();
    const revokedRules = rules.filter((rule) => !liveIds.has(rule.id));
    if (revokedRules.length)
      await this.api.declarativeNetRequest.updateSessionRules({
        removeRuleIds: revokedRules.map((rule) => rule.id),
      });
    const revoked = focusPasses.filter((p) => !keep.includes(p));
    // Native rules have no expiry of their own. Orphans must be removed even
    // without a recorded lease, and their already-open background pages checked.
    for (const rule of revokedRules) {
      for (const tabId of rule.condition?.tabIds || []) {
        if (!revoked.some((p) => p.tabId === tabId))
          revoked.push({ tabId, ruleId: rule.id, url: null, until: 0 });
      }
    }
    let navigationError;
    for (const pass of revoked) {
      let tab;
      try {
        tab = await this.api.tabs.get(pass.tabId);
      } catch {
        continue; // A closed tab needs no redirect or lease.
      }
      if (
        !this.config.temporaryPassEnabled ||
        !pass.url ||
        tab.url === pass.url
      ) {
        const aiBlock = await this.aiBlock(tab.id, tab.url);
        if (blockedBy(tab.url, this.config) || aiBlock) {
          try {
            await this.api.tabs.update(tab.id, {
              url:
                this.api.runtime.getURL("blocked.html") +
                (aiBlock ? "#ai" : "#url=" + encodeURIComponent(tab.url)),
            });
          } catch (error) {
            // The allow is already removed; retain only an expired retry lease
            // so a transient navigation failure also gets retried in background.
            keep.push({ ...pass, url: tab.url, until: 0 });
            navigationError = error;
          }
        }
      }
    }
    if (JSON.stringify(keep) !== JSON.stringify(focusPasses))
      await this.api.storage.session.set({ focusPasses: keep });
    if (navigationError) throw navigationError;
  }
  async contextIsCurrent(context, active, allowTransition = false) {
    const current = this.effectiveContext();
    if (!current || current.id !== context.id || current.mode !== context.mode)
      return false;
    let tab;
    try {
      tab = await this.foreground({ allowTransition });
    } catch {
      return false;
    }
    return !!tab && pageIdentity(tab) === active.identity;
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
    // A notification/badge API await can race navigation. Resolve the current
    // exact URL again before any enforcement, retaining precise pass scope.
    if (!(await this.contextIsCurrent(context, active, !!this.pending))) return;
    const target = this.currentCandidate;
    if (!target || !canAnalyze(target.url, this.config)) return;
    if (
      this.config.aiEnabled &&
      this.config.aiAction === "block" &&
      !(await this.currentPass(target.id, target.url))
    ) {
      await this.api.storage.session.set({
        ["aiBlock:" + target.id]: {
          url: target.url,
          title: target.title || "",
          reason: result.reason,
          key,
          sessionId: context.id,
          contextId: context.id,
          mode: context.mode,
          source: result.source || "ai",
        },
      });
      await this.api.tabs.update(target.id, {
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
      if (
        this.runtime.judgment?.key === key &&
        this.runtime.judgment.created === cached.created &&
        !(
          cached.label === "unrelated" &&
          cached.confidence >= this.config.threshold &&
          this.config.aiAction === "block"
        )
      )
        return;
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
          if (error.name === "FocusChangedError") return;
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
        this.enqueue(() => this.saveRuntime());
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
    return this.contextIsCurrent(context, pending, true);
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
        if (!row?.result || !samePageURL(row.result.url, active.url))
          throw new Error("页面已切换");
        page = row.result;
      } catch (error) {
        if (error.message === "页面已切换") throw error;
        // Restricted pages/injection errors don't imply unrelated content.
      }
    }
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    // Extraction may have raced a focus, tab, task or privacy change. Recheck
    // without transition grace before sending any newly captured page text.
    if (!(await this.contextIsCurrent(goal, active)))
      throw new DOMException("Page no longer active", "FocusChangedError");
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
  passBudget() {
    return describePassBudget(this.config, this.passBudgetRecord, this.now());
  }
  async grantPass(tabId, original, focusPasses) {
    if (!this.config.temporaryPassEnabled) throw new Error("临时放行已关闭。");
    const existing = focusPasses.find(
      (p) => p.tabId === tabId && p.url === original && p.until > this.now()
    );
    const ruleId = 100000 + tabId;
    // Fragments never reach the network; keep them in the lease and return URL.
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
    const rule = {
      id: ruleId,
      priority: 10,
      action: { type: "allow" },
      condition: {
        tabIds: [tabId],
        regexFilter: exact,
        isUrlFilterCaseSensitive: true,
        resourceTypes: ["main_frame"],
      },
    };
    if (existing) {
      // Restoring a lost native rule is safe: reuse the same bounded lease,
      // without charging again or extending its original deadline.
      await this.api.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [ruleId],
        addRules: [rule],
      });
      return { reused: true, until: existing.until };
    }
    const reservation = reservePass(
      this.config,
      this.passBudgetRecord,
      this.now()
    );
    const native = await this.api.declarativeNetRequest.getSessionRules();
    const previousRules = native.filter(
      (r) =>
        r.id === ruleId &&
        focusPasses.some((p) => p.ruleId === ruleId && p.until > this.now())
    );
    const lease = { tabId, ruleId, url: original, until: reservation.until };
    const nextPasses = [...focusPasses.filter((p) => p.tabId !== tabId), lease];
    // Reserve aggregate quota before installing an allow. The background queue
    // serializes all tabs, so a second grant observes this debit.
    try {
      await this.api.storage.local.set({ focusPassBudget: reservation.next });
    } catch (error) {
      // No allow has been installed. Recover a write whose response was lost,
      // so an API rejection alone cannot silently consume the daily allowance.
      try {
        const stored = (await this.api.storage.local.get("focusPassBudget"))
          .focusPassBudget;
        this.passBudgetRecord = normalizePassBudget(stored, this.now());
        if (JSON.stringify(stored) === JSON.stringify(reservation.next)) {
          await this.api.storage.local.set({
            focusPassBudget: reservation.previous,
          });
          this.passBudgetRecord = reservation.previous;
        }
      } catch {
        /* A storage failure is reported; no native allow exists. */
      }
      throw error;
    }
    this.passBudgetRecord = reservation.next;
    try {
      await this.api.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [ruleId],
        addRules: [rule],
      });
      await this.api.storage.session.set({ focusPasses: nextPasses });
    } catch (error) {
      let nativeRestored = false,
        sessionRestored = false;
      // A rejected API may have committed before the worker saw its response.
      // Verify rollback, rather than refunding while an allow might still live.
      for (let attempt = 0; attempt < 2 && !nativeRestored; attempt++) {
        try {
          await this.api.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [ruleId],
            addRules: previousRules,
          });
        } catch {
          /* Verify the actual rules even after a rejected call. */
        }
        try {
          nativeRestored =
            JSON.stringify(
              (await this.api.declarativeNetRequest.getSessionRules()).filter(
                (r) => r.id === ruleId
              )
            ) === JSON.stringify(previousRules);
        } catch {
          /* An unverified rollback must not refund quota. */
        }
      }
      if (nativeRestored) {
        for (let attempt = 0; attempt < 2 && !sessionRestored; attempt++) {
          try {
            const current =
              (await this.api.storage.session.get("focusPasses")).focusPasses ||
              [];
            if (JSON.stringify(current) !== JSON.stringify(focusPasses))
              await this.api.storage.session.set({ focusPasses });
            const restored =
              (await this.api.storage.session.get("focusPasses")).focusPasses ||
              [];
            sessionRestored =
              JSON.stringify(restored) === JSON.stringify(focusPasses);
          } catch {
            /* Retain the debit until rollback is verified. */
          }
        }
      }
      if (nativeRestored && sessionRestored) {
        try {
          await this.api.storage.local.set({
            focusPassBudget: reservation.previous,
          });
          this.passBudgetRecord = reservation.previous;
        } catch {
          throw new Error(
            error.message + "；放行已撤销，但额度恢复失败，请检查浏览器存储。"
          );
        }
      } else {
        // Keep any possibly-installed allow bounded by a recorded expiry and
        // an alarm. Maintenance also removes unregistered native rules.
        try {
          if (!nativeRestored)
            await this.api.storage.session.set({ focusPasses: nextPasses });
          await this.api.alarms.create("focus-expiry", { when: lease.until });
        } catch {
          /* The normal heartbeat and next worker wake retry cleanup. */
        }
        throw new Error(
          error.message + "；未能确认放行清理，已保留额度扣除并安排到期清理。"
        );
      }
      throw error;
    }
    return { reused: false, minutes: reservation.minutes, until: lease.until };
  }
  async snapshot() {
    const active = this.runtime.active;
    return {
      config: this.config,
      passBudget: this.passBudget(),
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
    const acceptedFocus = this.acceptUIFocus(message, sender);
    const { type, payload = {} } = message;
    if (type === "focus:ui-state") return { accepted: acceptedFocus };
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
        if (!tab || pageIdentity(tab) !== a.identity) a = null;
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
      const { focusPasses = [] } = await this.api.storage.session.get(
        "focusPasses"
      );
      const existing =
        this.config.temporaryPassEnabled &&
        focusPasses.find(
          (p) => p.tabId === tabId && p.url === original && p.until > this.now()
        );
      const passBudget = this.passBudget();
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
          passBudget,
          canPass: !!existing || passBudget.canGrant,
          minutes: existing ? 0 : passBudget.grantMinutes,
          until: existing ? existing.until : null,
        };
      const result = await this.grantPass(tabId, original, focusPasses);
      await this.maintenance();
      await this.api.tabs.update(tabId, { url: original });
      return { ok: true, ...result, passBudget: this.passBudget() };
    }
    throw new Error("不支持的操作");
  }
}

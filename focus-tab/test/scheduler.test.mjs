import test from "node:test";
import assert from "node:assert/strict";
import { FocusEngine } from "../src/engine.mjs";
import { chromeMock } from "./chrome-mock.mjs";
import { pageIdentity, semanticPageURL } from "../src/page-identity.mjs";

const related = {
  label: "related",
  confidence: 0.95,
  reason: "主动学习教程",
  source: "ai",
};
const unrelated = {
  label: "unrelated",
  confidence: 0.99,
  reason: "娱乐节目",
  source: "ai",
};
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};

async function scheduledFixture({
  ai,
  local,
  session,
  existing,
  now = 10_000_000,
} = {}) {
  const { api, state } = existing || chromeMock({ local, session });
  let instant = now,
    nextId = 0,
    queue = Promise.resolve();
  const timers = new Map(),
    alarmWrites = [];
  const timerAPI = {
    setTimeout(fn, delay) {
      const id = ++nextId;
      timers.set(id, { fn, when: instant + delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  api.alarms.get = async (name) => {
    const alarm = state.alarms.get(name);
    return alarm ? { name, ...alarm, scheduledTime: alarm.when } : undefined;
  };
  const create = api.alarms.create;
  api.alarms.create = async (name, info) => {
    alarmWrites.push({ name, ...info });
    return create(name, info);
  };
  const enqueue = (work) => {
    const task = queue.then(work);
    queue = task.catch(() => {});
    return task;
  };
  const flush = async () => {
    for (let i = 0; i < 12; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      await queue;
    }
  };
  const engine = new FocusEngine(
    api,
    enqueue,
    () => instant,
    ai || (async () => related),
    timerAPI
  );
  api.tabs.onUpdated.addListener(() => enqueue(() => engine.reconcile()));
  api.windows.onFocusChanged.addListener(() =>
    enqueue(() => engine.reconcile())
  );
  api.alarms.onAlarm.addListener((info) => {
    if (
      ["focus-check", "focus-expiry", "focus-ai-deadline"].includes(info.name)
    )
      enqueue(() => engine.reconcile());
  });
  await engine.init();
  return {
    api,
    state,
    engine,
    timers,
    alarmWrites,
    enqueue,
    flush,
    now: () => instant,
    jump: (ms) => {
      instant += ms;
    },
    async tick(ms) {
      const target = instant + ms;
      let count = 0;
      for (;;) {
        const due = [...timers]
          .filter(([, value]) => value.when <= target)
          .sort((a, b) => a[1].when - b[1].when)[0];
        if (!due) break;
        assert.ok(
          ++count < 100,
          "scheduler must not spin on an already-due deadline"
        );
        instant = due[1].when;
        timers.delete(due[0]);
        due[1].fn();
        await flush();
      }
      instant = target;
      await flush();
    },
    async tabEvent(patch) {
      Object.assign(state.tabs.get(1), patch);
      api.tabs.onUpdated.fire(1, { ...patch });
      await flush();
    },
    async alarm(name = "focus-ai-deadline") {
      state.alarms.delete(name);
      api.alarms.onAlarm.fire({ name });
      await flush();
    },
  };
}

test("a foreground page automatically classifies exactly at dwell without a popup or manual check", async () => {
  let calls = 0;
  const f = await scheduledFixture({
    ai: async () => {
      calls++;
      return unrelated;
    },
  });
  const start = f.now();
  assert.equal(f.engine.classificationStatus().nextCheckAt, start + 20000);
  assert.equal(f.state.alarms.get("focus-ai-deadline").when, start + 20000);
  await f.tick(19999);
  assert.equal(calls, 0);
  await f.tick(1);
  assert.equal(calls, 1);
  assert.ok(f.state.tabs.get(1).url.endsWith("blocked.html#ai"));
  assert.equal(f.engine.runtime.calls.length, 1);
});

test("the global interval dominates dwell and fires at its exact deadline without another 30-second rounding", async () => {
  let calls = 0;
  const f = await scheduledFixture({
    ai: async () => {
      calls++;
      return related;
    },
  });
  await f.tick(20000);
  assert.equal(calls, 1);
  await f.tabEvent({
    url: "https://www.bilibili.com/video/BVdifferent",
    title: "另一个教程",
  });
  const due = f.engine.runtime.lastAI + 90000;
  assert.equal(f.engine.classificationStatus().code, "interval");
  assert.equal(f.engine.classificationStatus().nextCheckAt, due);
  assert.equal(f.engine.classificationStatus().waitSeconds, 90);
  assert.equal(f.timers.size, 0, "long waits must not keep a timer alive");
  await f.tick(70000);
  await f.alarm("focus-check");
  assert.equal(f.engine.classificationStatus().waitSeconds, 20);
  await f.tick(19999);
  assert.equal(calls, 1);
  await f.tick(1);
  assert.equal(calls, 2);
  assert.equal(f.engine.config.intervalSeconds, 90);
});

test("hourly quota restoration uses the actual next legal request when the limit was lowered", async () => {
  const f = await scheduledFixture();
  const now = f.now();
  f.engine.config.requestsPerHour = 2;
  f.engine.runtime.calls = [
    now - 3000000,
    now - 2000000,
    now - 1000000,
    now - 100000,
  ];
  f.engine.runtime.lastAI = now - 100000;
  await f.engine.reconcile();
  const status = f.engine.classificationStatus();
  assert.equal(status.code, "hour-limit");
  assert.equal(status.nextCheckAt, now - 1000000 + 3600000);
  assert.equal(status.waitSeconds, 2600);
  assert.equal(f.timers.size, 0);
});

test("cached judgments schedule one cache-expiry check and never create a timer busy loop", async () => {
  let calls = 0;
  const f = await scheduledFixture({
    ai: async () => {
      calls++;
      return related;
    },
  });
  await f.tick(20000);
  const resultAt = f.engine.runtime.judgment.created;
  assert.equal(f.engine.classificationStatus().code, "judged");
  assert.equal(
    f.engine.classificationStatus().nextCheckAt,
    resultAt + 30 * 60000
  );
  assert.equal(f.timers.size, 0);
  const writes = f.alarmWrites.filter(
    (a) => a.name === "focus-ai-deadline"
  ).length;
  await f.tick(10000);
  await f.alarm("focus-check");
  assert.equal(calls, 1);
  assert.equal(
    f.alarmWrites.filter((a) => a.name === "focus-ai-deadline").length,
    writes
  );
});

test("tracking and explicit branding changes preserve dwell, while part and actual title changes restart it", async () => {
  let calls = 0;
  const f = await scheduledFixture({
    ai: async () => {
      calls++;
      return related;
    },
  });
  await f.tabEvent({
    url: "https://www.bilibili.com/video/BV123/?p=1&spm_id_from=old",
    title: "科研教程_哔哩哔哩_bilibili",
  });
  const since = f.engine.runtime.active.since;
  const key = f.engine.contextKey(
    f.engine.effectiveContext(),
    f.engine.runtime.active.url,
    f.engine.runtime.active.title
  );
  await f.tick(15000);
  await f.tabEvent({
    url: "https://www.bilibili.com/video/BV123?p=1&vd_source=changed&spm_id_from=new",
    title: "(3条消息) 科研教程 - bilibili",
  });
  assert.equal(f.engine.runtime.active.since, since);
  assert.equal(
    f.engine.contextKey(
      f.engine.effectiveContext(),
      f.engine.runtime.active.url,
      f.engine.runtime.active.title
    ),
    key
  );
  await f.tick(5000);
  assert.equal(calls, 1);
  await f.tabEvent({
    url: "https://www.bilibili.com/video/BV123/?p=2",
    title: "科研教程 - bilibili",
  });
  assert.equal(f.engine.runtime.active.since, f.now());
  const oldPart = f.engine.runtime.active.identity;
  await f.tabEvent({ title: "真正改变的内容标题 - bilibili" });
  assert.notEqual(f.engine.runtime.active.identity, oldPart);
  assert.notEqual(
    semanticPageURL("https://www.bilibili.com/video/BV123/?p=2&custom=one"),
    semanticPageURL("https://www.bilibili.com/video/BV123/?p=2&custom=two")
  );
  assert.notEqual(
    semanticPageURL("https://www.bilibili.com/video/BV123/?p=2&cid=1"),
    semanticPageURL("https://www.bilibili.com/video/BV123/?p=2&cid=2")
  );
  assert.equal(
    semanticPageURL("https://www.bilibili.com/video/BV123/?p=01"),
    semanticPageURL("https://www.bilibili.com/video/BV123/?p=1")
  );
});

test("an in-flight Bili judgment survives tracking changes and enforces the latest exact URL", async () => {
  const result = deferred();
  let calls = 0;
  const f = await scheduledFixture({
    ai: async () => {
      calls++;
      return result.promise;
    },
  });
  await f.tabEvent({
    url: "https://www.bilibili.com/video/BV123/?p=1&spm_id_from=old",
    title: "娱乐节目_哔哩哔哩_bilibili",
  });
  await f.tick(20000);
  const pending = f.engine.pending;
  const latest = "https://www.bilibili.com/video/BV123/?p=1&spm_id_from=new";
  await f.tabEvent({ url: latest, title: "娱乐节目 - bilibili" });
  assert.equal(f.engine.pending, pending);
  result.resolve(unrelated);
  await f.flush();
  assert.equal(calls, 1);
  assert.equal(f.api.storage.session.data["aiBlock:1"].url, latest);
  assert.ok(f.state.tabs.get(1).url.endsWith("blocked.html#ai"));
});

test("true video, part and unknown-document changes cancel old outcomes", async () => {
  for (const next of [
    "https://www.bilibili.com/video/BV456/?p=1",
    "https://www.bilibili.com/video/BV123/?p=2",
    "https://www.bilibili.com/video/BV123/?p=1&edition=other",
  ]) {
    const result = deferred();
    const f = await scheduledFixture({ ai: async () => result.promise });
    await f.tabEvent({
      url: "https://www.bilibili.com/video/BV123/?p=1",
      title: "视频",
    });
    await f.tick(20000);
    assert.ok(f.engine.pending);
    await f.tabEvent({ url: next });
    assert.equal(f.engine.pending, null);
    result.resolve(unrelated);
    await f.flush();
    assert.equal(f.state.updates.length, 0);
  }
});

test("a restarted worker restores its native deadline and does not postpone an existing heartbeat", async () => {
  const first = await scheduledFixture();
  await first.tick(10000);
  first.timers.clear();
  const deadline = first.state.alarms.get("focus-ai-deadline").when;
  const second = await scheduledFixture({
    existing: { api: first.api, state: first.state },
    now: first.now(),
  });
  assert.equal(second.engine.classificationStatus().nextCheckAt, deadline);
  assert.equal(
    second.alarmWrites.filter((a) => a.name === "focus-check").length,
    0
  );
  assert.equal(
    second.alarmWrites.filter((a) => a.name === "focus-ai-deadline").length,
    0
  );
  assert.ok([...second.timers.values()].some((t) => t.when === deadline));
});

test("native alarm fallback can finish automatic detection after a short timer was lost", async () => {
  let calls = 0;
  const f = await scheduledFixture({
    ai: async () => {
      calls++;
      return unrelated;
    },
  });
  f.timers.clear();
  f.jump(30000);
  await f.alarm();
  assert.equal(calls, 1);
  assert.ok(f.state.tabs.get(1).url.endsWith("blocked.html#ai"));
});

test("deadline callbacks recheck focus, idle and privacy instead of blindly classifying", async () => {
  for (const condition of ["unfocused", "idle", "private", "google"]) {
    let calls = 0;
    const f = await scheduledFixture({
      ai: async () => {
        calls++;
        return unrelated;
      },
    });
    await f.tick(19000);
    if (condition === "unfocused") f.state.window.focused = false;
    if (condition === "idle") f.state.idle = "idle";
    if (condition === "private")
      f.state.tabs.get(1).url = "https://message.bilibili.com/";
    if (condition === "google")
      f.state.tabs.get(1).url = "https://www.google.com/search?q=work";
    await f.tick(1000);
    assert.equal(calls, 0, condition);
    assert.equal(f.timers.size, 0, condition);
    assert.equal(f.engine.classificationStatus().nextCheckAt, null, condition);
  }
});

test("precise temporary passes still compare original URLs, not normalized tracking identities", async () => {
  const f = await scheduledFixture();
  const original = "https://tophub.today/?source=one";
  await f.engine.dispatch(
    { type: "focus:pass", payload: { url: original } },
    { tab: { id: 1 } }
  );
  assert.equal(await f.engine.currentPass(1, original), true);
  assert.equal(
    await f.engine.currentPass(1, "https://tophub.today/?source=two"),
    false
  );
  assert.notEqual(
    pageIdentity({
      id: 1,
      url: "https://www.bilibili.com/video/BV123/?p=1",
      title: "教程",
    }),
    pageIdentity({
      id: 1,
      url: "https://www.bilibili.com/video/BV123/?p=2",
      title: "教程",
    })
  );
});

test("a cached entertainment judgment cannot turn a precise temporary pass into a semantic URL exemption", async () => {
  let calls = 0;
  const f = await scheduledFixture({
    ai: async () => {
      calls++;
      return unrelated;
    },
  });
  await f.tick(20000);
  const original = f.api.storage.session.data["aiBlock:1"].url;
  await f.tabEvent({ url: f.state.tabs.get(1).url });
  await f.engine.dispatch(
    { type: "focus:pass", payload: { ai: true } },
    { tab: { id: 1 } }
  );
  await f.tabEvent({ url: original });
  await f.tick(20000);
  assert.equal(f.state.tabs.get(1).url, original);
  const changed = original + "?spm_id_from=tracking-change";
  await f.tabEvent({ url: changed });
  assert.equal(calls, 1);
  assert.equal(f.api.storage.session.data["aiBlock:1"].url, changed);
  assert.ok(f.state.tabs.get(1).url.endsWith("blocked.html#ai"));
});

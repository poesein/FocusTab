import { FocusEngine } from '../src/engine.mjs';

const clone = (value) => structuredClone(value);
function storageArea(seed = {}) {
  const data = clone(seed);
  return {
    data,
    async get(keys) {
      if (keys === null) return clone(data);
      const names =
        typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      return Object.fromEntries(
        names.filter((key) => Object.hasOwn(data, key)).map((key) => [key, clone(data[key])])
      );
    },
    async set(patch) {
      Object.assign(data, clone(patch));
    },
    async remove(keys) {
      for (const key of typeof keys === 'string' ? [keys] : keys) delete data[key];
    },
  };
}
export function event() {
  const listeners = [];
  return {
    listeners,
    addListener(fn) {
      listeners.push(fn);
    },
    fire(...args) {
      return listeners.map((fn) => fn(...args));
    },
  };
}
export function chromeMock({
  local = {},
  session = {},
  tabs = [
    {
      id: 1,
      windowId: 1,
      active: true,
      title: 'TrackMate 教程',
      url: 'https://www.bilibili.com/video/BVabc',
    },
  ],
} = {}) {
  const state = {
    tabs: new Map(tabs.map((tab) => [tab.id, clone(tab)])),
    window: { id: 1, focused: true, incognito: false },
    idle: 'active',
    updates: [],
    notices: [],
    badges: [],
    dynamic: [],
    sessionRules: [],
    alarms: new Map(),
  };
  const api = {
    runtime: {
      id: 'focus-test',
      getURL: (path) => 'chrome-extension://focus-test/' + path,
      onMessage: event(),
    },
    storage: { local: storageArea(local), session: storageArea(session) },
    windows: {
      async getLastFocused() {
        return clone(state.window);
      },
      onFocusChanged: event(),
    },
    idle: {
      setDetectionInterval(value) {
        state.idleSeconds = value;
      },
      async queryState() {
        return state.idle;
      },
      onStateChanged: event(),
    },
    tabs: {
      async query(filter) {
        return [...state.tabs.values()]
          .filter((tab) => tab.windowId === filter.windowId && (!filter.active || tab.active))
          .map(clone);
      },
      async get(id) {
        if (!state.tabs.has(id)) throw new Error('No tab');
        return clone(state.tabs.get(id));
      },
      async update(id, patch) {
        if (!state.tabs.has(id)) throw new Error('No tab');
        state.updates.push({ id, ...clone(patch) });
        Object.assign(state.tabs.get(id), clone(patch));
        return clone(state.tabs.get(id));
      },
      onActivated: event(),
      onUpdated: event(),
      onRemoved: event(),
    },
    alarms: {
      async create(name, opts) {
        state.alarms.set(name, clone(opts));
      },
      async clear(name) {
        return state.alarms.delete(name);
      },
      onAlarm: event(),
    },
    action: {
      async setBadgeText(value) {
        state.badges.push(clone(value));
      },
      async setBadgeBackgroundColor() {},
    },
    notifications: {
      async create(id, options) {
        state.notices.push({ id, ...clone(options) });
      },
    },
    declarativeNetRequest: {
      async isRegexSupported() {
        return { isSupported: true };
      },
      async getDynamicRules() {
        return clone(state.dynamic);
      },
      async updateDynamicRules({ removeRuleIds = [], addRules = [] }) {
        state.dynamic = [
          ...state.dynamic.filter((r) => !removeRuleIds.includes(r.id)),
          ...clone(addRules),
        ];
      },
      async getSessionRules() {
        return clone(state.sessionRules);
      },
      async updateSessionRules({ removeRuleIds = [], addRules = [] }) {
        state.sessionRules = [
          ...state.sessionRules.filter((r) => !removeRuleIds.includes(r.id)),
          ...clone(addRules),
        ];
      },
    },
    scripting: {
      async executeScript(request) {
        if (request.files) return [];
        const tab = state.tabs.get(request.target.tabId);
        return [
          {
            result: {
              url: tab.url,
              title: tab.title,
              excerpt: '单粒子追踪科研教程',
              method: 'readability',
            },
          },
        ];
      },
    },
    webNavigation: { onHistoryStateUpdated: event(), onReferenceFragmentUpdated: event() },
  };
  return { api, state };
}
export async function fixture(options = {}) {
  const { api, state } = chromeMock(options);
  let instant = 10_000_000;
  let queue = Promise.resolve();
  const enqueue = (work) => {
    const next = queue.then(work);
    queue = next.catch(() => {});
    return next;
  };
  const engine = new FocusEngine(api, enqueue, () => instant, options.ai);
  await engine.init();
  engine.config.aiEnabled = false;
  return {
    engine,
    api,
    state,
    enqueue,
    advance: (ms) => {
      instant += ms;
    },
    now: () => instant,
    async flush() {
      for (let i = 0; i < 6; i++) {
        await new Promise((resolve) => setImmediate(resolve));
        await queue;
      }
    },
    async start(goal = 'TrackMate 单粒子追踪', minutes = 5) {
      return engine.dispatch({ type: 'focus:start', payload: { goal, minutes } }, {});
    },
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { FocusEngine } from '../src/engine.mjs';
import { chromeMock, fixture } from './chrome-mock.mjs';

test('popup state selects normal windows explicitly and refreshes a page missed by tab events', async () => {
  let requests = 0;
  const f = await fixture({
    ai: async () => {
      requests++;
      return { label: 'unrelated', confidence: 0.99, reason: '娱乐' };
    },
  });
  let options;
  f.api.windows.getLastFocused = async (query) => {
    options = query;
    return query?.windowTypes?.includes('normal')
      ? { ...f.state.window, type: 'normal' }
      : { id: 99, type: 'popup', focused: true };
  };
  f.state.tabs.get(1).url = 'https://www.bilibili.com/video/new?private=secret';
  f.state.tabs.get(1).title = '刚刚打开的新视频';
  f.engine.config.aiEnabled = true;
  f.api.runtime.getManifest = () => ({ version: '0.1.2' });
  const data = await f.engine.dispatch({ type: 'focus:state' }, {});
  assert.deepEqual(options, { windowTypes: ['normal'] });
  assert.equal(data.current.url, 'https://www.bilibili.com/video/new');
  assert.equal(data.current.title, '刚刚打开的新视频');
  assert.equal(data.version, '0.1.2');
  assert.equal(data.diagnostics.code, 'ready');
  assert.equal(data.diagnostics.windowId, 1);
  assert.equal(data.diagnostics.windowFocused, true);
  assert.equal(data.diagnostics.idleState, 'active');
  assert.equal(data.diagnostics.tabId, 1);
  assert.equal(data.diagnostics.hasURL, true);
  assert.equal(data.diagnostics.eligible, true);
  assert.equal(data.diagnostics.checkedAt, f.now());
  assert.equal(requests, 0);
  assert.ok(!JSON.stringify(data.diagnostics).includes('private=secret'));
});

test('state polling never writes storage, changes badges, navigates, or consumes NAS budget', async () => {
  let requests = 0;
  const f = await fixture({
    ai: async () => {
      requests++;
      return { label: 'related', confidence: 0.95, reason: '教程' };
    },
  });
  f.engine.config.aiEnabled = true;
  f.advance(100000);
  let writes = 0;
  f.api.storage.session.set = async () => {
    writes++;
  };
  f.api.storage.local.set = async () => {
    writes++;
  };
  const badges = f.state.badges.length;
  const since = f.engine.runtime.active.since;
  for (let i = 0; i < 5; i++) {
    f.advance(2000);
    const state = await f.engine.dispatch({ type: 'focus:state' }, {});
    assert.equal(state.current.url, 'https://www.bilibili.com/video/BVabc');
    assert.equal(
      f.engine.runtime.active.since,
      since,
      'same-page polling must not reset stable dwell'
    );
  }
  assert.equal(writes, 0);
  assert.equal(requests, 0);
  assert.equal(f.engine.runtime.calls.length, 0);
  assert.equal(f.state.badges.length, badges);
  assert.equal(f.state.updates.length, 0);
});

test('unfocused and idle states show safe observed metadata but never relax automatic AI restrictions', async () => {
  for (const condition of ['unfocused', 'idle', 'locked']) {
    let requests = 0;
    const f = await fixture({
      ai: async () => {
        requests++;
        return { label: 'unrelated', confidence: 0.99, reason: '娱乐' };
      },
    });
    f.engine.config.aiEnabled = true;
    f.advance(100000);
    if (condition === 'unfocused') f.state.window.focused = false;
    else f.state.idle = condition;
    const state = await f.engine.dispatch({ type: 'focus:state' }, {});
    assert.equal(state.diagnostics.code, condition === 'unfocused' ? 'unfocused' : 'idle');
    assert.equal(state.diagnostics.eligible, false);
    assert.ok(state.current?.url, 'panel can explain which recent normal webpage was found');
    assert.equal(f.engine.runtime.active, null, 'AI must have no eligible foreground page');
    await f.engine.dispatch({ type: 'focus:check' }, {});
    await f.flush();
    assert.equal(requests, 0);
    assert.equal(f.state.updates.length, 0);
  }
});

test('missing tab URL, pending-only URL, internal pages and empty tab queries report distinct causes', async () => {
  for (const condition of ['missing-url', 'pending-only', 'unsupported-page', 'no-tab']) {
    const f = await fixture();
    if (condition === 'no-tab') f.state.tabs.clear();
    else if (condition === 'unsupported-page')
      f.state.tabs.get(1).url = 'chrome-extension://focus-test/index.html';
    else {
      delete f.state.tabs.get(1).url;
      if (condition === 'pending-only')
        f.state.tabs.get(1).pendingUrl = 'https://www.bilibili.com/video/pending';
    }
    const state = await f.engine.dispatch({ type: 'focus:state' }, {});
    assert.equal(state.diagnostics.code, condition === 'pending-only' ? 'missing-url' : condition);
    assert.equal(state.current, null);
    assert.equal(state.diagnostics.hasURL, condition === 'unsupported-page');
    assert.equal(state.diagnostics.eligible, false);
    assert.equal(f.engine.runtime.active, null);
    assert.ok(!JSON.stringify(state.diagnostics).includes('video/pending'));
  }
});

test('incognito metadata is never returned and incompatible window API shapes are diagnosed', async () => {
  for (const condition of ['private-window', 'private-tab', 'no-window', 'popup-window']) {
    const f = await fixture();
    if (condition === 'private-window') f.state.window.incognito = true;
    if (condition === 'private-tab') f.state.tabs.get(1).incognito = true;
    if (condition === 'no-window') f.api.windows.getLastFocused = async () => undefined;
    if (condition === 'popup-window') f.state.window.type = 'popup';
    const state = await f.engine.dispatch({ type: 'focus:state' }, {});
    assert.equal(state.current, null);
    assert.equal(
      state.diagnostics.code,
      condition.startsWith('private')
        ? 'incognito'
        : condition === 'no-window'
        ? 'no-window'
        : 'unsupported-window'
    );
    assert.ok(!JSON.stringify(state.diagnostics).includes('bilibili.com'));
  }
});

test('API failures identify their stage without disclosing raw exception URLs or replacing NAS errors', async () => {
  for (const stage of ['window', 'tabs', 'idle']) {
    const f = await fixture();
    f.engine.runtime.error = 'AI 暂不可用：403 Forbidden';
    const fail = async () => {
      throw new Error('Cannot access https://secret.example/path?token=private');
    };
    if (stage === 'window') f.api.windows.getLastFocused = fail;
    if (stage === 'tabs') f.api.tabs.query = fail;
    if (stage === 'idle') f.api.idle.queryState = fail;
    const state = await f.engine.dispatch({ type: 'focus:state' }, {});
    assert.equal(state.diagnostics.code, 'api-error');
    assert.ok(state.diagnostics.message.includes(stage + ' API'));
    assert.equal(state.current, null);
    assert.match(state.error, /403 Forbidden/);
    assert.ok(!JSON.stringify(state.diagnostics).includes('secret.example'));
    assert.ok(!JSON.stringify(state.diagnostics).includes('token=private'));
  }
});

test('cold worker initialization and state refresh cannot start NAS requests from restored old active state', async () => {
  const now = 10_000_000;
  const tab = {
    id: 1,
    windowId: 1,
    active: true,
    title: '教程',
    url: 'https://www.bilibili.com/video/old',
  };
  const { api } = chromeMock({
    tabs: [tab],
    session: {
      focusRuntime: {
        active: {
          identity: JSON.stringify([tab.id, tab.url, tab.title]),
          tabId: 1,
          url: tab.url,
          title: tab.title,
          since: now - 100000,
        },
      },
    },
  });
  let requests = 0,
    queue = Promise.resolve();
  const enqueue = (work) => {
    const task = queue.then(work);
    queue = task.catch(() => {});
    return task;
  };
  const engine = new FocusEngine(
    api,
    enqueue,
    () => now,
    async () => {
      requests++;
      return { label: 'related', confidence: 0.95, reason: '教程' };
    }
  );
  await engine.init();
  await engine.dispatch({ type: 'focus:state' }, {});
  assert.equal(requests, 0);
  assert.equal(engine.runtime.calls.length, 0);
  await engine.reconcile();
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    await queue;
  }
  assert.equal(requests, 1, 'a normal automatic browser/alarm reconcile can still classify');
});

test('refreshing a newly selected page cancels the old result without creating a replacement request', async () => {
  let resolve,
    requests = 0;
  const result = new Promise((yes) => {
    resolve = yes;
  });
  const f = await fixture({
    ai: async () => {
      requests++;
      return result;
    },
  });
  f.engine.config.aiEnabled = true;
  f.advance(21000);
  await f.engine.reconcile();
  await f.flush();
  assert.equal(requests, 1);
  f.state.tabs.get(1).url = 'https://www.bilibili.com/video/new-page';
  await f.engine.dispatch({ type: 'focus:state' }, {});
  resolve({ label: 'unrelated', confidence: 0.99, reason: '旧页娱乐' });
  await f.flush();
  assert.equal(requests, 1);
  assert.equal(f.state.updates.length, 0);
  assert.equal(f.engine.runtime.active.url, 'https://www.bilibili.com/video/new-page');
});

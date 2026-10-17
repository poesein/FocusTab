import test from 'node:test';
import assert from 'node:assert/strict';
import { FocusEngine } from '../src/engine.mjs';
import { documentKey } from '../src/rules.mjs';
import { fixture } from './chrome-mock.mjs';

const sender = { tab: { id: 1 }, url: 'chrome-extension://focus-test/blocked.html' };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const unrelated = {
  label: 'unrelated',
  confidence: 0.99,
  reason: '娱乐内容，与当前研究无关',
  source: 'ai',
};

test('static blocking and a temporary pass affect only the exact URL in its tab', async () => {
  const f = await fixture();
  const original = 'https://www.ablesci.com/tophot?id=1#article';
  await f.engine.dispatch({ type: 'focus:pass', payload: { url: original } }, sender);
  assert.equal(f.state.tabs.get(1).url, original);
  const [rule] = f.state.sessionRules;
  assert.deepEqual(rule.condition.tabIds, [1]);
  assert.equal(rule.action.type, 'allow');
  const regex = new RegExp(rule.condition.regexFilter);
  assert.ok(regex.test('https://www.ablesci.com/tophot?id=1'));
  assert.ok(!regex.test('https://www.ablesci.com/tophot?id=2'));
  assert.ok(!regex.test('https://www.ablesci.com/tophot/123'));
  assert.equal(await f.engine.currentPass(2, original), false);
  assert.equal(await f.engine.currentPass(1, original), true);
  f.state.tabs.get(1).url = 'https://www.ablesci.com/tophot/other';
  await f.engine.reconcile();
  assert.ok(f.state.tabs.get(1).url.startsWith('chrome-extension://focus-test/blocked.html#url='));
});

test('temporary DNR allowances expire and reblock background pages while browser is unfocused', async () => {
  const f = await fixture();
  f.engine.config.allowMinutes = 1;
  const original = 'https://tophub.today/';
  await f.engine.dispatch({ type: 'focus:pass', payload: { url: original } }, sender);
  assert.equal(f.state.sessionRules.length, 1);
  f.state.window.focused = false;
  f.advance(60001);
  await f.engine.reconcile();
  assert.equal(f.state.sessionRules.length, 0);
  assert.ok(f.state.tabs.get(1).url.includes('/blocked.html#url='));
  assert.deepEqual(f.api.storage.session.data.focusPasses, []);
});

test('worker restart removes orphan/expired allowances without discarding a still-valid lease', async () => {
  const f = await fixture();
  await f.engine.dispatch(
    { type: 'focus:pass', payload: { url: 'https://tophub.today/' } },
    sender
  );
  f.state.sessionRules.push({ id: 199999, priority: 10 });
  const next = new FocusEngine(f.api, f.enqueue, f.now);
  await next.init();
  assert.deepEqual(
    f.state.sessionRules.map((r) => r.id),
    [100001]
  );
  f.advance(11 * 60000);
  const afterExpiry = new FocusEngine(f.api, f.enqueue, f.now);
  await afterExpiry.init();
  assert.equal(f.state.sessionRules.length, 0);
  assert.ok(f.state.tabs.get(1).url.includes('/blocked.html#url='));
});

test('programmatic block URLs encode once and preserve encoded query plus fragment exactly', async () => {
  const f = await fixture();
  const original =
    'https://www.ablesci.com/tophot/story/123?next=a%26b%3Dc&literal=%2520#section%2F1';
  f.state.tabs.get(1).url = original;
  await f.engine.reconcile();
  const blocked = f.state.tabs.get(1).url;
  assert.ok(blocked.startsWith('chrome-extension://focus-test/blocked.html#url='));
  assert.equal(decodeURIComponent(blocked.split('#url=')[1]), original);
});

test('failed pass persistence rolls its DNR allow back', async () => {
  const f = await fixture();
  const set = f.api.storage.session.set;
  f.api.storage.session.set = async (patch) => {
    if (patch.focusPasses) throw new Error('storage full');
    return set(patch);
  };
  await assert.rejects(
    f.engine.dispatch({ type: 'focus:pass', payload: { url: 'https://tophub.today/' } }, sender),
    /storage full/
  );
  assert.equal(f.state.sessionRules.length, 0);
});

test('task expiry runs on extension pages and notifies once without closing research tabs', async () => {
  const f = await fixture();
  await f.start();
  f.state.tabs.get(1).url = 'chrome-extension://focus-test/newtab.html';
  f.state.window.focused = false;
  f.advance(5 * 60000 + 1);
  await f.engine.reconcile();
  await f.engine.reconcile();
  assert.equal(f.state.notices.filter((n) => n.title === '研究计时结束').length, 1);
  assert.ok(f.engine.runtime.notice.includes('资料页会保留'));
  assert.equal(f.state.updates.length, 0);
  assert.equal(f.engine.session.notified, true);
});

test('AI requests are nonblocking, stale navigation results cannot redirect the new page', async () => {
  const result = deferred();
  let called = 0;
  const f = await fixture({
    ai: async () => {
      called++;
      return result.promise;
    },
  });
  await f.start();
  f.engine.config.aiEnabled = true;
  f.engine.config.aiAction = 'block';
  f.advance(21000);
  await f.engine.reconcile();
  await f.flush();
  assert.equal(called, 1);
  assert.ok(f.engine.pending);
  // A normal serialized UI state request still completes while AI is pending.
  const state = await f.enqueue(() => f.engine.dispatch({ type: 'focus:state' }, {}));
  assert.equal(state.checking, true);
  f.state.tabs.get(1).url = 'https://www.bilibili.com/video/BVnew';
  await f.engine.reconcile();
  result.resolve(unrelated);
  await f.flush();
  assert.equal(f.state.tabs.get(1).url, 'https://www.bilibili.com/video/BVnew');
  assert.equal(f.engine.runtime.judgment, null);
  assert.equal(f.state.notices.length, 0);
});

test('outstanding AI result cannot affect a replaced or expired task', async () => {
  const result = deferred();
  const f = await fixture({ ai: async () => result.promise });
  await f.start();
  f.engine.config.aiEnabled = true;
  f.engine.config.aiAction = 'block';
  f.advance(21000);
  await f.engine.reconcile();
  await f.flush();
  await f.start('另一个研究问题');
  result.resolve(unrelated);
  await f.flush();
  assert.equal(f.engine.runtime.judgment, null);
  assert.equal(f.state.updates.length, 0);
});

test('model errors fail open for the current research page and still spend the bounded budget', async () => {
  let calls = 0;
  const f = await fixture({
    ai: async () => {
      calls++;
      throw new Error('NAS busy');
    },
  });
  await f.start();
  f.engine.config.aiEnabled = true;
  f.engine.config.requestsPerHour = 1;
  f.advance(21000);
  await f.engine.reconcile();
  await f.flush();
  assert.match(f.engine.runtime.error, /NAS busy/);
  assert.equal(f.state.updates.length, 0);
  f.advance(100000);
  await f.engine.dispatch({ type: 'focus:check' }, {});
  await f.flush();
  assert.equal(calls, 1);
  assert.equal(f.engine.runtime.calls.length, 1);
  assert.ok(f.state.dynamic.length > 0);
});

test('high-confidence unrelated AI outcome blocks its own exact page, and snapshots contain no excerpt', async () => {
  const f = await fixture({ ai: async () => unrelated });
  await f.start();
  f.engine.config.aiEnabled = true;
  f.engine.config.aiAction = 'block';
  f.advance(21000);
  await f.engine.reconcile();
  await f.flush();
  assert.ok(f.state.tabs.get(1).url.endsWith('/blocked.html#ai'));
  assert.equal(f.engine.runtime.judgment.label, 'unrelated');
  assert.equal(f.api.storage.session.data['aiBlock:1'].sessionId, f.engine.session.id);
  const snapshot = await f.engine.snapshot();
  assert.equal(snapshot.judgment.input.excerptLength, 9);
  assert.ok(!JSON.stringify(snapshot).includes('单粒子追踪科研教程'));
  assert.equal(f.state.notices.length, 1);
  assert.equal(f.state.notices[0].iconUrl, 'icons/icon-128.png');
});

test('uncertain and below-threshold AI outcomes leave the research page open', async () => {
  for (const outcome of [
    { label: 'uncertain', confidence: 0.99, reason: '资料不足' },
    { label: 'unrelated', confidence: 0.6, reason: '不确定用途' },
  ]) {
    const f = await fixture({ ai: async () => outcome });
    await f.start();
    f.engine.config.aiEnabled = true;
    f.engine.config.aiAction = 'block';
    f.advance(21000);
    await f.engine.reconcile();
    await f.flush();
    assert.equal(f.state.updates.length, 0);
    assert.equal(f.state.notices.length, 0);
    assert.equal(f.engine.runtime.judgment.label, outcome.label);
  }
});

test('extraction that observes a different page is discarded before the model request', async () => {
  let calls = 0;
  const f = await fixture({
    ai: async () => {
      calls++;
      return unrelated;
    },
  });
  await f.start();
  f.engine.config.aiEnabled = true;
  f.api.scripting.executeScript = async (request) =>
    request.files
      ? []
      : [{ result: { url: 'https://www.zhihu.com/messages', title: '私信', excerpt: '私密内容' } }];
  f.advance(21000);
  await f.engine.reconcile();
  await f.flush();
  assert.equal(calls, 0);
  assert.equal(f.state.updates.length, 0);
});

test('closing a temporarily allowed tab removes both its lease and AI record', async () => {
  const f = await fixture();
  await f.engine.dispatch(
    { type: 'focus:pass', payload: { url: 'https://tophub.today/' } },
    sender
  );
  await f.api.storage.session.set({ 'aiBlock:1': { url: 'https://tophub.today/' } });
  f.state.tabs.delete(1);
  await f.engine.tabRemoved(1);
  assert.equal(f.state.sessionRules.length, 0);
  assert.deepEqual(f.api.storage.session.data.focusPasses, []);
  assert.equal(f.api.storage.session.data['aiBlock:1'], undefined);
});

test('AI-blocked exact-page pass expires, then human correction can release that document for its task', async () => {
  const f = await fixture();
  await f.start();
  f.engine.config.aiEnabled = true;
  f.engine.config.aiAction = 'block';
  f.engine.config.allowMinutes = 1;
  const tab = f.state.tabs.get(1),
    original = tab.url;
  const key = documentKey(f.engine.session.goal, tab.url, tab.title);
  await f.api.storage.session.set({
    'aiBlock:1': {
      url: original,
      title: tab.title,
      reason: '不相关',
      key,
      sessionId: f.engine.session.id,
    },
  });
  await f.engine.dispatch({ type: 'focus:pass', payload: { ai: true } }, sender);
  f.state.window.focused = false;
  f.advance(60001);
  await f.engine.reconcile();
  assert.ok(f.state.tabs.get(1).url.endsWith('/blocked.html#ai'));
  const context = await f.engine.dispatch({ type: 'focus:blocked', payload: { ai: true } }, sender);
  assert.equal(context.source, 'ai');
  assert.equal(context.ai, true);
  await f.engine.dispatch(
    { type: 'focus:feedback', payload: { ai: true, label: 'related', remember: false } },
    sender
  );
  assert.equal(await f.engine.aiBlock(1, original), null);
  assert.equal(f.engine.feedback.at(-1).sessionId, f.engine.session.id);
  await f.engine.dispatch({ type: 'focus:undo' }, {});
  assert.ok(await f.engine.aiBlock(1, original));
});

test('feedback rejects stale foreground and expired tasks, blocks no other URL or session', async () => {
  const f = await fixture();
  await f.start();
  f.state.tabs.get(1).url = 'https://www.bilibili.com/video/different';
  await assert.rejects(
    f.engine.dispatch(
      { type: 'focus:feedback', payload: { label: 'related', remember: false } },
      {}
    ),
    /没有可纠正/
  );
  await f.engine.reconcile();
  f.advance(6 * 60000);
  await assert.rejects(
    f.engine.dispatch(
      { type: 'focus:feedback', payload: { label: 'related', remember: false } },
      {}
    ),
    /没有可纠正/
  );
  assert.equal(f.engine.feedback.length, 0);
});

test('arbitrary URLs cannot use a stored AI record to obtain a different pass', async () => {
  const f = await fixture();
  await f.start();
  await f.api.storage.session.set({
    'aiBlock:1': { url: 'https://www.bilibili.com/video/old', sessionId: 'old-session' },
  });
  await assert.rejects(
    f.engine.dispatch({ type: 'focus:pass', payload: { url: 'https://unrelated.test/' } }, sender),
    /没有可放行/
  );
  await assert.rejects(
    f.engine.dispatch({ type: 'focus:pass', payload: { ai: true } }, sender),
    /没有可放行/
  );
  assert.equal(f.state.sessionRules.length, 0);
});

test('oversized/malformed messages and unsupported config cannot alter saved options', async () => {
  const f = await fixture();
  for (const message of [
    { type: 'focus:config', payload: [] },
    { type: 'focus:config', payload: { badOption: true } },
    { type: 'focus:start', payload: { goal: {} } },
    { type: 'focus:start', payload: { goal: 'x'.repeat(40001) } },
  ])
    await assert.rejects(f.engine.dispatch(message, {}));
  assert.equal(f.api.storage.local.data.focusConfig, undefined);
});

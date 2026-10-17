import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './chrome-mock.mjs';

const sender = {
  id: 'focus-test',
  url: 'chrome-extension://focus-test/popup.html',
  documentId: 'popup-1',
  frameId: 0,
};
const focus = { windowId: 1, focused: true, visible: true };
const unrelated = {
  label: 'unrelated',
  confidence: 0.99,
  reason: '娱乐消遣',
  source: 'ai',
};
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
const report = (f, proof = focus, type = 'focus:state', source = sender) =>
  f.engine.dispatch({ type, uiFocus: proof }, source);

test('trusted focused popup identifies its owning page even when the normal window is not active', async () => {
  let calls = 0;
  const f = await fixture({
    ai: async () => {
      calls++;
      return unrelated;
    },
  });
  f.engine.config.aiEnabled = true;
  f.state.window.focused = false;
  const state = await report(f);
  assert.equal(state.diagnostics.windowFocused, false);
  assert.equal(state.diagnostics.popupFocused, true);
  assert.equal(state.diagnostics.focusSource, 'popup');
  assert.equal(state.diagnostics.eligible, true);
  assert.equal(state.current.url, 'https://www.bilibili.com/video/BVabc');
  assert.equal(calls, 0, 'a proof/state update does not query the NAS');
  await report(f, focus, 'focus:check');
  await f.flush();
  assert.equal(calls, 1);
  assert.ok(f.state.tabs.get(1).url.endsWith('blocked.html#ai'));
});

test('proof requires the exact extension popup, top frame, booleans, and matching normal window', async () => {
  for (const [source, proof] of [
    [{ ...sender, url: 'chrome-extension://focus-test/index.html' }, focus],
    [{ ...sender, url: 'chrome-extension://focus-test/popup.html?fake=1' }, focus],
    [{ ...sender, url: 'https://www.bilibili.com/' }, focus],
    [{ ...sender, id: 'other-extension' }, focus],
    [{ ...sender, frameId: 1 }, focus],
    [sender, { ...focus, focused: 'true' }],
    [sender, { ...focus, visible: false }],
    [sender, { ...focus, windowId: 99 }],
    [sender, { ...focus, windowId: null }],
  ]) {
    const f = await fixture();
    f.state.window.focused = false;
    const state = await report(f, proof, 'focus:state', source);
    assert.equal(state.diagnostics.eligible, false, JSON.stringify({ source, proof }));
    assert.equal(f.engine.runtime.active, null);
  }
});

test('proof TTL is measured by the worker and expires even if a popup remains present', async () => {
  let calls = 0;
  const f = await fixture({
    ai: async () => {
      calls++;
      return unrelated;
    },
  });
  f.engine.config.aiEnabled = true;
  f.state.window.focused = false;
  await report(f, { ...focus, until: f.now() + 99999999, receivedAt: 0 });
  f.advance(2501);
  const state = await f.engine.dispatch({ type: 'focus:state' }, {});
  assert.equal(state.diagnostics.code, 'unfocused');
  assert.equal(state.diagnostics.popupFocused, false);
  await f.engine.dispatch({ type: 'focus:check' }, {});
  await f.flush();
  assert.equal(calls, 0);
});

test('popup proof never overrides idle, lock, incognito, private routes or an unrelated active page', async () => {
  for (const condition of ['idle', 'locked', 'incognito', 'private']) {
    let calls = 0;
    const f = await fixture({
      ai: async () => {
        calls++;
        return unrelated;
      },
    });
    f.engine.config.aiEnabled = true;
    f.state.window.focused = false;
    if (condition === 'idle' || condition === 'locked') f.state.idle = condition;
    if (condition === 'incognito') f.state.tabs.get(1).incognito = true;
    if (condition === 'private') f.state.tabs.get(1).url = 'https://message.bilibili.com/';
    await report(f, focus, 'focus:check');
    await f.flush();
    assert.equal(calls, 0, condition);
    assert.equal(f.state.updates.length, 0, condition);
    if (condition === 'incognito') assert.equal((await f.engine.snapshot()).current, null);
  }
});

test('explicit blur clears the proof immediately and cannot start new requests using transition grace', async () => {
  let calls = 0;
  const f = await fixture({
    ai: async () => {
      calls++;
      return unrelated;
    },
  });
  f.engine.config.aiEnabled = true;
  f.state.window.focused = false;
  await report(f);
  const ack = await report(f, { ...focus, focused: false }, 'focus:ui-state');
  assert.deepEqual(ack, { accepted: true });
  assert.equal(f.engine.popupFocus, null);
  await report(f, { ...focus, focused: false }, 'focus:check');
  await f.flush();
  assert.equal(calls, 0);
  assert.equal(f.engine.runtime.calls.length, 0);
});

test('popup close preserves an in-flight same-page result across a sub-second parent focus transition', async () => {
  const result = deferred();
  let calls = 0;
  const f = await fixture({
    ai: async () => {
      calls++;
      return result.promise;
    },
  });
  f.engine.config.aiEnabled = true;
  f.state.window.focused = false;
  await report(f, focus, 'focus:check');
  await f.flush();
  const pending = f.engine.pending;
  assert.ok(pending);
  assert.equal(calls, 1);
  await report(f, { ...focus, focused: false, visible: false }, 'focus:ui-state');
  f.advance(500);
  await f.engine.reconcile();
  assert.equal(
    f.engine.pending,
    pending,
    'a brief popup transition must not cancel a captured request'
  );
  f.state.window.focused = true;
  await f.engine.reconcile();
  result.resolve(unrelated);
  await f.flush();
  assert.equal(calls, 1);
  assert.ok(f.state.tabs.get(1).url.endsWith('blocked.html#ai'));
});

test('focus transition grace expires in one second and never crosses URL, title or privacy changes', async () => {
  for (const condition of ['expired', 'url', 'title', 'private', 'locked']) {
    const result = deferred();
    const f = await fixture({ ai: async () => result.promise });
    f.engine.config.aiEnabled = true;
    f.state.window.focused = false;
    await report(f, focus, 'focus:check');
    await f.flush();
    await report(f, { ...focus, focused: false }, 'focus:ui-state');
    if (condition === 'expired') f.advance(1001);
    if (condition === 'url') f.state.tabs.get(1).url = 'https://www.bilibili.com/video/new';
    if (condition === 'title') f.state.tabs.get(1).title = '另一个标题';
    if (condition === 'private') f.state.tabs.get(1).url = 'https://message.bilibili.com/';
    if (condition === 'locked') f.state.idle = 'locked';
    await f.engine.refreshCurrentPage();
    assert.equal(f.engine.pending, null, condition);
    result.resolve(unrelated);
    await f.flush();
    assert.equal(f.state.updates.length, 0, condition);
  }
});

test('a late blur from an old popup cannot revoke a newly focused popup document', async () => {
  const f = await fixture();
  f.state.window.focused = false;
  await report(f);
  await report(f, focus, 'focus:state', { ...sender, documentId: 'popup-2' });
  const oldAck = await report(f, { ...focus, focused: false }, 'focus:ui-state', sender);
  assert.equal(oldAck.accepted, false);
  assert.equal(f.engine.popupFocus.documentId, 'popup-2');
  assert.equal((await f.engine.dispatch({ type: 'focus:state' }, {})).diagnostics.eligible, true);
});

test('focus is rechecked after extraction before sending newly captured text to the NAS', async () => {
  let calls = 0;
  const f = await fixture({
    ai: async () => {
      calls++;
      return unrelated;
    },
  });
  f.engine.config.aiEnabled = true;
  const scripting = f.api.scripting.executeScript;
  f.api.scripting.executeScript = async (request) => {
    const result = await scripting(request);
    if (!request.files) f.state.window.focused = false;
    return result;
  };
  f.advance(21000);
  await f.engine.reconcile();
  await f.flush();
  assert.equal(calls, 0);
  assert.equal(f.state.updates.length, 0);
});

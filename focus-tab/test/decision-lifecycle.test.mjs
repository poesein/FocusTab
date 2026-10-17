import test from 'node:test';
import assert from 'node:assert/strict';
import { FocusEngine } from '../src/engine.mjs';
import { fixture } from './chrome-mock.mjs';

const sender = { tab: { id: 1 }, url: 'chrome-extension://focus-test/blocked.html' };
const unrelated = { label: 'unrelated', confidence: 0.95, reason: '娱乐节目', source: 'ai' };
const feedback = (label, ai = false) => ({
  type: 'focus:feedback',
  payload: { label, remember: false, ai },
});

const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};

test('undo and clear remove enforcement from a revoked human entertainment judgment, including after worker restart', async () => {
  for (const operation of ['focus:undo', 'focus:clear']) {
    const f = await fixture();
    f.engine.config.aiEnabled = true;
    const original = f.state.tabs.get(1).url;
    await f.engine.dispatch(feedback('unrelated'), {});
    assert.ok(await f.engine.aiBlock(1, original));
    await f.engine.dispatch({ type: operation }, {});
    assert.equal(await f.engine.aiBlock(1, original), null, operation);
    const restarted = new FocusEngine(f.api, f.enqueue, f.now);
    await restarted.init();
    assert.equal(await restarted.aiBlock(1, original), null, `${operation} after restart`);
    f.state.tabs.get(1).url = original;
    await restarted.reconcile({ analyze: false });
    assert.equal(f.state.tabs.get(1).url, original);
  }
});

test('an uncertain correction suspends an existing AI block and undo restores the original AI decision', async () => {
  const f = await fixture({ ai: async () => unrelated });
  f.engine.config.aiEnabled = true;
  f.advance(21000);
  await f.engine.reconcile();
  await f.flush();
  const original = f.api.storage.session.data['aiBlock:1'].url;
  await f.engine.dispatch(feedback('uncertain', true), sender);
  assert.equal(await f.engine.aiBlock(1, original), null);
  f.state.tabs.get(1).url = original;
  await f.engine.reconcile();
  assert.equal(f.state.tabs.get(1).url, original);
  await f.engine.dispatch({ type: 'focus:undo' }, {});
  assert.ok(await f.engine.aiBlock(1, original));
});

test('stored AI blocks honor a raised threshold while human entertainment feedback remains authoritative', async () => {
  const f = await fixture({ ai: async () => unrelated });
  f.engine.config.aiEnabled = true;
  f.advance(21000);
  await f.engine.reconcile();
  await f.flush();
  const original = f.api.storage.session.data['aiBlock:1'].url;
  await f.engine.dispatch({ type: 'focus:config', payload: { threshold: 0.99 } }, {});
  assert.equal(await f.engine.aiBlock(1, original), null);
  const restarted = new FocusEngine(f.api, f.enqueue, f.now);
  await restarted.init();
  assert.equal(await restarted.aiBlock(1, original), null);
  f.state.tabs.get(1).url = original;
  await restarted.reconcile({ analyze: false });
  assert.equal(f.state.tabs.get(1).url, original);
  await restarted.dispatch(feedback('unrelated'), {});
  assert.ok(await restarted.aiBlock(1, original));
});

test('legacy blocks without confidence are rechecked rather than overriding the configured threshold', async () => {
  const f = await fixture();
  f.engine.config.aiEnabled = true;
  const original = f.state.tabs.get(1).url;
  const context = f.engine.effectiveContext();
  await f.api.storage.session.set({
    'aiBlock:1': { url: original, title: '教程', contextId: context.id, mode: context.mode },
  });
  assert.equal(await f.engine.aiBlock(1, original), null);
  await f.engine.reconcile({ analyze: false });
  assert.equal(f.state.tabs.get(1).url, original);
});

test('disabling analysis cancels extraction before a slow settings write can send the captured text', async () => {
  let calls = 0;
  const f = await fixture({
    ai: async () => {
      calls++;
      return unrelated;
    },
  });
  f.engine.config.aiEnabled = true;
  const extracted = deferred();
  const syncFinished = deferred();
  const execute = f.api.scripting.executeScript;
  f.api.scripting.executeScript = async (request) => {
    if (!request.files) await extracted.promise;
    return execute(request);
  };
  f.advance(21000);
  await f.engine.reconcile();
  await f.flush();
  assert.ok(f.engine.pending);
  const sync = f.engine.syncRules.bind(f.engine);
  f.engine.syncRules = async () => {
    await syncFinished.promise;
    return sync();
  };
  const saving = f.engine.dispatch({ type: 'focus:config', payload: { aiEnabled: false } }, {});
  extracted.resolve();
  await f.flush();
  const callsBeforeSave = calls;
  syncFinished.resolve();
  await saving;
  await f.flush();
  assert.equal(callsBeforeSave, 0, 'a pending settings write cannot delay cancellation');
  assert.equal(calls, 0);
});

test('an expired AI block returns a revisited page to bounded automatic analysis', async () => {
  let calls = 0;
  const f = await fixture({
    ai: async () => {
      calls++;
      return unrelated;
    },
  });
  f.engine.config.aiEnabled = true;
  f.engine.config.cacheMinutes = 1;
  f.advance(21000);
  await f.engine.reconcile();
  await f.flush();
  const original = f.api.storage.session.data['aiBlock:1'].url;
  f.advance(61000);
  f.state.tabs.get(1).url = original;
  await f.engine.reconcile();
  assert.equal(f.state.tabs.get(1).url, original);
  assert.equal(calls, 1, 'returning to the page cannot bypass dwell or the NAS interval');
  f.advance(30000);
  await f.engine.reconcile();
  await f.flush();
  assert.equal(calls, 2);
  assert.ok(f.state.tabs.get(1).url.endsWith('#ai'));
});

test('reusing a cached entertainment decision in another tab retains its original expiry', async () => {
  let calls = 0;
  const f = await fixture({
    ai: async () => {
      calls++;
      return unrelated;
    },
  });
  f.engine.config.aiEnabled = true;
  f.engine.config.cacheMinutes = 1;
  f.advance(21000);
  await f.engine.reconcile();
  await f.flush();
  const original = f.api.storage.session.data['aiBlock:1'].url;
  const created = f.engine.runtime.judgment.created;
  f.state.tabs.get(1).active = false;
  f.state.tabs.set(2, { id: 2, windowId: 1, active: true, title: 'TrackMate 教程', url: original });
  await f.engine.reconcile();
  f.advance(21000);
  await f.engine.reconcile();
  await f.flush();
  assert.equal(calls, 1);
  assert.equal(f.api.storage.session.data['aiBlock:2'].created, created);
  f.advance(40000);
  assert.equal(await f.engine.aiBlock(2, original), null);
});

test('a newer nonblocking AI outcome supersedes old entertainment enforcement when a pass expires', async () => {
  for (const outcome of [
    { label: 'related', confidence: 0.95, reason: '工作资料', source: 'ai' },
    { label: 'uncertain', confidence: 0.95, reason: '用途不明', source: 'ai' },
  ]) {
    let calls = 0;
    const f = await fixture({ ai: async () => (++calls === 1 ? unrelated : outcome) });
    f.engine.config.aiEnabled = true;
    f.engine.config.allowMinutes = 2;
    f.advance(21000);
    await f.engine.reconcile();
    await f.flush();
    const original = f.api.storage.session.data['aiBlock:1'].url;
    await f.engine.dispatch({ type: 'focus:pass', payload: { ai: true } }, sender);
    f.advance(90000);
    await f.engine.dispatch({ type: 'focus:check' }, {});
    await f.flush();
    assert.equal(calls, 2);
    assert.equal(f.engine.runtime.judgment.label, outcome.label);
    assert.equal(f.api.storage.session.data['aiBlock:1'], undefined);
    f.state.window.focused = false;
    f.advance(31000);
    await f.engine.reconcile();
    assert.equal(f.state.tabs.get(1).url, original);
    assert.equal(f.state.sessionRules.length, 0);
  }
});

test('a failed configuration rollback is retried by ordinary reconciliation after APIs recover', async () => {
  const f = await fixture();
  await f.api.storage.local.set({ focusConfig: f.engine.config });
  const originalRules = structuredClone(f.state.dynamic);
  const set = f.api.storage.local.set;
  const update = f.api.declarativeNetRequest.updateDynamicRules;
  let rejectRollback = true;
  f.api.storage.local.set = async (patch) => {
    if (patch.focusConfig) throw new Error('settings storage unavailable');
    return set(patch);
  };
  f.api.declarativeNetRequest.updateDynamicRules = async (patch) => {
    if (rejectRollback && patch.addRules.length) throw new Error('rule rollback unavailable');
    return update(patch);
  };
  await assert.rejects(
    f.engine.dispatch({ type: 'focus:config', payload: { blockFeeds: false } }, {}),
    (error) =>
      /settings storage unavailable/.test(error.message) &&
      /rule rollback unavailable/.test(error.message)
  );
  assert.equal(f.engine.config.blockFeeds, true);
  assert.equal(f.api.storage.local.data.focusConfig.blockFeeds, true);
  assert.equal(f.state.dynamic.length, 0);
  rejectRollback = false;
  f.api.storage.local.set = set;
  await f.engine.reconcile();
  assert.deepEqual(f.state.dynamic, originalRules);
  let writes = 0;
  f.api.declarativeNetRequest.updateDynamicRules = async (patch) => {
    writes++;
    return update(patch);
  };
  await f.engine.reconcile();
  assert.equal(writes, 0, 'successful recovery must stop rewriting unchanged native rules');
});

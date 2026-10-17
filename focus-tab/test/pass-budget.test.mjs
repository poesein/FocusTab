import test from 'node:test';
import assert from 'node:assert/strict';
import { FocusEngine } from '../src/engine.mjs';
import { DEFAULTS, loadConfig, validatePatch } from '../src/config.mjs';
import { describePassBudget, normalizePassBudget, reservePass } from '../src/pass-budget.mjs';
import { chromeMock, fixture } from './chrome-mock.mjs';

const url = 'https://tophub.today/';
const otherURL = 'https://www.ablesci.com/tophot';
const sender = (id = 1) => ({
  id: 'focus-test',
  tab: { id },
  url: 'chrome-extension://focus-test/blocked.html',
});
const message = (type = 'pass', target = url) => ({
  type: 'focus:' + type,
  payload: { url: target },
});
const getBudget = (f) => f.api.storage.local.data.focusPassBudget;
const addTab = (f, id, target = url) =>
  f.state.tabs.set(id, {
    id,
    windowId: 2,
    active: true,
    url: target,
    title: '资讯',
  });

test('legacy configurations acquire bounded pass defaults and explicit writes validate all new options', () => {
  assert.equal(loadConfig({ allowMinutes: 8 }).temporaryPassEnabled, true);
  assert.equal(loadConfig().passDailyMinutes, 20);
  assert.equal(loadConfig().passCooldownMinutes, 10);
  assert.deepEqual(
    validatePatch({
      temporaryPassEnabled: false,
      passDailyMinutes: 0,
      passCooldownMinutes: 0,
    }),
    { temporaryPassEnabled: false, passDailyMinutes: 0, passCooldownMinutes: 0 }
  );
  for (const patch of [
    { temporaryPassEnabled: 'false' },
    { passDailyMinutes: -1 },
    { passDailyMinutes: 181 },
    { passDailyMinutes: 1.5 },
    { passCooldownMinutes: 121 },
    { passCooldownMinutes: null },
  ])
    assert.throws(() => validatePatch(patch));
});

test('daily usage follows browser local midnight while cooldown survives the day change', () => {
  const before = new Date(2026, 9, 18, 23, 58).getTime();
  const approved = reservePass(DEFAULTS, null, before);
  const after = new Date(2026, 9, 19, 0, 1).getTime();
  const budget = describePassBudget(DEFAULTS, approved.next, after);
  assert.equal(approved.next.usedMinutes, 10);
  assert.equal(budget.usedMinutes, 0);
  assert.equal(budget.remainingMinutes, 20);
  assert.equal(budget.cooldownUntil, approved.until + 10 * 60000);
  assert.equal(budget.canGrant, false);
  assert.equal(budget.nextAvailableAt, budget.cooldownUntil);
  assert.equal(budget.waitSeconds, 17 * 60);
  assert.equal(describePassBudget(DEFAULTS, approved.next, budget.cooldownUntil).canGrant, true);
  assert.equal(
    normalizePassBudget({ day: 'invalid', usedMinutes: 123, lastPassEnds: NaN }, after).usedMinutes,
    0
  );
});

test('a shortened positive grant consumes exactly the remaining quota and exhaustion waits for local midnight', async () => {
  const f = await fixture();
  f.engine.config.passDailyMinutes = 3;
  const before = await f.engine.dispatch(message('blocked'), sender());
  assert.equal(before.canPass, true);
  assert.equal(before.minutes, 3);
  const result = await f.engine.dispatch(message(), sender());
  assert.equal(result.minutes, 3);
  assert.equal(result.until, f.now() + 3 * 60000);
  assert.equal(getBudget(f).usedMinutes, 3);
  addTab(f, 2);
  const denied = await f.engine.dispatch(message('blocked'), sender(2));
  assert.equal(denied.passBudget.remainingMinutes, 0);
  assert.equal(denied.canPass, false);
  assert.equal(denied.minutes, 0);
  assert.ok(denied.passBudget.nextAvailableAt > f.now());
  await assert.rejects(f.engine.dispatch(message(), sender(2)), /额度已用完/);
  assert.equal(getBudget(f).usedMinutes, 3);
  assert.deepEqual(Object.keys(getBudget(f)).sort(), ['day', 'lastPassEnds', 'usedMinutes']);
  assert.ok(!JSON.stringify(getBudget(f)).includes('http'));
});

test('same tab and exact URL reuse the original pass without extending expiry or charging twice', async () => {
  const f = await fixture();
  const first = await f.engine.dispatch(message(), sender());
  f.advance(60000);
  const state = await f.engine.dispatch(message('blocked'), sender());
  assert.equal(state.canPass, true);
  assert.equal(state.passBudget.canGrant, false);
  assert.equal(state.until, first.until);
  f.state.sessionRules = []; // Restore the same lease after a missing native rule.
  const reused = await f.engine.dispatch(message(), sender());
  assert.equal(reused.reused, true);
  assert.equal(reused.until, first.until);
  assert.equal(getBudget(f).usedMinutes, 10);
  assert.equal(f.api.storage.session.data.focusPasses[0].until, first.until);
  assert.equal(f.state.sessionRules.length, 1);
});

test('all sites and tabs share active-pass and post-expiry cooldown across close and worker restart', async () => {
  const f = await fixture();
  f.engine.config.allowMinutes = 1;
  await f.api.storage.local.set({ focusConfig: f.engine.config });
  const first = await f.engine.dispatch(message(), sender());
  addTab(f, 2, otherURL);
  await assert.rejects(f.engine.dispatch(message('pass', otherURL), sender(2)), /尚未到期/);
  f.state.tabs.delete(1);
  await f.engine.tabRemoved(1);
  assert.equal(getBudget(f).usedMinutes, 1, 'closing early never refunds');
  f.advance(60001);
  const next = new FocusEngine(f.api, f.enqueue, f.now);
  await next.init();
  const state = await next.dispatch(message('blocked', otherURL), sender(2));
  assert.equal(state.canPass, false);
  assert.equal(state.passBudget.usedMinutes, 1);
  assert.equal(state.passBudget.cooldownUntil, first.until + 10 * 60000);
  await assert.rejects(next.dispatch(message('pass', otherURL), sender(2)), /冷却/);
  f.advance(10 * 60000);
  const second = await next.dispatch(message('pass', otherURL), sender(2));
  assert.equal(second.minutes, 1);
  assert.equal(getBudget(f).usedMinutes, 2);
});

test('zero disables cooldown and zero daily limit is unlimited, without shortening the retained last expiry', async () => {
  const f = await fixture();
  f.engine.config.passDailyMinutes = 0;
  f.engine.config.passCooldownMinutes = 0;
  const first = await f.engine.dispatch(message(), sender());
  f.engine.config.allowMinutes = 1;
  addTab(f, 2, otherURL);
  const second = await f.engine.dispatch(message('pass', otherURL), sender(2));
  assert.equal(second.minutes, 1);
  assert.equal(second.passBudget.cooldownUntil, 0);
  assert.equal(second.passBudget.remainingMinutes, null);
  assert.equal(getBudget(f).lastPassEnds, first.until);
  assert.equal(getBudget(f).usedMinutes, 11);
  assert.equal(f.state.sessionRules.length, 2);
  f.engine.config.passCooldownMinutes = 10;
  assert.equal(f.engine.passBudget().cooldownUntil, first.until + 10 * 60000);
});

test('disabling passes removes registered and orphan allows and reblocks already-open background pages without refund', async () => {
  const f = await fixture();
  await f.engine.dispatch(message(), sender());
  addTab(f, 2, otherURL);
  f.state.sessionRules.push({
    id: 100002,
    action: { type: 'allow' },
    condition: { tabIds: [2] },
  });
  f.state.window.focused = false;
  const result = await f.engine.dispatch(
    { type: 'focus:config', payload: { temporaryPassEnabled: false } },
    {}
  );
  assert.equal(result.passBudget.enabled, false);
  assert.equal(result.passBudget.canGrant, false);
  assert.equal(result.passBudget.nextAvailableAt, null);
  assert.equal(f.state.sessionRules.length, 0);
  assert.equal(f.api.storage.session.data.focusPasses.length, 0);
  assert.equal(getBudget(f).usedMinutes, 10);
  for (const id of [1, 2]) assert.match(f.state.tabs.get(id).url, /blocked\.html#url=/);
  const blocked = await f.engine.dispatch(message('blocked'), sender());
  assert.equal(blocked.canPass, false);
  assert.ok(blocked.reason);
  await assert.rejects(f.engine.dispatch(message(), sender()), /已关闭/);
  assert.equal(await f.engine.currentPass(1, url), false);
});

test('restart with the pass switch disabled removes a native orphan even without a session lease', async () => {
  const { api, state } = chromeMock({
    local: { focusConfig: { temporaryPassEnabled: false, aiEnabled: false } },
  });
  state.tabs.get(1).url = url;
  state.window.focused = false;
  state.sessionRules.push({
    id: 100001,
    condition: { tabIds: [1] },
    action: { type: 'allow' },
  });
  const engine = new FocusEngine(api, (work) => work());
  await engine.init();
  assert.equal(state.sessionRules.length, 0);
  assert.match(state.tabs.get(1).url, /blocked\.html#url=/);
});

test('local reservation failures never install a native allow, including a lost write response', async () => {
  for (const commits of [false, true]) {
    const f = await fixture();
    const set = f.api.storage.local.set;
    let first = true;
    f.api.storage.local.set = async (patch) => {
      if (patch.focusPassBudget && first) {
        first = false;
        if (commits) await set(patch);
        throw new Error('local storage failed');
      }
      return set(patch);
    };
    await assert.rejects(f.engine.dispatch(message(), sender()), /local storage failed/);
    assert.equal(f.state.sessionRules.length, 0);
    assert.equal(f.engine.passBudget().usedMinutes, 0);
    assert.equal(getBudget(f)?.usedMinutes || 0, 0);
  }
});

test('a failed DNR installation is cleaned and verified before quota is refunded', async () => {
  for (const commits of [false, true]) {
    const f = await fixture();
    const update = f.api.declarativeNetRequest.updateSessionRules;
    const set = f.api.storage.local.set;
    let first = true;
    f.api.declarativeNetRequest.updateSessionRules = async (change) => {
      if (change.addRules?.length && first) {
        first = false;
        if (commits) await update(change);
        throw new Error('DNR failed');
      }
      return update(change);
    };
    f.api.storage.local.set = async (patch) => {
      if (patch.focusPassBudget?.usedMinutes === 0)
        assert.equal(f.state.sessionRules.length, 0, 'refund follows removal');
      return set(patch);
    };
    await assert.rejects(f.engine.dispatch(message(), sender()), /DNR failed/);
    assert.equal(f.state.sessionRules.length, 0);
    assert.equal(getBudget(f).usedMinutes, 0);
    assert.equal(f.engine.passBudget().canGrant, true);
  }
});

test('session persistence failures roll back native and session state before refund, including commit-then-reject', async () => {
  for (const commits of [false, true]) {
    const f = await fixture();
    const set = f.api.storage.session.set;
    const localSet = f.api.storage.local.set;
    let first = true;
    f.api.storage.session.set = async (patch) => {
      if (patch.focusPasses && first) {
        first = false;
        if (commits) await set(patch);
        throw new Error('session storage failed');
      }
      return set(patch);
    };
    f.api.storage.local.set = async (patch) => {
      if (patch.focusPassBudget?.usedMinutes === 0) {
        assert.equal(f.state.sessionRules.length, 0);
        assert.deepEqual(f.api.storage.session.data.focusPasses || [], []);
      }
      return localSet(patch);
    };
    await assert.rejects(f.engine.dispatch(message(), sender()), /session storage failed/);
    assert.equal(getBudget(f).usedMinutes, 0);
    assert.equal(f.state.sessionRules.length, 0);
    assert.deepEqual(f.api.storage.session.data.focusPasses || [], []);
  }
});

test('unverified cleanup retains its debit and bounded expiry, then maintenance removes the allow when APIs recover', async () => {
  const f = await fixture();
  const update = f.api.declarativeNetRequest.updateSessionRules;
  let broken = true;
  f.api.declarativeNetRequest.updateSessionRules = async (change) => {
    if (broken) {
      if (change.addRules?.length) await update(change);
      throw new Error('DNR unavailable');
    }
    return update(change);
  };
  await assert.rejects(f.engine.dispatch(message(), sender()), /保留额度扣除/);
  assert.equal(getBudget(f).usedMinutes, 10);
  assert.equal(f.state.sessionRules.length, 1);
  assert.equal(f.api.storage.session.data.focusPasses.length, 1);
  assert.equal(f.state.alarms.get('focus-expiry').when, f.now() + 10 * 60000);
  f.state.tabs.get(1).url = url;
  f.state.window.focused = false;
  broken = false;
  f.advance(10 * 60000 + 1);
  await f.engine.reconcile();
  assert.equal(f.state.sessionRules.length, 0);
  assert.match(f.state.tabs.get(1).url, /blocked\.html#url=/);
  assert.equal(getBudget(f).usedMinutes, 10);
});

test('a refund storage failure cannot recreate an allow or hide the retained debit', async () => {
  const f = await fixture();
  const set = f.api.storage.local.set;
  f.api.storage.local.set = async (patch) => {
    if (patch.focusPassBudget?.usedMinutes === 0) throw new Error('refund failed');
    return set(patch);
  };
  const update = f.api.declarativeNetRequest.updateSessionRules;
  f.api.declarativeNetRequest.updateSessionRules = async (patch) => {
    if (patch.addRules?.length) throw new Error('install failed');
    return update(patch);
  };
  await assert.rejects(f.engine.dispatch(message(), sender()), /额度恢复失败/);
  assert.equal(f.state.sessionRules.length, 0);
  assert.equal(f.engine.passBudget().usedMinutes, 10);
});

test('background enqueue serializes simultaneous cross-tab requests and cannot overdraw the daily limit', async () => {
  const { api, state } = chromeMock({
    local: {
      focusConfig: {
        aiEnabled: false,
        allowMinutes: 10,
        passDailyMinutes: 10,
        passCooldownMinutes: 0,
      },
    },
  });
  state.tabs.set(2, {
    id: 2,
    windowId: 2,
    active: false,
    url: otherURL,
    title: '热点',
  });
  const oldChrome = globalThis.chrome;
  globalThis.chrome = api;
  try {
    await import('../src/background.mjs?pass-budget-queue');
    const listener = api.runtime.onMessage.listeners[0];
    const request = (id, target) =>
      new Promise((resolve) => {
        assert.equal(listener(message('pass', target), sender(id), resolve), true);
      });
    const results = await Promise.all([request(1, url), request(2, otherURL)]);
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal(results.filter((r) => !r.ok).length, 1);
    assert.match(results.find((r) => !r.ok).error, /额度已用完/);
    assert.equal(api.storage.local.data.focusPassBudget.usedMinutes, 10);
    assert.equal(state.sessionRules.length, 1);
  } finally {
    globalThis.chrome = oldChrome;
  }
});

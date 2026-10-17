import test from 'node:test';
import assert from 'node:assert/strict';
import { applyInitialActionPreset } from '../src/deployment.mjs';

function fixture(saved = {}) {
  const writes = [];
  const state = structuredClone(saved);
  const api = {
    storage: {
      local: {
        async get(key) {
          return { [key]: state[key] };
        },
        async set(changes) {
          writes.push(structuredClone(changes));
          Object.assign(state, changes);
        },
      },
    },
  };
  return { api, state, writes };
}

test('ordinary public builds never read or change a saved reminder preference', async () => {
  const local = { focusConfig: { aiAction: 'remind' } };
  assert.equal(await applyInitialActionPreset({}, local), local);
});

test('a requested personal preset saves the old configuration and action marker in one write', async () => {
  const f = fixture();
  const local = {
    focusConfig: { aiAction: 'remind', title: '自定义首页' },
    focusSession: { id: 'keep' },
  };
  const result = await applyInitialActionPreset(f.api, local, 'block', 1234);
  assert.equal(result.focusConfig.aiAction, 'block');
  assert.equal(result.focusConfig.title, '自定义首页');
  assert.equal(result.focusSession, local.focusSession);
  assert.equal(local.focusConfig.aiAction, 'remind');
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.state.focusConfigBeforeInitialAction.config, local.focusConfig);
  assert.deepEqual(f.state.focusInitialActionPreset, {
    schema: 1,
    action: 'block',
    appliedAt: 1234,
  });
});

test('after the one-time preset the user can choose reminders without the next restart resetting it', async () => {
  const f = fixture({ focusInitialActionPreset: { schema: 1, action: 'block' } });
  const local = { focusConfig: { aiAction: 'remind' } };
  assert.equal(await applyInitialActionPreset(f.api, local, 'block'), local);
  assert.equal(f.writes.length, 0);
});

test('fresh profiles need no old-settings backup and invalid build presets cannot write', async () => {
  const f = fixture();
  const result = await applyInitialActionPreset(f.api, {}, 'block');
  assert.equal(result.focusConfig.aiAction, 'block');
  assert.equal(Object.hasOwn(f.state, 'focusConfigBeforeInitialAction'), false);
  await assert.rejects(applyInitialActionPreset(f.api, {}, 'unknown'), /预设无效/);
  assert.equal(f.writes.length, 1);
});

test('a failed deployment write preserves the previous in-memory configuration and reports failure', async () => {
  const f = fixture();
  f.api.storage.local.set = async () => {
    throw new Error('disk failure');
  };
  const local = { focusConfig: { aiAction: 'remind' } };
  await assert.rejects(applyInitialActionPreset(f.api, local, 'block'), /disk failure/);
  assert.equal(local.focusConfig.aiAction, 'remind');
  assert.equal(f.state.focusInitialActionPreset, undefined);
});

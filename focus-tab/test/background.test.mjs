import test from 'node:test';
import assert from 'node:assert/strict';
import { chromeMock } from './chrome-mock.mjs';

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};

test('background retries a transient startup failure and enforces extension-only messages without deadlock', async () => {
  const { api } = chromeMock();
  const get = api.storage.local.get;
  let first = true;
  api.storage.local.get = async (keys) => {
    if (first) {
      first = false;
      throw new Error('temporary storage failure');
    }
    return get(keys);
  };
  const originalChrome = globalThis.chrome,
    originalConsole = console.error;
  globalThis.chrome = api;
  console.error = () => {};
  try {
    await import('../src/background.mjs?test-retry');
    await flush();
    const listener = api.runtime.onMessage.listeners[0];
    assert.equal(
      listener(
        { type: {} },
        { id: api.runtime.id, url: api.runtime.getURL('options.html') },
        () => {}
      ),
      false
    );
    assert.equal(
      listener(
        { type: 'focus:state' },
        { id: api.runtime.id, url: 'https://www.zhihu.com/question/1' },
        () => assert.fail('content script accepted')
      ),
      false
    );
    assert.equal(
      listener(
        { type: 'focus:state' },
        { id: 'another-extension', url: api.runtime.getURL('options.html') },
        () => assert.fail('other extension accepted')
      ),
      false
    );
    let response;
    assert.equal(
      listener(
        { type: 'focus:state' },
        { id: api.runtime.id, url: api.runtime.getURL('options.html') },
        (value) => {
          response = value;
        }
      ),
      true
    );
    await flush();
    assert.equal(response?.ok, true);
    assert.equal(response.data.config.aiModel, 'qwen3:14b');
    let afterFailure;
    listener(
      { type: 'focus:config', payload: { unknown: true } },
      { id: api.runtime.id, url: api.runtime.getURL('options.html') },
      () => {}
    );
    listener(
      { type: 'focus:state' },
      { id: api.runtime.id, url: api.runtime.getURL('options.html') },
      (value) => {
        afterFailure = value;
      }
    );
    await flush();
    assert.equal(afterFailure?.ok, true, 'one rejected operation must not poison the queue');
  } finally {
    globalThis.chrome = originalChrome;
    console.error = originalConsole;
  }
});

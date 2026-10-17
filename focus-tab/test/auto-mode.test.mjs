import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './chrome-mock.mjs';
import { loadConfig } from '../src/config.mjs';
import { blockedBy, canAnalyze, isSearchResults } from '../src/rules.mjs';
import { makePayload, SYSTEM } from '../src/ai.mjs';

const unrelated = { label: 'unrelated', confidence: 0.98, reason: '纯娱乐游戏节目', source: 'ai' };
const related = { label: 'related', confidence: 0.94, reason: '主动学习教程', source: 'ai' };
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
const sender = { tab: { id: 1 }, url: 'chrome-extension://focus-test/blocked.html' };

test('fresh profiles automatically block entertainment while a saved reminder preference is preserved', () => {
  const defaults = loadConfig();
  assert.equal(defaults.autoClassify, true);
  assert.equal(defaults.aiAction, 'block');
  assert.equal(defaults.aiHost, 'http://127.0.0.1:11434');
  assert.equal(loadConfig({ aiAction: 'remind', autoClassify: false }).aiAction, 'remind');
});

test('a final video opened directly without a task is classified and entertainment is blocked', async () => {
  let context;
  const f = await fixture({
    ai: async (_cfg, current) => {
      context = current;
      return unrelated;
    },
  });
  f.engine.config.aiEnabled = true;
  f.state.tabs.get(1).url = 'https://www.bilibili.com/video/BV1zg411777p/';
  f.state.tabs.get(1).title = '输了就滚蛋！ 下一个是谁？_哔哩哔哩_bilibili';
  await f.engine.reconcile();
  f.advance(21000);
  await f.engine.reconcile();
  await f.flush();
  assert.equal(f.engine.session, null);
  assert.equal(context.mode, 'auto');
  assert.equal(context.goal, '');
  assert.ok(f.state.tabs.get(1).url.endsWith('/blocked.html#ai'));
  assert.equal(f.api.storage.session.data['aiBlock:1'].mode, 'auto');
  assert.equal(f.engine.runtime.judgment.mode, 'auto');
});

test('task-only mode waits for a valid task, while explicit manual checks bypass dwell but not NAS limits', async () => {
  let calls = 0,
    lastContext;
  const f = await fixture({
    ai: async (_cfg, context) => {
      calls++;
      lastContext = context;
      return related;
    },
  });
  f.engine.config.autoClassify = false;
  f.engine.config.aiEnabled = true;
  f.advance(21000);
  await f.engine.reconcile();
  await f.flush();
  assert.equal(calls, 0);
  assert.equal((await f.engine.snapshot()).status.code, 'waiting-task');
  await f.start('主动学习图像分析');
  await f.engine.dispatch({ type: 'focus:check' }, {});
  await f.flush();
  assert.equal(calls, 1);
  assert.equal(lastContext.mode, 'task');
  assert.equal(lastContext.goal, '主动学习图像分析');
  f.engine.runtime.cache = [];
  await f.engine.dispatch({ type: 'focus:check' }, {});
  await f.flush();
  assert.equal(calls, 1, 'manual checks cannot bypass the shared request interval');
});

test('search results are never AI input even when their host is explicitly allowlisted', async () => {
  const cfg = loadConfig({
    analysisHosts: [
      'google.com',
      'google.co.uk',
      'google.com.hk',
      'google.de',
      'bing.com',
      'duckduckgo.com',
      'baidu.com',
      'googleusercontent.com',
      'bilibili.com',
      'zhihu.com',
      'youtube.com',
      'x.com',
    ],
  });
  const results = [
    'https://www.google.com/search?q=娱乐',
    'https://www.google.co.uk/search?q=TrackMate',
    'https://www.google.com.hk/search?q=news',
    'https://www.google.de/search?q=学术',
    'https://scholar.google.com/scholar?q=cell',
    'https://www.bing.com/search?q=cell',
    'https://www.bing.com/videos/search?q=cell',
    'https://duckduckgo.com/?q=cell',
    'https://www.baidu.com/s?wd=cell',
    'https://search.bilibili.com/all?keyword=cell',
    'https://www.zhihu.com/search?q=cell',
    'https://www.youtube.com/results?search_query=cell',
    'https://x.com/search?q=cell',
  ];
  for (const url of results) {
    assert.equal(canAnalyze(url, cfg), false, url);
    assert.equal(blockedBy(url, cfg), null, url);
  }
  assert.equal(isSearchResults('https://www.googleusercontent.com/article/research'), false);
  assert.equal(canAnalyze('https://www.googleusercontent.com/article/research', cfg), true);
  assert.equal(isSearchResults('https://www.google.com.evil.test/search?q=secret'), false);
  assert.equal(canAnalyze('https://docs.google.com/document/d/private', cfg), false);
  let calls = 0;
  const f = await fixture({
    ai: async () => {
      calls++;
      return unrelated;
    },
  });
  f.engine.config = { ...cfg, aiEnabled: true };
  f.state.tabs.get(1).url = results[0];
  await f.engine.reconcile();
  f.advance(21000);
  await f.engine.reconcile();
  await f.flush();
  assert.equal(calls, 0);
  assert.equal((await f.engine.snapshot()).status.code, 'excluded');
  const custom = {
    ...cfg,
    customRules: [
      { id: 'explicit-search-rule', host: 'google.com', path: '/search', allPaths: false },
    ],
  };
  assert.ok(blockedBy(results[0], custom), 'an explicit custom rule remains the user’s choice');
  assert.equal(canAnalyze(results[0], custom), false);
});

test('an automatic result becomes stale when a task starts, and a task result becomes stale when ended', async () => {
  for (const fromTask of [false, true]) {
    const result = deferred();
    const f = await fixture({ ai: async () => result.promise });
    if (fromTask) await f.start();
    f.engine.config.aiEnabled = true;
    f.advance(21000);
    await f.engine.reconcile();
    await f.flush();
    assert.ok(f.engine.pending);
    if (fromTask) await f.engine.dispatch({ type: 'focus:end' }, {});
    else await f.start('现在开始科研任务');
    result.resolve(unrelated);
    await f.flush();
    assert.equal(f.state.updates.length, 0);
    assert.equal(f.engine.runtime.judgment, null);
    assert.equal(f.engine.runtime.calls.length, 1);
  }
});

test('task timer expiry invalidates its pending outcome and automatic classification continues afterward', async () => {
  const result = deferred();
  let calls = 0,
    currentMode;
  const f = await fixture({
    ai: async (_cfg, context) => {
      calls++;
      currentMode = context.mode;
      return calls === 1 ? result.promise : related;
    },
  });
  await f.start();
  f.engine.config.aiEnabled = true;
  f.advance(21000);
  await f.engine.reconcile();
  await f.flush();
  f.advance(5 * 60000);
  result.resolve(unrelated);
  await f.flush();
  assert.equal(f.state.updates.length, 0);
  await f.engine.reconcile();
  await f.flush();
  assert.equal(calls, 2);
  assert.equal(currentMode, 'auto');
  assert.equal(f.engine.runtime.judgment.mode, 'auto');
  assert.match(f.engine.runtime.notice, /自动.*判断继续/);
});

test('automatic feedback and explicit task feedback occupy separate document scopes', async () => {
  let calls = 0;
  const f = await fixture({
    ai: async () => {
      calls++;
      return related;
    },
  });
  await f.engine.dispatch(
    { type: 'focus:feedback', payload: { label: 'related', remember: true } },
    {}
  );
  const autoRow = f.engine.feedback[0];
  assert.equal(autoRow.mode, 'auto');
  assert.ok(autoRow.sessionId.startsWith('auto:'));
  f.engine.config.aiEnabled = true;
  f.advance(21000);
  await f.engine.reconcile();
  await f.flush();
  assert.equal(calls, 0);
  assert.equal(f.engine.runtime.judgment.source, 'human');
  await f.start('工作与学习');
  await f.engine.reconcile();
  await f.flush();
  assert.equal(calls, 1);
  assert.equal(f.engine.runtime.judgment.source, 'ai');
  await f.engine.dispatch(
    { type: 'focus:feedback', payload: { label: 'uncertain', remember: true } },
    {}
  );
  assert.notEqual(f.engine.feedback[1].key, autoRow.key);
  await f.engine.dispatch({ type: 'focus:end' }, {});
  await f.engine.reconcile();
  await f.flush();
  assert.equal(f.engine.runtime.judgment.source, 'human');
  assert.equal(f.engine.runtime.judgment.label, 'related');
});

test('non-remembered automatic feedback survives a worker wake, but does not cross browser sessions', async () => {
  const first = await fixture();
  await first.engine.dispatch(
    { type: 'focus:feedback', payload: { label: 'related', remember: false } },
    {}
  );
  let calls = 0;
  const sameBrowser = await fixture({
    local: structuredClone(first.api.storage.local.data),
    session: structuredClone(first.api.storage.session.data),
    ai: async () => {
      calls++;
      return related;
    },
  });
  assert.equal(sameBrowser.engine.runtime.autoSessionId, first.engine.runtime.autoSessionId);
  sameBrowser.engine.config.aiEnabled = true;
  sameBrowser.advance(21000);
  await sameBrowser.engine.reconcile();
  await sameBrowser.flush();
  assert.equal(calls, 0);
  assert.equal(sameBrowser.engine.runtime.judgment.source, 'human');
  const nextBrowser = await fixture({
    local: structuredClone(first.api.storage.local.data),
    ai: async () => {
      calls++;
      return related;
    },
  });
  assert.notEqual(nextBrowser.engine.runtime.autoSessionId, first.engine.runtime.autoSessionId);
  nextBrowser.engine.config.aiEnabled = true;
  nextBrowser.advance(21000);
  await nextBrowser.engine.reconcile();
  await nextBrowser.flush();
  assert.equal(calls, 1);
  assert.equal(nextBrowser.engine.runtime.judgment.source, 'ai');
});

test('an automatic AI block is correctable without a task and reused entertainment still enforces on a new tab', async () => {
  let calls = 0;
  const f = await fixture({
    ai: async () => {
      calls++;
      return unrelated;
    },
  });
  f.engine.config.aiEnabled = true;
  f.advance(21000);
  await f.engine.reconcile();
  await f.flush();
  const original = f.api.storage.session.data['aiBlock:1'].url;
  const context = await f.engine.dispatch({ type: 'focus:blocked', payload: { ai: true } }, sender);
  assert.equal(context.mode, 'auto');
  await f.engine.dispatch(
    { type: 'focus:feedback', payload: { ai: true, label: 'related', remember: false } },
    sender
  );
  assert.equal(await f.engine.aiBlock(1, original), null);
  await f.engine.dispatch({ type: 'focus:clear' }, {});
  f.engine.runtime.cache = [
    {
      ...unrelated,
      mode: 'auto',
      key: f.engine.contextKey(f.engine.effectiveContext(), original, 'TrackMate 教程'),
      created: f.now(),
    },
  ];
  f.state.tabs.set(2, { id: 2, windowId: 1, active: true, url: original, title: 'TrackMate 教程' });
  f.state.tabs.get(1).active = false;
  await f.engine.reconcile();
  f.advance(21000);
  await f.engine.reconcile();
  await f.flush();
  assert.equal(calls, 1, 'a cached classification must avoid a second NAS request');
  assert.ok(f.state.tabs.get(2).url.endsWith('/blocked.html#ai'));
});

test('403 failures stay visible, fail open, and share the same NAS budget across automatic/task modes', async () => {
  let calls = 0;
  const f = await fixture({
    ai: async () => {
      calls++;
      throw new Error('403 Forbidden: origin rejected');
    },
  });
  f.engine.config.aiEnabled = true;
  f.engine.config.requestsPerHour = 1;
  await f.engine.dispatch({ type: 'focus:check' }, {});
  await f.flush();
  assert.match(f.engine.runtime.error, /403 Forbidden/);
  assert.equal(f.state.updates.length, 0);
  f.state.tabs.get(1).url = 'https://www.bilibili.com/video/another';
  await f.engine.reconcile();
  assert.match((await f.engine.snapshot()).error, /403 Forbidden/);
  assert.equal((await f.engine.snapshot()).status.code, 'error');
  await f.start('新研究目标');
  f.advance(100000);
  await f.engine.dispatch({ type: 'focus:check' }, {});
  await f.flush();
  assert.equal(calls, 1);
});

test('entertainment query text cannot itself instruct the classifier to label consumption as work', () => {
  assert.match(SYSTEM, /即使它与检索词或task标题相符，也不能因此判为related/);
  const payload = makePayload(
    loadConfig(),
    { mode: 'task', goal: '下一个是谁娱乐节目' },
    {
      title: '输了就滚蛋！ 下一个是谁？',
      url: 'https://www.bilibili.com/video/BVpublic/',
      excerpt: '六位up主齐聚别墅，游戏失败者淘汰回家。标签：搞笑 生活 预告。',
    }
  );
  const input = JSON.parse(payload.messages[1].content);
  assert.equal(input.mode, 'task');
  assert.equal(input.task, '下一个是谁娱乐节目');
  const autoInput = JSON.parse(
    makePayload(
      loadConfig(),
      { mode: 'auto', goal: '' },
      { title: '教程', url: 'https://www.bilibili.com/video/BVpublic/', excerpt: '' }
    ).messages[1].content
  );
  assert.equal(autoInput.mode, 'auto');
  assert.equal(autoInput.task, '');
});

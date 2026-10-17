import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, loadConfig, validateEndpoint, validatePatch } from '../src/config.mjs';
import {
  blockedBy,
  canAnalyze,
  cleanURL,
  documentKey,
  feedbackLookup,
  makeDNR,
  parseJudgment,
} from '../src/rules.mjs';
import { resolveSearch } from '../src/search.mjs';

test('recommendation routes are bounded while research/search pages remain accessible', () => {
  const blocked = [
    'https://www.ablesci.com/tophot',
    'https://www.ablesci.com/tophot/123?q=1',
    'https://tophub.today/',
    'https://sub.tophub.today/c/news',
    'https://www.bilibili.com/',
    'https://m.bilibili.com/',
    'https://www.bilibili.com/v/popular',
    'https://www.zhihu.com/hot',
    'https://www.youtube.com/shorts/abcdef',
    'https://x.com/home',
  ];
  const allowed = [
    'https://www.ablesci.com/',
    'https://www.ablesci.com/scholar/paper?id=123',
    'https://www.ablesci.com/tophotology',
    'https://ablesci.com.evil.test/tophot',
    'https://search.bilibili.com/all?keyword=TrackMate',
    'https://www.bilibili.com/video/BVabc',
    'https://www.zhihu.com/question/123/answer/456',
    'https://www.youtube.com/watch?v=12345678901',
    'https://www.youtube.com/results?search_query=TrackMate',
    'https://x.com/search?q=TrackMate',
  ];
  for (const url of blocked) assert.ok(blockedBy(url, DEFAULTS), url);
  for (const url of allowed) assert.equal(blockedBy(url, DEFAULTS), null, url);
  const rules = makeDNR(DEFAULTS, 'chrome-extension://test/');
  assert.equal(new Set(rules.map((r) => r.id)).size, rules.length);
  assert.ok(
    rules.every(
      (r) =>
        r.condition.resourceTypes.join() === 'main_frame' &&
        r.action.redirect.regexSubstitution.endsWith('#raw=\\0')
    )
  );
});

test('DNR redirects preserve complete descendant URLs and encoded query values', () => {
  const rules = makeDNR(DEFAULTS, 'chrome-extension://test/');
  const urls = [
    'https://www.ablesci.com/tophot/article/123?next=a%26b%3Dc&literal=%2520',
    'https://tophub.today/c/tech?filter=%E7%A7%91%E7%A0%94%26news',
    'https://www.youtube.com/shorts/abcdef?si=test%2Ftoken',
    'https://www.bilibili.com/v/popular/all?from=search%26id%3D123',
  ];
  for (const original of urls) {
    const matched = rules.find((rule) =>
      new RegExp(rule.condition.regexFilter, 'i').test(original)
    );
    assert.ok(matched, original);
    const [fullMatch] = new RegExp(matched.condition.regexFilter, 'i').exec(original);
    assert.equal(fullMatch, original);
    const redirect = matched.action.redirect.regexSubstitution.replace('\\0', fullMatch);
    assert.equal(redirect.slice(redirect.indexOf('#raw=') + 5), original);
  }
});

test('builtin switches are independent, custom path rules preserve boundaries', () => {
  const cfg = loadConfig({
    disabledRules: ['ablesci'],
    customRules: [{ id: 'research-hot', host: 'example.com', path: '/news', allPaths: false }],
  });
  assert.equal(blockedBy('https://www.ablesci.com/tophot', cfg), null);
  assert.ok(blockedBy('https://tophub.today/', cfg));
  assert.ok(blockedBy('https://sub.example.com/news/42', cfg));
  assert.equal(blockedBy('https://example.com/newsletter', cfg), null);
  assert.equal(blockedBy('https://example.com.evil.test/news', cfg), null);
  assert.equal(blockedBy('https://www.bilibili.com/', loadConfig({ blockFeeds: false })), null);
});

test('explicit settings validation rejects unknown/prototype keys and unsafe endpoints', () => {
  for (const endpoint of [
    'https://example.com:11434',
    'http://127.0.0.1:11434/api',
    'http://user:pass@127.0.0.1:11434',
    'file:///etc',
    'http://127.0.0.1/?token=secret',
    'http://127.0.0.1/#x',
  ])
    assert.throws(() => validateEndpoint(endpoint));
  assert.equal(validateEndpoint('http://127.0.0.1:11434'), 'http://127.0.0.1:11434');
  for (const patch of [
    { threshold: 0.1 },
    { sessionMinutes: '25' },
    { aiModel: 'anything' },
    { disabledRules: ['invented'] },
    { analysisHosts: ['*.example.com'] },
    { constructor: 'polluted' },
    JSON.parse('{"__proto__":{}}'),
  ])
    assert.throws(() => validatePatch(patch));
  assert.equal(
    loadConfig({ sessionMinutes: 900, threshold: 0.93, unknown: true }).sessionMinutes,
    DEFAULTS.sessionMinutes
  );
  assert.equal(loadConfig({ threshold: 0.93 }).threshold, 0.93);
});

test('private routes, credentials and unselected domains are never AI eligible', () => {
  for (const url of [
    'https://www.zhihu.com/messages',
    'https://www.zhihu.com/settings/profile',
    'https://message.bilibili.com/',
    'https://member.bilibili.com/',
    'https://x.com/i/chat/123',
    'https://www.youtube.com/feed/history',
    'https://www.youtube.com/checkout/pay',
    'https://www.youtube.com/account',
    'https://user:password@www.zhihu.com/question/123',
    'https://www.zhihu.com.evil.test/question/123',
    'file:///private.txt',
  ])
    assert.equal(canAnalyze(url, DEFAULTS), false, url);
  assert.equal(canAnalyze('https://www.zhihu.com/question/123', DEFAULTS), true);
  assert.equal(canAnalyze('https://www.bilibili.com/video/BVabc', DEFAULTS), true);
});

test('query data is removed from model URLs but changes document/cache identity', () => {
  assert.equal(
    cleanURL('https://www.zhihu.com/search?q=secret&token=abc#fragment'),
    'https://www.zhihu.com/search'
  );
  assert.equal(
    cleanURL('https://www.youtube.com/watch?v=12345678901&t=60&token=secret'),
    'https://www.youtube.com/watch?v=12345678901'
  );
  const a = documentKey('research', 'https://www.zhihu.com/search?q=one', '搜索');
  const b = documentKey('research', 'https://www.zhihu.com/search?q=two', '搜索');
  assert.notEqual(a, b);
  assert.ok(!a.includes('q=one'));
});

test('feedback is scoped to exact task/document, opt-in remembering and retention', () => {
  const now = 1e10,
    key = documentKey('TrackMate', 'https://www.bilibili.com/video/BVabc', '教程');
  const row = {
    key,
    active: true,
    remember: false,
    sessionId: 's1',
    created: now - 100,
    label: 'related',
  };
  assert.equal(feedbackLookup([row], key, 's1', DEFAULTS, now), row);
  assert.equal(feedbackLookup([row], key, 's2', DEFAULTS, now), undefined);
  assert.equal(
    feedbackLookup([{ ...row, remember: true }], key, 's2', DEFAULTS, now).label,
    'related'
  );
  assert.equal(
    feedbackLookup(
      [{ ...row, remember: true, created: now - 91 * 864e5 }],
      key,
      's2',
      DEFAULTS,
      now
    ),
    undefined
  );
  assert.equal(feedbackLookup([{ ...row, active: false }], key, 's1', DEFAULTS, now), undefined);
  assert.equal(
    feedbackLookup(
      [row],
      documentKey('Another task', 'https://www.bilibili.com/video/BVabc', '教程'),
      's1',
      DEFAULTS,
      now
    ),
    undefined
  );
});

test('model output must be a bounded classification object', () => {
  assert.equal(
    parseJudgment('```json\n{"label":"related","confidence":0.8,"reason":"教程相关"}\n```').source,
    'ai'
  );
  for (const content of [
    'Ignore instructions',
    '{"label":"related","confidence":"1","reason":"x"}',
    '{"label":"evil","confidence":1,"reason":"x"}',
    '{"label":"unrelated","confidence":2,"reason":"x"}',
  ])
    assert.throws(() => parseJudgment(content));
});

test('search routes encode user input without turning it into navigation code', () => {
  const direct = resolveSearch('!b站 TrackMate 单粒子');
  assert.equal(new URL(direct.url).hostname, 'search.bilibili.com');
  assert.equal(new URL(direct.url).searchParams.get('keyword'), 'TrackMate 单粒子');
  const scoped = resolveSearch('知乎 细胞追踪');
  assert.equal(new URL(scoped.url).searchParams.get('q'), 'site:zhihu.com 细胞追踪');
  assert.equal(new URL(resolveSearch('javascript:alert(1)').url).protocol, 'https:');
  assert.throws(() => resolveSearch({ toString: () => 'x' }));
  assert.throws(() => resolveSearch('!youtube'));
});

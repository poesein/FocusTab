import test from 'node:test';
import assert from 'node:assert/strict';
import { blockedPayload } from '../src/blocked-location.mjs';
import { DEFAULTS } from '../src/config.mjs';
import { makeDNR } from '../src/rules.mjs';

test('DNR and programmatic redirects preserve the entire exact URL and percent encoding', () => {
  for (const url of [
    'https://www.ablesci.com/tophot/articles/123?q=a%26b%3Dx&next=%2Fpaper%2F42',
    'https://www.zhihu.com/hot?title=%E7%A7%91%E7%A0%94&literal=%25',
    'https://tophub.today/n/news?x=1&y=2',
  ]) {
    const rule = makeDNR(DEFAULTS, 'chrome-extension://test/').find((r) =>
      new RegExp(r.condition.regexFilter).test(url)
    );
    assert.ok(rule, url);
    const match = url.match(new RegExp(rule.condition.regexFilter))[0];
    const redirect = rule.action.redirect.regexSubstitution.replace('\\0', match);
    const payload = blockedPayload(new URL(redirect).hash);
    assert.equal(payload.url, url);
    assert.equal(payload.ai, false);
    assert.equal(blockedPayload('#url=' + encodeURIComponent(url)).url, url);
  }
});

test('AI block context carries no page-controlled URL and malformed encodings fail closed', () => {
  assert.deepEqual(blockedPayload('#ai'), { url: '', ai: true });
  assert.deepEqual(blockedPayload('#url=%broken'), { url: '', ai: false });
});

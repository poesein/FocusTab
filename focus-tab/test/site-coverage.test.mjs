import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, loadConfig } from '../src/config.mjs';
import {
  blockedBy,
  canAnalyze,
  cleanURL,
  documentKey,
  explainAnalysisEligibility,
  makeDNR,
} from '../src/rules.mjs';
import { resolveSearch } from '../src/search.mjs';
import { SITE_COVERAGE } from './fixtures/site-coverage.mjs';

for (const site of new Set(SITE_COVERAGE.map((row) => row.site))) {
  test(`site coverage: ${site} static redirects, AI eligibility and explanatory reasons`, () => {
    const dnr = makeDNR(DEFAULTS, 'chrome-extension://example/');
    for (const row of SITE_COVERAGE.filter((row) => row.site === site)) {
      const label = `${row.label}: ${row.url}`;
      assert.equal(!!blockedBy(row.url, DEFAULTS), row.blocked, label + ' programmatic rule');
      assert.equal(
        dnr.some((rule) => new RegExp(rule.condition.regexFilter, 'i').test(row.url)),
        row.blocked,
        label + ' DNR rule'
      );
      const explanation = explainAnalysisEligibility(row.url, DEFAULTS);
      assert.equal(explanation.code, row.code, label + ' reason');
      assert.equal(explanation.eligible, row.code === 'eligible', label + ' eligibility');
      assert.equal(
        canAnalyze(row.url, DEFAULTS),
        explanation.eligible,
        label + ' boolean API parity'
      );
      assert.ok(explanation.message.length > 5, label + ' human-readable explanation');
    }
  });
}

test('mobile/feed aliases respect each original builtin switch without broadening subdomains', () => {
  assert.equal(
    blockedBy(
      'https://m.bilibili.com/v/popular',
      loadConfig({ disabledRules: ['bilibili-mobile'] })
    ),
    null
  );
  assert.ok(
    blockedBy(
      'https://www.bilibili.com/v/popular',
      loadConfig({ disabledRules: ['bilibili-mobile'] })
    )
  );
  assert.ok(
    blockedBy('https://m.bilibili.com/v/popular', loadConfig({ disabledRules: ['bilibili'] }))
  );
  assert.equal(
    blockedBy('https://www.bilibili.com/v/popular', loadConfig({ disabledRules: ['bilibili'] })),
    null
  );
  for (const [id, domain] of [
    ['x', 'x.com'],
    ['twitter', 'twitter.com'],
  ]) {
    const config = loadConfig({ disabledRules: [id] });
    for (const host of [domain, 'www.' + domain, 'm.' + domain, 'mobile.' + domain])
      assert.equal(blockedBy('https://' + host + '/home', config), null, host);
    assert.equal(blockedBy('https://developer.' + domain + '/home', DEFAULTS), null);
    assert.equal(blockedBy('https://www.mobile.' + domain + '/home', DEFAULTS), null);
  }
  const disabled = loadConfig({ disabledRules: ['zhihu'] });
  assert.equal(blockedBy('https://www.zhihu.com/zvideo/', disabled), null);
  assert.equal(
    blockedBy('https://m.ablesci.com/tophot', loadConfig({ disabledRules: ['ablesci'] })),
    null
  );
});

test('zvideo root matching does not suppress concrete videos or lookalike paths', () => {
  for (const path of ['/zvideo', '/zvideo/', '/zvideo?from=example', '/zvideo/#tab'])
    assert.ok(blockedBy('https://www.zhihu.com' + path, DEFAULTS), path);
  for (const path of ['/zvideo/12345', '/zvideo/12345?from=example', '/zvideo2', '/zvideography']) {
    assert.equal(blockedBy('https://www.zhihu.com' + path, DEFAULTS), null, path);
    assert.equal(canAnalyze('https://www.zhihu.com' + path, DEFAULTS), true, path);
  }
});

test('only valid Bilibili video part identifiers survive URL cleaning', () => {
  const base = 'https://www.bilibili.com/video/BV1zg411777p/';
  for (const [part, expected] of [
    ['1', '1'],
    ['0002', '2'],
    ['10000', '10000'],
    ['0', null],
    ['-2', null],
    ['10001', null],
    ['1.5', null],
    ['1e2', null],
    ['2&secret=example', null],
  ]) {
    const cleaned = new URL(
      cleanURL(
        base + '?p=' + encodeURIComponent(part) + '&token=secret&spm_id_from=example#fragment'
      )
    );
    assert.equal(cleaned.searchParams.get('p'), expected, part);
    assert.ok(!cleaned.href.includes('secret') && !cleaned.hash);
    assert.equal([...cleaned.searchParams].length, expected ? 1 : 0);
  }
  assert.equal(
    cleanURL('https://m.bilibili.com/video/BVexample?p=2&token=secret'),
    'https://m.bilibili.com/video/BVexample?p=2'
  );
  assert.equal(
    cleanURL('https://www.bilibili.com/bangumi/play/ep123?p=2'),
    'https://www.bilibili.com/bangumi/play/ep123'
  );
  assert.notEqual(
    documentKey('research', base + '?p=1', 'same title'),
    documentKey('research', base + '?p=2', 'same title')
  );
});

test('unselected hosts never become AI eligible merely because feeds are disabled', () => {
  const config = loadConfig({ blockFeeds: false });
  for (const url of [
    'https://www.ablesci.com/tophot',
    'https://tophub.today/c/example',
    'https://example.org/article',
  ]) {
    assert.equal(blockedBy(url, config), null);
    assert.equal(explainAnalysisEligibility(url, config).code, 'unselected-host');
  }
  assert.deepEqual(config.analysisHosts, DEFAULTS.analysisHosts);
});

test('known private/search exclusions remain in force with explicit host selection and feeds disabled', () => {
  const config = loadConfig({
    blockFeeds: false,
    analysisHosts: [...DEFAULTS.analysisHosts, 'google.com'],
  });
  for (const row of SITE_COVERAGE.filter(
    (row) => row.code === 'private-page' || row.code === 'search-results'
  ))
    assert.equal(canAnalyze(row.url, config), false, row.url);
  assert.equal(canAnalyze('https://www.youtube.com/playlist?list=PLpublic_example', config), true);
  assert.equal(canAnalyze('https://www.zhihu.com/collection/12345', config), true);
  for (const name of ['my-lab', 'creator-lab', 'favorites-lab', 'watchlater-lab'])
    assert.equal(
      canAnalyze('https://x.com/' + name + '/status/12345', config),
      true,
      'a public account name must not be mistaken for a private route'
    );
});

test('supported direct search shortcuts stay searchable without AI-classifying their result pages', () => {
  for (const query of [
    '!b站 TrackMate',
    '!zhihu TrackMate',
    '!youtube TrackMate',
    '!twitter TrackMate',
    '谷歌学术 TrackMate',
    '科研通 TrackMate',
  ]) {
    const result = resolveSearch(query);
    assert.equal(blockedBy(result.url, DEFAULTS), null, query);
    assert.equal(explainAnalysisEligibility(result.url, DEFAULTS).code, 'search-results', query);
  }
});

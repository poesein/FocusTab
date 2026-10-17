import { patternToRegExp } from './vendor/leechblock-pattern.mjs';

// Independent small RE2-compatible expressions: browser limits apply per regex.
const rule = (id, name, host, paths, subdomains = false) => ({ id, name, host, paths, subdomains });
export const BUILTINS = [
  rule('ablesci', '科研通 · 热点', 'ablesci.com', ['/tophot']),
  rule('tophub', '今日热榜 · 全站', 'tophub.today', null, true),
  rule('bilibili', 'B站 · 推荐与热门', 'bilibili.com', [
    '/',
    '/v/popular',
    '/v/channel',
    '/v/douga',
    '/v/life',
    '/v/ent',
    '/v/dance',
    '/v/music',
    '/v/game',
  ]),
  rule('bilibili-mobile', 'B站 · 手机推荐', 'm.bilibili.com', ['/']),
  rule('zhihu', '知乎 · 推荐与热榜', 'zhihu.com', ['/', '/hot', '/explore', '/follow', '/zvideo']),
  rule('youtube', 'YouTube · 推荐与 Shorts', 'youtube.com', [
    '/',
    '/shorts',
    '/feed/trending',
    '/feed/explore',
  ]),
  rule('youtube-mobile', 'YouTube · 手机推荐', 'm.youtube.com', [
    '/',
    '/shorts',
    '/feed/trending',
    '/feed/explore',
  ]),
  rule('x', 'X · 推荐与趋势', 'x.com', ['/', '/home', '/explore', '/i/trending']),
  rule('twitter', 'Twitter · 推荐与趋势', 'twitter.com', ['/', '/home', '/explore', '/i/trending']),
];

export function hostIs(host, domain) {
  return host === domain || host.endsWith('.' + domain);
}
export function httpURL(raw) {
  try {
    const u = new URL(raw);
    return ['https:', 'http:'].includes(u.protocol) ? u : null;
  } catch {
    return null;
  }
}

export function ruleExpressions(config) {
  const entries = config.blockFeeds
    ? BUILTINS.filter((r) => !(config.disabledRules || []).includes(r.id))
    : [];
  const list = entries.flatMap((r) => (r.paths || [null]).map((path) => ({ ...r, path })));
  for (const r of config.customRules || [])
    list.push({ ...r, name: r.host + r.path, subdomains: true, path: r.allPaths ? null : r.path });
  return list.map((r, i) => {
    // LeechBlock handles escaping/wildcards. Explicit host/path boundaries below
    // prevent "ablesci.com.evil" and "/tophotology" from matching.
    const host = patternToRegExp(r.host, r.subdomains);
    let path = '';
    if (r.path === '/') path = '/?(?:[?#]|$)';
    else if (r.path !== null)
      path = r.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\/$/, '') + '(?:/|[?#]|$)';
    else path = '(?:/|[?#]|$)';
    return { id: i + 1, name: r.name, regex: `^https?://${host}(?::[0-9]+)?${path}` };
  });
}

export function blockedBy(raw, config) {
  const u = httpURL(raw);
  if (!u) return null;
  return ruleExpressions(config).find((r) => new RegExp(r.regex, 'i').test(u.href)) || null;
}

export function cleanURL(raw) {
  const u = httpURL(raw);
  if (!u) return '';
  const video =
    hostIs(u.hostname, 'youtube.com') && u.pathname === '/watch' ? u.searchParams.get('v') : '';
  u.username = '';
  u.password = '';
  u.search = '';
  u.hash = '';
  if (/^[A-Za-z0-9_-]{11}$/.test(video || '')) u.searchParams.set('v', video);
  return u.href;
}

export function canAnalyze(raw, config) {
  const u = httpURL(raw);
  if (!u || u.username || u.password || !config.analysisHosts.some((h) => hostIs(u.hostname, h)))
    return false;
  // Account, message and private application routes are never sent to the model.
  if (
    /\/(?:messages?|settings|notifications|login|signin|logout|signup|account|passport|checkout|payment|history|orders?|inbox|wallet|billing)(?:\/|$)/i.test(
      u.pathname
    )
  )
    return false;
  if (
    /^\/(?:i\/(?:chat|flow|bookmarks)|feed\/(?:history|subscriptions|library)|creator|my|favorites|watchlater)\b/i.test(
      u.pathname
    )
  )
    return false;
  if (
    hostIs(u.hostname, 'bilibili.com') &&
    /^(?:member|message|account|passport)\./.test(u.hostname)
  )
    return false;
  return !blockedBy(raw, config);
}

export function documentKey(goal, url, title) {
  // Distinguish search queries/SPA fragments without persisting their text in
  // feedback keys. This digest identifies documents; it is not encryption.
  let hash = 14695981039346656037n;
  for (const char of String(url))
    hash = BigInt.asUintN(64, (hash ^ BigInt(char.codePointAt(0))) * 1099511628211n);
  return JSON.stringify([
    goal.replace(/\s+/g, '').toLocaleLowerCase(),
    cleanURL(url),
    title.slice(0, 300),
    hash.toString(16),
  ]);
}

export function parseJudgment(content) {
  const row = JSON.parse(content.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  if (
    !row ||
    !['related', 'unrelated', 'uncertain'].includes(row.label) ||
    typeof row.confidence !== 'number' ||
    !Number.isFinite(row.confidence) ||
    row.confidence < 0 ||
    row.confidence > 1 ||
    typeof row.reason !== 'string'
  )
    throw new Error('模型返回格式无效');
  return {
    label: row.label,
    confidence: row.confidence,
    reason: row.reason.slice(0, 160),
    source: 'ai',
  };
}

export function feedbackLookup(rows, key, sessionId, config, now = Date.now()) {
  return [...rows]
    .reverse()
    .find(
      (r) =>
        r.key === key &&
        r.active &&
        now - r.created < config.retentionDays * 864e5 &&
        (r.remember || r.sessionId === sessionId)
    );
}

export function makeDNR(config, extensionURL) {
  return ruleExpressions(config).map((r) => ({
    id: r.id,
    priority: 1,
    // Consume the full request URL so descendants and encoded query values are
    // preserved in \\0. The UI treats raw= as already escaped URL data.
    action: {
      type: 'redirect',
      redirect: { regexSubstitution: extensionURL + 'blocked.html#raw=\\0' },
    },
    condition: {
      regexFilter: r.regex + '.*',
      isUrlFilterCaseSensitive: false,
      resourceTypes: ['main_frame'],
    },
  }));
}

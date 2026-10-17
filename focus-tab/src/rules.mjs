import { patternToRegExp } from './vendor/leechblock-pattern.mjs';

// Independent small RE2-compatible expressions: browser limits apply per regex.
const rule = (id, name, host, paths, subdomains = false, options = {}) => ({
  id,
  name,
  host,
  paths,
  subdomains,
  ...options,
});
const BILIBILI_FEEDS = [
  '/',
  '/v/popular',
  '/v/channel',
  '/v/douga',
  '/v/life',
  '/v/ent',
  '/v/dance',
  '/v/music',
  '/v/game',
];
export const BUILTINS = [
  rule('ablesci', '科研通 · 热点', 'ablesci.com', ['/tophot'], true),
  rule('tophub', '今日热榜 · 全站', 'tophub.today', null, true),
  rule('bilibili', 'B站 · 推荐与热门', 'bilibili.com', BILIBILI_FEEDS),
  rule('bilibili-mobile', 'B站 · 手机推荐', 'm.bilibili.com', BILIBILI_FEEDS),
  rule(
    'zhihu',
    '知乎 · 推荐与热榜',
    'zhihu.com',
    ['/', '/hot', '/explore', '/follow', '/zvideo'],
    false,
    {
      // The video recommendation entry is a feed; /zvideo/<id> is a concrete
      // video and must remain available for task-relatedness classification.
      exactPaths: ['/zvideo'],
    }
  ),
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
  rule('x', 'X · 推荐与趋势', 'x.com', ['/', '/home', '/explore', '/i/trending'], false, {
    hostAliases: ['m.x.com', 'mobile.x.com'],
  }),
  rule(
    'twitter',
    'Twitter · 推荐与趋势',
    'twitter.com',
    ['/', '/home', '/explore', '/i/trending'],
    false,
    {
      hostAliases: ['m.twitter.com', 'mobile.twitter.com'],
    }
  ),
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
  const list = entries.flatMap((r) =>
    [r.host, ...(r.hostAliases || [])].flatMap((host, aliasIndex) =>
      (r.paths || [null]).map((path) => ({ ...r, host, path, exactHost: aliasIndex > 0 }))
    )
  );
  for (const r of config.customRules || [])
    list.push({ ...r, name: r.host + r.path, subdomains: true, path: r.allPaths ? null : r.path });
  return list.map((r, i) => {
    // LeechBlock handles escaping/wildcards. Explicit host/path boundaries below
    // prevent "ablesci.com.evil" and "/tophotology" from matching.
    const host = r.exactHost
      ? r.host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      : patternToRegExp(r.host, r.subdomains);
    let path = '';
    if (r.path === '/') path = '/?(?:[?#]|$)';
    else if (r.path !== null)
      path =
        r.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\/$/, '') +
        (r.exactPaths?.includes(r.path) ? '/?(?:[?#]|$)' : '(?:/|[?#]|$)');
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
  const rawPart =
    hostIs(u.hostname, 'bilibili.com') && /^\/video\//.test(u.pathname)
      ? u.searchParams.get('p')
      : null;
  u.username = '';
  u.password = '';
  u.search = '';
  u.hash = '';
  if (/^[A-Za-z0-9_-]{11}$/.test(video || '')) u.searchParams.set('v', video);
  if (/^[0-9]{1,10}$/.test(rawPart || '') && Number(rawPart) >= 1 && Number(rawPart) <= 10000)
    u.searchParams.set('p', String(Number(rawPart)));
  return u.href;
}

export function isSearchResults(raw) {
  const u = httpURL(raw);
  if (!u) return false;
  const host = u.hostname,
    path = u.pathname;
  // Match Google domains, not similarly named content hosts such as
  // googleusercontent.com. Only search/redirect entry routes are excluded.
  if (
    /(^|\.)google\.(?:com|[a-z]{2,3}|com\.[a-z]{2}|co\.[a-z]{2})$/.test(host) &&
    /^\/(?:$|search(?:\/|$)|webhp(?:\/|$)|imghp(?:\/|$)|videohp(?:\/|$)|scholar(?:\/|$)|url(?:\/|$))/.test(
      path
    )
  )
    return true;
  if (
    (hostIs(host, 'bing.com') || hostIs(host, 'bing.cn')) &&
    /^\/(?:$|search(?:\/|$)|(?:images|videos|news)\/search(?:\/|$))/.test(path)
  )
    return true;
  if (hostIs(host, 'duckduckgo.com') && /^\/(?:$|html\/?$|lite\/?$)/.test(path)) return true;
  if (
    (host === 'search.yahoo.com' ||
      host === 'search.brave.com' ||
      host === 'www.ecosia.org' ||
      host === 'ecosia.org') &&
    /^\/(?:$|search(?:\/|$))/.test(path)
  )
    return true;
  if (
    hostIs(host, 'baidu.com') &&
    /^\/(?:$|s(?:\/|$)|baidu(?:\/|$)|sf\/vsearch(?:\/|$))/.test(path)
  )
    return true;
  if (
    host === 'search.bilibili.com' ||
    (hostIs(host, 'bilibili.com') && /^\/search(?:\/|$)/.test(path)) ||
    (hostIs(host, 'zhihu.com') && /^\/search(?:\/|$)/.test(path)) ||
    (hostIs(host, 'youtube.com') && /^\/(?:results|search)(?:\/|$)/.test(path)) ||
    ((hostIs(host, 'x.com') || hostIs(host, 'twitter.com')) && /^\/search(?:\/|$)/.test(path))
  )
    return true;
  return false;
}

function isPrivatePage(u) {
  if (u.username || u.password) return true;
  // Account, message and private application routes are never sent to the model.
  if (
    /\/(?:messages?|settings|notifications|login|signin|logout|signup|account|passport|checkout|payment|history|orders?|inbox|wallet|billing)(?:\/|$)/i.test(
      u.pathname
    )
  )
    return true;
  if (
    /^\/(?:i\/(?:chat|flow|bookmarks)|feed\/(?:history|subscriptions|library)|creator|my|favorites|watchlater)(?:\/|$)/i.test(
      u.pathname
    )
  )
    return true;
  if (hostIs(u.hostname, 'bilibili.com')) {
    if (/^(?:member|message|account|passport)\./.test(u.hostname)) return true;
    if (/^\/(?:list|medialist\/play)\/watchlater(?:\/|$)/i.test(u.pathname)) return true;
    if (
      hostIs(u.hostname, 'space.bilibili.com') &&
      /^\/(?:[0-9]+|self)\/favlist(?:\/|$)/i.test(u.pathname)
    )
      return true;
  }
  if (hostIs(u.hostname, 'youtube.com')) {
    if (hostIs(u.hostname, 'studio.youtube.com')) return true;
    if (
      /^\/feed\/(?:you|playlists|channels|downloads|purchases)(?:\/|$)/i.test(u.pathname) ||
      /^\/(?:account(?:_|\/|$)|paid_memberships(?:\/|$))/i.test(u.pathname)
    )
      return true;
    if (/^\/playlist\/?$/i.test(u.pathname) && ['WL', 'LL'].includes(u.searchParams.get('list')))
      return true;
  }
  if (
    (hostIs(u.hostname, 'x.com') || hostIs(u.hostname, 'twitter.com')) &&
    /^\/(?:compose|drafts)(?:\/|$)/i.test(u.pathname)
  )
    return true;
  if (
    hostIs(u.hostname, 'zhihu.com') &&
    (/^\/(?:drafts?|write)(?:\/|$)/i.test(u.pathname) ||
      /^\/people\/[^/]+\/collections(?:\/|$)/i.test(u.pathname))
  )
    return true;
  if (/^(?:docs|drive|mail|calendar|accounts)\.google\./.test(u.hostname)) return true;
  return false;
}

export function explainAnalysisEligibility(raw, config) {
  const u = httpURL(raw);
  const result = (eligible, code, message) => ({ eligible, code, message });
  if (!u) return result(false, 'unsupported-url', '仅支持普通 HTTP/HTTPS 网页，此页不发送给 AI。');
  if (isPrivatePage(u))
    return result(false, 'private-page', '账号、私信、后台或个人功能页面不发送给 AI。');
  if (isSearchResults(raw))
    return result(false, 'search-results', '搜索入口与结果仅用于检索，不发送给 AI。');
  if (blockedBy(raw, config))
    return result(
      false,
      'feed-blocked',
      '此页命中热点、推荐入口或自定义网址规则，由网址拦截处理。'
    );
  if (!(config.analysisHosts || []).some((h) => hostIs(u.hostname, h)))
    return result(false, 'unselected-host', '此网站未加入 AI 检测名单，不会发送给 AI。');
  return result(true, 'eligible', '此页符合站点、搜索和隐私筛选，可进入 AI 判断。');
}

export function canAnalyze(raw, config) {
  return explainAnalysisEligibility(raw, config).eligible;
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

const TRACKING = new Set([
  "spm_id_from",
  "spm_id",
  "vd_source",
  "from_spmid",
  "from",
  "seid",
  "share_source",
  "share_medium",
  "share_plat",
  "share_tag",
  "share_session_id",
]);

function bilibiliVideo(raw) {
  try {
    const url = new URL(raw);
    return /^https?:$/.test(url.protocol) &&
      /(^|\.)bilibili\.com$/.test(url.hostname) &&
      /^\/video\/(?:BV[A-Za-z0-9]+|av[0-9]+)\/?$/.test(url.pathname)
      ? url
      : null;
  } catch {
    return null;
  }
}

export function semanticPageURL(raw) {
  const url = bilibiliVideo(raw);
  if (!url) return raw;
  url.pathname = url.pathname.replace(/\/?$/, "/");
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING.has(key.toLowerCase()) || /^utm_/i.test(key))
      url.searchParams.delete(key);
  }
  const parts = url.searchParams.getAll("p");
  if (
    parts.length === 1 &&
    /^[0-9]+$/.test(parts[0]) &&
    Number(parts[0]) >= 1 &&
    Number(parts[0]) <= 10000
  )
    url.searchParams.set("p", String(Number(parts[0])));
  // Keep p/cid, duplicate parameters, unknown options and fragments: they can
  // select a different part or change the actual document being researched.
  url.searchParams.sort();
  return url.href;
}

export function semanticPageTitle(raw, url) {
  if (!bilibiliVideo(url)) return raw || "";
  return (raw || "")
    .replace(/^\s*[（(\[]\d+\s*条消息[）)\]]\s*/, "")
    .replace(/[_|\-]\s*(?:哔哩哔哩_bilibili|哔哩哔哩|bilibili)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function pageIdentity(tab) {
  return JSON.stringify([
    tab.id ?? tab.tabId,
    semanticPageURL(tab.url),
    semanticPageTitle(tab.title, tab.url),
  ]);
}

export function samePageURL(left, right) {
  return semanticPageURL(left) === semanticPageURL(right);
}

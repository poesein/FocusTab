import { Readability } from '@mozilla/readability';

const compact = (value) => (value || '').replace(/\s+/g, ' ').trim();
function removePrivateUI(copy) {
  copy
    .querySelectorAll(
      'input, textarea, select, form, script, style, nav, aside, [contenteditable], [hidden], [aria-hidden="true"]'
    )
    .forEach((n) => n.remove());
  copy.querySelectorAll('[style]').forEach((n) => {
    if (/display\s*:\s*none\b|visibility\s*:\s*hidden\b/i.test(n.getAttribute('style'))) n.remove();
  });
}
const safeText = (node) => {
  if (!node) return '';
  const copy = node.cloneNode(true);
  removePrivateUI(copy);
  return compact(copy.textContent);
};
export function extractPage(doc, maxChars = 1800) {
  const limit = Number.isFinite(maxChars)
    ? Math.max(0, Math.min(4000, Math.floor(maxChars)))
    : 1800;
  const url = doc.location?.href || doc.URL;
  let title = compact(doc.title).slice(0, 300);
  const description = compact(
    doc.querySelector('meta[name="description"], meta[property="og:description"]')?.content
  );
  let excerpt = '',
    method = 'metadata';
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    /* non-web test documents use generic extraction */
  }
  const bilibiliVideo =
    /(^|\.)bilibili\.com$/.test(parsed?.hostname || '') && /^\/video\//.test(parsed.pathname);
  const youtubeVideo =
    /(^|\.)youtube\.com$/.test(parsed?.hostname || '') && parsed.pathname === '/watch';
  if (bilibiliVideo || youtubeVideo) {
    // Article extraction on watch pages can promote the long recommendation
    // rail into the "article". Only use the actual video's title/description.
    const heading = bilibiliVideo
      ? doc.querySelector('h1.video-title, h1[title], h1')
      : doc.querySelector('ytd-watch-metadata h1, h1.ytd-watch-metadata, h1');
    title = (compact(heading?.getAttribute('title')) || safeText(heading) || title).slice(0, 300);
    const details = bilibiliVideo
      ? doc.querySelector('#v_desc') ||
        doc.querySelector('.video-desc-container') ||
        doc.querySelector('.basic-desc-info')
      : doc.querySelector('ytd-watch-metadata #description') ||
        doc.querySelector('#description-inline-expander') ||
        doc.querySelector('#description');
    const tags = bilibiliVideo
      ? [
          ...doc.querySelectorAll(
            '.video-tag-container .tag-link, .video-tag-container .tag, .tag-panel .tag-link'
          ),
        ]
          .slice(0, 15)
          .map(safeText)
          .filter(Boolean)
          .join(' ')
      : '';
    excerpt = compact([safeText(details) || description, tags].filter(Boolean).join(' '));
    if (excerpt) method = 'video-description';
  }
  // Video players often have no article. Their description/headings are still
  // useful; no video/audio downloading, OCR, cookies or input values are read.
  if (!bilibiliVideo && !youtubeVideo && doc.getElementsByTagName('*').length <= 15000) {
    const copy = doc.cloneNode(true);
    removePrivateUI(copy);
    try {
      const article = new Readability(copy, { maxElemsToParse: 15000, charThreshold: 120 }).parse();
      excerpt = compact(article?.textContent);
      if (excerpt) method = 'readability';
    } catch {
      /* Dynamic/video pages may not be readable. Use metadata. */
    }
  }
  if (!excerpt) excerpt = description;
  // Basic redaction reduces accidental contact details, but is not a guarantee
  // of anonymization. Only user-selected public domains are eligible at all.
  excerpt = excerpt.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱已隐藏]');
  return { url, title, excerpt: excerpt.slice(0, limit), method };
}

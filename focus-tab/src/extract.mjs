import { Readability } from '@mozilla/readability';

const compact = (value) => (value || '').replace(/\s+/g, ' ').trim();
export function extractPage(doc, maxChars = 1800) {
  const limit = Number.isFinite(maxChars)
    ? Math.max(0, Math.min(4000, Math.floor(maxChars)))
    : 1800;
  const url = doc.location?.href || doc.URL;
  const title = compact(doc.title).slice(0, 300);
  const description = compact(
    doc.querySelector('meta[name="description"], meta[property="og:description"]')?.content
  );
  let excerpt = '',
    method = 'metadata';
  // Video players often have no article. Their description/headings are still
  // useful; no video/audio downloading, OCR, cookies or input values are read.
  if (doc.getElementsByTagName('*').length <= 15000) {
    const copy = doc.cloneNode(true);
    copy
      .querySelectorAll(
        'input, textarea, select, form, script, style, nav, aside, [contenteditable], [hidden], [aria-hidden="true"]'
      )
      .forEach((n) => n.remove());
    copy.querySelectorAll('[style]').forEach((n) => {
      if (/display\s*:\s*none\b|visibility\s*:\s*hidden\b/i.test(n.getAttribute('style')))
        n.remove();
    });
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

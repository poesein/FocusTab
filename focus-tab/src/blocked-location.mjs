export function blockedPayload(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  if (raw === 'ai') return { url: '', ai: true };
  // DNR cannot URI-encode regex substitutions. Its raw URL already contains
  // meaningful percent escapes, which must survive the redirect unchanged.
  if (raw.startsWith('raw=')) return { url: raw.slice(4), ai: false };
  const encoded = raw.startsWith('url=') ? raw.slice(4) : raw;
  try {
    return { url: decodeURIComponent(encoded), ai: false };
  } catch {
    return { url: '', ai: false };
  }
}

const PROVIDERS = [
  ['bilibili', ['bilibili', 'b站', '哔哩哔哩', 'bilibili.com'], 'bilibili.com'],
  ['zhihu', ['知乎', 'zhihu', 'zhihu.com'], 'zhihu.com'],
  ['youtube', ['youtube', 'yt', 'youtube.com'], 'youtube.com'],
  ['pubmed', ['pubmed'], 'pubmed.ncbi.nlm.nih.gov'],
  ['ablesci', ['科研通', 'ablesci', 'ablesci.com'], 'ablesci.com'],
  ['x', ['twitter', '推特', 'x.com'], 'x.com'],
  ['scholar', ['scholar', '谷歌学术'], null],
];
export function resolveSearch(raw) {
  if (typeof raw !== 'string' || raw.length > 1000) throw new Error('请输入 1–200 字检索词');
  let q = raw.trim().replace(/\s+/g, ' ');
  const match = q.match(/^([^\s:：]+)(?:\s+|[:：]\s*)(.*)$/);
  let token = (match?.[1] || q).toLowerCase();
  const direct = token.startsWith('!') || token.startsWith('！');
  if (direct) token = token.slice(1);
  const provider = PROVIDERS.find((p) => p[1].includes(token));
  if (provider) q = (match?.[2] || '').trim();
  if (!q || q.length > 200)
    throw new Error(provider ? '请在站点名称后填写 1–200 字检索词' : '请输入 1–200 字检索词');
  let base = 'https://www.google.com/search',
    params = { q };
  if (provider) {
    const [id, , domain] = provider;
    if (id === 'scholar') base = 'https://scholar.google.com/scholar';
    else if (!direct || id === 'ablesci') params = { q: `site:${domain} ${q}` };
    else
      [base, params] = {
        bilibili: ['https://search.bilibili.com/all', { keyword: q }],
        zhihu: ['https://www.zhihu.com/search', { type: 'content', q }],
        youtube: ['https://www.youtube.com/results', { search_query: q }],
        pubmed: ['https://pubmed.ncbi.nlm.nih.gov/', { term: q }],
        x: ['https://x.com/search', { q }],
      }[id];
  }
  return { url: base + '?' + new URLSearchParams(params), goal: q };
}

export const DEFAULTS = {
  title: '这次，想弄明白什么？',
  placeholder: '搜索问题，开始有目的的浏览',
  brand: '专注',
  tabTitle: '专注 · 新标签页',
  hint: '',
  theme: 'system',
  showClock: false,
  showLinks: true,
  showTimer: true,
  newTaskPerSearch: true,
  sessionMinutes: 25,
  extendMinutes: 10,
  allowMinutes: 10,
  temporaryPassEnabled: true,
  passDailyMinutes: 20,
  passCooldownMinutes: 10,
  aiEnabled: true,
  autoClassify: true,
  aiHost: typeof FOCUSTAB_AI_HOST === 'string' ? FOCUSTAB_AI_HOST : 'http://127.0.0.1:11434',
  aiModel: 'qwen3:14b',
  contentMode: 'summary',
  aiAction: 'block',
  threshold: 0.9,
  dwellSeconds: 20,
  intervalSeconds: 90,
  requestsPerHour: 12,
  cacheMinutes: 30,
  excerptChars: 1800,
  keepAlive: '2m',
  idleSeconds: 300,
  retentionDays: 90,
  blockFeeds: true,
  disabledRules: [],
  analysisHosts: [
    'bilibili.com',
    'b23.tv',
    'zhihu.com',
    'youtube.com',
    'youtu.be',
    'x.com',
    'twitter.com',
  ],
  customRules: [],
  shortcuts: [
    { id: 'scholar', name: '谷歌学术', url: 'https://scholar.google.com/', icon: '学' },
    { id: 'pubmed', name: 'PubMed', url: 'https://pubmed.ncbi.nlm.nih.gov/', icon: 'P' },
    { id: 'ablesci', name: '科研通', url: 'https://www.ablesci.com/', icon: '研' },
    { id: 'github', name: 'GitHub', url: 'https://github.com/', icon: 'G' },
  ],
};

const RANGES = {
  sessionMinutes: [5, 120],
  extendMinutes: [5, 60],
  allowMinutes: [1, 30],
  passDailyMinutes: [0, 180],
  passCooldownMinutes: [0, 120],
  dwellSeconds: [10, 180],
  intervalSeconds: [30, 900],
  requestsPerHour: [1, 60],
  cacheMinutes: [1, 120],
  excerptChars: [300, 4000],
  idleSeconds: [60, 3600],
  retentionDays: [1, 365],
};
const ENUMS = {
  theme: ['light', 'dark', 'system'],
  aiModel: ['qwen3:8b', 'qwen3:14b'],
  contentMode: ['metadata', 'summary'],
  aiAction: ['remind', 'block'],
  keepAlive: ['30s', '1m', '2m', '5m'],
};

export function validHost(raw) {
  if (typeof raw !== 'string' || raw.length > 253 || raw !== raw.toLowerCase()) return false;
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(raw)) return false;
  return !raw.endsWith('.local') && !raw.endsWith('.localhost');
}

export function validateEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('请填写完整的局域网 Ollama 地址');
  }
  const h = url.hostname;
  const ip = h.split('.').map(Number);
  const privateIP =
    ip.length === 4 &&
    ip.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
    (ip[0] === 10 ||
      ip[0] === 127 ||
      (ip[0] === 192 && ip[1] === 168) ||
      (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31));
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    !(privateIP || h === 'localhost')
  ) {
    throw new Error('AI 地址仅支持本机或局域网 IPv4，不能带账户、路径或参数');
  }
  return url.origin;
}

export function validatePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('设置格式无效');
  const out = structuredClone(patch);
  for (const [key, value] of Object.entries(out)) {
    if (!Object.hasOwn(DEFAULTS, key)) throw new Error(`不支持的设置：${key}`);
    if (RANGES[key]) {
      const [lo, hi] = RANGES[key];
      if (!Number.isInteger(value) || value < lo || value > hi)
        throw new Error(`${key} 应为 ${lo}–${hi} 的整数`);
    } else if (ENUMS[key]) {
      if (!ENUMS[key].includes(value)) throw new Error(`不支持的选项：${key}`);
    } else if (key === 'threshold') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.5 || value > 0.99)
        throw new Error('阈值应为 0.50–0.99');
    } else if (key === 'aiHost') {
      out[key] = validateEndpoint(value);
    } else if (key === 'disabledRules') {
      const ids = [
        'ablesci',
        'tophub',
        'bilibili',
        'bilibili-mobile',
        'zhihu',
        'youtube',
        'youtube-mobile',
        'x',
        'twitter',
      ];
      if (
        !Array.isArray(value) ||
        value.length > ids.length ||
        value.some((id) => !ids.includes(id))
      )
        throw new Error('内置规则选项无效');
      out[key] = [...new Set(value)];
    } else if (key === 'analysisHosts') {
      if (!Array.isArray(value) || value.length > 50 || value.some((h) => !validHost(h)))
        throw new Error('检测网站应为每行一个域名，最多 50 个');
      out[key] = [...new Set(value)];
    } else if (key === 'customRules') {
      if (!Array.isArray(value) || value.length > 50) throw new Error('自定义规则最多 50 条');
      const ids = new Set();
      for (const r of value) {
        if (
          !r ||
          !validHost(r.host) ||
          typeof r.id !== 'string' ||
          !/^[a-zA-Z0-9_-]{1,80}$/.test(r.id) ||
          ids.has(r.id) ||
          typeof r.path !== 'string' ||
          r.path.length > 200 ||
          !r.path.startsWith('/') ||
          /[?#\\\s]/.test(r.path) ||
          typeof r.allPaths !== 'boolean'
        )
          throw new Error('网址规则无效：请填写域名和以 / 开始的路径');
        ids.add(r.id);
      }
    } else if (key === 'shortcuts') {
      if (!Array.isArray(value) || value.length > 20) throw new Error('快捷入口最多 20 个');
      const ids = new Set();
      for (const item of value) {
        let url;
        try {
          url = new URL(item.url);
        } catch {
          throw new Error('快捷入口网址无效');
        }
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          item.url.length > 2000 ||
          typeof item.id !== 'string' ||
          !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id) ||
          ids.has(item.id) ||
          typeof item.name !== 'string' ||
          !item.name.trim() ||
          item.name.length > 30 ||
          typeof item.icon !== 'string' ||
          item.icon.length > 8
        )
          throw new Error('快捷入口的名称、图标或网址无效');
        ids.add(item.id);
      }
    } else if (typeof DEFAULTS[key] === 'boolean') {
      if (typeof value !== 'boolean') throw new Error(`${key} 应为开关`);
    } else if (typeof value !== 'string' || value.length > 200) {
      throw new Error(`${key} 应为不超过 200 字的文字`);
    }
  }
  return out;
}

export function loadConfig(saved) {
  const cfg = structuredClone(DEFAULTS);
  for (const [key, value] of Object.entries(saved || {})) {
    try {
      Object.assign(cfg, validatePatch({ [key]: value }));
    } catch {
      /* tolerate stale stored options */
    }
  }
  return cfg;
}

export const PRESETS = {
  conserve: {
    aiModel: 'qwen3:8b',
    intervalSeconds: 180,
    dwellSeconds: 30,
    requestsPerHour: 8,
    keepAlive: '1m',
  },
  balanced: {
    aiModel: 'qwen3:8b',
    intervalSeconds: 90,
    dwellSeconds: 20,
    requestsPerHour: 12,
    keepAlive: '2m',
  },
  careful: {
    aiModel: 'qwen3:14b',
    intervalSeconds: 90,
    dwellSeconds: 25,
    requestsPerHour: 12,
    keepAlive: '2m',
  },
};

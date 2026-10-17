import { loadConfig, validatePatch } from './config.mjs';
import { resolveSearch } from './search.mjs';
export const isExtension = !!globalThis.chrome?.runtime?.id;

let popupInactive = false;
let popupWindow;

function isRealPopup() {
  return (
    isExtension &&
    globalThis.top === globalThis &&
    location.href === chrome.runtime.getURL('popup.html')
  );
}

async function popupFocusProof() {
  if (
    !isRealPopup() ||
    typeof document.hasFocus !== 'function' ||
    typeof chrome.windows?.getCurrent !== 'function'
  )
    return null;
  try {
    // A toolbar popup belongs to one normal browser window for its lifetime.
    // Cache only its identity, never the focus state. Read focus after the
    // asynchronous lookup so a preceding blur cannot renew a stale proof.
    popupWindow ||= Promise.resolve(chrome.windows.getCurrent());
    const owner = await popupWindow;
    if (
      !owner ||
      owner.type !== 'normal' ||
      owner.incognito === true ||
      !Number.isInteger(owner.id) ||
      owner.id < 0
    )
      return null;
    const visible = document.visibilityState === 'visible';
    return {
      windowId: owner.id,
      visible,
      focused: !popupInactive && visible && document.hasFocus(),
    };
  } catch {
    popupWindow = null;
    return null;
  }
}

export async function reportPopupFocus(focused) {
  if (!isRealPopup()) return null;
  // The latch also invalidates other requests already waiting for getCurrent.
  // A focus event permits a fresh proof but never substitutes for hasFocus().
  popupInactive = focused !== true;
  return request('ui-state');
}

function readPreviewValue(key, fallback = null) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback;
  } catch {
    // Stale or damaged preview storage must not prevent opening the UI.
    return fallback;
  }
}

function previewSession(value) {
  return value &&
    typeof value === 'object' &&
    typeof value.id === 'string' &&
    typeof value.goal === 'string' &&
    value.goal.length <= 200 &&
    Number.isFinite(value.started) &&
    Number.isFinite(value.ends)
    ? value
    : null;
}

export function openSettingsPage(section = 'appearance') {
  const supported = ['appearance', 'links', 'task', 'ai', 'blocking', 'privacy'];
  const hash =
    supported.includes(section) && section !== 'appearance' ? `#settings/${section}` : '#settings';
  const target = 'index.html' + hash;
  if (isExtension) return chrome.tabs.create({ url: chrome.runtime.getURL(target) });
  return globalThis.open(new URL(target, location.href).href, '_blank', 'noopener');
}

export async function request(type, payload = {}) {
  if (isExtension) {
    const message = { type: 'focus:' + type, payload };
    const uiFocus = await popupFocusProof();
    if (uiFocus) message.uiFocus = uiFocus;
    const reply = await chrome.runtime.sendMessage(message);
    if (!reply?.ok) throw new Error(reply?.error || '扩展后台未响应，请在扩展管理页重新加载');
    return reply.data;
  }
  // Explicit UI-only preview, never pretends to inspect or block other tabs.
  const state = {
    config: loadConfig(readPreviewValue('focus-preview-config')),
    session: previewSession(readPreviewValue('focus-preview-session')),
    current: null,
    judgment: null,
    error: '',
    notice: '',
    calls: 0,
    feedback: [],
    checking: false,
    status: '这是界面预览；安装扩展后，在普通网页中查看实际检测状态。',
  };
  if (type === 'config') {
    state.config = { ...state.config, ...validatePatch(payload) };
    localStorage.setItem('focus-preview-config', JSON.stringify(state.config));
  } else if (type === 'start' || type === 'search') {
    const search = type === 'search' ? resolveSearch(payload.query || '') : null;
    const rawGoal = search?.goal ?? payload.goal;
    if (typeof rawGoal !== 'string') throw new Error('请填写 1–200 字研究目标');
    const goal = rawGoal.trim();
    if (!goal || goal.length > 200) throw new Error('请填写 1–200 字研究目标');
    const minutes = payload.minutes ?? state.config.sessionMinutes;
    validatePatch({ sessionMinutes: minutes });
    if (
      type === 'start' ||
      state.config.newTaskPerSearch ||
      !state.session ||
      state.session.ends <= Date.now()
    ) {
      state.session = {
        id: crypto.randomUUID(),
        goal,
        started: Date.now(),
        ends: Date.now() + minutes * 6e4,
      };
      localStorage.setItem('focus-preview-session', JSON.stringify(state.session));
    }
    if (search) return { url: search.url };
  } else if (type === 'extend') {
    if (!state.session) throw new Error('请先开始一次研究');
    state.session.ends =
      Math.max(Date.now(), state.session.ends) + state.config.extendMinutes * 6e4;
    localStorage.setItem('focus-preview-session', JSON.stringify(state.session));
  } else if (type === 'end') {
    state.session = null;
    localStorage.removeItem('focus-preview-session');
  } else if (!['state', 'config', 'start', 'end', 'extend'].includes(type)) {
    throw new Error('这是界面预览；请加载扩展后使用内容判断、反馈和拦截');
  }
  return state;
}

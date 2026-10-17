import { FocusEngine } from './engine.mjs';
let queue = Promise.resolve();
function enqueue(work) {
  const task = queue.then(work);
  queue = task.catch((error) => console.error('[FocusTab]', error.message));
  return task;
}
const engine = new FocusEngine(chrome, enqueue);
let initialized = false;
async function ensureInitialized() {
  if (!initialized) {
    await engine.init();
    initialized = true;
  }
}
// A transient startup/API error must not permanently poison every later event.
enqueue(ensureInitialized).catch(() => {});
function reconcile() {
  return enqueue(async () => {
    await ensureInitialized();
    await engine.reconcile();
  }).catch(() => {});
}
chrome.tabs.onActivated.addListener(reconcile);
chrome.tabs.onUpdated.addListener((_id, change) => {
  if (change.url || change.title || change.status === 'complete') reconcile();
});
chrome.tabs.onRemoved.addListener((tabId) => {
  enqueue(async () => {
    await ensureInitialized();
    await engine.tabRemoved(tabId);
  }).catch(() => {});
});
chrome.windows.onFocusChanged.addListener(reconcile);
chrome.idle.onStateChanged.addListener(reconcile);
chrome.webNavigation.onHistoryStateUpdated.addListener((info) => {
  if (info.frameId === 0) reconcile();
});
chrome.webNavigation.onReferenceFragmentUpdated.addListener((info) => {
  if (info.frameId === 0) reconcile();
});
chrome.alarms.onAlarm.addListener((info) => {
  if (['focus-check', 'focus-expiry', 'focus-ai-deadline'].includes(info.name)) reconcile();
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (
    typeof message?.type !== 'string' ||
    !message.type.startsWith('focus:') ||
    sender.id !== chrome.runtime.id ||
    !sender.url?.startsWith(chrome.runtime.getURL(''))
  )
    return false;
  enqueue(async () => {
    await ensureInitialized();
    return engine.dispatch(message, sender);
  }).then(
    (data) => reply({ ok: true, data }),
    (error) => reply({ ok: false, error: error.message })
  );
  return true;
});

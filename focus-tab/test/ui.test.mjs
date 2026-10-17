import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { DEFAULTS } from '../src/config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = (
  await build({
    absWorkingDir: root,
    stdin: {
      contents:
        "import './src/app.jsx'; import { render } from 'preact'; import { request, reportPopupFocus } from './src/bridge.mjs'; globalThis.testRequest = request; globalThis.testReportPopupFocus = reportPopupFocus; globalThis.disposeUI = () => render(null, document.getElementById('app'));",
      resolveDir: root,
      loader: 'js',
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    define: { 'process.env.NODE_ENV': '"test"' },
  })
).outputFiles[0].text;

async function until(predicate, description = 'UI update') {
  for (let i = 0; i < 80; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

async function mount({ page = 'home', hash = '', url, setup = () => {} } = {}) {
  const dom = new JSDOM(`<body data-page="${page}"><div id="app"></div></body>`, {
    url: url || `https://focus.test/${page === 'home' ? 'index' : page}.html${hash}`,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.structuredClone = structuredClone;
  window.crypto.randomUUID = randomUUID;
  window.confirm = () => false;
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  setup(window);
  window.eval(bundle);
  await until(
    () => window.document.querySelector('.home-shell, .popup, .blocked-page'),
    'loaded page'
  );
  return dom;
}

const field = (document, label) =>
  [...document.querySelectorAll('label.field')]
    .find((el) => el.querySelector('.field-title')?.textContent === label)
    ?.querySelector('input, select, textarea');
const button = (document, text) =>
  [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === text);
const input = (window, node, value) => {
  node.value = value;
  node.dispatchEvent(new window.Event('input', { bubbles: true }));
};
async function settings(window, section) {
  window.document.querySelector('.settings-button').click();
  await until(() => window.document.querySelector('dialog')?.open, 'open settings');
  if (section) {
    [...window.document.querySelectorAll('.settings-sidebar nav button')]
      .find((el) => el.textContent.endsWith(section))
      .click();
    await until(() => window.document.querySelector('#settings-title')?.textContent === section);
  }
}
function extensionMock(window, state, calls) {
  window.testStorageListeners = [];
  window.chrome = {
    runtime: {
      id: 'focus-ui-test',
      getURL: (path) => `chrome-extension://focus-ui-test/${path}`,
      async sendMessage(message) {
        calls.push(JSON.parse(JSON.stringify(message)));
        const passBudget = state.passBudget || {
          enabled: state.config.temporaryPassEnabled !== false,
          dailyLimitMinutes: 20,
          usedMinutes: 0,
          remainingMinutes: 20,
          cooldownMinutes: 10,
          cooldownUntil: 0,
          waitSeconds: 0,
          nextAvailableAt: null,
          canGrant: state.config.temporaryPassEnabled !== false,
          grantMinutes: 10,
          reason: '',
        };
        return {
          ok: true,
          data:
            message.type === 'focus:blocked'
              ? structuredClone(
                  state.blockedResponse || {
                    url: 'https://www.bilibili.com/video/BVresearch',
                    reason: '待纠正的 AI 判断',
                    ai: true,
                    passBudget,
                    canPass: passBudget.canGrant,
                    minutes: passBudget.grantMinutes,
                  }
                )
              : structuredClone(state),
        };
      },
    },
    storage: {
      onChanged: {
        addListener(listener) {
          window.testStorageListeners.push(listener);
        },
        removeListener(listener) {
          window.testStorageListeners = window.testStorageListeners.filter((fn) => fn !== listener);
        },
      },
    },
    tabs: {
      async create(payload) {
        calls.push({ type: 'tabs:create', payload });
      },
    },
  };
}

test('damaged preview JSON and malformed sessions do not strand the loading screen', async () => {
  const dom = await mount({
    setup(window) {
      window.localStorage.setItem('focus-preview-config', '{broken');
      window.localStorage.setItem(
        'focus-preview-session',
        JSON.stringify({ goal: 'bad', ends: 'yesterday' })
      );
    },
  });
  try {
    assert.equal(dom.window.document.querySelector('h1').textContent, DEFAULTS.title);
    const state = await dom.window.testRequest('state');
    assert.equal(state.session, null);
    assert.equal(state.config.aiModel, DEFAULTS.aiModel);
  } finally {
    dom.window.disposeUI();
    dom.window.close();
  }
});

test('Escape asks once using the latest unsaved draft and leaves the dialog open when declined', async () => {
  const dom = await mount();
  try {
    const { window } = dom;
    await settings(window);
    input(window, field(window.document, '首页标题'), '未保存的研究首页');
    await until(
      () => button(window.document, '保存设置') && !button(window.document, '保存设置').disabled,
      'dirty draft'
    );
    let confirmations = 0;
    window.confirm = () => {
      confirmations++;
      return false;
    };
    const dialog = window.document.querySelector('dialog');
    dialog.dispatchEvent(new window.Event('cancel', { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(confirmations, 1);
    assert.equal(dialog.open, true);
    window.confirm = () => {
      confirmations++;
      return true;
    };
    dialog.dispatchEvent(new window.Event('cancel', { cancelable: true }));
    await until(() => !window.document.querySelector('dialog'), 'closed settings');
    assert.equal(confirmations, 2);
  } finally {
    dom.window.disposeUI();
    dom.window.close();
  }
});

test('fractional AI thresholds submit and server-normalized settings become clean', async () => {
  const dom = await mount();
  try {
    const { window } = dom;
    await settings(window, '内容判断');
    const threshold = field(window.document, '提醒 / 拦截阈值');
    assert.equal(threshold.step, '0.01');
    assert.equal(threshold.validity.stepMismatch, false);
    input(window, threshold, '0.91');
    input(window, field(window.document, 'NAS / Ollama 地址'), 'http://127.0.0.1:11434/');
    await until(() => !!button(window.document, '保存设置'));
    assert.equal(window.document.querySelector('.settings-form').checkValidity(), true);
    button(window.document, '保存设置').click();
    await until(() => button(window.document, '已保存')?.disabled, 'clean saved settings');
    const saved = JSON.parse(window.localStorage.getItem('focus-preview-config'));
    assert.equal(saved.threshold, 0.91);
    assert.equal(saved.aiHost, 'http://127.0.0.1:11434');
    assert.equal(field(window.document, 'NAS / Ollama 地址').value, saved.aiHost);
  } finally {
    dom.window.disposeUI();
    dom.window.close();
  }
});

test('a real storage failure is visible inside the settings modal and the draft stays dirty', async () => {
  const dom = await mount();
  try {
    const { window } = dom;
    await settings(window);
    input(window, field(window.document, '首页标题'), '保存会失败');
    await until(() => !!button(window.document, '保存设置'));
    window.Storage.prototype.setItem = () => {
      throw new window.DOMException('保存空间不足，请清理浏览器存储', 'QuotaExceededError');
    };
    button(window.document, '保存设置').click();
    await until(
      () =>
        window.document
          .querySelector('dialog [role="alert"]')
          ?.textContent.includes('保存空间不足'),
      'specific modal error'
    );
    assert.equal(button(window.document, '保存设置').disabled, false);
    assert.equal(window.document.querySelector('dialog').open, true);
    assert.equal(field(window.document, '首页标题').value, '保存会失败');
  } finally {
    dom.window.disposeUI();
    dom.window.close();
  }
});

test('popup preview settings has a web fallback and page-controlled strings remain text', async () => {
  let opened;
  const dom = await mount({
    page: 'popup',
    setup(window) {
      window.open = (...args) => {
        opened = args;
      };
    },
  });
  try {
    dom.window.document.querySelector('[aria-label="打开设置"]').click();
    assert.deepEqual(opened, ['https://focus.test/index.html#settings', '_blank', 'noopener']);
  } finally {
    dom.window.disposeUI();
    dom.window.close();
  }

  const calls = [],
    unsafe = '<img src=x onerror="window.pageInjected=true">';
  const state = {
    config: structuredClone(DEFAULTS),
    session: null,
    judgment: { label: 'uncertain', reason: unsafe, confidence: 0.8 },
    current: { title: unsafe, url: 'https://example.org/' },
    checking: false,
    feedback: [],
  };
  const extension = await mount({
    page: 'popup',
    setup(window) {
      extensionMock(window, state, calls);
    },
  });
  try {
    assert.equal(extension.window.document.querySelector('h2').textContent, unsafe);
    assert.equal(extension.window.document.querySelector('img'), null);
    assert.equal(extension.window.pageInjected, undefined);
  } finally {
    extension.window.disposeUI();
    extension.window.close();
  }
});

test('AI blocked-page correction submits feedback without silently granting a pass', async () => {
  const calls = [],
    state = {
      config: structuredClone(DEFAULTS),
      session: {
        id: 'research',
        goal: '研究单粒子追踪',
        started: Date.now(),
        ends: Date.now() + 600000,
      },
      current: null,
      judgment: null,
      checking: false,
      feedback: [],
    };
  const dom = await mount({
    page: 'blocked',
    hash: '#ai',
    setup(window) {
      extensionMock(window, state, calls);
    },
  });
  try {
    const { document } = dom.window;
    await until(() => !button(document, '这页与研究相关，纠正判断')?.disabled, 'loaded AI block');
    button(document, '这页与研究相关，纠正判断').click();
    await until(() => document.querySelector('.toast')?.textContent.includes('已纠正'));
    assert.deepEqual(calls.find((call) => call.type === 'focus:feedback')?.payload, {
      label: 'related',
      remember: false,
      ai: true,
    });
    assert.equal(
      calls.some((call) => call.type === 'focus:pass'),
      false
    );
    button(document, '仅此页放行 10 分钟').click();
    await until(() => calls.some((call) => call.type === 'focus:pass'));
    assert.equal(calls.filter((call) => call.type === 'focus:pass').length, 1);
  } finally {
    dom.window.disposeUI();
    dom.window.close();
  }
});

test('preview searches honor the saved task reuse setting and reject invalid timing', async () => {
  const dom = await mount();
  try {
    const request = dom.window.testRequest;
    await request('config', { newTaskPerSearch: false });
    const first = await request('start', { goal: 'TrackMate 轨迹导出', minutes: 5 });
    const search = await request('search', { query: 'B站 TrackMate 安装' });
    assert.ok(search.url.startsWith('https://www.google.com/search?'));
    const after = await request('state');
    assert.equal(after.session.id, first.session.id);
    assert.equal(after.session.goal, 'TrackMate 轨迹导出');
    await assert.rejects(request('start', { goal: '测试', minutes: 0 }), /sessionMinutes/);
    await request('end');
    await assert.rejects(request('extend'), /请先开始一次研究/);
  } finally {
    dom.window.disposeUI();
    dom.window.close();
  }
});

test('automatic popup allows checking and correcting without a research task and exposes AI errors', async () => {
  const calls = [],
    state = {
      config: { ...structuredClone(DEFAULTS), autoClassify: true },
      session: null,
      current: { title: '单粒子追踪教程', url: 'https://www.bilibili.com/video/BVresearch' },
      judgment: null,
      checking: false,
      feedback: [],
      error: 'AI 暂不可用：403 Forbidden',
      status: { mode: 'auto', code: 'error', message: '上次请求失败，请检查连接设置' },
    };
  const dom = await mount({
    page: 'popup',
    setup(window) {
      extensionMock(window, state, calls);
    },
  });
  try {
    const { document } = dom.window;
    assert.match(document.querySelector('.task-card').textContent, /研究目标可选填/);
    assert.match(document.querySelector('.judgment').textContent, /AI 请求失败/);
    assert.equal(button(document, '检查当前页面').disabled, false);
    assert.equal(button(document, '工作或学习').disabled, false);
    assert.equal(button(document, '娱乐消遣').disabled, false);
    assert.match(document.querySelector('.ai-error[role="alert"]').textContent, /403 Forbidden/);
    assert.match(document.querySelector('.detection-status').textContent, /上次请求失败/);
    button(document, '检查当前页面').click();
    await until(() => calls.some((call) => call.type === 'focus:check'));
    await until(() => !button(document, '工作或学习').disabled);
    button(document, '工作或学习').click();
    await until(() => calls.some((call) => call.type === 'focus:feedback'));
    assert.deepEqual(calls.find((call) => call.type === 'focus:feedback').payload, {
      label: 'related',
      remember: false,
    });
    button(document, '打开 AI 连接设置').click();
    assert.equal(
      calls.find((call) => call.type === 'tabs:create').payload.url,
      'chrome-extension://focus-ui-test/index.html#settings/ai'
    );
  } finally {
    dom.window.disposeUI();
    dom.window.close();
  }
});

test('task-only mode requires a live task and excluded pages disable checking and feedback', async () => {
  for (const item of [
    { autoClassify: false, session: null, code: 'waiting-task', enabled: false },
    {
      autoClassify: false,
      session: { id: 'expired', goal: '研究', started: Date.now() - 600000, ends: Date.now() - 1 },
      code: 'waiting-task',
      enabled: false,
    },
    {
      autoClassify: false,
      session: { id: 'active', goal: '研究', started: Date.now(), ends: Date.now() + 600000 },
      code: 'ready',
      enabled: true,
    },
    { autoClassify: true, session: null, code: 'excluded', enabled: false },
  ]) {
    const state = {
      config: { ...structuredClone(DEFAULTS), autoClassify: item.autoClassify },
      session: item.session,
      current: { title: '网页', url: 'https://www.bilibili.com/video/BVresearch' },
      checking: false,
      feedback: [],
      judgment: null,
      status: {
        code: item.code,
        mode: item.autoClassify ? 'auto' : 'task',
        message: item.code === 'excluded' ? 'Google 搜索结果不分析，请打开最终网页' : '',
      },
    };
    const dom = await mount({
      page: 'popup',
      setup(window) {
        extensionMock(window, state, []);
      },
    });
    try {
      const { document } = dom.window;
      assert.equal(button(document, '检查当前页面').disabled, !item.enabled, JSON.stringify(item));
      assert.equal(
        document.querySelector('.feedback-buttons button').disabled,
        !item.enabled,
        JSON.stringify(item)
      );
      if (item.code === 'excluded')
        assert.match(document.querySelector('.detection-status').textContent, /最终网页/);
    } finally {
      dom.window.disposeUI();
      dom.window.close();
    }
  }
});

test('automatic mode setting persists without replacing a saved reminder preference', async () => {
  const dom = await mount({
    hash: '#settings/ai',
    setup(window) {
      window.localStorage.setItem('focus-preview-config', JSON.stringify({ aiAction: 'remind' }));
    },
  });
  try {
    const { window } = dom;
    await until(() => window.document.querySelector('dialog')?.open);
    assert.equal(window.document.querySelector('#settings-title').textContent, '内容判断');
    const toggle = [...window.document.querySelectorAll('.toggle-field')].find(
      (el) =>
        el.querySelector('.field-title')?.textContent === '没有研究任务时，自动判断工作/学习与娱乐'
    );
    assert.ok(toggle);
    assert.match(toggle.textContent, /Google 搜索结果不分析/);
    const checkbox = toggle.querySelector('input');
    assert.equal(checkbox.checked, true);
    checkbox.checked = false;
    checkbox.dispatchEvent(new window.Event('change', { bubbles: true }));
    await until(() => !!button(window.document, '保存设置'));
    button(window.document, '保存设置').click();
    await until(() => button(window.document, '已保存')?.disabled);
    const saved = JSON.parse(window.localStorage.getItem('focus-preview-config'));
    assert.equal(saved.autoClassify, false);
    assert.equal(saved.aiAction, 'remind');
  } finally {
    dom.window.disposeUI();
    dom.window.close();
  }
});

test('popup explains missing pages and exposes the installed version and actual action', async () => {
  const calls = [],
    state = {
      config: { ...structuredClone(DEFAULTS), aiAction: 'remind' },
      version: '0.1.2',
      session: null,
      current: null,
      judgment: null,
      checking: false,
      feedback: [],
      calls: 3,
      status: { mode: 'auto', code: 'no-page', message: '等待普通网页' },
      diagnostics: {
        code: 'window-unfocused',
        message: '浏览器窗口未在前台，请返回网页后重新识别。',
        checkedAt: Date.now(),
      },
    };
  const dom = await mount({
    page: 'popup',
    setup(window) {
      extensionMock(window, state, calls);
    },
  });
  try {
    const { document } = dom.window;
    assert.equal(document.querySelector('.popup-version').textContent, 'v0.1.2');
    assert.match(document.querySelector('.page-diagnostic').textContent, /窗口未在前台/);
    assert.match(document.querySelector('.judgment').textContent, /等待识别普通网页/);
    assert.match(document.querySelector('.runtime-details').textContent, /仅提醒/);
    assert.match(document.querySelector('.runtime-details').textContent, /3 \/ 12/);
    assert.equal(button(document, '检查当前页面').disabled, true);
    const count = calls.length;
    button(document, '重新识别页面（不请求 AI）').click();
    await until(() => calls.length > count);
    assert.equal(calls.at(-1).type, 'focus:state');
    assert.equal(
      calls.some((row) => row.type === 'focus:check'),
      false
    );
  } finally {
    dom.window.disposeUI();
    dom.window.close();
  }
});

test('automatic AI blocks can be corrected without a task and do not silently pass the page', async () => {
  const calls = [],
    state = {
      config: { ...structuredClone(DEFAULTS), autoClassify: true },
      session: null,
      current: null,
      judgment: null,
      checking: false,
      feedback: [],
      status: { mode: 'auto', code: 'no-page', message: '' },
    };
  const dom = await mount({
    page: 'blocked',
    hash: '#ai',
    setup(window) {
      extensionMock(window, state, calls);
    },
  });
  try {
    const { document } = dom.window;
    await until(
      () =>
        button(document, '这页属于工作或学习，纠正判断') &&
        !button(document, '这页属于工作或学习，纠正判断').disabled
    );
    button(document, '这页属于工作或学习，纠正判断').click();
    await until(() => calls.some((call) => call.type === 'focus:feedback'));
    assert.deepEqual(calls.find((call) => call.type === 'focus:feedback').payload, {
      label: 'related',
      remember: false,
      ai: true,
    });
    assert.equal(
      calls.some((call) => call.type === 'focus:pass'),
      false
    );
  } finally {
    dom.window.disposeUI();
    dom.window.close();
  }
});

test('background automatic-status refresh does not replace an unsaved settings draft', async () => {
  const calls = [],
    state = {
      config: structuredClone(DEFAULTS),
      session: null,
      current: null,
      judgment: null,
      checking: false,
      feedback: [],
      status: { mode: 'auto', code: 'no-page', message: '等待网页' },
    };
  const dom = await mount({
    setup(window) {
      extensionMock(window, state, calls);
    },
  });
  try {
    const { window } = dom;
    await settings(window);
    input(window, field(window.document, '首页标题'), '我的未保存标题');
    await until(() => !!button(window.document, '保存设置'));
    state.config.title = '后台更新的标题';
    state.status = { mode: 'auto', code: 'checking', message: '正在检测' };
    const before = calls.length;
    for (const listener of window.testStorageListeners) listener({ focusRuntime: {} });
    await until(() => calls.length > before);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(field(window.document, '首页标题').value, '我的未保存标题');
    assert.equal(button(window.document, '保存设置').disabled, false);
  } finally {
    dom.window.disposeUI();
    dom.window.close();
  }
});

test('only a genuinely focused toolbar popup supplies owner-window proof, with blur and hidden revocation', async () => {
  const calls = [],
    state = {
      config: structuredClone(DEFAULTS),
      session: null,
      current: null,
      judgment: null,
      checking: false,
      feedback: [],
    };
  let focused = true,
    visibility = 'visible',
    ownerLookups = 0;
  const dom = await mount({
    page: 'popup',
    url: 'chrome-extension://focus-ui-test/popup.html',
    setup(window) {
      extensionMock(window, state, calls);
      window.document.hasFocus = () => focused;
      Object.defineProperty(window.document, 'visibilityState', {
        configurable: true,
        get: () => visibility,
      });
      window.chrome.windows = {
        async getCurrent() {
          ownerLookups++;
          return { id: 88, type: 'normal', incognito: false, focused: false };
        },
      };
    },
  });
  try {
    const { window } = dom;
    const initial = calls.find((call) => call.type === 'focus:state');
    assert.deepEqual(initial.uiFocus, { windowId: 88, visible: true, focused: true });
    assert.deepEqual(initial.payload, {});
    await window.testRequest('config', { title: '配置内容不含证明' });
    const config = calls.find((call) => call.type === 'focus:config');
    assert.deepEqual(config.payload, { title: '配置内容不含证明' });
    assert.deepEqual(config.uiFocus, { windowId: 88, visible: true, focused: true });

    window.dispatchEvent(new window.Event('blur'));
    await until(() =>
      calls.some((call) => call.type === 'focus:ui-state' && call.uiFocus?.focused === false)
    );
    await window.testRequest('state');
    assert.equal(
      calls.at(-1).uiFocus.focused,
      false,
      'blur revokes even before hasFocus catches up'
    );
    focused = false;
    window.dispatchEvent(new window.Event('focus'));
    await window.testReportPopupFocus(true);
    assert.equal(
      calls.at(-1).uiFocus.focused,
      false,
      'a focus event cannot substitute for document.hasFocus'
    );
    focused = true;
    await window.testReportPopupFocus(true);
    assert.equal(calls.at(-1).uiFocus.focused, true);

    visibility = 'hidden';
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    await until(() => calls.at(-1)?.uiFocus?.visible === false);
    assert.equal(calls.at(-1).uiFocus.focused, false);
    visibility = 'visible';
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    await until(() => calls.at(-1)?.uiFocus?.focused === true);
    const before = calls.length;
    window.disposeUI();
    await until(() => calls.length > before);
    assert.equal(calls.at(-1).type, 'focus:ui-state');
    assert.equal(calls.at(-1).uiFocus.focused, false, 'closing the popup revokes its proof');
    assert.equal(ownerLookups, 1, 'only identity is cached, not focus');
  } finally {
    dom.window.disposeUI();
    dom.window.close();
  }
});

test('new tabs, settings and web previews never report popup focus metadata', async () => {
  for (const url of [
    'chrome-extension://focus-ui-test/index.html',
    'chrome-extension://focus-ui-test/index.html#settings',
    'https://focus.test/popup.html',
  ]) {
    const calls = [],
      state = {
        config: structuredClone(DEFAULTS),
        session: null,
        current: null,
        judgment: null,
        checking: false,
        feedback: [],
      };
    let ownerLookups = 0;
    const dom = await mount({
      page: url.includes('popup.html') ? 'popup' : 'home',
      url,
      setup(window) {
        extensionMock(window, state, calls);
        window.document.hasFocus = () => true;
        window.chrome.windows = {
          async getCurrent() {
            ownerLookups++;
            return { id: 88, type: 'normal' };
          },
        };
      },
    });
    try {
      await dom.window.testReportPopupFocus(true);
      await dom.window.testRequest('state');
      assert.equal(
        calls.some((call) => Object.hasOwn(call, 'uiFocus')),
        false,
        url
      );
      assert.equal(
        calls.some((call) => call.type === 'focus:ui-state'),
        false,
        url
      );
      assert.equal(ownerLookups, 0, url);
    } finally {
      dom.window.disposeUI();
      dom.window.close();
    }
  }
});

test('old or unavailable window APIs and non-normal owners preserve the ordinary message path', async () => {
  for (const owner of [
    undefined,
    'reject',
    { id: 88, type: 'popup' },
    { id: 88, type: 'normal', incognito: true },
    { id: -1, type: 'normal' },
  ]) {
    const calls = [],
      state = {
        config: structuredClone(DEFAULTS),
        session: null,
        current: null,
        judgment: null,
        checking: false,
        feedback: [],
      };
    const dom = await mount({
      page: 'popup',
      url: 'chrome-extension://focus-ui-test/popup.html',
      setup(window) {
        extensionMock(window, state, calls);
        window.document.hasFocus = () => true;
        if (owner !== undefined)
          window.chrome.windows = {
            async getCurrent() {
              if (owner === 'reject') throw new Error('Window API unavailable');
              return owner;
            },
          };
      },
    });
    try {
      await dom.window.testRequest('state');
      assert.equal(
        calls.some((call) => Object.hasOwn(call, 'uiFocus')),
        false
      );
      assert.equal(dom.window.document.querySelector('.popup') !== null, true);
      assert.equal(dom.window.document.querySelector('.home-alerts .error:not([hidden])'), null);
    } finally {
      dom.window.disposeUI();
      dom.window.close();
    }
  }
});

test('a popup blur while its owner lookup is pending cannot renew a stale focused proof', async () => {
  const calls = [],
    state = {
      config: structuredClone(DEFAULTS),
      session: null,
      current: null,
      judgment: null,
      checking: false,
      feedback: [],
    };
  const dom = await mount({
    page: 'popup',
    url: 'chrome-extension://focus-ui-test/popup.html',
    setup(window) {
      extensionMock(window, state, calls);
      window.document.hasFocus = () => true;
      window.chrome.windows = {
        async getCurrent() {
          await Promise.resolve();
          window.dispatchEvent(new window.Event('blur'));
          return { id: 88, type: 'normal', incognito: false };
        },
      };
    },
  });
  try {
    assert.ok(calls.some((call) => call.type === 'focus:ui-state'));
    assert.ok(calls.every((call) => call.uiFocus?.focused === false));
  } finally {
    dom.window.disposeUI();
    dom.window.close();
  }
});

test('popup counts down the NAS interval locally and shows its automatic deadline without AI requests', async () => {
  let instant = 1_800_000_000_000;
  const timers = [],
    calls = [],
    nextCheckAt = instant + 90_000;
  const state = {
    config: structuredClone(DEFAULTS),
    session: null,
    current: { title: '研究教程', url: 'https://www.bilibili.com/video/BVresearch' },
    judgment: null,
    checking: false,
    feedback: [],
    diagnostics: { eligible: true },
    status: {
      mode: 'auto',
      code: 'interval',
      message: '正在等待 NAS 请求间隔，后台会自动检查。',
      waitSeconds: 90,
      nextCheckAt,
    },
  };
  const dom = await mount({
    page: 'popup',
    setup(window) {
      extensionMock(window, state, calls);
      window.Date.now = () => instant;
      window.setInterval = (callback, delay) => {
        timers.push({ callback, delay });
        return timers.length;
      };
      window.clearInterval = () => {};
    },
  });
  try {
    const { document } = dom.window;
    assert.match(document.querySelector('.judgment').textContent, /NAS 请求间隔.*1 分 30 秒/);
    assert.equal(
      document.querySelector('.next-check time').dateTime,
      new Date(nextCheckAt).toISOString()
    );
    const before = calls.length;
    instant += 31_000;
    timers.find((timer) => timer.delay === 1000).callback();
    await until(() => document.querySelector('.judgment').textContent.includes('59 秒'));
    assert.equal(calls.length, before, 'the local countdown must not poll state or call AI');
    assert.equal(
      calls.some((call) => call.type === 'focus:check'),
      false
    );
    assert.equal(
      document.querySelector('.next-check time').dateTime,
      new Date(nextCheckAt).toISOString()
    );
    instant += 120_000;
    timers.find((timer) => timer.delay === 1000).callback();
    await until(() => document.querySelector('.judgment').textContent.includes('等待后台复查'));
    assert.doesNotMatch(document.querySelector('.judgment').textContent, /-\d+ 秒/);
    assert.equal(calls.length, before);
  } finally {
    dom.window.disposeUI();
    dom.window.close();
  }
});

test('hourly quota, excluded pages and disabled AI do not pretend to be waiting for page dwell', async () => {
  const instant = 1_800_000_000_000;
  for (const item of [
    {
      code: 'hour-limit',
      pattern: /本小时 AI 请求额度已用完.*1 小时 0 分/,
      wait: 3601,
      aiEnabled: true,
    },
    { code: 'excluded', pattern: /不参与 AI 判断/, wait: 0, aiEnabled: true },
    { code: 'disabled', pattern: /AI 内容判断已关闭/, wait: 0, aiEnabled: false },
    { code: 'ready', pattern: /等待后台自动检查/, wait: 0, aiEnabled: true },
    { code: 'dwelling', pattern: /等待页面稳定停留.*20 秒/, wait: 20, aiEnabled: true },
    { code: 'checking', pattern: /正在判断工作/, wait: 0, aiEnabled: true },
  ]) {
    const calls = [],
      state = {
        config: { ...structuredClone(DEFAULTS), aiEnabled: item.aiEnabled },
        session: null,
        current: { title: '页面', url: 'https://www.bilibili.com/video/BVresearch' },
        judgment: { label: 'related', reason: '旧的判断', confidence: 0.9 },
        checking: item.code === 'checking',
        feedback: [],
        status: {
          mode: 'auto',
          code: item.code,
          message: '当前真实检测状态',
          waitSeconds: item.wait,
          nextCheckAt: item.wait ? instant + item.wait * 1000 : null,
        },
      };
    const dom = await mount({
      page: 'popup',
      setup(window) {
        extensionMock(window, state, calls);
        window.Date.now = () => instant;
      },
    });
    try {
      assert.match(dom.window.document.querySelector('.judgment').textContent, item.pattern);
      if (['excluded', 'disabled'].includes(item.code)) {
        assert.equal(button(dom.window.document, '检查当前页面').disabled, true);
      }
      assert.equal(
        calls.some((call) => call.type === 'focus:check'),
        false
      );
    } finally {
      dom.window.disposeUI();
      dom.window.close();
    }
  }
});

test('older status snapshots with waitSeconds still count down without inventing a precise next-check timestamp', async () => {
  let instant = 1_800_000_000_000;
  const timers = [],
    state = {
      config: structuredClone(DEFAULTS),
      session: null,
      current: { title: '页面', url: 'https://www.bilibili.com/video/BVresearch' },
      judgment: null,
      checking: false,
      feedback: [],
      status: { mode: 'auto', code: 'dwelling', message: '停留片刻后自动判断', waitSeconds: 20 },
    };
  const dom = await mount({
    page: 'popup',
    setup(window) {
      extensionMock(window, state, []);
      window.Date.now = () => instant;
      window.setInterval = (callback, delay) => {
        timers.push({ callback, delay });
        return timers.length;
      };
      window.clearInterval = () => {};
    },
  });
  try {
    assert.match(dom.window.document.querySelector('.judgment').textContent, /20 秒/);
    assert.equal(dom.window.document.querySelector('.next-check time'), null);
    instant += 6_000;
    timers.find((timer) => timer.delay === 1000).callback();
    await until(() => dom.window.document.querySelector('.judgment').textContent.includes('14 秒'));
  } finally {
    dom.window.disposeUI();
    dom.window.close();
  }
});

test('disabled temporary passes disappear completely while reading and correction remain available', async () => {
  const calls = [],
    state = {
      config: { ...structuredClone(DEFAULTS), temporaryPassEnabled: false },
      session: null,
      current: null,
      judgment: null,
      checking: false,
      feedback: [],
      passBudget: {
        enabled: false,
        dailyLimitMinutes: 20,
        usedMinutes: 10,
        remainingMinutes: 10,
        cooldownMinutes: 10,
        cooldownUntil: 0,
        waitSeconds: 0,
        nextAvailableAt: null,
        canGrant: false,
        grantMinutes: 0,
        reason: '已关闭临时放行',
      },
    };
  const dom = await mount({
    page: 'blocked',
    hash: '#ai',
    setup(window) {
      extensionMock(window, state, calls);
    },
  });
  try {
    const { document } = dom.window;
    await until(
      () =>
        button(document, '这页属于工作或学习，纠正判断') &&
        !button(document, '这页属于工作或学习，纠正判断').disabled
    );
    assert.equal([...document.querySelectorAll('.blocked-actions button')].length, 0);
    assert.equal(document.querySelector('.pass-budget'), null);
    assert.doesNotMatch(document.querySelector('.blocked-page').textContent, /放行/);
    const reading = [...document.querySelectorAll('.blocked-actions a')].find(
      (link) => link.textContent.trim() === '看会书吧'
    );
    assert.equal(reading.href, 'https://weread.qq.com/');
    assert.equal(reading.getAttribute('target'), null, 'reading opens in the current tab');
    assert.equal(reading.rel, 'noreferrer');
    button(document, '这页属于工作或学习，纠正判断').click();
    await until(() => document.querySelector('.toast').textContent.includes('已纠正'));
    assert.match(document.querySelector('.toast').textContent, /重新打开原网址/);
    assert.doesNotMatch(document.querySelector('.toast').textContent, /放行/);
    assert.equal(
      calls.some((call) => call.type === 'focus:pass'),
      false
    );
  } finally {
    dom.window.disposeUI();
    dom.window.close();
  }
});

test('the blocked page uses the final backend decision and actual granted minutes', async () => {
  const timers = [],
    calls = [],
    budget = {
      enabled: true,
      dailyLimitMinutes: 20,
      usedMinutes: 15,
      remainingMinutes: 5,
      cooldownMinutes: 10,
      cooldownUntil: 0,
      waitSeconds: 0,
      nextAvailableAt: null,
      canGrant: true,
      grantMinutes: 5,
      reason: '',
    };
  const state = {
    config: structuredClone(DEFAULTS),
    session: null,
    current: null,
    judgment: null,
    checking: false,
    feedback: [],
    passBudget: budget,
    blockedResponse: {
      url: 'https://www.bilibili.com/',
      reason: '推荐入口',
      minutes: 5,
      canPass: false,
      passBudget: budget,
    },
  };
  const dom = await mount({
    page: 'blocked',
    hash: '#https%3A%2F%2Fwww.bilibili.com%2F',
    setup(window) {
      extensionMock(window, state, calls);
      window.setInterval = (callback, delay) => {
        timers.push({ callback, delay });
        return timers.length;
      };
      window.clearInterval = () => {};
    },
  });
  try {
    const { document } = dom.window;
    await until(() =>
      document.querySelector('.pass-budget')?.textContent.includes('剩余 5 / 20 分钟')
    );
    const pass = button(document, '仅此页放行 5 分钟');
    assert.equal(pass.disabled, true, 'budget availability cannot override blocked.canPass=false');
    pass.click();
    assert.equal(
      calls.some((call) => call.type === 'focus:pass'),
      false
    );
    state.blockedResponse.canPass = true;
    timers.find((timer) => timer.delay === 2000).callback();
    await until(() => !button(document, '仅此页放行 5 分钟').disabled);
    button(document, '仅此页放行 5 分钟').click();
    await until(() => calls.some((call) => call.type === 'focus:pass'));
    assert.equal(calls.filter((call) => call.type === 'focus:pass').length, 1);
    assert.match(
      document.querySelector('.blocked-page').textContent,
      /按获批时长扣减，提前关页不退回/
    );
    assert.equal(
      calls.some((call) => call.type === 'focus:check'),
      false
    );
  } finally {
    dom.window.disposeUI();
    dom.window.close();
  }
});

test('cooldown counts down locally and expiry only rechecks the backend before enabling a pass', async () => {
  let instant = 1_800_000_000_000;
  const timers = [],
    calls = [],
    budget = {
      enabled: true,
      dailyLimitMinutes: 20,
      usedMinutes: 10,
      remainingMinutes: 10,
      cooldownMinutes: 10,
      cooldownUntil: instant + 10_000,
      waitSeconds: 10,
      nextAvailableAt: instant + 10_000,
      canGrant: false,
      grantMinutes: 10,
      reason: '再次放行仍在冷却中',
    };
  const state = {
    config: structuredClone(DEFAULTS),
    session: null,
    current: null,
    judgment: null,
    checking: false,
    feedback: [],
    passBudget: budget,
  };
  const dom = await mount({
    page: 'blocked',
    hash: '#ai',
    setup(window) {
      extensionMock(window, state, calls);
      window.Date.now = () => instant;
      window.setInterval = (callback, delay) => {
        timers.push({ callback, delay });
        return timers.length;
      };
      window.clearInterval = () => {};
    },
  });
  try {
    const { document } = dom.window;
    await until(() => document.querySelector('.pass-countdown')?.textContent.includes('10 秒'));
    assert.equal(button(document, '仅此页放行 10 分钟').disabled, true);
    const before = calls.length;
    instant += 5_000;
    timers.find((timer) => timer.delay === 1000).callback();
    await until(() => document.querySelector('.pass-countdown')?.textContent.includes('5 秒'));
    assert.equal(calls.length, before, 'a local countdown tick does not poll');
    instant += 5_000;
    timers.find((timer) => timer.delay === 1000).callback();
    await until(() => calls.length > before);
    assert.equal(calls.at(-1).type, 'focus:blocked');
    assert.equal(
      button(document, '仅此页放行 10 分钟').disabled,
      true,
      'zero alone is not authorization'
    );
    budget.canGrant = true;
    budget.nextAvailableAt = null;
    budget.reason = '';
    timers.find((timer) => timer.delay === 2000).callback();
    await until(() => !button(document, '仅此页放行 10 分钟').disabled);
    assert.equal(
      calls.some((call) => call.type === 'focus:check' || call.type === 'focus:pass'),
      false
    );
  } finally {
    dom.window.disposeUI();
    dom.window.close();
  }
});

test('an existing backend-approved pass can be reused without promising new minutes', async () => {
  const calls = [],
    budget = {
      enabled: true,
      dailyLimitMinutes: 20,
      usedMinutes: 20,
      remainingMinutes: 0,
      cooldownMinutes: 10,
      cooldownUntil: Date.now() + 600000,
      waitSeconds: 600,
      nextAvailableAt: Date.now() + 600000,
      canGrant: false,
      grantMinutes: 0,
      reason: '每日累计额度已用完',
    };
  const state = {
    config: structuredClone(DEFAULTS),
    session: null,
    current: null,
    judgment: null,
    checking: false,
    feedback: [],
    passBudget: budget,
    blockedResponse: {
      url: 'https://www.bilibili.com/',
      reason: '推荐入口',
      minutes: 10,
      canPass: true,
      passBudget: budget,
    },
  };
  const dom = await mount({
    page: 'blocked',
    setup(window) {
      extensionMock(window, state, calls);
    },
  });
  try {
    const { document } = dom.window;
    await until(() => !!button(document, '返回已放行页面'));
    assert.equal(button(document, '返回已放行页面').disabled, false);
    assert.match(document.querySelector('.pass-budget').textContent, /不会重新扣减额度或延长/);
    assert.equal(button(document, '仅此页放行 10 分钟'), undefined);
  } finally {
    dom.window.disposeUI();
    dom.window.close();
  }
});

test('pass limit settings support zero and disabling greys all timing controls without discarding values', async () => {
  const dom = await mount({ hash: '#settings/blocking' });
  try {
    const { window } = dom;
    await until(() => window.document.querySelector('dialog')?.open);
    const daily = field(window.document, '每日累计放行上限（分钟）'),
      cooldown = field(window.document, '再次放行冷却（分钟）');
    assert.equal(daily.min, '0');
    assert.equal(daily.max, '180');
    assert.equal(cooldown.min, '0');
    assert.equal(cooldown.max, '120');
    input(window, daily, '0');
    input(window, cooldown, '0');
    await until(() => !!button(window.document, '保存设置'));
    button(window.document, '保存设置').click();
    await until(() => button(window.document, '已保存')?.disabled);
    const toggle = [...window.document.querySelectorAll('.toggle-field')].find(
      (el) => el.querySelector('.field-title')?.textContent === '允许临时放行'
    );
    assert.match(toggle.textContent, /已有放行也会立即撤销/);
    const checkbox = toggle.querySelector('input');
    checkbox.checked = false;
    checkbox.dispatchEvent(new window.Event('change', { bubbles: true }));
    await until(() => daily.disabled);
    assert.equal(cooldown.disabled, true);
    assert.equal(field(window.document, '被拦截页面临时放行（分钟）').disabled, true);
    button(window.document, '保存设置').click();
    await until(() => button(window.document, '已保存')?.disabled);
    const saved = JSON.parse(window.localStorage.getItem('focus-preview-config'));
    assert.equal(saved.temporaryPassEnabled, false);
    assert.equal(saved.passDailyMinutes, 0);
    assert.equal(saved.passCooldownMinutes, 0);
    [...window.document.querySelectorAll('.settings-sidebar nav button')]
      .find((el) => el.textContent.endsWith('内容判断'))
      .click();
    await until(() => window.document.querySelector('#settings-title')?.textContent === '内容判断');
    assert.doesNotMatch(field(window.document, '明确娱乐或偏离目标时').textContent, /保留短时放行/);
  } finally {
    dom.window.disposeUI();
    dom.window.close();
  }
});

test('canPass cannot enable a pass with a missing or malformed per-page budget, even when snapshot budget is valid', async () => {
  const valid = {
    enabled: true,
    dailyLimitMinutes: 20,
    usedMinutes: 0,
    remainingMinutes: 20,
    cooldownMinutes: 10,
    cooldownUntil: 0,
    canGrant: true,
    grantMinutes: 10,
  };
  for (const bad of [
    undefined,
    null,
    { enabled: true },
    { ...valid, grantMinutes: -1 },
    { ...valid, remainingMinutes: '20' },
    { ...valid, usedMinutes: 20 },
    { ...valid, canGrant: 'true' },
    { ...valid, nextAvailableAt: 1e100 },
  ]) {
    const calls = [],
      state = {
        config: structuredClone(DEFAULTS),
        session: null,
        current: null,
        judgment: null,
        checking: false,
        feedback: [],
        passBudget: valid,
        blockedResponse: {
          url: 'https://www.bilibili.com/',
          reason: '推荐入口',
          minutes: 10,
          canPass: true,
          passBudget: bad,
        },
      };
    const dom = await mount({
      page: 'blocked',
      setup(window) {
        extensionMock(window, state, calls);
      },
    });
    try {
      const { document } = dom.window;
      await until(() => document.querySelector('.blocked-url'));
      const pass = [...document.querySelectorAll('.blocked-actions button')][0];
      assert.ok(pass);
      assert.equal(pass.disabled, true, JSON.stringify(bad));
      pass.click();
      assert.equal(
        calls.some((call) => call.type === 'focus:pass'),
        false
      );
      assert.match(document.querySelector('.blocked-page').textContent, /尚未获得有效放行额度/);
    } finally {
      dom.window.disposeUI();
      dom.window.close();
    }
  }
});

test('a complete budget without optional display fields remains compatible', async () => {
  const budget = {
    enabled: true,
    dailyLimitMinutes: 0,
    usedMinutes: 35,
    remainingMinutes: null,
    cooldownMinutes: 0,
    cooldownUntil: 0,
    canGrant: true,
    grantMinutes: 10,
  };
  const calls = [],
    state = {
      config: structuredClone(DEFAULTS),
      session: null,
      current: null,
      judgment: null,
      checking: false,
      feedback: [],
      passBudget: budget,
      blockedResponse: {
        url: 'https://www.bilibili.com/',
        reason: '推荐入口',
        canPass: true,
        passBudget: budget,
      },
    };
  const dom = await mount({
    page: 'blocked',
    setup(window) {
      extensionMock(window, state, calls);
    },
  });
  try {
    await until(
      () =>
        button(dom.window.document, '仅此页放行 10 分钟') &&
        !button(dom.window.document, '仅此页放行 10 分钟').disabled
    );
    assert.match(dom.window.document.querySelector('.pass-budget').textContent, /不设每日累计上限/);
  } finally {
    dom.window.disposeUI();
    dom.window.close();
  }
});

test('zero-cooldown existing passes remain reusable even while the budget could grant new minutes', async () => {
  const calls = [],
    budget = {
      enabled: true,
      dailyLimitMinutes: 20,
      usedMinutes: 5,
      remainingMinutes: 15,
      cooldownMinutes: 0,
      cooldownUntil: 0,
      canGrant: true,
      grantMinutes: 10,
      nextAvailableAt: Date.now(),
    };
  const state = {
    config: { ...structuredClone(DEFAULTS), passCooldownMinutes: 0 },
    session: null,
    current: null,
    judgment: null,
    checking: false,
    feedback: [],
    passBudget: budget,
    blockedResponse: {
      url: 'https://www.bilibili.com/',
      reason: '推荐入口',
      minutes: 0,
      canPass: true,
      until: Date.now() + 300000,
      passBudget: budget,
    },
  };
  const dom = await mount({
    page: 'blocked',
    setup(window) {
      extensionMock(window, state, calls);
    },
  });
  try {
    const { document } = dom.window;
    await until(() => !!button(document, '返回已放行页面'));
    assert.equal(button(document, '返回已放行页面').disabled, false);
    assert.match(document.querySelector('.pass-budget').textContent, /不会重新扣减额度或延长/);
    assert.equal(button(document, '仅此页放行 10 分钟'), undefined);
    button(document, '返回已放行页面').click();
    await until(() => calls.some((call) => call.type === 'focus:pass'));
    assert.equal(calls.filter((call) => call.type === 'focus:pass').length, 1);
  } finally {
    dom.window.disposeUI();
    dom.window.close();
  }
});

test('zero approved minutes need both a future existing lease and final backend permission', async () => {
  for (const item of [
    { canPass: true, until: undefined, canGrant: true },
    { canPass: true, until: Date.now() - 1000, canGrant: true },
    { canPass: true, until: undefined, canGrant: false },
    { canPass: true, until: Date.now() - 1000, canGrant: false },
    { canPass: false, until: Date.now() + 300000, canGrant: true },
    { canPass: true, until: 1e100, canGrant: true },
  ]) {
    const calls = [],
      budget = {
        enabled: true,
        dailyLimitMinutes: 20,
        usedMinutes: 5,
        remainingMinutes: 15,
        cooldownMinutes: 0,
        cooldownUntil: 0,
        canGrant: item.canGrant,
        grantMinutes: 10,
      };
    const state = {
      config: structuredClone(DEFAULTS),
      session: null,
      current: null,
      judgment: null,
      checking: false,
      feedback: [],
      passBudget: budget,
      blockedResponse: {
        url: 'https://www.bilibili.com/',
        reason: '推荐入口',
        minutes: 0,
        canPass: item.canPass,
        until: item.until,
        passBudget: budget,
      },
    };
    const dom = await mount({
      page: 'blocked',
      setup(window) {
        extensionMock(window, state, calls);
      },
    });
    try {
      const { document } = dom.window;
      await until(() => document.querySelector('.blocked-url'));
      const pass = [...document.querySelectorAll('.blocked-actions button')][0];
      assert.equal(pass.disabled, true, JSON.stringify(item));
      assert.equal(button(document, '返回已放行页面'), undefined);
      pass.click();
      assert.equal(
        calls.some((call) => call.type === 'focus:pass'),
        false
      );
    } finally {
      dom.window.disposeUI();
      dom.window.close();
    }
  }
});

test('an already available pass does not repeatedly refresh as its immediate nextAvailableAt expires', async () => {
  let instant = 1_800_000_000_000;
  const timers = [],
    calls = [],
    budget = {
      enabled: true,
      dailyLimitMinutes: 20,
      usedMinutes: 0,
      remainingMinutes: 20,
      cooldownMinutes: 10,
      cooldownUntil: 0,
      canGrant: true,
      grantMinutes: 10,
      nextAvailableAt: instant,
    };
  const state = {
    config: structuredClone(DEFAULTS),
    session: null,
    current: null,
    judgment: null,
    checking: false,
    feedback: [],
    passBudget: budget,
  };
  const dom = await mount({
    page: 'blocked',
    setup(window) {
      extensionMock(window, state, calls);
      window.Date.now = () => instant;
      window.setInterval = (callback, delay) => {
        timers.push({ callback, delay });
        return timers.length;
      };
      window.clearInterval = () => {};
    },
  });
  try {
    await until(
      () =>
        button(dom.window.document, '仅此页放行 10 分钟') &&
        !button(dom.window.document, '仅此页放行 10 分钟').disabled
    );
    const before = calls.length;
    for (let step = 0; step < 3; step++) {
      instant += 1000;
      budget.nextAvailableAt = instant;
      timers.find((timer) => timer.delay === 1000).callback();
      await new Promise((resolve) => setTimeout(resolve, 35));
    }
    assert.equal(calls.length, before, 'local ticks do not refresh an already available pass');
    timers.find((timer) => timer.delay === 2000).callback();
    await until(() => calls.length > before);
    assert.equal(calls.length, before + 1, 'the normal read-only poll remains unchanged');
    assert.equal(calls.at(-1).type, 'focus:blocked');
    assert.equal(
      calls.some((call) => call.type === 'focus:check' || call.type === 'focus:pass'),
      false
    );
  } finally {
    dom.window.disposeUI();
    dom.window.close();
  }
});

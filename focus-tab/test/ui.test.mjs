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
        "import './src/app.jsx'; import { render } from 'preact'; import { request } from './src/bridge.mjs'; globalThis.testRequest = request; globalThis.disposeUI = () => render(null, document.getElementById('app'));",
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

async function mount({ page = 'home', hash = '', setup = () => {} } = {}) {
  const dom = new JSDOM(`<body data-page="${page}"><div id="app"></div></body>`, {
    url: `https://focus.test/${page === 'home' ? 'index' : page}.html${hash}`,
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
  window.chrome = {
    runtime: {
      id: 'focus-ui-test',
      getURL: (path) => `chrome-extension://focus-ui-test/${path}`,
      async sendMessage(message) {
        calls.push(JSON.parse(JSON.stringify(message)));
        return {
          ok: true,
          data:
            message.type === 'focus:blocked'
              ? {
                  url: 'https://www.bilibili.com/video/BVresearch',
                  reason: '待纠正的 AI 判断',
                  minutes: 10,
                  ai: true,
                }
              : structuredClone(state),
        };
      },
    },
    storage: { onChanged: { addListener() {}, removeListener() {} } },
    tabs: { async create() {} },
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
    await until(() => document.querySelector('.toast')?.textContent.includes('已纠正本次判断'));
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

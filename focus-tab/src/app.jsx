import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import Sortable from 'sortablejs/modular/sortable.core.esm.js';
import { request, isExtension, openSettingsPage, reportPopupFocus } from './bridge.mjs';
import { BUILTINS } from './rules.mjs';
import { PRESETS, validatePatch } from './config.mjs';
import { blockedPayload } from './blocked-location.mjs';

const $ = (selector) => document.querySelector(selector);
const labels = {
  related: '与研究相关',
  unrelated: '可能偏离目标',
  uncertain: '信息不足，暂不判断',
};
const page =
  document.body.dataset.page ||
  (location.pathname.includes('popup')
    ? 'popup'
    : location.pathname.includes('blocked')
    ? 'blocked'
    : 'home');
const glyphs = {
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </>
  ),
  settings: (
    <>
      <path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1m-8.6 8.6-2.1 2.1" />
      <circle cx="12" cy="12" r="5" />
    </>
  ),
  arrow: (
    <>
      <path d="M5 12h14m-5-5 5 5-5 5" />
    </>
  ),
  close: <path d="m6 6 12 12M6 18 18 6" />,
  shield: (
    <>
      <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  leaf: (
    <>
      <path d="M5 19C1 8 10 3 21 3c0 12-5 20-16 16Z" />
      <path d="M3 21 16 8" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="m5 12 4 4L20 5" />,
};
function Icon({ name, size = 20 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {glyphs[name] || glyphs.leaf}
    </svg>
  );
}
function Logo({ brand = '专注' }) {
  return (
    <span class="brand">
      <span class="brand-mark">
        <Icon name="leaf" size={19} />
      </span>
      {brand}
    </span>
  );
}
function Button({ children, icon, secondary, small, ...props }) {
  return (
    <button class={`button ${secondary ? 'secondary' : ''} ${small ? 'small' : ''}`} {...props}>
      {icon && <Icon name={icon} size={17} />} {children}
    </button>
  );
}
function Field({ label, help, children }) {
  return (
    <label class="field">
      <span class="field-title">{label}</span>
      {children}
      {help && <small>{help}</small>}
    </label>
  );
}
function Toggle({ label, help, value, onChange }) {
  return (
    <label class="toggle-field">
      <span>
        <span class="field-title">{label}</span>
        {help && <small>{help}</small>}
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span class="switch" aria-hidden="true" />
    </label>
  );
}
function HostEditor({ hosts, onChange }) {
  const parse = (text) =>
    text
      .split('\n')
      .map((line) => line.trim().toLowerCase())
      .filter(Boolean);
  const [text, setText] = useState(hosts.join('\n'));
  useEffect(() => {
    // Preserve the in-progress last line. External settings and imports still
    // replace the editor when their normalized domains actually differ.
    if (JSON.stringify(hosts) !== JSON.stringify(parse(text))) setText(hosts.join('\n'));
  }, [hosts]);
  return (
    <textarea
      rows={7}
      value={text}
      onInput={(event) => {
        setText(event.target.value);
        onChange(parse(event.target.value));
      }}
    />
  );
}
function Timer({ session, now }) {
  const seconds = Math.max(0, Math.ceil((session.ends - now) / 1000));
  return (
    <span class="timer">
      <Icon name="clock" size={16} />
      {seconds
        ? `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(
            2,
            '0'
          )}`
        : '本轮已结束'}
    </span>
  );
}

function formatWait(seconds) {
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分`;
}

function detectionDisplay(state, now, receivedAt, automatic, judgmentLabels) {
  const status = typeof state.status === 'object' && state.status ? state.status : {};
  const nextCheckAt =
    Number.isFinite(status.nextCheckAt) &&
    status.nextCheckAt > 0 &&
    Number.isFinite(new Date(status.nextCheckAt).getTime())
      ? status.nextCheckAt
      : null;
  const fallbackDeadline =
    Number.isFinite(status.waitSeconds) && status.waitSeconds > 0
      ? receivedAt + status.waitSeconds * 1000
      : null;
  const deadline = nextCheckAt || fallbackDeadline;
  const seconds = deadline ? Math.max(0, Math.ceil((deadline - now) / 1000)) : null;
  let label;
  if (state.checking || status.code === 'checking') {
    label = automatic ? '正在判断工作 / 学习与娱乐…' : '正在对照研究目标…';
  } else {
    const waiting =
      seconds === null ? '' : seconds > 0 ? ` · 还需 ${formatWait(seconds)}` : ' · 等待后台复查';
    const statuses = {
      disabled: 'AI 内容判断已关闭',
      'waiting-task': '填写研究目标后开始判断',
      'no-page': state.diagnostics?.eligible === false ? '暂未满足判断条件' : '等待识别普通网页',
      excluded: '此页面不参与 AI 判断',
      dwelling: '等待页面稳定停留' + waiting,
      interval: '等待 NAS 请求间隔' + waiting,
      'hour-limit': '本小时 AI 请求额度已用完' + waiting,
      ready: '已满足条件，等待后台自动检查',
      error:
        'AI 请求失败' + (seconds !== null && seconds > 0 ? ` · ${formatWait(seconds)}后重试` : ''),
      judged: state.judgment ? judgmentLabels[state.judgment.label] : '已判断当前网页',
    };
    label = statuses[status.code];
    if (!label) {
      label = state.judgment
        ? judgmentLabels[state.judgment.label]
        : state.diagnostics?.eligible === false
        ? '暂未满足判断条件'
        : !state.current
        ? '等待识别普通网页'
        : typeof state.status === 'string'
        ? state.status
        : status.message || '等待后台检查状态';
    }
  }
  return { label, nextCheckAt, seconds };
}

function validPassBudget(budget) {
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)) return false;
  const integer = (value, min, max = Number.MAX_SAFE_INTEGER) =>
    Number.isSafeInteger(value) && value >= min && value <= max;
  const timestamp = (value) =>
    Number.isFinite(value) && value >= 0 && Number.isFinite(new Date(value).getTime());
  if (
    typeof budget.enabled !== 'boolean' ||
    typeof budget.canGrant !== 'boolean' ||
    !integer(budget.dailyLimitMinutes, 0, 180) ||
    !integer(budget.usedMinutes, 0) ||
    !integer(budget.cooldownMinutes, 0, 120) ||
    !timestamp(budget.cooldownUntil) ||
    !integer(budget.grantMinutes, 0, 30)
  )
    return false;
  if (
    budget.dailyLimitMinutes === 0
      ? budget.remainingMinutes !== null
      : budget.remainingMinutes !== Math.max(0, budget.dailyLimitMinutes - budget.usedMinutes)
  )
    return false;
  if (
    budget.canGrant &&
    (!budget.enabled ||
      budget.grantMinutes < 1 ||
      (budget.remainingMinutes !== null && budget.grantMinutes > budget.remainingMinutes))
  )
    return false;
  // Older complete budgets may omit display-only scheduling and reason fields.
  if (budget.waitSeconds !== undefined && !integer(budget.waitSeconds, 0)) return false;
  if (
    budget.nextAvailableAt !== undefined &&
    budget.nextAvailableAt !== null &&
    !timestamp(budget.nextAvailableAt)
  )
    return false;
  return budget.reason === undefined || typeof budget.reason === 'string';
}

function PassBudgetInfo({ budget, now, reused }) {
  if (!budget) return <p class="fine">正在读取今日放行额度…</p>;
  const cooldown = Number.isFinite(budget.cooldownUntil)
    ? Math.max(0, Math.ceil((budget.cooldownUntil - now) / 1000))
    : 0;
  return (
    <section class="pass-budget fine" aria-label="临时放行额度">
      <p>
        {budget.dailyLimitMinutes === 0
          ? `今日已获批 ${budget.usedMinutes} 分钟 · 不设每日累计上限`
          : `今日已获批 ${budget.usedMinutes} 分钟 · 剩余 ${budget.remainingMinutes} / ${budget.dailyLimitMinutes} 分钟`}
      </p>
      {cooldown > 0 && (
        <p class="pass-countdown" role="timer" aria-live="off">
          距再次放行还需 {formatWait(cooldown)}
        </p>
      )}
      {!reused && budget.reason && <p>{budget.reason}</p>}
      {!reused && !budget.canGrant && cooldown === 0 && budget.remainingMinutes !== 0 && (
        <p>正在核验最新放行额度…</p>
      )}
      {/* An available budget's timestamp is the backend's current time. It can
          be newer than our one-second UI clock without representing a wait. */}
      {!budget.canGrant &&
        Number.isFinite(budget.nextAvailableAt) &&
        budget.nextAvailableAt > now && (
          <p>
            下次可申请：
            <time dateTime={new Date(budget.nextAvailableAt).toISOString()}>
              {new Date(budget.nextAvailableAt).toLocaleString('zh-CN', {
                month: 'numeric',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false,
              })}
            </time>
          </p>
        )}
      {reused && <p>沿用当前放行截止时间，不会重新扣减额度或延长。</p>}
    </section>
  );
}

function App() {
  const [state, setState] = useState(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const initialSettings = location.hash.match(
    /^#settings(?:\/(appearance|links|task|ai|blocking|privacy))?$/
  );
  const [settings, setSettings] = useState(Boolean(initialSettings)),
    [section, setSection] = useState(initialSettings?.[1] || 'appearance');
  const [now, setNow] = useState(Date.now()),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState('');
  const [goal, setGoal] = useState(''),
    [remember, setRemember] = useState(false),
    [blocked, setBlocked] = useState(null);
  const input = useRef(),
    snapshotClock = useRef({ state: null, receivedAt: Date.now() });
  const passRefreshAt = useRef(null);
  async function refresh() {
    try {
      setState(await request('state'));
    } catch (e) {
      setError(e.message);
    }
  }
  async function refreshBlocked() {
    if (page !== 'blocked' || !isExtension) return;
    try {
      setBlocked(await request('blocked', blockedPayload(location.hash)));
    } catch (e) {
      setBlocked(null);
      setError(e.message);
    }
  }
  useEffect(() => {
    refresh();
    // The visible countdown is local. Keep the existing state refresh cadence;
    // displaying a second ticking down must never request an AI check.
    const clockTimer = setInterval(() => setNow(Date.now()), 1000);
    const stateTimer = setInterval(() => {
      if (page === 'popup' && !document.hidden) refresh();
      if (page === 'blocked' && !document.hidden) refreshBlocked();
    }, 2000);
    const changed = () => {
      if (page === 'popup') {
        reportPopupFocus(
          document.visibilityState === 'visible' &&
            typeof document.hasFocus === 'function' &&
            document.hasFocus()
        ).catch(() => {});
      }
      if (!document.hidden) {
        refresh();
        refreshBlocked();
      }
    };
    document.addEventListener('visibilitychange', changed);
    const focused = () => {
      if (page !== 'popup') return;
      reportPopupFocus(true).catch(() => {});
      refresh();
    };
    const blurred = () => {
      if (page === 'popup') reportPopupFocus(false).catch(() => {});
    };
    window.addEventListener('focus', focused);
    window.addEventListener('blur', blurred);
    window.addEventListener('pagehide', blurred);
    const storageChanged = (changes) => {
      if (changes.focusSession || changes.focusConfig || changes.focusRuntime) refresh();
    };
    if (isExtension) chrome.storage.onChanged.addListener(storageChanged);
    const key = (event) => {
      if (
        event.key === '/' &&
        !document.querySelector('dialog[open]') &&
        !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) &&
        !document.activeElement?.isContentEditable
      ) {
        event.preventDefault();
        input.current?.focus();
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      clearInterval(clockTimer);
      clearInterval(stateTimer);
      document.removeEventListener('visibilitychange', changed);
      window.removeEventListener('focus', focused);
      window.removeEventListener('blur', blurred);
      window.removeEventListener('pagehide', blurred);
      if (page === 'popup') reportPopupFocus(false).catch(() => {});
      document.removeEventListener('keydown', key);
      if (isExtension) chrome.storage.onChanged.removeListener(storageChanged);
    };
  }, []);
  useEffect(() => {
    if (!state) return;
    document.title = page === 'blocked' ? '停一下 · 专注' : state.config.tabTitle;
    document.documentElement.dataset.theme = state.config.theme;
  }, [state?.config]);
  useEffect(() => {
    refreshBlocked();
  }, []);
  const blockedBudget = validPassBudget(blocked?.passBudget) ? blocked.passBudget : null;
  const snapshotBudget = validPassBudget(state?.passBudget) ? state.passBudget : null;
  const waitingPassBudget = blockedBudget || snapshotBudget;
  const nextPassAt =
    waitingPassBudget?.enabled === true &&
    waitingPassBudget.canGrant === false &&
    blocked?.canPass !== true
      ? waitingPassBudget.nextAvailableAt
      : null;
  useEffect(() => {
    // Reaching zero only asks the backend again; the local clock never grants
    // a pass or resets the shared daily budget.
    if (
      page !== 'blocked' ||
      !Number.isFinite(nextPassAt) ||
      nextPassAt <= 0 ||
      nextPassAt > now ||
      passRefreshAt.current === nextPassAt
    )
      return;
    passRefreshAt.current = nextPassAt;
    refreshBlocked();
  }, [now, nextPassAt]);
  async function act(type, payload = {}, bubbleError = false) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await request(type, payload);
      if (result?.config) setState(result);
      return result;
    } catch (e) {
      setError(e.message);
      if (bubbleError) throw e;
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function saveConfig(patch) {
    // Keep the rejection intact so a native modal can display the real error.
    const result = await request('config', patch);
    if (!result?.config) throw new Error('保存设置后未收到确认，请重试');
    setState(result);
    setError('');
    setNotice('');
    return result.config;
  }
  async function search(e) {
    e.preventDefault();
    const result = await act('search', { query });
    if (result?.url) location.assign(result.url);
  }
  const openSettings = (name = 'appearance') => {
    setSection(name);
    setSettings(true);
    setError('');
  };
  if (!state)
    return (
      <main class="loading">
        <Logo />
        <p role="status">正在准备你的专注空间…</p>
        {error && <p class="error">{error}</p>}
      </main>
    );
  const { config, session, judgment } = state;
  const activeSession = Boolean(session && session.ends > now);
  const automatic = Boolean(config.autoClassify && !activeSession);
  const hasContext = Boolean(config.autoClassify || activeSession);
  const canJudge = Boolean(
    hasContext &&
      state.current &&
      state.status?.code !== 'excluded' &&
      state.diagnostics?.eligible !== false
  );
  const judgmentLabels = automatic
    ? { ...labels, related: '工作或学习', unrelated: '娱乐或消遣' }
    : labels;
  if (snapshotClock.current.state !== state) {
    snapshotClock.current = { state, receivedAt: Date.now() };
  }
  const detection = detectionDisplay(
    state,
    now,
    snapshotClock.current.receivedAt,
    automatic,
    judgmentLabels
  );
  const passBudget = blockedBudget || snapshotBudget;
  const passEnabled =
    config.temporaryPassEnabled !== false &&
    blocked?.passBudget?.enabled !== false &&
    state.passBudget?.enabled !== false;
  const candidateMinutes = blocked?.minutes ?? blockedBudget?.grantMinutes;
  const validMinutes =
    Number.isInteger(candidateMinutes) && candidateMinutes >= 1 && candidateMinutes <= 30;
  const existingLease =
    blocked?.minutes === 0 &&
    Number.isFinite(blocked.until) &&
    Number.isFinite(new Date(blocked.until).getTime()) &&
    blocked.until > now;
  const canPass = Boolean(
    passEnabled &&
      blockedBudget?.enabled === true &&
      blocked?.canPass === true &&
      (existingLease ||
        (validMinutes &&
          (blockedBudget.canGrant === false || candidateMinutes <= blockedBudget.grantMinutes)))
  );
  const reusedPass = Boolean(canPass && (existingLease || passBudget?.canGrant === false));
  const grantMinutes = blockedBudget && validMinutes ? candidateMinutes : 0;
  const checkStatus = typeof state.status === 'string' ? state.status : state.status?.message;
  const task = (
    <div class="task-card">
      <div class="task-heading">
        <span class="eyebrow">{activeSession ? '当前研究' : '浏览判断'}</span>
        {session && <Timer session={session} now={now} />}
      </div>
      {session ? (
        <>
          <strong class="task-goal">{session.goal}</strong>
          {!activeSession && (
            <p class="fine">
              {config.autoClassify
                ? '本轮已结束，已切回工作 / 学习与娱乐的自动判断。'
                : '本轮已结束，开始或续时后恢复内容判断。'}
            </p>
          )}
          <div class="task-actions">
            <Button secondary small disabled={busy} onClick={() => act('extend')}>
              续时 {config.extendMinutes} 分钟
            </Button>
            <button class="text-button" disabled={busy} onClick={() => act('end')}>
              结束本轮
            </button>
          </div>
        </>
      ) : (
        <>
          <p class="fine">
            {!config.aiEnabled
              ? 'AI 内容判断已关闭，可在设置中开启。研究目标可选填。'
              : config.autoClassify
              ? '自动模式已开启。研究目标可选填，填写后按这次任务判断资料相关性。'
              : '自动模式已关闭，填写研究目标后才会判断页面内容。'}
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await act('start', { goal });
            }}
          >
            <input
              aria-label="研究目标"
              placeholder="例如：寻找 TrackMate 轨迹分析教程"
              value={goal}
              maxLength={200}
              onInput={(e) => setGoal(e.target.value)}
            />
            <Button small disabled={busy || !goal.trim()}>
              开始研究
            </Button>
          </form>
        </>
      )}
    </div>
  );
  const alerts = (
    <>
      <div class="error" role="alert" hidden={!error}>
        {error}
      </div>
      <div class="toast" role="status" hidden={!notice}>
        {notice}
      </div>
    </>
  );
  if (page === 'blocked')
    return (
      <main class="blocked-page">
        <Logo brand={config.brand} />
        <div class="blocked-illustration">
          <Icon name="leaf" size={52} />
        </div>
        <span class="eyebrow">把注意力留给想做的事</span>
        <h1>停一下，再决定去哪里。</h1>
        <p class="muted">{blocked?.reason || '这个页面属于你设置的拦截范围。'}</p>
        {blocked?.url && <p class="blocked-url">{blocked.url}</p>}
        {session && (
          <div class="blocked-goal">
            <small>你正在研究</small>
            <strong>{session.goal}</strong>
          </div>
        )}
        <div class="blocked-actions">
          <a class="button secondary blocked-navigation" href="index.html">
            回到搜索
          </a>
          <a class="button blocked-navigation" href="https://weread.qq.com/" rel="noreferrer">
            看会书吧
          </a>
          {passEnabled && (
            <Button
              secondary
              disabled={busy || !canPass}
              onClick={async () => {
                if (!(await act('pass', blockedPayload(location.hash)))) await refreshBlocked();
              }}
            >
              {reusedPass
                ? '返回已放行页面'
                : grantMinutes > 0
                ? `仅此页放行 ${grantMinutes} 分钟`
                : '暂不可临时放行'}
            </Button>
          )}
        </div>
        {passEnabled && <PassBudgetInfo budget={passBudget} now={now} reused={reusedPass} />}
        {passEnabled && blocked && (!blockedBudget || typeof blocked.canPass !== 'boolean') && (
          <p class="fine" role="status">
            尚未获得有效放行额度，暂不可放行。
          </p>
        )}
        {location.hash === '#ai' && (
          <button
            class="text-button"
            disabled={busy || !blocked || !hasContext}
            onClick={async () => {
              if (await act('feedback', { label: 'related', remember: false, ai: true }))
                setNotice('已纠正；重新打开原网址时使用本次纠正。');
            }}
          >
            {automatic ? '这页属于工作或学习，纠正判断' : '这页与研究相关，纠正判断'}
          </button>
        )}
        {passEnabled && (
          <p class="fine">
            放行只适用于当前标签页的这个网址，到期恢复拦截。每日额度按获批时长扣减，提前关页不退回。
          </p>
        )}
        {alerts}
        <button class="text-button" onClick={() => openSettings('blocking')}>
          调整拦截规则
        </button>
        {settings && (
          <Settings
            config={config}
            section={section}
            setSection={setSection}
            onClose={() => setSettings(false)}
            save={saveConfig}
            act={act}
            state={state}
          />
        )}
      </main>
    );
  if (page === 'popup')
    return (
      <main class="popup">
        <header>
          <Logo brand={config.brand} />
          <span class="popup-version">v{state.version || '开发版'}</span>
          <button class="icon-button" aria-label="打开设置" onClick={openSettingsPage}>
            <Icon name="settings" />
          </button>
        </header>
        {task}
        <section class="current-card">
          <span class="eyebrow">当前页面</span>
          <h2>{state.current?.title || '当前没有可判断的普通网页'}</h2>
          <p class="site">{state.current?.url || '只在前台、非隐私窗口内判断'}</p>
          <div
            class={`judgment ${
              !state.status?.code || state.status.code === 'judged' ? judgment?.label || '' : ''
            }`}
          >
            <Icon name="shield" size={18} />
            <span>{detection.label}</span>
          </div>
          {judgment && (
            <>
              <p>{judgment.reason}</p>
              <p class="fine">
                {judgment.source === 'human'
                  ? '采用你的纠正'
                  : `模型自评 ${Math.round(judgment.confidence * 100)}% · ${
                      judgment.input?.method === 'readability' ? '正文摘录' : '页面元数据'
                    }`}{' '}
                · 不是准确率
              </p>
            </>
          )}
          {checkStatus && !state.checking && (
            <p class="fine detection-status" role="status">
              {checkStatus}
            </p>
          )}
          {(!state.current || state.diagnostics?.eligible === false) &&
            state.diagnostics?.message && (
              <p class="fine page-diagnostic" role="status">
                {state.diagnostics.message}
              </p>
            )}
          {state.error && (
            <div class="error ai-error" role="alert" aria-live="assertive">
              <strong>AI 判断暂不可用</strong>
              <p>{state.error}</p>
              <p>当前资料页保持开放，网址拦截继续生效。请检查 AI 地址、模型和访问权限。</p>
              <button class="text-button" onClick={() => openSettingsPage('ai')}>
                打开 AI 连接设置
              </button>
            </div>
          )}
          <Button
            secondary
            small
            disabled={busy || state.checking || !config.aiEnabled || !canJudge}
            onClick={() => act('check')}
          >
            检查当前页面
          </Button>
          <small class="fine block">手动检查可跳过稳定停留等待，仍遵守最小间隔和每小时限额。</small>
          {!state.current && (
            <button class="text-button" disabled={busy} onClick={refresh}>
              重新识别页面（不请求 AI）
            </button>
          )}
        </section>
        <details class="runtime-details">
          <summary>运行信息</summary>
          <p>
            版本 {state.version || '开发版'} ·{' '}
            {config.aiAction === 'block' ? '高置信度拦截' : '仅提醒'}
          </p>
          <p>
            本小时 AI 请求 {state.calls || 0} / {config.requestsPerHour}
          </p>
          <p>页面状态：{state.diagnostics?.code || state.status?.code || '等待检测'}</p>
          <p class="next-check">
            下一次自动检查：
            {detection.nextCheckAt ? (
              <time dateTime={new Date(detection.nextCheckAt).toISOString()}>
                {new Date(detection.nextCheckAt).toLocaleTimeString('zh-CN', { hour12: false })}
              </time>
            ) : state.checking || state.status?.code === 'checking' ? (
              '当前请求进行中'
            ) : (
              '等待满足判断条件'
            )}
          </p>
          <p class="fine">自动检查由后台调度，无需保持此弹窗打开。</p>
          {state.diagnostics?.checkedAt && (
            <p>检测时间：{new Date(state.diagnostics.checkedAt).toLocaleTimeString('zh-CN')}</p>
          )}
          {state.diagnostics?.message && <p>{state.diagnostics.message}</p>}
        </details>
        <section class="feedback">
          <span class="eyebrow">判断不合适？</span>
          <div class="feedback-buttons">
            {['related', 'unrelated', 'uncertain'].map((label) => (
              <button
                key={label}
                disabled={busy || !canJudge}
                onClick={() => act('feedback', { label, remember })}
              >
                {label === 'related'
                  ? automatic
                    ? '工作或学习'
                    : '在查资料'
                  : label === 'unrelated'
                  ? automatic
                    ? '娱乐消遣'
                    : '确实走神'
                  : '暂不判断'}
              </button>
            ))}
          </div>
          <label class="checkbox">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            {automatic ? '以后同一页也这样判断（自动模式）' : '以后同一目标、同一页也这样判断'}
          </label>
        </section>
        {alerts}
        <a class="popup-home" href="index.html" target="_blank">
          打开专注新标签页 <Icon name="arrow" size={15} />
        </a>
      </main>
    );
  return (
    <div class="home-shell">
      {!isExtension && <div class="preview-banner">界面预览 · 安装扩展后启用页面判断与拦截</div>}
      <header class="home-header">
        <Logo brand={config.brand} />
        <div class="header-right">
          <span class="protection-status">
            <span />
            {config.blockFeeds ? '已开启' : '已暂停'}
          </span>
          <button class="settings-button" onClick={() => openSettings()}>
            <Icon name="settings" size={18} />
            <span>设置</span>
          </button>
        </div>
      </header>
      <main class="newtab-main">
        <div class="hero-symbol" aria-hidden="true">
          <Icon name="leaf" size={29} />
        </div>
        {config.showClock && (
          <div class="clock-face">
            {new Date(now).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
          </div>
        )}
        {config.title && <h1>{config.title}</h1>}
        <form class="search-box" onSubmit={search}>
          <Icon name="search" size={24} />
          <input
            ref={input}
            type="search"
            aria-label="搜索资料"
            placeholder={config.placeholder}
            autoComplete="off"
            maxLength={240}
            value={query}
            onInput={(e) => setQuery(e.target.value)}
          />
          <button disabled={busy} aria-label="开始检索">
            <Icon name="arrow" size={22} />
          </button>
        </form>
        {config.hint && <p class="search-hint">{config.hint}</p>}
        {config.showLinks && (
          <nav class="shortcuts" aria-label="快捷入口">
            {config.shortcuts.map((item) => (
              <a key={item.id} href={item.url}>
                <span class="shortcut-icon">{item.icon || item.name[0]}</span>
                <span>{item.name}</span>
              </a>
            ))}
            <button
              class="shortcut-add"
              onClick={() => openSettings('links')}
              aria-label="管理快捷入口"
            >
              <Icon name="plus" size={20} />
            </button>
          </nav>
        )}
        {config.showTimer && session && (
          <div class="session-pill">
            <span class="session-dot" />
            <span class="pill-goal">{session.goal}</span>
            <Timer session={session} now={now} />
            <button class="text-button" onClick={() => openSettings('task')}>
              管理
            </button>
          </div>
        )}
        <div class="home-alerts">{alerts}</div>
      </main>
      {settings && (
        <Settings
          config={config}
          section={section}
          setSection={setSection}
          onClose={() => {
            setSettings(false);
            input.current?.focus();
          }}
          save={saveConfig}
          act={act}
          state={state}
        />
      )}
    </div>
  );
}

function Settings({ config, section, setSection, onClose, save, act, state }) {
  const dialog = useRef(),
    baseline = useRef(config),
    operation = useRef(false),
    [draft, setDraft] = useState(structuredClone(config)),
    [status, setStatus] = useState(''),
    [error, setError] = useState('');
  const [saving, setSaving] = useState(false),
    [running, setRunning] = useState(false),
    [goal, setGoal] = useState(state.session?.goal || ''),
    [clear, setClear] = useState(false);
  const importFile = useRef(),
    closeRef = useRef();
  const set = (key, value) => {
    if (operation.current) return;
    setDraft((d) => ({ ...d, [key]: value }));
    setStatus('有未保存的修改');
    setError('');
  };
  const dirty = JSON.stringify(draft) !== JSON.stringify(config);
  const close = () => {
    if (operation.current) return;
    if (dirty && !confirm('还有未保存的设置。要放弃这些修改并关闭吗？')) return;
    onClose();
  };
  closeRef.current = close;
  useEffect(() => {
    // Keep local edits, while accepting other windows' changes to untouched
    // fields. Commit only the resulting delta so stale fields cannot overwrite
    // a newer backend setting that has not reached this page yet.
    const previous = baseline.current;
    baseline.current = config;
    setDraft((current) =>
      Object.fromEntries(
        Object.entries(config).map(([key, value]) => [
          key,
          JSON.stringify(current[key]) === JSON.stringify(previous[key])
            ? structuredClone(value)
            : current[key],
        ])
      )
    );
  }, [config]);
  useEffect(() => {
    const el = dialog.current;
    el.showModal();
    return () => {
      if (el.open) el.close();
    };
  }, []);
  // The native dialog provides focus trapping. Read current draft in Escape
  // handler rather than retaining the mount-time closure.
  useEffect(() => {
    const el = dialog.current,
      cancel = (e) => {
        e.preventDefault();
        closeRef.current();
      };
    el.addEventListener('cancel', cancel);
    return () => el.removeEventListener('cancel', cancel);
  }, []);
  async function run(type, payload = {}) {
    if (operation.current) return null;
    operation.current = true;
    setRunning(true);
    setError('');
    try {
      return await act(type, payload, true);
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      operation.current = false;
      setRunning(false);
    }
  }
  async function commit(e) {
    e?.preventDefault();
    if (operation.current) return;
    operation.current = true;
    setSaving(true);
    setError('');
    try {
      const checked = validatePatch(
        Object.fromEntries(
          Object.entries(draft).filter(
            ([key, value]) => JSON.stringify(value) !== JSON.stringify(baseline.current[key])
          )
        )
      );
      const saved = await save(checked);
      setDraft(structuredClone(saved));
      setStatus('已保存');
    } catch (e) {
      setError(e.message);
    } finally {
      operation.current = false;
      setSaving(false);
    }
  }
  async function testAI() {
    setStatus('');
    setError('');
    if (dirty) {
      setError('请先保存 AI 地址和模型，再测试连接');
      return;
    }
    const result = await run('probe');
    if (result)
      setStatus(
        result.available
          ? `连接正常 · 已找到 ${config.aiModel}`
          : `连接正常，但未安装 ${config.aiModel}。已找到：${
              result.models.join('、') || '无可用 Qwen3 8B/14B'
            }`
      );
  }
  function downloadSettings() {
    const blob = new Blob([JSON.stringify({ format: 'FocusTab', version: 1, config }, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob),
      a = document.createElement('a');
    a.href = url;
    a.download = 'FocusTab-settings.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function importSettings(event) {
    const file = event.target.files?.[0];
    if (!file || operation.current) return;
    operation.current = true;
    setRunning(true);
    setError('');
    try {
      if (file.size > 200000) throw new Error('设置文件过大');
      let parsed;
      try {
        parsed = JSON.parse(await file.text());
      } catch {
        throw new Error('设置文件不是有效的 JSON，请重新选择导出的文件');
      }
      if (!parsed || parsed.format !== 'FocusTab' || parsed.version !== 1)
        throw new Error('请选择 FocusTab 导出的设置文件');
      const checked = validatePatch(parsed.config);
      setDraft((current) => ({ ...current, ...checked }));
      setStatus('已载入设置，请检查后保存');
      setError('');
    } catch (e) {
      setError(e.message);
    } finally {
      operation.current = false;
      setRunning(false);
      event.target.value = '';
    }
  }
  const tabs = [
    ['appearance', '界面与文字', '01'],
    ['links', '快捷入口', '02'],
    ['task', '研究任务', '03'],
    ['ai', '内容判断', '04'],
    ['blocking', '拦截规则', '05'],
    ['privacy', '隐私与反馈', '06'],
  ];
  const text = (key, label, help) => (
    <Field label={label} help={help}>
      <input value={draft[key]} maxLength={200} onInput={(e) => set(key, e.target.value)} />
    </Field>
  );
  const numeric = (key, label, min, max, help, disabled = false) => (
    <Field label={label} help={help}>
      <input
        type="number"
        min={min}
        max={max}
        step={key === 'threshold' ? '0.01' : '1'}
        disabled={disabled}
        value={draft[key]}
        onInput={(e) => set(key, e.target.value === '' ? '' : Number(e.target.value))}
      />
    </Field>
  );
  const toggle = (key, label, help) => (
    <Toggle value={draft[key]} label={label} help={help} onChange={(value) => set(key, value)} />
  );
  const select = (key, label, options, help) => (
    <Field label={label} help={help}>
      <select value={draft[key]} onChange={(e) => set(key, e.target.value)}>
        {options.map(([value, name]) => (
          <option key={value} value={value}>
            {name}
          </option>
        ))}
      </select>
    </Field>
  );
  return (
    <dialog
      ref={dialog}
      class="settings-dialog"
      onClick={(e) => {
        if (e.target === dialog.current) close();
      }}
      aria-labelledby="settings-title"
    >
      <div class="settings-shell">
        <aside class="settings-sidebar">
          <Logo brand={config.brand} />
          <p class="sidebar-label">你的专注空间</p>
          <nav aria-label="设置分组">
            {tabs.map(([id, label, num]) => (
              <button
                key={id}
                type="button"
                class={section === id ? 'selected' : ''}
                aria-current={section === id ? 'page' : undefined}
                onClick={() => setSection(id)}
              >
                <span>{num}</span>
                {label}
              </button>
            ))}
          </nav>
          <div class="sidebar-note">
            <Icon name="shield" size={19} />
            <p>
              只做三件事
              <br />
              舒服地开始
              <br />
              理解当前页面
              <br />
              挡住无意的浏览
            </p>
          </div>
        </aside>
        <div class="settings-right">
          <header class="settings-header">
            <div>
              <span class="eyebrow">PREFERENCES</span>
              <h2 id="settings-title">{tabs.find((t) => t[0] === section)?.[1] || '设置'}</h2>
            </div>
            <button
              class="icon-button"
              aria-label="关闭设置"
              disabled={saving || running}
              onClick={close}
            >
              <Icon name="close" />
            </button>
          </header>
          <form class="settings-form" onSubmit={commit}>
            <fieldset
              class="settings-scroll"
              disabled={saving || running}
              aria-busy={saving || running}
              aria-labelledby="settings-title"
            >
              {section === 'appearance' && (
                <>
                  <p class="section-intro">让每一次打开，都从自己的问题开始。</p>
                  <div class="settings-card">
                    {text('title', '首页标题', '留空时隐藏标题。')}
                    {text('placeholder', '搜索框提示')}
                    {text('hint', '搜索框下方文字', '默认留空，不追加平台或计时说明。')}
                    <div class="form-grid">
                      {text('brand', '左上角名称')}
                      {text('tabTitle', '浏览器标签页名称')}
                    </div>
                  </div>
                  <div class="settings-card">
                    {select('theme', '外观', [
                      ['system', '跟随系统'],
                      ['light', '浅色'],
                      ['dark', '深色'],
                    ])}
                    {toggle('showClock', '显示时间')}
                    {toggle('showLinks', '显示快捷入口')}
                    {toggle('showTimer', '显示当前研究计时', '时间到点只提醒，资料页保持开放。')}
                  </div>
                </>
              )}
              {section === 'links' && (
                <>
                  <p class="section-intro">
                    搜索框下方的常用入口。拖动手柄排序，也可使用上下移动按钮。
                  </p>
                  <ShortcutEditor
                    items={draft.shortcuts}
                    onChange={(value) => set('shortcuts', value)}
                  />
                </>
              )}
              {section === 'task' && (
                <>
                  <p class="section-intro">明确这次想查什么，AI 才有判断的依据。</p>
                  <div class="settings-card">
                    <Field label="这次的研究目标">
                      <textarea
                        rows={3}
                        maxLength={200}
                        placeholder="例如：学会用 TrackMate 导出轨迹 CSV"
                        value={goal}
                        onInput={(e) => setGoal(e.target.value)}
                      />
                    </Field>
                    <div class="inline-actions">
                      <Button
                        type="button"
                        small
                        disabled={!goal.trim()}
                        onClick={() => run('start', { goal, minutes: draft.sessionMinutes })}
                      >
                        开始一轮研究
                      </Button>
                      {state.session && (
                        <>
                          <Button type="button" secondary small onClick={() => run('extend')}>
                            续时 {config.extendMinutes} 分钟
                          </Button>
                          <button type="button" class="text-button" onClick={() => run('end')}>
                            结束当前任务
                          </button>
                        </>
                      )}
                    </div>
                    {state.session && <p class="fine">当前目标：{state.session.goal}</p>}
                  </div>
                  <div class="settings-card">
                    <div class="form-grid">
                      {numeric('sessionMinutes', '默认研究时长（分钟）', 5, 120)}
                      {numeric('extendMinutes', '每次续时（分钟）', 5, 60)}
                    </div>
                    {toggle(
                      'newTaskPerSearch',
                      '每次搜索新建研究任务',
                      '关闭后，后续检索沿用尚未结束的目标。计时到期后搜索会新建任务。'
                    )}
                  </div>
                  <div class="info-note">
                    <strong>检索前缀</strong>
                    <p>
                      “B站 TrackMate”使用 Google 站内检索；“!B站 TrackMate”直接进入 B
                      站搜索。也支持知乎、YouTube、PubMed、科研通、谷歌学术和 X。
                    </p>
                  </div>
                </>
              )}
              {section === 'ai' && (
                <>
                  <p class="section-intro">
                    判断工作 /
                    学习与娱乐；有研究任务时，进一步判断与本次目标的相关性。信息不足时保留不确定。
                  </p>
                  <div class="settings-card">
                    {toggle(
                      'aiEnabled',
                      '启用 AI 判断',
                      '只在普通页面位于前台、稳定停留且不处于隐私窗口时调用。'
                    )}
                    {toggle(
                      'autoClassify',
                      '没有研究任务时，自动判断工作/学习与娱乐',
                      '关闭后，仅在研究任务有效时判断。Google 搜索结果不分析，只判断点开后的最终网页；已知私密页面始终排除。'
                    )}
                    <Field label="NAS / Ollama 地址" help="只支持本机或局域网 IPv4 地址。">
                      <input value={draft.aiHost} onInput={(e) => set('aiHost', e.target.value)} />
                    </Field>
                    {select('aiModel', '模型', [
                      ['qwen3:8b', 'Qwen3 8B · 较省资源'],
                      ['qwen3:14b', 'Qwen3 14B · 更大模型'],
                    ])}
                    <div class="preset-buttons">
                      <span>快速配置</span>
                      {[
                        ['conserve', '节约 NAS'],
                        ['balanced', '均衡'],
                        ['careful', '更谨慎'],
                      ].map(([id, name]) => (
                        <button
                          key={id}
                          type="button"
                          onClick={() => {
                            setDraft((d) => ({ ...d, ...PRESETS[id] }));
                            setStatus('已应用预设，请保存');
                          }}
                        >
                          {name}
                        </button>
                      ))}
                    </div>
                    <Button type="button" secondary small onClick={testAI}>
                      测试连接
                    </Button>
                  </div>
                  <div class="settings-card">
                    {select(
                      'contentMode',
                      '发送给 AI 的页面信息',
                      [
                        ['metadata', '仅标题与清洗后的网址'],
                        ['summary', '标题、网址与正文摘录'],
                      ],
                      '摘要由 Mozilla Readability 提取，最多发送下方指定字符数。视频页不下载视频、不读取音频。'
                    )}
                    {numeric('excerptChars', '正文摘录上限（字符）', 300, 4000)}
                    {select('aiAction', '明确娱乐或偏离目标时', [
                      ['remind', '提醒，保留当前页面'],
                      [
                        'block',
                        draft.temporaryPassEnabled === false
                          ? '高置信度时拦截'
                          : '高置信度时拦截，保留短时放行入口',
                      ],
                    ])}
                    {numeric(
                      'threshold',
                      '提醒 / 拦截阈值',
                      0.5,
                      0.99,
                      '模型的自评置信度，不代表实测准确率。'
                    )}
                    <div class="form-grid">
                      {numeric('dwellSeconds', '稳定停留（秒）', 10, 180)}
                      {numeric('intervalSeconds', '请求最小间隔（秒）', 30, 900)}
                      {numeric('requestsPerHour', '每小时最多请求', 1, 60)}
                      {numeric('cacheMinutes', '同一判断上下文的页面缓存（分钟）', 1, 120)}
                    </div>
                    {select(
                      'keepAlive',
                      '模型空闲驻留',
                      [
                        ['30s', '30 秒'],
                        ['1m', '1 分钟'],
                        ['2m', '2 分钟'],
                        ['5m', '5 分钟'],
                      ],
                      '较短驻留有利于 NAS 释放模型资源，但下次请求可能需要重新加载。'
                    )}
                  </div>
                  <div class="settings-card">
                    <Field
                      label="允许判断的网站"
                      help="每行一个域名。包含其子域名，但账户、私信等已知私密路径仍会排除。只添加你愿意发送页面信息的公开内容网站。"
                    >
                      <HostEditor
                        hosts={draft.analysisHosts}
                        onChange={(hosts) => set('analysisHosts', hosts)}
                      />
                    </Field>
                  </div>
                  <p class="fine">
                    AI 连接失败或输出格式无效时，资料页保持开放，网址拦截继续工作。Ollama 若返回
                    403，请在 NAS 仅允许此扩展来源：
                    <code>{state.extensionOrigin || '安装后显示扩展来源'}</code>。
                  </p>
                </>
              )}
              {section === 'blocking' && (
                <>
                  <p class="section-intro">挡住推荐入口，留下搜索、具体资料和文献功能。</p>
                  <div class="settings-card">
                    {toggle(
                      'blockFeeds',
                      '全天拦截热点与推荐入口',
                      '无需 ActivityWatch、本地服务或另装 LeechBlock。'
                    )}
                    {BUILTINS.map((r) => (
                      <Toggle
                        key={r.id}
                        label={r.name}
                        help={r.paths ? r.paths.join(' · ') : r.host}
                        value={!(draft.disabledRules || []).includes(r.id)}
                        onChange={(enabled) =>
                          set(
                            'disabledRules',
                            enabled
                              ? (draft.disabledRules || []).filter((id) => id !== r.id)
                              : [...(draft.disabledRules || []), r.id]
                          )
                        }
                      />
                    ))}
                  </div>
                  <div class="settings-card">
                    {toggle(
                      'temporaryPassEnabled',
                      '允许临时放行',
                      '关闭并保存后，拦截页不再显示放行入口，已有放行也会立即撤销。'
                    )}
                    {numeric(
                      'allowMinutes',
                      '被拦截页面临时放行（分钟）',
                      1,
                      30,
                      '只放行当前标签页的精确网址。到期恢复拦截，其他页面仍受原规则保护。',
                      draft.temporaryPassEnabled === false
                    )}
                    <div class="form-grid">
                      {numeric(
                        'passDailyMinutes',
                        '每日累计放行上限（分钟）',
                        0,
                        180,
                        '0 表示不限。按获批时长扣减，提前关页不退回；所有网站和标签页共享。',
                        draft.temporaryPassEnabled === false
                      )}
                      {numeric(
                        'passCooldownMinutes',
                        '再次放行冷却（分钟）',
                        0,
                        120,
                        '0 表示关闭。当前放行结束后，再等待此时长才能申请下一次；跨网站共享。',
                        draft.temporaryPassEnabled === false
                      )}
                    </div>
                    <h3>自定义网址规则</h3>
                    <RuleEditor
                      items={draft.customRules}
                      onChange={(value) => set('customRules', value)}
                    />
                  </div>
                  <div class="info-note">
                    <strong>科研通的特殊处理</strong>
                    <p>默认只拦截 /tophot 及其下级页面。首页、检索和文献互助等其他功能保持开放。</p>
                  </div>
                </>
              )}
              {section === 'privacy' && (
                <>
                  <p class="section-intro">不统计桌面软件，不读取浏览历史，不截图。</p>
                  <div class="settings-card">
                    <h3>AI 能看到什么</h3>
                    <p>
                      当前判断模式、可选的研究目标、当前页面标题、清洗后的网址；开启正文模式时，还包括有长度上限的正文摘录。只发送至你设置的
                      NAS 地址，不发送整段浏览历史。
                    </p>
                    <p>
                      页面正文可能仍含个人信息。提取器会移除表单和可编辑内容并遮盖邮箱；只对你选择的网站启用，私密站点请勿加入。
                    </p>
                    {numeric('idleSeconds', '无操作多久暂停检测（秒）', 60, 3600)}
                    <p class="fine">
                      当前默认 5 分钟无鼠标键盘操作会暂停
                      AI。阅读长文章时可以调长；这里只决定检测，不记录用时。
                    </p>
                  </div>
                  <div class="settings-card">
                    <h3>纠错与反馈</h3>
                    <p>
                      自动模式可标记“工作或学习”“娱乐消遣”“暂不判断”；研究模式可标记“在查资料”“确实走神”“暂不判断”。纠正仅匹配同一判断模式、同一目标（如有）、同一页面标题与网址。选择“以后也这样判断”才跨研究轮次复用。
                    </p>
                    <p class="fine">
                      这是本地纠正规则，不会训练或修改 NAS 模型。最多保存 200 条，支持撤销和清除。
                    </p>
                    {numeric('retentionDays', '反馈保留（天）', 1, 365)}
                    <div class="inline-actions">
                      <Button
                        type="button"
                        secondary
                        small
                        disabled={!state.feedback?.length}
                        onClick={() => run('undo')}
                      >
                        撤销最近反馈
                      </Button>
                      <button
                        type="button"
                        class="text-button danger"
                        onClick={async () => {
                          if (clear) {
                            const result = await run('clear');
                            if (result) {
                              setClear(false);
                              setStatus('反馈已清除');
                            }
                          } else setClear(true);
                        }}
                      >
                        {clear ? '确认清除所有反馈' : '清除全部反馈'}
                      </button>
                      <small>{state.feedback?.length || 0} 条有效反馈</small>
                    </div>
                  </div>
                  <div class="settings-card">
                    <h3>备份与迁移</h3>
                    <p class="fine">仅导出界面、AI 和拦截设置，不含研究目标、正文和反馈。</p>
                    <div class="inline-actions">
                      <Button type="button" secondary small onClick={downloadSettings}>
                        导出设置
                      </Button>
                      <Button
                        type="button"
                        secondary
                        small
                        onClick={() => importFile.current.click()}
                      >
                        导入设置
                      </Button>
                      <input
                        ref={importFile}
                        type="file"
                        accept="application/json,.json"
                        hidden
                        onChange={importSettings}
                      />
                    </div>
                  </div>
                  <p class="fine">
                    开源基础：Preact、SortableJS、Mozilla Readability、Ollama JS 与 LeechBlock
                    网址匹配代码。
                    <a href="https://github.com/poesein/FocusTab" target="_blank" rel="noreferrer">
                      查看源码与许可证
                    </a>
                  </p>
                </>
              )}
            </fieldset>
            <footer class="settings-footer">
              <div aria-live={error ? 'assertive' : 'polite'} role={error ? 'alert' : 'status'}>
                <span class={error ? 'error-text' : dirty ? 'muted' : 'saved'}>
                  {error || status || '设置保存在当前浏览器'}
                </span>
              </div>
              <Button disabled={saving || running || !dirty} icon={dirty ? undefined : 'check'}>
                {saving ? '正在保存…' : dirty ? '保存设置' : '已保存'}
              </Button>
            </footer>
          </form>
        </div>
      </div>
    </dialog>
  );
}

function ShortcutEditor({ items, onChange }) {
  const list = useRef();
  useEffect(() => {
    const sortable = Sortable.create(list.current, {
      handle: '.drag-handle',
      animation: 140,
      onEnd: (event) => {
        const { oldIndex, newIndex, item, from } = event;
        if (oldIndex === newIndex) return;
        // Restore DOM before Preact reconciles the new ordering.
        from.removeChild(item);
        from.insertBefore(item, from.children[oldIndex] || null);
        const next = [...items],
          [moved] = next.splice(oldIndex, 1);
        next.splice(newIndex, 0, moved);
        onChange(next);
      },
    });
    return () => sortable.destroy();
  }, [items]);
  const update = (i, key, value) =>
    onChange(items.map((item, n) => (n === i ? { ...item, [key]: value } : item)));
  const move = (i, shift) => {
    const next = [...items];
    [next[i], next[i + shift]] = [next[i + shift], next[i]];
    onChange(next);
  };
  return (
    <div class="settings-card">
      <div ref={list} class="shortcut-editor">
        {items.map((item, i) => (
          <div class="shortcut-row" key={item.id}>
            <span class="drag-handle" aria-hidden="true">
              ⠿
            </span>
            <input
              class="icon-input"
              aria-label={`入口 ${i + 1} 图标`}
              value={item.icon}
              maxLength={8}
              onInput={(e) => update(i, 'icon', e.target.value)}
            />
            <div class="shortcut-fields">
              <input
                aria-label={`入口 ${i + 1} 名称`}
                placeholder="名称"
                value={item.name}
                maxLength={30}
                onInput={(e) => update(i, 'name', e.target.value)}
              />
              <input
                aria-label={`入口 ${i + 1} 网址`}
                type="url"
                placeholder="https://"
                value={item.url}
                onInput={(e) => update(i, 'url', e.target.value)}
              />
            </div>
            <div class="row-actions">
              <button
                type="button"
                aria-label={`上移 ${item.name}`}
                disabled={i === 0}
                onClick={() => move(i, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                aria-label={`下移 ${item.name}`}
                disabled={i === items.length - 1}
                onClick={() => move(i, 1)}
              >
                ↓
              </button>
              <button
                type="button"
                class="danger"
                aria-label={`删除 ${item.name}`}
                onClick={() => onChange(items.filter((_, n) => n !== i))}
              >
                ×
              </button>
            </div>
          </div>
        ))}
      </div>
      <Button
        type="button"
        secondary
        small
        icon="plus"
        disabled={items.length >= 20}
        onClick={() =>
          onChange([
            ...items,
            { id: crypto.randomUUID(), name: '新入口', url: 'https://example.com/', icon: '链' },
          ])
        }
      >
        添加快捷入口
      </Button>
    </div>
  );
}
function RuleEditor({ items, onChange }) {
  const update = (i, patch) =>
    onChange(items.map((item, n) => (n === i ? { ...item, ...patch } : item)));
  return (
    <div class="rule-editor">
      {!items.length && <p class="fine">暂无自定义规则。可以只拦一个路径，或选择整个网站。</p>}
      {items.map((item, i) => (
        <div class="custom-rule" key={item.id}>
          <div class="form-grid">
            <Field label="域名">
              <input
                aria-label={`规则 ${i + 1} 域名`}
                placeholder="example.com"
                value={item.host}
                onInput={(e) => update(i, { host: e.target.value.trim().toLowerCase() })}
              />
            </Field>
            <Field label="路径">
              <input
                aria-label={`规则 ${i + 1} 路径`}
                value={item.path}
                disabled={item.allPaths}
                onInput={(e) => update(i, { path: e.target.value })}
              />
            </Field>
          </div>
          <div class="rule-actions">
            <label class="checkbox">
              <input
                type="checkbox"
                checked={item.allPaths}
                onChange={(e) => update(i, { allPaths: e.target.checked })}
              />
              拦截整个网站与子域名
            </label>
            <button
              type="button"
              class="text-button danger"
              onClick={() => onChange(items.filter((_, n) => n !== i))}
            >
              删除
            </button>
          </div>
        </div>
      ))}
      <Button
        type="button"
        secondary
        small
        icon="plus"
        disabled={items.length >= 50}
        onClick={() =>
          onChange([...items, { id: crypto.randomUUID(), host: '', path: '/', allPaths: false }])
        }
      >
        添加网址规则
      </Button>
    </div>
  );
}

render(<App />, $('#app'));

import { useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';

type WindowMode = 'onboarding' | 'advanced';
type FocusSection = 'phone' | 'autostart' | 'bot' | null;
type RemoteState = 'online' | 'partial' | 'offline';
type Locale = 'zh' | 'en';
type LogFile = 'agent.log' | 'relay.log';

type HealthReport = {
  ok: boolean;
  code: string;
  checks: Array<{ id: string; ok: boolean; message: string }>;
  checkedAt: number;
};

type PairingSession = {
  pairingSessionId: string;
  qrPayload: string;
  expiresAt: number;
  startCommand?: string;
  botUsername?: string;
};

type PairingStatus = {
  pairingSessionId: string;
  status: 'pending' | 'confirmed' | 'expired';
  expiresAt: number;
  deviceAccessToken?: string;
};

type RelaySettings = {
  telegramBotToken: string;
  relayBotUsername: string;
};

type ServiceState = {
  installed: boolean;
  running: boolean;
  raw: string;
};

type AppSnapshot = {
  healthOk: boolean;
  botConfigured: boolean;
  usingHostedRelay: boolean;
  relayRunning: boolean;
  relayConnected: boolean;
  paired: boolean;
  threadBound: boolean;
  statusChecks: {
    codexReady: boolean;
    remoteServiceRunning: boolean;
    phonePaired: boolean;
    threadBound: boolean;
  };
  onboardingStep: 1 | 2 | 3 | 4 | 5;
  remoteState: RemoteState;
  locale: Locale;
  selectedThreadId: string | null;
  currentThread: {
    id: string;
    title: string;
    updatedAt: number;
    source: string;
    cwd: string | null;
  } | null;
  botUsername: string | null;
  officialBotUsername: string | null;
  lastError: string | null;
};

type UiDict = {
  appSubtitleOnboarding: string;
  appSubtitleHome: string;
  statePrefix: string;
  stateOnline: string;
  statePartial: string;
  stateOffline: string;
  homeTitle: string;
  homeSubtitle: string;
  sectionCurrent: string;
  sectionSettings: string;
  sectionLogs: string;
  checkCodex: string;
  checkRelay: string;
  checkPhone: string;
  checkThread: string;
  checkOk: string;
  checkBad: string;
  remoteSwitchTitle: string;
  remoteSwitchDesc: string;
  repairPhoneAction: string;
  refreshNow: string;
  currentThreadTitle: string;
  noThreadBound: string;
  threadId: string;
  threadSource: string;
  threadUpdatedAt: string;
  threadUnknownTime: string;
  autoStartTitle: string;
  autoStartDesc: string;
  botConfigTitle: string;
  botConfigDesc: string;
  relayModeTitle: string;
  relayModeHosted: string;
  relayModeSelfHosted: string;
  switchToHosted: string;
  switchToSelfHosted: string;
  hostedNoBotNeeded: string;
  hostedModeHint: string;
  currentBotLabel: string;
  botTokenRequired: string;
  botUsernameOptional: string;
  saveApply: string;
  hide: string;
  show: string;
  logFileLabel: string;
  logLinesLabel: string;
  logRefresh: string;
  copyLog: string;
  openLogDir: string;
  openIssues: string;
  logsEmpty: string;
  copied: string;
  saved: string;
  botGuideTitle: string;
  botGuideClose: string;
  botGuideOpenFather: string;
  botGuideDone: string;
  botGuideSteps: string[];
  language: string;
  langZh: string;
  langEn: string;
  step1Label: string;
  step2Label: string;
  step3Label: string;
  step4Label: string;
  progressTitle: string;
  step1Title: string;
  step1Desc: string;
  step1Run: string;
  step1Rerun: string;
  step1Ok: string;
  step2Title: string;
  step2Desc: string;
  step2HelpTitle: string;
  step2Configured: string;
  step2NotConfigured: string;
  step3Title: string;
  step3Desc: string;
  startPairing: string;
  regenerateQr: string;
  refreshPairingStatus: string;
  openTelegramPairing: string;
  pairingStatus: string;
  expiresAt: string;
  pending: string;
  step4Title: string;
  step4Desc: string;
  step4Refresh: string;
  doneTitle: string;
  doneDesc: string;
  actionRunHealth: string;
  actionSaveBot: string;
  actionSwitchHosted: string;
  actionSwitchSelfHosted: string;
  actionPairing: string;
  actionRepair: string;
  actionToggleRemoteOn: string;
  actionToggleRemoteOff: string;
  actionAutoStartOn: string;
  actionAutoStartOff: string;
  actionSetLocale: string;
  actionLoadLogs: string;
  errNetwork: string;
  errBotNotReady: string;
  unknownBot: string;
};

const UI: Record<Locale, UiDict> = {
  zh: {
    appSubtitleOnboarding: '首次配置向导（约 2-3 分钟）',
    appSubtitleHome: '应用主页',
    statePrefix: '状态',
    stateOnline: '在线',
    statePartial: '部分可用',
    stateOffline: '离线',
    homeTitle: '当前状态',
    homeSubtitle: '一眼查看是否在线、链路是否完整、当前绑定线程。',
    sectionCurrent: '当前状态',
    sectionSettings: '高级设置',
    sectionLogs: '日志与反馈',
    checkCodex: 'Codex 环境',
    checkRelay: '远程服务',
    checkPhone: '手机配对',
    checkThread: '线程绑定',
    checkOk: '正常',
    checkBad: '异常',
    remoteSwitchTitle: '远程开关',
    remoteSwitchDesc: '开启后，手机消息会转发到 Codex；关闭后暂停远程能力。',
    repairPhoneAction: '重新配对',
    refreshNow: '刷新',
    currentThreadTitle: '当前线程',
    noThreadBound: '当前尚未绑定线程，请在 Telegram 发送 /threads 并绑定。',
    threadId: 'ID',
    threadSource: '来源',
    threadUpdatedAt: '更新时间',
    threadUnknownTime: '未知',
    autoStartTitle: '开机自启',
    autoStartDesc: '电脑重启后自动恢复能力。',
    botConfigTitle: '机器人配置',
    botConfigDesc: '仅在你更换 Telegram Bot 时需要修改。',
    relayModeTitle: '连接模式',
    relayModeHosted: '官方托管（推荐）',
    relayModeSelfHosted: '本地自托管',
    switchToHosted: '切换到官方托管',
    switchToSelfHosted: '切换到本地自托管',
    hostedNoBotNeeded: '官方托管模式无需 BotFather 和 Token。',
    hostedModeHint: '如需使用你自己的机器人，可切换到本地自托管。',
    currentBotLabel: '当前机器人',
    botTokenRequired: 'Bot Token（必填）',
    botUsernameOptional: 'Bot 用户名（可选）',
    saveApply: '保存并应用',
    hide: '隐藏',
    show: '显示',
    logFileLabel: '日志文件',
    logLinesLabel: '显示行数',
    logRefresh: '加载日志',
    copyLog: '复制日志',
    openLogDir: '打开日志目录',
    openIssues: '反馈问题（GitHub）',
    logsEmpty: '暂无日志输出。',
    copied: '已复制',
    saved: '已保存',
    botGuideTitle: '如何创建 Telegram 机器人',
    botGuideClose: '关闭',
    botGuideOpenFather: '打开 BotFather',
    botGuideDone: '我知道了',
    botGuideSteps: [
      '打开 Telegram，搜索并进入 @BotFather。',
      '发送 /newbot，按提示创建机器人。',
      '复制返回的 Token（例如 123456:ABC...）。',
      '回到此页面粘贴 Token，点击“保存并应用”。',
    ],
    language: '语言',
    langZh: '中文',
    langEn: 'English',
    step1Label: '1. 环境检测',
    step2Label: '2. 配置机器人',
    step3Label: '3. 手机配对',
    step4Label: '4. 绑定线程',
    progressTitle: '配置进度',
    step1Title: '步骤 1：环境检测',
    step1Desc: '确认本机 Codex 可用。',
    step1Run: '开始检测',
    step1Rerun: '重新检测',
    step1Ok: '✅ 环境可用',
    step2Title: '步骤 2：配置 Telegram 机器人',
    step2Desc: '填写 Bot Token 并保存。',
    step2HelpTitle: '查看机器人配置教学',
    step2Configured: '机器人已配置。',
    step2NotConfigured: '机器人未配置。',
    step3Title: '步骤 3：手机配对',
    step3Desc: '扫码或打开 Telegram 配对链接，完成后刷新状态。',
    startPairing: '开始配对',
    regenerateQr: '重新生成二维码',
    refreshPairingStatus: '刷新配对状态',
    openTelegramPairing: '打开 Telegram 配对',
    pairingStatus: '配对状态',
    expiresAt: '过期时间',
    pending: '等待中',
    step4Title: '步骤 4：绑定线程',
    step4Desc: '在 Telegram 中发送 /threads 并绑定一个线程，然后点“我已完成，刷新”。',
    step4Refresh: '我已完成，刷新',
    doneTitle: '配置完成',
    doneDesc: '已就绪，将自动隐藏到菜单栏。',
    actionRunHealth: '正在检测 Codex 环境...',
    actionSaveBot: '正在保存机器人配置...',
    actionSwitchHosted: '正在切换到官方托管...',
    actionSwitchSelfHosted: '正在切换到本地自托管...',
    actionPairing: '正在创建配对...',
    actionRepair: '正在重建手机配对...',
    actionToggleRemoteOn: '正在开启远程...',
    actionToggleRemoteOff: '正在关闭远程...',
    actionAutoStartOn: '正在启用开机自启...',
    actionAutoStartOff: '正在关闭开机自启...',
    actionSetLocale: '正在切换语言...',
    actionLoadLogs: '正在读取日志...',
    errNetwork: '网络连接暂不可用，请稍后重试。',
    errBotNotReady: 'Telegram 机器人尚未就绪，请先检查 Token。',
    unknownBot: '未识别',
  },
  en: {
    appSubtitleOnboarding: 'First-time setup wizard (about 2-3 min)',
    appSubtitleHome: 'App Home',
    statePrefix: 'Status',
    stateOnline: 'Online',
    statePartial: 'Partially ready',
    stateOffline: 'Offline',
    homeTitle: 'Current status',
    homeSubtitle: 'Quick view of online state, pipeline health, and active thread.',
    sectionCurrent: 'Current Status',
    sectionSettings: 'Advanced Settings',
    sectionLogs: 'Logs & Feedback',
    checkCodex: 'Codex environment',
    checkRelay: 'Remote service',
    checkPhone: 'Phone paired',
    checkThread: 'Thread bound',
    checkOk: 'OK',
    checkBad: 'Issue',
    remoteSwitchTitle: 'Remote switch',
    remoteSwitchDesc: 'When enabled, phone messages are routed to Codex. Disable to pause remote access.',
    repairPhoneAction: 'Repair pairing',
    refreshNow: 'Refresh',
    currentThreadTitle: 'Current thread',
    noThreadBound: 'No thread is bound yet. Use /threads in Telegram and bind one.',
    threadId: 'ID',
    threadSource: 'Source',
    threadUpdatedAt: 'Updated',
    threadUnknownTime: 'Unknown',
    autoStartTitle: 'Auto-start',
    autoStartDesc: 'Restore capability automatically after reboot.',
    botConfigTitle: 'Bot configuration',
    botConfigDesc: 'Only update this when switching Telegram bot account.',
    relayModeTitle: 'Connection mode',
    relayModeHosted: 'Official hosted (recommended)',
    relayModeSelfHosted: 'Local self-hosted',
    switchToHosted: 'Switch to official hosted',
    switchToSelfHosted: 'Switch to local self-hosted',
    hostedNoBotNeeded: 'Official hosted mode does not require BotFather or token input.',
    hostedModeHint: 'Switch to local self-hosted only if you want your own bot token.',
    currentBotLabel: 'Current bot',
    botTokenRequired: 'Bot Token (required)',
    botUsernameOptional: 'Bot username (optional)',
    saveApply: 'Save and apply',
    hide: 'Hide',
    show: 'Show',
    logFileLabel: 'Log file',
    logLinesLabel: 'Lines',
    logRefresh: 'Load logs',
    copyLog: 'Copy logs',
    openLogDir: 'Open logs folder',
    openIssues: 'Report issue (GitHub)',
    logsEmpty: 'No log output yet.',
    copied: 'Copied',
    saved: 'Saved',
    botGuideTitle: 'How to create a Telegram bot',
    botGuideClose: 'Close',
    botGuideOpenFather: 'Open BotFather',
    botGuideDone: 'Got it',
    botGuideSteps: [
      'Open Telegram and search for @BotFather.',
      'Send /newbot and follow the prompts.',
      'Copy the returned token (for example 123456:ABC...).',
      'Paste token here and click "Save and apply".',
    ],
    language: 'Language',
    langZh: '中文',
    langEn: 'English',
    step1Label: '1. Environment check',
    step2Label: '2. Configure bot',
    step3Label: '3. Pair phone',
    step4Label: '4. Bind thread',
    progressTitle: 'Setup progress',
    step1Title: 'Step 1: Environment check',
    step1Desc: 'Confirm Codex is available on this Mac.',
    step1Run: 'Run checks',
    step1Rerun: 'Run again',
    step1Ok: '✅ Environment is ready',
    step2Title: 'Step 2: Configure Telegram bot',
    step2Desc: 'Fill in Bot Token and save.',
    step2HelpTitle: 'Open bot setup guide',
    step2Configured: 'Bot configured.',
    step2NotConfigured: 'Bot not configured.',
    step3Title: 'Step 3: Pair your phone',
    step3Desc: 'Scan QR or open Telegram pairing link, then refresh status.',
    startPairing: 'Start pairing',
    regenerateQr: 'Regenerate QR',
    refreshPairingStatus: 'Refresh pairing status',
    openTelegramPairing: 'Open Telegram pairing',
    pairingStatus: 'Pairing status',
    expiresAt: 'Expires at',
    pending: 'pending',
    step4Title: 'Step 4: Bind a thread',
    step4Desc: 'Send /threads in Telegram, bind one thread, then click refresh.',
    step4Refresh: 'Done, refresh',
    doneTitle: 'Setup completed',
    doneDesc: 'Ready. Window will hide to menu bar.',
    actionRunHealth: 'Checking Codex environment...',
    actionSaveBot: 'Saving bot configuration...',
    actionSwitchHosted: 'Switching to official hosted mode...',
    actionSwitchSelfHosted: 'Switching to local self-hosted mode...',
    actionPairing: 'Creating pairing session...',
    actionRepair: 'Repairing phone pairing...',
    actionToggleRemoteOn: 'Turning remote on...',
    actionToggleRemoteOff: 'Turning remote off...',
    actionAutoStartOn: 'Enabling auto-start...',
    actionAutoStartOff: 'Disabling auto-start...',
    actionSetLocale: 'Switching language...',
    actionLoadLogs: 'Loading logs...',
    errNetwork: 'Network is temporarily unavailable. Please try again later.',
    errBotNotReady: 'Telegram bot is not ready yet. Please check your token.',
    unknownBot: 'Unknown',
  },
};

function getTexts(locale: Locale): UiDict {
  return UI[locale] || UI.zh;
}

function toFriendlyError(error: unknown, locale: Locale): string {
  const text = error instanceof Error ? error.message : String(error);
  const ui = getTexts(locale);
  if (/fetch failed|aborted/i.test(text)) {
    return ui.errNetwork;
  }
  if (/telegram relay bot not ready/i.test(text)) {
    return ui.errBotNotReady;
  }
  return text;
}

function describeRemoteState(state: RemoteState | undefined, locale: Locale): string {
  const ui = getTexts(locale);
  if (state === 'online') {
    return ui.stateOnline;
  }
  if (state === 'partial') {
    return ui.statePartial;
  }
  return ui.stateOffline;
}

function formatTime(epochMs: number, locale: Locale): string {
  if (!epochMs || Number.isNaN(epochMs)) {
    return getTexts(locale).threadUnknownTime;
  }
  const localeTag = locale === 'en' ? 'en-US' : 'zh-CN';
  return new Date(epochMs).toLocaleString(localeTag);
}

function formatExpireTime(epochMs: number, locale: Locale): string {
  if (!epochMs || Number.isNaN(epochMs)) {
    return '-';
  }
  const localeTag = locale === 'en' ? 'en-US' : 'zh-CN';
  return new Date(epochMs).toLocaleString(localeTag);
}

type BusyState = {
  health: boolean;
  saveBot: boolean;
  relayMode: boolean;
  pairing: boolean;
  repairPairing: boolean;
  toggleRemote: boolean;
  autoStart: boolean;
  locale: boolean;
  logs: boolean;
};

const EMPTY_BUSY: BusyState = {
  health: false,
  saveBot: false,
  relayMode: false,
  pairing: false,
  repairPairing: false,
  toggleRemote: false,
  autoStart: false,
  locale: false,
  logs: false,
};

export function App() {
  const [windowMode, setWindowMode] = useState<WindowMode>('onboarding');
  const [focusSection, setFocusSection] = useState<FocusSection>(null);

  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [pairing, setPairing] = useState<PairingSession | null>(null);
  const [pairingStatus, setPairingStatus] = useState<PairingStatus | null>(null);
  const [pairingQrDataUrl, setPairingQrDataUrl] = useState('');

  const [relaySettings, setRelaySettings] = useState<RelaySettings>({
    telegramBotToken: '',
    relayBotUsername: '',
  });
  const [showBotToken, setShowBotToken] = useState(false);
  const [showBotGuide, setShowBotGuide] = useState(false);

  const [agentService, setAgentService] = useState<ServiceState | null>(null);
  const [busy, setBusy] = useState<BusyState>(EMPTY_BUSY);
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [selectedLogFile, setSelectedLogFile] = useState<LogFile>('agent.log');
  const [logLines, setLogLines] = useState(120);
  const [logContent, setLogContent] = useState('');

  const phoneSectionRef = useRef<HTMLDivElement | null>(null);
  const autostartSectionRef = useRef<HTMLDivElement | null>(null);
  const botSectionRef = useRef<HTMLDivElement | null>(null);
  const autoHideTriggeredRef = useRef(false);
  const trackedEventsRef = useRef<Set<string>>(new Set());

  const locale: Locale = snapshot?.locale || 'zh';
  const ui = useMemo(() => getTexts(locale), [locale]);

  const onboardingSteps = useMemo(
    () => [ui.step1Label, ui.step2Label, ui.step3Label, ui.step4Label],
    [ui.step1Label, ui.step2Label, ui.step3Label, ui.step4Label],
  );

  const onboardingStep = snapshot?.onboardingStep || 1;
  const onboardingUiStep = onboardingStep >= 5 ? onboardingSteps.length : Math.min(onboardingStep, onboardingSteps.length);
  const progressPercent = Math.round((onboardingUiStep / onboardingSteps.length) * 100);

  const remoteState = snapshot?.remoteState ?? 'offline';
  const remoteStateText = describeRemoteState(remoteState, locale);
  const remoteStateClass = remoteState === 'online' ? 'ok' : remoteState === 'partial' ? 'warn' : 'danger';
  const remoteEnabled = Boolean(snapshot?.relayRunning);
  const autoStartEnabled = Boolean(agentService?.installed);

  function setBusyFlag(key: keyof BusyState, value: boolean): void {
    setBusy((prev) => ({ ...prev, [key]: value }));
  }

  function setNoticeWithAutoClear(text: string): void {
    setNotice(text);
    if (!text) {
      return;
    }
    setTimeout(() => {
      setNotice((current) => (current === text ? '' : current));
    }, 2500);
  }

  async function refreshSnapshot() {
    const next = await window.desktopApi.getAppSnapshot();
    setSnapshot(next);
    return next as AppSnapshot;
  }

  async function refreshRelaySettings() {
    const settings = await window.desktopApi.getRelaySettings();
    setRelaySettings({
      telegramBotToken: typeof settings?.telegramBotToken === 'string' ? settings.telegramBotToken : '',
      relayBotUsername: typeof settings?.relayBotUsername === 'string' ? settings.relayBotUsername : '',
    });
  }

  async function refreshServices() {
    const agent = await window.desktopApi.serviceControl('status');
    setAgentService(agent);
  }

  async function refreshLogs() {
    setBusyFlag('logs', true);
    try {
      const tail = await window.desktopApi.getLogsTail(selectedLogFile, logLines);
      setLogContent(tail || '');
    } catch (e: unknown) {
      setError(toFriendlyError(e, locale));
    } finally {
      setBusyFlag('logs', false);
    }
  }

  async function initializePage() {
    setBooting(true);
    setError('');
    try {
      const modePayload = await window.desktopApi.getWindowMode();
      if (modePayload?.mode === 'advanced' || modePayload?.mode === 'onboarding') {
        setWindowMode(modePayload.mode);
      }
      setFocusSection(modePayload?.focusSection || null);
      await Promise.all([refreshSnapshot(), refreshRelaySettings(), refreshServices()]);
      const tail = await window.desktopApi.getLogsTail('agent.log', 120);
      setLogContent(tail || '');
      void window.desktopApi.trackAnalyticsEvent('app_opened');
    } catch (e: unknown) {
      setError(toFriendlyError(e, locale));
    } finally {
      setBooting(false);
    }
  }

  function trackEventOnce(name: string, payload?: Record<string, unknown>) {
    if (trackedEventsRef.current.has(name)) {
      return;
    }
    trackedEventsRef.current.add(name);
    void window.desktopApi.trackAnalyticsEvent(name, payload);
  }

  async function runHealth() {
    setBusyFlag('health', true);
    setError('');
    try {
      const report = await window.desktopApi.getHealth();
      setHealth(report);
      await refreshSnapshot();
    } catch (e: unknown) {
      setError(toFriendlyError(e, locale));
    } finally {
      setBusyFlag('health', false);
    }
  }

  async function saveRelaySettings() {
    setBusyFlag('saveBot', true);
    setError('');
    try {
      const next = await window.desktopApi.setRelaySettings({
        telegramBotToken: relaySettings.telegramBotToken,
        relayBotUsername: relaySettings.relayBotUsername,
      });
      setRelaySettings({
        telegramBotToken: typeof next?.telegramBotToken === 'string' ? next.telegramBotToken : '',
        relayBotUsername: typeof next?.relayBotUsername === 'string' ? next.relayBotUsername : '',
      });
      await Promise.all([refreshSnapshot(), refreshServices()]);
      setNoticeWithAutoClear(ui.saved);
    } catch (e: unknown) {
      setError(toFriendlyError(e, locale));
    } finally {
      setBusyFlag('saveBot', false);
    }
  }

  async function startPairing() {
    setBusyFlag('pairing', true);
    setError('');
    try {
      const session = await window.desktopApi.startPairing();
      const qr = await QRCode.toDataURL(session.qrPayload, { width: 240, margin: 1 });
      setPairing(session);
      setPairingQrDataUrl(qr);
      setPairingStatus({
        pairingSessionId: session.pairingSessionId,
        status: 'pending',
        expiresAt: session.expiresAt,
      });
      void window.desktopApi.trackAnalyticsEvent('pairing_qr_shown', {
        bot: session.botUsername || snapshot?.officialBotUsername || '',
      });
      await refreshSnapshot();
    } catch (e: unknown) {
      setError(toFriendlyError(e, locale));
    } finally {
      setBusyFlag('pairing', false);
    }
  }

  async function checkPairingStatus() {
    if (!pairing) {
      return;
    }
    try {
      const status = await window.desktopApi.checkPairingStatus(pairing.pairingSessionId);
      setPairingStatus(status);
      if (status.status === 'confirmed') {
        trackEventOnce('pairing_confirmed');
      }
      await refreshSnapshot();
    } catch (e: unknown) {
      setError(toFriendlyError(e, locale));
    }
  }

  async function restartPairingFlow() {
    setBusyFlag('repairPairing', true);
    setError('');
    try {
      await window.desktopApi.clearPairing();
      setPairing(null);
      setPairingStatus(null);
      setPairingQrDataUrl('');
      await Promise.all([refreshSnapshot(), refreshServices()]);
      setWindowMode('onboarding');
      setFocusSection('phone');
      await window.desktopApi.setWindowMode('onboarding', 'phone');
    } catch (e: unknown) {
      setError(toFriendlyError(e, locale));
    } finally {
      setBusyFlag('repairPairing', false);
    }
  }

  async function setRemoteEnabled(shouldEnable: boolean) {
    setBusyFlag('toggleRemote', true);
    setError('');
    setSnapshot((prev) => (prev ? { ...prev, relayRunning: shouldEnable } : prev));
    try {
      await window.desktopApi.toggleRelay(shouldEnable);
      await refreshSnapshot();
      setTimeout(() => {
        void refreshSnapshot().catch(() => undefined);
      }, 1200);
    } catch (e: unknown) {
      setError(toFriendlyError(e, locale));
    } finally {
      setBusyFlag('toggleRemote', false);
    }
  }

  async function setAutoStartEnabled(shouldEnable: boolean) {
    setBusyFlag('autoStart', true);
    setError('');
    try {
      if (shouldEnable) {
        await window.desktopApi.serviceControl('install');
        await window.desktopApi.serviceControl('start');
      } else {
        await window.desktopApi.serviceControl('uninstall');
      }
      await refreshServices();
    } catch (e: unknown) {
      setError(toFriendlyError(e, locale));
    } finally {
      setBusyFlag('autoStart', false);
    }
  }

  async function setLocale(nextLocale: Locale) {
    if (nextLocale === locale) {
      return;
    }
    setBusyFlag('locale', true);
    setError('');
    try {
      await window.desktopApi.setLocale(nextLocale);
      await refreshSnapshot();
    } catch (e: unknown) {
      setError(toFriendlyError(e, locale));
    } finally {
      setBusyFlag('locale', false);
    }
  }

  async function switchRelayMode(target: 'hosted' | 'self-hosted') {
    setBusyFlag('relayMode', true);
    setError('');
    try {
      if (target === 'hosted') {
        await window.desktopApi.useOfficialRelay();
      } else {
        await window.desktopApi.useSelfHostedRelay();
      }
      await Promise.all([refreshSnapshot(), refreshRelaySettings(), refreshServices()]);
      setNoticeWithAutoClear(ui.saved);
    } catch (e: unknown) {
      setError(toFriendlyError(e, locale));
    } finally {
      setBusyFlag('relayMode', false);
    }
  }

  async function copyLogs() {
    try {
      await navigator.clipboard.writeText(logContent || '');
      setNoticeWithAutoClear(ui.copied);
    } catch {
      setError('Copy failed');
    }
  }

  async function openLogsDir() {
    const errorMessage = await window.desktopApi.openLogsDir();
    if (errorMessage) {
      setError(errorMessage);
    }
  }

  async function openIssues() {
    try {
      await window.desktopApi.openFeedbackIssues();
    } catch (e: unknown) {
      setError(toFriendlyError(e, locale));
    }
  }

  useEffect(() => {
    void initializePage();
    const unsubscribe = window.desktopApi.onWindowModeChanged((payload) => {
      setWindowMode(payload.mode);
      setFocusSection(payload.focusSection || null);
    });
    return () => {
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      void refreshSnapshot().catch(() => undefined);
    }, 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!pairing || pairingStatus?.status !== 'pending') {
      return;
    }
    const timer = setInterval(() => {
      void checkPairingStatus();
    }, 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairing?.pairingSessionId, pairingStatus?.status]);

  useEffect(() => {
    if (!snapshot) {
      return;
    }
    if (snapshot.onboardingStep < 5) {
      trackEventOnce('onboarding_started');
    }
    if (snapshot.threadBound) {
      trackEventOnce('first_thread_bound');
    }
  }, [snapshot]);

  useEffect(() => {
    if (windowMode !== 'advanced') {
      return;
    }
    const targetRef =
      focusSection === 'phone'
        ? phoneSectionRef
        : focusSection === 'autostart'
          ? autostartSectionRef
          : focusSection === 'bot'
            ? botSectionRef
            : null;
    if (targetRef?.current) {
      targetRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [windowMode, focusSection]);

  useEffect(() => {
    if (windowMode !== 'onboarding') {
      autoHideTriggeredRef.current = false;
      return;
    }
    if (onboardingStep < 5) {
      autoHideTriggeredRef.current = false;
      return;
    }
    if (autoHideTriggeredRef.current) {
      return;
    }
    autoHideTriggeredRef.current = true;
    const timer = setTimeout(() => {
      void window.desktopApi.setWindowMode('advanced');
      void window.desktopApi.hideWindow();
    }, 2200);
    return () => clearTimeout(timer);
  }, [windowMode, onboardingStep]);

  useEffect(() => {
    void refreshLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLogFile, logLines]);

  const operationText = useMemo(() => {
    if (busy.health) return ui.actionRunHealth;
    if (busy.saveBot) return ui.actionSaveBot;
    if (busy.relayMode) {
      return snapshot?.usingHostedRelay ? ui.actionSwitchSelfHosted : ui.actionSwitchHosted;
    }
    if (busy.pairing) return ui.actionPairing;
    if (busy.repairPairing) return ui.actionRepair;
    if (busy.toggleRemote) return remoteEnabled ? ui.actionToggleRemoteOn : ui.actionToggleRemoteOff;
    if (busy.autoStart) return autoStartEnabled ? ui.actionAutoStartOn : ui.actionAutoStartOff;
    if (busy.locale) return ui.actionSetLocale;
    if (busy.logs) return ui.actionLoadLogs;
    return '';
  }, [busy, ui, remoteEnabled, autoStartEnabled]);

  function renderOnboardingStepPanel() {
    if (onboardingStep === 1) {
      return (
        <div className="panel-card">
          <h3>{ui.step1Title}</h3>
          <p className="muted">{ui.step1Desc}</p>
          <div className="actions">
            <button onClick={() => void runHealth()} disabled={busy.health}>{health ? ui.step1Rerun : ui.step1Run}</button>
            <button onClick={() => void refreshSnapshot()}>{ui.refreshNow}</button>
          </div>
          {health && (
            <div className="light-box">
              <p>{health.ok ? ui.step1Ok : `❌ ${health.code}`}</p>
              {health.checks.map((item) => (
                <p key={item.id}>{item.ok ? '✅' : '❌'} {item.message}</p>
              ))}
            </div>
          )}
        </div>
      );
    }

    if (onboardingStep === 2) {
      if (snapshot?.usingHostedRelay) {
        return (
          <div className="panel-card">
            <h3>{ui.step2Title}</h3>
            <p className="muted">{ui.hostedNoBotNeeded}</p>
            <p className="muted">{ui.currentBotLabel}: @{snapshot.officialBotUsername || ui.unknownBot}</p>
            <div className="actions">
              <button onClick={() => void refreshSnapshot()}>{ui.refreshNow}</button>
              <button onClick={() => void switchRelayMode('self-hosted')} disabled={busy.relayMode}>{ui.switchToSelfHosted}</button>
            </div>
            <p className="muted">{ui.step2Configured}</p>
          </div>
        );
      }
      return (
        <div className="panel-card">
          <div className="title-row">
            <h3>{ui.step2Title}</h3>
            <button
              type="button"
              className="help-dot"
              title={ui.step2HelpTitle}
              onClick={() => setShowBotGuide(true)}
            >
              ?
            </button>
          </div>
          <p className="muted">{ui.step2Desc}</p>
          <div className="input-row">
            <input
              type={showBotToken ? 'text' : 'password'}
              value={relaySettings.telegramBotToken}
              placeholder={ui.botTokenRequired}
              onChange={(event) => setRelaySettings((prev) => ({ ...prev, telegramBotToken: event.target.value }))}
            />
            <button onClick={() => setShowBotToken((prev) => !prev)}>{showBotToken ? ui.hide : ui.show}</button>
          </div>
          <div className="input-row">
            <input
              value={relaySettings.relayBotUsername}
              placeholder={ui.botUsernameOptional}
              onChange={(event) => setRelaySettings((prev) => ({ ...prev, relayBotUsername: event.target.value }))}
            />
          </div>
          <div className="actions">
            <button onClick={() => void saveRelaySettings()} disabled={busy.saveBot}>{ui.saveApply}</button>
            <button onClick={() => void switchRelayMode('hosted')} disabled={busy.relayMode}>{ui.switchToHosted}</button>
            <button onClick={() => void refreshSnapshot()}>{ui.refreshNow}</button>
          </div>
          <p className="muted">{snapshot?.botConfigured ? ui.step2Configured : ui.step2NotConfigured}</p>
        </div>
      );
    }

    if (onboardingStep === 3) {
      return (
        <div className="panel-card">
          <h3>{ui.step3Title}</h3>
          <p className="muted">{ui.step3Desc}</p>
          <div className="actions">
            <button onClick={() => void startPairing()} disabled={busy.pairing}>{pairing ? ui.regenerateQr : ui.startPairing}</button>
            <button onClick={() => void checkPairingStatus()} disabled={!pairing}>{ui.refreshPairingStatus}</button>
          </div>
          {pairing && (
            <div className="pairing-box">
              {pairingQrDataUrl && <img className="qr" src={pairingQrDataUrl} alt="pairing qr" />}
              <div className="actions">
                <a className="link-button" href={pairing.qrPayload} target="_blank" rel="noreferrer">{ui.openTelegramPairing}</a>
              </div>
              <p className="muted">{ui.pairingStatus}: {pairingStatus?.status || ui.pending}</p>
              <p className="muted">{ui.expiresAt}: {formatExpireTime(pairing.expiresAt, locale)}</p>
            </div>
          )}
        </div>
      );
    }

    if (onboardingStep === 4) {
      return (
        <div className="panel-card">
          <h3>{ui.step4Title}</h3>
          <p className="muted">{ui.step4Desc}</p>
          <div className="actions">
            <button onClick={() => void refreshSnapshot()}>{ui.step4Refresh}</button>
          </div>
        </div>
      );
    }

    return (
      <div className="panel-card">
        <h3>{ui.doneTitle}</h3>
        <p className="muted">{ui.doneDesc}</p>
      </div>
    );
  }

  const checks = snapshot?.statusChecks || {
    codexReady: false,
    remoteServiceRunning: false,
    phonePaired: false,
    threadBound: false,
  };

  return (
    <div className="shell">
      <header className="header">
        <div>
          <h1>Codex Bridge Desktop</h1>
          <p>{windowMode === 'onboarding' ? ui.appSubtitleOnboarding : ui.appSubtitleHome}</p>
        </div>
        <div className="header-right">
          <div className="locale-switch" role="group" aria-label={ui.language}>
            <button type="button" className={locale === 'zh' ? 'active' : ''} onClick={() => void setLocale('zh')}>
              {ui.langZh}
            </button>
            <button type="button" className={locale === 'en' ? 'active' : ''} onClick={() => void setLocale('en')}>
              {ui.langEn}
            </button>
          </div>
          <div className={`pill ${remoteStateClass}`}>{ui.statePrefix}: {remoteStateText}</div>
        </div>
      </header>

      {!!error && <div className="banner error">{error}</div>}
      {!!notice && <div className="banner success">{notice}</div>}
      {!!operationText && <div className="banner info">{operationText}</div>}
      {booting && <div className="banner info">Loading...</div>}

      {windowMode === 'onboarding' ? (
        <main className="onboarding-layout">
          <section className="card steps-card">
            <h2>{ui.progressTitle}</h2>
            <div className="progress-track">
              <div className="progress-value" style={{ width: `${progressPercent}%` }} />
            </div>
            <ol className="step-list">
              {onboardingSteps.map((label, index) => {
                const stepNo = index + 1;
                const state = onboardingUiStep > stepNo ? 'done' : onboardingUiStep === stepNo ? 'current' : 'todo';
                return (
                  <li key={label} className={state}>
                    <span>{label}</span>
                  </li>
                );
              })}
            </ol>
          </section>

          <section className="card action-card">{renderOnboardingStepPanel()}</section>
        </main>
      ) : (
        <main className="home-layout">
          <section className="card status-card" ref={phoneSectionRef}>
            <div className="card-head">
              <h2>{ui.sectionCurrent}</h2>
              <button onClick={() => void refreshSnapshot()}>{ui.refreshNow}</button>
            </div>
            <p className="muted">{ui.homeSubtitle}</p>

            <div className="status-hero">
              <div>
                <p className="hero-label">{ui.homeTitle}</p>
                <p className={`hero-state ${remoteStateClass}`}>{remoteStateText}</p>
              </div>
              <div className="hero-actions">
                <label className="switch-toggle" aria-label={ui.remoteSwitchTitle}>
                  <input
                    type="checkbox"
                    checked={remoteEnabled}
                    onChange={(event) => void setRemoteEnabled(event.target.checked)}
                    disabled={busy.toggleRemote}
                  />
                  <span className="switch-slider" />
                </label>
                <button onClick={() => void restartPairingFlow()} disabled={busy.repairPairing}>{ui.repairPhoneAction}</button>
              </div>
            </div>

            <div className="check-grid">
              <div className={`check-item ${checks.codexReady ? 'ok' : 'bad'}`}>
                <span>{ui.checkCodex}</span>
                <strong>{checks.codexReady ? ui.checkOk : ui.checkBad}</strong>
              </div>
              <div className={`check-item ${checks.remoteServiceRunning ? 'ok' : 'bad'}`}>
                <span>{ui.checkRelay}</span>
                <strong>{checks.remoteServiceRunning ? ui.checkOk : ui.checkBad}</strong>
              </div>
              <div className={`check-item ${checks.phonePaired ? 'ok' : 'bad'}`}>
                <span>{ui.checkPhone}</span>
                <strong>{checks.phonePaired ? ui.checkOk : ui.checkBad}</strong>
              </div>
              <div className={`check-item ${checks.threadBound ? 'ok' : 'bad'}`}>
                <span>{ui.checkThread}</span>
                <strong>{checks.threadBound ? ui.checkOk : ui.checkBad}</strong>
              </div>
            </div>

            <div className="thread-box">
              <h3>{ui.currentThreadTitle}</h3>
              {snapshot?.currentThread ? (
                <>
                  <p className="thread-title">{snapshot.currentThread.title}</p>
                  <p className="muted"><strong>{ui.threadId}:</strong> <code>{snapshot.currentThread.id}</code></p>
                  <p className="muted"><strong>{ui.threadSource}:</strong> {snapshot.currentThread.source}</p>
                  <p className="muted"><strong>{ui.threadUpdatedAt}:</strong> {formatTime(snapshot.currentThread.updatedAt, locale)}</p>
                </>
              ) : (
                <p className="muted">{ui.noThreadBound}</p>
              )}
            </div>
          </section>

          <section className="card settings-card">
            <div className="card-head">
              <h2>{ui.sectionSettings}</h2>
            </div>

            <div className="settings-group" ref={autostartSectionRef}>
              <h3>{ui.autoStartTitle}</h3>
              <p className="muted">{ui.autoStartDesc}</p>
              <label className="switch-toggle" aria-label={ui.autoStartTitle}>
                <input
                  type="checkbox"
                  checked={autoStartEnabled}
                  onChange={(event) => void setAutoStartEnabled(event.target.checked)}
                  disabled={busy.autoStart}
                />
                <span className="switch-slider" />
              </label>
            </div>

            <div className="settings-group" ref={botSectionRef}>
              <div className="title-row">
                <h3>{ui.botConfigTitle}</h3>
                {!snapshot?.usingHostedRelay && (
                  <button type="button" className="help-dot" title={ui.step2HelpTitle} onClick={() => setShowBotGuide(true)}>?</button>
                )}
              </div>
              <p className="muted">{ui.botConfigDesc}</p>
              <p className="muted"><strong>{ui.relayModeTitle}:</strong> {snapshot?.usingHostedRelay ? ui.relayModeHosted : ui.relayModeSelfHosted}</p>
              <p className="muted">{ui.currentBotLabel}: {snapshot?.botUsername ? `@${snapshot.botUsername}` : ui.unknownBot}</p>
              {snapshot?.usingHostedRelay ? (
                <div className="actions compact">
                  <button onClick={() => void switchRelayMode('self-hosted')} disabled={busy.relayMode}>{ui.switchToSelfHosted}</button>
                  <p className="muted">{ui.hostedModeHint}</p>
                </div>
              ) : (
                <>
                  <div className="input-row">
                    <input
                      type={showBotToken ? 'text' : 'password'}
                      value={relaySettings.telegramBotToken}
                      placeholder={ui.botTokenRequired}
                      onChange={(event) => setRelaySettings((prev) => ({ ...prev, telegramBotToken: event.target.value }))}
                    />
                    <button onClick={() => setShowBotToken((prev) => !prev)}>{showBotToken ? ui.hide : ui.show}</button>
                  </div>
                  <div className="input-row">
                    <input
                      value={relaySettings.relayBotUsername}
                      placeholder={ui.botUsernameOptional}
                      onChange={(event) => setRelaySettings((prev) => ({ ...prev, relayBotUsername: event.target.value }))}
                    />
                  </div>
                  <div className="actions compact">
                    <button onClick={() => void saveRelaySettings()} disabled={busy.saveBot}>{ui.saveApply}</button>
                    <button onClick={() => void switchRelayMode('hosted')} disabled={busy.relayMode}>{ui.switchToHosted}</button>
                  </div>
                </>
              )}
            </div>
          </section>

          <section className="card logs-card">
            <div className="card-head">
              <h2>{ui.sectionLogs}</h2>
            </div>

            <div className="log-controls">
              <label>
                <span>{ui.logFileLabel}</span>
                <select value={selectedLogFile} onChange={(e) => setSelectedLogFile(e.target.value as LogFile)}>
                  <option value="agent.log">agent.log</option>
                  <option value="relay.log">relay.log</option>
                </select>
              </label>
              <label>
                <span>{ui.logLinesLabel}</span>
                <select value={logLines} onChange={(e) => setLogLines(Number(e.target.value))}>
                  <option value={80}>80</option>
                  <option value={120}>120</option>
                  <option value={200}>200</option>
                  <option value={400}>400</option>
                </select>
              </label>
            </div>

            <div className="actions">
              <button onClick={() => void refreshLogs()} disabled={busy.logs}>{ui.logRefresh}</button>
              <button onClick={() => void copyLogs()}>{ui.copyLog}</button>
              <button onClick={() => void openLogsDir()}>{ui.openLogDir}</button>
              <button onClick={() => void openIssues()}>{ui.openIssues}</button>
            </div>

            <pre className="log-view">{logContent || ui.logsEmpty}</pre>
          </section>
        </main>
      )}

      {showBotGuide && (
        <div className="modal-backdrop" role="presentation" onClick={() => setShowBotGuide(false)}>
          <div className="modal-card" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h3>{ui.botGuideTitle}</h3>
              <button type="button" onClick={() => setShowBotGuide(false)}>{ui.botGuideClose}</button>
            </div>
            <ol>
              {ui.botGuideSteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <div className="actions">
              <a className="link-button" href="https://t.me/BotFather" target="_blank" rel="noreferrer">{ui.botGuideOpenFather}</a>
              <button type="button" onClick={() => setShowBotGuide(false)}>{ui.botGuideDone}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

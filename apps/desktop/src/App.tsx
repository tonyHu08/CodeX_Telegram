import { useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';

type WindowMode = 'onboarding' | 'advanced';
type FocusSection = 'phone' | 'autostart' | 'bot' | null;
type RemoteState = 'online' | 'partial' | 'offline';
type Locale = 'zh' | 'en';

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
  relayRunning: boolean;
  relayConnected: boolean;
  paired: boolean;
  threadBound: boolean;
  onboardingStep: 1 | 2 | 3 | 4 | 5;
  remoteState: RemoteState;
  locale: Locale;
  selectedThreadId: string | null;
  botUsername: string | null;
  lastError: string | null;
};

type UiDict = {
  appSubtitleOnboarding: string;
  appSubtitleAdvanced: string;
  statePrefix: string;
  stateOnline: string;
  statePartial: string;
  stateOffline: string;
  statusNotChecked: string;
  statusInstalledRunning: string;
  statusInstalledStopped: string;
  statusDisabled: string;
  loadingInit: string;
  loadingHealth: string;
  loadingSaveBot: string;
  loadingPairing: string;
  loadingRepairPairing: string;
  loadingEnableRemote: string;
  loadingDisableRemote: string;
  loadingEnableAutostart: string;
  loadingDisableAutostart: string;
  loadingDoneAutoHide: string;
  errNetwork: string;
  errBotNotReady: string;
  progressTitle: string;
  step1Label: string;
  step2Label: string;
  step3Label: string;
  step1Title: string;
  step1Desc: string;
  step1Run: string;
  step1Rerun: string;
  refreshStatus: string;
  step1Ok: string;
  step2Title: string;
  step2HelpTitle: string;
  step2Desc: string;
  botTokenRequired: string;
  botUsernameOptional: string;
  hide: string;
  show: string;
  save: string;
  currentBotConfigured: string;
  currentBotNotConfigured: string;
  step3Title: string;
  step3Desc: string;
  startPairing: string;
  regenerateQr: string;
  refreshPairingStatus: string;
  openTelegramPairing: string;
  pairingStatus: string;
  expiresAt: string;
  pending: string;
  doneTitle: string;
  doneDesc: string;
  remoteStatusTitle: string;
  remoteSwitchTitle: string;
  remoteSwitchDesc: string;
  remoteReady: string;
  remotePartialHint: string;
  remoteOfflineHint: string;
  repairPhoneHint: string;
  repairPhoneAction: string;
  autostartTitle: string;
  autostartSwitchTitle: string;
  autostartSwitchDesc: string;
  refresh: string;
  botConfigTitle: string;
  botConfigDesc: string;
  currentBot: string;
  unknownBot: string;
  changeBotHint: string;
  changeBotAction: string;
  saveApply: string;
  cancel: string;
  botGuideTitle: string;
  botGuideClose: string;
  botGuideOpenFather: string;
  botGuideDone: string;
  botGuideSteps: string[];
  language: string;
  langZh: string;
  langEn: string;
};

const UI: Record<Locale, UiDict> = {
  zh: {
    appSubtitleOnboarding: '首次配置向导（约 2-3 分钟）',
    appSubtitleAdvanced: '高级配置',
    statePrefix: '状态',
    stateOnline: '在线',
    statePartial: '部分可用',
    stateOffline: '离线',
    statusNotChecked: '未检测',
    statusInstalledRunning: '已启用并运行',
    statusInstalledStopped: '已安装，未运行',
    statusDisabled: '未启用',
    loadingInit: '加载中...',
    loadingHealth: '正在检测 Codex 环境...',
    loadingSaveBot: '正在保存机器人配置...',
    loadingPairing: '正在创建手机配对...',
    loadingRepairPairing: '正在准备重新配对...',
    loadingEnableRemote: '正在恢复远程能力...',
    loadingDisableRemote: '正在暂停远程能力...',
    loadingEnableAutostart: '正在启用开机自启...',
    loadingDisableAutostart: '正在关闭开机自启...',
    loadingDoneAutoHide: '✅ 配置已就绪，将切换到菜单栏使用...',
    errNetwork: '网络连接暂不可用，请稍后重试。',
    errBotNotReady: 'Telegram 机器人尚未就绪，请先确认 Token 配置正确。',
    progressTitle: '配置进度',
    step1Label: '步骤 1：环境检测',
    step2Label: '步骤 2：配置机器人',
    step3Label: '步骤 3：手机配对',
    step1Title: '步骤 1：环境检测',
    step1Desc: '点击检测，确认本机 Codex 环境可用。',
    step1Run: '开始检测',
    step1Rerun: '重新检测',
    refreshStatus: '刷新状态',
    step1Ok: '✅ 环境可用',
    step2Title: '步骤 2：配置 Telegram 机器人',
    step2HelpTitle: '查看机器人配置教学',
    step2Desc: '填入 Bot Token 并保存，系统会自动进入下一步。',
    botTokenRequired: 'Bot Token（必填）',
    botUsernameOptional: 'Bot 用户名（可选）',
    hide: '隐藏',
    show: '显示',
    save: '保存',
    currentBotConfigured: '当前：机器人已配置。',
    currentBotNotConfigured: '当前：机器人未配置。',
    step3Title: '步骤 3：手机配对',
    step3Desc: '扫码配对后，点击“刷新配对状态”；确认成功后会自动完成配置。',
    startPairing: '开始配对',
    regenerateQr: '重新生成二维码',
    refreshPairingStatus: '刷新配对状态',
    openTelegramPairing: '打开 Telegram 配对',
    pairingStatus: '配对状态',
    expiresAt: '过期时间',
    pending: 'pending',
    doneTitle: '配置完成',
    doneDesc: '已就绪，正在切换到菜单栏模式…',
    remoteStatusTitle: '远程状态',
    remoteSwitchTitle: '远程开关',
    remoteSwitchDesc: '开启后手机可发消息远程操作，关闭后会暂停远程能力。',
    remoteReady: '手机端可以直接发送消息远程操作 Codex。',
    remotePartialHint: '基础配置已完成一部分，建议先点击“重新配对”后再试。',
    remoteOfflineHint: '当前不可用，请先完成配置并恢复远程能力。',
    repairPhoneHint: '“重新配对手机”只会重建手机绑定关系，不会更换机器人。',
    repairPhoneAction: '重新配对手机',
    autostartTitle: '开机自启（Agent）',
    autostartSwitchTitle: '开机自启',
    autostartSwitchDesc: '开启后电脑重启会自动恢复远程能力。',
    refresh: '刷新',
    botConfigTitle: '机器人配置（高级）',
    botConfigDesc: '仅在你要更换 Telegram 机器人账号时才需要修改。',
    currentBot: '当前机器人',
    unknownBot: '未识别',
    changeBotHint: '“更换机器人”会替换 Token；通常不需要频繁操作。',
    changeBotAction: '更换机器人',
    saveApply: '保存并应用',
    cancel: '取消',
    botGuideTitle: '如何创建 Telegram 机器人',
    botGuideClose: '关闭',
    botGuideOpenFather: '打开 BotFather',
    botGuideDone: '我知道了',
    botGuideSteps: [
      '打开 Telegram 搜索并进入 @BotFather。',
      '发送 /newbot，按提示创建机器人。',
      '复制返回的 Token（如 123456:ABC...）。',
      '回到本页粘贴 Token，点击“保存”。',
    ],
    language: '语言',
    langZh: '中文',
    langEn: 'English',
  },
  en: {
    appSubtitleOnboarding: 'First-time setup wizard (about 2-3 min)',
    appSubtitleAdvanced: 'Advanced settings',
    statePrefix: 'Status',
    stateOnline: 'Online',
    statePartial: 'Partially ready',
    stateOffline: 'Offline',
    statusNotChecked: 'Not checked',
    statusInstalledRunning: 'Installed and running',
    statusInstalledStopped: 'Installed, not running',
    statusDisabled: 'Disabled',
    loadingInit: 'Loading...',
    loadingHealth: 'Checking Codex environment...',
    loadingSaveBot: 'Saving bot configuration...',
    loadingPairing: 'Creating mobile pairing...',
    loadingRepairPairing: 'Preparing re-pairing...',
    loadingEnableRemote: 'Resuming remote access...',
    loadingDisableRemote: 'Pausing remote access...',
    loadingEnableAutostart: 'Enabling auto-start...',
    loadingDisableAutostart: 'Disabling auto-start...',
    loadingDoneAutoHide: '✅ Setup complete, switching to menu bar mode...',
    errNetwork: 'Network is temporarily unavailable. Please try again later.',
    errBotNotReady: 'Telegram bot is not ready yet. Please check your token.',
    progressTitle: 'Setup progress',
    step1Label: 'Step 1: Environment check',
    step2Label: 'Step 2: Configure bot',
    step3Label: 'Step 3: Phone pairing',
    step1Title: 'Step 1: Environment check',
    step1Desc: 'Run checks to confirm Codex is available on this Mac.',
    step1Run: 'Run checks',
    step1Rerun: 'Run again',
    refreshStatus: 'Refresh status',
    step1Ok: '✅ Environment is ready',
    step2Title: 'Step 2: Configure Telegram bot',
    step2HelpTitle: 'Open bot setup guide',
    step2Desc: 'Paste Bot Token and save. The wizard will move to the next step automatically.',
    botTokenRequired: 'Bot Token (required)',
    botUsernameOptional: 'Bot username (optional)',
    hide: 'Hide',
    show: 'Show',
    save: 'Save',
    currentBotConfigured: 'Current: bot configured.',
    currentBotNotConfigured: 'Current: bot not configured.',
    step3Title: 'Step 3: Phone pairing',
    step3Desc: 'Scan QR, then click "Refresh pairing status". The setup completes automatically after confirmation.',
    startPairing: 'Start pairing',
    regenerateQr: 'Regenerate QR',
    refreshPairingStatus: 'Refresh pairing status',
    openTelegramPairing: 'Open Telegram pairing',
    pairingStatus: 'Pairing status',
    expiresAt: 'Expires at',
    pending: 'pending',
    doneTitle: 'Setup completed',
    doneDesc: 'Ready now. Switching to menu bar mode…',
    remoteStatusTitle: 'Remote status',
    remoteSwitchTitle: 'Remote switch',
    remoteSwitchDesc: 'When enabled, you can control Codex from your phone. Disable it to pause remote access.',
    remoteReady: 'Your phone can now send messages to control Codex remotely.',
    remotePartialHint: 'Setup is partially complete. Try "Repair phone pairing".',
    remoteOfflineHint: 'Remote is unavailable. Complete setup and turn remote back on.',
    repairPhoneHint: '"Repair phone pairing" only rebuilds phone binding and does not change bot account.',
    repairPhoneAction: 'Repair phone pairing',
    autostartTitle: 'Auto-start (Agent)',
    autostartSwitchTitle: 'Auto-start',
    autostartSwitchDesc: 'When enabled, remote access is restored automatically after reboot.',
    refresh: 'Refresh',
    botConfigTitle: 'Bot settings (advanced)',
    botConfigDesc: 'Only update this when you want to switch to another Telegram bot account.',
    currentBot: 'Current bot',
    unknownBot: 'Unknown',
    changeBotHint: '"Change bot" replaces the token. This is usually infrequent.',
    changeBotAction: 'Change bot',
    saveApply: 'Save and apply',
    cancel: 'Cancel',
    botGuideTitle: 'How to create a Telegram bot',
    botGuideClose: 'Close',
    botGuideOpenFather: 'Open BotFather',
    botGuideDone: 'Got it',
    botGuideSteps: [
      'Open Telegram and search for @BotFather.',
      'Send /newbot and follow instructions.',
      'Copy the returned token (for example: 123456:ABC...).',
      'Come back here, paste token, and click Save.',
    ],
    language: 'Language',
    langZh: '中文',
    langEn: 'English',
  },
};

function getTexts(locale: Locale): UiDict {
  return UI[locale] || UI.zh;
}

function toFriendlyError(error: unknown, locale: Locale): string {
  const text = error instanceof Error ? error.message : String(error);
  const ui = getTexts(locale);
  if (/fetch failed/i.test(text)) {
    return ui.errNetwork;
  }
  if (/telegram relay bot not ready/i.test(text)) {
    return ui.errBotNotReady;
  }
  return text;
}

function describeAgentService(state: ServiceState | null, locale: Locale): string {
  const ui = getTexts(locale);
  if (!state) {
    return ui.statusNotChecked;
  }
  if (state.running) {
    return ui.statusInstalledRunning;
  }
  if (state.installed) {
    return ui.statusInstalledStopped;
  }
  if (/Could not find service/i.test(state.raw || '')) {
    return ui.statusDisabled;
  }
  return ui.statusDisabled;
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

function formatExpireTime(epochMs: number, locale: Locale): string {
  if (!epochMs || Number.isNaN(epochMs)) {
    return '-';
  }
  const localeTag = locale === 'en' ? 'en-US' : 'zh-CN';
  return new Date(epochMs).toLocaleString(localeTag);
}

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
  const [showBotConfigEditor, setShowBotConfigEditor] = useState(false);

  const [agentService, setAgentService] = useState<ServiceState | null>(null);

  const [loading, setLoading] = useState('');
  const [error, setError] = useState('');

  const phoneSectionRef = useRef<HTMLDivElement | null>(null);
  const autostartSectionRef = useRef<HTMLDivElement | null>(null);
  const botSectionRef = useRef<HTMLDivElement | null>(null);
  const autoHideTriggeredRef = useRef(false);

  const locale: Locale = snapshot?.locale || 'zh';
  const ui = useMemo(() => getTexts(locale), [locale]);

  const stepLabels = useMemo(() => [ui.step1Label, ui.step2Label, ui.step3Label], [ui]);
  const onboardingStep = snapshot?.onboardingStep || 1;
  const onboardingUiStep = onboardingStep >= 5 ? stepLabels.length : Math.min(onboardingStep, stepLabels.length);
  const progressPercent = Math.round((onboardingUiStep / stepLabels.length) * 100);
  const remoteState = snapshot?.remoteState ?? 'offline';
  const remoteStateText = describeRemoteState(remoteState, locale);
  const remoteStateClass = remoteState === 'online' ? 'ok' : remoteState === 'partial' ? 'warn' : 'danger';
  const remoteEnabled = Boolean(snapshot?.relayRunning);
  const autoStartEnabled = Boolean(agentService?.installed);

  const agentServiceText = useMemo(() => describeAgentService(agentService, locale), [agentService, locale]);

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

  async function initializePage() {
    setLoading(ui.loadingInit);
    setError('');
    try {
      const modePayload = await window.desktopApi.getWindowMode();
      if (modePayload?.mode === 'advanced' || modePayload?.mode === 'onboarding') {
        setWindowMode(modePayload.mode);
      }
      setFocusSection(modePayload?.focusSection || null);

      await Promise.all([
        refreshSnapshot(),
        refreshRelaySettings(),
        refreshServices(),
      ]);
    } catch (e: unknown) {
      setError(toFriendlyError(e, locale));
    } finally {
      setLoading('');
    }
  }

  async function runHealth() {
    setLoading(ui.loadingHealth);
    setError('');
    try {
      const report = await window.desktopApi.getHealth();
      setHealth(report);
      await refreshSnapshot();
    } catch (e: unknown) {
      setError(toFriendlyError(e, locale));
    } finally {
      setLoading('');
    }
  }

  async function saveRelaySettings() {
    setLoading(ui.loadingSaveBot);
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
      const [, updatedSnapshot] = await Promise.all([refreshServices(), refreshSnapshot()]);
      if (windowMode === 'advanced' && updatedSnapshot?.botConfigured) {
        setShowBotConfigEditor(false);
      }
    } catch (e: unknown) {
      setError(toFriendlyError(e, locale));
    } finally {
      setLoading('');
    }
  }

  async function startPairing() {
    setLoading(ui.loadingPairing);
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
      await refreshSnapshot();
    } catch (e: unknown) {
      setError(toFriendlyError(e, locale));
    } finally {
      setLoading('');
    }
  }

  async function checkPairingStatus() {
    if (!pairing) {
      return;
    }
    try {
      const status = await window.desktopApi.checkPairingStatus(pairing.pairingSessionId);
      setPairingStatus(status);
      await refreshSnapshot();
    } catch (e: unknown) {
      setError(toFriendlyError(e, locale));
    }
  }

  async function restartPairingFlow() {
    setLoading(ui.loadingRepairPairing);
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
      setLoading('');
    }
  }

  async function setRemoteEnabled(shouldEnable: boolean) {
    setLoading(shouldEnable ? ui.loadingEnableRemote : ui.loadingDisableRemote);
    setError('');
    try {
      await window.desktopApi.toggleRelay(shouldEnable);
      await refreshAll();
    } catch (e: unknown) {
      setError(toFriendlyError(e, locale));
    } finally {
      setLoading('');
    }
  }

  async function enableAutoStart() {
    setLoading(ui.loadingEnableAutostart);
    setError('');
    try {
      await window.desktopApi.serviceControl('install');
      await window.desktopApi.serviceControl('start');
      await refreshServices();
    } catch (e: unknown) {
      setError(toFriendlyError(e, locale));
    } finally {
      setLoading('');
    }
  }

  async function disableAutoStart() {
    setLoading(ui.loadingDisableAutostart);
    setError('');
    try {
      await window.desktopApi.serviceControl('uninstall');
      await refreshServices();
    } catch (e: unknown) {
      setError(toFriendlyError(e, locale));
    } finally {
      setLoading('');
    }
  }

  async function setAutoStartEnabled(shouldEnable: boolean) {
    if (shouldEnable) {
      await enableAutoStart();
      return;
    }
    await disableAutoStart();
  }

  async function setLocale(nextLocale: Locale) {
    if (nextLocale === locale) {
      return;
    }
    setError('');
    try {
      await window.desktopApi.setLocale(nextLocale);
      await refreshAll();
    } catch (e: unknown) {
      setError(toFriendlyError(e, locale));
    }
  }

  async function refreshAll() {
    setError('');
    try {
      await Promise.all([refreshSnapshot(), refreshServices(), refreshRelaySettings()]);
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
    }, 4000);
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
    setLoading(ui.loadingDoneAutoHide);
    const timer = setTimeout(() => {
      void window.desktopApi.setWindowMode('advanced');
      void window.desktopApi.hideWindow();
      setLoading('');
    }, 2500);
    return () => clearTimeout(timer);
  }, [windowMode, onboardingStep, ui.loadingDoneAutoHide]);

  const currentStepPanel = () => {
    if (onboardingStep === 1) {
      return (
        <div className="panel-card">
          <h3>{ui.step1Title}</h3>
          <p className="muted">{ui.step1Desc}</p>
          <div className="actions">
            <button onClick={() => void runHealth()}>{health ? ui.step1Rerun : ui.step1Run}</button>
            <button onClick={() => void refreshSnapshot()}>{ui.refreshStatus}</button>
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
            <button onClick={() => void saveRelaySettings()}>{ui.save}</button>
            <button onClick={() => void refreshAll()}>{ui.refreshStatus}</button>
          </div>
          <p className="muted">{snapshot?.botConfigured ? ui.currentBotConfigured : ui.currentBotNotConfigured}</p>
        </div>
      );
    }

    if (onboardingStep === 3) {
      return (
        <div className="panel-card">
          <h3>{ui.step3Title}</h3>
          <p className="muted">{ui.step3Desc}</p>
          <div className="actions">
            <button onClick={() => void startPairing()}>{pairing ? ui.regenerateQr : ui.startPairing}</button>
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

    return <div className="panel-card"><h3>{ui.doneTitle}</h3><p className="muted">{ui.doneDesc}</p></div>;
  };

  return (
    <div className="shell">
      <header className="header">
        <div>
          <h1>Codex Bridge Desktop</h1>
          <p>{windowMode === 'onboarding' ? ui.appSubtitleOnboarding : ui.appSubtitleAdvanced}</p>
        </div>
        <div className="header-right">
          <div className="locale-switch" role="group" aria-label={ui.language}>
            <button
              type="button"
              className={locale === 'zh' ? 'active' : ''}
              onClick={() => void setLocale('zh')}
            >
              {ui.langZh}
            </button>
            <button
              type="button"
              className={locale === 'en' ? 'active' : ''}
              onClick={() => void setLocale('en')}
            >
              {ui.langEn}
            </button>
          </div>
          <div className={`pill ${remoteStateClass}`}>
            {ui.statePrefix}: {remoteStateText}
          </div>
        </div>
      </header>

      {!!error && <div className="banner error">{error}</div>}
      {!!loading && <div className="banner info">{loading}</div>}

      {windowMode === 'onboarding' ? (
        <main className="onboarding-layout">
          <section className="card steps-card">
            <h2>{ui.progressTitle}</h2>
            <div className="progress-track">
              <div className="progress-value" style={{ width: `${progressPercent}%` }} />
            </div>
            <ol className="step-list">
              {stepLabels.map((label, index) => {
                const stepNo = index + 1;
                const state = onboardingStep > stepNo ? 'done' : onboardingStep === stepNo ? 'current' : 'todo';
                return (
                  <li key={label} className={state}>
                    <span>{label}</span>
                  </li>
                );
              })}
            </ol>
          </section>

          <section className="card action-card">{currentStepPanel()}</section>
        </main>
      ) : (
        <main className="advanced-layout">
          <section className="card" ref={phoneSectionRef}>
            <h2>{ui.remoteStatusTitle}</h2>
            <p className="muted">{ui.statePrefix}: {remoteStateText}</p>
            <div className="switch-row">
              <div className="switch-text">
                <strong>{ui.remoteSwitchTitle}</strong>
                <p className="muted">{ui.remoteSwitchDesc}</p>
              </div>
              <label className="switch-toggle" aria-label={ui.remoteSwitchTitle}>
                <input
                  type="checkbox"
                  checked={remoteEnabled}
                  onChange={(event) => void setRemoteEnabled(event.target.checked)}
                />
                <span className="switch-slider" />
              </label>
            </div>
            <p className="muted">
              {remoteState === 'online'
                ? ui.remoteReady
                : remoteState === 'partial'
                  ? ui.remotePartialHint
                  : ui.remoteOfflineHint}
            </p>
            <p className="muted">{ui.repairPhoneHint}</p>
            <div className="actions">
              <button onClick={() => void restartPairingFlow()}>{ui.repairPhoneAction}</button>
              <button onClick={() => void refreshAll()}>{ui.refreshStatus}</button>
            </div>
          </section>

          <section className="card" ref={autostartSectionRef}>
            <h2>{ui.autostartTitle}</h2>
            <p className="muted">{ui.statePrefix}: {agentServiceText}</p>
            <div className="switch-row">
              <div className="switch-text">
                <strong>{ui.autostartSwitchTitle}</strong>
                <p className="muted">{ui.autostartSwitchDesc}</p>
              </div>
              <label className="switch-toggle" aria-label={ui.autostartSwitchTitle}>
                <input
                  type="checkbox"
                  checked={autoStartEnabled}
                  onChange={(event) => void setAutoStartEnabled(event.target.checked)}
                />
                <span className="switch-slider" />
              </label>
            </div>
            <div className="actions">
              <button onClick={() => void refreshServices()}>{ui.refresh}</button>
            </div>
          </section>

          <section className="card" ref={botSectionRef}>
            <h2>{ui.botConfigTitle}</h2>
            <p className="muted">{ui.botConfigDesc}</p>
            <p className="muted">{ui.currentBot}: {snapshot?.botUsername ? `@${snapshot.botUsername}` : ui.unknownBot}</p>
            <p className="muted">{ui.changeBotHint}</p>

            {(snapshot?.botConfigured && !showBotConfigEditor) ? (
              <div className="actions">
                <button onClick={() => setShowBotConfigEditor(true)}>{ui.changeBotAction}</button>
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
                <div className="actions">
                  <button onClick={() => void saveRelaySettings()}>{ui.saveApply}</button>
                  <button onClick={() => void refreshAll()}>{ui.refreshStatus}</button>
                  {snapshot?.botConfigured && (
                    <button onClick={() => setShowBotConfigEditor(false)}>{ui.cancel}</button>
                  )}
                </div>
              </>
            )}
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

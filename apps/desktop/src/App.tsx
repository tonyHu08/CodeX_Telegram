import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';

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

type ThreadSummary = {
  id: string;
  preview: string;
  updatedAt: number;
  source: string;
  cwd: string | null;
};

type AgentStatus = {
  deviceId: string;
  selectedThreadId: string | null;
  pendingApprovals: number;
  runningTurns: number;
  relayConnected: boolean;
  hasDeviceToken?: boolean;
  lastError: string | null;
  updatedAt: number;
};

type DesktopConfig = {
  deviceId: string;
  relayBaseUrl: string;
  selectedThreadId: string | null;
  autoStartAgent: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
};

type RelaySettings = {
  telegramBotToken: string;
  relayBotUsername: string;
};

type RelayHealth = {
  ok: boolean;
  relayBaseUrl?: string;
  websocketClients?: number;
  telegramEnabled?: boolean;
  botUsername?: string;
  targetBaseUrl: string;
  checkedAt: number;
};

type ServiceState = {
  installed: boolean;
  running: boolean;
  raw: string;
};

function describeServiceState(serviceState: ServiceState | null): string {
  if (!serviceState) {
    return '未检测';
  }
  if (serviceState.running) {
    return '已开启（开机后自动在线）';
  }
  if (serviceState.installed) {
    return '已安装，但当前未运行';
  }
  if (/Could not find service/i.test(serviceState.raw)) {
    return '未启用开机自动在线';
  }
  return '未启用';
}

function describeRelayServiceState(state: ServiceState | null): string {
  if (!state) {
    return '未检测';
  }
  if (state.running) {
    return '运行中';
  }
  if (state.installed) {
    return '已安装，未运行';
  }
  return '未安装';
}

function toFriendlyError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/fetch failed/i.test(text)) {
    return '手机消息通道暂时不可用，请先点“修复手机连接”再重试。';
  }
  if (/HTTP 503/i.test(text) && /telegram relay bot not ready/i.test(text)) {
    return '本机 Telegram 机器人尚未就绪，请稍后重试。';
  }
  return text;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function App() {
  const [config, setConfig] = useState<DesktopConfig | null>(null);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [pairing, setPairing] = useState<PairingSession | null>(null);
  const [pairingStatus, setPairingStatus] = useState<PairingStatus | null>(null);
  const [pairingQrDataUrl, setPairingQrDataUrl] = useState<string>('');
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [serviceState, setServiceState] = useState<ServiceState | null>(null);
  const [relayServiceState, setRelayServiceState] = useState<ServiceState | null>(null);
  const [relaySettings, setRelaySettings] = useState<RelaySettings>({
    telegramBotToken: '',
    relayBotUsername: '',
  });
  const [relayHealth, setRelayHealth] = useState<RelayHealth | null>(null);
  const [showBotToken, setShowBotToken] = useState(false);
  const [showBotGuide, setShowBotGuide] = useState(false);
  const [loading, setLoading] = useState<string>('');
  const [error, setError] = useState<string>('');

  const serviceStateText = useMemo(() => describeServiceState(serviceState), [serviceState]);
  const relayServiceStateText = useMemo(() => describeRelayServiceState(relayServiceState), [relayServiceState]);
  const botConfigured = useMemo(() => relaySettings.telegramBotToken.trim().length > 0, [relaySettings.telegramBotToken]);
  const envReady = useMemo(() => Boolean(health?.ok), [health?.ok]);
  const messageServiceReady = useMemo(() => Boolean(relayServiceState?.running), [relayServiceState?.running]);
  const telegramBotReady = useMemo(() => Boolean(relayHealth?.telegramEnabled), [relayHealth?.telegramEnabled]);
  const phonePaired = useMemo(
    () => Boolean(status?.relayConnected) || Boolean(status?.hasDeviceToken) || pairingStatus?.status === 'confirmed',
    [status?.relayConnected, status?.hasDeviceToken, pairingStatus?.status],
  );
  const threadBound = useMemo(() => Boolean(status?.selectedThreadId), [status?.selectedThreadId]);
  const onboardingStep = useMemo(() => {
    if (!envReady) {
      return 1;
    }
    // Once phone + thread are ready, keep user in completed state even if
    // bot connectivity has temporary fluctuations.
    if (phonePaired && threadBound) {
      return 5;
    }
    // Step 2 only checks whether bot credentials were configured.
    // Service/network readiness is shown as actionable hints in later steps,
    // so previously paired users won't be forced back to step 2.
    if (!botConfigured) {
      return 2;
    }
    if (!phonePaired) {
      return 3;
    }
    if (!threadBound) {
      return 4;
    }
    return 5;
  }, [envReady, botConfigured, phonePaired, threadBound]);
  const onboardingDone = onboardingStep === 5;
  const selectedThread = useMemo(
    () => threads.find((item) => item.id === status?.selectedThreadId) ?? null,
    [threads, status?.selectedThreadId],
  );
  const telegramBotLink = useMemo(
    () => (relayHealth?.botUsername ? `https://t.me/${relayHealth.botUsername}` : ''),
    [relayHealth?.botUsername],
  );

  async function refreshBasic() {
    const [cfg, st] = await Promise.all([
      window.desktopApi.getConfig(),
      window.desktopApi.getCurrentStatus(),
    ]);
    setConfig(cfg);
    setStatus(st);
  }

  async function refreshRelaySettings() {
    try {
      const settings = await window.desktopApi.getRelaySettings();
      setRelaySettings({
        telegramBotToken: typeof settings?.telegramBotToken === 'string' ? settings.telegramBotToken : '',
        relayBotUsername: typeof settings?.relayBotUsername === 'string' ? settings.relayBotUsername : '',
      });
    } catch (e: any) {
      setError(toFriendlyError(e));
    }
  }

  async function refreshRelayServiceState(): Promise<{
    state: ServiceState | null;
    health: RelayHealth | null;
  }> {
    try {
      const [state, health] = await Promise.all([
        window.desktopApi.getRelayServiceStatus(),
        window.desktopApi.checkRelayHealth().catch(() => null),
      ]);
      setRelayServiceState(state);
      setRelayHealth(health);
      return { state, health };
    } catch (e: any) {
      setError(toFriendlyError(e));
      return { state: null, health: null };
    }
  }

  async function runHealth() {
    setLoading('正在检测 Codex 环境...');
    setError('');
    try {
      const report = await window.desktopApi.getHealth();
      setHealth(report);
    } catch (e: any) {
      setError(toFriendlyError(e));
    } finally {
      setLoading('');
    }
  }

  async function repairLocalRelay() {
    setLoading('正在修复手机连接...');
    setError('');
    try {
      const state = await window.desktopApi.repairLocalRelay();
      setRelayServiceState(state);
      await refreshBasic();
    } catch (e: any) {
      setError(toFriendlyError(e));
    } finally {
      setLoading('');
    }
  }

  async function saveRelaySettings() {
    setLoading('正在保存机器人配置...');
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
      await refreshRelayServiceState();
      await refreshBasic();
      setLoading('已保存并应用到消息服务。');
      setTimeout(() => setLoading(''), 1600);
    } catch (e: any) {
      setError(toFriendlyError(e));
      setLoading('');
    }
  }

  async function clearRelaySettings() {
    setLoading('正在清空机器人配置...');
    setError('');
    try {
      const next = await window.desktopApi.setRelaySettings({
        telegramBotToken: '',
        relayBotUsername: '',
      });
      setRelaySettings({
        telegramBotToken: typeof next?.telegramBotToken === 'string' ? next.telegramBotToken : '',
        relayBotUsername: typeof next?.relayBotUsername === 'string' ? next.relayBotUsername : '',
      });
      await refreshRelayServiceState();
      await refreshBasic();
      setLoading('已清空并应用。');
      setTimeout(() => setLoading(''), 1200);
    } catch (e: any) {
      setError(toFriendlyError(e));
      setLoading('');
    }
  }

  async function startPairing() {
    setLoading('正在创建配对会话...');
    setError('');
    try {
      // Ensure relay is alive and bot login has settled before requesting pairing.
      let probe = await refreshRelayServiceState();
      let ready = Boolean(probe.state?.running) && Boolean(probe.health?.telegramEnabled);
      if (!ready) {
        setLoading('正在准备 Telegram 机器人连接...');
        await window.desktopApi.repairLocalRelay();
        await delay(900);
        probe = await refreshRelayServiceState();
        ready = Boolean(probe.state?.running) && Boolean(probe.health?.telegramEnabled);
      }
      if (!ready) {
        throw new Error('TELEGRAM_BOT_NOT_READY');
      }

      const session = await window.desktopApi.startPairing();
      const qr = await QRCode.toDataURL(session.qrPayload, {
        width: 260,
        margin: 1,
      });
      setPairing(session);
      setPairingQrDataUrl(qr);
      setPairingStatus({
        pairingSessionId: session.pairingSessionId,
        status: 'pending',
        expiresAt: session.expiresAt,
      });
      await refreshRelayServiceState();
    } catch (e: any) {
      const text = toFriendlyError(e);
      if (/TELEGRAM_BOT_NOT_READY/.test(text) || /telegram relay bot not ready/i.test(text)) {
        setError('机器人连接尚未就绪。请回到步骤 2 再点一次“保存并启用”，等待 3-5 秒后重试。若仍失败，请点“修复手机连接”。');
      } else {
        setError(text);
      }
    } finally {
      setLoading('');
    }
  }

  async function checkPairingStatus() {
    if (!pairing) {
      return;
    }
    try {
      const result = await window.desktopApi.checkPairingStatus(pairing.pairingSessionId);
      setPairingStatus(result);
      await refreshBasic();
    } catch (e: any) {
      const message = toFriendlyError(e);
      if (message.includes('HTTP 404')) {
        setPairingStatus({
          pairingSessionId: pairing.pairingSessionId,
          status: 'expired',
          expiresAt: Date.now(),
        });
        setError('当前配对会话已失效，请点击“开始配对”生成新的二维码。');
        return;
      }
      setError(message);
    }
  }

  async function copyPairingStartCommand() {
    if (!pairing?.startCommand) {
      return;
    }
    try {
      await navigator.clipboard.writeText(pairing.startCommand);
      setError('');
      setLoading('已复制配对指令，可直接粘贴到 Telegram。');
      setTimeout(() => setLoading(''), 1500);
    } catch (e: any) {
      setError(toFriendlyError(e));
    }
  }

  async function copyPairingLink() {
    if (!pairing?.qrPayload) {
      return;
    }
    try {
      await navigator.clipboard.writeText(pairing.qrPayload);
      setError('');
      setLoading('已复制配对链接。');
      setTimeout(() => setLoading(''), 1500);
    } catch (e: any) {
      setError(toFriendlyError(e));
    }
  }

  async function copyText(text: string, successMessage: string) {
    try {
      await navigator.clipboard.writeText(text);
      setError('');
      setLoading(successMessage);
      setTimeout(() => setLoading(''), 1500);
    } catch (e: any) {
      setError(toFriendlyError(e));
    }
  }

  async function loadThreads() {
    setLoading('读取线程列表...');
    setError('');
    try {
      const rows = await window.desktopApi.listThreads();
      setThreads(rows);
    } catch (e: any) {
      setError(toFriendlyError(e));
    } finally {
      setLoading('');
    }
  }

  async function bindThread(threadId: string) {
    setLoading('绑定线程...');
    setError('');
    try {
      await window.desktopApi.bindThread(threadId);
      await refreshBasic();
    } catch (e: any) {
      setError(toFriendlyError(e));
    } finally {
      setLoading('');
    }
  }

  async function serviceControl(action: 'install' | 'start' | 'stop' | 'restart' | 'status' | 'uninstall') {
    setLoading('正在更新后台服务状态...');
    setError('');
    try {
      const res = await window.desktopApi.serviceControl(action);
      setServiceState(res);
    } catch (e: any) {
      setError(toFriendlyError(e));
    } finally {
      setLoading('');
    }
  }

  async function refreshServiceState() {
    await serviceControl('status');
  }

  async function enableAutoStart() {
    setLoading('正在开启开机自动在线...');
    setError('');
    try {
      await window.desktopApi.serviceControl('install');
      const started = await window.desktopApi.serviceControl('start');
      setServiceState(started);
    } catch (e: any) {
      setError(toFriendlyError(e));
    } finally {
      setLoading('');
    }
  }

  async function disableAutoStart() {
    setLoading('正在关闭开机自动在线...');
    setError('');
    try {
      const state = await window.desktopApi.serviceControl('uninstall');
      setServiceState(state);
    } catch (e: any) {
      setError(toFriendlyError(e));
    } finally {
      setLoading('');
    }
  }

  useEffect(() => {
    void (async () => {
      await refreshBasic();
      await runHealth();
      await refreshRelaySettings();
      await refreshServiceState();
      await refreshRelayServiceState();
    })();
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      void refreshBasic();
    }, 3000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!pairing || (pairingStatus && pairingStatus.status !== 'pending')) {
      return;
    }
    const timer = setInterval(() => {
      void checkPairingStatus();
    }, 3000);
    return () => clearInterval(timer);
  }, [pairing?.pairingSessionId, pairingStatus?.status]);

  useEffect(() => {
    if (!onboardingDone || threads.length > 0) {
      return;
    }
    void loadThreads();
  }, [onboardingDone, threads.length]);

  useEffect(() => {
    if (!showBotGuide) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowBotGuide(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [showBotGuide]);

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div>
          <h1>Codex Bridge Desktop</h1>
          <p>首次使用请按步骤完成配置（约 2-3 分钟）</p>
        </div>
        <div className={`status-pill ${onboardingDone ? 'online' : 'offline'}`}>
          <span>{onboardingDone ? '已完成引导' : `引导进行中（第 ${Math.min(onboardingStep, 4)} 步）`}</span>
        </div>
      </header>

      {!!error && <div className="banner error">{error}</div>}
      {!!loading && <div className="banner info">{loading}</div>}

      {!onboardingDone ? (
        <main className="grid onboarding-grid">
          <section className="card wizard-steps-card">
            <h2>快速开始向导</h2>
            <ol className="steps wizard-steps">
              <li className={onboardingStep > 1 ? 'done' : onboardingStep === 1 ? 'current' : ''}>
                <strong>步骤 1：环境检测</strong>
                <span>确认本机 Codex 可用。</span>
              </li>
              <li className={onboardingStep > 2 ? 'done' : onboardingStep === 2 ? 'current' : ''}>
                <strong>步骤 2：配置机器人</strong>
                <span>填写 Telegram Bot Token 并保存。</span>
              </li>
              <li className={onboardingStep > 3 ? 'done' : onboardingStep === 3 ? 'current' : ''}>
                <strong>步骤 3：手机配对</strong>
                <span>扫码或打开链接完成手机绑定。</span>
              </li>
              <li className={onboardingStep > 4 ? 'done' : onboardingStep === 4 ? 'current' : ''}>
                <strong>步骤 4：选择线程</strong>
                <span>选中一个 Codex 对话线程作为远程目标。</span>
              </li>
            </ol>
            <div className="panel subtle">
              <p className="muted">请按顺序完成左侧步骤，右侧会展示当前步骤操作。</p>
            </div>
          </section>

          <section className="card wizard-action-card">
            {onboardingStep === 1 && (
              <div className="panel step-panel">
                <h3>步骤 1：环境检测</h3>
                <p className="muted">点击一次检测按钮，看到“可用”后自动进入下一步。</p>
                <div className="actions">
                  <button onClick={() => void runHealth()}>{health ? '重新检测' : '开始检测'}</button>
                </div>
                {health && (
                  <div className="panel subtle">
                    <p>{health.ok ? '✅ 可用' : `❌ ${health.code}`}</p>
                    {health.checks.map((item) => (
                      <p key={item.id}>{item.ok ? '✅' : '❌'} {item.message}</p>
                    ))}
                  </div>
                )}
              </div>
            )}

            {onboardingStep === 2 && (
              <div className="panel step-panel">
                <div className="step-title-row">
                  <h3>步骤 2：填写 Telegram 机器人</h3>
                  <button
                    type="button"
                    className="icon-help-button"
                    onClick={() => setShowBotGuide(true)}
                    aria-label="打开机器人配置教学"
                    title="不会配置？点击查看教学"
                  >
                    ?
                  </button>
                </div>
                <p className="muted">输入 Bot Token 后点“保存并启用”，成功后进入下一步。</p>
                <div className="inline-form">
                  <input
                    type={showBotToken ? 'text' : 'password'}
                    value={relaySettings.telegramBotToken}
                    onChange={(e) => setRelaySettings((prev) => ({ ...prev, telegramBotToken: e.target.value }))}
                    placeholder="Bot Token（必填）"
                  />
                  <button onClick={() => setShowBotToken((v) => !v)}>
                    {showBotToken ? '隐藏' : '显示'}
                  </button>
                </div>
                <div className="inline-form">
                  <input
                    value={relaySettings.relayBotUsername}
                    onChange={(e) => setRelaySettings((prev) => ({ ...prev, relayBotUsername: e.target.value }))}
                    placeholder="Bot 用户名（可选，不填自动识别）"
                  />
                </div>
                <div className="actions">
                  <button onClick={() => void saveRelaySettings()}>保存并启用</button>
                  <button onClick={() => void refreshRelayServiceState()}>检查机器人连通性</button>
                  <button onClick={() => void repairLocalRelay()}>修复手机连接</button>
                  <button onClick={() => void clearRelaySettings()}>清空配置</button>
                </div>
                <p className="muted">
                  当前状态：机器人{botConfigured ? '已配置' : '未配置'}，
                  手机消息服务{relayServiceStateText}，
                  机器人连通{telegramBotReady ? '已就绪' : '未就绪'}。
                </p>
              </div>
            )}

            {onboardingStep === 3 && (
              <div className="panel step-panel">
                <h3>步骤 3：手机配对</h3>
                <p className="muted">建议用系统相机扫码；若扫码无反应，请点“打开 Telegram 配对”。</p>
                {(!messageServiceReady || !telegramBotReady) && (
                  <p className="muted">
                    当前手机消息服务{relayServiceStateText}，机器人连通{telegramBotReady ? '已就绪' : '未就绪'}。
                    若配对报错，请先返回步骤 2 点“检查机器人连通性”或“修复手机连接”。
                  </p>
                )}
                <div className="actions">
                  <button onClick={() => void startPairing()}>开始配对</button>
                  <button onClick={() => void checkPairingStatus()}>刷新配对状态</button>
                </div>
                {pairing && (
                  <>
                    {pairingQrDataUrl && <img className="qr" src={pairingQrDataUrl} alt="pairing qr" />}
                    <div className="actions">
                      <a className="link-button" href={pairing.qrPayload} target="_blank" rel="noreferrer">
                        打开 Telegram 配对
                      </a>
                      <button onClick={() => void copyPairingLink()}>复制配对链接</button>
                      {pairing.startCommand && (
                        <button onClick={() => void copyPairingStartCommand()}>
                          复制配对指令
                        </button>
                      )}
                    </div>
                    <p className="muted">配对状态：{pairingStatus?.status || 'pending'}</p>
                    <details className="panel subtle">
                      <summary>查看配对详情</summary>
                      {pairing.botUsername && <p className="muted">机器人: @{pairing.botUsername}</p>}
                      {pairing.startCommand && <p className="muted">备用指令：{pairing.startCommand}</p>}
                      <p className="muted">会话ID: {pairing.pairingSessionId}</p>
                    </details>
                  </>
                )}
              </div>
            )}

            {onboardingStep === 4 && (
              <div className="panel step-panel">
                <h3>步骤 4：在 Telegram 选择线程</h3>
                <p className="muted">
                  请在 Telegram 给机器人发送 <code>/threads</code>，然后直接点会话按钮完成绑定。
                </p>
                <div className="actions">
                  <button onClick={() => void copyText('/threads', '已复制 /threads，可直接粘贴到 Telegram。')}>复制 /threads</button>
                  {telegramBotLink && (
                    <a className="link-button" href={telegramBotLink} target="_blank" rel="noreferrer">
                      打开机器人聊天
                    </a>
                  )}
                  <button onClick={() => void refreshBasic()}>我已在 Telegram 绑定，刷新状态</button>
                </div>
                <p className="muted">当“绑定线程”显示为已绑定后，会自动进入“已完成”。</p>
              </div>
            )}
          </section>
        </main>
      ) : (
        <main className="grid">
          <section className="card">
            <h2>配置完成</h2>
            <div className="panel step-panel done-panel">
              <h3>✅ 远程能力已就绪</h3>
              <p>现在可以直接在 Telegram 给机器人发消息，远程操作当前绑定线程。</p>
              <div className="actions">
                <button onClick={() => void refreshBasic()}>刷新状态</button>
                <button onClick={() => void copyText('/threads', '已复制 /threads，可直接在 Telegram 切换线程。')}>复制 /threads（切换线程）</button>
                <button onClick={() => void window.desktopApi.clearPairing()}>重新配对手机</button>
              </div>
            </div>
          </section>

          <section className="card">
            <h2>当前状态</h2>
            <div className="kv">
              <div><span>手机连接</span><strong>{status?.relayConnected ? '在线' : '离线'}</strong></div>
              <div><span>手机消息服务</span><strong>{relayServiceStateText}</strong></div>
              <div><span>机器人配置</span><strong>{botConfigured ? '已配置' : '未配置'}</strong></div>
              <div><span>当前机器人</span><strong>{relayHealth?.botUsername ? `@${relayHealth.botUsername}` : '未识别'}</strong></div>
              <div><span>绑定线程</span><strong>{status?.selectedThreadId || '未绑定'}</strong></div>
              <div><span>待审批</span><strong>{String(status?.pendingApprovals ?? 0)}</strong></div>
              <div><span>运行中任务</span><strong>{String(status?.runningTurns ?? 0)}</strong></div>
              <div><span>错误信息</span><strong>{status?.lastError || '无'}</strong></div>
            </div>
            {selectedThread && (
              <div className="panel subtle">
                <h3>当前对话线程</h3>
                <p><strong>{selectedThread.preview || selectedThread.id}</strong></p>
                <p className="muted">
                  更新时间：{new Date(selectedThread.updatedAt < 1e11 ? selectedThread.updatedAt * 1000 : selectedThread.updatedAt).toLocaleString()}
                </p>
              </div>
            )}
            <p className="muted">“手机离线”通常表示尚未配对，或机器人服务未运行。</p>
            <div className="actions">
              <button onClick={() => void refreshBasic()}>刷新状态</button>
              <button onClick={() => void repairLocalRelay()}>修复手机连接</button>
              <button onClick={() => void refreshRelayServiceState()}>刷新消息服务</button>
            </div>
          </section>

          <section className="card">
            <h2>开机自动在线（可选）</h2>
            <div className="panel">
              <p>{serviceStateText}</p>
              <p className="muted">这是本机后台服务（Agent），用于电脑重启后自动恢复远程能力。</p>
            </div>
            <div className="actions">
              <button onClick={() => void enableAutoStart()}>启用自动在线</button>
              <button onClick={() => void serviceControl('stop')}>立即停止</button>
              <button onClick={() => void disableAutoStart()}>关闭自动在线</button>
              <button onClick={() => void refreshServiceState()}>刷新</button>
            </div>

            <details className="panel">
              <summary>高级与排错</summary>
              <p className="muted">设备 ID: {config?.deviceId || '-'}</p>
              <p className="muted">本机消息服务: {relayServiceState?.raw || '-'}</p>
              <div className="actions">
                <button onClick={() => void window.desktopApi.reconnectRelay()}>重新连接手机消息通道</button>
                <button onClick={() => void window.desktopApi.clearPairing()}>解绑手机</button>
              </div>
              {serviceState && <pre className="code-block">{JSON.stringify(serviceState, null, 2)}</pre>}
            </details>
          </section>
        </main>
      )}

      {showBotGuide && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => setShowBotGuide(false)}
        >
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-label="Telegram 机器人配置教学"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <h3>如何完成「步骤 2：配置机器人」</h3>
              <button type="button" onClick={() => setShowBotGuide(false)}>关闭</button>
            </div>

            <ol className="guide-list">
              <li>
                在 Telegram 搜索并打开 <strong>@BotFather</strong>。
              </li>
              <li>
                发送 <code>/newbot</code>，按提示设置机器人名称和用户名（用户名必须以 <code>bot</code> 结尾）。
              </li>
              <li>
                BotFather 返回一串 <strong>Token</strong>（格式类似 <code>123456:ABC...</code>），复制它。
              </li>
              <li>
                回到本页面，把 Token 粘贴到 <strong>Bot Token（必填）</strong>，然后点 <strong>保存并启用</strong>。
              </li>
              <li>
                看到“机器人已配置”且“手机消息服务运行中”后，继续下一步“手机配对”。
              </li>
            </ol>

            <div className="panel subtle">
              <p><strong>常见问题</strong></p>
              <p className="muted">1) 看不到 BotFather：请确认 Telegram 网络正常。</p>
              <p className="muted">2) 保存失败：检查 Token 是否完整，前后不要有空格。</p>
              <p className="muted">3) 用户名不确定：可以先不填，系统会自动识别。</p>
            </div>

            <div className="actions">
              <a className="link-button" href="https://t.me/BotFather" target="_blank" rel="noreferrer">
                打开 BotFather
              </a>
              <button type="button" onClick={() => setShowBotGuide(false)}>我知道了</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

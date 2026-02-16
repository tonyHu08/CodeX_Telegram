import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, shell } from 'electron';
import WebSocket from 'ws';
import keytar from 'keytar';
import { startLocalRelay, type LocalRelayHandle } from './local-relay';
import {
  BridgeAgent,
  ConfigStore,
  LaunchdServiceManager,
  localeText,
  normalizeLocale,
  type BridgeLocale,
  type ServiceStatus,
  type DeviceInboundEvent,
  type DeviceOutboundEvent,
  type HealthReport,
  type PairingSession,
  type PairingStatus,
} from '@codex-bridge/bridge-core';

const KEYCHAIN_SERVICE = 'codex-bridge-desktop';
const KEYCHAIN_ACCOUNT = 'device-access-token';
const AGENT_LABEL = 'com.codex-bridge.agent';
const RELAY_LABEL = 'com.codex-bridge.relay';
const LOCAL_RELAY_BASE_URL = 'http://127.0.0.1:8787';
const OFFICIAL_RELAY_BASE_URL = (process.env.CB_OFFICIAL_RELAY_BASE_URL || 'https://relay.codexbridge.app').trim();
const OFFICIAL_BOT_USERNAME = (process.env.CB_OFFICIAL_BOT_USERNAME || 'codexbridge_official_bot').trim().replace(/^@+/, '');
const LOCAL_RELAY_STORE_PATH = path.join(dataRoot(), 'data', 'local-relay-store.json');
const RELAY_CONFIG_PATH = path.join(dataRoot(), 'relay-config.json');
const LOCAL_RELAY_HOST = '127.0.0.1';
const LOCAL_RELAY_PORT = 8787;
const FEEDBACK_ISSUES_URL = process.env.CB_FEEDBACK_ISSUES_URL || 'https://github.com/tonyHu08/CodeX_Bridge/issues';

if (!process.env.CB_DEFAULT_RELAY_BASE_URL && app.isPackaged) {
  // Default to local relay for the open-source "local mode" product.
  // Hosted relay (if any) should be explicitly configured via env.
  process.env.CB_DEFAULT_RELAY_BASE_URL = LOCAL_RELAY_BASE_URL;
}

type RelaySettings = {
  telegramBotToken: string;
  relayBotUsername: string;
};

type WindowMode = 'onboarding' | 'advanced';
type WindowFocusSection = 'phone' | 'autostart' | 'bot' | null;
type RemoteState = 'online' | 'partial' | 'offline';

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
  locale: BridgeLocale;
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

function withLocale(locale: BridgeLocale, zh: string, en: string): string {
  return localeText(locale, zh, en);
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolvePreferredCodexBin(): string {
  const envBin = (process.env.CODEX_BIN || '').trim();
  if (envBin && isExecutable(envBin)) {
    return envBin;
  }

  const candidates = [
    '/Applications/Codex.app/Contents/Resources/codex',
    'codex',
  ];

  for (const candidate of candidates) {
    if (candidate === 'codex') {
      return candidate;
    }
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  return 'codex';
}

function dataRoot(): string {
  return path.join(os.homedir(), '.codex-bridge');
}

function configPath(): string {
  return path.join(dataRoot(), 'config.json');
}

function dbPath(): string {
  return path.join(dataRoot(), 'data', 'codex_bridge.db');
}

function logDir(): string {
  return path.join(dataRoot(), 'logs');
}

function relayWsUrl(baseUrl: string): string {
  const asWs = baseUrl.replace(/^http/i, 'ws');
  return `${asWs.replace(/\/$/, '')}/v1/devices/stream`;
}

function normalizeRelayBaseUrl(value: string, locale: BridgeLocale): string {
  const normalized = value.trim().replace(/\/+$/, '');
  if (!normalized) {
    throw new Error(withLocale(locale, '远程服务地址不能为空', 'Remote service URL is required'));
  }
  if (!/^https?:\/\//i.test(normalized)) {
    throw new Error(withLocale(locale, '远程服务地址必须以 http:// 或 https:// 开头', 'Remote service URL must start with http:// or https://'));
  }
  return normalized;
}

function normalizeBotUsername(value: string): string {
  const raw = value.trim().replace(/^@+/, '');
  if (!raw) {
    return '';
  }
  if (/bot$/i.test(raw)) {
    return raw;
  }
  return `${raw}_bot`;
}

function isLocalRelayUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  } catch {
    return false;
  }
}

function parseEnvText(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function readEnvFileIfExists(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  try {
    return parseEnvText(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function readJsonFileIfExists(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function createTrayIconByState(state: RemoteState) {
  void state;
  const iconPath2x = path.join(__dirname, 'assets', 'trayTemplate@2x.png');
  const iconPath = path.join(__dirname, 'assets', 'trayTemplate.png');
  const colorIconPath = path.join(__dirname, 'assets', 'cab-brand-icon.png');

  let icon = nativeImage.createFromPath(iconPath2x);
  if (icon.isEmpty()) {
    icon = nativeImage.createFromPath(iconPath);
  }
  if (icon.isEmpty()) {
    icon = nativeImage.createFromPath(colorIconPath);
  }
  if (icon.isEmpty()) {
    const fallbackSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18"><path d="M3.4 11.8V8.3a4.6 4.6 0 0 1 4.6-4.6h2a4.6 4.6 0 0 1 4.6 4.6v3.5M2.7 11.9H15.3M8.3 6.2V11.9M9 6.2V11.9M9.7 6.2V11.9" fill="none" stroke="#000" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    icon = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(fallbackSvg).toString('base64')}`);
  }

  const sized = icon.resize({ width: 18, height: 18 });
  sized.setTemplateImage(true);
  return sized;
}

function toEpochMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  if (value < 10_000_000_000) {
    return Math.floor(value * 1000);
  }
  return Math.floor(value);
}

function findMonorepoRoot(): string | null {
  let cursor = app.getAppPath();
  for (let i = 0; i < 8; i += 1) {
    const pkgPath = path.join(cursor, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: string };
        if (pkg.name === 'codex-remote-bridge') {
          return cursor;
        }
      } catch {
        // ignore
      }
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
  return null;
}

async function httpJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers || {}),
    },
  });

  if (!res.ok) {
    let body = '';
    try {
      body = await res.text();
    } catch {
      body = '';
    }
    throw new Error(`HTTP ${res.status}: ${body || res.statusText}`);
  }

  return await res.json() as T;
}

class RelayConnection {
  private ws: WebSocket | null = null;
  private readonly onEvent: (event: DeviceInboundEvent) => Promise<void>;
  private readonly getToken: () => Promise<string | null>;
  private readonly getRelayBaseUrl: () => string;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private _connected = false;
  private _lastError: string | null = null;

  constructor(options: {
    onEvent: (event: DeviceInboundEvent) => Promise<void>;
    getToken: () => Promise<string | null>;
    getRelayBaseUrl: () => string;
  }) {
    this.onEvent = options.onEvent;
    this.getToken = options.getToken;
    this.getRelayBaseUrl = options.getRelayBaseUrl;
  }

  get connected(): boolean {
    return this._connected;
  }

  get lastError(): string | null {
    return this._lastError;
  }

  async connect(): Promise<void> {
    this.stopped = false;
    const token = await this.getToken();
    if (!token) {
      this._connected = false;
      this._lastError = 'device token not found';
      return;
    }

    const base = this.getRelayBaseUrl();
    const wsUrl = `${relayWsUrl(base)}?token=${encodeURIComponent(token)}`;

    await new Promise<void>((resolve) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      ws.once('open', () => {
        this._connected = true;
        this._lastError = null;
        resolve();
      });

      ws.on('message', (raw) => {
        try {
          const payload = JSON.parse(String(raw));
          if (!payload || typeof payload !== 'object') {
            return;
          }
          if (payload.type === 'hello') {
            return;
          }
          void this.onEvent(payload as DeviceInboundEvent);
        } catch (error: any) {
          this._lastError = error?.message || String(error);
        }
      });

      ws.on('close', () => {
        this._connected = false;
        this.ws = null;
        if (!this.stopped) {
          this.scheduleReconnect();
        }
      });

      ws.on('error', (error: any) => {
        this._connected = false;
        this._lastError = error?.message || String(error);
      });

      setTimeout(() => resolve(), 4000).unref();
    });
  }

  async reconnectNow(): Promise<void> {
    await this.disconnect();
    await this.connect();
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._connected = false;
  }

  send(event: DeviceOutboundEvent): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(JSON.stringify(event));
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, 2000);
    this.reconnectTimer.unref();
  }
}

class DesktopRuntime {
  private readonly configStore: ConfigStore;
  private readonly agent: BridgeAgent;
  private readonly launchdManager: LaunchdServiceManager;
  private readonly relayLaunchdManager: LaunchdServiceManager;
  private readonly relay: RelayConnection;
  private relayManagedByApp = false;
  private remoteEnabled = true;
  private inMemoryDeviceToken: string | null = null;
  private lastHealthReport: HealthReport | null = null;
  private appSnapshotCache: { value: AppSnapshot; expiresAt: number } | null = null;
  private relayHealthCache: {
    value: {
      ok: boolean;
      relayBaseUrl?: string;
      websocketClients?: number;
      telegramEnabled?: boolean;
      botUsername?: string;
      targetBaseUrl: string;
      checkedAt: number;
    };
    checkedAt: number;
  } | null = null;
  private relayHealthRefreshPromise: Promise<void> | null = null;
  private threadSummaryCache: {
    value: {
      id: string;
      title: string;
      updatedAt: number;
      source: string;
      cwd: string | null;
    };
    checkedAt: number;
  } | null = null;
  private threadSummaryRefreshPromise: Promise<void> | null = null;

  constructor() {
    fs.mkdirSync(dataRoot(), { recursive: true });
    fs.mkdirSync(path.join(dataRoot(), 'data'), { recursive: true });
    fs.mkdirSync(logDir(), { recursive: true });

    this.configStore = new ConfigStore(configPath());
    const cfg = this.configStore.load();
    const codexBin = resolvePreferredCodexBin();

    this.agent = new BridgeAgent({
      deviceId: cfg.deviceId,
      dbPath: dbPath(),
      codexBin,
      fallbackModel: 'gpt-5.2-codex',
      requestTimeoutMs: 60_000,
      turnTimeoutMs: 0,
      stuckTurnResetMs: 0,
      locale: cfg.locale,
    });

    this.launchdManager = new LaunchdServiceManager(AGENT_LABEL);
    this.relayLaunchdManager = new LaunchdServiceManager(RELAY_LABEL);
    this.relay = new RelayConnection({
      getToken: async () => await this.resolveDeviceToken(),
      getRelayBaseUrl: () => this.configStore.load().relayBaseUrl,
      onEvent: async (event) => {
        if (event.type === 'incomingUserMessage') {
          await this.agent.handleIncomingMessage(event);
          return;
        }
        if (event.type === 'incomingControlCommand') {
          await this.agent.handleControlCommand(event);
          return;
        }
        if (event.type === 'approvalDecision') {
          await this.agent.applyApprovalDecision(event.approvalId, event.allow);
        }
      },
    });

    this.agent.on('outbound', (event: DeviceOutboundEvent) => {
      this.relay.send(event);
    });
  }

  private invalidateCaches(): void {
    this.appSnapshotCache = null;
  }

  private invalidateThreadCache(): void {
    this.threadSummaryCache = null;
    this.threadSummaryRefreshPromise = null;
    this.invalidateCaches();
  }

  private async fetchJsonWithTimeout<T>(url: string, timeoutMs: number, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref();
    try {
      return await httpJson<T>(url, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private maybeRefreshRelayHealth(force = false): void {
    if (this.relayHealthRefreshPromise) {
      return;
    }
    const freshEnough = this.relayHealthCache && Date.now() - this.relayHealthCache.checkedAt <= 5_000;
    if (!force && freshEnough) {
      return;
    }
    this.relayHealthRefreshPromise = this.checkRelayHealth(800)
      .then((health) => {
        this.relayHealthCache = {
          value: health,
          checkedAt: Date.now(),
        };
      })
      .catch(() => {
        if (!this.relayHealthCache || Date.now() - this.relayHealthCache.checkedAt > 30_000) {
          this.relayHealthCache = null;
        }
      })
      .finally(() => {
        this.relayHealthRefreshPromise = null;
      });
  }

  private maybeRefreshCurrentThread(threadId: string): void {
    if (!threadId) {
      return;
    }
    if (this.threadSummaryRefreshPromise) {
      return;
    }
    const freshEnough = this.threadSummaryCache
      && this.threadSummaryCache.value.id === threadId
      && Date.now() - this.threadSummaryCache.checkedAt <= 5_000;
    if (freshEnough) {
      return;
    }

    this.threadSummaryRefreshPromise = this.agent.getBoundThreadSummary()
      .then((summary) => {
        if (!summary || summary.id !== threadId) {
          return;
        }
        this.threadSummaryCache = {
          value: {
            id: summary.id,
            title: summary.title || summary.preview || summary.id,
            updatedAt: toEpochMs(summary.updatedAt || 0),
            source: summary.source || 'unknown',
            cwd: summary.cwd || null,
          },
          checkedAt: Date.now(),
        };
      })
      .catch(() => {
        // ignore refresh failures and keep previous cache
      })
      .finally(() => {
        this.threadSummaryRefreshPromise = null;
      });
  }

  private async resolveDeviceToken(): Promise<string | null> {
    try {
      // Keychain access can trigger a prompt (or hang) on some systems.
      // Treat it as best-effort and fall back quickly.
      const fromKeychain = await Promise.race<string | null>([
        keytar.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT),
        new Promise((resolve) => setTimeout(() => resolve(null), 350)),
      ]);
      if (fromKeychain) {
        this.inMemoryDeviceToken = fromKeychain;
        return fromKeychain;
      }
    } catch {
      // Ignore keychain access failures and fallback to local persisted token.
    }

    if (this.inMemoryDeviceToken) {
      return this.inMemoryDeviceToken;
    }

    const cfg = this.configStore.load();
    if (!isLocalRelayUrl(cfg.relayBaseUrl)) {
      return null;
    }

    const restored = this.readPersistedTokenFromLocalRelayStore(cfg.deviceId);
    if (!restored) {
      return null;
    }

    this.inMemoryDeviceToken = restored;
    // Important: do NOT auto-write back into Keychain here.
    // On some systems this triggers a permission prompt and can hang startup/background flows.
    return restored;
  }

  private readPersistedTokenFromLocalRelayStore(deviceId: string): string | null {
    try {
      const parsed = readJsonFileIfExists(LOCAL_RELAY_STORE_PATH);
      const rows = Array.isArray(parsed.bindings) ? parsed.bindings : [];
      for (const item of rows) {
        if (!item || typeof item !== 'object') {
          continue;
        }
        const row = item as Record<string, unknown>;
        if (String(row.deviceId || '') !== deviceId) {
          continue;
        }
        const token = String(row.deviceAccessToken || '').trim();
        if (token) {
          return token;
        }
      }
    } catch {
      // ignore malformed relay store
    }
    return null;
  }

  private async ensureDeviceTokenRestoredIfMissing(): Promise<string | null> {
    return await this.resolveDeviceToken();
  }

  async start(): Promise<void> {
    await this.agent.start();
    try {
      this.lastHealthReport = await this.agent.getHealth();
    } catch {
      this.lastHealthReport = null;
    }
    await this.ensureDeviceTokenRestoredIfMissing();
    const cfg = this.configStore.load();
    if (!this.agent.getBinding() && cfg.selectedThreadId) {
      try {
        await this.agent.bindThread(cfg.selectedThreadId);
      } catch {
        this.configStore.update((current) => ({ ...current, selectedThreadId: null }));
      }
    }
    if (!this.agent.getBinding()) {
      try {
        const latest = (await this.agent.listThreads(1))[0];
        if (latest?.id) {
          await this.agent.bindThread(latest.id);
          this.configStore.update((current) => ({ ...current, selectedThreadId: latest.id }));
        }
      } catch {
        // ignore auto-bind failure; user can bind manually in UI
      }
    }
    await this.relay.connect();
    this.invalidateCaches();
  }

  async stop(): Promise<void> {
    await this.relay.disconnect();
    await this.agent.stop();
    this.invalidateCaches();
  }

  private shouldManageRelayLifecycle(): boolean {
    const cfg = this.configStore.load();
    return isLocalRelayUrl(cfg.relayBaseUrl);
  }

  private selfLaunchArgs(modeFlag: '--agent' | '--relay'): string[] {
    if (app.isPackaged) {
      return [modeFlag];
    }
    return [path.join(__dirname, 'main.js'), modeFlag];
  }

  private readRelaySettingsFromDisk(): RelaySettings {
    const dataConfig = readJsonFileIfExists(RELAY_CONFIG_PATH);
    return {
      telegramBotToken: typeof dataConfig.telegramBotToken === 'string' ? dataConfig.telegramBotToken.trim() : '',
      relayBotUsername: typeof dataConfig.relayBotUsername === 'string'
        ? normalizeBotUsername(dataConfig.relayBotUsername)
        : '',
    };
  }

  getRelaySettings(): RelaySettings {
    return this.readRelaySettingsFromDisk();
  }

  setRelaySettings(input: Partial<RelaySettings>): RelaySettings {
    const current = this.readRelaySettingsFromDisk();
    const next: RelaySettings = {
      telegramBotToken: typeof input.telegramBotToken === 'string' ? input.telegramBotToken.trim() : current.telegramBotToken,
      relayBotUsername: typeof input.relayBotUsername === 'string'
        ? normalizeBotUsername(input.relayBotUsername)
        : normalizeBotUsername(current.relayBotUsername),
    };

    fs.mkdirSync(path.dirname(RELAY_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(RELAY_CONFIG_PATH, JSON.stringify(next, null, 2), { mode: 0o600 });

    if (this.shouldManageRelayLifecycle()) {
      this.repairManagedLocalRelay();
    }
    this.relayHealthCache = null;
    this.invalidateCaches();
    return next;
  }

  private resolveRelayRuntimeEnv(): Record<string, string> {
    const cfg = this.configStore.load();
    const dataConfig = readJsonFileIfExists(RELAY_CONFIG_PATH);
    const dataEnv = readEnvFileIfExists(path.join(dataRoot(), 'relay.env'));
    const repoRoot = findMonorepoRoot();
    const repoEnv = repoRoot ? readEnvFileIfExists(path.join(repoRoot, '.env')) : {};

    const hasTokenInJson = Object.prototype.hasOwnProperty.call(dataConfig, 'telegramBotToken');
    const hasUsernameInJson = Object.prototype.hasOwnProperty.call(dataConfig, 'relayBotUsername');

    const tokenFromJson = typeof dataConfig.telegramBotToken === 'string' ? dataConfig.telegramBotToken.trim() : '';
    const usernameFromJson = typeof dataConfig.relayBotUsername === 'string' ? dataConfig.relayBotUsername.trim() : '';

    const telegramBotToken =
      hasTokenInJson
        ? tokenFromJson
        : process.env.TELEGRAM_BOT_TOKEN?.trim()
          || dataEnv.TELEGRAM_BOT_TOKEN
          || repoEnv.TELEGRAM_BOT_TOKEN
          || '';

    const relayBotUsername = normalizeBotUsername(
      hasUsernameInJson
        ? usernameFromJson
        : process.env.RELAY_BOT_USERNAME?.trim()
          || dataEnv.RELAY_BOT_USERNAME
          || repoEnv.RELAY_BOT_USERNAME
          || '',
    );

    if (!hasTokenInJson && !hasUsernameInJson && (telegramBotToken || relayBotUsername)) {
      fs.mkdirSync(path.dirname(RELAY_CONFIG_PATH), { recursive: true });
      fs.writeFileSync(RELAY_CONFIG_PATH, JSON.stringify({
        telegramBotToken,
        relayBotUsername,
      }, null, 2), { mode: 0o600 });
    }

    return {
      PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
      HOST: LOCAL_RELAY_HOST,
      PORT: String(LOCAL_RELAY_PORT),
      RELAY_PUBLIC_BASE_URL: LOCAL_RELAY_BASE_URL,
      RELAY_STORE_PATH: LOCAL_RELAY_STORE_PATH,
      TELEGRAM_BOT_TOKEN: telegramBotToken,
      RELAY_BOT_USERNAME: relayBotUsername,
      BRIDGE_LOCALE: cfg.locale,
    };
  }

  private ensureManagedLocalRelayInstalled(): void {
    const relayStatus = this.relayLaunchdManager.status();
    if (relayStatus.installed) {
      return;
    }

    const relayStdPath = path.join(logDir(), 'relay.log');
    this.relayLaunchdManager.install({
      executable: process.execPath,
      args: this.selfLaunchArgs('--relay'),
      workingDirectory: dataRoot(),
      stdoutPath: relayStdPath,
      stderrPath: relayStdPath,
      env: this.resolveRelayRuntimeEnv(),
    });
  }

  startManagedLocalRelayIfNeeded(): void {
    if (!this.shouldManageRelayLifecycle()) {
      this.relayManagedByApp = false;
      return;
    }

    this.ensureManagedLocalRelayInstalled();

    this.relayLaunchdManager.start();
    this.relayManagedByApp = true;
  }

  stopManagedLocalRelayIfNeeded(): void {
    if (!this.relayManagedByApp) {
      return;
    }
    this.relayLaunchdManager.stop();
    this.relayManagedByApp = false;
  }

  repairManagedLocalRelay(): ServiceStatus {
    const relayStdPath = path.join(logDir(), 'relay.log');
    this.relayLaunchdManager.install({
      executable: process.execPath,
      args: this.selfLaunchArgs('--relay'),
      workingDirectory: dataRoot(),
      stdoutPath: relayStdPath,
      stderrPath: relayStdPath,
      env: this.resolveRelayRuntimeEnv(),
    });
    this.relayLaunchdManager.start();
    this.relayManagedByApp = true;
    return this.relayLaunchdManager.status();
  }

  relayServiceStatus(): ServiceStatus {
    return this.relayLaunchdManager.status();
  }

  getConfig() {
    return this.configStore.load();
  }

  setLocale(locale: BridgeLocale) {
    const normalized = normalizeLocale(locale);
    this.agent.setLocale(normalized);
    this.configStore.update((cfg) => ({ ...cfg, locale: normalized }));
    this.invalidateCaches();
    return this.configStore.load();
  }

  setRelayBaseUrl(relayBaseUrl: string) {
    const wasLocal = this.shouldManageRelayLifecycle();
    const cfg = this.configStore.load();
    const normalized = normalizeRelayBaseUrl(relayBaseUrl, cfg.locale);
    this.configStore.update((current) => ({ ...current, relayBaseUrl: normalized }));
    const nowLocal = this.shouldManageRelayLifecycle();
    if (wasLocal && !nowLocal) {
      this.stopManagedLocalRelayIfNeeded();
    } else if (!wasLocal && nowLocal) {
      this.startManagedLocalRelayIfNeeded();
    }
    this.remoteEnabled = true;
    void this.relay.reconnectNow().catch(() => undefined);
    this.relayHealthCache = null;
    this.invalidateCaches();
    return this.configStore.load();
  }

  useOfficialHostedRelay() {
    const cfg = this.configStore.load();
    if (!OFFICIAL_RELAY_BASE_URL) {
      throw new Error(withLocale(cfg.locale, '未配置官方托管地址（CB_OFFICIAL_RELAY_BASE_URL）。', 'Official hosted relay URL is not configured (CB_OFFICIAL_RELAY_BASE_URL).'));
    }
    return this.setRelayBaseUrl(OFFICIAL_RELAY_BASE_URL);
  }

  useLocalSelfHostedRelay() {
    return this.setRelayBaseUrl(LOCAL_RELAY_BASE_URL);
  }

  private isNetworkFetchError(error: unknown): boolean {
    const text = error instanceof Error ? error.message : String(error);
    return /fetch failed|enotfound|econnrefused|econnreset|ssl|certificate|network|timed out/i.test(text);
  }

  private async requestRelayJson<T>(
    endpointPath: string,
    init?: RequestInit,
    options?: { allowLocalFallback?: boolean },
  ): Promise<T> {
    const cfg = this.configStore.load();
    const primaryBase = cfg.relayBaseUrl.replace(/\/$/, '');

    try {
      return await httpJson<T>(`${primaryBase}${endpointPath}`, init);
    } catch (primaryError: any) {
      if (!options?.allowLocalFallback || !this.isNetworkFetchError(primaryError) || primaryBase === LOCAL_RELAY_BASE_URL) {
        throw primaryError;
      }

      try {
        await httpJson<{ ok: boolean }>(`${LOCAL_RELAY_BASE_URL}/healthz`);
        const result = await httpJson<T>(`${LOCAL_RELAY_BASE_URL}${endpointPath}`, init);
        this.configStore.update((current) => ({ ...current, relayBaseUrl: LOCAL_RELAY_BASE_URL }));
        await this.relay.reconnectNow();
        return result;
      } catch (fallbackError: any) {
        const primaryMessage = primaryError?.message || String(primaryError);
        const fallbackMessage = fallbackError?.message || String(fallbackError);
        const locale = cfg.locale;
        throw new Error(
          withLocale(
            locale,
            `当前远程地址不可达（${primaryBase}）。本地服务回退失败：${fallbackMessage}。原始错误：${primaryMessage}`,
            `Primary remote URL is unreachable (${primaryBase}). Local fallback failed: ${fallbackMessage}. Original error: ${primaryMessage}`,
          ),
        );
      }
    }
  }

  async checkRelayHealth(timeoutMs = 800) {
    const cfg = this.configStore.load();
    const baseUrl = cfg.relayBaseUrl.replace(/\/$/, '');
    const health = await this.fetchJsonWithTimeout<{
      ok: boolean;
      relayBaseUrl?: string;
      websocketClients?: number;
      telegramEnabled?: boolean;
      botUsername?: string;
    }>(`${baseUrl}/healthz`, Math.max(200, timeoutMs));
    return {
      ...health,
      targetBaseUrl: baseUrl,
      checkedAt: Date.now(),
    };
  }

  async getHealth() {
    const report = await this.agent.getHealth();
    this.lastHealthReport = report;
    return report;
  }

  async startPairing(): Promise<PairingSession> {
    const cfg = this.configStore.load();
    const response = await this.requestRelayJson<PairingSession>('/v1/pairing/sessions', {
      method: 'POST',
      body: JSON.stringify({ deviceId: cfg.deviceId }),
    }, { allowLocalFallback: true });
    return response;
  }

  async checkPairingStatus(pairingSessionId: string): Promise<PairingStatus> {
    const cfg = this.configStore.load();
    const result = await httpJson<PairingStatus>(`${cfg.relayBaseUrl.replace(/\/$/, '')}/v1/pairing/sessions/${pairingSessionId}`);

    if (result.status === 'confirmed' && result.deviceAccessToken) {
      this.inMemoryDeviceToken = result.deviceAccessToken;
      try {
        await keytar.setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, result.deviceAccessToken);
      } catch {
        // Continue with in-memory token fallback.
      }
      await this.relay.reconnectNow();
      this.invalidateCaches();
    }

    return result;
  }

  async listThreads() {
    return await this.agent.listThreads(30);
  }

  async bindThread(threadId: string) {
    await this.agent.bindThread(threadId);
    this.configStore.update((cfg) => ({
      ...cfg,
      selectedThreadId: threadId,
    }));
    this.invalidateThreadCache();
    return this.configStore.load();
  }

  async getCurrentStatus() {
    const base = await this.agent.getStatus(this.relay.connected, this.relay.lastError);
    const token = await this.ensureDeviceTokenRestoredIfMissing();
    return {
      ...base,
      hasDeviceToken: Boolean(token),
    };
  }

  private computeOnboardingStep(input: {
    healthOk: boolean;
    botConfigured: boolean;
    paired: boolean;
    threadBound: boolean;
  }): 1 | 2 | 3 | 4 | 5 {
    if (!input.healthOk) {
      return 1;
    }
    if (!input.botConfigured) {
      return 2;
    }
    if (!input.paired) {
      return 3;
    }
    if (!input.threadBound) {
      return 4;
    }
    return 5;
  }

  private computeRemoteState(input: {
    healthOk: boolean;
    botConfigured: boolean;
    relayRunning: boolean;
    paired: boolean;
    relayConnected: boolean;
  }): RemoteState {
    if (!input.healthOk || !input.botConfigured || !input.relayRunning) {
      return 'offline';
    }
    if (!input.paired || !input.relayConnected) {
      return 'partial';
    }
    return 'online';
  }

  async getAppSnapshot(): Promise<AppSnapshot> {
    if (this.appSnapshotCache && this.appSnapshotCache.expiresAt > Date.now()) {
      return this.appSnapshotCache.value;
    }

    const status = await this.getCurrentStatus();
    const relaySettings = this.getRelaySettings();
    const relayService = this.relayServiceStatus();
    const cfg = this.configStore.load();
    const usingHostedRelay = !isLocalRelayUrl(cfg.relayBaseUrl);
    const healthOk = this.lastHealthReport?.ok ?? false;
    const botConfigured = usingHostedRelay || relaySettings.telegramBotToken.trim().length > 0;
    const relayRunning = usingHostedRelay ? this.remoteEnabled : relayService.running;
    const paired = Boolean(status.relayConnected) || Boolean(status.hasDeviceToken);
    const threadBound = Boolean(status.selectedThreadId);
    this.maybeRefreshRelayHealth();
    if (status.selectedThreadId) {
      this.maybeRefreshCurrentThread(status.selectedThreadId);
    } else {
      this.threadSummaryCache = null;
    }

    const relayHealth = this.relayHealthCache?.value || null;
    const currentThread = status.selectedThreadId
      ? (this.threadSummaryCache && this.threadSummaryCache.value.id === status.selectedThreadId
        ? this.threadSummaryCache.value
        : {
            id: status.selectedThreadId,
            title: status.selectedThreadId,
            updatedAt: 0,
            source: 'unknown',
            cwd: null,
          })
      : null;
    const remoteState = this.computeRemoteState({
      healthOk,
      botConfigured,
      relayRunning,
      paired,
      relayConnected: status.relayConnected,
    });

    const snapshot: AppSnapshot = {
      healthOk,
      botConfigured,
      usingHostedRelay,
      relayRunning,
      relayConnected: status.relayConnected,
      paired,
      threadBound,
      statusChecks: {
        codexReady: healthOk,
        remoteServiceRunning: relayRunning,
        phonePaired: paired,
        threadBound,
      },
      onboardingStep: this.computeOnboardingStep({
        healthOk,
        botConfigured,
        paired,
        threadBound,
      }),
      remoteState,
      locale: cfg.locale,
      selectedThreadId: status.selectedThreadId,
      currentThread,
      botUsername: relayHealth?.botUsername || null,
      officialBotUsername: usingHostedRelay ? OFFICIAL_BOT_USERNAME : null,
      lastError: status.lastError,
    };
    this.appSnapshotCache = {
      value: snapshot,
      expiresAt: Date.now() + 1000,
    };
    return snapshot;
  }

  async clearPairing() {
    this.inMemoryDeviceToken = null;
    try {
      await keytar.deletePassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    } catch {
      // ignore keychain delete failures
    }
    await this.relay.disconnect();
    this.invalidateCaches();
  }

  serviceControl(action: 'install' | 'start' | 'stop' | 'restart' | 'status' | 'uninstall') {
    const stdoutPath = path.join(logDir(), 'agent.log');
    const stderrPath = path.join(logDir(), 'agent.log');

    if (action === 'install') {
      this.launchdManager.install({
        executable: process.execPath,
        args: this.selfLaunchArgs('--agent'),
        workingDirectory: dataRoot(),
        stdoutPath,
        stderrPath,
        env: {
          PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
        },
      });
      this.invalidateCaches();
      return this.launchdManager.status();
    }

    if (action === 'start') {
      this.launchdManager.start();
      this.invalidateCaches();
      return this.launchdManager.status();
    }

    if (action === 'stop') {
      this.launchdManager.stop();
      this.invalidateCaches();
      return this.launchdManager.status();
    }

    if (action === 'restart') {
      this.launchdManager.restart();
      this.invalidateCaches();
      return this.launchdManager.status();
    }

    if (action === 'uninstall') {
      this.launchdManager.uninstall();
      this.invalidateCaches();
      return this.launchdManager.status();
    }

    return this.launchdManager.status();
  }

  async reconnectRelay() {
    await this.relay.reconnectNow();
    this.invalidateCaches();
  }

  getLogsTail(file: 'agent.log' | 'relay.log', lines = 120): string {
    const fileName = file === 'relay.log' ? 'relay.log' : 'agent.log';
    const filePath = path.join(logDir(), fileName);
    if (!fs.existsSync(filePath)) {
      return '';
    }
    const content = fs.readFileSync(filePath, 'utf8');
    const normalizedLines = content.replace(/\r\n/g, '\n').split('\n');
    return normalizedLines.slice(Math.max(0, normalizedLines.length - Math.max(1, lines))).join('\n').trim();
  }

  async openLogsDir(): Promise<string> {
    return await shell.openPath(logDir());
  }

  async openFeedbackIssues(): Promise<void> {
    await shell.openExternal(FEEDBACK_ISSUES_URL);
  }

  async toggleRelay(shouldRun: boolean): Promise<ServiceStatus> {
    if (!this.shouldManageRelayLifecycle()) {
      this.remoteEnabled = shouldRun;
      if (shouldRun) {
        await this.relay.reconnectNow();
      } else {
        await this.relay.disconnect();
      }
      this.invalidateCaches();
      return {
        installed: true,
        running: this.remoteEnabled,
        raw: 'hosted relay mode',
      };
    }
    if (shouldRun) {
      this.ensureManagedLocalRelayInstalled();
      this.relayLaunchdManager.start();
      this.relayManagedByApp = true;
      this.invalidateCaches();
      void this.relay.reconnectNow()
        .then(() => {
          this.invalidateCaches();
        })
        .catch(() => {
          this.invalidateCaches();
        });
      return this.relayServiceStatus();
    }

    this.relayLaunchdManager.stop();
    this.relayManagedByApp = false;
    await this.relay.disconnect();
    this.invalidateCaches();
    return this.relayServiceStatus();
  }

  async trackAnalyticsEvent(eventName: string, payload?: Record<string, unknown>): Promise<void> {
    const cfg = this.configStore.load();
    const baseUrl = cfg.relayBaseUrl.replace(/\/$/, '');
    const deviceIdHash = createHash('sha256').update(cfg.deviceId).digest('hex').slice(0, 24);
    try {
      await this.fetchJsonWithTimeout<{ ok: boolean }>(
        `${baseUrl}/v1/analytics/events`,
        800,
        {
          method: 'POST',
          body: JSON.stringify({
            eventId: randomUUID(),
            name: eventName,
            timestamp: Date.now(),
            appVersion: app.getVersion(),
            locale: cfg.locale,
            channelTag: 'desktop',
            deviceIdHash,
            payload: payload || {},
          }),
        },
      );
    } catch {
      // best-effort analytics, never block product flow
    }
  }
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let trayRefreshTimer: NodeJS.Timeout | null = null;
let trayIconState: RemoteState | null = null;
let trayInteractive = false;
let isQuitting = false;
let currentWindowMode: WindowMode = 'onboarding';
let currentWindowFocusSection: WindowFocusSection = null;
let runtime: DesktopRuntime | null = null;
let localRelayHandle: LocalRelayHandle | null = null;
const isRelayProcess = process.argv.includes('--relay');
const isAgentProcess = process.argv.includes('--agent');
const requiresSingleInstanceLock = !isRelayProcess && !isAgentProcess;
const singleInstanceLock = requiresSingleInstanceLock ? app.requestSingleInstanceLock() : true;

if (!singleInstanceLock) {
  app.quit();
}

function getRuntimeOrThrow(): DesktopRuntime {
  if (!runtime) {
    throw new Error('runtime is not initialized');
  }
  return runtime;
}

function readLocaleFallback(): BridgeLocale {
  if (runtime) {
    return runtime.getConfig().locale;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as { locale?: string };
    return normalizeLocale(parsed.locale);
  } catch {
    return normalizeLocale('');
  }
}

function updateDockVisibility(visible: boolean) {
  void visible;
  if (!app.dock) {
    return;
  }
  try {
    // Keep dock icon hidden in all modes. App is menu-bar first.
    app.dock.hide();
  } catch {
    // ignore dock visibility errors
  }
}

function emitWindowModeChanged() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send('window-mode-changed', {
    mode: currentWindowMode,
    focusSection: currentWindowFocusSection,
  });
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return;
  }

  const preloadPath = path.join(__dirname, 'preload.js');
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 920,
    minHeight: 620,
    show: false,
    backgroundColor: '#eef3fb',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Codex Bridge Desktop',
  });

  const devServer = process.env.DESKTOP_DEV_SERVER;
  if (devServer) {
    void mainWindow.loadURL(devServer);
  } else {
    const rendererPath = path.join(__dirname, '..', 'renderer', 'index.html');
    void mainWindow.loadFile(rendererPath);
  }

  mainWindow.webContents.on('did-finish-load', () => {
    emitWindowModeChanged();
  });

  mainWindow.on('close', (event) => {
    if (isQuitting) {
      return;
    }
    event.preventDefault();
    mainWindow?.hide();
    updateDockVisibility(false);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function showMainWindow(mode: WindowMode, focusSection: WindowFocusSection = null) {
  currentWindowMode = mode;
  currentWindowFocusSection = focusSection;
  createMainWindow();
  if (!mainWindow) {
    return;
  }
  emitWindowModeChanged();
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
  updateDockVisibility(true);
}

function hideMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }
  updateDockVisibility(false);
}

function setTrayIconState(state: RemoteState) {
  if (!tray) {
    return;
  }
  if (trayIconState === state) {
    return;
  }
  tray.setImage(createTrayIconByState(state));
  trayIconState = state;
}

async function refreshTrayMenu() {
  if (!tray) {
    return;
  }
  const runtimeRef = runtime;
  const fallbackLocale = readLocaleFallback();
  if (!trayInteractive || !runtimeRef) {
    setTrayIconState('offline');
    tray.setToolTip(withLocale(fallbackLocale, 'Codex Bridge Desktop（正在启动）', 'Codex Bridge Desktop (starting)'));
    tray.setContextMenu(Menu.buildFromTemplate([
      {
        label: 'Codex Bridge Desktop',
        enabled: false,
      },
      {
        label: withLocale(fallbackLocale, '⏳ 正在初始化，请稍候…', '⏳ Initializing, please wait...'),
        enabled: false,
      },
      {
        label: withLocale(fallbackLocale, '初始化完成后菜单将自动可用', 'Menu will be enabled automatically once ready'),
        enabled: false,
      },
      { type: 'separator' },
      {
        label: withLocale(fallbackLocale, '退出 Codex Bridge', 'Quit Codex Bridge'),
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]));
    return;
  }
  const snapshot = await runtimeRef.getAppSnapshot().catch(() => null);
  if (!snapshot) {
    setTrayIconState('offline');
    tray.setContextMenu(Menu.buildFromTemplate([
      {
        label: 'Codex Bridge Desktop',
        click: () => showMainWindow('advanced'),
      },
      {
        label: withLocale(fallbackLocale, '⚪ 状态读取失败（点击重试）', '⚪ Failed to read status (click to retry)'),
        click: () => {
          void refreshTrayMenu();
        },
      },
      { type: 'separator' },
      {
        label: withLocale(fallbackLocale, '打开应用主页…', 'Open app home…'),
        click: () => showMainWindow('advanced'),
      },
      {
        label: withLocale(fallbackLocale, '退出 Codex Bridge', 'Quit Codex Bridge'),
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]));
    return;
  }

  setTrayIconState(snapshot.remoteState);
  const locale = snapshot.locale;

  const globalStatusLabel =
    snapshot.remoteState === 'online'
      ? withLocale(locale, '🟢 状态：在线', '🟢 Status: Online')
      : snapshot.remoteState === 'partial'
        ? withLocale(locale, '🟡 状态：部分可用', '🟡 Status: Partially Ready')
        : withLocale(locale, '🔴 状态：离线', '🔴 Status: Offline');
  const remoteSwitchLabel = snapshot.relayRunning
    ? withLocale(locale, '🟢 远程开关：已开启（点此暂停）', '🟢 Remote switch: ON (click to pause)')
    : withLocale(locale, '⚪ 远程开关：已暂停（点此恢复）', '⚪ Remote switch: OFF (click to resume)');
  const defaultMode: WindowMode = snapshot.onboardingStep < 5 ? 'onboarding' : 'advanced';

  const menu = Menu.buildFromTemplate([
    {
      label: 'Codex Bridge Desktop',
      click: () => showMainWindow(defaultMode),
    },
    {
      label: globalStatusLabel,
      click: () => showMainWindow(defaultMode),
    },
    {
      label: remoteSwitchLabel,
      click: () => {
        void runtimeRef.toggleRelay(!snapshot.relayRunning).then(() => refreshTrayMenu());
      },
    },
    { type: 'separator' },
    ...(snapshot.onboardingStep < 5
      ? [{
        label: withLocale(locale, '打开初始化向导…', 'Open setup wizard…'),
        click: () => showMainWindow('onboarding'),
      }]
      : []),
    {
      label: withLocale(locale, '打开应用主页…', 'Open app home…'),
      click: () => showMainWindow('advanced'),
    },
    {
      label: withLocale(locale, '重新配对手机…', 'Repair phone pairing…'),
      click: () => showMainWindow('advanced', 'phone'),
    },
    { type: 'separator' },
    {
      label: withLocale(locale, '刷新状态', 'Refresh status'),
      click: () => {
        void refreshTrayMenu();
      },
    },
    { type: 'separator' },
    {
      label: withLocale(locale, '退出 Codex Bridge', 'Quit Codex Bridge'),
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip(withLocale(locale, 'Codex Bridge Desktop（手机远程）', 'Codex Bridge Desktop (mobile remote)'));
  tray.setContextMenu(menu);
}

function createTray() {
  if (tray || isAgentProcess || isRelayProcess) {
    return;
  }
  tray = new Tray(createTrayIconByState('offline'));
  trayIconState = 'offline';
  tray.on('click', () => {
    void refreshTrayMenu();
    tray?.popUpContextMenu();
  });

  void refreshTrayMenu();
  trayRefreshTimer = setInterval(() => {
    void refreshTrayMenu();
  }, 4000);
  trayRefreshTimer.unref();
}

async function yieldToUiTick(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function registerIpcHandlers() {
  const runtimeRef = getRuntimeOrThrow();
  ipcMain.handle('ipc.getConfig', async () => runtimeRef.getConfig());
  ipcMain.handle('ipc.setLocale', async (_evt, locale: BridgeLocale) => {
    const updated = runtimeRef.setLocale(locale);
    void refreshTrayMenu();
    return updated;
  });
  ipcMain.handle('ipc.getRelaySettings', async () => runtimeRef.getRelaySettings());
  ipcMain.handle('ipc.setRelaySettings', async (_evt, relaySettings: Partial<RelaySettings>) => runtimeRef.setRelaySettings(relaySettings));
  ipcMain.handle('ipc.setRelayBaseUrl', async (_evt, relayBaseUrl: string) => runtimeRef.setRelayBaseUrl(relayBaseUrl));
  ipcMain.handle('ipc.useOfficialRelay', async () => runtimeRef.useOfficialHostedRelay());
  ipcMain.handle('ipc.useSelfHostedRelay', async () => runtimeRef.useLocalSelfHostedRelay());
  ipcMain.handle('ipc.checkRelayHealth', async () => await runtimeRef.checkRelayHealth());
  ipcMain.handle('ipc.getHealth', async () => await runtimeRef.getHealth());
  ipcMain.handle('ipc.getAppSnapshot', async () => await runtimeRef.getAppSnapshot());
  ipcMain.handle('ipc.startPairing', async () => await runtimeRef.startPairing());
  ipcMain.handle('ipc.checkPairingStatus', async (_evt, pairingSessionId: string) => await runtimeRef.checkPairingStatus(pairingSessionId));
  ipcMain.handle('ipc.listThreads', async () => await runtimeRef.listThreads());
  ipcMain.handle('ipc.bindThread', async (_evt, threadId: string) => await runtimeRef.bindThread(threadId));
  ipcMain.handle('ipc.getCurrentStatus', async () => await runtimeRef.getCurrentStatus());
  ipcMain.handle('ipc.serviceControl', async (_evt, action: 'install' | 'start' | 'stop' | 'restart' | 'status' | 'uninstall') => runtimeRef.serviceControl(action));
  ipcMain.handle('ipc.getRelayServiceStatus', async () => runtimeRef.relayServiceStatus());
  ipcMain.handle('ipc.repairLocalRelay', async () => runtimeRef.repairManagedLocalRelay());
  ipcMain.handle('ipc.clearPairing', async () => await runtimeRef.clearPairing());
  ipcMain.handle('ipc.reconnectRelay', async () => await runtimeRef.reconnectRelay());
  ipcMain.handle('ipc.toggleRelay', async (_evt, shouldRun: boolean) => {
    const status = await runtimeRef.toggleRelay(!!shouldRun);
    void refreshTrayMenu();
    return status;
  });
  ipcMain.handle('ipc.getLogsTail', async (_evt, file: 'agent.log' | 'relay.log', lines?: number) => runtimeRef.getLogsTail(file, lines));
  ipcMain.handle('ipc.openLogsDir', async () => await runtimeRef.openLogsDir());
  ipcMain.handle('ipc.openFeedbackIssues', async () => await runtimeRef.openFeedbackIssues());
  ipcMain.handle('ipc.trackAnalyticsEvent', async (_evt, eventName: string, payload?: Record<string, unknown>) => {
    await runtimeRef.trackAnalyticsEvent(eventName, payload);
    return { ok: true };
  });
  ipcMain.handle('ipc.getWindowMode', async () => ({
    mode: currentWindowMode,
    focusSection: currentWindowFocusSection,
  }));
  ipcMain.handle('ipc.setWindowMode', async (_evt, mode: WindowMode, focusSection?: WindowFocusSection) => {
    currentWindowMode = mode === 'advanced' ? 'advanced' : 'onboarding';
    currentWindowFocusSection = focusSection || null;
    emitWindowModeChanged();
    return {
      mode: currentWindowMode,
      focusSection: currentWindowFocusSection,
    };
  });
  ipcMain.handle('ipc.hideWindow', async () => {
    hideMainWindow();
    return { ok: true };
  });
}

async function bootstrap() {
  if (!singleInstanceLock) {
    return;
  }

  if (requiresSingleInstanceLock) {
    app.on('second-instance', () => {
      showMainWindow('advanced');
    });
  }

  await app.whenReady();
  if (process.platform === 'darwin' && typeof app.setActivationPolicy === 'function') {
    try {
      app.setActivationPolicy('accessory');
    } catch {
      // ignore activation policy failures
    }
  }
  const isAgentMode = isAgentProcess;
  const isRelayMode = isRelayProcess;

  if (isRelayMode) {
    localRelayHandle = await startLocalRelay({
      host: process.env.HOST || LOCAL_RELAY_HOST,
      port: Number(process.env.PORT || LOCAL_RELAY_PORT),
      relayBaseUrl: process.env.RELAY_PUBLIC_BASE_URL || LOCAL_RELAY_BASE_URL,
      persistPath: process.env.RELAY_STORE_PATH || LOCAL_RELAY_STORE_PATH,
      telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
      relayBotUsername: process.env.RELAY_BOT_USERNAME || '',
      locale: normalizeLocale(process.env.BRIDGE_LOCALE),
    });
    if (app.dock) {
      app.dock.hide();
    }
    return;
  }

  if (!isAgentMode) {
    // Show tray immediately (disabled menu) so users get instant feedback on app launch.
    createTray();
    // Let macOS render the tray icon before running sync startup work.
    await yieldToUiTick();
  }

  runtime = new DesktopRuntime();
  await registerIpcHandlers();
  const runtimeRef = getRuntimeOrThrow();

  if (!isAgentMode) {
    runtimeRef.startManagedLocalRelayIfNeeded();
  }

  await runtimeRef.start();
  trayInteractive = true;
  if (!isAgentMode) {
    void refreshTrayMenu();
    const snapshot = await runtimeRef.getAppSnapshot().catch(() => null);
    if (!snapshot || snapshot.onboardingStep < 5) {
      showMainWindow('onboarding');
    } else {
      hideMainWindow();
    }
  } else if (app.dock) {
    app.dock.hide();
  }

  app.on('activate', () => {
    if (!isAgentMode) {
      const currentRuntime = runtime;
      if (!currentRuntime) {
        showMainWindow('advanced');
        return;
      }
      void currentRuntime.getAppSnapshot()
        .then((snapshot) => {
          showMainWindow(snapshot.onboardingStep < 5 ? 'onboarding' : 'advanced');
        })
        .catch(() => {
          showMainWindow('advanced');
        });
    }
  });
}

void bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});

app.on('before-quit', () => {
  isQuitting = true;
  if (trayRefreshTimer) {
    clearInterval(trayRefreshTimer);
    trayRefreshTimer = null;
  }

  if (process.argv.includes('--relay')) {
    if (localRelayHandle) {
      void localRelayHandle.stop();
      localRelayHandle = null;
    }
    return;
  }
  if (!process.argv.includes('--agent')) {
    runtime?.stopManagedLocalRelayIfNeeded();
  }
  if (runtime) {
    void runtime.stop();
  }
});

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { app, BrowserWindow, ipcMain } from 'electron';
import WebSocket from 'ws';
import keytar from 'keytar';
import { startLocalRelay, type LocalRelayHandle } from './local-relay';
import {
  BridgeAgent,
  ConfigStore,
  LaunchdServiceManager,
  type ServiceStatus,
  type DeviceInboundEvent,
  type DeviceOutboundEvent,
  type PairingSession,
  type PairingStatus,
} from '@codex-bridge/bridge-core';

const KEYCHAIN_SERVICE = 'codex-bridge-desktop';
const KEYCHAIN_ACCOUNT = 'device-access-token';
const AGENT_LABEL = 'com.codex-bridge.agent';
const RELAY_LABEL = 'com.codex-bridge.relay';
const LOCAL_RELAY_BASE_URL = 'http://127.0.0.1:8787';
const LOCAL_RELAY_STORE_PATH = path.join(dataRoot(), 'data', 'local-relay-store.json');
const RELAY_CONFIG_PATH = path.join(dataRoot(), 'relay-config.json');
const LOCAL_RELAY_HOST = '127.0.0.1';
const LOCAL_RELAY_PORT = 8787;

type RelaySettings = {
  telegramBotToken: string;
  relayBotUsername: string;
};

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

function normalizeRelayBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, '');
  if (!normalized) {
    throw new Error('Relay 地址不能为空');
  }
  if (!/^https?:\/\//i.test(normalized)) {
    throw new Error('Relay 地址必须以 http:// 或 https:// 开头');
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
  private inMemoryDeviceToken: string | null = null;

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

  private async resolveDeviceToken(): Promise<string | null> {
    try {
      const fromKeychain = await keytar.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
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
    try {
      await keytar.setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, restored);
    } catch {
      // Keep running with in-memory fallback token.
    }
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
  }

  async stop(): Promise<void> {
    await this.relay.disconnect();
    await this.agent.stop();
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
    return next;
  }

  private resolveRelayRuntimeEnv(): Record<string, string> {
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

  setRelayBaseUrl(relayBaseUrl: string) {
    const normalized = normalizeRelayBaseUrl(relayBaseUrl);
    this.configStore.update((cfg) => ({ ...cfg, relayBaseUrl: normalized }));
    return this.configStore.load();
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
        throw new Error(
          `当前远程地址不可达（${primaryBase}）。本地服务回退失败：${fallbackMessage}。原始错误：${primaryMessage}`,
        );
      }
    }
  }

  async checkRelayHealth() {
    const cfg = this.configStore.load();
    const baseUrl = cfg.relayBaseUrl.replace(/\/$/, '');
    const health = await httpJson<{
      ok: boolean;
      relayBaseUrl?: string;
      websocketClients?: number;
      telegramEnabled?: boolean;
    }>(`${baseUrl}/healthz`);
    return {
      ...health,
      targetBaseUrl: baseUrl,
      checkedAt: Date.now(),
    };
  }

  async getHealth() {
    return await this.agent.getHealth();
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

  async clearPairing() {
    this.inMemoryDeviceToken = null;
    try {
      await keytar.deletePassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    } catch {
      // ignore keychain delete failures
    }
    await this.relay.disconnect();
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
      return this.launchdManager.status();
    }

    if (action === 'start') {
      this.launchdManager.start();
      return this.launchdManager.status();
    }

    if (action === 'stop') {
      this.launchdManager.stop();
      return this.launchdManager.status();
    }

    if (action === 'restart') {
      this.launchdManager.restart();
      return this.launchdManager.status();
    }

    if (action === 'uninstall') {
      this.launchdManager.uninstall();
      return this.launchdManager.status();
    }

    return this.launchdManager.status();
  }

  async reconnectRelay() {
    await this.relay.reconnectNow();
  }
}

let mainWindow: BrowserWindow | null = null;
const runtime = new DesktopRuntime();
let localRelayHandle: LocalRelayHandle | null = null;
const isRelayProcess = process.argv.includes('--relay');
const isAgentProcess = process.argv.includes('--agent');
const requiresSingleInstanceLock = !isRelayProcess && !isAgentProcess;
const singleInstanceLock = requiresSingleInstanceLock ? app.requestSingleInstanceLock() : true;

if (!singleInstanceLock) {
  app.quit();
}

function createMainWindow() {
  const preloadPath = path.join(__dirname, 'preload.js');
  mainWindow = new BrowserWindow({
    width: 1140,
    height: 760,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0f1624',
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

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function registerIpcHandlers() {
  ipcMain.handle('ipc.getConfig', async () => runtime.getConfig());
  ipcMain.handle('ipc.getRelaySettings', async () => runtime.getRelaySettings());
  ipcMain.handle('ipc.setRelaySettings', async (_evt, relaySettings: Partial<RelaySettings>) => runtime.setRelaySettings(relaySettings));
  ipcMain.handle('ipc.setRelayBaseUrl', async (_evt, relayBaseUrl: string) => runtime.setRelayBaseUrl(relayBaseUrl));
  ipcMain.handle('ipc.checkRelayHealth', async () => await runtime.checkRelayHealth());
  ipcMain.handle('ipc.getHealth', async () => await runtime.getHealth());
  ipcMain.handle('ipc.startPairing', async () => await runtime.startPairing());
  ipcMain.handle('ipc.checkPairingStatus', async (_evt, pairingSessionId: string) => await runtime.checkPairingStatus(pairingSessionId));
  ipcMain.handle('ipc.listThreads', async () => await runtime.listThreads());
  ipcMain.handle('ipc.bindThread', async (_evt, threadId: string) => await runtime.bindThread(threadId));
  ipcMain.handle('ipc.getCurrentStatus', async () => await runtime.getCurrentStatus());
  ipcMain.handle('ipc.serviceControl', async (_evt, action: 'install' | 'start' | 'stop' | 'restart' | 'status' | 'uninstall') => runtime.serviceControl(action));
  ipcMain.handle('ipc.getRelayServiceStatus', async () => runtime.relayServiceStatus());
  ipcMain.handle('ipc.repairLocalRelay', async () => runtime.repairManagedLocalRelay());
  ipcMain.handle('ipc.clearPairing', async () => await runtime.clearPairing());
  ipcMain.handle('ipc.reconnectRelay', async () => await runtime.reconnectRelay());
}

async function bootstrap() {
  if (!singleInstanceLock) {
    return;
  }

  if (requiresSingleInstanceLock) {
    app.on('second-instance', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) {
          mainWindow.restore();
        }
        mainWindow.focus();
      }
    });
  }

  await app.whenReady();
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
    });
    if (app.dock) {
      app.dock.hide();
    }
    return;
  }

  await registerIpcHandlers();

  if (!isAgentMode) {
    runtime.startManagedLocalRelayIfNeeded();
  }

  await runtime.start();
  if (!isAgentMode) {
    createMainWindow();
  } else if (app.dock) {
    app.dock.hide();
  }

  app.on('activate', () => {
    if (!isAgentMode && BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });

  app.on('window-all-closed', () => {
    if (!isAgentMode) {
      app.quit();
    }
  });
}

void bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});

app.on('before-quit', () => {
  if (process.argv.includes('--relay')) {
    if (localRelayHandle) {
      void localRelayHandle.stop();
      localRelayHandle = null;
    }
    return;
  }
  if (!process.argv.includes('--agent')) {
    runtime.stopManagedLocalRelayIfNeeded();
  }
  void runtime.stop();
});

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import { z } from 'zod';
import { localeText, normalizeLocale, type BridgeLocale } from '@codex-bridge/bridge-core';

interface PairingSession {
  id: string;
  deviceId: string;
  code: string;
  status: 'pending' | 'confirmed' | 'expired';
  expiresAt: number;
  createdAt: number;
  confirmedAt?: number;
  deviceAccessToken?: string;
  telegramUserId?: string;
  telegramChatId?: string;
}

interface DeviceBinding {
  deviceId: string;
  telegramUserId: string;
  telegramChatId: string;
  deviceAccessToken: string;
  createdAt: number;
}

interface IncomingImageAttachment {
  kind: 'localImage';
  path: string;
  mimeType?: string;
}

interface IncomingUserMessageEvent {
  type: 'incomingUserMessage';
  chatId: string;
  messageId: string;
  text: string;
  images?: IncomingImageAttachment[];
  createdAt: number;
}

type ControlCommandName = 'threads' | 'bind' | 'status' | 'current' | 'active' | 'detail' | 'usage' | 'unbind' | 'cancel' | 'help';

interface IncomingControlCommandEvent {
  type: 'incomingControlCommand';
  chatId: string;
  messageId: string;
  command: ControlCommandName;
  args?: string;
  source?: 'message' | 'callback';
  createdAt: number;
}

interface ApprovalDecisionEvent {
  type: 'approvalDecision';
  approvalId: string;
  allow: boolean;
  createdAt: number;
}

interface ExecutionStatusEvent {
  type: 'executionStatus';
  chatId: string;
  messageId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  text?: string;
  createdAt: number;
}

interface FinalResponseEvent {
  type: 'finalResponse';
  chatId: string;
  messageId: string;
  text: string;
  purpose?: 'turn' | 'command';
  options?: {
    replyMarkup?: Record<string, unknown>;
    parseMode?: 'HTML' | 'MarkdownV2';
    disableNotification?: boolean;
  };
  createdAt: number;
}

interface ApprovalRequestEvent {
  type: 'approvalRequest';
  chatId: string;
  messageId: string;
  approvalId: string;
  summary: string;
  createdAt: number;
}

type DeviceInboundEvent = IncomingUserMessageEvent | IncomingControlCommandEvent | ApprovalDecisionEvent;
type DeviceOutboundEvent = ExecutionStatusEvent | FinalResponseEvent | ApprovalRequestEvent;

const PAIRING_TTL_MS = 5 * 60 * 1000;
const TELEGRAM_TEXT_LIMIT = 3800;
const TELEGRAM_MEDIA_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const TELEGRAM_MEDIA_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

function splitTelegramText(text: string, limit = TELEGRAM_TEXT_LIMIT): string[] {
  const normalized = (text || '').trim();
  if (!normalized) {
    return [''];
  }

  const parts: string[] = [];
  let cursor = normalized;

  while (cursor.length > limit) {
    let cut = cursor.lastIndexOf('\n', limit);
    if (cut < Math.floor(limit * 0.6)) {
      cut = cursor.lastIndexOf(' ', limit);
    }
    if (cut < Math.floor(limit * 0.4)) {
      cut = limit;
    }
    parts.push(cursor.slice(0, cut).trim());
    cursor = cursor.slice(cut).trimStart();
  }

  if (cursor) {
    parts.push(cursor);
  }
  return parts;
}

function inferImageMimeType(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') {
    return 'image/jpeg';
  }
  if (ext === '.png') {
    return 'image/png';
  }
  if (ext === '.webp') {
    return 'image/webp';
  }
  if (ext === '.gif') {
    return 'image/gif';
  }
  if (ext === '.bmp') {
    return 'image/bmp';
  }
  return undefined;
}

function pickLargestTelegramPhoto(
  items: Array<{ file_id: string; file_size?: number }>,
): { file_id: string; file_size?: number } | null {
  if (!Array.isArray(items) || items.length === 0) {
    return null;
  }
  const sorted = [...items].sort((a, b) => (Number(b.file_size || 0) - Number(a.file_size || 0)));
  return sorted[0] || null;
}

class RelayStore {
  private readonly persistPath: string;
  private readonly sessions = new Map<string, PairingSession>();
  private readonly bindingsByDevice = new Map<string, DeviceBinding>();
  private readonly bindingsByToken = new Map<string, DeviceBinding>();
  private readonly bindingsByChat = new Map<string, DeviceBinding>();
  private readonly approvalToDevice = new Map<string, string>();

  constructor(persistPath: string) {
    this.persistPath = persistPath;
    this.loadBindings();
  }

  private loadBindings(): void {
    if (!fs.existsSync(this.persistPath)) {
      return;
    }
    try {
      const raw = fs.readFileSync(this.persistPath, 'utf8');
      const parsed = JSON.parse(raw) as { bindings?: DeviceBinding[] };
      const rows = Array.isArray(parsed?.bindings) ? parsed.bindings : [];
      for (const row of rows) {
        if (!row?.deviceId || !row?.deviceAccessToken || !row?.telegramChatId || !row?.telegramUserId) {
          continue;
        }
        this.bindingsByDevice.set(row.deviceId, row);
        this.bindingsByToken.set(row.deviceAccessToken, row);
        this.bindingsByChat.set(row.telegramChatId, row);
      }
    } catch {
      // Ignore corrupted persisted bindings and start fresh.
    }
  }

  private saveBindings(): void {
    const rows = Array.from(this.bindingsByDevice.values());
    fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
    fs.writeFileSync(this.persistPath, JSON.stringify({ bindings: rows }, null, 2), { mode: 0o600 });
  }

  createPairingSession(deviceId: string): PairingSession {
    const id = randomUUID();
    const code = String(randomInt(100000, 999999));
    const now = Date.now();
    const session: PairingSession = {
      id,
      deviceId,
      code,
      status: 'pending',
      createdAt: now,
      expiresAt: now + PAIRING_TTL_MS,
    };
    this.sessions.set(id, session);
    return session;
  }

  getPairingSession(id: string): PairingSession | null {
    const session = this.sessions.get(id);
    if (!session) {
      return null;
    }
    if (session.status === 'pending' && session.expiresAt < Date.now()) {
      session.status = 'expired';
    }
    return session;
  }

  confirmPairing(input: {
    pairingSessionId: string;
    code: string;
    telegramUserId: string;
    telegramChatId: string;
  }): PairingSession {
    const session = this.getPairingSession(input.pairingSessionId);
    if (!session) {
      throw new Error('pairing session not found');
    }
    if (session.status !== 'pending') {
      throw new Error(`pairing session not pending (${session.status})`);
    }
    if (session.expiresAt < Date.now()) {
      session.status = 'expired';
      throw new Error('pairing session expired');
    }
    if (session.code !== input.code) {
      throw new Error('invalid pairing code');
    }

    const token = randomBytes(24).toString('base64url');
    session.status = 'confirmed';
    session.confirmedAt = Date.now();
    session.telegramUserId = input.telegramUserId;
    session.telegramChatId = input.telegramChatId;
    session.deviceAccessToken = token;

    const binding: DeviceBinding = {
      deviceId: session.deviceId,
      telegramUserId: input.telegramUserId,
      telegramChatId: input.telegramChatId,
      deviceAccessToken: token,
      createdAt: Date.now(),
    };

    this.bindingsByDevice.set(binding.deviceId, binding);
    this.bindingsByToken.set(binding.deviceAccessToken, binding);
    this.bindingsByChat.set(binding.telegramChatId, binding);
    this.saveBindings();

    return session;
  }

  getBindingByToken(token: string): DeviceBinding | null {
    return this.bindingsByToken.get(token) || null;
  }

  getBindingByChat(chatId: string): DeviceBinding | null {
    return this.bindingsByChat.get(chatId) || null;
  }

  trackApproval(approvalId: string, deviceId: string): void {
    this.approvalToDevice.set(approvalId, deviceId);
  }

  getApprovalDevice(approvalId: string): string | null {
    return this.approvalToDevice.get(approvalId) || null;
  }
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: {
    id: string;
    data?: string;
    from?: { id: number };
    message?: {
      message_id: number;
      chat: { id: number; type: string };
    };
  };
}

interface TelegramMessage {
  message_id: number;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  from?: { id: number; username?: string };
  chat: { id: number; type: string };
}

interface TelegramPhotoSize {
  file_id: string;
  file_size?: number;
}

class TelegramBotClient {
  private readonly token: string;
  private readonly logger: FastifyBaseLogger;
  private readonly baseUrl: string;
  private readonly fileBaseUrl: string;

  constructor(token: string, logger: FastifyBaseLogger) {
    this.token = token;
    this.logger = logger;
    this.baseUrl = `https://api.telegram.org/bot${this.token}`;
    this.fileBaseUrl = `https://api.telegram.org/file/bot${this.token}`;
  }

  async getMe(): Promise<{ username?: string }> {
    return await this.request('getMe', {});
  }

  async deleteWebhook(dropPendingUpdates = false): Promise<void> {
    await this.request('deleteWebhook', {
      drop_pending_updates: dropPendingUpdates,
    });
  }

  async setMyCommands(commands: Array<{ command: string; description: string }>): Promise<void> {
    await this.request('setMyCommands', { commands });
  }

  async getUpdates(offset: number | null, timeoutSeconds = 25): Promise<TelegramUpdate[]> {
    const payload: Record<string, unknown> = {
      timeout: timeoutSeconds,
      allowed_updates: ['message', 'callback_query'],
    };
    if (offset != null) {
      payload.offset = offset;
    }
    return await this.request('getUpdates', payload);
  }

  async getFile(fileId: string): Promise<{ file_id?: string; file_path?: string }> {
    return await this.request('getFile', {
      file_id: fileId,
    });
  }

  async downloadFile(filePath: string): Promise<Buffer> {
    const normalized = String(filePath || '').replace(/^\/+/, '');
    if (!normalized) {
      throw new Error('empty telegram file path');
    }
    const res = await fetch(`${this.fileBaseUrl}/${normalized}`);
    if (!res.ok) {
      throw new Error(`Telegram file HTTP ${res.status}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async sendMessage(
    chatId: string,
    text: string,
    options?: {
      replyMarkup?: Record<string, unknown>;
      parseMode?: 'HTML' | 'MarkdownV2';
      disableNotification?: boolean;
    },
  ): Promise<void> {
    const chunks = splitTelegramText(text);
    for (const [index, chunk] of chunks.entries()) {
      const payload: Record<string, unknown> = {
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: true,
      };
      if (index === 0 && options?.replyMarkup) {
        payload.reply_markup = options.replyMarkup;
      }
      if (options?.parseMode) {
        payload.parse_mode = options.parseMode;
      }
      if (options?.disableNotification) {
        payload.disable_notification = true;
      }
      await this.request('sendMessage', payload);
    }
  }

  async sendChatAction(chatId: string, action: 'typing' = 'typing'): Promise<void> {
    await this.request('sendChatAction', {
      chat_id: chatId,
      action,
    });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    const payload: Record<string, unknown> = {
      callback_query_id: callbackQueryId,
    };
    if (text && text.trim()) {
      payload.text = text.trim();
    }
    await this.request('answerCallbackQuery', payload);
  }

  private async request(method: string, payload: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${this.baseUrl}/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`Telegram API HTTP ${res.status} for ${method}`);
    }

    const data = await res.json();
    if (!data.ok) {
      throw new Error(`Telegram API error for ${method}: ${data.description || 'unknown'}`);
    }
    return data.result;
  }

  startPolling(handlers: {
    onMessage: (msg: {
      chatId: string;
      text: string;
      fromUserId: string;
      messageId: string;
      photoFileId?: string;
    }) => Promise<void>;
    onCallbackQuery: (query: { id: string; chatId: string; fromUserId: string; data: string; messageId: string }) => Promise<void>;
  }): () => void {
    let running = true;
    let offset: number | null = null;

    const loop = async () => {
      while (running) {
        try {
          const updates = await this.getUpdates(offset, 25);
          for (const update of updates) {
            offset = update.update_id + 1;
            const message = update.message;
            if (message && message.from) {
              const text = (message.text || message.caption || '').trim();
              const largestPhoto = pickLargestTelegramPhoto(Array.isArray(message.photo) ? message.photo : []);
              if (!text && !largestPhoto) {
                continue;
              }
              await handlers.onMessage({
                chatId: String(message.chat.id),
                text,
                fromUserId: String(message.from.id),
                messageId: String(message.message_id),
                photoFileId: largestPhoto?.file_id,
              });
            }

            const callback = update.callback_query;
            if (callback && callback.data && callback.message?.chat?.id && callback.from?.id) {
              await handlers.onCallbackQuery({
                id: callback.id,
                chatId: String(callback.message.chat.id),
                fromUserId: String(callback.from.id),
                data: String(callback.data),
                messageId: String(callback.message.message_id),
              });
            }
          }
        } catch (error: any) {
          const message = error?.message || String(error);
          if (message.includes('HTTP 409')) {
            this.logger.error({ err: error }, 'Telegram polling conflict (another bot instance/webhook may be active)');
            try {
              await this.deleteWebhook(false);
              this.logger.warn('Issued deleteWebhook to recover Telegram polling conflict');
            } catch (recoveryError: any) {
              this.logger.error(
                { err: recoveryError },
                'Failed to recover Telegram polling conflict via deleteWebhook',
              );
            }
          } else {
            this.logger.error({ err: error }, 'Telegram polling loop error');
          }
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      }
    };

    void loop();

    return () => {
      running = false;
    };
  }
}

function buildPairingDeepLink(botUsername: string, pairingSessionId: string, code: string): string {
  return `https://t.me/${botUsername}?start=pair_${pairingSessionId}_${code}`;
}

function buildPairingStartCommand(pairingSessionId: string, code: string): string {
  return `/start pair_${pairingSessionId}_${code}`;
}

function parseSupportedCommand(rawText: string): { command: ControlCommandName; args: string } | null {
  const match = rawText.trim().match(/^\/([a-zA-Z]+)(?:@[\w_]+)?(?:\s+([\s\S]*))?$/);
  if (!match) {
    return null;
  }

  const name = String(match[1] || '').toLowerCase();
  const args = String(match[2] || '').trim();
  if (name === 'threads') {
    return { command: 'threads', args };
  }
  if (name === 'bind') {
    return { command: 'bind', args };
  }
  if (name === 'status') {
    return { command: 'status', args };
  }
  if (name === 'current') {
    return { command: 'current', args };
  }
  if (name === 'active') {
    return { command: 'active', args };
  }
  if (name === 'detail') {
    return { command: 'detail', args };
  }
  if (name === 'usage' || name === 'limits') {
    return { command: 'usage', args };
  }
  if (name === 'unbind') {
    return { command: 'unbind', args };
  }
  if (name === 'cancel' || name === 'cancal' || name === 'stop' || name === 'abort') {
    return { command: 'cancel', args };
  }
  if (name === 'help' || name === 'menu') {
    return { command: 'help', args };
  }
  if (name === 'start') {
    return { command: 'help', args };
  }
  return null;
}

function parseCallbackCommand(data: string): { command: ControlCommandName; args: string } | null {
  const value = (data || '').trim();
  if (!value) {
    return null;
  }
  if (value === 'threads') {
    return { command: 'threads', args: '' };
  }
  if (value === 'bind_latest') {
    return { command: 'bind', args: 'latest' };
  }
  if (value === 'status') {
    return { command: 'status', args: '' };
  }
  if (value === 'current') {
    return { command: 'current', args: '' };
  }
  if (value === 'active') {
    return { command: 'active', args: '' };
  }
  if (value === 'usage') {
    return { command: 'usage', args: '' };
  }
  if (value === 'unbind') {
    return { command: 'unbind', args: '' };
  }
  if (value === 'cancel') {
    return { command: 'cancel', args: '' };
  }
  if (value.startsWith('bind_thread:')) {
    return { command: 'bind', args: value.slice('bind_thread:'.length).trim() };
  }
  if (value.startsWith('bind_idx:')) {
    return { command: 'bind', args: value.slice('bind_idx:'.length).trim() };
  }
  return null;
}

function buildMainReplyKeyboard(): Record<string, unknown> {
  return {
    keyboard: [
      [{ text: '/threads' }, { text: '/bind latest' }],
      [{ text: '/usage' }, { text: '/status' }],
      [{ text: '/active' }, { text: '/current' }],
      [{ text: '/detail' }, { text: '/cancel' }],
      [{ text: '/unbind' }],
    ],
    resize_keyboard: true,
  };
}

export interface LocalRelayStartOptions {
  host: string;
  port: number;
  relayBaseUrl: string;
  persistPath: string;
  telegramBotToken?: string;
  relayBotUsername?: string;
  locale?: BridgeLocale;
}

export interface LocalRelayHandle {
  stop: () => Promise<void>;
}

export async function startLocalRelay(options: LocalRelayStartOptions): Promise<LocalRelayHandle> {
  const locale = normalizeLocale(options.locale || process.env.BRIDGE_LOCALE);
  const t = (zh: string, en: string) => localeText(locale, zh, en);
  const relayStore = new RelayStore(options.persistPath);
  const wsByDeviceId = new Map<string, { send: (payload: string) => void; close: () => void }>();
  const typingIntervals = new Map<string, NodeJS.Timeout>();
  const app: FastifyInstance = Fastify({ logger: true });
  const configuredRelayBotUsername = (options.relayBotUsername || '').trim();
  let activeRelayBotUsername = configuredRelayBotUsername || 'codexbridge_official_bot';
  const telegramBotToken = options.telegramBotToken || '';
  const telegramMediaDir = path.join(path.dirname(options.persistPath), 'telegram-media');
  let lastMediaCleanupAt = 0;

  let telegramBot: TelegramBotClient | null = null;
  let stopPolling: (() => void) | null = null;

  async function sendTelegramMessage(
    chatId: string,
    text: string,
    options?: {
      replyMarkup?: Record<string, unknown>;
      parseMode?: 'HTML' | 'MarkdownV2';
      disableNotification?: boolean;
    },
  ): Promise<void> {
    if (!telegramBot) {
      app.log.info({ chatId, text }, 'Telegram token not configured, message only logged');
      return;
    }
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await telegramBot.sendMessage(chatId, text, options);
        return;
      } catch (error: any) {
        const shouldRetry = attempt < maxAttempts;
        app.log.error(
          {
            err: error,
            chatId,
            attempt,
            maxAttempts,
          },
          shouldRetry ? 'Failed to send Telegram message, retrying' : 'Failed to send Telegram message',
        );
        if (!shouldRetry) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 600 * attempt));
      }
    }
  }

  function cleanupTelegramMediaDir(): void {
    const now = Date.now();
    if (now - lastMediaCleanupAt < TELEGRAM_MEDIA_CLEANUP_INTERVAL_MS) {
      return;
    }
    lastMediaCleanupAt = now;
    try {
      if (!fs.existsSync(telegramMediaDir)) {
        return;
      }
      const entries = fs.readdirSync(telegramMediaDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) {
          continue;
        }
        const filePath = path.join(telegramMediaDir, entry.name);
        try {
          const stat = fs.statSync(filePath);
          if (now - stat.mtimeMs > TELEGRAM_MEDIA_MAX_AGE_MS) {
            fs.rmSync(filePath, { force: true });
          }
        } catch {
          // ignore per-file cleanup errors
        }
      }
    } catch {
      // ignore cleanup errors
    }
  }

  async function downloadTelegramPhotoAsLocalAttachment(photoFileId: string): Promise<IncomingImageAttachment | null> {
    if (!telegramBot) {
      return null;
    }
    const file = await telegramBot.getFile(photoFileId);
    const filePath = String(file.file_path || '').trim();
    if (!filePath) {
      throw new Error('Telegram getFile returned empty file_path');
    }
    const bytes = await telegramBot.downloadFile(filePath);
    fs.mkdirSync(telegramMediaDir, { recursive: true });
    cleanupTelegramMediaDir();

    const ext = path.extname(filePath) || '.jpg';
    const filename = `tg_${Date.now()}_${randomUUID()}${ext}`;
    const localPath = path.join(telegramMediaDir, filename);
    fs.writeFileSync(localPath, bytes, { mode: 0o600 });
    return {
      kind: 'localImage',
      path: localPath,
      mimeType: inferImageMimeType(filePath),
    };
  }

  function typingKey(chatId: string, messageId: string): string {
    return `${chatId}:${messageId}`;
  }

  function stopTypingIndicator(chatId: string, messageId: string): void {
    const key = typingKey(chatId, messageId);
    const timer = typingIntervals.get(key);
    if (!timer) {
      return;
    }
    clearInterval(timer);
    typingIntervals.delete(key);
  }

  function startTypingIndicator(chatId: string, messageId: string): void {
    if (!telegramBot) {
      return;
    }
    const key = typingKey(chatId, messageId);
    if (typingIntervals.has(key)) {
      return;
    }

    const tick = async () => {
      if (!telegramBot) {
        return;
      }
      try {
        await telegramBot.sendChatAction(chatId, 'typing');
      } catch (error: any) {
        app.log.debug({ err: error, chatId, messageId }, 'Failed to send Telegram typing action');
      }
    };

    void tick();
    const timer = setInterval(() => {
      void tick();
    }, 4500);
    timer.unref();
    typingIntervals.set(key, timer);
  }

  function sendToDevice(deviceId: string, event: DeviceInboundEvent): boolean {
    const ws = wsByDeviceId.get(deviceId);
    if (!ws) {
      return false;
    }
    ws.send(JSON.stringify(event));
    return true;
  }

  function handleDeviceOutbound(deviceId: string, event: DeviceOutboundEvent): void {
    app.log.info(
      {
        deviceId,
        eventType: event.type,
        chatId: (event as { chatId?: string }).chatId,
        purpose: event.type === 'finalResponse' ? (event as FinalResponseEvent).purpose || 'turn' : undefined,
        textPreview:
          event.type === 'finalResponse'
            ? String((event as FinalResponseEvent).text || '').slice(0, 120)
            : event.type === 'executionStatus'
              ? String((event as ExecutionStatusEvent).text || '').slice(0, 120)
              : undefined,
      },
      'Received outbound event from device',
    );

    if (event.type === 'approvalRequest') {
      relayStore.trackApproval(event.approvalId, deviceId);
      void sendTelegramMessage(
        event.chatId,
        [
          t('⚠️ 需要审批', '⚠️ Approval required'),
          `ID: ${event.approvalId}`,
          event.summary,
          t(
            `可回复 /approve ${event.approvalId} 或 /deny ${event.approvalId}`,
            `Reply /approve ${event.approvalId} or /deny ${event.approvalId}`,
          ),
        ].join('\n'),
      );
      return;
    }

    if (event.type === 'executionStatus') {
      const statusText = (event.text || '').trim();
      if (event.status === 'running') {
        startTypingIndicator(event.chatId, event.messageId);
        if (!statusText || /^(仍在处理中|still processing)/i.test(statusText)) {
          return;
        }
        void sendTelegramMessage(event.chatId, `⏳ ${statusText}`);
        return;
      }

      stopTypingIndicator(event.chatId, event.messageId);
      if (event.status === 'queued' && statusText) {
        void sendTelegramMessage(event.chatId, `⏳ ${statusText}`);
      }
      return;
    }

    if (event.type === 'finalResponse') {
      stopTypingIndicator(event.chatId, event.messageId);
      const purpose = event.purpose || 'turn';
      if (purpose === 'command') {
        void sendTelegramMessage(event.chatId, event.text, event.options);
        return;
      }

      const failureText = event.text.trim();
      const isFailure = /^(执行失败|execution failed)[:：]?/i.test(failureText) || /app-server stopped/i.test(failureText);
      if (isFailure) {
        const needsCodexHint = /network stream disconnected|runtime unresponsive|app-server stopped|app-server exited/i.test(failureText);
        const decoratedFailure = needsCodexHint
          ? `${failureText}\n\n${t('建议：请确认 Codex App 已打开且在线，然后重试。', 'Tip: make sure Codex App is open and online, then retry.')}`
          : failureText;
        void sendTelegramMessage(event.chatId, `❌ ${decoratedFailure}`, {
          replyMarkup: buildMainReplyKeyboard(),
        });
      } else {
        void sendTelegramMessage(event.chatId, `${t('✅ 已完成', '✅ Completed')}\n\n${event.text}`, {
          replyMarkup: buildMainReplyKeyboard(),
        });
      }
    }
  }

  await app.register(cors, {
    origin: true,
  });
  await app.register(websocket);

  app.get('/healthz', async () => {
    return {
      ok: true,
      relayBaseUrl: options.relayBaseUrl,
      websocketClients: wsByDeviceId.size,
      telegramEnabled: !!telegramBot,
      botUsername: activeRelayBotUsername,
    };
  });

  app.post('/v1/pairing/sessions', async (request, reply) => {
    if (!telegramBot) {
      return reply.status(503).send({
        error: 'telegram relay bot not ready, please retry in a few seconds',
      });
    }

    const bodySchema = z.object({
      deviceId: z.string().uuid().optional(),
    });
    const body = bodySchema.safeParse(request.body || {});
    if (!body.success) {
      return reply.status(400).send({ error: body.error.message });
    }

    const deviceId = body.data.deviceId || randomUUID();
    const session = relayStore.createPairingSession(deviceId);
    const qrPayload = buildPairingDeepLink(activeRelayBotUsername, session.id, session.code);
    const startCommand = buildPairingStartCommand(session.id, session.code);

    return {
      pairingSessionId: session.id,
      deviceId: session.deviceId,
      expiresAt: session.expiresAt,
      qrPayload,
      startCommand,
      botUsername: activeRelayBotUsername,
      pollUrl: `${options.relayBaseUrl}/v1/pairing/sessions/${session.id}`,
      debugCode: process.env.NODE_ENV === 'production' ? undefined : session.code,
    };
  });

  app.get('/v1/pairing/sessions/:id', async (request, reply) => {
    const params = z.object({ id: z.string() }).safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: params.error.message });
    }

    const session = relayStore.getPairingSession(params.data.id);
    if (!session) {
      return reply.status(404).send({ error: 'pairing session not found' });
    }

    return {
      pairingSessionId: session.id,
      status: session.status,
      expiresAt: session.expiresAt,
      deviceAccessToken: session.status === 'confirmed' ? session.deviceAccessToken : undefined,
    };
  });

  app.post('/v1/pairing/sessions/:id/confirm', async (request, reply) => {
    const params = z.object({ id: z.string() }).safeParse(request.params);
    const body = z.object({
      code: z.string().min(6),
      telegramUserId: z.string(),
      telegramChatId: z.string(),
    }).safeParse(request.body || {});

    if (!params.success) {
      return reply.status(400).send({ error: params.error.message });
    }
    if (!body.success) {
      return reply.status(400).send({ error: body.error.message });
    }

    try {
      const session = relayStore.confirmPairing({
        pairingSessionId: params.data.id,
        code: body.data.code,
        telegramUserId: body.data.telegramUserId,
        telegramChatId: body.data.telegramChatId,
      });

      await sendTelegramMessage(body.data.telegramChatId, t('✅ 配对成功，设备已绑定。', '✅ Pairing successful, device is now bound.'));

      return {
        pairingSessionId: session.id,
        status: session.status,
        deviceId: session.deviceId,
        deviceAccessToken: session.deviceAccessToken,
      };
    } catch (error: any) {
      return reply.status(400).send({ error: error?.message || String(error) });
    }
  });

  app.get('/v1/devices/me', async (request, reply) => {
    const auth = request.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
    if (!token) {
      return reply.status(401).send({ error: 'missing bearer token' });
    }

    const binding = relayStore.getBindingByToken(token);
    if (!binding) {
      return reply.status(401).send({ error: 'invalid token' });
    }

    return {
      deviceId: binding.deviceId,
      telegramUserId: binding.telegramUserId,
      telegramChatId: binding.telegramChatId,
      connected: wsByDeviceId.has(binding.deviceId),
    };
  });

  app.get('/v1/devices/stream', { websocket: true }, (socket, req) => {
    const query = req.query as Record<string, string | undefined>;
    const token = query.token || '';
    const binding = relayStore.getBindingByToken(token);

    if (!binding) {
      socket.close(4001, 'invalid token');
      return;
    }

    wsByDeviceId.set(binding.deviceId, {
      send: (payload) => socket.send(payload),
      close: () => socket.close(),
    });

    socket.send(JSON.stringify({
      type: 'hello',
      deviceId: binding.deviceId,
      serverTime: Date.now(),
    }));

    socket.on('message', (raw: Buffer) => {
      try {
        const parsed = JSON.parse(raw.toString('utf8')) as DeviceOutboundEvent;
        handleDeviceOutbound(binding.deviceId, parsed);
      } catch (error: any) {
        app.log.warn({ err: error }, 'Invalid outbound device event');
      }
    });

    socket.on('close', () => {
      wsByDeviceId.delete(binding.deviceId);
    });
  });

  app.post('/v1/bot/incoming', async (request, reply) => {
    const body = z.object({
      telegramChatId: z.string(),
      text: z.string().optional(),
      images: z.array(z.object({
        kind: z.literal('localImage'),
        path: z.string().min(1),
        mimeType: z.string().optional(),
      })).optional(),
      messageId: z.string().optional(),
    }).superRefine((value, ctx) => {
      const hasText = !!String(value.text || '').trim();
      const hasImages = Array.isArray(value.images) && value.images.length > 0;
      if (!hasText && !hasImages) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'text or images is required',
          path: ['text'],
        });
      }
    }).safeParse(request.body || {});

    if (!body.success) {
      return reply.status(400).send({ error: body.error.message });
    }

    const binding = relayStore.getBindingByChat(body.data.telegramChatId);
    if (!binding) {
      return reply.status(404).send({ error: 'chat is not bound to any device' });
    }

    const messageId = body.data.messageId || randomUUID();
    const text = String(body.data.text || '').trim();
    const images = (Array.isArray(body.data.images) ? body.data.images : [])
      .map((item) => ({
        kind: item.kind,
        path: String(item.path || '').trim(),
        mimeType: item.mimeType ? String(item.mimeType).trim() : undefined,
      }))
      .filter((item) => item.kind === 'localImage' && !!item.path);
    const commandInfo = images.length === 0 ? parseSupportedCommand(text) : null;
    const event: DeviceInboundEvent = commandInfo
      ? {
          type: 'incomingControlCommand',
          chatId: body.data.telegramChatId,
          messageId,
          command: commandInfo.command,
          args: commandInfo.args,
          source: 'message',
          createdAt: Date.now(),
        }
      : {
          type: 'incomingUserMessage',
          chatId: body.data.telegramChatId,
          messageId,
          text,
          images: images.length > 0 ? images : undefined,
          createdAt: Date.now(),
        };

    app.log.info(
      {
        chatId: body.data.telegramChatId,
        textPreview: text.slice(0, 120),
        imageCount: images.length,
        recognizedCommand: commandInfo?.command || null,
      },
      'Received synthetic bot incoming event',
    );

    const sent = sendToDevice(binding.deviceId, event);
    return {
      delivered: sent,
      deviceId: binding.deviceId,
    };
  });

  await app.listen({ host: options.host, port: options.port });
  app.log.info({ host: options.host, port: options.port }, 'Codex Bridge local relay started');

  if (telegramBotToken) {
    telegramBot = new TelegramBotClient(telegramBotToken, app.log);
    try {
      await telegramBot.deleteWebhook(false);
      const me = await telegramBot.getMe();
      if (me.username) {
        if (configuredRelayBotUsername && configuredRelayBotUsername !== me.username) {
          app.log.warn(
            { configured: configuredRelayBotUsername, actual: me.username },
            'RELAY_BOT_USERNAME does not match Telegram token owner; using token owner for pairing links',
          );
        }
        activeRelayBotUsername = me.username;
      }
      app.log.info({ bot: me.username || activeRelayBotUsername }, 'Telegram relay bot enabled');
    } catch (error: any) {
      app.log.error(
        {
          err: error,
          fallbackBotUsername: activeRelayBotUsername,
        },
        'Failed to initialize Telegram metadata, will continue with polling retry',
      );
    }

    stopPolling = telegramBot.startPolling({
      onMessage: async (msg) => {
        const text = msg.text.trim();
        const images: IncomingImageAttachment[] = [];
        if (msg.photoFileId) {
          try {
            const attachment = await downloadTelegramPhotoAsLocalAttachment(msg.photoFileId);
            if (attachment) {
              images.push(attachment);
            }
          } catch (error: any) {
            app.log.error(
              {
                err: error,
                chatId: msg.chatId,
                messageId: msg.messageId,
                photoFileId: msg.photoFileId,
              },
              'Failed to fetch Telegram photo',
            );
            if (!text) {
              await telegramBot!.sendMessage(msg.chatId, t('❌ 图片下载失败，请稍后重试。', '❌ Failed to download image. Please try again.'));
              return;
            }
          }
        }
        const commandInfo = images.length === 0 ? parseSupportedCommand(text) : null;
        app.log.info(
          {
            chatId: msg.chatId,
            messageId: msg.messageId,
            textPreview: text.slice(0, 120),
            hasPhoto: !!msg.photoFileId,
            imageCount: images.length,
            recognizedCommand: commandInfo?.command || null,
          },
          'Received Telegram message update',
        );

        if (images.length === 0 && text.startsWith('/start pair_')) {
          const token = text.replace('/start ', '').trim();
          const [, pairingSessionId, code] = token.match(/^pair_([^_]+)_(\d{6})$/) || [];
          if (!pairingSessionId || !code) {
            await telegramBot!.sendMessage(msg.chatId, t('配对链接无效。请回到桌面端重新生成二维码。', 'Invalid pairing link. Please regenerate QR code from desktop app.'));
            return;
          }

          try {
            relayStore.confirmPairing({
              pairingSessionId,
              code,
              telegramUserId: msg.fromUserId,
              telegramChatId: msg.chatId,
            });
            await telegramBot!.sendMessage(msg.chatId, t('✅ 配对成功，现在可以直接发消息远程操作 Codex。', '✅ Pairing successful. You can now send messages to control Codex remotely.'));
          } catch (error: any) {
            await telegramBot!.sendMessage(msg.chatId, `${t('❌ 配对失败：', '❌ Pairing failed: ')}${error?.message || String(error)}`);
          }
          return;
        }

        if (images.length === 0 && text === '/start') {
          const existingBinding = relayStore.getBindingByChat(msg.chatId);
          if (!existingBinding) {
            await telegramBot!.sendMessage(
              msg.chatId,
              t('请在桌面端点击“开始配对”，然后扫码或发送配对指令。', 'Please click \"Start pairing\" in desktop app, then scan QR or send pairing command.'),
              { replyMarkup: buildMainReplyKeyboard() },
            );
            return;
          }
          const sent = sendToDevice(existingBinding.deviceId, {
            type: 'incomingControlCommand',
            chatId: msg.chatId,
            messageId: msg.messageId,
            command: 'help',
            args: '',
            source: 'message',
            createdAt: Date.now(),
          });
          if (!sent) {
            await telegramBot!.sendMessage(msg.chatId, t('设备当前离线，请确认桌面端已打开。', 'Device is offline. Please make sure desktop app is open.'), {
              replyMarkup: buildMainReplyKeyboard(),
            });
          }
          return;
        }

        if (images.length === 0 && (text.startsWith('/approve ') || text.startsWith('/deny '))) {
          const allow = text.startsWith('/approve ');
          const approvalId = text.split(/\s+/)[1] || '';
          if (!approvalId) {
            await telegramBot!.sendMessage(msg.chatId, t('用法：/approve <approvalId> 或 /deny <approvalId>', 'Usage: /approve <approvalId> or /deny <approvalId>'));
            return;
          }

          const deviceId = relayStore.getApprovalDevice(approvalId);
          if (!deviceId) {
            await telegramBot!.sendMessage(msg.chatId, `${t('未找到审批单：', 'Approval not found: ')}${approvalId}`);
            return;
          }

          const sent = sendToDevice(deviceId, {
            type: 'approvalDecision',
            approvalId,
            allow,
            createdAt: Date.now(),
          });

          await telegramBot!.sendMessage(
            msg.chatId,
            sent
              ? `${t('已提交审批：', 'Approval submitted: ')}${approvalId}`
              : `${t('设备离线，审批提交失败：', 'Device offline, failed to submit approval: ')}${approvalId}`,
          );
          return;
        }

        if (!text && images.length === 0) {
          return;
        }

        const binding = relayStore.getBindingByChat(msg.chatId);
        if (!binding) {
          await telegramBot!.sendMessage(msg.chatId, t('当前未绑定设备，请先在桌面端点击“开始配对”并扫码。', 'No device is bound yet. Please click \"Start pairing\" in desktop app and scan QR.'), {
            replyMarkup: buildMainReplyKeyboard(),
          });
          return;
        }

        if (commandInfo) {
          const sent = sendToDevice(binding.deviceId, {
            type: 'incomingControlCommand',
            chatId: msg.chatId,
            messageId: msg.messageId,
            command: commandInfo.command,
            args: commandInfo.args,
            source: 'message',
            createdAt: Date.now(),
          });
          if (!sent) {
            await telegramBot!.sendMessage(msg.chatId, t('设备当前离线，请确认桌面端已打开。', 'Device is offline. Please make sure desktop app is open.'), {
              replyMarkup: buildMainReplyKeyboard(),
            });
          }
          return;
        }

        const sent = sendToDevice(binding.deviceId, {
          type: 'incomingUserMessage',
          chatId: msg.chatId,
          messageId: msg.messageId,
          text,
          images: images.length > 0 ? images : undefined,
          createdAt: Date.now(),
        });

        if (!sent) {
          await telegramBot!.sendMessage(msg.chatId, t('设备当前离线，请确认桌面端已打开。', 'Device is offline. Please make sure desktop app is open.'), {
            replyMarkup: buildMainReplyKeyboard(),
          });
        }
      },
      onCallbackQuery: async (query) => {
        const data = query.data.trim();
        app.log.info(
          {
            chatId: query.chatId,
            messageId: query.messageId,
            callbackId: query.id,
            callbackData: data.slice(0, 120),
          },
          'Received Telegram callback query',
        );
        if (!data) {
          await telegramBot!.answerCallbackQuery(query.id);
          return;
        }

        if (data.startsWith('approve:') || data.startsWith('deny:')) {
          const allow = data.startsWith('approve:');
          const approvalId = data.slice(data.indexOf(':') + 1).trim();
          if (!approvalId) {
            await telegramBot!.answerCallbackQuery(query.id, t('审批单无效', 'Invalid approval id'));
            return;
          }
          const deviceId = relayStore.getApprovalDevice(approvalId);
          if (!deviceId) {
            await telegramBot!.answerCallbackQuery(query.id, t('审批单不存在', 'Approval not found'));
            return;
          }
          const sent = sendToDevice(deviceId, {
            type: 'approvalDecision',
            approvalId,
            allow,
            createdAt: Date.now(),
          });
          await telegramBot!.answerCallbackQuery(query.id, sent ? t('已提交', 'Submitted') : t('设备离线', 'Device offline'));
          return;
        }

        const binding = relayStore.getBindingByChat(query.chatId);
        if (!binding) {
          await telegramBot!.answerCallbackQuery(query.id, t('当前未绑定设备', 'No device bound'));
          return;
        }

        const mapped = parseCallbackCommand(data);
        if (!mapped) {
          await telegramBot!.answerCallbackQuery(query.id, t('暂不支持该按钮', 'Unsupported button'));
          return;
        }

        await telegramBot!.answerCallbackQuery(query.id, t('处理中…', 'Processing...'));
        const sent = sendToDevice(binding.deviceId, {
          type: 'incomingControlCommand',
          chatId: query.chatId,
          messageId: query.messageId,
          command: mapped.command,
          args: mapped.args,
          source: 'callback',
          createdAt: Date.now(),
        });
        if (!sent) {
          await telegramBot!.sendMessage(query.chatId, t('设备当前离线，请确认桌面端已打开。', 'Device is offline. Please make sure desktop app is open.'), {
            replyMarkup: buildMainReplyKeyboard(),
          });
        }
      },
    });

    try {
      await telegramBot.setMyCommands([
        { command: 'threads', description: t('查看最近会话并快速绑定', 'List recent threads and bind quickly') },
        { command: 'bind', description: t('绑定会话（/bind latest 或 /bind <id>）', 'Bind a thread (/bind latest or /bind <id>)') },
        { command: 'usage', description: t('查询 Codex 剩余用量', 'Show Codex usage limits') },
        { command: 'limits', description: t('查询 Codex 剩余用量（别名）', 'Show Codex usage limits (alias)') },
        { command: 'current', description: t('查看当前会话快照', 'Show current thread snapshot') },
        { command: 'active', description: t('查看当前会话标题', 'Show active thread title') },
        { command: 'detail', description: t('查看会话详情（来源/ID/CWD）', 'Show thread details (source/ID/CWD)') },
        { command: 'status', description: t('查看连接与运行状态', 'Show runtime and connection status') },
        { command: 'cancel', description: t('终止当前任务并清空排队', 'Cancel current task and clear queue') },
        { command: 'unbind', description: t('解绑当前会话', 'Unbind current thread') },
        { command: 'help', description: t('显示菜单与按钮', 'Show menu and buttons') },
      ]);
    } catch (error: any) {
      app.log.warn({ err: error }, 'Failed to set Telegram bot commands');
    }
  } else {
    app.log.warn('TELEGRAM_BOT_TOKEN not configured; relay bot disabled');
  }

  return {
    stop: async () => {
      stopPolling?.();
      for (const timer of typingIntervals.values()) {
        clearInterval(timer);
      }
      typingIntervals.clear();
      for (const ws of wsByDeviceId.values()) {
        ws.close();
      }
      wsByDeviceId.clear();
      await app.close();
    },
  };
}

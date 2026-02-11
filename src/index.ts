import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { loadConfig, type BridgeConfig } from './config';
import { createLogger, type Logger } from './logger';
import { BridgeDb } from './db';
import { TelegramClient } from './telegram';
import { CodexAppServerClient } from './codex-app-server';
import { ThreadRuntimeManager } from './runtime-manager';
import { nowMs, sanitizePreview, sleep, truncate } from './utils';
import type {
  ApprovalRequestEvent,
  PendingApproval,
  RemoteBinding,
  TelegramCallbackQuery,
  TelegramMessage,
  TelegramUpdate,
  ThreadListItem,
} from './types';

function toEpochMs(input: number): number {
  if (!Number.isFinite(input) || input <= 0) {
    return 0;
  }
  if (input < 10_000_000_000) {
    return Math.floor(input * 1000);
  }
  return Math.floor(input);
}

function formatLocalTime(epochMs: number): string {
  if (!epochMs) {
    return '-';
  }
  return new Date(epochMs).toLocaleString();
}

function normalizeCommandName(token: string): string {
  const base = token.startsWith('/') ? token.slice(1) : token;
  const atIndex = base.indexOf('@');
  if (atIndex >= 0) {
    return base.slice(0, atIndex).toLowerCase();
  }
  return base.toLowerCase();
}

function escapeTelegramText(text: string): string {
  return text.replace(/\u0000/g, '');
}

function escapeTelegramHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function compactText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function sourceLabel(source: string): string {
  if (!source) {
    return 'unknown';
  }
  return source;
}

function sourceFromBindingMode(mode: string): string {
  if (!mode) {
    return 'unknown';
  }
  if (mode.startsWith('thread:')) {
    const source = mode.slice('thread:'.length).trim();
    return source || 'unknown';
  }
  return 'unknown';
}

const THREAD_CACHE_TTL_MS = 10 * 60 * 1000;
const GLOBAL_STATE_CACHE_TTL_MS = 15_000;
const CODEX_GLOBAL_STATE_PATH = process.env.CODEX_GLOBAL_STATE_PATH
  || (process.env.HOME ? path.join(process.env.HOME, '.codex', '.codex-global-state.json') : '');

interface CodexSidebarMetadata {
  titleByThreadId: Map<string, string>;
  orderByThreadId: Map<string, number>;
  workspaceRoots: string[];
  workspaceLabelByRoot: Map<string, string>;
}

interface DisplayThreadItem {
  thread: ThreadListItem;
  title: string;
  group: string;
}

interface DisplayThreadsState {
  displayItems: DisplayThreadItem[];
  currentBinding: RemoteBinding | null;
  sidebarMetadata: CodexSidebarMetadata;
  mergedCount: number;
  hiddenCount: number;
  usingSidebarVisibility: boolean;
}

interface CodexSidebarMetadataCache {
  loadedAt: number;
  mtimeMs: number;
  data: CodexSidebarMetadata;
}

let codexSidebarMetadataCache: CodexSidebarMetadataCache | null = null;

function buildMainReplyKeyboard(): Record<string, unknown> {
  return {
    keyboard: [
      [{ text: '/threads' }, { text: '/bind latest' }],
      [{ text: '/active' }, { text: '/current' }],
      [{ text: '/detail' }, { text: '/status' }],
      [{ text: '/unbind' }],
    ],
    resize_keyboard: true,
  };
}

function normalizeTopicForKey(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 80);
}

function basenameLabel(inputPath: string): string {
  if (!inputPath) {
    return '';
  }
  const normalized = inputPath.replace(/[\\/]+$/, '');
  if (!normalized) {
    return '';
  }
  const base = path.basename(normalized);
  return base || normalized;
}

function inferThreadTopic(preview: string, fallbackIndex: number): string {
  const normalized = compactText(preview || '');
  if (!normalized) {
    return `会话 ${fallbackIndex + 1}`;
  }

  const keywordRules: Array<{ pattern: RegExp; title: string }> = [
    { pattern: /(telegram|clawdbot|远程|手机).*(codex|app)/i, title: 'Telegram 远程控制 Codex' },
    { pattern: /(优化|改进).*(ios app|展示|交互)/i, title: 'iOS 展示交互优化' },
    { pattern: /(readme|项目).*(了解|信息|基本)/i, title: '项目基础信息梳理' },
    { pattern: /(ios app).*(后端|服务).*(infohub|资讯)/i, title: 'InfoHub 项目全貌梳理' },
    { pattern: /(拍照|抠图|单词卡|swift ui|swiftui)/i, title: 'iOS 拍照抠图单词卡' },
    { pattern: /^(你好|hello|hi)$/i, title: '问候 / 快速测试' },
  ];

  for (const rule of keywordRules) {
    if (rule.pattern.test(normalized)) {
      return rule.title;
    }
  }

  let cleaned = normalized
    .replace(/^(我想要做一个能力(?:，|,)?(?:希望能)?)/, '')
    .replace(/^(我想要|我想|我们来|请你|请|帮我|这是一个|这是|通过|给我|希望能|希望|先|现在|能不能|可不可以)/, '')
    .trim();

  cleaned = cleaned
    .replace(/(你了解现在的情况吗|你调研下.*|可以吗|好吗)[。！？?]*$/u, '')
    .trim();

  const parts = cleaned
    .split(/[，。！？；:：]/u)
    .map((part) => compactText(part))
    .filter(Boolean);
  const topic = parts.find((part) => part.length >= 4) || cleaned;
  return truncate(topic || `会话 ${fallbackIndex + 1}`, 18);
}

function loadCodexSidebarMetadata(logger?: Logger): CodexSidebarMetadata {
  const empty: CodexSidebarMetadata = {
    titleByThreadId: new Map(),
    orderByThreadId: new Map(),
    workspaceRoots: [],
    workspaceLabelByRoot: new Map(),
  };
  if (!CODEX_GLOBAL_STATE_PATH) {
    return empty;
  }

  try {
    const stat = fs.statSync(CODEX_GLOBAL_STATE_PATH);
    const now = nowMs();
    if (
      codexSidebarMetadataCache
      && codexSidebarMetadataCache.mtimeMs === stat.mtimeMs
      && now - codexSidebarMetadataCache.loadedAt <= GLOBAL_STATE_CACHE_TTL_MS
    ) {
      return codexSidebarMetadataCache.data;
    }

    const parsed = JSON.parse(fs.readFileSync(CODEX_GLOBAL_STATE_PATH, 'utf8')) as unknown;
    if (!isRecord(parsed)) {
      return empty;
    }

    const titleByThreadId = new Map<string, string>();
    const orderByThreadId = new Map<string, number>();
    const workspaceLabelByRoot = new Map<string, string>();

    const threadTitlesNode = isRecord(parsed['thread-titles']) ? parsed['thread-titles'] : null;
    const titlesNode = threadTitlesNode && isRecord(threadTitlesNode.titles)
      ? threadTitlesNode.titles
      : null;
    if (titlesNode) {
      for (const [threadId, title] of Object.entries(titlesNode)) {
        if (typeof threadId === 'string' && typeof title === 'string') {
          const normalizedTitle = compactText(title);
          if (threadId && normalizedTitle) {
            titleByThreadId.set(threadId, normalizedTitle);
          }
        }
      }
    }

    const orderNode = threadTitlesNode && Array.isArray(threadTitlesNode.order)
      ? threadTitlesNode.order
      : [];
    orderNode.forEach((threadId, index) => {
      if (typeof threadId === 'string' && threadId && !orderByThreadId.has(threadId)) {
        orderByThreadId.set(threadId, index);
      }
    });

    const workspaceRootsRaw = Array.isArray(parsed['electron-saved-workspace-roots'])
      ? parsed['electron-saved-workspace-roots']
      : [];
    const workspaceRoots = workspaceRootsRaw
      .filter((item): item is string => typeof item === 'string' && !!item.trim())
      .map((item) => item.trim())
      .sort((a, b) => b.length - a.length);

    const workspaceLabelsNode = isRecord(parsed['electron-workspace-root-labels'])
      ? parsed['electron-workspace-root-labels']
      : null;
    if (workspaceLabelsNode) {
      for (const [root, label] of Object.entries(workspaceLabelsNode)) {
        if (typeof root === 'string' && typeof label === 'string') {
          const normalizedLabel = compactText(label);
          if (root && normalizedLabel) {
            workspaceLabelByRoot.set(root, normalizedLabel);
          }
        }
      }
    }

    const data: CodexSidebarMetadata = {
      titleByThreadId,
      orderByThreadId,
      workspaceRoots,
      workspaceLabelByRoot,
    };
    codexSidebarMetadataCache = {
      loadedAt: now,
      mtimeMs: stat.mtimeMs,
      data,
    };
    return data;
  } catch (error: any) {
    logger?.warn('Failed to load Codex sidebar metadata', {
      path: CODEX_GLOBAL_STATE_PATH,
      error: error?.message || String(error),
    });
    return empty;
  }
}

function resolveThreadGroup(thread: ThreadListItem, metadata: CodexSidebarMetadata): string {
  const cwd = (thread.cwd || '').trim();
  if (cwd) {
    for (const root of metadata.workspaceRoots) {
      if (cwd === root || cwd.startsWith(`${root}/`)) {
        const custom = metadata.workspaceLabelByRoot.get(root);
        return custom || basenameLabel(root) || root;
      }
    }
    return basenameLabel(cwd) || cwd;
  }
  return thread.source === 'cli' ? 'CLI' : '其他';
}

function resolveThreadTitle(
  thread: ThreadListItem,
  index: number,
  metadata: CodexSidebarMetadata,
): string {
  const fromCodex = metadata.titleByThreadId.get(thread.id);
  if (fromCodex) {
    return fromCodex;
  }
  return inferThreadTopic(thread.preview || '', index);
}

function pickPreferredThread(
  current: DisplayThreadItem,
  candidate: DisplayThreadItem,
  currentThreadId: string | null,
  metadata: CodexSidebarMetadata,
): DisplayThreadItem {
  const currentIsActive = !!currentThreadId && current.thread.id === currentThreadId;
  const candidateIsActive = !!currentThreadId && candidate.thread.id === currentThreadId;
  if (candidateIsActive && !currentIsActive) {
    return candidate;
  }
  if (currentIsActive && !candidateIsActive) {
    return current;
  }

  const currentOrder = metadata.orderByThreadId.get(current.thread.id);
  const candidateOrder = metadata.orderByThreadId.get(candidate.thread.id);
  if (typeof candidateOrder === 'number' && typeof currentOrder === 'number') {
    if (candidateOrder < currentOrder) {
      return candidate;
    }
    if (currentOrder < candidateOrder) {
      return current;
    }
  } else if (typeof candidateOrder === 'number' && typeof currentOrder !== 'number') {
    return candidate;
  } else if (typeof currentOrder === 'number' && typeof candidateOrder !== 'number') {
    return current;
  }

  return toEpochMs(candidate.thread.updatedAt) > toEpochMs(current.thread.updatedAt)
    ? candidate
    : current;
}

function buildThreadButtonTitle(item: DisplayThreadItem, index: number, isCurrent: boolean): string {
  const title = truncate(compactText(item.title || `会话 ${index + 1}`), 24);
  return `${isCurrent ? '✅ ' : ''}🧵 ${title}`;
}

function buildThreadsInlineKeyboard(
  items: DisplayThreadItem[],
  currentThreadId: string | null,
): Record<string, unknown> {
  const inlineRows: Array<Array<{ text: string; callback_data: string }>> = [];

  items.forEach((item, index) => {
    const isCurrent = currentThreadId === item.thread.id;
    inlineRows.push([
      {
        text: buildThreadButtonTitle(item, index, isCurrent),
        callback_data: `bind_thread:${item.thread.id}`,
      },
    ]);
  });

  inlineRows.push([{ text: '🔄 刷新会话列表', callback_data: 'threads' }]);

  return {
    inline_keyboard: inlineRows,
  };
}

function dedupeThreadsForDisplay(
  threads: ThreadListItem[],
  currentThreadId: string | null,
  metadata: CodexSidebarMetadata,
): { items: DisplayThreadItem[]; mergedCount: number } {
  const dedupedById = new Map<string, ThreadListItem>();
  for (const thread of threads) {
    const existing = dedupedById.get(thread.id);
    if (!existing || toEpochMs(thread.updatedAt) > toEpochMs(existing.updatedAt)) {
      dedupedById.set(thread.id, thread);
    }
  }

  const threadsByTime = Array.from(dedupedById.values()).sort(
    (a, b) => {
      const aOrder = metadata.orderByThreadId.get(a.id);
      const bOrder = metadata.orderByThreadId.get(b.id);
      if (typeof aOrder === 'number' && typeof bOrder === 'number' && aOrder !== bOrder) {
        return aOrder - bOrder;
      }
      if (typeof aOrder === 'number' && typeof bOrder !== 'number') {
        return -1;
      }
      if (typeof bOrder === 'number' && typeof aOrder !== 'number') {
        return 1;
      }
      return toEpochMs(b.updatedAt) - toEpochMs(a.updatedAt);
    },
  );

  const mergedByTopic = new Map<string, DisplayThreadItem>();
  let mergedCount = threads.length - threadsByTime.length;

  for (let index = 0; index < threadsByTime.length; index += 1) {
    const thread = threadsByTime[index];
    const title = resolveThreadTitle(thread, index, metadata);
    const group = resolveThreadGroup(thread, metadata);
    const signature = `${group}|${thread.source}|${normalizeTopicForKey(title)}`;
    const existing = mergedByTopic.get(signature);
    const current: DisplayThreadItem = {
      thread,
      title,
      group,
    };

    if (!existing) {
      mergedByTopic.set(signature, current);
      continue;
    }

    mergedCount += 1;
    mergedByTopic.set(
      signature,
      pickPreferredThread(existing, current, currentThreadId, metadata),
    );
  }

  const items = Array.from(mergedByTopic.values()).sort((a, b) => {
    const aOrder = metadata.orderByThreadId.get(a.thread.id);
    const bOrder = metadata.orderByThreadId.get(b.thread.id);
    if (typeof aOrder === 'number' && typeof bOrder === 'number' && aOrder !== bOrder) {
      return aOrder - bOrder;
    }
    if (typeof aOrder === 'number' && typeof bOrder !== 'number') {
      return -1;
    }
    if (typeof bOrder === 'number' && typeof aOrder !== 'number') {
      return 1;
    }
    return toEpochMs(b.thread.updatedAt) - toEpochMs(a.thread.updatedAt);
  });

  const mergedByPreview = new Map<string, DisplayThreadItem>();
  for (const item of items) {
    const previewSig = normalizeTopicForKey(compactText(item.thread.preview || ''));
    const dedupeByPreview = previewSig.length >= 12;
    const previewKey = dedupeByPreview
      ? `${item.group}|${item.thread.source}|${previewSig}`
      : `id:${item.thread.id}`;
    const existing = mergedByPreview.get(previewKey);
    if (!existing) {
      mergedByPreview.set(previewKey, item);
      continue;
    }
    mergedCount += 1;
    mergedByPreview.set(
      previewKey,
      pickPreferredThread(existing, item, currentThreadId, metadata),
    );
  }

  const finalItems = Array.from(mergedByPreview.values()).sort((a, b) => {
    const aOrder = metadata.orderByThreadId.get(a.thread.id);
    const bOrder = metadata.orderByThreadId.get(b.thread.id);
    if (typeof aOrder === 'number' && typeof bOrder === 'number' && aOrder !== bOrder) {
      return aOrder - bOrder;
    }
    if (typeof aOrder === 'number' && typeof bOrder !== 'number') {
      return -1;
    }
    if (typeof bOrder === 'number' && typeof aOrder !== 'number') {
      return 1;
    }
    return toEpochMs(b.thread.updatedAt) - toEpochMs(a.thread.updatedAt);
  });

  return {
    items: finalItems,
    mergedCount,
  };
}

function filterThreadsBySidebarVisibility(
  threads: ThreadListItem[],
  metadata: CodexSidebarMetadata,
): { threads: ThreadListItem[]; hiddenCount: number; usingSidebarVisibility: boolean } {
  if (metadata.workspaceRoots.length === 0) {
    return {
      threads,
      hiddenCount: 0,
      usingSidebarVisibility: false,
    };
  }

  const visible = threads.filter((thread) => {
    const cwd = (thread.cwd || '').trim();
    if (!cwd) {
      return false;
    }
    return metadata.workspaceRoots.some((root) => cwd === root || cwd.startsWith(`${root}/`));
  });
  if (visible.length === 0) {
    // Fallback: when workspace metadata cannot be matched, keep original list to avoid hiding all sessions.
    return {
      threads,
      hiddenCount: 0,
      usingSidebarVisibility: false,
    };
  }

  return {
    threads: visible,
    hiddenCount: Math.max(0, threads.length - visible.length),
    usingSidebarVisibility: true,
  };
}

interface TurnConversationSummary {
  turnId: string;
  status: string;
  userText: string;
  assistantText: string;
}

interface ThreadConversationSnapshot {
  threadId: string;
  source: string;
  updatedAt: number;
  preview: string;
  lastUser: string;
  lastAssistant: string;
  recentTurns: TurnConversationSummary[];
  degraded?: boolean;
}

function extractUserTextFromItem(item: Record<string, unknown>): string {
  const content = Array.isArray(item.content) ? item.content : [];
  const parts: string[] = [];
  for (const contentPart of content) {
    if (!isRecord(contentPart)) {
      continue;
    }
    if (contentPart.type !== 'text') {
      continue;
    }
    const text = typeof contentPart.text === 'string' ? compactText(contentPart.text) : '';
    if (text) {
      parts.push(text);
    }
  }
  return parts.join(' ').trim();
}

function parseThreadConversationSnapshot(payload: unknown): ThreadConversationSnapshot | null {
  if (!isRecord(payload)) {
    return null;
  }
  const thread = isRecord(payload.thread) ? payload.thread : null;
  if (!thread) {
    return null;
  }
  const threadId = typeof thread.id === 'string' ? thread.id : '';
  if (!threadId) {
    return null;
  }

  const source = sourceLabel(typeof thread.source === 'string' ? thread.source : 'unknown');
  const updatedAt = Number(thread.updatedAt || 0);
  const preview = sanitizePreview(typeof thread.preview === 'string' ? thread.preview : '');
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const recentTurns: TurnConversationSummary[] = [];

  for (const rawTurn of turns.slice(-6)) {
    if (!isRecord(rawTurn)) {
      continue;
    }

    const turnId = typeof rawTurn.id === 'string' ? rawTurn.id : '(unknown-turn)';
    const status = typeof rawTurn.status === 'string' ? rawTurn.status : 'unknown';
    const items = Array.isArray(rawTurn.items) ? rawTurn.items : [];
    let userText = '';
    let assistantText = '';

    for (const rawItem of items) {
      if (!isRecord(rawItem)) {
        continue;
      }
      const type = typeof rawItem.type === 'string' ? rawItem.type : '';
      if (type === 'userMessage') {
        const text = extractUserTextFromItem(rawItem);
        if (text) {
          userText = userText ? `${userText} ${text}` : text;
        }
      } else if (type === 'agentMessage') {
        const text = typeof rawItem.text === 'string' ? compactText(rawItem.text) : '';
        if (text) {
          assistantText = assistantText ? `${assistantText} ${text}` : text;
        }
      }
    }

    if (userText || assistantText || status !== 'unknown') {
      recentTurns.push({
        turnId,
        status,
        userText: userText.trim(),
        assistantText: assistantText.trim(),
      });
    }
  }

  let lastUser = '';
  let lastAssistant = '';
  for (let index = recentTurns.length - 1; index >= 0; index -= 1) {
    const turn = recentTurns[index];
    if (!lastUser && turn.userText) {
      lastUser = turn.userText;
    }
    if (!lastAssistant && turn.assistantText) {
      lastAssistant = turn.assistantText;
    }
    if (lastUser && lastAssistant) {
      break;
    }
  }

  return {
    threadId,
    source,
    updatedAt,
    preview,
    lastUser,
    lastAssistant,
    recentTurns,
  };
}

function buildApprovalInlineKeyboard(approvalId: string): Record<string, unknown> {
  return {
    inline_keyboard: [
      [
        { text: '✅ 通过', callback_data: `approve:${approvalId}` },
        { text: '❌ 拒绝', callback_data: `deny:${approvalId}` },
      ],
    ],
  };
}

async function withTimeout<T>(task: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      task,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

class BridgeService {
  private readonly config: BridgeConfig;
  private readonly logger: Logger;
  private readonly db: BridgeDb;
  private readonly telegram: TelegramClient;
  private readonly runtimeManager: ThreadRuntimeManager;

  private controlClient: CodexAppServerClient | null = null;
  private controlClientInit: Promise<CodexAppServerClient> | null = null;
  private running = false;
  private pollOffset: number | null = null;
  private readonly rateWindow = new Map<string, { startedAt: number; count: number }>();
  private maintenanceTimer: NodeJS.Timeout | null = null;
  private readonly recentThreadsByChat = new Map<string, { threads: ThreadListItem[]; updatedAt: number }>();

  constructor(config: BridgeConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.db = new BridgeDb(config.dbPath, logger);
    this.telegram = new TelegramClient(config.telegramBotToken, logger);
    this.runtimeManager = new ThreadRuntimeManager({
      logger,
      codexBin: config.codexBin,
      requestTimeoutMs: config.requestTimeoutMs,
      fallbackModel: config.fallbackModel,
    });
    this.runtimeManager.setApprovalHandler((event) => {
      void this.onApprovalRequested(event);
    });
  }

  async start(): Promise<void> {
    this.running = true;

    const storedOffset = this.db.getState('telegram_offset');
    if (storedOffset) {
      const parsed = Number(storedOffset);
      if (Number.isFinite(parsed) && parsed > 0) {
        this.pollOffset = parsed;
      }
    }

    const staleCount = this.db.markAllActiveTurnsStale(nowMs());
    await this.notifyAndClearStaleTurns(staleCount > 0);
    await this.expireOrphanPendingApprovals();

    const control = await this.getControlClient();
    const models = await control.listModels();
    if (!models.includes(this.config.fallbackModel)) {
      this.logger.warn('Configured fallback model is not listed by app-server', {
        fallbackModel: this.config.fallbackModel,
        models,
      });
    } else {
      this.logger.info('Fallback model is available', {
        fallbackModel: this.config.fallbackModel,
      });
    }

    this.maintenanceTimer = setInterval(() => {
      void this.runMaintenance();
    }, 15_000);
    this.maintenanceTimer.unref();

    this.logger.info('Codex remote bridge started', {
      dbPath: this.config.dbPath,
      allowedChatIds: Array.from(this.config.allowedChatIds),
      fallbackModel: this.config.fallbackModel,
      pollOffset: this.pollOffset,
    });

    await this.pollLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }

    if (this.controlClient) {
      try {
        await this.controlClient.stop();
      } catch (error: any) {
        this.logger.warn('Failed to stop control app-server client', {
          error: error?.message || String(error),
        });
      }
      this.controlClient = null;
      this.controlClientInit = null;
    }

    await this.runtimeManager.stopAll();
    this.db.close();
    this.logger.info('Codex remote bridge stopped');
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.telegram.getUpdates(this.pollOffset, this.config.pollTimeoutSeconds);
        if (!updates || updates.length === 0) {
          continue;
        }

        for (const update of updates) {
          await this.processUpdate(update);
          const nextOffset = update.update_id + 1;
          this.pollOffset = nextOffset;
          this.db.setState('telegram_offset', String(nextOffset), nowMs());
        }
      } catch (error: any) {
        this.logger.error('Polling loop error', {
          error: error?.message || String(error),
        });
        await sleep(this.config.pollingBackoffMs);
      }
    }
  }

  private async processUpdate(update: TelegramUpdate): Promise<void> {
    const accepted = this.db.recordMessageUpdate(update.update_id, nowMs());
    if (!accepted) {
      return;
    }

    if (update.callback_query) {
      await this.processCallbackQuery(update.update_id, update.callback_query);
      return;
    }

    const message = update.message;
    if (!message || !message.text) {
      return;
    }

    const chatId = String(message.chat.id);
    if (!this.config.allowedChatIds.has(chatId)) {
      this.logger.warn('Ignored unauthorized chat message', {
        chatId,
        messageId: message.message_id,
      });
      return;
    }

    if (!this.allowRate(chatId)) {
      await this.safeSend(chatId, '⚠️ 发送太频繁，请稍后再试。');
      return;
    }

    const text = message.text.trim();
    if (!text) {
      return;
    }

    this.logger.info('Telegram message received', {
      chatId,
      messageId: message.message_id,
      updateId: update.update_id,
      text: truncate(text, 120),
    });

    try {
      if (text.startsWith('/')) {
        await this.handleCommand(chatId, message, text);
      } else {
        await this.handleAsk(chatId, text, message.message_id);
      }
    } catch (error: any) {
      this.logger.error('Failed to process message update', {
        chatId,
        updateId: update.update_id,
        messageId: message.message_id,
        error: error?.message || String(error),
      });
      await this.safeSend(chatId, `❌ 处理消息失败\\n${escapeTelegramText(error?.message || String(error))}`);
    }
  }

  private resolveAuthorizedChatIdForCallback(callback: TelegramCallbackQuery): string | null {
    const fromChatId = String(callback.from.id);
    if (this.config.allowedChatIds.has(fromChatId)) {
      return fromChatId;
    }
    const messageChatId = callback.message ? String(callback.message.chat.id) : '';
    if (messageChatId && this.config.allowedChatIds.has(messageChatId)) {
      return messageChatId;
    }
    return null;
  }

  private async processCallbackQuery(updateId: number, callback: TelegramCallbackQuery): Promise<void> {
    const chatId = this.resolveAuthorizedChatIdForCallback(callback);
    if (!chatId) {
      this.logger.warn('Ignored unauthorized callback query', {
        updateId,
        callbackId: callback.id,
        from: callback.from.id,
      });
      try {
        await this.telegram.answerCallbackQuery(callback.id, '无权限');
      } catch {
        // Ignore follow-up errors.
      }
      return;
    }

    if (!this.allowRate(chatId)) {
      try {
        await this.telegram.answerCallbackQuery(callback.id, '发送太频繁，请稍后');
      } catch {
        // Ignore follow-up errors.
      }
      return;
    }

    const data = (callback.data || '').trim();
    if (!data) {
      try {
        await this.telegram.answerCallbackQuery(callback.id);
      } catch {
        // Ignore follow-up errors.
      }
      return;
    }

    this.logger.info('Telegram callback received', {
      chatId,
      updateId,
      callbackId: callback.id,
      data: truncate(data, 120),
    });

    try {
      await this.telegram.answerCallbackQuery(callback.id, '处理中…');

      if (data === 'threads') {
        await this.handleThreads(chatId);
        return;
      }
      if (data === 'bind_latest') {
        await this.handleBind(chatId, 'latest', {
          fromInlineButton: true,
        });
        return;
      }
      if (data === 'status') {
        await this.handleStatus(chatId);
        return;
      }
      if (data === 'current') {
        await this.handleCurrent(chatId);
        return;
      }
      if (data === 'unbind') {
        this.db.deleteBinding(chatId);
        await this.safeSend(chatId, '已解绑当前会话。', {
          replyMarkup: buildMainReplyKeyboard(),
        });
        return;
      }
      if (data.startsWith('bind_thread:')) {
        const threadId = data.slice('bind_thread:'.length).trim();
        if (!threadId) {
          await this.safeSend(chatId, '按钮数据无效，请重新执行 /threads。');
          return;
        }
        await this.handleBind(chatId, threadId, {
          fromInlineButton: true,
        });
        return;
      }
      if (data.startsWith('bind_idx:')) {
        const idxRaw = data.slice('bind_idx:'.length);
        const idx = Number(idxRaw);
        if (!Number.isFinite(idx) || idx <= 0) {
          await this.safeSend(chatId, '按钮数据无效，请重新执行 /threads。');
          return;
        }
        await this.handleBind(chatId, String(Math.floor(idx)), {
          fromInlineButton: true,
        });
        return;
      }
      if (data.startsWith('approve:')) {
        await this.handleApprovalDecision(chatId, data.slice('approve:'.length), true);
        return;
      }
      if (data.startsWith('deny:')) {
        await this.handleApprovalDecision(chatId, data.slice('deny:'.length), false);
        return;
      }

      await this.safeSend(chatId, '暂不支持该按钮动作，请执行 /help。');
    } catch (error: any) {
      this.logger.error('Failed to process callback query', {
        chatId,
        updateId,
        callbackId: callback.id,
        data,
        error: error?.message || String(error),
      });
      await this.safeSend(chatId, `❌ 按钮处理失败\n${escapeTelegramText(error?.message || String(error))}`);
    }
  }

  private allowRate(chatId: string): boolean {
    const now = nowMs();
    const state = this.rateWindow.get(chatId);
    if (!state || now - state.startedAt >= 60_000) {
      this.rateWindow.set(chatId, {
        startedAt: now,
        count: 1,
      });
      return true;
    }

    if (state.count >= this.config.messageRateLimitPerMinute) {
      return false;
    }

    state.count += 1;
    return true;
  }

  private async handleCommand(chatId: string, message: TelegramMessage, raw: string): Promise<void> {
    const parts = raw.split(/\s+/);
    const commandToken = parts[0] || '';
    const args = raw.slice(commandToken.length).trim();
    const command = normalizeCommandName(commandToken);

    switch (command) {
      case 'threads':
        await this.handleThreads(chatId);
        return;
      case 'bind':
        await this.handleBind(chatId, args);
        return;
      case 'ask':
        if (!args) {
          await this.safeSend(chatId, '用法: /ask <消息内容>');
          return;
        }
        await this.handleAsk(chatId, args, message.message_id);
        return;
      case 'approve':
        await this.handleApprovalDecision(chatId, args, true);
        return;
      case 'deny':
        await this.handleApprovalDecision(chatId, args, false);
        return;
      case 'status':
        await this.handleStatus(chatId);
        return;
      case 'active':
        await this.handleActive(chatId);
        return;
      case 'current':
        await this.handleCurrent(chatId);
        return;
      case 'detail':
        await this.handleDetail(chatId, args);
        return;
      case 'unbind':
        this.db.deleteBinding(chatId);
        await this.safeSend(chatId, '已解绑当前会话。', {
          replyMarkup: buildMainReplyKeyboard(),
        });
        return;
      case 'menu':
      case 'help':
      case 'start':
        await this.sendHelp(chatId);
        return;
      default:
        await this.safeSend(chatId, `未知命令: /${command}。发送 /help 查看可用命令。`);
    }
  }

  private async sendHelp(chatId: string): Promise<void> {
    await this.safeSend(
      chatId,
      [
        '远程控制菜单（可直接点键盘按钮）：',
        '/threads - 查看最近会话（精简列表，支持编号绑定）',
        '/bind latest - 绑定最新会话',
        '/bind <threadId|编号> - 按 ID（或兼容旧编号）绑定',
        '/active - 快速查看当前正在对话的会话',
        '/detail <编号|threadId|current|latest> - 查看会话详情（来源/ID/CWD）',
        '/ask <内容> - 显式提问（直接发文本也可以）',
        '/current - 查看当前绑定会话的最近对话快照',
        '/status - 查看绑定与运行状态',
        '/unbind - 解除当前绑定',
        '/help - 再次显示菜单',
      ].join('\n'),
      {
        replyMarkup: buildMainReplyKeyboard(),
      },
    );
  }

  private buildDisplayThreadsState(chatId: string, threads: ThreadListItem[]): DisplayThreadsState {
    const currentBinding = this.db.getBinding(chatId);
    const sidebarMetadata = loadCodexSidebarMetadata(this.logger);
    const visibility = filterThreadsBySidebarVisibility(threads, sidebarMetadata);
    const deduped = dedupeThreadsForDisplay(
      visibility.threads,
      currentBinding?.threadId || null,
      sidebarMetadata,
    );

    return {
      displayItems: deduped.items,
      currentBinding,
      sidebarMetadata,
      mergedCount: deduped.mergedCount,
      hiddenCount: visibility.hiddenCount,
      usingSidebarVisibility: visibility.usingSidebarVisibility,
    };
  }

  private async handleThreads(chatId: string): Promise<void> {
    await this.safeSend(chatId, '正在获取最近会话列表…', {
      disableNotification: true,
    });

    const control = await this.getControlClient();
    const threads = await withTimeout(
      control.listThreads(this.config.maxThreadList),
      Math.min(this.config.requestTimeoutMs, 12_000),
      'thread/list',
    );

    if (threads.length === 0) {
      await this.safeSend(chatId, '当前没有可用会话。');
      return;
    }

    const state = this.buildDisplayThreadsState(chatId, threads);
    const displayItems = state.displayItems;
    if (displayItems.length === 0) {
      await this.safeSend(chatId, '当前没有可展示的会话。');
      return;
    }

    this.recentThreadsByChat.set(chatId, {
      threads: displayItems.map((item) => item.thread),
      updatedAt: nowMs(),
    });

    const lines: string[] = ['最近会话：'];
    const currentItem = state.currentBinding
      ? displayItems.find((item) => item.thread.id === state.currentBinding?.threadId) || null
      : null;
    if (currentItem) {
      lines.push(`当前会话: ✅ <b>${escapeTelegramHtml(currentItem.title)}</b>`);
    } else if (state.currentBinding) {
      lines.push('当前会话: ✅ <b>(已绑定，但不在最近列表)</b>');
    } else {
      lines.push('当前会话: (未绑定)');
    }
    lines.push('');

    let currentGroup = '';
    displayItems.forEach((item, index) => {
      const thread = item.thread;
      const isCurrent = state.currentBinding?.threadId === thread.id;
      if (item.group !== currentGroup) {
        currentGroup = item.group;
        lines.push(`<b>📁 ${escapeTelegramHtml(currentGroup)}</b>`);
      }
      lines.push(
        `${index + 1}. ${isCurrent ? '✅ ' : ''}<b>${escapeTelegramHtml(item.title)}</b>`,
      );
      lines.push(`   更新: ${escapeTelegramHtml(formatLocalTime(toEpochMs(thread.updatedAt)))}`);
    });
    if (state.mergedCount > 0) {
      lines.push(`已合并近似重复会话: ${state.mergedCount}`);
    }
    if (state.usingSidebarVisibility && state.hiddenCount > 0) {
      lines.push(`已过滤侧边栏不可见会话: ${state.hiddenCount}`);
    }
    lines.push('');
    lines.push('可用: /bind [编号] | /detail [编号] | /bind latest');
    lines.push('快速查看当前: /active');
    lines.push('提示: 详情信息（来源/ID/CWD）请用 /detail。');

    await this.safeSend(chatId, lines.join('\n'), {
      replyMarkup: buildThreadsInlineKeyboard(displayItems, state.currentBinding?.threadId || null),
      parseMode: 'HTML',
    });
  }

  private getCachedThreads(chatId: string): ThreadListItem[] | null {
    const cached = this.recentThreadsByChat.get(chatId);
    if (!cached) {
      return null;
    }
    if (nowMs() - cached.updatedAt > THREAD_CACHE_TTL_MS) {
      this.recentThreadsByChat.delete(chatId);
      return null;
    }
    return cached.threads;
  }

  private pickPreferredLatestThread(threads: ThreadListItem[]): ThreadListItem | null {
    if (threads.length === 0) {
      return null;
    }

    const preferred = threads.find((thread) => thread.source === 'vscode' || thread.source === 'appServer');
    return preferred || threads[0];
  }

  private async handleBind(
    chatId: string,
    argRaw: string,
    options?: { fromInlineButton?: boolean },
  ): Promise<void> {
    const fromInlineButton = !!options?.fromInlineButton;
    const arg = argRaw.trim();
    if (!arg) {
      await this.safeSend(chatId, '用法: /bind latest 或 /bind <threadId|编号>');
      return;
    }

    const control = await this.getControlClient();
    let targetThreadId = arg;
    let visibleThreads: ThreadListItem[] | null = null;
    let usingSidebarVisibility = false;
    let sidebarMetadata: CodexSidebarMetadata | null = null;

    if (arg === 'latest') {
      const latest = await control.listThreads(this.config.maxThreadList);
      sidebarMetadata = loadCodexSidebarMetadata(this.logger);
      const visibility = filterThreadsBySidebarVisibility(latest, sidebarMetadata);
      visibleThreads = visibility.threads;
      usingSidebarVisibility = visibility.usingSidebarVisibility;
      const deduped = dedupeThreadsForDisplay(
        visibleThreads,
        this.db.getBinding(chatId)?.threadId || null,
        sidebarMetadata,
      );
      const preferred = this.pickPreferredLatestThread(deduped.items.map((item) => item.thread));
      if (!preferred) {
        await this.safeSend(chatId, '没有可绑定的会话。');
        return;
      }
      targetThreadId = preferred.id;
    } else if (/^\d+$/.test(arg)) {
      const index = Number(arg);
      const cached = this.getCachedThreads(chatId);
      if (!cached || cached.length === 0) {
        await this.safeSend(chatId, '最近会话缓存已过期，请先执行 /threads。');
        return;
      }
      if (!Number.isFinite(index) || index <= 0 || index > cached.length) {
        await this.safeSend(chatId, `编号无效，请输入 1 到 ${cached.length}。`);
        return;
      }
      targetThreadId = cached[index - 1].id;
    }

    if (fromInlineButton) {
      if (!visibleThreads || !sidebarMetadata) {
        const latest = await control.listThreads(this.config.maxThreadList);
        sidebarMetadata = loadCodexSidebarMetadata(this.logger);
        const visibility = filterThreadsBySidebarVisibility(latest, sidebarMetadata);
        visibleThreads = visibility.threads;
        usingSidebarVisibility = visibility.usingSidebarVisibility;
      }

      if (usingSidebarVisibility && visibleThreads && !visibleThreads.some((thread) => thread.id === targetThreadId)) {
        await this.safeSend(chatId, '该会话在 Codex 侧边栏已删除或隐藏，请先执行 /threads 刷新列表。', {
          replyMarkup: buildMainReplyKeyboard(),
        });
        return;
      }
    }

    let readResult: Awaited<ReturnType<CodexAppServerClient['readThread']>> | null = null;
    try {
      readResult = await withTimeout(
        control.readThread(targetThreadId),
        Math.min(this.config.requestTimeoutMs, 12_000),
        'thread/read(bind)',
      );
      if (readResult && !readResult.thread?.id) {
        await this.safeSend(chatId, `绑定失败：无法读取线程 ${targetThreadId}`);
        return;
      }
    } catch (error: any) {
      this.logger.warn('Bind metadata read failed; proceeding with optimistic bind', {
        threadId: targetThreadId,
        error: error?.message || String(error),
      });
    }

    void this.runtimeManager.getOrCreate(targetThreadId).catch((error: any) => {
      this.logger.warn('Deferred runtime warmup failed after /bind', {
        threadId: targetThreadId,
        error: error?.message || String(error),
      });
    });
    const source = sourceLabel(String(readResult?.thread?.source || 'unknown'));
    this.db.saveBinding(chatId, targetThreadId, `thread:${source}`, nowMs());

    const preview = sanitizePreview(String(readResult?.thread?.preview || ''));
    await this.safeSend(
      chatId,
      [
        `已绑定线程: ${targetThreadId}`,
        `来源: ${source}`,
        preview ? `预览: ${truncate(preview, 160)}` : null,
        !readResult ? '提示: 元数据读取超时，已先完成绑定；首次消息会自动继续。' : null,
        source === 'cli' ? '提示: 该线程来源为 cli，在 Codex App 中可能不显示实时更新。' : null,
        '可用: /current 查看当前会话快照',
      ]
        .filter(Boolean)
        .join('\n'),
      {
        replyMarkup: buildMainReplyKeyboard(),
      },
    );
  }

  private async handleAsk(chatId: string, text: string, replyToMessageId?: number): Promise<void> {
    const binding = this.db.getBinding(chatId);
    if (!binding) {
      await this.safeSend(chatId, '当前未绑定会话，请先执行 /threads 然后 /bind。', {
        replyToMessageId,
        replyMarkup: buildMainReplyKeyboard(),
      });
      return;
    }

    const active = this.db.getActiveTurn(binding.threadId);
    if (active && (active.status === 'running' || active.status === 'queued')) {
      if (active.queuedText) {
        await this.safeSend(chatId, '当前已有排队消息，请等待当前与排队任务完成后再发。', {
          replyToMessageId,
        });
        return;
      }

      this.db.upsertActiveTurn({
        threadId: binding.threadId,
        chatId,
        turnId: active.turnId,
        status: active.status,
        queuedText: text,
        startedAt: active.startedAt,
        updatedAt: nowMs(),
      });
      await this.safeSend(chatId, '当前正在处理中，已将该消息加入队列。', {
        replyToMessageId,
      });
      return;
    }

    void this.executeTurn(chatId, binding.threadId, text, replyToMessageId);
  }

  private async executeTurn(chatId: string, threadId: string, text: string, replyToMessageId?: number): Promise<void> {
    const startAt = nowMs();
    const binding = this.db.getBinding(chatId);
    let bindingSource = binding && binding.threadId === threadId ? sourceFromBindingMode(binding.mode) : 'unknown';
    if (bindingSource === 'unknown') {
      try {
        const control = await this.getControlClient();
        const read = await withTimeout(
          control.readThread(threadId),
          Math.min(this.config.requestTimeoutMs, 8_000),
          'thread/read',
        );
        bindingSource = sourceLabel(String(read.thread.source || 'unknown'));
      } catch {
        // Keep unknown as fallback.
      }
    }
    this.db.upsertActiveTurn({
      threadId,
      chatId,
      turnId: null,
      status: 'running',
      queuedText: null,
      startedAt: startAt,
      updatedAt: startAt,
    });

    await this.safeSend(chatId, '已接收，正在让 Codex 处理…', {
      replyToMessageId,
      disableNotification: true,
    });

    this.logger.info('Turn execution started', {
      chatId,
      threadId,
      preview: truncate(text, 120),
    });

    let progressTimer: NodeJS.Timeout | null = null;
    let progressCount = 0;
    progressTimer = setInterval(() => {
      progressCount += 1;
      const elapsedSec = Math.floor((nowMs() - startAt) / 1000);
      const text = progressCount <= 2
        ? `⏳ 仍在处理中（已等待 ${elapsedSec} 秒）`
        : `⏳ 任务仍在进行中（已等待 ${elapsedSec} 秒）`;
      void this.safeSend(chatId, text, {
        disableNotification: true,
      });
    }, 30_000);
    progressTimer.unref();

    try {
      const client = await this.runtimeManager.getOrCreate(threadId);
      const result = await client.runTurn(threadId, text, this.config.turnTimeoutMs);

      if (result.status === 'completed') {
        const content = result.finalText.trim() || '(空回复)';
        const heading = result.usedFallback ? '✅ 已完成（自动回退模型）' : '✅ 已完成';
        await this.safeSend(
          chatId,
          `${heading}\n线程: ${threadId}\n来源: ${bindingSource}\n\n${escapeTelegramText(content)}`,
        );
        this.logger.info('Turn execution completed', {
          chatId,
          threadId,
          turnId: result.turnId,
          usedFallback: result.usedFallback,
          outputLength: content.length,
        });
      } else {
        await this.safeSend(
          chatId,
          `❌ 执行失败\n线程: ${threadId}\n来源: ${bindingSource}\n${escapeTelegramText(result.errorMessage || '未知错误')}`,
        );
        this.logger.warn('Turn execution failed', {
          chatId,
          threadId,
          turnId: result.turnId,
          error: result.errorMessage || 'unknown',
          usedFallback: result.usedFallback,
        });
      }
    } catch (error: any) {
      await this.safeSend(chatId, `❌ 执行异常\n${escapeTelegramText(error?.message || String(error))}`);
      this.logger.error('Turn execution exception', {
        threadId,
        chatId,
        error: error?.message || String(error),
      });
    } finally {
      if (progressTimer) {
        clearInterval(progressTimer);
      }
      const current = this.db.getActiveTurn(threadId);
      const queued = current?.queuedText || null;
      if (queued) {
        this.db.upsertActiveTurn({
          threadId,
          chatId,
          turnId: null,
          status: 'running',
          queuedText: null,
          startedAt: nowMs(),
          updatedAt: nowMs(),
        });
        await this.safeSend(chatId, '⏭️ 当前任务已结束，开始处理排队消息…', {
          disableNotification: true,
        });
        void this.executeTurn(chatId, threadId, queued);
      } else {
        this.db.clearActiveTurn(threadId);
      }
    }
  }

  private async onApprovalRequested(event: ApprovalRequestEvent): Promise<void> {
    const binding = this.db.getBindingByThread(event.threadId);
    if (!binding) {
      this.logger.warn('No binding found for approval request, auto-denying', {
        approvalId: event.approvalId,
        threadId: event.threadId,
      });
      const client = this.runtimeManager.getExisting(event.threadId);
      if (client) {
        client.resolveApproval(event.approvalId, false);
      }
      return;
    }

    const now = nowMs();
    const pending: PendingApproval = {
      approvalId: event.approvalId,
      chatId: binding.chatId,
      threadId: event.threadId,
      turnId: event.turnId,
      requestId: String(event.requestId),
      kind: event.kind,
      summary: event.summary,
      expiresAt: now + this.config.approvalTimeoutMs,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };

    this.db.savePendingApproval(pending);

    await this.safeSend(
      binding.chatId,
      [
        `⚠️ 需要审批: ${event.approvalId}`,
        event.summary,
        `过期时间: ${formatLocalTime(pending.expiresAt)}`,
        `可直接点按钮，或执行 /approve ${event.approvalId} / /deny ${event.approvalId}`,
      ].join('\n'),
      {
        replyMarkup: buildApprovalInlineKeyboard(event.approvalId),
      },
    );
  }

  private async handleApprovalDecision(chatId: string, args: string, allow: boolean): Promise<void> {
    const approvalId = args.trim().split(/\s+/)[0] || '';
    if (!approvalId) {
      await this.safeSend(chatId, `用法: ${allow ? '/approve' : '/deny'} <approvalId>`);
      return;
    }

    const pending = this.db.getPendingApproval(approvalId);
    if (!pending) {
      await this.safeSend(chatId, `未找到审批单: ${approvalId}`);
      return;
    }

    if (pending.chatId !== chatId) {
      await this.safeSend(chatId, '无权限处理该审批单。');
      return;
    }

    if (pending.status !== 'pending') {
      await this.safeSend(chatId, `该审批单当前状态为 ${pending.status}，不可重复处理。`);
      return;
    }

    const client = this.runtimeManager.getExisting(pending.threadId);
    if (!client) {
      this.db.setPendingApprovalStatus(approvalId, 'failed', nowMs());
      await this.safeSend(chatId, `审批失败：线程运行时不可用（${approvalId}）。`);
      return;
    }

    const resolved = client.resolveApproval(approvalId, allow);
    if (!resolved) {
      this.db.setPendingApprovalStatus(approvalId, 'failed', nowMs());
      await this.safeSend(chatId, `审批失败：审批单已失效（${approvalId}）。`);
      return;
    }

    this.db.setPendingApprovalStatus(approvalId, allow ? 'approved' : 'denied', nowMs());
    await this.safeSend(chatId, `${allow ? '已通过' : '已拒绝'}审批：${approvalId}`);
  }

  private async fetchThreadConversationSnapshot(threadId: string): Promise<ThreadConversationSnapshot | null> {
    const control = await this.getControlClient();
    try {
      const payload = await withTimeout(
        control.request<unknown>('thread/read', {
          threadId,
          includeTurns: true,
        }),
        Math.min(this.config.requestTimeoutMs, 25_000),
        'thread/read(includeTurns=true)',
      );
      const parsed = parseThreadConversationSnapshot(payload);
      if (parsed) {
        return parsed;
      }
      throw new Error('thread/read(includeTurns=true) returned unparseable payload');
    } catch (error: any) {
      this.logger.warn('Failed to fetch thread snapshot with turns; falling back to basic thread/read', {
        threadId,
        errorMessage: error?.message || String(error),
      });
    }

    const basic = await withTimeout(
      control.readThread(threadId),
      Math.min(this.config.requestTimeoutMs, 12_000),
      'thread/read',
    );
    if (!basic?.thread?.id) {
      return null;
    }

    return {
      threadId: String(basic.thread.id || threadId),
      source: sourceLabel(String(basic.thread.source || 'unknown')),
      updatedAt: Number(basic.thread.updatedAt || 0),
      preview: sanitizePreview(String(basic.thread.preview || '')),
      lastUser: '',
      lastAssistant: '',
      recentTurns: [],
      degraded: true,
    };
  }

  private async handleActive(chatId: string): Promise<void> {
    const binding = this.db.getBinding(chatId);
    if (!binding) {
      await this.safeSend(chatId, '当前未绑定会话。可先执行 /threads 然后 /bind [编号]。', {
        replyMarkup: buildMainReplyKeyboard(),
      });
      return;
    }

    const control = await this.getControlClient();
    let readResult: Awaited<ReturnType<CodexAppServerClient['readThread']>>;
    try {
      readResult = await withTimeout(
        control.readThread(binding.threadId),
        Math.min(this.config.requestTimeoutMs, 8_000),
        'thread/read',
      );
    } catch (error: any) {
      await this.safeSend(chatId, `❌ 读取当前会话失败\n${escapeTelegramText(error?.message || String(error))}`);
      return;
    }

    const thread: ThreadListItem = {
      id: String(readResult.thread.id || binding.threadId),
      preview: sanitizePreview(String(readResult.thread.preview || '')),
      updatedAt: Number(readResult.thread.updatedAt || 0),
      cwd: readResult.thread.cwd == null ? null : String(readResult.thread.cwd),
      source: sourceLabel(String(readResult.thread.source || 'unknown')),
    };
    this.db.saveBinding(chatId, thread.id, `thread:${thread.source}`, nowMs());

    const metadata = loadCodexSidebarMetadata(this.logger);
    const title = resolveThreadTitle(thread, 0, metadata);
    const group = resolveThreadGroup(thread, metadata);
    const activeTurn = this.db.getActiveTurn(thread.id);

    const lines: string[] = [];
    lines.push('🎯 当前会话');
    lines.push(`<b>${escapeTelegramHtml(title)}</b>`);
    lines.push(`分组: ${escapeTelegramHtml(group)}`);
    if (thread.updatedAt > 0) {
      lines.push(`更新时间: ${escapeTelegramHtml(formatLocalTime(toEpochMs(thread.updatedAt)))}`);
    }
    lines.push(`任务状态: ${activeTurn ? escapeTelegramHtml(activeTurn.status) : 'idle'}`);
    lines.push('可用: /current 查看快照，/detail current 查看详情');

    await this.safeSend(chatId, lines.join('\n'), {
      replyMarkup: buildMainReplyKeyboard(),
      parseMode: 'HTML',
    });
  }

  private async handleDetail(chatId: string, argsRaw: string): Promise<void> {
    const arg = (argsRaw || '').trim() || 'current';
    const binding = this.db.getBinding(chatId);
    const control = await this.getControlClient();
    let targetThreadId = '';

    if (arg === 'current') {
      if (!binding) {
        await this.safeSend(chatId, '当前未绑定会话。请先执行 /threads 然后 /bind <编号>。');
        return;
      }
      targetThreadId = binding.threadId;
    } else if (arg === 'latest') {
      const latest = await control.listThreads(this.config.maxThreadList);
      const state = this.buildDisplayThreadsState(chatId, latest);
      const preferred = this.pickPreferredLatestThread(state.displayItems.map((item) => item.thread));
      if (!preferred) {
        await this.safeSend(chatId, '没有可查看详情的会话。');
        return;
      }
      targetThreadId = preferred.id;
    } else if (/^\d+$/.test(arg)) {
      const index = Number(arg);
      const cached = this.getCachedThreads(chatId);
      if (!cached || cached.length === 0) {
        await this.safeSend(chatId, '最近会话缓存已过期，请先执行 /threads。');
        return;
      }
      if (!Number.isFinite(index) || index <= 0 || index > cached.length) {
        await this.safeSend(chatId, `编号无效，请输入 1 到 ${cached.length}。`);
        return;
      }
      targetThreadId = cached[index - 1].id;
    } else {
      targetThreadId = arg;
    }

    let readResult: Awaited<ReturnType<CodexAppServerClient['readThread']>>;
    try {
      readResult = await withTimeout(
        control.readThread(targetThreadId),
        Math.min(this.config.requestTimeoutMs, 10_000),
        'thread/read',
      );
    } catch (error: any) {
      await this.safeSend(chatId, `❌ 读取会话详情失败\n${escapeTelegramText(error?.message || String(error))}`);
      return;
    }

    if (!readResult?.thread?.id) {
      await this.safeSend(chatId, `未找到会话：${targetThreadId}`);
      return;
    }

    const thread: ThreadListItem = {
      id: String(readResult.thread.id || targetThreadId),
      preview: sanitizePreview(String(readResult.thread.preview || '')),
      updatedAt: Number(readResult.thread.updatedAt || 0),
      cwd: readResult.thread.cwd == null ? null : String(readResult.thread.cwd),
      source: sourceLabel(String(readResult.thread.source || 'unknown')),
    };

    const metadata = loadCodexSidebarMetadata(this.logger);
    const title = resolveThreadTitle(thread, 0, metadata);
    const group = resolveThreadGroup(thread, metadata);
    const isBound = !!binding && binding.threadId === thread.id;

    const lines: string[] = [];
    lines.push('🧾 会话详情');
    lines.push(`标题: <b>${escapeTelegramHtml(title)}</b>`);
    lines.push(`分组: ${escapeTelegramHtml(group)}`);
    lines.push(`ID: <code>${escapeTelegramHtml(thread.id)}</code>`);
    lines.push(`来源: ${escapeTelegramHtml(thread.source)}`);
    lines.push(`CWD: <code>${escapeTelegramHtml(thread.cwd || '(无)')}</code>`);
    if (thread.updatedAt > 0) {
      lines.push(`更新时间: ${escapeTelegramHtml(formatLocalTime(toEpochMs(thread.updatedAt)))}`);
    }
    lines.push(`绑定状态: ${isBound ? '✅ 当前已绑定' : '未绑定'}`);
    if (thread.preview) {
      lines.push(`预览: ${escapeTelegramHtml(truncate(thread.preview, 200))}`);
    }
    lines.push('可用: /bind [编号|threadId] 绑定该会话');

    await this.safeSend(chatId, lines.join('\n'), {
      replyMarkup: buildMainReplyKeyboard(),
      parseMode: 'HTML',
    });
  }

  private async handleCurrent(chatId: string): Promise<void> {
    const binding = this.db.getBinding(chatId);
    if (!binding) {
      await this.safeSend(chatId, '当前未绑定会话，请先执行 /threads 然后 /bind。', {
        replyMarkup: buildMainReplyKeyboard(),
      });
      return;
    }

    await this.safeSend(chatId, '正在读取当前会话快照…', {
      disableNotification: true,
    });

    let snapshot: ThreadConversationSnapshot | null = null;
    try {
      snapshot = await this.fetchThreadConversationSnapshot(binding.threadId);
    } catch (error: any) {
      await this.safeSend(chatId, `❌ 读取会话快照失败\n${escapeTelegramText(error?.message || String(error))}`);
      return;
    }

    if (!snapshot) {
      await this.safeSend(chatId, '未能解析当前会话内容，请稍后重试。');
      return;
    }

    const source = snapshot.source || sourceFromBindingMode(binding.mode);
    this.db.saveBinding(chatId, binding.threadId, `thread:${source}`, nowMs());

    const lines: string[] = [];
    lines.push(`当前会话: ${snapshot.threadId}`);
    lines.push(`来源: ${source}`);
    if (snapshot.updatedAt > 0) {
      lines.push(`更新时间: ${formatLocalTime(toEpochMs(snapshot.updatedAt))}`);
    }
    if (snapshot.preview) {
      lines.push(`标题: ${truncate(snapshot.preview, 120)}`);
    }
    if (snapshot.degraded) {
      lines.push('注: 当前会话较大或较忙，已降级为基础快照。');
    }
    lines.push(`最近用户: ${snapshot.lastUser ? truncate(snapshot.lastUser, 220) : '(无)'}`);
    lines.push(`最近助手: ${snapshot.lastAssistant ? truncate(snapshot.lastAssistant, 220) : '(无)'}`);

    const recentTurns = snapshot.recentTurns.slice(-3);
    if (recentTurns.length > 0) {
      lines.push('最近 3 轮:');
      recentTurns.forEach((turn, index) => {
        lines.push(`${index + 1}) 👤 ${turn.userText ? truncate(turn.userText, 120) : '(无)'}`);
        const assistantText = turn.assistantText
          ? truncate(turn.assistantText, 120)
          : turn.status === 'inProgress' || turn.status === 'in_progress'
            ? '(处理中)'
            : '(无)';
        lines.push(`   🤖 ${assistantText}`);
      });
    }

    await this.safeSend(chatId, lines.join('\n'), {
      replyMarkup: buildMainReplyKeyboard(),
    });
  }

  private async handleStatus(chatId: string): Promise<void> {
    const binding = this.db.getBinding(chatId);
    const activeTurns = this.db.listActiveTurnsByChat(chatId);
    const pending = this.db.listPendingApprovalsByChat(chatId).filter((item) => item.status === 'pending');

    let threadUpdatedAt = 0;
    let bindingSource = binding ? sourceFromBindingMode(binding.mode) : 'unknown';
    if (binding) {
      try {
        const control = await this.getControlClient();
        const read = await withTimeout(
          control.readThread(binding.threadId),
          Math.min(this.config.requestTimeoutMs, 8_000),
          'thread/read',
        );
        threadUpdatedAt = Number(read.thread.updatedAt || 0);
        if (bindingSource === 'unknown') {
          bindingSource = sourceLabel(String(read.thread.source || 'unknown'));
          this.db.saveBinding(chatId, binding.threadId, `thread:${bindingSource}`, nowMs());
        }
      } catch {
        // Keep fallback values when thread lookup fails.
      }
    }

    const lines: string[] = [];
    lines.push(`绑定线程: ${binding ? binding.threadId : '(未绑定)'}`);
    if (binding) {
      lines.push(`线程来源: ${bindingSource}`);
      if (bindingSource === 'cli') {
        lines.push('提示: cli 线程在 Codex App 中可能不显示实时更新。');
      }
      if (threadUpdatedAt > 0) {
        lines.push(`会话更新时间: ${formatLocalTime(toEpochMs(threadUpdatedAt))}`);
      }
    }
    lines.push(`运行中任务: ${activeTurns.length}`);
    if (activeTurns.length > 0) {
      for (const turn of activeTurns.slice(0, 3)) {
        lines.push(`- ${turn.threadId} status=${turn.status} queued=${turn.queuedText ? 'yes' : 'no'}`);
      }
    }

    lines.push(`待审批: ${pending.length}`);
    for (const approval of pending.slice(0, 3)) {
      lines.push(`- ${approval.approvalId} expires=${formatLocalTime(approval.expiresAt)}`);
    }
    if (binding) {
      lines.push('可用命令: /current 查看当前会话快照');
    }

    await this.safeSend(chatId, lines.join('\n'), {
      replyMarkup: buildMainReplyKeyboard(),
    });
  }

  private async runMaintenance(): Promise<void> {
    const now = nowMs();

    const pending = this.db.listPendingApprovalsByStatus('pending');
    for (const approval of pending) {
      if (approval.expiresAt > now) {
        continue;
      }
      const client = this.runtimeManager.getExisting(approval.threadId);
      if (client) {
        client.resolveApproval(approval.approvalId, false);
      }
      this.db.setPendingApprovalStatus(approval.approvalId, 'timed_out', now);
      await this.safeSend(approval.chatId, `审批超时，已自动拒绝：${approval.approvalId}`);
    }

    const removed = this.db.pruneMessageDedup(now - this.config.dedupRetentionMs);
    if (removed > 0) {
      this.logger.debug('Pruned message dedup rows', { count: removed });
    }
  }

  private async notifyAndClearStaleTurns(notify: boolean): Promise<void> {
    const bindings = this.db.listBindings();
    if (bindings.length === 0) {
      return;
    }

    const notifiedChats = new Set<string>();
    for (const binding of bindings) {
      const activeTurns = this.db.listActiveTurnsByChat(binding.chatId);
      const staleTurns = activeTurns.filter((turn) => turn.status === 'stale');
      if (staleTurns.length === 0) {
        continue;
      }

      if (notify && !notifiedChats.has(binding.chatId)) {
        notifiedChats.add(binding.chatId);
        await this.safeSend(
          binding.chatId,
          `⚠️ 检测到服务重启，上一条处理中任务已中断（${staleTurns.length} 条）。请重新发送。`,
          {
            disableNotification: true,
          },
        );
      }

      for (const staleTurn of staleTurns) {
        this.db.clearActiveTurn(staleTurn.threadId);
      }
    }
  }

  private async expireOrphanPendingApprovals(): Promise<void> {
    const now = nowMs();
    const pending = this.db.listPendingApprovalsByStatus('pending');
    if (pending.length === 0) {
      return;
    }

    for (const approval of pending) {
      this.db.setPendingApprovalStatus(approval.approvalId, 'expired', now);
      await this.safeSend(
        approval.chatId,
        `检测到服务重启，审批单已失效：${approval.approvalId}。如需继续，请重新发送请求。`,
      );
    }
  }

  private async getControlClient(): Promise<CodexAppServerClient> {
    if (this.controlClient) {
      return this.controlClient;
    }

    if (this.controlClientInit) {
      return await this.controlClientInit;
    }

    const initPromise = (async () => {
      const client = new CodexAppServerClient({
        logger: this.logger,
        codexBin: this.config.codexBin,
        requestTimeoutMs: this.config.requestTimeoutMs,
        fallbackModel: this.config.fallbackModel,
        clientName: 'bridge-control',
      });
      await client.start();
      this.controlClient = client;
      this.logger.info('Control app-server client ready');
      return client;
    })();

    this.controlClientInit = initPromise;
    try {
      return await initPromise;
    } finally {
      this.controlClientInit = null;
    }
  }

  private async safeSend(
    chatId: string,
    text: string,
    options?: {
      replyToMessageId?: number;
      disableNotification?: boolean;
      replyMarkup?: Record<string, unknown>;
      parseMode?: 'HTML' | 'MarkdownV2';
    },
  ): Promise<void> {
    try {
      await this.telegram.sendMessage(chatId, text, options);
    } catch (error: any) {
      this.logger.error('Failed to send Telegram message', {
        chatId,
        error: error?.message || String(error),
      });
    }
  }
}

async function main(): Promise<void> {
  const logger = createLogger();
  let service: BridgeService | null = null;

  try {
    const config = loadConfig();
    service = new BridgeService(config, logger);

    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      logger.warn('Received shutdown signal', { signal });
      if (service) {
        await service.stop();
      }
      process.exit(0);
    };

    process.on('SIGINT', () => {
      void shutdown('SIGINT');
    });
    process.on('SIGTERM', () => {
      void shutdown('SIGTERM');
    });

    await service.start();
  } catch (error: any) {
    logger.error('Bridge fatal error', {
      error: error?.stack || error?.message || String(error),
    });
    if (service) {
      await service.stop();
    }
    process.exit(1);
  }
}

void main();

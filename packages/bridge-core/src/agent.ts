import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { BridgeDb } from './db';
import {
  CodexAppServerClient,
  type CollaborationModeMask,
  type TurnCollaborationModePayload,
} from './codex-app-server';
import { createLogger, type Logger } from './logger';
import { ThreadRuntimeManager } from './runtime-manager';
import { runHealthChecks } from './health';
import { sanitizePreview, truncate } from './utils';
import { localeText, normalizeLocale, type BridgeLocale } from './i18n';
import type {
  AgentStatus,
  DeviceOutboundEvent,
  IncomingControlCommandEvent,
  IncomingImageAttachment,
  IncomingUserMessageEvent,
  ThreadSummary,
} from './desktop-types';
import type {
  ApprovalRequestEvent,
  RemoteBinding,
  ThreadListItem,
  UserInputQuestion,
  UserInputRequestEvent,
  TurnExecutionResult,
  TurnUserInput,
} from './types';

interface TurnContext {
  chatId: string;
  messageId: string;
}

interface RunningTurnState {
  promise: Promise<void>;
  startedAt: number;
  watchdog?: NodeJS.Timeout;
}

export interface BridgeAgentOptions {
  deviceId: string;
  dbPath: string;
  codexBin?: string;
  fallbackModel?: string;
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
  stuckTurnResetMs?: number;
  autoApproveRemoteActions?: boolean;
  locale?: BridgeLocale;
  logger?: Logger;
}

const DEVICE_BINDING_PREFIX = 'device:';
const THREAD_CACHE_TTL_MS = 10 * 60 * 1000;
const THREAD_LIST_LIMIT = 20;
const GLOBAL_STATE_CACHE_TTL_MS = 15_000;
const COLLABORATION_MODE_CACHE_TTL_MS = 60_000;
const CHAT_MODE_STATE_PREFIX = 'chat_mode:';
const PLAN_INPUT_TIMEOUT_MS = 10 * 60 * 1000;
const PLAN_CONFIRM_TIMEOUT_MS = 30 * 60 * 1000;
const CODEX_GLOBAL_STATE_PATH = process.env.CODEX_GLOBAL_STATE_PATH
  || (process.env.HOME ? path.join(process.env.HOME, '.codex', '.codex-global-state.json') : '');

type ChatModeOverride = 'plan' | 'code';

interface ResolvedBridgeAgentOptions {
  deviceId: string;
  dbPath: string;
  codexBin: string;
  fallbackModel: string;
  requestTimeoutMs: number;
  turnTimeoutMs: number;
  stuckTurnResetMs: number;
  autoApproveRemoteActions: boolean;
  locale: BridgeLocale;
  logger?: Logger;
}

interface CodexSidebarMetadata {
  titleByThreadId: Map<string, string>;
  orderByThreadId: Map<string, number>;
  workspaceRoots: string[];
  workspaceLabelByRoot: Map<string, string>;
}

interface DisplayThreadItem {
  thread: ThreadSummary;
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
  degradedReason?: string;
}

interface ThreadReadWithDegradeResult {
  thread: ThreadSummary;
  degraded: boolean;
  degradedReason?: string;
}

interface TurnModeResolution {
  override: ChatModeOverride;
  payload: TurnCollaborationModePayload | null;
  warningText: string | null;
}

interface PendingPlanInputSession {
  sessionId: string;
  userInputRequestId: string;
  chatId: string;
  messageId: string;
  threadId: string;
  turnId: string;
  questions: UserInputQuestion[];
  currentIndex: number;
  answers: Record<string, unknown>;
  multiSelections: Record<string, Set<string>>;
  awaitingTextQuestionId: string | null;
  createdAt: number;
  expiresAt: number;
}

interface PendingPlanConfirmation {
  token: string;
  chatId: string;
  messageId: string;
  threadId: string;
  planText: string;
  createdAt: number;
  expiresAt: number;
}

interface CodexSidebarMetadataCache {
  loadedAt: number;
  mtimeMs: number;
  data: CodexSidebarMetadata;
}

let codexSidebarMetadataCache: CodexSidebarMetadataCache | null = null;

function nowMs(): number {
  return Date.now();
}

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

function compactText(value: string): string {
  return (value || '').replace(/\s+/g, ' ').trim();
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

function escapeTelegramHtml(text: string): string {
  return (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function isLikelyImageGenerationRequest(text: string): boolean {
  const normalized = compactText(text || '').toLowerCase();
  if (!normalized) {
    return false;
  }
  // Avoid blocking product/development discussions like "新增支持图片发送能力".
  const hasDevelopmentIntent =
    /(实现|新增|支持|开发|功能|能力|方案|设计|接口|代码|修复|优化|重构|迁移|测试|文档|readme|项目|bridge|telegram|codex|api|sdk|feature|implement|support|develop|code|fix|refactor|docs|project|issue|bug)/i.test(
      normalized,
    );
  if (hasDevelopmentIntent) {
    return false;
  }

  // Only intercept explicit "generate/send me an image" style requests.
  const explicitImageRequest =
    /((给我|发我|来一张|生成|画|做一张|创建).{0,12}(图片|图像|配图|照片|截图|image|photo|picture|pic))|((send|generate|draw|create|make).{0,15}(image|photo|picture|pic))/i.test(
      normalized,
    );
  return explicitImageRequest;
}

function normalizeIncomingImageAttachments(images: IncomingImageAttachment[] | undefined): IncomingImageAttachment[] {
  if (!Array.isArray(images) || images.length === 0) {
    return [];
  }
  return images
    .map((item) => ({
      kind: item.kind,
      path: String(item.path || '').trim(),
      mimeType: item.mimeType ? String(item.mimeType).trim() : undefined,
    }))
    .filter((item) => item.kind === 'localImage' && !!item.path);
}

function buildTurnInputs(event: IncomingUserMessageEvent, locale: BridgeLocale): TurnUserInput[] {
  const normalizedText = compactText(event.text || '');
  const images = normalizeIncomingImageAttachments(event.images);
  const inputs: TurnUserInput[] = [];

  if (normalizedText) {
    inputs.push({ type: 'text', text: normalizedText });
  } else if (images.length > 0) {
    // Give model explicit instruction for caption-less image messages.
    inputs.push({
      type: 'text',
      text: localeText(
        locale,
        '请基于这张图片回答用户问题；若无其他问题，请先简要描述图片内容。',
        'Please answer based on this image. If no specific question is provided, briefly describe the image first.',
      ),
    });
  }

  for (const image of images) {
    inputs.push({ type: 'localImage', path: image.path });
  }

  if (inputs.length === 0) {
    inputs.push({ type: 'text', text: localeText(locale, '请回复字符串 OK', 'Please reply with string OK') });
  }
  return inputs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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

function inferThreadTopic(preview: string, fallbackIndex: number, locale: BridgeLocale): string {
  const normalized = compactText(preview || '');
  if (!normalized) {
    return localeText(locale, `会话 ${fallbackIndex + 1}`, `Thread ${fallbackIndex + 1}`);
  }

  const keywordRules: Array<{ pattern: RegExp; titleZh: string; titleEn: string }> = [
    { pattern: /(telegram|clawdbot|remote|远程|手机).*(codex|app)/i, titleZh: 'Telegram 远程控制 Codex', titleEn: 'Telegram Remote Control for Codex' },
    { pattern: /(优化|改进|optimi[sz]e|improv).*(ios app|展示|交互|ui|ux)/i, titleZh: 'iOS 展示交互优化', titleEn: 'iOS UI/UX Improvements' },
    { pattern: /(readme|项目|project).*(了解|信息|基本|overview|intro)/i, titleZh: '项目基础信息梳理', titleEn: 'Project Basics Overview' },
    { pattern: /(ios app).*(后端|服务|backend|service).*(infohub|资讯)/i, titleZh: 'InfoHub 项目全貌梳理', titleEn: 'InfoHub Full Project Overview' },
    { pattern: /(拍照|抠图|单词卡|swift ui|swiftui|flashcard|subject extraction)/i, titleZh: 'iOS 拍照抠图单词卡', titleEn: 'iOS Photo Cutout Flashcards' },
    { pattern: /^(你好|hello|hi)$/i, titleZh: '问候 / 快速测试', titleEn: 'Greeting / Quick Test' },
  ];

  for (const rule of keywordRules) {
    if (rule.pattern.test(normalized)) {
      return localeText(locale, rule.titleZh, rule.titleEn);
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
  return truncate(topic || localeText(locale, `会话 ${fallbackIndex + 1}`, `Thread ${fallbackIndex + 1}`), 18);
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

function listThreadsFromSidebarMetadata(metadata: CodexSidebarMetadata, locale: BridgeLocale): ThreadSummary[] {
  // Best-effort fallback list when app-server `thread/list` is slow/unavailable.
  // Uses thread ids + titles that Codex Desktop persists locally.
  const orderedIds = Array.from(metadata.orderByThreadId.entries())
    .sort((a, b) => a[1] - b[1])
    .map(([threadId]) => threadId)
    .filter(Boolean);

  const ids = orderedIds.length > 0 ? orderedIds : Array.from(metadata.titleByThreadId.keys());
  return ids.map((threadId) => ({
    id: threadId,
    preview: sanitizePreview(metadata.titleByThreadId.get(threadId) || ''),
    updatedAt: 0,
    cwd: null,
    source: localeText(locale, 'codex', 'codex'),
  }));
}

function resolveThreadGroup(thread: ThreadSummary, metadata: CodexSidebarMetadata, locale: BridgeLocale): string {
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
  return thread.source === 'cli' ? 'CLI' : localeText(locale, '其他', 'Other');
}

function resolveThreadTitle(
  thread: ThreadSummary,
  index: number,
  metadata: CodexSidebarMetadata,
  locale: BridgeLocale,
): string {
  const fromCodex = metadata.titleByThreadId.get(thread.id);
  if (fromCodex) {
    return fromCodex;
  }
  return inferThreadTopic(thread.preview || '', index, locale);
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

function buildThreadButtonTitle(
  item: DisplayThreadItem,
  index: number,
  isCurrent: boolean,
  locale: BridgeLocale,
): string {
  const title = truncate(compactText(item.title || localeText(locale, `会话 ${index + 1}`, `Thread ${index + 1}`)), 24);
  return `${isCurrent ? '✅ ' : ''}🧵 ${title}`;
}

function buildThreadsInlineKeyboard(
  items: DisplayThreadItem[],
  currentThreadId: string | null,
  locale: BridgeLocale,
): Record<string, unknown> {
  const inlineRows: Array<Array<{ text: string; callback_data: string }>> = [];

  items.forEach((item, index) => {
    const isCurrent = currentThreadId === item.thread.id;
    inlineRows.push([
      {
        text: buildThreadButtonTitle(item, index, isCurrent, locale),
        callback_data: `bind_thread:${item.thread.id}`,
      },
    ]);
  });

  inlineRows.push([{ text: localeText(locale, '🔄 刷新会话列表', '🔄 Refresh threads'), callback_data: 'threads' }]);

  return {
    inline_keyboard: inlineRows,
  };
}

function buildMainReplyKeyboard(): Record<string, unknown> {
  return {
    keyboard: [
      [{ text: '/threads' }, { text: '/bind latest' }],
      [{ text: '/usage' }, { text: '/status' }],
      [{ text: '/active' }, { text: '/current' }],
      [{ text: '/plan on' }, { text: '/plan off' }],
      [{ text: '/plan status' }, { text: '/cancel' }],
      [{ text: '/detail' }],
      [{ text: '/unbind' }],
    ],
    resize_keyboard: true,
  };
}

function dedupeThreadsForDisplay(
  threads: ThreadSummary[],
  currentThreadId: string | null,
  metadata: CodexSidebarMetadata,
  locale: BridgeLocale,
): { items: DisplayThreadItem[]; mergedCount: number } {
  const dedupedById = new Map<string, ThreadSummary>();
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
    const title = resolveThreadTitle(thread, index, metadata, locale);
    const group = resolveThreadGroup(thread, metadata, locale);
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
  threads: ThreadSummary[],
  metadata: CodexSidebarMetadata,
): { threads: ThreadSummary[]; hiddenCount: number; usingSidebarVisibility: boolean } {
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

async function withTimeout<T>(task: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      task,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export class BridgeAgent extends EventEmitter {
  private readonly options: ResolvedBridgeAgentOptions;
  private locale: BridgeLocale;
  private readonly logger: Logger;
  private readonly db: BridgeDb;
  private readonly runtimeManager: ThreadRuntimeManager;

  private controlClient: CodexAppServerClient | null = null;
  private controlClientInit: Promise<CodexAppServerClient> | null = null;

  private readonly pendingApprovals = new Map<string, { threadId: string; chatId: string; messageId: string }>();
  private readonly turnContextByThread = new Map<string, TurnContext>();
  private readonly runningTurns = new Map<string, RunningTurnState>();
  private readonly queuedByThread = new Map<string, IncomingUserMessageEvent>();
  private readonly cancelRequestedByThread = new Set<string>();
  private readonly recentThreadsByChat = new Map<string, { threads: ThreadSummary[]; updatedAt: number }>();
  private readonly pendingPlanInputByChat = new Map<string, PendingPlanInputSession>();
  private readonly pendingPlanInputBySessionId = new Map<string, PendingPlanInputSession>();
  private readonly pendingPlanConfirmByChat = new Map<string, PendingPlanConfirmation>();
  private readonly pendingPlanConfirmByToken = new Map<string, PendingPlanConfirmation>();
  private readonly oneShotModeByChat = new Map<string, ChatModeOverride>();
  private collaborationModesCache: { loadedAt: number; modes: CollaborationModeMask[] } | null = null;

  private shouldRetryAfterRuntimeError(message: string): boolean {
    return /app-server stopped|app-server exited|app-server is not running|not running|stdin is not writable|runtime unresponsive|stream disconnected/i.test(
      message,
    );
  }

  private maxRecoveryAttemptsForError(message: string): number {
    // "stream disconnected/runtime unresponsive" are often transient; allow two resets.
    if (/stream disconnected|runtime unresponsive/i.test(message)) {
      return 2;
    }
    return 2;
  }

  constructor(options: BridgeAgentOptions) {
    super();
    this.options = {
      deviceId: options.deviceId,
      dbPath: options.dbPath,
      codexBin: options.codexBin ?? 'codex',
      fallbackModel: options.fallbackModel ?? 'gpt-5.2-codex',
      requestTimeoutMs: options.requestTimeoutMs ?? 60_000,
      turnTimeoutMs: options.turnTimeoutMs ?? 20 * 60 * 1000,
      stuckTurnResetMs: options.stuckTurnResetMs ?? 4 * 60 * 1000,
      autoApproveRemoteActions: options.autoApproveRemoteActions ?? true,
      locale: normalizeLocale(options.locale),
      logger: options.logger,
    };
    this.locale = this.options.locale;

    this.logger = this.options.logger || createLogger();
    this.db = new BridgeDb(this.options.dbPath, this.logger);
    this.runtimeManager = new ThreadRuntimeManager({
      logger: this.logger,
      codexBin: this.options.codexBin,
      requestTimeoutMs: this.options.requestTimeoutMs,
      fallbackModel: this.options.fallbackModel,
    });

    this.runtimeManager.setApprovalHandler((event) => {
      void this.handleApproval(event);
    });
    this.runtimeManager.setUserInputHandler((event) => {
      void this.handleUserInputRequest(event);
    });
  }

  setLocale(locale: BridgeLocale): void {
    this.locale = normalizeLocale(locale);
  }

  private t(zh: string, en: string): string {
    return localeText(this.locale, zh, en);
  }

  async start(): Promise<void> {
    await this.getControlClient();
    this.db.markAllActiveTurnsStale(Date.now());
  }

  async stop(): Promise<void> {
    await this.runtimeManager.stopAll();

    if (this.controlClient) {
      try {
        await this.controlClient.stop();
      } catch {
        // ignore
      }
      this.controlClient = null;
      this.controlClientInit = null;
    }

    this.db.close();
  }

  async getHealth() {
    return await runHealthChecks({
      codexBin: this.options.codexBin,
      logger: this.logger,
      requestTimeoutMs: this.options.requestTimeoutMs,
    });
  }

  async listThreads(limit = 20): Promise<ThreadSummary[]> {
    const control = await this.getControlClient();
    const rows = await control.listThreads(limit);
    return rows.map((item) => ({
      id: item.id,
      preview: item.preview,
      updatedAt: item.updatedAt,
      source: item.source,
      cwd: item.cwd,
    }));
  }

  async bindThread(threadId: string): Promise<void> {
    const control = await this.getControlClient();
    let source = 'unknown';
    try {
      const read = await withTimeout(
        control.readThread(threadId),
        Math.min(this.options.requestTimeoutMs, 12_000),
        'thread/read(bindThread)',
      );
      if (read?.thread?.id) {
        source = sourceLabel(String(read.thread.source || 'unknown'));
      }
    } catch (error: any) {
      this.logger.warn('bindThread metadata read failed; binding with fallback metadata', {
        threadId,
        error: error?.message || String(error),
      });
    }

    this.db.saveBinding(this.bindingChatId(), threadId, `thread:${source}`, Date.now());
    void this.runtimeManager.getOrCreate(threadId).catch((error: any) => {
      this.logger.warn('Deferred runtime warmup failed after bindThread', {
        threadId,
        error: error?.message || String(error),
      });
    });
  }

  getBinding(): RemoteBinding | null {
    return this.db.getBinding(this.bindingChatId());
  }

  async getStatus(relayConnected: boolean, lastError: string | null): Promise<AgentStatus> {
    return {
      deviceId: this.options.deviceId,
      selectedThreadId: this.getBinding()?.threadId || null,
      pendingApprovals: this.pendingApprovals.size,
      runningTurns: this.runningTurns.size,
      relayConnected,
      lastError,
      updatedAt: Date.now(),
    };
  }

  async getBoundThreadSummary(): Promise<{
    id: string;
    title: string;
    preview: string;
    updatedAt: number;
    source: string;
    cwd: string | null;
  } | null> {
    const binding = this.getBinding();
    if (!binding?.threadId) {
      return null;
    }

    const control = await this.getControlClient();
    const read = await withTimeout(
      control.readThread(binding.threadId),
      Math.min(this.options.requestTimeoutMs, 8_000),
      'thread/read(bound-summary)',
    );
    if (!read?.thread?.id) {
      return null;
    }
    const thread: ThreadSummary = {
      id: String(read.thread.id || binding.threadId),
      preview: sanitizePreview(String(read.thread.preview || '')),
      updatedAt: Number(read.thread.updatedAt || 0),
      source: sourceLabel(String(read.thread.source || 'unknown')),
      cwd: read.thread.cwd == null ? null : String(read.thread.cwd),
    };
    const metadata = loadCodexSidebarMetadata(this.logger);
    return {
      id: thread.id,
      title: resolveThreadTitle(thread, 0, metadata, this.locale),
      preview: thread.preview,
      updatedAt: thread.updatedAt,
      source: thread.source,
      cwd: thread.cwd,
    };
  }

  async handleIncomingMessage(event: IncomingUserMessageEvent): Promise<void> {
    this.cleanupExpiredPlanState();
    const fallbackCommand = this.parseControlCommandFromText(event.text);
    if (fallbackCommand) {
      await this.handleControlCommand({
        type: 'incomingControlCommand',
        chatId: event.chatId,
        messageId: event.messageId,
        command: fallbackCommand.command,
        args: fallbackCommand.args,
        source: 'message',
        createdAt: event.createdAt,
      });
      return;
    }

    if (await this.tryConsumePlanTextAnswer(event)) {
      return;
    }

    // User sent a new free-form message, clear stale "plan confirmation" card for this chat.
    this.clearPlanConfirmationForChat(event.chatId);

    if (isLikelyImageGenerationRequest(event.text)) {
      this.emitOutbound({
        type: 'finalResponse',
        chatId: event.chatId,
        messageId: event.messageId,
        text: this.t(
          '当前桥接版支持“图片输入 + 文本回复”，但暂不支持把生成图片回传到 Telegram。请改为文字输出需求。',
          'Current bridge supports image input + text output, but does not support sending generated images back to Telegram yet. Please request text output.',
        ),
        purpose: 'turn',
        createdAt: Date.now(),
      });
      return;
    }

    const binding = this.getBinding();
    if (!binding) {
      this.emitFinal(
        event.chatId,
        event.messageId,
        this.t('当前未绑定会话，请先执行 /threads 然后 /bind。', 'No thread is bound. Please run /threads and then /bind.'),
        {
          replyMarkup: buildMainReplyKeyboard(),
        },
      );
      return;
    }

    const threadId = binding.threadId;
    if (this.runningTurns.has(threadId)) {
      const running = this.runningTurns.get(threadId);
      const runningMs = running ? Date.now() - running.startedAt : 0;
      if (running && this.options.stuckTurnResetMs > 0 && runningMs >= this.options.stuckTurnResetMs) {
        this.queuedByThread.set(threadId, event);
        this.emitOutbound({
          type: 'executionStatus',
          chatId: event.chatId,
          messageId: event.messageId,
          status: 'queued',
          text: this.t(
            '检测到前一条任务卡住，正在自动重置并继续执行本条消息…',
            'The previous task appears stuck. Automatically resetting runtime and continuing this message...',
          ),
          createdAt: Date.now(),
        });
        void this.runtimeManager.resetThread(threadId);
        return;
      }

      if (this.queuedByThread.has(threadId)) {
        this.emitOutbound({
          type: 'executionStatus',
          chatId: event.chatId,
          messageId: event.messageId,
          status: 'failed',
          text: this.t('线程忙，且已有排队消息，请稍后再试。', 'Thread is busy and already has a queued message. Please try again later.'),
          createdAt: Date.now(),
        });
        return;
      }

      this.queuedByThread.set(threadId, event);
      this.emitOutbound({
        type: 'executionStatus',
        chatId: event.chatId,
        messageId: event.messageId,
        status: 'queued',
        text: this.locale === 'en'
          ? `Added to queue. Waiting for previous task${running ? ` (running for ${Math.max(1, Math.floor((Date.now() - running.startedAt) / 1000))}s)` : ''}.`
          : `已加入队列，等待前一条任务完成${running ? `（已运行 ${Math.max(1, Math.floor((Date.now() - running.startedAt) / 1000))} 秒）` : ''}。`,
        createdAt: Date.now(),
      });
      return;
    }

    const startedAt = Date.now();
    let watchdog: NodeJS.Timeout | null = null;
    if (this.options.stuckTurnResetMs > 0) {
      watchdog = setTimeout(() => {
        const current = this.runningTurns.get(threadId);
        if (!current || current.startedAt !== startedAt) {
          return;
        }
        this.logger.warn('Turn appears stuck, resetting runtime for thread', {
          threadId,
          startedAt,
          waitedMs: Date.now() - startedAt,
        });
        void this.runtimeManager.resetThread(threadId);
      }, this.options.stuckTurnResetMs);
      watchdog.unref();
    }

    const runPromise = this.processMessage(threadId, event)
      .catch((error: any) => {
        if (this.cancelRequestedByThread.has(threadId)) {
          this.logger.info('Suppressed turn error output after cancel', {
            threadId,
            messageId: event.messageId,
          });
          return;
        }
        const message = error?.message || String(error);
        this.logger.error('Failed to process incoming user message', {
          threadId,
          error: message,
        });

        this.emitOutbound({
          type: 'executionStatus',
          chatId: event.chatId,
          messageId: event.messageId,
          status: 'failed',
          text: this.locale === 'en' ? `Execution failed: ${message}` : `执行失败：${message}`,
          createdAt: Date.now(),
        });

        this.emitOutbound({
          type: 'finalResponse',
          chatId: event.chatId,
          messageId: event.messageId,
          text: this.locale === 'en' ? `Execution failed: ${message}` : `执行失败：${message}`,
          purpose: 'turn',
          createdAt: Date.now(),
        });
      })
      .finally(() => {
        if (watchdog) {
          clearTimeout(watchdog);
        }
        this.runningTurns.delete(threadId);
        const wasCancelled = this.cancelRequestedByThread.has(threadId);
        this.cancelRequestedByThread.delete(threadId);
        if (wasCancelled) {
          this.queuedByThread.delete(threadId);
          return;
        }
        const queued = this.queuedByThread.get(threadId);
        if (queued) {
          this.queuedByThread.delete(threadId);
          void this.handleIncomingMessage(queued);
        }
      });

    this.runningTurns.set(threadId, {
      promise: runPromise,
      startedAt,
      ...(watchdog ? { watchdog } : {}),
    });
    await runPromise;
  }

  private parseControlCommandFromText(text: string): { command: IncomingControlCommandEvent['command']; args: string } | null {
    const raw = (text || '').trim();
    const match = raw.match(/^\/([a-zA-Z]+)(?:@[\w_]+)?(?:\s+([\s\S]*))?$/);
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
    if (name === 'active') {
      return { command: 'active', args };
    }
    if (name === 'current') {
      return { command: 'current', args };
    }
    if (name === 'detail') {
      return { command: 'detail', args };
    }
    if (name === 'usage' || name === 'limits') {
      return { command: 'usage', args };
    }
    if (name === 'plan') {
      return { command: 'plan', args };
    }
    if (name === 'unbind') {
      return { command: 'unbind', args };
    }
    if (name === 'cancel' || name === 'cancal' || name === 'stop' || name === 'abort') {
      return { command: 'cancel', args };
    }
    if (name === 'help' || name === 'menu' || name === 'start') {
      return { command: 'help', args };
    }
    return null;
  }

  async handleControlCommand(event: IncomingControlCommandEvent): Promise<void> {
    try {
      switch (event.command) {
        case 'threads':
          await this.handleThreadsCommand(event);
          return;
        case 'bind':
          await this.handleBindCommand(event);
          return;
        case 'status':
          await this.handleStatusCommand(event);
          return;
        case 'active':
          await this.handleActiveCommand(event);
          return;
        case 'current':
          await this.handleCurrentCommand(event);
          return;
        case 'detail':
          await this.handleDetailCommand(event);
          return;
        case 'usage':
          await this.handleUsageCommand(event);
          return;
        case 'plan':
          await this.handlePlanCommand(event);
          return;
        case 'unbind':
          this.db.deleteBinding(this.bindingChatId());
          this.emitFinal(event.chatId, event.messageId, this.t('已解绑当前会话。', 'Current thread unbound.'), {
            replyMarkup: buildMainReplyKeyboard(),
          });
          return;
        case 'cancel':
          await this.handleCancelCommand(event);
          return;
        case 'help':
          await this.sendHelp(event.chatId, event.messageId);
          return;
        default:
          this.emitFinal(event.chatId, event.messageId, this.t('不支持该命令。请发送 /help 查看可用命令。', 'Unsupported command. Send /help for available commands.'));
      }
    } catch (error: any) {
      const msg = error?.message || String(error);
      this.emitFinal(event.chatId, event.messageId, this.locale === 'en' ? `Command failed: ${msg}` : `命令执行失败：${msg}`);
    }
  }

  async applyApprovalDecision(approvalId: string, allow: boolean): Promise<boolean> {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) {
      return false;
    }

    const ok = this.runtimeManager.resolveApproval(approvalId, allow, pending.threadId || undefined);
    if (ok) {
      this.pendingApprovals.delete(approvalId);
    }
    return ok;
  }

  private cleanupExpiredPlanState(): void {
    const now = nowMs();
    for (const [chatId, session] of this.pendingPlanInputByChat.entries()) {
      if (session.expiresAt > now) {
        continue;
      }
      this.pendingPlanInputByChat.delete(chatId);
      this.pendingPlanInputBySessionId.delete(session.sessionId);
      this.runtimeManager.cancelUserInput(session.userInputRequestId, session.threadId);
    }

    for (const [chatId, confirm] of this.pendingPlanConfirmByChat.entries()) {
      if (confirm.expiresAt > now) {
        continue;
      }
      this.pendingPlanConfirmByChat.delete(chatId);
      this.pendingPlanConfirmByToken.delete(confirm.token);
    }
  }

  private clearPlanInputSession(session: PendingPlanInputSession): void {
    this.pendingPlanInputByChat.delete(session.chatId);
    this.pendingPlanInputBySessionId.delete(session.sessionId);
  }

  private clearPlanConfirmationForChat(chatId: string): void {
    const existing = this.pendingPlanConfirmByChat.get(chatId);
    if (!existing) {
      return;
    }
    this.pendingPlanConfirmByChat.delete(chatId);
    this.pendingPlanConfirmByToken.delete(existing.token);
  }

  private getPlanQuestion(session: PendingPlanInputSession): UserInputQuestion | null {
    const question = session.questions[session.currentIndex];
    if (!question) {
      return null;
    }
    return question;
  }

  private buildPlanQuestionKeyboard(session: PendingPlanInputSession, question: UserInputQuestion): Record<string, unknown> {
    const inlineRows: Array<Array<{ text: string; callback_data: string }>> = [];
    question.options.forEach((option, optionIndex) => {
      const selected = session.multiSelections[question.id]?.has(option.id) ? '✅ ' : '';
      inlineRows.push([{
        text: `${selected}${truncate(compactText(option.label || option.id), 24)}`,
        callback_data: `plan_a:${session.sessionId}:${session.currentIndex}:${optionIndex}`,
      }]);
    });

    if (question.allowTextInput) {
      inlineRows.push([{
        text: this.t('✏️ 文本回答', '✏️ Answer in text'),
        callback_data: `plan_t:${session.sessionId}:${session.currentIndex}`,
      }]);
    }
    if (question.allowMultiple) {
      inlineRows.push([{
        text: this.t('✅ 提交本题', '✅ Submit this question'),
        callback_data: `plan_s:${session.sessionId}:${session.currentIndex}`,
      }]);
    }
    inlineRows.push([{
      text: this.t('🛑 取消本次计划', '🛑 Cancel this plan'),
      callback_data: `plan_x:${session.sessionId}`,
    }]);
    return { inline_keyboard: inlineRows };
  }

  private async sendPlanQuestion(session: PendingPlanInputSession): Promise<void> {
    const question = this.getPlanQuestion(session);
    if (!question) {
      await this.submitPlanAnswers(session);
      return;
    }

    const lines: string[] = [];
    lines.push(this.t('📝 Plan 模式需要你确认', '📝 Plan mode needs your input'));
    lines.push(this.locale === 'en'
      ? `Question ${session.currentIndex + 1}/${session.questions.length}`
      : `问题 ${session.currentIndex + 1}/${session.questions.length}`);
    if (question.header) {
      lines.push(this.locale === 'en'
        ? `Topic: ${question.header}`
        : `主题: ${question.header}`);
    }
    lines.push(question.prompt);

    if (question.options.length > 0) {
      lines.push('');
      lines.push(this.t('可选项：', 'Options:'));
      question.options.forEach((option, index) => {
        lines.push(`${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ''}`);
      });
    }

    if (question.allowMultiple) {
      lines.push(this.t('本题支持多选，勾选后点击“提交本题”。', 'This question allows multiple choices. Select options then tap "Submit this question".'));
    } else {
      lines.push(this.t('本题单选，点一个选项即可继续。', 'Single-choice question. Tap one option to continue.'));
    }
    if (question.allowTextInput) {
      lines.push(this.t('也可点“文本回答”，然后直接发送文本。', 'You can also tap "Answer in text", then send a text response.'));
    }

    this.emitFinal(session.chatId, session.messageId, lines.join('\n'), {
      replyMarkup: this.buildPlanQuestionKeyboard(session, question),
    });
  }

  private async submitPlanAnswers(session: PendingPlanInputSession): Promise<void> {
    const answered = this.runtimeManager.resolveUserInput(
      session.userInputRequestId,
      session.answers,
      session.threadId || undefined,
    );
    this.clearPlanInputSession(session);

    if (!answered) {
      this.emitFinal(
        session.chatId,
        session.messageId,
        this.t('该计划问题已失效，请重新发起计划。', 'This plan prompt has expired. Please start planning again.'),
        { replyMarkup: buildMainReplyKeyboard() },
      );
      return;
    }

    this.emitOutbound({
      type: 'executionStatus',
      chatId: session.chatId,
      messageId: session.messageId,
      status: 'running',
      text: this.t('已收到你的选择，正在继续生成计划…', 'Received your choices. Continuing plan generation...'),
      createdAt: nowMs(),
    });
  }

  private async tryConsumePlanTextAnswer(event: IncomingUserMessageEvent): Promise<boolean> {
    const session = this.pendingPlanInputByChat.get(event.chatId);
    if (!session) {
      return false;
    }
    this.cleanupExpiredPlanState();
    if (!this.pendingPlanInputByChat.has(event.chatId)) {
      return false;
    }

    const text = compactText(event.text || '');
    const question = this.getPlanQuestion(session);
    if (!question) {
      return false;
    }

    // Text-mode answer explicitly requested by button flow.
    if (session.awaitingTextQuestionId) {
      if (!text) {
        this.emitFinal(
          event.chatId,
          event.messageId,
          this.t('请发送非空文本作为回答，或使用按钮取消。', 'Please send a non-empty text answer, or cancel using button.'),
        );
        return true;
      }

      const questionId = session.awaitingTextQuestionId;
      session.awaitingTextQuestionId = null;
      session.answers[questionId] = text;
      session.currentIndex += 1;
      await this.sendPlanQuestion(session);
      return true;
    }

    // Fallback when inline buttons are unavailable on Telegram client.
    if (!text) {
      return true;
    }

    const optionCount = question.options.length;
    const indexTokens = text
      .split(/[,\s，、]+/)
      .map((token) => token.trim())
      .filter(Boolean);
    const allNumeric = indexTokens.length > 0 && indexTokens.every((token) => /^\d+$/.test(token));

    if (optionCount > 0 && allNumeric) {
      const indexes = indexTokens.map((token) => Number(token));
      if (indexes.some((idx) => idx < 1 || idx > optionCount)) {
        this.emitFinal(
          event.chatId,
          event.messageId,
          this.locale === 'en'
            ? `Invalid option index. Please send number 1-${optionCount}${question.allowMultiple ? ' (multi-select: e.g. "1 3")' : ''}.`
            : `选项编号无效，请发送 1-${optionCount}${question.allowMultiple ? '（多选示例：1 3）' : ''}。`,
        );
        return true;
      }

      if (question.allowMultiple) {
        const unique = Array.from(new Set(indexes));
        session.answers[question.id] = unique.map((idx) => question.options[idx - 1]!.id);
      } else {
        session.answers[question.id] = question.options[indexes[0]! - 1]!.id;
      }
      session.currentIndex += 1;
      await this.sendPlanQuestion(session);
      return true;
    }

    if (optionCount > 0 && !question.allowTextInput) {
      this.emitFinal(
        event.chatId,
        event.messageId,
        this.locale === 'en'
          ? `Please answer with option number${question.allowMultiple ? 's' : ''} (1-${optionCount}).`
          : `请使用选项编号作答${question.allowMultiple ? '（可多选）' : ''}，范围 1-${optionCount}。`,
      );
      return true;
    }

    if (question.allowTextInput) {
      session.answers[question.id] = text;
      session.currentIndex += 1;
      await this.sendPlanQuestion(session);
      return true;
    }

    if (!text) {
      this.emitFinal(
        event.chatId,
        event.messageId,
        this.t('请发送非空文本作为回答，或使用按钮取消。', 'Please send a non-empty text answer, or cancel using button.'),
      );
      return true;
    }

    return false;
  }

  private async handleUserInputRequest(event: UserInputRequestEvent): Promise<void> {
    this.cleanupExpiredPlanState();
    const context = this.turnContextByThread.get(event.threadId);
    let chatId = context?.chatId || '';
    let messageId = context?.messageId || randomUUID();
    if (!chatId) {
      const binding = this.db.getBindingByThread(event.threadId);
      if (binding) {
        chatId = binding.chatId;
      }
    }

    if (!chatId) {
      this.logger.warn('Dropping request_user_input because chat context is missing', {
        threadId: event.threadId,
        turnId: event.turnId,
      });
      this.runtimeManager.cancelUserInput(event.userInputRequestId, event.threadId || undefined);
      return;
    }

    const existing = this.pendingPlanInputByChat.get(chatId);
    if (existing) {
      this.runtimeManager.cancelUserInput(existing.userInputRequestId, existing.threadId || undefined);
      this.clearPlanInputSession(existing);
    }

    const sessionId = randomUUID().replace(/-/g, '').slice(0, 12);
    const normalizedQuestions = (event.questions.length > 0 ? event.questions : [{
      id: 'q1',
      prompt: this.t('请继续补充你的计划偏好。', 'Please provide additional planning preferences.'),
      allowMultiple: false,
      allowTextInput: true,
      options: [],
    }]).map((question) => {
      if ((question.options?.length || 0) === 0 && !question.allowTextInput) {
        return {
          ...question,
          allowTextInput: true,
        };
      }
      return question;
    });
    const session: PendingPlanInputSession = {
      sessionId,
      userInputRequestId: event.userInputRequestId,
      chatId,
      messageId,
      threadId: event.threadId,
      turnId: event.turnId,
      questions: normalizedQuestions,
      currentIndex: 0,
      answers: {},
      multiSelections: {},
      awaitingTextQuestionId: null,
      createdAt: nowMs(),
      expiresAt: nowMs() + PLAN_INPUT_TIMEOUT_MS,
    };
    this.pendingPlanInputByChat.set(chatId, session);
    this.pendingPlanInputBySessionId.set(sessionId, session);
    await this.sendPlanQuestion(session);
  }

  private async applyPlanConfirmationAction(
    event: IncomingControlCommandEvent,
    action: 'execute' | 'refine' | 'cancel',
    tokenHint?: string,
  ): Promise<boolean> {
    const confirmation = tokenHint
      ? this.pendingPlanConfirmByToken.get(tokenHint)
      : this.pendingPlanConfirmByChat.get(event.chatId);
    if (!confirmation || confirmation.chatId !== event.chatId) {
      this.emitFinal(
        event.chatId,
        event.messageId,
        this.t('当前没有待确认的计划。请先发起一条 Plan 消息。', 'There is no pending plan confirmation. Start a Plan message first.'),
      );
      return true;
    }

    this.pendingPlanConfirmByToken.delete(confirmation.token);
    this.pendingPlanConfirmByChat.delete(confirmation.chatId);

    if (action === 'cancel') {
      this.emitFinal(event.chatId, event.messageId, this.t('已取消本轮计划执行。', 'Plan execution cancelled.'), {
        replyMarkup: buildMainReplyKeyboard(),
      });
      return true;
    }

    if (action === 'refine') {
      this.emitFinal(
        event.chatId,
        event.messageId,
        this.t('好的，请继续补充要调整的部分，我会继续在 Plan 模式迭代。', 'Got it. Please send what to refine, and I will continue iterating in Plan mode.'),
        { replyMarkup: buildMainReplyKeyboard() },
      );
      return true;
    }

    this.oneShotModeByChat.set(event.chatId, 'code');
    this.emitFinal(
      event.chatId,
      event.messageId,
      this.t('已确认执行，正在按 Code 模式开始实施。', 'Execution confirmed. Starting implementation in Code mode.'),
      { replyMarkup: buildMainReplyKeyboard() },
    );
    const executeText = this.t(
      `请基于以下已确认计划直接开始执行，不要再停留在计划阶段：\n\n${confirmation.planText}`,
      `Execute directly based on this confirmed plan. Do not stay in planning mode:\n\n${confirmation.planText}`,
    );
    await this.handleIncomingMessage({
      type: 'incomingUserMessage',
      chatId: event.chatId,
      messageId: randomUUID(),
      text: executeText,
      createdAt: nowMs(),
    });
    return true;
  }

  private async handlePlanCallback(event: IncomingControlCommandEvent, payload: string): Promise<boolean> {
    const raw = String(payload || '').trim();
    if (!raw) {
      return false;
    }

    const parts = raw.split(':');
    const kind = parts[0];
    if (kind === 'plan_r') {
      const session = this.pendingPlanInputBySessionId.get(parts[1] || '');
      if (!session || session.chatId !== event.chatId) {
        this.emitFinal(event.chatId, event.messageId, this.t('该题目已过期，请重新发起计划。', 'This question has expired. Please start planning again.'));
        return true;
      }
      await this.sendPlanQuestion(session);
      return true;
    }

    if (kind === 'plan_x') {
      const session = this.pendingPlanInputBySessionId.get(parts[1] || '');
      if (!session || session.chatId !== event.chatId) {
        this.emitFinal(event.chatId, event.messageId, this.t('该计划已过期。', 'This plan has expired.'));
        return true;
      }
      this.runtimeManager.cancelUserInput(session.userInputRequestId, session.threadId || undefined);
      this.clearPlanInputSession(session);
      this.emitFinal(event.chatId, event.messageId, this.t('已取消本次计划提问。', 'Plan questioning cancelled.'), {
        replyMarkup: buildMainReplyKeyboard(),
      });
      return true;
    }

    if (kind === 'plan_a' || kind === 'plan_t' || kind === 'plan_s') {
      const sessionId = parts[1] || '';
      const questionIndex = Number(parts[2] || -1);
      const session = this.pendingPlanInputBySessionId.get(sessionId);
      if (!session || session.chatId !== event.chatId) {
        this.emitFinal(event.chatId, event.messageId, this.t('该题目已过期，请重新发起计划。', 'This question has expired. Please start planning again.'));
        return true;
      }
      const question = this.getPlanQuestion(session);
      if (!question || questionIndex !== session.currentIndex) {
        await this.sendPlanQuestion(session);
        return true;
      }

      if (kind === 'plan_t') {
        if (!question.allowTextInput) {
          this.emitFinal(event.chatId, event.messageId, this.t('该题不支持文本输入，请使用按钮选择。', 'Text input is not enabled for this question.'));
          return true;
        }
        session.awaitingTextQuestionId = question.id;
        this.emitFinal(event.chatId, event.messageId, this.t('请直接发送你的文本回答。', 'Please send your text answer now.'));
        return true;
      }

      if (kind === 'plan_a') {
        const optionIndex = Number(parts[3] || -1);
        const option = question.options[optionIndex];
        if (!option) {
          this.emitFinal(event.chatId, event.messageId, this.t('选项已失效，请重新选择。', 'Option expired. Please choose again.'));
          return true;
        }

        if (question.allowMultiple) {
          if (!session.multiSelections[question.id]) {
            session.multiSelections[question.id] = new Set<string>();
          }
          const selected = session.multiSelections[question.id];
          if (selected.has(option.id)) {
            selected.delete(option.id);
          } else {
            selected.add(option.id);
          }
          await this.sendPlanQuestion(session);
          return true;
        }

        session.answers[question.id] = option.id;
        session.awaitingTextQuestionId = null;
        session.currentIndex += 1;
        await this.sendPlanQuestion(session);
        return true;
      }

      if (kind === 'plan_s') {
        if (!question.allowMultiple) {
          this.emitFinal(event.chatId, event.messageId, this.t('该题无需提交，选择选项即可继续。', 'This question does not need submit; choosing one option continues.'));
          return true;
        }
        const selected = session.multiSelections[question.id] || new Set<string>();
        if (selected.size === 0) {
          this.emitFinal(event.chatId, event.messageId, this.t('请至少选择一个选项再提交。', 'Please select at least one option before submit.'));
          return true;
        }
        session.answers[question.id] = Array.from(selected.values());
        session.awaitingTextQuestionId = null;
        session.currentIndex += 1;
        await this.sendPlanQuestion(session);
        return true;
      }
    }

    if (kind === 'plan_e' || kind === 'plan_f' || kind === 'plan_c') {
      const token = parts[1] || '';
      if (kind === 'plan_c') {
        return await this.applyPlanConfirmationAction(event, 'cancel', token);
      }

      if (kind === 'plan_f') {
        return await this.applyPlanConfirmationAction(event, 'refine', token);
      }

      return await this.applyPlanConfirmationAction(event, 'execute', token);
    }

    return false;
  }

  private chatModeStateKey(chatId: string): string {
    return `${CHAT_MODE_STATE_PREFIX}${chatId}`;
  }

  private getChatModeOverride(chatId: string): ChatModeOverride | null {
    const raw = (this.db.getState(this.chatModeStateKey(chatId)) || '').trim().toLowerCase();
    if (raw === 'plan' || raw === 'code') {
      return raw;
    }
    return null;
  }

  private setChatModeOverride(chatId: string, mode: ChatModeOverride): void {
    this.db.setState(this.chatModeStateKey(chatId), mode, nowMs());
  }

  private modeLabel(mode: ChatModeOverride): string {
    return mode === 'plan' ? 'Plan' : 'Code';
  }

  private isCollaborationModeListUnsupportedError(message: string): boolean {
    const normalized = (message || '').trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    if (normalized.includes('collaborationmode/list')) {
      return /method not found|unsupported|unknown|unrecognized|not implemented/.test(normalized);
    }
    if (!normalized.includes('collaboration')) {
      return false;
    }
    return /method not found|unsupported|unknown|unrecognized|not implemented/.test(normalized);
  }

  private buildTurnCollaborationModePayload(mode: CollaborationModeMask): TurnCollaborationModePayload {
    const settings: TurnCollaborationModePayload['settings'] = {};
    settings.model = mode.model || this.options.fallbackModel;
    if (mode.reasoningEffort) {
      settings.reasoning_effort = mode.reasoningEffort;
    }
    if (mode.developerInstructions) {
      settings.developer_instructions = mode.developerInstructions;
    }
    return {
      mode: mode.wireMode,
      settings,
    };
  }

  private async listCollaborationModes(forceRefresh = false): Promise<CollaborationModeMask[]> {
    const now = nowMs();
    if (
      !forceRefresh
      && this.collaborationModesCache
      && now - this.collaborationModesCache.loadedAt <= COLLABORATION_MODE_CACHE_TTL_MS
    ) {
      return this.collaborationModesCache.modes;
    }

    const control = await this.getControlClient();
    const modes = await withTimeout(
      control.listCollaborationModes(),
      Math.min(this.options.requestTimeoutMs, 10_000),
      'collaborationMode/list',
    );
    this.collaborationModesCache = {
      loadedAt: now,
      modes,
    };
    return modes;
  }

  private async resolveTurnModeForMessage(chatId: string): Promise<TurnModeResolution | null> {
    const oneShot = this.oneShotModeByChat.get(chatId);
    if (oneShot) {
      this.oneShotModeByChat.delete(chatId);
    }
    const override = oneShot || this.getChatModeOverride(chatId);
    if (!override) {
      return null;
    }

    try {
      const modes = await this.listCollaborationModes();
      const matched = modes.find((mode) => mode.mode === override);
      if (!matched) {
        return {
          override,
          payload: null,
          warningText: this.locale === 'en'
            ? `${this.modeLabel(override)} mode is not supported by current Codex version. Falling back to default mode for this message.`
            : `当前 Codex 版本不支持 ${this.modeLabel(override)} 模式，本条消息已按默认模式继续。`,
        };
      }
      return {
        override,
        payload: this.buildTurnCollaborationModePayload(matched),
        warningText: null,
      };
    } catch (error: any) {
      const message = error?.message || String(error);
      this.logger.warn('Failed to resolve collaboration mode for turn; fallback to default turn mode', {
        chatId,
        override,
        error: message,
      });
      const unsupported = this.isCollaborationModeListUnsupportedError(message);
      return {
        override,
        payload: null,
        warningText: unsupported
          ? this.t(
            '当前 Codex 版本不支持原生 Plan/Code 模式切换，本条消息已按默认模式继续。',
            'Current Codex version does not support native Plan/Code mode switching. This message continues with default mode.',
          )
          : this.t(
            `${this.modeLabel(override)} 模式暂时不可用，本条消息已按默认模式继续。`,
            `${this.modeLabel(override)} mode is temporarily unavailable. This message continues with default mode.`,
          ),
      };
    }
  }

  private async handlePlanCommand(event: IncomingControlCommandEvent): Promise<void> {
    this.cleanupExpiredPlanState();
    const args = String(event.args || '').trim();
    const [firstToken, ...restTokens] = args.split(/\s+/).filter(Boolean);
    const action = String(firstToken || '').toLowerCase();

    if ((action === 'callback' || action === 'cb') && restTokens.length > 0) {
      const handled = await this.handlePlanCallback(event, restTokens.join(' '));
      if (!handled) {
        this.emitFinal(event.chatId, event.messageId, this.t('该按钮已失效，请重试 /plan status。', 'This button expired. Please retry /plan status.'));
      }
      return;
    }

    if (action === 'on') {
      let modes: CollaborationModeMask[] = [];
      try {
        modes = await this.listCollaborationModes(true);
      } catch (error: any) {
        const message = error?.message || String(error);
        const unsupported = this.isCollaborationModeListUnsupportedError(message);
        this.emitFinal(
          event.chatId,
          event.messageId,
          unsupported
            ? this.t(
              '当前 Codex 版本不支持原生 Plan mode。',
              'Current Codex version does not support native Plan mode.',
            )
            : this.locale === 'en'
              ? `Plan mode probe failed, please retry later: ${message}`
              : `Plan mode 探测失败，请稍后重试：${message}`,
          { replyMarkup: buildMainReplyKeyboard() },
        );
        return;
      }

      const planMode = modes.find((mode) => mode.mode === 'plan');
      if (!planMode) {
        this.emitFinal(
          event.chatId,
          event.messageId,
          this.t('当前 Codex 版本不支持原生 Plan mode。', 'Current Codex version does not support native Plan mode.'),
          { replyMarkup: buildMainReplyKeyboard() },
        );
        return;
      }

      this.setChatModeOverride(event.chatId, 'plan');
      this.emitFinal(
        event.chatId,
        event.messageId,
        this.t(
          '已切换为 Plan mode。\n后续消息会按原生 Plan 模式执行。\n可用：/plan status 或 /plan off',
          'Switched to Plan mode.\nFollowing messages will run with native Plan mode.\nAvailable: /plan status or /plan off',
        ),
        { replyMarkup: buildMainReplyKeyboard() },
      );
      return;
    }

    if (action === 'off') {
      const pendingPlanInput = this.pendingPlanInputByChat.get(event.chatId);
      if (pendingPlanInput) {
        this.runtimeManager.cancelUserInput(pendingPlanInput.userInputRequestId, pendingPlanInput.threadId || undefined);
        this.clearPlanInputSession(pendingPlanInput);
      }
      this.clearPlanConfirmationForChat(event.chatId);
      this.setChatModeOverride(event.chatId, 'code');
      this.emitFinal(
        event.chatId,
        event.messageId,
        this.t(
          '已切换为 Code 模式。\n后续消息会按原生 Code 模式执行；若当前版本不支持将自动降级。',
          'Switched to Code mode.\nFollowing messages will run with native Code mode; if unsupported, it will degrade automatically.',
        ),
        { replyMarkup: buildMainReplyKeyboard() },
      );
      return;
    }

    if (action === 'execute' || action === 'confirm' || action === 'run') {
      await this.applyPlanConfirmationAction(event, 'execute');
      return;
    }

    if (action === 'refine' || action === 'edit' || action === 'continue') {
      await this.applyPlanConfirmationAction(event, 'refine');
      return;
    }

    if (action === 'cancel' || action === 'abort') {
      await this.applyPlanConfirmationAction(event, 'cancel');
      return;
    }

    if (action === 'status') {
      const override = this.getChatModeOverride(event.chatId);
      const pendingInput = this.pendingPlanInputByChat.get(event.chatId);
      const pendingConfirm = this.pendingPlanConfirmByChat.get(event.chatId);
      const lines: string[] = [
        this.t('🧭 模式状态', '🧭 Mode status'),
        this.locale === 'en'
          ? `Current override: ${override ? this.modeLabel(override) : 'default (none)'}`
          : `当前覆盖模式: ${override ? this.modeLabel(override) : '默认（未设置）'}`,
      ];
      if (pendingInput) {
        lines.push(this.locale === 'en'
          ? `Pending questions: Q${pendingInput.currentIndex + 1}/${pendingInput.questions.length}`
          : `待回答问题: 第 ${pendingInput.currentIndex + 1}/${pendingInput.questions.length} 题`);
      } else {
        lines.push(this.t('待回答问题: 无', 'Pending questions: none'));
      }
      lines.push(pendingConfirm
        ? this.t('计划确认: 待确认执行', 'Plan confirmation: waiting for execution confirm')
        : this.t('计划确认: 无', 'Plan confirmation: none'));
      try {
        const modes = await this.listCollaborationModes();
        const hasPlan = modes.some((mode) => mode.mode === 'plan');
        const hasCode = modes.some((mode) => mode.mode === 'code');
        lines.push(
          this.locale === 'en'
            ? `Native support: Plan ${hasPlan ? '✅' : '❌'} / Code ${hasCode ? '✅' : '❌'}`
            : `原生支持: Plan ${hasPlan ? '✅' : '❌'} / Code ${hasCode ? '✅' : '❌'}`,
        );
      } catch (error: any) {
        const message = error?.message || String(error);
        const unsupported = this.isCollaborationModeListUnsupportedError(message);
        lines.push(
          unsupported
            ? this.t('原生模式列表: 当前版本不支持。', 'Native mode list: unsupported by current version.')
            : this.locale === 'en'
              ? `Native mode list: unavailable (${truncate(message, 120)})`
              : `原生模式列表: 暂不可用（${truncate(message, 120)}）`,
        );
      }
      lines.push(this.t('可用: /plan on | /plan off | /plan execute | /plan refine | /plan cancel', 'Available: /plan on | /plan off | /plan execute | /plan refine | /plan cancel'));

      const inlineRows: Array<Array<{ text: string; callback_data: string }>> = [];
      if (pendingInput) {
        inlineRows.push([{
          text: this.t('继续答题', 'Continue questions'),
          callback_data: `plan_r:${pendingInput.sessionId}`,
        }]);
      }
      if (pendingConfirm) {
        inlineRows.push(
          [{ text: this.t('✅ 确认并执行', '✅ Execute plan'), callback_data: `plan_e:${pendingConfirm.token}` }],
          [{ text: this.t('✏️ 继续改计划', '✏️ Refine plan'), callback_data: `plan_f:${pendingConfirm.token}` }],
          [{ text: this.t('🛑 取消本轮', '🛑 Cancel'), callback_data: `plan_c:${pendingConfirm.token}` }],
        );
      }
      this.emitFinal(event.chatId, event.messageId, lines.join('\n'), {
        replyMarkup: buildMainReplyKeyboard(),
      });
      if (inlineRows.length > 0) {
        this.emitFinal(event.chatId, event.messageId, this.t('可点下方按钮继续。', 'Use buttons below to continue.'), {
          replyMarkup: {
            inline_keyboard: inlineRows,
          },
        });
      }
      return;
    }

    this.emitFinal(
      event.chatId,
      event.messageId,
      this.t(
        '用法: /plan on | /plan off | /plan status | /plan execute | /plan refine | /plan cancel',
        'Usage: /plan on | /plan off | /plan status | /plan execute | /plan refine | /plan cancel',
      ),
      {
        replyMarkup: buildMainReplyKeyboard(),
      },
    );
  }

  private async handleCancelCommand(event: IncomingControlCommandEvent): Promise<void> {
    const pendingPlanInput = this.pendingPlanInputByChat.get(event.chatId);
    if (pendingPlanInput) {
      this.runtimeManager.cancelUserInput(pendingPlanInput.userInputRequestId, pendingPlanInput.threadId || undefined);
      this.clearPlanInputSession(pendingPlanInput);
    }
    this.clearPlanConfirmationForChat(event.chatId);

    const binding = this.getBinding();
    if (!binding) {
      this.emitFinal(event.chatId, event.messageId, this.t('当前未绑定会话，无法终止任务。', 'No bound thread. Unable to cancel tasks.'));
      return;
    }

    const threadId = binding.threadId;
    const hasRunning = this.runningTurns.has(threadId);
    const hasQueued = this.queuedByThread.has(threadId);
    if (!hasRunning && !hasQueued) {
      this.emitFinal(event.chatId, event.messageId, this.t('当前没有可终止的运行中/排队任务。', 'There is no running or queued task to cancel.'), {
        replyMarkup: buildMainReplyKeyboard(),
      });
      return;
    }

    this.cancelRequestedByThread.add(threadId);
    this.queuedByThread.delete(threadId);

    let resetError: string | null = null;
    if (hasRunning) {
      try {
        await this.runtimeManager.resetThread(threadId);
      } catch (error: any) {
        resetError = error?.message || String(error);
      }
    }

    if (resetError) {
      this.emitFinal(
        event.chatId,
        event.messageId,
        this.locale === 'en'
          ? `Cancellation requested, but runtime reset failed: ${resetError}`
          : `终止请求已提交，但重置运行时失败：${resetError}`,
        { replyMarkup: buildMainReplyKeyboard() },
      );
      return;
    }

    const summary = hasRunning && hasQueued
      ? this.t('已终止当前任务，并清空排队消息。', 'Current task cancelled and queued message cleared.')
      : hasRunning
        ? this.t('已终止当前任务。', 'Current task cancelled.')
        : this.t('已清空排队消息。', 'Queued message cleared.');
    this.emitFinal(event.chatId, event.messageId, summary, {
      replyMarkup: buildMainReplyKeyboard(),
    });
  }

  private async processMessage(threadId: string, event: IncomingUserMessageEvent): Promise<void> {
    const startedAt = Date.now();
    const turnInput = buildTurnInputs(event, this.locale);
    const turnModeResolution = await this.resolveTurnModeForMessage(event.chatId);
    this.turnContextByThread.set(threadId, {
      chatId: event.chatId,
      messageId: event.messageId,
    });

    this.emitOutbound({
      type: 'executionStatus',
      chatId: event.chatId,
      messageId: event.messageId,
      status: 'running',
      text: this.t('已接收，正在让 Codex 处理…', 'Received, processing with Codex...'),
      createdAt: Date.now(),
    });
    if (turnModeResolution?.warningText) {
      this.emitOutbound({
        type: 'executionStatus',
        chatId: event.chatId,
        messageId: event.messageId,
        status: 'running',
        text: turnModeResolution.warningText,
        createdAt: Date.now(),
      });
    }

    const heartbeat = setInterval(() => {
      this.emitOutbound({
        type: 'executionStatus',
        chatId: event.chatId,
        messageId: event.messageId,
        status: 'running',
        text: this.locale === 'en'
          ? `Still processing (${Math.max(1, Math.floor((Date.now() - startedAt) / 1000))}s)`
          : `仍在处理中（${Math.max(1, Math.floor((Date.now() - startedAt) / 1000))} 秒）`,
        createdAt: Date.now(),
      });
    }, 30_000);
    heartbeat.unref();

    let result: TurnExecutionResult;
    let recoveryAttempt = 0;
    const perAttemptTurnTimeoutMs = this.options.turnTimeoutMs;
    const attemptHardLimitMs = perAttemptTurnTimeoutMs > 0 ? perAttemptTurnTimeoutMs + 10_000 : 0;
    const withAttemptTimeout = async <T>(promise: Promise<T>): Promise<T> => {
      if (attemptHardLimitMs <= 0) {
        return await promise;
      }
      return await new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`runtime unresponsive after ${attemptHardLimitMs}ms`));
        }, attemptHardLimitMs);
        timer.unref();
        promise
          .then((value) => {
            clearTimeout(timer);
            resolve(value);
          })
          .catch((error) => {
            clearTimeout(timer);
            reject(error);
          });
      });
    };
    const runTurnOnce = async (): Promise<TurnExecutionResult> => {
      this.logger.info('Starting turn attempt', {
        threadId,
        messageId: event.messageId,
        imageInputs: turnInput.filter((item) => item.type === 'localImage' || item.type === 'image').length,
        inputItems: turnInput.length,
        timeoutMs: perAttemptTurnTimeoutMs,
        hardLimitMs: attemptHardLimitMs > 0 ? attemptHardLimitMs : null,
      });
      try {
        const result = await withAttemptTimeout((async () => {
          const runtime = await this.runtimeManager.getOrCreate(threadId);
          return await runtime.runTurn(
            threadId,
            turnInput,
            perAttemptTurnTimeoutMs,
            turnModeResolution?.payload
              ? {
                collaborationMode: turnModeResolution.payload,
              }
              : undefined,
          );
        })());
        this.logger.info('Turn attempt finished', {
          threadId,
          messageId: event.messageId,
          status: result.status,
          errorMessage: result.errorMessage || null,
        });
        return result;
      } catch (error: any) {
        const failed = {
          threadId,
          turnId: '',
          status: 'failed',
          finalText: '',
          errorMessage: error?.message || String(error),
          usedFallback: false,
        } satisfies TurnExecutionResult;
        this.logger.warn('Turn attempt failed before completion', {
          threadId,
          messageId: event.messageId,
          errorMessage: failed.errorMessage || null,
        });
        return failed;
      }
    };

    try {
      result = await runTurnOnce();
    } finally {
      clearInterval(heartbeat);
    }

    if (this.cancelRequestedByThread.has(threadId)) {
      this.logger.info('Turn cancelled by user; suppressing result output', {
        threadId,
        messageId: event.messageId,
      });
      return;
    }

    while (
      result.status === 'failed'
      && !this.cancelRequestedByThread.has(threadId)
      && this.shouldRetryAfterRuntimeError(result.errorMessage || '')
      && recoveryAttempt < this.maxRecoveryAttemptsForError(result.errorMessage || '')
    ) {
      recoveryAttempt += 1;
      const maxRecoveryAttempts = this.maxRecoveryAttemptsForError(result.errorMessage || '');
      this.emitOutbound({
        type: 'executionStatus',
        chatId: event.chatId,
        messageId: event.messageId,
        status: 'running',
        text: this.locale === 'en'
          ? `Codex connection interrupted. Retrying automatically (${recoveryAttempt}/${maxRecoveryAttempts})...`
          : `检测到 Codex 连接中断，正在自动重试（${recoveryAttempt}/${maxRecoveryAttempts}）…`,
        createdAt: Date.now(),
      });

      this.logger.warn('Resetting runtime before retry', {
        threadId,
        messageId: event.messageId,
        recoveryAttempt,
      });
      await this.runtimeManager.resetThread(threadId);
      await new Promise((resolve) => setTimeout(resolve, 300));
      result = await runTurnOnce();
    }

    if (this.cancelRequestedByThread.has(threadId)) {
      this.logger.info('Turn cancelled by user during retry; suppressing result output', {
        threadId,
        messageId: event.messageId,
      });
      return;
    }

    if (result.status === 'completed') {
      this.emitOutbound({
        type: 'executionStatus',
        chatId: event.chatId,
        messageId: event.messageId,
        status: 'completed',
        text: result.usedFallback
          ? this.t('已完成（自动回退模型）', 'Completed (fallback model used)')
          : this.t('已完成', 'Completed'),
        createdAt: Date.now(),
      });

      if (turnModeResolution?.override === 'plan') {
        const token = randomUUID().replace(/-/g, '').slice(0, 12);
        this.clearPlanConfirmationForChat(event.chatId);
        const confirmation: PendingPlanConfirmation = {
          token,
          chatId: event.chatId,
          messageId: event.messageId,
          threadId,
          planText: result.finalText || 'OK',
          createdAt: nowMs(),
          expiresAt: nowMs() + PLAN_CONFIRM_TIMEOUT_MS,
        };
        this.pendingPlanConfirmByChat.set(event.chatId, confirmation);
        this.pendingPlanConfirmByToken.set(token, confirmation);
        this.emitOutbound({
          type: 'finalResponse',
          chatId: event.chatId,
          messageId: event.messageId,
          text: `${result.finalText || 'OK'}\n\n${this.t(
            '——\n请确认下一步：\n• /plan execute  确认并执行\n• /plan refine  继续改计划\n• /plan cancel  取消本轮',
            '--\nConfirm next step:\n• /plan execute  execute plan\n• /plan refine  keep refining plan\n• /plan cancel  cancel this plan',
          )}`,
          purpose: 'turn',
          options: {
            replyMarkup: {
              inline_keyboard: [
                [{ text: this.t('✅ 确认并执行', '✅ Execute plan'), callback_data: `plan_e:${token}` }],
                [{ text: this.t('✏️ 继续改计划', '✏️ Refine plan'), callback_data: `plan_f:${token}` }],
                [{ text: this.t('🛑 取消本轮', '🛑 Cancel'), callback_data: `plan_c:${token}` }],
              ],
            },
          },
          createdAt: Date.now(),
        });
        return;
      }

      this.emitOutbound({
        type: 'finalResponse',
        chatId: event.chatId,
        messageId: event.messageId,
        text: result.finalText || 'OK',
        purpose: 'turn',
        createdAt: Date.now(),
      });
      return;
    }

    this.emitOutbound({
      type: 'executionStatus',
      chatId: event.chatId,
      messageId: event.messageId,
      status: 'failed',
      text: result.errorMessage || this.t('执行失败', 'Execution failed'),
      createdAt: Date.now(),
    });

    this.emitOutbound({
      type: 'finalResponse',
      chatId: event.chatId,
      messageId: event.messageId,
      text: this.locale === 'en'
        ? `Execution failed: ${result.errorMessage || 'unknown error'}`
        : `执行失败：${result.errorMessage || 'unknown error'}`,
      purpose: 'turn',
      createdAt: Date.now(),
    });
  }

  private async sendHelp(chatId: string, messageId: string): Promise<void> {
    this.emitFinal(
      chatId,
      messageId,
      this.locale === 'en'
        ? [
            'Remote control menu (tap keyboard buttons directly):',
            '/threads - list recent threads (compact list with index binding)',
            '/bind latest - bind latest thread',
            '/bind <threadId|index> - bind by id (or legacy index)',
            '/usage (or /limits) - show Codex rate limits remaining',
            '/plan on|off|status - switch or check native Plan mode',
            '/active - quick view of active conversation thread',
            '/detail <index|threadId|current|latest> - view details (source/ID/CWD)',
            '/current - show latest snapshot of bound thread',
            '/status - show binding and runtime status',
            '/cancel - stop current task and clear queue',
            '/unbind - remove current binding',
            '/help - show this menu again',
          ].join('\n')
        : [
            '远程控制菜单（可直接点键盘按钮）：',
            '/threads - 查看最近会话（精简列表，支持编号绑定）',
            '/bind latest - 绑定最新会话',
            '/bind <threadId|编号> - 按 ID（或兼容旧编号）绑定',
            '/usage（或 /limits）- 查看 Codex 剩余用量',
            '/plan on|off|status - 切换或查看原生 Plan 模式',
            '/active - 快速查看当前正在对话的会话',
            '/detail <编号|threadId|current|latest> - 查看会话详情（来源/ID/CWD）',
            '/current - 查看当前绑定会话的最近对话快照',
            '/status - 查看绑定与运行状态',
            '/cancel - 终止当前运行任务并清空排队',
            '/unbind - 解除当前绑定',
            '/help - 再次显示菜单',
          ].join('\n'),
      {
        replyMarkup: buildMainReplyKeyboard(),
      },
    );
  }

  private buildDisplayThreadsState(chatId: string, threads: ThreadSummary[]): DisplayThreadsState {
    const currentBinding = this.getBinding();
    const sidebarMetadata = loadCodexSidebarMetadata(this.logger);
    const visibility = filterThreadsBySidebarVisibility(threads, sidebarMetadata);
    const deduped = dedupeThreadsForDisplay(
      visibility.threads,
      currentBinding?.threadId || null,
      sidebarMetadata,
      this.locale,
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

  private async handleThreadsCommand(event: IncomingControlCommandEvent): Promise<void> {
    let threads: ThreadSummary[] = [];
    let listDegraded = false;
    let listErrorMessage = '';
    try {
      threads = await withTimeout(
        this.listThreads(THREAD_LIST_LIMIT),
        Math.min(this.options.requestTimeoutMs, 6_000),
        'thread/list',
      );
    } catch (firstError: any) {
      // Degrade to local sidebar metadata so /threads always responds quickly.
      listDegraded = true;
      listErrorMessage = firstError?.message || String(firstError);
      const sidebarMetadata = loadCodexSidebarMetadata(this.logger);
      threads = listThreadsFromSidebarMetadata(sidebarMetadata, this.locale);
    }
    if (threads.length === 0) {
      this.emitFinal(event.chatId, event.messageId, this.t('当前没有可用会话。', 'No available threads found.'));
      return;
    }

    const state = this.buildDisplayThreadsState(event.chatId, threads);
    const displayItems = state.displayItems;
    if (displayItems.length === 0) {
      this.emitFinal(event.chatId, event.messageId, this.t('当前没有可展示的会话。', 'No visible threads to display.'));
      return;
    }

    this.recentThreadsByChat.set(event.chatId, {
      threads: displayItems.map((item) => item.thread),
      updatedAt: nowMs(),
    });

    const lines: string[] = [this.t('最近会话：', 'Recent threads:')];
    if (listDegraded) {
      lines.push(this.t(
        '⚠️ 列表已降级：Codex 暂时忙或响应慢，已使用侧边栏缓存生成列表（更新时间可能缺失）。',
        '⚠️ Degraded list: Codex is busy/slow. Using sidebar cache (timestamps may be missing).',
      ));
      if (listErrorMessage) {
        lines.push(this.locale === 'en'
          ? `Reason: ${escapeTelegramHtml(truncate(listErrorMessage, 120))}`
          : `原因: ${escapeTelegramHtml(truncate(listErrorMessage, 120))}`);
      }
      lines.push('');
    }
    const currentItem = state.currentBinding
      ? displayItems.find((item) => item.thread.id === state.currentBinding?.threadId) || null
      : null;
    if (currentItem) {
      lines.push(this.locale === 'en'
        ? `Current thread: ✅ <b>${escapeTelegramHtml(currentItem.title)}</b>`
        : `当前会话: ✅ <b>${escapeTelegramHtml(currentItem.title)}</b>`);
    } else if (state.currentBinding) {
      lines.push(this.t('当前会话: ✅ <b>(已绑定，但不在最近列表)</b>', 'Current thread: ✅ <b>(bound but not in recent list)</b>'));
    } else {
      lines.push(this.t('当前会话: (未绑定)', 'Current thread: (not bound)'));
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
      if (thread.updatedAt > 0) {
        lines.push(
          this.locale === 'en'
            ? `   Updated: ${escapeTelegramHtml(formatLocalTime(toEpochMs(thread.updatedAt)))}`
            : `   更新: ${escapeTelegramHtml(formatLocalTime(toEpochMs(thread.updatedAt)))}`,
        );
      }
    });
    if (state.mergedCount > 0) {
      lines.push(this.locale === 'en' ? `Merged near-duplicate threads: ${state.mergedCount}` : `已合并近似重复会话: ${state.mergedCount}`);
    }
    if (state.usingSidebarVisibility && state.hiddenCount > 0) {
      lines.push(this.locale === 'en' ? `Filtered sidebar-invisible threads: ${state.hiddenCount}` : `已过滤侧边栏不可见会话: ${state.hiddenCount}`);
    }
    lines.push('');
    lines.push(this.t('可用: /bind [编号] | /detail [编号] | /bind latest', 'Available: /bind [index] | /detail [index] | /bind latest'));
    lines.push(this.t('快速查看当前: /active', 'Quick view current: /active'));
    lines.push(this.t('提示: 详情信息（来源/ID/CWD）请用 /detail。', 'Tip: use /detail for source/ID/CWD details.'));

    this.emitFinal(event.chatId, event.messageId, lines.join('\n'), {
      replyMarkup: buildThreadsInlineKeyboard(
        displayItems,
        state.currentBinding?.threadId || null,
        this.locale,
      ),
      parseMode: 'HTML',
    });
  }

  private getCachedThreads(chatId: string): ThreadSummary[] | null {
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

  private pickPreferredLatestThread(threads: ThreadSummary[]): ThreadSummary | null {
    if (threads.length === 0) {
      return null;
    }

    const preferred = threads.find((thread) => thread.source === 'vscode' || thread.source === 'appServer');
    return preferred || threads[0];
  }

  private async handleBindCommand(event: IncomingControlCommandEvent): Promise<void> {
    const argRaw = (event.args || '').trim();
    if (!argRaw) {
      this.emitFinal(event.chatId, event.messageId, this.t('用法: /bind latest 或 /bind <threadId|编号>', 'Usage: /bind latest or /bind <threadId|index>'));
      return;
    }

    const control = await this.getControlClient();
    let targetThreadId = argRaw;
    let visibleThreads: ThreadSummary[] | null = null;
    let usingSidebarVisibility = false;
    let sidebarMetadata: CodexSidebarMetadata | null = null;

    if (argRaw === 'latest') {
      const latest = await control.listThreads(THREAD_LIST_LIMIT);
      sidebarMetadata = loadCodexSidebarMetadata(this.logger);
      const visibility = filterThreadsBySidebarVisibility(latest, sidebarMetadata);
      visibleThreads = visibility.threads;
      usingSidebarVisibility = visibility.usingSidebarVisibility;
      const deduped = dedupeThreadsForDisplay(
        visibleThreads,
        this.getBinding()?.threadId || null,
        sidebarMetadata,
        this.locale,
      );
      const preferred = this.pickPreferredLatestThread(deduped.items.map((item) => item.thread));
      if (!preferred) {
        this.emitFinal(event.chatId, event.messageId, this.t('没有可绑定的会话。', 'No thread available to bind.'));
        return;
      }
      targetThreadId = preferred.id;
    } else if (/^\d+$/.test(argRaw)) {
      const index = Number(argRaw);
      const cached = this.getCachedThreads(event.chatId);
      if (!cached || cached.length === 0) {
        this.emitFinal(event.chatId, event.messageId, this.t('最近会话缓存已过期，请先执行 /threads。', 'Recent thread cache expired. Run /threads first.'));
        return;
      }
      if (!Number.isFinite(index) || index <= 0 || index > cached.length) {
        this.emitFinal(
          event.chatId,
          event.messageId,
          this.locale === 'en' ? `Invalid index. Please enter 1 to ${cached.length}.` : `编号无效，请输入 1 到 ${cached.length}。`,
        );
        return;
      }
      targetThreadId = cached[index - 1].id;
    }

    if (event.source === 'callback') {
      if (!visibleThreads || !sidebarMetadata) {
        const latest = await control.listThreads(THREAD_LIST_LIMIT);
        sidebarMetadata = loadCodexSidebarMetadata(this.logger);
        const visibility = filterThreadsBySidebarVisibility(latest, sidebarMetadata);
        visibleThreads = visibility.threads;
        usingSidebarVisibility = visibility.usingSidebarVisibility;
      }

      if (usingSidebarVisibility && visibleThreads && !visibleThreads.some((thread) => thread.id === targetThreadId)) {
        this.emitFinal(event.chatId, event.messageId, this.t('该会话在 Codex 侧边栏已删除或隐藏，请先执行 /threads 刷新列表。', 'This thread is deleted or hidden in Codex sidebar. Run /threads to refresh list.'), {
          replyMarkup: buildMainReplyKeyboard(),
        });
        return;
      }
    }

    let readResult: Awaited<ReturnType<CodexAppServerClient['readThread']>> | null = null;
    try {
      readResult = await withTimeout(
        control.readThread(targetThreadId),
        Math.min(this.options.requestTimeoutMs, 12_000),
        'thread/read(bind)',
      );
      if (readResult && !readResult.thread?.id) {
        this.emitFinal(event.chatId, event.messageId, this.locale === 'en' ? `Bind failed: unable to read thread ${targetThreadId}` : `绑定失败：无法读取线程 ${targetThreadId}`);
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
    this.db.saveBinding(this.bindingChatId(), targetThreadId, `thread:${source}`, nowMs());

    const preview = sanitizePreview(String(readResult?.thread?.preview || ''));
    this.emitFinal(
      event.chatId,
      event.messageId,
      [
        this.locale === 'en' ? `Bound thread: ${targetThreadId}` : `已绑定线程: ${targetThreadId}`,
        this.locale === 'en' ? `Source: ${source}` : `来源: ${source}`,
        preview ? (this.locale === 'en' ? `Preview: ${truncate(preview, 160)}` : `预览: ${truncate(preview, 160)}`) : null,
        !readResult ? this.t('提示: 元数据读取超时，已先完成绑定；首次消息会自动继续。', 'Tip: metadata read timed out; binding already completed. First message will continue automatically.') : null,
        source === 'cli' ? this.t('提示: 该线程来源为 cli，在 Codex App 中可能不显示实时更新。', 'Tip: this thread is from CLI and may not appear live-updated in Codex App.') : null,
        this.t('可用: /current 查看当前会话快照', 'Available: /current to view current thread snapshot'),
      ]
        .filter(Boolean)
        .join('\n'),
      {
        replyMarkup: buildMainReplyKeyboard(),
      },
    );
  }

  private async handleActiveCommand(event: IncomingControlCommandEvent): Promise<void> {
    const binding = this.getBinding();
    if (!binding) {
      this.emitFinal(event.chatId, event.messageId, this.t('当前未绑定会话。可先执行 /threads 然后 /bind [编号]。', 'No thread is bound. Run /threads then /bind [index].'), {
        replyMarkup: buildMainReplyKeyboard(),
      });
      return;
    }

    const control = await this.getControlClient();
    let readResult: Awaited<ReturnType<CodexAppServerClient['readThread']>>;
    try {
      readResult = await withTimeout(
        control.readThread(binding.threadId),
        Math.min(this.options.requestTimeoutMs, 8_000),
        'thread/read',
      );
    } catch (error: any) {
      this.emitFinal(
        event.chatId,
        event.messageId,
        this.locale === 'en'
          ? `❌ Failed to read current thread\n${error?.message || String(error)}`
          : `❌ 读取当前会话失败\n${error?.message || String(error)}`,
      );
      return;
    }

    const thread: ThreadSummary = {
      id: String(readResult.thread.id || binding.threadId),
      preview: sanitizePreview(String(readResult.thread.preview || '')),
      updatedAt: Number(readResult.thread.updatedAt || 0),
      cwd: readResult.thread.cwd == null ? null : String(readResult.thread.cwd),
      source: sourceLabel(String(readResult.thread.source || 'unknown')),
    };
    this.db.saveBinding(this.bindingChatId(), thread.id, `thread:${thread.source}`, nowMs());

    const metadata = loadCodexSidebarMetadata(this.logger);
    const title = resolveThreadTitle(thread, 0, metadata, this.locale);
    const group = resolveThreadGroup(thread, metadata, this.locale);
    const running = this.runningTurns.has(thread.id);
    const queued = this.queuedByThread.has(thread.id);

    const lines: string[] = [];
    lines.push(this.t('🎯 当前会话', '🎯 Active thread'));
    lines.push(`<b>${escapeTelegramHtml(title)}</b>`);
    lines.push(this.locale === 'en' ? `Group: ${escapeTelegramHtml(group)}` : `分组: ${escapeTelegramHtml(group)}`);
    if (thread.updatedAt > 0) {
      lines.push(this.locale === 'en'
        ? `Updated: ${escapeTelegramHtml(formatLocalTime(toEpochMs(thread.updatedAt)))}`
        : `更新时间: ${escapeTelegramHtml(formatLocalTime(toEpochMs(thread.updatedAt)))}`);
    }
    lines.push(
      this.locale === 'en'
        ? `Task status: ${running ? (queued ? 'running + queued' : 'running') : (queued ? 'queued' : 'idle')}`
        : `任务状态: ${running ? (queued ? 'running + queued' : 'running') : (queued ? 'queued' : 'idle')}`,
    );
    lines.push(this.t('可用: /current 查看快照，/detail current 查看详情', 'Available: /current for snapshot, /detail current for details'));

    this.emitFinal(event.chatId, event.messageId, lines.join('\n'), {
      replyMarkup: buildMainReplyKeyboard(),
      parseMode: 'HTML',
    });
  }

  private async handleDetailCommand(event: IncomingControlCommandEvent): Promise<void> {
    const arg = (event.args || '').trim() || 'current';
    const binding = this.getBinding();
    let targetThreadId = '';

    if (arg === 'current') {
      if (!binding) {
        this.emitFinal(event.chatId, event.messageId, this.t('当前未绑定会话。请先执行 /threads 然后 /bind <编号>。', 'No bound thread. Please run /threads then /bind <index>.'));
        return;
      }
      targetThreadId = binding.threadId;
    } else if (arg === 'latest') {
      const control = await this.getControlClient();
      const latest = await control.listThreads(THREAD_LIST_LIMIT);
      const state = this.buildDisplayThreadsState(event.chatId, latest);
      const preferred = this.pickPreferredLatestThread(state.displayItems.map((item) => item.thread));
      if (!preferred) {
        this.emitFinal(event.chatId, event.messageId, this.t('没有可查看详情的会话。', 'No thread available for detail view.'));
        return;
      }
      targetThreadId = preferred.id;
    } else if (/^\d+$/.test(arg)) {
      const index = Number(arg);
      const cached = this.getCachedThreads(event.chatId);
      if (!cached || cached.length === 0) {
        this.emitFinal(event.chatId, event.messageId, this.t('最近会话缓存已过期，请先执行 /threads。', 'Recent thread cache expired. Run /threads first.'));
        return;
      }
      if (!Number.isFinite(index) || index <= 0 || index > cached.length) {
        this.emitFinal(event.chatId, event.messageId, this.locale === 'en' ? `Invalid index. Please enter 1 to ${cached.length}.` : `编号无效，请输入 1 到 ${cached.length}。`);
        return;
      }
      targetThreadId = cached[index - 1].id;
    } else {
      targetThreadId = arg;
    }

    const readResult = await this.readThreadSummaryWithDegrade(targetThreadId, 'detail');
    const thread = readResult.thread;

    const metadata = loadCodexSidebarMetadata(this.logger);
    const title = resolveThreadTitle(thread, 0, metadata, this.locale);
    const group = resolveThreadGroup(thread, metadata, this.locale);
    const isBound = !!binding && binding.threadId === thread.id;

    const lines: string[] = [];
    lines.push(this.t('🧾 会话详情', '🧾 Thread details'));
    lines.push(this.locale === 'en' ? `Title: <b>${escapeTelegramHtml(title)}</b>` : `标题: <b>${escapeTelegramHtml(title)}</b>`);
    lines.push(this.locale === 'en' ? `Group: ${escapeTelegramHtml(group)}` : `分组: ${escapeTelegramHtml(group)}`);
    lines.push(`ID: <code>${escapeTelegramHtml(thread.id)}</code>`);
    lines.push(this.locale === 'en' ? `Source: ${escapeTelegramHtml(thread.source)}` : `来源: ${escapeTelegramHtml(thread.source)}`);
    lines.push(this.locale === 'en' ? `CWD: <code>${escapeTelegramHtml(thread.cwd || '(none)')}</code>` : `CWD: <code>${escapeTelegramHtml(thread.cwd || '(无)')}</code>`);
    if (thread.updatedAt > 0) {
      lines.push(this.locale === 'en'
        ? `Updated: ${escapeTelegramHtml(formatLocalTime(toEpochMs(thread.updatedAt)))}`
        : `更新时间: ${escapeTelegramHtml(formatLocalTime(toEpochMs(thread.updatedAt)))}`);
    }
    lines.push(this.locale === 'en' ? `Binding: ${isBound ? '✅ bound' : 'not bound'}` : `绑定状态: ${isBound ? '✅ 当前已绑定' : '未绑定'}`);
    if (thread.preview) {
      lines.push(this.locale === 'en' ? `Preview: ${escapeTelegramHtml(truncate(thread.preview, 200))}` : `预览: ${escapeTelegramHtml(truncate(thread.preview, 200))}`);
    }
    if (readResult.degraded) {
      lines.push(this.t('注: 当前会话较大或较忙，详情已降级为基础元数据。', 'Note: thread is large or busy; detail was degraded to basic metadata.'));
      if (readResult.degradedReason) {
        lines.push(this.locale === 'en'
          ? `Reason: ${escapeTelegramHtml(truncate(readResult.degradedReason, 200))}`
          : `原因: ${escapeTelegramHtml(truncate(readResult.degradedReason, 200))}`);
      }
    }
    lines.push(this.t('可用: /bind [编号|threadId] 绑定该会话', 'Available: /bind [index|threadId] to bind this thread'));

    this.emitFinal(event.chatId, event.messageId, lines.join('\n'), {
      replyMarkup: buildMainReplyKeyboard(),
      parseMode: 'HTML',
    });
  }

  private composeDegradedReason(reasons: string[]): string | undefined {
    const compact = reasons
      .map((item) => compactText(item || ''))
      .filter(Boolean);
    if (compact.length === 0) {
      return undefined;
    }
    return truncate(Array.from(new Set(compact)).join(' | '), 260);
  }

  private minimalThreadSummary(threadId: string): ThreadSummary {
    return {
      id: threadId,
      preview: '',
      updatedAt: 0,
      cwd: null,
      source: 'unknown',
    };
  }

  private threadSummaryFromReadResult(read: Awaited<ReturnType<CodexAppServerClient['readThread']>>, fallbackThreadId: string): ThreadSummary {
    return {
      id: String(read.thread.id || fallbackThreadId),
      preview: sanitizePreview(String(read.thread.preview || '')),
      updatedAt: Number(read.thread.updatedAt || 0),
      cwd: read.thread.cwd == null ? null : String(read.thread.cwd),
      source: sourceLabel(String(read.thread.source || 'unknown')),
    };
  }

  private async readThreadSummaryWithDegrade(threadId: string, scene: string): Promise<ThreadReadWithDegradeResult> {
    const stageTimeout = (ms: number): number => Math.max(this.options.requestTimeoutMs, ms);
    const reasons: string[] = [];
    let control: CodexAppServerClient;
    try {
      control = await this.getControlClient();
    } catch (error: any) {
      const message = error?.message || String(error);
      this.logger.warn('Thread read degraded because control client is unavailable', {
        threadId,
        scene,
        attemptIndex: 0,
        timeoutMs: 0,
        usedResume: false,
        degraded: true,
        errorMessage: message,
      });
      return {
        thread: this.minimalThreadSummary(threadId),
        degraded: true,
        degradedReason: truncate(message, 200),
      };
    }

    try {
      const timeoutMs = stageTimeout(20_000);
      const read = await withTimeout(
        control.readThread(threadId),
        timeoutMs,
        `thread/read(${scene}:attempt1)`,
      );
      if (read?.thread?.id) {
        return {
          thread: this.threadSummaryFromReadResult(read, threadId),
          degraded: false,
        };
      }
      reasons.push('thread/read returned empty thread');
      this.logger.warn('Thread read returned empty payload; will retry with resume', {
        threadId,
        scene,
        attemptIndex: 1,
        timeoutMs,
        usedResume: false,
        degraded: true,
      });
    } catch (error: any) {
      const message = error?.message || String(error);
      reasons.push(message);
      this.logger.warn('Thread read attempt failed; will retry with resume', {
        threadId,
        scene,
        attemptIndex: 1,
        timeoutMs: stageTimeout(20_000),
        usedResume: false,
        degraded: true,
        errorMessage: message,
      });
    }

    try {
      const timeoutMs = stageTimeout(12_000);
      await withTimeout(
        control.resumeThread(threadId),
        timeoutMs,
        `thread/resume(${scene})`,
      );
    } catch (error: any) {
      const message = error?.message || String(error);
      reasons.push(`resume: ${message}`);
      this.logger.warn('Thread resume attempt failed before retry read', {
        threadId,
        scene,
        attemptIndex: 2,
        timeoutMs: stageTimeout(12_000),
        usedResume: true,
        degraded: true,
        errorMessage: message,
      });
    }

    try {
      const timeoutMs = stageTimeout(30_000);
      const read = await withTimeout(
        control.readThread(threadId),
        timeoutMs,
        `thread/read(${scene}:retry)`,
      );
      if (read?.thread?.id) {
        return {
          thread: this.threadSummaryFromReadResult(read, threadId),
          degraded: true,
          degradedReason: this.composeDegradedReason(reasons),
        };
      }
      reasons.push('thread/read retry returned empty thread');
    } catch (error: any) {
      const message = error?.message || String(error);
      reasons.push(message);
      this.logger.warn('Thread read retry failed; returning minimal degraded snapshot', {
        threadId,
        scene,
        attemptIndex: 3,
        timeoutMs: stageTimeout(30_000),
        usedResume: true,
        degraded: true,
        errorMessage: message,
      });
    }

    return {
      thread: this.minimalThreadSummary(threadId),
      degraded: true,
      degradedReason: this.composeDegradedReason(reasons),
    };
  }

  private async fetchThreadConversationSnapshot(threadId: string): Promise<ThreadConversationSnapshot> {
    const stageTimeout = (ms: number): number => Math.max(this.options.requestTimeoutMs, ms);
    const reasons: string[] = [];
    let control: CodexAppServerClient | null = null;
    try {
      control = await this.getControlClient();
    } catch (error: any) {
      const message = error?.message || String(error);
      reasons.push(message);
      this.logger.warn('Failed to get control client for /current; falling back to degraded snapshot', {
        threadId,
        attemptIndex: 0,
        timeoutMs: 0,
        usedResume: false,
        degraded: true,
        errorMessage: message,
      });
    }
    try {
      if (control) {
        const timeoutMs = stageTimeout(25_000);
        const payload = await withTimeout(
          control.request<unknown>('thread/read', {
            threadId,
            includeTurns: true,
          }),
          timeoutMs,
          'thread/read(includeTurns=true)',
        );
        const parsed = parseThreadConversationSnapshot(payload);
        if (parsed) {
          return parsed;
        }
        throw new Error('thread/read(includeTurns=true) returned unparseable payload');
      }
    } catch (error: any) {
      const message = error?.message || String(error);
      reasons.push(message);
      this.logger.warn('Failed to fetch thread snapshot with turns; falling back to basic thread/read', {
        threadId,
        attemptIndex: 1,
        timeoutMs: stageTimeout(25_000),
        usedResume: false,
        degraded: true,
        errorMessage: message,
      });
    }

    const basic = await this.readThreadSummaryWithDegrade(threadId, 'current');
    return {
      threadId: basic.thread.id || threadId,
      source: sourceLabel(String(basic.thread.source || 'unknown')),
      updatedAt: Number(basic.thread.updatedAt || 0),
      preview: sanitizePreview(String(basic.thread.preview || '')),
      lastUser: '',
      lastAssistant: '',
      recentTurns: [],
      degraded: true,
      degradedReason: this.composeDegradedReason([
        ...reasons,
        basic.degradedReason || '',
      ]),
    };
  }

  private async handleCurrentCommand(event: IncomingControlCommandEvent): Promise<void> {
    const binding = this.getBinding();
    if (!binding) {
      this.emitFinal(event.chatId, event.messageId, this.t('当前未绑定会话，请先执行 /threads 然后 /bind。', 'No thread is bound. Please run /threads then /bind.'), {
        replyMarkup: buildMainReplyKeyboard(),
      });
      return;
    }

    let snapshot: ThreadConversationSnapshot;
    try {
      snapshot = await this.fetchThreadConversationSnapshot(binding.threadId);
    } catch (error: any) {
      const message = error?.message || String(error);
      this.logger.warn('Unexpected /current failure; returning degraded fallback snapshot', {
        threadId: binding.threadId,
        errorMessage: message,
      });
      snapshot = {
        threadId: binding.threadId,
        source: sourceFromBindingMode(binding.mode),
        updatedAt: 0,
        preview: '',
        lastUser: '',
        lastAssistant: '',
        recentTurns: [],
        degraded: true,
        degradedReason: truncate(message, 180),
      };
    }

    const source = snapshot.source || sourceFromBindingMode(binding.mode);
    this.db.saveBinding(this.bindingChatId(), binding.threadId, `thread:${source}`, nowMs());

    const lines: string[] = [];
    lines.push(this.locale === 'en' ? `Current thread: ${snapshot.threadId}` : `当前会话: ${snapshot.threadId}`);
    lines.push(this.locale === 'en' ? `Source: ${source}` : `来源: ${source}`);
    if (snapshot.updatedAt > 0) {
      lines.push(this.locale === 'en' ? `Updated: ${formatLocalTime(toEpochMs(snapshot.updatedAt))}` : `更新时间: ${formatLocalTime(toEpochMs(snapshot.updatedAt))}`);
    }
    if (snapshot.preview) {
      lines.push(this.locale === 'en' ? `Title: ${truncate(snapshot.preview, 120)}` : `标题: ${truncate(snapshot.preview, 120)}`);
    }
    if (snapshot.degraded) {
      lines.push(this.t('注: 当前会话较大或较忙，已降级为基础快照。', 'Note: current thread is large or busy; fallback snapshot is shown.'));
      if (snapshot.degradedReason) {
        lines.push(this.locale === 'en'
          ? `Reason: ${truncate(snapshot.degradedReason, 120)}`
          : `原因: ${truncate(snapshot.degradedReason, 120)}`);
      }
    }
    lines.push(this.locale === 'en' ? `Recent user: ${snapshot.lastUser ? truncate(snapshot.lastUser, 220) : '(none)'}` : `最近用户: ${snapshot.lastUser ? truncate(snapshot.lastUser, 220) : '(无)'}`);
    lines.push(this.locale === 'en' ? `Recent assistant: ${snapshot.lastAssistant ? truncate(snapshot.lastAssistant, 220) : '(none)'}` : `最近助手: ${snapshot.lastAssistant ? truncate(snapshot.lastAssistant, 220) : '(无)'}`);

    const recentTurns = snapshot.recentTurns.slice(-3);
    if (recentTurns.length > 0) {
      lines.push(this.t('最近 3 轮:', 'Recent 3 turns:'));
      recentTurns.forEach((turn, index) => {
        lines.push(this.locale === 'en' ? `${index + 1}) 👤 ${turn.userText ? truncate(turn.userText, 120) : '(none)'}` : `${index + 1}) 👤 ${turn.userText ? truncate(turn.userText, 120) : '(无)'}`);
        const assistantText = turn.assistantText
          ? truncate(turn.assistantText, 120)
          : turn.status === 'inProgress' || turn.status === 'in_progress'
            ? this.t('(处理中)', '(processing)')
            : this.t('(无)', '(none)');
        lines.push(`   🤖 ${assistantText}`);
      });
    }

    this.emitFinal(event.chatId, event.messageId, lines.join('\n'), {
      replyMarkup: buildMainReplyKeyboard(),
    });
  }

  private formatRateLimitResetTime(epochMs: number | null): string {
    if (!epochMs || !Number.isFinite(epochMs)) {
      return this.t('未知', 'unknown');
    }
    const localeTag = this.locale === 'en' ? 'en-US' : 'zh-CN';
    return new Date(epochMs).toLocaleString(localeTag, {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }

  private localizeRateLimitLabel(label: string): string {
    const normalized = (label || '').trim().toLowerCase();
    if (normalized === '5h' || normalized === '5h quota' || normalized === 'primary') {
      return this.t('五小时额度', '5h quota');
    }
    if (normalized === 'weekly' || normalized === 'secondary') {
      return this.t('周额度', 'Weekly quota');
    }
    return label || this.t('额度', 'Quota');
  }

  private async handleUsageCommand(event: IncomingControlCommandEvent): Promise<void> {
    const control = await this.getControlClient();
    const snapshot = await withTimeout(
      control.getAccountRateLimits(),
      Math.min(this.options.requestTimeoutMs, 10_000),
      'account/rateLimits/read',
    );

    if (!snapshot.windows.length) {
      this.emitFinal(
        event.chatId,
        event.messageId,
        this.t('暂时无法读取用量信息，请稍后再试。', 'Unable to read usage data right now. Please try again later.'),
        { replyMarkup: buildMainReplyKeyboard() },
      );
      return;
    }

    const lines: string[] = [this.t('📊 剩余用量', '📊 Rate limits remaining')];
    lines.push('');
    for (const window of snapshot.windows) {
      const remain = Math.max(0, Math.min(100, Math.round(window.remainingPercent)));
      const resetAt = this.formatRateLimitResetTime(window.resetsAt);
      lines.push(`${this.localizeRateLimitLabel(window.label)}: ${remain}%  ·  ${this.t('重置', 'resets')} ${resetAt}`);
    }
    if (snapshot.planType) {
      lines.push('');
      lines.push(`${this.t('套餐', 'Plan')}: ${snapshot.planType}`);
    }
    if (snapshot.creditsText) {
      lines.push(`${this.t('积分', 'Credits')}: ${snapshot.creditsText}`);
    }

    this.emitFinal(event.chatId, event.messageId, lines.join('\n'), {
      replyMarkup: buildMainReplyKeyboard(),
    });
  }

  private async handleStatusCommand(event: IncomingControlCommandEvent): Promise<void> {
    const binding = this.getBinding();

    let threadUpdatedAt = 0;
    let bindingSource = binding ? sourceFromBindingMode(binding.mode) : 'unknown';
    if (binding) {
      try {
        const control = await this.getControlClient();
        const read = await withTimeout(
          control.readThread(binding.threadId),
          Math.min(this.options.requestTimeoutMs, 8_000),
          'thread/read',
        );
        threadUpdatedAt = Number(read.thread.updatedAt || 0);
        if (bindingSource === 'unknown') {
          bindingSource = sourceLabel(String(read.thread.source || 'unknown'));
          this.db.saveBinding(this.bindingChatId(), binding.threadId, `thread:${bindingSource}`, nowMs());
        }
      } catch {
        // Keep fallback values when thread lookup fails.
      }
    }

    const lines: string[] = [];
    lines.push(this.locale === 'en' ? `Bound thread: ${binding ? binding.threadId : '(none)'}` : `绑定线程: ${binding ? binding.threadId : '(未绑定)'}`);
    if (binding) {
      lines.push(this.locale === 'en' ? `Thread source: ${bindingSource}` : `线程来源: ${bindingSource}`);
      if (bindingSource === 'cli') {
        lines.push(this.t('提示: cli 线程在 Codex App 中可能不显示实时更新。', 'Tip: CLI threads may not show live updates in Codex App.'));
      }
      if (threadUpdatedAt > 0) {
        lines.push(this.locale === 'en' ? `Thread updated at: ${formatLocalTime(toEpochMs(threadUpdatedAt))}` : `会话更新时间: ${formatLocalTime(toEpochMs(threadUpdatedAt))}`);
      }
    }
    lines.push(this.locale === 'en' ? `Running tasks: ${this.runningTurns.size}` : `运行中任务: ${this.runningTurns.size}`);
    lines.push(this.locale === 'en' ? `Queued tasks: ${this.queuedByThread.size}` : `排队任务: ${this.queuedByThread.size}`);
    lines.push(this.locale === 'en' ? `Pending approvals: ${this.pendingApprovals.size}` : `待审批: ${this.pendingApprovals.size}`);

    this.emitFinal(event.chatId, event.messageId, lines.join('\n'), {
      replyMarkup: buildMainReplyKeyboard(),
    });
  }

  private emitFinal(
    chatId: string,
    messageId: string,
    text: string,
    options?: {
      replyMarkup?: Record<string, unknown>;
      parseMode?: 'HTML' | 'MarkdownV2';
      disableNotification?: boolean;
    },
  ): void {
    this.emitOutbound({
      type: 'finalResponse',
      chatId,
      messageId,
      text,
      purpose: 'command',
      options,
      createdAt: Date.now(),
    });
  }

  private async handleApproval(event: ApprovalRequestEvent): Promise<void> {
    const context = this.turnContextByThread.get(event.threadId) || {
      chatId: 'unknown',
      messageId: randomUUID(),
    };

    if (this.options.autoApproveRemoteActions) {
      const resolved = this.runtimeManager.resolveApproval(
        event.approvalId,
        true,
        event.threadId || undefined,
      );
      if (resolved) {
        this.logger.info('Approval auto-accepted (full-access mode)', {
          threadId: event.threadId,
          approvalId: event.approvalId,
          summary: truncate(event.summary, 300),
        });
        return;
      }
      this.logger.warn('Auto-approval failed, falling back to manual approval', {
        threadId: event.threadId,
        approvalId: event.approvalId,
      });
    }

    this.pendingApprovals.set(event.approvalId, {
      threadId: event.threadId,
      chatId: context.chatId,
      messageId: context.messageId,
    });

    this.emitOutbound({
      type: 'approvalRequest',
      chatId: context.chatId,
      messageId: context.messageId,
      approvalId: event.approvalId,
      summary: event.summary,
      createdAt: Date.now(),
    });
  }

  private emitOutbound(event: DeviceOutboundEvent): void {
    this.emit('outbound', event);
  }

  private bindingChatId(): string {
    return `${DEVICE_BINDING_PREFIX}${this.options.deviceId}`;
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
        codexBin: this.options.codexBin,
        requestTimeoutMs: this.options.requestTimeoutMs,
        fallbackModel: this.options.fallbackModel,
        clientName: `desktop-control-${this.options.deviceId.slice(0, 8)}`,
      });
      await client.start();
      this.controlClient = client;
      return client;
    })();

    this.controlClientInit = initPromise;
    try {
      return await initPromise;
    } finally {
      this.controlClientInit = null;
    }
  }
}

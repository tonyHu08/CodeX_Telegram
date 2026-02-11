import path from 'node:path';

export interface BridgeConfig {
  telegramBotToken: string;
  allowedChatIds: Set<string>;
  pollTimeoutSeconds: number;
  pollingBackoffMs: number;
  approvalTimeoutMs: number;
  codexBin: string;
  fallbackModel: string;
  dbPath: string;
  messageRateLimitPerMinute: number;
  maxThreadList: number;
  requestTimeoutMs: number;
  turnTimeoutMs: number;
  dedupRetentionMs: number;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function parseAllowedChatIds(value: string): Set<string> {
  const ids = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    throw new Error('TELEGRAM_ALLOWED_CHAT_IDS must contain at least one chat id');
  }
  return new Set(ids);
}

export function loadConfig(): BridgeConfig {
  const token = requiredEnv('TELEGRAM_BOT_TOKEN');
  const allowedChatIds = parseAllowedChatIds(requiredEnv('TELEGRAM_ALLOWED_CHAT_IDS'));

  const defaultDbPath = path.resolve(process.cwd(), 'data', 'codex_remote_bridge.db');

  return {
    telegramBotToken: token,
    allowedChatIds,
    pollTimeoutSeconds: parsePositiveInt(process.env.TELEGRAM_POLL_TIMEOUT_SECONDS, 25),
    pollingBackoffMs: parsePositiveInt(process.env.TELEGRAM_POLL_BACKOFF_MS, 2000),
    approvalTimeoutMs: parsePositiveInt(process.env.APPROVAL_TIMEOUT_MS, 5 * 60 * 1000),
    codexBin: (process.env.CODEX_BIN || 'codex').trim(),
    fallbackModel: (process.env.CODEX_FALLBACK_MODEL || 'gpt-5.2-codex').trim(),
    dbPath: (process.env.BRIDGE_DB_PATH || defaultDbPath).trim(),
    messageRateLimitPerMinute: parsePositiveInt(process.env.MESSAGE_RATE_LIMIT_PER_MINUTE, 10),
    maxThreadList: parsePositiveInt(process.env.MAX_THREAD_LIST, 8),
    requestTimeoutMs: parsePositiveInt(process.env.APP_SERVER_REQUEST_TIMEOUT_MS, 60_000),
    turnTimeoutMs: parsePositiveInt(process.env.TURN_TIMEOUT_MS, 20 * 60 * 1000),
    dedupRetentionMs: parsePositiveInt(process.env.MESSAGE_DEDUP_RETENTION_MS, 7 * 24 * 60 * 60 * 1000),
  };
}

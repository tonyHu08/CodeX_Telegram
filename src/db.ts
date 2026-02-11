import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type {
  ActiveTurn,
  ActiveTurnStatus,
  PendingApproval,
  PendingApprovalStatus,
  RemoteBinding,
} from './types';
import type { Logger } from './logger';

function toRemoteBinding(row: any): RemoteBinding {
  return {
    chatId: String(row.chat_id),
    threadId: String(row.thread_id),
    mode: String(row.mode),
    updatedAt: Number(row.updated_at),
  };
}

function toPendingApproval(row: any): PendingApproval {
  return {
    approvalId: String(row.approval_id),
    chatId: String(row.chat_id),
    threadId: String(row.thread_id),
    turnId: String(row.turn_id),
    requestId: String(row.request_id),
    kind: row.kind,
    summary: String(row.summary),
    expiresAt: Number(row.expires_at),
    status: row.status,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toActiveTurn(row: any): ActiveTurn {
  return {
    threadId: String(row.thread_id),
    chatId: String(row.chat_id),
    turnId: row.turn_id == null ? null : String(row.turn_id),
    status: row.status,
    queuedText: row.queued_text == null ? null : String(row.queued_text),
    startedAt: row.started_at == null ? null : Number(row.started_at),
    updatedAt: Number(row.updated_at),
  };
}

export class BridgeDb {
  private readonly db: any;
  private readonly logger: Logger;

  constructor(dbPath: string, logger: Logger) {
    this.logger = logger;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bindings (
        chat_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_bindings_thread_id ON bindings(thread_id);

      CREATE TABLE IF NOT EXISTS pending_approvals (
        approval_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_pending_approvals_status_expires
        ON pending_approvals(status, expires_at);

      CREATE INDEX IF NOT EXISTS idx_pending_approvals_chat_status
        ON pending_approvals(chat_id, status);

      CREATE TABLE IF NOT EXISTS message_dedup (
        update_id INTEGER PRIMARY KEY,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS active_turns (
        thread_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        turn_id TEXT,
        status TEXT NOT NULL,
        queued_text TEXT,
        started_at INTEGER,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS kv_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  saveBinding(chatId: string, threadId: string, mode: string, nowMs: number): void {
    const stmt = this.db.prepare(`
      INSERT INTO bindings (chat_id, thread_id, mode, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        thread_id = excluded.thread_id,
        mode = excluded.mode,
        updated_at = excluded.updated_at
    `);
    stmt.run(chatId, threadId, mode, nowMs);
  }

  getBinding(chatId: string): RemoteBinding | null {
    const row = this.db.prepare('SELECT * FROM bindings WHERE chat_id = ?').get(chatId);
    return row ? toRemoteBinding(row) : null;
  }

  getBindingByThread(threadId: string): RemoteBinding | null {
    const row = this.db.prepare('SELECT * FROM bindings WHERE thread_id = ? ORDER BY updated_at DESC LIMIT 1').get(threadId);
    return row ? toRemoteBinding(row) : null;
  }

  listBindings(): RemoteBinding[] {
    const rows = this.db.prepare('SELECT * FROM bindings ORDER BY updated_at DESC').all();
    return rows.map(toRemoteBinding);
  }

  deleteBinding(chatId: string): void {
    this.db.prepare('DELETE FROM bindings WHERE chat_id = ?').run(chatId);
  }

  recordMessageUpdate(updateId: number, nowMs: number): boolean {
    const stmt = this.db.prepare('INSERT INTO message_dedup (update_id, created_at) VALUES (?, ?)');
    try {
      stmt.run(updateId, nowMs);
      return true;
    } catch (error: any) {
      if (error && String(error.code) === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
        return false;
      }
      throw error;
    }
  }

  pruneMessageDedup(beforeMs: number): number {
    const info = this.db.prepare('DELETE FROM message_dedup WHERE created_at < ?').run(beforeMs);
    return Number(info.changes || 0);
  }

  savePendingApproval(approval: PendingApproval): void {
    const stmt = this.db.prepare(`
      INSERT INTO pending_approvals (
        approval_id, chat_id, thread_id, turn_id, request_id,
        kind, summary, expires_at, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(approval_id) DO UPDATE SET
        chat_id = excluded.chat_id,
        thread_id = excluded.thread_id,
        turn_id = excluded.turn_id,
        request_id = excluded.request_id,
        kind = excluded.kind,
        summary = excluded.summary,
        expires_at = excluded.expires_at,
        status = excluded.status,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `);
    stmt.run(
      approval.approvalId,
      approval.chatId,
      approval.threadId,
      approval.turnId,
      approval.requestId,
      approval.kind,
      approval.summary,
      approval.expiresAt,
      approval.status,
      approval.createdAt,
      approval.updatedAt,
    );
  }

  getPendingApproval(approvalId: string): PendingApproval | null {
    const row = this.db.prepare('SELECT * FROM pending_approvals WHERE approval_id = ?').get(approvalId);
    return row ? toPendingApproval(row) : null;
  }

  listPendingApprovalsByStatus(status: PendingApprovalStatus): PendingApproval[] {
    const rows = this.db.prepare('SELECT * FROM pending_approvals WHERE status = ? ORDER BY created_at ASC').all(status);
    return rows.map(toPendingApproval);
  }

  listPendingApprovalsByChat(chatId: string): PendingApproval[] {
    const rows = this.db.prepare('SELECT * FROM pending_approvals WHERE chat_id = ? ORDER BY created_at DESC').all(chatId);
    return rows.map(toPendingApproval);
  }

  setPendingApprovalStatus(approvalId: string, status: PendingApprovalStatus, updatedAt: number): void {
    this.db
      .prepare('UPDATE pending_approvals SET status = ?, updated_at = ? WHERE approval_id = ?')
      .run(status, updatedAt, approvalId);
  }

  upsertActiveTurn(input: {
    threadId: string;
    chatId: string;
    turnId: string | null;
    status: ActiveTurnStatus;
    queuedText: string | null;
    startedAt: number | null;
    updatedAt: number;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO active_turns (
        thread_id, chat_id, turn_id, status, queued_text, started_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        chat_id = excluded.chat_id,
        turn_id = excluded.turn_id,
        status = excluded.status,
        queued_text = excluded.queued_text,
        started_at = excluded.started_at,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      input.threadId,
      input.chatId,
      input.turnId,
      input.status,
      input.queuedText,
      input.startedAt,
      input.updatedAt,
    );
  }

  clearActiveTurn(threadId: string): void {
    this.db.prepare('DELETE FROM active_turns WHERE thread_id = ?').run(threadId);
  }

  getActiveTurn(threadId: string): ActiveTurn | null {
    const row = this.db.prepare('SELECT * FROM active_turns WHERE thread_id = ?').get(threadId);
    return row ? toActiveTurn(row) : null;
  }

  listActiveTurnsByChat(chatId: string): ActiveTurn[] {
    const rows = this.db.prepare('SELECT * FROM active_turns WHERE chat_id = ? ORDER BY updated_at DESC').all(chatId);
    return rows.map(toActiveTurn);
  }

  markAllActiveTurnsStale(nowMs: number): number {
    const info = this.db
      .prepare("UPDATE active_turns SET status = 'stale', turn_id = NULL, updated_at = ? WHERE status != 'stale'")
      .run(nowMs);
    const changes = Number(info.changes || 0);
    if (changes > 0) {
      this.logger.warn('Marked active turns stale on startup', { count: changes });
    }
    return changes;
  }

  getState(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM kv_state WHERE key = ?').get(key);
    return row ? String(row.value) : null;
  }

  setState(key: string, value: string, nowMs: number): void {
    this.db
      .prepare(`
        INSERT INTO kv_state (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `)
      .run(key, value, nowMs);
  }

  close(): void {
    this.db.close();
  }
}

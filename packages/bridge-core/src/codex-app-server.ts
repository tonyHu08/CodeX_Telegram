import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Logger } from './logger';
import type {
  ApprovalKind,
  ApprovalRequestEvent,
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  ThreadListItem,
  TurnExecutionResult,
  TurnUserInput,
} from './types';
import { sanitizePreview, truncate } from './utils';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface PendingTurn {
  threadId: string;
  turnId: string;
  status: 'inProgress' | 'completed' | 'failed';
  deltaBuffer: string;
  finalText: string;
  errorMessage: string | null;
  resolve?: (value: TurnExecutionResult) => void;
  timeout?: NodeJS.Timeout;
}

interface PendingApprovalInternal extends ApprovalRequestEvent {}

interface ThreadReadResult {
  thread: {
    id: string;
    preview?: string;
    updatedAt?: number;
    cwd?: string | null;
    source?: string;
  };
}

interface ThreadListResult {
  data?: Array<{
    id: string;
    preview?: string;
    updatedAt?: number;
    cwd?: string | null;
    source?: unknown;
  }>;
}

interface ModelListResult {
  data?: Array<{
    id?: string;
    model?: string;
  }>;
}

export interface RateLimitWindowSnapshot {
  label: string;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: number | null;
  windowDurationMins: number | null;
}

export interface RateLimitSnapshot {
  windows: RateLimitWindowSnapshot[];
  planType: string | null;
  creditsText: string | null;
}

function idKey(id: JsonRpcId): string {
  return typeof id === 'number' ? `n:${id}` : `s:${id}`;
}

function parseErrorMessage(value: unknown): string {
  if (typeof value === 'string' && value.trim()) {
    return value;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const maybeMessage = record.message;
    const maybeDetails =
      record.additionalDetails ??
      record.additional_details ??
      (isRecord(record.codexErrorInfo) ? record.codexErrorInfo : null);

    const message =
      typeof maybeMessage === 'string' && maybeMessage.trim() ? maybeMessage.trim() : '';

    let details = '';
    if (typeof maybeDetails === 'string' && maybeDetails.trim()) {
      details = maybeDetails.trim();
    } else if (maybeDetails && typeof maybeDetails === 'object') {
      try {
        details = JSON.stringify(maybeDetails);
      } catch {
        details = '';
      }
    }

    if (message && details) {
      return `${message} | ${details}`;
    }
    if (message) {
      return message;
    }
    if (details) {
      return details;
    }
  }
  return 'Unknown error';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function extractString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function toNumberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toEpochMs(value: unknown): number | null {
  if (typeof value === 'string') {
    const fromIso = Date.parse(value);
    if (Number.isFinite(fromIso)) {
      return fromIso;
    }
    const fromNumber = toNumberOrNull(value);
    if (fromNumber == null) {
      return null;
    }
    return fromNumber < 10_000_000_000 ? Math.floor(fromNumber * 1000) : Math.floor(fromNumber);
  }
  const numberValue = toNumberOrNull(value);
  if (numberValue == null) {
    return null;
  }
  return numberValue < 10_000_000_000 ? Math.floor(numberValue * 1000) : Math.floor(numberValue);
}

function normalizeWindowLabel(raw: Record<string, unknown>, fallback: string): string {
  const label = extractString(raw.label)
    || extractString(raw.name)
    || extractString(raw.windowName)
    || extractString(raw.window_name)
    || fallback;
  return label.trim() || fallback;
}

function normalizeWindowDurationMins(raw: Record<string, unknown>): number | null {
  return toNumberOrNull(raw.windowDurationMins ?? raw.window_duration_mins ?? raw.windowMinutes ?? raw.window_minutes);
}

function labelFromWindowDurationMins(durationMins: number | null, fallback: string): string {
  if (durationMins == null || !Number.isFinite(durationMins) || durationMins <= 0) {
    if (/^primary$/i.test(fallback)) {
      return '5h';
    }
    if (/^secondary$/i.test(fallback)) {
      return 'Weekly';
    }
    return fallback;
  }
  if (durationMins >= 7 * 24 * 60 - 30 && durationMins <= 7 * 24 * 60 + 30) {
    return 'Weekly';
  }
  if (durationMins === 300) {
    return '5h';
  }
  if (durationMins % 60 === 0) {
    return `${Math.round(durationMins / 60)}h`;
  }
  return `${Math.round(durationMins)}m`;
}

function normalizeUsedPercent(raw: Record<string, unknown>): number | null {
  const direct = toNumberOrNull(raw.usedPercent ?? raw.used_percent ?? raw.usagePercent ?? raw.usage_percent);
  if (direct != null) {
    return Math.min(100, Math.max(0, direct));
  }
  const remaining = toNumberOrNull(raw.remainingPercent ?? raw.remaining_percent);
  if (remaining != null) {
    return Math.min(100, Math.max(0, 100 - remaining));
  }
  return null;
}

function normalizeRateLimitWindow(value: unknown, fallback: string): RateLimitWindowSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }
  const usedPercent = normalizeUsedPercent(value);
  if (usedPercent == null) {
    return null;
  }
  const resetsAt = toEpochMs(value.resetsAt ?? value.resetAt ?? value.reset_at);
  const windowDurationMins = normalizeWindowDurationMins(value);
  return {
    label: labelFromWindowDurationMins(windowDurationMins, normalizeWindowLabel(value, fallback)),
    usedPercent,
    remainingPercent: Math.max(0, Math.min(100, 100 - usedPercent)),
    resetsAt,
    windowDurationMins,
  };
}

function normalizeRateLimitWindows(value: unknown, fallback: string): RateLimitWindowSnapshot[] {
  if (Array.isArray(value)) {
    return value
      .map((item, index) => normalizeRateLimitWindow(item, `${fallback} ${index + 1}`))
      .filter((item): item is RateLimitWindowSnapshot => item !== null);
  }
  const single = normalizeRateLimitWindow(value, fallback);
  return single ? [single] : [];
}

function normalizeCreditsText(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (isRecord(value)) {
    const remaining = value.remaining ?? value.balance ?? value.value;
    const unit = extractString(value.unit);
    const num = toNumberOrNull(remaining);
    if (num != null) {
      return unit ? `${num} ${unit}` : String(num);
    }
  }
  return null;
}

function normalizeSessionSource(value: unknown): string {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  if (isRecord(value)) {
    const subAgent = value.subAgent;
    if (isRecord(subAgent)) {
      const agentId = extractString(subAgent.agentId);
      const parentTurnId = extractString(subAgent.parentTurnId);
      if (agentId || parentTurnId) {
        const detail = [agentId ? `agent=${agentId}` : '', parentTurnId ? `turn=${parentTurnId}` : '']
          .filter(Boolean)
          .join(',');
        return detail ? `subAgent(${detail})` : 'subAgent';
      }
      return 'subAgent';
    }
  }

  return 'unknown';
}

export class CodexAppServerClient extends EventEmitter {
  private readonly logger: Logger;
  private readonly codexBin: string;
  private readonly requestTimeoutMs: number;
  private readonly fallbackModel: string;
  private readonly clientName: string;
  private readonly cwd?: string;

  private process: ChildProcessWithoutNullStreams | null = null;
  private started = false;
  private nextRequestId = 1;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private preferredModel: string | null = null;

  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly pendingTurns = new Map<string, PendingTurn>();
  private readonly pendingApprovals = new Map<string, PendingApprovalInternal>();

  constructor(options: {
    logger: Logger;
    codexBin: string;
    requestTimeoutMs: number;
    fallbackModel: string;
    clientName: string;
    cwd?: string;
  }) {
    super();
    this.logger = options.logger;
    this.codexBin = options.codexBin;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.fallbackModel = options.fallbackModel;
    this.clientName = options.clientName;
    this.cwd = options.cwd;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.process = spawn(this.codexBin, ['app-server'], {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    this.process.stdout.setEncoding('utf8');
    this.process.stderr.setEncoding('utf8');
    this.process.stdout.on('data', (chunk: string) => this.onStdoutData(chunk));
    this.process.stderr.on('data', (chunk: string) => this.onStderrData(chunk));
    this.process.on('error', (error) => {
      this.logger.error('Codex app-server process error', { error: parseErrorMessage(error) });
      this.failAllPending(`app-server process error: ${parseErrorMessage(error)}`);
    });
    this.process.on('exit', (code, signal) => {
      this.logger.warn('Codex app-server exited', { code, signal, client: this.clientName });
      this.started = false;
      this.process = null;
      this.failAllPending(`app-server exited (code=${String(code)} signal=${String(signal)})`);
    });

    await this.request('initialize', {
      clientInfo: {
        name: this.clientName,
        version: '0.1.0',
      },
    });
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.process) {
      this.started = false;
      return;
    }

    for (const approvalId of this.pendingApprovals.keys()) {
      this.resolveApproval(approvalId, false);
    }

    const processToStop = this.process;
    this.process = null;
    this.started = false;

    processToStop.removeAllListeners();
    processToStop.kill('SIGTERM');
    setTimeout(() => {
      if (!processToStop.killed) {
        processToStop.kill('SIGKILL');
      }
    }, 2000).unref();

    this.failAllPending('app-server stopped');
  }

  private onStdoutData(chunk: string): void {
    this.stdoutBuffer += chunk;
    let idx = this.stdoutBuffer.indexOf('\n');
    while (idx >= 0) {
      const line = this.stdoutBuffer.slice(0, idx).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
      if (line) {
        this.handleLine(line, 'stdout');
      }
      idx = this.stdoutBuffer.indexOf('\n');
    }
  }

  private onStderrData(chunk: string): void {
    this.stderrBuffer += chunk;
    let idx = this.stderrBuffer.indexOf('\n');
    while (idx >= 0) {
      const line = this.stderrBuffer.slice(0, idx).trim();
      this.stderrBuffer = this.stderrBuffer.slice(idx + 1);
      if (line) {
        this.handleLine(line, 'stderr');
      }
      idx = this.stderrBuffer.indexOf('\n');
    }
  }

  private handleLine(line: string, stream: 'stdout' | 'stderr'): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (stream === 'stderr') {
        this.logger.debug('Codex stderr', { client: this.clientName, line: truncate(line, 500) });
        if (/stream disconnected - retrying sampling request \(5\/5/i.test(line)) {
          this.logger.warn('Sampling stream retries exhausted; failing pending turns', {
            client: this.clientName,
          });
          this.failPendingTurns('network stream disconnected after retries');
        }
      }
      return;
    }

    if (!isRecord(parsed)) {
      return;
    }

    const hasMethod = typeof parsed.method === 'string';
    const hasId = 'id' in parsed;
    const hasResult = 'result' in parsed;
    const hasError = 'error' in parsed;

    if (hasId && !hasMethod && (hasResult || hasError)) {
      this.handleResponse(parsed as unknown as JsonRpcResponse);
      return;
    }

    if (hasId && hasMethod) {
      this.handleServerRequest(parsed as unknown as JsonRpcRequest);
      return;
    }

    if (hasMethod) {
      this.handleNotification(parsed as unknown as JsonRpcNotification);
      return;
    }
  }

  private handleResponse(message: JsonRpcResponse): void {
    const key = idKey(message.id);
    const pending = this.pendingRequests.get(key);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(key);

    if (message.error) {
      pending.reject(new Error(parseErrorMessage(message.error)));
      return;
    }

    pending.resolve(message.result);
  }

  private handleServerRequest(message: JsonRpcRequest): void {
    const method = message.method;
    if (
      method !== 'item/commandExecution/requestApproval' &&
      method !== 'item/fileChange/requestApproval' &&
      method !== 'execCommandApproval' &&
      method !== 'applyPatchApproval' &&
      method !== 'item/tool/requestUserInput'
    ) {
      this.writeRpc({ id: message.id, error: { code: -32601, message: `Unsupported server request: ${method}` } });
      return;
    }

    if (method === 'item/tool/requestUserInput') {
      this.writeRpc({ id: message.id, result: { answers: {} } });
      this.logger.warn('Auto-replied empty request_user_input answers', { client: this.clientName });
      return;
    }

    const rawParams = isRecord(message.params) ? message.params : {};
    const threadId =
      extractString(rawParams.threadId) ||
      extractString(rawParams.conversationId) ||
      extractString(rawParams.thread_id);
    const turnId = extractString(rawParams.turnId) || extractString(rawParams.turn_id) || extractString(rawParams.callId);
    const itemId = extractString(rawParams.itemId);

    // Guard against late approval requests from already-finished/timed-out turns.
    // If we no longer track this turn as pending, forwarding approval to Telegram is confusing.
    if (!this.belongsToPendingTurn(threadId, turnId)) {
      const isLegacy = method === 'execCommandApproval' || method === 'applyPatchApproval';
      const decision = isLegacy ? 'abort' : 'cancel';
      this.logger.warn('Dropping stale approval request (turn already finished)', {
        client: this.clientName,
        method,
        threadId,
        turnId,
      });
      this.writeRpc({
        id: message.id,
        result: {
          decision,
        },
      });
      return;
    }

    const approvalId = `apr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    const approval: PendingApprovalInternal = {
      approvalId,
      requestId: message.id,
      kind: method as ApprovalKind,
      threadId,
      turnId,
      itemId: itemId || undefined,
      summary: this.buildApprovalSummary(method as ApprovalKind, rawParams),
      rawParams,
    };

    this.pendingApprovals.set(approvalId, approval);
    this.emit('approval', approval);
  }

  private belongsToPendingTurn(threadId: string, turnId: string): boolean {
    if (turnId) {
      return this.pendingTurns.has(turnId);
    }
    if (!threadId) {
      return this.pendingTurns.size > 0;
    }
    for (const turn of this.pendingTurns.values()) {
      if (turn.threadId === threadId) {
        return true;
      }
    }
    return false;
  }

  private handleNotification(notification: JsonRpcNotification): void {
    const method = notification.method;
    const params = isRecord(notification.params) ? notification.params : {};

    if (method === 'item/agentMessage/delta') {
      const turnId = extractString(params.turnId);
      const state = this.ensureTurnState(turnId, extractString(params.threadId));
      state.deltaBuffer += extractString(params.delta);
      return;
    }

    if (method === 'item/completed') {
      const turnId = extractString(params.turnId);
      const state = this.ensureTurnState(turnId, extractString(params.threadId));
      const item = isRecord(params.item) ? params.item : {};
      if (item.type === 'agentMessage') {
        const itemText = extractString(item.text);
        if (itemText) {
          state.finalText = itemText;
        }
      }
      return;
    }

    if (method === 'turn/completed') {
      const threadId = extractString(params.threadId);
      const turn = isRecord(params.turn) ? params.turn : {};
      let turnId = extractString(turn.id);
      if (!turnId) {
        turnId = extractString(params.id);
      }
      if (!turnId && this.pendingTurns.size === 1) {
        turnId = Array.from(this.pendingTurns.keys())[0] || '';
      }
      const state = this.ensureTurnState(turnId, threadId);
      const status = extractString(turn.status);
      state.status = status === 'completed' ? 'completed' : 'failed';
      const err = isRecord(turn.error) ? turn.error : null;
      state.errorMessage = err ? parseErrorMessage(err) : state.errorMessage;
      this.resolveTurn(state);
      return;
    }

    if (method === 'codex/event/task_complete' || method === 'codex/event/task_completed') {
      let turnId = extractString(params.id);
      if (!turnId && this.pendingTurns.size === 1) {
        turnId = Array.from(this.pendingTurns.keys())[0] || '';
      }
      const msg = isRecord(params.msg) ? params.msg : {};
      const lastAgentMessage = extractString(msg.last_agent_message);
      const conversationId = extractString(params.conversationId) || extractString(params.threadId);
      const state = this.ensureTurnState(turnId, conversationId);
      if (lastAgentMessage) {
        state.finalText = lastAgentMessage;
      }
      state.status = 'completed';
      this.resolveTurn(state);
      return;
    }

    if (method === 'error') {
      let turnId = extractString(params.turnId);
      if (!turnId) {
        turnId = extractString(params.id);
      }
      if (!turnId && this.pendingTurns.size === 1) {
        turnId = Array.from(this.pendingTurns.keys())[0] || '';
      }
      const threadId = extractString(params.threadId);
      const state = this.ensureTurnState(turnId, threadId);
      const error = isRecord(params.error) ? params.error : null;
      if (error) {
        state.errorMessage = parseErrorMessage(error);
        // App-server may keep reconnecting for missing models for a long time.
        // Fail fast so caller can immediately retry with fallback model.
        if (this.isModelNotFound(state.errorMessage)) {
          state.status = 'failed';
          this.resolveTurn(state);
        }
      }
      return;
    }

    if (method === 'codex/event/warning') {
      const msg = isRecord(params.msg) ? params.msg : null;
      const warningText = msg ? extractString(msg.message) : '';
      const previousModel = this.extractPreviousModel(warningText);
      if (previousModel) {
        this.preferredModel = previousModel;
        this.logger.warn('Captured preferred model from resume warning', {
          client: this.clientName,
          preferredModel: previousModel,
        });
      }
      return;
    }
  }

  private extractPreviousModel(message: string): string | null {
    const match = message.match(/previous=`([^`]+)`/);
    if (!match || !match[1]) {
      return null;
    }
    return match[1];
  }

  private resolveTurn(state: PendingTurn): void {
    const finalText = (state.finalText || state.deltaBuffer || '').trim();
    const result: TurnExecutionResult = {
      threadId: state.threadId,
      turnId: state.turnId,
      status: state.status === 'completed' ? 'completed' : 'failed',
      finalText,
      errorMessage: state.status === 'completed' ? null : state.errorMessage || 'Turn failed without details',
      usedFallback: false,
    };

    if (state.timeout) {
      clearTimeout(state.timeout);
      state.timeout = undefined;
    }

    if (state.resolve) {
      state.resolve(result);
      state.resolve = undefined;
    }

    this.pendingTurns.delete(state.turnId);
  }

  private ensureTurnState(turnId: string, threadId: string): PendingTurn {
    if (!turnId) {
      return {
        threadId,
        turnId: '__unknown__',
        status: 'failed',
        deltaBuffer: '',
        finalText: '',
        errorMessage: 'Missing turn id',
      };
    }

    const existing = this.pendingTurns.get(turnId);
    if (existing) {
      if (!existing.threadId && threadId) {
        existing.threadId = threadId;
      }
      return existing;
    }

    const created: PendingTurn = {
      threadId,
      turnId,
      status: 'inProgress',
      deltaBuffer: '',
      finalText: '',
      errorMessage: null,
    };
    this.pendingTurns.set(turnId, created);
    return created;
  }

  private failAllPending(message: string): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
    }
    this.pendingRequests.clear();

    for (const turn of this.pendingTurns.values()) {
      if (turn.timeout) {
        clearTimeout(turn.timeout);
      }
      if (turn.resolve) {
        turn.resolve({
          threadId: turn.threadId,
          turnId: turn.turnId,
          status: 'failed',
          finalText: turn.finalText || turn.deltaBuffer,
          errorMessage: message,
          usedFallback: false,
        });
      }
    }
    this.pendingTurns.clear();

    this.pendingApprovals.clear();
  }

  private failPendingTurns(message: string): void {
    for (const turn of this.pendingTurns.values()) {
      if (turn.timeout) {
        clearTimeout(turn.timeout);
      }
      if (turn.resolve) {
        turn.resolve({
          threadId: turn.threadId,
          turnId: turn.turnId,
          status: 'failed',
          finalText: turn.finalText || turn.deltaBuffer,
          errorMessage: message,
          usedFallback: false,
        });
      }
    }
    this.pendingTurns.clear();
  }

  private writeRpc(payload: Record<string, unknown>): void {
    if (!this.process || !this.process.stdin.writable) {
      throw new Error('app-server stdin is not writable');
    }
    this.process.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  async request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.process) {
      throw new Error('app-server is not running');
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const key = idKey(id);

    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(key);
        reject(new Error(`RPC timeout for method ${method}`));
      }, this.requestTimeoutMs);

      this.pendingRequests.set(key, {
        resolve: (value: unknown) => resolve(value as T),
        reject,
        timeout,
      });

      this.writeRpc({
        jsonrpc: '2.0',
        id,
        method,
        params: params ?? {},
      });
    });
  }

  async listThreads(limit: number): Promise<ThreadListItem[]> {
    const result = await this.request<ThreadListResult>('thread/list', {
      limit,
      sortKey: 'updated_at',
    });

    const rows = Array.isArray(result?.data) ? result.data : [];
    return rows.map((row) => ({
      id: extractString(row.id),
      preview: sanitizePreview(String(row.preview || '')),
      updatedAt: Number(row.updatedAt || 0),
      cwd: row.cwd == null ? null : String(row.cwd),
      source: normalizeSessionSource(row.source),
    }));
  }

  async listModels(): Promise<string[]> {
    const result = await this.request<ModelListResult>('model/list', {});
    const rows = Array.isArray(result?.data) ? result.data : [];
    const names = rows
      .map((item) => (typeof item?.model === 'string' && item.model ? item.model : item?.id))
      .filter((value): value is string => typeof value === 'string' && !!value);
    return Array.from(new Set(names));
  }

  async getAccountRateLimits(): Promise<RateLimitSnapshot> {
    const result = await this.request<Record<string, unknown>>('account/rateLimits/read', {});
    const limits = isRecord(result?.rateLimits) ? result.rateLimits : {};
    const windows = [
      ...normalizeRateLimitWindows(limits.primary, 'Primary'),
      ...normalizeRateLimitWindows(limits.secondary, 'Secondary'),
    ];
    return {
      windows,
      planType: extractString(result?.planType).trim() || null,
      creditsText: normalizeCreditsText(result?.credits),
    };
  }

  async readThread(threadId: string): Promise<ThreadReadResult> {
    const result = await this.request<ThreadReadResult>('thread/read', {
      threadId,
      includeTurns: false,
    });
    const thread: Record<string, unknown> = isRecord(result?.thread) ? result.thread : {};
    return {
      thread: {
        id: extractString(thread.id),
        preview: sanitizePreview(extractString(thread.preview)),
        updatedAt: Number(thread.updatedAt || 0),
        cwd: thread.cwd == null ? null : extractString(thread.cwd),
        source: normalizeSessionSource(thread.source),
      },
    };
  }

  async resumeThread(threadId: string): Promise<void> {
    await this.request('thread/resume', {
      threadId,
    });
  }

  async runTurn(threadId: string, input: TurnUserInput[], turnTimeoutMs: number): Promise<TurnExecutionResult> {
    const preferred = this.preferredModel || undefined;
    const first = await this.executeTurn(threadId, input, preferred, turnTimeoutMs);

    if (
      first.status === 'failed' &&
      this.isModelNotFound(first.errorMessage) &&
      this.fallbackModel &&
      preferred !== this.fallbackModel
    ) {
      this.logger.warn('Retrying turn with fallback model', {
        client: this.clientName,
        threadId,
        fallbackModel: this.fallbackModel,
      });
      const second = await this.executeTurn(threadId, input, this.fallbackModel, turnTimeoutMs);
      return { ...second, usedFallback: true };
    }

    return { ...first, usedFallback: false };
  }

  private async executeTurn(
    threadId: string,
    input: TurnUserInput[],
    model: string | undefined,
    turnTimeoutMs: number,
  ): Promise<TurnExecutionResult> {
    const normalizedInput = input
      .map((item): Record<string, unknown> | null => {
        if (item.type === 'text') {
          const text = String(item.text || '').trim();
          return text ? { type: 'text', text } : null;
        }
        if (item.type === 'image') {
          const url = String(item.url || '').trim();
          return url ? { type: 'image', url } : null;
        }
        if (item.type === 'localImage') {
          const imagePath = String(item.path || '').trim();
          return imagePath ? { type: 'localImage', path: imagePath } : null;
        }
        return null;
      })
      .filter((item): item is Record<string, unknown> => item !== null);
    if (normalizedInput.length === 0) {
      throw new Error('turn/start input is empty');
    }

    const params: Record<string, unknown> = {
      threadId,
      input: normalizedInput,
    };
    if (model) {
      params.model = model;
    }

    const result = await this.request<{ turn?: { id?: string } }>('turn/start', params);
    const turnId = extractString(result?.turn?.id);
    if (!turnId) {
      throw new Error('turn/start response missing turn id');
    }

    const state = this.ensureTurnState(turnId, threadId);

    if (state.status !== 'inProgress') {
      return {
        threadId,
        turnId,
        status: state.status === 'completed' ? 'completed' : 'failed',
        finalText: (state.finalText || state.deltaBuffer || '').trim(),
        errorMessage: state.status === 'completed' ? null : state.errorMessage,
        usedFallback: false,
      };
    }

    return await new Promise<TurnExecutionResult>((resolve) => {
      state.resolve = resolve;
      if (turnTimeoutMs > 0) {
        state.timeout = setTimeout(() => {
          state.status = 'failed';
          state.errorMessage = `Turn timed out after ${turnTimeoutMs}ms`;
          this.resolveTurn(state);
        }, turnTimeoutMs);
      }
    });
  }

  private isModelNotFound(errorMessage: string | null): boolean {
    if (!errorMessage) {
      return false;
    }
    return /model_not_found/i.test(errorMessage) || /does not exist/i.test(errorMessage);
  }

  resolveApproval(approvalId: string, allow: boolean): boolean {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) {
      return false;
    }

    const isLegacy = pending.kind === 'execCommandApproval' || pending.kind === 'applyPatchApproval';
    const decision = isLegacy
      ? allow
        ? 'approved'
        : 'abort'
      : allow
        ? 'accept'
        : 'cancel';

    this.writeRpc({
      id: pending.requestId,
      result: {
        decision,
      },
    });

    this.pendingApprovals.delete(approvalId);
    return true;
  }

  hasApproval(approvalId: string): boolean {
    return this.pendingApprovals.has(approvalId);
  }

  private buildApprovalSummary(kind: ApprovalKind, params: Record<string, unknown>): string {
    if (kind === 'item/commandExecution/requestApproval') {
      const command = extractString(params.command);
      const cwd = extractString(params.cwd);
      const reason = extractString(params.reason);
      return [
        `Type: command execution`,
        command ? `Command: ${truncate(command, 280)}` : null,
        cwd ? `CWD: ${cwd}` : null,
        reason ? `Reason: ${reason}` : null,
      ]
        .filter(Boolean)
        .join('\n');
    }

    if (kind === 'item/fileChange/requestApproval') {
      const reason = extractString(params.reason);
      const grantRoot = extractString(params.grantRoot);
      return [
        'Type: file change',
        reason ? `Reason: ${reason}` : null,
        grantRoot ? `Grant root: ${grantRoot}` : null,
      ]
        .filter(Boolean)
        .join('\n');
    }

    if (kind === 'execCommandApproval') {
      const commandArray = Array.isArray(params.command) ? params.command.map((v) => String(v)) : [];
      const cwd = extractString(params.cwd);
      const reason = extractString(params.reason);
      return [
        'Type: command execution (legacy)',
        commandArray.length > 0 ? `Command: ${truncate(commandArray.join(' '), 280)}` : null,
        cwd ? `CWD: ${cwd}` : null,
        reason ? `Reason: ${reason}` : null,
      ]
        .filter(Boolean)
        .join('\n');
    }

    const reason = extractString(params.reason);
    const fileChanges = isRecord(params.fileChanges) ? Object.keys(params.fileChanges).length : 0;
    return [
      'Type: file change (legacy)',
      fileChanges > 0 ? `Files: ${fileChanges}` : null,
      reason ? `Reason: ${reason}` : null,
    ]
      .filter(Boolean)
      .join('\n');
  }
}

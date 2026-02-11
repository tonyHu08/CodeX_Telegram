export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  jsonrpc?: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc?: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

export interface JsonRpcNotification {
  jsonrpc?: '2.0';
  method: string;
  params?: unknown;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: {
    id: number;
    type: string;
    username?: string;
    title?: string;
  };
  text?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export interface RemoteBinding {
  chatId: string;
  threadId: string;
  mode: string;
  updatedAt: number;
}

export type PendingApprovalStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'timed_out'
  | 'expired'
  | 'failed';

export type ApprovalKind =
  | 'item/commandExecution/requestApproval'
  | 'item/fileChange/requestApproval'
  | 'execCommandApproval'
  | 'applyPatchApproval';

export interface PendingApproval {
  approvalId: string;
  chatId: string;
  threadId: string;
  turnId: string;
  requestId: string;
  kind: ApprovalKind;
  summary: string;
  expiresAt: number;
  status: PendingApprovalStatus;
  createdAt: number;
  updatedAt: number;
}

export type ActiveTurnStatus = 'running' | 'queued' | 'stale';

export interface ActiveTurn {
  threadId: string;
  chatId: string;
  turnId: string | null;
  status: ActiveTurnStatus;
  queuedText: string | null;
  startedAt: number | null;
  updatedAt: number;
}

export interface ApprovalRequestEvent {
  approvalId: string;
  requestId: JsonRpcId;
  kind: ApprovalKind;
  threadId: string;
  turnId: string;
  itemId?: string;
  summary: string;
  rawParams: Record<string, unknown>;
}

export interface TurnExecutionResult {
  threadId: string;
  turnId: string;
  status: 'completed' | 'failed';
  finalText: string;
  errorMessage: string | null;
  usedFallback: boolean;
}

export interface ThreadListItem {
  id: string;
  preview: string;
  updatedAt: number;
  cwd: string | null;
  source: string;
}

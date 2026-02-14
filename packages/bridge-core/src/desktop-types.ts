import type { BridgeLocale } from './i18n';

export type HealthCode =
  | 'OK'
  | 'CODEX_NOT_FOUND'
  | 'CODEX_NOT_AUTHENTICATED'
  | 'RELAY_DISCONNECTED'
  | 'THREAD_NOT_VISIBLE'
  | 'UNKNOWN_ERROR';

export interface HealthCheckItem {
  id: string;
  ok: boolean;
  message: string;
  code?: HealthCode;
}

export interface HealthReport {
  ok: boolean;
  code: HealthCode;
  checks: HealthCheckItem[];
  checkedAt: number;
}

export interface DesktopConfig {
  deviceId: string;
  relayBaseUrl: string;
  selectedThreadId: string | null;
  autoStartAgent: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  locale: BridgeLocale;
}

export type AnalyticsEventName =
  | 'app_opened'
  | 'onboarding_started'
  | 'pairing_qr_shown'
  | 'pairing_confirmed'
  | 'first_threads_viewed'
  | 'first_thread_bound'
  | 'first_turn_completed'
  | (string & {});

export interface PairingSession {
  pairingSessionId: string;
  qrPayload: string;
  expiresAt: number;
  startCommand?: string;
  botUsername?: string;
}

export interface PairingStatus {
  pairingSessionId: string;
  status: 'pending' | 'confirmed' | 'expired';
  expiresAt: number;
  deviceAccessToken?: string;
}

export interface IncomingImageAttachment {
  kind: 'localImage';
  path: string;
  mimeType?: string;
}

export interface IncomingUserMessageEvent {
  type: 'incomingUserMessage';
  chatId: string;
  messageId: string;
  text: string;
  images?: IncomingImageAttachment[];
  createdAt: number;
}

export type ControlCommandName = 'threads' | 'bind' | 'status' | 'current' | 'active' | 'detail' | 'usage' | 'unbind' | 'cancel' | 'help';

export interface IncomingControlCommandEvent {
  type: 'incomingControlCommand';
  chatId: string;
  messageId: string;
  command: ControlCommandName;
  args?: string;
  source?: 'message' | 'callback';
  createdAt: number;
}

export interface ApprovalDecisionEvent {
  type: 'approvalDecision';
  approvalId: string;
  allow: boolean;
  createdAt: number;
}

export interface ExecutionStatusEvent {
  type: 'executionStatus';
  chatId: string;
  messageId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  text?: string;
  createdAt: number;
}

export interface FinalResponseEvent {
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

export interface OutgoingApprovalRequestEvent {
  type: 'approvalRequest';
  chatId: string;
  messageId: string;
  approvalId: string;
  summary: string;
  createdAt: number;
}

export type DeviceInboundEvent =
  | IncomingUserMessageEvent
  | IncomingControlCommandEvent
  | ApprovalDecisionEvent;

export type DeviceOutboundEvent =
  | ExecutionStatusEvent
  | FinalResponseEvent
  | OutgoingApprovalRequestEvent;

export interface AgentStatus {
  deviceId: string;
  selectedThreadId: string | null;
  pendingApprovals: number;
  runningTurns: number;
  relayConnected: boolean;
  lastError: string | null;
  updatedAt: number;
}

export interface ThreadSummary {
  id: string;
  preview: string;
  updatedAt: number;
  source: string;
  cwd: string | null;
}

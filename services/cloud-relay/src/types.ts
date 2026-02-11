export interface PairingSession {
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

export interface DeviceBinding {
  deviceId: string;
  telegramUserId: string;
  telegramChatId: string;
  deviceAccessToken: string;
  createdAt: number;
}

export interface IncomingUserMessageEvent {
  type: 'incomingUserMessage';
  chatId: string;
  messageId: string;
  text: string;
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
  createdAt: number;
}

export interface ApprovalRequestEvent {
  type: 'approvalRequest';
  chatId: string;
  messageId: string;
  approvalId: string;
  summary: string;
  createdAt: number;
}

export type DeviceInboundEvent = IncomingUserMessageEvent | ApprovalDecisionEvent;
export type DeviceOutboundEvent = ExecutionStatusEvent | FinalResponseEvent | ApprovalRequestEvent;

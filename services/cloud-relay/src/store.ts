import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { DeviceBinding, PairingSession } from './types';

const PAIRING_TTL_MS = 5 * 60 * 1000;

export class RelayStore {
  private readonly sessions = new Map<string, PairingSession>();
  private readonly bindingsByDevice = new Map<string, DeviceBinding>();
  private readonly bindingsByToken = new Map<string, DeviceBinding>();
  private readonly bindingsByChat = new Map<string, DeviceBinding>();
  private readonly approvalToDevice = new Map<string, string>();

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

    return session;
  }

  getBindingByToken(token: string): DeviceBinding | null {
    return this.bindingsByToken.get(token) || null;
  }

  getBindingByDevice(deviceId: string): DeviceBinding | null {
    return this.bindingsByDevice.get(deviceId) || null;
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

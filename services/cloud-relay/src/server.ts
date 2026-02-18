import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import { z } from 'zod';
import { RelayStore } from './store';
import { TelegramBotClient } from './telegram';
import type { AnalyticsEvent, ApprovalDecisionEvent, DeviceOutboundEvent, IncomingUserMessageEvent } from './types';

const relayStore = new RelayStore();
const wsByDeviceId = new Map<string, { send: (payload: string) => void; close: () => void }>();

const app = Fastify({ logger: true });

const relayBaseUrl = process.env.RELAY_PUBLIC_BASE_URL || 'http://127.0.0.1:8787';
const configuredRelayBotUsername = (process.env.RELAY_BOT_USERNAME || '').trim();
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || '';
let activeRelayBotUsername = configuredRelayBotUsername || 'codex_bridge_bot';
const locale = String(process.env.BRIDGE_LOCALE || process.env.LANG || '').toLowerCase().startsWith('en') ? 'en' : 'zh';
const t = (zh: string, en: string) => (locale === 'en' ? en : zh);

let telegramBot: TelegramBotClient | null = null;
let stopPolling: (() => void) | null = null;

function buildPairingDeepLink(pairingSessionId: string, code: string): string {
  return `https://t.me/${activeRelayBotUsername}?start=pair_${pairingSessionId}_${code}`;
}

function buildPairingStartCommand(pairingSessionId: string, code: string): string {
  return `/start pair_${pairingSessionId}_${code}`;
}

async function sendTelegramMessage(chatId: string, text: string): Promise<void> {
  if (!telegramBot) {
    app.log.info({ chatId, text }, 'Telegram token not configured, message only logged');
    return;
  }
  try {
    await telegramBot.sendMessage(chatId, text);
  } catch (error: any) {
    app.log.error({ err: error, chatId }, 'Failed to send Telegram message');
  }
}

function sendToDevice(deviceId: string, event: IncomingUserMessageEvent | ApprovalDecisionEvent): boolean {
  const ws = wsByDeviceId.get(deviceId);
  if (!ws) {
    return false;
  }
  ws.send(JSON.stringify(event));
  return true;
}

function handleDeviceOutbound(deviceId: string, event: DeviceOutboundEvent): void {
  if (event.type === 'approvalRequest') {
    relayStore.trackApproval(event.approvalId, deviceId);
    void sendTelegramMessage(
      event.chatId,
      [
        t('⚠️ 需要审批', '⚠️ Approval required'),
        `ID: ${event.approvalId}`,
        event.summary,
        t(`可回复 /approve ${event.approvalId} 或 /deny ${event.approvalId}`, `Reply /approve ${event.approvalId} or /deny ${event.approvalId}`),
      ].join('\n'),
    );
    return;
  }

  if (event.type === 'executionStatus') {
    if (event.text && ['queued', 'running', 'failed'].includes(event.status)) {
      void sendTelegramMessage(event.chatId, `⏳ ${event.text}`);
    }
    return;
  }

  if (event.type === 'finalResponse') {
    void sendTelegramMessage(event.chatId, `${t('✅ 已完成', '✅ Completed')}\n\n${event.text}`);
  }
}

async function setupRoutes() {
  await app.register(cors, {
    origin: true,
  });
  await app.register(websocket);

  app.get('/healthz', async () => {
    const analytics = relayStore.getAnalyticsSummary();
    return {
      ok: true,
      relayBaseUrl,
      websocketClients: wsByDeviceId.size,
      telegramEnabled: !!telegramBot,
      analyticsEvents: analytics.total,
    };
  });

  app.post('/v1/devices/register', async (request, reply) => {
    const body = z.object({
      deviceId: z.string().uuid().optional(),
      deviceFingerprint: z.string().min(8),
      appVersion: z.string().min(1),
      platform: z.string().min(1),
    }).safeParse(request.body || {});

    if (!body.success) {
      return reply.status(400).send({ error: body.error.message });
    }

    const registered = relayStore.registerDevice({
      deviceId: body.data.deviceId,
      deviceFingerprint: body.data.deviceFingerprint,
      appVersion: body.data.appVersion,
      platform: body.data.platform,
    });

    return {
      deviceId: registered.deviceId,
      deviceToken: registered.deviceToken,
      createdAt: registered.createdAt,
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
    const qrPayload = buildPairingDeepLink(session.id, session.code);
    const startCommand = buildPairingStartCommand(session.id, session.code);

    return {
      pairingSessionId: session.id,
      deviceId: session.deviceId,
      expiresAt: session.expiresAt,
      qrPayload,
      startCommand,
      botUsername: activeRelayBotUsername,
      pollUrl: `${relayBaseUrl}/v1/pairing/sessions/${session.id}`,
      // debug helper for local testing; hide in production through gateway
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

  app.post('/v1/analytics/events', async (request, reply) => {
    const body = z.object({
      eventId: z.string().min(8),
      name: z.string().min(1),
      timestamp: z.number().int().positive(),
      appVersion: z.string().min(1),
      locale: z.string().min(2),
      channelTag: z.string().min(1),
      deviceIdHash: z.string().min(8),
      payload: z.record(z.unknown()).optional(),
    }).safeParse(request.body || {});

    if (!body.success) {
      return reply.status(400).send({ error: body.error.message });
    }

    const event: AnalyticsEvent = {
      eventId: body.data.eventId,
      name: body.data.name,
      timestamp: body.data.timestamp,
      appVersion: body.data.appVersion,
      locale: body.data.locale,
      channelTag: body.data.channelTag,
      deviceIdHash: body.data.deviceIdHash,
      payload: body.data.payload,
    };
    relayStore.pushAnalyticsEvent(event);

    return { ok: true };
  });

  app.get('/v1/analytics/summary', async () => {
    return {
      ok: true,
      ...relayStore.getAnalyticsSummary(),
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
      text: z.string().min(1),
      messageId: z.string().optional(),
    }).safeParse(request.body || {});

    if (!body.success) {
      return reply.status(400).send({ error: body.error.message });
    }

    const binding = relayStore.getBindingByChat(body.data.telegramChatId);
    if (!binding) {
      return reply.status(404).send({ error: 'chat is not bound to any device' });
    }

    const event: IncomingUserMessageEvent = {
      type: 'incomingUserMessage',
      chatId: body.data.telegramChatId,
      messageId: body.data.messageId || randomUUID(),
      text: body.data.text,
      createdAt: Date.now(),
    };

    const sent = sendToDevice(binding.deviceId, event);
    return {
      delivered: sent,
      deviceId: binding.deviceId,
    };
  });
}

async function startTelegramRelayBot(): Promise<void> {
  if (!telegramBotToken) {
    app.log.warn('TELEGRAM_BOT_TOKEN not configured; relay bot disabled');
    return;
  }

  telegramBot = new TelegramBotClient(telegramBotToken, app.log);
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
  app.log.info({ bot: me.username }, 'Telegram relay bot enabled');

  stopPolling = telegramBot.startPolling({
    onMessage: async (msg) => {
      const text = msg.text.trim();

      if (text.startsWith('/start pair_')) {
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

      if (text.startsWith('/approve ') || text.startsWith('/deny ')) {
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

      const binding = relayStore.getBindingByChat(msg.chatId);
      if (!binding) {
        await telegramBot!.sendMessage(msg.chatId, t('当前未绑定设备，请先在桌面端点击“开始配对”并扫码。', 'No device is bound yet. Please click \"Start pairing\" in desktop app and scan QR.'));
        return;
      }

      const sent = sendToDevice(binding.deviceId, {
        type: 'incomingUserMessage',
        chatId: msg.chatId,
        messageId: msg.messageId,
        text,
        createdAt: Date.now(),
      });

      if (!sent) {
        await telegramBot!.sendMessage(msg.chatId, t('设备当前离线，请确认桌面端 Agent 正在运行。', 'Device is offline. Please make sure desktop Agent is running.'));
      }
    },
  });
}

async function main() {
  await setupRoutes();
  await startTelegramRelayBot();

  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || '127.0.0.1';

  await app.listen({ port, host });
  app.log.info({ host, port }, 'CodeX Telegram cloud-relay started');
}

void main().catch((error) => {
  app.log.error({ err: error }, 'Failed to start cloud-relay');
  process.exit(1);
});

process.on('SIGINT', async () => {
  stopPolling?.();
  await app.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  stopPolling?.();
  await app.close();
  process.exit(0);
});

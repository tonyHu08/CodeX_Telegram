import type { FastifyBaseLogger } from 'fastify';

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    from?: { id: number; username?: string };
    chat: { id: number; type: string };
  };
}

export class TelegramBotClient {
  private readonly token: string;
  private readonly logger: FastifyBaseLogger;
  private readonly baseUrl: string;

  constructor(token: string, logger: FastifyBaseLogger) {
    this.token = token;
    this.logger = logger;
    this.baseUrl = `https://api.telegram.org/bot${this.token}`;
  }

  async getMe(): Promise<{ username?: string }> {
    return await this.request('getMe', {});
  }

  async deleteWebhook(dropPendingUpdates = false): Promise<void> {
    await this.request('deleteWebhook', {
      drop_pending_updates: dropPendingUpdates,
    });
  }

  async getUpdates(offset: number | null, timeoutSeconds = 25): Promise<TelegramUpdate[]> {
    const payload: Record<string, unknown> = {
      timeout: timeoutSeconds,
      allowed_updates: ['message'],
    };
    if (offset != null) {
      payload.offset = offset;
    }
    return await this.request('getUpdates', payload);
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    await this.request('sendMessage', {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    });
  }

  private async request(method: string, payload: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${this.baseUrl}/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`Telegram API HTTP ${res.status} for ${method}`);
    }

    const data = await res.json();
    if (!data.ok) {
      throw new Error(`Telegram API error for ${method}: ${data.description || 'unknown'}`);
    }
    return data.result;
  }

  startPolling(handlers: {
    onMessage: (msg: { chatId: string; text: string; fromUserId: string; messageId: string }) => Promise<void>;
  }): () => void {
    let running = true;
    let offset: number | null = null;

    const loop = async () => {
      while (running) {
        try {
          const updates = await this.getUpdates(offset, 25);
          for (const update of updates) {
            offset = update.update_id + 1;
            const message = update.message;
            if (!message || !message.text || !message.from) {
              continue;
            }

            await handlers.onMessage({
              chatId: String(message.chat.id),
              text: message.text.trim(),
              fromUserId: String(message.from.id),
              messageId: String(message.message_id),
            });
          }
        } catch (error: any) {
          const message = error?.message || String(error);
          if (message.includes('HTTP 409')) {
            this.logger.error({ err: error }, 'Telegram polling conflict (another bot instance/webhook may be active)');
          } else {
            this.logger.error({ err: error }, 'Telegram polling loop error');
          }
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      }
    };

    void loop();

    return () => {
      running = false;
    };
  }
}

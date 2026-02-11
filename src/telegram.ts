import { sleep, splitTelegramText } from './utils';
import type { Logger } from './logger';
import type { TelegramApiResponse, TelegramUpdate } from './types';

type TelegramReplyMarkup = Record<string, unknown>;

interface SendMessageOptions {
  replyToMessageId?: number;
  disableNotification?: boolean;
  replyMarkup?: TelegramReplyMarkup;
  parseMode?: 'HTML' | 'MarkdownV2';
}

export class TelegramClient {
  private readonly token: string;
  private readonly logger: Logger;
  private readonly baseUrl: string;

  constructor(token: string, logger: Logger) {
    this.token = token;
    this.logger = logger;
    this.baseUrl = `https://api.telegram.org/bot${this.token}`;
  }

  async getUpdates(offset: number | null, timeoutSeconds: number): Promise<TelegramUpdate[]> {
    const payload: Record<string, unknown> = {
      timeout: timeoutSeconds,
      allowed_updates: ['message', 'callback_query'],
    };
    if (offset != null) {
      payload.offset = offset;
    }

    const data = await this.request<TelegramUpdate[]>('getUpdates', payload);
    return data;
  }

  async sendMessage(chatId: string, text: string, options: SendMessageOptions = {}): Promise<void> {
    const chunks = splitTelegramText(text);
    for (const [index, chunk] of chunks.entries()) {
      const payload: Record<string, unknown> = {
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: true,
      };
      if (options.replyToMessageId != null) {
        payload.reply_to_message_id = options.replyToMessageId;
      }
      if (options.disableNotification) {
        payload.disable_notification = true;
      }
      if (index === 0 && options.replyMarkup) {
        payload.reply_markup = options.replyMarkup;
      }
      if (options.parseMode) {
        payload.parse_mode = options.parseMode;
      }
      await this.request('sendMessage', payload);
    }
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    const payload: Record<string, unknown> = {
      callback_query_id: callbackQueryId,
    };
    if (text && text.trim()) {
      payload.text = text.trim();
    }
    await this.request('answerCallbackQuery', payload);
  }

  private async request<T = unknown>(method: string, payload: Record<string, unknown>): Promise<T> {
    const maxAttempts = method === 'getUpdates' ? 2 : 3;
    const url = `${this.baseUrl}/${method}`;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          let description = '';
          try {
            const body = (await response.json()) as TelegramApiResponse<unknown>;
            description = body.description || '';
          } catch {
            // Ignore parse failures and keep status-only error fallback.
          }
          const suffix = description ? `: ${description}` : '';
          const httpError = new Error(`Telegram API HTTP ${response.status} for ${method}${suffix}`);

          const shouldRetry =
            (response.status >= 500 || response.status === 429 || response.status === 408) && attempt < maxAttempts;
          if (!shouldRetry) {
            throw httpError;
          }
          lastError = httpError;
          await sleep(400 * attempt);
          continue;
        }

        const json = (await response.json()) as TelegramApiResponse<T>;
        if (!json.ok) {
          throw new Error(`Telegram API error for ${method}: ${json.description || 'unknown'}`);
        }

        if (json.result === undefined) {
          this.logger.debug('Telegram API returned empty result', { method });
          return [] as unknown as T;
        }

        return json.result;
      } catch (error: any) {
        const err = error instanceof Error ? error : new Error(String(error));
        const retryable =
          !/HTTP 4\d\d/.test(err.message) || /HTTP 429/.test(err.message) || /HTTP 408/.test(err.message);
        if (attempt >= maxAttempts || !retryable) {
          throw err;
        }
        lastError = err;
        await sleep(400 * attempt);
      }
    }

    throw lastError || new Error(`Telegram request failed for ${method}`);
  }
}

import type { Logger } from './logger';
import { CodexAppServerClient } from './codex-app-server';
import type { ApprovalRequestEvent } from './types';

export class ThreadRuntimeManager {
  private readonly logger: Logger;
  private readonly codexBin: string;
  private readonly requestTimeoutMs: number;
  private readonly fallbackModel: string;

  private readonly clients = new Map<string, CodexAppServerClient>();
  private readonly creating = new Map<string, Promise<CodexAppServerClient>>();
  private approvalHandler: ((event: ApprovalRequestEvent) => void) | null = null;

  constructor(options: {
    logger: Logger;
    codexBin: string;
    requestTimeoutMs: number;
    fallbackModel: string;
  }) {
    this.logger = options.logger;
    this.codexBin = options.codexBin;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.fallbackModel = options.fallbackModel;
  }

  setApprovalHandler(handler: (event: ApprovalRequestEvent) => void): void {
    this.approvalHandler = handler;
  }

  getExisting(threadId: string): CodexAppServerClient | null {
    return this.clients.get(threadId) || null;
  }

  async getOrCreate(threadId: string): Promise<CodexAppServerClient> {
    const existing = this.clients.get(threadId);
    if (existing) {
      return existing;
    }

    const creating = this.creating.get(threadId);
    if (creating) {
      return await creating;
    }

    const promise = this.createClient(threadId);
    this.creating.set(threadId, promise);
    try {
      const client = await promise;
      this.clients.set(threadId, client);
      return client;
    } finally {
      this.creating.delete(threadId);
    }
  }

  private async createClient(threadId: string): Promise<CodexAppServerClient> {
    const client = new CodexAppServerClient({
      logger: this.logger,
      codexBin: this.codexBin,
      requestTimeoutMs: this.requestTimeoutMs,
      fallbackModel: this.fallbackModel,
      clientName: `bridge-thread-${threadId.slice(-8)}`,
    });

    client.on('approval', (event: ApprovalRequestEvent) => {
      if (this.approvalHandler) {
        this.approvalHandler(event);
      }
    });

    await client.start();
    await client.resumeThread(threadId);

    this.logger.info('Thread runtime ready', { threadId });
    return client;
  }

  async stopAll(): Promise<void> {
    const current = Array.from(this.clients.entries());
    this.clients.clear();
    this.creating.clear();

    await Promise.all(
      current.map(async ([threadId, client]) => {
        try {
          await client.stop();
        } catch (error: any) {
          this.logger.warn('Failed to stop thread runtime', {
            threadId,
            error: error?.message || String(error),
          });
        }
      }),
    );
  }
}

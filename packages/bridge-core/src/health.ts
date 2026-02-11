import { spawnSync } from 'node:child_process';
import type { Logger } from './logger';
import { CodexAppServerClient } from './codex-app-server';
import type { HealthCheckItem, HealthReport } from './desktop-types';

function makeReport(checks: HealthCheckItem[]): HealthReport {
  const failed = checks.find((item) => !item.ok);
  return {
    ok: !failed,
    code: failed?.code || 'OK',
    checks,
    checkedAt: Date.now(),
  };
}

export async function runHealthChecks(options: {
  codexBin?: string;
  logger: Logger;
  requestTimeoutMs?: number;
}): Promise<HealthReport> {
  const codexBin = options.codexBin || 'codex';
  const checks: HealthCheckItem[] = [];

  const which = spawnSync(codexBin, ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
  });

  if (which.error || which.status !== 0) {
    checks.push({
      id: 'codex-binary',
      ok: false,
      message: `Cannot execute ${codexBin}.`,
      code: 'CODEX_NOT_FOUND',
    });
    return makeReport(checks);
  }

  checks.push({
    id: 'codex-binary',
    ok: true,
    message: `Found Codex CLI (${which.stdout.trim() || 'ok'})`,
  });

  const client = new CodexAppServerClient({
    logger: options.logger,
    codexBin,
    requestTimeoutMs: options.requestTimeoutMs || 20_000,
    fallbackModel: 'gpt-5.2-codex',
    clientName: 'desktop-health-check',
  });

  try {
    await client.start();
    checks.push({
      id: 'app-server-init',
      ok: true,
      message: 'Codex App Server initialize succeeded.',
    });

    const threads = await client.listThreads(3);
    checks.push({
      id: 'thread-list',
      ok: true,
      message: `thread/list succeeded (${threads.length} threads visible).`,
    });
  } catch (error: any) {
    const message = error?.message || String(error);
    const authError = /auth|login|unauthorized|forbidden/i.test(message);
    checks.push({
      id: 'app-server-init',
      ok: false,
      message,
      code: authError ? 'CODEX_NOT_AUTHENTICATED' : 'UNKNOWN_ERROR',
    });
  } finally {
    try {
      await client.stop();
    } catch {
      // ignore
    }
  }

  return makeReport(checks);
}

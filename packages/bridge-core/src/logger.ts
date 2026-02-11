export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

function formatMeta(meta?: Record<string, unknown>): string {
  if (!meta || Object.keys(meta).length === 0) {
    return '';
  }
  try {
    return ` ${JSON.stringify(meta)}`;
  } catch {
    return ' {"meta":"unserializable"}';
  }
}

class ConsoleLogger implements Logger {
  private readonly debugEnabled: boolean;

  constructor() {
    this.debugEnabled = String(process.env.BRIDGE_DEBUG || '0') === '1';
  }

  info(message: string, meta?: Record<string, unknown>): void {
    console.log(`${new Date().toISOString()} [INFO] ${message}${formatMeta(meta)}`);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    console.warn(`${new Date().toISOString()} [WARN] ${message}${formatMeta(meta)}`);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    console.error(`${new Date().toISOString()} [ERROR] ${message}${formatMeta(meta)}`);
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    if (!this.debugEnabled) {
      return;
    }
    console.log(`${new Date().toISOString()} [DEBUG] ${message}${formatMeta(meta)}`);
  }
}

export function createLogger(): Logger {
  return new ConsoleLogger();
}

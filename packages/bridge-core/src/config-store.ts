import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DesktopConfig } from './desktop-types';
import { normalizeLocale } from './i18n';

export function defaultDataRoot(): string {
  return path.join(os.homedir(), '.codex-bridge');
}

export function defaultConfigPath(): string {
  return path.join(defaultDataRoot(), 'config.json');
}

export function createDefaultDesktopConfig(partial?: Partial<DesktopConfig>): DesktopConfig {
  const relayDefault = process.env.CB_DEFAULT_RELAY_BASE_URL || 'http://127.0.0.1:8787';
  return {
    deviceId: partial?.deviceId || randomUUID(),
    relayBaseUrl: partial?.relayBaseUrl || relayDefault,
    selectedThreadId: partial?.selectedThreadId ?? null,
    autoStartAgent: partial?.autoStartAgent ?? true,
    logLevel: partial?.logLevel || 'info',
    locale: normalizeLocale(partial?.locale),
  };
}

export class ConfigStore {
  private readonly configPath: string;

  constructor(configPath = defaultConfigPath()) {
    this.configPath = configPath;
  }

  get path(): string {
    return this.configPath;
  }

  load(): DesktopConfig {
    if (!fs.existsSync(this.configPath)) {
      const created = createDefaultDesktopConfig();
      this.save(created);
      return created;
    }

    const raw = fs.readFileSync(this.configPath, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const fallback = createDefaultDesktopConfig();
      this.save(fallback);
      return fallback;
    }

    const record = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    const cfg = createDefaultDesktopConfig({
      deviceId: typeof record.deviceId === 'string' ? record.deviceId : undefined,
      relayBaseUrl: typeof record.relayBaseUrl === 'string' ? record.relayBaseUrl : undefined,
      selectedThreadId: typeof record.selectedThreadId === 'string'
        ? record.selectedThreadId
        : record.selectedThreadId === null
          ? null
          : undefined,
      autoStartAgent: typeof record.autoStartAgent === 'boolean' ? record.autoStartAgent : undefined,
      logLevel: record.logLevel === 'debug' || record.logLevel === 'info' || record.logLevel === 'warn' || record.logLevel === 'error'
        ? record.logLevel
        : undefined,
      locale: normalizeLocale(record.locale),
    });
    this.save(cfg);
    return cfg;
  }

  save(config: DesktopConfig): void {
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  }

  update(mutator: (current: DesktopConfig) => DesktopConfig): DesktopConfig {
    const current = this.load();
    const next = mutator(current);
    this.save(next);
    return next;
  }
}

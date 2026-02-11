export type BridgeLocale = 'zh' | 'en';

type TranslateValue = string | number | boolean | null | undefined;

export function normalizeLocale(input: unknown): BridgeLocale {
  const raw = String(input || '').trim().toLowerCase();
  if (!raw) {
    return detectSystemLocale();
  }
  if (raw === 'zh' || raw.startsWith('zh-')) {
    return 'zh';
  }
  if (raw === 'en' || raw.startsWith('en-')) {
    return 'en';
  }
  return detectSystemLocale();
}

export function detectSystemLocale(): BridgeLocale {
  const envLocale = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '';
  const normalized = String(envLocale).toLowerCase();
  if (normalized.startsWith('zh')) {
    return 'zh';
  }
  return 'en';
}

export function localeText(locale: BridgeLocale, zh: string, en: string): string {
  return locale === 'en' ? en : zh;
}

export function formatTemplate(
  template: string,
  values?: Record<string, TranslateValue>,
): string {
  if (!values) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = values[key];
    return value == null ? '' : String(value);
  });
}

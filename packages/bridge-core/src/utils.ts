export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function nowMs(): number {
  return Date.now();
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function splitTelegramText(input: string, chunkSize = 3500): string[] {
  const text = input.trim();
  if (!text) {
    return [''];
  }
  if (text.length <= chunkSize) {
    return [text];
  }

  const chunks: string[] = [];
  let rest = text;
  while (rest.length > chunkSize) {
    let splitIndex = rest.lastIndexOf('\n', chunkSize);
    if (splitIndex < 0 || splitIndex < chunkSize / 2) {
      splitIndex = chunkSize;
    }
    chunks.push(rest.slice(0, splitIndex).trimEnd());
    rest = rest.slice(splitIndex).trimStart();
  }
  if (rest.length > 0) {
    chunks.push(rest);
  }
  return chunks;
}

export function sanitizePreview(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

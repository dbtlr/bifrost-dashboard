export function requireName(value: unknown, max = 100): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new Error(`name must be between 1 and ${max} characters after trimming.`);
  }
  return value.trim();
}

export function requireWebUrl(value: string, base?: string): URL {
  const url = new URL(value, base);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('URLs must use HTTP(S) and must not contain credentials.');
  }
  return url;
}

export function requireAppUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) {
    throw new Error('url must be an absolute http or https URL of at most 2048 characters.');
  }
  try {
    return requireWebUrl(value).href;
  } catch {
    throw new Error('url must be an absolute http or https URL without credentials.');
  }
}

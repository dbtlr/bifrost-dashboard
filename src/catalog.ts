import { requireAppUrl, requireName, requireWebUrl } from './app-rules.ts';

export interface App {
  name: string;
  url: string;
  domain: string;
  icon?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a nonempty string.`);
  }
  return value.trim();
}

// Validate the entire snapshot so a partial automation write cannot silently hide apps.
export function parseCatalog(value: unknown, sourceUrl: string): App[] {
  if (!isRecord(value) || !Array.isArray(value.apps)) {
    throw new Error('The catalog must contain an apps array.');
  }

  const source = requireWebUrl(sourceUrl);
  return value.apps.map((entry: unknown, index: number): App => {
    if (!isRecord(entry)) throw new Error(`App ${index + 1} must be an object.`);
    const name = requireName(entry.name);
    const url = new URL(requireAppUrl(entry.url));
    const app: App = { name, url: url.href, domain: url.host };

    if (entry.icon !== undefined) {
      const icon = requireWebUrl(requireText(entry.icon, `App ${index + 1} icon`), source.href);
      if (icon.origin !== source.origin) {
        throw new Error(`App ${index + 1} icon must be hosted alongside the catalog.`);
      }
      app.icon = icon.href;
    }
    return app;
  }).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) || a.url.localeCompare(b.url));
}

export async function loadApps(sourceUrl: string, fetcher: typeof fetch = fetch): Promise<App[]> {
  const response = await fetcher(sourceUrl, {
    cache: 'no-cache',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Catalog request failed (${response.status}).`);
  return parseCatalog(await response.json(), sourceUrl);
}

export function filterApps(apps: readonly App[], query: string): App[] {
  const normalized = query.trim().toLocaleLowerCase();
  return apps.filter(app => `${app.name} ${app.domain}`.toLocaleLowerCase().includes(normalized));
}

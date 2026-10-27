import { isRecord, requireAppUrl, requireName, requireWebUrl } from './app-rules.ts';

export interface App {
  id: number;
  name: string;
  url: string;
  domain: string;
  icon?: string;
  groupId: number | null;
}

export interface Group {
  id: number;
  name: string;
  apps: App[];
}

export interface Catalog {
  groups: Group[];
  ungrouped: App[];
}

function requireId(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} id must be a positive integer.`);
  }
  return value;
}

function parseApp(entry: unknown, base: URL, label: string): App {
  if (!isRecord(entry)) throw new Error(`${label} must be an object.`);
  const url = new URL(requireAppUrl(entry.url));
  const groupId = entry.groupId === null || entry.groupId === undefined ? null : requireId(entry.groupId, `${label} group`);
  const app: App = { id: requireId(entry.id, label), name: requireName(entry.name), url: url.href, domain: url.host, groupId };

  if (entry.icon !== null && entry.icon !== undefined) {
    if (typeof entry.icon !== 'string' || !entry.icon.trim()) throw new Error(`${label} icon must be a nonempty string.`);
    const icon = requireWebUrl(entry.icon.trim(), base.href);
    if (icon.origin !== base.origin) throw new Error(`${label} icon must be hosted alongside the dashboard.`);
    app.icon = icon.href;
  }
  return app;
}

function parseApps(value: unknown, base: URL, label: string): App[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value.map((entry, index) => parseApp(entry, base, `${label} ${index + 1}`));
}

// Validate the entire snapshot so a partial response cannot silently hide apps. Icon paths
// are relative to the dashboard root (baseUrl), not to the API URL.
export function parseCatalog(value: unknown, baseUrl: string): Catalog {
  if (!isRecord(value) || !Array.isArray(value.groups)) {
    throw new Error('The catalog must contain a groups array and an ungrouped array.');
  }
  const base = requireWebUrl(baseUrl);
  const groups = value.groups.map((entry: unknown, index: number): Group => {
    if (!isRecord(entry)) throw new Error(`Group ${index + 1} must be an object.`);
    return {
      id: requireId(entry.id, `Group ${index + 1}`),
      name: requireName(entry.name, 60),
      apps: parseApps(entry.apps, base, `Group ${index + 1} app`),
    };
  });
  return { groups, ungrouped: parseApps(value.ungrouped, base, 'Ungrouped app') };
}

export async function loadCatalog(apiUrl: string, baseUrl: string, fetcher: typeof fetch = fetch): Promise<Catalog> {
  const response = await fetcher(apiUrl, {
    cache: 'no-cache',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Catalog request failed (${response.status}).`);
  return parseCatalog(await response.json(), baseUrl);
}

export function countApps(catalog: Catalog): number {
  return catalog.groups.reduce((total, group) => total + group.apps.length, catalog.ungrouped.length);
}

// What the launcher shows: apps matching the query, and no group that has none (empty groups included).
export function filterCatalog(catalog: Catalog, query: string): Catalog {
  const normalized = query.trim().toLocaleLowerCase();
  const matches = (app: App): boolean => `${app.name} ${app.domain}`.toLocaleLowerCase().includes(normalized);
  return {
    groups: catalog.groups
      .map(group => ({ ...group, apps: group.apps.filter(matches) }))
      .filter(group => group.apps.length > 0),
    ungrouped: catalog.ungrouped.filter(matches),
  };
}

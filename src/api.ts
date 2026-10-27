import { parseApp, parseCatalog } from './catalog.ts';
import type { App, Catalog } from './catalog.ts';

export interface Layout {
  groups: { id: number; apps: number[] }[];
  ungrouped: number[];
}

export interface AppFields {
  name?: string;
  url?: string;
  groupId?: number | null;
}

// Carries the server's readable message so forms can show it as is.
export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface SendOptions {
  body?: BodyInit;
  contentType?: string;
  cache?: RequestCache;
  timeout?: number;
}

function endpoint(path: string): string {
  return new URL(`api/${path}`, document.baseURI).href;
}

// Every API call goes through here. Paths are relative to the dashboard root, like icon paths.
async function send(method: string, path: string, { body, contentType, cache = 'no-store', timeout = 30_000 }: SendOptions = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(endpoint(path), {
      method,
      body,
      headers: contentType ? { 'Content-Type': contentType } : undefined,
      cache,
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    throw new ApiError(0, 'Couldn’t reach the dashboard. Check your connection and try again.');
  }
  if (response.status === 204) return undefined;
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message = typeof payload === 'object' && payload !== null && 'error' in payload && typeof payload.error === 'string'
      ? payload.error
      : `The request failed (${response.status}).`;
    throw new ApiError(response.status, message);
  }
  return payload;
}

const sendJson = (method: string, path: string, value: unknown) => send(method, path, { body: JSON.stringify(value), contentType: 'application/json' });

// The launcher reads on every load, so it revalidates and gives up sooner than writes do.
export async function getCatalog(): Promise<Catalog> {
  return parseCatalog(await send('GET', 'catalog', { cache: 'no-cache', timeout: 10_000 }), document.baseURI);
}

export async function createApp(fields: Required<AppFields>): Promise<App> {
  return parseApp(await sendJson('POST', 'apps', fields), new URL(document.baseURI), 'The new app');
}
export const updateApp = (id: number, fields: AppFields) => sendJson('PATCH', `apps/${id}`, fields);
export const deleteApp = (id: number) => send('DELETE', `apps/${id}`);
export const uploadIcon = (id: number, file: Blob) => send('PUT', `apps/${id}/icon`, { body: file, contentType: file.type || 'application/octet-stream' });
export const removeIcon = (id: number) => send('DELETE', `apps/${id}/icon`);
export const createGroup = (name: string) => sendJson('POST', 'groups', { name });
export const renameGroup = (id: number, name: string) => sendJson('PATCH', `groups/${id}`, { name });
export const deleteGroup = (id: number) => send('DELETE', `groups/${id}`);

// The revision is that of the catalog the layout was built from; the server rejects it with 409 if it is stale.
export async function saveLayout(layout: Layout, revision: number): Promise<Catalog> {
  return parseCatalog(await sendJson('PUT', 'layout', { revision, ...layout }), document.baseURI);
}

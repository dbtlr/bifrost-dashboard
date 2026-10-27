import { parseCatalog } from './catalog.ts';
import type { Catalog } from './catalog.ts';

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

function endpoint(path: string): string {
  return new URL(`api/${path}`, document.baseURI).href;
}

async function send(method: string, path: string, body?: BodyInit, contentType?: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(endpoint(path), {
      method,
      body,
      headers: contentType ? { 'Content-Type': contentType } : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
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

const sendJson = (method: string, path: string, value: unknown) => send(method, path, JSON.stringify(value), 'application/json');

export const createApp = (fields: Required<AppFields>) => sendJson('POST', 'apps', fields) as Promise<{ id: number }>;
export const updateApp = (id: number, fields: AppFields) => sendJson('PATCH', `apps/${id}`, fields);
export const deleteApp = (id: number) => send('DELETE', `apps/${id}`);
export const uploadIcon = (id: number, file: Blob) => send('PUT', `apps/${id}/icon`, file, file.type || 'application/octet-stream');
export const removeIcon = (id: number) => send('DELETE', `apps/${id}/icon`);
export const createGroup = (name: string) => sendJson('POST', 'groups', { name });
export const renameGroup = (id: number, name: string) => sendJson('PATCH', `groups/${id}`, { name });
export const deleteGroup = (id: number) => send('DELETE', `groups/${id}`);

export async function saveLayout(layout: Layout): Promise<Catalog> {
  return parseCatalog(await sendJson('PUT', 'layout', layout), document.baseURI);
}

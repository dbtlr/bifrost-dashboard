import { createHash, randomUUID } from 'node:crypto';
import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { requireAppUrl, requireName } from '../src/app-rules.ts';
import { isRecord, StoreError } from './store.ts';
import type { AppInput, Layout, Store } from './store.ts';

function json(response: ServerResponse, status: number, body?: unknown): void {
  response.setHeader('Cache-Control', 'no-cache');
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

function badRequest(message: string): never {
  throw new StoreError(400, message);
}

function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!isRecord(value)) badRequest('Body must be a JSON object.');
  for (const field of Object.keys(value)) {
    if (!fields.includes(field)) badRequest(`Unknown field: ${field}.`);
  }
  return value;
}

function id(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) badRequest('IDs must be positive integers.');
  return value;
}

function validated<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    badRequest(error instanceof Error ? error.message : 'Invalid value.');
  }
}

function appInput(value: unknown, partial: boolean): Partial<AppInput> {
  const body = object(value, ['name', 'url', 'groupId']);
  const result: Partial<AppInput> = {};
  if (!partial || 'name' in body) result.name = validated(() => requireName(body.name));
  if (!partial || 'url' in body) result.url = validated(() => requireAppUrl(body.url));
  if ('groupId' in body) result.groupId = body.groupId === null ? null : id(body.groupId);
  return result;
}

function layoutInput(value: unknown): Layout {
  const body = object(value, ['groups', 'ungrouped']);
  if (!Array.isArray(body.groups) || !Array.isArray(body.ungrouped)) badRequest('groups and ungrouped must be arrays.');
  return {
    groups: body.groups.map((value: unknown) => {
      const group = object(value, ['id', 'apps']);
      if (!Array.isArray(group.apps)) badRequest('Group apps must be an array.');
      return { id: id(group.id), apps: group.apps.map(id) };
    }),
    ungrouped: body.ungrouped.map(id),
  };
}

function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        chunks.length = 0;
        reject(new StoreError(413, 'Request body is too large.'));
      } else {
        chunks.push(chunk);
      }
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
    request.on('aborted', () => reject(new StoreError(400, 'Request body was interrupted.')));
  });
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const body = await readBody(request, 64 * 1024);
  return validated(() => JSON.parse(body.toString('utf8')));
}

const iconTypes = new Map([
  ['image/svg+xml', 'svg'], ['image/png', 'png'], ['image/webp', 'webp'],
  ['image/jpeg', 'jpg'], ['image/gif', 'gif'], ['image/x-icon', 'ico'], ['image/vnd.microsoft.icon', 'ico'],
]);

function writeIcon(dataDir: string, bytes: Buffer, extension: string): string {
  const hash = createHash('sha256').update(bytes).digest('hex');
  // Identical bytes reuse the first upload's extension even if the MIME type changes.
  const existing = [...new Set(iconTypes.values())].find(type => existsSync(join(dataDir, 'icons', `${hash}.${type}`)));
  const file = `${hash}.${existing ?? extension}`;
  const target = join(dataDir, 'icons', file);
  if (!existsSync(target)) {
    const temporary = join(dataDir, 'icons', `.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, bytes, { flag: 'wx' });
      renameSync(temporary, target);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  return `icons/${file}`;
}

export function createApiHandler({ store, dataDir }: { store: Store; dataDir: string }) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    response.setHeader('Cache-Control', 'no-cache');
    try {
      const path = (request.url ?? '/').split('?')[0];
      const app = /^\/api\/apps\/([1-9]\d*)(\/icon)?$/.exec(path ?? '');
      const group = /^\/api\/groups\/([1-9]\d*)$/.exec(path ?? '');
      let methods: string[];
      if (path === '/api/catalog') methods = ['GET'];
      else if (path === '/api/apps' || path === '/api/groups') methods = ['POST'];
      else if (app) methods = app[2] ? ['PUT', 'DELETE'] : ['PATCH', 'DELETE'];
      else if (group) methods = ['PATCH', 'DELETE'];
      else if (path === '/api/layout') methods = ['PUT'];
      else throw new StoreError(404, 'API route does not exist.');
      if (!methods.includes(request.method ?? '')) {
        response.setHeader('Allow', methods.join(', '));
        throw new StoreError(405, 'Method is not allowed.');
      }
      if (path === '/api/catalog') {
        json(response, 200, store.catalog());
      } else if (path === '/api/apps') {
        const input = appInput(await readJson(request), false);
        if (input.name === undefined || input.url === undefined) badRequest('name and url are required.');
        json(response, 201, store.createApp({ name: input.name, url: input.url, groupId: input.groupId ?? null }));
      } else if (app) {
        const appId = id(Number(app[1]));
        if (app[2]) {
          store.getApp(appId);
          if (request.method === 'DELETE') {
            json(response, 200, store.setIcon(appId, null));
          } else {
            const contentType = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() ?? '';
            const extension = iconTypes.get(contentType);
            if (!extension) throw new StoreError(415, 'Unsupported icon content type.');
            const bytes = await readBody(request, 1024 * 1024);
            if (bytes.length === 0) badRequest('Icon body must not be empty.');
            // The app may have been deleted while its upload was being read.
            store.getApp(appId);
            json(response, 200, store.setIcon(appId, writeIcon(dataDir, bytes, extension)));
          }
        } else if (request.method === 'DELETE') {
          store.deleteApp(appId);
          json(response, 204);
        } else {
          json(response, 200, store.updateApp(appId, appInput(await readJson(request), true)));
        }
      } else if (path === '/api/groups' || group) {
        const groupId = group ? id(Number(group[1])) : null;
        if (request.method === 'DELETE' && groupId !== null) {
          store.deleteGroup(groupId);
          json(response, 204);
        } else {
          const body = object(await readJson(request), ['name']);
          const name = validated(() => requireName(body.name, 60));
          json(response, groupId === null ? 201 : 200, groupId === null ? store.createGroup(name) : store.updateGroup(groupId, name));
        }
      } else {
        json(response, 200, store.setLayout(layoutInput(await readJson(request))));
      }
    } catch (error) {
      if (error instanceof StoreError) {
        json(response, error.status, { error: error.message });
      } else {
        console.error('Dashboard API request failed:', error);
        json(response, 500, { error: 'Internal server error.' });
      }
    }
  };
}

import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isRecord, requireAppUrl, requireName } from '../src/app-rules.ts';
import { StoreError } from './store.ts';
import type { AppInput, Layout, Store } from './store.ts';

function json(response: ServerResponse, status: number, body?: unknown): void {
  response.setHeader('Cache-Control', 'no-cache');
  if (status === 204) {
    response.writeHead(status);
    response.end();
    return;
  }
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

function pathId(value: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new StoreError(404, 'API route does not exist.');
  return result;
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
  if (partial && Object.keys(body).length === 0) badRequest('Body must contain at least one field.');
  const result: Partial<AppInput> = {};
  if (!partial || 'name' in body) result.name = validated(() => requireName(body.name));
  if (!partial || 'url' in body) result.url = validated(() => requireAppUrl(body.url));
  if ('groupId' in body) result.groupId = body.groupId === null ? null : id(body.groupId);
  return result;
}

function layoutInput(value: unknown): { layout: Layout; revision: number } {
  const body = object(value, ['revision', 'groups', 'ungrouped']);
  const { revision } = body;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
    badRequest('revision must be the nonnegative integer revision of the catalog the layout was based on.');
  }
  if (!Array.isArray(body.groups) || !Array.isArray(body.ungrouped)) badRequest('groups and ungrouped must be arrays.');
  const layout: Layout = {
    groups: body.groups.map((value: unknown) => {
      const group = object(value, ['id', 'apps']);
      if (!Array.isArray(group.apps)) badRequest('Group apps must be an array.');
      return { id: id(group.id), apps: group.apps.map(id) };
    }),
    ungrouped: body.ungrouped.map(id),
  };
  return { layout, revision };
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
  const contentType = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') throw new StoreError(415, 'Content-Type must be application/json.');
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
  // Reuse trusts any file already at `target`, so its bytes must be on disk before the rename publishes it.
  if (!existsSync(target)) {
    const temporary = join(dataDir, 'icons', `.${randomUUID()}.tmp`);
    try {
      const fd = openSync(temporary, 'wx');
      try {
        for (let offset = 0; offset < bytes.length;) offset += writeSync(fd, bytes, offset);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, target);
    } finally {
      rmSync(temporary, { force: true });
    }
    const directory = openSync(join(dataDir, 'icons'), 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
  return `icons/${file}`;
}

export function createApiHandler({ store, dataDir }: { store: Store; dataDir: string }) {
  return async (request: IncomingMessage, response: ServerResponse, path: string): Promise<void> => {
    response.setHeader('Cache-Control', 'no-cache');
    try {
      const app = /^\/api\/apps\/([1-9]\d*)(\/icon)?$/.exec(path);
      const group = /^\/api\/groups\/([1-9]\d*)$/.exec(path);
      const appId = app ? pathId(app[1]!) : null;
      const groupId = group ? pathId(group[1]!) : null;
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
      } else if (app && appId !== null) {
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
        if (request.method === 'DELETE' && groupId !== null) {
          store.deleteGroup(groupId);
          json(response, 204);
        } else {
          const body = object(await readJson(request), ['name']);
          if (groupId !== null && Object.keys(body).length === 0) badRequest('Body must contain at least one field.');
          const name = validated(() => requireName(body.name, 60));
          json(response, groupId === null ? 201 : 200, groupId === null ? store.createGroup(name) : store.updateGroup(groupId, name));
        }
      } else {
        const { layout, revision } = layoutInput(await readJson(request));
        json(response, 200, store.setLayout(layout, revision));
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

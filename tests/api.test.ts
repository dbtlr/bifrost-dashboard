import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createApiHandler } from '../server/api.ts';
import { openStore } from '../server/store.ts';

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'bifrost-api-'));
  const store = openStore(dataDir);
  const server = createServer(createApiHandler({ store, dataDir }));
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const request = async (path: string, method = 'GET', body?: unknown) => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { request, dataDir, base: `http://127.0.0.1:${address.port}` };
}

test('JSON API creates, patches, orders, and deletes apps and groups with documented shapes', async t => {
  const { request } = await fixture(t);
  const groupResponse = await request('/api/groups', 'POST', { name: ' Media ' });
  assert.equal(groupResponse.status, 201);
  const group = await groupResponse.json();
  assert.deepEqual(group, { id: group.id, name: 'Media', apps: [] });
  const appResponse = await request('/api/apps', 'POST', { name: ' Photos ', url: 'https://photos.test', groupId: group.id });
  assert.equal(appResponse.status, 201);
  const app = await appResponse.json();
  assert.deepEqual(app, { id: app.id, name: 'Photos', url: 'https://photos.test/', icon: null, groupId: group.id });
  const patched = await request(`/api/apps/${app.id}`, 'PATCH', { name: 'Album', groupId: null });
  assert.equal(patched.status, 200);
  assert.deepEqual(await patched.json(), { ...app, name: 'Album', groupId: null });
  const renamed = await request(`/api/groups/${group.id}`, 'PATCH', { name: 'Files' });
  assert.equal(renamed.status, 200);
  assert.deepEqual(await renamed.json(), { ...group, name: 'Files' });
  const layout = await request('/api/layout', 'PUT', { groups: [{ id: group.id, apps: [app.id] }], ungrouped: [] });
  assert.equal(layout.status, 200);
  assert.deepEqual(await layout.json(), { groups: [{ id: group.id, name: 'Files', apps: [{ ...app, name: 'Album' }] }], ungrouped: [] });
  const response = await request('/api/catalog');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-cache');
  assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  const conflict = await request('/api/layout', 'PUT', { groups: [], ungrouped: [] });
  assert.equal(conflict.status, 409);
  assert.deepEqual(await (await request('/api/catalog')).json(), await response.json());
  const deleteGroup = await request(`/api/groups/${group.id}`, 'DELETE');
  assert.equal(deleteGroup.status, 204);
  assert.equal(await deleteGroup.text(), '');
  assert.equal((await request(`/api/apps/${app.id}`, 'DELETE')).status, 204);
  assert.deepEqual(await (await request('/api/catalog')).json(), { groups: [], ungrouped: [] });
});

test('rejects unknown fields, invalid values, malformed JSON, and oversized JSON without mutation', async t => {
  const { request, base } = await fixture(t);
  const app = await (await request('/api/apps', 'POST', { name: 'App', url: 'https://app.test' })).json();
  const group = await (await request('/api/groups', 'POST', { name: 'Group' })).json();
  const invalid: [string, string, unknown][] = [
    ['/api/apps', 'POST', { name: 'App', url: 'https://app.test', icon: 'icons/a.svg' }],
    [`/api/apps/${app.id}`, 'PATCH', { extra: true }],
    ['/api/groups', 'POST', { name: 'New', apps: [] }],
    [`/api/groups/${group.id}`, 'PATCH', { name: 'New', id: group.id }],
    ['/api/layout', 'PUT', { groups: [{ id: group.id, apps: [app.id], extra: true }], ungrouped: [] }],
    ['/api/layout', 'PUT', { groups: [], ungrouped: [], extra: true }],
    ['/api/layout', 'PUT', { groups: [], ungrouped: ['1'] }],
    ['/api/apps', 'POST', []], ['/api/apps', 'POST', null], ['/api/apps', 'POST', {}],
    ['/api/apps', 'POST', { name: ' ', url: 'https://app.test' }],
    ['/api/apps', 'POST', { name: 'a'.repeat(101), url: 'https://app.test' }],
    ['/api/groups', 'POST', { name: 'a'.repeat(61) }],
    [`/api/groups/${group.id}`, 'PATCH', {}],
    ...['javascript:alert(1)', '/relative', 'https://user:pw@app.test', 'https://app.test/' + 'a'.repeat(2048)].map(url =>
      ['/api/apps', 'POST', { name: 'App', url }] satisfies [string, string, unknown]),
    ['/api/apps', 'POST', { name: 'App', url: 'https://app.test', groupId: '1' }],
    [`/api/apps/${app.id}`, 'PATCH', { groupId: 1.5 }],
    [`/api/apps/${app.id}`, 'PATCH', { url: null }],
  ];
  const before = await (await request('/api/catalog')).json();
  for (const [path, method, body] of invalid) {
    const response = await request(path, method, body);
    assert.equal(response.status, 400, `${method} ${path}: ${JSON.stringify(body)}`);
    assert.equal(typeof (await response.json()).error, 'string');
    assert.equal(response.headers.get('cache-control'), 'no-cache');
  }
  for (const [body, status] of [['{unfinished', 400], ['', 400], [' '.repeat(65537), 413]] satisfies [string, number][]) {
    const response = await fetch(base + '/api/apps', { method: 'POST', body });
    assert.equal(response.status, status);
    assert.equal(typeof (await response.json()).error, 'string');
  }
  assert.deepEqual(await (await request('/api/catalog')).json(), before);
});

test('returns JSON errors for conflicts, missing objects, unknown routes, and wrong methods', async t => {
  const { request } = await fixture(t);
  await request('/api/groups', 'POST', { name: 'Media' });
  const other = await (await request('/api/groups', 'POST', { name: 'Other' })).json();
  for (const [path, method, body, status] of [
    ['/api/groups', 'POST', { name: ' media ' }, 409],
    [`/api/groups/${other.id}`, 'PATCH', { name: 'MEDIA' }, 409],
    ['/api/apps', 'POST', { name: 'App', url: 'https://app.test', groupId: 999 }, 404],
    ['/api/apps/999', 'PATCH', { name: 'Missing' }, 404],
    ['/api/apps/999', 'DELETE', undefined, 404],
    ['/api/apps/999/icon', 'DELETE', undefined, 404],
    ['/api/groups/999', 'PATCH', { name: 'Missing' }, 404],
    ['/api/groups/999', 'DELETE', undefined, 404],
    ['/api/unknown', 'GET', undefined, 404],
  ] satisfies [string, string, unknown, number][]) {
    const response = await request(path, method, body);
    assert.equal(response.status, status, `${method} ${path}`);
    assert.equal(typeof (await response.json()).error, 'string');
    assert.equal(response.headers.get('cache-control'), 'no-cache');
  }
  for (const [path, allow] of [
    ['/api/catalog', 'GET'], ['/api/apps', 'POST'], ['/api/apps/1', 'PATCH, DELETE'],
    ['/api/apps/1/icon', 'PUT, DELETE'], ['/api/groups', 'POST'], ['/api/groups/1', 'PATCH, DELETE'], ['/api/layout', 'PUT'],
  ]) {
    const response = await request(path!, 'OPTIONS');
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), allow);
    assert.equal(typeof (await response.json()).error, 'string');
  }
});

test('icon uploads reject unsupported types, empty bodies, and bodies over 1 MiB', async t => {
  const { request, base, dataDir } = await fixture(t);
  const app = await (await request('/api/apps', 'POST', { name: 'App', url: 'https://app.test' })).json();
  for (const [type, body, status] of [
    ['text/plain', '<svg/>', 415], ['', '<svg/>', 415],
    ['image/svg+xml', '', 400], ['image/png', Buffer.alloc(1024 * 1024 + 1), 413],
  ] satisfies [string, string | Buffer, number][]) {
    const response = await fetch(`${base}/api/apps/${app.id}/icon`, { method: 'PUT', headers: { 'Content-Type': type }, body });
    assert.equal(response.status, status);
    assert.equal(typeof (await response.json()).error, 'string');
    assert.equal(response.headers.get('cache-control'), 'no-cache');
  }
  assert.equal((await fetch(base + '/api/apps/999/icon', { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: 'icon' })).status, 404);
  assert.deepEqual(await readdir(join(dataDir, 'icons')), []);
  assert.deepEqual((await (await request('/api/catalog')).json()).ungrouped, [app]);
});

test('icons use content hashes, deduplicate, and are removed only after the last reference', async t => {
  const { request, base, dataDir } = await fixture(t);
  const first = await (await request('/api/apps', 'POST', { name: 'First', url: 'https://first.test' })).json();
  const second = await (await request('/api/apps', 'POST', { name: 'Second', url: 'https://second.test' })).json();
  const upload = async (id: number, bytes: string, type = 'image/svg+xml') => {
    const response = await fetch(`${base}/api/apps/${id}/icon`, { method: 'PUT', headers: { 'Content-Type': type }, body: bytes });
    assert.equal(response.status, 200);
    return response.json();
  };
  const icon = (await upload(first.id, '<svg/>', 'image/svg+xml; charset=utf-8')).icon;
  assert.equal(icon, 'icons/d4dc56669143034f31aa309635d4113d9ad76a02b1739da22c965ed2049be9e6.svg');
  assert.equal(await readFile(join(dataDir, icon), 'utf8'), '<svg/>');
  assert.equal((await upload(second.id, '<svg/>')).icon, icon);
  assert.equal((await upload(second.id, '<svg/>', 'image/png')).icon, icon);
  assert.equal((await upload(first.id, '<svg/>')).icon, icon);
  assert.equal((await readdir(join(dataDir, 'icons'))).length, 1);
  const replacement = (await upload(first.id, '<svg>new</svg>')).icon;
  assert.notEqual(replacement, icon);
  assert.equal((await readdir(join(dataDir, 'icons'))).length, 2);
  assert.equal((await request(`/api/apps/${second.id}`, 'DELETE')).status, 204);
  await assert.rejects(readFile(join(dataDir, icon)), { code: 'ENOENT' });
  const removed = await request(`/api/apps/${first.id}/icon`, 'DELETE');
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).icon, null);
  assert.deepEqual(await readdir(join(dataDir, 'icons')), []);
  assert.equal((await request(`/api/apps/${first.id}/icon`, 'DELETE')).status, 200);
  for (const [type, ext] of [
    ['image/png', 'png'], ['image/webp', 'webp'], ['image/jpeg', 'jpg'], ['image/gif', 'gif'],
    ['image/x-icon', 'ico'], ['image/vnd.microsoft.icon', 'ico'],
  ]) {
    const result = await upload(first.id, `bytes for ${type}`, type);
    assert.ok(result.icon.endsWith(`.${ext}`));
    assert.equal((await readdir(join(dataDir, 'icons'))).length, 1);
  }
  // The maximum accepted body is inclusive.
  const max = await fetch(`${base}/api/apps/${first.id}/icon`, {
    method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: Buffer.alloc(1024 * 1024),
  });
  assert.equal(max.status, 200);
  assert.equal((await request(`/api/apps/${first.id}`, 'DELETE')).status, 204);
  assert.deepEqual(await readdir(join(dataDir, 'icons')), []);
});

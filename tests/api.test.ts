import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createRuntimeMiddleware } from '../server/server.ts';

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'bifrost-api-'));
  const runtime = createRuntimeMiddleware(dataDir);
  const server = createServer((request, response) => runtime.handle(request, response, () => response.writeHead(404).end()));
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    runtime.close();
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
  const layout = await request('/api/layout', 'PUT', { revision: 4, groups: [{ id: group.id, apps: [app.id] }], ungrouped: [] });
  assert.equal(layout.status, 200);
  assert.deepEqual(await layout.json(), { revision: 5, groups: [{ id: group.id, name: 'Files', apps: [{ ...app, name: 'Album' }] }], ungrouped: [] });
  const response = await request('/api/catalog');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-cache');
  assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  const conflict = await request('/api/layout', 'PUT', { revision: 5, groups: [], ungrouped: [] });
  assert.equal(conflict.status, 409);
  assert.deepEqual(await (await request('/api/catalog')).json(), await response.json());
  const deleteGroup = await request(`/api/groups/${group.id}`, 'DELETE');
  assert.equal(deleteGroup.status, 204);
  assert.equal(await deleteGroup.text(), '');
  assert.equal((await request(`/api/apps/${app.id}`, 'DELETE')).status, 204);
  assert.deepEqual(await (await request('/api/catalog')).json(), { revision: 7, groups: [], ungrouped: [] });
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
    ['/api/layout', 'PUT', { revision: 2, groups: [], ungrouped: ['1'] }],
    ['/api/layout', 'PUT', { groups: [{ id: group.id, apps: [] }], ungrouped: [app.id] }],
    ...[-1, 1.5, '2', null].map(revision =>
      ['/api/layout', 'PUT', { revision, groups: [{ id: group.id, apps: [] }], ungrouped: [app.id] }] satisfies [string, string, unknown]),
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
    const response = await fetch(base + '/api/apps', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
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


test('rejects URLs that exceed 2048 characters after normalization on create and patch', async t => {
  const { request } = await fixture(t);
  const app = await (await request('/api/apps', 'POST', { name: 'App', url: 'https://app.test' })).json();
  const before = await (await request('/api/catalog')).json();
  const urls = [
    'https://a.test/' + 'a b'.repeat(677),
    'https://' + 'ü'.repeat(20) + '.test/' + 'a'.repeat(2010),
  ];
  for (const url of urls) {
    assert.ok(url.length <= 2048);
    assert.ok(new URL(url).href.length > 2048);
    for (const [path, method, body] of [
      ['/api/apps', 'POST', { name: 'Too long', url }],
      [`/api/apps/${app.id}`, 'PATCH', { url }],
    ] satisfies [string, string, unknown][]) {
      const response = await request(path, method, body);
      assert.equal(response.status, 400, `${method}: normalized URL length`);
      assert.equal(typeof (await response.json()).error, 'string');
    }
  }
  assert.deepEqual(await (await request('/api/catalog')).json(), before);
  const url = 'https://a.test/' + 'a'.repeat(2033);
  const response = await request(`/api/apps/${app.id}`, 'PATCH', { url });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).url, url);
});

test('app and group name limits count Unicode code points on create and patch', async t => {
  const { request } = await fixture(t);
  for (const [resource, max] of [['apps', 100], ['groups', 60]] satisfies [string, number][]) {
    const name = '😀'.repeat(max);
    const body = resource === 'apps' ? { name, url: 'https://app.test' } : { name };
    const created = await request(`/api/${resource}`, 'POST', body);
    assert.equal(created.status, 201, `${resource}: accepts ${max} code points`);
    const entry = await created.json();
    assert.equal(entry.name, name);
    const patched = await request(`/api/${resource}/${entry.id}`, 'PATCH', { name: ` ${name} ` });
    assert.equal(patched.status, 200);
    assert.equal((await patched.json()).name, name);
    for (const [path, method, value] of [
      [`/api/${resource}`, 'POST', { ...body, name: name + '😀' }],
      [`/api/${resource}/${entry.id}`, 'PATCH', { name: name + '😀' }],
    ] satisfies [string, string, unknown][]) {
      const response = await request(path, method, value);
      assert.equal(response.status, 400, `${method} ${resource}: rejects ${max + 1} code points`);
      assert.equal(typeof (await response.json()).error, 'string');
    }
  }
});

test('JSON endpoints require application/json and allow content type parameters', async t => {
  const { request, base } = await fixture(t);
  const app = await (await request('/api/apps', 'POST', { name: 'App', url: 'https://app.test' })).json();
  const group = await (await request('/api/groups', 'POST', { name: 'Group' })).json();
  const endpoints: [string, string, unknown, number][] = [
    ['/api/apps', 'POST', { name: 'New', url: 'https://new.test' }, 201],
    [`/api/apps/${app.id}`, 'PATCH', { name: 'Renamed' }, 200],
    ['/api/groups', 'POST', { name: 'New group' }, 201],
    [`/api/groups/${group.id}`, 'PATCH', { name: 'Renamed group' }, 200],
    ['/api/layout', 'PUT', { revision: 2, groups: [{ id: group.id, apps: [] }], ungrouped: [app.id] }, 200],
  ];
  const before = await (await request('/api/catalog')).json();
  for (const [path, method, body] of endpoints) {
    for (const type of [undefined, 'text/plain', 'application/x-www-form-urlencoded', 'application/jsonp']) {
      const response = await fetch(base + path, {
        method, headers: type === undefined ? {} : { 'Content-Type': type },
        body: Buffer.from(JSON.stringify(body)),
      });
      assert.equal(response.status, 415, `${method} ${path}: ${type ?? 'missing header'}`);
      assert.equal(typeof (await response.json()).error, 'string');
      assert.equal(response.headers.get('cache-control'), 'no-cache');
    }
  }
  assert.deepEqual(await (await request('/api/catalog')).json(), before);
  // Apply the layout before adding resources so its snapshot is still current.
  for (const [path, method, body, status] of endpoints.reverse()) {
    const response = await fetch(base + path, {
      method, headers: { 'Content-Type': 'Application/JSON; charset=utf-8' }, body: JSON.stringify(body),
    });
    assert.equal(response.status, status);
  }
});

test('empty app and group patches return 400 without changing the catalog', async t => {
  const { request } = await fixture(t);
  const app = await (await request('/api/apps', 'POST', { name: 'App', url: 'https://app.test' })).json();
  const group = await (await request('/api/groups', 'POST', { name: 'Group' })).json();
  const before = await (await request('/api/catalog')).json();
  for (const path of [`/api/apps/${app.id}`, `/api/groups/${group.id}`]) {
    const response = await request(path, 'PATCH', {});
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Body must contain at least one field.' });
  }
  assert.deepEqual(await (await request('/api/catalog')).json(), before);
});

test('204 app and group deletions have no content type and no body', async t => {
  const { request } = await fixture(t);
  const app = await (await request('/api/apps', 'POST', { name: 'App', url: 'https://app.test' })).json();
  const group = await (await request('/api/groups', 'POST', { name: 'Group' })).json();
  for (const path of [`/api/apps/${app.id}`, `/api/groups/${group.id}`]) {
    const response = await request(path, 'DELETE');
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('content-type'), null);
    assert.equal(await response.text(), '');
    assert.equal(response.headers.get('cache-control'), 'no-cache');
  }
});

test('API routing uses the decoded path and rejects invalid path IDs with 404', async t => {
  const { request } = await fixture(t);
  const catalog = await request('/api/%63atalog?ignored=true');
  assert.equal(catalog.status, 200);
  assert.deepEqual(await catalog.json(), { revision: 0, groups: [], ungrouped: [] });
  const created = await request('/%61pi/%61pps', 'POST', { name: 'App', url: 'https://app.test' });
  assert.equal(created.status, 201);
  const app = await created.json();
  const patched = await request(`/api/%61pps/${app.id}`, 'PATCH', { name: 'Renamed' });
  assert.equal(patched.status, 200);
  for (const resource of ['apps', 'groups']) {
    for (const id of ['0', '-1', '1.5', '01', 'NaN', '9007199254740992', '99999999999999999999']) {
      const response = await request(`/api/${resource}/${id}`, 'DELETE');
      assert.equal(response.status, 404, `${resource}/${id}`);
      assert.equal(typeof (await response.json()).error, 'string');
    }
  }
  const icon = await request('/api/apps/99999999999999999999/icon', 'DELETE');
  assert.equal(icon.status, 404);
  const bodyId = await request(`/api/apps/${app.id}`, 'PATCH', { groupId: 9007199254740992 });
  assert.equal(bodyId.status, 400);
});

test('deleting an app while its icon streams leaves no icon file behind', async t => {
  const { request, base, dataDir } = await fixture(t);
  const app = await (await request('/api/apps', 'POST', { name: 'App', url: 'https://app.test' })).json();
  const before = await readdir(join(dataDir, 'icons'));
  const upload = httpRequest(`${base}/api/apps/${app.id}/icon`, {
    method: 'PUT', headers: { 'Content-Type': 'image/svg+xml', Expect: '100-continue' },
  });
  t.after(() => upload.destroy());
  const continued = once(upload, 'continue');
  const completed = once(upload, 'response');
  upload.flushHeaders();
  // The continue response confirms the server has accepted headers and is awaiting bytes.
  await continued;
  upload.write('<svg>');
  assert.equal((await request(`/api/apps/${app.id}`, 'DELETE')).status, 204);
  upload.end('</svg>');
  const [response] = await completed;
  assert.equal(response.statusCode, 404);
  response.resume();
  await once(response, 'end');
  assert.deepEqual(await readdir(join(dataDir, 'icons')), before);
  assert.deepEqual(await (await request('/api/catalog')).json(), { revision: 2, groups: [], ungrouped: [] });
});

test('PUT layout applies the exact order of at least three ungrouped apps', async t => {
  const { request } = await fixture(t);
  const apps = [];
  for (const name of ['A', 'B', 'C']) {
    apps.push(await (await request('/api/apps', 'POST', { name, url: 'https://app.test' })).json());
  }
  const ordered = [apps[2], apps[0], apps[1]];
  const response = await request('/api/layout', 'PUT', { revision: 3, groups: [], ungrouped: ordered.map(app => app.id) });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).ungrouped, ordered);
  assert.deepEqual((await (await request('/api/catalog')).json()).ungrouped, ordered);
});

test('the catalog revision increases with every change made through the API', async t => {
  const { request, base } = await fixture(t);
  let expected = 0;
  const revision = async () => (await (await request('/api/catalog')).json()).revision;
  const changes = async (send: () => Promise<Response>, status: number) => {
    const response = await send();
    assert.equal(response.status, status);
    expected += 1;
    assert.equal(await revision(), expected);
    return response.status === 204 ? undefined : response.json();
  };
  assert.equal(await revision(), 0);
  const group = await changes(() => request('/api/groups', 'POST', { name: 'Group' }), 201);
  const app = await changes(() => request('/api/apps', 'POST', { name: 'App', url: 'https://app.test' }), 201);
  await changes(() => request(`/api/apps/${app.id}`, 'PATCH', { groupId: group.id }), 200);
  await changes(() => request(`/api/groups/${group.id}`, 'PATCH', { name: 'Renamed' }), 200);
  await changes(() => fetch(`${base}/api/apps/${app.id}/icon`, { method: 'PUT', headers: { 'Content-Type': 'image/svg+xml' }, body: '<svg/>' }), 200);
  await changes(() => request(`/api/apps/${app.id}/icon`, 'DELETE'), 200);
  const layout = await changes(() => request('/api/layout', 'PUT', { revision: expected, groups: [{ id: group.id, apps: [app.id] }], ungrouped: [] }), 200);
  assert.equal(layout.revision, expected);
  await changes(() => request(`/api/groups/${group.id}`, 'DELETE'), 204);
  await changes(() => request(`/api/apps/${app.id}`, 'DELETE'), 204);
  assert.equal((await request('/api/groups', 'POST', { name: '' })).status, 400);
  assert.equal(await revision(), expected);
});

test('a layout with a stale revision returns 409 and changes nothing', async t => {
  const { request } = await fixture(t);
  const first = await (await request('/api/groups', 'POST', { name: 'First' })).json();
  const second = await (await request('/api/groups', 'POST', { name: 'Second' })).json();
  const read = await (await request('/api/catalog')).json();
  // Another client reorders the groups after the first client read the catalog.
  assert.equal((await request('/api/layout', 'PUT', { revision: read.revision, groups: [{ id: second.id, apps: [] }, { id: first.id, apps: [] }], ungrouped: [] })).status, 200);
  const before = await (await request('/api/catalog')).json();
  const response = await request('/api/layout', 'PUT', { revision: read.revision, groups: [{ id: first.id, apps: [] }, { id: second.id, apps: [] }], ungrouped: [] });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /^The catalog changed since it was read/);
  assert.deepEqual(await (await request('/api/catalog')).json(), before);
  assert.deepEqual(before.groups.map((group: { name: string }) => group.name), ['Second', 'First']);
});

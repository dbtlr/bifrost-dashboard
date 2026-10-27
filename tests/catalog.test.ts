import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countApps, filterCatalog, loadCatalog, parseCatalog } from '../src/catalog.ts';

const base = 'https://dashboard.example.test/';
const api = 'https://dashboard.example.test/api/catalog';
const immich = { id: 7, name: 'Immich', url: 'https://photos.example.test', icon: 'icons/immich.svg', groupId: 2 };
const home = { id: 9, name: ' Home Assistant ', url: 'http://home.example.test:8123', icon: null, groupId: null };
const sample = { groups: [{ id: 2, name: 'Media', apps: [immich] }, { id: 3, name: 'Empty', apps: [] }], ungrouped: [home] };

test('reads groups in order, keeps domains, and resolves icons against the dashboard root', () => {
  const catalog = parseCatalog(sample, base);
  assert.deepEqual(catalog.groups.map(group => group.name), ['Media', 'Empty']);
  assert.deepEqual(catalog.groups[0]?.apps[0], {
    id: 7, name: 'Immich', url: 'https://photos.example.test/', domain: 'photos.example.test',
    icon: 'https://dashboard.example.test/icons/immich.svg', groupId: 2,
  });
  assert.deepEqual(catalog.ungrouped[0], { id: 9, name: 'Home Assistant', url: 'http://home.example.test:8123/', domain: 'home.example.test:8123', groupId: null });
});

test('icons resolve beside the dashboard, including subpath deployments', () => {
  const catalog = parseCatalog(sample, 'https://dashboard.example.test/start/');
  assert.equal(catalog.groups[0]?.apps[0]?.icon, 'https://dashboard.example.test/start/icons/immich.svg');
});

test('order is preserved rather than sorted', () => {
  const catalog = parseCatalog({ groups: [], ungrouped: [{ ...home, id: 1, name: 'Zed' }, { ...home, id: 2, name: 'Alpha' }] }, base);
  assert.deepEqual(catalog.ungrouped.map(app => app.name), ['Zed', 'Alpha']);
});

test('invalid catalogs fail validation rather than silently dropping apps', () => {
  const invalid = [
    null, [], {}, { groups: {}, ungrouped: [] }, { groups: [], ungrouped: {} }, { groups: [null], ungrouped: [] },
    { groups: [{ id: 1, name: ' ', apps: [] }], ungrouped: [] }, { groups: [{ id: 1, name: 'G' }], ungrouped: [] },
    { groups: [], ungrouped: [{ ...home, id: 'x' }] }, { groups: [], ungrouped: [{ ...home, name: ' ' }] },
    { groups: [], ungrouped: [{ ...home, icon: 4 }] }, { groups: [], ungrouped: [null] },
  ];
  for (const value of invalid) assert.throws(() => parseCatalog(value, base));
});

test('app destinations must be absolute HTTP(S) URLs without embedded credentials', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,hello', '/relative', 'https://user:secret@photos.example.test']) {
    assert.throws(() => parseCatalog({ groups: [], ungrouped: [{ ...home, url }] }, base));
  }
});

test('icons must resolve to the dashboard origin', () => {
  for (const icon of ['https://other.example.test/icon.svg', '//other.example.test/icon.svg', 'data:image/svg+xml,test', 'javascript:alert(1)']) {
    assert.throws(() => parseCatalog({ groups: [], ungrouped: [{ ...home, icon }] }, base));
  }
});

test('search matches names and domains across groups and hides groups without matches', () => {
  const catalog = parseCatalog(sample, base);
  const byName = filterCatalog(catalog, '  PHOTOS  ');
  assert.deepEqual(byName.groups.map(group => group.name), ['Media']);
  assert.equal(byName.ungrouped.length, 0);
  assert.deepEqual(filterCatalog(catalog, 'assistant').ungrouped.map(app => app.name), ['Home Assistant']);
  assert.equal(filterCatalog(catalog, 'assistant').groups.length, 0);
  assert.equal(filterCatalog(catalog, '8123').ungrouped.length, 1);
  assert.equal(countApps(filterCatalog(catalog, '')), 2);
  assert.equal(countApps(filterCatalog(catalog, 'missing')), 0);
  assert.equal(catalog.groups.length, 2);
});

test('the launcher view omits empty groups even without a query', () => {
  assert.deepEqual(filterCatalog(parseCatalog(sample, base), '').groups.map(group => group.name), ['Media']);
});

test('fetches and revalidates the catalog on every load', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (url, options) => {
    assert.equal(String(url), api);
    assert.equal(options?.cache, 'no-cache');
    assert.ok(options?.signal instanceof AbortSignal);
    calls += 1;
    return new Response(JSON.stringify({ groups: [], ungrouped: [{ ...home, name: `App ${calls}` }] }));
  };
  assert.equal((await loadCatalog(api, base, fetcher)).ungrouped[0]?.name, 'App 1');
  assert.equal((await loadCatalog(api, base, fetcher)).ungrouped[0]?.name, 'App 2');
});

test('rejects failed responses, malformed JSON, and network failures', async () => {
  await assert.rejects(loadCatalog(api, base, async () => new Response('Not found', { status: 404 })), /404/);
  await assert.rejects(loadCatalog(api, base, async () => new Response('{unfinished')));
  await assert.rejects(loadCatalog(api, base, async () => { throw new TypeError('Network unavailable'); }), /Network unavailable/);
});

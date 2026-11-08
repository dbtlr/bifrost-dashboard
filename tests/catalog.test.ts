import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterApps, loadApps, parseCatalog } from '../src/catalog.ts';

const source = 'https://dashboard.example.test/apps.json';
const sample = { name: 'Immich', url: 'https://photos.example.test', icon: '/icons/immich.svg' };

test('reads the catalog, resolves local icons, and sorts names alphabetically', () => {
  const apps = parseCatalog({ apps: [sample, { name: '  Archive  ', url: 'https://docs.example.test/library' }] }, source);
  assert.deepEqual(apps, [
    { name: 'Archive', url: 'https://docs.example.test/library', domain: 'docs.example.test' },
    { name: 'Immich', url: 'https://photos.example.test/', domain: 'photos.example.test', icon: 'https://dashboard.example.test/icons/immich.svg' },
  ]);
});

test('relative icons resolve beside the catalog, including subpath deployments', () => {
  const apps = parseCatalog({ apps: [{ ...sample, icon: 'icons/immich.v2.svg' }] }, 'https://dashboard.example.test/start/apps.json');
  assert.equal(apps[0]?.icon, 'https://dashboard.example.test/start/icons/immich.v2.svg');
});

test('empty catalogs are valid; missing icons can use the UI fallback', () => {
  assert.deepEqual(parseCatalog({ apps: [] }, source), []);
  assert.equal(parseCatalog({ apps: [{ name: 'Home', url: 'http://home.example.test:8123' }] }, source)[0]?.domain, 'home.example.test:8123');
});

test('invalid catalogs fail validation rather than silently dropping apps', () => {
  for (const invalid of [null, [], {}, { apps: {} }, { apps: [null] }, { apps: [{ ...sample, name: ' ' }] }, { apps: [{ name: 'Missing URL' }] }, { apps: [{ ...sample, icon: 4 }] }]) {
    assert.throws(() => parseCatalog(invalid, source));
  }
});

test('app destinations must be absolute HTTP(S) URLs without embedded credentials', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,hello', 'file:///tmp/app', '/relative', '//photos.example.test', 'https://user:secret@photos.example.test']) {
    assert.throws(() => parseCatalog({ apps: [{ ...sample, url }] }, source));
  }
});

test('icons must resolve to the catalog origin', () => {
  for (const icon of ['https://other.example.test/icon.svg', '//other.example.test/icon.svg', 'data:image/svg+xml,test', 'javascript:alert(1)', 'https://user:secret@dashboard.example.test/icon.svg']) {
    assert.throws(() => parseCatalog({ apps: [{ ...sample, icon }] }, source));
  }
});

test('search matches app names and domains without changing the catalog', () => {
  const apps = parseCatalog({ apps: [sample, { name: 'Home Assistant', url: 'https://home.example.test' }] }, source);
  assert.deepEqual(filterApps(apps, '  PHOTOS  ').map(app => app.name), ['Immich']);
  assert.deepEqual(filterApps(apps, 'assistant').map(app => app.name), ['Home Assistant']);
  assert.equal(filterApps(apps, '').length, 2);
  assert.equal(filterApps(apps, 'missing').length, 0);
  assert.equal(apps.length, 2);
});

test('fetches and revalidates the runtime file on every load', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (url, options) => {
    assert.equal(String(url), source);
    assert.equal(options?.cache, 'no-cache');
    assert.ok(options?.signal instanceof AbortSignal);
    calls += 1;
    return new Response(JSON.stringify({ apps: [{ ...sample, name: `App ${calls}` }] }));
  };
  assert.equal((await loadApps(source, fetcher))[0]?.name, 'App 1');
  assert.equal((await loadApps(source, fetcher))[0]?.name, 'App 2');
});

test('rejects missing files, malformed JSON, and failed network requests', async () => {
  await assert.rejects(loadApps(source, async () => new Response('Not found', { status: 404 })), /404/);
  await assert.rejects(loadApps(source, async () => new Response('{unfinished')));
  await assert.rejects(loadApps(source, async () => { throw new TypeError('Network unavailable'); }), /Network unavailable/);
});

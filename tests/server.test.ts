import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDashboardServer, readConfig } from '../server/server.ts';

test('runtime defaults use a fixed port separate from Vite and resolve paths from the app root', () => {
  assert.deepEqual(readConfig({}, '/example/dashboard'), {
    host: '127.0.0.1', port: 4310,
    buildDir: '/example/dashboard/dist', dataDir: '/example/dashboard/public',
  });
  assert.deepEqual(readConfig({
    BIFROST_HOST: '0.0.0.0', BIFROST_PORT: '9123',
    BIFROST_BUILD_DIR: '/example/build', BIFROST_DATA_DIR: '/example/data',
  }, '/example/dashboard'), {
    host: '0.0.0.0', port: 9123,
    buildDir: '/example/build', dataDir: '/example/data',
  });
  for (const port of ['0', '-1', '65536', '4310abc', '1.5', '']) {
    assert.throws(() => readConfig({ BIFROST_PORT: port }, '/example/dashboard'), /port/i);
  }
});

test('built files and live data are served independently without restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bifrost-server-'));
  const buildDir = join(root, 'build');
  const dataDir = join(root, 'live data');
  await mkdir(join(buildDir, 'assets'), { recursive: true });
  await mkdir(join(buildDir, 'icons'));
  await mkdir(join(dataDir, 'icons'), { recursive: true });
  await writeFile(join(buildDir, 'index.html'), '<h1>Built dashboard</h1>');
  await writeFile(join(buildDir, 'assets', 'app.js'), 'console.log("built asset");');
  await writeFile(join(buildDir, 'apps.json'), '{"apps":[{"name":"Bundled sample"}]}');
  await writeFile(join(buildDir, 'icons', 'sample.svg'), '<svg/>');
  await writeFile(join(dataDir, 'apps.json'), '{"apps":[]}');
  await writeFile(join(dataDir, 'icons', 'home.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(join(dataDir, 'private.txt'), 'not a public route');
  await writeFile(join(root, 'private.txt'), 'outside the web root');

  const server = createDashboardServer({ buildDir, dataDir });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;

  await t.test('serves built HTML and assets with revalidation behind any proxy Host', async () => {
    const response = await fetch(url, { headers: { Host: 'dashboard.example.test' } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control') ?? '', /no-cache/);
    assert.equal(await response.text(), '<h1>Built dashboard</h1>');
    assert.equal(await (await fetch(`${url}/assets/app.js`)).text(), 'console.log("built asset");');
    const head = await fetch(url, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  });

  await t.test('serves the persistent catalog, not the build snapshot', async () => {
    const response = await fetch(`${url}/apps.json`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    assert.match(response.headers.get('cache-control') ?? '', /no-cache/);
    assert.deepEqual(await response.json(), { apps: [] });
    const next = '{"apps":[{"name":"New app","url":"https://new.example.test"}]}';
    await writeFile(join(dataDir, 'apps.next.json'), next);
    await rename(join(dataDir, 'apps.next.json'), join(dataDir, 'apps.json'));
    assert.equal(await (await fetch(`${url}/apps.json`)).text(), next);
    await writeFile(join(dataDir, 'icons', 'new.svg'), '<svg/>');
    assert.equal((await fetch(`${url}/icons/new.svg`)).status, 200);
  });

  await t.test('missing live files return 404 even when bundled samples exist', async () => {
    assert.equal((await fetch(`${url}/icons/home.svg`)).status, 200);
    assert.equal((await fetch(`${url}/icons/sample.svg`)).status, 404);
    assert.equal((await fetch(`${url}/missing-page`)).status, 404);
    await rm(join(dataDir, 'apps.json'));
    assert.equal((await fetch(`${url}/apps.json`)).status, 404);
  });

  await t.test('does not expose other data files, dotfiles, or parent directories', async () => {
    await writeFile(join(buildDir, '.secret'), 'hidden');
    for (const path of ['/private.txt', '/.secret', '/icons/%2e%2e%2fprivate.txt', '/%2e%2e%2fprivate.txt']) {
      const response = await fetch(url + path);
      assert.ok([400, 403, 404].includes(response.status), `${path}: ${response.status}`);
      assert.doesNotMatch(await response.text(), /not a public route|outside the web root|hidden/);
    }
  });
});

test('startup fails clearly when the build is missing', () => {
  assert.throws(() => createDashboardServer({ buildDir: '/example/missing-build', dataDir: '/example/data' }), /build/i);
});

test('an occupied port fails instead of silently selecting another', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bifrost-port-'));
  await writeFile(join(root, 'index.html'), '<h1>App</h1>');
  const first = createDashboardServer({ buildDir: root, dataDir: root });
  const second = createDashboardServer({ buildDir: root, dataDir: root });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => first.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  first.listen(0, '127.0.0.1');
  await once(first, 'listening');
  const address = first.address();
  assert.ok(address && typeof address !== 'string');
  const failure = once(second, 'error');
  second.listen(address.port, '127.0.0.1');
  const [error] = await failure;
  assert.equal((error as NodeJS.ErrnoException).code, 'EADDRINUSE');
});

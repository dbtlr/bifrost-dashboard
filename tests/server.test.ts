import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { createDashboardServer, readConfig } from '../server/server.ts';

const appRoot = fileURLToPath(new URL('../', import.meta.url));

async function devFixture(t: TestContext, { relativeDataDir = false, directory = 'data' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bifrost-vite-'));
  let server: Awaited<ReturnType<typeof createViteServer>> | undefined;
  t.after(async () => {
    await server?.close();
    await rm(root, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });
  const dataDir = relativeDataDir ? await mkdtemp(join(appRoot, '.bifrost-vite-state-')) : join(root, directory);
  await mkdir(dataDir, { recursive: true });
  await mkdir(join(root, 'sample'));
  await writeFile(join(root, 'index.html'), '<h1>Development</h1>');
  await writeFile(join(root, 'sample', 'apps.json'), '{"apps":[]}');
  await writeFile(join(dataDir, 'apps.json'), '{"apps":[{"name":"Dev app","url":"https://dev.test"}]}');
  const previous = process.env.BIFROST_DATA_DIR;
  process.env.BIFROST_DATA_DIR = relativeDataDir ? relative(appRoot, dataDir) : dataDir;
  try {
    server = await createViteServer({
      configFile: join(appRoot, 'vite.config.ts'), root,
      logLevel: 'silent',
      server: { host: '127.0.0.1', port: 0, hmr: false },
    });
  } finally {
    if (previous === undefined) delete process.env.BIFROST_DATA_DIR;
    else process.env.BIFROST_DATA_DIR = previous;
  }
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== 'string');
  return { root, dataDir, base: `http://127.0.0.1:${address.port}` };
}

test('Vite dev serves the API but denies database, legacy data, and sample files', async t => {
  const { base } = await devFixture(t);
  for (const path of ['/data/bifrost.sqlite', '/data/apps.json', '/sample/apps.json']) {
    const response = await fetch(base + path);
    assert.ok([403, 404].includes(response.status), `${path}: ${response.status}`);
  }
  const response = await fetch(base + '/api/catalog');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ungrouped[0].name, 'Dev app');
});

test('Vite and production resolve relative data directories from the application root', async t => {
  const { base, dataDir } = await devFixture(t, { relativeDataDir: true });
  const env = { BIFROST_DATA_DIR: relative(appRoot, dataDir) };
  assert.equal(readConfig(env, appRoot).dataDir, dataDir);
  const response = await fetch(base + '/api/catalog');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ungrouped[0]?.name, 'Dev app');
});

test('Vite denies custom data directories through root and filesystem URLs', async t => {
  const { base, dataDir } = await devFixture(t, { directory: 'private state' });
  for (const path of [
    '/private%20state/apps.json', '/private%20state/bifrost.sqlite',
    `/@fs${dataDir}/apps.json`, `/@fs${dataDir}/bifrost.sqlite`,
  ]) {
    const response = await fetch(base + path);
    assert.ok([403, 404].includes(response.status), `${path}: ${response.status}`);
    await response.arrayBuffer();
  }
  assert.equal((await fetch(base + '/api/catalog')).status, 200);
});

test('runtime defaults use a fixed port separate from Vite and resolve paths from the app root', () => {
  assert.deepEqual(readConfig({}, '/example/dashboard'), {
    host: '127.0.0.1', port: 4310,
    buildDir: '/example/dashboard/dist', dataDir: '/example/dashboard/data',
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

  await t.test('serves the API catalog and treats apps.json as an ordinary build path', async () => {
    const response = await fetch(`${url}/api/catalog`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    assert.deepEqual(await response.json(), { groups: [], ungrouped: [] });
    await writeFile(join(dataDir, 'apps.json'), '{"apps":[{"name":"Ignored later","url":"https://ignored.test"}]}');
    assert.deepEqual(await (await fetch(`${url}/api/catalog`)).json(), { groups: [], ungrouped: [] });
    assert.deepEqual(await (await fetch(`${url}/apps.json`)).json(), { apps: [{ name: 'Bundled sample' }] });
    await rm(join(buildDir, 'apps.json'));
    assert.equal((await fetch(`${url}/apps.json`)).status, 404);
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

  await t.test('API path errors remain JSON, including rejected traversal paths', async () => {
    for (const [path, status] of [
      ['/api/missing', 404], ['/api/%ZZ', 400], ['/api/%2e%2e%2fprivate.txt', 400],
    ] satisfies [string, number][]) {
      const response = await fetch(url + path);
      assert.equal(response.status, status);
      assert.equal(response.headers.get('cache-control'), 'no-cache');
      assert.equal(typeof (await response.json()).error, 'string');
    }
  });

  await t.test('does not expose other data files, dotfiles, or parent directories', async () => {
    await writeFile(join(buildDir, '.secret'), 'hidden');
    await writeFile(join(dataDir, 'icons', '.secret'), 'hidden');
    for (const path of ['/private.txt', '/bifrost.sqlite', '/icons/.secret', '/.secret', '/icons/%2e%2e%2fprivate.txt', '/%2e%2e%2fprivate.txt']) {
      const response = await fetch(url + path);
      assert.ok([400, 403, 404].includes(response.status), `${path}: ${response.status}`);
      assert.doesNotMatch(await response.text(), /not a public route|outside the web root|hidden/);
    }
  });
});

test('startup fails clearly when the build is missing', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bifrost-missing-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.throws(() => createDashboardServer({ buildDir: join(root, 'missing-build'), dataDir: join(root, 'data') }), /build/i);
});

test('startup reports the legacy file and invalid app before exiting', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bifrost-startup-import-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  await mkdir(dataDir);
  await writeFile(join(root, 'index.html'), '<h1>Built dashboard</h1>');
  await writeFile(join(dataDir, 'apps.json'), '{"apps":[{"name":"","url":"https://app.test"}]}');
  const result = spawnSync(process.execPath, [join(appRoot, 'server', 'start.ts')], {
    env: { ...process.env, BIFROST_BUILD_DIR: root, BIFROST_DATA_DIR: dataDir }, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(`Cannot import ${join(dataDir, 'apps.json')}: app 1 name must be`), result.stderr);
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

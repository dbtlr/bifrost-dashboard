import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

// These tests run server/service.ts as a separate process against a fake system root (`--root`),
// whose systemctl and journalctl are shell stand-ins that record every call and keep state in files.

const appRoot = fileURLToPath(new URL('../', import.meta.url));
const MARKER = '# Managed by bifrost-dashboard server/service.ts';
const asRoot = process.geteuid?.() === 0;

// Like systemd, stop and disable answer "not loaded" (5) and "does not exist" (1) once the unit file is gone;
// `new-wording` switches disable to systemd 257's message, which drops "file".
const fakeSystemctl = (root: string) => `#!/bin/sh
S='${root}/state'
UNIT='${root}/etc/systemd/system/bifrost-dashboard.service'
echo "systemctl $*" >> '${root}/calls'
echo "PROBE=\${PROBE:-unset} PATH=$PATH" > '${root}/env'
if [ -e "${root}/fail/$1" ]; then cat "${root}/fail/$1" >&2; echo "$1 failed" >&2; exit 1; fi
if [ ! -e "$UNIT" ]; then
  case "$1" in
    stop) echo "Failed to stop $2: Unit $2 not loaded." >&2; exit 5 ;;
    disable) if [ -e "${root}/new-wording" ]; then echo "Failed to disable unit: Unit $2 does not exist" >&2; else echo "Failed to disable unit: Unit file $2 does not exist." >&2; fi; exit 1 ;;
  esac
fi
case "$1" in
  is-enabled) if [ -e "$S/enabled" ]; then echo enabled; exit 0; elif [ -e "$S/runtime" ]; then echo enabled-runtime; exit 0; else echo disabled; exit 1; fi ;;
  is-active) if [ -e "$S/active" ]; then echo active; exit 0; else echo inactive; exit 3; fi ;;
  enable) touch "$S/enabled" ;;
  disable) rm -f "$S/enabled" ;;
  stop) rm -f "$S/active" ;;
  restart) rm -f "$S/active"; [ -e "${root}/dies" ] || touch "$S/active" ;;
  status) echo "status $2"; if [ -e "$S/active" ]; then exit 0; else exit 3; fi ;;
esac
exit 0
`;

const fakeJournalctl = (root: string) => `#!/bin/sh
echo "journalctl $*" >> '${root}/calls'
if [ -e "${root}/fail/journalctl" ]; then echo "journal unavailable" >&2; exit 1; fi
echo "journal $*"
`;

interface FixtureOptions {
  env?: string;
  releaseAt?: string[];
}

async function fixture(t: TestContext, { env, releaseAt = ['release'] }: FixtureOptions = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'bifrost-service-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'root');
  const release = join(base, ...releaseAt);

  for (const dir of ['etc/systemd/system', 'etc/bifrost-dashboard', 'usr/bin', 'state', 'fail']) {
    await mkdir(join(root, dir), { recursive: true });
  }
  await writeFile(join(root, 'usr/bin/systemctl'), fakeSystemctl(root), { mode: 0o755 });
  await writeFile(join(root, 'usr/bin/journalctl'), fakeJournalctl(root), { mode: 0o755 });
  await writeFile(join(root, 'calls'), '');
  if (env !== undefined) await writeFile(join(root, 'etc/bifrost-dashboard/dashboard.env'), env);

  for (const dir of ['server', 'deploy', 'src', 'dist', 'node_modules']) await mkdir(join(release, dir), { recursive: true });
  await copyFile(join(appRoot, 'server/service.ts'), join(release, 'server/service.ts'));
  await copyFile(join(appRoot, 'deploy/bifrost-dashboard.service'), join(release, 'deploy/bifrost-dashboard.service'));
  await writeFile(join(release, 'package.json'), '{"name":"bifrost-dashboard","version":"9.8.7","type":"module"}\n');
  await writeFile(join(release, 'server/start.ts'), '');
  await writeFile(join(release, 'src/app-rules.ts'), '');
  await writeFile(join(release, 'dist/index.html'), '');

  const unitPath = join(root, 'etc/systemd/system/bifrost-dashboard.service');
  return {
    base, root, release, unitPath,
    run(...args: string[]) {
      const result = spawnSync(process.execPath, [join(release, 'server/service.ts'), '--root', root, ...args], { encoding: 'utf8', env: { ...process.env, PROBE: 'leaked' } });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    },
    async calls(): Promise<string[]> {
      return (await readFile(join(root, 'calls'), 'utf8')).split('\n').filter(Boolean);
    },
    async resetCalls() { await writeFile(join(root, 'calls'), ''); },
    async setState(state: { enabled?: boolean; active?: boolean; runtime?: boolean }) {
      for (const [name, on] of Object.entries(state)) {
        if (on) await writeFile(join(root, 'state', name), '');
        else await rm(join(root, 'state', name), { force: true });
      }
    },
    async state() {
      const names = await readdir(join(root, 'state'));
      return { enabled: names.includes('enabled'), active: names.includes('active') };
    },
    async fail(command: string, message = '') { await writeFile(join(root, 'fail', command), message); },
    async dies() { await writeFile(join(root, 'dies'), ''); },
    async writeEnv(text: string) { await writeFile(join(root, 'etc/bifrost-dashboard/dashboard.env'), text); },
    async unit(): Promise<string | null> { return readFile(unitPath, 'utf8').catch(() => null); },
  };
}

const node = await realpath(process.execPath);
const systemctlCalls = (calls: string[]) => calls.filter(call => call.startsWith('systemctl ')).map(call => call.slice('systemctl '.length));

test('unit renders the template from the release and the defaults', { skip: asRoot }, async t => {
  const f = await fixture(t);
  const result = f.run('unit');
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.split('\n');
  assert.equal(lines[0], MARKER);
  assert.ok(lines.includes(`WorkingDirectory=${f.release}`));
  assert.ok(lines.includes(`ExecStart=${node} ${f.release}/server/start.ts`));
  assert.ok(lines.includes('Environment=NODE_ENV=production'));
  assert.ok(lines.includes('Environment=BIFROST_HOST=127.0.0.1'));
  assert.ok(lines.includes('Environment=BIFROST_PORT=4310'));
  assert.ok(lines.includes('Environment=BIFROST_DATA_DIR=/var/lib/bifrost-dashboard'));
  assert.ok(lines.includes('StateDirectory=bifrost-dashboard'));
  assert.equal(lines.filter(line => line.startsWith('Environment=')).length, 4, 'the unit sets no other environment');
  assert.doesNotMatch(result.stdout, /@[A-Z_]+@/);
  assert.deepEqual(await f.calls(), [], 'unit runs no managers');
});

test('unit applies settings from dashboard.env, with quotes, comments, and a byte order mark', { skip: asRoot }, async t => {
  const f = await fixture(t, {
    env: '﻿# Dashboard\n\n  BIFROST_HOST=127.0.0.2  \nBIFROST_PORT="4400"\nBIFROST_DATA_DIR=\'/var/lib/bifrost-dashboard-test\'\n',
  });
  const result = f.run('unit');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Environment=BIFROST_HOST=127\.0\.0\.2$/m);
  assert.match(result.stdout, /^Environment=BIFROST_PORT=4400$/m);
  assert.match(result.stdout, /^Environment=BIFROST_DATA_DIR=\/var\/lib\/bifrost-dashboard-test$/m);
  assert.match(result.stdout, /^StateDirectory=bifrost-dashboard-test$/m);

  await f.writeEnv('BIFROST_HOST=::1\n');
  const ipv6 = f.run('unit');
  assert.equal(ipv6.status, 0, ipv6.stderr);
  assert.match(ipv6.stdout, /^Environment=BIFROST_HOST=::1$/m);
});

test('settings that break their rules fail and name the setting or line', { skip: asRoot }, async t => {
  const cases: [string, RegExp][] = [
    ['BIFROST_HOST=0.0.0.0', /BIFROST_HOST/],
    ['BIFROST_HOST=::1%lo', /BIFROST_HOST/],
    ['BIFROST_HOST=0127.0.0.1', /BIFROST_HOST/],
    ['BIFROST_HOST=127.0.0.01', /BIFROST_HOST/],
    ['BIFROST_HOST=127.0.0.256', /BIFROST_HOST/],
    ['BIFROST_HOST=localhost', /BIFROST_HOST/],
    ['BIFROST_PORT=80', /BIFROST_PORT/],
    ['BIFROST_PORT=70000', /BIFROST_PORT/],
    ['BIFROST_PORT=4310x', /BIFROST_PORT/],
    ['BIFROST_DATA_DIR=/var/lib/postgresql', /BIFROST_DATA_DIR/],
    ['BIFROST_DATA_DIR=/var/lib/bifrost-dashboard-', /BIFROST_DATA_DIR/],
    ['BIFROST_DATA_DIR=/var/lib/bifrost-dashboard/x', /BIFROST_DATA_DIR/],
    ['BIFROST_DATA_DIR=/srv/bifrost-dashboard-data', /BIFROST_DATA_DIR/],
    ['BIFROST_NODE_BIN=bin/node', /BIFROST_NODE_BIN/],
    ['BIFROST_NODE_BIN=/nonexistent/node', /BIFROST_NODE_BIN/],
    ['BIFROST_NODE_BIN=package.json', /BIFROST_NODE_BIN must be an absolute path/],
    ['BIFROST_NODE_BIN=/usr', /BIFROST_NODE_BIN/],
    ['BIFROST_DATA_DIR=/var/lib/bifrost-dashboard-a%n', /BIFROST_DATA_DIR/],
    ['BIFROST_DATA_DIR="/var/lib/bifrost-dashboard-a b"', /BIFROST_DATA_DIR/],
    ['BIFROST_PORT="4400\'', /BIFROST_PORT/],
    ['BIFROST_DATADIR=/var/lib/bifrost-dashboard', /BIFROST_DATADIR/],
    ['BIFROST_PORT=4400\nBIFROST_PORT=4401', /BIFROST_PORT/],
    ['export BIFROST_PORT=4400', /line 1/],
    ['bifrost_port=4400', /line 1/],
    ['BIFROST_PORT 4400', /line 1/],
  ];
  const f = await fixture(t);
  for (const [env, message] of cases) {
    await f.writeEnv(env);
    const result = f.run('unit');
    assert.equal(result.status, 1, `${env} should fail`);
    assert.match(result.stderr, /^bifrost-dashboard: /, env);
    assert.match(result.stderr, message, env);
    assert.equal(result.stdout, '', env);
  }
});

test('a Node.js path whose resolved form breaks the path rules is rejected', { skip: asRoot }, async t => {
  const f = await fixture(t);
  const hostile = join(f.base, 'x\nExecStartPre=+/bin/sh');
  await mkdir(hostile, { recursive: true });
  await copyFile(node, join(hostile, 'node'));
  await symlink(join(hostile, 'node'), join(f.base, 'node'));
  await f.writeEnv(`BIFROST_NODE_BIN=${join(f.base, 'node')}\n`);
  const result = f.run('unit');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /BIFROST_NODE_BIN/);
  assert.equal(result.stdout, '');
});

test('settings from earlier versions and unrelated keys only warn', { skip: asRoot }, async t => {
  const f = await fixture(t, { env: 'BIFROST_APP_DIR=/srv/bifrost-dashboard\nBIFROST_BUILD_DIR=/srv/x/dist\nOTHER_SETTING=1\n' });
  const result = f.run('unit');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /warning: .*BIFROST_APP_DIR/);
  assert.match(result.stderr, /warning: .*BIFROST_BUILD_DIR/);
  assert.match(result.stderr, /warning: .*OTHER_SETTING/);
  assert.match(result.stdout, /^WorkingDirectory=/m);
});

test('a configuration path that is not a regular file fails instead of using defaults', { skip: asRoot }, async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'etc/bifrost-dashboard/dashboard.env'));
  const result = f.run('unit');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /dashboard\.env/);
});

test('a configuration link whose target is missing fails instead of using defaults', { skip: asRoot }, async t => {
  const f = await fixture(t);
  await symlink(join(f.base, 'missing.env'), join(f.root, 'etc/bifrost-dashboard/dashboard.env'));
  const result = f.run('unit');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /dashboard\.env cannot be read/);
  assert.equal(result.stdout, '');
});

test('an incomplete release is refused and the missing file is named', { skip: asRoot }, async t => {
  const f = await fixture(t);
  await rm(join(f.release, 'dist/index.html'));
  const result = f.run('install');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /dist\/index\.html/);
  assert.equal(await f.unit(), null);
  assert.deepEqual(await f.calls(), []);
});

test('a release without node_modules is refused', { skip: asRoot }, async t => {
  const f = await fixture(t);
  await rm(join(f.release, 'node_modules'), { recursive: true });
  const result = f.run('unit');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /node_modules/);
});

test('a release path that would not stay literal in the unit is refused', { skip: asRoot }, async t => {
  const f = await fixture(t, { releaseAt: ['a release'] });
  const result = f.run('unit');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /release path/);
});

test('a template without the managed line or with an unknown placeholder is refused', { skip: asRoot }, async t => {
  const f = await fixture(t);
  const template = join(f.release, 'deploy/bifrost-dashboard.service');
  const original = await readFile(template, 'utf8');
  await writeFile(template, original.split('\n').slice(1).join('\n'));
  assert.match(f.run('unit').stderr, /managed line/);
  await writeFile(template, `${original}Environment=X=@UNKNOWN@\n`);
  assert.match(f.run('unit').stderr, /@UNKNOWN@/);
});

test('version fails when package.json has no version', { skip: asRoot }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.release, 'package.json'), '{"type":"module"}\n');
  assert.equal(f.run('version').status, 1);
});

test('a release that contains the data directory, or reaches it through a link, is refused', { skip: asRoot }, async t => {
  const contains = await fixture(t, { releaseAt: ['root', 'var'] });
  assert.match(contains.run('unit').stderr, /overlaps the data directory/);

  const linked = await fixture(t);
  await mkdir(join(linked.root, 'var/lib'), { recursive: true });
  await symlink(join(linked.release, 'data'), join(linked.root, 'var/lib/bifrost-dashboard'));
  const result = linked.run('unit');
  assert.equal(result.status, 1, 'a dangling link into the release still overlaps');
  assert.match(result.stderr, /overlaps the data directory/);
});

test('a link whose target climbs with .. is followed before the .. applies', { skip: asRoot }, async t => {
  const f = await fixture(t);
  await mkdir(join(f.release, 'nested'));
  await mkdir(join(f.root, 'var/lib'), { recursive: true });
  await symlink(join(f.release, 'nested'), join(f.root, 'var/lib/alias'));
  // Lexically alias/../data is /var/lib/data; through the link it is <release>/data.
  await symlink('alias/../data', join(f.root, 'var/lib/bifrost-dashboard'));
  const result = f.run('unit');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /overlaps the data directory/);
});

test('a missing component followed by .. still leads to the links after it, and / contains every release', { skip: asRoot }, async t => {
  const f = await fixture(t);
  await mkdir(join(f.release, 'nested'));
  await mkdir(join(f.root, 'var/lib'), { recursive: true });
  await symlink(join(f.release, 'nested'), join(f.root, 'var/lib/alias'));
  await symlink('missing/../alias/../data', join(f.root, 'var/lib/bifrost-dashboard'));
  assert.match(f.run('unit').stderr, /overlaps the data directory/);
  await rm(join(f.root, 'var/lib/bifrost-dashboard'));
  await symlink('missing/../alias/data', join(f.root, 'var/lib/bifrost-dashboard'));
  assert.match(f.run('unit').stderr, /overlaps the data directory/, 'links after the climb are followed too');

  const slash = await fixture(t);
  await mkdir(join(slash.root, 'var/lib'), { recursive: true });
  await symlink('/', join(slash.root, 'var/lib/bifrost-dashboard'));
  assert.match(slash.run('unit').stderr, /overlaps the data directory/);
});

test('a link loop at the data path fails instead of hanging', { skip: asRoot }, async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'var/lib'), { recursive: true });
  await symlink('bifrost-dashboard', join(f.root, 'var/lib/bifrost-dashboard'));
  const result = f.run('unit');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Too many symbolic links/);
});

test('a release beside the data directory with a similar name is accepted', { skip: asRoot }, async t => {
  const f = await fixture(t, { releaseAt: ['root', 'var/lib/bifrost-dashboard-other/r1'] });
  const result = f.run('unit');
  assert.equal(result.status, 0, result.stderr);
});

test('a release inside the data directory is refused', { skip: asRoot }, async t => {
  for (const at of [['root', 'var/lib/bifrost-dashboard/r1'], ['root', 'var/lib/private/bifrost-dashboard/r1']]) {
    const f = await fixture(t, { releaseAt: at });
    const result = f.run('unit');
    assert.equal(result.status, 1, at.join('/'));
    assert.match(result.stderr, /data directory/, at.join('/'));
  }
});

test('install on a fresh host writes the unit, enables, restarts, and checks the service', { skip: asRoot }, async t => {
  const f = await fixture(t);
  const result = f.run('install');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /bifrost-dashboard\.service is active/);
  assert.deepEqual(systemctlCalls(await f.calls()), [
    'is-enabled bifrost-dashboard.service',
    'is-active bifrost-dashboard.service',
    'daemon-reload',
    'enable bifrost-dashboard.service',
    'restart bifrost-dashboard.service',
    'is-active bifrost-dashboard.service',
  ]);
  const unit = await f.unit();
  assert.equal(unit, f.run('unit').stdout);
  assert.equal((await stat(f.unitPath)).mode & 0o777, 0o644);
  assert.deepEqual(await readdir(dirname(f.unitPath)), ['bifrost-dashboard.service'], 'no temporary files remain');
  assert.deepEqual(await f.state(), { enabled: true, active: true });
  assert.equal((await readFile(join(f.root, 'env'), 'utf8')).trim(), 'PROBE=unset PATH=/usr/sbin:/usr/bin:/sbin:/bin', 'managers get a minimal environment');
});

test('install sets the unit mode explicitly, whatever the umask', { skip: asRoot }, async t => {
  const f = await fixture(t);
  const result = spawnSync('/bin/sh', ['-c', 'umask 000; exec "$0" "$@"', process.execPath, join(f.release, 'server/service.ts'), '--root', f.root, 'install'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await stat(f.unitPath)).mode & 0o777, 0o644);
});

test('install refuses to replace an unmanaged unit unless forced', { skip: asRoot }, async t => {
  const f = await fixture(t);
  await writeFile(f.unitPath, '[Service]\nExecStart=/usr/bin/true\n');
  const refused = f.run('install');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /--force/);
  assert.equal(await f.unit(), '[Service]\nExecStart=/usr/bin/true\n');
  assert.deepEqual(await f.calls(), []);

  const forced = f.run('install', '--force');
  assert.equal(forced.status, 0, forced.stderr);
  assert.ok((await f.unit())?.startsWith(MARKER));
});

test('a unit with the managed line anywhere but first is unmanaged', { skip: asRoot }, async t => {
  const f = await fixture(t);
  await writeFile(f.unitPath, `[Service]\n${MARKER}\n`);
  assert.equal(f.run('install').status, 1);
  assert.equal(await f.unit(), `[Service]\n${MARKER}\n`);
});

test('a unit path that is a directory is refused', { skip: asRoot }, async t => {
  const f = await fixture(t);
  await mkdir(f.unitPath);
  const result = f.run('install', '--force');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not a regular file/);
});

test('install refuses a masked or symlinked unit even when forced', { skip: asRoot }, async t => {
  const f = await fixture(t);
  await symlink('/dev/null', f.unitPath);
  const result = f.run('install', '--force');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /symbolic link/);
  assert.ok((await lstat(f.unitPath)).isSymbolicLink());
  assert.deepEqual(await f.calls(), []);
});

test('a failed install over a running service restores its unit and restarts it', { skip: asRoot }, async t => {
  const f = await fixture(t);
  const previous = `${MARKER}\n[Service]\nWorkingDirectory=/srv/previous\n`;
  await writeFile(f.unitPath, previous);
  await f.setState({ enabled: true, active: true });
  await f.dies();
  const result = f.run('install');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not active/);
  assert.match(result.stderr, /restored/);
  assert.equal(await f.unit(), previous);
  const calls = systemctlCalls(await f.calls());
  assert.deepEqual(calls.slice(-2), ['daemon-reload', 'restart bifrost-dashboard.service']);
  assert.equal(calls.at(-1), 'restart bifrost-dashboard.service', 'recovery ends by restarting the previous service');
  assert.ok(!calls.includes('stop bifrost-dashboard.service'), 'a service that was active is not stopped');
  assert.ok(!calls.includes('disable bifrost-dashboard.service'), 'a service that was enabled stays enabled');
});

test('a failed first install stops and disables the service before removing its unit', { skip: asRoot }, async t => {
  const f = await fixture(t);
  await f.dies();
  const result = f.run('install');
  assert.equal(result.status, 1);
  assert.equal(await f.unit(), null);
  assert.deepEqual(await f.state(), { enabled: false, active: false });
  const calls = systemctlCalls(await f.calls());
  const recovery = calls.slice(calls.lastIndexOf('is-active bifrost-dashboard.service') + 1);
  assert.deepEqual(recovery, ['stop bifrost-dashboard.service', 'disable bifrost-dashboard.service', 'daemon-reload']);
});

test('a failure to flush the unit directory after the rename runs recovery', { skip: asRoot }, async t => {
  const f = await fixture(t);
  const previous = `${MARKER}\n[Service]\nWorkingDirectory=/srv/previous\n`;
  await writeFile(f.unitPath, previous);
  await f.setState({ enabled: true, active: true });
  // Write and search permission without read: files can be renamed in, but the directory cannot be opened to flush it.
  await chmod(dirname(f.unitPath), 0o300);
  const result = f.run('install');
  await chmod(dirname(f.unitPath), 0o755);
  assert.equal(result.status, 4, 'the restore cannot be flushed either, so the state is not confirmed');
  assert.match(result.stderr, /Recovery failed/);
  assert.equal(await f.unit(), previous, 'the previous unit is back in place');
});

test('a service enabled only for this boot counts as not enabled and is disabled again', { skip: asRoot }, async t => {
  const f = await fixture(t);
  await f.setState({ runtime: true });
  await f.dies();
  assert.equal(f.run('install').status, 1);
  assert.ok(systemctlCalls(await f.calls()).includes('disable bifrost-dashboard.service'));
});

test('install reports status 4 when recovery also fails', { skip: asRoot }, async t => {
  const f = await fixture(t);
  await f.dies();
  await f.fail('stop');
  const result = f.run('install');
  assert.equal(result.status, 4);
  assert.match(result.stderr, /Recovery failed/);
  assert.match(result.stderr, /Recovery steps completed: none\./);
});

test('a failed recovery names the recovery steps that completed', { skip: asRoot }, async t => {
  const f = await fixture(t);
  await f.dies();
  await f.fail('disable');
  const result = f.run('install');
  assert.equal(result.status, 4);
  assert.match(result.stderr, /Recovery steps completed: stop\./);
});

test('a failure while writing the unit changes nothing', { skip: asRoot }, async t => {
  const f = await fixture(t);
  await chmod(dirname(f.unitPath), 0o555);
  const result = f.run('install');
  await chmod(dirname(f.unitPath), 0o755);
  assert.equal(result.status, 1);
  assert.deepEqual(systemctlCalls(await f.calls()), ['is-enabled bifrost-dashboard.service', 'is-active bifrost-dashboard.service']);
});

test('restart rewrites the unit from the current configuration without enabling the service', { skip: asRoot }, async t => {
  const f = await fixture(t);
  assert.equal(f.run('install').status, 0);
  await f.setState({ enabled: false });
  await f.writeEnv('BIFROST_PORT=4400\n');
  await f.resetCalls();
  const result = f.run('restart');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /is active/);
  assert.match(await f.unit() ?? '', /^Environment=BIFROST_PORT=4400$/m);
  const calls = systemctlCalls(await f.calls());
  assert.ok(!calls.some(call => call.startsWith('enable')), 'restart does not enable');
  assert.ok(calls.includes('restart bifrost-dashboard.service'));
  assert.deepEqual(await f.state(), { enabled: false, active: true });
});

test('restart refuses a unit installed from another release', { skip: asRoot }, async t => {
  const f = await fixture(t);
  const other = `${MARKER}\n[Service]\nWorkingDirectory=/srv/other-release\n`;
  await writeFile(f.unitPath, other);
  const result = f.run('restart');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\/srv\/other-release/);
  assert.match(result.stderr, /install/);
  assert.equal(await f.unit(), other);
  assert.deepEqual(await f.calls(), []);
});

test('restart requires a unit these commands installed', { skip: asRoot }, async t => {
  const f = await fixture(t);
  assert.equal(f.run('restart').status, 1, 'no unit');
  await writeFile(f.unitPath, `[Service]\nWorkingDirectory=${f.release}\n`);
  assert.equal(f.run('restart').status, 1, 'unmanaged unit');
  await writeFile(f.unitPath, `${MARKER}\n[Service]\nWorkingDirectory=${f.release}\nWorkingDirectory=${f.release}\n`);
  assert.equal(f.run('restart').status, 1, 'two WorkingDirectory lines');
  assert.deepEqual(await f.calls(), []);
});

test('install refuses an empty data directory while data from earlier versions is waiting', { skip: asRoot }, async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'srv/bifrost-dashboard-data'), { recursive: true });
  const refused = f.run('install');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /\/srv\/bifrost-dashboard-data/);
  assert.equal(await f.unit(), null);

  await mkdir(join(f.root, 'var/lib/bifrost-dashboard'), { recursive: true });
  await writeFile(join(f.root, 'var/lib/bifrost-dashboard/apps.json'), '{"apps":[]}');
  assert.equal(f.run('install').status, 0, 'a copied legacy catalog is accepted');
  await rm(join(f.root, 'var/lib/bifrost-dashboard/apps.json'));
  assert.match(f.run('restart').stderr, /\/srv\/bifrost-dashboard-data/, 'restart applies the same guard');
  await writeFile(join(f.root, 'var/lib/bifrost-dashboard/bifrost.sqlite'), '');
  assert.equal(f.run('restart').status, 0, 'a migrated database is accepted');
});

test('uninstall stops and disables the service, removes the unit, and can be run again', { skip: asRoot }, async t => {
  const f = await fixture(t);
  assert.equal(f.run('install').status, 0);
  await f.resetCalls();
  const result = f.run('uninstall');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(systemctlCalls(await f.calls()), ['stop bifrost-dashboard.service', 'disable bifrost-dashboard.service', 'daemon-reload']);
  assert.equal(await f.unit(), null);
  assert.deepEqual(await f.state(), { enabled: false, active: false });
  const again = f.run('uninstall');
  assert.equal(again.status, 0, again.stderr);
  await writeFile(join(f.root, 'new-wording'), '');
  const newer = f.run('uninstall');
  assert.equal(newer.status, 0, `systemd 257 wording also counts as done: ${newer.stderr}`);
});

test('a rerun of uninstall still fails on errors other than a unit systemd no longer knows', { skip: asRoot }, async t => {
  const f = await fixture(t);
  await f.fail('stop');
  const result = f.run('uninstall');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /stop failed/);

  const other = await fixture(t);
  await other.fail('disable', 'Failed to connect to bus: socket not found\n');
  const bus = other.run('uninstall');
  assert.equal(bus.status, 4, 'stop counted as done, then disable failed for another reason');
  assert.match(bus.stderr, /Failed to connect to bus/);

  const elsewhere = await fixture(t);
  await elsewhere.fail('disable', 'Unit other.service does not exist\n');
  assert.equal(elsewhere.run('uninstall').status, 4, 'a message about another unit does not count');
});

test('uninstall refuses an unmanaged unit unless forced', { skip: asRoot }, async t => {
  const f = await fixture(t);
  await writeFile(f.unitPath, '[Service]\n');
  assert.equal(f.run('uninstall').status, 1);
  assert.equal(await f.unit(), '[Service]\n');
  assert.equal(f.run('uninstall', '--force').status, 0);
  assert.equal(await f.unit(), null);
});

test('uninstall that stops partway reports status 4 and names the completed steps', { skip: asRoot }, async t => {
  const f = await fixture(t);
  assert.equal(f.run('install').status, 0);
  await f.fail('disable');
  const result = f.run('uninstall');
  assert.equal(result.status, 4);
  assert.match(result.stderr, /stop/);
  assert.ok(await f.unit(), 'the unit stays when disabling fails');
});

test('status passes through the systemctl exit code', { skip: asRoot }, async t => {
  const f = await fixture(t);
  const inactive = f.run('status');
  assert.equal(inactive.status, 3);
  assert.match(inactive.stdout, /status bifrost-dashboard\.service/);
  await f.setState({ active: true });
  assert.equal(f.run('status').status, 0);
});

test('logs passes the line count to journalctl and rejects counts out of range', { skip: asRoot }, async t => {
  const f = await fixture(t);
  const result = f.run('logs', '--lines', '20');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await f.calls(), ['journalctl -u bifrost-dashboard.service -n 20 --no-pager']);
  assert.match(result.stdout, /journal -u bifrost-dashboard\.service -n 20 --no-pager/);
  await f.resetCalls();
  assert.equal(f.run('logs').status, 0);
  assert.deepEqual(await f.calls(), ['journalctl -u bifrost-dashboard.service -n 50 --no-pager']);
  for (const lines of ['0', '10001', 'ten']) assert.equal(f.run('logs', '--lines', lines).status, 2, lines);
  await f.fail('journalctl');
  const failed = f.run('logs');
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /journalctl failed/);
});

test('version prints the release version', { skip: asRoot }, async t => {
  const f = await fixture(t);
  const result = f.run('version');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '9.8.7\n');
});

test('usage errors exit with status 2', { skip: asRoot }, async t => {
  const f = await fixture(t);
  for (const args of [[], ['deploy'], ['status', '--force'], ['status', '--lines', '5'], ['install', 'extra'], ['logs', '--lines']]) {
    const result = f.run(...args);
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, /^bifrost-dashboard: /, args.join(' '));
  }
  assert.deepEqual(await f.calls(), []);
});

test('commands that change the service require root without --root', { skip: asRoot }, async t => {
  const f = await fixture(t);
  for (const command of ['install', 'restart', 'uninstall', 'logs']) {
    const result = spawnSync(process.execPath, [join(f.release, 'server/service.ts'), command], { encoding: 'utf8' });
    assert.equal(result.status, 1, command);
    assert.match(result.stderr, /root/, command);
  }
});

test('--root refuses a directory that resolves to the real root', { skip: asRoot }, async t => {
  const f = await fixture(t);
  await symlink('/', join(f.base, 'slash'));
  for (const dir of ['/', '/tmp/..', join(f.base, 'slash')]) {
    const result = spawnSync(process.execPath, [join(f.release, 'server/service.ts'), '--root', dir, 'status'], { encoding: 'utf8' });
    assert.equal(result.status, 1, dir);
    assert.match(result.stderr, /--root/, dir);
  }
});

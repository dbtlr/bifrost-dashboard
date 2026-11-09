// Installs and controls the dashboard as a systemd service. The contract is docs/service.md.
// It imports nothing from the rest of the release, so it runs before any check of that release.
import { spawnSync } from 'node:child_process';
import type { StdioOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, fchmodSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVICE = 'bifrost-dashboard.service';
const MARKER = '# Managed by bifrost-dashboard server/service.ts';
const LEGACY_DATA_DIR = '/srv/bifrost-dashboard-data';
const HIDDEN = ['/home', '/root', '/run/user', '/tmp', '/var/tmp'];
const MANAGER_TIMEOUT_MS = 30_000;
const REQUIRED_FILES = ['package.json', 'deploy/bifrost-dashboard.service', 'server/start.ts', 'src/app-rules.ts', 'dist/index.html'];

// Status 1: nothing changed or restored. 2: usage. 4: changed and not restored (docs/service.md, Exit status).
class Failure extends Error {
  readonly status: 1 | 2 | 4;

  constructor(message: string, status: 1 | 2 | 4 = 1) {
    super(message);
    this.status = status;
  }
}

const usage = (message: string) => new Failure(`${message} Usage: service.ts [--root DIR] install|restart|status|logs|version|unit|uninstall`, 2);

interface Options {
  command: string;
  root: string | null;
  force: boolean;
  lines: number;
}

const COMMANDS = new Set(['install', 'restart', 'status', 'logs', 'version', 'unit', 'uninstall']);
const NEEDS_ROOT = new Set(['install', 'restart', 'logs', 'uninstall']);

export function parseArgs(args: string[]): Options {
  const options: Options = { command: '', root: null, force: false, lines: 50 };
  let sawLines = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--root' || arg === '--lines') {
      const value = args[++index];
      if (value === undefined) throw usage(`${arg} needs a value.`);
      if (arg === '--root') options.root = value;
      else {
        if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 10_000) throw usage('--lines must be a whole number from 1 to 10000.');
        options.lines = Number(value);
        sawLines = true;
      }
    } else if (arg === '--force') options.force = true;
    else if (arg.startsWith('-')) throw usage(`Unknown option ${arg}.`);
    else if (options.command) throw usage(`Unexpected argument ${arg}.`);
    else options.command = arg;
  }
  if (!COMMANDS.has(options.command)) throw usage(options.command ? `Unknown command ${options.command}.` : 'No command given.');
  if (options.force && options.command !== 'install' && options.command !== 'uninstall') throw usage('--force applies only to install and uninstall.');
  if (sawLines && options.command !== 'logs') throw usage('--lines applies only to logs.');
  return options;
}

// --- Paths ---------------------------------------------------------------------------------------

const SAFE_PATH = /^(\/[A-Za-z0-9_.-]+)+$/;

// Absolute, made of literal characters only, and free of `.` and `..` segments, so it stays literal in a unit.
function isSafePath(path: string): boolean {
  return SAFE_PATH.test(path) && !path.split('/').some(part => part === '.' || part === '..');
}

const isInside = (path: string, parent: string): boolean => path === parent || path.startsWith(`${parent}/`);

// Resolves symbolic links in the part of the path that exists, so a path that does not exist yet still compares.
function resolveExisting(path: string): string {
  const missing: string[] = [];
  let current = path;
  while (!existsSync(current)) {
    missing.unshift(current.slice(current.lastIndexOf('/') + 1));
    current = dirname(current);
  }
  return join(realpathSync(current), ...missing);
}

// --- Configuration -------------------------------------------------------------------------------

interface Config {
  host: string;
  port: number;
  dataDir: string;
  stateName: string;
  node: string;
}

const SETTINGS = new Set(['BIFROST_HOST', 'BIFROST_PORT', 'BIFROST_DATA_DIR', 'BIFROST_NODE_BIN']);
const LEGACY_SETTINGS = new Set(['BIFROST_APP_DIR', 'BIFROST_BUILD_DIR']);

export function parseEnv(text: string, warn: (message: string) => void): Map<string, string> {
  const settings = new Map<string, string>();
  const seen = new Set<string>();
  text.replace(/^﻿/, '').split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Failure(`dashboard.env line ${index + 1} is not KEY=value.`);
    const key = match[1]!;
    const rawValue = match[2]!;
    if (seen.has(key)) throw new Failure(`dashboard.env sets ${key} more than once.`);
    seen.add(key);
    const quoted = rawValue.length >= 2 && rawValue[0] === rawValue.at(-1) && (rawValue[0] === '"' || rawValue[0] === "'");
    if (SETTINGS.has(key)) settings.set(key, quoted ? rawValue.slice(1, -1) : rawValue);
    else if (LEGACY_SETTINGS.has(key)) warn(`${key} in dashboard.env is ignored; the release determines it.`);
    else if (key.startsWith('BIFROST_')) throw new Failure(`dashboard.env sets unknown setting ${key}.`);
    else warn(`${key} in dashboard.env is ignored.`);
  });
  return settings;
}

const OCTET = '(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])';
const LOOPBACK_V4 = new RegExp(`^127(\\.${OCTET}){3}$`);

export function validateConfig(settings: Map<string, string>, defaultNode: string): Config {
  const host = settings.get('BIFROST_HOST') ?? '127.0.0.1';
  if (host !== '::1' && !LOOPBACK_V4.test(host)) {
    throw new Failure(`BIFROST_HOST must be ::1 or a 127.x.x.x address without leading zeros, not ${JSON.stringify(host)}.`);
  }
  const rawPort = settings.get('BIFROST_PORT') ?? '4310';
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || port < 1024 || port > 65535) throw new Failure(`BIFROST_PORT must be an integer from 1024 to 65535, not ${JSON.stringify(rawPort)}.`);
  const dataDir = settings.get('BIFROST_DATA_DIR') ?? '/var/lib/bifrost-dashboard';
  if (!/^\/var\/lib\/bifrost-dashboard(-[A-Za-z0-9_.-]+)?$/.test(dataDir)) {
    throw new Failure(`BIFROST_DATA_DIR must be /var/lib/bifrost-dashboard or /var/lib/bifrost-dashboard-NAME, not ${JSON.stringify(dataDir)}.`);
  }
  const configuredNode = settings.get('BIFROST_NODE_BIN') ?? defaultNode;
  if (!configuredNode.startsWith('/')) throw new Failure(`BIFROST_NODE_BIN must be an absolute path, not ${JSON.stringify(configuredNode)}.`);
  let node: string;
  try {
    node = realpathSync(configuredNode);
    if (!statSync(node).isFile()) throw new Error('not a file');
  } catch {
    throw new Failure(`BIFROST_NODE_BIN ${JSON.stringify(configuredNode)} is not an existing file.`);
  }
  if (!isSafePath(node)) throw new Failure(`BIFROST_NODE_BIN resolves to ${JSON.stringify(node)}, which may contain only letters, digits, _, ., /, and -.`);
  return { host, port, dataDir, stateName: dataDir.slice('/var/lib/'.length), node };
}

// --- The system ----------------------------------------------------------------------------------

interface ManagerResult {
  status: number;
  stdout: string;
  stderr: string;
}

// Every system path goes through `path`, so `--root` redirects all of them.
class System {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  path(absolute: string): string {
    return this.root === '/' ? absolute : join(this.root, absolute);
  }

  // Managers run by absolute path with an argument list, no shell, and a minimal environment.
  manager(program: 'systemctl' | 'journalctl', args: string[], { allowed = [0], inherit = false }: { allowed?: number[] | 'any'; inherit?: boolean } = {}): ManagerResult {
    const stdio: StdioOptions = inherit ? ['ignore', 'inherit', 'inherit'] : 'pipe';
    const result = spawnSync(this.path(`/usr/bin/${program}`), args, {
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' },
      encoding: 'utf8', stdio, timeout: MANAGER_TIMEOUT_MS,
    });
    const name = `${program} ${args[0]}`;
    if (result.error) {
      const timedOut = (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
      throw new Failure(timedOut ? `${name} did not finish within 30 seconds.` : `${name} could not run: ${result.error.message}`);
    }
    const status = result.status ?? 1;
    if (allowed !== 'any' && !allowed.includes(status)) {
      throw new Failure(`${name} failed${result.stderr?.trim() ? `: ${result.stderr.trim()}` : ` with status ${status}.`}`);
    }
    return { status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  systemctl(...args: string[]): ManagerResult {
    return this.manager('systemctl', args);
  }
}

// --- The unit ------------------------------------------------------------------------------------

interface InstalledUnit {
  text: string;
  managed: boolean;
}

function readInstalledUnit(path: string): InstalledUnit | null {
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (info.isSymbolicLink()) throw new Failure(`${path} is a symbolic link, possibly a masked unit. Unmask or remove it first.`);
  if (!info.isFile()) throw new Failure(`${path} is not a regular file.`);
  const text = readFileSync(path, 'utf8');
  return { text, managed: text.split('\n')[0] === MARKER };
}

// The release a managed unit runs, from its single WorkingDirectory line. Drop-ins are not consulted.
function installedRelease(unit: InstalledUnit): string {
  const lines = unit.text.split('\n').filter(line => line.startsWith('WorkingDirectory='));
  if (lines.length !== 1) throw new Failure(`The installed ${SERVICE} must have exactly one WorkingDirectory line.`);
  return lines[0]!.slice('WorkingDirectory='.length);
}

export function renderUnit(template: string, release: string, config: Config): string {
  const values: [string, string][] = [
    ['@RELEASE@', release], ['@NODE@', config.node], ['@HOST@', config.host], ['@PORT@', String(config.port)],
    ['@DATA_DIR@', config.dataDir], ['@STATE_DIRECTORY@', config.stateName],
  ];
  const text = values.reduce((unit, [placeholder, value]) => unit.split(placeholder).join(value), template);
  if (text.split('\n')[0] !== MARKER) throw new Failure('The release template deploy/bifrost-dashboard.service lacks the managed line.');
  const leftover = /@[A-Z_]+@/.exec(text);
  if (leftover) throw new Failure(`The release template has an unknown placeholder ${leftover[0]}.`);
  return text;
}

// Writes beside the unit under a name systemd ignores, sets the mode, flushes, then renames over it.
function writeAtomically(path: string, text: string): void {
  const temporary = join(dirname(path), `.bifrost-dashboard.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      writeSync(fd, text);
      fchmodSync(fd, 0o644);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  const directory = openSync(dirname(path), constants.O_RDONLY);
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

// --- Commands ------------------------------------------------------------------------------------

interface Context {
  options: Options;
  system: System;
  release: string;
  unitPath: string;
  warn(message: string): void;
  print(text: string): void;
}

function readConfiguration(context: Context): Config {
  const path = context.system.path('/etc/bifrost-dashboard/dashboard.env');
  let text = '';
  const info = statSync(path, { throwIfNoEntry: false });
  if (info) {
    if (!info.isFile()) throw new Failure(`${path} is not a regular file.`);
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      throw new Failure(`${path} cannot be read: ${(error as Error).message}`);
    }
  }
  return validateConfig(parseEnv(text, context.warn), process.execPath);
}

function checkRelease(context: Context, config: Config): void {
  const { release, system } = context;
  if (!isSafePath(release)) throw new Failure(`The release path ${JSON.stringify(release)} may contain only letters, digits, _, ., /, and -.`);
  for (const file of REQUIRED_FILES) {
    if (!statSync(join(release, file), { throwIfNoEntry: false })?.isFile()) throw new Failure(`The release ${release} lacks ${file}. Run npm ci and npm run build.`);
  }
  if (!statSync(join(release, 'node_modules'), { throwIfNoEntry: false })?.isDirectory()) throw new Failure(`The release ${release} lacks node_modules/. Run npm ci.`);
  if (context.options.root === null) {
    for (const [name, path] of [['The release', release], ['BIFROST_NODE_BIN', config.node]] as const) {
      const hidden = HIDDEN.find(directory => isInside(path, directory));
      if (hidden) throw new Failure(`${name} ${path} is under ${hidden}, which the service cannot see.`);
    }
  }
  for (const fixed of [`/var/lib/${config.stateName}`, `/var/lib/private/${config.stateName}`]) {
    const data = resolveExisting(system.path(fixed));
    if (isInside(release, data) || isInside(data, release)) throw new Failure(`The release ${release} overlaps the data directory ${fixed}.`);
  }
}

// Refuses to start on an empty catalog while data from an earlier version waits at the old location.
function checkLegacyData(context: Context, config: Config): void {
  const { system } = context;
  if (!existsSync(system.path(LEGACY_DATA_DIR))) return;
  const data = system.path(config.dataDir);
  if (existsSync(join(data, 'bifrost.sqlite')) || existsSync(join(data, 'apps.json'))) return;
  throw new Failure(`${LEGACY_DATA_DIR} exists but ${config.dataDir} has no bifrost.sqlite or apps.json. Move the data first; see docs/service.md.`);
}

function renderedUnit(context: Context, config: Config): string {
  checkRelease(context, config);
  return renderUnit(readFileSync(join(context.release, 'deploy/bifrost-dashboard.service'), 'utf8'), context.release, config);
}

// Shared by install and restart: write, reload, (enable), restart, check; on failure, restore.
function apply(context: Context, unit: string, previous: InstalledUnit | null, enable: boolean): void {
  const { system } = context;
  const wasEnabled = system.manager('systemctl', ['is-enabled', SERVICE], { allowed: 'any' }).stdout.trim() === 'enabled';
  const wasActive = system.manager('systemctl', ['is-active', SERVICE], { allowed: 'any' }).status === 0;
  writeAtomically(context.unitPath, unit);
  try {
    system.systemctl('daemon-reload');
    if (enable) system.systemctl('enable', SERVICE);
    system.systemctl('restart', SERVICE);
    if (system.manager('systemctl', ['is-active', SERVICE], { allowed: 'any' }).status !== 0) {
      throw new Failure(`${SERVICE} is not active after the restart.`);
    }
  } catch (error) {
    const reason = (error as Error).message;
    try {
      if (!wasActive) system.systemctl('stop', SERVICE);
      if (!wasEnabled) system.systemctl('disable', SERVICE);
      if (previous) writeAtomically(context.unitPath, previous.text);
      else rmSync(context.unitPath, { force: true });
      system.systemctl('daemon-reload');
      if (wasActive) system.systemctl('restart', SERVICE);
    } catch (recovery) {
      throw new Failure(`${reason} Recovery failed: ${(recovery as Error).message} Inspect ${SERVICE} before retrying.`, 4);
    }
    throw new Failure(`${reason} The previous unit and service state were restored.`);
  }
  context.print(`${SERVICE} is active\n`);
}

function install(context: Context): void {
  const config = readConfiguration(context);
  const unit = renderedUnit(context, config);
  checkLegacyData(context, config);
  const previous = readInstalledUnit(context.unitPath);
  if (previous && !previous.managed && !context.options.force) {
    throw new Failure(`${context.unitPath} was not written by these commands. Use install --force to replace it.`);
  }
  apply(context, unit, previous, true);
}

function restart(context: Context): void {
  const previous = readInstalledUnit(context.unitPath);
  if (!previous?.managed) throw new Failure(`${SERVICE} is not installed by these commands. Run install first.`);
  const installed = installedRelease(previous);
  if (installed !== context.release) {
    throw new Failure(`The installed ${SERVICE} runs the release ${installed}, not ${context.release}. Use install to switch releases.`);
  }
  const config = readConfiguration(context);
  const unit = renderedUnit(context, config);
  checkLegacyData(context, config);
  apply(context, unit, previous, false);
}

function uninstall(context: Context): void {
  const { system } = context;
  const installed = readInstalledUnit(context.unitPath);
  if (installed && !installed.managed && !context.options.force) {
    throw new Failure(`${context.unitPath} was not written by these commands. Use uninstall --force to remove it.`);
  }
  // Without a unit file, this finishes an earlier partial run: a unit systemd no longer knows counts as stopped.
  const allowed = installed ? [0] : 'any' as const;
  const done: string[] = [];
  const steps: [string, () => void][] = [
    ['stop', () => system.manager('systemctl', ['stop', SERVICE], { allowed })],
    ['disable', () => system.manager('systemctl', ['disable', SERVICE], { allowed })],
    ['remove the unit', () => rmSync(context.unitPath, { force: true })],
    ['daemon-reload', () => system.systemctl('daemon-reload')],
  ];
  for (const [name, step] of steps) {
    try {
      step();
    } catch (error) {
      if (done.length === 0) throw error;
      throw new Failure(`${(error as Error).message} Completed: ${done.join(', ')}. Run uninstall again after fixing the cause.`, 4);
    }
    done.push(name);
  }
  context.print(`${SERVICE} is uninstalled\n`);
}

function passThrough(context: Context, program: 'systemctl' | 'journalctl', args: string[]): number {
  return context.system.manager(program, args, { allowed: 'any', inherit: true }).status;
}

export function main(args: string[], scriptUrl: string): number {
  const warn = (message: string) => process.stderr.write(`bifrost-dashboard: warning: ${message}\n`);
  try {
    const options = parseArgs(args);
    let root = '/';
    if (options.root !== null) {
      if (process.geteuid?.() === 0) throw new Failure('--root is for tests and is refused when running as root.');
      try {
        root = realpathSync(options.root);
      } catch {
        throw new Failure(`--root ${options.root} does not exist.`);
      }
      if (root === '/') throw new Failure(`--root ${options.root} resolves to /, the real system.`);
    } else if (NEEDS_ROOT.has(options.command) && process.geteuid?.() !== 0) {
      throw new Failure(`${options.command} must be run as root.`);
    }
    const system = new System(root);
    const release = realpathSync(fileURLToPath(new URL('../', scriptUrl)));
    const context: Context = {
      options, system, release, warn,
      unitPath: system.path(`/etc/systemd/system/${SERVICE}`),
      print: text => process.stdout.write(text),
    };
    switch (options.command) {
      case 'install': install(context); return 0;
      case 'restart': restart(context); return 0;
      case 'uninstall': uninstall(context); return 0;
      case 'status': return passThrough(context, 'systemctl', ['status', SERVICE, '--no-pager']);
      case 'logs': {
        const status = passThrough(context, 'journalctl', ['-u', SERVICE, '-n', String(options.lines), '--no-pager']);
        if (status !== 0) throw new Failure(`journalctl failed with status ${status}.`);
        return 0;
      }
      case 'version': {
        const { version } = JSON.parse(readFileSync(join(release, 'package.json'), 'utf8')) as { version?: unknown };
        if (typeof version !== 'string') throw new Failure('package.json has no version.');
        context.print(`${version}\n`);
        return 0;
      }
      default: context.print(renderedUnit(context, readConfiguration(context))); return 0;
    }
  } catch (error) {
    const failure = error instanceof Failure ? error : new Failure((error as Error).message);
    process.stderr.write(`bifrost-dashboard: ${failure.message}\n`);
    return failure.status;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2), import.meta.url);
}

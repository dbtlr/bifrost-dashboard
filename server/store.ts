import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isRecord, requireAppUrl, requireName } from '../src/app-rules.ts';

export interface StoredApp {
  id: number;
  name: string;
  url: string;
  icon: string | null;
  groupId: number | null;
}

export interface Group {
  id: number;
  name: string;
  apps: StoredApp[];
}

export interface Catalog {
  groups: Group[];
  ungrouped: StoredApp[];
}

export interface AppInput {
  name: string;
  url: string;
  groupId: number | null;
}

export interface Layout {
  groups: { id: number; apps: number[] }[];
  ungrouped: number[];
}

export class StoreError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function appRow(row: Record<string, unknown>): StoredApp {
  const { id, name, url, icon, groupId } = row;
  if (typeof id !== 'number' || typeof name !== 'string' || typeof url !== 'string'
    || (icon !== null && typeof icon !== 'string') || (groupId !== null && typeof groupId !== 'number')) {
    throw new Error('Invalid app row in database.');
  }
  return { id, name, url, icon, groupId };
}

function localIcon(value: unknown, dataDir: string): string | null {
  if (typeof value !== 'string') return null;
  let filename: string;
  try {
    const url = new URL(value, 'http://legacy.invalid/apps.json');
    const match = /^\/icons\/+([^/]+)$/.exec(url.pathname);
    if (!match) return null;
    filename = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  if (filename.startsWith('.') || /[/\\\0]/.test(filename)) return null;
  const path = `icons/${filename}`;
  return statSync(join(dataDir, path), { throwIfNoEntry: false })?.isFile() ? path : null;
}

function legacyApps(dataDir: string) {
  const file = join(dataDir, 'apps.json');
  try {
    if (!statSync(file, { throwIfNoEntry: false })?.isFile()) return [];
    const value: unknown = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!isRecord(value) || !Array.isArray(value.apps)) throw new Error('The catalog must contain an apps array.');
    return value.apps.map((entry: unknown, index: number) => {
      try {
        if (!isRecord(entry)) throw new Error('must be an object.');
        return { name: requireName(entry.name), url: requireAppUrl(entry.url), icon: localIcon(entry.icon, dataDir) };
      } catch (error) {
        throw new Error(`app ${index + 1} ${error instanceof Error ? error.message : 'is invalid.'}`);
      }
    }).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) || a.url.localeCompare(b.url));
  } catch (error) {
    throw new Error(`Cannot import ${file}: ${error instanceof Error ? error.message : 'Invalid catalog.'}`);
  }
}

export function openStore(dataDir: string) {
  mkdirSync(join(dataDir, 'icons'), { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'bifrost.sqlite'));
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000');

  function transaction<T>(action: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  try {
    const version = db.prepare('PRAGMA user_version').get()?.user_version;
    if (version === 0) {
      transaction(() => {
        db.exec(`
          CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, position INTEGER NOT NULL);
          CREATE UNIQUE INDEX group_names ON groups(name COLLATE NOCASE);
          CREATE TABLE apps (
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, url TEXT NOT NULL, icon TEXT,
            group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL, position INTEGER NOT NULL
          );
          PRAGMA user_version = 1;
        `);
        const apps = legacyApps(dataDir);
        const insert = db.prepare('INSERT INTO apps (name, url, icon, group_id, position) VALUES (?, ?, ?, NULL, ?)');
        apps.forEach((app, index) => insert.run(app.name, app.url, app.icon, index));
      });
    } else if (version !== 1) {
      throw new Error(`Unsupported database schema version: ${version}`);
    }
  } catch (error) {
    db.close();
    throw error;
  }

  function catalog(): Catalog {
    const apps = db.prepare('SELECT id, name, url, icon, group_id AS groupId FROM apps ORDER BY position, id').all().map(appRow);
    const groups = db.prepare('SELECT id, name FROM groups ORDER BY position, id').all().map(row => {
      if (typeof row.id !== 'number' || typeof row.name !== 'string') throw new Error('Invalid group row in database.');
      return { id: row.id, name: row.name, apps: apps.filter(app => app.groupId === row.id) };
    });
    return { groups, ungrouped: apps.filter(app => app.groupId === null) };
  }

  function getApp(id: number): StoredApp {
    const row = db.prepare('SELECT id, name, url, icon, group_id AS groupId FROM apps WHERE id = ?').get(id);
    if (!row) throw new StoreError(404, 'App does not exist.');
    return appRow(row);
  }

  function deleteApp(id: number): void {
    const app = getApp(id);
    db.prepare('DELETE FROM apps WHERE id = ?').run(id);
    removeUnusedIcon(app.icon);
  }

  function removeUnusedIcon(icon: string | null): void {
    if (icon === null || db.prepare('SELECT id FROM apps WHERE icon = ? LIMIT 1').get(icon)) return;
    const path = localIcon(icon, dataDir);
    if (path !== null) rmSync(join(dataDir, path), { force: true });
  }

  function setIcon(id: number, icon: string | null): StoredApp {
    const app = getApp(id);
    db.prepare('UPDATE apps SET icon = ? WHERE id = ?').run(icon, id);
    removeUnusedIcon(app.icon);
    return getApp(id);
  }

  function getGroup(id: number): Group {
    const group = catalog().groups.find(group => group.id === id);
    if (!group) throw new StoreError(404, 'Group does not exist.');
    return group;
  }

  function nextPosition(groupId: number | null): number {
    const row = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM apps WHERE group_id IS ?').get(groupId);
    if (typeof row?.next !== 'number') throw new Error('Invalid app position in database.');
    return row.next;
  }

  function createApp(input: AppInput): StoredApp {
    const name = requireName(input.name);
    return transaction(() => {
      if (input.groupId !== null) getGroup(input.groupId);
      const result = db.prepare('INSERT INTO apps (name, url, group_id, position) VALUES (?, ?, ?, ?)')
        .run(name, input.url, input.groupId, nextPosition(input.groupId));
      return getApp(Number(result.lastInsertRowid));
    });
  }

  function updateApp(id: number, changes: Partial<AppInput>): StoredApp {
    return transaction(() => {
      const app = getApp(id);
      const name = changes.name === undefined ? app.name : requireName(changes.name);
      const url = changes.url ?? app.url;
      const groupId = changes.groupId === undefined ? app.groupId : changes.groupId;
      if (groupId !== null) getGroup(groupId);
      if (groupId !== app.groupId) {
        db.prepare('UPDATE apps SET group_id = ?, position = ? WHERE id = ?').run(groupId, nextPosition(groupId), id);
      }
      db.prepare('UPDATE apps SET name = ?, url = ? WHERE id = ?').run(name, url, id);
      return getApp(id);
    });
  }

  function uniqueGroupName(name: string, id?: number): string {
    const normalized = requireName(name, 60);
    const folded = (value: string) => value.normalize('NFKC').toUpperCase().toLowerCase();
    if (catalog().groups.some(group => group.id !== id && folded(group.name) === folded(normalized))) {
      throw new StoreError(409, 'A group with that name already exists.');
    }
    return normalized;
  }

  function createGroup(name: string): Group {
    return transaction(() => {
      const normalized = uniqueGroupName(name);
      const result = db.prepare('INSERT INTO groups (name, position) SELECT ?, COALESCE(MAX(position), -1) + 1 FROM groups').run(normalized);
      return getGroup(Number(result.lastInsertRowid));
    });
  }

  function updateGroup(id: number, name: string): Group {
    return transaction(() => {
      getGroup(id);
      db.prepare('UPDATE groups SET name = ? WHERE id = ?').run(uniqueGroupName(name, id), id);
      return getGroup(id);
    });
  }

  function deleteGroup(id: number): void {
    transaction(() => {
      const group = getGroup(id);
      const position = nextPosition(null);
      const move = db.prepare('UPDATE apps SET group_id = NULL, position = ? WHERE id = ?');
      group.apps.forEach((app, index) => move.run(position + index, app.id));
      db.prepare('DELETE FROM groups WHERE id = ?').run(id);
    });
  }

  function setLayout(layout: Layout): Catalog {
    return transaction(() => {
      const current = catalog();
      const groupIds = layout.groups.map(group => group.id);
      const appIds = [...layout.ungrouped, ...layout.groups.flatMap(group => group.apps)];
      const matches = (actual: number[], expected: number[]) => actual.length === expected.length
        && new Set(actual).size === actual.length && expected.every(id => actual.includes(id));
      if (!matches(groupIds, current.groups.map(group => group.id))
        || !matches(appIds, [...current.ungrouped, ...current.groups.flatMap(group => group.apps)].map(app => app.id))) {
        throw new StoreError(409, 'Layout must include every current group and app exactly once.');
      }
      const move = db.prepare('UPDATE apps SET group_id = ?, position = ? WHERE id = ?');
      layout.groups.forEach((group, index) => {
        db.prepare('UPDATE groups SET position = ? WHERE id = ?').run(index, group.id);
        group.apps.forEach((id, position) => move.run(group.id, position, id));
      });
      layout.ungrouped.forEach((id, position) => move.run(null, position, id));
      return catalog();
    });
  }

  return { catalog, getApp, setIcon, createApp, updateApp, deleteApp, createGroup, updateGroup, deleteGroup, setLayout, close: () => db.close() };
}

export type Store = ReturnType<typeof openStore>;

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { openStore } from '../server/store.ts';

test('imports legacy apps alphabetically once, retaining only existing local icons', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'bifrost-store-'));
  await mkdir(join(dataDir, 'icons'));
  await writeFile(join(dataDir, 'icons', 'home.svg'), '<svg/>');
  await writeFile(join(dataDir, 'apps.json'), JSON.stringify({ apps: [
    { name: 'Zulu', url: 'https://z.example.test', icon: '/icons/home.svg' },
    { name: 'alpha', url: 'https://a.example.test', icon: 'icons/home.svg' },
    { name: 'Missing', url: 'https://m.example.test', icon: 'icons/missing.svg' },
    { name: 'External', url: 'https://e.example.test', icon: 'https://other.test/icon.svg' },
    { name: 'Traversal', url: 'https://t.example.test', icon: 'icons/../apps.json' },
  ] }));
  let store = openStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const apps = store.catalog().ungrouped;
  assert.deepEqual(apps.map(app => app.name), ['alpha', 'External', 'Missing', 'Traversal', 'Zulu']);
  assert.deepEqual(apps.map(app => app.icon), ['icons/home.svg', null, null, null, 'icons/home.svg']);
  assert.equal(apps[0]?.url, 'https://a.example.test/');
  store.close();
  store = openStore(dataDir);
  assert.deepEqual(store.catalog().ungrouped, apps);
  for (const app of apps) store.deleteApp(app.id);
  store.close();
  store = openStore(dataDir);
  assert.deepEqual(store.catalog(), { groups: [], ungrouped: [] });
});

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'bifrost-store-'));
  const store = openStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  return store;
}

test('creates in insertion order, appends group moves, and preserves order when deleting a group', async t => {
  const store = await fixture(t);
  const media = store.createGroup(' Media ');
  const work = store.createGroup('Work');
  const zulu = store.createApp({ name: 'Zulu', url: 'https://z.test', groupId: null });
  const alpha = store.createApp({ name: 'Alpha', url: 'https://a.test', groupId: null });
  const one = store.createApp({ name: 'One', url: 'https://1.test', groupId: media.id });
  const two = store.createApp({ name: 'Two', url: 'https://2.test', groupId: media.id });
  assert.deepEqual(store.catalog().groups.map(group => group.name), ['Media', 'Work']);
  assert.deepEqual(store.catalog().ungrouped.map(app => app.id), [zulu.id, alpha.id]);
  store.updateApp(zulu.id, { groupId: media.id });
  store.updateApp(one.id, { name: 'First', groupId: media.id });
  assert.deepEqual(store.catalog().groups[0]?.apps.map(app => app.id), [one.id, two.id, zulu.id]);
  store.updateApp(two.id, { groupId: work.id });
  store.updateApp(two.id, { groupId: media.id });
  assert.deepEqual(store.catalog().groups[0]?.apps.map(app => app.id), [one.id, zulu.id, two.id]);
  store.deleteGroup(media.id);
  assert.deepEqual(store.catalog().ungrouped.map(app => [app.id, app.groupId]), [
    [alpha.id, null], [one.id, null], [zulu.id, null], [two.id, null],
  ]);
  assert.deepEqual(store.catalog().groups, [{ ...work, apps: [] }]);
});

test('group names conflict ignoring case on create and rename, including non-ASCII letters', async t => {
  const store = await fixture(t);
  const first = store.createGroup('Média');
  const other = store.createGroup('Other');
  assert.throws(() => store.createGroup(' MÉDIA '), { status: 409 });
  assert.throws(() => store.updateGroup(other.id, 'mÉdia'), { status: 409 });
  assert.equal(store.updateGroup(first.id, 'MÉDIA').name, 'MÉDIA');
});

test('layout reorders and moves every app atomically; missing, extra, or duplicate IDs change nothing', async t => {
  const store = await fixture(t);
  const a = store.createGroup('A');
  const b = store.createGroup('B');
  const x = store.createApp({ name: 'X', url: 'https://x.test', groupId: a.id });
  const y = store.createApp({ name: 'Y', url: 'https://y.test', groupId: null });
  const before = store.catalog();
  const invalid = [
    { groups: [{ id: a.id, apps: [x.id] }], ungrouped: [y.id] },
    { groups: [{ id: a.id, apps: [x.id] }, { id: b.id, apps: [] }, { id: 999, apps: [] }], ungrouped: [y.id] },
    { groups: [{ id: a.id, apps: [x.id] }, { id: a.id, apps: [] }, { id: b.id, apps: [] }], ungrouped: [y.id] },
    { groups: [{ id: a.id, apps: [] }, { id: b.id, apps: [] }], ungrouped: [y.id] },
    { groups: [{ id: a.id, apps: [x.id] }, { id: b.id, apps: [] }], ungrouped: [y.id, 999] },
    { groups: [{ id: a.id, apps: [x.id] }, { id: b.id, apps: [x.id] }], ungrouped: [y.id] },
  ];
  for (const layout of invalid) {
    assert.throws(() => store.setLayout(layout), { status: 409 });
    assert.deepEqual(store.catalog(), before);
  }
  const result = store.setLayout({ groups: [{ id: b.id, apps: [y.id, x.id] }, { id: a.id, apps: [] }], ungrouped: [] });
  assert.deepEqual(result.groups.map(group => group.id), [b.id, a.id]);
  assert.deepEqual(result.groups[0]?.apps.map(app => [app.id, app.groupId]), [[y.id, b.id], [x.id, b.id]]);
});


test('deleted IDs are not reassigned, so a stale layout cannot target replacement resources', async t => {
  const store = await fixture(t);
  const group = store.createGroup('Old');
  const app = store.createApp({ name: 'Old', url: 'https://old.test', groupId: null });
  store.deleteApp(app.id);
  store.deleteGroup(group.id);
  const replacementGroup = store.createGroup('New');
  const replacementApp = store.createApp({ name: 'New', url: 'https://new.test', groupId: null });
  assert.notEqual(replacementGroup.id, group.id);
  assert.notEqual(replacementApp.id, app.id);
  assert.throws(() => store.setLayout({ groups: [{ id: group.id, apps: [] }], ungrouped: [app.id] }), { status: 409 });
});

test('a database created without legacy data never imports a file added on a later start', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'bifrost-store-'));
  let store = openStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  store.close();
  await writeFile(join(dataDir, 'apps.json'), '{"apps":[{"name":"Later","url":"https://later.test"}]}');
  store = openStore(dataDir);
  assert.deepEqual(store.catalog(), { groups: [], ungrouped: [] });
});

test('group names use Unicode case folding on create and rename', async t => {
  const store = await fixture(t);
  const other = store.createGroup('Other');
  for (const [name, equivalent] of [['STRASSE', 'straße'], ['ΟΔΟΣ', 'οδοσ'], ['Office', 'Ｏｆｆｉｃｅ']]) {
    const group = store.createGroup(name!);
    assert.throws(() => store.createGroup(equivalent!), { status: 409 });
    assert.throws(() => store.updateGroup(other.id, equivalent!), { status: 409 });
    assert.equal(store.updateGroup(group.id, equivalent!).name, equivalent);
  }
});

test('legacy icons resolve URL paths to existing files directly under icons', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'bifrost-legacy-icons-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await mkdir(join(dataDir, 'icons', 'nested'), { recursive: true });
  await writeFile(join(dataDir, 'icons', 'home.svg'), '<svg/>');
  await writeFile(join(dataDir, 'icons', 'nested', 'home.svg'), '<svg/>');
  const icons = [
    './icons/home.svg', 'icons//home.svg', '/icons/home.svg',
    'http://host/icons/home.svg', 'https://other.test/icons/home.svg',
    'icons/../bifrost.sqlite', 'icons/nested/home.svg', 'icons/missing.svg',
    'http://host/elsewhere/home.svg', 'icons/%2e%2e%2fbifrost.sqlite', 'http://[invalid',
  ];
  await writeFile(join(dataDir, 'apps.json'), JSON.stringify({ apps: icons.map((icon, index) => ({
    name: `App ${index + 1}`, url: 'https://app.test', icon,
  })) }));
  const store = openStore(dataDir);
  t.after(() => store.close());
  assert.deepEqual(store.catalog().ungrouped.map(app => app.icon), [
    'icons/home.svg', 'icons/home.svg', 'icons/home.svg', 'icons/home.svg', 'icons/home.svg',
    null, null, null, null, null, null,
  ]);
});

test('imports a legacy catalog with a leading UTF-8 BOM', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'bifrost-legacy-bom-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await writeFile(join(dataDir, 'apps.json'), '\uFEFF{"apps":[{"name":"App","url":"https://app.test"}]}');
  const store = openStore(dataDir);
  t.after(() => store.close());
  assert.equal(store.catalog().ungrouped[0]?.name, 'App');
});

test('legacy failures name the source file and entry, and leave import all-or-nothing', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'bifrost-legacy-error-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const legacy = join(dataDir, 'apps.json');
  const valid = { name: 'Valid', url: 'https://valid.test' };
  for (const [invalid, message] of [
    [null, 'app 3 must be an object.'],
    [{ ...valid, name: '' }, 'app 3 name must be between 1 and 100 characters after trimming.'],
    [{ ...valid, url: 'bad' }, 'app 3 url must be an absolute http or https URL without credentials.'],
  ]) {
    await writeFile(legacy, JSON.stringify({ apps: [valid, valid, invalid] }));
    assert.throws(() => openStore(dataDir), { message: `Cannot import ${legacy}: ${message}` });
  }
  await writeFile(legacy, '{"apps":{}}');
  assert.throws(() => openStore(dataDir), { message: `Cannot import ${legacy}: The catalog must contain an apps array.` });
  await writeFile(legacy, '{broken');
  assert.throws(() => openStore(dataDir), error => error instanceof Error && error.message.startsWith(`Cannot import ${legacy}: `));
  await writeFile(legacy, JSON.stringify({ apps: [{ name: 'Fixed', url: 'https://fixed.test' }] }));
  const store = openStore(dataDir);
  t.after(() => store.close());
  assert.deepEqual(store.catalog().ungrouped.map(app => app.name), ['Fixed']);
});

test('new apps append after surviving group apps when the first apps were deleted', async t => {
  const store = await fixture(t);
  const group = store.createGroup('Group');
  const apps = ['A', 'B', 'C', 'D'].map(name => store.createApp({ name, url: 'https://app.test', groupId: group.id }));
  store.deleteApp(apps[0]!.id);
  store.deleteApp(apps[1]!.id);
  const added = store.createApp({ name: 'New', url: 'https://app.test', groupId: group.id });
  assert.deepEqual(store.catalog().groups[0]?.apps, [apps[2], apps[3], added]);
});

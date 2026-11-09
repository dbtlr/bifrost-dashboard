import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../src/api.ts';
import { parseCatalog } from '../src/catalog.ts';
import { appChanges, draftFor, failureMessage, layoutOf, moveApp, moveGroup, rebaseDraft } from '../src/manage-model.ts';

const app = (id: number, groupId: number | null) => ({ id, name: `App ${id}`, url: `https://app${id}.test/`, icon: null, groupId });
const catalog = parseCatalog({
  revision: 4,
  groups: [{ id: 1, name: 'One', apps: [app(10, 1), app(11, 1)] }, { id: 2, name: 'Two', apps: [] }],
  ungrouped: [app(20, null), app(21, null), app(22, null)],
}, 'https://dashboard.test/');

test('a layout lists every group and app in display order', () => {
  assert.deepEqual(layoutOf(catalog), { groups: [{ id: 1, apps: [10, 11] }, { id: 2, apps: [] }], ungrouped: [20, 21, 22] });
});

test('moving a group swaps it with its neighbour and stops at either end', () => {
  assert.deepEqual(moveGroup(catalog, 1, 1)?.groups.map(group => group.id), [2, 1]);
  assert.deepEqual(moveGroup(catalog, 2, -1)?.groups.map(group => group.id), [2, 1]);
  assert.equal(moveGroup(catalog, 1, -1), null);
  assert.equal(moveGroup(catalog, 2, 1), null);
  assert.equal(moveGroup(catalog, 99, 1), null);
});

test('moving an app swaps it within its own list only', () => {
  assert.deepEqual(moveApp(catalog, 21, -1), { groups: [{ id: 1, apps: [10, 11] }, { id: 2, apps: [] }], ungrouped: [21, 20, 22] });
  assert.deepEqual(moveApp(catalog, 10, 1)?.groups[0]?.apps, [11, 10]);
  assert.equal(moveApp(catalog, 11, 1), null);
  assert.equal(moveApp(catalog, 20, -1), null);
  assert.equal(moveApp(catalog, 99, 1), null);
  assert.deepEqual(layoutOf(catalog).ungrouped, [20, 21, 22], 'the catalog itself is unchanged');
});

test('an app update sends only the fields that differ after trimming', () => {
  const current = catalog.groups[0]!.apps[0]!;
  assert.deepEqual(appChanges(current, { name: ' App 10 ', url: 'https://app10.test/', groupId: 1 }), {});
  assert.deepEqual(appChanges(current, { name: 'Renamed', url: 'https://app10.test/', groupId: 1 }), { name: 'Renamed' });
  assert.deepEqual(appChanges(current, { name: 'App 10', url: 'https://new.test', groupId: 1 }), { url: 'https://new.test' });
  assert.deepEqual(appChanges(current, { name: 'App 10', url: 'https://app10.test/', groupId: null }), { groupId: null });
});

test('an unsaved group choice is kept until the server moves the app to another group', () => {
  const current = catalog.groups[0]!.apps[0]!;
  const draft = { ...draftFor('app:10', current), groupId: '2' };
  assert.equal(draft.name, 'App 10');
  assert.equal(rebaseDraft(draft, current).groupId, '2');
  const movedElsewhere = { ...current, groupId: null };
  const rebased = rebaseDraft(draft, movedElsewhere);
  assert.equal(rebased.groupId, '');
  assert.equal(rebaseDraft({ ...rebased, groupId: '1' }, movedElsewhere).groupId, '1');
  assert.deepEqual(draftFor('new-app'), { key: 'new-app', name: '', url: '', groupId: '', server: { name: '', url: '', groupId: '' } });
});

test('a refresh takes the server value for every field the user has not touched, so saving cannot undo another change', () => {
  const current = catalog.groups[0]!.apps[0]!;
  const draft = { ...draftFor('app:10', current), name: 'Renamed here' };
  const changedElsewhere = { ...current, url: 'https://moved.test/' };
  const rebased = rebaseDraft(draft, changedElsewhere);
  assert.equal(rebased.url, 'https://moved.test/', 'the untouched URL follows the server');
  assert.equal(rebased.name, 'Renamed here', 'the edited name is kept');
  assert.deepEqual(appChanges(changedElsewhere, { name: rebased.name, url: rebased.url, groupId: changedElsewhere.groupId }), { name: 'Renamed here' });

  const editedUrl = rebaseDraft({ ...draftFor('app:10', current), url: 'https://typed.test/' }, changedElsewhere);
  assert.equal(editedUrl.url, 'https://typed.test/', 'an edited URL is kept even when the server changed it');
});

test('only layout conflicts say the list now shows the current order', () => {
  const conflict = new ApiError(409, 'The catalog changed since it was read.');
  assert.equal(failureMessage(conflict, true), 'The catalog changed since it was read. The list now shows the current order.');
  assert.equal(failureMessage(new ApiError(404, 'App does not exist.'), true), 'App does not exist. The list now shows the current order.');
  assert.equal(failureMessage(new ApiError(409, 'A group with that name already exists.'), false), 'A group with that name already exists.');
  assert.equal(failureMessage(new ApiError(404, 'App does not exist.'), false), 'App does not exist.');
  assert.equal(failureMessage(new ApiError(500, 'Database is locked.'), true), 'Database is locked.');
  assert.equal(failureMessage('odd', false), 'Something went wrong. Please try again.');
});

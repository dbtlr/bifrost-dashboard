import { ApiError } from './api.ts';
import type { AppFields, Layout } from './api.ts';
import type { App, Catalog } from './catalog.ts';

// Editing rules for the Manage drawer, kept apart from the DOM so they can be tested directly.

export function layoutOf(catalog: Catalog): Layout {
  return {
    groups: catalog.groups.map(group => ({ id: group.id, apps: group.apps.map(app => app.id) })),
    ungrouped: catalog.ungrouped.map(app => app.id),
  };
}

function swap<T>(items: T[], index: number, delta: number): boolean {
  const target = index + delta;
  if (index < 0 || target < 0 || target >= items.length) return false;
  [items[index], items[target]] = [items[target]!, items[index]!];
  return true;
}

// The layout with the group swapped with its neighbour, or null when it cannot move that way.
export function moveGroup(catalog: Catalog, id: number, delta: number): Layout | null {
  const layout = layoutOf(catalog);
  return swap(layout.groups, layout.groups.findIndex(group => group.id === id), delta) ? layout : null;
}

// The layout with the app swapped with its neighbour in its own list, or null when it cannot move that way.
export function moveApp(catalog: Catalog, id: number, delta: number): Layout | null {
  const layout = layoutOf(catalog);
  const list = layout.groups.find(group => group.apps.includes(id))?.apps ?? layout.ungrouped;
  return swap(list, list.indexOf(id), delta) ? layout : null;
}

export interface AppValues {
  name: string;
  url: string;
  groupId: number | null;
}

// Only the fields the user changed, so a save never overwrites another client's change to an untouched field.
export function appChanges(app: App, values: AppValues): AppFields {
  const changes: AppFields = {};
  if (values.name.trim() !== app.name) changes.name = values.name;
  if (values.url.trim() !== app.url) changes.url = values.url;
  if (values.groupId !== app.groupId) changes.groupId = values.groupId;
  return changes;
}

// Unsaved form input. Group values are option values: '' for ungrouped, otherwise the group ID.
// `server` holds each field as it was when the draft last matched the server.
export interface Draft {
  key: string;
  name: string;
  url: string;
  groupId: string;
  server: { name: string; url: string; groupId: string };
}

const groupValue = (app?: App): string => (app?.groupId == null ? '' : String(app.groupId));
const serverValues = (app?: App) => ({ name: app?.name ?? '', url: app?.url ?? '', groupId: groupValue(app) });

export function draftFor(key: string, app?: App): Draft {
  return { key, ...serverValues(app), server: serverValues(app) };
}

// After a refresh: a name or URL the user has not touched takes the server's new value, so a save never
// sends a stale value back over a change made elsewhere; an edited one is kept. The unsaved group choice
// is kept unless the server has since moved the app to another group, as dragging it in the tree does.
export function rebaseDraft(draft: Draft, app: App): Draft {
  const server = serverValues(app);
  return {
    key: draft.key,
    name: draft.name === draft.server.name ? server.name : draft.name,
    url: draft.url === draft.server.url ? server.url : draft.url,
    groupId: server.groupId === draft.server.groupId ? draft.groupId : server.groupId,
    server,
  };
}

// A rejected layout write is followed by a reload, so only then does the message point to the new order.
export function failureMessage(error: unknown, layout: boolean): string {
  if (!(error instanceof Error)) return 'Something went wrong. Please try again.';
  const stale = layout && error instanceof ApiError && (error.status === 409 || error.status === 404);
  return stale ? `${error.message} The list now shows the current order.` : error.message;
}

import Sortable from 'sortablejs';
import * as api from './api.ts';
import type { Layout } from './api.ts';
import type { App, Catalog, Group } from './catalog.ts';
import { createIcon } from './icon.ts';

export interface ManagerHost {
  dialog: HTMLDialogElement;
  trigger: HTMLButtonElement;
  getCatalog(): Catalog;
  setCatalog(catalog: Catalog): void;
  reload(): Promise<Catalog>;
}

type FormState =
  | { kind: 'app'; id: number }
  | { kind: 'new-app' }
  | { kind: 'new-group' }
  | { kind: 'rename-group'; id: number };

type ErrorPlace = 'tree' | 'form';
type Child = Node | string;
type Props = Record<string, string | boolean | undefined>;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    node.setAttribute(name, value === true ? '' : value);
  }
  node.append(...children);
  return node;
}

function button(label: string, props: Props = {}): HTMLButtonElement {
  return h('button', { type: 'button', ...props }, label);
}

function layoutOf(catalog: Catalog): Layout {
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

function errorMessage(error: unknown): string {
  if (error instanceof api.ApiError) return error.message;
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

// The management drawer: a grouped tree you reorder by dragging, plus a form for one app or group.
export function createManager(host: ManagerHost) {
  const { dialog, trigger } = host;
  let form: FormState | null = null;
  let draft = { key: '', name: '', url: '', groupId: '' };
  let pendingIcon: File | null = null;
  let previewUrl: string | null = null;
  let sortables: Sortable[] = [];

  const treeError = h('p', { class: 'manage-error', role: 'alert', hidden: true });
  const groupsEl = h('div', { class: 'm-groups' });
  const ungroupedEl = h('div', { class: 'm-group m-ungrouped' });
  const addApp = button('+ App', { class: 'ghost-button', 'data-act': 'new-app' });
  const addGroup = button('+ Group', { class: 'ghost-button', 'data-act': 'new-group' });
  const close = button('×', { class: 'manage-close', 'aria-label': 'Close manage panel' });
  const formPane = h('section', { class: 'manage-form-pane', 'aria-label': 'Edit', hidden: true });
  const tree = h('section', { class: 'manage-tree', 'aria-label': 'Apps and groups' },
    treeError, groupsEl, ungroupedEl, h('div', { class: 'manage-new' }, addApp, addGroup));
  dialog.append(h('div', { class: 'manage-panel' },
    h('header', { class: 'manage-top' }, h('h2', { id: 'manage-title' }, 'Manage'), close),
    h('div', { class: 'manage-body' }, tree, formPane)));

  const formKey = (): string => (form ? (form.kind === 'app' || form.kind === 'rename-group' ? `${form.kind}:${form.id}` : form.kind) : '');
  const findApp = (id: number): App | undefined => {
    const catalog = host.getCatalog();
    return [...catalog.ungrouped, ...catalog.groups.flatMap(group => group.apps)].find(app => app.id === id);
  };
  const findGroup = (id: number): Group | undefined => host.getCatalog().groups.find(group => group.id === id);

  function showError(target: HTMLElement, message: string): void {
    target.textContent = message;
    target.hidden = !message;
  }

  // The form is rebuilt on refresh, so errors find their element only after the rebuild.
  function errorTarget(where: ErrorPlace): HTMLElement {
    return (where === 'form' ? formPane.querySelector<HTMLElement>('.form-error') : null) ?? treeError;
  }

  function hideErrors(): void {
    showError(treeError, '');
    const formError = formPane.querySelector<HTMLElement>('.form-error');
    if (formError) showError(formError, '');
  }

  function focusFirst(...selectors: string[]): void {
    for (const selector of selectors) {
      const target = dialog.querySelector<HTMLElement>(selector);
      if (target && !(target instanceof HTMLButtonElement && target.disabled) && target.getClientRects().length > 0) {
        target.focus();
        return;
      }
    }
  }

  // --- Server changes -----------------------------------------------------

  async function refresh(): Promise<void> {
    host.setCatalog(await host.reload());
  }

  // After a failed change, show what the server really has plus the reason.
  async function recover(error: unknown, where: ErrorPlace): Promise<void> {
    try {
      await refresh();
    } catch {
      renderTree();
    }
    const stale = error instanceof api.ApiError && (error.status === 409 || error.status === 404);
    showError(errorTarget(where), stale ? `${errorMessage(error)} The list now shows the current order.` : errorMessage(error));
  }

  async function commitLayout(layout: Layout, focus: string[] = []): Promise<void> {
    hideErrors();
    try {
      host.setCatalog(await api.saveLayout(layout));
      focusFirst(...focus);
    } catch (error) {
      await recover(error, 'tree');
    }
  }

  async function run(operation: () => Promise<void>, where: ErrorPlace): Promise<boolean> {
    hideErrors();
    try {
      await operation();
      return true;
    } catch (error) {
      await recover(error, where);
      return false;
    }
  }

  function layoutFromDom(): Layout {
    const appIds = (list: Element | null): number[] =>
      [...(list?.querySelectorAll<HTMLElement>(':scope > .m-app:not(.sortable-fallback)') ?? [])].map(item => Number(item.dataset.appId));
    return {
      groups: [...groupsEl.querySelectorAll<HTMLElement>(':scope > .m-group')].map(group => ({
        id: Number(group.dataset.groupId),
        apps: appIds(group.querySelector('.m-apps')),
      })),
      ungrouped: appIds(ungroupedEl.querySelector('.m-apps')),
    };
  }

  function moveGroup(id: number, delta: number): void {
    const layout = layoutOf(host.getCatalog());
    if (!swap(layout.groups, layout.groups.findIndex(group => group.id === id), delta)) return;
    void commitLayout(layout, [`[data-act="group-${delta < 0 ? 'up' : 'down'}"][data-id="${id}"]`, `[data-act="group-${delta < 0 ? 'down' : 'up'}"][data-id="${id}"]`]);
  }

  function moveApp(id: number, delta: number): void {
    const layout = layoutOf(host.getCatalog());
    const list = layout.groups.find(group => group.apps.includes(id))?.apps ?? layout.ungrouped;
    if (!swap(list, list.indexOf(id), delta)) return;
    void commitLayout(layout, [`[data-act="move-${delta < 0 ? 'up' : 'down'}"]`, `[data-act="move-${delta < 0 ? 'down' : 'up'}"]`]);
  }

  async function removeApp(app: App): Promise<void> {
    if (!confirm(`Remove “${app.name}” from the dashboard?`)) return;
    const ok = await run(async () => {
      await api.deleteApp(app.id);
      if (form?.kind === 'app' && form.id === app.id) form = null;
      await refresh();
    }, form?.kind === 'app' && form.id === app.id ? 'form' : 'tree');
    if (ok) focusFirst('[data-act="new-app"]');
  }

  async function removeGroup(group: Group): Promise<void> {
    const note = group.apps.length > 0
      ? `Its ${group.apps.length === 1 ? 'app moves' : `${group.apps.length} apps move`} to Ungrouped.`
      : 'It has no apps.';
    if (!confirm(`Delete the group “${group.name}”? ${note}`)) return;
    const ok = await run(async () => {
      await api.deleteGroup(group.id);
      if (form?.kind === 'rename-group' && form.id === group.id) form = null;
      await refresh();
    }, 'tree');
    if (ok) focusFirst('[data-act="new-group"]');
  }

  // --- Tree -----------------------------------------------------------------

  function destroySortables(): void {
    sortables.forEach(sortable => sortable.destroy());
    sortables = [];
  }

  function appRow(app: App): HTMLLIElement {
    const selected = form?.kind === 'app' && form.id === app.id;
    const edit = button(app.name, { class: 'm-app-name', 'aria-label': `Edit ${app.name}`, 'aria-current': selected ? 'true' : undefined });
    const remove = button('×', { class: 'm-app-remove icon-button', 'aria-label': `Remove ${app.name}` });
    edit.addEventListener('click', () => openForm({ kind: 'app', id: app.id }));
    remove.addEventListener('click', () => { void removeApp(app); });
    const icon = createIcon(app.name, app.icon, 22);
    icon.classList.add('app-icon-small');
    return h('li', { class: selected ? 'm-app selected' : 'm-app', 'data-app-id': String(app.id) },
      h('span', { class: 'grip app-grip', 'aria-hidden': 'true' }), icon, edit, remove);
  }

  function appList(groupId: number | null, apps: readonly App[]): HTMLUListElement {
    return h('ul', { class: 'm-apps', 'data-list': groupId === null ? 'ungrouped' : String(groupId) }, ...apps.map(appRow));
  }

  function groupBlock(group: Group, index: number, total: number): HTMLElement {
    const id = String(group.id);
    const actions = h('div', { class: 'm-group-actions' },
      button('Rename', { 'aria-label': `Rename group ${group.name}`, 'data-act': 'group-rename', 'data-id': id }),
      button('↑', { 'aria-label': `Move group ${group.name} up`, 'data-act': 'group-up', 'data-id': id, disabled: index === 0 }),
      button('↓', { 'aria-label': `Move group ${group.name} down`, 'data-act': 'group-down', 'data-id': id, disabled: index === total - 1 }),
      button('Delete', { 'aria-label': `Delete group ${group.name}`, 'data-act': 'group-delete', 'data-id': id, class: 'danger' }));
    actions.addEventListener('click', event => {
      const act = (event.target as HTMLElement).closest('button')?.dataset.act;
      if (act === 'group-rename') openForm({ kind: 'rename-group', id: group.id });
      else if (act === 'group-up') moveGroup(group.id, -1);
      else if (act === 'group-down') moveGroup(group.id, 1);
      else if (act === 'group-delete') void removeGroup(group);
    });
    return h('div', { class: 'm-group', 'data-group-id': id },
      h('div', { class: 'm-group-head' },
        h('span', { class: 'grip group-grip', 'aria-hidden': 'true' }),
        h('h3', { class: 'm-group-name' }, group.name),
        actions),
      appList(group.id, group.apps));
  }

  function onDrop(event: Sortable.SortableEvent): void {
    if (event.from === event.to && event.oldIndex === event.newIndex) return;
    void commitLayout(layoutFromDom());
  }

  function renderTree(): void {
    destroySortables();
    const catalog = host.getCatalog();
    groupsEl.replaceChildren(...catalog.groups.map((group, index) => groupBlock(group, index, catalog.groups.length)));
    ungroupedEl.replaceChildren(
      h('div', { class: 'm-group-head' }, h('h3', { class: 'm-group-name' }, 'Ungrouped')),
      appList(null, catalog.ungrouped));

    const common: Sortable.Options = { forceFallback: true, animation: 150, ghostClass: 'drag-ghost', chosenClass: 'drag-chosen', onEnd: onDrop };
    sortables.push(new Sortable(groupsEl, { ...common, handle: '.group-grip', draggable: '.m-group' }));
    for (const list of dialog.querySelectorAll<HTMLElement>('.m-apps')) {
      sortables.push(new Sortable(list, { ...common, group: 'apps', handle: '.app-grip', draggable: '.m-app', emptyInsertThreshold: 24 }));
    }
  }

  // --- Forms ------------------------------------------------------------------

  function field(label: string, control: HTMLElement): HTMLDivElement {
    control.id = `field-${label.toLowerCase()}`;
    return h('div', { class: 'field' }, h('label', { for: control.id }, label), control);
  }

  function closeForm(focus?: string): void {
    form = null;
    pendingIcon = null;
    renderForm();
    renderTree();
    focusFirst(...(focus ? [focus] : []), '[data-act="new-app"]');
  }

  function openForm(next: FormState): void {
    form = next;
    pendingIcon = null;
    draft = { key: '', name: '', url: '', groupId: '' };
    hideErrors();
    renderTree();
    renderForm();
    focusFirst('.manage-form-pane input[name="name"]');
  }

  function formHead(title: string, onCancel: () => void): HTMLElement {
    const back = button('← Back', { class: 'form-back', 'aria-label': 'Back to apps and groups' });
    back.addEventListener('click', onCancel);
    return h('div', { class: 'form-head' }, back, h('h3', { id: 'form-title' }, title));
  }

  function groupForm(state: Extract<FormState, { kind: 'new-group' | 'rename-group' }>): HTMLFormElement {
    const group = state.kind === 'rename-group' ? findGroup(state.id) : undefined;
    if (draft.key !== formKey()) draft = { key: formKey(), name: group?.name ?? '', url: '', groupId: '' };
    const name = h('input', { name: 'name', type: 'text', required: true, maxlength: '60', autocomplete: 'off', value: draft.name });
    name.addEventListener('input', () => { draft.name = name.value; });
    const cancel = () => closeForm(group ? `[data-act="group-rename"][data-id="${group.id}"]` : '[data-act="new-group"]');
    const cancelButton = button('Cancel', { class: 'form-cancel' });
    cancelButton.addEventListener('click', cancel);
    const save = h('button', { type: 'submit', class: 'solid-button' }, 'Save');
    const element = h('form', { class: 'manage-form', novalidate: true, 'aria-labelledby': 'form-title' },
      formHead(group ? 'Rename group' : 'New group', cancel),
      h('p', { class: 'manage-error form-error', role: 'alert', hidden: true }),
      field('Name', name),
      h('div', { class: 'form-actions' }, cancelButton, save));
    element.addEventListener('submit', event => {
      event.preventDefault();
      save.disabled = true;
      void (async () => {
        const ok = await run(async () => {
          if (group) await api.renameGroup(group.id, name.value);
          else await api.createGroup(name.value);
          form = null;
          await refresh();
        }, 'form');
        save.disabled = false;
        if (ok) focusFirst(group ? `[data-act="group-rename"][data-id="${group.id}"]` : '[data-act="new-group"]');
      })();
    });
    return element;
  }

  function iconField(app: App | undefined, preview: () => HTMLElement): HTMLElement {
    const fileInput = h('input', { type: 'file', accept: 'image/*', hidden: true, 'aria-label': 'Icon file' });
    const upload = button('Upload icon…', { class: 'ghost-button' });
    const remove = button('Remove icon', { class: 'ghost-button' });
    const previewSlot = h('span', { class: 'icon-preview' }, preview());
    remove.hidden = app ? !app.icon : !pendingIcon;
    upload.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (!file) return;
      if (app) {
        void run(async () => {
          await api.uploadIcon(app.id, file);
          await refresh();
        }, 'form');
        return;
      }
      pendingIcon = file;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(file);
      previewSlot.replaceChildren(preview());
      remove.hidden = false;
    });
    remove.addEventListener('click', () => {
      if (app) {
        void run(async () => {
          await api.removeIcon(app.id);
          await refresh();
        }, 'form');
        return;
      }
      pendingIcon = null;
      previewSlot.replaceChildren(preview());
      remove.hidden = true;
    });
    return h('div', { class: 'icon-field' }, h('span', { class: 'field-label' }, 'Icon'),
      h('div', { class: 'icon-row' }, previewSlot, upload, remove, fileInput));
  }

  function appForm(state: Extract<FormState, { kind: 'app' | 'new-app' }>): HTMLFormElement {
    const app = state.kind === 'app' ? findApp(state.id) : undefined;
    if (draft.key !== formKey()) draft = { key: formKey(), name: app?.name ?? '', url: app?.url ?? '', groupId: app?.groupId == null ? '' : String(app.groupId) };
    if (app) draft.groupId = app.groupId === null ? '' : String(app.groupId);
    const name = h('input', { name: 'name', type: 'text', required: true, maxlength: '100', autocomplete: 'off', value: draft.name });
    const url = h('input', { name: 'url', type: 'url', required: true, inputmode: 'url', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'https://', value: draft.url });
    const group = h('select', { name: 'group' }, h('option', { value: '' }, 'Ungrouped'),
      ...host.getCatalog().groups.map(entry => h('option', { value: String(entry.id) }, entry.name)));
    group.value = draft.groupId;
    name.addEventListener('input', () => { draft.name = name.value; });
    url.addEventListener('input', () => { draft.url = url.value; });
    group.addEventListener('change', () => { draft.groupId = group.value; });

    const cancel = () => closeForm(app ? `[data-app-id="${app.id}"] .m-app-name` : '[data-act="new-app"]');
    const cancelButton = button('Cancel', { class: 'form-cancel' });
    cancelButton.addEventListener('click', cancel);
    const save = h('button', { type: 'submit', class: 'solid-button' }, 'Save');
    const preview = (): HTMLElement => {
      const source = app ? app.icon : (pendingIcon && previewUrl ? previewUrl : undefined);
      return createIcon(app?.name ?? (name.value || 'New app'), source, 32);
    };
    const actions = h('div', { class: 'form-actions' });
    if (app) {
      const removeButton = button('Remove app', { class: 'danger' });
      removeButton.addEventListener('click', () => { void removeApp(app); });
      actions.append(removeButton);
    }
    actions.append(cancelButton, save);

    const children: Child[] = [
      formHead(app ? 'Edit app' : 'New app', cancel),
      h('p', { class: 'manage-error form-error', role: 'alert', hidden: true }),
      field('Name', name), field('URL', url), field('Group', group), iconField(app, preview),
    ];
    if (app) {
      const up = button('Move up', { 'data-act': 'move-up' });
      const down = button('Move down', { 'data-act': 'move-down' });
      const catalog = host.getCatalog();
      const siblings = app.groupId === null ? catalog.ungrouped : findGroup(app.groupId)?.apps ?? [];
      const position = siblings.findIndex(entry => entry.id === app.id);
      up.disabled = position <= 0;
      down.disabled = position === siblings.length - 1;
      up.addEventListener('click', () => moveApp(app.id, -1));
      down.addEventListener('click', () => moveApp(app.id, 1));
      children.push(h('div', { class: 'order-row' }, h('span', { class: 'field-label' }, 'Order'), up, down));
    }
    children.push(actions);
    const element = h('form', { class: 'manage-form', novalidate: true, 'aria-labelledby': 'form-title' }, ...children);

    element.addEventListener('submit', event => {
      event.preventDefault();
      save.disabled = true;
      void (async () => {
        let createdId: number | undefined;
        const ok = await run(async () => {
          const groupId = group.value === '' ? null : Number(group.value);
          if (app) {
            const changes: api.AppFields = {};
            if (name.value.trim() !== app.name) changes.name = name.value;
            if (url.value.trim() !== app.url) changes.url = url.value;
            if (groupId !== app.groupId) changes.groupId = groupId;
            if (Object.keys(changes).length > 0) await api.updateApp(app.id, changes);
          } else {
            createdId = (await api.createApp({ name: name.value, url: url.value, groupId })).id;
            if (pendingIcon) {
              try {
                await api.uploadIcon(createdId, pendingIcon);
              } catch (error) {
                // The app exists now, so continue in its edit form with the reason.
                form = { kind: 'app', id: createdId };
                pendingIcon = null;
                draft.key = '';
                await refresh();
                throw new Error(`The app was added, but its icon wasn’t saved. ${errorMessage(error)}`);
              }
            }
          }
          form = null;
          await refresh();
        }, 'form');
        save.disabled = false;
        if (ok) focusFirst(`[data-app-id="${createdId ?? app?.id}"] .m-app-name`, '[data-act="new-app"]');
      })();
    });
    return element;
  }

  function renderForm(): void {
    dialog.dataset.screen = form ? 'form' : 'tree';
    formPane.hidden = !form;
    if (!form) {
      formPane.replaceChildren();
      return;
    }
    formPane.replaceChildren(form.kind === 'new-group' || form.kind === 'rename-group' ? groupForm(form) : appForm(form));
  }

  function renderAll(): void {
    renderTree();
    renderForm();
  }

  // Called whenever the catalog changes; forms for things that no longer exist are dropped.
  function update(): void {
    if (!dialog.open) return;
    if ((form?.kind === 'app' && !findApp(form.id)) || (form?.kind === 'rename-group' && !findGroup(form.id))) form = null;
    renderAll();
  }

  function open(): void {
    form = null;
    pendingIcon = null;
    hideErrors();
    renderAll();
    dialog.showModal();
  }

  addApp.addEventListener('click', () => openForm({ kind: 'new-app' }));
  addGroup.addEventListener('click', () => openForm({ kind: 'new-group' }));
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    destroySortables();
    form = null;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    trigger.focus();
  });

  return { open, update };
}

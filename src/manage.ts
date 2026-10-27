import Sortable from 'sortablejs';
import * as api from './api.ts';
import type { Layout } from './api.ts';
import type { App, Catalog, Group } from './catalog.ts';
import { createIcon } from './icon.ts';
import { appChanges, draftFor, failureMessage, moveApp, moveGroup, rebaseDraft } from './manage-model.ts';
import type { Draft } from './manage-model.ts';

export interface ManagerHost {
  dialog: HTMLDialogElement;
  trigger: HTMLButtonElement;
  getCatalog(): Catalog;
  // Shows the catalog a request returns, unless a request started later has already been shown.
  applyCatalog(request: () => Promise<Catalog>): Promise<boolean>;
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

interface WriteOptions {
  where: ErrorPlace;
  // A layout write: a failure reloads the order, and the message says so.
  layout?: boolean;
  // The control to refocus when focus was not on a dialog control as the write began.
  origin?: string;
  // Where focus goes after success, before the control that started the write.
  focus?: () => string[];
}

const nameField = '.manage-form-pane input[name="name"]';

// The management drawer: a grouped tree you reorder by dragging, plus a form for one app or group.
// Changes are written one at a time: while one is in flight, every control that writes is disabled.
export function createManager(host: ManagerHost) {
  const { dialog, trigger } = host;
  let form: FormState | null = null;
  let draft: Draft = draftFor('');
  let pendingIcon: File | null = null;
  let previewUrl: string | null = null;
  let sortables: Sortable[] = [];
  let busy = false;

  const treeError = h('p', { class: 'manage-error', role: 'alert', hidden: true });
  const groupsEl = h('div', { class: 'm-groups' });
  const ungroupedEl = h('div', { class: 'm-group m-ungrouped' });
  const addApp = writeControl(button('+ App', { class: 'ghost-button', 'data-act': 'new-app' }));
  const addGroup = writeControl(button('+ Group', { class: 'ghost-button', 'data-act': 'new-group' }));
  const close = button('×', { class: 'manage-close', 'aria-label': 'Close manage panel' });
  const formPane = h('section', { class: 'manage-form-pane', 'aria-label': 'Edit', hidden: true });
  const tree = h('section', { class: 'manage-tree', 'aria-label': 'Apps and groups' },
    treeError, groupsEl, ungroupedEl, h('div', { class: 'manage-new' }, addApp, addGroup));
  dialog.append(h('div', { class: 'manage-panel' },
    h('header', { class: 'manage-top' }, h('h2', { id: 'manage-title' }, 'Manage'), close),
    h('div', { class: 'manage-body' }, tree, formPane)));
  dialog.setAttribute('aria-busy', 'false');

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

  // A selector that finds the same control again after the tree or form is rebuilt.
  function focusKey(element: Element | null): string | undefined {
    if (!(element instanceof HTMLElement) || !dialog.contains(element)) return undefined;
    const { act, id } = element.dataset;
    if (act) return `[data-act="${act}"]${id ? `[data-id="${id}"]` : ''}`;
    return element.id ? `#${element.id}` : undefined;
  }

  // --- Server changes -----------------------------------------------------

  // A control that starts a write: disabled while a write is in flight, and always when not allowed.
  function writeControl(control: HTMLButtonElement, allowed = true): HTMLButtonElement {
    control.dataset.write = allowed ? 'ready' : 'blocked';
    control.disabled = busy || !allowed;
    return control;
  }

  function setBusy(value: boolean): void {
    busy = value;
    dialog.setAttribute('aria-busy', String(value));
    for (const sortable of sortables) sortable.option('disabled', value);
    for (const control of dialog.querySelectorAll<HTMLButtonElement>('[data-write]')) {
      control.disabled = value || control.dataset.write === 'blocked';
    }
  }

  const refresh = (): Promise<boolean> => host.applyCatalog(api.getCatalog);

  // Runs one change. A failure reloads what the server really has (or, if that fails too, redraws the
  // last accepted catalog) and shows the reason. Focus then returns to where the user was working.
  async function write(operation: () => Promise<void>, options: WriteOptions): Promise<void> {
    if (busy) return;
    const origin = focusKey(document.activeElement) ?? options.origin;
    hideErrors();
    setBusy(true);
    let failure: string | undefined;
    try {
      await operation();
    } catch (error) {
      failure = failureMessage(error, options.layout ?? false);
      if (!(await refresh().catch(() => false))) renderTree();
    } finally {
      setBusy(false);
    }
    if (failure !== undefined) showError(errorTarget(options.where), failure);
    const targets = failure === undefined ? options.focus?.() ?? [] : [];
    if (origin) focusFirst(...targets, origin, nameField, '[data-act="new-app"]');
    else focusFirst(...targets);
  }

  // The revision is that of the catalog on screen, so the server rejects the layout if it is stale.
  function commitLayout(layout: Layout, focus: string[] = []): void {
    const { revision } = host.getCatalog();
    void write(async () => { await host.applyCatalog(() => api.saveLayout(layout, revision)); }, { where: 'tree', layout: true, focus: () => focus });
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

  function shiftGroup(id: number, delta: number): void {
    const layout = moveGroup(host.getCatalog(), id, delta);
    if (layout) commitLayout(layout, [`[data-act="group-${delta < 0 ? 'up' : 'down'}"][data-id="${id}"]`, `[data-act="group-${delta < 0 ? 'down' : 'up'}"][data-id="${id}"]`]);
  }

  function shiftApp(id: number, delta: number): void {
    const layout = moveApp(host.getCatalog(), id, delta);
    if (layout) commitLayout(layout, [`[data-act="move-${delta < 0 ? 'up' : 'down'}"]`, `[data-act="move-${delta < 0 ? 'down' : 'up'}"]`]);
  }

  async function removeApp(app: App): Promise<void> {
    if (!confirm(`Remove “${app.name}” from the dashboard?`)) return;
    await write(async () => {
      await api.deleteApp(app.id);
      if (form?.kind === 'app' && form.id === app.id) form = null;
      await refresh();
    }, { where: form?.kind === 'app' && form.id === app.id ? 'form' : 'tree', focus: () => ['[data-act="new-app"]'] });
  }

  async function removeGroup(group: Group): Promise<void> {
    const note = group.apps.length > 0
      ? `Its ${group.apps.length === 1 ? 'app moves' : `${group.apps.length} apps move`} to Ungrouped.`
      : 'It has no apps.';
    if (!confirm(`Delete the group “${group.name}”? ${note}`)) return;
    await write(async () => {
      await api.deleteGroup(group.id);
      if (form?.kind === 'rename-group' && form.id === group.id) form = null;
      await refresh();
    }, { where: 'tree', focus: () => ['[data-act="new-group"]'] });
  }

  // --- Tree -----------------------------------------------------------------

  function destroySortables(): void {
    sortables.forEach(sortable => sortable.destroy());
    sortables = [];
  }

  function appRow(app: App): HTMLLIElement {
    const selected = form?.kind === 'app' && form.id === app.id;
    const id = String(app.id);
    const edit = button(app.name, { class: 'm-app-name', 'aria-label': `Edit ${app.name}`, 'aria-current': selected ? 'true' : undefined, 'data-act': 'edit-app', 'data-id': id });
    const remove = writeControl(button('×', { class: 'm-app-remove icon-button', 'aria-label': `Remove ${app.name}`, 'data-act': 'remove-app', 'data-id': id }));
    edit.addEventListener('click', () => openForm({ kind: 'app', id: app.id }));
    remove.addEventListener('click', () => { void removeApp(app); });
    const icon = createIcon(app.name, app.icon, 22);
    icon.classList.add('app-icon-small');
    return h('li', { class: selected ? 'm-app selected' : 'm-app', 'data-app-id': id },
      h('span', { class: 'grip app-grip', 'aria-hidden': 'true' }), icon, edit, remove);
  }

  function appList(groupId: number | null, apps: readonly App[]): HTMLUListElement {
    return h('ul', { class: 'm-apps', 'data-list': groupId === null ? 'ungrouped' : String(groupId) }, ...apps.map(appRow));
  }

  function groupBlock(group: Group, index: number, total: number): HTMLElement {
    const id = String(group.id);
    const actions = h('div', { class: 'm-group-actions' },
      button('Rename', { 'aria-label': `Rename group ${group.name}`, 'data-act': 'group-rename', 'data-id': id }),
      writeControl(button('↑', { 'aria-label': `Move group ${group.name} up`, 'data-act': 'group-up', 'data-id': id }), index > 0),
      writeControl(button('↓', { 'aria-label': `Move group ${group.name} down`, 'data-act': 'group-down', 'data-id': id }), index < total - 1),
      writeControl(button('Delete', { 'aria-label': `Delete group ${group.name}`, 'data-act': 'group-delete', 'data-id': id, class: 'danger' })));
    actions.addEventListener('click', event => {
      const act = (event.target as HTMLElement).closest('button')?.dataset.act;
      if (act === 'group-rename') openForm({ kind: 'rename-group', id: group.id });
      else if (act === 'group-up') shiftGroup(group.id, -1);
      else if (act === 'group-down') shiftGroup(group.id, 1);
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
    commitLayout(layoutFromDom());
  }

  function renderTree(): void {
    destroySortables();
    const catalog = host.getCatalog();
    groupsEl.replaceChildren(...catalog.groups.map((group, index) => groupBlock(group, index, catalog.groups.length)));
    ungroupedEl.replaceChildren(
      h('div', { class: 'm-group-head' }, h('h3', { class: 'm-group-name' }, 'Ungrouped')),
      appList(null, catalog.ungrouped));

    const common: Sortable.Options = { forceFallback: true, animation: 150, ghostClass: 'drag-ghost', chosenClass: 'drag-chosen', onEnd: onDrop, disabled: busy };
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
    draft = draftFor('');
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
    if (draft.key !== formKey()) draft = { ...draftFor(formKey()), name: group?.name ?? '' };
    const name = h('input', { name: 'name', type: 'text', required: true, autocomplete: 'off', value: draft.name });
    name.addEventListener('input', () => { draft.name = name.value; });
    const cancel = () => closeForm(group ? `[data-act="group-rename"][data-id="${group.id}"]` : '[data-act="new-group"]');
    const cancelButton = button('Cancel', { class: 'form-cancel' });
    cancelButton.addEventListener('click', cancel);
    const save = writeControl(h('button', { type: 'submit', class: 'solid-button', 'data-act': 'save' }, 'Save'));
    const element = h('form', { class: 'manage-form', novalidate: true, 'aria-labelledby': 'form-title' },
      formHead(group ? 'Rename group' : 'New group', cancel),
      h('p', { class: 'manage-error form-error', role: 'alert', hidden: true }),
      field('Name', name),
      h('div', { class: 'form-actions' }, cancelButton, save));
    element.addEventListener('submit', event => {
      event.preventDefault();
      if (save.disabled) return;
      const key = formKey();
      void write(async () => {
        if (group) await api.renameGroup(group.id, name.value);
        else await api.createGroup(name.value);
        if (formKey() === key) form = null;
        await refresh();
      }, {
        where: 'form',
        origin: '[data-act="save"]',
        focus: () => [group ? `[data-act="group-rename"][data-id="${group.id}"]` : '[data-act="new-group"]'],
      });
    });
    return element;
  }

  function iconField(app: App | undefined, preview: () => HTMLElement): HTMLElement {
    const fileInput = h('input', { type: 'file', accept: 'image/*', hidden: true, 'aria-label': 'Icon file' });
    const upload = writeControl(button('Upload icon…', { class: 'ghost-button', 'data-act': 'upload-icon' }));
    const remove = writeControl(button('Remove icon', { class: 'ghost-button', 'data-act': 'remove-icon' }));
    const previewSlot = h('span', { class: 'icon-preview' }, preview());
    remove.hidden = app ? !app.icon : !pendingIcon;
    upload.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (!file) return;
      if (app) {
        void write(async () => {
          await api.uploadIcon(app.id, file);
          await refresh();
        }, { where: 'form', origin: '[data-act="upload-icon"]' });
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
        void write(async () => {
          await api.removeIcon(app.id);
          await refresh();
        }, { where: 'form', origin: '[data-act="remove-icon"]' });
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
    if (draft.key !== formKey()) draft = draftFor(formKey(), app);
    else if (app) draft = rebaseDraft(draft, app);
    const name = h('input', { name: 'name', type: 'text', required: true, autocomplete: 'off', value: draft.name });
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
    const save = writeControl(h('button', { type: 'submit', class: 'solid-button', 'data-act': 'save' }, 'Save'));
    const preview = (): HTMLElement => {
      const source = app ? app.icon : (pendingIcon && previewUrl ? previewUrl : undefined);
      return createIcon(app?.name ?? (name.value || 'New app'), source, 32);
    };
    const actions = h('div', { class: 'form-actions' });
    if (app) {
      const removeButton = writeControl(button('Remove app', { class: 'danger', 'data-act': 'form-remove' }));
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
      const catalog = host.getCatalog();
      const siblings = app.groupId === null ? catalog.ungrouped : findGroup(app.groupId)?.apps ?? [];
      const position = siblings.findIndex(entry => entry.id === app.id);
      const up = writeControl(button('Move up', { 'data-act': 'move-up' }), position > 0);
      const down = writeControl(button('Move down', { 'data-act': 'move-down' }), position < siblings.length - 1);
      up.addEventListener('click', () => shiftApp(app.id, -1));
      down.addEventListener('click', () => shiftApp(app.id, 1));
      children.push(h('div', { class: 'order-row' }, h('span', { class: 'field-label' }, 'Order'), up, down));
    }
    children.push(actions);
    const element = h('form', { class: 'manage-form', novalidate: true, 'aria-labelledby': 'form-title' }, ...children);

    element.addEventListener('submit', event => {
      event.preventDefault();
      if (save.disabled) return;
      const key = formKey();
      let createdId: number | undefined;
      void write(async () => {
        const values = { name: name.value, url: url.value, groupId: group.value === '' ? null : Number(group.value) };
        if (app) {
          const changes = appChanges(app, values);
          if (Object.keys(changes).length > 0) await api.updateApp(app.id, changes);
        } else {
          createdId = (await api.createApp(values)).id;
          if (pendingIcon) {
            try {
              await api.uploadIcon(createdId, pendingIcon);
            } catch (error) {
              // The app exists now, so the reload after this failure opens its edit form with the reason.
              form = { kind: 'app', id: createdId };
              pendingIcon = null;
              draft = draftFor('');
              throw new Error(`The app was added, but its icon wasn’t saved. ${failureMessage(error, false)}`);
            }
          }
        }
        if (formKey() === key) form = null;
        await refresh();
      }, {
        where: 'form',
        origin: '[data-act="save"]',
        focus: () => [`[data-app-id="${createdId ?? app?.id}"] .m-app-name`, '[data-act="new-app"]'],
      });
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

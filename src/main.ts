import { countApps, filterCatalog, loadCatalog } from './catalog.ts';
import type { App, Catalog } from './catalog.ts';
import { createIcon } from './icon.ts';
import { createManager } from './manage.ts';
import './style.css';

function element<T extends HTMLElement>(id: string): T {
  const result = document.getElementById(id);
  if (!result) throw new Error(`Missing dashboard element: ${id}`);
  return result as T;
}

const search = element<HTMLInputElement>('search');
const launcher = element('launcher');
const section = element('apps-section');
const totalCount = element('total-count');
const announcement = element('search-announcement');
const message = element('message');
const messageTitle = element('message-title');
const messageDetail = element('message-detail');
const retry = element<HTMLButtonElement>('retry');
const manageOpen = element<HTMLButtonElement>('manage-open');
const manageDialog = element<HTMLDialogElement>('manage');
const source = document.querySelector<HTMLMetaElement>('meta[name="apps-source"]')?.content || './api/catalog';
let catalog: Catalog = { groups: [], ungrouped: [] };

function countLabel(count: number): string {
  return `${count} ${count === 1 ? 'app' : 'apps'}`;
}

function createAppItem(app: App): HTMLLIElement {
  const item = document.createElement('li');
  const link = document.createElement('a');
  link.className = 'app-link';
  link.href = app.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.setAttribute('aria-label', `Open ${app.name} (${app.domain}, opens in a new tab)`);

  const name = document.createElement('span');
  name.className = 'app-name';
  name.textContent = app.name;
  const domain = document.createElement('span');
  domain.className = 'app-domain';
  domain.textContent = app.domain;
  domain.title = app.domain;
  const arrow = document.createElement('span');
  arrow.className = 'app-arrow';
  arrow.textContent = '↗';
  arrow.setAttribute('aria-hidden', 'true');

  link.append(createIcon(app.name, app.icon), name, domain, arrow);
  item.append(link);
  return item;
}

function createSection(title: string, apps: readonly App[], id: string): HTMLElement {
  const wrapper = document.createElement('section');
  wrapper.className = 'launcher-section';
  wrapper.setAttribute('aria-labelledby', id);
  const line = document.createElement('div');
  line.className = 'section-line';
  const heading = document.createElement('h2');
  heading.id = id;
  const count = document.createElement('span');
  count.textContent = `· ${apps.length}`;
  heading.append(`${title} `, count);
  line.append(heading);
  const grid = document.createElement('ul');
  grid.className = 'app-grid';
  grid.append(...apps.map(createAppItem));
  wrapper.append(line, grid);
  return wrapper;
}

function showMessage(title: string, detail = '', canRetry = false): void {
  message.hidden = !title;
  messageTitle.textContent = title;
  messageDetail.textContent = detail;
  messageDetail.hidden = !detail;
  retry.hidden = !canRetry;
}

// Nonempty groups in the user's order, then ungrouped apps. Without any groups, one plain list.
function renderApps(): void {
  const total = countApps(catalog);
  const visible = filterCatalog(catalog, search.value);
  const shown = countApps(visible);
  const sections = visible.groups.map(group => createSection(group.name, group.apps, `group-${group.id}`));
  if (visible.ungrouped.length > 0) {
    sections.push(createSection(catalog.groups.length > 0 ? 'Ungrouped' : 'All apps', visible.ungrouped, 'ungrouped'));
  }
  launcher.replaceChildren(...sections);
  totalCount.textContent = countLabel(total);
  announcement.textContent = `${countLabel(shown)}${search.value.trim() ? ' matching your search' : ''}.`;
  if (total === 0) {
    showMessage('No apps yet.', 'Use Manage to add your first app.');
  } else if (shown === 0) {
    showMessage('No matching apps.', 'Try another name or domain.');
  } else {
    showMessage('');
  }
}

function setCatalog(next: Catalog): void {
  catalog = next;
  search.disabled = false;
  manageOpen.disabled = false;
  renderApps();
  manager.update();
}

const reload = (): Promise<Catalog> => loadCatalog(new URL(source, document.baseURI).href, document.baseURI);
const manager = createManager({
  dialog: manageDialog,
  trigger: manageOpen,
  getCatalog: () => catalog,
  setCatalog,
  reload,
});

async function refreshApps(): Promise<void> {
  section.setAttribute('aria-busy', 'true');
  search.disabled = true;
  retry.disabled = true;
  showMessage('Loading apps…');
  try {
    setCatalog(await reload());
  } catch (error) {
    console.error('Unable to load the app catalog:', error);
    showMessage('Couldn’t load your apps.', 'Please try again in a moment.', true);
  } finally {
    section.setAttribute('aria-busy', 'false');
    retry.disabled = false;
  }
}

search.addEventListener('input', renderApps);
retry.addEventListener('click', () => { void refreshApps(); });
manageOpen.addEventListener('click', () => manager.open());
document.addEventListener('keydown', event => {
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing || manageDialog.open) return;
  const active = document.activeElement;
  const isEditing = active instanceof HTMLElement && (active.matches('input, textarea, select') || active.isContentEditable);
  if (event.key === '/' && !isEditing && !search.disabled) {
    event.preventDefault();
    search.focus();
  } else if (event.key === 'Escape' && active === search) {
    event.preventDefault();
    search.value = '';
    renderApps();
    search.blur();
  }
});

void refreshApps();

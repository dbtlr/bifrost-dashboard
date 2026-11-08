import { filterApps, loadApps } from './catalog.ts';
import type { App } from './catalog.ts';
import './style.css';

function element<T extends HTMLElement>(id: string): T {
  const result = document.getElementById(id);
  if (!result) throw new Error(`Missing dashboard element: ${id}`);
  return result as T;
}

const search = element<HTMLInputElement>('search');
const grid = element<HTMLUListElement>('app-grid');
const section = element('apps-section');
const totalCount = element('total-count');
const resultCount = element('result-count');
const announcement = element('search-announcement');
const message = element('message');
const messageTitle = element('message-title');
const messageDetail = element('message-detail');
const retry = element<HTMLButtonElement>('retry');
const source = document.querySelector<HTMLMetaElement>('meta[name="apps-source"]')?.content || './apps.json';
let apps: App[] = [];

function countLabel(count: number): string {
  return `${count} ${count === 1 ? 'app' : 'apps'}`;
}

function initials(name: string): string {
  return name.split(/\s+/u).slice(0, 2).map(word => Array.from(word)[0] ?? '').join('').toLocaleUpperCase();
}

function createAppItem(app: App): HTMLLIElement {
  const item = document.createElement('li');
  const link = document.createElement('a');
  link.className = 'app-link';
  link.href = app.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.setAttribute('aria-label', `Open ${app.name} (${app.domain}, opens in a new tab)`);

  const icon = document.createElement('span');
  icon.className = 'app-icon';
  icon.setAttribute('aria-hidden', 'true');
  const fallback = document.createElement('span');
  fallback.className = 'icon-fallback';
  fallback.textContent = initials(app.name);
  icon.append(fallback);

  if (app.icon) {
    const image = document.createElement('img');
    image.alt = '';
    image.width = 44;
    image.height = 44;
    image.decoding = 'async';
    image.loading = 'lazy';
    fallback.hidden = true;
    image.addEventListener('error', () => {
      image.hidden = true;
      fallback.hidden = false;
    }, { once: true });
    image.src = app.icon;
    icon.append(image);
  }

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

  link.append(icon, name, domain, arrow);
  item.append(link);
  return item;
}

function showMessage(title: string, detail = '', canRetry = false): void {
  message.hidden = !title;
  messageTitle.textContent = title;
  messageDetail.textContent = detail;
  messageDetail.hidden = !detail;
  retry.hidden = !canRetry;
}

function renderApps(): void {
  const visible = filterApps(apps, search.value);
  grid.replaceChildren(...visible.map(createAppItem));
  resultCount.textContent = `· ${visible.length}`;
  announcement.textContent = `${countLabel(visible.length)}${search.value.trim() ? ' matching your search' : ''}.`;
  if (apps.length === 0) {
    showMessage('No apps yet.', 'Apps will appear here when they’re available.');
  } else if (visible.length === 0) {
    showMessage('No matching apps.', 'Try another name or domain.');
  } else {
    showMessage('');
  }
}

async function refreshApps(): Promise<void> {
  section.setAttribute('aria-busy', 'true');
  search.disabled = true;
  retry.disabled = true;
  showMessage('Loading apps…');
  try {
    apps = await loadApps(new URL(source, document.baseURI).href);
    totalCount.textContent = countLabel(apps.length);
    search.disabled = false;
    renderApps();
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
document.addEventListener('keydown', event => {
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
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

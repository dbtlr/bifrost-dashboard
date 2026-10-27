import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test as base } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { createDashboardServer } from '../../server/server.ts';

export { expect };

const buildDir = fileURLToPath(new URL('../../dist', import.meta.url));

export function sampleIcon(name: string): string {
  return fileURLToPath(new URL(`../../sample/icons/${name}`, import.meta.url));
}

interface Item { id: number; name: string }

// Talks to the test's own dashboard server the way an automation tool would.
export class Api {
  origin: string;

  constructor(origin: string) {
    this.origin = origin;
  }

  async call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.origin}/api/${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${method} ${path} failed with ${response.status}`);
    return (response.status === 204 ? undefined : await response.json()) as T;
  }

  addGroup(name: string): Promise<Item> {
    return this.call('POST', 'groups', { name });
  }

  addApp(name: string, groupId: number | null = null, host = name.toLowerCase().replace(/\W+/g, '-')): Promise<Item> {
    return this.call('POST', 'apps', { name, url: `https://${host}.example.test`, groupId });
  }

  async uploadIcon(id: number, file: string): Promise<void> {
    const response = await fetch(`${this.origin}/api/apps/${id}/icon`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/svg+xml' },
      body: await readFile(file),
    });
    if (!response.ok) throw new Error(`Icon upload failed with ${response.status}`);
  }

  // Everyday: Home Assistant, Vaultwarden. Media: Immich (with an icon), Jellyfin. Archive: empty. Ungrouped: Miniflux.
  async seed(): Promise<void> {
    const everyday = await this.addGroup('Everyday');
    const media = await this.addGroup('Media');
    await this.addGroup('Archive');
    await this.addApp('Home Assistant', everyday.id);
    await this.addApp('Vaultwarden', everyday.id);
    const immich = await this.addApp('Immich', media.id);
    await this.uploadIcon(immich.id, sampleIcon('photos.svg'));
    await this.addApp('Jellyfin', media.id);
    await this.addApp('Miniflux');
  }

  catalog(): Promise<{ groups: { name: string; apps: { name: string; icon: string | null }[] }[]; ungrouped: { name: string }[] }> {
    return this.call('GET', 'catalog');
  }
}

// Every test gets a fresh server and database, so tests never share state and can run in parallel.
export const test = base.extend<{ api: Api }>({
  baseURL: async ({}, use) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'bifrost-browser-'));
    const server = createDashboardServer({ buildDir, dataDir });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    await use(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  },
  api: async ({ baseURL }, use) => {
    await use(new Api(baseURL!));
  },
});

// Pointer events in small steps so SortableJS's fallback drag sees a real gesture.
export async function drag(page: Page, handle: Locator, target: Locator, where: 'top' | 'middle' | 'bottom' = 'middle'): Promise<void> {
  await handle.scrollIntoViewIfNeeded();
  const from = (await handle.boundingBox())!;
  const to = (await target.boundingBox())!;
  const x = to.x + Math.min(to.width / 2, 120);
  const y = to.y + (where === 'top' ? 3 : where === 'bottom' ? to.height - 3 : to.height / 2);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 6, from.y + from.height / 2 + 6, { steps: 4 });
  await page.mouse.move(x, y, { steps: 20 });
  await page.mouse.move(x, y + (where === 'bottom' ? -1 : 1), { steps: 3 });
  await page.mouse.up();
}

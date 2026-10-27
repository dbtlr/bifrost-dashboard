import type { Page } from '@playwright/test';
import { delayFirst, drag, expect, sampleIcon, test } from './fixtures.ts';
import type { Api } from './fixtures.ts';

const manage = (page: Page) => page.locator('#manage');
const field = (page: Page, label: string) => manage(page).locator('form').getByLabel(label, { exact: true });
const launcherHeadings = (page: Page) => page.locator('.launcher-section h2');
const groupNames = (page: Page) => manage(page).locator('.m-group:not(.m-ungrouped) .m-group-name');
const rows = (page: Page, list: string) => manage(page).locator(`.m-apps[data-list="${list}"] .m-app-name`);
const alert = (page: Page) => manage(page).getByRole('alert');
const appGrip = (page: Page, name: string) => manage(page).locator('.m-app', { hasText: name }).locator('.app-grip');
const appRow = (page: Page, name: string) => manage(page).locator('.m-app', { hasText: name });
const groupGrip = (page: Page, name: string) => manage(page).locator('.m-group', { hasText: name }).locator('.group-grip');
const groupHead = (page: Page, name: string) => manage(page).locator('.m-group', { hasText: name }).locator('.m-group-head');
const isLayout = (status: number) => (response: { url(): string; status(): number }) => response.url().endsWith('/api/layout') && response.status() === status;

async function openManage(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Manage' }).click();
  await expect(manage(page)).toBeVisible();
}

async function editApp(page: Page, name: string): Promise<void> {
  await manage(page).getByRole('button', { name: `Edit ${name}`, exact: true }).click();
  await expect(manage(page).getByRole('heading', { name: 'Edit app' })).toBeVisible();
}

async function groupId(page: Page, name: string): Promise<string> {
  return (await manage(page).locator('.m-group', { has: page.getByRole('heading', { name, exact: true }) }).getAttribute('data-group-id'))!;
}

test('the drawer opens and closes with the keyboard, returning focus to Manage', async ({ page, api }) => {
  await api.seed();
  await openManage(page);
  await expect(manage(page).getByRole('heading', { name: 'Manage' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(manage(page)).toBeHidden();
  await expect(page.getByRole('button', { name: 'Manage' })).toBeFocused();
  await page.getByRole('button', { name: 'Manage' }).click();
  await manage(page).getByRole('button', { name: 'Close manage panel' }).click();
  await expect(manage(page)).toBeHidden();
  await expect(page.getByRole('button', { name: 'Manage' })).toBeFocused();
});

test('the tree mirrors the launcher: groups in order, apps under them, then Ungrouped', async ({ page, api }) => {
  await api.seed();
  await openManage(page);
  await expect(groupNames(page)).toHaveText(['Everyday', 'Media', 'Archive']);
  await expect(rows(page, 'ungrouped')).toHaveText(['Miniflux']);
  await expect(manage(page).locator('.m-apps:empty')).toHaveCount(1);
  for (const label of ['Rename group Everyday', 'Move group Everyday down', 'Delete group Everyday', 'Remove Vaultwarden']) {
    await expect(manage(page).getByRole('button', { name: label })).toBeVisible();
  }
});

test('adding a group and an app updates the launcher behind the drawer', async ({ page, api }) => {
  await openManage(page);
  await manage(page).getByRole('button', { name: '+ Group' }).click();
  await field(page, 'Name').fill('Media');
  await manage(page).getByRole('button', { name: 'Save' }).click();
  await expect(groupNames(page)).toHaveText(['Media']);

  await manage(page).getByRole('button', { name: '+ App' }).click();
  await field(page, 'Name').fill('Immich');
  await field(page, 'URL').fill('photos.example.test');
  await manage(page).getByRole('button', { name: 'Save' }).click();
  await expect(manage(page).getByRole('alert')).toContainText('absolute http or https URL');
  await field(page, 'URL').fill('https://photos.example.test');
  await field(page, 'Group').selectOption({ label: 'Media' });
  await manage(page).getByRole('button', { name: 'Save' }).click();
  await expect(rows(page, await groupId(page, 'Media'))).toHaveText(['Immich']);
  await expect(launcherHeadings(page)).toHaveText(['Media · 1']);
  await expect(page.getByRole('link', { name: /Open Immich \(photos\.example\.test/ })).toBeVisible();
  expect((await api.catalog()).groups[0]?.apps.map(entry => entry.name)).toEqual(['Immich']);
});

test('edits to an app and group save immediately and show errors inline', async ({ page, api }) => {
  await api.seed();
  await openManage(page);
  await editApp(page, 'Vaultwarden');
  await field(page, 'Name').fill('Bitwarden');
  await field(page, 'URL').fill('https://bitwarden.example.test/vault');
  await field(page, 'Group').selectOption({ label: 'Archive' });
  await manage(page).getByRole('button', { name: 'Save' }).click();
  await expect(launcherHeadings(page)).toHaveText(['Everyday · 1', 'Media · 2', 'Archive · 1', 'Ungrouped · 1']);
  await expect(page.getByRole('link', { name: /Open Bitwarden \(bitwarden\.example\.test/ })).toHaveAttribute('href', 'https://bitwarden.example.test/vault');

  await manage(page).getByRole('button', { name: 'Rename group Archive' }).click();
  await field(page, 'Name').fill('Media');
  await manage(page).getByRole('button', { name: 'Save' }).click();
  await expect(alert(page)).toHaveText('A group with that name already exists.');
  await field(page, 'Name').fill('Vault');
  await manage(page).getByRole('button', { name: 'Save' }).click();
  await expect(launcherHeadings(page)).toContainText(['Everyday · 1', 'Media · 2', 'Vault · 1']);
});

test('uploading and removing an icon updates the launcher', async ({ page, api }) => {
  await api.seed();
  await openManage(page);
  await editApp(page, 'Jellyfin');
  const tile = page.locator('.app-link', { hasText: 'Jellyfin' });
  await expect(tile.locator('img')).toHaveCount(0);
  await manage(page).locator('input[type=file]').setInputFiles(sampleIcon('watch.svg'));
  await expect(tile.locator('img')).toHaveAttribute('src', /\/icons\/.+\.svg$/);
  await expect.poll(() => tile.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await manage(page).getByRole('button', { name: 'Remove icon' }).click();
  await expect(tile.locator('img')).toHaveCount(0);
  await expect(tile.locator('.icon-fallback')).toBeVisible();
});

test('a new app can bring its icon along', async ({ page, api }) => {
  await openManage(page);
  await manage(page).getByRole('button', { name: '+ App' }).click();
  await field(page, 'Name').fill('Grafana');
  await field(page, 'URL').fill('https://metrics.example.test');
  await manage(page).locator('input[type=file]').setInputFiles(sampleIcon('grafana.svg'));
  await manage(page).getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.app-link', { hasText: 'Grafana' }).locator('img')).toHaveAttribute('src', /\/icons\/.+\.svg$/);
  expect((await api.catalog()).ungrouped).toHaveLength(1);
});

test('dragging an app into another group, including an empty one, persists after reload', async ({ page, api }) => {
  await api.seed();
  await openManage(page);
  const everyday = await groupId(page, 'Everyday');
  const archive = await groupId(page, 'Archive');
  const saved = page.waitForResponse(response => response.url().endsWith('/api/layout') && response.ok());
  await drag(page, manage(page).locator('.m-app', { hasText: 'Vaultwarden' }).locator('.app-grip'), manage(page).locator(`.m-apps[data-list="${archive}"]`));
  await saved;
  await expect(rows(page, archive)).toHaveText(['Vaultwarden']);
  await expect(rows(page, everyday)).toHaveText(['Home Assistant']);
  await expect(launcherHeadings(page)).toHaveText(['Everyday · 1', 'Media · 2', 'Archive · 1', 'Ungrouped · 1']);
  // Icons in the saved layout resolve against the dashboard root, not the API URL.
  const immich = page.locator('.app-link', { hasText: 'Immich' }).locator('img');
  await expect(immich).toHaveAttribute('src', /^http:\/\/[^/]+\/icons\//);
  await expect.poll(() => immich.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);

  const second = page.waitForResponse(response => response.url().endsWith('/api/layout') && response.ok());
  await drag(page, manage(page).locator('.m-app', { hasText: 'Jellyfin' }).locator('.app-grip'), manage(page).locator('.m-apps[data-list="ungrouped"] .m-app'), 'bottom');
  await second;
  await expect(rows(page, 'ungrouped')).toHaveText(['Miniflux', 'Jellyfin']);

  await page.reload();
  const state = await api.catalog();
  expect(state.groups.map(group => group.apps.map(entry => entry.name))).toEqual([['Home Assistant'], ['Immich'], ['Vaultwarden']]);
  expect(state.ungrouped.map(entry => entry.name)).toEqual(['Miniflux', 'Jellyfin']);
  await expect(launcherHeadings(page)).toHaveText(['Everyday · 1', 'Media · 1', 'Archive · 1', 'Ungrouped · 2']);
});

test('dragging a group reorders the sections and persists', async ({ page, api }) => {
  await api.seed();
  await openManage(page);
  const saved = page.waitForResponse(response => response.url().endsWith('/api/layout') && response.ok());
  await drag(page, manage(page).locator('.m-group', { hasText: 'Media' }).locator('.group-grip'), manage(page).locator('.m-group', { hasText: 'Everyday' }).locator('.m-group-head'), 'top');
  await saved;
  await expect(groupNames(page)).toHaveText(['Media', 'Everyday', 'Archive']);
  await expect(launcherHeadings(page)).toHaveText(['Media · 2', 'Everyday · 2', 'Ungrouped · 1']);
  await page.reload();
  await expect(launcherHeadings(page)).toHaveText(['Media · 2', 'Everyday · 2', 'Ungrouped · 1']);
  expect((await api.catalog()).groups.map(group => group.name)).toEqual(['Media', 'Everyday', 'Archive']);
});

test('keyboard users reorder apps and groups with the move buttons', async ({ page, api }, info) => {
  await api.seed();
  await openManage(page);
  const everyday = await groupId(page, 'Everyday');
  await editApp(page, 'Vaultwarden');
  await expect(manage(page).getByRole('button', { name: 'Move down' })).toBeDisabled();
  await manage(page).getByRole('button', { name: 'Move up' }).focus();
  await page.keyboard.press('Enter');
  await expect(rows(page, everyday)).toHaveText(['Vaultwarden', 'Home Assistant']);
  await expect(page.locator('.app-link').first()).toContainText('Vaultwarden');
  await expect(manage(page).getByRole('button', { name: 'Move up' })).toBeDisabled();
  await expect(manage(page).getByRole('button', { name: 'Move down' })).toBeFocused();

  if (info.project.name === 'mobile') await manage(page).getByRole('button', { name: 'Back to apps and groups' }).click();
  await manage(page).getByRole('button', { name: 'Move group Everyday down' }).click();
  await expect(groupNames(page)).toHaveText(['Media', 'Everyday', 'Archive']);
  await expect(manage(page).getByRole('button', { name: 'Move group Everyday down' })).toBeFocused();
  expect((await api.catalog()).groups.map(group => group.name)).toEqual(['Media', 'Everyday', 'Archive']);
});

test('deleting a group keeps its apps as ungrouped', async ({ page, api }) => {
  await api.seed();
  page.on('dialog', dialog => {
    expect(dialog.message()).toContain('2 apps move to Ungrouped');
    void dialog.accept();
  });
  await openManage(page);
  await manage(page).getByRole('button', { name: 'Delete group Everyday' }).click();
  await expect(groupNames(page)).toHaveText(['Media', 'Archive']);
  await expect(rows(page, 'ungrouped')).toHaveText(['Miniflux', 'Home Assistant', 'Vaultwarden']);
  await expect(launcherHeadings(page)).toHaveText(['Media · 2', 'Ungrouped · 3']);
});

test('declining a confirmation changes nothing; removing an app deletes only that app', async ({ page, api }) => {
  await api.seed();
  let accept = false;
  page.on('dialog', dialog => { void (accept ? dialog.accept() : dialog.dismiss()); });
  await openManage(page);
  await manage(page).getByRole('button', { name: 'Remove Miniflux' }).click();
  await expect(rows(page, 'ungrouped')).toHaveText(['Miniflux']);
  accept = true;
  await manage(page).getByRole('button', { name: 'Remove Miniflux' }).click();
  await expect(manage(page).locator('.m-apps[data-list="ungrouped"] .m-app')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Open Miniflux/ })).toHaveCount(0);
  await expect(page.locator('.app-link')).toHaveCount(4);
});

test('on a phone the form replaces the tree and Back returns to it', async ({ page, api }, info) => {
  await api.seed();
  await openManage(page);
  const phone = info.project.name === 'mobile';
  await editApp(page, 'Immich');
  await expect(field(page, 'Name')).toHaveValue('Immich');
  const tree = manage(page).getByRole('button', { name: '+ Group' });
  if (phone) {
    await expect(tree).toBeHidden();
    await manage(page).getByRole('button', { name: 'Back to apps and groups' }).click();
    await expect(tree).toBeVisible();
    await expect(field(page, 'Name')).toHaveCount(0);
    await expect(manage(page).getByRole('button', { name: 'Edit Immich' })).toBeFocused();
  } else {
    await expect(tree).toBeVisible();
    const box = (await manage(page).boundingBox())!;
    expect(box.width).toBeLessThan(420);
    expect(box.x + box.width).toBe(page.viewportSize()!.width);
    const heading = page.getByRole('heading', { name: 'Your apps.' });
    await expect(heading).toBeVisible();
    expect((await heading.boundingBox())!.x + (await heading.boundingBox())!.width).toBeLessThan(box.x);
    await manage(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(field(page, 'Name')).toHaveCount(0);
  }
});

test('the drawer fits narrow screens with large touch targets', async ({ page, api }, info) => {
  await api.seed();
  await openManage(page);
  await editApp(page, 'Immich');
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 800 });
    for (const screen of ['form', 'tree']) {
      if (screen === 'tree') await manage(page).getByRole('button', { name: 'Back to apps and groups' }).click();
      const layout = await manage(page).evaluate(dialog => {
        const panel = dialog.querySelector('.manage-body')!;
        const small = [...dialog.querySelectorAll('button, input:not([hidden]), select, .grip')]
          .filter(item => item.getClientRects().length > 0)
          .map(item => ({ label: item.textContent || item.getAttribute('aria-label'), height: item.getBoundingClientRect().height }))
          .filter(item => item.height < 44);
        return { overflow: panel.scrollWidth > panel.clientWidth || document.documentElement.scrollWidth > window.innerWidth, small };
      });
      expect(layout.overflow).toBe(false);
      if (info.project.name === 'mobile' && width <= 390) expect(layout.small).toEqual([]);
      if (screen === 'tree') await editApp(page, 'Immich');
    }
  }
});

test('a layout conflict recovers with the server’s order and an inline message', async ({ page, api }) => {
  await api.seed();
  await openManage(page);
  await api.addApp('Added elsewhere');
  const everyday = await groupId(page, 'Everyday');
  const rejected = page.waitForResponse(response => response.url().endsWith('/api/layout') && response.status() === 409);
  await drag(page, manage(page).locator('.m-app', { hasText: 'Vaultwarden' }).locator('.app-grip'), manage(page).locator('.m-app', { hasText: 'Home Assistant' }), 'top');
  await rejected;
  await expect(alert(page)).toContainText('current order');
  await expect(rows(page, everyday)).toHaveText(['Home Assistant', 'Vaultwarden']);
  await expect(rows(page, 'ungrouped')).toHaveText(['Miniflux', 'Added elsewhere']);
  await expect(page.getByRole('link', { name: /Open Added elsewhere/ })).toBeVisible();
  expect((await api.catalog()).groups[0]?.apps.map(entry => entry.name)).toEqual(['Home Assistant', 'Vaultwarden']);

  // The next successful change clears the message.
  await manage(page).getByRole('button', { name: 'Move group Everyday down' }).click();
  await expect(groupNames(page)).toHaveText(['Media', 'Everyday', 'Archive']);
  await expect(alert(page)).toHaveCount(0);
});

// The tree and the launcher both show exactly what the server has.
async function expectServerState(page: Page, api: Api): Promise<void> {
  await expect(manage(page)).toHaveAttribute('aria-busy', 'false');
  const state = await api.catalog();
  await expect(groupNames(page)).toHaveText(state.groups.map(group => group.name));
  for (const group of state.groups) await expect(rows(page, String(group.id))).toHaveText(group.apps.map(app => app.name));
  await expect(rows(page, 'ungrouped')).toHaveText(state.ungrouped.map(app => app.name));
  const sections = state.groups.filter(group => group.apps.length > 0).map(group => `${group.name} · ${group.apps.length}`);
  if (state.ungrouped.length > 0) sections.push(`${state.groups.length > 0 ? 'Ungrouped' : 'All apps'} · ${state.ungrouped.length}`);
  await expect(launcherHeadings(page)).toHaveText(sections);
}

test('while a slow layout save is in flight, other changes wait, so an older reply never overwrites a newer state', async ({ page, api }) => {
  await api.seed();
  await openManage(page);
  const everyday = await groupId(page, 'Everyday');
  const { released: delivered } = await delayFirst(page, 'layout', 'PUT');
  await drag(page, groupGrip(page, 'Media'), groupHead(page, 'Everyday'), 'top');
  await expect(manage(page)).toHaveAttribute('aria-busy', 'true');
  await expect(manage(page).getByRole('button', { name: '+ App' })).toBeDisabled();
  await expect(manage(page).getByRole('button', { name: 'Move group Everyday down' })).toBeDisabled();
  await editApp(page, 'Vaultwarden');
  await expect(manage(page).getByRole('button', { name: 'Move up' })).toBeDisabled();
  await expect(manage(page).getByRole('button', { name: 'Save' })).toBeDisabled();
  await expect(manage(page).getByRole('button', { name: 'Remove app' })).toBeDisabled();
  await manage(page).getByRole('button', { name: 'Move up' }).click();
  await delivered;
  await expect(rows(page, everyday)).toHaveText(['Vaultwarden', 'Home Assistant']);
  await expectServerState(page, api);
  const state = await api.catalog();
  expect(state.groups.map(group => group.name)).toEqual(['Media', 'Everyday', 'Archive']);
  expect(state.groups[1]?.apps.map(app => app.name)).toEqual(['Vaultwarden', 'Home Assistant']);
  await expect(alert(page)).toHaveCount(0);
});

test('Move up then Move down during a slow save returns the app to where it started', async ({ page, api }) => {
  for (const name of ['A', 'B', 'C']) await api.addApp(name);
  await openManage(page);
  const { released: delivered } = await delayFirst(page, 'layout', 'PUT');
  await editApp(page, 'B');
  await manage(page).getByRole('button', { name: 'Move up' }).click();
  await manage(page).getByRole('button', { name: 'Move down' }).click();
  await delivered;
  await expect(rows(page, 'ungrouped')).toHaveText(['A', 'B', 'C']);
  await expectServerState(page, api);
  expect((await api.catalog()).ungrouped.map(app => app.name)).toEqual(['A', 'B', 'C']);
});

test('a group order changed elsewhere is not undone by a move in an open drawer', async ({ page, api }) => {
  await api.seed();
  await openManage(page);
  await api.orderGroups(['Archive', 'Media', 'Everyday']);
  const rejected = page.waitForResponse(isLayout(409));
  await manage(page).getByRole('button', { name: 'Move group Everyday down' }).click();
  await rejected;
  await expect(alert(page)).toHaveText('The catalog changed since it was read. Read it again and retry. The list now shows the current order.');
  await expectServerState(page, api);
  expect((await api.catalog()).groups.map(group => group.name)).toEqual(['Archive', 'Media', 'Everyday']);
});

test('a group change made elsewhere is not undone by a drag in an open drawer', async ({ page, api }) => {
  await api.seed();
  await openManage(page);
  const archive = await api.group('Archive');
  await api.call('PATCH', `apps/${(await api.app('Miniflux')).id}`, { groupId: archive.id });
  const rejected = page.waitForResponse(isLayout(409));
  await drag(page, appGrip(page, 'Vaultwarden'), appRow(page, 'Home Assistant'), 'top');
  await rejected;
  await expect(alert(page)).toContainText('The catalog changed since it was read.');
  await expectServerState(page, api);
  const state = await api.catalog();
  expect(state.groups.find(group => group.name === 'Archive')?.apps.map(app => app.name)).toEqual(['Miniflux']);
  expect(state.groups[0]?.apps.map(app => app.name)).toEqual(['Home Assistant', 'Vaultwarden']);
});

test('when a change and the reload after it both fail, the tree returns to the last saved order', async ({ page, api }) => {
  await api.seed();
  await openManage(page);
  const everyday = await groupId(page, 'Everyday');
  await page.route('**/api/layout', route => route.fulfill({ status: 500, json: { error: 'Database is locked.' } }));
  await page.route('**/api/catalog', route => route.fulfill({ status: 503 }));
  await drag(page, appGrip(page, 'Vaultwarden'), appRow(page, 'Home Assistant'), 'top');
  await expect(alert(page)).toHaveText('Database is locked.');
  await expect(rows(page, everyday)).toHaveText(['Home Assistant', 'Vaultwarden']);
  await expect(page.locator('.app-link').first()).toContainText('Home Assistant');
});

test('focus returns to the control used after a failed save, an icon upload, and an icon removal', async ({ page, api }) => {
  await api.seed();
  await openManage(page);
  await editApp(page, 'Jellyfin');
  await field(page, 'URL').fill('not a url');
  await manage(page).getByRole('button', { name: 'Save' }).click();
  await expect(alert(page)).toContainText('absolute http or https URL');
  await expect(manage(page).getByRole('button', { name: 'Save' })).toBeFocused();

  const chooser = page.waitForEvent('filechooser');
  await manage(page).getByRole('button', { name: 'Upload icon…' }).click();
  await (await chooser).setFiles(sampleIcon('watch.svg'));
  await expect(manage(page).getByRole('button', { name: 'Remove icon' })).toBeVisible();
  await expect(manage(page).getByRole('button', { name: 'Upload icon…' })).toBeFocused();

  await manage(page).getByRole('button', { name: 'Remove icon' }).click();
  await expect(manage(page).getByRole('button', { name: 'Remove icon' })).toBeHidden();
  await expect(field(page, 'Name')).toBeFocused();
});

test('an unsaved group choice survives a refresh unless the app’s group changed on the server', async ({ page, api }) => {
  await api.seed();
  await openManage(page);
  const archive = await groupId(page, 'Archive');
  const everyday = await groupId(page, 'Everyday');
  await editApp(page, 'Jellyfin');
  await field(page, 'Name').fill('Jelly');
  await field(page, 'Group').selectOption({ label: 'Archive' });
  await manage(page).locator('input[type=file]').setInputFiles(sampleIcon('watch.svg'));
  await expect(manage(page).getByRole('button', { name: 'Remove icon' })).toBeVisible();
  await expect(field(page, 'Group')).toHaveValue(archive);
  await expect(field(page, 'Name')).toHaveValue('Jelly');

  await api.call('PATCH', `apps/${(await api.app('Jellyfin')).id}`, { groupId: Number(everyday) });
  await manage(page).getByRole('button', { name: 'Remove icon' }).click();
  await expect(manage(page).getByRole('button', { name: 'Remove icon' })).toBeHidden();
  await expect(field(page, 'Group')).toHaveValue(everyday);
});

test('a form for an app or group deleted elsewhere closes with a plain message', async ({ page, api }) => {
  await api.seed();
  await openManage(page);
  await editApp(page, 'Vaultwarden');
  await api.call('DELETE', `apps/${(await api.app('Vaultwarden')).id}`);
  await field(page, 'Name').fill('Bitwarden');
  await manage(page).getByRole('button', { name: 'Save' }).click();
  await expect(alert(page)).toHaveText('App does not exist.');
  await expect(field(page, 'Name')).toHaveCount(0);
  await expect(rows(page, await groupId(page, 'Everyday'))).toHaveText(['Home Assistant']);

  await manage(page).getByRole('button', { name: 'Rename group Archive' }).click();
  await api.call('DELETE', `groups/${(await api.group('Archive')).id}`);
  await field(page, 'Name').fill('Old');
  await manage(page).getByRole('button', { name: 'Save' }).click();
  await expect(alert(page)).toHaveText('Group does not exist.');
  await expect(field(page, 'Name')).toHaveCount(0);
  await expect(groupNames(page)).toHaveText(['Everyday', 'Media']);
});

test('removing an app while its icon upload is still saving waits for the upload and shows no error', async ({ page, api }) => {
  await api.seed();
  page.on('dialog', dialog => { void dialog.accept(); });
  await openManage(page);
  const jellyfin = await api.app('Jellyfin');
  const { released: delivered } = await delayFirst(page, `apps/${jellyfin.id}/icon`, 'PUT', 'request');
  await editApp(page, 'Jellyfin');
  await manage(page).locator('input[type=file]').setInputFiles(sampleIcon('watch.svg'));
  await manage(page).getByRole('button', { name: 'Remove app' }).click();
  await delivered;
  await expect(page.getByRole('link', { name: /Open Jellyfin/ })).toHaveCount(0);
  await expect(manage(page)).toHaveAttribute('aria-busy', 'false');
  await expect(alert(page)).toHaveCount(0);
  expect((await api.catalog()).groups[1]?.apps.map(app => app.name)).toEqual(['Immich']);
});

test('Save is disabled while a new app is created, so a double click adds it once', async ({ page, api }) => {
  await openManage(page);
  const { released: delivered } = await delayFirst(page, 'apps', 'POST', 'response', 800);
  await manage(page).getByRole('button', { name: '+ App' }).click();
  await field(page, 'Name').fill('Grafana');
  await field(page, 'URL').fill('https://metrics.example.test');
  const save = manage(page).getByRole('button', { name: 'Save' });
  await save.click();
  await expect(save).toBeDisabled();
  await save.click({ force: true });
  await delivered;
  await expect(rows(page, 'ungrouped')).toHaveText(['Grafana']);
  await expect(manage(page)).toHaveAttribute('aria-busy', 'false');
  expect((await api.catalog()).ungrouped.map(app => app.name)).toEqual(['Grafana']);
});

test('when a new app’s icon fails to upload, its edit form opens and saving again does not add it twice', async ({ page, api }) => {
  await openManage(page);
  await page.route('**/api/apps/*/icon', route => route.fulfill({ status: 415, json: { error: 'Unsupported icon content type.' } }));
  await manage(page).getByRole('button', { name: '+ App' }).click();
  await field(page, 'Name').fill('Grafana');
  await field(page, 'URL').fill('https://metrics.example.test');
  await manage(page).locator('input[type=file]').setInputFiles(sampleIcon('grafana.svg'));
  await manage(page).getByRole('button', { name: 'Save' }).click();
  await expect(manage(page).getByRole('heading', { name: 'Edit app' })).toBeVisible();
  await expect(alert(page)).toHaveText('The app was added, but its icon wasn’t saved. Unsupported icon content type.');
  await expect(field(page, 'Name')).toHaveValue('Grafana');
  await manage(page).getByRole('button', { name: 'Save' }).click();
  await expect(field(page, 'Name')).toHaveCount(0);
  expect((await api.catalog()).ungrouped.map(app => app.name)).toEqual(['Grafana']);
});

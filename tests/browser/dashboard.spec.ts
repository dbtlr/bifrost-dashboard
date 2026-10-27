import { expect, test } from './fixtures.ts';

const empty = { revision: 0, groups: [], ungrouped: [] };
const app = (id: number, name: string, url: string, extra: Record<string, unknown> = {}) => ({ id, name, url, icon: null, groupId: null, ...extra });

test('apps appear in the user’s groups and order; names and domains are searchable', async ({ page, api }) => {
  await api.seed();
  await page.goto('/');
  const sections = page.locator('.launcher-section h2');
  await expect(sections).toHaveText(['Everyday · 2', 'Media · 2', 'Ungrouped · 1']);
  await expect(page.getByText('A → Z')).toHaveCount(0);
  const links = page.locator('.app-link');
  await expect(links).toHaveCount(5);
  await expect(links.first()).toContainText('Home Assistant');
  await expect(links.first()).toHaveAttribute('href', 'https://home-assistant.example.test/');
  await expect(links.first()).toHaveAttribute('target', '_blank');
  await expect(page.locator('#total-count')).toHaveText('5 apps');
  await expect.poll(() => page.locator('.app-link img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);

  await page.context().route('https://home-assistant.example.test/', route => route.fulfill({ contentType: 'text/html', body: '<h1>Home Assistant</h1>' }));
  const opened = page.waitForEvent('popup');
  await links.first().click();
  const destination = await opened;
  await expect(destination.getByRole('heading', { name: 'Home Assistant' })).toBeVisible();
  await destination.close();

  const searchbox = page.getByRole('searchbox');
  await searchbox.fill('IMMICH');
  await expect(sections).toHaveText(['Media · 1']);
  await searchbox.fill('vault');
  await expect(sections).toHaveText(['Everyday · 1']);
  await searchbox.fill('no match');
  await expect(page.getByText('No matching apps.')).toBeVisible();
  await searchbox.press('Escape');
  await expect(links).toHaveCount(5);

  await api.addApp('New app');
  await page.reload();
  await expect(links).toHaveCount(6);
  await expect(page.getByRole('link', { name: /Open New app/ })).toBeVisible();
});

test('without groups the apps form one list; "/" focuses search', async ({ page, api }) => {
  await api.addApp('Miniflux');
  await page.goto('/');
  await expect(page.locator('.launcher-section h2')).toHaveText(['All apps · 1']);
  await page.keyboard.press('/');
  await expect(page.getByRole('searchbox')).toBeFocused();
});

test('an empty catalog shows its own state', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('No apps yet.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Manage' })).toBeEnabled();
});

test('failed loads offer a retry and an empty catalog is distinct from an error', async ({ page }) => {
  await page.route('**/api/catalog', route => route.fulfill({ status: 503 }));
  await page.goto('/');
  await expect(page.getByText('Couldn’t load your apps.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Manage' })).toBeDisabled();
  await page.unroute('**/api/catalog');
  await page.route('**/api/catalog', route => route.fulfill({ json: empty }));
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('No apps yet.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeHidden();
});

test('malformed catalogs show a recoverable error', async ({ page }) => {
  await page.route('**/api/catalog', route => route.fulfill({ body: '{unfinished', contentType: 'application/json' }));
  await page.goto('/');
  await expect(page.getByText('Couldn’t load your apps.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeEnabled();
});

test('missing icons fall back to initials and catalog text is never treated as HTML', async ({ page }) => {
  const name = '<img src=x onerror=alert(1)>';
  const group = '<b>Bold group</b>';
  await page.route('**/api/catalog', route => route.fulfill({
    json: {
      revision: 0,
      groups: [{ id: 1, name: group, apps: [app(1, 'Home Assistant', 'https://home.example.test/', { groupId: 1 })] }],
      ungrouped: [app(2, name, 'https://safe.example.test/', { icon: 'icons/missing.svg' })],
    },
  }));
  await page.route('**/icons/missing.svg', route => route.fulfill({ status: 404 }));
  await page.goto('/');
  await expect(page.locator('.app-link')).toHaveCount(2);
  await expect(page.getByText(name, { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: group })).toBeVisible();
  await expect(page.locator('.app-name img, h2 b')).toHaveCount(0);
  await expect(page.locator('.icon-fallback').filter({ hasText: 'HA' })).toBeVisible();
  await expect(page.locator('.app-link').filter({ hasText: name }).locator('.icon-fallback')).toBeVisible();
});

test('long names and domains fit narrow screens with readable text and large targets', async ({ page }) => {
  const long = app(3, 'A very long application name with several words', 'https://an-extremely-long-app-domain.internal.example.test/');
  await page.route('**/api/catalog', route => route.fulfill({
    json: { revision: 0, groups: [{ id: 1, name: 'A group with quite a long name indeed', apps: [app(1, 'Home Assistant', 'https://home.example.test/', { groupId: 1 })] }], ungrouped: [app(2, 'Immich', 'https://photos.example.test/'), long] },
  }));
  await page.goto('/');
  await expect(page.locator('.app-link')).toHaveCount(3);
  for (const width of [320, 390, 540, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > window.innerWidth,
      domainSize: parseFloat(getComputedStyle(document.querySelector('.app-domain')!).fontSize),
      searchSize: parseFloat(getComputedStyle(document.querySelector('input')!).fontSize),
      manage: document.getElementById('manage-open')!.getBoundingClientRect().height,
      targets: [...document.querySelectorAll('.app-link')].map(link => ({ width: link.getBoundingClientRect().width, height: link.getBoundingClientRect().height })),
    }));
    expect(layout.overflow).toBe(false);
    expect(layout.domainSize).toBeGreaterThanOrEqual(11);
    expect(layout.searchSize).toBeGreaterThanOrEqual(16);
    expect(layout.manage).toBeGreaterThanOrEqual(44);
    for (const target of layout.targets) {
      expect(target.width).toBeGreaterThanOrEqual(44);
      expect(target.height).toBeGreaterThanOrEqual(44);
    }
  }
});

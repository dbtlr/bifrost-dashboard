import { expect, test } from '@playwright/test';

const home = { name: 'Home Assistant', url: 'https://home.example.test' };
const photos = { name: 'Immich', url: 'https://photos.example.test', icon: '/icons/photos.svg' };

test('runtime updates appear on reload; names and domains are searchable', async ({ page }) => {
  let apps = [home, photos];
  await page.route('**/apps.json', route => route.fulfill({ json: { apps } }));
  await page.goto('/');
  const links = page.locator('.app-link');
  await expect(links).toHaveCount(2);
  await expect(links.first()).toHaveAttribute('href', home.url + '/');
  await expect(links.first()).toHaveAttribute('target', '_blank');
  await expect.poll(() => page.locator('.app-link img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await page.context().route(home.url + '/', route => route.fulfill({ contentType: 'text/html', body: '<h1>Home Assistant</h1>' }));
  const opened = page.waitForEvent('popup');
  await links.first().click();
  const destination = await opened;
  await expect(destination).toHaveURL(home.url + '/');
  await expect(destination.getByRole('heading', { name: 'Home Assistant' })).toBeVisible();
  await destination.close();
  await page.getByRole('searchbox').fill('PHOTOS');
  await expect(links).toHaveCount(1);
  await expect(links.first()).toContainText('Immich');
  await page.getByRole('searchbox').fill('no match');
  await expect(page.getByText('No matching apps.')).toBeVisible();
  await page.getByRole('searchbox').press('Escape');
  await expect(links).toHaveCount(2);
  apps = [...apps, { name: 'New app', url: 'https://new.example.test' }];
  await page.reload();
  await expect(links).toHaveCount(3);
  await expect(page.getByRole('link', { name: /Open New app/ })).toBeVisible();
});

test('failed loads offer a retry and an empty catalog is distinct from an error', async ({ page }) => {
  await page.route('**/apps.json', route => route.fulfill({ status: 503 }));
  await page.goto('/');
  await expect(page.getByText('Couldn’t load your apps.')).toBeVisible();
  await page.unroute('**/apps.json');
  await page.route('**/apps.json', route => route.fulfill({ json: { apps: [] } }));
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('No apps yet.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeHidden();
});

test('malformed catalogs show a recoverable error', async ({ page }) => {
  await page.route('**/apps.json', route => route.fulfill({ body: '{unfinished', contentType: 'application/json' }));
  await page.goto('/');
  await expect(page.getByText('Couldn’t load your apps.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeEnabled();
});

test('missing icons fall back to initials and catalog text is never treated as HTML', async ({ page }) => {
  const name = '<img src=x onerror=alert(1)>';
  await page.route('**/apps.json', route => route.fulfill({ json: { apps: [home, { name, url: 'https://safe.example.test', icon: '/icons/missing.svg' }] } }));
  await page.route('**/icons/missing.svg', route => route.fulfill({ status: 404 }));
  await page.goto('/');
  await expect(page.locator('.app-link')).toHaveCount(2);
  await expect(page.getByText(name, { exact: true })).toBeVisible();
  await expect(page.locator('.app-name img')).toHaveCount(0);
  await expect(page.locator('.icon-fallback').filter({ hasText: 'HA' })).toBeVisible();
  await expect(page.locator('.app-link').filter({ hasText: name }).locator('.icon-fallback')).toBeVisible();
});

test('long names and domains fit narrow screens with readable text and large targets', async ({ page }) => {
  const longApp = { name: 'A very long application name with several words', url: 'https://an-extremely-long-app-domain.internal.example.test' };
  await page.route('**/apps.json', route => route.fulfill({ json: { apps: [home, photos, longApp] } }));
  await page.goto('/');
  await expect(page.locator('.app-link')).toHaveCount(3);
  for (const width of [320, 390, 540, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > window.innerWidth,
      domainSize: parseFloat(getComputedStyle(document.querySelector('.app-domain')!).fontSize),
      searchSize: parseFloat(getComputedStyle(document.querySelector('input')!).fontSize),
      targets: [...document.querySelectorAll('.app-link')].map(link => ({ width: link.getBoundingClientRect().width, height: link.getBoundingClientRect().height })),
    }));
    expect(layout.overflow).toBe(false);
    expect(layout.domainSize).toBeGreaterThanOrEqual(11);
    expect(layout.searchSize).toBeGreaterThanOrEqual(16);
    for (const target of layout.targets) {
      expect(target.width).toBeGreaterThanOrEqual(44);
      expect(target.height).toBeGreaterThanOrEqual(44);
    }
  }
});

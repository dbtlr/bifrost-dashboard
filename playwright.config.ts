import { defineConfig, devices } from '@playwright/test';

// Each test starts its own dashboard server (see tests/browser/fixtures.ts), so there is no shared webServer.
// `npm run test:browser` builds first because the fixture serves the built files from dist/.
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  use: {
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 960 } } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
});

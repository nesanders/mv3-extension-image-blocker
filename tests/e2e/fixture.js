// Shared Playwright test fixture: launches the real unpacked extension in
// a persistent Chromium context, per Playwright's documented pattern for
// MV3 extensions (launchPersistentContext + --load-extension). Each test
// gets its own fresh, disposable user-data-dir so extension storage never
// leaks between tests.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { test: base, chromium, expect } = require('@playwright/test');

const EXTENSION_PATH = path.join(__dirname, '..', '..');
const PW_CHROMIUM = process.env.PW_CHROMIUM_EXECUTABLE || undefined;

const test = base.extend({
  context: async ({}, use) => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctli-e2e-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      executablePath: PW_CHROMIUM,
      headless: true,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--headless=new'
      ]
    });
    await use(context);
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  },

  extensionId: async ({ context }, use) => {
    let [background] = context.serviceWorkers();
    if (!background) background = await context.waitForEvent('serviceworker');
    await use(background.url().split('/')[2]);
  }
});

module.exports = { test, expect };

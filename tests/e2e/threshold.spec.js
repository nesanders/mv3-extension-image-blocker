const path = require('path');
const fs = require('fs');
const { test, expect } = require('./fixture');
const { MAIN_PORT } = require('./server');
const { formatSizeLabel } = require('../../lib/decisions.js');

const BASE = `http://localhost:${MAIN_PORT}`;

test('size-threshold mode auto-loads small images and placeholders large ones with a size label', async ({
  context,
  extensionId
}) => {
  // Enable the feature via the real options UI (default 50 KB threshold
  // stays as-is) before visiting the fixture page.
  const optionsPage = await context.newPage();
  await optionsPage.goto(`chrome-extension://${extensionId}/options.html`);
  await optionsPage.locator('#threshold-enabled').check();
  await expect
    .poll(() => optionsPage.evaluate(() => chrome.storage.local.get('sizeThresholdEnabled')))
    .toEqual({ sizeThresholdEnabled: true });
  await optionsPage.close();

  const page = await context.newPage();
  await page.goto(`${BASE}/threshold.html`);

  // small.png (~1.7 KB) is well under the 50 KB default threshold: it
  // should auto-load with no placeholder and no click.
  const smallImg = page.locator('#small-img');
  await expect(async () => {
    expect(await smallImg.evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);
  }).toPass({ timeout: 5000 });
  await expect(page.locator('.ctli-placeholder:has(+ #small-img)')).toHaveCount(0);

  // large.png (~100 KB) is well over the threshold: it should show a
  // placeholder carrying a size label that matches its real Content-Length.
  const largePlaceholder = page.locator('.ctli-placeholder:has(+ #large-img)');
  await expect(largePlaceholder).toBeVisible();

  const largeImagePath = path.join(__dirname, 'fixtures', 'images', 'large.png');
  const expectedLabel = formatSizeLabel(fs.statSync(largeImagePath).size);
  await expect(largePlaceholder.locator('.ctli-label')).toHaveText(`${expectedLabel} · Tap to load`);

  await largePlaceholder.click();
  const largeImg = page.locator('#large-img');
  await expect(largeImg).toBeVisible();
  await expect(async () => {
    expect(await largeImg.evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);
  }).toPass({ timeout: 5000 });
});

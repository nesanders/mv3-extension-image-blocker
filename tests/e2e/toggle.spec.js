const { test, expect } = require('./fixture');
const { MAIN_PORT } = require('./server');

const BASE = `http://localhost:${MAIN_PORT}`;

test('turning blocking off for a site loads already-placeholdered images without a reload', async ({
  context,
  extensionId
}) => {
  const page = await context.newPage();
  await page.goto(`${BASE}/static.html`);

  const placeholder1 = page.locator('.ctli-placeholder:has(+ #img1)');
  await expect(placeholder1).toBeVisible();

  // Flip the same underlying storage the toolbar icon's one-tap toggle and
  // the popup's site switch both write to - background.js reconciles DNR
  // rules and broadcasts a reload to open tabs on any change to this key,
  // regardless of which UI entry point triggered it.
  const optionsPage = await context.newPage();
  await optionsPage.goto(`chrome-extension://${extensionId}/options.html`);
  await optionsPage.evaluate(() => chrome.storage.local.set({ siteAllowlist: ['localhost'] }));
  await optionsPage.close();

  // No page.reload() here: the already-open tab should pick up the
  // placeholders and load them in place.
  await expect(placeholder1).toHaveCount(0, { timeout: 5000 });
  const img1 = page.locator('#img1');
  await expect(img1).toBeVisible();
  await expect(async () => {
    expect(await img1.evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);
  }).toPass({ timeout: 5000 });
});

test('the popup reflects and can flip the global blocking toggle', async ({ context, extensionId }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);

  const globalToggle = popup.locator('#global-toggle');
  await expect(globalToggle).toBeChecked(); // on by default

  await globalToggle.click();
  await expect
    .poll(() => popup.evaluate(() => chrome.storage.local.get('globalBlockingEnabled')))
    .toEqual({ globalBlockingEnabled: false });

  const page = await context.newPage();
  await page.goto(`${BASE}/static.html`);
  await expect(page.locator('.ctli-placeholder')).toHaveCount(0);
  const img1 = page.locator('#img1');
  await expect(async () => {
    expect(await img1.evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);
  }).toPass({ timeout: 5000 });
});

const { test, expect } = require('./fixture');
const { MAIN_PORT } = require('./server');

const BASE = `http://localhost:${MAIN_PORT}`;

test('a domain added to the allowlist shows no placeholders at all', async ({ context, extensionId }) => {
  const optionsPage = await context.newPage();
  await optionsPage.goto(`chrome-extension://${extensionId}/options.html`);
  await optionsPage.locator('#add-domain').fill('localhost');
  await optionsPage.locator('#add-form button[type="submit"]').click();
  await expect
    .poll(() => optionsPage.evaluate(() => chrome.storage.local.get('siteAllowlist')))
    .toEqual({ siteAllowlist: ['localhost'] });
  await optionsPage.close();

  const page = await context.newPage();
  await page.goto(`${BASE}/static.html`);

  await expect(page.locator('.ctli-placeholder')).toHaveCount(0);
  const img1 = page.locator('#img1');
  await expect(async () => {
    expect(await img1.evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);
  }).toPass({ timeout: 5000 });
});

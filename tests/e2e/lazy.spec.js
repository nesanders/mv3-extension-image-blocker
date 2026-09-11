const { test, expect } = require('./fixture');
const { MAIN_PORT } = require('./server');

const BASE = `http://localhost:${MAIN_PORT}`;

test('a loading="lazy" image is still detected and blocked once it loads', async ({ context }) => {
  const page = await context.newPage();
  await page.goto(`${BASE}/lazy.html`);

  const img = page.locator('#lazy-img');
  await img.scrollIntoViewIfNeeded();

  const placeholder = page.locator('.ctli-placeholder:has(+ #lazy-img)');
  await expect(placeholder).toBeVisible();

  await placeholder.click();
  await expect(img).toBeVisible();
  await expect(async () => {
    expect(await img.evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);
  }).toPass({ timeout: 5000 });
});

const { test, expect } = require('./fixture');
const { MAIN_PORT } = require('./server');

const BASE = `http://localhost:${MAIN_PORT}`;

test.describe('default blocking + click-to-load', () => {
  test('images are blocked by default and show a placeholder', async ({ context }) => {
    const page = await context.newPage();
    await page.goto(`${BASE}/static.html`);

    // The placeholder is inserted as the element immediately before the
    // <img> it covers, so this selector confirms it's img1's placeholder
    // specifically (the page has two images, each with its own).
    const placeholder = page.locator('.ctli-placeholder:has(+ #img1)');
    await expect(placeholder).toBeVisible();

    const img1 = page.locator('#img1');
    await expect(img1).toBeHidden(); // display:none while placeholder shows
    const naturalWidth = await img1.evaluate((el) => el.naturalWidth);
    expect(naturalWidth).toBe(0); // never actually loaded
  });

  test('clicking the placeholder loads the image', async ({ context }) => {
    const page = await context.newPage();
    await page.goto(`${BASE}/static.html`);

    const placeholder = page.locator('.ctli-placeholder:has(+ #img1)');
    await expect(placeholder).toBeVisible();
    await placeholder.click();

    const img1 = page.locator('#img1');
    await expect(img1).toBeVisible();
    await expect(placeholder).toHaveCount(0);
    await expect(async () => {
      expect(await img1.evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);
    }).toPass({ timeout: 5000 });
  });
});

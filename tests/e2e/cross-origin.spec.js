const { test, expect } = require('./fixture');
const { MAIN_PORT } = require('./server');

const BASE = `http://localhost:${MAIN_PORT}`;

test('click-to-load works for a cross-origin image with no CORS headers', async ({ context }) => {
  // cross-origin.html embeds an image from a second server (different
  // port = different origin) that sends no Access-Control-Allow-Origin
  // header. The allow-rule click-to-load method never reads the response
  // bytes in JS, so it isn't affected by that the way a fetch()+blob
  // fallback would be (that approach gets an opaque, unreadable response).
  const page = await context.newPage();
  await page.goto(`${BASE}/cross-origin.html`);

  const placeholder = page.locator('.ctli-placeholder:has(+ #cross-img)');
  await expect(placeholder).toBeVisible();

  await placeholder.click();

  const img = page.locator('#cross-img');
  await expect(img).toBeVisible();
  await expect(async () => {
    expect(await img.evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);
  }).toPass({ timeout: 5000 });
});

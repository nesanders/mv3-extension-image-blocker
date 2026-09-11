const { test, expect } = require('./fixture');
const { MAIN_PORT } = require('./server');

const BASE = `http://localhost:${MAIN_PORT}`;

test('an image injected after page load (SPA-style) is still detected and blocked', async ({ context }) => {
  const page = await context.newPage();
  await page.goto(`${BASE}/dynamic.html`);

  // dynamic.html injects #dynamic-img ~300ms after load, via JS, to
  // simulate a client-side route change rather than being present in the
  // initial HTML.
  const placeholder = page.locator('.ctli-placeholder:has(+ #dynamic-img)');
  await expect(placeholder).toBeVisible({ timeout: 5000 });

  const img = page.locator('#dynamic-img');
  await placeholder.click();
  await expect(img).toBeVisible();
});

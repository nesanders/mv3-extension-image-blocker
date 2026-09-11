const { test, expect } = require('./fixture');
const { MAIN_PORT } = require('./server');

const BASE = `http://localhost:${MAIN_PORT}`;

test.describe('video blocking + click-to-load', () => {
  test('video is blocked by default and shows a placeholder', async ({ context }) => {
    const page = await context.newPage();
    await page.goto(`${BASE}/video.html`);

    const placeholder = page.locator('.ctli-placeholder--video');
    await expect(placeholder).toBeVisible();
    await expect(placeholder.locator('.ctli-label')).toHaveText('Tap to load video');

    const video = page.locator('#test-video');
    await expect(video).toBeHidden();
    const videoWidth = await video.evaluate((el) => el.videoWidth);
    expect(videoWidth).toBe(0); // never actually loaded
  });

  test('clicking the placeholder loads and plays the video', async ({ context }) => {
    const page = await context.newPage();
    await page.goto(`${BASE}/video.html`);

    const placeholder = page.locator('.ctli-placeholder--video');
    await expect(placeholder).toBeVisible();
    await placeholder.click();

    const video = page.locator('#test-video');
    await expect(video).toBeVisible();
    await expect(placeholder).toHaveCount(0);
    await expect(async () => {
      expect(await video.evaluate((el) => el.videoWidth)).toBeGreaterThan(0);
    }).toPass({ timeout: 5000 });
  });
});

test.describe('audio blocking + click-to-load', () => {
  test('audio is blocked by default, shows a placeholder, and loads on click', async ({ context }) => {
    const page = await context.newPage();
    await page.goto(`${BASE}/audio.html`);

    const placeholder = page.locator('.ctli-placeholder--audio');
    await expect(placeholder).toBeVisible();
    await expect(placeholder.locator('.ctli-label')).toHaveText('Tap to load audio');

    const audio = page.locator('#test-audio');
    await expect(audio).toBeHidden();
    expect(await audio.evaluate((el) => el.readyState)).toBe(0); // HAVE_NOTHING

    await placeholder.click();
    await expect(audio).toBeVisible();
    await expect(placeholder).toHaveCount(0);
    await expect(async () => {
      expect(await audio.evaluate((el) => el.readyState)).toBeGreaterThan(0);
    }).toPass({ timeout: 5000 });
  });
});

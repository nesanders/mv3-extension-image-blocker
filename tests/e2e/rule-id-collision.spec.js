const { test, expect } = require('./fixture');

// Regression test for a real crash reported on Vivaldi mobile:
// "Uncaught (in promise) Error: Rule with id 115882 does not have a
// unique ID." siteRuleId() is a hash, not an allocator, so two different
// allowlisted domains can land on the same preferred id - these two
// domains are a real, verified collision under the current hash (see
// lib/rules.js's siteRuleId): both hash to id 337594. Before the fix,
// adding them together made reconcileSiteRules try to register two
// dynamic rules with the same id in one updateDynamicRules() call, which
// Chrome rejects with exactly that error - as an uncaught rejection,
// since nothing in the storage.onChanged chain caught it.
const COLLIDING_DOMAIN_A = 'site757.test';
const COLLIDING_DOMAIN_B = 'site3000.test';

test('allowlisting two domains that hash to the same rule id does not crash, and both get a working rule', async ({
  context,
  extensionId
}) => {
  const errors = [];
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker');
  sw.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  sw.on('pageerror', (err) => errors.push(String(err)));

  const optionsPage = await context.newPage();
  await optionsPage.goto(`chrome-extension://${extensionId}/options.html`);

  // Add both colliding domains in the same storage write, exactly like
  // the real failure: two "added" domains reconciled together.
  await optionsPage.evaluate(
    ({ a, b }) => chrome.storage.local.set({ siteAllowlist: [a, b] }),
    { a: COLLIDING_DOMAIN_A, b: COLLIDING_DOMAIN_B }
  );

  let ruleForA;
  let ruleForB;
  await expect(async () => {
    const dynamicRules = await optionsPage.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());
    ruleForA = dynamicRules.find((r) => r.condition.requestDomains && r.condition.requestDomains.includes(COLLIDING_DOMAIN_A));
    ruleForB = dynamicRules.find((r) => r.condition.requestDomains && r.condition.requestDomains.includes(COLLIDING_DOMAIN_B));
    expect(ruleForA, `expected a dynamic rule for ${COLLIDING_DOMAIN_A}`).toBeTruthy();
    expect(ruleForB, `expected a dynamic rule for ${COLLIDING_DOMAIN_B}`).toBeTruthy();
  }).toPass({ timeout: 5000 });

  expect(ruleForA.id).not.toBe(ruleForB.id); // the actual bug: these used to collide
  expect(errors, `service worker logged error(s): ${errors.join(' | ')}`).toEqual([]);
});

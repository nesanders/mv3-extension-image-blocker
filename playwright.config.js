// @ts-check
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.js',
  timeout: 30000,
  fullyParallel: false, // one shared fixture HTTP server; keep it simple/deterministic
  workers: 1,
  reporter: [['list']],
  globalSetup: require.resolve('./tests/e2e/global-setup.js'),
  globalTeardown: require.resolve('./tests/e2e/global-teardown.js')
});

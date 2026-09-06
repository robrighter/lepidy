import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: "http://127.0.0.1:3100",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } },
    },
    {
      name: "mobile-chromium",
      use: { ...devices["iPhone 13"], browserName: "chromium" },
      grepInvert: /DESKTOP-INT/,
    },
  ],
  webServer: [
    {
      // The built Worker, not `next dev`. The dev binding proxy cannot host a
      // Durable Object and reaches one in another worker over the dev registry,
      // where the connection does not survive past the first call. Running the
      // real Worker gives the suite real D1 and real objects in one process,
      // and tests the runtime the product actually ships on.
      command: "node scripts/browser-worker.mjs development",
      url: "http://127.0.0.1:3100/signin",
      reuseExistingServer: false,
      timeout: 180_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: "node scripts/browser-worker.mjs production",
      url: "http://127.0.0.1:3101/signin",
      reuseExistingServer: false,
      timeout: 180_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: "node scripts/serve-markups.mjs",
      url: "http://127.0.0.1:4174",
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
});

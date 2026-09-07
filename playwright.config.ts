import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: true,
  // One local Worker serves the whole suite, and every scenario signs up, which
  // means an Argon2id hash. Left to one worker per core the sign-ups alone
  // saturate it and unrelated tests fail on a timeout. This is the real capacity
  // of the single-process harness, not a flake to retry away.
  //
  // Do not lower this to chase a crashed `wrangler dev`. That was tried on
  // 2026-09-06 and made it strictly worse: at two workers the dev server died
  // earlier and took 45 scenarios instead of 21. Whatever kills it is not
  // concurrency and not memory — see the C01a evidence record for what was
  // ruled out and what to look at instead.
  workers: 3,
  // Assertions still wait on observed state rather than sleeping; the budget is
  // simply larger because every scenario is served by one local Worker doing
  // real Argon2id hashing and real Durable Object work.
  expect: { timeout: 10_000 },
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

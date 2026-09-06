import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: "http://127.0.0.1:3000",
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
      command: "npm run dev -- --hostname 127.0.0.1",
      url: "http://127.0.0.1:3000",
      reuseExistingServer: false,
      timeout: 120_000,
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

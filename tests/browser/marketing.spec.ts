import { expect, test } from "./harness";

test("MARKETING-INT-001 keeps the marketing site behind its access code in a browser", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByLabel("Enter access code")).toBeVisible();
  await expect(page).toHaveURL(/:\d+\/$/);
});

test("MARKETING-INT-002 sends the desktop shell to the workspace instead of the marketing site", async ({ page }) => {
  // What an installed build from before the shell opened on /workspace sees:
  // the Tauri bridge is present and the window starts at the bare origin.
  await page.addInitScript(() => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: () => Promise.reject(new Error("not the real shell")),
      transformCallback: () => 0,
    };
  });
  await page.goto("/");
  await expect(page).toHaveURL(/\/workspace$/);
  await expect(page.getByRole("heading", { name: "Sign in to Lepidy" })).toBeVisible();
  await expect(page.getByLabel("Enter access code")).toHaveCount(0);
});

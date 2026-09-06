import { expect, test } from "@playwright/test";

const mockups = "http://127.0.0.1:4174";

test("MOCKUP-SEC-001 renders Solo local-content and online-host terms", async ({ page }) => {
  await page.goto(`${mockups}/pricing.html`);
  await expect(
    page.getByRole("heading", {
      name: "Build unlimited autonomous agents. Use the AI accounts you already have.",
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Unlimited autonomous agents with your ChatGPT or Claude account"),
  ).toHaveCount(2);
  await expect(page.getByText("Messages, files and vault ciphertext on one designated computer")).toBeVisible();
  await expect(page.getByText("Remote access while that computer is online")).toBeVisible();

  await page.goto(`${mockups}/sessions.html`);
  await expect(page.getByText("maya-mbp stores this Solo workspace's channel contents.")).toBeVisible();
  await expect(page.getByText("Channel names and access metadata stay in the cloud.")).toBeVisible();
});

test("MOCKUP-SEC-002 exposes no remote launch editor", async ({ page }) => {
  await page.goto(`${mockups}/runtime.html`);
  await expect(page.getByText("Stored only on maya-mbp · unavailable to remote clients")).toBeVisible();
  await expect(page.getByText(/It can never send or edit a command/)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Edit$/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Reset to preset/i })).toHaveCount(0);
});

test("MOCKUP-SEC-003 explains user-held vault recovery and device-mediated use", async ({ page }) => {
  await page.goto(`${mockups}/vault.html`);
  await expect(page.getByText("Recovery belongs to you.")).toBeVisible();
  await expect(page.getByText(/Lepidy never stores your vault key or recovery code/)).toBeVisible();

  await page.goto(`${mockups}/credential.html`);
  await expect(page.getByText("Only your devices can unlock this.")).toBeVisible();
  await expect(page.getByText(/An enrolled, unlocked device attaches the key/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Reveal in desktop app…" })).toBeVisible();
  await expect(page.getByText(/Keys and plaintext never enter this remote page/)).toBeVisible();
});

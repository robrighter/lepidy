import { expect, test } from "./harness";

import { freshAccount, signUp } from "./auth-helpers";

test.beforeEach(async ({ page }) => {
  await signUp(page, freshAccount());
  await page.goto("/c/general");
});

test("C10-INT-UI applies a queue preset, submits a form and reveals a populated status tab", async ({ page }) => {
  await page.getByText("Queue setup", { exact: true }).click();
  await page.getByRole("button", { name: "Idea board" }).click();
  await expect(page.getByText("Form submissions", { exact: true })).toBeVisible();
  await expect(page.getByText(/Ranked by 🔥/)).toBeVisible();

  await page.getByText("Submit an entry", { exact: true }).click();
  const form = page.locator(".form-composer");
  await form.getByRole("textbox", { name: /^Title/ }).fill("Bulk CSV export");
  await form.getByRole("textbox", { name: /^Details/ }).fill("Let operations download every row in one pass.");
  await page.getByRole("button", { name: "Submit entry" }).click();

  const item = page.locator(".messages > li").first();
  await expect(item.locator(".form-submission-card")).toContainText("Bulk CSV export");
  await expect(item.locator(".rank-count")).toContainText("0");
  await item.getByRole("button", { name: "React with 🔥" }).click();
  await expect(item.locator(".rank-count")).toContainText("1");
  await item.getByLabel("Item status").selectOption({ label: "Triage" });

  const triage = page.getByRole("link", { name: /Triage 1/ });
  await expect(triage).toBeVisible();
  await triage.click();
  await expect(page.locator(".messages > li").first()).toContainText("Bulk CSV export");
});

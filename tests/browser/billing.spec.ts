import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./harness";
import { freshAccount, signUp } from "./auth-helpers";

test.beforeEach(async ({ page }) => signUp(page, freshAccount()));

test("B03-UI-INT-001 reviews an exact purchase without granting it", async ({ page }) => {
  await page.goto("/billing");
  await expect(page.getByRole("link", { name: "Billing" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: /Team/ })).toBeVisible();
  await expect(page.getByText("$19.00/month")).toBeVisible();

  await page.getByLabel("Plan").selectOption("team");
  await page.getByRole("spinbutton", { name: /^Seats/ }).fill("6");
  await page.getByRole("spinbutton", { name: /^100 GB storage packs/ }).fill("2");
  await page.getByRole("button", { name: "Review change" }).click();
  const review = page.locator(".billing-review");
  await expect(review).toContainText("$33.00");
  await expect(review).toContainText("Immediately; added capacity is prorated");

  await review.getByRole("button", { name: "Continue to secure checkout" }).click();
  await expect(page.getByRole("status")).toContainText("not configured");
  await expect(page.getByRole("heading", { name: /Team/ })).toBeVisible();
});

test("B03-UI-INT-002 explains invoices, downgrades and lapse recovery accessibly", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile contract");
  await page.goto("/billing");
  await expect(page.getByRole("heading", { name: "Invoices" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Downgrade safeguards" })).toBeVisible();
  await expect(page.getByText(/never silently removes a colleague/)).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations.filter(({ impact }) => impact === "serious" || impact === "critical")).toEqual([]);
  await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
});

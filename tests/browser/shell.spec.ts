import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("SHELL-INT-001 renders the workspace shell at the active viewport", async ({ page }, testInfo) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Good morning, Maya." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Needs you" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Agent activity" })).toBeVisible();
  await expect(page.locator("aside[aria-label='Workspace navigation']")).toBeVisible();

  const bodyWidth = await page.locator("body").evaluate((body) => body.scrollWidth);
  const viewportWidth = page.viewportSize()?.width ?? 0;
  expect(bodyWidth).toBeLessThanOrEqual(viewportWidth);

  const rail = page.locator(".rail");
  if (testInfo.project.name === "mobile-chromium") {
    await expect(rail).toHaveCSS("position", "fixed");
    await expect(rail).toHaveCSS("bottom", "0px");
    await expect(page.locator(".brand")).toBeHidden();
  } else {
    await expect(rail).toHaveCSS("position", "sticky");
    await expect(page.locator(".brand")).toContainText("Lepidy");
  }
});

test("SHELL-INT-002 has no serious or critical automated accessibility violations", async ({ page }) => {
  await page.goto("/");
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter(({ impact }) =>
    impact === "serious" || impact === "critical",
  );
  expect(blocking).toEqual([]);
});

test("DESKTOP-INT-001 renders the frameless Windows caption controls and drag surface", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    document.documentElement.dataset.desktopPlatform = "windows";
  });

  const titlebar = page.locator(".desktop-titlebar");
  await expect(titlebar).toBeVisible();
  await expect(titlebar).toHaveAttribute("data-tauri-drag-region", "true");
  await expect(page.getByRole("button", { name: "Minimize" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Maximize" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Close" })).toBeVisible();
  await expect(page.locator("body")).toHaveCSS("padding-top", "34px");
});

test("DESKTOP-INT-002 reserves the branded macOS overlay for native traffic lights", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    document.documentElement.dataset.desktopPlatform = "macos";
  });

  await expect(page.locator(".desktop-titlebar")).toBeVisible();
  await expect(page.locator(".window-controls")).toBeHidden();
  await expect(page.locator("body")).toHaveCSS("padding-top", "34px");
});

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function openRailIfNarrow(page: Page, projectName: string) {
  if (projectName !== "mobile-chromium") return;
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.locator(".app-shell")).toHaveAttribute("data-rail-open", "true");
}

test("SHELL-INT-001 renders the workspace shell at the active viewport", async ({ page }, testInfo) => {
  await page.goto("/");

  await expect(page.locator("aside[aria-label='Workspace navigation']")).toBeAttached();
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Channels", level: 2 })).toBeVisible();

  const bodyWidth = await page.locator("body").evaluate((body) => body.scrollWidth);
  expect(bodyWidth).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);

  const rail = page.locator(".rail");
  if (testInfo.project.name === "mobile-chromium") {
    // Narrow: the rail is a drawer, closed until asked for.
    await expect(rail).toHaveCSS("position", "fixed");
    await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
    await openRailIfNarrow(page, testInfo.project.name);
    await expect(page.getByRole("link", { name: "Inbox" })).toBeVisible();
  } else {
    await expect(rail).toHaveCSS("position", "sticky");
    await expect(page.locator(".brand")).toContainText("Lepidy");
    await expect(page.getByRole("button", { name: "Open navigation" })).toBeHidden();
  }
});

test("SHELL-INT-002 has no serious or critical accessibility violations in either theme", async ({ page }) => {
  async function blockingViolations() {
    const results = await new AxeBuilder({ page }).analyze();
    return results.violations
      .filter(({ impact }) => impact === "serious" || impact === "critical")
      .map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target.join(" ")) }));
  }

  for (const path of ["/", "/vault", "/profile"]) {
    await page.goto(path);
    expect(await blockingViolations(), `${path} in light mode`).toEqual([]);
    await page.getByRole("button", { name: "Switch to dark theme" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(await blockingViolations(), `${path} in dark mode`).toEqual([]);
    await page.getByRole("button", { name: "Switch to light theme" }).click();
  }
});

test("SHELL-INT-003 marks exactly one navigation item current as you move around", async ({ page }, testInfo) => {
  await page.goto("/");
  await openRailIfNarrow(page, testInfo.project.name);

  const current = page.locator(".rail nav[aria-label='Primary'] a[aria-current='page']");
  await expect(current).toHaveCount(1);
  await expect(current).toHaveText("Home");

  await page.getByRole("link", { name: "Vault" }).click();
  await expect(page).toHaveURL(/\/vault$/);
  await expect(page.getByRole("heading", { name: "Vault", level: 1 })).toBeVisible();
  await openRailIfNarrow(page, testInfo.project.name);
  await expect(current).toHaveCount(1);
  await expect(current).toHaveText("Vault");

  // A channel is not one of the primary sections, so none of them stays current.
  await page.getByRole("link", { name: "eng", exact: true }).click();
  await expect(page).toHaveURL(/\/c\/eng$/);
  await expect(page.getByRole("heading", { name: "#eng", level: 1 })).toBeVisible();
  await openRailIfNarrow(page, testInfo.project.name);
  await expect(current).toHaveCount(0);
});

test("SHELL-INT-004 reaches and operates the shell with the keyboard alone", async ({ page }) => {
  await page.goto("/");

  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main")).toBeVisible();

  const themeToggle = page.getByRole("button", { name: /Switch to (dark|light) theme/ });
  await themeToggle.focus();
  await expect(themeToggle).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  const accountMenu = page.getByRole("button", { name: /Account menu for/ });
  await accountMenu.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();
  await expect(accountMenu).toHaveAttribute("aria-expanded", "false");
});

test("SHELL-INT-005 applies dark mode, remembers it, and paints it before first render", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("button", { name: "Switch to light theme" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  const darkCanvas = await page
    .locator("body")
    .evaluate((body) => getComputedStyle(body).backgroundColor);

  // Survives a reload with no flash: the attribute is present on first paint.
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const themeAtFirstPaint = await page.evaluate(
    () => document.documentElement.dataset.theme,
  );
  expect(themeAtFirstPaint).toBe("dark");
  expect(
    await page.locator("body").evaluate((body) => getComputedStyle(body).backgroundColor),
  ).toBe(darkCanvas);

  await page.getByRole("button", { name: "Switch to light theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("SHELL-INT-006 states plainly that a surface is not built yet", async ({ page }) => {
  await page.goto("/inbox");
  await expect(page.getByRole("heading", { name: "Your inbox is not built yet" })).toBeVisible();
  await expect(page.getByText(/arrive with C06/)).toBeVisible();

  // A channel nobody can see is refused rather than invented.
  await page.goto("/c/does-not-exist");
  await expect(page.getByRole("heading", { name: "Channel not available" })).toBeVisible();
  await expect(page.getByText(/only listed for its own members/)).toBeVisible();
});

test("SHELL-INT-007 says out loud that the development workspace is not a real one", async ({ page }) => {
  await page.goto("/");
  const notice = page.getByRole("status");
  await expect(notice).toContainText("Development workspace");
  await expect(notice).toContainText("not a real workspace");
});

test("SHELL-INT-008 shows the viewer's own profile from the shell data", async ({ page }, testInfo) => {
  await page.goto("/");
  await openRailIfNarrow(page, testInfo.project.name);
  await page.locator(".rail-foot a").click();

  await expect(page).toHaveURL(/\/profile$/);
  await expect(page.getByRole("heading", { name: "Profile", level: 1 })).toBeVisible();
  await expect(page.getByText("Maya Chen").first()).toBeVisible();
  await expect(page.getByText("@maya")).toBeVisible();
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

test("DESKTOP-INT-003 keeps the rail below the reserved native titlebar", async ({ page }) => {
  await page.goto("/");
  const browserTop = await page.locator(".rail").evaluate((rail) => rail.getBoundingClientRect().top);
  expect(browserTop).toBe(0);
  await expect(page.locator(".desktop-titlebar")).toBeHidden();

  await page.evaluate(() => {
    document.documentElement.dataset.desktopPlatform = "windows";
  });
  const desktopTop = await page.locator(".rail").evaluate((rail) => rail.getBoundingClientRect().top);
  expect(desktopTop).toBe(34);
});

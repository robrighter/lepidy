import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { freshAccount, signUp } from "./auth-helpers";

test.beforeEach(async ({ page }) => {
  await signUp(page, { ...freshAccount(), displayName: "Maya Chen", handle: "maya" });
  const cookie = (await page.context().cookies()).find((cookie) => cookie.name === "lepidy_session");
  expect(cookie).toBeDefined();
  const seeded = await page.request.post("/__fixture/seed", { headers: { authorization: cookie!.value } });
  expect(seeded.ok(), await seeded.text()).toBe(true);
});

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

test("ROOM-INT-013 renders channel history and tells a person from an agent", async ({ page }) => {
  await page.goto("/c/eng");
  await expect(page.getByRole("heading", { name: "#eng", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "#eng", level: 2 })).toBeVisible();

  const messages = page.locator(".messages > li");
  await expect(messages).toHaveCount(2);
  await expect(page.locator(".messages > li[data-author-kind=member]")).toContainText("Maya Chen");
  await expect(page.locator(".messages > li[data-author-kind=member]")).toContainText("failed-charge retry");
  await expect(page.locator(".messages > li[data-author-kind=member]")).toContainText("2 replies");
  // An agent is visibly an agent, not a person with an odd name.
  await expect(page.locator(".messages > li[data-author-kind=agent]")).toContainText("a.releasebot");
  await expect(page.locator(".messages > li[data-author-kind=agent]").getByText("agent")).toBeVisible();
  await expect(page.locator(".messages > li[data-author-kind=member]").getByText("agent")).toHaveCount(0);

  // A room with nothing in it says so rather than showing a blank panel.
  await page.goto("/c/release");
  await expect(page.getByRole("heading", { name: "No messages yet" })).toBeVisible();
  await expect(page.getByText(/start this room off/)).toBeVisible();
});

test("MSG-INT-008 renders markdown as elements and never as markup", async ({ page }) => {
  await page.goto("/c/eng");
  const agentMessage = page.locator(".messages > li[data-author-kind=agent]");

  // A fenced block is a real code element with its language shown.
  const code = agentMessage.locator("pre code");
  await expect(code).toHaveText("wrangler deploy --env production");
  await expect(agentMessage.locator("pre .code-language")).toHaveText("sh");
  await expect(agentMessage.locator(".markdown strong")).toHaveText("no rollbacks");
  await expect(agentMessage.locator(".markdown p code").first()).toHaveText("api@2.14.0");

  // A mention is classified by its prefix, and shown as one.
  const mention = agentMessage.locator(".mention");
  await expect(mention).toHaveText("@maya");
  await expect(mention).toHaveAttribute("data-mention-kind", "member");

  // A reaction shows its count and is announced to a screen reader.
  const reactions = page.locator(".messages > li[data-author-kind=member]").locator(".reactions li");
  await expect(reactions).toHaveCount(1);
  await expect(reactions.first()).toContainText("1");
});

test("MSG-INT-009 keeps focus, preserves a draft and separates Enter from Shift+Enter", async ({ page }) => {
  await page.goto("/c/eng");
  const composer = page.getByRole("textbox", { name: /Message #eng/ });
  await expect(composer).toBeVisible();

  // Shift+Enter adds a line rather than sending.
  await composer.click();
  await composer.type("first line");
  await page.keyboard.press("Shift+Enter");
  await composer.type("second line");
  await expect(composer).toHaveValue("first line\nsecond line");
  await expect(composer).toBeFocused();

  // The draft survives leaving the room and coming back.
  await page.goto("/c/release");
  await expect(page.getByRole("textbox", { name: /Message #release/ })).toHaveValue("");
  await page.goto("/c/eng");
  await expect(page.getByRole("textbox", { name: /Message #eng/ })).toHaveValue(
    "first line\nsecond line",
  );

  // Enter sends through the authenticated action and clears the spent draft.
  await page.getByRole("textbox", { name: /Message #eng/ }).click();
  await page.keyboard.press("Enter");
  await expect(page.locator(".messages > li")).toHaveCount(3);
  await expect(page.locator(".messages > li").filter({ hasText: "first line" })).toContainText("second line");
  await expect(page.getByRole("textbox", { name: /Message #eng/ })).toBeFocused();
  await expect(page.getByRole("textbox", { name: /Message #eng/ })).toHaveValue("");
});

test("SHELL-INT-006 states plainly that a surface is not built yet", async ({ page }) => {
  // The Inbox itself now carries approvals (V03) and says which of its other
  // tiers are still to come, rather than claiming the whole surface is absent.
  await page.goto("/inbox");
  await expect(page.getByRole("heading", { name: "Nothing is waiting on you" })).toBeVisible();
  await expect(page.getByText(/join them with C06/)).toBeVisible();

  // The vault is a real surface now (V03/V04), so the unbuilt example moved to
  // one that genuinely is: profile editing, which C07 owns.
  await page.goto("/profile");
  await expect(page.getByRole("heading", { name: "Editing your profile is not built yet" })).toBeVisible();
  await expect(page.getByText(/arrive with C07/)).toBeVisible();

  // A channel nobody can see is refused rather than invented.
  await page.goto("/c/does-not-exist");
  await expect(page.getByRole("heading", { name: "Channel not available" })).toBeVisible();
  await expect(page.getByText(/only listed for its own members/)).toBeVisible();
});

test("SHELL-INT-007 uses authenticated workspace data without a development banner", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Development workspace.")).toHaveCount(0);
  await expect(page.getByText("@maya")).toBeVisible();
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

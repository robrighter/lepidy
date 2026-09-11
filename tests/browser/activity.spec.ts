import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./harness";
import { freshAccount, signUp } from "./auth-helpers";

test.beforeEach(async ({ page }) => {
  await signUp(page, freshAccount());
  const cookie = (await page.context().cookies()).find((entry) => entry.name === "lepidy_session");
  const response = await page.request.post("/__fixture/activity", { headers: { authorization: cookie!.value } });
  expect(response.ok(), await response.text()).toBe(true);
});

test("C06-UI-INT-001 shows the same durable mention in ranked Home and actionable Inbox", async ({ page }) => {
  await page.goto("/workspace");
  const home = page.getByRole("region", { name: "What needs you" });
  await expect(home).toContainText("please review the launch note");
  await expect(home).toContainText("Mention");
  await expect(page.getByRole("link", { name: "Notifications, 1 unread" })).toBeVisible();
  await expect(page.locator(".rail a[href='/inbox'] .badge")).toHaveText("1");

  await page.goto("/inbox");
  await expect(page.getByText("1 unread · 1 mentions · 0 threads · 0 DMs")).toBeVisible();
  const card = page.locator(".activity-card").filter({ hasText: "please review the launch note" });
  await expect(card).toHaveCount(1);
  await card.getByRole("button", { name: "Mark read" }).click();
  await expect(card).toHaveCount(0);

  await page.getByRole("link", { name: "All" }).click();
  const readCard = page.locator(".activity-card").filter({ hasText: "please review the launch note" });
  await expect(readCard).toHaveCount(1);
  await expect(readCard.getByRole("button", { name: "Mark unread" })).toBeVisible();
});

test("C06-UI-INT-002 keeps the activity feed usable at narrow width", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile contract");
  await page.goto("/inbox?view=all");
  await expect(page.getByRole("heading", { name: "Messages for you" })).toBeVisible();
  await expect(page.locator(".activity-card").first()).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
  expect(
    (await new AxeBuilder({ page }).analyze()).violations.filter(
      ({ impact }) => impact === "serious" || impact === "critical",
    ),
  ).toEqual([]);
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator(".activity-card").first()).toBeVisible();
});

test("C06-UI-INT-003 saves keyword, DND and per-room preferences through a progressive form", async ({ page }) => {
  await page.goto("/inbox?view=all");
  const settings = page.getByRole("region", { name: "Notification settings" });
  await expect(settings.getByRole("combobox", { name: "Room", exact: true })).toBeVisible();
  await settings.getByRole("combobox", { name: "Room notifications" }).selectOption("everything");
  await settings.getByRole("textbox", { name: "Keyword alerts" }).fill("incident, launch");
  await settings.getByRole("textbox", { name: "DND starts (UTC)" }).fill("22:00");
  await settings.getByRole("textbox", { name: "DND ends (UTC)" }).fill("07:00");
  await settings.getByRole("button", { name: "Save notification settings" }).click();
  await expect(settings.getByRole("combobox", { name: "Room notifications" })).toHaveValue("everything");
  await expect(settings.getByRole("textbox", { name: "Keyword alerts" })).toHaveValue("incident, launch");
  await expect(settings.getByRole("textbox", { name: "DND starts (UTC)" })).toHaveValue("22:00");
  await expect(settings.getByRole("textbox", { name: "DND ends (UTC)" })).toHaveValue("07:00");
});

test("C06-UI-INT-004 confirms the exact broadcast audience before sending", async ({ page }) => {
  await page.goto("/inbox?view=all");
  await page.locator(".activity-card").first().getByRole("link", { name: "Open conversation" }).click();
  const composer = page.getByRole("textbox", { name: "Message #activity" });
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toBe("Notify 1 recipient with this broadcast?");
    await dialog.accept();
  });
  await composer.fill("@channel release is ready");
  await page.keyboard.press("Enter");
  await expect(page.locator(".messages > li").filter({ hasText: "release is ready" })).toHaveCount(1);
});

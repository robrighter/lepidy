import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./harness";
import { freshAccount, signUp } from "./auth-helpers";

test.beforeEach(async ({ page }) => {
  await signUp(page, freshAccount());
  const session = (await page.context().cookies()).find((cookie) => cookie.name === "lepidy_session");
  const seeded = await page.request.post("/__fixture/team-storage", { headers: { authorization: session!.value } });
  expect(seeded.ok(), await seeded.text()).toBe(true);
  await page.goto("/c/general");
});

test("C09-UI-INT-001 searches mixed workspace results, scopes a room and manages a saved query", async ({ page }, testInfo) => {
  await page.setInputFiles('input[type="file"]', {
    name: "Aurora runbook.txt", mimeType: "text/plain", buffer: Buffer.from("restart the aurora relay"),
  });
  await expect(page.locator(".composer-attachments li")).toHaveAttribute("data-state", "ready");
  const composer = page.getByRole("textbox", { name: /Message #general/ });
  await composer.fill("Aurora launch runbook");
  await page.keyboard.press("Enter");
  await expect(page.locator(".composer-attachments li")).toHaveCount(0);

  if (testInfo.project.name === "mobile-chromium") await page.getByRole("button", { name: "Open navigation" }).click();
  await page.locator(".search-button").click();
  await expect(page.getByRole("heading", { name: "Find the thread behind the work." })).toBeVisible();
  await page.getByRole("searchbox", { name: "Search workspace" }).fill("Aurora in:#general has:file");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator(".search-ledger li")).toHaveCount(2);
  await expect(page.locator(".search-ledger")).toContainText("Aurora launch runbook");
  await expect(page.locator(".search-ledger")).toContainText("Aurora runbook.txt");

  await page.getByLabel("Name this search").fill("General runbooks");
  await page.getByRole("button", { name: "Save current search" }).click();
  await expect(page.getByRole("status")).toContainText("Search saved");
  await expect(page.getByRole("link", { name: /General runbooks/ })).toContainText("in:#general");

  await page.locator(".search-ledger li").filter({ hasText: "Aurora launch runbook" }).getByRole("link").click();
  await expect(page).toHaveURL(/\/c\/general#message-/);
  const matchedMessage = page.locator('.message[id^="message-"]').filter({ hasText: "Aurora launch runbook" });
  await expect(matchedMessage).toBeVisible();
  expect(new URL(page.url()).hash).toBe(`#${await matchedMessage.getAttribute("id")}`);
  await page.getByRole("link", { name: "Search this room" }).click();
  await expect(page.getByRole("searchbox", { name: "Search workspace" })).toHaveValue("in:#general");

  if (testInfo.project.name === "mobile-chromium") {
    await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
    expect(
      (await new AxeBuilder({ page }).include("#main").analyze()).violations.filter(
        ({ impact }) => impact === "serious" || impact === "critical",
      ),
    ).toEqual([]);
  }
});

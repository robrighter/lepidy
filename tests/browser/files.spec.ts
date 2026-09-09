import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./harness";
import { freshAccount, signUp } from "./auth-helpers";

/**
 * The whole byte path against the built Worker: a real reservation through a
 * Server Action, real bytes through the transfer route into real R2, and a real
 * authorized download back out.
 */
test.beforeEach(async ({ page }) => {
  await signUp(page, freshAccount());
  // A fresh workspace is Solo, whose attachments live on its own host. Cloud
  // attachments are a Team capability, and real checkout is B01-B03.
  const session = (await page.context().cookies()).find((cookie) => cookie.name === "lepidy_session");
  const seeded = await page.request.post("/__fixture/team-storage", { headers: { authorization: session!.value } });
  expect(seeded.ok(), await seeded.text()).toBe(true);
  await page.goto("/c/general");
});

async function attach(page: import("@playwright/test").Page, name: string, mimeType: string, body: string) {
  await page.setInputFiles('input[type="file"]', { name, mimeType, buffer: Buffer.from(body) });
}

test("C08-UI-INT-001 attaches a file, sends it and serves it back only as a download", async ({ page }) => {
  await attach(page, "runbook.txt", "text/plain", "restart the relay");
  const pending = page.locator(".composer-attachments li");
  await expect(pending).toHaveCount(1);
  await expect(pending).toHaveAttribute("data-state", "ready");

  const composer = page.getByRole("textbox", { name: /Message #general/ });
  await composer.click();
  await composer.fill("here is the runbook");
  await page.keyboard.press("Enter");

  const attachment = page.locator(".messages .message-attachments a").filter({ hasText: "runbook.txt" });
  await expect(attachment).toBeVisible();
  // The composer clears once the message owns the file.
  await expect(page.locator(".composer-attachments li")).toHaveCount(0);

  const href = await attachment.getAttribute("href");
  const download = await page.request.get(href!);
  expect(download.status()).toBe(200);
  expect(await download.text()).toBe("restart the relay");
  // Attacker-supplied bytes are never served under a type the browser will act
  // on, and never inline.
  expect(download.headers()["content-type"]).toBe("application/octet-stream");
  expect(download.headers()["content-disposition"]).toContain("attachment");
  expect(download.headers()["x-content-type-options"]).toBe("nosniff");
});

test("C08-UI-INT-002 refuses a download to somebody who cannot see the room", async ({ page, browser }) => {
  await attach(page, "private.txt", "text/plain", "leadership only");
  // The composer refuses to send while a file is still in flight, so the
  // message only exists once the upload has landed.
  await expect(page.locator(".composer-attachments li")).toHaveAttribute("data-state", "ready");
  const composer = page.getByRole("textbox", { name: /Message #general/ });
  await composer.click();
  await composer.fill("attached");
  await page.keyboard.press("Enter");
  const href = await page.locator(".messages .message-attachments a").first().getAttribute("href");

  // A second, unrelated workspace must not be able to fetch it by id, and is
  // told it is missing rather than forbidden.
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await signUp(otherPage, freshAccount());
  const refused = await otherPage.request.get(href!);
  expect(refused.status()).toBe(404);
  // A signed-out request is refused before any lookup happens.
  const anonymous = await browser.newContext();
  expect((await anonymous.request.get(new URL(href!, "http://127.0.0.1:3100").toString())).status()).toBe(401);
  await other.close();
  await anonymous.close();
});

test("C08-UI-INT-003 pastes an image, shows it inline and stays accessible", async ({ page }, testInfo) => {
  // A 1x1 PNG, pasted the way a screenshot arrives.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  await page.setInputFiles('input[type="file"]', { name: "screenshot.png", mimeType: "image/png", buffer: png });
  await expect(page.locator(".composer-attachments li")).toHaveAttribute("data-state", "ready");
  const composer = page.getByRole("textbox", { name: /Message #general/ });
  await composer.click();
  await composer.fill("see attached");
  await page.keyboard.press("Enter");

  // An image the product recognises renders inline; it is still fetched from
  // the same authorized route.
  const image = page.locator(".messages .message-attachments img");
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute("alt", "screenshot.png");
  expect(await image.getAttribute("src")).toMatch(/^\/files\//);

  if (testInfo.project.name === "mobile-chromium") {
    await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
    expect(
      (await new AxeBuilder({ page }).include(".messages").analyze()).violations.filter(
        ({ impact }) => impact === "serious" || impact === "critical",
      ),
    ).toEqual([]);
  }
});

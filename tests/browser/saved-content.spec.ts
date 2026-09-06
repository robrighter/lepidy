import { expect, test } from "@playwright/test";

import { freshAccount, signUp } from "./auth-helpers";

/**
 * Message actions driven as a signed-in member against the built Worker, so
 * every one of these goes through the real authenticated write path.
 */
test.beforeEach(async ({ page }) => {
  await signUp(page, freshAccount());
});

async function post(page: import("@playwright/test").Page, body: string) {
  const composer = page.getByRole("textbox", { name: /Message #general/ });
  await composer.click();
  await composer.fill(body);
  await page.keyboard.press("Enter");
  await expect(page.locator(".messages > li").filter({ hasText: body })).toHaveCount(1);
}

test("MSG-INT-010 edits a message in place and marks it as edited", async ({ page }) => {
  await page.goto("/c/general");
  await post(page, "the deploy is amber");

  await page.getByRole("button", { name: "Edit this message" }).click();
  const editor = page.getByRole("textbox", { name: "Edit message" });
  await editor.fill("the deploy is green");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  const message = page.locator(".messages > li").first();
  await expect(message).toContainText("the deploy is green");
  await expect(message).not.toContainText("amber");
  await expect(message.getByText("edited")).toBeVisible();

  // It is the stored message that changed, not just the screen.
  await page.reload();
  await expect(page.locator(".messages > li").first()).toContainText("the deploy is green");
});

test("MSG-INT-011 deletes a message and leaves a tombstone rather than a hole", async ({ page }) => {
  await page.goto("/c/general");
  await post(page, "MSG_DELETE_CANARY");

  await page.getByRole("button", { name: "Delete this message" }).click();
  await expect(page.getByText("This message was deleted.")).toBeVisible();
  await expect(page.locator(".messages")).not.toContainText("MSG_DELETE_CANARY");

  await page.reload();
  await expect(page.getByText("This message was deleted.")).toBeVisible();
  await expect(page.locator(".messages")).not.toContainText("MSG_DELETE_CANARY");
});

test("MSG-INT-012 reacts and takes the reaction back", async ({ page }) => {
  await page.goto("/c/general");
  await post(page, "shipped it");

  const react = page.getByRole("button", { name: "React with \u{1F525}" });
  await react.click();
  await expect(page.locator(".reactions li")).toHaveCount(1);
  await expect(page.locator(".reactions li").first()).toContainText("1");

  await page.reload();
  const remove = page.getByRole("button", { name: "Remove \u{1F525} reaction" });
  await expect(remove).toHaveAttribute("aria-pressed", "true");
  await remove.click();
  await expect(page.locator(".reactions li")).toHaveCount(0);
});

test("MSG-INT-013 pins a message for the room and unpins it again", async ({ page }) => {
  await page.goto("/c/general");
  await post(page, "read the runbook first");

  await page.getByRole("button", { name: "Pin to this channel" }).click();
  const pinned = page.getByRole("region", { name: "Pinned messages" });
  await expect(pinned).toBeVisible();
  await expect(pinned).toContainText("read the runbook first");
  await expect(page.locator(".messages > li").first().locator(".message-meta .tag")).toContainText(
    "pinned",
  );

  await page.reload();
  await page.getByRole("button", { name: "Unpin from this channel" }).click();
  await expect(page.getByRole("region", { name: "Pinned messages" })).toHaveCount(0);
});

test("SAVED-INT-005 saves a message to a private list and removes it again", async ({ page }) => {
  await page.goto("/c/general");
  await post(page, "worth keeping for later");

  await page.goto("/saved");
  await expect(page.getByRole("heading", { name: "Nothing saved yet" })).toBeVisible();

  await page.goto("/c/general");
  await page.getByRole("button", { name: "Save this message" }).click();
  await expect(page.getByRole("button", { name: "Remove from saved" })).toBeVisible();

  await page.goto("/saved");
  await expect(page.getByRole("heading", { name: "Saved", level: 2 })).toBeVisible();
  await expect(page.locator(".messages > li")).toHaveCount(1);
  await expect(page.locator(".messages > li").first()).toContainText("worth keeping for later");

  await page.getByRole("button", { name: "Remove from saved" }).click();
  await expect(page.getByRole("heading", { name: "Nothing saved yet" })).toBeVisible();
});

test("SAVED-INT-006 offers Saved from the rail", async ({ page }, testInfo) => {
  await page.goto("/");
  if (testInfo.project.name === "mobile-chromium") {
    await page.getByRole("button", { name: "Open navigation" }).click();
  }
  await page.getByRole("link", { name: "Saved" }).click();
  await expect(page).toHaveURL(/\/saved$/);
  await expect(
    page.locator(".rail nav[aria-label='Primary'] a[aria-current='page']"),
  ).toHaveText("Saved");
});

test("FORWARD-INT-005 forwards a message into another room, carrying its provenance", async ({
  page,
}) => {
  // A second room to forward into, created through the production authority.
  const cookie = (await page.context().cookies()).find((entry) => entry.name === "lepidy_session");
  const seeded = await page.request.post("/__fixture/seed", {
    headers: { authorization: cookie!.value },
  });
  expect(seeded.ok(), await seeded.text()).toBe(true);

  await page.goto("/c/eng");
  const source = page.locator(".messages > li").filter({ hasText: "failed-charge retry" });
  await expect(source).toHaveCount(1);

  await source.getByRole("button", { name: "Forward this message" }).click();
  const picker = page.getByRole("group", { name: "Forward to a channel" });
  await expect(picker).toBeVisible();
  await picker.getByRole("button", { name: "#release" }).click();
  // The picker closes only once the forward has actually been accepted, so this
  // waits on the outcome rather than on the click.
  await expect(picker).toHaveCount(0);
  await expect(page.locator(".message-error")).toHaveCount(0);

  await page.goto("/c/release");
  const copy = page.locator(".messages > li").filter({ hasText: "failed-charge retry" });
  await expect(copy).toHaveCount(1);
  // The copy names where it came from, because this reader can see that room.
  await expect(copy).toContainText("Forwarded from");
  await expect(copy).toContainText("in #eng");

  // It is a real message in this room, durable like any other.
  await page.reload();
  await expect(
    page.locator(".messages > li").filter({ hasText: "failed-charge retry" }),
  ).toHaveCount(1);
});

test("MSG-INT-014 reveals older messages without disturbing what is already on screen", async ({
  page,
}) => {
  // Seeded through the production authority in one call: this scenario is about
  // paging a long history, and posting it a message at a time is covered
  // elsewhere and heavy enough to be the thing that fails instead.
  const cookie = (await page.context().cookies()).find((entry) => entry.name === "lepidy_session");
  const seeded = await page.request.post("/__fixture/bulk", {
    headers: { authorization: cookie!.value },
    data: { slug: "paging", count: 21 },
  });
  expect(seeded.ok(), await seeded.text()).toBe(true);

  await page.goto("/c/paging");
  await expect(page.locator(".messages > li")).toHaveCount(20);
  await expect(page.getByRole("link", { name: "Show older messages" })).toBeVisible();
  // The newest is on screen and the oldest is not.
  await expect(page.locator(".messages")).toContainText("paged message 20");
  await expect(page.locator(".messages")).not.toContainText("paged message 0");

  await page.getByRole("link", { name: "Show older messages" }).click();
  await expect(page.locator(".messages > li")).toHaveCount(21);
  // Revealing older messages keeps everything that was already there.
  await expect(page.locator(".messages")).toContainText("paged message 0");
  await expect(page.locator(".messages")).toContainText("paged message 20");
  await expect(page.getByText("You have reached the start of this room.")).toBeVisible();
});

test("DRAFT-INT-006 syncs a draft to the server so it survives more than this browser", async ({
  page,
  context,
}) => {
  await page.goto("/c/general");
  const composer = page.getByRole("textbox", { name: /Message #general/ });
  await composer.click();
  await composer.fill("a thought I have not finished");
  await expect(page.getByText("Draft saved")).toBeVisible();

  // A different browser context carrying the same session is another device.
  const session = (await context.cookies()).find((entry) => entry.name === "lepidy_session");
  const csrf = (await context.cookies()).find((entry) => entry.name === "lepidy_csrf");
  const second = await context.browser()!.newContext();
  await second.addCookies(
    [session!, csrf!].map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
    })),
  );
  const other = await second.newPage();
  await other.goto("/c/general");
  await expect(other.getByRole("textbox", { name: /Message #general/ })).toHaveValue(
    "a thought I have not finished",
  );
  await other.close();
  await second.close();

  // Sending spends the draft everywhere, not only in this browser.
  await composer.click();
  await page.keyboard.press("Enter");
  await expect(page.locator(".messages > li")).toHaveCount(1);
  await page.reload();
  await expect(page.getByRole("textbox", { name: /Message #general/ })).toHaveValue("");
});

test("SCHED-MSG-INT-008 schedules a message for later and can take it back", async ({ page }) => {
  await page.goto("/c/general");
  const composer = page.getByRole("textbox", { name: /Message #general/ });
  await composer.click();
  await composer.fill("SCHEDULED_BROWSER_CANARY");

  await page.getByRole("button", { name: "Schedule this message for later" }).click();
  const when = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 16);
  await page.getByLabel("Send at").fill(when);
  await page.getByRole("button", { name: "Schedule", exact: true }).click();
  // The panel closes only once the schedule has been accepted, so this waits on
  // the outcome rather than on the click.
  await expect(page.getByLabel("Send at")).toHaveCount(0);
  await expect(page.locator(".composer-error")).toHaveCount(0);

  // It is waiting, not posted.
  await expect(page.locator(".messages > li")).toHaveCount(0);
  await page.goto("/scheduled");
  await expect(page.getByRole("heading", { name: "Scheduled", level: 2 })).toBeVisible();
  const entry = page.locator(".scheduled-list li");
  await expect(entry).toHaveCount(1);
  await expect(entry).toContainText("SCHEDULED_BROWSER_CANARY");
  await expect(entry.locator(".tag")).toHaveText("scheduled");

  await entry.getByRole("button", { name: /^Cancel the message scheduled/ }).click();
  await expect(page.getByRole("heading", { name: "Nothing scheduled" })).toBeVisible();

  // Cancelling means it never arrives in the room.
  await page.goto("/c/general");
  await expect(page.locator(".messages")).toHaveCount(0);
});

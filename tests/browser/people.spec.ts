import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./harness";
import { freshAccount, signUp } from "./auth-helpers";

/**
 * What each scenario's own sign-up produced, so a test can address the member
 * it created by handle. Keyed by test id because the suite is fully parallel.
 */
const seeded = new Map<string, { viewerHandle: string; graceHandle: string }>();

test.beforeEach(async ({ page }, testInfo) => {
  const account = freshAccount();
  await signUp(page, account);
  const session = (await page.context().cookies()).find((cookie) => cookie.name === "lepidy_session");
  const response = await page.request.post("/__fixture/people", { headers: { authorization: session!.value } });
  expect(response.ok(), await response.text()).toBe(true);
  const { handle } = (await response.json()) as { handle: string };
  seeded.set(testInfo.testId, { viewerHandle: account.handle, graceHandle: handle });
});

test("C07-UI-INT-001 renders the directory and persists a creator-managed group", async ({ page }) => {
  await page.goto("/people");
  await expect(page.getByRole("link", { name: "People" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Grace Hopper" })).toBeVisible();
  await expect(page.getByText("Timezone not set").first()).toBeVisible();

  const create = page.locator("form").filter({ has: page.getByRole("button", { name: "Create group" }) });
  await create.getByLabel("Handle").fill("g.platform");
  await create.getByLabel("Name").fill("Platform");
  await create.getByLabel("Grace Hopper").check();
  await create.getByRole("button", { name: "Create group" }).click();
  await expect(page.getByRole("status")).toContainText("Group created");
  await expect(page.getByRole("heading", { name: "@g.platform" })).toBeVisible();
  await expect(page.getByText("Platform · 1 active member")).toBeVisible();
});

test("C07-UI-INT-002 saves timezone, working hours and custom status on the real profile", async ({ page }) => {
  await page.goto("/profile");
  await page.getByLabel("Title").fill("Engineering");
  await page.getByLabel("Custom status").fill("Shipping the directory");
  await page.getByLabel("Timezone").fill("America/New_York");
  await page.getByLabel("Working day starts").fill("09:00");
  await page.getByLabel("Working day ends").fill("17:30");
  // A declared availability has to survive being connected, which the viewer
  // demonstrably is: this very page was served over their own session.
  await page.getByLabel("Availability").selectOption("focus");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByRole("status")).toContainText("Profile saved");
  await expect(page.getByLabel("Timezone")).toHaveValue("America/New_York");
  await expect(page.getByLabel("Availability")).toHaveValue("focus");
  await page.goto("/people");
  await expect(page.getByText("Shipping the directory")).toBeVisible();
  await expect(page.getByText("09:00–17:30")).toBeVisible();
  const self = page.locator(".person-card").filter({ hasText: "Ada Lovelace" });
  await expect(self.locator(".presence-dot")).toHaveClass(/focus/);
  await expect(self).toContainText("Focus");

  // Clearing it hands the dot back to live connections. The browser shell has
  // no live-delivery client yet, so that derives Offline rather than Online —
  // what matters here is that the declaration stopped being asserted.
  await page.goto("/profile");
  await page.getByLabel("Availability").selectOption("auto");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByRole("status")).toContainText("Profile saved");
  await page.goto("/people");
  const cleared = page.locator(".person-card").filter({ hasText: "Ada Lovelace" });
  await expect(cleared.locator(".presence-dot")).not.toHaveClass(/focus/);
  await expect(cleared).toContainText("Offline");
});

test("C07-UI-INT-003 holds a Solo invitation and supports explicit cancellation", async ({ page }) => {
  await page.goto("/people");
  const admin = page.locator("section").filter({ has: page.getByRole("heading", { name: "Workspace administration" }) });
  await admin.getByLabel("Email").fill("next-person@example.test");
  await admin.getByLabel("Invitation role").selectOption("member");
  await admin.getByRole("button", { name: "Invite person" }).click();
  await expect(page.getByRole("status")).toContainText("held until an administrator confirms");
  const invitation = page.locator(".admin-row").filter({ hasText: "next-person@example.test" });
  await expect(invitation).toContainText("Held for seat confirmation");
  await invitation.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("status")).toContainText("Invitation canceled");
  await expect(page.getByText("next-person@example.test")).toHaveCount(0);
});

test("C07-UI-INT-004 offboards through authenticated authority and retains the tombstone", async ({ page }) => {
  await page.goto("/people");
  const member = page.locator(".admin-row").filter({ hasText: "Grace Hopper" });
  await member.getByRole("button", { name: "Offboard" }).click();
  await expect(page.getByRole("status")).toContainText("active authority revoked");
  const removed = page.locator(".admin-row").filter({ hasText: "Grace Hopper" });
  await expect(removed).toContainText("removed");
  await expect(page.locator(".person-card").filter({ hasText: "Grace Hopper" })).toHaveAttribute("data-member-status", "removed");
});

test("C07-UI-INT-005 remains keyboard-accessible, responsive and readable in dark mode", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile contract");
  await page.goto("/people");
  await expect(page.getByRole("heading", { name: "People", exact: true, level: 2 })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
  expect((await new AxeBuilder({ page }).analyze()).violations.filter(({ impact }) => impact === "serious" || impact === "critical")).toEqual([]);
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("heading", { name: "Workspace administration" })).toBeVisible();
});

test("C07-UI-INT-006 shows the saved profile and a group's real membership as mention hovercards", async ({ page }, testInfo) => {
  const { viewerHandle } = seeded.get(testInfo.testId)!;

  // The card is the directory arriving at the message, so it must show what
  // the person actually saved rather than a second, separately-edited copy.
  await page.goto("/profile");
  await page.getByLabel("Title").fill("Engineering");
  await page.getByLabel("Custom status").fill("Shipping the directory");
  await page.getByLabel("Timezone").fill("Europe/Berlin");
  await page.getByLabel("Working day starts").fill("09:00");
  await page.getByLabel("Working day ends").fill("17:30");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByRole("status")).toContainText("Profile saved");

  await page.goto("/people");
  const create = page.locator("form").filter({ has: page.getByRole("button", { name: "Create group" }) });
  await create.getByLabel("Handle").fill("g.platform");
  await create.getByLabel("Name").fill("Platform");
  await create.getByLabel("Description").fill("Runtime and storage");
  // Creating a group does not join it, so both members are chosen explicitly.
  await create.getByLabel("Ada Lovelace").check();
  await create.getByLabel("Grace Hopper").check();
  await create.getByRole("button", { name: "Create group" }).click();
  await expect(page.getByRole("heading", { name: "@g.platform" })).toBeVisible();

  // An agent is created too, because mentioning one hands the message to every
  // owner and PRD §6.2 requires those owners named wherever the agent appears.
  await page.goto("/agents");
  await page.getByLabel("Handle").fill("triage");
  await page.getByLabel("What it does").fill("Sorts the queue");
  await page.getByRole("button", { name: "Create agent" }).click();
  await expect(page.getByText("@a.triage").first()).toBeVisible();

  await page.goto("/c/general");
  const composer = page.getByRole("textbox", { name: /Message #general/ });
  await composer.click();
  await composer.fill(`morning @${viewerHandle} and @g.platform and @a.triage`);
  await page.keyboard.press("Enter");
  // A second message mentioning the same people: every card needs its own DOM
  // id, or `aria-describedby` on the later mention resolves to the earlier card.
  await expect(page.locator(".messages > li")).toHaveCount(1);
  await composer.click();
  await composer.fill(`and again @${viewerHandle}`);
  await page.keyboard.press("Enter");
  await expect(page.locator(".messages > li")).toHaveCount(2);
  const cardIds = await page.locator(".messages .mention-card").evaluateAll((nodes) => nodes.map((node) => node.id));
  expect(cardIds.length).toBeGreaterThan(1);
  expect(new Set(cardIds).size).toBe(cardIds.length);

  const personMention = page.locator(".messages > li").first().locator(".mention-anchor").filter({ hasText: `@${viewerHandle}` });
  const personCard = personMention.locator(".mention-card");
  await expect(personCard).toBeHidden();
  await personMention.hover();
  await expect(personCard).toBeVisible();
  await expect(personCard).toContainText("Ada Lovelace");
  await expect(personCard).toContainText("owner · Engineering");
  await expect(personCard).toContainText("Shipping the directory");
  await expect(personCard).toContainText("Europe/Berlin");
  await expect(personCard).toContainText("09:00–17:30");

  // The card is reachable without a pointer, and describes the name it belongs
  // to rather than floating unattached in the accessibility tree.
  const groupMention = page.locator(".messages .mention-anchor").filter({ hasText: "@g.platform" });
  const groupName = groupMention.locator(".mention");
  await groupName.focus();
  const groupCard = groupMention.locator(".mention-card");
  await expect(groupCard).toBeVisible();
  await expect(groupName).toHaveAttribute("aria-describedby", (await groupCard.getAttribute("id"))!);
  await expect(groupCard).toContainText("Platform");
  await expect(groupCard).toContainText("2 active members");
  await expect(groupCard).toContainText("Ada Lovelace");
  await expect(groupCard).toContainText("Grace Hopper");

  const agentMention = page.locator(".messages .mention-anchor").filter({ hasText: "@a.triage" });
  const agentCard = agentMention.locator(".mention-card");
  await agentMention.hover();
  await expect(agentCard).toBeVisible();
  await expect(agentCard).toContainText("agent");
  await expect(agentCard).toContainText("Owned by Ada Lovelace");

  // Hovercards must not make the room scroll sideways, and must stay readable
  // in dark mode where they sit on their own raised surface.
  await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await groupMention.hover();
  await expect(groupCard).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).include(".messages").analyze()).violations.filter(
      ({ impact }) => impact === "serious" || impact === "critical",
    ),
  ).toEqual([]);
});

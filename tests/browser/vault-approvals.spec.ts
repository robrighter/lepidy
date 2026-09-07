import { expect, test } from "@playwright/test";

import { LOCALHOST_BASE } from "./device-helpers";
import { CANARY, registerPasskey, requestRelease, seedAskCredential } from "./vault-helpers";

/**
 * Approval as a conversation, end to end in a browser.
 *
 * A credential that asks every time is requested by a device, the card arrives
 * in the Inbox and as a message from `@a.vault`, and a person answers it — with
 * a real WebAuthn assertion for allow and with nothing at all for deny. The
 * gesture is made by a virtual authenticator, so the assertion the server
 * verifies is a genuine one rather than a stub.
 */

test("VAULT-APPROVAL-INT-001 asks a person, is answered with a real gesture, and only then releases", async ({
  page,
}) => {
  const fixture = await seedAskCredential(page);

  // An ask-every-time credential is not released; a card is raised instead.
  const asked = await requestRelease(page, fixture);
  expect(asked.status()).toBe(200);
  const pending = (await asked.json()) as {
    results: { decision: { kind: string } }[];
    approvals: { approvalId: string; hint: string }[];
  };
  expect(pending.results[0].decision).toEqual({ kind: "needs_approval" });
  expect(pending.approvals).toHaveLength(1);
  expect(pending.approvals[0].hint).toContain("do not retry in a loop");
  expect(await asked.text()).not.toContain(CANARY);

  // The card is in the Inbox, carrying every fact the approver needs.
  await page.goto(`${LOCALHOST_BASE}/inbox`);
  const card = page.getByRole("article").first();
  await expect(card).toContainText("wants a credential");
  await expect(card).toContainText("deploy the staging migration");
  await expect(card).toContainText("ASK_TOKEN");
  await expect(card).toContainText("High risk");
  await expect(card).toContainText("no answer is a denial");
  await expect(page.getByRole("button", { name: "Deny" })).toBeEnabled();

  // Allowing needs a passkey; until there is one the page says so rather than
  // offering a button that cannot work.
  await expect(card).toContainText("Allowing needs a passkey");
  await expect(page.getByRole("button", { name: /^Allow/ }).first()).toBeDisabled();

  await registerPasskey(page);
  await page.goto(`${LOCALHOST_BASE}/inbox`);
  const allow = page.getByRole("button", { name: "Allow once" });
  await expect(allow).toBeEnabled();
  await allow.click();
  await expect(page.getByText("Nothing is waiting on you")).toBeVisible();

  // The grant the gesture issued is the one the release path honours, and the
  // value still crosses the wire sealed.
  const released = await requestRelease(page, fixture);
  const payload = (await released.json()) as {
    results: { decision: { kind: string; via?: string }; envelope?: unknown }[];
  };
  expect(payload.results[0].decision).toEqual({ kind: "allow", via: "grant" });
  expect(payload.results[0].envelope).toBeDefined();
  expect(await released.text()).not.toContain(CANARY);

  // "Allow once" is spent by that one use, so the next request asks again
  // rather than riding on the answer somebody already gave.
  const again = (await (await requestRelease(page, fixture)).json()) as {
    results: { decision: { kind: string } }[];
    approvals: unknown[];
  };
  expect(again.results[0].decision.kind).toBe("needs_approval");
  expect(again.approvals).toHaveLength(1);

  // The card and its answer are a real conversation with @a.vault, readable
  // where the person already is — not a notification that vanishes.
  // Followed by its address rather than by clicking the rail, so the scenario
  // proves the conversation exists at both viewports rather than proving where
  // a narrow layout happens to put the rail.
  await page.goto(`${LOCALHOST_BASE}/`);
  const conversation = await page
    .getByRole("link", { name: "a.vault", exact: true })
    .first()
    .getAttribute("href");
  await page.goto(`${LOCALHOST_BASE}${conversation}`);
  await expect(page.getByText("deploy the staging migration").first()).toBeVisible();
  await expect(page.getByText("ASK_TOKEN").first()).toBeVisible();
  // The answer is a reply on the card, so a second owner opening it sees who
  // decided rather than an open request.
  await expect(page.getByText(/repl(y|ies)/).first()).toBeVisible();
  // The conversation carries the question and the answer, and never the value.
  expect(await page.content()).not.toContain(CANARY);
});

test("VAULT-APPROVAL-INT-002 lets anyone deny with no gesture, before the page has hydrated", async ({ browser }) => {
  // Scripting off, so nothing on this page can ever hydrate: denying has to be
  // the action that always works, including on a phone that has not finished
  // loading.
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  const fixture = await seedAskCredential(page);
  const asked = await requestRelease(page, fixture);
  expect(((await asked.json()) as { approvals: unknown[] }).approvals).toHaveLength(1);

  await page.goto(`${LOCALHOST_BASE}/inbox`);
  await expect(page.getByRole("article").first()).toContainText("ASK_TOKEN");
  // The allow buttons say plainly that they are not ready, rather than
  // pretending to work.
  await expect(page.getByRole("article").first()).toContainText("Allowing needs");
  await page.getByRole("button", { name: "Deny" }).click();
  await expect(page.getByText("Nothing is waiting on you")).toBeVisible();

  // And the denial is real: the next request is refused rather than released.
  const after = (await (await requestRelease(page, fixture)).json()) as {
    results: { decision: { kind: string } }[];
    approvals: unknown[];
  };
  expect(after.results[0].decision.kind).toBe("needs_approval");
  expect(after.approvals).toHaveLength(1);
  await context.close();
});

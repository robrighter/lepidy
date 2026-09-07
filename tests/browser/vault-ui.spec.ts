import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { freshAccount, signUp } from "./auth-helpers";
import { LOCALHOST_BASE } from "./device-helpers";
import { CANARY, registerPasskey, requestRelease, seedAskCredential, seedCapturedCredential } from "./vault-helpers";

/**
 * The vault and agent pages, driven against the built Worker.
 *
 * These are the screens somebody opens when they think something is wrong, so
 * what is tested is what they can find out and what they can do about it: who
 * is holding a credential right now, who let them, how to take it back, and how
 * to switch something off. And, throughout, that a remote page which renders
 * all of that never receives a value.
 */

test("VAULT-UI-INT-001 shows who holds a credential, who approved it, and takes it back", async ({ page }) => {
  // An hour's TTL, so the approver is offered a timed window and the grant that
  // results is one somebody can watch and revoke rather than a single use.
  const fixture = await seedAskCredential(page, { grantTtlMs: 60 * 60_000 });
  await registerPasskey(page);
  await requestRelease(page, fixture);

  await page.goto(`${LOCALHOST_BASE}/inbox`);
  await page.getByRole("button", { name: "Allow for 15 minutes" }).click();
  await expect(page.getByText("Nothing is waiting on you")).toBeVisible();

  await page.goto(`${LOCALHOST_BASE}/vault`);
  // The overview counts what is live and what is waiting.
  await expect(page.getByRole("heading", { name: "Vault", exact: true, level: 2 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Live grants", level: 2 })).toBeVisible();

  const grants = page.getByRole("table").first();
  await expect(grants).toContainText("ASK_TOKEN");
  // Who has it, and who let them: two different people-shaped facts, kept apart.
  await expect(grants).toContainText(`@${fixture.account.handle}`);
  await expect(grants).toContainText("approved by @");
  await expect(grants).toContainText("Injected");

  // Nothing on this page is the value, and nothing on it could be.
  expect(await page.content()).not.toContain(CANARY);

  // The grant is honoured while it stands.
  const held = (await (await requestRelease(page, fixture)).json()) as {
    results: { decision: { kind: string; via?: string } }[];
  };
  expect(held.results[0].decision).toEqual({ kind: "allow", via: "grant" });

  // Taking it back is one button, and it takes effect immediately.
  await page.getByRole("button", { name: "Revoke" }).first().click();
  await expect(page.getByText("No credential is released right now.")).toBeVisible();
  const after = (await (await requestRelease(page, fixture)).json()) as {
    results: { decision: { kind: string } }[];
  };
  expect(after.results[0].decision.kind).toBe("needs_approval");
});

test("VAULT-UI-INT-002 describes a credential without ever being able to show it", async ({ page }) => {
  const fixture = await seedAskCredential(page);
  await requestRelease(page, fixture);

  await page.goto(`${LOCALHOST_BASE}/vault`);
  await page.getByRole("link", { name: /ASK_TOKEN/ }).click();
  await expect(page).toHaveURL(new RegExp(`/vault/${fixture.credentialId}$`));

  // What it is, how it can reach an agent, and the three separate privileges.
  await expect(page.getByRole("heading", { name: "ASK_TOKEN" })).toBeVisible();
  await expect(page.getByText("Only your own clients can unlock this.")).toBeVisible();
  await expect(page.getByText(/Injected — the default/)).toBeVisible();
  await expect(page.getByText(/Revealed — off/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Who can do what" })).toBeVisible();
  await expect(page.getByText("Asks a human every time")).toBeVisible();

  // The access log distinguishes the request from its answer, and carries the
  // requester's own reason.
  await expect(page.getByText("deploy the staging migration").first()).toBeVisible();
  expect(await page.content()).not.toContain(CANARY);

  // The densest new markup in the product, checked in both themes: a page
  // somebody reads in a hurry has to be readable.
  for (const theme of ["light", "dark"] as const) {
    if (theme === "dark") await page.getByRole("button", { name: "Switch to dark theme" }).click();
    const results = await new AxeBuilder({ page }).analyze();
    expect(
      results.violations.filter(({ impact }) => impact === "serious" || impact === "critical").map(({ id }) => id),
      `the credential page in ${theme} mode`,
    ).toEqual([]);
  }

  // A credential this member has no rights to is missing, not forbidden — the
  // page cannot be used to ask which credentials exist.
  await page.goto(`${LOCALHOST_BASE}/vault/credential-somebody-elses`);
  await expect(page.getByRole("heading", { name: "Credential not available" })).toBeVisible();
  await expect(page.getByText(/only listed for the people it is shared with/)).toBeVisible();
});

test("VAULT-UI-INT-003 cuts one agent off from the vault without silencing it, with no scripting", async ({
  browser,
}) => {
  // Scripting off: switching something off has to work before a page can
  // hydrate, because that is when somebody reaches for it.
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  const account = freshAccount();
  await signUp(page, account, LOCALHOST_BASE);

  await page.goto(`${LOCALHOST_BASE}/agents`);
  await page.getByLabel("Handle").fill("switchbot");
  await page.getByLabel("What it does").fill("Watches deploys");
  await page.getByRole("button", { name: "Create agent" }).click();
  const listed = page.getByRole("link", { name: "@a.switchbot", exact: true });
  await expect(listed).toBeVisible();

  await listed.click();
  await expect(page.getByRole("heading", { name: "@a.switchbot" })).toBeVisible();
  await expect(page.getByText("on, under each credential's own policy")).toBeVisible();

  await page.getByRole("button", { name: "Switch its vault access off" }).click();
  await expect(page.getByText("This agent cannot use any credential.")).toBeVisible();
  // Still active: the vault switch and the pause are different controls.
  await expect(page.getByText(/It is still active and can keep working/)).toBeVisible();
  await expect(page.getByRole("definition").filter({ hasText: "switched off" })).toBeVisible();

  // Switching it back on is the direction that needs a person, and the page
  // says so rather than offering a button that cannot work.
  await expect(page.getByRole("button", { name: "Switch its vault access on" })).toBeDisabled();
  await expect(page.getByText(/needs a passkey on your account/)).toBeVisible();
  await context.close();
});

test("VAULT-UI-INT-004 shows a captured credential as unusable until somebody confirms it", async ({ page }) => {
  const fixture = await seedCapturedCredential(page);

  await page.goto(`${LOCALHOST_BASE}/vault/${fixture.credentialId}`);
  await expect(page.getByRole("heading", { name: "CAPTURED_TOKEN" })).toBeVisible();
  // The page says what produced it and why it cannot be used yet, which is the
  // whole point of letting an agent create one at all.
  // The description says it too, so the banner is addressed specifically.
  await expect(page.getByText(/Captured from .* and switched off/)).toBeVisible();
  await expect(page.getByText(/cannot make one usable/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm this capture" })).toBeVisible();

  // And it really is unusable: a release is refused while it waits.
  const refused = (await (await requestRelease(page, fixture)).json()) as {
    results: { decision: { kind: string; reason?: string } }[];
  };
  expect(refused.results[0].decision).toEqual({ kind: "deny", reason: "credential_frozen" });

  await registerPasskey(page);
  await page.goto(`${LOCALHOST_BASE}/vault/${fixture.credentialId}`);
  await page.getByRole("button", { name: "Confirm this capture" }).click();
  await expect(page.getByText(/cannot make one usable/)).toBeHidden();

  // Confirmed, it behaves like any other ask-every-time credential.
  const asked = (await (await requestRelease(page, fixture)).json()) as {
    results: { decision: { kind: string } }[];
  };
  expect(asked.results[0].decision.kind).toBe("needs_approval");
});

import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
/**
 * The authenticated path, end to end against real local bindings: real D1, a
 * real workspace Durable Object and a real session cookie. Each run creates its
 * own account so the suite never depends on data a previous run left behind.
 */
const accountsPerTest = new Map<string, number>();

export function freshAccount() {
  const testId = test.info().testId;
  const ordinal = accountsPerTest.get(testId) ?? 0;
  accountsPerTest.set(testId, ordinal + 1);
  const id = createHash("sha256").update(`${testId}:${ordinal}`).digest("hex").slice(0, 12);
  return {
    email: `signup-${id}@example.test`,
    password: "correct horse battery staple",
    displayName: "Ada Lovelace",
    handle: `ada${id.slice(0, 6)}`,
    workspaceName: `Workspace ${id.slice(0, 6)}`,
  };
}

/**
 * `origin` exists for the one suite that cannot use the default host: WebAuthn
 * refuses a bare IP address as a relying party, so the approval scenarios sign
 * up on `localhost` and stay there.
 */
export async function signUp(page: Page, account: ReturnType<typeof freshAccount>, origin = "") {
  await page.goto(`${origin}/signup`);
  await page.getByLabel("Your name").fill(account.displayName);
  await page.getByLabel("Handle").fill(account.handle);
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByLabel("Workspace name").fill(account.workspaceName);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/$/);
}



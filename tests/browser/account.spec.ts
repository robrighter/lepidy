import { expect, test } from "./harness";

import { freshAccount, signUp } from "./auth-helpers";

test("AUTH-INT-001 signs up into a real workspace and posts a message that persists", async ({
  page,
}) => {
  const account = freshAccount();
  await signUp(page, account);

  // Landed in the shell, signed in, with no development-data banner.
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: account.workspaceName, level: 2 })).toBeVisible();
  await expect(page.getByText("Development workspace.")).toHaveCount(0);
  await expect(page.getByText(`@${account.handle}`)).toBeVisible();

  // A new workspace has somewhere to talk.
  await page.goto("/c/general");
  await expect(page.getByRole("heading", { name: "#general", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No messages yet" })).toBeVisible();

  // The composer's authenticated write path, for real.
  const body = `first real message ${account.handle}`;
  const composer = page.getByRole("textbox", { name: /Message #general/ });
  await composer.click();
  await composer.fill(body);
  await page.keyboard.press("Enter");

  await expect(page.locator(".messages > li")).toHaveCount(1);
  await expect(page.locator(".messages > li").first()).toContainText(body);
  await expect(page.locator(".messages > li").first()).toContainText(account.displayName);
  await expect(page.locator(".composer-error")).toHaveCount(0);
  // The caret stays where the next word belongs, and the draft is spent.
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue("");

  // It is durable, not just on screen.
  await page.reload();
  await expect(page.locator(".messages > li").first()).toContainText(body);
});

test("AUTH-INT-002 signs out, revokes the session and refuses the workspace afterwards", async ({
  page,
}) => {
  const account = freshAccount();
  await signUp(page, account);
  await expect(page).toHaveURL(/\/$/);

  const sessionCookie = (await page.context().cookies()).find(
    (cookie) => cookie.name === "lepidy_session",
  );
  // The session token is not readable by anything running in the page.
  expect(sessionCookie?.httpOnly).toBe(true);
  expect(sessionCookie?.sameSite).toBe("Lax");
  expect(await page.evaluate(() => document.cookie)).not.toContain("lepidy_session");

  await page.getByRole("button", { name: /Account menu for/ }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/signin$/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

  // Signed out, the workspace shows nothing and offers the way back in.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in to Lepidy" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to sign in" })).toBeVisible();

  // Putting the revoked token back does not restore the session.
  expect(sessionCookie).toBeDefined();
  await page.context().addCookies([sessionCookie!]);
  await page.goto("/c/general");
  await expect(page.getByRole("heading", { name: "Sign in to Lepidy" })).toBeVisible();
  await expect(page.locator(".messages, .composer")).toHaveCount(0);
});

test("AUTH-INT-003 signs back in and refuses a wrong password without saying which half was wrong", async ({
  page,
}) => {
  const account = freshAccount();
  await signUp(page, account);
  await page.getByRole("button", { name: /Account menu for/ }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/signin$/);

  // Each attempt waits for its own outcome, so a queued click cannot be the
  // thing that fails instead of the credentials.
  async function attemptAndFail(email: string, password: string): Promise<string> {
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    const response = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/signin"));
    await page.getByRole("button", { name: "Sign in" }).click();
    await response;
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
    await expect(page.locator(".auth-error")).toBeVisible();
    return (await page.locator(".auth-error").textContent()) ?? "";
  }

  const wrongPassword = await attemptAndFail(account.email, "not the right password at all");
  expect(wrongPassword).toBe("That email and password do not match.");

  // An unknown address and a wrong password are indistinguishable, which is
  // exactly what an attacker enumerating accounts is looking for.
  expect(await attemptAndFail(`nobody-${account.handle}@example.test`, account.password)).toBe(
    wrongPassword,
  );

  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: account.workspaceName, level: 2 })).toBeVisible();
});

test("AUTH-INT-004 refuses sign-up outside development without creating durable state", async ({ page }) => {
  const account = freshAccount();
  const production = "http://127.0.0.1:3101";
  const before = await (await page.request.get(`${production}/__fixture/counts`)).json();
  await page.route("**/signup", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    const headers = request.headers();
    const response = await page.request.post(`${production}/signup`, {
      headers: { "content-type": headers["content-type"], "next-action": headers["next-action"], origin: production },
      data: request.postDataBuffer()!,
    });
    await route.fulfill({ response });
  });
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(account.displayName);
  await page.getByLabel("Handle").fill(account.handle);
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByLabel("Workspace name").fill(account.workspaceName);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.locator(".auth-error")).toContainText("Self-service sign-up needs email verification");
  expect(await (await page.request.get(`${production}/__fixture/counts`)).json()).toEqual(before);
  expect((await page.context().cookies()).some((cookie) => cookie.name === "lepidy_session")).toBe(false);
  // Exactly the same account input succeeds on the allowed deployment.
  await page.unroute("**/signup");
  await signUp(page, account);
});

test("AUTH-INT-005 requires a session-bound CSRF token for message mutations", async ({ page, browser }) => {
  await signUp(page, freshAccount());
  await page.goto("/c/general");
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === "lepidy_csrf")!;
  expect(csrf).toBeDefined();
  const other = await browser.newContext({ baseURL: "http://127.0.0.1:3100" });
  let otherCsrf: string;
  try {
    const otherPage = await other.newPage();
    await signUp(otherPage, freshAccount());
    otherCsrf = (await other.cookies()).find((cookie) => cookie.name === "lepidy_csrf")!.value;
  } finally {
    await other.close();
  }
  const session = (await page.context().cookies()).find((cookie) => cookie.name === "lepidy_session")!;
  const counts = async () => (await page.request.post("/__fixture/workspace-counts", { headers: { authorization: session.value } })).json();
  const before = await counts();
  const composer = page.getByRole("textbox", { name: /Message #general/ });
  for (const value of ["", "forged-csrf", otherCsrf]) {
    await page.context().addCookies([{ ...csrf, value }]);
    await composer.fill(`denied csrf canary ${value || "missing"}`);
    const response = page.waitForResponse((response) => response.request().method() === "POST");
    await composer.press("Enter");
    await response;
    await expect(page.locator(".composer-error")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await expect(composer).toBeFocused();
    await page.reload();
    await expect(page.locator(".messages > li")).toHaveCount(0);
    expect(await counts()).toEqual(before);
  }
  await page.context().addCookies([csrf]);
  await composer.fill("allowed csrf message");
  const sent = page.waitForRequest((request) => request.method() === "POST");
  await composer.press("Enter");
  const request = await sent;
  await expect(page.locator(".messages > li")).toHaveCount(1);
  await expect(composer).toHaveValue("");
  const afterAllowed = await counts();
  // A foreign Origin cannot use even a valid session and CSRF token.
  const headers = request.headers();
  const payload = JSON.parse(request.postData()!);
  payload[0].bodyMarkdown = "forbidden origin canary";
  payload[0].idempotencyKey = `csrf-origin:${crypto.randomUUID()}`;
  const denied = await page.request.post("/c/general", {
    headers: { "content-type": headers["content-type"], "next-action": headers["next-action"], origin: "https://foreign.example.test" },
    data: JSON.stringify(payload),
  });
  expect(denied.status()).toBeGreaterThanOrEqual(400);
  expect(await counts()).toEqual(afterAllowed);
  await page.reload();
  await expect(page.locator(".messages > li")).toHaveCount(1);
  await expect(page.locator(".messages > li")).toContainText("allowed csrf message");
});

test("AUTH-INT-006 refuses forged sign-out actions without revoking the session", async ({ page }) => {
  const account = freshAccount();
  await signUp(page, account);
  await page.getByRole("button", { name: /Account menu for/ }).click();
  const outgoing = page.waitForRequest((request) => request.method() === "POST");
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  const request = await outgoing;
  await expect(page).toHaveURL(/\/signin$/);
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === "lepidy_csrf")!;
  const headers = request.headers();
  for (const value of [null, "forged-signout-csrf", JSON.parse(request.postData()!)[0]]) {
    const denied = await page.request.post("/", {
      headers: { "content-type": headers["content-type"], "next-action": headers["next-action"], origin: "http://127.0.0.1:3100" },
      data: JSON.stringify([value]),
    });
    expect(await denied.text()).toContain("Unable to sign out. Refresh and try again.");
    await page.goto("/");
    await expect(page.getByRole("heading", { name: account.workspaceName, level: 2 })).toBeVisible();
  }
  expect(csrf.value).not.toBe(JSON.parse(request.postData()!)[0]);
  await page.context().addCookies([{ ...csrf, value: "" }]);
  await page.getByRole("button", { name: /Account menu for/ }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page.getByRole("menu").getByRole("alert")).toContainText("Unable to sign out");
  await page.context().addCookies([csrf]);
  await page.reload();
  await page.getByRole("button", { name: /Account menu for/ }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/signin$/);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in to Lepidy" })).toBeVisible();
});

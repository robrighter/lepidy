import { expect, test } from "./harness";

import { freshAccount, signUp } from "./auth-helpers";

/**
 * The installed shell, tested against what is actually served rather than
 * against the source that produced it. A manifest that names an icon which
 * 404s installs with no icon, and nothing in a type system notices.
 */

test("PWA-INT-001 serves a manifest whose icons all exist", async ({ page }) => {
  const response = await page.request.get("/manifest.webmanifest");
  expect(response.ok(), await response.text()).toBe(true);
  const manifest = (await response.json()) as {
    name: string;
    start_url: string;
    display: string;
    scope: string;
    icons: { src: string; sizes: string; purpose?: string }[];
    shortcuts?: { url: string }[];
  };

  expect(manifest.name).toBe("Lepidy");
  expect(manifest.display).toBe("standalone");
  // Home, because somebody opening this from a home-screen icon is asking what
  // needs them, and that is the screen which answers it.
  expect(manifest.start_url).toBe("/");
  expect(manifest.scope).toBe("/");

  // A launcher may crop an icon to a circle, and this mark is a pair of wings
  // whose tips a circular crop removes first. The maskable icon is a separate
  // file for that reason, so its absence is worth failing over.
  expect(manifest.icons.some((icon) => icon.purpose === "maskable")).toBe(true);

  for (const icon of manifest.icons) {
    const asset = await page.request.get(icon.src);
    expect(asset.ok(), `${icon.src} is named by the manifest and 404s`).toBe(true);
  }
  // Every shortcut is a place, never an action: a shortcut that answered an
  // approval would be an approval anybody holding the phone could give.
  for (const shortcut of manifest.shortcuts ?? []) {
    expect(shortcut.url.startsWith("/")).toBe(true);
  }
});

test("PWA-INT-002 registers a service worker that caches nothing signed in", async ({ page }) => {
  await signUp(page, { ...freshAccount(), displayName: "Ada Ruiz", handle: "ada" });
  await page.goto("/");

  const registered = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return registration.active !== null;
  });
  expect(registered).toBe(true);

  // The rule that matters, asserted against the served worker: nothing that
  // came back from a signed-in request is ever put in a cache. A workspace is
  // shared, its content is other people's, and a cache outlives a sign-out.
  const source = await (await page.request.get("/sw.js")).text();
  expect(source).not.toMatch(/cache\.put\s*\(/);
  expect(source).not.toMatch(/\.addAll\(\s*\[?\s*request/);
  // And it lets everything that is not a page navigation past untouched —
  // every Server Action is a POST, and a worker that failed one would lose a
  // message somebody wrote.
  expect(source).toContain('request.method !== "GET" || request.mode !== "navigate"');

  // Only shipped assets are precached.
  const precache = await page.evaluate(async () => {
    const keys = await caches.keys();
    const entries: string[] = [];
    for (const key of keys) {
      const cache = await caches.open(key);
      for (const request of await cache.keys()) entries.push(new URL(request.url).pathname);
    }
    return entries;
  });
  expect(precache.length).toBeGreaterThan(0);
  for (const entry of precache) {
    expect(["/offline.html", "/mark.svg", "/icon-192.png"]).toContain(entry);
  }
});

test("PWA-INT-003 opens a notification only onto a place in this workspace", async ({ page }) => {
  await page.goto("/");
  const source = await (await page.request.get("/sw.js")).text();
  // The shipped function, run in a real engine. The path arrives from outside
  // the page and is rendered by the operating system, so a payload that could
  // carry a URL would be an open redirect with a system-level entry point.
  const resolve = await page.evaluate((workerSource) => {
    const body = workerSource.slice(workerSource.indexOf("function destination(data)"));
    const source = body.slice(0, body.indexOf("\n}") + 2);
    // eslint-disable-next-line no-new-func
    const built = new Function(`${source}; return destination;`)() as (
      data: unknown,
    ) => string;
    return [
      ["/inbox?approval=req-7", built({ path: "/inbox?approval=req-7" })],
      ["/c/deploys", built({ path: "/c/deploys" })],
      ["https://evil.test/", built({ path: "https://evil.test/" })],
      ["//evil.test/", built({ path: "//evil.test/" })],
      ["../../etc", built({ path: "../../etc" })],
      ["\\\\evil", built({ path: "\\\\evil" })],
      ["missing", built({})],
      ["number", built({ path: 7 })],
    ] as [string, string][];
  }, source);

  const answers = new Map(resolve);
  // A real destination is kept.
  expect(answers.get("/inbox?approval=req-7")).toBe("/inbox?approval=req-7");
  expect(answers.get("/c/deploys")).toBe("/c/deploys");
  // Everything else lands in the Inbox, which is where the thing was waiting
  // anyway — a refusal here must still open something, or the notification
  // becomes a click that does nothing.
  for (const key of ["https://evil.test/", "//evil.test/", "../../etc", "\\\\evil", "missing", "number"]) {
    expect(answers.get(key), `${key} was allowed`).toBe("/inbox");
  }
});

test("PWA-INT-004 has an offline page that does not overstate what is waiting", async ({ page }) => {
  const response = await page.request.get("/offline.html");
  expect(response.ok()).toBe(true);
  const html = await response.text();

  // The temptation on an offline page is to reassure. A person reading this may
  // have an agent waiting on an approval, so it must not imply anything is
  // being held for them.
  expect(html).toContain("Nothing you type here while offline is saved or sent.");
  expect(html).toContain("expire after five minutes");
  // And it must not blame the workspace for the device's network.
  expect(html).toContain("Your workspace is online; this device cannot currently reach it.");
  // It ships with the app, so it must not need the network it is shown without.
  expect(html).not.toMatch(/src="https?:\/\//);
  expect(html).not.toMatch(/href="https?:\/\//);
});

test("PWA-INT-005 never promises a notification will arrive", async ({ page }) => {
  await signUp(page, { ...freshAccount(), displayName: "Ada Ruiz", handle: "ada" });

  // The permission value comes from the browser and the operating system under
  // it. What is being tested is what Lepidy *says* about each value, so each is
  // set before the page's own scripts run rather than driven through a
  // permission prompt: a scenario that depended on Chromium's prompt plumbing
  // would be testing Chromium.
  const withPermission = async (permission: string) => {
    await page.addInitScript((value) => {
      Object.defineProperty(Notification, "permission", { value, configurable: true });
    }, permission);
    await page.goto("/inbox");
    return page.locator(".notification-permission");
  };

  // Granted: still no promise. The operating system can silence a notification
  // during a focus mode and Lepidy cannot override that, so the honest version
  // says so and names where things wait instead.
  let panel = await withPermission("granted");
  await expect(panel).toHaveAttribute("data-permission", "granted");
  await expect(panel).toContainText("cannot override");
  await expect(panel).toContainText("Inbox");

  // Default: the ask, and the reason it is worth answering.
  panel = await withPermission("default");
  await expect(panel).toHaveAttribute("data-permission", "default");
  await expect(panel).toContainText("five minutes");
  await expect(panel.getByRole("button", { name: "Allow notifications" })).toBeVisible();

  // Denied: Lepidy must not offer to ask again. A browser that has been told no
  // does not re-prompt, so a button here would be a button that does nothing.
  panel = await withPermission("denied");
  await expect(panel).toHaveAttribute("data-permission", "denied");
  await expect(panel).toContainText("cannot ask again");
  await expect(panel).toContainText("nothing is lost");
  await expect(panel.locator("button")).toHaveCount(0);
});

test("PWA-INT-006 refuses a push subscription without a session or a CSRF token", async ({ page }) => {
  // Both are state changes made with a cookie, so both carry a token. A signed
  // out browser asking to be subscribed is not an error to log — it is a
  // session that ended between the permission prompt and this request.
  const anonymous = await page.request.post("/api/push/subscribe", {
    data: { endpoint: "https://push.example.test/f/a", p256dh: "x", auth: "y" },
  });
  expect([401, 403]).toContain(anonymous.status());

  await signUp(page, { ...freshAccount(), displayName: "Ada Ruiz", handle: "ada" });
  await page.goto("/inbox");

  // Signed in, but with no token: still refused, and refused before anything is
  // stored.
  const forged = await page.request.post("/api/push/subscribe", {
    data: { endpoint: "https://push.example.test/f/a", p256dh: "x", auth: "y" },
  });
  expect(forged.status()).toBe(403);
});

test("PWA-INT-007 stores a real subscription and refuses a malformed one", async ({ page }) => {
  await signUp(page, { ...freshAccount(), displayName: "Ada Ruiz", handle: "ada" });
  await page.goto("/inbox");

  const csrfToken = await page.evaluate(
    () =>
      (document.cookie.split("; ").find((entry) => entry.startsWith("lepidy_csrf=")) ?? "").split(
        "=",
      )[1] ?? "",
  );
  expect(csrfToken).not.toBe("");

  // A real P-256 subscription, generated here so the scenario owns both halves.
  const real = await page.evaluate(async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ]);
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const encode = (bytes: Uint8Array) =>
      btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return {
      endpoint: "https://push.example.test/f/browser",
      p256dh: encode(raw),
      auth: encode(crypto.getRandomValues(new Uint8Array(16))),
    };
  });

  const stored = await page.request.post("/api/push/subscribe", {
    data: { csrfToken, ...real },
  });
  expect(stored.ok(), await stored.text()).toBe(true);

  // A key of the wrong length is one the encryption would fail on later, in an
  // outbox retry loop, with nothing to point at. Refused here instead.
  const malformed = await page.request.post("/api/push/subscribe", {
    data: { csrfToken, ...real, auth: "c2hvcnQ" },
  });
  expect(malformed.status()).toBe(400);

  // Plain http would be a push endpoint on the wire.
  const insecure = await page.request.post("/api/push/subscribe", {
    data: { csrfToken, ...real, endpoint: "http://push.example.test/f/browser" },
  });
  expect(insecure.status()).toBe(400);

  // And stopping is idempotent, because a request to stop being notified must
  // not fail because it had already been carried out.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const removed = await page.request.delete("/api/push/subscribe", {
      data: { csrfToken, endpoint: real.endpoint },
    });
    expect(removed.ok()).toBe(true);
  }
});

test("PWA-INT-008 says a deployment cannot push rather than failing silently", async ({ page }) => {
  // No VAPID key is bound in the test environment, which is the state every
  // development deployment is in. The browser has to be told that, or a person
  // grants permission and waits forever for a notification nothing will send.
  const response = await page.request.get("/api/push/key");
  expect(response.status()).toBe(503);
  expect(await response.json()).toMatchObject({ error: expect.stringContaining("not configured") });
});


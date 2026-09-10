/**
 * Lepidy's service worker.
 *
 * The interesting decisions here are all refusals, so they are stated first.
 *
 * **It caches nothing that came back from a signed-in request.** Not a page,
 * not an API response, not a message. A workspace is shared, its content is
 * other people's, and a cache is a copy of it sitting in browser storage that
 * outlives a sign-out, survives an offboarding, and is readable by anything
 * that later gets code execution on that origin. The offline experience this
 * buys is worse than a caching service worker's, and that is the trade: the
 * only thing cached is a document that says the network is gone.
 *
 * **It never intercepts anything but a GET navigation.** A Server Action is a
 * POST, and every form in this product posts to one so that a submission made
 * before hydration is still carried out (C01a). A service worker that queued,
 * retried or failed one of those would lose a message somebody wrote.
 *
 * **A notification can only open a place in this workspace.** The path is
 * validated here rather than trusted from the payload, for the same reason the
 * desktop shell validates a deep link: the text arrives from outside the page
 * and is rendered by the operating system, and a notification that could carry
 * a URL would be an open redirect with a system-level entry point.
 */

const VERSION = "lepidy-v1";
const OFFLINE_DOCUMENT = "/offline.html";

/** The only things that are ever cached. All of them ship with the app. */
const PRECACHE = [OFFLINE_DOCUMENT, "/mark.svg", "/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(PRECACHE))
      // Take over straight away. A worker waiting for every tab to close is a
      // worker whose fix ships days after it was written.
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Everything that is not a page the browser is navigating to goes straight to
  // the network, untouched. That includes every Server Action POST, every
  // upload, and every authenticated fetch.
  if (request.method !== "GET" || request.mode !== "navigate") return;

  event.respondWith(
    // Network first, and no `catch` that stores anything: on success the
    // response is returned and forgotten.
    fetch(request).catch(async () => {
      const cache = await caches.open(VERSION);
      const offline = await cache.match(OFFLINE_DOCUMENT);
      return (
        offline ??
        new Response("Lepidy is offline.", {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8" },
        })
      );
    }),
  );
});

/**
 * Where a notification may take somebody.
 *
 * A rooted, same-origin path and nothing else. `//evil.test` is a
 * protocol-relative URL that a naive check reads as a path, and a payload
 * carrying `https://…` would be a redirect the operating system delivered.
 */
function destination(data) {
  const path = typeof data?.path === "string" ? data.path.trim() : "";
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("://")) return "/inbox";
  if (path.includes("..") || path.includes("\\")) return "/inbox";
  return path;
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = destination(event.notification.data);
  event.waitUntil(
    (async () => {
      const target = new URL(path, self.location.origin);
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Reuse a window that is already open on this workspace rather than
      // opening a second one: somebody answering an approval from a
      // notification should land in the app they already had, with whatever
      // they were typing still in it.
      for (const client of windows) {
        if (new URL(client.url).origin === target.origin) {
          await client.focus();
          if ("navigate" in client) await client.navigate(target.href);
          return;
        }
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});

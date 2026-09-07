import { test as base, type BrowserContext } from "@playwright/test";

export { expect } from "@playwright/test";

/**
 * The browser harness, and the one thing it does to the browser.
 *
 * Next.js prefetches every `<Link>` in the viewport, which on this shell means
 * roughly ten speculative requests for the rail on every page — thirty-four in
 * one short scenario, measured. A test navigates or closes long before those
 * finish, so the browser abandons them, and an abandoned request is a client
 * disconnect.
 *
 * That matters here because of an upstream defect: `wrangler dev` proxies each
 * request through a ProxyWorker, and when the proxied fetch rejects — which is
 * what a client disconnect looks like from inside — it reports the failure to
 * its controller as a fatal error and the dev server exits. Every remaining
 * scenario then fails on a refused connection. It is the instability recorded
 * against C01a, and it is why a run could lose eighty scenarios to one
 * abandoned prefetch.
 *
 * So the harness stops the browser making requests it is going to abandon.
 * Nothing about the product changes: prefetching is a browser optimisation for
 * a route the test is about to fetch anyway, no assertion depends on it, and a
 * navigation that follows fetches normally. What goes away is a stream of
 * speculative requests whose only role in this suite was to be cancelled.
 *
 * If a scenario ever needs to assert on prefetching itself, it should make its
 * own context and not use this fixture — and then it owns the consequence.
 */
export async function blockPrefetch(context: BrowserContext): Promise<void> {
  await context.route("**", async (route, request) => {
    const headers = request.headers();
    // Next's own markers for a speculative navigation fetch. A real navigation
    // and a real RSC request made by a click carry neither.
    if (headers["next-router-prefetch"] === "1" || headers["purpose"] === "prefetch") {
      await route.abort();
      return;
    }
    await route.fallback();
  });
}

export const test = base.extend<{ noPrefetch: void }>({
  noPrefetch: [
    async ({ context }, use) => {
      await blockPrefetch(context);
      await use();
      // Let whatever is still in the air finish before Playwright tears the
      // context down. A scenario often ends just after a navigation, with its
      // scripts, fonts and stylesheets still loading; closing then cancels
      // them, and the dev server treats a cancelled request as fatal for the
      // reason above. Waiting costs a moment at the end of a scenario and
      // removes the largest remaining source of those cancellations.
      await Promise.all(
        context.pages().map((page) => page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined)),
      );
    },
    { auto: true },
  ],
});

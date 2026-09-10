import { vapidPublicKeyForBrowser } from "@/src/shell/push-context";

/**
 * The public half of this deployment's VAPID key.
 *
 * The browser needs it to create a subscription at all, and it is public by
 * definition: it is what the push service uses to check our signature. A
 * deployment with no key answers 503 rather than an empty string, so the client
 * can say "this deployment cannot push" instead of failing inside
 * `pushManager.subscribe` with a message nobody can act on.
 */
export async function GET(): Promise<Response> {
  const key = await vapidPublicKeyForBrowser();
  if (key === null) {
    return Response.json({ error: "web push is not configured for this deployment" }, { status: 503 });
  }
  return Response.json({ key }, { headers: { "cache-control": "private, max-age=3600" } });
}

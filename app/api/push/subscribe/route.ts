import { readCsrfToken } from "@/src/shell/session-cookies";
import { pushViewer } from "@/src/shell/push-context";

/**
 * Register or forget this browser.
 *
 * Both directions carry a CSRF token, because both are state changes made with
 * a cookie. The asymmetry worth noting is what happens when one fails: a failed
 * subscribe means somebody does not get notified and finds out by checking the
 * Inbox, while a failed unsubscribe means somebody keeps being notified after
 * asking not to be — so `DELETE` reports success when the row is already gone.
 */
type Body = { csrfToken?: unknown; endpoint?: unknown; p256dh?: unknown; auth?: unknown };

async function authorized(request: Request): Promise<{ body: Body } | Response> {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return Response.json({ error: "expected a json body" }, { status: 400 });
  }
  const expected = await readCsrfToken();
  if (!expected || typeof body.csrfToken !== "string" || body.csrfToken !== expected) {
    return Response.json({ error: "csrf token mismatch" }, { status: 403 });
  }
  return { body };
}

export async function POST(request: Request): Promise<Response> {
  const checked = await authorized(request);
  if (checked instanceof Response) return checked;
  const { body } = checked;
  if (typeof body.endpoint !== "string" || typeof body.p256dh !== "string" || typeof body.auth !== "string") {
    return Response.json({ error: "a subscription needs an endpoint and both keys" }, { status: 400 });
  }

  const viewer = await pushViewer();
  if (viewer.status === "signed_out") return Response.json({ error: "signed out" }, { status: 401 });
  if (viewer.status === "unavailable") return Response.json({ error: viewer.reason }, { status: 503 });

  try {
    await viewer.stub.subscribeToPush({
      actor: viewer.actor,
      endpoint: body.endpoint,
      p256dh: body.p256dh,
      auth: body.auth,
      now: Date.now(),
    });
  } catch (error) {
    // The shape checks in `validateSubscription` are the only thing that can
    // fail here, and they describe what is wrong with the subscription rather
    // than anything about this workspace.
    return Response.json(
      { error: error instanceof Error ? error.message : "subscription refused" },
      { status: 400 },
    );
  }
  return Response.json({ subscribed: true });
}

export async function DELETE(request: Request): Promise<Response> {
  const checked = await authorized(request);
  if (checked instanceof Response) return checked;
  const { body } = checked;
  if (typeof body.endpoint !== "string") {
    return Response.json({ error: "an endpoint is required" }, { status: 400 });
  }
  const viewer = await pushViewer();
  if (viewer.status === "signed_out") return Response.json({ error: "signed out" }, { status: 401 });
  if (viewer.status === "unavailable") return Response.json({ error: viewer.reason }, { status: 503 });
  // Idempotent: a request to stop being notified must not fail because it had
  // already been carried out.
  await viewer.stub.unsubscribeFromPush({ actor: viewer.actor, endpoint: body.endpoint });
  return Response.json({ removed: true });
}

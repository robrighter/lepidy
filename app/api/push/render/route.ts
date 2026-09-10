import { pushViewer } from "@/src/shell/push-context";

/**
 * What the device is allowed to display for one notification.
 *
 * The push that woke the service worker carried identifiers and nothing else.
 * This is where the words come from, and the reason that split is worth its
 * extra round trip: the request arrives with the **viewer's own session**, so
 * visibility is decided now rather than when the push was sent. Somebody
 * removed from a room in the seconds between gets nothing.
 *
 * A subject the viewer may not see answers 404, exactly as a room does — "you
 * are not allowed to see this" tells somebody it exists.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind");
  const id = url.searchParams.get("id");
  if ((kind !== "message" && kind !== "approval") || !id) {
    return Response.json({ error: "kind and id are required" }, { status: 400 });
  }

  const viewer = await pushViewer();
  // A signed-out browser gets no content at all. This is the case where a
  // person signed out but their subscription had not yet been forgotten, and
  // the right answer is a generic notification rather than a preview.
  if (viewer.status === "signed_out") return Response.json({ error: "signed out" }, { status: 401 });
  if (viewer.status === "unavailable") return Response.json({ error: viewer.reason }, { status: 503 });

  const rendered = await viewer.stub.renderNotification({
    actor: viewer.actor,
    kind,
    id,
    now: Date.now(),
  });
  if (rendered === null) return Response.json({ error: "nothing to show" }, { status: 404 });
  return Response.json(rendered, { headers: { "cache-control": "no-store" } });
}

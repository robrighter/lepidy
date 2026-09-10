import { AuthorizationService } from "../control/authorization";
import { MAX_FILE_BYTES } from "../domain/files";
import { SESSION_COOKIE, type ShellEnvironment } from "../shell/resolve-shell-source";
import { resolveViewerWorkspace } from "../shell/workspace-shell-source";

/**
 * The one path bytes travel.
 *
 * It is a Worker route rather than a Durable Object method because a 2 MB row
 * limit and a 30-second CPU budget are not where file transfer belongs
 * (HLD §5.4): the object decides *whether* a transfer may happen and the Worker
 * moves the bytes. The object never sees them.
 *
 * It is also not a presigned URL. R2 presigning needs the S3 API and a stored
 * access key, and it is unsupported by the local runtime the whole integration
 * suite runs on — so a presigned design could only ever have been asserted, not
 * tested. Streaming through the Worker keeps the same property that mattered
 * (bytes bypass the object) and is exercised end to end against real R2.
 */

function refusal(message: string, status: number): Response {
  return new Response(message, { status, headers: { "cache-control": "no-store" } });
}

function cookieToken(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=") || null;
  }
  return null;
}

export async function handleFileTransferRequest(env: ShellEnvironment, request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const match = /^\/files\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname);
  if (!match) return url.pathname.startsWith("/files/") ? refusal("Not found", 404) : null;
  if (request.method !== "PUT" && request.method !== "GET") return refusal("Method not allowed", 405);
  if (!env.CONTROL_DB || !env.WORKSPACE || !env.FILES) return refusal("Unavailable", 503);

  const token = cookieToken(request);
  if (!token) return refusal("Unauthorized", 401);
  const authorization = new AuthorizationService(env.CONTROL_DB, env.WORKSPACE);
  const resolved = await resolveViewerWorkspace(
    { db: env.CONTROL_DB, workspaces: env.WORKSPACE, authenticateSession: (value) => authorization.authenticateBrowserSession(value) },
    token,
  );
  if (resolved.status !== "ok") return refusal("Unauthorized", 401);
  const stub = env.WORKSPACE.get(env.WORKSPACE.idFromString(resolved.row.durable_object_id));
  const actor = { memberId: resolved.row.member_id, authorizationEpoch: resolved.row.authorization_epoch };
  const fileId = match[1]!;

  if (request.method === "GET") {
    let authorized: Awaited<ReturnType<typeof stub.authorizeDownload>>;
    try {
      authorized = await stub.authorizeDownload({ actor, fileId });
    } catch {
      // Never distinguishes "no such file" from "not yours": the object already
      // reports an invisible room's file as missing, and so does this.
      return refusal("Not found", 404);
    }
    const object = await env.FILES.get(authorized.objectKey);
    if (object === null) return refusal("Not found", 404);
    await stub.recordUsage({ at: Date.now(), delta: { requests: 1, r2Reads: 1 } });
    return new Response(object.body, {
      headers: {
        // Never the stored media type on a download: serving attacker-supplied
        // bytes under a type the browser will execute is the whole bug class.
        // Images the product renders inline are fetched through the same route
        // and are still sent as an attachment.
        "content-type": "application/octet-stream",
        "content-length": String(authorized.file.byteLength),
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(authorized.file.fileName)}`,
        "content-security-policy": "default-src 'none'; sandbox",
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      },
    });
  }

  const declared = Number(request.headers.get("content-length") ?? "");
  if (!Number.isSafeInteger(declared) || declared <= 0 || declared > MAX_FILE_BYTES) return refusal("Invalid length", 413);
  if (request.body === null) return refusal("Missing body", 400);

  let reservation: { objectKey: string };
  try {
    reservation = await stub.beginTransfer({ actor, fileId, byteLength: declared });
  } catch (error) {
    return refusal(error instanceof Error ? error.message : "Upload not found", 409);
  }

  // The body is digested as it streams rather than buffered: a 100 MB
  // attachment must not have to fit in memory to get an integrity hash, and
  // the retention contract wants one for restore verification.
  const [toStore, toDigest] = request.body.tee();
  // A Workers runtime extension hanging off `crypto`, not a bare global. The
  // ambient DOM `Crypto` type does not know it exists, so it is named here.
  const workerCrypto = crypto as Crypto & { DigestStream: typeof DigestStream };
  const digest = new workerCrypto.DigestStream("SHA-256");
  const digested = toDigest.pipeTo(digest);
  const stored = await env.FILES.put(reservation.objectKey, toStore, {
    httpMetadata: { contentDisposition: "attachment" },
  });
  if (stored === null) return refusal("Upload failed", 502);
  await stub.recordUsage({ at: Date.now(), delta: { requests: 1, r2Writes: 1 } });
  await digested;
  const sha256 = [...new Uint8Array(await digest.digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (stored.size !== declared) {
    // A body that lied about its length does not get to stay.
    await env.FILES.delete(reservation.objectKey);
    return refusal("Upload length did not match", 400);
  }

  try {
    await stub.confirmUpload({ actor, fileId, byteLength: stored.size, sha256, now: Date.now() });
  } catch (error) {
    // The object refused to record it, so the bytes do not get to stay.
    await env.FILES.delete(reservation.objectKey);
    return refusal(error instanceof Error ? error.message : "Upload rejected", 409);
  }
  return Response.json({ fileId, byteLength: stored.size });
}

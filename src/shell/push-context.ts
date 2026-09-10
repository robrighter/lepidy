import { getCloudflareContext } from "@opennextjs/cloudflare";
import { cookies } from "next/headers";

import { AuthorizationService } from "../control/authorization";
import type { Workspace } from "../cloudflare/workspace";
import { SESSION_COOKIE, type ShellEnvironment } from "./resolve-shell-source";
import { resolveViewerWorkspace, shellErrorReason } from "./workspace-shell-source";

/**
 * The viewer, their workspace, and nothing else.
 *
 * The push routes all need the same three things and all of them have to fail
 * the same way — a signed-out browser asking to be subscribed is not an error
 * to log, it is a browser whose session ended between the permission prompt and
 * the request.
 */
export type PushViewer =
  | { status: "ready"; stub: DurableObjectStub<Workspace>; actor: { memberId: string; authorizationEpoch: number } }
  | { status: "signed_out" }
  | { status: "unavailable"; reason: string };

export async function pushViewer(): Promise<PushViewer> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  if (!token) return { status: "signed_out" };
  let env: ShellEnvironment = {};
  try {
    env = (await getCloudflareContext({ async: true })).env as ShellEnvironment;
  } catch {
    env = {};
  }
  if (!env.CONTROL_DB || !env.WORKSPACE) return { status: "signed_out" };
  const authorization = new AuthorizationService(env.CONTROL_DB, env.WORKSPACE);
  const resolved = await resolveViewerWorkspace(
    {
      db: env.CONTROL_DB,
      workspaces: env.WORKSPACE,
      authenticateSession: (value) => authorization.authenticateBrowserSession(value),
    },
    token,
  );
  if (resolved.status === "signed_out") return { status: "signed_out" };
  if (resolved.status === "unavailable") return { status: "unavailable", reason: resolved.reason };
  try {
    return {
      status: "ready",
      stub: env.WORKSPACE.get(
        env.WORKSPACE.idFromString(resolved.row.durable_object_id),
      ) as DurableObjectStub<Workspace>,
      actor: { memberId: resolved.row.member_id, authorizationEpoch: resolved.row.authorization_epoch },
    };
  } catch (error) {
    return { status: "unavailable", reason: shellErrorReason(error) };
  }
}

/**
 * The public half of this deployment's VAPID key, for `pushManager.subscribe`.
 *
 * Public by definition — it is what the browser hands to the push service so
 * the service can check our signature — so serving it is not a disclosure. The
 * private half never leaves the Worker's secret binding.
 */
export async function vapidPublicKeyForBrowser(): Promise<string | null> {
  let env: { VAPID_PRIVATE_JWK?: string } = {};
  try {
    env = (await getCloudflareContext({ async: true })).env as { VAPID_PRIVATE_JWK?: string };
  } catch {
    return null;
  }
  if (!env.VAPID_PRIVATE_JWK) return null;
  try {
    const jwk = JSON.parse(env.VAPID_PRIVATE_JWK) as JsonWebKey;
    const { vapidPublicKey } = await import("../cloudflare/web-push");
    return await vapidPublicKey({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
  } catch {
    return null;
  }
}

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { cookies } from "next/headers";
import { cache } from "react";

import { AuthorizationService } from "../control/authorization";
import type { VaultApprovalCard } from "../cloudflare/workspace";
import { SESSION_COOKIE, type ShellEnvironment } from "./resolve-shell-source";
import { resolveViewerWorkspace, shellErrorReason } from "./workspace-shell-source";

export type ApprovalsState =
  | { status: "ready"; approvals: readonly VaultApprovalCard[]; hasPasskey: boolean }
  | { status: "signed_out" }
  | { status: "unavailable"; reason: string };

/**
 * The credential requests waiting on this person, and the ones they are waiting
 * on themselves.
 *
 * `hasPasskey` is read here rather than discovered when somebody presses Allow.
 * Allowing needs a verified gesture, an account without a passkey cannot make
 * one, and finding that out only after reading a card and deciding is the worst
 * possible moment to be told.
 */
export const workspaceApprovals = cache(async (): Promise<ApprovalsState> => {
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
    const stub = env.WORKSPACE.get(env.WORKSPACE.idFromString(resolved.row.durable_object_id));
    const listed = await stub.listVaultApprovals({
      actor: { memberId: resolved.row.member_id, authorizationEpoch: resolved.row.authorization_epoch },
      now: Date.now(),
    });
    const passkeys = await env.CONTROL_DB.prepare(
      "SELECT COUNT(*) AS count FROM passkeys WHERE account_id = ?",
    )
      .bind(resolved.row.account_id)
      .first<{ count: number }>();
    return { status: "ready", approvals: listed.approvals, hasPasskey: (passkeys?.count ?? 0) > 0 };
  } catch (error) {
    return { status: "unavailable", reason: shellErrorReason(error) };
  }
});

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { cookies } from "next/headers";

import { AuthorizationService } from "../control/authorization";
import type { AgentRuntimeView } from "../cloudflare/workspace";
import { SESSION_COOKIE, type ShellEnvironment } from "./resolve-shell-source";
import { resolveViewerWorkspace, shellErrorReason } from "./workspace-shell-source";

/**
 * The runtime screen's read side.
 *
 * One authorized call, refused outright for anybody who does not own the agent,
 * because everything the screen shows is the configuration of somebody's own
 * computer and somebody's own delegated authority. What it cannot return is
 * what that machine runs: the workspace method it calls has no field for an
 * executable, an argument, a directory, an environment value or a limit, and a
 * remote page is exactly where none of those may ever appear.
 */

export type RuntimeState =
  | {
      status: "ready";
      runtime: AgentRuntimeView;
      workspaceSlug: string;
      origin: string | null;
      /**
       * The name the machine's owner gave it at enrolment.
       *
       * Resolved here rather than in the workspace, so the Durable Object keeps
       * no copy of control-plane device metadata. It is a name, not a fact
       * about the machine: the identifier the product actually acts on is the
       * device id beside it.
       */
      deviceLabel: string | null;
    }
  | { status: "signed_out" }
  | { status: "unavailable"; reason: string };

export async function agentRuntime(agentId: string, origin: string | null): Promise<RuntimeState> {
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
    const runtime = await stub.describeAgentRuntime({
      actor: { memberId: resolved.row.member_id, authorizationEpoch: resolved.row.authorization_epoch },
      agentId,
      now: Date.now(),
    });
    const deviceId = runtime.local.device?.deviceId ?? null;
    const labelled =
      deviceId === null
        ? null
        // By exact id, which the reader can already see, and without filtering
        // on kind: `lepidy login` enrols as a client by default and the same
        // device then registers as a runner, so a kind filter would silently
        // drop the name for most real machines.
        : await env.CONTROL_DB.prepare("SELECT label FROM devices WHERE id = ? AND status = 'active'")
            .bind(deviceId)
            .first<{ label: string }>();
    return {
      status: "ready",
      runtime,
      workspaceSlug: resolved.row.slug,
      origin,
      deviceLabel: labelled?.label ?? null,
    };
  } catch (error) {
    return { status: "unavailable", reason: shellErrorReason(error) };
  }
}

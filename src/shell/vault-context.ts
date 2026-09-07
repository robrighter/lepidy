import { getCloudflareContext } from "@opennextjs/cloudflare";
import { cookies } from "next/headers";
import { cache } from "react";

import { AuthorizationService } from "../control/authorization";
import type {
  AgentDetail,
  VaultActivityRow,
  VaultApprovalCard,
  VaultCredentialDetail,
  VaultCredentialSummary,
  VaultGrantRow,
  Workspace,
} from "../cloudflare/workspace";
import { SESSION_COOKIE, type ShellEnvironment } from "./resolve-shell-source";
import { resolveViewerWorkspace, shellErrorReason } from "./workspace-shell-source";

/**
 * The vault's read side.
 *
 * Everything here is metadata, policy, grants and activity — the questions a
 * person asks when they are deciding whether something is wrong. None of it can
 * carry a value: the workspace methods it calls have no field for one, and a
 * remote page is exactly the place that must never be able to receive one.
 */

export type VaultOverview = {
  credentials: readonly VaultCredentialSummary[];
  grants: readonly VaultGrantRow[];
  approvals: readonly VaultApprovalCard[];
  activity: readonly VaultActivityRow[];
  agentAccessOn: boolean;
  viewerIsAdmin: boolean;
};

export type VaultState =
  | { status: "ready"; overview: VaultOverview }
  | { status: "signed_out" }
  | { status: "unavailable"; reason: string };

export type CredentialState =
  | { status: "ready"; detail: VaultCredentialDetail; grants: readonly VaultGrantRow[]; activity: readonly VaultActivityRow[] }
  | { status: "signed_out" }
  | { status: "unavailable"; reason: string };

export type AgentState =
  | { status: "ready"; agent: AgentDetail; grants: readonly VaultGrantRow[]; activity: readonly VaultActivityRow[] }
  | { status: "signed_out" }
  | { status: "unavailable"; reason: string };

type Viewer = {
  stub: DurableObjectStub<Workspace>;
  actor: { memberId: string; authorizationEpoch: number };
  role: string;
};

async function viewer(): Promise<Viewer | { status: "signed_out" } | { status: "unavailable"; reason: string }> {
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

  const stub = env.WORKSPACE.get(env.WORKSPACE.idFromString(resolved.row.durable_object_id));
  const actor = { memberId: resolved.row.member_id, authorizationEpoch: resolved.row.authorization_epoch };
  const member = await stub.getMember(resolved.row.member_id);
  return { stub, actor, role: member?.role ?? "member" };
}

function isViewer(value: Awaited<ReturnType<typeof viewer>>): value is Viewer {
  return "stub" in value;
}

export const vaultOverview = cache(async (): Promise<VaultState> => {
  const resolved = await viewer();
  if (!isViewer(resolved)) return resolved;
  const now = Date.now();
  try {
    const [credentials, grants, approvals, activity, settings] = await Promise.all([
      resolved.stub.listVaultCredentials({ actor: resolved.actor, now }),
      resolved.stub.listVaultGrants({ actor: resolved.actor, now }),
      resolved.stub.listVaultApprovals({ actor: resolved.actor, now }),
      resolved.stub.listVaultActivity({ actor: resolved.actor, limit: 20, now }),
      resolved.stub.getVaultAgentAccess({ actor: resolved.actor }),
    ]);
    return {
      status: "ready",
      overview: {
        credentials: credentials.credentials,
        grants: grants.grants,
        approvals: approvals.approvals,
        activity: activity.activity,
        agentAccessOn: settings.enabled,
        viewerIsAdmin: resolved.role === "owner" || resolved.role === "admin",
      },
    };
  } catch (error) {
    return { status: "unavailable", reason: shellErrorReason(error) };
  }
});

export async function credentialDetail(credentialId: string): Promise<CredentialState> {
  const resolved = await viewer();
  if (!isViewer(resolved)) return resolved;
  const now = Date.now();
  try {
    const detail = await resolved.stub.describeVaultCredential({ actor: resolved.actor, credentialId, now });
    const [grants, activity] = await Promise.all([
      resolved.stub.listVaultGrants({ actor: resolved.actor, credentialId, now }),
      resolved.stub.listVaultActivity({ actor: resolved.actor, credentialId, limit: 50, now }),
    ]);
    return { status: "ready", detail, grants: grants.grants, activity: activity.activity };
  } catch (error) {
    return { status: "unavailable", reason: shellErrorReason(error) };
  }
}

export async function agentDetail(agentId: string): Promise<AgentState> {
  const resolved = await viewer();
  if (!isViewer(resolved)) return resolved;
  const now = Date.now();
  try {
    const agent = await resolved.stub.describeAgent({ actor: resolved.actor, agentId, now });
    const [grants, activity] = await Promise.all([
      resolved.stub.listVaultGrants({ actor: resolved.actor, agentId, now }),
      resolved.stub.listVaultActivity({ actor: resolved.actor, agentId, limit: 50, now }),
    ]);
    return { status: "ready", agent, grants: grants.grants, activity: activity.activity };
  } catch (error) {
    return { status: "unavailable", reason: shellErrorReason(error) };
  }
}

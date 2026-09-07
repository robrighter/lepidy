"use server";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { headers } from "next/headers";

import { ACCOUNTS_OBJECT_NAME } from "@/src/cloudflare/accounts-address";
import type { Accounts } from "@/src/cloudflare/accounts";
import type { VaultApprovalCard } from "@/src/cloudflare/workspace";
import { originFromHeaders } from "@/src/domain/mcp-oauth";
import { canonicalApprovalDigest, type ApprovalDecisionInput } from "@/src/domain/vault-approval";
import type { ShellEnvironment } from "@/src/shell/resolve-shell-source";
import { isFailure, shellErrorReason, viewerWorkspace } from "@/src/shell/viewer-workspace";

/**
 * Answering a credential request.
 *
 * Denying is a plain form post and needs nothing but a session: a protective
 * action must be the easy one, and it has to work on a phone with a flaky
 * connection and no JavaScript yet. Allowing is a two-step ceremony, because it
 * needs a verified gesture bound to the exact decision, and a gesture only a
 * browser can make.
 */

export type ApprovalsResult = {
  ok: boolean;
  reason?: string;
  approvals?: readonly VaultApprovalCard[];
};

export type BeginAllowResult =
  | { ok: true; challengeId: string; digest: string; options: unknown }
  | { ok: false; reason: string };

function parseDecisions(raw: unknown): readonly ApprovalDecisionInput[] {
  if (typeof raw !== "string") throw new Error("that answer was malformed");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error("that answer was malformed");
  return parsed.map((entry) => {
    const item = entry as ApprovalDecisionInput;
    if (typeof item?.credentialId !== "string") throw new Error("that answer was malformed");
    return { credentialId: item.credentialId, outcome: item.outcome, window: item.window };
  });
}

/**
 * The host this request actually arrived on.
 *
 * A passkey is bound to the origin that created it, so a ceremony run on a
 * preview or a local Worker has to name that host rather than the production
 * one, or every assertion fails verification with nothing to show for it.
 */
async function relyingParty(): Promise<{ rpId: string; origin: string } | undefined> {
  const list = await headers();
  const host = list.get("host");
  if (host === null || host.length === 0) return undefined;
  const origin = originFromHeaders(host, list.get("x-forwarded-proto"), `https://${host}`);
  return { rpId: host.split(":")[0], origin };
}

async function accountsStub(): Promise<DurableObjectStub<Accounts> | null> {
  let env: ShellEnvironment = {};
  try {
    env = (await getCloudflareContext({ async: true })).env as ShellEnvironment;
  } catch {
    return null;
  }
  return env.ACCOUNTS ? env.ACCOUNTS.getByName(ACCOUNTS_OBJECT_NAME) : null;
}

/**
 * Deny every credential on one card. No step-up, by design: the step-up matrix
 * puts protective actions on the easy side of the line.
 */
export async function denyApprovalAction(
  previous: ApprovalsResult | null,
  form: FormData,
): Promise<ApprovalsResult> {
  const field = (name: string): string => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };
  const keep = { approvals: previous?.approvals };
  const workspace = await viewerWorkspace(field("csrfToken"));
  if (isFailure(workspace)) return { ok: false, reason: workspace.reason, ...keep };

  try {
    const decisions = parseDecisions(field("decisions")).map((decision) => ({ ...decision, outcome: "denied" as const }));
    const answered = await workspace.stub.decideVaultApproval({
      actor: workspace.actor,
      approvalId: field("approvalId"),
      decisions,
      now: Date.now(),
    });
    const listed = await workspace.stub.listVaultApprovals({ actor: workspace.actor, now: Date.now() });
    // A card somebody else answered first is not an error the denier caused;
    // they are told who answered rather than shown a failure.
    return {
      ok: answered.accepted,
      ...(answered.accepted ? {} : { reason: answered.reason ?? "that request was already answered" }),
      approvals: listed.approvals,
    };
  } catch (error) {
    const listed = await workspace.stub.listVaultApprovals({ actor: workspace.actor, now: Date.now() });
    return { ok: false, reason: shellErrorReason(error), approvals: listed.approvals };
  }
}

/**
 * Step one of allowing: compute the digest of the decision being authorised and
 * begin a passkey assertion bound to it.
 */
export async function beginApprovalAllowAction(input: {
  csrfToken: string;
  approvalId: string;
  decisions: readonly ApprovalDecisionInput[];
}): Promise<BeginAllowResult> {
  const workspace = await viewerWorkspace(input.csrfToken);
  if (isFailure(workspace)) return { ok: false, reason: workspace.reason };
  const accounts = await accountsStub();
  if (accounts === null) return { ok: false, reason: "This deployment has no account storage configured." };

  try {
    const listed = await workspace.stub.listVaultApprovals({ actor: workspace.actor, now: Date.now() });
    const card = listed.approvals.find((approval) => approval.approvalId === input.approvalId);
    if (card === undefined || !card.viewerMayDecide) return { ok: false, reason: "That request is no longer open." };
    // The digest is computed from what the workspace holds, not from what the
    // browser sent, so the gesture authorises the decision the server will
    // actually apply.
    const digest = canonicalApprovalDigest({
      approvalId: card.approvalId,
      items: card.items.map((item) => ({
        credentialId: item.credentialId, name: item.name, version: item.version, policyEpoch: item.policyEpoch,
      })),
      decisions: input.decisions,
    });
    const party = await relyingParty();
    const begun = await accounts.beginVaultApprovalAssertion({
      accountId: workspace.accountId, digest, ...(party === undefined ? {} : { relyingParty: party }),
    });
    return { ok: true, challengeId: begun.id, digest, options: begun.options };
  } catch (error) {
    return { ok: false, reason: shellErrorReason(error) };
  }
}

/**
 * Step two: verify the assertion, then answer the card in the same request. The
 * digest is recomputed here rather than trusted, so a browser cannot present a
 * gesture for one decision and ask for another.
 */
export async function finishApprovalAllowAction(input: {
  csrfToken: string;
  approvalId: string;
  decisions: readonly ApprovalDecisionInput[];
  challengeId: string;
  credentialId: string;
  response: unknown;
}): Promise<ApprovalsResult> {
  const workspace = await viewerWorkspace(input.csrfToken);
  if (isFailure(workspace)) return { ok: false, reason: workspace.reason };
  const accounts = await accountsStub();
  if (accounts === null) return { ok: false, reason: "This deployment has no account storage configured." };

  try {
    const listed = await workspace.stub.listVaultApprovals({ actor: workspace.actor, now: Date.now() });
    const card = listed.approvals.find((approval) => approval.approvalId === input.approvalId);
    if (card === undefined || !card.viewerMayDecide) return { ok: false, reason: "That request is no longer open." };
    const digest = canonicalApprovalDigest({
      approvalId: card.approvalId,
      items: card.items.map((item) => ({
        credentialId: item.credentialId, name: item.name, version: item.version, policyEpoch: item.policyEpoch,
      })),
      decisions: input.decisions,
    });
    const party = await relyingParty();
    const verified = await accounts.verifyVaultApprovalAssertion({
      accountId: workspace.accountId,
      challengeId: input.challengeId,
      credentialId: input.credentialId,
      response: input.response,
      digest,
      ...(party === undefined ? {} : { relyingParty: party }),
    });
    const answered = await workspace.stub.decideVaultApproval({
      actor: workspace.actor,
      approvalId: input.approvalId,
      decisions: input.decisions,
      stepUp: { verified, digest },
      now: Date.now(),
    });
    const after = await workspace.stub.listVaultApprovals({ actor: workspace.actor, now: Date.now() });
    return {
      ok: answered.accepted,
      ...(answered.accepted ? {} : { reason: answered.reason ?? "that request was already answered" }),
      approvals: after.approvals,
    };
  } catch (error) {
    const after = await workspace.stub.listVaultApprovals({ actor: workspace.actor, now: Date.now() });
    return { ok: false, reason: shellErrorReason(error), approvals: after.approvals };
  }
}

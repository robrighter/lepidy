"use server";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { headers } from "next/headers";

import { ACCOUNTS_OBJECT_NAME } from "@/src/cloudflare/accounts-address";
import type { Accounts } from "@/src/cloudflare/accounts";
import type { VaultGrantRow } from "@/src/cloudflare/workspace";
import { originFromHeaders } from "@/src/domain/mcp-oauth";
import { canonicalVaultActionDigest } from "@/src/domain/vault-approval";
import type { ShellEnvironment } from "@/src/shell/resolve-shell-source";
import { isFailure, shellErrorReason, viewerWorkspace } from "@/src/shell/viewer-workspace";

/**
 * The vault's protective actions.
 *
 * Switching something off and taking a grant back are plain form posts that
 * work before the page has hydrated, because those are the actions somebody
 * reaches for when they think something is wrong. Switching protection back on
 * is the direction that needs a verified gesture, and it is the only one here
 * that needs the page to be working.
 */

export type VaultActionResult = {
  ok: boolean;
  reason?: string;
  /**
   * The list as it stands after the change, so the table advances from the
   * answer rather than waiting on a revalidation that would land after the
   * client had already applied it.
   */
  grants?: readonly VaultGrantRow[];
};

export type BeginStepUpResult =
  | { ok: true; challengeId: string; digest: string; options: unknown }
  | { ok: false; reason: string };

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
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

async function relyingParty(): Promise<{ rpId: string; origin: string } | undefined> {
  const list = await headers();
  const host = list.get("host");
  if (host === null || host.length === 0) return undefined;
  return { rpId: host.split(":")[0], origin: originFromHeaders(host, list.get("x-forwarded-proto"), `https://${host}`) };
}

/** Take one live grant back. Managers, admins and the holder may all do it. */
export async function revokeGrantAction(previous: VaultActionResult | null, form: FormData): Promise<VaultActionResult> {
  const workspace = await viewerWorkspace(field(form, "csrfToken"));
  if (isFailure(workspace)) return { ok: false, reason: workspace.reason, grants: previous?.grants };
  // The same scope the table was rendered with, so what comes back replaces
  // exactly what was on screen.
  const scope = {
    ...(field(form, "credentialId") === "" ? {} : { credentialId: field(form, "credentialId") }),
    ...(field(form, "agentId") === "" ? {} : { agentId: field(form, "agentId") }),
  };
  try {
    const revoked = await workspace.stub.revokeVaultGrant({
      actor: workspace.actor,
      grantId: field(form, "grantId"),
      now: Date.now(),
    });
    const listed = await workspace.stub.listVaultGrants({ actor: workspace.actor, ...scope, now: Date.now() });
    // Already gone is the outcome the person wanted, not an error.
    return {
      ok: true,
      ...(revoked.revoked ? {} : { reason: "That grant had already ended." }),
      grants: listed.grants,
    };
  } catch (error) {
    const listed = await workspace.stub.listVaultGrants({ actor: workspace.actor, ...scope, now: Date.now() });
    return { ok: false, reason: shellErrorReason(error), grants: listed.grants };
  }
}

/** Switch one credential off for everybody. No step-up, by design. */
export async function freezeCredentialAction(
  _previous: VaultActionResult | null,
  form: FormData,
): Promise<VaultActionResult> {
  const workspace = await viewerWorkspace(field(form, "csrfToken"));
  if (isFailure(workspace)) return { ok: false, reason: workspace.reason };
  try {
    await workspace.stub.setVaultCredentialFreeze({
      actor: workspace.actor,
      credentialId: field(form, "credentialId"),
      frozen: true,
      now: Date.now(),
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: shellErrorReason(error) };
  }
}

/** Cut one agent off from credentials without silencing it. */
export async function switchAgentVaultOffAction(
  _previous: VaultActionResult | null,
  form: FormData,
): Promise<VaultActionResult> {
  const workspace = await viewerWorkspace(field(form, "csrfToken"));
  if (isFailure(workspace)) return { ok: false, reason: workspace.reason };
  try {
    await workspace.stub.setAgentVaultAccess({
      actor: workspace.actor,
      agentId: field(form, "agentId"),
      enabled: false,
      now: Date.now(),
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: shellErrorReason(error) };
  }
}

/** The workspace-wide switch, off. Anybody who is signed in may pull it. */
export async function switchWorkspaceVaultOffAction(
  _previous: VaultActionResult | null,
  form: FormData,
): Promise<VaultActionResult> {
  const workspace = await viewerWorkspace(field(form, "csrfToken"));
  if (isFailure(workspace)) return { ok: false, reason: workspace.reason };
  try {
    await workspace.stub.setVaultAgentAccess({
      actor: workspace.actor,
      enabled: false,
      freshUserVerification: false,
      now: Date.now(),
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: shellErrorReason(error) };
  }
}

export type VaultSwitchOnAction = "vault.access_on" | "vault.credential_on" | "vault.agent_on";

/** Step one of switching protection back on: a gesture bound to that exact act. */
export async function beginVaultStepUpAction(input: {
  csrfToken: string;
  action: VaultSwitchOnAction;
  subjectId: string;
}): Promise<BeginStepUpResult> {
  const workspace = await viewerWorkspace(input.csrfToken);
  if (isFailure(workspace)) return { ok: false, reason: workspace.reason };
  const accounts = await accountsStub();
  if (accounts === null) return { ok: false, reason: "This deployment has no account storage configured." };
  try {
    const digest = canonicalVaultActionDigest({ action: input.action, subjectId: input.subjectId, epoch: 1 });
    const party = await relyingParty();
    const begun = await accounts.beginVaultApprovalAssertion({
      accountId: workspace.accountId,
      digest,
      ...(party === undefined ? {} : { relyingParty: party }),
    });
    return { ok: true, challengeId: begun.id, digest, options: begun.options };
  } catch (error) {
    return { ok: false, reason: shellErrorReason(error) };
  }
}

/** Step two: verify the gesture, then make the change it authorised. */
export async function finishVaultStepUpAction(input: {
  csrfToken: string;
  action: VaultSwitchOnAction;
  subjectId: string;
  challengeId: string;
  credentialId: string;
  response: unknown;
}): Promise<VaultActionResult> {
  const workspace = await viewerWorkspace(input.csrfToken);
  if (isFailure(workspace)) return { ok: false, reason: workspace.reason };
  const accounts = await accountsStub();
  if (accounts === null) return { ok: false, reason: "This deployment has no account storage configured." };
  try {
    // Recomputed here rather than trusted, so a browser cannot present a
    // gesture for one switch and ask for another.
    const digest = canonicalVaultActionDigest({ action: input.action, subjectId: input.subjectId, epoch: 1 });
    const party = await relyingParty();
    const verified = await accounts.verifyVaultApprovalAssertion({
      accountId: workspace.accountId,
      challengeId: input.challengeId,
      credentialId: input.credentialId,
      response: input.response,
      digest,
      ...(party === undefined ? {} : { relyingParty: party }),
    });
    if (!verified) return { ok: false, reason: "That gesture could not be verified." };
    const now = Date.now();
    switch (input.action) {
      case "vault.access_on":
        await workspace.stub.setVaultAgentAccess({
          actor: workspace.actor,
          enabled: true,
          freshUserVerification: true,
          now,
        });
        break;
      case "vault.credential_on":
        await workspace.stub.setVaultCredentialFreeze({
          actor: workspace.actor,
          credentialId: input.subjectId,
          frozen: false,
          now,
        });
        break;
      case "vault.agent_on":
        await workspace.stub.setAgentVaultAccess({
          actor: workspace.actor,
          agentId: input.subjectId,
          enabled: true,
          now,
        });
        break;
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: shellErrorReason(error) };
  }
}

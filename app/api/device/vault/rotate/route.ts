import type { VaultCiphertextEnvelope, VaultKeyWrap } from "@/src/domain/vault-envelope";
import {
  authorizeDeviceRequest,
  deviceEnvironment,
  deviceError,
  deviceJson,
  verifyDevicePassword,
} from "@/src/shell/device-api";

/**
 * Replacing a credential's value — `lepidy rotate`.
 *
 * There is deliberately no way for an agent to reach this. The write path an
 * agent has is `capture`, and `capture` is create-only precisely so a
 * prompt-injected agent cannot overwrite a token with an attacker's while every
 * tool carries on authenticating and nothing looks wrong. Rotation is the human
 * counterpart: a person at an unlocked client, who already holds the key that
 * opens the credential, re-sealing it under a new one.
 *
 * The metadata and policy are carried over unchanged. Rotation replaces a
 * value; changing what a credential is permitted to do is a separate decision
 * and should be a separate act.
 */
export async function POST(request: Request) {
  const env = await deviceEnvironment();
  if (env === null) return deviceError("unavailable", "this deployment has no control plane configured", 503);
  const authorized = await authorizeDeviceRequest(env, request);
  if (authorized instanceof Response) return authorized;

  const body = authorized.body as Record<string, unknown>;
  if (typeof body.credentialId !== "string") return deviceError("invalid_body", "credentialId is required");
  if (!(await verifyDevicePassword(env, authorized.accountId, body.password))) {
    return deviceError("verification_required", "rotating a credential needs fresh user verification", 403);
  }

  const actor = { memberId: authorized.memberId, authorizationEpoch: authorized.claims.authorizationEpoch };
  try {
    const current = await authorized.workspace.describeVaultCredential({
      actor,
      credentialId: body.credentialId,
      now: Date.now(),
    });
    const rotated = await authorized.workspace.updateVaultCredential({
      actor,
      credentialId: body.credentialId,
      metadata: current.credential,
      policy: current.credential.policy,
      envelope: body.envelope as VaultCiphertextEnvelope,
      wraps: body.wraps as readonly VaultKeyWrap[],
      // Custodianship is unchanged by a rotation: the same people manage it,
      // and the wraps the client sent must match them exactly.
      acl: [
        { subjectType: "member", subjectId: authorized.memberId, verb: "manage" },
        { subjectType: "member", subjectId: authorized.memberId, verb: "use" },
      ],
      freshUserVerification: true,
      localVaultUnlocked: true,
      now: Date.now(),
    });
    return deviceJson({ credential: rotated.credential });
  } catch (error) {
    return deviceError("rotate_refused", error instanceof Error ? error.message : "that rotation was refused", 400);
  }
}

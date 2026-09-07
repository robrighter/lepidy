import type { VaultCiphertextEnvelope, VaultKeyWrap } from "@/src/domain/vault-envelope";
import type { VaultAclEntry, VaultCredentialMetadata, VaultPolicy } from "@/src/domain/vault-policy";
import {
  authorizeDeviceRequest,
  deviceEnvironment,
  deviceError,
  deviceJson,
  verifyDevicePassword,
} from "@/src/shell/device-api";

/**
 * Create a credential from an enrolled client — `lepidy add`.
 *
 * What arrives is already sealed: an AES-GCM envelope bound to this workspace,
 * credential id and version, plus one wrap per custodian. The plaintext was
 * read from the caller's terminal and encrypted before the request was built,
 * so there is no point in this code path where the value exists in the cloud.
 *
 * Both halves of the vault step-up are established here rather than asserted by
 * the caller. `freshUserVerification` is a password check inside this request.
 * `localVaultUnlocked` is the signature the request already carried: the device
 * signing key is sealed under the client's local passphrase, so a valid
 * signature is evidence that the local vault was open when the request was made
 * — and it is the only such evidence a server can have, since an unlock that
 * reached the server would no longer be local.
 */
export async function POST(request: Request) {
  const env = await deviceEnvironment();
  if (env === null) return deviceError("unavailable", "this deployment has no control plane configured", 503);
  const authorized = await authorizeDeviceRequest(env, request);
  if (authorized instanceof Response) return authorized;

  const body = authorized.body as Record<string, unknown>;
  if (typeof body.credentialId !== "string" || typeof body.idempotencyKey !== "string") {
    return deviceError("invalid_body", "credentialId and idempotencyKey are required");
  }
  if (!(await verifyDevicePassword(env, authorized.accountId, body.password))) {
    return deviceError("verification_required", "creating a credential needs fresh user verification", 403);
  }

  try {
    // Shape-checked by the workspace, not here: `normalizeVaultMetadata`,
    // `normalizeVaultPolicy`, `validateVaultEnvelope`, `validateVaultKeyWrap` and
    // `validateVaultAcl` are the one authority on what a credential may be, and a
    // second set of checks in the route would only be a second thing to drift.
    const created = await authorized.workspace.createVaultCredential({
      actor: { memberId: authorized.memberId, authorizationEpoch: authorized.claims.authorizationEpoch },
      idempotencyKey: body.idempotencyKey,
      credentialId: body.credentialId,
      metadata: body.metadata as VaultCredentialMetadata,
      policy: body.policy as VaultPolicy,
      envelope: body.envelope as VaultCiphertextEnvelope,
      wraps: body.wraps as readonly VaultKeyWrap[],
      acl: body.acl as readonly VaultAclEntry[],
      freshUserVerification: true,
      localVaultUnlocked: true,
      now: Date.now(),
    });
    return deviceJson({ credential: created.credential, created: created.created });
  } catch (error) {
    return deviceError("create_refused", error instanceof Error ? error.message : "that credential was refused", 400);
  }
}

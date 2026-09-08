import type { VaultCiphertextEnvelope, VaultKeyWrap } from "@/src/domain/vault-envelope";
import {
  authorizeDeviceRequest,
  deviceEnvironment,
  deviceError,
  deviceJson,
  verifyDevicePassword,
} from "@/src/shell/device-api";

/** Remove one custodian through a client-generated full credential rekey. */
export async function POST(request: Request) {
  const env = await deviceEnvironment();
  if (env === null) return deviceError("unavailable", "this deployment has no control plane configured", 503);
  const authorized = await authorizeDeviceRequest(env, request);
  if (authorized instanceof Response) return authorized;
  const body = authorized.body as Record<string, unknown>;
  if (typeof body.credentialId !== "string" || typeof body.removedMemberId !== "string" || !Array.isArray(body.wraps)) {
    return deviceError("invalid_body", "credentialId, removedMemberId, envelope and wraps are required");
  }
  if (body.confirmed !== true) return deviceError("confirmation_required", "removing a custodian needs explicit confirmation", 403);
  if (!(await verifyDevicePassword(env, authorized.accountId, body.password))) {
    return deviceError("verification_required", "removing a custodian needs fresh user verification", 403);
  }
  try {
    const result = await authorized.workspace.removeVaultCustodian({
      actor: { memberId: authorized.memberId, authorizationEpoch: authorized.claims.authorizationEpoch },
      credentialId: body.credentialId,
      removedMemberId: body.removedMemberId,
      envelope: body.envelope as VaultCiphertextEnvelope,
      wraps: body.wraps as readonly VaultKeyWrap[],
      freshUserVerification: true,
      localVaultUnlocked: true,
      confirmed: true,
      now: Date.now(),
    });
    return deviceJson(result);
  } catch (error) {
    return deviceError("custodian_remove_refused", error instanceof Error ? error.message : "that removal was refused", 400);
  }
}

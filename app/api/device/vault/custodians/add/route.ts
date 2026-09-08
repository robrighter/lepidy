import type { VaultKeyWrap } from "@/src/domain/vault-envelope";
import {
  authorizeDeviceRequest,
  deviceEnvironment,
  deviceError,
  deviceJson,
  verifyDevicePassword,
} from "@/src/shell/device-api";

/** Add one custodian wrap produced by an unlocked existing custodian client. */
export async function POST(request: Request) {
  const env = await deviceEnvironment();
  if (env === null) return deviceError("unavailable", "this deployment has no control plane configured", 503);
  const authorized = await authorizeDeviceRequest(env, request);
  if (authorized instanceof Response) return authorized;
  const body = authorized.body as Record<string, unknown>;
  if (typeof body.credentialId !== "string" || typeof body.recipientMemberId !== "string") {
    return deviceError("invalid_body", "credentialId and recipientMemberId are required");
  }
  if (body.confirmed !== true) return deviceError("confirmation_required", "adding a custodian needs explicit confirmation", 403);
  if (!(await verifyDevicePassword(env, authorized.accountId, body.password))) {
    return deviceError("verification_required", "adding a custodian needs fresh user verification", 403);
  }
  try {
    const result = await authorized.workspace.addVaultCustodian({
      actor: { memberId: authorized.memberId, authorizationEpoch: authorized.claims.authorizationEpoch },
      credentialId: body.credentialId,
      recipientMemberId: body.recipientMemberId,
      wrap: body.wrap as VaultKeyWrap,
      freshUserVerification: true,
      localVaultUnlocked: true,
      confirmed: true,
      now: Date.now(),
    });
    return deviceJson(result);
  } catch (error) {
    return deviceError("custodian_add_refused", error instanceof Error ? error.message : "that custodian was refused", 400);
  }
}

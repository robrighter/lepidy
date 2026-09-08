import { VaultRecoveryService, type VaultRecoveryPackage } from "@/src/control/vault-recovery";
import type { VaultKeyWrap } from "@/src/domain/vault-envelope";
import {
  authorizeDeviceRequest,
  deviceEnvironment,
  deviceError,
  deviceJson,
  verifyDevicePassword,
} from "@/src/shell/device-api";

/** Rekey away from a lost device, then revoke its control-plane credential. */
export async function POST(request: Request) {
  const env = await deviceEnvironment();
  if (env === null) return deviceError("unavailable", "this deployment has no control plane configured", 503);
  const authorized = await authorizeDeviceRequest(env, request);
  if (authorized instanceof Response) return authorized;
  const body = authorized.body as Record<string, unknown>;
  if (
    typeof body.removedDeviceId !== "string"
    || typeof body.expectedVaultEpoch !== "number"
    || typeof body.expectedKeyEpoch !== "number"
    || typeof body.publicKey !== "string"
    || !Array.isArray(body.replacements)
  ) return deviceError("invalid_body", "device removal requires the target and complete recovery/rekey packages");
  if (body.confirmed !== true) return deviceError("confirmation_required", "device removal needs explicit confirmation", 403);
  if (!(await verifyDevicePassword(env, authorized.accountId, body.password))) {
    return deviceError("verification_required", "device removal needs fresh user verification", 403);
  }
  try {
    const actor = { memberId: authorized.memberId, authorizationEpoch: authorized.claims.authorizationEpoch };
    const key = await authorized.workspace.rotateVaultMemberKey({
      actor,
      expectedKeyEpoch: body.expectedKeyEpoch,
      publicKey: body.publicKey,
      deviceId: authorized.deviceId,
      replacements: body.replacements as readonly { credentialId: string; credentialVersion: number; wrap: VaultKeyWrap }[],
      freshUserVerification: true,
      localVaultUnlocked: true,
      confirmed: true,
      now: Date.now(),
    });
    const recovery = await new VaultRecoveryService(env.db).removeDeviceAfterRekey({
      accountId: authorized.accountId,
      actingDeviceId: authorized.deviceId,
      removedDeviceId: body.removedDeviceId,
      expectedVaultEpoch: body.expectedVaultEpoch,
      package: body.recoveryPackage as VaultRecoveryPackage,
      freshUserVerification: true,
      confirmed: true,
    });
    await authorized.workspace.revokeVaultGrantsForDevice({ deviceId: body.removedDeviceId, now: Date.now() });
    return deviceJson({ key, recovery, removedDeviceId: body.removedDeviceId });
  } catch (error) {
    return deviceError("device_removal_refused", error instanceof Error ? error.message : "that device removal was refused", 400);
  }
}

import type { VaultKeyWrap } from "@/src/domain/vault-envelope";
import {
  authorizeDeviceRequest,
  deviceEnvironment,
  deviceError,
  deviceJson,
  verifyDevicePassword,
} from "@/src/shell/device-api";

/** Publish a recovered/replacement member key and all of its credential wraps atomically. */
export async function POST(request: Request) {
  const env = await deviceEnvironment();
  if (env === null) return deviceError("unavailable", "this deployment has no control plane configured", 503);
  const authorized = await authorizeDeviceRequest(env, request);
  if (authorized instanceof Response) return authorized;
  const body = authorized.body as Record<string, unknown>;
  if (
    typeof body.expectedKeyEpoch !== "number"
    || typeof body.publicKey !== "string"
    || !Array.isArray(body.replacements)
  ) return deviceError("invalid_body", "expectedKeyEpoch, publicKey and replacements are required");
  if (body.confirmed !== true) return deviceError("confirmation_required", "vault key rotation needs explicit confirmation", 403);
  if (!(await verifyDevicePassword(env, authorized.accountId, body.password))) {
    return deviceError("verification_required", "vault key rotation needs fresh user verification", 403);
  }
  try {
    return deviceJson(await authorized.workspace.rotateVaultMemberKey({
      actor: { memberId: authorized.memberId, authorizationEpoch: authorized.claims.authorizationEpoch },
      expectedKeyEpoch: body.expectedKeyEpoch,
      publicKey: body.publicKey,
      deviceId: authorized.deviceId,
      replacements: body.replacements as readonly { credentialId: string; credentialVersion: number; wrap: VaultKeyWrap }[],
      freshUserVerification: true,
      localVaultUnlocked: true,
      confirmed: true,
      now: Date.now(),
    }));
  } catch (error) {
    return deviceError("member_key_rotation_refused", error instanceof Error ? error.message : "that key rotation was refused", 400);
  }
}

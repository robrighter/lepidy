import {
  authorizeDeviceRequest,
  deviceEnvironment,
  deviceError,
  deviceJson,
  verifyDevicePassword,
} from "@/src/shell/device-api";

/** Current ciphertext plus this member's wraps for local recovery/rekey work. */
export async function POST(request: Request) {
  const env = await deviceEnvironment();
  if (env === null) return deviceError("unavailable", "this deployment has no control plane configured", 503);
  const authorized = await authorizeDeviceRequest(env, request);
  if (authorized instanceof Response) return authorized;
  const body = authorized.body as Record<string, unknown>;
  if (!(await verifyDevicePassword(env, authorized.accountId, body.password))) {
    return deviceError("verification_required", "vault rekey preparation needs fresh user verification", 403);
  }
  try {
    return deviceJson(authorized.workspace.getVaultMemberRekeyMaterial({
      actor: { memberId: authorized.memberId, authorizationEpoch: authorized.claims.authorizationEpoch },
      freshUserVerification: true,
      localVaultUnlocked: true,
    }));
  } catch (error) {
    return deviceError("member_key_material_refused", error instanceof Error ? error.message : "that key material was refused", 400);
  }
}

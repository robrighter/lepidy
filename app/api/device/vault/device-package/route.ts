import { VaultRecoveryService, type VaultDevicePackage } from "@/src/control/vault-recovery";
import {
  authorizeDeviceRequest,
  deviceEnvironment,
  deviceError,
  deviceJson,
  verifyDevicePassword,
} from "@/src/shell/device-api";

/** Existing devices approve opaque packages; a target device can consume only its own exact epoch. */
export async function POST(request: Request) {
  const env = await deviceEnvironment();
  if (env === null) return deviceError("unavailable", "this deployment has no control plane configured", 503);
  const authorized = await authorizeDeviceRequest(env, request);
  if (authorized instanceof Response) return authorized;
  const body = authorized.body as Record<string, unknown>;
  const service = new VaultRecoveryService(env.db);
  try {
    if (body.action === "consume") {
      const packageValue = await service.consumeDevicePackage({
        accountId: authorized.accountId,
        targetDeviceId: authorized.deviceId,
        targetDeviceKeyEpoch: authorized.claims.deviceKeyEpoch,
      });
      return deviceJson({ package: packageValue });
    }
    if (body.action === "store") {
      if (!(await verifyDevicePassword(env, authorized.accountId, body.password))) {
        return deviceError("verification_required", "approving a device needs fresh user verification", 403);
      }
      return deviceJson(await service.storeDevicePackage({
        accountId: authorized.accountId,
        approvedByDeviceId: authorized.deviceId,
        package: body.package as VaultDevicePackage,
        freshUserVerification: true,
        confirmed: body.confirmed === true,
      }));
    }
    return deviceError("invalid_body", "action must be store or consume");
  } catch (error) {
    return deviceError("device_package_refused", error instanceof Error ? error.message : "that device package was refused", 400);
  }
}

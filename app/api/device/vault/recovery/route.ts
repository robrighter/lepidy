import { VaultRecoveryService, type VaultRecoveryPackage } from "@/src/control/vault-recovery";
import {
  authorizeDeviceRequest,
  deviceEnvironment,
  deviceError,
  deviceJson,
  verifyDevicePassword,
} from "@/src/shell/device-api";

/** Opaque recovery-package custody; recovery codes and vault keys never enter this route. */
export async function POST(request: Request) {
  const env = await deviceEnvironment();
  if (env === null) return deviceError("unavailable", "this deployment has no control plane configured", 503);
  const authorized = await authorizeDeviceRequest(env, request);
  if (authorized instanceof Response) return authorized;
  const body = authorized.body as Record<string, unknown>;
  const service = new VaultRecoveryService(env.db);
  try {
    if (body.action === "read") return deviceJson(await service.read(authorized.accountId));
    if (!(await verifyDevicePassword(env, authorized.accountId, body.password))) {
      return deviceError("verification_required", "changing recovery needs fresh user verification", 403);
    }
    if (body.action === "initialize") {
      return deviceJson(await service.initialize({
        accountId: authorized.accountId,
        deviceId: authorized.deviceId,
        package: body.package as VaultRecoveryPackage,
        confirmed: body.confirmed === true,
      }));
    }
    if (body.action === "rotate" && typeof body.expectedVaultEpoch === "number") {
      return deviceJson(await service.rotate({
        accountId: authorized.accountId,
        deviceId: authorized.deviceId,
        expectedVaultEpoch: body.expectedVaultEpoch,
        package: body.package as VaultRecoveryPackage,
        confirmed: body.confirmed === true,
      }));
    }
    return deviceError("invalid_body", "action must be read, initialize or rotate");
  } catch (error) {
    return deviceError("recovery_refused", error instanceof Error ? error.message : "that recovery operation was refused", 400);
  }
}

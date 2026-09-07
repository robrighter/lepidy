import { authorizeDeviceRequest, deviceEnvironment, deviceError, deviceJson } from "@/src/shell/device-api";

/**
 * Stop answering for everything, and say so.
 *
 * The machine's own way of standing down cleanly — on shutdown, or when an
 * operator turns the daemon off. An owner can do the same from anywhere without
 * the machine being reachable, which is the case this has to keep working in:
 * the rows go away whether or not anything is listening.
 */
export async function POST(request: Request) {
  const env = await deviceEnvironment();
  if (env === null) return deviceError("unavailable", "this deployment has no control plane configured", 503);
  const authorized = await authorizeDeviceRequest(env, request);
  if (authorized instanceof Response) return authorized;

  const body = authorized.body as { reason?: unknown };
  try {
    const released = await authorized.workspace.releaseRunner({
      actor: { memberId: authorized.memberId, authorizationEpoch: authorized.claims.authorizationEpoch },
      deviceId: authorized.deviceId,
      reason: typeof body.reason === "string" ? body.reason : null,
      now: Date.now(),
    });
    return deviceJson({ workspaceId: authorized.workspaceId, ...released });
  } catch {
    return deviceError("runner_unregistered", "this device is not a registered runner", 409);
  }
}

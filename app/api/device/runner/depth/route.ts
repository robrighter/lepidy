import { authorizeDeviceRequest, deviceEnvironment, deviceError, deviceJson } from "@/src/shell/device-api";

/**
 * "Is there work for me?", answered now.
 *
 * The runner asks on every connection and after every process exit, and that is
 * what closes the lost-wake race without anything being held open. D03 measured
 * this: one bounded call is the entire cost of a wake that never arrived, which
 * is why an idle agent can cost nothing at all.
 */
export async function POST(request: Request) {
  const env = await deviceEnvironment();
  if (env === null) return deviceError("unavailable", "this deployment has no control plane configured", 503);
  const authorized = await authorizeDeviceRequest(env, request);
  if (authorized instanceof Response) return authorized;

  try {
    const depth = await authorized.workspace.runnerQueueDepth({
      actor: { memberId: authorized.memberId, authorizationEpoch: authorized.claims.authorizationEpoch },
      deviceId: authorized.deviceId,
      now: Date.now(),
    });
    return deviceJson({ workspaceId: authorized.workspaceId, ...depth });
  } catch {
    return deviceError("runner_unregistered", "this device is not a registered runner", 409);
  }
}

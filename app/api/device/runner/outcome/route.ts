import { authorizeDeviceRequest, deviceEnvironment, deviceError, deviceJson } from "@/src/shell/device-api";

/**
 * What happened to a run, as the machine saw it.
 *
 * Reported by the daemon rather than by the harness, deliberately: a harness
 * that dies, hangs or is killed reports nothing, and those are exactly the
 * cases somebody needs to hear about. A `blocked` outcome — the harness
 * refusing something under its own safe default permission posture — is a
 * person's decision waiting to be made, not an error, and it lands where an
 * owner will see it.
 */
export async function POST(request: Request) {
  const env = await deviceEnvironment();
  if (env === null) return deviceError("unavailable", "this deployment has no control plane configured", 503);
  const authorized = await authorizeDeviceRequest(env, request);
  if (authorized instanceof Response) return authorized;

  const body = authorized.body as { agentId?: unknown; sessionId?: unknown; outcome?: unknown; reason?: unknown };
  if (typeof body.agentId !== "string" || typeof body.sessionId !== "string" || typeof body.outcome !== "string") {
    return deviceError("invalid_body", "agentId, sessionId and outcome are required");
  }
  try {
    const reported = await authorized.workspace.reportRunnerOutcome({
      actor: { memberId: authorized.memberId, authorizationEpoch: authorized.claims.authorizationEpoch },
      deviceId: authorized.deviceId,
      agentId: body.agentId,
      sessionId: body.sessionId,
      outcome: body.outcome as "completed" | "blocked" | "failed",
      reason: typeof body.reason === "string" ? body.reason : null,
      now: Date.now(),
    });
    return deviceJson({ workspaceId: authorized.workspaceId, ...reported });
  } catch {
    return deviceError("report_refused", "that report was refused", 403);
  }
}

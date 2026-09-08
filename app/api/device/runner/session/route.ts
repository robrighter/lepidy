import { authorizeDeviceRequest, deviceEnvironment, deviceError, deviceJson } from "@/src/shell/device-api";

/**
 * The session a harness on this machine speaks MCP with.
 *
 * The daemon names an agent it already answers for; the workspace finds that
 * agent's live delegation itself, so a runner cannot ask for authority nobody
 * gave it. The token comes back once and is handed to the harness through its
 * environment, never through a command line.
 *
 * A session is meant to be *kept*. Starting a harness is the expensive part, so
 * one session serves many runs — bounded, as A04 already enforces, by the
 * delegation's lifetime and the eight-hour session ceiling.
 */
export async function POST(request: Request) {
  const env = await deviceEnvironment();
  if (env === null) return deviceError("unavailable", "this deployment has no control plane configured", 503);
  const authorized = await authorizeDeviceRequest(env, request);
  if (authorized instanceof Response) return authorized;

  const body = authorized.body as { agentId?: unknown };
  if (typeof body.agentId !== "string" || body.agentId.length === 0) {
    return deviceError("invalid_body", "agentId is required");
  }
  try {
    const grant = await authorized.workspace.startRunnerSession({
      actor: { memberId: authorized.memberId, authorizationEpoch: authorized.claims.authorizationEpoch },
      deviceId: authorized.deviceId,
      agentId: body.agentId,
      now: Date.now(),
    });
    return deviceJson({ workspaceId: authorized.workspaceId, ...grant });
  } catch {
    // One wording for an agent this device does not answer for, one for an
    // agent with no live delegation, and one for a device that is not a
    // runner — a caller learns its request was refused, not which of those.
    return deviceError("session_refused", "a session for that agent was refused", 403);
  }
}

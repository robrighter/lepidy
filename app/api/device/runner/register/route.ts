import { authorizeDeviceRequest, deviceEnvironment, deviceError, deviceJson } from "@/src/shell/device-api";

/**
 * `lepidy-agentd` declaring which agents this machine answers for.
 *
 * What travels is a list of agent ids and, for each, the *name* of a preset the
 * machine already holds. Nothing describes what runs: no executable, no
 * arguments, no working directory, no environment mapping, no permission
 * posture. The workspace stores the name so it can say it back in a wake, and a
 * name the machine no longer recognises is refused on the machine.
 */
export async function POST(request: Request) {
  const env = await deviceEnvironment();
  if (env === null) return deviceError("unavailable", "this deployment has no control plane configured", 503);
  const authorized = await authorizeDeviceRequest(env, request);
  if (authorized instanceof Response) return authorized;

  const body = authorized.body as { runnerEpoch?: unknown; agents?: unknown };
  const agents = Array.isArray(body.agents) ? body.agents : null;
  if (agents === null) return deviceError("invalid_body", "agents must be an array");
  const claims: { agentId: string; presetId: string }[] = [];
  for (const entry of agents) {
    if (typeof entry !== "object" || entry === null) return deviceError("invalid_body", "each agent needs an id and a preset");
    const { agentId, presetId } = entry as { agentId?: unknown; presetId?: unknown };
    if (typeof agentId !== "string" || typeof presetId !== "string") {
      return deviceError("invalid_body", "each agent needs an id and a preset");
    }
    claims.push({ agentId, presetId });
  }

  try {
    // The device id and the config revision come from the signed claims, not
    // from the body: a runner cannot register a machine it is not, or claim a
    // preset revision it did not sign for.
    const registered = await authorized.workspace.registerRunner({
      actor: { memberId: authorized.memberId, authorizationEpoch: authorized.claims.authorizationEpoch },
      deviceId: authorized.deviceId,
      runnerEpoch: Number(body.runnerEpoch),
      presetRevision: authorized.claims.configRevision,
      agents: claims,
      now: Date.now(),
    });
    return deviceJson({ workspaceId: authorized.workspaceId, ...registered });
  } catch {
    return deviceError("registration_refused", "that runner registration was refused", 403);
  }
}

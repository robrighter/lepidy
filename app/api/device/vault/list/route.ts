import { authorizeDeviceRequest, deviceEnvironment, deviceError, deviceJson } from "@/src/shell/device-api";

/**
 * Credential metadata for `lepidy list`.
 *
 * Metadata only, by construction: the workspace's own discovery method
 * serialises no ciphertext, no wrap and no value, and this passes that result
 * through unchanged. A device that can list is not thereby a device that can
 * open anything.
 */
export async function POST(request: Request) {
  const env = await deviceEnvironment();
  if (env === null) return deviceError("unavailable", "this deployment has no control plane configured", 503);
  const authorized = await authorizeDeviceRequest(env, request);
  if (authorized instanceof Response) return authorized;

  const body = authorized.body as { agentId?: string; delegationId?: string; originChannelId?: string };
  try {
    const listed = await authorized.workspace.listVaultCredentials({
      actor: { memberId: authorized.memberId, authorizationEpoch: authorized.claims.authorizationEpoch },
      ...(typeof body.agentId === "string" ? { agentId: body.agentId } : {}),
      ...(typeof body.delegationId === "string" ? { delegationId: body.delegationId } : {}),
      ...(typeof body.originChannelId === "string" ? { originChannelId: body.originChannelId } : {}),
      now: Date.now(),
    });
    return deviceJson({ workspaceId: authorized.workspaceId, credentials: listed.credentials });
  } catch {
    return deviceError("list_refused", "that listing was refused", 403);
  }
}

import { authorizeDeviceRequest, deviceEnvironment, deviceError, deviceJson } from "@/src/shell/device-api";

/**
 * The same-device local release path behind `lepidy run`.
 *
 * The decision is the workspace's, taken against the full D04 policy with this
 * request's own signed device, project, origin and delegation. What comes back
 * on an allow is still ciphertext: the envelope and the wrap sealed for this
 * member. Unwrapping happens on the client, so a refusal here is the only thing
 * standing between an agent and a credential — and a compromised Worker still
 * has nothing it can open.
 *
 * `needs_approval` is answered honestly rather than as a denial: the
 * conversational approval that resolves it is V03's, and until it lands the CLI
 * says so and stops instead of pretending the credential does not exist.
 */
export async function POST(request: Request) {
  const env = await deviceEnvironment();
  if (env === null) return deviceError("unavailable", "this deployment has no control plane configured", 503);
  const authorized = await authorizeDeviceRequest(env, request);
  if (authorized instanceof Response) return authorized;

  const body = authorized.body as Record<string, unknown>;
  const origin = (body.origin ?? {}) as { channelId?: unknown; messageId?: unknown };
  if (
    typeof body.credentialId !== "string" ||
    typeof body.delivery !== "string" ||
    typeof origin.channelId !== "string" ||
    typeof origin.messageId !== "string"
  ) {
    return deviceError("invalid_body", "credentialId, delivery and origin channel/message are required");
  }
  if (body.delivery !== "inject" && body.delivery !== "file") {
    return deviceError("invalid_body", "this endpoint releases inject and file deliveries only");
  }
  // The project the value is being used in is part of the decision, and the
  // signature already covers it. Taking it from the body instead would let a
  // signed request be re-aimed at a project the policy forbids.
  const projectId = authorized.claims.projectId;

  try {
    const released = await authorized.workspace.releaseVaultCredential({
      actor: { memberId: authorized.memberId, authorizationEpoch: authorized.claims.authorizationEpoch },
      credentialId: body.credentialId,
      device: {
        id: authorized.deviceId,
        active: true,
        ownedByMember: true,
        // Both established by the envelope this request arrived in: the control
        // plane verified the signature and burned the nonce before this ran.
        signatureVerified: true,
        nonceFresh: true,
      },
      origin: { channelId: origin.channelId, messageId: origin.messageId },
      projectId,
      delivery: body.delivery,
      ...(typeof body.agentId === "string" ? { agentId: body.agentId } : {}),
      ...(typeof body.delegationId === "string" ? { delegationId: body.delegationId } : {}),
      now: Date.now(),
    });
    return deviceJson({
      workspaceId: authorized.workspaceId,
      decision: released.decision,
      ...(released.hint === undefined ? {} : { hint: released.hint }),
      ...(released.envelope === undefined ? {} : { envelope: released.envelope }),
      ...(released.wrap === undefined ? {} : { wrap: released.wrap }),
    });
  } catch {
    return deviceError("release_refused", "that release was refused", 403);
  }
}

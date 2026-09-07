import { authorizeDeviceRequest, deviceEnvironment, deviceError, deviceJson } from "@/src/shell/device-api";
import { MAX_APPROVAL_CREDENTIALS } from "@/src/domain/vault-approval";

/**
 * The same-device local release path behind `lepidy run`.
 *
 * One command asks once, for everything it needs. That is not a convenience: an
 * approval card that lists three credentials is one interruption instead of
 * three, and coalescing is the anti-fatigue measure the whole approval design
 * rests on. Sending them one at a time would produce three cards for one
 * command and train people to click through them.
 *
 * The decision is the workspace's, taken against the full D04 policy with this
 * request's own signed device, project, origin and delegation. What comes back
 * on an allow is still ciphertext: the envelope and the wrap sealed for this
 * member. Unwrapping happens on the client, so a compromised Worker still has
 * nothing it can open.
 */
export async function POST(request: Request) {
  const env = await deviceEnvironment();
  if (env === null) return deviceError("unavailable", "this deployment has no control plane configured", 503);
  const authorized = await authorizeDeviceRequest(env, request);
  if (authorized instanceof Response) return authorized;

  const body = authorized.body as Record<string, unknown>;
  const origin = (body.origin ?? {}) as { channelId?: unknown; messageId?: unknown };
  const credentialIds = Array.isArray(body.credentialIds)
    ? body.credentialIds.filter((value): value is string => typeof value === "string")
    : [];
  if (
    credentialIds.length === 0 ||
    credentialIds.length !== (body.credentialIds as unknown[]).length ||
    typeof body.delivery !== "string" ||
    typeof body.reason !== "string" ||
    typeof origin.channelId !== "string" ||
    typeof origin.messageId !== "string"
  ) {
    return deviceError("invalid_body", "credentialIds, delivery, reason and origin channel/message are required");
  }
  if (credentialIds.length > MAX_APPROVAL_CREDENTIALS) {
    return deviceError("invalid_body", `one command may ask for at most ${MAX_APPROVAL_CREDENTIALS} credentials`);
  }
  if (body.delivery !== "inject" && body.delivery !== "file") {
    return deviceError("invalid_body", "this endpoint releases inject and file deliveries only");
  }
  // The project the value is being used in is part of the decision, and the
  // signature already covers it. Taking it from the body instead would let a
  // signed request be re-aimed at a project the policy forbids.
  const projectId = authorized.claims.projectId;
  const actor = { memberId: authorized.memberId, authorizationEpoch: authorized.claims.authorizationEpoch };
  const device = {
    id: authorized.deviceId,
    active: true,
    ownedByMember: true,
    // Both established by the envelope this request arrived in: the control
    // plane verified the signature and burned the nonce before this ran.
    signatureVerified: true,
    nonceFresh: true,
  };
  const provenance = {
    ...(typeof body.agentId === "string" ? { agentId: body.agentId } : {}),
    ...(typeof body.delegationId === "string" ? { delegationId: body.delegationId } : {}),
  };

  try {
    const results = [];
    const asking: string[] = [];
    for (const credentialId of credentialIds) {
      const released = await authorized.workspace.releaseVaultCredential({
        actor,
        credentialId,
        device,
        origin: { channelId: origin.channelId, messageId: origin.messageId },
        projectId,
        delivery: body.delivery,
        ...provenance,
        now: Date.now(),
      });
      if (released.decision.kind === "needs_approval") asking.push(credentialId);
      results.push({
        credentialId,
        decision: released.decision,
        ...(released.hint === undefined ? {} : { hint: released.hint }),
        ...(released.envelope === undefined ? {} : { envelope: released.envelope }),
        ...(released.wrap === undefined ? {} : { wrap: released.wrap }),
      });
    }

    // Everything still unanswered becomes as few cards as the ownership of
    // those credentials allows — one where the same people own them all.
    const approvals =
      asking.length === 0
        ? []
        : (
            await authorized.workspace.requestVaultApproval({
              actor,
              credentialIds: asking,
              device,
              origin: { channelId: origin.channelId, messageId: origin.messageId },
              projectId,
              delivery: body.delivery,
              reason: body.reason,
              ...provenance,
              now: Date.now(),
            })
          ).approvals;

    return deviceJson({ workspaceId: authorized.workspaceId, results, approvals });
  } catch (error) {
    return deviceError("release_refused", error instanceof Error ? error.message : "that release was refused", 403);
  }
}

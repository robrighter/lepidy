export type VaultDelivery = "inject" | "file" | "device_proxy" | "reveal";
export type VaultDecision =
  | { kind: "allow"; via: "grant" | "automatic" }
  | { kind: "needs_approval" }
  | { kind: "deny"; reason: string };

type Scope = {
  members: readonly string[];
  groups: readonly string[];
  agents: readonly string[];
  channels: readonly string[];
};

export type VaultAuthorizationInput = {
  now: number;
  workspaceAccessOn: boolean;
  member: { id: string; active: boolean; authorizationEpochCurrent: boolean; groupIds: readonly string[] };
  device: { active: boolean; ownedByMember: boolean; signatureVerified: boolean; nonceFresh: boolean };
  origin: { verified: boolean; channelId: string; memberCanAccess: boolean };
  credential: {
    active: boolean;
    mode: "never" | "ask" | "auto";
    use: Scope;
    reveal: Scope;
    allowedDeliveries: readonly VaultDelivery[];
    availableUntil?: number;
    rateAvailable: boolean;
  };
  request: { delivery: VaultDelivery; agentId?: string };
  delegation?: {
    active: boolean;
    ownerIsMember: boolean;
    agentMatches: boolean;
    channelAllowed: boolean;
    credentialAllowed: boolean;
    deliveryAllowed: boolean;
    projectAllowed: boolean;
  };
  grantMatchesExactly: boolean;
};

export function decideVaultAuthorization(input: VaultAuthorizationInput): VaultDecision {
  if (!input.workspaceAccessOn) return deny("agent_access_off");
  if (!input.member.active || !input.member.authorizationEpochCurrent) return deny("membership_inactive");
  if (!input.device.active || !input.device.ownedByMember) return deny("device_inactive");
  if (!input.device.signatureVerified || !input.device.nonceFresh) return deny("request_unverified");
  if (!input.origin.verified || !input.origin.memberCanAccess) return deny("origin_unverified");
  if (!input.credential.active) return deny("credential_inactive");
  if (input.credential.availableUntil !== undefined && input.now >= input.credential.availableUntil) {
    return deny("outside_availability");
  }
  if (!input.credential.rateAvailable) return deny("rate_limited");
  if (!input.credential.allowedDeliveries.includes(input.request.delivery)) return deny("delivery_refused");

  if (input.request.agentId) {
    const delegation = input.delegation;
    if (
      !delegation?.active ||
      !delegation.ownerIsMember ||
      !delegation.agentMatches ||
      !delegation.channelAllowed ||
      !delegation.credentialAllowed ||
      !delegation.deliveryAllowed ||
      !delegation.projectAllowed
    ) {
      return deny("delegation_refused");
    }
  }

  const aclContext = {
    memberId: input.member.id,
    groupIds: input.member.groupIds,
    agentId: input.request.agentId,
    channelId: input.origin.channelId,
  };
  if (!matchesScope(input.credential.use, aclContext)) return deny("use_acl_refused");
  if (input.request.delivery === "reveal" && !matchesScope(input.credential.reveal, aclContext)) {
    return deny("reveal_acl_refused");
  }

  if (input.grantMatchesExactly) return { kind: "allow", via: "grant" };
  if (input.credential.mode === "never") return deny("policy_never");
  if (input.credential.mode === "ask" || input.request.delivery === "reveal") {
    return { kind: "needs_approval" };
  }
  return { kind: "allow", via: "automatic" };
}

function matchesScope(
  scope: Scope,
  context: { memberId: string; groupIds: readonly string[]; agentId?: string; channelId: string },
): boolean {
  return (
    scope.members.includes(context.memberId) ||
    context.groupIds.some((id) => scope.groups.includes(id)) ||
    (context.agentId !== undefined && scope.agents.includes(context.agentId)) ||
    scope.channels.includes(context.channelId)
  );
}

function deny(reason: string): VaultDecision {
  return { kind: "deny", reason };
}

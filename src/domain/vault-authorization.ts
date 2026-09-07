export type VaultDelivery = "inject" | "file" | "device_proxy" | "reveal";
export type VaultDecision =
  | { kind: "allow"; via: "grant" | "automatic" }
  | { kind: "needs_approval" }
  | { kind: "deny"; reason: string };

export type VaultScope = {
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
    /**
     * The per-credential kill switch. Separate from `mode` and from the ACL
     * because switching a credential off is a protective action that takes no
     * step-up, and because it must outrank every policy a compromised session
     * could otherwise satisfy.
     */
    frozen?: boolean;
    mode: "never" | "ask" | "auto";
    use: VaultScope;
    reveal: VaultScope;
    allowedDeliveries: readonly VaultDelivery[];
    projectAllowed: boolean;
    availableUntil?: number;
    rateAvailable: boolean;
  };
  /** `agentVaultAccessOff` is the per-agent kill switch: this agent may keep working, and may not touch credentials. */
  request: { delivery: VaultDelivery; agentId?: string; agentVaultAccessOff?: boolean };
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
  // The three kill-switch scopes come first, ahead of everything a request
  // could argue with. "Off" has to mean off before any other question is asked.
  if (!input.workspaceAccessOn) return deny("agent_access_off");
  if (input.request.agentId !== undefined && input.request.agentVaultAccessOff === true) {
    return deny("agent_vault_access_off");
  }
  if (input.credential.frozen === true) return deny("credential_frozen");
  if (!input.member.active || !input.member.authorizationEpochCurrent) return deny("membership_inactive");
  if (!input.device.active || !input.device.ownedByMember) return deny("device_inactive");
  if (!input.device.signatureVerified || !input.device.nonceFresh) return deny("request_unverified");
  if (!input.origin.verified || !input.origin.memberCanAccess) return deny("origin_unverified");
  if (!input.credential.active) return deny("credential_inactive");
  if (input.credential.availableUntil !== undefined && input.now >= input.credential.availableUntil) {
    return deny("outside_availability");
  }
  if (!input.credential.projectAllowed) return deny("project_refused");
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
  if (!matchesVaultScope(input.credential.use, aclContext)) return deny("use_acl_refused");
  if (input.request.delivery === "reveal" && !matchesVaultScope(input.credential.reveal, aclContext)) {
    return deny("reveal_acl_refused");
  }

  if (input.grantMatchesExactly) return { kind: "allow", via: "grant" };
  if (input.credential.mode === "never") return deny("policy_never");
  if (input.credential.mode === "ask" || input.request.delivery === "reveal") {
    return { kind: "needs_approval" };
  }
  return { kind: "allow", via: "automatic" };
}

export function matchesVaultScope(
  scope: VaultScope,
  context: { memberId: string; groupIds: readonly string[]; agentId?: string; channelId: string },
): boolean {
  return (
    scope.members.includes(context.memberId) ||
    context.groupIds.some((id) => scope.groups.includes(id)) ||
    (context.agentId !== undefined && scope.agents.includes(context.agentId)) ||
    scope.channels.includes(context.channelId)
  );
}

export function vaultDenialHint(reason: string, name: string, retryAfter?: number): string {
  switch (reason) {
    case "agent_access_off":
      return "Agent access is switched off for this workspace. Ask a human to turn it on; do not look for this credential elsewhere.";
    case "outside_availability":
      return `${name} is outside its availability window. Ask a human to extend it; do not retry elsewhere.`;
    case "project_refused":
      return `${name} is not available to this project. Stop and tell the user; do not retry from another project.`;
    case "rate_limited":
      return `${name} hit its hourly use ceiling.${retryAfter ? ` Retry after ${new Date(retryAfter).toISOString()}.` : ""} Stop rather than retrying in a loop.`;
    case "delivery_refused":
      return `${name} does not permit that delivery. Use the delivery described by its metadata; never read it from a file or ask for it in chat.`;
    case "agent_vault_access_off":
      return `This agent's access to the vault was switched off, so ${name} is unavailable to it. Ask a human to turn it back on; do not use another agent or another route.`;
    case "credential_frozen":
      return `${name} was switched off by a human and cannot be used by anyone until they turn it back on. Stop and tell the user; there is no way around this.`;
    case "no_custodian_wrap":
      return `${name} has no key wrapped for this member, so this device cannot open it. Ask a custodian to share it; do not look for the value elsewhere.`;
    case "policy_never":
      return `${name} is unavailable to agents. Tell the user; there is no way around this.`;
    case "use_acl_refused":
    case "reveal_acl_refused":
    case "delegation_refused":
      return `Access to ${name} was refused. Stop and tell the user; do not search files, shell configuration, or chat for it.`;
    default:
      return `Access to ${name} was refused. Stop and tell the user; do not look for the credential elsewhere.`;
  }
}

function deny(reason: string): VaultDecision {
  return { kind: "deny", reason };
}

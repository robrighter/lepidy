import { describe, expect, it } from "vitest";
import {
  decideVaultAuthorization,
  vaultDenialHint,
  type VaultAuthorizationInput,
} from "./vault-authorization";

function valid(): VaultAuthorizationInput {
  return {
    now: 1_800_000_000_000,
    workspaceAccessOn: true,
    member: { id: "member-1", active: true, authorizationEpochCurrent: true, groupIds: [] },
    device: { active: true, ownedByMember: true, signatureVerified: true, nonceFresh: true },
    origin: { verified: true, channelId: "channel-1", memberCanAccess: true },
    credential: {
      active: true,
      mode: "auto",
      use: { members: ["member-1"], groups: [], agents: [], channels: [] },
      reveal: { members: ["member-1"], groups: [], agents: [], channels: [] },
      allowedDeliveries: ["inject", "file", "device_proxy", "reveal"],
      projectAllowed: true,
      rateAvailable: true,
    },
    request: { delivery: "inject" },
    grantMatchesExactly: false,
  };
}

describe("vault authorization contract", () => {
  it("VAULT-AUTH-001 unions ACL entries within the use verb", () => {
    for (const use of [
      { members: ["member-1"], groups: [], agents: [], channels: [] },
      { members: [], groups: ["group-1"], agents: [], channels: [] },
      { members: [], groups: [], agents: [], channels: ["channel-1"] },
    ]) {
      const input = valid();
      input.member.groupIds = ["group-1"];
      input.credential.use = use;
      expect(decideVaultAuthorization(input)).toEqual({ kind: "allow", via: "automatic" });
    }
  });

  it.each([
    ["workspace access", (x: VaultAuthorizationInput) => (x.workspaceAccessOn = false), "agent_access_off"],
    ["membership", (x: VaultAuthorizationInput) => (x.member.active = false), "membership_inactive"],
    ["device owner", (x: VaultAuthorizationInput) => (x.device.ownedByMember = false), "device_inactive"],
    ["signature", (x: VaultAuthorizationInput) => (x.device.signatureVerified = false), "request_unverified"],
    ["nonce", (x: VaultAuthorizationInput) => (x.device.nonceFresh = false), "request_unverified"],
    ["origin", (x: VaultAuthorizationInput) => (x.origin.verified = false), "origin_unverified"],
    ["project", (x: VaultAuthorizationInput) => (x.credential.projectAllowed = false), "project_refused"],
    ["rate", (x: VaultAuthorizationInput) => (x.credential.rateAvailable = false), "rate_limited"],
  ])("VAULT-AUTH-002 mandatory %s failure overrides an ACL match", (_name, mutate, reason) => {
    const input = valid();
    mutate(input);
    expect(decideVaultAuthorization(input)).toEqual({ kind: "deny", reason });
  });

  it("VAULT-AUTH-003 requires every unattended delegation dimension", () => {
    const input = valid();
    input.request.agentId = "agent-1";
    input.credential.use = { members: [], groups: [], agents: ["agent-1"], channels: [] };
    input.delegation = {
      active: true,
      ownerIsMember: true,
      agentMatches: true,
      channelAllowed: true,
      credentialAllowed: true,
      deliveryAllowed: true,
      projectAllowed: true,
    };
    expect(decideVaultAuthorization(input)).toEqual({ kind: "allow", via: "automatic" });
    input.delegation.credentialAllowed = false;
    expect(decideVaultAuthorization(input)).toEqual({ kind: "deny", reason: "delegation_refused" });
  });

  it("VAULT-AUTH-004 requires use and reveal independently", () => {
    const input = valid();
    input.request.delivery = "reveal";
    input.credential.reveal = { members: [], groups: [], agents: [], channels: [] };
    expect(decideVaultAuthorization(input)).toEqual({ kind: "deny", reason: "reveal_acl_refused" });
    input.credential.reveal = { members: ["member-1"], groups: [], agents: [], channels: [] };
    expect(decideVaultAuthorization(input)).toEqual({ kind: "needs_approval" });
  });

  it("VAULT-AUTH-005 honors only an exact live grant supplied by the durable layer", () => {
    const input = valid();
    input.credential.mode = "ask";
    expect(decideVaultAuthorization(input)).toEqual({ kind: "needs_approval" });
    input.grantMatchesExactly = true;
    expect(decideVaultAuthorization(input)).toEqual({ kind: "allow", via: "grant" });
  });

  it("VAULT-AUTH-006 gives agents instructive denials that forbid circumvention", () => {
    expect(vaultDenialHint("use_acl_refused", "GITHUB_TOKEN")).toContain("do not search files");
    expect(vaultDenialHint("rate_limited", "GITHUB_TOKEN", 1_800_000_100_000)).toContain("Stop rather than retrying");
    expect(vaultDenialHint("project_refused", "GITHUB_TOKEN")).toContain("do not retry from another project");
  });
});

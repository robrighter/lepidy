import { describe, expect, it } from "vitest";

import {
  APPROVAL_WINDOW_MS,
  MAX_APPROVAL_CREDENTIALS,
  VAULT_APPROVAL_TTL_MS,
  approvalAnswerMarkdown,
  approvalCardMarkdown,
  approvalDeniedHint,
  approvalGrantExpiry,
  approvalPendingHint,
  approvalTimeoutHint,
  availableApprovalWindows,
  canonicalApprovalDigest,
  decideApprovalTransition,
  isApprovalExpired,
  killSwitchAnnouncement,
  normalizeApprovalReason,
  sharedApproverSet,
  validateApprovalItems,
  validateApprovalTuple,
  type ApprovalItem,
  type ApprovalRequestTuple,
} from "./vault-approval";

const NOW = 1_800_000_000_000;

function tuple(overrides: Partial<ApprovalRequestTuple> = {}): ApprovalRequestTuple {
  return {
    requesterMemberId: "member-1",
    deviceId: "device-1",
    projectId: "project-a",
    originChannelId: "channel-1",
    originMessageId: "message-1",
    delivery: "inject",
    reason: "deploy the staging migration",
    ...overrides,
  };
}

function items(count = 1): ApprovalItem[] {
  return Array.from({ length: count }, (_, index) => ({
    credentialId: `credential-${index}`,
    name: `TOKEN_${index}`,
    version: 1,
    policyEpoch: 1,
  }));
}

describe("vault approval rules", () => {
  it("VAULT-APPROVAL-RULE-001 requires a reason and keeps it to one readable line", () => {
    expect(normalizeApprovalReason("  read the staging database\n ")).toBe("read the staging database");
    expect(normalizeApprovalReason("first\nsecond")).toBe("first second");
    for (const empty of ["", "   ", "\n", undefined, null, 42]) {
      expect(() => normalizeApprovalReason(empty)).toThrow(/reason is required/);
    }
    expect(() => normalizeApprovalReason("x".repeat(501))).toThrow(/too long/);
  });

  it("VAULT-APPROVAL-RULE-002 refuses a request tuple that is not internally consistent", () => {
    expect(validateApprovalTuple(tuple()).reason).toBe("deploy the staging migration");
    expect(validateApprovalTuple(tuple({ agentId: "agent-1", delegationId: "delegation-1" })).agentId).toBe("agent-1");
    // An agent request without its exact delegation would let one owner's
    // channel rights ride on another owner's credential rights.
    expect(() => validateApprovalTuple(tuple({ agentId: "agent-1" }))).toThrow(/exact delegation/);
    expect(() => validateApprovalTuple(tuple({ delegationId: "delegation-1" }))).toThrow(/exact delegation/);
    expect(() => validateApprovalTuple(tuple({ deviceId: "" }))).toThrow(/device id/);
    expect(() => validateApprovalTuple(tuple({ delivery: "shout" as never }))).toThrow(/delivery is invalid/);
  });

  it("VAULT-APPROVAL-RULE-003 bounds a batch and refuses a repeated credential", () => {
    expect(validateApprovalItems(items(MAX_APPROVAL_CREDENTIALS))).toHaveLength(MAX_APPROVAL_CREDENTIALS);
    expect(() => validateApprovalItems([])).toThrow(/at least one credential/);
    expect(() => validateApprovalItems(items(MAX_APPROVAL_CREDENTIALS + 1))).toThrow(/more than 10/);
    expect(() => validateApprovalItems([items()[0], items()[0]])).toThrow(/twice/);
    expect(() => validateApprovalItems([{ ...items()[0], version: 0 }])).toThrow(/version is invalid/);
  });

  it("VAULT-APPROVAL-RULE-004 batches only where the approver set is identical", () => {
    expect(sharedApproverSet([["b", "a"], ["a", "b"]])).toEqual(["a", "b"]);
    expect(sharedApproverSet([["a", "a"], ["a"]])).toEqual(["a"]);
    // A credential a second person also owns is a different question.
    expect(sharedApproverSet([["a"], ["a", "b"]])).toBeNull();
    expect(sharedApproverSet([["a"], ["b"]])).toBeNull();
    // Nobody can answer for a credential with no eligible approver, so it can
    // never be batched into somebody else's card.
    expect(sharedApproverSet([[]])).toBeNull();
    expect(sharedApproverSet([])).toBeNull();
  });

  it("VAULT-APPROVAL-RULE-005 offers only the windows the credential's own policy permits", () => {
    expect(availableApprovalWindows({})).toEqual(["once"]);
    expect(availableApprovalWindows({ grantTtlMs: 60_000 })).toEqual(["once"]);
    expect(availableApprovalWindows({ grantTtlMs: APPROVAL_WINDOW_MS.fifteen_minutes })).toEqual([
      "once",
      "fifteen_minutes",
    ]);
    expect(availableApprovalWindows({ grantTtlMs: 60 * 60_000 })).toEqual(["once", "fifteen_minutes", "session"]);
  });

  it("VAULT-APPROVAL-RULE-006 turns a window into an expiry the grant rules will accept", () => {
    // No expiry is what the grant rules read as a single use.
    expect(approvalGrantExpiry("once", { grantTtlMs: 60 * 60_000 }, NOW)).toBeUndefined();
    expect(approvalGrantExpiry("session", {}, NOW)).toBeUndefined();
    expect(approvalGrantExpiry("fifteen_minutes", { grantTtlMs: 60 * 60_000 }, NOW)).toBe(
      NOW + APPROVAL_WINDOW_MS.fifteen_minutes,
    );
    // Clamped to the credential's own ceiling rather than exceeding it.
    expect(approvalGrantExpiry("session", { grantTtlMs: 30 * 60_000 }, NOW)).toBe(NOW + 30 * 60_000);
    expect(() => approvalGrantExpiry("session", { grantTtlMs: 60_000 }, NOW)).toThrow(/not permitted/);
  });

  it("VAULT-APPROVAL-RULE-007 lets the first terminal answer win and tells the second what happened", () => {
    expect(decideApprovalTransition("pending", "allowed")).toEqual({ ok: true, status: "allowed" });
    expect(decideApprovalTransition("pending", "denied")).toEqual({ ok: true, status: "denied" });
    expect(decideApprovalTransition("allowed", "denied")).toEqual({
      ok: false,
      reason: "that request was already allowed",
    });
    expect(decideApprovalTransition("denied", "allowed").ok).toBe(false);
    expect(decideApprovalTransition("expired", "allowed")).toEqual({
      ok: false,
      reason: "that request timed out before it was answered",
    });
  });

  it("VAULT-APPROVAL-RULE-008 expires exactly at five minutes and only while pending", () => {
    const approval = { status: "pending" as const, expiresAt: NOW + VAULT_APPROVAL_TTL_MS };
    expect(isApprovalExpired(approval, NOW + VAULT_APPROVAL_TTL_MS - 1)).toBe(false);
    expect(isApprovalExpired(approval, NOW + VAULT_APPROVAL_TTL_MS)).toBe(true);
    expect(isApprovalExpired({ ...approval, status: "allowed" }, NOW + VAULT_APPROVAL_TTL_MS)).toBe(false);
  });

  it("VAULT-APPROVAL-RULE-009 binds the approver's gesture to this exact set of decisions", () => {
    const batch = items(2);
    const decisions = [
      { credentialId: "credential-0", outcome: "allowed" as const, window: "once" as const },
      { credentialId: "credential-1", outcome: "denied" as const, window: "once" as const },
    ];
    const digest = canonicalApprovalDigest({ approvalId: "approval-1", items: batch, decisions });

    // Order of presentation cannot change the digest; content always does.
    expect(canonicalApprovalDigest({ approvalId: "approval-1", items: batch, decisions: [...decisions].reverse() })).toBe(
      digest,
    );
    for (const changed of [
      { approvalId: "approval-2", items: batch, decisions },
      { approvalId: "approval-1", items: [batch[0], { ...batch[1], version: 2 }], decisions },
      { approvalId: "approval-1", items: [batch[0], { ...batch[1], policyEpoch: 2 }], decisions },
      {
        approvalId: "approval-1",
        items: batch,
        decisions: [decisions[0], { ...decisions[1], outcome: "allowed" as const }],
      },
      {
        approvalId: "approval-1",
        items: batch,
        decisions: [{ ...decisions[0], window: "fifteen_minutes" as const }, decisions[1]],
      },
    ]) {
      expect(canonicalApprovalDigest(changed)).not.toBe(digest);
    }

    // A partial answer has no digest at all: every credential is decided or the
    // card is not answered.
    expect(() =>
      canonicalApprovalDigest({ approvalId: "approval-1", items: batch, decisions: [decisions[0]] }),
    ).toThrow(/needs a decision/);
    expect(() =>
      canonicalApprovalDigest({
        approvalId: "approval-1",
        items: batch,
        decisions: [decisions[0], { ...decisions[1], credentialId: "credential-9" }],
      }),
    ).toThrow(/not part of this approval/);
  });

  it("VAULT-APPROVAL-RULE-010 tells an agent to stop rather than to look elsewhere", () => {
    for (const hint of [
      approvalTimeoutHint(["TOKEN_0"]),
      approvalDeniedHint(["TOKEN_0"], "ada"),
      approvalPendingHint(["TOKEN_0"], NOW),
    ]) {
      expect(hint).toContain("TOKEN_0");
      expect(hint.toLowerCase()).toContain("do not");
      expect(hint).not.toMatch(/try again|retry it|elsewhere\?/i);
    }
    expect(approvalTimeoutHint(["TOKEN_0"])).toContain("counts as a denial");
    expect(approvalPendingHint(["TOKEN_0"], NOW)).toContain(new Date(NOW).toISOString());
  });

  it("VAULT-APPROVAL-RULE-011 puts every fact the approver needs on the card", () => {
    const card = approvalCardMarkdown({
      requesterHandle: "ada",
      agentHandle: "a.deploy",
      deviceLabel: "Ada's laptop",
      projectLabel: "api",
      originChannelLabel: "#eng",
      delivery: "reveal",
      reason: "read the failing migration",
      expiresAt: NOW,
      items: [
        { name: "STAGING_DB_URL", description: "Staging database", highRisk: true, recentUses: 3, lastUsedAt: NOW - 1 },
        { name: "OTHER", description: "", highRisk: false, recentUses: 0 },
      ],
    });
    expect(card).toContain("@a.deploy, operating for @ada");
    expect(card).toContain("read the failing migration");
    expect(card).toContain("Ada's laptop");
    expect(card).toContain("#eng");
    expect(card).toContain("STAGING_DB_URL");
    expect(card).toContain("⚠️ high risk");
    expect(card).toContain("read 3× in the last day");
    expect(card).toContain("not used in the last day");
    // A reveal says plainly what it costs, rather than reading like an inject.
    expect(card).toContain("transcript on disk");
    expect(card).toContain("No answer is a denial");
  });

  it("VAULT-APPROVAL-RULE-012 says who answered and how, so a second owner is not left guessing", () => {
    const answer = approvalAnswerMarkdown({
      approverHandle: "grace",
      decisions: [
        { name: "STAGING_DB_URL", outcome: "allowed", window: "fifteen_minutes" },
        { name: "PROD_KEY", outcome: "denied", window: "once" },
      ],
    });
    expect(answer).toContain("Answered by @grace");
    expect(answer).toContain("**STAGING_DB_URL** — allowed for 15 minutes");
    expect(answer).toContain("**PROD_KEY** — denied");
  });

  it("VAULT-APPROVAL-RULE-013 announces every kill-switch flip and never claims grants came back", () => {
    const off = killSwitchAnnouncement({
      scope: { kind: "workspace" },
      off: true,
      actorHandle: "ada",
      revokedGrants: 2,
    });
    expect(off).toContain("Agent access to the vault was switched off by @ada");
    expect(off).toContain("2 active grants were revoked");

    const single = killSwitchAnnouncement({
      scope: { kind: "credential", name: "PROD_KEY" },
      off: true,
      actorHandle: "ada",
      revokedGrants: 1,
    });
    expect(single).toContain("The credential PROD_KEY was switched off");
    expect(single).toContain("1 active grant was revoked");

    const on = killSwitchAnnouncement({
      scope: { kind: "agent", handle: "a.deploy" },
      off: false,
      actorHandle: "grace",
      revokedGrants: 0,
    });
    expect(on).toContain("Vault access for @a.deploy was switched back on by @grace");
    expect(on).toContain("were not restored");
  });
});

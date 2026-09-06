import { describe, expect, it } from "vitest";

import {
  assertRedactedAuditMetadata,
  auditGenesisHash,
  canonicalAuditMetadata,
  computeAuditEntryHash,
  verifyAuditChain,
  type AuditChainLink,
  type StoredAuditEntry,
} from "./audit-chain";

const WORKSPACE = "workspace-audit-fixture";

function link(overrides: Partial<AuditChainLink> = {}): AuditChainLink {
  return {
    workspaceKey: WORKSPACE,
    sequence: 1,
    recordedAt: 1_700_000_000_000,
    eventType: "membership.projected",
    outcome: "allowed",
    requesterKind: "member",
    requesterId: "member-requester",
    operatingOwnerId: "member-owner",
    approverId: "member-approver",
    subjectKind: "member",
    subjectId: "member-subject",
    metadata: { role: "admin", control_version: 3 },
    previousHash: auditGenesisHash(WORKSPACE),
    ...overrides,
  };
}

function chain(count: number, start = auditGenesisHash(WORKSPACE)): StoredAuditEntry[] {
  const entries: StoredAuditEntry[] = [];
  let previousHash = start;
  for (let index = 0; index < count; index += 1) {
    const candidate = link({
      sequence: index + 1,
      recordedAt: 1_700_000_000_000 + index,
      subjectId: `member-${index}`,
      previousHash,
    });
    const entryHash = computeAuditEntryHash(candidate);
    entries.push({ ...candidate, entryHash });
    previousHash = entryHash;
  }
  return entries;
}

describe("workspace audit chain", () => {
  it("AUDIT-RULE-001 binds every provenance field into the entry hash", () => {
    const base = computeAuditEntryHash(link());
    const variations: Partial<AuditChainLink>[] = [
      { workspaceKey: "workspace-other" },
      { sequence: 2 },
      { recordedAt: 1_700_000_000_001 },
      { eventType: "membership.removed" },
      { outcome: "denied" },
      { requesterKind: "agent" },
      { requesterId: "member-other" },
      { operatingOwnerId: "member-other-owner" },
      { approverId: "member-other-approver" },
      { subjectKind: "agent" },
      { subjectId: "member-other-subject" },
      { metadata: { role: "member", control_version: 3 } },
      { previousHash: auditGenesisHash("workspace-other") },
    ];
    const hashes = variations.map((variation) => computeAuditEntryHash(link(variation)));
    expect(new Set([base, ...hashes]).size).toBe(variations.length + 1);
  });

  it("AUDIT-RULE-002 separates requester, operating owner and approver", () => {
    const swapped = computeAuditEntryHash(
      link({ requesterId: "member-owner", operatingOwnerId: "member-requester" }),
    );
    expect(swapped).not.toBe(computeAuditEntryHash(link()));
  });

  it("AUDIT-RULE-003 canonicalises metadata so key order cannot change the hash", () => {
    const ordered = computeAuditEntryHash(link({ metadata: { role: "admin", control_version: 3 } }));
    const reordered = computeAuditEntryHash(link({ metadata: { control_version: 3, role: "admin" } }));
    expect(reordered).toBe(ordered);
    expect(canonicalAuditMetadata({ b: 1, a: "x" })).toBe('1:a=3:"x",1:b=1:1');
  });

  it("AUDIT-RULE-004 cannot be forged by moving a delimiter between fields", () => {
    const split = computeAuditEntryHash(link({ requesterId: "member-requester|1", operatingOwnerId: "" }));
    const shifted = computeAuditEntryHash(link({ requesterId: "member-requester", operatingOwnerId: "|1" }));
    expect(split).not.toBe(shifted);
  });

  it.each([
    ["body_markdown", "hello"],
    ["message_content", "hello"],
    ["credential_value", "value"],
    ["access_token", "value"],
    ["recovery_code", "value"],
    ["vault_root_wrap", "value"],
    ["launch_command", "value"],
    ["executable_path", "value"],
    ["process_arguments", "value"],
    ["environment_pairs", "value"],
    ["password_hint", "value"],
    ["plaintext_excerpt", "value"],
    ["authorization", "Bearer x"],
    ["value", "x"],
    ["message", "x"],
  ])("AUDIT-RULE-005 refuses forbidden metadata field %s", (key, value) => {
    expect(() => assertRedactedAuditMetadata({ [key]: value })).toThrow(/forbidden field|not a redacted identifier/);
    expect(() => computeAuditEntryHash(link({ metadata: { [key]: value } }))).toThrow();
  });

  it("AUDIT-RULE-006 bounds metadata shape, size and value types", () => {
    expect(() => assertRedactedAuditMetadata({ note: "x".repeat(257) })).toThrow(/exceeds 256 characters/);
    expect(() => assertRedactedAuditMetadata({ Note: "x" })).toThrow(/not a redacted identifier/);
    expect(() => assertRedactedAuditMetadata({ ratio: Number.NaN })).toThrow(/finite number/);
    expect(() =>
      assertRedactedAuditMetadata({ nested: { deep: true } } as never),
    ).toThrow(/not a scalar/);
    const tooMany = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`f${index}`, index]));
    expect(() => assertRedactedAuditMetadata(tooMany)).toThrow(/exceeds 24 fields/);
    expect(() => assertRedactedAuditMetadata({ note: "x".repeat(256), ratio: 1.5, ok: true, absent: null })).not.toThrow();
    // A counter that merely shares a prefix with a header name stays allowed.
    expect(() => assertRedactedAuditMetadata({ authorization_epoch: 3 })).not.toThrow();
  });

  it("AUDIT-RULE-007 accepts an intact chain and reports its head", () => {
    const entries = chain(4);
    const verification = verifyAuditChain(entries, {
      startHash: auditGenesisHash(WORKSPACE),
      startSequence: 1,
    });
    expect(verification).toEqual({ ok: true, entryCount: 4, chainHash: entries[3].entryHash });
  });

  it("AUDIT-RULE-008 detects an edited field, a broken link, a gap and reordered time", () => {
    const entries = chain(4);

    const edited = entries.map((entry, index) =>
      index === 2 ? { ...entry, outcome: "denied" as const } : entry,
    );
    expect(verifyAuditChain(edited, { startHash: auditGenesisHash(WORKSPACE), startSequence: 1 })).toEqual({
      ok: false,
      entryCount: 4,
      brokenAtSequence: 3,
      reason: "entry hash does not cover the stored fields",
    });

    const removed = [entries[0], entries[2], entries[3]];
    expect(verifyAuditChain(removed, { startHash: auditGenesisHash(WORKSPACE), startSequence: 1 })).toEqual({
      ok: false,
      entryCount: 3,
      brokenAtSequence: 3,
      reason: "expected sequence 2",
    });

    const relinked = chain(2, auditGenesisHash("workspace-other"));
    expect(verifyAuditChain(relinked, { startHash: auditGenesisHash(WORKSPACE), startSequence: 1 })).toEqual({
      ok: false,
      entryCount: 2,
      brokenAtSequence: 1,
      reason: "previous hash does not match the preceding entry",
    });
  });

  it("AUDIT-RULE-009 verifies a chain that resumes after retention purged its head", () => {
    const entries = chain(4);
    const survivors = entries.slice(2);
    expect(
      verifyAuditChain(survivors, { startHash: entries[1].entryHash, startSequence: 3 }),
    ).toEqual({ ok: true, entryCount: 2, chainHash: entries[3].entryHash });
    expect(
      verifyAuditChain(survivors, { startHash: entries[0].entryHash, startSequence: 3 }),
    ).toMatchObject({ ok: false, brokenAtSequence: 3 });
  });

  it("AUDIT-RULE-010 gives each workspace a distinct genesis", () => {
    expect(auditGenesisHash("workspace-a")).not.toBe(auditGenesisHash("workspace-b"));
    expect(auditGenesisHash("workspace-a")).toMatch(/^[0-9a-f]{64}$/);
  });
});

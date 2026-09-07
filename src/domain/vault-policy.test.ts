import { describe, expect, it } from "vitest";

import { encodeVaultBytes, type VaultKeyWrap } from "./vault-envelope";
import { normalizeVaultMetadata, normalizeVaultPolicy, validateVaultAcl } from "./vault-policy";

const wrap: VaultKeyWrap = {
  custodianMemberId: "member-a",
  recipientKeyEpoch: 1,
  wrapSuite: "P256-HKDF-SHA256-AES256GCM",
  ephemeralPublicKey: encodeVaultBytes(new Uint8Array(65)),
  iv: encodeVaultBytes(new Uint8Array(12)),
  wrappedDek: encodeVaultBytes(new Uint8Array(48)),
};

describe("vault policy validation", () => {
  it("VAULT-POLICY-RULE-001 accepts bounded metadata and policy", () => {
    expect(normalizeVaultMetadata({ name: "GITHUB_TOKEN", description: "GitHub", envVar: "GH_TOKEN", tags: ["dev", "dev"], commands: ["gh"], proxyHosts: ["api.github.com"] })).toMatchObject({ tags: ["dev"] });
    expect(normalizeVaultPolicy({ mode: "ask", allowedDeliveries: ["inject"], projectIds: ["project-a"], grantTtlMs: 60_000, highRisk: true }, 100)).toMatchObject({ mode: "ask", grantTtlMs: 60_000 });
  });

  it("VAULT-POLICY-RULE-002 rejects invalid names, stale windows and excessive grants", () => {
    expect(() => normalizeVaultMetadata({ name: "bad-name", description: "", tags: [], commands: [], proxyHosts: [] })).toThrow("name");
    expect(() => normalizeVaultPolicy({ mode: "auto", allowedDeliveries: ["inject"], projectIds: [], availableUntil: 100, highRisk: false }, 100)).toThrow("future");
    expect(() => normalizeVaultPolicy({ mode: "auto", allowedDeliveries: ["inject"], projectIds: [], grantTtlMs: 28_800_001, highRisk: false }, 100)).toThrow("TTL");
  });

  it("VAULT-POLICY-RULE-003 requires one member custodian and an exact wrap set", () => {
    expect(validateVaultAcl([{ subjectType: "member", subjectId: "member-a", verb: "manage" }], [wrap])).toHaveLength(1);
    expect(() => validateVaultAcl([{ subjectType: "group", subjectId: "group-a", verb: "manage" }], [wrap])).toThrow("members");
    expect(() => validateVaultAcl([{ subjectType: "member", subjectId: "member-b", verb: "manage" }], [wrap])).toThrow("exactly");
  });
});

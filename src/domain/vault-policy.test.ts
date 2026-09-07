import { describe, expect, it } from "vitest";

import { encodeVaultBytes, type VaultKeyWrap } from "./vault-envelope";
import {
  ROTATION_WARNING_MS,
  normalizeCapturedFrom,
  normalizeVaultMetadata,
  normalizeVaultPolicy,
  rotationState,
  validateVaultAcl,
} from "./vault-policy";

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

  it("VAULT-POLICY-RULE-004 keeps a structured credential's shape honest and its values out of the metadata", () => {
    const base = { name: "DATABASE", description: "", tags: [], commands: [], proxyHosts: [] };
    // One record that expands into five variables, rather than five credentials
    // somebody has to remember to rotate together.
    const structured = normalizeVaultMetadata({
      ...base, kind: "structured", fields: ["HOST", "PORT", "USER", "PASSWORD", "NAME"],
    });
    expect(structured.kind).toBe("structured");
    expect(structured.fields).toEqual(["HOST", "PORT", "USER", "PASSWORD", "NAME"]);

    expect(normalizeVaultMetadata(base).kind).toBe("opaque");
    expect(normalizeVaultMetadata(base).fields).toEqual([]);
    expect(() => normalizeVaultMetadata({ ...base, kind: "structured", fields: [] })).toThrow(/must name the fields/);
    expect(() => normalizeVaultMetadata({ ...base, fields: ["HOST"] })).toThrow(/only a structured credential/);
    // Each field becomes an environment variable, so it has to be usable as one.
    expect(() => normalizeVaultMetadata({ ...base, kind: "structured", fields: ["not a var"] })).toThrow(/field name is invalid/);
    expect(() => normalizeVaultMetadata({ ...base, kind: "wrapped" as never, fields: [] })).toThrow(/kind is invalid/);
  });

  it("VAULT-POLICY-RULE-005 warns before a credential expires rather than after", () => {
    const now = 1_800_000_000_000;
    expect(rotationState(undefined, now)).toBe("none");
    expect(rotationState(now + ROTATION_WARNING_MS + 1, now)).toBe("none");
    // A week's notice, because "expired" is the wrong moment to find out.
    expect(rotationState(now + ROTATION_WARNING_MS, now)).toBe("due_soon");
    expect(rotationState(now + 1, now)).toBe("due_soon");
    expect(rotationState(now, now)).toBe("overdue");
    expect(rotationState(now - 1, now)).toBe("overdue");
    expect(() =>
      normalizeVaultMetadata({ name: "T", description: "", tags: [], commands: [], proxyHosts: [], rotateAt: -1 }),
    ).toThrow(/rotation date is invalid/);
  });

  it("VAULT-POLICY-RULE-006 records what produced a captured value, and never its arguments", () => {
    expect(normalizeCapturedFrom("gh")).toBe("gh");
    expect(normalizeCapturedFrom("  aws  ")).toBe("aws");
    expect(normalizeCapturedFrom("op.exe")).toBe("op.exe");
    // A command line would carry paths and, in the worst case, another secret.
    // Only the program's name may reach the workspace.
    for (const rejected of ["gh auth token", "/usr/bin/gh", "gh --token=abc", "", "  ", 7, null]) {
      expect(() => normalizeCapturedFrom(rejected)).toThrow();
    }
  });
});

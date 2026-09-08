import { describe, expect, it } from "vitest";

import {
  CANARY_PREFIX,
  SCAN_DIGEST_CONTEXT,
  SCAN_MIN_VALUE_LENGTH,
  canaryMarkerFor,
  canaryRefusalHint,
  canaryValue,
  findCanaryMarkers,
  normalizeCanaryMarker,
  scanDigestPreimage,
  validateScanDigest,
  validateScanLength,
} from "./vault-canary";

const tag = "a1b2c3d4e5f6";
const random = "0123456789abcdef0123456789abcdef";

describe("canary credentials", () => {
  it("CANARY-RULE-001 builds a marker and a value from a tag and random half", () => {
    expect(canaryMarkerFor(tag)).toBe(`${CANARY_PREFIX}${tag}`);
    expect(canaryValue(tag, random)).toBe(`${CANARY_PREFIX}${tag}-${random}`);
    expect(normalizeCanaryMarker(`${CANARY_PREFIX}${tag}`)).toBe(`${CANARY_PREFIX}${tag}`);
  });

  it("CANARY-RULE-002 refuses a marker or value that is not the exact shape", () => {
    expect(() => canaryMarkerFor("short")).toThrow("twelve");
    expect(() => canaryMarkerFor("A1B2C3D4E5F6")).toThrow("twelve");
    expect(() => normalizeCanaryMarker("ghp_looks_real")).toThrow("invalid");
    expect(() => normalizeCanaryMarker(42)).toThrow("invalid");
    expect(() => canaryValue(tag, "tooshort")).toThrow("thirty-two");
  });

  it("CANARY-RULE-003 finds a canary anywhere in a body and reports each once", () => {
    const markers = [{ marker: canaryMarkerFor(tag), name: "CANARY_ONE" }, { marker: canaryMarkerFor("ffffffffffff"), name: "CANARY_TWO" }];
    const value = canaryValue(tag, random);
    expect(findCanaryMarkers(`the token is ${value} apparently`, markers).map((hit) => hit.name)).toEqual(["CANARY_ONE"]);
    // Twice in one body is still one credential to report.
    expect(findCanaryMarkers(`${value} and again ${value}`, markers).map((hit) => hit.name)).toEqual(["CANARY_ONE"]);
    // The marker alone is the trip: a leak that carried it carried the value.
    expect(findCanaryMarkers(canaryMarkerFor(tag), markers).map((hit) => hit.name)).toEqual(["CANARY_ONE"]);
    expect(findCanaryMarkers("nothing to see", markers)).toEqual([]);
    expect(findCanaryMarkers("", markers)).toEqual([]);
    expect(findCanaryMarkers(canaryMarkerFor(tag), [])).toEqual([]);
  });

  it("CANARY-RULE-004 tells the agent to stop rather than to try another route", () => {
    const hint = canaryRefusalHint(["CANARY_ONE"]);
    expect(hint).toContain("CANARY_ONE");
    expect(hint).toContain("Do not try to send it another way");
    expect(hint).toContain("lepidy run --with");
  });
});

describe("scan targets", () => {
  it("CANARY-RULE-005 binds a digest to one workspace, credential and version", () => {
    const preimage = scanDigestPreimage({ workspaceId: "ws-1", credentialId: "cred-1", version: 2, value: "canary-value-0001" });
    expect(preimage).toBe(`${SCAN_DIGEST_CONTEXT}\nws-1\ncred-1\n2\ncanary-value-0001`);
    // A different version, credential or workspace hashes differently, so a
    // digest lifted from one place never matches somewhere else.
    expect(preimage).not.toBe(scanDigestPreimage({ workspaceId: "ws-1", credentialId: "cred-1", version: 3, value: "canary-value-0001" }));
    expect(() => scanDigestPreimage({ workspaceId: "ws-1", credentialId: "cred-1", version: 0, value: "x" })).toThrow("version");
  });

  it("CANARY-RULE-006 accepts only a 32-byte digest and a length worth scanning for", () => {
    expect(validateScanDigest("A".repeat(43))).toBe("A".repeat(43));
    expect(() => validateScanDigest("A".repeat(42))).toThrow("invalid");
    expect(() => validateScanDigest("+".repeat(43))).toThrow("invalid");
    expect(validateScanLength(SCAN_MIN_VALUE_LENGTH)).toBe(SCAN_MIN_VALUE_LENGTH);
    // Below the minimum a digest is both easiest to guess and likeliest to
    // match ordinary text by accident, so it is never stored at all.
    expect(() => validateScanLength(SCAN_MIN_VALUE_LENGTH - 1)).toThrow("invalid");
    expect(() => validateScanLength(9000)).toThrow("invalid");
  });
});

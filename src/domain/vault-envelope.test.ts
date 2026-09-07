import { describe, expect, it } from "vitest";

import { decryptVaultValue, encryptVaultValue } from "./vault-client-crypto";
import { encodeVaultBytes, validateVaultEnvelope, validateVaultKeyWrap } from "./vault-envelope";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("V01 client envelope", () => {
  it("VAULT-ENVELOPE-RULE-001 binds ciphertext to workspace, credential and version AAD", async () => {
    const created = await encryptVaultValue({
      workspaceId: "workspace-a",
      credentialId: "credential-a",
      version: 1,
      keyEpoch: 1,
      plaintext: encoder.encode("canary-vault-value"),
    });
    expect(decoder.decode(await decryptVaultValue({
      workspaceId: "workspace-a",
      credentialId: "credential-a",
      envelope: created.envelope,
      dek: created.dek,
    }))).toBe("canary-vault-value");
    await expect(decryptVaultValue({
      workspaceId: "workspace-b",
      credentialId: "credential-a",
      envelope: created.envelope,
      dek: created.dek,
    })).rejects.toThrow();
    await expect(decryptVaultValue({
      workspaceId: "workspace-a",
      credentialId: "credential-b",
      envelope: created.envelope,
      dek: created.dek,
    })).rejects.toThrow();
  });

  it("VAULT-ENVELOPE-RULE-002 rejects malformed suites, epochs, IVs and wraps", async () => {
    const created = await encryptVaultValue({
      workspaceId: "workspace-a",
      credentialId: "credential-a",
      version: 2,
      keyEpoch: 3,
      plaintext: encoder.encode("value"),
    });
    expect(validateVaultEnvelope(created.envelope, { version: 2, keyEpoch: 3 })).toEqual(created.envelope);
    expect(() => validateVaultEnvelope({ ...created.envelope, version: 1 }, { version: 2, keyEpoch: 3 })).toThrow("epoch");
    expect(() => validateVaultEnvelope({ ...created.envelope, iv: encodeVaultBytes(new Uint8Array(11)) }, { version: 2, keyEpoch: 3 })).toThrow("96 bits");
    expect(() => validateVaultKeyWrap({
      custodianMemberId: "member-a",
      recipientKeyEpoch: 1,
      wrapSuite: "P256-HKDF-SHA256-AES256GCM",
      ephemeralPublicKey: encodeVaultBytes(new Uint8Array(65)),
      iv: encodeVaultBytes(new Uint8Array(12)),
      wrappedDek: encodeVaultBytes(new Uint8Array(47)),
    })).toThrow("wrapped DEK");
  });
});

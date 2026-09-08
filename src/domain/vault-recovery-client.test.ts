import { describe, expect, it } from "vitest";

import {
  generateVaultRecoveryCode,
  openVaultDevicePackage,
  openVaultRecovery,
  sealVaultDevicePackage,
  sealVaultRecovery,
} from "./vault-recovery-client";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("trusted-client vault recovery cryptography", () => {
  it("V07-UNIT-001 recovers locally and gives a wrong code only one generic failure", async () => {
    const code = generateVaultRecoveryCode();
    const secret = encoder.encode("V07-ACCOUNT-VAULT-PACKAGE-CANARY-32-BYTES");
    const sealed = await sealVaultRecovery({ accountId: "account-v07", vaultEpoch: 1, recoveryCode: code, accountVaultPackage: secret });
    expect(JSON.stringify(sealed)).not.toContain(code);
    expect(JSON.stringify(sealed)).not.toContain(decoder.decode(secret));
    await expect(openVaultRecovery({ accountId: "account-v07", recoveryCode: code, package: sealed }))
      .resolves.toEqual(secret);
    await expect(openVaultRecovery({ accountId: "account-v07", recoveryCode: "AAAAAA-AAAAAA-AAAAAA-AAAAAA", package: sealed }))
      .rejects.toThrow("recovery code did not open the vault");
    await expect(openVaultRecovery({ accountId: "another-account", recoveryCode: code, package: sealed }))
      .rejects.toThrow("recovery code did not open the vault");
  }, 20_000);

  it("V07-UNIT-002 binds a device package to its device and key epoch", async () => {
    const target = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const other = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const secret = encoder.encode("V07-DEVICE-VAULT-PACKAGE-CANARY-32-BYTES");
    const sealed = await sealVaultDevicePackage({
      accountId: "account-v07", vaultEpoch: 4, targetDeviceId: "device-new", targetDeviceKeyEpoch: 2,
      targetEncryptionPublicKey: await crypto.subtle.exportKey("jwk", target.publicKey), accountVaultPackage: secret,
    });
    expect(JSON.stringify(sealed)).not.toContain(decoder.decode(secret));
    await expect(openVaultDevicePackage({ accountId: "account-v07", package: sealed, targetEncryptionPrivateKey: target.privateKey }))
      .resolves.toEqual(secret);
    await expect(openVaultDevicePackage({ accountId: "account-v07", package: sealed, targetEncryptionPrivateKey: other.privateKey }))
      .rejects.toThrow("device package did not open");
    await expect(openVaultDevicePackage({
      accountId: "account-v07", package: { ...sealed, targetDeviceKeyEpoch: 3 }, targetEncryptionPrivateKey: target.privateKey,
    })).rejects.toThrow("device package did not open");
  });
});

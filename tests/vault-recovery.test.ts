import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import {
  DEVICE_PACKAGE_SUITE,
  RECOVERY_PACKAGE_SUITE,
  VaultRecoveryService,
  type VaultDevicePackage,
  type VaultRecoveryPackage,
} from "../src/control/vault-recovery";
import { encodeVaultBytes } from "../src/domain/vault-envelope";

const NOW = 1_810_000_000_000;

function recoveryPackage(epoch: number, marker = 7): VaultRecoveryPackage {
  return {
    suite: RECOVERY_PACKAGE_SUITE,
    vaultEpoch: epoch,
    memoryKib: 65_536,
    iterations: 3,
    lanes: 1,
    salt: encodeVaultBytes(new Uint8Array(16).fill(marker)),
    iv: encodeVaultBytes(new Uint8Array(12).fill(marker + 1)),
    ciphertext: encodeVaultBytes(new Uint8Array(64).fill(marker + 2)),
  };
}

function devicePackage(deviceId: string, vaultEpoch = 1, deviceKeyEpoch = 1): VaultDevicePackage {
  const point = new Uint8Array(65).fill(4);
  point[0] = 4;
  return {
    suite: DEVICE_PACKAGE_SUITE,
    vaultEpoch,
    targetDeviceId: deviceId,
    targetDeviceKeyEpoch: deviceKeyEpoch,
    ephemeralPublicKey: encodeVaultBytes(point),
    iv: encodeVaultBytes(new Uint8Array(12).fill(5)),
    ciphertext: encodeVaultBytes(new Uint8Array(80).fill(6)),
  };
}

async function seed(suffix: string) {
  const accountId = `account-v07-${suffix}`;
  const existingDeviceId = `device-existing-${suffix}`;
  const newDeviceId = `device-new-${suffix}`;
  await env.CONTROL_DB.prepare(
    `INSERT INTO accounts(id, primary_email_normalized, display_name, status, security_epoch, created_at, updated_at)
     VALUES (?, ?, 'V07', 'active', 1, ?, ?)`,
  ).bind(accountId, `v07-${suffix}@example.test`, NOW, NOW).run();
  for (const deviceId of [existingDeviceId, newDeviceId]) {
    await env.CONTROL_DB.prepare(
      `INSERT INTO devices(
         id, account_id, kind, credential_hash, public_key, label, status, created_at, last_seen_at,
         security_epoch, key_epoch, signing_public_key_jwk, encryption_public_key_jwk
       ) VALUES (?, ?, 'client', ?, NULL, ?, 'active', ?, ?, 1, 1, ?, ?)`,
    ).bind(
      deviceId,
      accountId,
      new TextEncoder().encode(`credential:${deviceId}`),
      deviceId,
      NOW,
      NOW,
      JSON.stringify({ kty: "EC", crv: "P-256", x: "AQ", y: "Ag" }),
      JSON.stringify({ kty: "EC", crv: "P-256", x: "Aw", y: "BA" }),
    ).run();
  }
  return { accountId, existingDeviceId, newDeviceId };
}

describe("vault recovery and device package custody", () => {
  beforeAll(async () => {
    await applyD1Migrations(env.CONTROL_DB, env.TEST_CONTROL_MIGRATIONS);
  });
  it("V07-INT-003 stores only an opaque recovery package and rotates it with an epoch CAS", async () => {
    const ids = await seed("recovery");
    const service = new VaultRecoveryService(env.CONTROL_DB, () => NOW + 10);
    const initial = recoveryPackage(1);
    await expect(service.initialize({
      accountId: ids.accountId, deviceId: ids.existingDeviceId, package: initial, confirmed: false,
    })).rejects.toThrow("confirmation");
    await expect(service.initialize({
      accountId: ids.accountId, deviceId: ids.existingDeviceId, package: initial, confirmed: true,
    })).resolves.toEqual({ vaultEpoch: 1, package: initial });
    const next = recoveryPackage(2, 11);
    await expect(service.rotate({
      accountId: ids.accountId, deviceId: ids.existingDeviceId, expectedVaultEpoch: 0,
      package: { ...next, vaultEpoch: 1 }, confirmed: true,
    })).rejects.toThrow("concurrently");
    await expect(service.rotate({
      accountId: ids.accountId, deviceId: ids.existingDeviceId, expectedVaultEpoch: 1,
      package: next, confirmed: true,
    })).resolves.toEqual({ vaultEpoch: 2, package: next });

    const dump = await env.CONTROL_DB.prepare(
      "SELECT package_json FROM account_vault_recovery WHERE account_id = ?",
    ).bind(ids.accountId).first<{ package_json: string }>();
    expect(dump?.package_json).toBe(JSON.stringify(next));
    expect(dump?.package_json).not.toContain("V07-RECOVERY-CODE-CANARY");
    expect(dump?.package_json).not.toContain("V07-RAW-VAULT-KEY-CANARY");
  });

  it("V07-INT-004 enrolls one exact device epoch, consumes once and invalidates old packages on recovery rotation", async () => {
    const ids = await seed("device");
    let clock = NOW + 20;
    const service = new VaultRecoveryService(env.CONTROL_DB, () => clock++);
    await service.initialize({
      accountId: ids.accountId, deviceId: ids.existingDeviceId, package: recoveryPackage(1), confirmed: true,
    });
    const envelope = devicePackage(ids.newDeviceId);
    await expect(service.storeDevicePackage({
      accountId: ids.accountId, approvedByDeviceId: ids.existingDeviceId, package: envelope,
      freshUserVerification: false, confirmed: true,
    })).rejects.toThrow("fresh user verification");
    await expect(service.storeDevicePackage({
      accountId: ids.accountId, approvedByDeviceId: ids.existingDeviceId,
      package: { ...envelope, targetDeviceKeyEpoch: 2 }, freshUserVerification: true, confirmed: true,
    })).rejects.toThrow("stale");
    await expect(service.storeDevicePackage({
      accountId: ids.accountId, approvedByDeviceId: ids.existingDeviceId, package: envelope,
      freshUserVerification: true, confirmed: true,
    })).resolves.toEqual({ stored: true });
    await expect(service.consumeDevicePackage({
      accountId: ids.accountId, targetDeviceId: ids.newDeviceId, targetDeviceKeyEpoch: 1,
    })).resolves.toEqual(envelope);
    await expect(service.consumeDevicePackage({
      accountId: ids.accountId, targetDeviceId: ids.newDeviceId, targetDeviceKeyEpoch: 1,
    })).rejects.toThrow("not found");

    await env.CONTROL_DB.prepare(
      "UPDATE vault_device_packages SET consumed_at = NULL WHERE account_id = ? AND target_device_id = ?",
    ).bind(ids.accountId, ids.newDeviceId).run();
    await service.rotate({
      accountId: ids.accountId, deviceId: ids.existingDeviceId, expectedVaultEpoch: 1,
      package: recoveryPackage(2, 12), confirmed: true,
    });
    await expect(service.consumeDevicePackage({
      accountId: ids.accountId, targetDeviceId: ids.newDeviceId, targetDeviceKeyEpoch: 1,
    })).rejects.toThrow("not found");
  });

  it("V07-INT-006 removes a device with the old recovery and enrollment packages in one batch", async () => {
    const ids = await seed("removal");
    const service = new VaultRecoveryService(env.CONTROL_DB, () => NOW + 30);
    await service.initialize({
      accountId: ids.accountId, deviceId: ids.existingDeviceId,
      package: recoveryPackage(1), confirmed: true,
    });
    await service.storeDevicePackage({
      accountId: ids.accountId, approvedByDeviceId: ids.existingDeviceId,
      package: devicePackage(ids.newDeviceId), freshUserVerification: true, confirmed: true,
    });
    await expect(service.removeDeviceAfterRekey({
      accountId: ids.accountId, actingDeviceId: ids.existingDeviceId,
      removedDeviceId: ids.existingDeviceId, expectedVaultEpoch: 1,
      package: recoveryPackage(2, 14), freshUserVerification: true, confirmed: true,
    })).rejects.toThrow("cannot remove itself");
    await expect(service.removeDeviceAfterRekey({
      accountId: ids.accountId, actingDeviceId: ids.existingDeviceId,
      removedDeviceId: ids.newDeviceId, expectedVaultEpoch: 1,
      package: recoveryPackage(2, 14), freshUserVerification: true, confirmed: true,
    })).resolves.toEqual({ removedDeviceId: ids.newDeviceId, vaultEpoch: 2 });
    await expect(service.read(ids.accountId)).resolves.toMatchObject({ vaultEpoch: 2 });
    const removed = await env.CONTROL_DB.prepare("SELECT status, key_epoch FROM devices WHERE id = ?")
      .bind(ids.newDeviceId).first<{ status: string; key_epoch: number }>();
    expect(removed).toEqual({ status: "revoked", key_epoch: 2 });
    const packages = await env.CONTROL_DB.prepare("SELECT COUNT(*) AS count FROM vault_device_packages WHERE account_id = ?")
      .bind(ids.accountId).first<{ count: number }>();
    expect(packages?.count).toBe(0);
  });
});

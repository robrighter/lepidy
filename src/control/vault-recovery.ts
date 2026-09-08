import { decodeVaultBytes, validateVaultPublicKey } from "../domain/vault-envelope";

export const RECOVERY_PACKAGE_SUITE = "ARGON2ID-AES256GCM" as const;
export const DEVICE_PACKAGE_SUITE = "P256-HKDF-SHA256-AES256GCM" as const;

export type VaultRecoveryPackage = {
  suite: typeof RECOVERY_PACKAGE_SUITE;
  vaultEpoch: number;
  memoryKib: number;
  iterations: number;
  lanes: number;
  salt: string;
  iv: string;
  ciphertext: string;
};

export type VaultDevicePackage = {
  suite: typeof DEVICE_PACKAGE_SUITE;
  vaultEpoch: number;
  targetDeviceId: string;
  targetDeviceKeyEpoch: number;
  ephemeralPublicKey: string;
  iv: string;
  ciphertext: string;
};

export type StoredVaultRecovery = { vaultEpoch: number; package: VaultRecoveryPackage };

/**
 * Opaque custody for client-produced recovery and device enrollment packages.
 * This class intentionally has validation and persistence operations only: no
 * method accepts a recovery code or owns a decryption key.
 */
export class VaultRecoveryService {
  constructor(private readonly db: D1Database, private readonly now: () => number = () => Date.now()) {}

  async initialize(input: {
    accountId: string;
    deviceId: string;
    package: VaultRecoveryPackage;
    confirmed: boolean;
  }): Promise<StoredVaultRecovery> {
    if (!input.confirmed) throw new Error("recovery code confirmation is required");
    const value = validateRecoveryPackage(input.package, 1);
    await this.requireActiveDevice(input.accountId, input.deviceId);
    const now = this.now();
    try {
      await this.db.prepare(
        `INSERT INTO account_vault_recovery(
           account_id, vault_epoch, package_json, updated_by_device_id, created_at, updated_at
         ) VALUES (?, 1, ?, ?, ?, ?)`,
      ).bind(input.accountId, JSON.stringify(value), input.deviceId, now, now).run();
    } catch {
      throw new Error("account vault recovery is already initialized");
    }
    return { vaultEpoch: 1, package: value };
  }

  async read(accountId: string): Promise<StoredVaultRecovery> {
    const row = await this.db.prepare(
      "SELECT vault_epoch, package_json FROM account_vault_recovery WHERE account_id = ?",
    ).bind(accountId).first<{ vault_epoch: number; package_json: string }>();
    if (row === null) throw new Error("account vault recovery is not initialized");
    return { vaultEpoch: row.vault_epoch, package: validateRecoveryPackage(JSON.parse(row.package_json), row.vault_epoch) };
  }

  async rotate(input: {
    accountId: string;
    deviceId: string;
    expectedVaultEpoch: number;
    package: VaultRecoveryPackage;
    confirmed: boolean;
  }): Promise<StoredVaultRecovery> {
    if (!input.confirmed) throw new Error("recovery rotation confirmation is required");
    await this.requireActiveDevice(input.accountId, input.deviceId);
    const nextEpoch = input.expectedVaultEpoch + 1;
    const value = validateRecoveryPackage(input.package, nextEpoch);
    const result = await this.db.prepare(
      `UPDATE account_vault_recovery
       SET vault_epoch = ?, package_json = ?, updated_by_device_id = ?, updated_at = ?
       WHERE account_id = ? AND vault_epoch = ?`,
    ).bind(nextEpoch, JSON.stringify(value), input.deviceId, this.now(), input.accountId, input.expectedVaultEpoch).run();
    if (result.meta.changes !== 1) throw new Error("account vault epoch changed concurrently");
    await this.db.prepare("DELETE FROM vault_device_packages WHERE account_id = ? AND vault_epoch < ?")
      .bind(input.accountId, nextEpoch).run();
    return { vaultEpoch: nextEpoch, package: value };
  }

  async storeDevicePackage(input: {
    accountId: string;
    approvedByDeviceId: string;
    package: VaultDevicePackage;
    freshUserVerification: boolean;
    confirmed: boolean;
  }): Promise<{ stored: boolean }> {
    if (!input.freshUserVerification) throw new Error("fresh user verification is required");
    if (!input.confirmed) throw new Error("device enrollment confirmation is required");
    await this.requireActiveDevice(input.accountId, input.approvedByDeviceId);
    const target = await this.requireActiveDevice(input.accountId, input.package.targetDeviceId);
    const recovery = await this.read(input.accountId);
    const value = validateDevicePackage(input.package, recovery.vaultEpoch, target.keyEpoch);
    const existing = await this.db.prepare(
      `SELECT package_json FROM vault_device_packages
       WHERE account_id = ? AND target_device_id = ? AND vault_epoch = ?`,
    ).bind(input.accountId, value.targetDeviceId, value.vaultEpoch).first<{ package_json: string }>();
    if (existing !== null) {
      if (existing.package_json !== JSON.stringify(value)) throw new Error("a different device package already exists");
      return { stored: false };
    }
    await this.db.prepare(
      `INSERT INTO vault_device_packages(
         account_id, target_device_id, vault_epoch, target_device_key_epoch,
         package_json, approved_by_device_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      input.accountId, value.targetDeviceId, value.vaultEpoch, value.targetDeviceKeyEpoch,
      JSON.stringify(value), input.approvedByDeviceId, this.now(),
    ).run();
    return { stored: true };
  }

  async consumeDevicePackage(input: {
    accountId: string;
    targetDeviceId: string;
    targetDeviceKeyEpoch: number;
  }): Promise<VaultDevicePackage> {
    const target = await this.requireActiveDevice(input.accountId, input.targetDeviceId);
    if (target.keyEpoch !== input.targetDeviceKeyEpoch) throw new Error("device key epoch changed");
    const recovery = await this.read(input.accountId);
    const row = await this.db.prepare(
      `SELECT package_json FROM vault_device_packages
       WHERE account_id = ? AND target_device_id = ? AND vault_epoch = ?
         AND target_device_key_epoch = ? AND consumed_at IS NULL`,
    ).bind(input.accountId, input.targetDeviceId, recovery.vaultEpoch, input.targetDeviceKeyEpoch)
      .first<{ package_json: string }>();
    if (row === null) throw new Error("device enrollment package not found");
    await this.db.prepare(
      `UPDATE vault_device_packages SET consumed_at = ?
       WHERE account_id = ? AND target_device_id = ? AND vault_epoch = ? AND consumed_at IS NULL`,
    ).bind(this.now(), input.accountId, input.targetDeviceId, recovery.vaultEpoch).run();
    return validateDevicePackage(JSON.parse(row.package_json), recovery.vaultEpoch, target.keyEpoch);
  }

  /**
   * Finalize device removal after every workspace member key has been rekeyed.
   * The target credential, old account recovery package and all old device
   * packages change in one D1 batch. Callers deliberately rekey workspaces
   * first: failure between planes can leave signing access temporarily alive,
   * but never leaves the removed device able to open current ciphertext.
   */
  async removeDeviceAfterRekey(input: {
    accountId: string;
    actingDeviceId: string;
    removedDeviceId: string;
    expectedVaultEpoch: number;
    package: VaultRecoveryPackage;
    freshUserVerification: boolean;
    confirmed: boolean;
  }): Promise<{ removedDeviceId: string; vaultEpoch: number }> {
    if (!input.freshUserVerification) throw new Error("fresh user verification is required");
    if (!input.confirmed) throw new Error("device removal confirmation is required");
    if (input.actingDeviceId === input.removedDeviceId) throw new Error("the active recovery device cannot remove itself");
    await this.requireActiveDevice(input.accountId, input.actingDeviceId);
    const current = await this.read(input.accountId);
    const removed = await this.db.prepare(
      "SELECT status FROM devices WHERE id = ? AND account_id = ?",
    ).bind(input.removedDeviceId, input.accountId).first<{ status: "active" | "revoked" }>();
    if (
      removed?.status === "revoked"
      && current.vaultEpoch === input.expectedVaultEpoch + 1
      && JSON.stringify(current.package) === JSON.stringify(input.package)
    ) return { removedDeviceId: input.removedDeviceId, vaultEpoch: current.vaultEpoch };
    if (removed?.status !== "active") throw new Error("active account device not found");
    if (current.vaultEpoch !== input.expectedVaultEpoch) throw new Error("account vault epoch changed concurrently");
    const nextEpoch = current.vaultEpoch + 1;
    const value = validateRecoveryPackage(input.package, nextEpoch);
    const now = this.now();
    const results = await this.db.batch([
      this.db.prepare(
        `UPDATE account_vault_recovery
         SET vault_epoch = ?, package_json = ?, updated_by_device_id = ?, updated_at = ?
         WHERE account_id = ? AND vault_epoch = ?`,
      ).bind(nextEpoch, JSON.stringify(value), input.actingDeviceId, now, input.accountId, current.vaultEpoch),
      this.db.prepare(
        `UPDATE devices SET status = 'revoked', revoked_at = ?, key_epoch = key_epoch + 1
         WHERE id = ? AND account_id = ? AND status = 'active'`,
      ).bind(now, input.removedDeviceId, input.accountId),
      this.db.prepare("DELETE FROM vault_device_packages WHERE account_id = ?")
        .bind(input.accountId),
    ]);
    if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1) {
      throw new Error("device removal changed concurrently");
    }
    return { removedDeviceId: input.removedDeviceId, vaultEpoch: nextEpoch };
  }

  private async requireActiveDevice(accountId: string, deviceId: string): Promise<{ keyEpoch: number }> {
    const row = await this.db.prepare(
      `SELECT key_epoch FROM devices
       WHERE id = ? AND account_id = ? AND status = 'active'`,
    ).bind(deviceId, accountId).first<{ key_epoch: number }>();
    if (row === null) throw new Error("active account device not found");
    return { keyEpoch: row.key_epoch };
  }
}

export function validateRecoveryPackage(value: VaultRecoveryPackage, expectedEpoch: number): VaultRecoveryPackage {
  if (value.suite !== RECOVERY_PACKAGE_SUITE || value.vaultEpoch !== expectedEpoch) throw new Error("recovery package epoch or suite is invalid");
  if (value.memoryKib < 65_536 || value.iterations < 3 || value.lanes !== 1) throw new Error("recovery package KDF is too weak");
  if (decodeVaultBytes(value.salt, "recovery salt").byteLength < 16) throw new Error("recovery salt is too short");
  if (decodeVaultBytes(value.iv, "recovery iv").byteLength !== 12) throw new Error("recovery iv must be 96 bits");
  if (decodeVaultBytes(value.ciphertext, "recovery ciphertext").byteLength < 48) throw new Error("recovery ciphertext is too short");
  return { ...value };
}

export function validateDevicePackage(value: VaultDevicePackage, expectedVaultEpoch: number, expectedDeviceKeyEpoch: number): VaultDevicePackage {
  if (value.suite !== DEVICE_PACKAGE_SUITE || value.vaultEpoch !== expectedVaultEpoch) throw new Error("device package vault epoch or suite is invalid");
  if (value.targetDeviceId.length === 0 || value.targetDeviceId.length > 200) throw new Error("target device id is invalid");
  if (value.targetDeviceKeyEpoch !== expectedDeviceKeyEpoch) throw new Error("device package key epoch is stale");
  validateVaultPublicKey(value.ephemeralPublicKey, "device package ephemeral public key");
  if (decodeVaultBytes(value.iv, "device package iv").byteLength !== 12) throw new Error("device package iv must be 96 bits");
  if (decodeVaultBytes(value.ciphertext, "device package ciphertext").byteLength < 48) throw new Error("device package ciphertext is too short");
  return { ...value };
}

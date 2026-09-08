CREATE TABLE account_vault_recovery (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  vault_epoch INTEGER NOT NULL CHECK (vault_epoch > 0),
  package_json TEXT NOT NULL CHECK (json_valid(package_json)),
  updated_by_device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE vault_device_packages (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  target_device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  vault_epoch INTEGER NOT NULL CHECK (vault_epoch > 0),
  target_device_key_epoch INTEGER NOT NULL CHECK (target_device_key_epoch > 0),
  package_json TEXT NOT NULL CHECK (json_valid(package_json)),
  approved_by_device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  consumed_at INTEGER,
  PRIMARY KEY (account_id, target_device_id, vault_epoch)
) STRICT;
CREATE INDEX vault_device_packages_target_idx
  ON vault_device_packages(target_device_id, consumed_at, vault_epoch);

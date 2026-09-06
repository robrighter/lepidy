CREATE TABLE password_credentials (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  encoded_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('verify_email', 'email_login', 'password_reset', 'identity_link', 'passkey_registration', 'passkey_authentication')),
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  email_normalized TEXT,
  token_hash BLOB,
  challenge TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL,
  CHECK (token_hash IS NOT NULL OR challenge IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX auth_challenges_token_idx ON auth_challenges(token_hash) WHERE token_hash IS NOT NULL;
CREATE INDEX auth_challenges_expiry_idx ON auth_challenges(expires_at, consumed_at);

ALTER TABLE workspaces ADD COLUMN storage_mode TEXT NOT NULL DEFAULT 'local_host'
  CHECK (storage_mode IN ('local_host', 'cloud'));
ALTER TABLE workspaces ADD COLUMN designated_host_device_id TEXT REFERENCES devices(id) ON DELETE SET NULL;
ALTER TABLE workspaces ADD COLUMN host_epoch INTEGER NOT NULL DEFAULT 0 CHECK (host_epoch >= 0);
ALTER TABLE workspaces ADD COLUMN routing_epoch INTEGER NOT NULL DEFAULT 1 CHECK (routing_epoch > 0);

CREATE TRIGGER memberships_keep_last_owner_update
BEFORE UPDATE OF role, status ON memberships
WHEN OLD.role = 'owner' AND OLD.status = 'active'
  AND (NEW.role <> 'owner' OR NEW.status <> 'active')
  AND NOT EXISTS (
    SELECT 1 FROM memberships other
    WHERE other.workspace_id = OLD.workspace_id
      AND other.member_id <> OLD.member_id
      AND other.role = 'owner'
      AND other.status = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'workspace requires an active owner');
END;

CREATE TRIGGER memberships_keep_last_owner_delete
BEFORE DELETE ON memberships
WHEN OLD.role = 'owner' AND OLD.status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM memberships other
    WHERE other.workspace_id = OLD.workspace_id
      AND other.member_id <> OLD.member_id
      AND other.role = 'owner'
      AND other.status = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'workspace requires an active owner');
END;

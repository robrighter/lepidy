PRAGMA foreign_keys = ON;

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  primary_email_normalized TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'locked', 'deleted')),
  security_epoch INTEGER NOT NULL DEFAULT 1 CHECK (security_epoch > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE login_identities (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  email_normalized TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1)),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  UNIQUE (provider, provider_subject)
) STRICT;
CREATE INDEX login_identities_account_idx ON login_identities(account_id);

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  credential_id BLOB NOT NULL UNIQUE,
  public_key BLOB NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
  transports_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(transports_json)),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
) STRICT;

CREATE TABLE sessions (
  token_hash BLOB PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  security_epoch INTEGER NOT NULL,
  csrf_secret_hash BLOB NOT NULL,
  device_label TEXT,
  platform TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  CHECK (expires_at > created_at)
) STRICT;
CREATE INDEX sessions_account_active_idx ON sessions(account_id, revoked_at, expires_at);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('client', 'runner')),
  credential_hash BLOB NOT NULL UNIQUE,
  public_key BLOB,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER
) STRICT;
CREATE INDEX devices_account_idx ON devices(account_id, status);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
  durable_object_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  jurisdiction TEXT NOT NULL CHECK (jurisdiction IN ('global', 'eu')),
  plan TEXT NOT NULL DEFAULT 'solo' CHECK (plan IN ('solo', 'team')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('provisioning', 'active', 'quarantined', 'deleting', 'deleted')),
  membership_version INTEGER NOT NULL DEFAULT 0 CHECK (membership_version >= 0),
  reported_schema_version INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE memberships (
  member_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'guest')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended', 'removed')),
  authorization_epoch INTEGER NOT NULL DEFAULT 1 CHECK (authorization_epoch > 0),
  version INTEGER NOT NULL CHECK (version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (workspace_id, account_id),
  UNIQUE (workspace_id, member_id)
) STRICT;
CREATE INDEX memberships_account_idx ON memberships(account_id, status, workspace_id);
CREATE INDEX memberships_workspace_idx ON memberships(workspace_id, status, role);

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email_normalized TEXT NOT NULL,
  token_hash BLOB NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member', 'guest')),
  invited_by_member_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX invitations_workspace_email_idx ON invitations(workspace_id, email_normalized);

CREATE TABLE control_operations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('membership_upsert', 'membership_revoke', 'account_revoke', 'workspace_delete')),
  aggregate_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  applied_at INTEGER,
  last_error TEXT,
  UNIQUE (workspace_id, kind, aggregate_id, version)
) STRICT;
CREATE INDEX control_operations_due_idx ON control_operations(status, next_attempt_at);

CREATE TABLE subscriptions (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_customer_id TEXT,
  provider_subscription_id TEXT UNIQUE,
  status TEXT NOT NULL,
  seat_quantity INTEGER NOT NULL DEFAULT 1 CHECK (seat_quantity > 0),
  storage_pack_gb INTEGER NOT NULL DEFAULT 0 CHECK (storage_pack_gb >= 0),
  updated_at INTEGER NOT NULL
) STRICT;

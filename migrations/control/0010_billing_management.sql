CREATE TABLE billing_change_requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  requested_by_member_id TEXT NOT NULL,
  plan TEXT NOT NULL CHECK (plan IN ('solo', 'team')),
  seat_quantity INTEGER NOT NULL CHECK (seat_quantity BETWEEN 1 AND 50),
  storage_pack_gb INTEGER NOT NULL CHECK (storage_pack_gb >= 0 AND storage_pack_gb % 100 = 0),
  monthly_price_cents INTEGER NOT NULL CHECK (monthly_price_cents >= 0),
  direction TEXT NOT NULL CHECK (direction IN ('increase', 'decrease', 'same', 'restore')),
  status TEXT NOT NULL CHECK (status IN ('pending_checkout', 'submitted', 'superseded', 'expired')),
  provider_session_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX billing_change_requests_workspace_idx
  ON billing_change_requests(workspace_id, created_at DESC);

CREATE TABLE billing_invoices (
  source TEXT NOT NULL CHECK (source IN ('stripe', 'apple', 'microsoft')),
  external_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  amount_due_cents INTEGER NOT NULL CHECK (amount_due_cents >= 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'paid', 'void', 'uncollectible')),
  hosted_url TEXT,
  issued_at INTEGER NOT NULL,
  PRIMARY KEY (source, external_id)
) STRICT;

CREATE INDEX billing_invoices_workspace_idx ON billing_invoices(workspace_id, issued_at DESC);

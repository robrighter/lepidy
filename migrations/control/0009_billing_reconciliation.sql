ALTER TABLE subscriptions ADD COLUMN external_id TEXT;
ALTER TABLE subscriptions ADD COLUMN current_period_end INTEGER;
ALTER TABLE subscriptions ADD COLUMN cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0, 1));
ALTER TABLE subscriptions ADD COLUMN provider_version INTEGER NOT NULL DEFAULT 0 CHECK (provider_version >= 0);

CREATE UNIQUE INDEX subscriptions_source_external_idx
  ON subscriptions(source, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE billing_event_receipts (
  source TEXT NOT NULL CHECK (source IN ('stripe', 'apple', 'microsoft')),
  event_id TEXT NOT NULL,
  event_created_at INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  workspace_id TEXT,
  received_at INTEGER NOT NULL,
  applied_at INTEGER,
  disposition TEXT NOT NULL CHECK (disposition IN ('applied', 'duplicate', 'stale', 'ignored', 'failed')),
  last_error TEXT,
  PRIMARY KEY (source, event_id)
) STRICT;

CREATE INDEX billing_events_workspace_idx
  ON billing_event_receipts(workspace_id, received_at DESC);

CREATE TABLE billing_reconciliation_jobs (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('stripe', 'apple', 'microsoft')),
  external_id TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX billing_reconciliation_due_idx
  ON billing_reconciliation_jobs(next_attempt_at);

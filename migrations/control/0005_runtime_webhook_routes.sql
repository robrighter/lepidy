CREATE TABLE runtime_webhook_routes (
  organization_id TEXT NOT NULL,
  provider_workspace_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  durable_object_id TEXT NOT NULL,
  secret_envelope TEXT NOT NULL,
  transport_context TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'disconnected')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (organization_id, provider_workspace_id),
  UNIQUE (workspace_id, organization_id, provider_workspace_id)
) STRICT;
CREATE INDEX runtime_webhook_routes_workspace_idx ON runtime_webhook_routes(workspace_id, status);

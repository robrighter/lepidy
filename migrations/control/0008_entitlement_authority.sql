ALTER TABLE subscriptions ADD COLUMN plan TEXT NOT NULL DEFAULT 'solo' CHECK (plan IN ('solo', 'team'));
ALTER TABLE subscriptions ADD COLUMN source TEXT NOT NULL DEFAULT 'none' CHECK (source IN ('none', 'stripe', 'apple', 'microsoft'));

UPDATE subscriptions
SET plan = COALESCE((SELECT plan FROM workspaces WHERE workspaces.id = subscriptions.workspace_id), 'solo'),
    source = CASE
      WHEN provider IN ('stripe', 'apple', 'microsoft') THEN provider
      ELSE 'none'
    END;

INSERT INTO subscriptions(workspace_id, provider, status, seat_quantity, storage_pack_gb, updated_at, plan, source)
SELECT id, 'none', 'active', CASE WHEN plan = 'team' THEN 5 ELSE 1 END, 0, updated_at, plan, 'none'
FROM workspaces
WHERE NOT EXISTS (SELECT 1 FROM subscriptions WHERE subscriptions.workspace_id = workspaces.id);

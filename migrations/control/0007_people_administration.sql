ALTER TABLE invitations ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'ready'
  CHECK (delivery_state IN ('ready', 'held_for_plan'));
ALTER TABLE invitations ADD COLUMN last_sent_at INTEGER;
CREATE INDEX invitations_pending_idx
  ON invitations(workspace_id, revoked_at, accepted_at, expires_at);

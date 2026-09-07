-- The OAuth client registry.
--
-- This is the one part of the MCP authorization server that cannot live in a
-- workspace object: an MCP client registers itself before anybody has signed
-- in, so at registration time there is no workspace to route to. Everything
-- that follows — codes, connections, tokens — is workspace-scoped and lives in
-- the tenant.
--
-- A client id is a label, not a credential. Registration is open by design
-- (RFC 7591, required by MCP), so nothing here authorises anything: the
-- decisions are taken at the authorization endpoint by a signed-in person
-- looking at a consent screen, and at redemption by PKCE.
CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT,
  redirect_uris_json TEXT NOT NULL CHECK (json_valid(redirect_uris_json)),
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none'
    CHECK (token_endpoint_auth_method = 'none'),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
) STRICT;

CREATE INDEX oauth_clients_created_idx ON oauth_clients(created_at);

ALTER TABLE devices ADD COLUMN security_epoch INTEGER NOT NULL DEFAULT 1 CHECK (security_epoch > 0);
ALTER TABLE devices ADD COLUMN key_epoch INTEGER NOT NULL DEFAULT 1 CHECK (key_epoch > 0);
ALTER TABLE devices ADD COLUMN signing_public_key_jwk TEXT CHECK (
  signing_public_key_jwk IS NULL OR json_valid(signing_public_key_jwk)
);
ALTER TABLE devices ADD COLUMN encryption_public_key_jwk TEXT CHECK (
  encryption_public_key_jwk IS NULL OR json_valid(encryption_public_key_jwk)
);

CREATE TABLE device_request_nonces (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  nonce TEXT NOT NULL,
  request_id TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, nonce),
  CHECK (expires_at > seen_at)
) STRICT;
CREATE INDEX device_request_nonces_expiry_idx ON device_request_nonces(expires_at);

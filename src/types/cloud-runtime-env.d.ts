interface CloudflareEnv {
  /** Platform transport key. A secret binding in production, never a tenant value. */
  TRANSPORT_SECRET_KEY?: string;
  /** Platform OIDC signing JWK. A secret/key-service binding in production. */
  WIF_SIGNING_JWK?: string;
}

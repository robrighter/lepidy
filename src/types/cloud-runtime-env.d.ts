interface CloudflareEnv {
  /** Platform transport key. A secret binding in production, never a tenant value. */
  TRANSPORT_SECRET_KEY?: string;
  /** Platform OIDC signing JWK. A secret/key-service binding in production. */
  WIF_SIGNING_JWK?: string;
  /**
   * The VAPID private key that identifies this deployment to a push service,
   * as a P-256 JWK. A secret binding, and platform-wide rather than per-tenant:
   * it authenticates Lepidy to Google, Apple and Mozilla, and says nothing
   * about any payload — RFC 8291 encryption is what keeps those unreadable.
   *
   * A deployment without one has no push transport at all, which is a state the
   * outbox reports rather than one it retries.
   */
  VAPID_PRIVATE_JWK?: string;
  /** The contact a push service is told to reach on abuse: `mailto:` or `https:`. */
  VAPID_SUBJECT?: string;
}

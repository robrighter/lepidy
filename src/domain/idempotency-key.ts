const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;

export type IdempotencyKey = string & { readonly __brand: "IdempotencyKey" };

/**
 * Validate a client-generated mutation key before it reaches durable storage.
 * Meaning and tenant ownership are checked by the command handler; this rule
 * only guarantees a bounded, log-safe transport value.
 */
export function parseIdempotencyKey(value: unknown): IdempotencyKey | null {
  if (typeof value !== "string" || !IDEMPOTENCY_KEY.test(value)) return null;
  return value as IdempotencyKey;
}

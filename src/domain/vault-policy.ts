import { assertOpaqueId, type VaultKeyWrap } from "./vault-envelope";
import type { VaultDelivery } from "./vault-authorization";

export const MAX_VAULT_GRANT_TTL_MS = 8 * 60 * 60 * 1_000;
export const MAX_VAULT_USES_PER_HOUR = 10_000;

export type VaultPolicy = {
  mode: "never" | "ask" | "auto";
  allowedDeliveries: readonly VaultDelivery[];
  projectIds: readonly string[];
  grantTtlMs?: number;
  availableUntil?: number;
  maxUsesPerHour?: number;
  highRisk: boolean;
};

export type VaultCredentialMetadata = {
  name: string;
  description: string;
  envVar?: string;
  tags: readonly string[];
  commands: readonly string[];
  proxyHosts: readonly string[];
};

export type VaultAclEntry = {
  subjectType: "member" | "group" | "agent" | "channel";
  subjectId: string;
  verb: "use" | "reveal" | "manage";
};

export function normalizeVaultMetadata(value: VaultCredentialMetadata): VaultCredentialMetadata {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(value.name)) throw new Error("credential name is invalid");
  if (value.description.length > 500) throw new Error("credential description is too long");
  if (value.envVar !== undefined && !/^[A-Z_][A-Z0-9_]{0,63}$/u.test(value.envVar)) {
    throw new Error("credential environment variable is invalid");
  }
  return {
    name: value.name,
    description: value.description,
    ...(value.envVar === undefined ? {} : { envVar: value.envVar }),
    tags: uniqueStrings(value.tags, "tag", 32, 64),
    commands: uniqueStrings(value.commands, "command", 32, 200),
    proxyHosts: uniqueStrings(value.proxyHosts, "proxy host", 64, 253),
  };
}

export function normalizeVaultPolicy(value: VaultPolicy, now: number): VaultPolicy {
  if (!(["never", "ask", "auto"] as const).includes(value.mode)) throw new Error("vault mode is invalid");
  const allowed = [...new Set(value.allowedDeliveries)];
  if (allowed.length === 0 || allowed.some((item) => !(["inject", "file", "device_proxy", "reveal"] as const).includes(item))) {
    throw new Error("vault delivery is invalid");
  }
  const projectIds = uniqueStrings(value.projectIds, "project id", 100, 200);
  for (const id of projectIds) assertOpaqueId(id, "project id");
  if (value.grantTtlMs !== undefined && (!Number.isSafeInteger(value.grantTtlMs) || value.grantTtlMs < 1 || value.grantTtlMs > MAX_VAULT_GRANT_TTL_MS)) {
    throw new Error("vault grant TTL is invalid");
  }
  if (value.availableUntil !== undefined && (!Number.isSafeInteger(value.availableUntil) || value.availableUntil <= now)) {
    throw new Error("vault availability must end in the future");
  }
  if (value.maxUsesPerHour !== undefined && (!Number.isSafeInteger(value.maxUsesPerHour) || value.maxUsesPerHour < 1 || value.maxUsesPerHour > MAX_VAULT_USES_PER_HOUR)) {
    throw new Error("vault hourly use ceiling is invalid");
  }
  return { ...value, allowedDeliveries: allowed, projectIds };
}

export function validateVaultAcl(entries: readonly VaultAclEntry[], wraps: readonly VaultKeyWrap[]): VaultAclEntry[] {
  if (entries.length === 0) throw new Error("vault ACL must not be empty");
  const seen = new Set<string>();
  const normalized = entries.map((entry) => {
    if (!(["member", "group", "agent", "channel"] as const).includes(entry.subjectType)) throw new Error("vault ACL subject type is invalid");
    if (!(["use", "reveal", "manage"] as const).includes(entry.verb)) throw new Error("vault ACL verb is invalid");
    assertOpaqueId(entry.subjectId, "ACL subject id");
    if (entry.verb === "manage" && entry.subjectType !== "member") {
      throw new Error("vault manage access may only be assigned to members");
    }
    const key = `${entry.subjectType}:${entry.subjectId}:${entry.verb}`;
    if (seen.has(key)) throw new Error("vault ACL contains a duplicate entry");
    seen.add(key);
    return { ...entry };
  });
  const managers = new Set(normalized.filter((entry) => entry.verb === "manage").map((entry) => entry.subjectId));
  const custodians = new Set(wraps.map((wrap) => wrap.custodianMemberId));
  if (managers.size === 0) throw new Error("vault credential requires a custodian");
  if (managers.size !== custodians.size || [...managers].some((id) => !custodians.has(id))) {
    throw new Error("vault key wraps must exactly match managing custodians");
  }
  return normalized;
}

function uniqueStrings(values: readonly string[], field: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(values) || values.length > maxItems) throw new Error(`too many vault ${field}s`);
  const result = [...new Set(values)];
  if (result.some((value) => typeof value !== "string" || value.length === 0 || value.length > maxLength)) {
    throw new Error(`vault ${field} is invalid`);
  }
  return result;
}

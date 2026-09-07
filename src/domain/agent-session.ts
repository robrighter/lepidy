import { mcpToolDefinition, type McpToolName } from "./mcp-oauth";

export const DELEGATION_DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const DELEGATION_MAX_TTL_MS = DELEGATION_DEFAULT_TTL_MS;
export const SESSION_TOKEN_TTL_MS = 15 * 60 * 1000;
export const SESSION_HARD_TTL_MS = 8 * 60 * 60 * 1000;

export type SessionCapability = McpToolName;

export type DelegationBounds = {
  channelIds: readonly string[] | null;
  credentialIds: readonly string[];
  deliveryModes: readonly string[];
  projectIds: readonly string[];
};

export function normalizeBoundedIds(
  values: readonly string[] | null | undefined,
  options: { nullable: boolean; maximum?: number } = { nullable: false },
): readonly string[] | null {
  if (values == null) return options.nullable ? null : [];
  const maximum = options.maximum ?? 100;
  if (values.length > maximum) throw new Error(`at most ${maximum} values are allowed`);
  const normalized = [...new Set(values.map((value) => value.trim()))].sort();
  if (normalized.some((value) => value.length === 0 || value.length > 200)) {
    throw new Error("delegation values must be non-empty and at most 200 characters");
  }
  return normalized;
}

export function normalizeSessionCapabilities(values: readonly string[]): readonly SessionCapability[] {
  const normalized = normalizeBoundedIds(values, { nullable: false, maximum: 32 }) as readonly string[];
  if (normalized.length === 0) throw new Error("a session needs at least one capability");
  for (const value of normalized) {
    const tool = mcpToolDefinition(value);
    if (tool === null || !tool.sessionCapable) throw new Error(`session capability ${value} is not allowed`);
  }
  return normalized as readonly SessionCapability[];
}

export function sessionAllowsTool(capabilities: readonly string[], toolName: McpToolName): boolean {
  const tool = mcpToolDefinition(toolName);
  return tool !== null && tool.sessionCapable && capabilities.includes(toolName);
}

export function delegationAllowsChannel(channelIds: readonly string[] | null, channelId: string): boolean {
  return channelIds === null || channelIds.includes(channelId);
}

export function sessionTokenExpiresAt(input: {
  now: number;
  sessionHardExpiresAt: number;
  delegationExpiresAt: number;
}): number {
  return Math.min(input.now + SESSION_TOKEN_TTL_MS, input.sessionHardExpiresAt, input.delegationExpiresAt);
}

export function validDelegationExpiry(now: number, expiresAt: number): boolean {
  return Number.isSafeInteger(expiresAt) && expiresAt > now && expiresAt <= now + DELEGATION_MAX_TTL_MS;
}


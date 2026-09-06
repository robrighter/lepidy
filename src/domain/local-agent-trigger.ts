const REMOTE_TRIGGER_KEYS = new Set([
  "workspaceId",
  "agentId",
  "deviceId",
  "presetId",
  "configRevision",
  "requestId",
]);

export type LocalAgentTrigger = {
  workspaceId: string;
  agentId: string;
  deviceId: string;
  presetId: string;
  configRevision: number;
  requestId: string;
};

export function parseRemoteLocalAgentTrigger(value: unknown): LocalAgentTrigger {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid local agent trigger");
  }

  const input = value as Record<string, unknown>;
  const unexpected = Object.keys(input).filter((key) => !REMOTE_TRIGGER_KEYS.has(key));
  if (unexpected.length > 0) {
    throw new Error(`remote launch configuration is forbidden: ${unexpected.sort().join(", ")}`);
  }

  for (const key of ["workspaceId", "agentId", "deviceId", "presetId", "requestId"] as const) {
    if (typeof input[key] !== "string" || input[key].length === 0) {
      throw new Error(`invalid ${key}`);
    }
  }
  if (!Number.isSafeInteger(input.configRevision) || Number(input.configRevision) < 1) {
    throw new Error("invalid configRevision");
  }

  return input as LocalAgentTrigger;
}

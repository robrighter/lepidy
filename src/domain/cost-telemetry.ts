export const USAGE_BUCKET_MS = 5 * 60_000;

export const PUBLISHED_RESOURCE_LIMITS = Object.freeze({
  humansPerWorkspace: 50,
  concurrentWorkspaceSockets: 500,
  concurrentRunsPerDevice: 4,
  agentStartsPerWorkspacePerMinute: 120,
  mcpWritesPerConnectionPerMinute: 120,
  workspaceStorageBytes: 10 * 1024 ** 3,
});

export type UsageDelta = {
  requests?: number; rowsRead?: number; rowsWritten?: number; cpuMs?: number;
  activeMs?: number; socketConnectedMs?: number; runnerConnectedMs?: number;
  runnerActiveMs?: number;
  queueMessages?: number; r2Reads?: number; r2Writes?: number; r2StoredByteMs?: number;
};

export type UsageTotals = Required<UsageDelta>;

export function usageBucket(timestamp: number): number {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error("usage timestamp must be a whole millisecond value");
  return Math.floor(timestamp / USAGE_BUCKET_MS) * USAGE_BUCKET_MS;
}

export function normalizeUsageDelta(delta: UsageDelta): UsageTotals {
  const result = {
    requests: delta.requests ?? 0, rowsRead: delta.rowsRead ?? 0, rowsWritten: delta.rowsWritten ?? 0,
    cpuMs: delta.cpuMs ?? 0, activeMs: delta.activeMs ?? 0, socketConnectedMs: delta.socketConnectedMs ?? 0,
    runnerConnectedMs: delta.runnerConnectedMs ?? 0, runnerActiveMs: delta.runnerActiveMs ?? 0, queueMessages: delta.queueMessages ?? 0,
    r2Reads: delta.r2Reads ?? 0, r2Writes: delta.r2Writes ?? 0, r2StoredByteMs: delta.r2StoredByteMs ?? 0,
  };
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} usage must be a non-negative whole number`);
  }
  return result;
}

export function runnerIdleMs(usage: UsageTotals): number {
  return Math.max(0, usage.runnerConnectedMs - usage.runnerActiveMs);
}

export function limitUtilization(observed: number, limit: number): { percent: number; severity: "ok" | "warning" | "critical" } {
  if (!Number.isSafeInteger(observed) || observed < 0 || !Number.isSafeInteger(limit) || limit <= 0) throw new Error("limit utilization is invalid");
  const percent = Math.round(observed / limit * 100);
  return { percent, severity: percent >= 100 ? "critical" : percent >= 80 ? "warning" : "ok" };
}

/** Marginal Cloudflare estimate from HLD §13; observed counters remain separately visible. */
export function estimateMonthlyCostCents(usage: UsageTotals): number {
  const workerRequests = usage.requests * 0.30 / 1_000_000;
  const workerCpu = usage.cpuMs * 0.02 / 1_000_000;
  const rowsRead = usage.rowsRead * 0.001 / 1_000_000;
  const rowsWritten = usage.rowsWritten / 1_000_000;
  const duration = usage.activeMs / 1000 * 0.128 * 12.50 / 1_000_000;
  const queue = usage.queueMessages * 3 * 0.40 / 1_000_000;
  const r2Operations = usage.r2Reads * 0.36 / 1_000_000 + usage.r2Writes * 4.50 / 1_000_000;
  const r2Storage = usage.r2StoredByteMs / (1024 ** 3 * 30 * 24 * 60 * 60_000) * 0.015;
  return Math.ceil((workerRequests + workerCpu + rowsRead + rowsWritten + duration + queue + r2Operations + r2Storage) * 100);
}

export function forecastMonthly(current: UsageTotals, observedMs: number): { projected: UsageTotals; estimatedCostCents: number; confidence: "low" | "medium" | "high" } {
  if (!Number.isSafeInteger(observedMs) || observedMs <= 0) throw new Error("forecast window must be positive");
  const monthMs = 30 * 24 * 60 * 60_000;
  const factor = monthMs / observedMs;
  const projected = Object.fromEntries(Object.entries(current).map(([key, value]) => [key, Math.round(value * factor)])) as UsageTotals;
  return { projected, estimatedCostCents: estimateMonthlyCostCents(projected), confidence: observedMs < 24 * 60 * 60_000 ? "low" : observedMs < 7 * 24 * 60 * 60_000 ? "medium" : "high" };
}

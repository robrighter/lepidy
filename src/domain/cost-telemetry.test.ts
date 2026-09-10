import { describe, expect, it } from "vitest";
import { forecastMonthly, limitUtilization, normalizeUsageDelta, PUBLISHED_RESOURCE_LIMITS, runnerIdleMs, usageBucket } from "./cost-telemetry";

describe("cost telemetry", () => {
  it("rolls events into stable five-minute buckets", () => {
    expect(usageBucket(300_001)).toBe(300_000);
    expect(usageBucket(599_999)).toBe(300_000);
  });

  it("refuses negative or fractional counters", () => {
    expect(() => normalizeUsageDelta({ rowsWritten: -1 })).toThrow("rowsWritten");
    expect(() => normalizeUsageDelta({ cpuMs: 1.5 })).toThrow("cpuMs");
  });

  it("labels short forecasts as estimates rather than measurements", () => {
    const current = normalizeUsageDelta({ requests: 1_000, rowsWritten: 100, activeMs: 60_000 });
    const forecast = forecastMonthly(current, 60 * 60_000);
    expect(forecast.confidence).toBe("low");
    expect(forecast.projected.requests).toBe(720_000);
    expect(forecast.estimatedCostCents).toBeGreaterThan(0);
  });

  it("publishes finite automation ceilings independently of paid seats", () => {
    expect(PUBLISHED_RESOURCE_LIMITS.humansPerWorkspace).toBe(50);
    expect(PUBLISHED_RESOURCE_LIMITS.concurrentWorkspaceSockets).toBe(500);
    expect(PUBLISHED_RESOURCE_LIMITS.concurrentRunsPerDevice).toBe(4);
  });

  it("measures idle runner time separately and grades limit pressure", () => {
    expect(runnerIdleMs(normalizeUsageDelta({ runnerConnectedMs: 10_000, runnerActiveMs: 2_500 }))).toBe(7_500);
    expect(limitUtilization(79, 100)).toEqual({ percent: 79, severity: "ok" });
    expect(limitUtilization(80, 100).severity).toBe("warning");
    expect(limitUtilization(100, 100).severity).toBe("critical");
  });
});

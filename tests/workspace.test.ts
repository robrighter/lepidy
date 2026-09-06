import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Workspace } from "../src/cloudflare/workspace";
import type { MigrationFixture } from "./fixtures/migration-fixture";

describe("Workspace Durable Object migrations", () => {
  it("WORKSPACE-INT-001 migrates a new workspace to the current singleton version", async () => {
    const stub = env.WORKSPACE.getByName("workspace-current");

    await expect(stub.health()).resolves.toEqual({
      ok: true,
      schemaVersion: 4,
      status: "ready",
      error: null,
    });

    await runInDurableObject<Workspace, void>(stub, (_instance, state) => {
      const schemaRows = state.storage.sql
        .exec<{ singleton: number; version: number; status: string }>(
          "SELECT singleton, version, status FROM _schema",
        )
        .toArray();
      const tables = state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .toArray()
        .map(({ name }) => name);

      expect(schemaRows).toEqual([{ singleton: 1, version: 4, status: "ready" }]);
      expect(tables).toEqual(
        expect.arrayContaining([
          "members",
          "agents",
          "groups",
          "channels",
          "messages",
          "idempotency_keys",
          "replay_events",
          "pending_events",
          "applied_control_operations",
        ]),
      );
    });
  });

  it.each([1, 2, 3])("MIGRATION-INT-001 upgrades a historical version-%s workspace", async (version) => {
    const stub = env.MIGRATION_FIXTURE.getByName(`historical-v${version}`);

    await expect(stub.migrateThrough(version)).resolves.toEqual({
      version,
      status: "ready",
      error: null,
    });
    await expect(stub.migrateCurrent()).resolves.toEqual({
      version: 4,
      status: "ready",
      error: null,
    });
    await expect(stub.migrateCurrent()).resolves.toEqual({
      version: 4,
      status: "ready",
      error: null,
    });
  });

  it("MIGRATION-INT-002 rolls back a failed migration and quarantines only that workspace", async () => {
    const failed = env.MIGRATION_FIXTURE.getByName("broken-v2");
    const healthy = env.MIGRATION_FIXTURE.getByName("healthy-v2");

    const failure = await failed.migrateBrokenAfterVersionOne();
    expect(failure.version).toBe(1);
    expect(failure.status).toBe("quarantined");
    expect(failure.error).toContain("table_that_does_not_exist");

    await runInDurableObject<MigrationFixture, void>(failed, (_instance, state) => {
      const partialTable = state.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'should_roll_back'",
        )
        .one();
      const failures = state.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM _migration_failures")
        .one();

      expect(partialTable.count).toBe(0);
      expect(failures.count).toBe(1);
    });

    await expect(healthy.migrateCurrent()).resolves.toEqual({
      version: 4,
      status: "ready",
      error: null,
    });
    await expect(failed.migrateCurrent()).resolves.toEqual(failure);
  });
});

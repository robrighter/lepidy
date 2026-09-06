import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Workspace } from "../src/cloudflare/workspace";

describe("Workspace Durable Object fixture", () => {
  it("WORKSPACE-INT-001 creates the singleton schema once and exposes it over RPC", async () => {
    const stub = env.WORKSPACE.getByName("workspace-fixture");

    await expect(stub.health()).resolves.toEqual({ ok: true, schemaVersion: 1 });
    await expect(stub.health()).resolves.toEqual({ ok: true, schemaVersion: 1 });

    await runInDurableObject<Workspace, void>(stub, (_instance, state) => {
      const rows = state.storage.sql
        .exec<{ singleton: number; version: number }>(
          "SELECT singleton, version FROM _schema",
        )
        .toArray();

      expect(rows).toEqual([{ singleton: 1, version: 1 }]);
    });
  });
});

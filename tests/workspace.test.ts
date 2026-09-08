import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Workspace } from "../src/cloudflare/workspace";
import { checksumSoloSnapshot, type SoloSnapshotPayload } from "../src/domain/solo-snapshot";
import type { MigrationFixture } from "./fixtures/migration-fixture";

describe("Workspace Durable Object migrations", () => {
  it("WORKSPACE-INT-001 migrates a new workspace to the current singleton version", async () => {
    const stub = env.WORKSPACE.getByName("workspace-current");

    await expect(stub.health()).resolves.toEqual({
      ok: true,
      schemaVersion: 28,
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

      expect(schemaRows).toEqual([{ singleton: 1, version: 28, status: "ready" }]);
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
          "due_work",
          "due_work_failures",
          "audit_events",
          "audit_anchors",
          "audit_retention",
          "channel_message_sequence",
          "channel_read_state",
          "thread_read_state",
          "message_reactions",
          "message_mentions",
          "channel_pins",
          "saved_items",
          "message_drafts",
          "scheduled_messages",
          "message_snippets",
          "custom_emoji",
          "agent_scope_channels",
          "agent_queue",
          "oauth_codes",
          "oauth_connections",
          "mcp_message_attribution",
          "mcp_write_limits",
          "agent_delegations",
          "agent_sessions",
          "agent_session_message_attribution",
          "agent_session_write_limits",
          "vault_settings",
          "vault_credentials",
          "vault_credential_key_wraps",
          "vault_credential_acl",
          "vault_grants",
          "vault_usage_events",
          "vault_credential_deletions",
          "vault_member_keys",
          "vault_approvals",
          "vault_approval_items",
          "vault_approval_approvers",
          "runner_devices",
          "runner_agents",
          "runner_wakes",
          "vault_proxy_requests",
          "agent_runtime_configs",
          "runtime_runs",
          "anthropic_webhook_receipts",
          "custom_runtime_deliveries",
          "notification_preferences",
          "channel_notification_preferences",
          "notification_keywords",
          "thread_subscriptions",
          "notifications",
        ]),
      );
    });
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27])("MIGRATION-INT-001 upgrades a historical version-%s workspace", async (version) => {
    const stub = env.MIGRATION_FIXTURE.getByName(`historical-v${version}`);

    await expect(stub.migrateThrough(version)).resolves.toEqual({
      version,
      status: "ready",
      error: null,
    });
    await expect(stub.migrateCurrent()).resolves.toEqual({
      version: 28,
      status: "ready",
      error: null,
    });
    await expect(stub.migrateCurrent()).resolves.toEqual({
      version: 28,
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
      version: 28,
      status: "ready",
      error: null,
    });
    await expect(failed.migrateCurrent()).resolves.toEqual(failure);
  });

  it("SOLO-RELAY-002 leases one host, fences old epochs, and stores metadata only", async () => {
    const stub = env.WORKSPACE.getByName("solo-relay-routing");
    await stub.initializeWorkspace({ storageMode: "local_host", hostEpoch: 0, routingEpoch: 1, now: 100 });

    await runInDurableObject<Workspace, void>(stub, (instance) => {
      expect(() => instance.routeOpaqueFrame(
        {
          workspaceId: "workspace-solo",
          hostEpoch: 1,
          sequence: 1,
          requestId: "request_route_001",
          direction: "to_host",
          ciphertextBytes: 96,
        },
        101,
      )).toThrow("host_offline");
    });

    await stub.designateSoloHost({ deviceId: "device-main", newHostEpoch: 1, now: 102 });
    await expect(
      stub.renewSoloHostLease({ deviceId: "device-main", hostEpoch: 1, now: 103, ttlMs: 30_000 }),
    ).resolves.toBe(30_103);

    const toHost = {
      workspaceId: "workspace-solo",
      hostEpoch: 1,
      sequence: 1,
      requestId: "request_route_001",
      direction: "to_host" as const,
      ciphertextBytes: 96,
    };
    await expect(stub.routeOpaqueFrame(toHost, 104)).resolves.toEqual({ routed: true, sequence: 1 });
    await expect(
      stub.routeOpaqueFrame({ ...toHost, direction: "from_host", requestId: "request_route_002" }, 105),
    ).resolves.toEqual({ routed: true, sequence: 1 });
    await runInDurableObject<Workspace, void>(stub, (instance) => {
      expect(() => instance.routeOpaqueFrame(toHost, 106)).toThrow("stale relay sequence");
      expect(() => instance.routeOpaqueFrame({ ...toHost, sequence: 2 }, 31_000)).toThrow("host_offline");
    });

    await stub.designateSoloHost({ deviceId: "device-replacement", newHostEpoch: 2, now: 31_001 });
    await runInDurableObject<Workspace, void>(stub, (instance) => {
      expect(() =>
        instance.renewSoloHostLease({ deviceId: "device-main", hostEpoch: 1, now: 31_002, ttlMs: 30_000 }),
      ).toThrow("stale or unauthorized solo host");
    });
    await stub.renewSoloHostLease({
      deviceId: "device-replacement",
      hostEpoch: 2,
      now: 31_003,
      ttlMs: 30_000,
    });
    await runInDurableObject<Workspace, void>(stub, (instance) => {
      expect(() => instance.routeOpaqueFrame({ ...toHost, hostEpoch: 1, sequence: 2 }, 31_004)).toThrow(
        "host_offline",
      );
    });
    await expect(stub.routeOpaqueFrame({ ...toHost, hostEpoch: 2 }, 31_004)).resolves.toEqual({
      routed: true,
      sequence: 1,
    });

    await runInDurableObject<Workspace, void>(stub, (_instance, state) => {
      const configColumns = state.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(workspace_config)")
        .toArray()
        .map(({ name }) => name);
      expect(configColumns).not.toContain("ciphertext");
      expect(configColumns).not.toContain("content");
    });
  });

  it("SOLO-RELAY-003 rejects host designation for a cloud workspace", async () => {
    const stub = env.WORKSPACE.getByName("cloud-no-solo-host");
    await stub.initializeWorkspace({ storageMode: "cloud", hostEpoch: 0, routingEpoch: 1, now: 100 });
    await runInDurableObject<Workspace, void>(stub, (instance) => {
      expect(() => instance.designateSoloHost({ deviceId: "device-main", newHostEpoch: 1, now: 101 })).toThrow(
        "workspace is not local-hosted",
      );
    });
  });

  it("SOLO-UPGRADE-001 stages, resumes, verifies, then atomically switches routing", async () => {
    const stub = env.WORKSPACE.getByName("solo-upgrade");
    await stub.initializeWorkspace({ storageMode: "local_host", hostEpoch: 1, routingEpoch: 7, now: 100 });
    const payload: SoloSnapshotPayload = {
      version: 1,
      workspaceId: "workspace-upgrade",
      hostEpoch: 1,
      channels: [
        { id: "channel-1", kind: "public", slug: "general", name: "General", createdAt: 10, updatedAt: 10 },
      ],
      messages: [
        {
          id: "message-1",
          channelId: "channel-1",
          authorId: "member-1",
          bodyMarkdown: "TEAM_UPGRADE_CANARY",
          createdAt: 20,
        },
      ],
      attachments: [],
    };
    const snapshot = { ...payload, checksum: await checksumSoloSnapshot(payload) };

    await expect(stub.stageSoloUpgrade({ importId: "import_upgrade_001", snapshot, now: 101 })).resolves.toEqual({
      staged: true,
      replayed: false,
    });
    await expect(stub.stageSoloUpgrade({ importId: "import_upgrade_001", snapshot, now: 102 })).resolves.toEqual({
      staged: true,
      replayed: true,
    });
    await runInDurableObject<Workspace, void>(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ storage_mode: string }>("SELECT storage_mode FROM workspace_config").one())
        .toEqual({ storage_mode: "local_host" });
      expect(state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM messages").one().count).toBe(0);
    });

    await expect(
      stub.finalizeSoloUpgrade({ importId: "import_upgrade_001", expectedWorkspaceId: "workspace-upgrade", now: 103 }),
    ).resolves.toEqual({ storageMode: "cloud", routingEpoch: 8, replayed: false });
    await expect(
      stub.finalizeSoloUpgrade({ importId: "import_upgrade_001", expectedWorkspaceId: "workspace-upgrade", now: 104 }),
    ).resolves.toEqual({ storageMode: "cloud", routingEpoch: 8, replayed: true });
    await runInDurableObject<Workspace, void>(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ body_markdown: string }>("SELECT body_markdown FROM messages").one())
        .toEqual({ body_markdown: "TEAM_UPGRADE_CANARY" });
      expect(state.storage.sql.exec<{ status: string }>("SELECT status FROM solo_upgrade_imports").one())
        .toEqual({ status: "complete" });
    });
  });
});

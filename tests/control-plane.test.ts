import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

describe("D1 control-plane schema", () => {
  beforeAll(async () => {
    await applyD1Migrations(env.CONTROL_DB, env.TEST_CONTROL_MIGRATIONS);
  });

  it("CONTROL-INT-001 stores identity, routing and membership without tenant content", async () => {
    const tables = await env.CONTROL_DB.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all<{ name: string; sql: string }>();
    const names = tables.results.map(({ name }) => name);

    expect(names).toEqual(
      expect.arrayContaining([
        "accounts",
        "login_identities",
        "passkeys",
        "sessions",
        "devices",
        "workspaces",
        "memberships",
        "invitations",
        "control_operations",
        "subscriptions",
      ]),
    );
    expect(names).not.toEqual(
      expect.arrayContaining(["messages", "channels", "credentials", "audit_events"]),
    );

    const schema = tables.results.map(({ sql }) => sql.toLowerCase()).join("\n");
    for (const forbidden of ["body_markdown", "ciphertext", "credential_value", "agent_brief"]) {
      expect(schema).not.toContain(forbidden);
    }
  });

  it("CONTROL-INT-002 gives one account different tenant-local member ids", async () => {
    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare(
        "INSERT INTO accounts(id, primary_email_normalized, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).bind("account-1", "maya@example.com", "Maya", 1, 1),
      env.CONTROL_DB.prepare(
        "INSERT INTO workspaces(id, slug, durable_object_id, name, jurisdiction, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind("workspace-a", "alpha", "do-a", "Alpha", "global", 1, 1),
      env.CONTROL_DB.prepare(
        "INSERT INTO workspaces(id, slug, durable_object_id, name, jurisdiction, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind("workspace-b", "beta", "do-b", "Beta", "eu", 1, 1),
      env.CONTROL_DB.prepare(
        "INSERT INTO memberships(member_id, workspace_id, account_id, role, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind("member-alpha", "workspace-a", "account-1", "owner", "active", 1, 1, 1),
      env.CONTROL_DB.prepare(
        "INSERT INTO memberships(member_id, workspace_id, account_id, role, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind("member-beta", "workspace-b", "account-1", "owner", "active", 1, 1, 1),
    ]);

    const memberships = await env.CONTROL_DB.prepare(
      "SELECT workspace_id, member_id FROM memberships WHERE account_id = ? ORDER BY workspace_id",
    )
      .bind("account-1")
      .all<{ workspace_id: string; member_id: string }>();

    expect(memberships.results).toEqual([
      { workspace_id: "workspace-a", member_id: "member-alpha" },
      { workspace_id: "workspace-b", member_id: "member-beta" },
    ]);
    expect(new Set(memberships.results.map(({ member_id }) => member_id)).size).toBe(2);
  });
});

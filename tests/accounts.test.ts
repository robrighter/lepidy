import { env } from "cloudflare:workers";
import { applyD1Migrations, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import type { Accounts } from "../src/cloudflare/accounts";
import { ACCOUNTS_OBJECT_NAME } from "../src/cloudflare/accounts-address";

describe("control-plane account object", () => {
  beforeAll(async () => {
    await applyD1Migrations(env.CONTROL_DB, env.TEST_CONTROL_MIGRATIONS);
  });

  const accounts = () => env.ACCOUNTS.getByName(ACCOUNTS_OBJECT_NAME);

  it("ACCOUNT-INT-001 signs a new account up into a workspace that has somewhere to talk", async () => {
    const result = await accounts().signUpWithWorkspace({
      email: "starter@example.test",
      password: "correct horse battery staple",
      displayName: "Ada Lovelace",
      handle: "ada",
      workspaceName: "Starter Workspace",
      workspaceSlug: "starter-workspace",
      jurisdiction: "global",
      storageMode: "cloud",
    });
    expect(result.accountId).toMatch(/^[0-9a-f-]{36}$/);

    const row = await env.CONTROL_DB.prepare(
      "SELECT w.durable_object_id, m.member_id FROM workspaces w JOIN memberships m ON m.workspace_id = w.id WHERE w.id = ?",
    )
      .bind(result.workspaceId)
      .first<{ durable_object_id: string; member_id: string }>();
    expect(row).not.toBeNull();

    const workspace = env.WORKSPACE.get(env.WORKSPACE.idFromString(row!.durable_object_id));
    const browsed = await workspace.browseChannels({
      actor: { memberId: row!.member_id, authorizationEpoch: 1 },
    });
    // A workspace with nowhere to talk is not a workspace.
    expect(browsed.channels).toHaveLength(1);
    expect(browsed.channels[0]).toMatchObject({ slug: "general", kind: "public", isMember: true });
  });

  it("ACCOUNT-INT-002 tells an unknown address and a wrong password apart from nobody", async () => {
    await accounts().signUpWithWorkspace({
      email: "known@example.test",
      password: "correct horse battery staple",
      displayName: "Grace Hopper",
      handle: "grace",
      workspaceName: "Known Workspace",
      workspaceSlug: "known-workspace",
      jurisdiction: "global",
      storageMode: "cloud",
    });

    await expect(
      accounts().authenticatePassword("known@example.test", "correct horse battery staple"),
    ).resolves.toMatch(/^[0-9a-f-]{36}$/);
    // Both failures answer the same way, which is the whole point.
    await expect(
      accounts().authenticatePassword("known@example.test", "wrong password entirely"),
    ).resolves.toBeNull();
    await expect(
      accounts().authenticatePassword("unknown@example.test", "correct horse battery staple"),
    ).resolves.toBeNull();
    // The address is normalised, so case is not a second account.
    await expect(
      accounts().authenticatePassword("KNOWN@Example.TEST", "correct horse battery staple"),
    ).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });

  it("ACCOUNT-INT-003 refuses a second account on the same address", async () => {
    const input = {
      email: "duplicate@example.test",
      password: "correct horse battery staple",
      displayName: "Alan Turing",
      handle: "alan",
      workspaceName: "First Workspace",
      workspaceSlug: "first-workspace",
      jurisdiction: "global" as const,
      storageMode: "cloud" as const,
    };
    await accounts().signUpWithWorkspace(input);
    // Asserted against the instance: a rejecting stub call is reported as an
    // unhandled rejection by the Workers test harness itself.
    await runInDurableObject<Accounts, void>(accounts(), async (instance) => {
      await expect(
        instance.signUpWithWorkspace({ ...input, handle: "alan2", workspaceSlug: "second-workspace" }),
      ).rejects.toThrow(/UNIQUE constraint failed/);
    });
  });
});

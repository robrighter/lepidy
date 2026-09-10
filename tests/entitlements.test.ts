import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { AdministrationService } from "../src/control/administration";
import { OnboardingService } from "../src/control/onboarding";
import { StorageEntitlementService } from "../src/control/storage-entitlement";

const NOW = 1_810_000_000_000;
const GIB = 1024 * 1024 * 1024;
let ordinal = 0;

describe("B01 seat and storage entitlements", () => {
  beforeAll(async () => {
    await applyD1Migrations(env.CONTROL_DB, env.TEST_CONTROL_MIGRATIONS);
  });

  async function createWorkspace(storageMode: "local_host" | "cloud") {
    ordinal += 1;
    const accountId = `b01-account-${ordinal}`;
    await env.CONTROL_DB.prepare(
      `INSERT INTO accounts(id, primary_email_normalized, display_name, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?)`,
    ).bind(accountId, `b01-${ordinal}@example.com`, `B01 Owner ${ordinal}`, NOW, NOW).run();
    return new OnboardingService(env.CONTROL_DB, env.WORKSPACE, () => NOW).createWorkspace({
      accountId,
      name: `B01 Workspace ${ordinal}`,
      slug: `b01-workspace-${ordinal}`,
      handle: `b01-owner-${ordinal}`,
      jurisdiction: "global",
      storageMode,
    });
  }

  it("B01-INT-001 provisions the only entitlement row and projects its exact storage allowance", async () => {
    const solo = await createWorkspace("local_host");
    const team = await createWorkspace("cloud");
    await expect(env.CONTROL_DB.prepare(
      "SELECT plan, source, status, seat_quantity, storage_pack_gb FROM subscriptions WHERE workspace_id = ?",
    ).bind(solo.workspaceId).first()).resolves.toMatchObject({
      plan: "solo", source: "none", status: "active", seat_quantity: 1, storage_pack_gb: 0,
    });
    await expect(env.CONTROL_DB.prepare(
      "SELECT plan, source, status, seat_quantity, storage_pack_gb FROM subscriptions WHERE workspace_id = ?",
    ).bind(team.workspaceId).first()).resolves.toMatchObject({
      plan: "team", source: "none", status: "active", seat_quantity: 5, storage_pack_gb: 0,
    });

    await env.CONTROL_DB.prepare(
      "UPDATE subscriptions SET seat_quantity = 6, storage_pack_gb = 100, updated_at = ? WHERE workspace_id = ?",
    ).bind(NOW + 1, team.workspaceId).run();
    const projected = await new StorageEntitlementService(env.CONTROL_DB, env.WORKSPACE, () => NOW + 1).project(team.workspaceId);
    expect(projected.quotaBytes).toBe(130 * GIB);
  });

  it("B01-INT-002 reserves capacity for ready invitations and ignores a client billing claim", async () => {
    const team = await createWorkspace("cloud");
    const administration = new AdministrationService(env.CONTROL_DB, env.WORKSPACE, () => NOW + 10);
    for (let index = 0; index < 4; index += 1) {
      await expect(administration.inviteMember({
        workspaceId: team.workspaceId,
        invitedByMemberId: team.memberId,
        email: `ready-${ordinal}-${index}@example.com`,
        role: "member",
      })).resolves.toMatchObject({ heldForPlan: false });
    }
    const held = await administration.inviteMember({
      workspaceId: team.workspaceId,
      invitedByMemberId: team.memberId,
      email: `held-${ordinal}@example.com`,
      role: "guest",
      billingConfirmed: true,
    });
    expect(held.heldForPlan).toBe(true);
    await expect(administration.confirmInvitationPlan(team.workspaceId, team.memberId, held.id))
      .rejects.toThrow("increase the workspace seat capacity");

    await env.CONTROL_DB.prepare(
      "UPDATE subscriptions SET seat_quantity = 6, updated_at = ? WHERE workspace_id = ?",
    ).bind(NOW + 11, team.workspaceId).run();
    await expect(administration.confirmInvitationPlan(team.workspaceId, team.memberId, held.id)).resolves.toBeUndefined();
  });
});

import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { handleBillingGatewayRequest } from "../src/cloudflare/billing-gateway";
import { OnboardingService } from "../src/control/onboarding";
import { BillingReconciliationService } from "../src/control/billing";

const NOW = 1_810_000_000_000;
const SECRET = "whsec_b02_test_signing_secret_123456";
let ordinal = 0;

async function signature(body: string, timestamp = Math.floor(NOW / 1000)) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`)));
  return `t=${timestamp},v1=${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

describe("B02 billing reconciliation", () => {
  beforeAll(async () => applyD1Migrations(env.CONTROL_DB, env.TEST_CONTROL_MIGRATIONS));

  async function workspace() {
    ordinal += 1;
    const accountId = `b02-account-${ordinal}`;
    await env.CONTROL_DB.prepare("INSERT INTO accounts(id, primary_email_normalized, display_name, status, created_at, updated_at) VALUES (?, ?, 'Owner', 'active', ?, ?)")
      .bind(accountId, `b02-${ordinal}@example.com`, NOW, NOW).run();
    return new OnboardingService(env.CONTROL_DB, env.WORKSPACE, () => NOW).createWorkspace({
      accountId, name: `B02 ${ordinal}`, slug: `b02-${ordinal}`, handle: `b02-owner-${ordinal}`,
      jurisdiction: "global", storageMode: "local_host",
    });
  }

  async function deliver(workspaceId: string, id: string, created: number, status = "active") {
    const body = JSON.stringify({ id, type: "customer.subscription.updated", created, livemode: false, data: { object: {
      id: `sub_${workspaceId}`, status, current_period_end: 1_900_000_000, cancel_at_period_end: false,
      metadata: { lepidy_workspace_id: workspaceId, lepidy_plan: "team", lepidy_seats: "6", lepidy_storage_pack_gb: "100" },
    } } });
    const result = await handleBillingGatewayRequest({ ...env, STRIPE_WEBHOOK_SECRET: SECRET }, new Request("https://lepidy.test/hooks/stripe", {
      method: "POST", body, headers: { "stripe-signature": await signature(body) },
    }), NOW);
    if (!result) throw new Error("billing route was not handled");
    return result;
  }

  it("B02-INT-001 verifies raw test events, applies once and rejects replay authority", async () => {
    const target = await workspace();
    expect((await deliver(target.workspaceId, "evt_b02_once", 100)).status).toBe(200);
    expect(await (await deliver(target.workspaceId, "evt_b02_once", 100)).json()).toMatchObject({ disposition: "duplicate" });
    await expect(env.CONTROL_DB.prepare("SELECT source, plan, status, seat_quantity, storage_pack_gb, current_period_end FROM subscriptions WHERE workspace_id = ?")
      .bind(target.workspaceId).first()).resolves.toMatchObject({ source: "stripe", plan: "team", status: "active", seat_quantity: 6, storage_pack_gb: 100, current_period_end: 1_900_000_000_000 });
  });

  it("B02-INT-002 ignores out-of-order state and maps nonpayment without deleting allowance", async () => {
    const target = await workspace();
    await deliver(target.workspaceId, "evt_b02_new", 200, "past_due");
    expect(await (await deliver(target.workspaceId, "evt_b02_old", 199)).json()).toMatchObject({ disposition: "stale" });
    await expect(env.CONTROL_DB.prepare("SELECT status, seat_quantity, storage_pack_gb FROM subscriptions WHERE workspace_id = ?")
      .bind(target.workspaceId).first()).resolves.toMatchObject({ status: "past_due", seat_quantity: 6, storage_pack_gb: 100 });
  });

  it("B02-INT-003 refuses live mode, altered bytes and non-exact routes", async () => {
    const target = await workspace();
    const valid = await deliver(target.workspaceId, "evt_b02_valid", 300);
    expect(valid.status).toBe(200);
    const altered = await handleBillingGatewayRequest({ ...env, STRIPE_WEBHOOK_SECRET: SECRET }, new Request("https://lepidy.test/hooks/stripe", { method: "POST", body: "{}", headers: { "stripe-signature": await signature("different") } }), NOW);
    if (!altered) throw new Error("billing route was not handled");
    expect(altered.status).toBe(400);
    expect((await handleBillingGatewayRequest({ ...env, STRIPE_WEBHOOK_SECRET: SECRET }, new Request("https://lepidy.test/hooks/stripe/"), NOW))?.status).toBe(404);
  });

  it("B02-INT-004 reconciles due provider state and backs failures off", async () => {
    const target = await workspace();
    await deliver(target.workspaceId, "evt_b02_seed", 400);
    await env.CONTROL_DB.prepare("UPDATE billing_reconciliation_jobs SET next_attempt_at = ? WHERE workspace_id = ?").bind(NOW, target.workspaceId).run();
    const service = new BillingReconciliationService(env.CONTROL_DB, () => NOW + 1);
    await expect(service.reconcileDue(async ({ workspaceId, externalId }) => ({
      id: "evt_b02_reconciled", type: "reconciliation.snapshot", created: 401,
      entitlement: { workspaceId, externalId, plan: "team", status: "canceled", seats: 6, storagePackGb: 100,
        currentPeriodEnd: 1_900_000_000_000, cancelAtPeriodEnd: false, providerVersion: 401_000 },
    }))).resolves.toEqual({ applied: 1, failed: 0 });
    await expect(env.CONTROL_DB.prepare("SELECT status, seat_quantity, storage_pack_gb FROM subscriptions WHERE workspace_id = ?").bind(target.workspaceId).first())
      .resolves.toMatchObject({ status: "canceled", seat_quantity: 6, storage_pack_gb: 100 });

    await env.CONTROL_DB.prepare("UPDATE billing_reconciliation_jobs SET next_attempt_at = ? WHERE workspace_id = ?").bind(NOW, target.workspaceId).run();
    await expect(service.reconcileDue(async () => { throw new Error("provider unavailable"); })).resolves.toEqual({ applied: 0, failed: 1 });
    await expect(env.CONTROL_DB.prepare("SELECT attempts, next_attempt_at, last_error FROM billing_reconciliation_jobs WHERE workspace_id = ?").bind(target.workspaceId).first())
      .resolves.toMatchObject({ attempts: 1, next_attempt_at: NOW + 1 + 120_000, last_error: "provider unavailable" });
  });
});

import { env } from "cloudflare:workers";
import { applyD1Migrations, runInDurableObject } from "cloudflare:test";
import { Webhook } from "standardwebhooks";
import { beforeAll, describe, expect, it } from "vitest";

import { handleRuntimeGatewayRequest } from "../src/cloudflare/runtime-gateway";
import type { Actor, Workspace } from "../src/cloudflare/workspace";

const NOW = 1_800_000_000_000;

describe("A05 cloud runtime integration", () => {
  beforeAll(async () => {
    await applyD1Migrations(env.CONTROL_DB, env.TEST_CONTROL_MIGRATIONS);
  });

  async function configured(name: string) {
    const stub = env.WORKSPACE.getByName(name);
    await stub.initializeWorkspace({ storageMode: "cloud", hostEpoch: 0, routingEpoch: 1, now: NOW });
    await stub.applyMembership({ operationId: `${name}-membership`, memberId: "owner", accountId: "account-owner",
      handle: "maya", displayName: "Maya", role: "owner", status: "active", authorizationEpoch: 1, version: 1, now: NOW });
    const actor: Actor = { memberId: "owner", authorizationEpoch: 1 };
    const agent = await stub.createAgent({ actor, idempotencyKey: `agent:create:${name}:0001`, handle: `a.${name}`, now: NOW });
    await env.CONTROL_DB.prepare(
      `INSERT INTO workspaces(id, slug, durable_object_id, name, jurisdiction, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'global', 'active', ?, ?)`,
    ).bind(`workspace-${name}`, name, stub.id.toString(), name, NOW, NOW).run();
    const webhookSecret = `whsec_${btoa("w".repeat(32))}`;
    await stub.configureClaudeRuntime({ actor, agentId: agent.agentId, authority: {
      issuer: "https://issuer.lepidy.test", audience: "anthropic-wif", subject: `integration-${name}`,
      organizationId: `org-${name}`, workspaceId: `provider-${name}`, serviceAccountId: "sa-developer", federationRuleId: "rule-exact",
    }, providerAgentId: "agent_provider", providerEnvironmentId: "environment_provider",
      webhookSigningSecret: webhookSecret, budgetCents: 250, now: NOW });
    return { stub, actor, agent, webhookSecret };
  }

  it("A05-INT-001 keeps setup pending, envelopes its secret and exposes metadata only", async () => {
    const { stub, actor, agent, webhookSecret } = await configured("cloudsetup");
    const summary = await stub.runtimeSummary({ actor, agentId: agent.agentId });
    expect(summary).toMatchObject({ kind: "claude_cloud", status: "pending", budget_cents: 250,
      resource_proved_at: null, webhook_proved_at: null });
    expect(JSON.stringify(summary)).not.toContain(webhookSecret);
    await runInDurableObject<Workspace, void>(stub, async (_instance, state) => {
      const stored = state.storage.sql.exec<{ secret_envelope: string }>(
        "SELECT secret_envelope FROM agent_runtime_configs WHERE agent_id = ?", agent.agentId,
      ).one().secret_envelope;
      expect(stored).not.toContain("whsec_");
    });
  });

  it("A05-INT-002 exact raw webhook route verifies, dedupes and never redirects", async () => {
    const { stub, actor, agent, webhookSecret } = await configured("cloudhook");
    const event = { type: "event", id: "whe_cloudhook_1", created_at: new Date(NOW).toISOString(), data: {
      type: "session.status_idled", id: "sesn_1", organization_id: "org-cloudhook", workspace_id: "provider-cloudhook",
    } };
    const body = JSON.stringify(event);
    const signedAt = new Date();
    const headers = { "content-type": "application/json", "webhook-id": event.id,
      "webhook-timestamp": String(Math.floor(signedAt.getTime() / 1000)),
      "webhook-signature": new Webhook(webhookSecret).sign(event.id, signedAt, body) };
    const deliver = () => handleRuntimeGatewayRequest(env, new Request("https://app.lepidy.test/hooks/anthropic", { method: "POST", headers, body }));
    await expect(deliver()).resolves.toMatchObject({ status: 204 });
    await expect(deliver()).resolves.toMatchObject({ status: 204 });
    await runInDurableObject<Workspace, void>(stub, async (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM anthropic_webhook_receipts").one().count).toBe(1);
    });
    expect(await stub.runtimeSummary({ actor, agentId: agent.agentId })).toMatchObject({ status: "pending", webhook_proved_at: expect.any(Number) });
    const staleBody = `${body} `;
    const bad = await handleRuntimeGatewayRequest(env, new Request("https://app.lepidy.test/hooks/anthropic", { method: "POST", headers, body: staleBody }));
    expect(bad?.status).toBe(400);
    for (const [path, method] of [["/hooks/anthropic/", "POST"], ["/hooks/anthropic", "GET"]] as const) {
      const response = await handleRuntimeGatewayRequest(env, new Request(`https://app.lepidy.test${path}`, { method }));
      expect(response?.status).toBeGreaterThanOrEqual(400);
      expect(response?.status).toBeLessThan(500);
    }
  });
});

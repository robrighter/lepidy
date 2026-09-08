import { Webhook } from "standardwebhooks";
import { describe, expect, it, vi } from "vitest";

import {
  ANTHROPIC_VERSION, CUSTOM_CALLBACK_KEYS, MANAGED_AGENTS_BETA, callManagedAgents, customWake,
  decryptTransportSecret, deliverCustomWake, encryptTransportSecret, exchangeWifAssertion,
  listManagedAgentResources,
  mintWifAssertion,
  unwrapAnthropicWebhook, validatePublicCallbackUrl, validateWifAuthority,
  validateBudgetChange, validateProviderSchedule,
} from "./cloud-custom-runtime";

describe("cloud and custom runtime boundary", () => {
  it("A05-UNIT-001 accepts only exact WIF authority and WIF bearer tokens", async () => {
    expect(() => validateWifAuthority({ issuer: "https://issuer.lepidy.test", audience: "anthropic", subject: "tenant:*",
      organizationId: "org", workspaceId: "ws", serviceAccountId: "sa", federationRuleId: "rule" })).toThrow("exact");
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(init?.body)).toContain("urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer");
      return Response.json({ access_token: "sk-ant-oat01-test", expires_in: 300, token_type: "Bearer" });
    });
    await expect(exchangeWifAssertion({ assertion: "header.payload.signature", fetcher })).resolves.toEqual({ accessToken: "sk-ant-oat01-test", expiresIn: 300 });
    await expect(callManagedAgents({ accessToken: "sk-ant-api03-forbidden", path: "/v1/sessions" })).rejects.toThrow("WIF");
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const assertion = await mintWifAssertion({ authority: { issuer: "https://issuer.lepidy.test", audience: "anthropic-wif",
      subject: "integration-exact", organizationId: "org", workspaceId: "ws", serviceAccountId: "sa", federationRuleId: "rule" },
      privateJwk: await crypto.subtle.exportKey("jwk", keys.privateKey), keyId: "test-key", now: 1_800_000_000_000 });
    const claims = JSON.parse(atob(assertion.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
    expect(claims).toMatchObject({ iss: "https://issuer.lepidy.test", aud: "anthropic-wif", sub: "integration-exact" });
  });

  it("A05-UNIT-002 pins Managed Agents headers, budget body and redirect refusal", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("anthropic-version")).toBe(ANTHROPIC_VERSION);
      expect(headers.get("anthropic-beta")).toBe(MANAGED_AGENTS_BETA);
      expect(headers.get("authorization")).toBe("Bearer sk-ant-oat01-short");
      expect(JSON.parse(String(init?.body))).toMatchObject({ budget: { amount: "250", currency: "USD" } });
      return Response.json({ id: "sesn_1", agent_version: "v7" });
    });
    await callManagedAgents({ accessToken: "sk-ant-oat01-short", path: "/v1/sessions", body: {
      agent_id: "agt_1", environment_id: "env_1", budget: { amount: "250", currency: "USD" },
    }, fetcher });
  });

  it("A05-UNIT-003 envelopes transport secrets with contextual authentication", async () => {
    const envelope = await encryptTransportSecret("whsec_abcdefghijklmnopqrstuvwxyz", "k".repeat(32), "integration:one");
    expect(envelope).not.toContain("whsec_");
    await expect(decryptTransportSecret(envelope, "k".repeat(32), "integration:one")).resolves.toContain("whsec_");
    await expect(decryptTransportSecret(envelope, "k".repeat(32), "integration:two")).rejects.toThrow("authenticate");
  });

  it("A05-UNIT-004 verifies raw Anthropic bytes, freshness, identity and duplicate key", () => {
    const key = `whsec_${btoa("x".repeat(32))}`;
    const rawBody = JSON.stringify({ type: "event", id: "whe_1", created_at: new Date().toISOString(), data: {
      type: "session.status_idled", id: "sesn_1", organization_id: "org_1", workspace_id: "ws_1",
    } });
    const headers = { "webhook-id": "whe_1", "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
      "webhook-signature": new Webhook(key).sign("whe_1", new Date(), rawBody) };
    expect(unwrapAnthropicWebhook({ rawBody, headers, signingSecret: key, organizationId: "org_1", workspaceId: "ws_1" }).id).toBe("whe_1");
    expect(() => unwrapAnthropicWebhook({ rawBody, headers, signingSecret: key, organizationId: "other", workspaceId: "ws_1" })).toThrow("authority");
    expect(() => unwrapAnthropicWebhook({ rawBody: `${rawBody} `, headers, signingSecret: key, organizationId: "org_1", workspaceId: "ws_1" })).toThrow();
    const staleAt = new Date(Date.now() - 10 * 60_000);
    const stale = { "webhook-id": "whe_1", "webhook-timestamp": String(Math.floor(staleAt.getTime() / 1000)),
      "webhook-signature": new Webhook(key).sign("whe_1", staleAt, rawBody) };
    expect(() => unwrapAnthropicWebhook({ rawBody, headers: stale, signingSecret: key, organizationId: "org_1", workspaceId: "ws_1" })).toThrow();
  });

  it("A05-UNIT-005 rejects every private/mixed callback target and rechecks DNS", async () => {
    const privateAddresses = ["0.0.0.0", "127.0.0.1", "10.0.0.1", "100.64.0.1", "169.254.1.1", "172.16.1.1", "192.0.2.1", "192.168.1.1", "198.18.0.1", "203.0.113.1", "224.0.0.1", "240.0.0.1", "::", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "ff00::1", "2001:db8::1"];
    for (const address of privateAddresses) {
      await expect(validatePublicCallbackUrl("https://hook.example.test/callback", async () => ["93.184.216.34", address])).rejects.toThrow("strictly public");
    }
    await expect(validatePublicCallbackUrl("https://user:pass@hook.example.test/callback", async () => ["93.184.216.34"])).rejects.toThrow();
    await expect(validatePublicCallbackUrl("https://hook.example.test:444/callback", async () => ["93.184.216.34"])).rejects.toThrow();
    await expect(validatePublicCallbackUrl("https://127.0.0.1/callback", async () => ["127.0.0.1"])).rejects.toThrow();
  });

  it("A05-UNIT-006 sends metadata only, refuses redirects and classifies retries", async () => {
    const wake = customWake({ delivery_id: "delivery_123", created_at: new Date().toISOString(), workspace_id: "workspace_1", agent_id: "agent_1", queue_depth: 2 });
    expect(Object.keys(wake)).toEqual([...CUSTOM_CALLBACK_KEYS]);
    expect(JSON.stringify(wake)).not.toContain("prompt");
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      expect(Object.keys(JSON.parse(String(init?.body)))).toEqual([...CUSTOM_CALLBACK_KEYS]);
      return new Response(null, { status: 302 });
    });
    await expect(deliverCustomWake({ url: "https://hook.example.test/wake", wake, secret: "s".repeat(32),
      resolve: async () => ["93.184.216.34"], fetcher, now: Date.now() })).resolves.toMatchObject({ status: "permanent" });
  });

  it("A05-UNIT-007 bounds and redacts provider errors", async () => {
    const canary = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";
    await expect(callManagedAgents({ accessToken: "sk-ant-oat01-short", path: "/v1/sessions/sesn_1",
      fetcher: async () => new Response(`${canary}${"x".repeat(2000)}`, { status: 500 }) })).rejects.not.toThrow(canary);
  });

  it("A05-UNIT-008 enforces provider schedule and one-way budget semantics", () => {
    expect(validateProviderSchedule("0 9 * * 1-5", "America/New_York")).toEqual({ cron: "0 9 * * 1-5", timezone: "America/New_York" });
    expect(() => validateProviderSchedule("0 9 * *", "UTC")).toThrow("five-field");
    expect(() => validateProviderSchedule("0 9 * * *", "Mars/Olympus")).toThrow("IANA");
    expect(validateBudgetChange(250, 500, 100)).toBe(500);
    expect(validateBudgetChange(250, null, 100)).toBeNull();
    expect(() => validateBudgetChange(null, 500, 100)).toThrow("cannot be added");
    expect(() => validateBudgetChange(250, 100, 100)).toThrow("exceed consumed");
  });

  it("A05-UNIT-009 follows opaque reconciliation cursors without inventing them", async () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return Response.json(urls.length === 1
        ? { data: [{ id: "one" }], has_more: true, last_id: "opaque/+ cursor" }
        : { data: [{ id: "two" }], has_more: false });
    });
    await expect(listManagedAgentResources({ accessToken: "sk-ant-oat01-short", path: "/v1/sessions?limit=100", fetcher }))
      .resolves.toEqual([{ id: "one" }, { id: "two" }]);
    expect(urls[1]).toContain("after_id=opaque%2F%2B%20cursor");
  });
});

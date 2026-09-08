import { describe, expect, it } from "vitest";

import { encodeVaultBytes } from "./vault-envelope";
import {
  normalizeVaultProxyRequest,
  openVaultProxyResponse,
  sealVaultProxyRequest,
  sealVaultProxyResponse,
} from "./vault-proxy";

describe("V06 device-mediated proxy envelope", () => {
  it("VAULT-PROXY-RULE-001 accepts only bounded HTTPS requests with safe caller headers", () => {
    expect(normalizeVaultProxyRequest({
      url: "https://api.example.test/v1", method: "post",
      headers: { Accept: "application/json", "Idempotency-Key": "operation-1" }, body: "{}",
    })).toEqual({
      url: "https://api.example.test/v1", method: "POST",
      headers: { accept: "application/json", "idempotency-key": "operation-1" }, body: "{}",
    });
    for (const request of [
      { url: "http://api.example.test", method: "GET" },
      { url: "https://127.0.0.1", method: "GET" },
      { url: "https://user@api.example.test", method: "GET" },
      { url: "https://api.example.test:444", method: "GET" },
      { url: "https://api.example.test", method: "TRACE" },
      { url: "https://api.example.test", method: "GET", headers: { authorization: "Bearer caller-secret" } },
      { url: "https://api.example.test", method: "DELETE", body: "not permitted" },
    ]) {
      expect(() => normalizeVaultProxyRequest(request)).toThrow();
    }
  });

  it("VAULT-PROXY-RULE-002 binds encrypted responses to one workspace and request", async () => {
    const responseKey = crypto.getRandomValues(new Uint8Array(32));
    const envelope = await sealVaultProxyResponse({
      workspaceId: "workspace-a", requestId: "request-a", responseKey,
      result: { status: 200, headers: { "content-type": "application/json" }, body: '{"ok":true}', truncated: false },
    });
    await expect(openVaultProxyResponse({
      workspaceId: "workspace-a", requestId: "request-a", responseKey, envelope,
    })).resolves.toEqual({
      status: 200, headers: { "content-type": "application/json" }, body: '{"ok":true}', truncated: false,
    });
    await expect(openVaultProxyResponse({
      workspaceId: "workspace-a", requestId: "request-b", responseKey, envelope,
    })).rejects.toThrow();
  });

  it("VAULT-PROXY-RULE-003 puts no request plaintext in the release-device frame", async () => {
    const recipient = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"],
    );
    const publicKey = encodeVaultBytes(new Uint8Array(await crypto.subtle.exportKey("raw", recipient.publicKey)));
    const relay = await sealVaultProxyRequest({
      workspaceId: "workspace-a", requestId: "request-a", recipientPublicKey: publicKey,
      responseKey: crypto.getRandomValues(new Uint8Array(32)),
      request: {
        url: "https://api.example.test/private-path", method: "POST",
        headers: { accept: "application/json" }, body: "request-plaintext-canary",
      },
    });
    expect(JSON.stringify(relay)).not.toContain("private-path");
    expect(JSON.stringify(relay)).not.toContain("request-plaintext-canary");
    expect(relay.ciphertext.length).toBeGreaterThan(100);
  });
});

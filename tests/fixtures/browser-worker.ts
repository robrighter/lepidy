// Local browser harness only. Production's custom-worker.ts never imports this file.
import worker from "../../custom-worker";
import { Workspace as ProductionWorkspace } from "../../src/cloudflare/workspace";
import { AuthorizationService } from "../../src/control/authorization";
import { resolveViewerWorkspace } from "../../src/shell/workspace-shell-source";
import { encryptVaultValue } from "../../src/domain/vault-client-crypto";
import { encodeVaultBytes } from "../../src/domain/vault-envelope";
export { Accounts } from "../../src/cloudflare/accounts";

export class Workspace extends ProductionWorkspace {
  async browserCounts() {
    const counts: Record<string, number> = {};
    for (const table of ["messages", "message_mentions", "message_reactions", "pending_events", "replay_events", "audit_events", "idempotency_keys"]) {
      counts[table] = this.ctx.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`).one().count;
    }
    return counts;
  }
  /** Bulk history for pagination scenarios, written through the real authority. */
  async seedBulkHistory(actor: { memberId: string; authorizationEpoch: number }, slug: string, count: number) {
    const now = Date.now();
    const channel = await this.createChannel({ actor, idempotencyKey: `browser-bulk:${slug}`, kind: "public", slug, name: slug, now });
    for (let index = 0; index < count; index += 1) {
      await this.sendMessage({ actor, channelId: channel.channelId, idempotencyKey: `browser-bulk:${slug}:${index}`, bodyMarkdown: `paged message ${index}`, now: now + index });
    }
    return { channelId: channel.channelId };
  }
  async seedBrowserHistory(actor: { memberId: string; authorizationEpoch: number }) {
    const now = Date.now();
    const rooms = [];
    for (const slug of ["eng", "release"]) {
      rooms.push(await this.createChannel({ actor, idempotencyKey: `browser-fixture:${slug}`, kind: "public", slug, name: slug, now }));
    }
    const channelId = rooms[0].channelId;
    const first = await this.sendMessage({ actor, channelId, idempotencyKey: "browser-fixture:first", bodyMarkdown: "Rolling the failed-charge retry out behind a flag this afternoon.", now });
    await this.sendMessage({ actor, channelId, idempotencyKey: "browser-fixture:reply1", bodyMarkdown: "First reply", threadParentId: first.messageId, now });
    await this.sendMessage({ actor, channelId, idempotencyKey: "browser-fixture:reply2", bodyMarkdown: "Second reply", threadParentId: first.messageId, now });
    const agent = await this.sendMessage({ actor, channelId, idempotencyKey: "browser-fixture:agent", bodyMarkdown: "Released `api@2.14.0` with **no rollbacks**. @maya\n\n```sh\nwrangler deploy --env production\n```", now });
    // Agent posting has no public transport until A01/A03. Seed its persisted
    // attribution only; all browser reads still use the production authority.
    this.ctx.storage.sql.exec("INSERT INTO agents(id, handle, display_name, created_at, updated_at) VALUES ('fixture-agent', 'a.releasebot', 'Release Bot', ?, ?)", now, now);
    this.ctx.storage.sql.exec("UPDATE messages SET author_kind = 'agent', author_id = 'fixture-agent', author_display_snapshot = 'a.releasebot' WHERE id = ?", agent.messageId);
    await this.reactToMessage({ actor, messageId: first.messageId, emoji: "👀", now });
  }

  async seedDelegatedSession(actor: { memberId: string; authorizationEpoch: number }) {
    const now = Date.now();
    const allowed = await this.createChannel({ actor, idempotencyKey: `browser-session:allowed:${now}`, kind: "public", slug: `delegated-${String(now).slice(-6)}`, now });
    const outside = await this.createChannel({ actor, idempotencyKey: `browser-session:outside:${now}`, kind: "public", slug: `outside-${String(now).slice(-6)}`, now });
    const agent = await this.createAgent({ actor, idempotencyKey: `browser-session:agent:${now}`, handle: `runner${String(now).slice(-6)}`, now });
    const root = await this.sendMessage({ actor, channelId: allowed.channelId, idempotencyKey: `browser-session:root:${now}`, bodyMarkdown: "Delegated session root", now });
    const delegation = await this.createAgentDelegation({ actor, agent: agent.agentId, channelIds: [allowed.channelId], expiresAt: now + 60 * 60 * 1000, now });
    const session = await this.startAgentSession({
      actor,
      delegationId: delegation.id,
      deviceId: "browser-runner-device",
      runnerEpoch: 1,
      presetRevision: 1,
      capabilities: ["whoami", "list_channels", "read_channel", "read_thread", "list_agents", "agent_post"],
      now,
    });
    return { token: session.token, sessionId: session.sessionId, delegationId: delegation.id, agentId: agent.agentId, agentHandle: agent.handle, allowedChannelId: allowed.channelId, outsideChannelId: outside.channelId, rootMessageId: root.messageId };
  }

  async seedBrowserVault(actor: { memberId: string; authorizationEpoch: number }) {
    const now = Date.now();
    const credentialId = "browser-vault-credential";
    const encrypted = await encryptVaultValue({ workspaceId: this.ctx.id.toString(), credentialId, version: 1, keyEpoch: 1, plaintext: new TextEncoder().encode("browser-vault-plaintext-canary") });
    await this.createVaultCredential({
      actor, idempotencyKey: "browser:vault:create:000001", credentialId,
      metadata: { name: "BROWSER_TEST_TOKEN", description: "Browser vault test", envVar: "BROWSER_TOKEN", tags: ["browser"], commands: ["browser-tool"], proxyHosts: ["api.example.test"] },
      policy: { mode: "ask", allowedDeliveries: ["inject"], projectIds: [], highRisk: true },
      envelope: encrypted.envelope,
      wraps: [{ custodianMemberId: actor.memberId, recipientKeyEpoch: 1, wrapSuite: "P256-HKDF-SHA256-AES256GCM", ephemeralPublicKey: encodeVaultBytes(new Uint8Array(65).fill(1)), iv: encodeVaultBytes(new Uint8Array(12).fill(2)), wrappedDek: encodeVaultBytes(new Uint8Array(48).fill(3)) }],
      acl: [{ subjectType: "member", subjectId: actor.memberId, verb: "manage" }, { subjectType: "member", subjectId: actor.memberId, verb: "use" }],
      freshUserVerification: true, localVaultUnlocked: true, now,
    });
    return { credentialId };
  }
}

export default {
  // Deterministic local delivery sink; scheduler delivery itself is covered by the Worker suite.
  async queue(batch: MessageBatch) { batch.ackAll(); },
  async fetch(request: Request, env: CloudflareEnv, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/__fixture/counts") {
      const counts: Record<string, number> = {};
      for (const table of ["accounts", "sessions", "workspaces", "memberships", "auth_challenges"]) {
        const row = await env.CONTROL_DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>();
        counts[table] = row!.count;
      }
      return Response.json(counts);
    }
    if (["/__fixture/seed", "/__fixture/bulk", "/__fixture/workspace-counts", "/__fixture/session-token", "/__fixture/vault"].includes(url.pathname) && request.method === "POST") {
      const authorization = new AuthorizationService(env.CONTROL_DB, env.WORKSPACE);
      const resolved = await resolveViewerWorkspace({ db: env.CONTROL_DB, workspaces: env.WORKSPACE, authenticateSession: (token) => authorization.authenticateBrowserSession(token) }, request.headers.get("authorization"));
      if (resolved.status !== "ok") return new Response("Unauthorized", { status: 401 });
      const stub = env.WORKSPACE.get(env.WORKSPACE.idFromString(resolved.row.durable_object_id)) as unknown as DurableObjectStub<Workspace>;
      if (url.pathname.endsWith("workspace-counts")) return Response.json(await stub.browserCounts());
      if (url.pathname.endsWith("session-token")) {
        return Response.json(await stub.seedDelegatedSession({ memberId: resolved.row.member_id, authorizationEpoch: resolved.row.authorization_epoch }));
      }
      if (url.pathname.endsWith("vault")) {
        return Response.json(await stub.seedBrowserVault({ memberId: resolved.row.member_id, authorizationEpoch: resolved.row.authorization_epoch }));
      }
      if (url.pathname.endsWith("bulk")) {
        const body = (await request.json()) as { slug: string; count: number };
        return Response.json(
          await stub.seedBulkHistory(
            { memberId: resolved.row.member_id, authorizationEpoch: resolved.row.authorization_epoch },
            body.slug,
            body.count,
          ),
        );
      }
      await stub.seedBrowserHistory({ memberId: resolved.row.member_id, authorizationEpoch: resolved.row.authorization_epoch });
      return Response.json({ ok: true });
    }
    return worker.fetch(request, env, ctx);
  },
};

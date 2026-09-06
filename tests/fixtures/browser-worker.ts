// Local browser harness only. Production's custom-worker.ts never imports this file.
import worker from "../../custom-worker";
import { Workspace as ProductionWorkspace } from "../../src/cloudflare/workspace";
import { AuthorizationService } from "../../src/control/authorization";
import { resolveViewerWorkspace } from "../../src/shell/workspace-shell-source";
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
    if (["/__fixture/seed", "/__fixture/bulk", "/__fixture/workspace-counts"].includes(url.pathname) && request.method === "POST") {
      const authorization = new AuthorizationService(env.CONTROL_DB, env.WORKSPACE);
      const resolved = await resolveViewerWorkspace({ db: env.CONTROL_DB, workspaces: env.WORKSPACE, authenticateSession: (token) => authorization.authenticateBrowserSession(token) }, request.headers.get("authorization"));
      if (resolved.status !== "ok") return new Response("Unauthorized", { status: 401 });
      const stub = env.WORKSPACE.get(env.WORKSPACE.idFromString(resolved.row.durable_object_id)) as unknown as DurableObjectStub<Workspace>;
      if (url.pathname.endsWith("workspace-counts")) return Response.json(await stub.browserCounts());
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

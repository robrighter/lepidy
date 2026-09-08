// Local browser harness only. Production's custom-worker.ts never imports this file.
import worker from "../../custom-worker";
import { Workspace as ProductionWorkspace } from "../../src/cloudflare/workspace";
import { AuthorizationService } from "../../src/control/authorization";
import { OnboardingService } from "../../src/control/onboarding";
import { SimpleWebAuthnPasskeyProvider } from "../../src/control/passkeys";
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

  async seedBrowserActivity(actor: { memberId: string; authorizationEpoch: number }) {
    const now = Date.now();
    const viewer = this.ctx.storage.sql.exec<{ handle: string }>("SELECT handle FROM members WHERE id = ?", actor.memberId).one();
    const senderId = `activity-sender-${crypto.randomUUID().slice(0, 8)}`;
    await this.applyMembership({
      operationId: `browser-activity:${senderId}`, memberId: senderId, accountId: `account-${senderId}`,
      handle: `sender${senderId.slice(-4)}`, displayName: "Grace Hopper", role: "member", status: "active",
      authorizationEpoch: 1, version: 1, now,
    });
    const channel = await this.createChannel({
      actor, idempotencyKey: `browser-activity:channel:${now}`, kind: "public", slug: `activity-${String(now).slice(-6)}`,
      name: "activity", memberIds: [senderId], now,
    });
    await this.sendMessage({
      actor: { memberId: senderId, authorizationEpoch: 1 }, idempotencyKey: `browser-activity:message:${now}`,
      channelId: channel.channelId, bodyMarkdown: `@${viewer.handle} please review the launch note`, now: now + 1,
    });
    return { channelId: channel.channelId };
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

  /**
   * A runner session that may actually drain a queue, plus work waiting in it.
   *
   * The delegated-session fixture above deliberately carries only read and post
   * capabilities; the waiting spike needs the queue tools as well, and it needs
   * mentions already enqueued so a harness has something to come back for.
   */
  async seedRunnerQueue(
    actor: { memberId: string; authorizationEpoch: number },
    mentions: number,
    credentialIds: readonly string[] = [],
  ) {
    const now = Date.now();
    const channel = await this.createChannel({ actor, idempotencyKey: `browser-wait:channel:${now}`, kind: "public", slug: `waiting-${String(now).slice(-6)}`, now });
    const agent = await this.createAgent({ actor, idempotencyKey: `browser-wait:agent:${now}`, handle: `waiter${String(now).slice(-6)}`, now });
    const delegation = await this.createAgentDelegation({
      actor,
      agent: agent.agentId,
      channelIds: [channel.channelId],
      credentialIds,
      deliveryModes: ["inject"],
      projectIds: ["cli-project"],
      expiresAt: now + 60 * 60 * 1000,
      now,
    });
    const session = await this.startAgentSession({
      actor,
      delegationId: delegation.id,
      deviceId: "browser-runner-device",
      runnerEpoch: 1,
      presetRevision: 1,
      capabilities: ["whoami", "read_channel", "read_thread", "agent_next", "agent_start", "agent_complete", "agent_post"],
      now,
    });
    const messageIds = await this.enqueueRunnerMentions(actor, channel.channelId, agent.handle, mentions, now);
    return {
      token: session.token, sessionId: session.sessionId, delegationId: delegation.id,
      agentId: agent.agentId, agentHandle: agent.handle, channelId: channel.channelId, messageIds,
    };
  }

  /** More work for a session that has already drained, as a lost wake would leave. */
  async enqueueRunnerMentions(
    actor: { memberId: string; authorizationEpoch: number },
    channelId: string,
    agentHandle: string,
    count: number,
    now = Date.now(),
  ) {
    const messageIds: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const sent = await this.sendMessage({
        actor, channelId, idempotencyKey: `browser-wait:mention:${now}:${index}:${crypto.randomUUID().slice(0, 8)}`,
        bodyMarkdown: `@${agentHandle} please answer question ${index}`, now: now + index,
      });
      messageIds.push(sent.messageId);
    }
    return messageIds;
  }

  /** Ending a delegation, so the spike can watch a live session learn it stopped. */
  async revokeRunnerDelegation(actor: { memberId: string; authorizationEpoch: number }, delegationId: string) {
    return this.revokeAgentDelegation({ actor, delegationId, now: Date.now() });
  }

  /**
   * A real channel and message for a device release to cite as its origin.
   *
   * The vault's policy requires verified provenance, so a CLI scenario needs an
   * origin that actually exists; this creates one through the production
   * authority rather than inventing ids the policy would refuse.
   */
  async seedDeviceOrigin(actor: { memberId: string; authorizationEpoch: number }) {
    const now = Date.now();
    const channel = await this.createChannel({ actor, idempotencyKey: `browser-device:${now}`, kind: "public", slug: `device-${String(now).slice(-6)}`, name: "device", now });
    const message = await this.sendMessage({ actor, channelId: channel.channelId, idempotencyKey: `browser-device:message:${now}`, bodyMarkdown: "Deploy with the release token.", now });
    return { channelId: channel.channelId, messageId: message.messageId };
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
    // Passkey enrolment has no production route yet — the registration UI is
    // F04/C07's remaining surface — but V03's approval step-up is a real
    // WebAuthn assertion, so the browser suite needs a real registered passkey
    // to make one with. This runs the production ceremony against the host the
    // request actually arrived on.
    if (url.pathname.startsWith("/__fixture/passkey/") && request.method === "POST") {
      const authorization = new AuthorizationService(env.CONTROL_DB, env.WORKSPACE);
      let accountId: string;
      try {
        ({ accountId } = await authorization.authenticateBrowserSession(request.headers.get("authorization") ?? ""));
      } catch {
        return new Response("Unauthorized", { status: 401 });
      }
      const host = new URL(request.url).host;
      const onboarding = new OnboardingService(
        env.CONTROL_DB,
        env.WORKSPACE,
        () => Date.now(),
        new SimpleWebAuthnPasskeyProvider(host.split(":")[0], [`http://${host}`]),
      );
      if (url.pathname.endsWith("/begin")) {
        return Response.json(
          await onboarding.beginPasskeyRegistration(accountId, {
            freshSession: true,
            stepUpVerified: true,
            confirmed: true,
          }),
        );
      }
      const body = (await request.json()) as { challengeId: string; response: unknown };
      return Response.json({
        credentialId: await onboarding.finishPasskeyRegistration({ accountId, ...body }),
      });
    }
    if (["/__fixture/seed", "/__fixture/activity", "/__fixture/bulk", "/__fixture/workspace-counts", "/__fixture/session-token", "/__fixture/vault", "/__fixture/device-origin", "/__fixture/runner-queue", "/__fixture/runner-enqueue", "/__fixture/runner-revoke"].includes(url.pathname) && request.method === "POST") {
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
      if (url.pathname.endsWith("runner-queue")) {
        const body = (await request.json()) as { mentions: number; credentialIds?: string[] };
        return Response.json(
          await stub.seedRunnerQueue(
            { memberId: resolved.row.member_id, authorizationEpoch: resolved.row.authorization_epoch },
            body.mentions,
            body.credentialIds ?? [],
          ),
        );
      }
      if (url.pathname.endsWith("runner-enqueue")) {
        const body = (await request.json()) as { channelId: string; agentHandle: string; count: number };
        return Response.json({
          messageIds: await stub.enqueueRunnerMentions(
            { memberId: resolved.row.member_id, authorizationEpoch: resolved.row.authorization_epoch },
            body.channelId, body.agentHandle, body.count,
          ),
        });
      }
      if (url.pathname.endsWith("runner-revoke")) {
        const body = (await request.json()) as { delegationId: string };
        return Response.json(await stub.revokeRunnerDelegation({ memberId: resolved.row.member_id, authorizationEpoch: resolved.row.authorization_epoch }, body.delegationId));
      }
      if (url.pathname.endsWith("device-origin")) {
        const actor = { memberId: resolved.row.member_id, authorizationEpoch: resolved.row.authorization_epoch };
        return Response.json({
          workspaceId: resolved.row.id,
          workspaceSlug: resolved.row.slug,
          memberId: resolved.row.member_id,
          authorizationEpoch: resolved.row.authorization_epoch,
          ...(await stub.seedDeviceOrigin(actor)),
        });
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
      if (url.pathname.endsWith("activity")) {
        return Response.json(await stub.seedBrowserActivity({ memberId: resolved.row.member_id, authorizationEpoch: resolved.row.authorization_epoch }));
      }
      await stub.seedBrowserHistory({ memberId: resolved.row.member_id, authorizationEpoch: resolved.row.authorization_epoch });
      return Response.json({ ok: true });
    }
    return worker.fetch(request, env, ctx);
  },
};

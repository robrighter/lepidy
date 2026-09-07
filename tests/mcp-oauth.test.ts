import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Actor, Workspace } from "../src/cloudflare/workspace";
import { base64url, formatToken, randomSecret, workspaceResourceUri } from "../src/domain/mcp-oauth";

const NOW = 1_800_000_000_000;
const ORIGIN = "https://lepidy.test";

type Seeded = {
  stub: DurableObjectStub<Workspace>;
  slug: string;
  resource: string;
  owner: Actor;
  member: Actor;
};

let workspaceOrdinal = 0;

async function seed(slug: string): Promise<Seeded> {
  const stub = env.WORKSPACE.getByName(slug);
  await stub.initializeWorkspace({
    storageMode: "cloud",
    hostEpoch: 0,
    routingEpoch: 1,
    workspaceSlug: slug,
    now: NOW,
  });
  const people: readonly [string, string, string, "owner" | "member"][] = [
    ["member-owner", "maya", "Maya Chen", "owner"],
    ["member-two", "daniel", "Daniel Park", "member"],
  ];
  for (const [memberId, handle, displayName, role] of people) {
    await stub.applyMembership({
      operationId: `${slug}-op-${memberId}`,
      memberId,
      accountId: `account-${slug}-${memberId}`,
      handle,
      displayName,
      role,
      status: "active",
      authorizationEpoch: 1,
      version: 1,
      now: NOW,
    });
  }
  return {
    stub,
    slug,
    resource: workspaceResourceUri(ORIGIN, slug),
    owner: { memberId: "member-owner", authorizationEpoch: 1 },
    member: { memberId: "member-two", authorizationEpoch: 1 },
  };
}

function freshWorkspace(): Promise<Seeded> {
  workspaceOrdinal += 1;
  return seed(`tenant-${workspaceOrdinal}`);
}

const VERIFIER = "verifier-".padEnd(64, "x");

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** The whole dance, from consent to a usable pair, as one helper. */
async function connect(
  seeded: Seeded,
  overrides: { actor?: Actor; scope?: string; clientId?: string; now?: number } = {},
) {
  const now = overrides.now ?? NOW;
  const clientId = overrides.clientId ?? "client-code";
  const codeChallenge = await challengeFor(VERIFIER);
  const authorized = await seeded.stub.beginOauthAuthorization({
    actor: overrides.actor ?? seeded.owner,
    workspaceSlug: seeded.slug,
    clientId,
    clientName: "Claude Code",
    redirectUri: "http://127.0.0.1:1234/callback",
    codeChallenge,
    scope: overrides.scope ?? "chat:read chat:write",
    resource: seeded.resource,
    now,
  });
  if (!authorized.ok) throw new Error(`authorization refused: ${authorized.description}`);

  const exchanged = await seeded.stub.exchangeOauthCode({
    workspaceSlug: seeded.slug,
    code: authorized.code,
    clientId,
    clientName: "Claude Code",
    redirectUri: "http://127.0.0.1:1234/callback",
    codeVerifier: VERIFIER,
    resource: seeded.resource,
    now,
  });
  if (!exchanged.ok) throw new Error(`exchange refused: ${exchanged.description}`);
  return { code: authorized.code, clientId, ...exchanged.grant };
}

function countRows(stub: DurableObjectStub<Workspace>, sql: string): Promise<number> {
  return runInDurableObject<Workspace, number>(stub, (_instance, state) =>
    state.storage.sql.exec<{ total: number }>(sql).one().total,
  );
}

type AuditRow = { event_type: string; requester_id: string | null; subject_id: string | null; metadata_json: string };

function auditRows(stub: DurableObjectStub<Workspace>): Promise<AuditRow[]> {
  return runInDurableObject<Workspace, AuditRow[]>(stub, (_instance, state) =>
    state.storage.sql
      .exec<AuditRow>(
        "SELECT event_type, requester_id, subject_id, metadata_json FROM audit_events ORDER BY sequence",
      )
      .toArray(),
  );
}

describe("MCP-INT-001 a connection is made by a member and acts as that member", () => {
  it("issues a pair a resource server accepts, carrying the agreed scope", async () => {
    const seeded = await freshWorkspace();
    const grant = await connect(seeded);

    expect(grant.accessToken.startsWith(`lpd_at_${seeded.slug}_`)).toBe(true);
    expect(grant.refreshToken.startsWith(`lpd_rt_${seeded.slug}_`)).toBe(true);
    expect(grant.expiresInSeconds).toBe(3600);
    expect(grant.scope).toBe("chat:read chat:write");

    const authenticated = await seeded.stub.authenticateOauthToken({
      accessToken: grant.accessToken,
      audience: seeded.resource,
      now: NOW + 1_000,
    });
    expect(authenticated.ok).toBe(true);
    if (!authenticated.ok) return;
    // The acting person is derived from the token and from nothing the caller
    // said about who they are.
    expect(authenticated.principal.memberId).toBe("member-owner");
    expect(authenticated.principal.handle).toBe("maya");
    expect(authenticated.principal.clientName).toBe("Claude Code");
  });

  it("records who agreed to what, and never the credential itself", async () => {
    const seeded = await freshWorkspace();
    const grant = await connect(seeded);

    const entries = await auditRows(seeded.stub);
    const authorized = entries.find((entry) => entry.event_type === "oauth.authorized");
    const connected = entries.find((entry) => entry.event_type === "oauth.connected");
    expect(authorized?.requester_id).toBe("member-owner");
    expect(connected?.subject_id).toBe(grant.connectionId);

    const serialised = JSON.stringify(entries);
    for (const secret of [grant.accessToken, grant.refreshToken, grant.code]) {
      expect(serialised.includes(secret)).toBe(false);
    }
  });
});

describe("MCP-INT-002 a code is single-use, short-lived and PKCE-bound", () => {
  it("refuses a second redemption of a code that already worked", async () => {
    const seeded = await freshWorkspace();
    const first = await connect(seeded);

    const replay = await seeded.stub.exchangeOauthCode({
      workspaceSlug: seeded.slug,
      code: first.code,
      clientId: first.clientId,
      clientName: "Claude Code",
      redirectUri: "http://127.0.0.1:1234/callback",
      codeVerifier: VERIFIER,
      resource: seeded.resource,
      now: NOW + 1,
    });
    expect(replay).toMatchObject({ ok: false, error: "invalid_grant" });
    // The refusal leaves no second connection behind.
    expect(await countRows(seeded.stub, "SELECT COUNT(*) AS total FROM oauth_connections")).toBe(1);
  });

  it("refuses a wrong verifier, a changed redirect, another client and an expired code", async () => {
    const seeded = await freshWorkspace();
    const codeChallenge = await challengeFor(VERIFIER);
    const base = {
      workspaceSlug: seeded.slug,
      clientId: "client-code",
      clientName: null,
      redirectUri: "http://127.0.0.1:1234/callback",
      codeVerifier: VERIFIER,
      resource: seeded.resource,
      now: NOW,
    };
    async function mint() {
      const authorized = await seeded.stub.beginOauthAuthorization({
        actor: seeded.owner,
        workspaceSlug: seeded.slug,
        clientId: "client-code",
        clientName: null,
        redirectUri: "http://127.0.0.1:1234/callback",
        codeChallenge,
        scope: "chat:read",
        resource: seeded.resource,
        now: NOW,
      });
      if (!authorized.ok) throw new Error("authorization refused");
      return authorized.code;
    }

    expect(
      await seeded.stub.exchangeOauthCode({ ...base, code: await mint(), codeVerifier: "b".repeat(64) }),
    ).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(
      await seeded.stub.exchangeOauthCode({
        ...base,
        code: await mint(),
        redirectUri: "http://127.0.0.1:1234/other",
      }),
    ).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(
      await seeded.stub.exchangeOauthCode({ ...base, code: await mint(), clientId: "client-other" }),
    ).toMatchObject({ ok: false, error: "invalid_client" });
    expect(
      await seeded.stub.exchangeOauthCode({ ...base, code: await mint(), now: NOW + 61_000 }),
    ).toMatchObject({ ok: false, error: "invalid_grant", description: "the code has expired" });

    // Four refusals, no connection anywhere.
    expect(await countRows(seeded.stub, "SELECT COUNT(*) AS total FROM oauth_connections")).toBe(0);

    // The paired allow case: the same shape, done right, still works.
    const good = await seeded.stub.exchangeOauthCode({ ...base, code: await mint() });
    expect(good.ok).toBe(true);
  });
});

describe("MCP-INT-003 refresh rotates, and a replayed rotation kills the connection", () => {
  it("issues a new pair and retires the old one", async () => {
    const seeded = await freshWorkspace();
    const first = await connect(seeded);

    const rotated = await seeded.stub.refreshOauthTokens({
      workspaceSlug: seeded.slug,
      refreshToken: first.refreshToken,
      clientId: first.clientId,
      now: NOW + 10_000,
    });
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;
    expect(rotated.grant.refreshToken).not.toBe(first.refreshToken);
    expect(rotated.grant.connectionId).toBe(first.connectionId);

    // The superseded access token stops working the moment it is replaced.
    expect(
      await seeded.stub.authenticateOauthToken({
        accessToken: first.accessToken,
        audience: seeded.resource,
        now: NOW + 10_001,
      }),
    ).toMatchObject({ ok: false, error: "invalid_token" });
    expect(
      await seeded.stub.authenticateOauthToken({
        accessToken: rotated.grant.accessToken,
        audience: seeded.resource,
        now: NOW + 10_001,
      }),
    ).toMatchObject({ ok: true });
  });

  it("treats a rotated refresh token presented again as a leak", async () => {
    const seeded = await freshWorkspace();
    const first = await connect(seeded);
    const rotated = await seeded.stub.refreshOauthTokens({
      workspaceSlug: seeded.slug,
      refreshToken: first.refreshToken,
      clientId: first.clientId,
      now: NOW + 10_000,
    });
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;

    const replay = await seeded.stub.refreshOauthTokens({
      workspaceSlug: seeded.slug,
      refreshToken: first.refreshToken,
      clientId: first.clientId,
      now: NOW + 20_000,
    });
    expect(replay).toMatchObject({ ok: false, error: "invalid_grant" });

    // The whole connection dies, not just the replayed token: the current pair
    // is dead too, because we cannot tell a leak from a lost response.
    expect(
      await seeded.stub.authenticateOauthToken({
        accessToken: rotated.grant.accessToken,
        audience: seeded.resource,
        now: NOW + 20_001,
      }),
    ).toMatchObject({ ok: false, error: "invalid_token" });
    expect(
      await seeded.stub.refreshOauthTokens({
        workspaceSlug: seeded.slug,
        refreshToken: rotated.grant.refreshToken,
        clientId: first.clientId,
        now: NOW + 20_002,
      }),
    ).toMatchObject({ ok: false, error: "invalid_grant" });

    expect(
      (await auditRows(seeded.stub)).some(
        (entry) =>
          entry.event_type === "oauth.revoked" &&
          entry.metadata_json.includes("refresh_token_replayed"),
      ),
    ).toBe(true);
  });

  it("refuses a refresh token presented by another client", async () => {
    const seeded = await freshWorkspace();
    const first = await connect(seeded);
    expect(
      await seeded.stub.refreshOauthTokens({
        workspaceSlug: seeded.slug,
        refreshToken: first.refreshToken,
        clientId: "client-other",
        now: NOW + 5_000,
      }),
    ).toMatchObject({ ok: false, error: "invalid_client" });
    // Refusing another client is not the same as detecting a leak, so the
    // connection survives and its own client can still rotate.
    expect(
      await seeded.stub.refreshOauthTokens({
        workspaceSlug: seeded.slug,
        refreshToken: first.refreshToken,
        clientId: first.clientId,
        now: NOW + 5_001,
      }),
    ).toMatchObject({ ok: true });
  });
});

describe("MCP-INT-004 a token is useless anywhere but its own workspace", () => {
  it("refuses one workspace's token at another, in both directions", async () => {
    const first = await freshWorkspace();
    const second = await freshWorkspace();
    const firstGrant = await connect(first);
    const secondGrant = await connect(second);

    // Presented to the other tenant's object: the prefix names a different
    // workspace, so it is refused before any lookup happens.
    expect(
      await second.stub.authenticateOauthToken({
        accessToken: firstGrant.accessToken,
        audience: second.resource,
        now: NOW + 1_000,
      }),
    ).toMatchObject({ ok: false, error: "invalid_token" });
    expect(
      await first.stub.authenticateOauthToken({
        accessToken: secondGrant.accessToken,
        audience: first.resource,
        now: NOW + 1_000,
      }),
    ).toMatchObject({ ok: false, error: "invalid_token" });

    // Presented to its own object but claiming the other's audience: this is
    // the case the RFC 8707 binding exists for, and it is refused too.
    expect(
      await first.stub.authenticateOauthToken({
        accessToken: firstGrant.accessToken,
        audience: second.resource,
        now: NOW + 1_000,
      }),
    ).toMatchObject({ ok: false, error: "invalid_token" });

    // Each still works where it belongs.
    expect(
      await first.stub.authenticateOauthToken({
        accessToken: firstGrant.accessToken,
        audience: first.resource,
        now: NOW + 1_000,
      }),
    ).toMatchObject({ ok: true });
  });

  it("refuses to authorize against a resource naming another workspace", async () => {
    const first = await freshWorkspace();
    const second = await freshWorkspace();
    const result = await first.stub.beginOauthAuthorization({
      actor: first.owner,
      workspaceSlug: first.slug,
      clientId: "client-code",
      clientName: null,
      redirectUri: "http://127.0.0.1:1234/callback",
      codeChallenge: await challengeFor(VERIFIER),
      scope: "chat:read",
      resource: second.resource,
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, error: "invalid_target" });
    expect(await countRows(first.stub, "SELECT COUNT(*) AS total FROM oauth_codes")).toBe(0);
  });

  it("refuses a caller that names a slug this object is not", async () => {
    const seeded = await freshWorkspace();
    await expect(
      runInDurableObject(seeded.stub, (instance: Workspace) =>
        instance.beginOauthAuthorization({
          actor: seeded.owner,
          workspaceSlug: "somebody-else",
          clientId: "client-code",
          clientName: null,
          redirectUri: "http://127.0.0.1:1234/callback",
          codeChallenge: "b".repeat(43),
          scope: "chat:read",
          resource: workspaceResourceUri(ORIGIN, "somebody-else"),
          now: NOW,
        }),
      ),
    ).rejects.toThrow(/workspace slug/);
  });
});

describe("MCP-INT-005 authority is re-checked live on every call", () => {
  it("cuts a connection off when the person stops being a member", async () => {
    const seeded = await freshWorkspace();
    const grant = await connect(seeded, { actor: seeded.member });
    expect(
      await seeded.stub.authenticateOauthToken({
        accessToken: grant.accessToken,
        audience: seeded.resource,
        now: NOW + 1_000,
      }),
    ).toMatchObject({ ok: true });

    await seeded.stub.applyMembership({
      operationId: `${seeded.slug}-remove-two`,
      memberId: "member-two",
      accountId: `account-${seeded.slug}-member-two`,
      handle: "daniel",
      displayName: "Daniel Park",
      role: "member",
      status: "removed",
      authorizationEpoch: 2,
      version: 2,
      now: NOW + 2_000,
    });

    // Nothing was revoked and no token expired; the next call simply finds no
    // member to act as.
    expect(
      await seeded.stub.authenticateOauthToken({
        accessToken: grant.accessToken,
        audience: seeded.resource,
        now: NOW + 3_000,
      }),
    ).toMatchObject({ ok: false, error: "invalid_token" });
    expect(
      await seeded.stub.refreshOauthTokens({
        workspaceSlug: seeded.slug,
        refreshToken: grant.refreshToken,
        clientId: grant.clientId,
        now: NOW + 3_000,
      }),
    ).toMatchObject({ ok: false, error: "invalid_grant" });
  });

  it("expires an access token on time while the connection stays refreshable", async () => {
    const seeded = await freshWorkspace();
    const grant = await connect(seeded);
    expect(
      await seeded.stub.authenticateOauthToken({
        accessToken: grant.accessToken,
        audience: seeded.resource,
        now: NOW + 3_600_000 - 1,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await seeded.stub.authenticateOauthToken({
        accessToken: grant.accessToken,
        audience: seeded.resource,
        now: NOW + 3_600_000,
      }),
    ).toMatchObject({ ok: false, error: "invalid_token" });
    expect(
      await seeded.stub.refreshOauthTokens({
        workspaceSlug: seeded.slug,
        refreshToken: grant.refreshToken,
        clientId: grant.clientId,
        now: NOW + 3_600_000,
      }),
    ).toMatchObject({ ok: true });
  });

  it("refuses a scope the connection never asked for", async () => {
    const seeded = await freshWorkspace();
    const grant = await connect(seeded, { scope: "chat:read" });
    expect(
      await seeded.stub.authenticateOauthToken({
        accessToken: grant.accessToken,
        audience: seeded.resource,
        now: NOW + 1_000,
        requiredScope: "chat:write",
      }),
    ).toMatchObject({ ok: false, error: "insufficient_scope" });
    expect(
      await seeded.stub.authenticateOauthToken({
        accessToken: grant.accessToken,
        audience: seeded.resource,
        now: NOW + 1_000,
        requiredScope: "chat:read",
      }),
    ).toMatchObject({ ok: true });
  });
});

describe("MCP-INT-006 a person can see and end their own connections", () => {
  it("lists only the caller's connections and ends one on request", async () => {
    const seeded = await freshWorkspace();
    const mine = await connect(seeded, { actor: seeded.owner });
    const theirs = await connect(seeded, { actor: seeded.member, clientId: "client-desktop" });

    const listed = await seeded.stub.listOauthConnections({ actor: seeded.owner });
    expect(listed.connections.map((row) => row.id)).toEqual([mine.connectionId]);
    expect(listed.connections[0]).toMatchObject({ clientId: "client-code", scope: "chat:read chat:write" });

    // Somebody else's connection is missing, not forbidden. Asserted against
    // the instance, because a rejecting stub RPC is reported by the harness
    // itself as an unhandled rejection.
    await runInDurableObject(seeded.stub, async (instance: Workspace) => {
      await expect(
        instance.revokeOauthConnection({
          actor: seeded.owner,
          connectionId: theirs.connectionId,
          now: NOW + 1_000,
        }),
      ).rejects.toThrow(/connection not found/);
    });
    // And it still works, because refusing to reveal it did not disturb it.
    expect(
      await seeded.stub.authenticateOauthToken({
        accessToken: theirs.accessToken,
        audience: seeded.resource,
        now: NOW + 1_000,
      }),
    ).toMatchObject({ ok: true });

    expect(
      await seeded.stub.revokeOauthConnection({
        actor: seeded.owner,
        connectionId: mine.connectionId,
        now: NOW + 2_000,
      }),
    ).toEqual({ revoked: true });
    expect(
      await seeded.stub.authenticateOauthToken({
        accessToken: mine.accessToken,
        audience: seeded.resource,
        now: NOW + 3_000,
      }),
    ).toMatchObject({ ok: false, error: "invalid_token" });
    expect((await seeded.stub.listOauthConnections({ actor: seeded.owner })).connections).toEqual([]);
  });

  it("revokes a connection from either half of its pair, and says nothing about the rest", async () => {
    const seeded = await freshWorkspace();
    const first = await connect(seeded);
    expect(await seeded.stub.revokeOauthToken({ token: first.refreshToken, now: NOW + 1_000 })).toEqual({
      revoked: true,
    });
    // Idempotent, and an unknown token is answered the same way rather than
    // reporting whether it existed.
    expect(await seeded.stub.revokeOauthToken({ token: first.refreshToken, now: NOW + 1_100 })).toEqual({
      revoked: false,
    });
    expect(
      await seeded.stub.revokeOauthToken({
        token: formatToken("at", seeded.slug, randomSecret()),
        now: NOW + 1_200,
      }),
    ).toEqual({ revoked: false });

    const second = await connect(seeded, { clientId: "client-desktop" });
    expect(await seeded.stub.revokeOauthToken({ token: second.accessToken, now: NOW + 2_000 })).toEqual({
      revoked: true,
    });
    expect(
      await seeded.stub.authenticateOauthToken({
        accessToken: second.accessToken,
        audience: seeded.resource,
        now: NOW + 2_100,
      }),
    ).toMatchObject({ ok: false, error: "invalid_token" });
  });
});

describe("MCP-INT-007 an authorization request needs a live member", () => {
  it("refuses a stale authorization epoch and a member who is not there", async () => {
    const seeded = await freshWorkspace();
    const request = (actor: Actor) => ({
      actor,
      workspaceSlug: seeded.slug,
      clientId: "client-code",
      clientName: null,
      redirectUri: "http://127.0.0.1:1234/callback",
      codeChallenge: "b".repeat(43),
      scope: "chat:read",
      resource: seeded.resource,
      now: NOW,
    });

    await runInDurableObject(seeded.stub, async (instance: Workspace) => {
      for (const actor of [
        { memberId: "member-owner", authorizationEpoch: 99 },
        { memberId: "member-nobody", authorizationEpoch: 1 },
      ]) {
        await expect(instance.beginOauthAuthorization(request(actor))).rejects.toThrow(/not authorized/);
      }
    });
    expect(await countRows(seeded.stub, "SELECT COUNT(*) AS total FROM oauth_codes")).toBe(0);

    // The paired allow case, so the refusals above are about authority rather
    // than about the request being malformed.
    expect(await seeded.stub.beginOauthAuthorization(request(seeded.owner))).toMatchObject({ ok: true });
  });
});

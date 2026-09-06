import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Actor, Workspace } from "../src/cloudflare/workspace";

const NOW = 1_800_000_000_000;

type Seeded = {
  stub: DurableObjectStub<Workspace>;
  owner: Actor;
  member: Actor;
  outsider: Actor;
  channelId: string;
};

async function seed(name: string, storageMode: "cloud" | "local_host" = "cloud"): Promise<Seeded> {
  const stub = env.WORKSPACE.getByName(name);
  await stub.initializeWorkspace({ storageMode, hostEpoch: 0, routingEpoch: 1, now: NOW });
  const people: readonly [string, string, string][] = [
    ["member-owner", "maya", "Maya Chen"],
    ["member-two", "daniel", "Daniel Park"],
    ["member-three", "priya", "Priya Singh"],
  ];
  for (const [index, [memberId, handle, displayName]] of people.entries()) {
    await stub.applyMembership({
      operationId: `${name}-op-${memberId}`,
      memberId,
      accountId: `account-${memberId}`,
      handle,
      displayName,
      role: index === 0 ? "owner" : "member",
      status: "active",
      authorizationEpoch: 1,
      version: 1,
      now: NOW,
    });
  }
  const owner: Actor = { memberId: "member-owner", authorizationEpoch: 1 };
  const member: Actor = { memberId: "member-two", authorizationEpoch: 1 };
  const channel = await stub.createChannel({
    actor: owner,
    idempotencyKey: `channel:create:${name}:0001`,
    kind: "public",
    slug: "eng",
    memberIds: [member.memberId],
    now: NOW,
  });
  return {
    stub,
    owner,
    member,
    outsider: { memberId: "member-three", authorizationEpoch: 1 },
    channelId: channel.channelId,
  };
}

describe("snippets", () => {
  it("SNIP-INT-001 posts a summary into history and keeps the body beside it", async () => {
    const seeded = await seed("snippets-post");
    const sent = await seeded.stub.sendSnippet({
      actor: seeded.owner,
      idempotencyKey: "message:snippet:0000000001",
      channelId: seeded.channelId,
      title: "Deploy script",
      language: "sh",
      body: "if true; then\n\techo hi\nfi",
      now: NOW + 1,
    });

    const history = await seeded.stub.readChannelHistory({
      actor: seeded.owner,
      channelId: seeded.channelId,
    });
    const message = history.messages[0];
    // History carries a one-line summary, not the snippet.
    expect(message.bodyMarkdown).toBe("**Deploy script** · sh · 3 lines");
    expect(message.bodyMarkdown).not.toContain("echo hi");
    // The snippet travels beside it, with its indentation intact.
    expect(message.snippet).toMatchObject({
      title: "Deploy script",
      language: "sh",
      body: "if true; then\n\techo hi\nfi",
      lineCount: 3,
    });

    // A retried post is one snippet, not two.
    const retry = await seeded.stub.sendSnippet({
      actor: seeded.owner,
      idempotencyKey: "message:snippet:0000000001",
      channelId: seeded.channelId,
      title: "Deploy script",
      language: "sh",
      body: "if true; then\n\techo hi\nfi",
      now: NOW + 2,
    });
    expect(retry.messageId).toBe(sent.messageId);
    expect(retry.replayed).toBe(true);
    expect(
      (await seeded.stub.readChannelHistory({ actor: seeded.owner, channelId: seeded.channelId }))
        .messages,
    ).toHaveLength(1);
  });

  it("SNIP-INT-002 keeps the snippet body out of every record that outlives it", async () => {
    const seeded = await seed("snippets-audit");
    await seeded.stub.sendSnippet({
      actor: seeded.owner,
      idempotencyKey: "message:snippet:0000000010",
      channelId: seeded.channelId,
      title: "Runbook",
      body: "SNIPPET_BODY_CANARY",
      now: NOW + 1,
    });

    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      const dump = [
        ...state.storage.sql
          .exec<{ v: string }>("SELECT metadata_json AS v FROM audit_events")
          .toArray(),
        ...state.storage.sql.exec<{ v: string }>("SELECT payload_json AS v FROM replay_events").toArray(),
        ...state.storage.sql.exec<{ v: string }>("SELECT payload_json AS v FROM pending_events").toArray(),
      ]
        .map((row) => row.v)
        .join("");
      expect(dump).not.toContain("SNIPPET_BODY_CANARY");
      // The audit records what kind of thing happened, with counts only.
      const audit = state.storage.sql
        .exec<{ event_type: string; metadata_json: string }>(
          "SELECT event_type, metadata_json FROM audit_events WHERE event_type = 'message.snippet_created'",
        )
        .one();
      expect(JSON.parse(audit.metadata_json)).toMatchObject({ line_count: 1 });
    });
  });

  it("SNIP-INT-003 refuses an unjoined room, an empty snippet and a Solo workspace", async () => {
    const seeded = await seed("snippets-refused");
    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      await expect(
        instance.sendSnippet({
          actor: seeded.outsider,
          idempotencyKey: "message:snippet:0000000020",
          channelId: seeded.channelId,
          body: "SNIPPET_REFUSED_CANARY",
          now: NOW + 1,
        }),
      ).rejects.toThrow("join this room before posting in it");
      await expect(
        instance.sendSnippet({
          actor: seeded.owner,
          idempotencyKey: "message:snippet:0000000021",
          channelId: seeded.channelId,
          body: "   ",
          now: NOW + 2,
        }),
      ).rejects.toThrow("snippet is empty or too long");
    });

    const solo = await seed("snippets-solo", "local_host");
    await runInDurableObject<Workspace, void>(solo.stub, async (instance) => {
      await expect(
        instance.sendSnippet({
          actor: solo.owner,
          idempotencyKey: "message:snippet:0000000022",
          channelId: solo.channelId,
          body: "SOLO_SNIPPET_CANARY",
          now: NOW + 1,
        }),
      ).rejects.toThrow("content_is_host_owned");
    });
    await runInDurableObject<Workspace, void>(solo.stub, (_instance, state) => {
      expect(
        state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM message_snippets").one().n,
      ).toBe(0);
    });
  });
});

describe("slash commands", () => {
  it("CMD-INT-001 posts what the speaking commands say", async () => {
    const seeded = await seed("commands-speak");
    await expect(
      seeded.stub.runComposerInput({
        actor: seeded.owner,
        idempotencyKey: "composer:run:00000000001",
        channelId: seeded.channelId,
        raw: "/me is looking into it",
        now: NOW + 1,
      }),
    ).resolves.toMatchObject({ kind: "sent" });
    await seeded.stub.runComposerInput({
      actor: seeded.owner,
      idempotencyKey: "composer:run:00000000002",
      channelId: seeded.channelId,
      raw: "/shrug no idea",
      now: NOW + 2,
    });

    const history = await seeded.stub.readChannelHistory({
      actor: seeded.owner,
      channelId: seeded.channelId,
    });
    const bodies = history.messages.map((message) => message.bodyMarkdown);
    expect(bodies).toContain("_is looking into it_");
    expect(bodies.some((body) => body.startsWith("no idea "))).toBe(true);
  });

  it("CMD-INT-002 refuses an unknown command rather than posting it", async () => {
    const seeded = await seed("commands-unknown");
    const result = await seeded.stub.runComposerInput({
      actor: seeded.owner,
      idempotencyKey: "composer:run:00000000010",
      channelId: seeded.channelId,
      raw: "/deploy production UNKNOWN_COMMAND_CANARY",
      now: NOW + 1,
    });
    expect(result).toMatchObject({ kind: "rejected" });
    expect(result.kind === "rejected" && result.reason).toContain("/deploy is not a command");

    // Nothing was said out loud, and the escape hatch says it deliberately.
    expect(
      (await seeded.stub.readChannelHistory({ actor: seeded.owner, channelId: seeded.channelId }))
        .messages,
    ).toEqual([]);
    await seeded.stub.runComposerInput({
      actor: seeded.owner,
      idempotencyKey: "composer:run:00000000011",
      channelId: seeded.channelId,
      raw: "//deploy production",
      now: NOW + 2,
    });
    expect(
      (await seeded.stub.readChannelHistory({ actor: seeded.owner, channelId: seeded.channelId }))
        .messages[0].bodyMarkdown,
    ).toBe("/deploy production");
  });

  it("CMD-INT-003 carries an acting command out through the same authority a button would", async () => {
    const seeded = await seed("commands-acting");
    const open = await seeded.stub.createChannel({
      actor: seeded.owner,
      idempotencyKey: "channel:create:release:0001",
      kind: "public",
      slug: "release",
      now: NOW,
    });

    await expect(
      seeded.stub.runComposerInput({
        actor: seeded.member,
        idempotencyKey: "composer:run:00000000020",
        channelId: open.channelId,
        raw: "/join",
        now: NOW + 1,
      }),
    ).resolves.toEqual({ kind: "acted", command: "join" });
    expect(
      (await seeded.stub.browseChannels({ actor: seeded.member })).channels.find(
        (channel) => channel.id === open.channelId,
      )?.isMember,
    ).toBe(true);

    await expect(
      seeded.stub.runComposerInput({
        actor: seeded.member,
        idempotencyKey: "composer:run:00000000021",
        channelId: open.channelId,
        raw: "/leave",
        now: NOW + 2,
      }),
    ).resolves.toEqual({ kind: "acted", command: "leave" });
  });

  it("CMD-INT-004 gives a command no authority the person typing it lacks", async () => {
    const seeded = await seed("commands-authority");
    const closed = await seeded.stub.createChannel({
      actor: seeded.owner,
      idempotencyKey: "channel:create:design:0001",
      kind: "private",
      slug: "design",
      now: NOW,
    });

    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      // A member cannot archive somebody else's room by typing it.
      await expect(
        instance.runComposerInput({
          actor: seeded.member,
          idempotencyKey: "composer:run:00000000030",
          channelId: seeded.channelId,
          raw: "/archive",
          now: NOW + 1,
        }),
      ).rejects.toThrow("only an admin or the room's creator may archive it");
      // A private room they are not in stays missing, command or not.
      await expect(
        instance.runComposerInput({
          actor: seeded.member,
          idempotencyKey: "composer:run:00000000031",
          channelId: closed.channelId,
          raw: "/me poking around",
          now: NOW + 2,
        }),
      ).rejects.toThrow("channel not found");
      await expect(
        instance.runComposerInput({
          actor: seeded.member,
          idempotencyKey: "composer:run:00000000032",
          channelId: closed.channelId,
          raw: "/join",
          now: NOW + 3,
        }),
      ).rejects.toThrow("channel not found");
    });

    // The owner may archive their own room, which is the paired allow case.
    await expect(
      seeded.stub.runComposerInput({
        actor: seeded.owner,
        idempotencyKey: "composer:run:00000000033",
        channelId: seeded.channelId,
        raw: "/archive",
        now: NOW + 4,
      }),
    ).resolves.toEqual({ kind: "acted", command: "archive" });
  });
});

describe("custom emoji", () => {
  it("EMOJI-INT-001 lets an admin name one and everybody use it", async () => {
    const seeded = await seed("emoji-admin");
    await expect(
      seeded.stub.createCustomEmoji({
        actor: seeded.owner,
        name: ":SHIPIT:",
        aliasEmoji: "\u{1F680}",
        now: NOW + 1,
      }),
    ).resolves.toEqual({ created: true, name: "shipit" });
    // Naming it twice is one emoji, so an old message cannot change meaning.
    await expect(
      seeded.stub.createCustomEmoji({
        actor: seeded.owner,
        name: "shipit",
        aliasEmoji: "\u{1F525}",
        now: NOW + 2,
      }),
    ).resolves.toEqual({ created: false, name: "shipit" });

    // Every member can read the workspace's emoji.
    await expect(seeded.stub.listCustomEmoji({ actor: seeded.member })).resolves.toEqual({
      emoji: [{ name: "shipit", aliasEmoji: "\u{1F680}", createdAt: NOW + 1 }],
    });

    const sent = await seeded.stub.sendMessage({
      actor: seeded.owner,
      idempotencyKey: "message:send:emoji00001",
      channelId: seeded.channelId,
      bodyMarkdown: "shipped",
      now: NOW + 3,
    });
    await expect(
      seeded.stub.reactToMessage({
        actor: seeded.member,
        messageId: sent.messageId,
        emoji: ":shipit:",
        now: NOW + 4,
      }),
    ).resolves.toEqual({ added: true });
  });

  it("EMOJI-INT-002 refuses naming and removing to anybody who is not an admin", async () => {
    const seeded = await seed("emoji-refused");
    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      await expect(
        instance.createCustomEmoji({
          actor: seeded.member,
          name: "sneaky",
          aliasEmoji: "\u{1F525}",
          now: NOW + 1,
        }),
      ).rejects.toThrow("only an admin may name a custom emoji");
      await expect(
        instance.deleteCustomEmoji({ actor: seeded.member, name: "sneaky", now: NOW + 2 }),
      ).rejects.toThrow("only an admin may remove a custom emoji");
      // A name that could be confused with another is refused outright.
      await expect(
        instance.createCustomEmoji({
          actor: seeded.owner,
          name: "not a name",
          aliasEmoji: "\u{1F525}",
          now: NOW + 3,
        }),
      ).rejects.toThrow("invalid custom emoji name");
      // A custom emoji must alias a real emoji, not another name.
      await expect(
        instance.createCustomEmoji({
          actor: seeded.owner,
          name: "circular",
          aliasEmoji: ":shipit:",
          now: NOW + 4,
        }),
      ).rejects.toThrow("a custom emoji needs a real emoji");
    });

    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      expect(
        state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM custom_emoji").one().n,
      ).toBe(0);
    });
  });

  it("EMOJI-INT-003 refuses a reaction naming an emoji this workspace has not defined", async () => {
    const seeded = await seed("emoji-unknown");
    const sent = await seeded.stub.sendMessage({
      actor: seeded.owner,
      idempotencyKey: "message:send:emoji00010",
      channelId: seeded.channelId,
      bodyMarkdown: "shipped",
      now: NOW + 1,
    });

    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      await expect(
        instance.reactToMessage({
          actor: seeded.owner,
          messageId: sent.messageId,
          emoji: ":nobody-defined-this:",
          now: NOW + 2,
        }),
      ).rejects.toThrow("no custom emoji by that name");
    });
    // A literal emoji never needed defining.
    await expect(
      seeded.stub.reactToMessage({
        actor: seeded.owner,
        messageId: sent.messageId,
        emoji: "\u{1F525}",
        now: NOW + 3,
      }),
    ).resolves.toEqual({ added: true });
  });

  it("EMOJI-INT-004 lets a reaction be withdrawn after its emoji is removed", async () => {
    const seeded = await seed("emoji-removed");
    await seeded.stub.createCustomEmoji({
      actor: seeded.owner,
      name: "shipit",
      aliasEmoji: "\u{1F680}",
      now: NOW + 1,
    });
    const sent = await seeded.stub.sendMessage({
      actor: seeded.owner,
      idempotencyKey: "message:send:emoji00020",
      channelId: seeded.channelId,
      bodyMarkdown: "shipped",
      now: NOW + 2,
    });
    await seeded.stub.reactToMessage({
      actor: seeded.owner,
      messageId: sent.messageId,
      emoji: ":shipit:",
      now: NOW + 3,
    });

    await expect(
      seeded.stub.deleteCustomEmoji({ actor: seeded.owner, name: "shipit", now: NOW + 4 }),
    ).resolves.toEqual({ deleted: true });

    // Nobody can add it any more, but the person who used it can take it back
    // rather than being stranded with a reaction they cannot remove.
    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      await expect(
        instance.reactToMessage({
          actor: seeded.member,
          messageId: sent.messageId,
          emoji: ":shipit:",
          now: NOW + 5,
        }),
      ).rejects.toThrow("no custom emoji by that name");
    });
    await expect(
      seeded.stub.unreactToMessage({
        actor: seeded.owner,
        messageId: sent.messageId,
        emoji: ":shipit:",
        now: NOW + 6,
      }),
    ).resolves.toEqual({ removed: true });
  });
});

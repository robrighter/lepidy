import { describe, expect, it } from "vitest";

import { isEmojiToken, parseCustomEmojiName, parseEmojiTokens, toEmojiToken } from "./emoji";
import {
  MAX_SNIPPET_BODY_LENGTH,
  parseSnippet,
  snippetMessageBody,
} from "./rooms";
import {
  SHRUG,
  SLASH_COMMAND_HELP,
  commandMessageBody,
  parseComposerInput,
} from "./slash-commands";

describe("slash command parsing", () => {
  it("PROD-RULE-001 tells a command from a message", () => {
    expect(parseComposerInput("hello there")).toEqual({
      kind: "message",
      bodyMarkdown: "hello there",
    });
    expect(parseComposerInput("/me is looking into it")).toEqual({
      kind: "command",
      name: "me",
      argument: "is looking into it",
    });
    expect(parseComposerInput("/join")).toEqual({ kind: "command", name: "join", argument: "" });
    // Case and surrounding whitespace do not change what was meant.
    expect(parseComposerInput("  /LEAVE  ")).toEqual({
      kind: "command",
      name: "leave",
      argument: "",
    });
  });

  it("PROD-RULE-002 refuses an unknown command instead of saying it out loud", () => {
    // Somebody who mistypes a command did not mean to post it to the room.
    expect(parseComposerInput("/deploy production now")).toEqual({
      kind: "unknown_command",
      typed: "/deploy",
    });
    expect(parseComposerInput("/")).toEqual({ kind: "unknown_command", typed: "/" });
    expect(parseComposerInput("/9lives")).toEqual({ kind: "unknown_command", typed: "/9lives" });
  });

  it("PROD-RULE-003 gives a way to start a message with a slash", () => {
    expect(parseComposerInput("//not a command")).toEqual({
      kind: "message",
      bodyMarkdown: "/not a command",
    });
    expect(parseComposerInput("//join")).toEqual({ kind: "message", bodyMarkdown: "/join" });
  });

  it("PROD-RULE-004 treats an empty composer as nothing to do", () => {
    for (const raw of ["", "   ", "\n\t "]) {
      expect(parseComposerInput(raw), JSON.stringify(raw)).toEqual({ kind: "empty" });
    }
  });

  it("PROD-RULE-005 builds the text the speaking commands post", () => {
    expect(commandMessageBody("me", "is looking into it")).toBe("_is looking into it_");
    expect(commandMessageBody("shrug", "no idea")).toBe(`no idea ${SHRUG}`);
    expect(commandMessageBody("shrug", "")).toBe(SHRUG);
    // `/me` with nothing to say says nothing.
    expect(commandMessageBody("me", "")).toBeNull();
    // The acting commands do not post; the object carries them out.
    expect(commandMessageBody("join", "")).toBeNull();
    expect(commandMessageBody("leave", "")).toBeNull();
    expect(commandMessageBody("archive", "")).toBeNull();
  });

  it("PROD-RULE-006 documents every command it accepts", () => {
    const documented = new Set(SLASH_COMMAND_HELP.map((entry) => entry.name));
    for (const name of ["me", "shrug", "join", "leave", "archive"] as const) {
      expect(parseComposerInput(`/${name}`).kind, name).toBe("command");
      expect(documented.has(name), name).toBe(true);
    }
    expect(documented.size).toBe(SLASH_COMMAND_HELP.length);
  });
});

describe("custom emoji names", () => {
  it("PROD-RULE-007 normalises a name with or without its colons", () => {
    expect(parseCustomEmojiName(":shipit:")).toBe("shipit");
    expect(parseCustomEmojiName("shipit")).toBe("shipit");
    expect(parseCustomEmojiName("  :SHIPIT:  ")).toBe("shipit");
    expect(parseCustomEmojiName("party-parrot_2")).toBe("party-parrot_2");
    expect(parseCustomEmojiName("+1")).toBeNull();
    expect(parseCustomEmojiName("1+")).toBe("1+");
  });

  it("PROD-RULE-008 refuses a name that could be confused with another", () => {
    for (const value of ["", "::", "  ", "has space", "a".repeat(33), "-leading", "emo:ji", 7, null]) {
      expect(parseCustomEmojiName(value), String(value)).toBeNull();
    }
    expect(parseCustomEmojiName("a".repeat(32))).toHaveLength(32);
  });

  it("PROD-RULE-009 recognises the token form without resolving it", () => {
    expect(toEmojiToken("shipit")).toBe(":shipit:");
    expect(isEmojiToken(":shipit:")).toBe(true);
    expect(isEmojiToken("\u{1F525}")).toBe(false);
    expect(isEmojiToken("::")).toBe(false);
    expect(isEmojiToken("shipit")).toBe(false);
  });

  it("PROD-RULE-010 finds the names a body refers to, once each", () => {
    expect(parseEmojiTokens("ship it :shipit: and :shipit: again :party-parrot:")).toEqual([
      "shipit",
      "party-parrot",
    ]);
    expect(parseEmojiTokens("no tokens here")).toEqual([]);
    // A ratio is not a token, and neither is a lone colon.
    expect(parseEmojiTokens("10:30 and : alone")).toEqual([]);
  });
});

describe("snippets", () => {
  it("PROD-RULE-011 keeps the whitespace that makes code mean something", () => {
    const snippet = parseSnippet({
      title: "  Deploy   script ",
      language: " SH ",
      body: "if true; then\n\techo hi\nfi\n\n",
    });
    expect(snippet).toEqual({
      title: "Deploy script",
      language: "sh",
      // Indentation survives; only trailing blank space is trimmed.
      body: "if true; then\n\techo hi\nfi",
      lineCount: 3,
    });
  });

  it("PROD-RULE-012 falls back to a title and drops a language it cannot use", () => {
    expect(parseSnippet({ body: "x" })).toMatchObject({ title: "Snippet", language: null });
    expect(parseSnippet({ body: "x", language: "not a language" })).toMatchObject({ language: null });
    expect(parseSnippet({ body: "x", title: "y".repeat(200) })?.title).toHaveLength(120);
  });

  it("PROD-RULE-013 refuses an empty snippet and one past the ceiling", () => {
    for (const body of ["", "   \n\t ", null, 7]) {
      expect(parseSnippet({ body }), String(body)).toBeNull();
    }
    expect(parseSnippet({ body: "x".repeat(MAX_SNIPPET_BODY_LENGTH) })).not.toBeNull();
    expect(parseSnippet({ body: "x".repeat(MAX_SNIPPET_BODY_LENGTH + 1) })).toBeNull();
    // A snippet may be far longer than a message, which is the whole point.
    expect(MAX_SNIPPET_BODY_LENGTH).toBeGreaterThan(16_000);
  });

  it("PROD-RULE-014 summarises a snippet without repeating it", () => {
    const snippet = parseSnippet({ title: "Runbook", language: "sh", body: "a\nb" })!;
    expect(snippetMessageBody(snippet)).toBe("**Runbook** · sh · 2 lines");
    expect(snippetMessageBody({ ...snippet, lineCount: 1, language: null })).toBe(
      "**Runbook** · 1 line",
    );
    // The summary is what history shows, so it must not carry the body.
    expect(snippetMessageBody(snippet)).not.toContain("a\nb");
  });
});

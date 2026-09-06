import { describe, expect, it } from "vitest";

import { isSafeLinkHref, parseInline, parseMarkdown, toPlainText } from "./markdown";
import { parseMentions } from "./mentions";
import { parseReactionEmoji } from "./rooms";

describe("markdown blocks", () => {
  it("MD-RULE-001 renders a fenced code block with its language", () => {
    expect(parseMarkdown("```ts\nconst a = 1;\n```")).toEqual([
      { type: "code_block", language: "ts", value: "const a = 1;" },
    ]);
    expect(parseMarkdown("```\nplain\n```")).toEqual([
      { type: "code_block", language: null, value: "plain" },
    ]);
    // An unterminated fence still renders as code rather than losing the text.
    expect(parseMarkdown("```sh\nwrangler deploy")).toEqual([
      { type: "code_block", language: "sh", value: "wrangler deploy" },
    ]);
  });

  it("MD-RULE-002 keeps everything inside a fence literal", () => {
    const blocks = parseMarkdown("```\n**not bold** @a.deploybot [x](javascript:alert(1))\n```");
    expect(blocks).toEqual([
      {
        type: "code_block",
        language: null,
        value: "**not bold** @a.deploybot [x](javascript:alert(1))",
      },
    ]);
  });

  it("MD-RULE-003 groups paragraphs, quotes and both kinds of list", () => {
    const blocks = parseMarkdown(
      "first line\nsecond line\n\n> quoted\n> lines\n\n- one\n- two\n\n1. alpha\n2. beta",
    );
    expect(blocks.map((block) => block.type)).toEqual([
      "paragraph",
      "quote",
      "list",
      "list",
    ]);
    expect(blocks[2]).toMatchObject({ ordered: false });
    expect(blocks[3]).toMatchObject({ ordered: true });
    expect(toPlainText(blocks)).toBe("first line\nsecond line\nquoted\nlines\none\ntwo\nalpha\nbeta");
  });
});

describe("markdown inline", () => {
  it("MD-RULE-004 lets a code span win over everything inside it", () => {
    expect(parseInline("say `@a.deploybot **now**`")).toEqual([
      { type: "text", value: "say " },
      { type: "code", value: "@a.deploybot **now**" },
    ]);
  });

  it("MD-RULE-005 marks up emphasis, strong and strikethrough", () => {
    expect(parseInline("**bold** *italic* _also_ ~~gone~~")).toEqual([
      { type: "strong", children: [{ type: "text", value: "bold" }] },
      { type: "text", value: " " },
      { type: "emphasis", children: [{ type: "text", value: "italic" }] },
      { type: "text", value: " " },
      { type: "emphasis", children: [{ type: "text", value: "also" }] },
      { type: "text", value: " " },
      { type: "strike", children: [{ type: "text", value: "gone" }] },
    ]);
  });

  it("MD-RULE-014 leaves an underscore inside a word alone", () => {
    // A developer's identifiers survive intact; the shorthand still works when
    // the underscore actually opens and closes a word.
    expect(parseInline("MSG_DELETE_CANARY")).toEqual([
      { type: "text", value: "MSG_DELETE_CANARY" },
    ]);
    expect(parseInline("call read_channel_history now")).toEqual([
      { type: "text", value: "call read_channel_history now" },
    ]);
    expect(parseInline("_really_ good")).toEqual([
      { type: "emphasis", children: [{ type: "text", value: "really" }] },
      { type: "text", value: " good" },
    ]);
    // Asterisks still emphasise inside a word, as they always have.
    expect(parseInline("a*b*c")[1]).toMatchObject({ type: "emphasis" });
  });

  it("MD-RULE-006 links only to schemes a message may safely link to", () => {
    expect(parseInline("[docs](https://example.test/a)")).toEqual([
      {
        type: "link",
        href: "https://example.test/a",
        children: [{ type: "text", value: "docs" }],
      },
    ]);
    expect(parseInline("visit https://example.test/b now")[1]).toMatchObject({ type: "link" });
    expect(parseInline("[here](/channels/eng)")[0]).toMatchObject({ type: "link", href: "/channels/eng" });

    // An unsafe scheme is shown as the text somebody typed, never as a link.
    for (const href of ["javascript:alert(1)", "data:text/html,x", "vbscript:x", "//evil.test"]) {
      const nodes = parseInline(`[click](${href})`);
      expect(nodes.every((node) => node.type !== "link"), href).toBe(true);
      expect(nodes.map((node) => (node.type === "text" ? node.value : "")).join("")).toContain(href);
    }
  });

  it("MD-RULE-007 produces a tree and never markup", () => {
    const blocks = parseMarkdown("<script>alert(1)</script> & <b>x</b>");
    expect(blocks).toEqual([
      { type: "paragraph", children: [{ type: "text", value: "<script>alert(1)</script> & <b>x</b>" }] },
    ]);
    // Nothing in the tree is a string of HTML for something else to insert.
    expect(JSON.stringify(blocks)).not.toContain('"html"');
  });

  it("MD-RULE-008 classifies a mention by its prefix", () => {
    expect(parseInline("@maya @a.releasebot @g.fieldtechs @here @channel")).toEqual([
      { type: "mention", kind: "member", handle: "maya", label: "@maya" },
      { type: "text", value: " " },
      { type: "mention", kind: "agent", handle: "a.releasebot", label: "@a.releasebot" },
      { type: "text", value: " " },
      { type: "mention", kind: "group", handle: "g.fieldtechs", label: "@g.fieldtechs" },
      { type: "text", value: " " },
      { type: "mention", kind: "here", handle: "", label: "@here" },
      { type: "text", value: " " },
      { type: "mention", kind: "channel", handle: "", label: "@channel" },
    ]);
  });
});

describe("link safety", () => {
  it("MD-RULE-009 accepts only http, https, mailto and app-relative links", () => {
    for (const href of ["https://a.test", "http://a.test", "mailto:x@a.test", "/inbox"]) {
      expect(isSafeLinkHref(href), href).toBe(true);
    }
    for (const href of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      " javascript:alert(1)",
      "data:text/html;base64,x",
      "file:///etc/passwd",
      "//evil.test",
      "",
      "   ",
      `https://a.test/${"x".repeat(3000)}`,
    ]) {
      expect(isSafeLinkHref(href), href).toBe(false);
    }
  });
});

describe("mentions over a whole body", () => {
  it("MD-RULE-010 never addresses anything named inside code", () => {
    const body = "ask @maya\n\n```\n@a.deploybot deploy now\n```\n\nand `@g.oncall` too";
    expect(parseMentions(body).map((mention) => `${mention.kind}:${mention.handle}`)).toEqual([
      "member:maya",
    ]);
  });

  it("MD-RULE-011 deduplicates and trims trailing punctuation", () => {
    expect(parseMentions("@maya, @maya. @a.releasebot!").map((m) => `${m.kind}:${m.handle}`)).toEqual([
      "member:maya",
      "agent:a.releasebot",
    ]);
    expect(parseMentions("@Maya and @MAYA").map((m) => m.handle)).toEqual(["maya"]);
  });

  it("MD-RULE-012 finds nothing where there is nothing to find", () => {
    // The domain half of an email address is not a mention of anybody.
    expect(parseMentions("email x@example.test")).toEqual([]);
    expect(parseInline("email x@example.test").every((node) => node.type !== "mention")).toBe(true);
    expect(parseMentions("no mentions here")).toEqual([]);
    expect(parseMentions("@ @. @-")).toEqual([]);
    // A mention at the start of a line and after punctuation still counts.
    expect(parseMentions("@maya (@daniel)").map((m) => m.handle)).toEqual(["maya", "daniel"]);
  });
});

describe("reactions", () => {
  it("MD-RULE-013 accepts an emoji or a named custom form and nothing else", () => {
    expect(parseReactionEmoji("\u{1F525}")).toBe("\u{1F525}");
    expect(parseReactionEmoji(" \u{1F440} ")).toBe("\u{1F440}");
    expect(parseReactionEmoji(":shipit:")).toBe(":shipit:");
    for (const value of ["", "   ", "lgtm", "a".repeat(40), "\u{1F525} \u{1F525}", ":Bad:", 7, null]) {
      expect(parseReactionEmoji(value), String(value)).toBeNull();
    }
  });
});

import { describe, expect, it } from "vitest";

import { nextSearchCursor, parseSearchQuery, searchCursor, searchMatch } from "./search";

describe("workspace search rules", () => {
  it("C09-RULE-001 parses every supported operator and leaves ordinary words", () => {
    const parsed = parseSearchQuery("failed retry from:@maya in:#release has:file has:link has:code is:thread after:2026-01-01 before:2026-02-01");
    expect(parsed).toMatchObject({
      text: "failed retry", from: ["maya"], in: ["release"], has: ["file", "link", "code"],
      isThread: true, errors: [],
    });
    expect(new Date(parsed.after!).toISOString()).toContain("2026-01-01");
    expect(new Date(parsed.before!).toISOString()).toContain("2026-02-01");
  });

  it("C09-RULE-002 reports invalid recognized operators instead of silently matching nothing", () => {
    expect(parseSearchQuery("has:image is:root before:2026-02-30 after:nope").errors).toEqual([
      "has:image is not supported", "is:root is not supported",
      "before:2026-02-30 needs a real YYYY-MM-DD date", "after:nope needs a real YYYY-MM-DD date",
    ]);
  });

  it("C09-RULE-003 compiles text to inert bounded prefix terms", () => {
    expect(searchMatch('deploy OR "everything" -secret')).toBe('"deploy"* AND "OR"* AND "everything"* AND "secret"*');
    expect(searchMatch("a ! ?")).toBeNull();
    expect(searchMatch("word ".repeat(30))!.split(" AND ")).toHaveLength(16);
  });

  it("C09-RULE-004 bounds pagination cursors", () => {
    expect(searchCursor("40")).toBe(40);
    expect(searchCursor("-1")).toBe(0);
    expect(searchCursor("9999")).toBe(1000);
    expect(nextSearchCursor(20, 20, 41)).toBe("40");
    expect(nextSearchCursor(20, 20, 40)).toBeNull();
  });
});

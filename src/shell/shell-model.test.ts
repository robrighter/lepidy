import { describe, expect, it } from "vitest";

import {
  SHELL_NAV,
  avatarGradient,
  channelHref,
  channelLabel,
  initials,
  nextThemePreference,
  normalisePath,
  parseThemePreference,
  resolveActiveNav,
  resolveTheme,
  sectionTitle,
} from "./shell-model";

const CHANNELS = [
  { id: "channel-eng", slug: "eng", name: "Engineering" },
  { id: "channel-secret", slug: null, name: null },
];

describe("shell navigation rules", () => {
  it.each([
    ["/", "home"],
    ["/inbox", "inbox"],
    ["/inbox/", "inbox"],
    ["/inbox/thread-1", "inbox"],
    ["/agents", "agents"],
    ["/vault", "vault"],
  ])("SHELL-RULE-001 marks %s active as %s", (pathname, expected) => {
    expect(resolveActiveNav(pathname)?.id).toBe(expected);
  });

  it("SHELL-RULE-002 never lights up Home for a deeper section", () => {
    for (const item of SHELL_NAV.filter((entry) => entry.id !== "home")) {
      expect(resolveActiveNav(item.href)?.id).not.toBe("home");
    }
    expect(resolveActiveNav("/c/eng")).toBeNull();
    expect(resolveActiveNav("/profile")).toBeNull();
  });

  it("SHELL-RULE-003 normalises paths without collapsing the root", () => {
    expect(normalisePath("/")).toBe("/");
    expect(normalisePath("/inbox///")).toBe("/inbox");
    expect(normalisePath("inbox")).toBe("/inbox");
  });

  it("SHELL-RULE-004 titles a section, a known channel and an unknown channel", () => {
    expect(sectionTitle("/", CHANNELS)).toBe("Home");
    expect(sectionTitle("/vault", CHANNELS)).toBe("Vault");
    expect(sectionTitle("/profile", CHANNELS)).toBe("Profile");
    expect(sectionTitle("/c/eng", CHANNELS)).toBe("#eng");
    expect(sectionTitle("/c/channel-secret", CHANNELS)).toBe("#channel-secret");
    expect(sectionTitle("/c/ghost", CHANNELS)).toBe("#ghost");
  });

  it("SHELL-RULE-005 builds channel links and labels that survive an odd slug", () => {
    expect(channelHref({ id: "channel-eng", slug: "eng" })).toBe("/c/eng");
    expect(channelHref({ id: "channel-secret", slug: null })).toBe("/c/channel-secret");
    expect(channelHref({ id: "c 1", slug: "a b" })).toBe("/c/a%20b");
    expect(channelLabel(CHANNELS[0])).toBe("eng");
    expect(channelLabel(CHANNELS[1])).toBe("channel-secret");
  });
});

describe("shell identity presentation", () => {
  it("SHELL-RULE-006 derives at most two initials from any principal name", () => {
    expect(initials("Maya Chen")).toBe("MC");
    expect(initials("@a.releasebot")).toBe("AR");
    expect(initials("priya_singh-kaur")).toBe("PS");
    expect(initials("Prince")).toBe("P");
    expect(initials("   ")).toBe("?");
  });

  it("SHELL-RULE-007 gives one name one gradient, always", () => {
    expect(avatarGradient("Maya Chen")).toEqual(avatarGradient("Maya Chen"));
    const distinct = new Set(
      ["Maya Chen", "Daniel Park", "Priya Singh", "Ada Lovelace"].map((name) =>
        avatarGradient(name).join("/"),
      ),
    );
    expect(distinct.size).toBeGreaterThan(1);
  });
});

describe("shell theme rules", () => {
  it("SHELL-RULE-008 falls back to the system preference for anything unrecognised", () => {
    expect(parseThemePreference("dark")).toBe("dark");
    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference("system")).toBe("system");
    expect(parseThemePreference(null)).toBe("system");
    expect(parseThemePreference("neon")).toBe("system");
  });

  it("SHELL-RULE-009 resolves and toggles against what the viewer currently sees", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");

    // Toggling out of "system" commits to the opposite of the rendered theme.
    expect(nextThemePreference("system", true)).toBe("light");
    expect(nextThemePreference("system", false)).toBe("dark");
    expect(nextThemePreference("dark", false)).toBe("light");
    expect(nextThemePreference("light", true)).toBe("dark");
  });
});

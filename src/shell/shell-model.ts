/**
 * Pure shell rules shared by the server layout, the client rail and the tests.
 * Nothing here touches storage, so navigation, identity presentation and theme
 * resolution can be case-tested without a workspace.
 */

export type ShellSection = "home" | "inbox" | "saved" | "scheduled" | "files" | "people" | "agents" | "vault" | "channel" | "profile";

export type ShellNavItem = {
  id: ShellSection;
  label: string;
  href: string;
  /** Every deeper path under this prefix keeps the item active. */
  match: string;
  badge?: number;
};

export const SHELL_NAV: readonly ShellNavItem[] = [
  { id: "home", label: "Home", href: "/", match: "/" },
  { id: "inbox", label: "Inbox", href: "/inbox", match: "/inbox" },
  { id: "saved", label: "Saved", href: "/saved", match: "/saved" },
  { id: "scheduled", label: "Scheduled", href: "/scheduled", match: "/scheduled" },
  { id: "files", label: "Files", href: "/files", match: "/files" },
  { id: "people", label: "People", href: "/people", match: "/people" },
  { id: "agents", label: "Agents", href: "/agents", match: "/agents" },
  { id: "vault", label: "Vault", href: "/vault", match: "/vault" },
] as const;

/**
 * Longest matching prefix wins, and "/" only matches itself, so `/inbox` never
 * lights up Home as well.
 */
export function resolveActiveNav(
  pathname: string,
  items: readonly ShellNavItem[] = SHELL_NAV,
): ShellNavItem | null {
  const path = normalisePath(pathname);
  let best: ShellNavItem | null = null;
  for (const item of items) {
    const match = normalisePath(item.match);
    const matches = match === "/" ? path === "/" : path === match || path.startsWith(`${match}/`);
    if (!matches) continue;
    if (best === null || match.length > normalisePath(best.match).length) best = item;
  }
  return best;
}

export function normalisePath(pathname: string): string {
  if (!pathname.startsWith("/")) return `/${pathname}`.replace(/\/+$/, "") || "/";
  return pathname.replace(/\/+$/, "") || "/";
}

export function channelHref(channel: { slug: string | null; id: string }): string {
  return `/c/${encodeURIComponent(channel.slug ?? channel.id)}`;
}

/** The title the topbar shows for a path, including a channel's own name. */
export function sectionTitle(
  pathname: string,
  channels: readonly { id: string; slug: string | null; name: string | null }[] = [],
): string {
  const path = normalisePath(pathname);
  if (path === "/profile") return "Profile";
  if (path === "/search") return "Search";
  if (path.startsWith("/c/")) {
    const key = decodeURIComponent(path.slice("/c/".length).split("/")[0]);
    const channel = channels.find((item) => item.slug === key || item.id === key);
    return channel ? `#${channelLabel(channel)}` : `#${key}`;
  }
  return resolveActiveNav(path)?.label ?? "Lepidy";
}

export function channelLabel(channel: { slug: string | null; name: string | null; id: string }): string {
  return channel.slug ?? channel.name ?? channel.id;
}

/* -------------------------------------------------------------------------- */
/* Identity presentation                                                       */
/* -------------------------------------------------------------------------- */

/** Up to two initials, ignoring a leading handle sigil and any separator. */
export function initials(name: string): string {
  const words = name.replace(/^[@#]/, "").split(/[\s._\-]+/).filter(Boolean);
  if (words.length === 0) return "?";
  return words
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
}

/** Brand-kit gradient pairs; the same name always gets the same pair. */
export const AVATAR_GRADIENTS: readonly (readonly [string, string])[] = [
  ["#7C3AED", "#C4B5FD"],
  ["#5B8CF5", "#9F5BF5"],
  ["#FF8FA3", "#FFD1C4"],
  ["#34D399", "#A7F3D0"],
  ["#F59E0B", "#FDE68A"],
  ["#6366F1", "#E0E7FF"],
] as const;

export function stableHash(value: string): number {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return Math.abs(hash);
}

export function avatarGradient(name: string): readonly [string, string] {
  return AVATAR_GRADIENTS[stableHash(name) % AVATAR_GRADIENTS.length];
}

/* -------------------------------------------------------------------------- */
/* Theme                                                                       */
/* -------------------------------------------------------------------------- */

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "lepidy-theme";

export function parseThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (preference === "system") return prefersDark ? "dark" : "light";
  return preference;
}

/** Toggling from "system" commits to the opposite of what is currently shown. */
export function nextThemePreference(
  preference: ThemePreference,
  prefersDark: boolean,
): ThemePreference {
  return resolveTheme(preference, prefersDark) === "dark" ? "light" : "dark";
}

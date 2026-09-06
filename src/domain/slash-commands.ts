/**
 * Slash command parsing.
 *
 * This decides what somebody typed, and nothing else. A command never carries
 * authority: `/archive` parses the same whoever types it, and the workspace
 * object decides whether that person may archive anything. Keeping the two
 * apart is what stops a parser change from becoming a permission change.
 */

export type SlashCommandName = "me" | "shrug" | "join" | "leave" | "archive";

export type ComposerInput =
  | { kind: "message"; bodyMarkdown: string }
  | { kind: "command"; name: SlashCommandName; argument: string }
  | { kind: "unknown_command"; typed: string }
  | { kind: "empty" };

export const SHRUG = "¯\\_(ツ)_/¯";

const KNOWN: ReadonlySet<string> = new Set<SlashCommandName>([
  "me",
  "shrug",
  "join",
  "leave",
  "archive",
]);

/** What each command does, for the composer's own help. */
export const SLASH_COMMAND_HELP: readonly { name: SlashCommandName; usage: string; summary: string }[] =
  [
    { name: "me", usage: "/me is looking into it", summary: "Post as an action rather than speech." },
    { name: "shrug", usage: "/shrug no idea", summary: "Append a shrug to your message." },
    { name: "join", usage: "/join", summary: "Join the room you are reading." },
    { name: "leave", usage: "/leave", summary: "Leave the room you are reading." },
    { name: "archive", usage: "/archive", summary: "Archive this room. Admins and its creator only." },
  ];

const COMMAND = /^\/([a-z][a-z0-9-]{0,31})(?:\s+([\s\S]*))?$/i;

/**
 * Classify what the composer should do with what was typed.
 *
 * A body beginning `//` is an escape hatch for anybody who genuinely wants to
 * start a message with a slash; it posts as text with one slash removed.
 */
export function parseComposerInput(raw: string): ComposerInput {
  const body = raw.replace(/^\s+|\s+$/g, "");
  if (body.length === 0) return { kind: "empty" };

  if (body.startsWith("//")) return { kind: "message", bodyMarkdown: body.slice(1) };
  if (!body.startsWith("/")) return { kind: "message", bodyMarkdown: body };

  const match = COMMAND.exec(body);
  if (match === null) return { kind: "unknown_command", typed: body.split(/\s/)[0] };

  const name = match[1].toLowerCase();
  const argument = (match[2] ?? "").trim();
  if (!KNOWN.has(name)) return { kind: "unknown_command", typed: `/${name}` };
  return { kind: "command", name: name as SlashCommandName, argument };
}

/**
 * The text a command posts, or null when it acts on the room instead of saying
 * something. `/me` and `/shrug` are the two that produce a message.
 */
export function commandMessageBody(name: SlashCommandName, argument: string): string | null {
  switch (name) {
    case "me":
      return argument.length === 0 ? null : `_${argument}_`;
    case "shrug":
      return argument.length === 0 ? SHRUG : `${argument} ${SHRUG}`;
    default:
      return null;
  }
}

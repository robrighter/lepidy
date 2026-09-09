export type WorkspaceRole = "owner" | "admin" | "member" | "guest";

/**
 * What a member says about their own availability, as distinct from whether a
 * connection is currently open. `auto` means they have said nothing, so the
 * directory answers from live connections instead.
 */
export type Availability = "auto" | "focus" | "away";
export type Presence = "online" | "focus" | "away" | "offline";
export type MemberStatus = "pending" | "active" | "suspended" | "removed";

export const MAX_GROUP_MENTION_MEMBERS = 50;
export const RESERVED_GROUP_HANDLES = new Set(["g.here", "g.channel", "g.everyone"]);

export function normalizeGroupHandle(raw: string): string {
  const value = raw.trim().normalize("NFKC").toLowerCase().replace(/^@+/, "");
  if (!value) return "";
  return value.startsWith("g.") ? value : `g.${value}`;
}

export function parseGroupHandle(raw: string): string {
  const handle = normalizeGroupHandle(raw);
  if (!/^g\.[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(handle) || handle.length > 64) {
    throw new Error("group handle must be g. followed by letters, numbers and single separators");
  }
  if (RESERVED_GROUP_HANDLES.has(handle)) throw new Error("that group handle is reserved for broadcasts");
  return handle;
}

export function parseAvailability(value: unknown): Availability {
  if (value === "focus" || value === "away") return value;
  if (value === "auto" || value === "" || value === null || value === undefined) return "auto";
  throw new Error("availability must be auto, focus or away");
}

/**
 * A declaration outranks a socket. Somebody who has said they are heads-down
 * stays heads-down while their tabs are open, which is the only reading that
 * makes saying it worth anything.
 */
export function resolvePresence(availability: Availability, connected: boolean): Presence {
  if (availability !== "auto") return availability;
  return connected ? "online" : "offline";
}

export function parseProfile(input: {
  displayName: string;
  title?: string | null;
  timezone?: string | null;
  workingStartMinute?: number | null;
  workingEndMinute?: number | null;
  customStatus?: string | null;
}): {
  displayName: string;
  title: string | null;
  timezone: string | null;
  workingStartMinute: number | null;
  workingEndMinute: number | null;
  customStatus: string | null;
} {
  const displayName = input.displayName.trim().replaceAll(/\s+/g, " ");
  if (displayName.length < 1 || displayName.length > 80) throw new Error("display name must be 1-80 characters");
  const title = boundedOptional(input.title, 100, "title");
  const customStatus = boundedOptional(input.customStatus, 120, "custom status");
  const timezone = boundedOptional(input.timezone, 64, "timezone");
  if (timezone !== null) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: timezone }).format(0);
    } catch {
      throw new Error("timezone must be an IANA timezone");
    }
  }
  const start = minute(input.workingStartMinute);
  const end = minute(input.workingEndMinute);
  if ((start === null) !== (end === null)) throw new Error("working hours need both a start and an end");
  if (start !== null && start === end) throw new Error("working hours cannot span zero minutes");
  return { displayName, title, timezone, workingStartMinute: start, workingEndMinute: end, customStatus };
}

export function mayAdministerMember(input: {
  actorRole: WorkspaceRole;
  actorId: string;
  targetRole: WorkspaceRole;
  targetId: string;
  nextRole?: WorkspaceRole;
  nextStatus?: MemberStatus;
}): boolean {
  if (input.actorRole === "owner") return input.actorId !== input.targetId || input.nextStatus !== "removed";
  if (input.actorRole !== "admin") return false;
  if (input.targetRole === "owner" || input.targetRole === "admin") return false;
  return input.nextRole !== "owner" && input.nextRole !== "admin";
}

export function planGroupMention(input: {
  memberIds: readonly string[];
  senderId: string;
}): readonly string[] {
  if (input.memberIds.length === 0) throw new Error("that group has no active members");
  const targets = [...new Set(input.memberIds.filter((id) => id !== input.senderId))].sort();
  if (targets.length > MAX_GROUP_MENTION_MEMBERS) {
    throw new Error(`that group mentions ${targets.length} people; the limit is ${MAX_GROUP_MENTION_MEMBERS}`);
  }
  return targets;
}

export function ownershipTransferConfirmation(targetHandle: string): string {
  return `transfer ownership to @${targetHandle}`;
}

function boundedOptional(value: string | null | undefined, max: number, label: string): string | null {
  const normalized = value?.trim().replaceAll(/\s+/g, " ") ?? "";
  if (normalized.length > max) throw new Error(`${label} is too long`);
  return normalized || null;
}

function minute(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < 0 || value > 1439) throw new Error("working hour minute is invalid");
  return value;
}

export type MentionCard = {
  kind: "member" | "group" | "agent";
  handle: string;
  title: string;
  subtitle: string;
  status: string | null;
  facts: readonly string[];
};

/** Presence as a word, because a coloured dot alone tells a screen reader nothing. */
export function presenceLabel(presence: Presence): string {
  switch (presence) {
    case "online": return "Active";
    case "focus": return "Focus";
    case "away": return "Away";
    case "offline": return "Offline";
  }
}

export function formatWorkingHours(start: number | null, end: number | null): string {
  if (start === null || end === null) return "Working hours not set";
  return `${formatMinuteOfDay(start)}–${formatMinuteOfDay(end)}`;
}

export function formatMinuteOfDay(minuteOfDay: number): string {
  return `${String(Math.floor(minuteOfDay / 60)).padStart(2, "0")}:${String(minuteOfDay % 60).padStart(2, "0")}`;
}

/**
 * A member's own clock. An unset or unrecognised zone says so rather than
 * quietly showing the reader's own time as if it were the other person's.
 */
export function formatLocalTime(timezone: string | null, now: Date): string {
  if (!timezone) return "Timezone not set";
  try {
    const time = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(now);
    return `${timezone} · ${time}`;
  } catch {
    return "Timezone not set";
  }
}

/**
 * The facts behind a mention hovercard.
 *
 * A card repeats what the directory already shows the same reader; it is a
 * convenience, not a second visibility rule. So it is built only from a
 * directory the caller was already authorized to read, and a handle absent
 * from that directory gets no card at all rather than a "no such person"
 * disclosure.
 */
export function buildMentionCards(
  directory: {
    agents?: readonly {
      handle: string; displayName: string; description: string | null;
      status: "active" | "paused" | "archived"; ownerIds: readonly string[];
    }[];
    people: readonly {
      id: string; handle: string; displayName: string; role: WorkspaceRole; status: MemberStatus;
      title: string | null; customStatus: string | null; timezone: string | null;
      workingStartMinute: number | null; workingEndMinute: number | null;
      presence: Presence; ownedAgentCount: number;
    }[];
    groups: readonly {
      handle: string; displayName: string; description: string | null; memberIds: readonly string[];
    }[];
  },
  now: Date,
): ReadonlyMap<string, MentionCard> {
  const cards = new Map<string, MentionCard>();
  const nameById = new Map(directory.people.map((person) => [person.id, person.displayName]));

  for (const person of directory.people) {
    const facts = [
      person.status === "active" ? presenceLabel(person.presence) : "No longer in this workspace",
      formatLocalTime(person.timezone, now),
      formatWorkingHours(person.workingStartMinute, person.workingEndMinute),
      `${person.ownedAgentCount} agent${person.ownedAgentCount === 1 ? "" : "s"}`,
    ];
    cards.set(person.handle, {
      kind: "member",
      handle: person.handle,
      title: person.displayName,
      subtitle: person.title ? `${person.role} · ${person.title}` : person.role,
      status: person.customStatus,
      facts,
    });
  }

  for (const group of directory.groups) {
    // Members are named, not counted alone: a group mention reaches people, and
    // the reader deserves to know which ones before they send it.
    const named = group.memberIds.map((id) => nameById.get(id)).filter((name): name is string => Boolean(name));
    const shown = named.slice(0, 8);
    const remainder = named.length - shown.length;
    cards.set(group.handle, {
      kind: "group",
      handle: group.handle,
      title: group.displayName,
      subtitle: `${named.length} active member${named.length === 1 ? "" : "s"}`,
      status: group.description,
      facts: named.length === 0
        ? ["This group has no active members"]
        : [shown.join(", ") + (remainder > 0 ? ` and ${remainder} more` : "")],
    });
  }

  for (const agent of directory.agents ?? []) {
    // PRD §6.2: an agent's owners are visible everywhere the agent is. A
    // mention hands the message to every owner whether or not they could open
    // the room, so an owner this reader cannot name is still counted out loud
    // rather than silently dropped from the list.
    const named = agent.ownerIds.map((id) => nameById.get(id)).filter((name): name is string => Boolean(name));
    const unnamed = agent.ownerIds.length - named.length;
    const owners = agent.ownerIds.length === 0
      ? "Nobody owns this agent"
      : `Owned by ${[...named, ...(unnamed > 0 ? [`${unnamed} more`] : [])].join(", ")}`;
    cards.set(agent.handle, {
      kind: "agent",
      handle: agent.handle,
      title: agent.displayName,
      subtitle: agent.status === "active" ? "agent" : `agent · ${agent.status}`,
      status: agent.description,
      facts: [owners],
    });
  }

  return cards;
}

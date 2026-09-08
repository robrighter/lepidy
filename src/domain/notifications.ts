export const NOTIFY_LEVELS = ["everything", "mentions", "nothing", "mute"] as const;
export type NotifyLevel = (typeof NOTIFY_LEVELS)[number];

export type NotificationKind = "mention" | "thread_reply" | "dm" | "keyword" | "channel";

export type NotificationDecision = {
  inbox: boolean;
  badge: boolean;
  push: boolean;
  reason: string;
};

export function parseNotifyLevel(value: unknown): NotifyLevel | null {
  return NOTIFY_LEVELS.includes(value as NotifyLevel) ? (value as NotifyLevel) : null;
}

/**
 * One rule for every delivery surface. Agent traffic is deliberately quieter:
 * only an explicit address or subscribed-thread reply reaches the default
 * `mentions` tier. `everything` is the explicit opt-in that raises agents to
 * parity. `nothing` keeps an Inbox record but sends no interrupt; `mute` hides
 * ordinary room activity completely. Approvals use their own always-notify
 * path and never call this rule.
 */
export function decideMessageNotification(input: {
  level: NotifyLevel;
  kind: NotificationKind;
  authorKind: "member" | "agent";
  dndActive: boolean;
  keywordMatched?: boolean;
  broadcast?: boolean;
}): NotificationDecision {
  const directed = input.kind === "mention" || input.kind === "thread_reply" || input.kind === "dm" || input.broadcast === true;
  if (input.level === "mute") {
    return { inbox: false, badge: false, push: false, reason: "room_muted" };
  }

  const inbox = input.level === "nothing" || directed || input.kind === "keyword" || input.level === "everything";
  const badge = input.level !== "nothing" && inbox;
  let eligible = directed || input.keywordMatched === true || input.level === "everything";
  if (input.level === "mentions" && !directed && input.keywordMatched !== true) eligible = false;
  if (input.level === "nothing") eligible = false;
  if (input.authorKind === "agent" && !directed && input.level !== "everything") eligible = false;
  const push = eligible && !input.dndActive;
  return {
    inbox,
    badge,
    push,
    reason: push ? "eligible" : input.dndActive && eligible ? "dnd" : "preference",
  };
}

export function isDndActive(input: {
  minuteOfDay: number;
  startMinute: number | null;
  endMinute: number | null;
  manualUntil: number | null;
  now: number;
}): boolean {
  if (input.manualUntil !== null && input.manualUntil > input.now) return true;
  if (input.startMinute === null || input.endMinute === null || input.startMinute === input.endMinute) return false;
  if (input.startMinute < input.endMinute) {
    return input.minuteOfDay >= input.startMinute && input.minuteOfDay < input.endMinute;
  }
  return input.minuteOfDay >= input.startMinute || input.minuteOfDay < input.endMinute;
}

export function notificationIsVisible(input: {
  channelKind: "public" | "private" | "dm" | "group_dm";
  isCurrentMember: boolean;
  privateItem: boolean;
  privateItemAllowed: boolean;
}): boolean {
  const roomVisible = input.channelKind === "public" || input.isCurrentMember;
  return roomVisible && (!input.privateItem || input.privateItemAllowed);
}

export function mayUseBroadcast(input: {
  actorRole: "owner" | "admin" | "member" | "guest";
  channelAllowsMembers: boolean;
  confirmedRecipientCount: number | null;
  actualRecipientCount: number;
}): boolean {
  const permitted = input.actorRole === "owner" || input.actorRole === "admin" || input.channelAllowsMembers;
  return permitted && input.actualRecipientCount > 0 && input.confirmedRecipientCount === input.actualRecipientCount;
}

export function homeRank(input: {
  kind: NotificationKind | "approval";
  unread: boolean;
  createdAt: number;
}): number {
  const weight = input.kind === "approval" ? 50 : input.kind === "mention" ? 40 : input.kind === "thread_reply" ? 30 : input.kind === "dm" ? 25 : input.kind === "keyword" ? 20 : 10;
  return (input.unread ? 100 : 0) + weight + Math.min(Math.floor(input.createdAt / 86_400_000), 10_000_000);
}

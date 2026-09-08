import { describe, expect, it } from "vitest";
import { decideMessageNotification, homeRank, isDndActive, mayUseBroadcast, notificationIsVisible } from "./notifications";

describe("notification rules", () => {
  it("C06-RULE-001 keeps agent traffic quiet unless it is directed or explicitly raised", () => {
    expect(decideMessageNotification({ level: "mentions", kind: "channel", authorKind: "agent", dndActive: false })).toMatchObject({ inbox: false, push: false });
    expect(decideMessageNotification({ level: "mentions", kind: "thread_reply", authorKind: "agent", dndActive: false })).toMatchObject({ inbox: true, badge: true, push: true });
    expect(decideMessageNotification({ level: "everything", kind: "channel", authorKind: "agent", dndActive: false })).toMatchObject({ inbox: true, push: true });
  });

  it("C06-RULE-002 distinguishes nothing from mute and lets DND suppress interruption", () => {
    expect(decideMessageNotification({ level: "nothing", kind: "mention", authorKind: "member", dndActive: false })).toMatchObject({ inbox: true, badge: false, push: false });
    expect(decideMessageNotification({ level: "nothing", kind: "channel", authorKind: "member", dndActive: false })).toMatchObject({ inbox: true, badge: false, push: false });
    expect(decideMessageNotification({ level: "mute", kind: "mention", authorKind: "member", dndActive: false })).toMatchObject({ inbox: false, badge: false, push: false });
    expect(decideMessageNotification({ level: "mentions", kind: "mention", authorKind: "member", dndActive: true })).toMatchObject({ inbox: true, push: false, reason: "dnd" });
    expect(decideMessageNotification({ level: "mentions", kind: "channel", authorKind: "member", dndActive: false, broadcast: true })).toMatchObject({ inbox: true, badge: true, push: true });
  });

  it("C06-RULE-003 handles overnight and manual DND windows", () => {
    expect(isDndActive({ minuteOfDay: 30, startMinute: 1320, endMinute: 420, manualUntil: null, now: 100 })).toBe(true);
    expect(isDndActive({ minuteOfDay: 800, startMinute: 1320, endMinute: 420, manualUntil: null, now: 100 })).toBe(false);
    expect(isDndActive({ minuteOfDay: 800, startMinute: null, endMinute: null, manualUntil: 101, now: 100 })).toBe(true);
  });

  it("C06-RULE-004 applies room and private-item visibility together", () => {
    expect(notificationIsVisible({ channelKind: "private", isCurrentMember: false, privateItem: false, privateItemAllowed: false })).toBe(false);
    expect(notificationIsVisible({ channelKind: "public", isCurrentMember: false, privateItem: true, privateItemAllowed: false })).toBe(false);
    expect(notificationIsVisible({ channelKind: "public", isCurrentMember: false, privateItem: true, privateItemAllowed: true })).toBe(true);
  });

  it("C06-RULE-005 gates broadcasts on authority and an exact recipient confirmation", () => {
    expect(mayUseBroadcast({ actorRole: "member", channelAllowsMembers: false, confirmedRecipientCount: 8, actualRecipientCount: 8 })).toBe(false);
    expect(mayUseBroadcast({ actorRole: "admin", channelAllowsMembers: false, confirmedRecipientCount: 7, actualRecipientCount: 8 })).toBe(false);
    expect(mayUseBroadcast({ actorRole: "admin", channelAllowsMembers: false, confirmedRecipientCount: 8, actualRecipientCount: 8 })).toBe(true);
  });

  it("C06-RULE-006 ranks unread approvals, mentions and threads deterministically", () => {
    const at = 1_800_000_000_000;
    expect(homeRank({ kind: "approval", unread: true, createdAt: at })).toBeGreaterThan(homeRank({ kind: "mention", unread: true, createdAt: at }));
    expect(homeRank({ kind: "mention", unread: true, createdAt: at })).toBeGreaterThan(homeRank({ kind: "thread_reply", unread: true, createdAt: at }));
    expect(homeRank({ kind: "thread_reply", unread: true, createdAt: at })).toBeGreaterThan(homeRank({ kind: "thread_reply", unread: false, createdAt: at }));
  });
});

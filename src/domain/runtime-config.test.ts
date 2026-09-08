import { describe, expect, it } from "vitest";

import {
  decideLocalStart,
  defaultDelegationExpiry,
  delegationSentence,
  describeRun,
  expiryPhrase,
  formatMoney,
  formatShortDate,
  isLocalPresetIntent,
  isLocalStartPolicy,
  isRuntimeKind,
  joinWithAnd,
  LOCAL_PRESET_INTENTS,
  localPresetIntentLabel,
  localPresetRequestIsConfirmed,
  parseBudgetDollars,
  runNeedsAttention,
  runtimeIsAttended,
  type RunHistoryRow,
} from "./runtime-config";

/**
 * The runtime screen's rules (R05).
 *
 * Case tables, because each of these is asked by more than one caller and a
 * second copy of any of them would eventually disagree. The two that carry
 * security weight are the start decision — which decides whether a message from
 * a stranger causes a process to run on a colleague's laptop — and the pending
 * rule, which must never report a local change confirmed on anything except the
 * machine's own revision moving.
 */

const NOW = 1_800_000_000_000;

describe("RUNTIME-RULE-001 runtime kinds", () => {
  it("accepts the four runtimes and nothing else", () => {
    for (const kind of ["connected", "local", "claude_cloud", "custom"]) {
      expect(isRuntimeKind(kind)).toBe(true);
    }
    for (const value of ["", "cloud", "LOCAL", "connected ", null, 3, {}]) {
      expect(isRuntimeKind(value)).toBe(false);
    }
  });

  it("treats exactly one runtime as attended", () => {
    expect(runtimeIsAttended("connected")).toBe(true);
    expect(runtimeIsAttended("local")).toBe(false);
    expect(runtimeIsAttended("claude_cloud")).toBe(false);
    expect(runtimeIsAttended("custom")).toBe(false);
  });
});

describe("RUNTIME-RULE-002 who may start a session", () => {
  const owners = ["member-maya", "member-dan"];

  it.each([
    ["an owner under the open policy", true, "scope" as const, "member-maya", true],
    ["a stranger under the open policy", true, "scope" as const, "member-priya", true],
    ["an owner under owners-only", true, "owners" as const, "member-dan", true],
    ["a stranger under owners-only", true, "owners" as const, "member-priya", false],
    ["an owner while start-on-mention is off", false, "scope" as const, "member-maya", false],
    ["a stranger while start-on-mention is off", false, "owners" as const, "member-priya", false],
  ])("%s", (_label, startOnMention, whoMayStart, requesterMemberId, expected) => {
    expect(
      decideLocalStart({ startOnMention, whoMayStart, requesterMemberId, ownerMemberIds: owners }).start,
    ).toBe(expected);
  });

  it("says which brake stopped it, so the page can explain itself", () => {
    expect(
      decideLocalStart({ startOnMention: false, whoMayStart: "scope", requesterMemberId: "member-maya", ownerMemberIds: owners }),
    ).toEqual({ start: false, reason: "start_on_mention_is_off" });
    expect(
      decideLocalStart({ startOnMention: true, whoMayStart: "owners", requesterMemberId: "member-priya", ownerMemberIds: owners }),
    ).toEqual({ start: false, reason: "requester_is_not_an_owner" });
  });

  it("refuses an empty requester under owners-only", () => {
    // An agent-authored or system-authored mention has no member behind it.
    // Under owners-only that is not an owner, and it must not be read as one.
    expect(
      decideLocalStart({ startOnMention: true, whoMayStart: "owners", requesterMemberId: "", ownerMemberIds: owners }).start,
    ).toBe(false);
  });

  it("accepts only the two policies", () => {
    expect(isLocalStartPolicy("scope")).toBe(true);
    expect(isLocalStartPolicy("owners")).toBe(true);
    for (const value of ["everyone", "", "Owners", null, 1]) expect(isLocalStartPolicy(value)).toBe(false);
  });
});

describe("RUNTIME-RULE-003 asking a machine to look at its own preset", () => {
  it("accepts only the closed set of intents", () => {
    for (const intent of LOCAL_PRESET_INTENTS) expect(isLocalPresetIntent(intent)).toBe(true);
    // Anything that could carry a command, a path or free text is not an intent.
    for (const value of [
      "run /bin/sh",
      "review_preset --program /bin/sh",
      "approve_agent ",
      "",
      null,
      { intent: "review_preset" },
    ]) {
      expect(isLocalPresetIntent(value)).toBe(false);
    }
  });

  it("gives every intent a sentence a person can act on", () => {
    for (const intent of LOCAL_PRESET_INTENTS) {
      expect(localPresetIntentLabel(intent).length).toBeGreaterThan(8);
    }
  });

  it("stays pending until the machine's own revision moves", () => {
    expect(localPresetRequestIsConfirmed({ revisionAtRequest: 14, currentRevision: 14 })).toBe(false);
    expect(localPresetRequestIsConfirmed({ revisionAtRequest: 14, currentRevision: 13 })).toBe(false);
    expect(localPresetRequestIsConfirmed({ revisionAtRequest: 14, currentRevision: 15 })).toBe(true);
  });
});

describe("RUNTIME-RULE-004 the delegation sentence", () => {
  it("reads as the sentence the product promised", () => {
    expect(
      delegationSentence({
        ownerHandle: "maya",
        channelNames: ["billing", "support"],
        credentialNames: ["STRIPE_TEST", "SENTRY_TOKEN"],
        expiresAt: Date.UTC(2026, 9, 5),
        spendCapDailyCents: 2000,
      }),
    ).toBe(
      "Runs as @maya in #billing and #support until 5 Oct 2026. May use STRIPE_TEST and SENTRY_TOKEN. Spend cap $20.00/day.",
    );
  });

  it("says 'no room' rather than reading an empty list as unrestricted", () => {
    const sentence = delegationSentence({
      ownerHandle: "dan",
      channelNames: [],
      credentialNames: [],
      expiresAt: Date.UTC(2026, 0, 1),
      spendCapDailyCents: null,
    });
    expect(sentence).toBe("Runs as @dan in no room until 1 Jan 2026. May use no credential.");
    expect(sentence).not.toContain("Spend cap");
  });

  it("distinguishes 'every room in scope' from a list", () => {
    expect(
      delegationSentence({
        ownerHandle: "maya",
        channelNames: null,
        credentialNames: ["GITHUB_TOKEN"],
        expiresAt: Date.UTC(2026, 9, 5),
        spendCapDailyCents: null,
      }),
    ).toBe("Runs as @maya in every room it is in scope for until 5 Oct 2026. May use GITHUB_TOKEN.");
  });

  it("joins lists the way a person would say them", () => {
    expect(joinWithAnd([])).toBe("");
    expect(joinWithAnd(["one"])).toBe("one");
    expect(joinWithAnd(["one", "two"])).toBe("one and two");
    expect(joinWithAnd(["one", "two", "three"])).toBe("one, two and three");
  });

  it("reads the same date for every reader", () => {
    expect(formatShortDate(Date.UTC(2026, 9, 5, 23, 30))).toBe("5 Oct 2026");
  });
});

describe("RUNTIME-RULE-005 expiry", () => {
  it.each([
    [NOW - 1, "expired"],
    [NOW, "expired"],
    [NOW + 90_000, "1 minute left"],
    [NOW + 8 * 60_000, "8 minutes left"],
    [NOW + 5 * 3_600_000, "5 hours left"],
    [NOW + 9 * 86_400_000, "9 days left"],
  ])("phrases %s as %s", (expiresAt, expected) => {
    expect(expiryPhrase(expiresAt, NOW)).toBe(expected);
  });

  it("defaults to thirty days", () => {
    expect(defaultDelegationExpiry(NOW)).toBe(NOW + 30 * 86_400_000);
  });
});

describe("RUNTIME-RULE-006 run history", () => {
  const row = (over: Partial<RunHistoryRow>): RunHistoryRow => ({
    id: "run-1",
    kind: "scheduled",
    state: "succeeded",
    failureCode: null,
    budgetCents: 500,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  });

  it("names a budget stop as a budget stop wherever it appears", () => {
    expect(describeRun(row({ state: "idle", failureCode: "budget_exceeded" }))).toEqual({
      tone: "warn",
      label: "Stopped at its spending limit",
    });
    expect(describeRun(row({ state: "failed", failureCode: "budget_exceeded" })).label).toBe(
      "Stopped at its spending limit",
    );
  });

  it("explains a run that never started, in plain words", () => {
    expect(describeRun(row({ state: "failed", failureCode: "environment_archived" }))).toEqual({
      tone: "alert",
      label: "Did not start — the environment is archived",
    });
    expect(describeRun(row({ state: "failed", failureCode: "rate_limited" })).label).toContain("next occurrence");
    expect(describeRun(row({ state: "failed", failureCode: null })).label).toBe("Failed");
    // A code nobody has written a sentence for still has to read as words.
    expect(describeRun(row({ state: "failed", failureCode: "provider_failed" })).label).toBe("Failed — provider failed");
  });

  it("separates what somebody must chase from what nobody must", () => {
    expect(runNeedsAttention(row({ state: "succeeded" }))).toBe(false);
    expect(runNeedsAttention(row({ state: "running" }))).toBe(false);
    expect(runNeedsAttention(row({ state: "queued" }))).toBe(false);
    expect(runNeedsAttention(row({ state: "idle", failureCode: "budget_exceeded" }))).toBe(true);
    expect(runNeedsAttention(row({ state: "failed", failureCode: "environment_archived" }))).toBe(true);
  });
});

describe("RUNTIME-RULE-007 budgets", () => {
  it.each([
    ["5", 500],
    ["5.00", 500],
    ["$12.34", 1234],
    ["0.01", 1],
  ])("parses %s", (value, cents) => {
    expect(parseBudgetDollars(value)).toEqual({ cents });
  });

  it.each(["", "0", "0.00", "-5", "5.005", "1e3", "five", "9999999999", "5,00"])(
    "refuses %s rather than rounding it",
    (value) => {
      expect(parseBudgetDollars(value)).toHaveProperty("error");
    },
  );

  it("formats what it parsed", () => {
    expect(formatMoney(500)).toBe("$5.00");
    expect(formatMoney(1)).toBe("$0.01");
  });
});

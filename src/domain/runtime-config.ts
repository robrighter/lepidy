/**
 * The rules behind the runtime configuration screen.
 *
 * Four runtimes, one question: is a human at the keyboard? That answer decides
 * where an agent's authority comes from, so it decides what the screen may
 * offer. Everything here is pure, because each of these rules is asked by more
 * than one caller — the workspace when it decides whether a mention wakes a
 * machine, the page when it decides what to render, and the tests that hold
 * both to the same answer.
 *
 * The rule that matters most is the one that is *absent*: nothing in this file
 * describes, validates or formats an executable, an argument, a directory, an
 * environment value or a resource limit. Launch configuration has one author
 * and it is the machine that runs it (D05a). What a remote page may do about a
 * local preset is ask for it to be looked at, and wait.
 */

export const RUNTIME_KINDS = ["connected", "local", "claude_cloud", "custom"] as const;
export type RuntimeKind = (typeof RUNTIME_KINDS)[number];

/** The two runtimes a person can pick without configuring a provider first. */
export const SELF_SERVE_RUNTIME_KINDS = ["connected", "local"] as const;
export type SelfServeRuntimeKind = (typeof SELF_SERVE_RUNTIME_KINDS)[number];

export function isRuntimeKind(value: unknown): value is RuntimeKind {
  return typeof value === "string" && (RUNTIME_KINDS as readonly string[]).includes(value);
}

/** Whether an unattended runtime needs a delegation to act at all. */
export function runtimeIsAttended(kind: RuntimeKind): boolean {
  return kind === "connected";
}

/* -------------------------------------------------------------------------- */
/* Who may cause a process to start on somebody's machine                      */
/* -------------------------------------------------------------------------- */

export const LOCAL_START_POLICIES = ["scope", "owners"] as const;
export type LocalStartPolicy = (typeof LOCAL_START_POLICIES)[number];

export function isLocalStartPolicy(value: unknown): value is LocalStartPolicy {
  return typeof value === "string" && (LOCAL_START_POLICIES as readonly string[]).includes(value);
}

export type LocalStartDecision =
  | { start: true }
  | { start: false; reason: "start_on_mention_is_off" | "requester_is_not_an_owner" };

/**
 * Whether this mention may wake the machine.
 *
 * Deliberately separate from `decideEnqueue`: the work is still queued either
 * way. Refusing to *start* is not refusing to *hear* — the item waits for an
 * owner to start a session by hand, and the sender is not left believing their
 * message went nowhere. Collapsing the two would silently discard work, which
 * is the failure this codebase keeps re-learning.
 */
export function decideLocalStart(input: {
  startOnMention: boolean;
  whoMayStart: LocalStartPolicy;
  requesterMemberId: string;
  ownerMemberIds: readonly string[];
}): LocalStartDecision {
  if (!input.startOnMention) return { start: false, reason: "start_on_mention_is_off" };
  if (input.whoMayStart === "owners" && !input.ownerMemberIds.includes(input.requesterMemberId)) {
    return { start: false, reason: "requester_is_not_an_owner" };
  }
  return { start: true };
}

/* -------------------------------------------------------------------------- */
/* Asking a machine to look at its own preset                                  */
/* -------------------------------------------------------------------------- */

/**
 * What a remote owner may ask a machine to do about its local configuration.
 *
 * A closed set of intents with no parameters, and that is the entire point. A
 * free-text field here would be a launch-configuration channel with extra
 * steps: whatever a person could type, an attacker with the same authority
 * could type too, and the machine would be reading instructions off the
 * network. An intent says which conversation to have; the change itself happens
 * in front of somebody on that computer.
 */
export const LOCAL_PRESET_INTENTS = [
  "approve_agent",
  "review_preset",
  "revalidate_harness",
  "review_limits",
] as const;
export type LocalPresetIntent = (typeof LOCAL_PRESET_INTENTS)[number];

export function isLocalPresetIntent(value: unknown): value is LocalPresetIntent {
  return typeof value === "string" && (LOCAL_PRESET_INTENTS as readonly string[]).includes(value);
}

export function localPresetIntentLabel(intent: LocalPresetIntent): string {
  switch (intent) {
    case "approve_agent":
      return "Allow this agent to start sessions";
    case "review_preset":
      return "Review the launch preset";
    case "revalidate_harness":
      return "Re-check the harness version";
    case "review_limits":
      return "Review the local limits";
  }
}

/**
 * A request is answered when the machine's configuration has moved on.
 *
 * The revision is the machine's own counter, incremented locally by an edit
 * that required an operating-system verification gesture and reported on the
 * next signed registration. So "confirmed" here means a person was physically
 * at that computer after the ask — which no cloud state could assert on its
 * own, and which is why the pending state has to be visible rather than
 * optimistic.
 */
export function localPresetRequestIsConfirmed(input: {
  revisionAtRequest: number;
  currentRevision: number;
}): boolean {
  return input.currentRevision > input.revisionAtRequest;
}

/* -------------------------------------------------------------------------- */
/* The delegation, as one English sentence                                     */
/* -------------------------------------------------------------------------- */

export type DelegationSentenceInput = {
  ownerHandle: string;
  /** `null` means every room the agent is in scope for. */
  channelNames: readonly string[] | null;
  credentialNames: readonly string[];
  expiresAt: number;
  spendCapDailyCents: number | null;
};

/**
 * "Runs as Maya in #billing and #support until 5 Oct. May use STRIPE_TEST and
 * SENTRY_TOKEN. Spend cap $20/day."
 *
 * A permission nobody can restate is a permission nobody is supervising, so the
 * product owes the reader one sentence rather than four fields they have to
 * assemble themselves. It is built here, once, and the page and the tests read
 * the same string.
 */
export function delegationSentence(input: DelegationSentenceInput): string {
  const where =
    input.channelNames === null
      ? "in every room it is in scope for"
      : input.channelNames.length === 0
        ? "in no room"
        : `in ${joinWithAnd(input.channelNames.map((name) => `#${name}`))}`;
  const until = formatShortDate(input.expiresAt);
  const sentences = [`Runs as @${input.ownerHandle} ${where} until ${until}.`];
  sentences.push(
    input.credentialNames.length === 0
      ? "May use no credential."
      : `May use ${joinWithAnd([...input.credentialNames])}.`,
  );
  if (input.spendCapDailyCents !== null) {
    sentences.push(`Spend cap ${formatMoney(input.spendCapDailyCents)}/day.`);
  }
  return sentences.join(" ");
}

/** How long is left, in the words a person would use out loud. */
export function expiryPhrase(expiresAt: number, now: number): string {
  const remaining = expiresAt - now;
  if (remaining <= 0) return "expired";
  const days = Math.floor(remaining / 86_400_000);
  if (days >= 2) return `${days} days left`;
  const hours = Math.floor(remaining / 3_600_000);
  if (hours >= 2) return `${hours} hours left`;
  const minutes = Math.max(1, Math.floor(remaining / 60_000));
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"} left`;
}

/** Default 30 days, and the ceiling A04 already enforces is separate. */
export const DELEGATION_DEFAULT_DAYS = 30;

export function defaultDelegationExpiry(now: number): number {
  return now + DELEGATION_DEFAULT_DAYS * 86_400_000;
}

/* -------------------------------------------------------------------------- */
/* Run history                                                                 */
/* -------------------------------------------------------------------------- */

export type RunTone = "ok" | "warn" | "alert" | "quiet";

export type RunHistoryRow = {
  id: string;
  kind: "mention" | "scheduled" | "manual";
  state: "queued" | "starting" | "running" | "idle" | "succeeded" | "failed" | "terminated";
  failureCode: string | null;
  budgetCents: number | null;
  createdAt: number;
  updatedAt: number;
};

/**
 * What a row of the run history says, in words rather than a state name.
 *
 * A failure that reads `failed` tells a person nothing they can act on, and the
 * whole reason this table exists is that a nightly job which quietly stopped
 * working must be noticed the next morning rather than the next quarter.
 */
export function describeRun(row: RunHistoryRow): { tone: RunTone; label: string } {
  switch (row.state) {
    case "succeeded":
      return { tone: "ok", label: "Finished" };
    case "queued":
      return { tone: "quiet", label: "Waiting to start" };
    case "starting":
      return { tone: "quiet", label: "Starting" };
    case "running":
      return { tone: "ok", label: "Working now" };
    case "idle":
      return row.failureCode === "budget_exceeded"
        ? { tone: "warn", label: "Stopped at its spending limit" }
        : { tone: "quiet", label: "Waiting for more work" };
    case "terminated":
      return { tone: "warn", label: "Stopped" };
    case "failed":
      return { tone: "alert", label: failureLabel(row.failureCode) };
  }
}

function failureLabel(code: string | null): string {
  switch (code) {
    case "budget_exceeded":
      return "Stopped at its spending limit";
    case "environment_archived":
      return "Did not start — the environment is archived";
    case "rate_limited":
      return "Did not start — rate limited, it will try at the next occurrence";
    case "provider_unauthorized":
      return "Did not start — the provider refused this workspace's authority";
    case "delivery_failed":
      return "The callback could not be delivered";
    case null:
      return "Failed";
    default:
      return `Failed — ${code.replace(/_/g, " ")}`;
  }
}

/** A run nobody has to chase, versus one somebody does. */
export function runNeedsAttention(row: RunHistoryRow): boolean {
  return describeRun(row).tone === "alert" || describeRun(row).tone === "warn";
}

/* -------------------------------------------------------------------------- */
/* Budgets                                                                     */
/* -------------------------------------------------------------------------- */

export const MAX_BUDGET_CENTS = 1_000_000;

/**
 * A budget a person typed, in dollars, turned into the integer cents the
 * provider takes — or a refusal saying which way it was wrong.
 *
 * Refused rather than rounded: a cap is the strongest spend control in the
 * product, and quietly turning `$0.005` into `$0.01` or `1e3` into something
 * surprising is not a thing a spend control should do.
 */
export function parseBudgetDollars(value: string): { cents: number } | { error: string } {
  const trimmed = value.trim().replace(/^\$/, "");
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(trimmed)) {
    return { error: "Give the cap in dollars, like 5 or 5.00." };
  }
  const cents = Math.round(Number(trimmed) * 100);
  if (cents < 1) return { error: "A cap has to be at least one cent." };
  if (cents > MAX_BUDGET_CENTS) return { error: "That is above the largest cap this form accepts." };
  return { cents };
}

export function formatMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/* -------------------------------------------------------------------------- */
/* Small shared formatting                                                     */
/* -------------------------------------------------------------------------- */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** UTC, deliberately: a shared sentence must not read differently per reader. */
export function formatShortDate(at: number): string {
  const date = new Date(at);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

export function joinWithAnd(values: readonly string[]): string {
  if (values.length === 0) return "";
  if (values.length === 1) return values[0];
  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`;
}

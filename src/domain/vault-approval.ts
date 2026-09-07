import { assertOpaqueId } from "./vault-envelope";
import { MAX_VAULT_GRANT_TTL_MS, type VaultPolicy } from "./vault-policy";
import type { VaultDelivery } from "./vault-authorization";

/**
 * The rules behind approval as a conversation.
 *
 * An approval is a message a person answers, not a modal they dismiss, and that
 * changes what the rules have to guarantee. Two owners may open the same card on
 * two phones, so the first terminal answer has to win and the second has to be
 * told what happened. Nobody is watching, so the request has to end by itself.
 * And because the card is the only place the decision is made, everything the
 * approver needs in order to decide has to be in it — which is why the reason is
 * mandatory and why a batch may only ever coalesce requests that are genuinely
 * the same question asked about several credentials.
 */

/**
 * Five minutes, from PRD §8.6, and deliberately longer than a local modal's
 * sixty seconds: the human may be walking to a meeting, and an agent told to
 * come back later is better than one told it was denied.
 */
export const VAULT_APPROVAL_TTL_MS = 5 * 60_000;

/** One command's worth of credentials. Past this it is not a card, it is a form. */
export const MAX_APPROVAL_CREDENTIALS = 10;

export const MAX_APPROVAL_REASON_LENGTH = 500;

/** The reserved identity every approval and announcement is spoken by. */
export const VAULT_AGENT_HANDLE = "a.vault";

/**
 * The key of the conversation between one member and the vault.
 *
 * Its own namespace, so it can never collide with the digest of a conversation
 * between people however the participant ids fall.
 */
export function vaultDirectMessageKey(memberId: string): string {
  assertOpaqueId(memberId, "member id");
  return `vault-dm:${memberId}`;
}

/** Fifteen minutes exists so one work session does not produce forty cards. */
export const APPROVAL_WINDOW_MS = { fifteen_minutes: 15 * 60_000, session: MAX_VAULT_GRANT_TTL_MS } as const;

export type ApprovalWindow = "once" | "fifteen_minutes" | "session";
export type ApprovalOutcome = "allowed" | "denied";
export type ApprovalStatus = "pending" | "allowed" | "denied" | "expired";

/**
 * The tuple every credential in one batch must share.
 *
 * These are exactly the fields the approver is shown and reasons about: who is
 * asking, from where, for what and why. Two requests that differ in any of them
 * are two different questions and must not be coalesced into one card, however
 * close together they arrive.
 */
export type ApprovalRequestTuple = {
  requesterMemberId: string;
  agentId?: string;
  delegationId?: string;
  deviceId: string;
  projectId: string;
  originChannelId: string;
  originMessageId: string;
  delivery: VaultDelivery;
  reason: string;
};

export type ApprovalItem = {
  credentialId: string;
  name: string;
  version: number;
  policyEpoch: number;
};

export type ApprovalDecisionInput = {
  credentialId: string;
  outcome: ApprovalOutcome;
  window: ApprovalWindow;
};

/**
 * A reason is mandatory in the tool schema so the prompt is never
 * uninformative. An empty one is a refusal to state the case, not a request.
 */
export function normalizeApprovalReason(value: unknown): string {
  if (typeof value !== "string") throw new Error("a reason is required to request a credential");
  const trimmed = value.replaceAll(/[\r\n]+/gu, " ").trim().normalize("NFC");
  if (trimmed.length === 0) throw new Error("a reason is required to request a credential");
  if (trimmed.length > MAX_APPROVAL_REASON_LENGTH) throw new Error("that reason is too long");
  return trimmed;
}

export function validateApprovalTuple(tuple: ApprovalRequestTuple): ApprovalRequestTuple {
  for (const [field, value] of [
    ["requester member id", tuple.requesterMemberId],
    ["device id", tuple.deviceId],
    ["project id", tuple.projectId],
    ["origin channel id", tuple.originChannelId],
    ["origin message id", tuple.originMessageId],
  ] as const) {
    assertOpaqueId(value, field);
  }
  if (tuple.agentId !== undefined) assertOpaqueId(tuple.agentId, "agent id");
  if (tuple.delegationId !== undefined) assertOpaqueId(tuple.delegationId, "delegation id");
  if ((tuple.agentId === undefined) !== (tuple.delegationId === undefined)) {
    throw new Error("an agent request must name its exact delegation");
  }
  if (!(["inject", "file", "device_proxy", "reveal"] as const).includes(tuple.delivery)) {
    throw new Error("vault delivery is invalid");
  }
  return { ...tuple, reason: normalizeApprovalReason(tuple.reason) };
}

export function validateApprovalItems(items: readonly ApprovalItem[]): readonly ApprovalItem[] {
  if (items.length === 0) throw new Error("an approval must name at least one credential");
  if (items.length > MAX_APPROVAL_CREDENTIALS) {
    throw new Error(`an approval may not carry more than ${MAX_APPROVAL_CREDENTIALS} credentials`);
  }
  const seen = new Set<string>();
  for (const item of items) {
    assertOpaqueId(item.credentialId, "credential id");
    if (seen.has(item.credentialId)) throw new Error("an approval may not name a credential twice");
    seen.add(item.credentialId);
    if (!Number.isSafeInteger(item.version) || item.version < 1) throw new Error("credential version is invalid");
    if (!Number.isSafeInteger(item.policyEpoch) || item.policyEpoch < 1) throw new Error("policy epoch is invalid");
  }
  return items;
}

/**
 * The eligible approver set must be identical across a batch, because the card
 * is answered once by one person. Two credentials owned by different people are
 * two cards, even when one command asked for both.
 */
export function sharedApproverSet(sets: readonly (readonly string[])[]): readonly string[] | null {
  if (sets.length === 0) return null;
  const first = [...new Set(sets[0])].sort();
  if (first.length === 0) return null;
  for (const candidate of sets.slice(1)) {
    const other = [...new Set(candidate)].sort();
    if (other.length !== first.length || other.some((id, index) => id !== first[index])) return null;
  }
  return first;
}

/**
 * Which allow buttons a card may show.
 *
 * `Allow once` is always available: a grant with no expiry is spent by one use.
 * The timed windows exist only where the credential's own policy permits a TTL
 * that long, so the card can never offer a window the grant rules would refuse
 * — an approver pressing a button that then fails learns nothing except not to
 * trust the buttons.
 */
export function availableApprovalWindows(policy: Pick<VaultPolicy, "grantTtlMs">): readonly ApprovalWindow[] {
  const ttl = policy.grantTtlMs;
  if (ttl === undefined) return ["once"];
  const windows: ApprovalWindow[] = ["once"];
  if (ttl >= APPROVAL_WINDOW_MS.fifteen_minutes) windows.push("fifteen_minutes");
  if (ttl > APPROVAL_WINDOW_MS.fifteen_minutes) windows.push("session");
  return windows;
}

/**
 * The expiry a chosen window becomes, clamped to what the policy allows.
 *
 * `undefined` means a single-use grant, which is what the grant rules read a
 * missing expiry as.
 */
export function approvalGrantExpiry(
  window: ApprovalWindow,
  policy: Pick<VaultPolicy, "grantTtlMs">,
  now: number,
): number | undefined {
  if (window === "once" || policy.grantTtlMs === undefined) return undefined;
  if (!availableApprovalWindows(policy).includes(window)) {
    throw new Error("that approval window is not permitted by this credential's policy");
  }
  const requested = window === "session" ? APPROVAL_WINDOW_MS.session : APPROVAL_WINDOW_MS.fifteen_minutes;
  return now + Math.min(requested, policy.grantTtlMs);
}

/**
 * The only terminal transition an approval may take, and only from pending.
 *
 * Two owners answering at once is the normal case, not the edge case. The
 * second answer is refused here rather than merged, so the card can honestly
 * say who decided and how.
 */
export function decideApprovalTransition(
  current: ApprovalStatus,
  next: Exclude<ApprovalStatus, "pending">,
): { ok: true; status: ApprovalStatus } | { ok: false; reason: string } {
  if (current !== "pending") {
    return {
      ok: false,
      reason: current === "expired" ? "that request timed out before it was answered" : `that request was already ${current}`,
    };
  }
  return { ok: true, status: next };
}

export function isApprovalExpired(approval: { status: ApprovalStatus; expiresAt: number }, now: number): boolean {
  return approval.status === "pending" && now >= approval.expiresAt;
}

/**
 * What the approver's gesture is bound to.
 *
 * The assertion authorises this approval, these credentials, at these versions,
 * with these outcomes and these windows, in this order — so it cannot be
 * replayed onto a different card, a different set of credentials, or the same
 * card after a credential changed underneath it. Any of those is a different
 * decision and needs a different gesture.
 */
export function canonicalApprovalDigest(input: {
  approvalId: string;
  items: readonly ApprovalItem[];
  decisions: readonly ApprovalDecisionInput[];
}): string {
  assertOpaqueId(input.approvalId, "approval id");
  const byId = new Map(input.items.map((item) => [item.credentialId, item]));
  const ordered = [...input.decisions].sort((left, right) => (left.credentialId < right.credentialId ? -1 : 1));
  if (ordered.length !== input.items.length) throw new Error("every credential in the approval needs a decision");
  const rows = ordered.map((decision) => {
    const item = byId.get(decision.credentialId);
    if (item === undefined) throw new Error("that credential is not part of this approval");
    if (decision.outcome !== "allowed" && decision.outcome !== "denied") throw new Error("approval outcome is invalid");
    if (!(["once", "fifteen_minutes", "session"] as const).includes(decision.window)) {
      throw new Error("approval window is invalid");
    }
    return [decision.credentialId, item.version, item.policyEpoch, decision.outcome, decision.window];
  });
  return JSON.stringify(["lepidy-vault-approval", 1, input.approvalId, rows]);
}

/**
 * What the agent is told, and what it must not do next.
 *
 * A timeout is a denial, and the wording says so without inviting a retry
 * somewhere else — the whole point of the vault is that there is no somewhere
 * else, and an agent that reads "try again" will go looking.
 */
export function approvalTimeoutHint(names: readonly string[]): string {
  const listed = names.join(", ");
  return `The request for ${listed} timed out without an answer, which counts as a denial. Stop and tell the user what you could not do; do not ask again in a loop and do not look for the value in files, shell configuration or chat.`;
}

export function approvalPendingHint(names: readonly string[], expiresAt: number): string {
  return `${names.join(", ")} needs a human to approve this use. The request expires at ${new Date(expiresAt).toISOString()}. Stop and wait to be asked again; do not retry in a loop and do not look for the value elsewhere.`;
}

export function approvalDeniedHint(names: readonly string[], approverHandle: string): string {
  return `${names.join(", ")} was denied by ${approverHandle}. Stop and tell the user; do not ask again for the same thing and do not look for the value elsewhere.`;
}

/**
 * The card's body. It is a real message in a real room, so it is Markdown, and
 * it carries every fact PRD §8.6 requires without exception — including the
 * plain warning that a reveal puts the value into a transcript on disk.
 */
export function approvalCardMarkdown(input: {
  requesterHandle: string;
  agentHandle?: string;
  deviceLabel: string;
  projectLabel: string;
  originChannelLabel: string;
  delivery: VaultDelivery;
  reason: string;
  expiresAt: number;
  items: readonly { name: string; description: string; highRisk: boolean; recentUses: number; lastUsedAt?: number }[];
}): string {
  const asker = input.agentHandle
    ? `@${input.agentHandle}, operating for @${input.requesterHandle}`
    : `@${input.requesterHandle}`;
  const lines = [
    `**Credential request** — ${asker}`,
    "",
    `**Why:** ${input.reason}`,
    `**From:** ${input.deviceLabel} · project ${input.projectLabel} · ${input.originChannelLabel}`,
    `**Delivery:** ${deliveryDescription(input.delivery)}`,
    "",
  ];
  for (const item of input.items) {
    const risk = item.highRisk ? " ⚠️ high risk" : "";
    lines.push(`- **${item.name}**${risk} — ${item.description || "no description"}`);
    lines.push(`  - ${usageLine(item.recentUses, item.lastUsedAt)}`);
  }
  lines.push("");
  lines.push(`Expires at ${new Date(input.expiresAt).toISOString()}. No answer is a denial.`);
  return lines.join("\n");
}

function deliveryDescription(delivery: VaultDelivery): string {
  switch (delivery) {
    case "inject":
      return "injected into the command's environment";
    case "file":
      return "written to an owner-only temporary file for the command, removed when it exits";
    case "device_proxy":
      return "used by your device to make the request; the value is not handed to the agent";
    case "reveal":
      return "⚠️ revealed into the model's context and written to a transcript on disk";
  }
}

function usageLine(recentUses: number, lastUsedAt?: number): string {
  if (recentUses === 0) return "not used in the last day";
  const last = lastUsedAt === undefined ? "" : `, last at ${new Date(lastUsedAt).toISOString()}`;
  return `read ${recentUses}× in the last day${last}`;
}

/**
 * The answer, posted back into the same card's thread.
 *
 * A card that has been answered says who answered it and how, so a second owner
 * does not answer it twice or wonder what became of it.
 */
export function approvalAnswerMarkdown(input: {
  approverHandle: string;
  decisions: readonly { name: string; outcome: ApprovalOutcome; window: ApprovalWindow }[];
}): string {
  const lines = [`**Answered by @${input.approverHandle}.**`, ""];
  for (const decision of input.decisions) {
    lines.push(
      decision.outcome === "denied"
        ? `- **${decision.name}** — denied`
        : `- **${decision.name}** — allowed ${windowLabel(decision.window)}`,
    );
  }
  return lines.join("\n");
}

export function approvalExpiredMarkdown(names: readonly string[]): string {
  return `**Timed out.** Nobody answered within five minutes, so ${names.join(", ")} was denied and the agent was told to stop and report.`;
}

export function windowLabel(window: ApprovalWindow): string {
  switch (window) {
    case "once":
      return "once";
    case "fifteen_minutes":
      return "for 15 minutes";
    case "session":
      return "for this session";
  }
}

/* -------------------------------------------------------------------------- */
/* The kill switch                                                             */
/* -------------------------------------------------------------------------- */

/**
 * What a step-up gesture authorises when it is not an approval.
 *
 * Switching protection back *on* is the direction that needs proof of a person:
 * the matrix asks for fresh user verification to turn agent access on, and the
 * same reasoning covers unfreezing a credential or restoring an agent's access.
 * Switching protection off never does. The digest names the exact action and
 * subject so a gesture collected for one cannot be spent on another.
 */
export function canonicalVaultActionDigest(input: { action: string; subjectId: string; epoch: number }): string {
  if (!/^[a-z_.]{1,64}$/u.test(input.action)) throw new Error("vault action is invalid");
  assertOpaqueId(input.subjectId, "subject id");
  if (!Number.isSafeInteger(input.epoch) || input.epoch < 0) throw new Error("vault action epoch is invalid");
  return JSON.stringify(["lepidy-vault-action", 1, input.action, input.subjectId, input.epoch]);
}

export type KillSwitchScope =
  | { kind: "workspace" }
  | { kind: "agent"; handle: string }
  | { kind: "credential"; name: string };

/**
 * Every state change is announced, naming who flipped it.
 *
 * A kill switch that flips silently produces an hour of mysterious agent
 * failures, and the person debugging them has no way to find out why.
 */
export function killSwitchAnnouncement(input: {
  scope: KillSwitchScope;
  off: boolean;
  actorHandle: string;
  revokedGrants: number;
}): string {
  const subject =
    input.scope.kind === "workspace"
      ? "Agent access to the vault"
      : input.scope.kind === "agent"
        ? `Vault access for @${input.scope.handle}`
        : `The credential ${input.scope.name}`;
  const state = input.off ? "switched off" : "switched back on";
  const consequence = input.off
    ? `${input.revokedGrants === 0 ? "No" : String(input.revokedGrants)} active grant${input.revokedGrants === 1 ? "" : "s"} ${input.revokedGrants === 1 ? "was" : "were"} revoked and any request in flight is denied.`
    : "Previously revoked grants were not restored; the next use asks again.";
  return `**${subject} was ${state} by @${input.actorHandle}.** ${consequence}`;
}

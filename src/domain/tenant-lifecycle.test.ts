import { describe, expect, it } from "vitest";

import {
  assertReceiptCarriesNoContent,
  authorizePurge,
  CANCELLATION_WINDOW_MS,
  deletionConfirmation,
  nextPurgeStage,
  planDeletion,
  PURGE_STAGES,
  receiptVerification,
  soloDeletionCaveat,
  type DeletionRequest,
} from "./tenant-lifecycle";

const NOW = 1_800_000_000_000;

function request(overrides: Partial<DeletionRequest> = {}): DeletionRequest {
  return {
    workspaceId: "ws-1",
    requestedByMemberId: "owner",
    requestedAt: NOW,
    purgeAfter: NOW + CANCELLATION_WINDOW_MS,
    ...overrides,
  };
}

describe("tenant lifecycle", () => {
  it("O01-RULE-001 asks for the workspace's own name, not a word anybody could type", () => {
    const planned = planDeletion({
      workspaceId: "ws-1",
      requestedByMemberId: "owner",
      slug: "Acme-Eng",
      confirmation: "acme-eng",
      stepUpVerified: true,
      now: NOW,
    });
    expect(planned.purgeAfter).toBe(NOW + CANCELLATION_WINDOW_MS);

    // "DELETE" would be muscle memory within a week. The name of the thing
    // being destroyed cannot be typed absent-mindedly.
    for (const confirmation of ["DELETE", "delete", "", "acme", "acme-eng-2"]) {
      expect(() =>
        planDeletion({
          workspaceId: "ws-1", requestedByMemberId: "owner", slug: "Acme-Eng",
          confirmation, stepUpVerified: true, now: NOW,
        }),
      ).toThrow(/did not match/);
    }
    // Case and surrounding space are not the point of the check.
    expect(deletionConfirmation("  ACME-Eng ")).toBe("acme-eng");
  });

  it("O01-RULE-002 always asks for a verified gesture, because nothing here is recoverable", () => {
    // Every other destructive action in this product can be undone. This one
    // removes a company's conversations and their credential ciphertext, and no
    // amount of authority afterwards brings any of it back.
    expect(() =>
      planDeletion({
        workspaceId: "ws-1", requestedByMemberId: "owner", slug: "acme",
        confirmation: "acme", stepUpVerified: false, now: NOW,
      }),
    ).toThrow(/verified gesture/);
  });

  it("O01-RULE-003 holds the purge open for a week, and makes skipping it a separate act", () => {
    const pending = request();
    // The person who deletes a workspace is often not the person who notices.
    expect(authorizePurge({ request: pending, now: NOW + 1 })).toEqual({
      allowed: false,
      reason: "window_open",
    });
    expect(authorizePurge({ request: pending, now: pending.purgeAfter }).allowed).toBe(true);
    expect(authorizePurge({ request: pending, now: pending.purgeAfter }).reason).toBe(
      "window_elapsed",
    );

    // Skipping needs its own confirmation and its own gesture. A person who has
    // just typed a workspace's name is in exactly the state where one more
    // click is automatic, and this is the click that removes the seven days a
    // mistake could have been noticed in.
    expect(
      authorizePurge({
        request: pending, now: NOW + 1,
        skipWindow: { confirmation: "acme", slug: "acme", stepUpVerified: true },
      }),
    ).toEqual({ allowed: true, reason: "explicitly_skipped" });
    for (const skip of [
      { confirmation: "acme", slug: "acme", stepUpVerified: false },
      { confirmation: "yes", slug: "acme", stepUpVerified: true },
    ]) {
      expect(authorizePurge({ request: pending, now: NOW + 1, skipWindow: skip }).allowed).toBe(
        false,
      );
    }
  });

  it("O01-RULE-004 runs every stage, resumes where it stopped, and leaves routing until last", () => {
    // A list rather than a sequence of calls, so "did it touch everything" is a
    // question with an answer.
    expect(nextPurgeStage([])).toBe(PURGE_STAGES[0]);
    expect(nextPurgeStage(["attachments", "content"])).toBe("vault");
    // Out-of-order completion still resumes correctly, which is what makes an
    // interrupted purge safe to run again.
    expect(nextPurgeStage(["content", "attachments", "vault", "audit"])).toBe("scheduler");
    expect(nextPurgeStage([...PURGE_STAGES])).toBeNull();

    // Routing last: a workspace whose routing is gone is one nothing can
    // reach — including the purge that had not finished.
    expect(PURGE_STAGES[PURGE_STAGES.length - 1]).toBe("routing");
    expect(new Set(PURGE_STAGES).size).toBe(PURGE_STAGES.length);
  });

  it("O01-RULE-005 keeps a receipt that proves the deletion and describes nothing", async () => {
    const stages = PURGE_STAGES.map((stage) => ({ stage, removed: 3 }));
    const verification = await receiptVerification("ws-1", stages);
    expect(verification).toMatch(/^[0-9a-f]{64}$/);
    // A different count is a different digest, so a receipt cannot be edited
    // unnoticed.
    expect(await receiptVerification("ws-1", [{ stage: "content", removed: 4 }])).not.toBe(
      verification,
    );

    assertReceiptCarriesNoContent({
      workspaceId: "ws-1", requestId: "req-1", requestedAt: NOW, completedAt: NOW + 1,
      jurisdiction: "eu", stages, verification,
    });
    // The receipt outlives the workspace, which makes it the most tempting
    // place to keep "just the channel names" — and that would mean a deleted
    // workspace left a list of its rooms behind for thirty days.
    for (const leak of [
      { channels: ["eng"] },
      { members: ["maya"] },
      { name: "Acme" },
      { slug: "acme" },
      { messages: 12, body: "hello" },
    ]) {
      expect(() => assertReceiptCarriesNoContent({ workspaceId: "ws-1", ...leak })).toThrow(
        /may not carry/,
      );
    }
  });

  it("O01-RULE-006 never claims a Solo purge erased the computer or its backups", () => {
    const caveat = soloDeletionCaveat();
    // Saying "your data has been deleted" would be false in the one case where
    // being wrong matters most.
    expect(caveat).toContain("designated computer");
    expect(caveat).toContain("backup");
    expect(caveat).not.toMatch(/everything (has been|is) deleted/i);
  });
});

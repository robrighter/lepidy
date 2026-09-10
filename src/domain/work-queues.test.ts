import { describe, expect, it } from "vitest";

import {
  buildFormSubmission,
  maySeeQueueStatus,
  parseFormDefinition,
  parseQueueStatuses,
  queuePreset,
  rankQueueItems,
  renderFormSubmission,
} from "./work-queues";

describe("work queue form rules", () => {
  const form = parseFormDefinition({
    instructions: "Tell us what changed",
    fields: [
      { id: "title", label: "Title", type: "short_text", required: true, options: [] },
      { id: "priority", label: "Priority", type: "single_select", required: true, options: ["Low", "High"] },
      { id: "tags", label: "Tags", type: "multi_select", required: false, options: ["UI", "API"] },
    ],
  })!;

  it("validates, snapshots and renders ordered answers", () => {
    const submission = buildFormSubmission(form, 4, { title: "Export", priority: "High", tags: ["API", "UI"] });
    expect(submission.formVersion).toBe(4);
    expect(renderFormSubmission(submission)).toBe("**Title:** Export\n\n**Priority:** High\n\n**Tags:** API, UI");
  });

  it("refuses missing, unknown and out-of-list values", () => {
    expect(() => buildFormSubmission(form, 1, { priority: "Low" })).toThrow("Title is required");
    expect(() => buildFormSubmission(form, 1, { title: "x", priority: "Medium" })).toThrow("invalid option");
    expect(() => buildFormSubmission(form, 1, { title: "x", priority: "Low", surprise: "x" })).toThrow("unknown field");
  });

  it("requires stable unique form ids and labels", () => {
    expect(parseFormDefinition({ instructions: "", fields: [] })).toBeNull();
    expect(parseFormDefinition({ instructions: "", fields: [
      { id: "x", label: "Title", type: "short_text", required: true, options: [] },
      { id: "x", label: "Other", type: "short_text", required: false, options: [] },
    ] })).toBeNull();
  });
});

describe("work queue visibility and ranking", () => {
  const privateStatus = { id: "secret", label: "Security", visibility: "private" as const, allowedMemberIds: ["member-allowed"] };

  it("shows private statuses only to owners and explicitly allowed members", () => {
    expect(maySeeQueueStatus(privateStatus, "member-other", false)).toBe(false);
    expect(maySeeQueueStatus(privateStatus, "member-allowed", false)).toBe(true);
    expect(maySeeQueueStatus(privateStatus, "member-other", true)).toBe(true);
    expect(maySeeQueueStatus({ ...privateStatus, allowedMemberIds: [] }, "member-other", false)).toBe(false);
  });

  it("ranks votes, then newest, then id without mutating input", () => {
    const input = [
      { id: "a", voteCount: 2, createdAt: 20 },
      { id: "z", voteCount: 2, createdAt: 20 },
      { id: "b", voteCount: 3, createdAt: 10 },
    ];
    expect(rankQueueItems(input).map((item) => item.id)).toEqual(["b", "z", "a"]);
    expect(input.map((item) => item.id)).toEqual(["a", "z", "b"]);
  });

  it("validates status definitions and supplies all three presets", () => {
    expect(parseQueueStatuses([privateStatus])).toEqual([privateStatus]);
    for (const preset of ["idea_board", "support_queue", "bug_tracker"] as const) {
      const value = queuePreset(preset);
      expect(value.form.fields[0]).toMatchObject({ label: "Title", required: true });
      expect(value.statuses.length).toBeGreaterThan(0);
    }
  });
});

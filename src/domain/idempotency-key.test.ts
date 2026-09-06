import { describe, expect, it } from "vitest";

import { parseIdempotencyKey } from "./idempotency-key";

describe("parseIdempotencyKey", () => {
  it("accepts a bounded opaque client key", () => {
    expect(parseIdempotencyKey("msg:01K4F1CGW7B4Y6VZ0X7G1C0F8M")).toBe(
      "msg:01K4F1CGW7B4Y6VZ0X7G1C0F8M",
    );
  });

  it.each([
    "short",
    "contains spaces 123",
    "contains/a/slash/123",
    `x${"y".repeat(128)}`,
    "\ninvalid-control-value",
  ])("rejects unsafe or unbounded value %j", (value) => {
    expect(parseIdempotencyKey(value)).toBeNull();
  });

  it("rejects non-string input", () => {
    expect(parseIdempotencyKey({ key: "msg:1234567890123456" })).toBeNull();
  });
});

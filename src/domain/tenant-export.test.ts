import { describe, expect, it } from "vitest";

import {
  assertVaultRecordIsCiphertextOnly,
  chunkId,
  dispositionOf,
  EXPORT_VERSION,
  exportedTables,
  manifestHash,
  replacementRoutingEpoch,
  restorableTables,
  restoreDecision,
  RECORD_KINDS,
  sha256,
} from "./tenant-export";
import { PURGE_TABLES } from "./tenant-lifecycle";

describe("tenant export and restore", () => {
  it("O01B-RULE-001 classifies every table that exists, and refuses to guess", () => {
    // The guard that survives this task. A migration adding a table has to make
    // somebody decide, because both silent answers are wrong: silently
    // exporting could carry authority into a restore, and silently skipping
    // loses a customer's data with no sign that it happened.
    const tables = Object.values(PURGE_TABLES).flat();
    const unclassified = tables.filter((table) => !(table in RECORD_KINDS));
    expect(unclassified, `these tables have no export disposition: ${unclassified.join(", ")}`).toEqual([]);
    expect(() => dispositionOf("a_table_added_next_year")).toThrow(/no export disposition/);
  });

  it("O01B-RULE-002 never lets a restore write anything that carries authority", () => {
    // The promise D07 §4 makes, reduced to one function. A restore driven by a
    // list of exclusions would be one exclusion away from resurrecting a
    // revoked grant; this cannot write an `authority` row because there is no
    // branch in which it would.
    const restorable = new Set(restorableTables());
    for (const [table, disposition] of Object.entries(RECORD_KINDS)) {
      const decision = restoreDecision(table, EXPORT_VERSION);
      if (disposition === "content" || disposition === "settings") {
        expect(decision.write, `${table} should restore`).toBe(true);
        expect(restorable.has(table)).toBe(true);
      } else {
        expect(decision.write, `${table} must never restore`).toBe(false);
        expect(restorable.has(table)).toBe(false);
      }
    }

    // Named individually as well, because these are the ones the contract calls
    // out and a reader should be able to find them here.
    for (const table of [
      "agent_sessions",
      "agent_delegations",
      "runner_devices",
      "vault_grants",
      "vault_approvals",
      "oauth_connections",
      "oauth_codes",
      "idempotency_keys",
      "pending_events",
      "agent_queue",
    ]) {
      expect(restoreDecision(table, EXPORT_VERSION).write, `${table}`).toBe(false);
    }
  });

  it("O01B-RULE-003 refuses an export it does not understand", () => {
    // A future format could classify a table differently. Writing it under
    // today's rules would apply today's meaning to tomorrow's data.
    const decision = restoreDecision("messages", EXPORT_VERSION + 1);
    expect(decision).toEqual({ write: false, table: "messages", because: "unknown_version" });
    expect(restoreDecision("messages", EXPORT_VERSION).write).toBe(true);
  });

  it("O01B-RULE-004 exports authority for the record and still refuses to restore it", () => {
    // An export should show who had access at the time — that is often the
    // whole reason one was taken — without that being a way to put it back.
    const exported = new Set(exportedTables());
    expect(exported.has("vault_grants")).toBe(true);
    expect(exported.has("agent_sessions")).toBe(true);
    expect(restoreDecision("vault_grants", EXPORT_VERSION).write).toBe(false);

    // And a moment that has passed is neither exported nor restored: a restored
    // nonce is a replay window somebody already closed.
    expect(exported.has("idempotency_keys")).toBe(false);
    expect(exported.has("replay_events")).toBe(false);
  });

  it("O01B-RULE-005 restores in the reverse of purge order, so references exist first", () => {
    const restorable = restorableTables();
    // Members before the messages that reference them; channels before pins.
    expect(restorable.indexOf("members")).toBeLessThan(restorable.indexOf("messages"));
    expect(restorable.indexOf("channels")).toBeLessThan(restorable.indexOf("channel_pins"));
    expect(restorable.indexOf("messages")).toBeLessThan(restorable.indexOf("message_reactions"));
    // Derived from the purge order rather than written twice, so the two cannot
    // disagree about which table references which.
    const purgeOrder = Object.values(PURGE_TABLES).flat();
    expect(purgeOrder.indexOf("members")).toBeGreaterThan(purgeOrder.indexOf("messages"));
  });

  it("O01B-RULE-006 gives a chunk a stable id and a manifest hash that notices reordering", async () => {
    // Stability is the whole of resumability: a client that lost its connection
    // asks for the same id and gets the same bytes.
    expect(chunkId("exp-1", "messages", 0)).toBe("exp-1.messages.000000000");
    expect(chunkId("exp-1", "messages", 0)).toBe(chunkId("exp-1", "messages", 0));
    expect(chunkId("exp-1", "messages", 1)).not.toBe(chunkId("exp-1", "messages", 0));
    expect(() => chunkId("exp-1", "messages", -1)).toThrow();

    const a = { id: chunkId("exp-1", "members", 0), rows: 2, sha256: await sha256("a") };
    const b = { id: chunkId("exp-1", "messages", 0), rows: 3, sha256: await sha256("b") };
    const ordered = await manifestHash("exp-1", [a, b]);
    // A checksum over concatenated bytes alone would not catch reordering.
    expect(await manifestHash("exp-1", [b, a])).not.toBe(ordered);
    // Nor truncation, nor a swapped chunk, nor a changed row count.
    expect(await manifestHash("exp-1", [a])).not.toBe(ordered);
    expect(await manifestHash("exp-1", [a, { ...b, rows: 4 }])).not.toBe(ordered);
    expect(await manifestHash("exp-2", [a, b])).not.toBe(ordered);
    expect(await manifestHash("exp-1", [a, b])).toBe(ordered);
  });

  it("O01B-RULE-007 refuses to put readable vault material in an export", () => {
    // There is no server-side plaintext to export and no server-decryptable
    // root to accompany the ciphertext. This checks that stays true of the rows
    // actually written, because the failure mode is a future migration adding a
    // convenience column and an export is where it would first leave.
    expect(() =>
      assertVaultRecordIsCiphertextOnly("vault_credentials", {
        id: "cred-1", ciphertext: "…", nonce: "…", kdf_params: "…",
      }),
    ).not.toThrow();

    for (const leak of [
      { value: "ghp_real" },
      { plaintext: "…" },
      { cached_value: "…" },
      { vault_root: "…" },
      { recovery_code: "…" },
      { member_private_key: "…" },
    ]) {
      expect(() => assertVaultRecordIsCiphertextOnly("vault_credentials", leak)).toThrow(
        /readable vault material/,
      );
    }
    // Only vault rows are held to this: a message body legitimately contains
    // whatever somebody typed, including the word "secret".
    expect(() =>
      assertVaultRecordIsCiphertextOnly("messages", { body_markdown: "the secret is out" }),
    ).not.toThrow();
  });

  it("O01B-RULE-008 always gives a replacement workspace a new routing epoch", () => {
    // The mechanism that makes "does not resurrect a live session" true for the
    // sessions a replacement object never saw: anything still holding the old
    // epoch is refused rather than silently accepted against restored data.
    expect(replacementRoutingEpoch(1)).toBe(2);
    expect(replacementRoutingEpoch(41)).toBe(42);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => replacementRoutingEpoch(bad)).toThrow();
    }
  });
});

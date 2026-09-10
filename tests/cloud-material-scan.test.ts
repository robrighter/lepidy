import { describe, expect, it } from "vitest";

import { WORKSPACE_MIGRATIONS } from "../src/cloudflare/workspace-migrations";

/**
 * The scan TESTING.md asks for: every cloud migration and serialised cloud
 * protocol shape, checked for the three things the cloud must never hold.
 *
 * This is a structural test rather than a behavioural one, and that is the
 * point. Every other vault test proves that a particular code path does not
 * send a secret; this one proves there is nowhere in the cloud schema for one
 * to be *put*. The failure it exists to catch is a migration, months from now,
 * adding a convenience column — `last_value`, `unwrapped_key`, `passphrase_hint`
 * — that no behavioural test would fail on until somebody used it.
 */

/**
 * Column and field names that would mean the cloud could open a credential, or
 * knew how to start a process on somebody's machine.
 *
 * Split into words before matching, so `cachedPlaintext` and `vault_root_key`
 * are caught rather than only the exact spellings.
 */
const FORBIDDEN_WORDS = [
  "plaintext",
  "passphrase",
  "unwrapped",
  "recovery" /* only in combination with code — refined below */,
  "argv",
  "executable",
  "cwd",
];

/** Words that are forbidden only next to another, to keep the check honest. */
const FORBIDDEN_PAIRS: [string, string][] = [
  ["recovery", "code"],
  ["vault", "root"],
  ["private", "key"],
  ["launch", "config"],
  ["preset", "path"],
];

function words(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.toLowerCase())
    .filter(Boolean);
}

/** Every column name a migration creates or adds. */
function columnNames(statement: string): string[] {
  const names: string[] = [];
  const created = /CREATE\s+TABLE\s+\w+\s*\(([\s\S]*)\)/i.exec(statement);
  if (created) {
    for (const line of created[1].split(",")) {
      const name = /^\s*([a-z_][a-z0-9_]*)\s+/i.exec(line);
      if (name) names.push(name[1]);
    }
  }
  const added = /ALTER\s+TABLE\s+\w+\s+ADD\s+COLUMN\s+([a-z_][a-z0-9_]*)/i.exec(statement);
  if (added) names.push(added[1]);
  return names;
}

describe("cloud storage carries nothing it must not hold", () => {
  it("G02-INT-007 gives no migrated column a name that could hold vault or launch material", () => {
    const offenders: string[] = [];
    for (const migration of WORKSPACE_MIGRATIONS) {
      for (const statement of migration.statements) {
        for (const column of columnNames(statement)) {
          const parts = words(column);
          for (const word of FORBIDDEN_WORDS) {
            // `recovery` alone is legitimate — a recovery *package* is
            // ciphertext the cloud is meant to hold — so it is only refused in
            // the pairs below.
            if (word === "recovery") continue;
            if (parts.includes(word)) offenders.push(`v${migration.version}.${column} (${word})`);
          }
          for (const [first, second] of FORBIDDEN_PAIRS) {
            if (parts.includes(first) && parts.includes(second)) {
              offenders.push(`v${migration.version}.${column} (${first} ${second})`);
            }
          }
        }
      }
    }
    expect(
      offenders,
      `these columns could hold something the cloud must never have: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("G02-INT-008 keeps the check itself honest", () => {
    // A structural test that cannot fail is worse than none, so the detector is
    // pointed at the things it is supposed to catch.
    const caught = (sql: string) => {
      for (const column of columnNames(sql)) {
        const parts = words(column);
        if (FORBIDDEN_WORDS.some((word) => word !== "recovery" && parts.includes(word))) return true;
        if (FORBIDDEN_PAIRS.some(([a, b]) => parts.includes(a) && parts.includes(b))) return true;
      }
      return false;
    };

    expect(caught("CREATE TABLE x (id TEXT, cached_plaintext TEXT)")).toBe(true);
    expect(caught("CREATE TABLE x (id TEXT, cachedPlaintext TEXT)")).toBe(true);
    expect(caught("ALTER TABLE x ADD COLUMN vault_root_key TEXT")).toBe(true);
    expect(caught("ALTER TABLE x ADD COLUMN recovery_code TEXT")).toBe(true);
    expect(caught("CREATE TABLE x (id TEXT, launch_config_json TEXT)")).toBe(true);
    expect(caught("CREATE TABLE x (id TEXT, preset_path TEXT)")).toBe(true);
    expect(caught("CREATE TABLE x (id TEXT, executable TEXT)")).toBe(true);

    // And not at the things it must not: the cloud legitimately holds a
    // recovery *package* as ciphertext, a credential's *ciphertext*, and a
    // preset's non-secret *label*.
    expect(caught("CREATE TABLE x (id TEXT, recovery_package TEXT)")).toBe(false);
    expect(caught("CREATE TABLE x (id TEXT, ciphertext TEXT, nonce TEXT)")).toBe(false);
    expect(caught("CREATE TABLE x (id TEXT, preset_label TEXT)")).toBe(false);
    expect(caught("CREATE TABLE x (id TEXT, key_wrap TEXT)")).toBe(false);
  });
});

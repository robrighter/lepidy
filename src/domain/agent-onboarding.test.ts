import { describe, expect, it } from "vitest";

import {
  VAULT_INSTRUCTION,
  VAULT_INSTRUCTION_TOKEN_BUDGET,
  approximateTokenCount,
  commandHints,
  commandSegments,
  isWrappedCommand,
  leadingProgram,
  mcpInstructions,
  type HintCatalogueEntry,
} from "./agent-onboarding";

const catalogue: readonly HintCatalogueEntry[] = [
  { id: "cred-gh", name: "GITHUB_TOKEN", commands: [] },
  { id: "cred-aws-id", name: "AWS_ACCESS_KEY_ID", commands: [] },
  { id: "cred-aws-secret", name: "AWS_SECRET_ACCESS_KEY", commands: [] },
  { id: "cred-house", name: "HOUSE_TOKEN", envVar: "HOUSE_TOKEN", commands: ["housectl"] },
  { id: "cred-unused", name: "PROD_DB_URL", commands: [] },
];

describe("agent onboarding text", () => {
  it("ONBOARD-RULE-001 keeps the always-on instruction inside its token budget", () => {
    // The one string every session pays for, forever. A test rather than a
    // comment, because the failure mode is somebody growing it into a manual.
    expect(approximateTokenCount(VAULT_INSTRUCTION)).toBeLessThanOrEqual(VAULT_INSTRUCTION_TOKEN_BUDGET);
    expect(approximateTokenCount(VAULT_INSTRUCTION)).toBeGreaterThan(20);
  });

  it("ONBOARD-RULE-002 says the one thing that matters and names no value path", () => {
    expect(VAULT_INSTRUCTION).toContain("lepidy run --with");
    expect(VAULT_INSTRUCTION).toContain("No tool returns a credential value.");
    expect(VAULT_INSTRUCTION).toContain("A refusal is an answer");
    // It must never advertise a route that does not exist, or an agent will
    // spend a turn looking for it.
    expect(VAULT_INSTRUCTION).not.toMatch(/reveal|request_secret|store_secret/u);
  });

  it("ONBOARD-RULE-003 states the authority a connection acts with, then the vault rule", () => {
    const session = mcpInstructions({
      kind: "session", agentHandle: "a.triage", ownerHandle: "maya", delegationId: "delegation-1",
    });
    expect(session).toContain("Running @a.triage under @maya's delegation delegation-1.");
    expect(session.endsWith(VAULT_INSTRUCTION)).toBe(true);

    const oauth = mcpInstructions({ kind: "oauth", handle: "maya" });
    expect(oauth).toContain("Connected to Lepidy as @maya.");
    expect(oauth.endsWith(VAULT_INSTRUCTION)).toBe(true);
  });
});

describe("command hints", () => {
  it("ONBOARD-RULE-004 splits a shell line on every separator and finds the real program", () => {
    expect(commandSegments("ls | gh pr list && echo done")).toEqual(["ls", "gh pr list", "echo done"]);
    expect(commandSegments("  ;  ; ")).toEqual([]);
    expect(leadingProgram("sudo FOO=bar /usr/local/bin/gh pr list")).toBe("gh");
    expect(leadingProgram("env AWS_REGION=eu-west-1 aws s3 ls")).toBe("aws");
    expect(leadingProgram("")).toBe("");
  });

  it("ONBOARD-RULE-005 names the credentials a command needs and the exact rewrite", () => {
    const [hint] = commandHints("gh pr list", catalogue);
    expect(hint).toMatchObject({ program: "gh", credentials: ["GITHUB_TOKEN"], alreadyWrapped: false });
    expect(hint?.rewrite).toBe("lepidy run --with GITHUB_TOKEN -- gh pr list");

    // Several credentials for one command are one invocation and therefore one
    // approval card, not one card each.
    const [aws] = commandHints("aws s3 ls", catalogue);
    expect(aws?.rewrite).toBe("lepidy run --with AWS_ACCESS_KEY_ID,AWS_SECRET_ACCESS_KEY -- aws s3 ls");
  });

  it("ONBOARD-RULE-006 matches a credential's own declared command, not only conventions", () => {
    const [hint] = commandHints("housectl deploy", catalogue);
    expect(hint?.credentials).toEqual(["HOUSE_TOKEN"]);
  });

  it("ONBOARD-RULE-007 never invents a credential the workspace does not hold", () => {
    // `stripe` is in the conventional table; this workspace holds no Stripe
    // credential, so there is nothing to say. False coaching is what makes a
    // hint surface hated, so silence is the correct answer.
    expect(commandHints("stripe listen", catalogue)).toEqual([]);
    expect(commandHints("cargo test", catalogue)).toEqual([]);
    expect(commandHints("", catalogue)).toEqual([]);
  });

  it("ONBOARD-RULE-008 reports a command already going through the CLI as correct", () => {
    expect(isWrappedCommand("lepidy run --with GITHUB_TOKEN -- gh pr list")).toBe(true);
    expect(isWrappedCommand("ls && lp capture TOKEN -- gh auth token")).toBe(true);
    expect(isWrappedCommand("echo lepidy")).toBe(false);

    const [hint] = commandHints("lepidy run --with GITHUB_TOKEN -- gh pr list", catalogue);
    expect(hint).toMatchObject({ alreadyWrapped: true, credentials: [], rewrite: null });
  });

  it("ONBOARD-RULE-009 judges a pipeline one segment at a time", () => {
    const hints = commandHints("ls -la | gh pr list | housectl deploy", catalogue);
    expect(hints.map((hint) => hint.program)).toEqual(["gh", "housectl"]);
  });
});

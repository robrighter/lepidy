/**
 * Teaching an agent the conventions (V08, PRD §8.11).
 *
 * An agent that does not know how this product works will paste tokens into
 * chat, read `.env` files and ask for plaintext — the exact behaviours the
 * vault exists to prevent. Onboarding is therefore a feature with requirements,
 * and it is spread across four layers with very different costs:
 *
 * | Layer | Channel | Cost |
 * |---|---|---|
 * | 1 | the MCP server's `instructions` | paid in every session, forever |
 * | 2 | tool descriptions and deny hints | free until the agent is stuck |
 * | 3 | a skill carrying the depth | loads on demand |
 * | 4 | a `PreToolUse` hook | free until it fires |
 *
 * This file owns layers 1 and 2. Layer 2's denial sentences live with the
 * policy decision in `vault-authorization.ts`, because a denial hint is part of
 * the answer rather than a separate document. Layers 3 and 4 are the skill and
 * the hook shipped in `plugin/lepidy`, installed by `lepidy init`.
 *
 * **None of it is a boundary.** Instructions, hints, a skill and a hook are all
 * advice to something that may ignore them. What is enforced is the policy
 * decision, the delegation, the signed device request and the ACL — every one
 * of which is re-checked at use, and none of which reads a word of this file.
 */

/**
 * The always-on text, budgeted.
 *
 * This string is loaded into every session for the life of the product, so it
 * carries exactly one idea — run the command through the CLI — and everything
 * else is left to the layers that cost nothing until they are needed. Growing
 * it into a manual is a permanent tax on every session, which is why the budget
 * below is asserted by a test rather than described in a comment.
 */
export const VAULT_INSTRUCTION_TOKEN_BUDGET = 80;

export const VAULT_INSTRUCTION =
  "Lepidy holds this workspace's credentials and lends them to commands, not conversations. " +
  "Never ask for a value or read one from a file: run the work through `lepidy run --with NAME -- <command>`, " +
  "which puts it in that child's environment. No tool returns a credential value. " +
  "A refusal is an answer: report it and stop.";

/**
 * A rough token count, for the budget test only.
 *
 * Four characters to a token is the usual English approximation. It is not
 * exact and does not need to be: the point of the budget is to notice when
 * somebody turns sixty words into three hundred.
 */
export function approximateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

export type OnboardingPrincipal =
  | { kind: "session"; agentHandle: string; ownerHandle: string; delegationId: string }
  | { kind: "oauth"; handle: string };

/** What an MCP client is told the moment it connects. */
export function mcpInstructions(principal: OnboardingPrincipal): string {
  const preamble = principal.kind === "session"
    ? `Running @${principal.agentHandle} under @${principal.ownerHandle}'s delegation ${principal.delegationId}. ` +
      "Every tool is limited to this session's capabilities and delegated rooms."
    : `Connected to Lepidy as @${principal.handle}. Agent tools act only for agents you own; ` +
      "room reads and writes always use your current membership.";
  return `${preamble} ${VAULT_INSTRUCTION}`;
}

/* ------------------------------------------------------------------ */
/* Command hints (layer 2)                                            */
/* ------------------------------------------------------------------ */

/**
 * Wrappers that stand in front of the program that actually matters, so
 * `sudo aws s3 ls` is an `aws` command.
 */
const WRAPPERS = ["sudo", "command", "exec", "time", "nohup", "env"] as const;

/**
 * Conventional program-to-variable mappings, used only to *recognise* a
 * credential this workspace already holds.
 *
 * Nothing here invents a credential: a program matches only when the workspace
 * has one whose name or environment variable is in this list, or whose own
 * `commands` metadata names the program. Guessing wider would produce coaching
 * for credentials that do not exist, and false coaching is what makes people
 * turn the hook off.
 */
const CONVENTIONAL_COMMAND_CREDENTIALS: Readonly<Record<string, readonly string[]>> = {
  aws: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"],
  claude: ["ANTHROPIC_API_KEY"],
  doctl: ["DIGITALOCEAN_ACCESS_TOKEN"],
  fly: ["FLY_API_TOKEN"],
  gh: ["GITHUB_TOKEN"],
  heroku: ["HEROKU_API_KEY"],
  kubectl: ["KUBECONFIG"],
  npm: ["NPM_TOKEN"],
  openai: ["OPENAI_API_KEY"],
  psql: ["DATABASE_URL", "PGPASSWORD"],
  railway: ["RAILWAY_TOKEN"],
  "sentry-cli": ["SENTRY_TOKEN"],
  stripe: ["STRIPE_API_KEY", "STRIPE_SECRET_KEY"],
  supabase: ["SUPABASE_ACCESS_TOKEN"],
  terraform: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
  vercel: ["VERCEL_TOKEN"],
  wrangler: ["CLOUDFLARE_API_TOKEN"],
};

export type HintCatalogueEntry = {
  id: string;
  name: string;
  envVar?: string;
  commands: readonly string[];
};

export type CommandHint = {
  /** The segment this hint is about, as it was written. */
  segment: string;
  program: string;
  /** Credential names, in catalogue order, never values. */
  credentials: readonly string[];
  /** A copy-pasteable replacement, or null when there is nothing to change. */
  rewrite: string | null;
  /** Already going through the CLI: the command is correct as written. */
  alreadyWrapped: boolean;
};

/**
 * Split a shell line into roughly independent commands.
 *
 * Deliberately naive: it does not understand quoting or subshells. Getting this
 * wrong costs a missed coaching opportunity and never a wrong release, so
 * simple and permissive is the right trade.
 */
export function commandSegments(command: string): readonly string[] {
  return command
    .split(/\|\||&&|[|;&\n]/u)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function basename(token: string): string {
  const parts = token.split(/[\\/]/u);
  return parts[parts.length - 1] ?? token;
}

function isAssignment(token: string): boolean {
  return token.includes("=") && !token.startsWith("-");
}

/** The first real program in a segment, skipping `FOO=bar` prefixes and wrappers. */
export function leadingProgram(segment: string): string {
  for (const token of segment.split(/\s+/u)) {
    if (token.length === 0 || isAssignment(token)) continue;
    const name = basename(token);
    if ((WRAPPERS as readonly string[]).includes(name)) continue;
    return name;
  }
  return "";
}

/** Does any part of this command already run through the Lepidy CLI? */
export function isWrappedCommand(command: string): boolean {
  return commandSegments(command).some((segment) => ["lepidy", "lp"].includes(leadingProgram(segment)));
}

function credentialsForProgram(program: string, catalogue: readonly HintCatalogueEntry[]): readonly string[] {
  if (program.length === 0) return [];
  const conventional = CONVENTIONAL_COMMAND_CREDENTIALS[program] ?? [];
  return catalogue
    .filter((entry) =>
      entry.commands.includes(program)
      || conventional.includes(entry.name)
      || (entry.envVar !== undefined && conventional.includes(entry.envVar)))
    .map((entry) => entry.name);
}

/**
 * Which credentials this command needs, and how to write it so the value never
 * reaches the conversation.
 *
 * One hint per segment that needs something. A segment already going through
 * the CLI is reported as correct rather than silently dropped, because "you are
 * already doing this right" is a useful answer to a client that asked.
 */
export function commandHints(command: string, catalogue: readonly HintCatalogueEntry[]): readonly CommandHint[] {
  const hints: CommandHint[] = [];
  for (const segment of commandSegments(command)) {
    const program = leadingProgram(segment);
    const alreadyWrapped = ["lepidy", "lp"].includes(program);
    const credentials = alreadyWrapped ? [] : credentialsForProgram(program, catalogue);
    if (!alreadyWrapped && credentials.length === 0) continue;
    hints.push({
      segment,
      program,
      credentials,
      rewrite: alreadyWrapped ? null : `lepidy run --with ${credentials.join(",")} -- ${segment}`,
      alreadyWrapped,
    });
  }
  return hints;
}

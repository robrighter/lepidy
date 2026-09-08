//! `lepidy hook pretooluse` — the Claude Code `PreToolUse` hook.
//!
//! Adapted from Agent Vault's `crates/av-cli/src/hook.rs` at
//! `d794820084151eddbdbb56bf9cd10b5bf3666cdc`. The rules and their ordering are
//! its; the daemon it asked for facts is replaced by the local advice cache,
//! because this runs on every Bash tool call and cannot read a passphrase or
//! wait for a network round trip.
//!
//! # This is not a security boundary
//!
//! Say it wherever this is described, or somebody will eventually rely on it.
//!
//! - It sees **Bash tool calls only**. A file read, an editor, a language
//!   runtime, an MCP tool on another server and a shell spawned by a script are
//!   all invisible to it.
//! - It **fails open on every error**: bad JSON, a missing cache, an unreadable
//!   file, a panic. A hook that failed closed would block every command the
//!   agent runs, which is far worse than missing a coaching moment.
//! - An agent can trivially construct a command shape it does not recognise,
//!   and the hook is configuration on the agent's own machine, which the agent
//!   can edit.
//! - It reads a **cache** that may be stale.
//!
//! What decides whether a credential may be released is the workspace's policy
//! engine — ordered, fail-closed, re-evaluated per request against a signed
//! device claim, a live delegation and a live ACL. Nothing in this file is
//! consulted by it. The hook exists to teach at the moment of the mistake and
//! to save a wasted turn, and that is all it is for.
//!
//! # Budget
//!
//! Rule 1 short-circuits before the cache is even opened, because every
//! injected command the agent runs lands here. The rest is a file read and some
//! string work.

use std::io::Read;

use serde_json::Value;

use crate::advice::{load, Advice};
use crate::args::Args;
use crate::error::{CliError, CliResult};
use crate::hint::{base, hints, is_assignment, is_wrapped, leading_program, segments};
use crate::scan::Credential;

pub const ALLOW: i32 = 0;
/// Claude Code reads exit code 2 from a `PreToolUse` hook as "do not run this,
/// and show the agent what was written to standard error".
pub const BLOCK: i32 = 2;

/// Programs that read a file's contents out to standard output.
const READERS: &[&str] = &[
    "cat", "less", "more", "head", "tail", "bat", "grep", "rg", "strings", "xxd", "od", "nl",
];

/// Templates, not credentials. Blocking these is pure false coaching — they
/// exist to be read, and they are what somebody checks to work out what a
/// project needs.
const ENV_TEMPLATE_SUFFIXES: &[&str] = &[".example", ".sample", ".template", ".dist"];

#[derive(Debug, PartialEq, Eq)]
pub enum Ruling {
    Allow,
    Block(String),
}

/// Everything the rules need, gathered before any of them run.
///
/// A plain struct, which is what makes [`evaluate`] pure and the whole rule set
/// testable without a cache, a workspace or a vault.
#[derive(Debug, Default)]
pub struct Facts {
    /// Names and environment variables the vault holds. Empty when there is no
    /// cache, which correctly makes rules 3 and 5 silent.
    pub known: Vec<String>,
    /// Credentials whose *value* appears literally in the command text.
    pub value_hits: Vec<String>,
    /// Per segment, the credentials that segment needs.
    pub hints: Vec<(String, Vec<String>)>,
}

pub fn run(args: &Args) -> CliResult<i32> {
    match args.positional(0) {
        Some("pretooluse") | None => Ok(pretooluse()),
        Some(other) => Err(CliError::usage(format!(
            "{other:?} is not a hook this CLI answers; the only one is `lepidy hook pretooluse`"
        ))),
    }
}

/// Fail open around everything. An unexpected shape must not stop the agent
/// from running commands.
fn pretooluse() -> i32 {
    let mut raw = String::new();
    if std::io::stdin().read_to_string(&mut raw).is_err() {
        return ALLOW;
    }
    let Some(command) = bash_command(&raw) else {
        return ALLOW;
    };
    // Rule 1, before the cache is opened: never coach a command that is already
    // correct. This is the hot path — every injected command lands here.
    if is_wrapped(&command) {
        return ALLOW;
    }
    let facts = match load() {
        Some(advice) => gather(&command, &advice),
        None => Facts::default(),
    };
    match evaluate(&command, &facts) {
        Ruling::Allow => ALLOW,
        Ruling::Block(message) => {
            eprintln!("{}", message.trim());
            BLOCK
        }
    }
}

/// The Bash command inside Claude Code's hook JSON.
///
/// `None` — meaning allow — for any other tool, a missing or empty command, and
/// anything that does not parse.
pub fn bash_command(raw: &str) -> Option<String> {
    let parsed: Value = serde_json::from_str(raw).ok()?;
    if parsed.get("tool_name")?.as_str()? != "Bash" {
        return None;
    }
    let command = parsed.get("tool_input")?.get("command")?.as_str()?;
    if command.trim().is_empty() {
        return None;
    }
    Some(command.to_string())
}

/// Ordered, first match wins. Pure: everything it needs is in `facts`.
pub fn evaluate(command: &str, facts: &Facts) -> Ruling {
    // 1. Already going through Lepidy.
    if is_wrapped(command) {
        return Ruling::Allow;
    }

    // 2. A credential *value* is sitting in the command text. Something has
    //    already put a plaintext credential in the agent's context; the least
    //    this can do is keep it out of argv and the shell history as well.
    if !facts.value_hits.is_empty() {
        return Ruling::Block(format!(
            "This command contains the value of a credential Lepidy holds ({}).\n\
             Do not pass credentials as arguments — argv is readable by every process on this machine \
             and is written to shell history.\n\
             Use injection instead:  lepidy run --with {} -- <command>\n\
             If that value came from the conversation it is already exposed: tell the user and rotate it.",
            facts.value_hits.join(", "),
            facts.value_hits.join(",")
        ));
    }

    for segment in segments(command) {
        // 3. Printing an injected value straight back out, which is exactly
        //    what injection exists to prevent.
        if let Some(variable) = echoed_credential(segment, &facts.known) {
            return Ruling::Block(format!(
                "Printing ${variable} would copy the credential into this conversation and into the session \
                 transcript on disk, which is what injection prevents.\n\
                 If you need to check that it works, run the real command through Lepidy:  \
                 lepidy run --with {variable} -- <command>"
            ));
        }
        if !facts.known.is_empty() && is_bare_env_dump(segment) {
            return Ruling::Block(
                "Dumping the environment would copy any injected credential into this conversation. \
                 Run the specific command you need through Lepidy instead:  \
                 lepidy run --with <NAME> -- <command>"
                    .into(),
            );
        }

        // 4. Reading a credential file Lepidy should be the source for. This is
        //    the circumvention move that matters most: an agent that politely
        //    routes around a denial leaves the user believing they are
        //    protected, which is worse than having no vault at all.
        if let Some(path) = credential_file_read(segment) {
            return Ruling::Block(format!(
                "Lepidy holds this machine's credentials; do not read them from {path}.\n\
                 Run `lepidy list` to see what is available, then use `lepidy run --with <NAME> -- <command>`.\n\
                 If you genuinely need a non-secret value from that file, say so and ask the user."
            ));
        }
    }

    // 5. The command needs a credential and is not wrapped. Coach before it
    //    401s, which turns a wasted turn into zero-turn discovery.
    for (segment, names) in &facts.hints {
        if names.is_empty() {
            continue;
        }
        return Ruling::Block(format!(
            "`{}` needs {}, which Lepidy holds.\n\
             Re-run it as:  lepidy run --with {} -- {segment}\n\
             The value goes into that command's environment, not into this conversation.",
            leading_program(segment),
            names.join(", "),
            names.join(",")
        ));
    }

    Ruling::Allow
}

/// Everything the rules need, read from the cache and nothing else.
pub fn gather(command: &str, advice: &Advice) -> Facts {
    let credentials: Vec<Credential> = advice
        .credentials
        .iter()
        .filter_map(|entry| {
            Some(Credential {
                name: entry.name.clone(),
                digest: entry.digest.clone()?,
                length: entry.length?,
                workspace_id: advice.workspace_id.clone(),
                credential_id: entry.id.clone(),
                version: entry.version,
            })
        })
        .collect();
    Facts {
        known: advice.variables().into_iter().map(str::to_string).collect(),
        value_hits: crate::scan::matches(command.as_bytes(), advice, &credentials),
        hints: hints(command, advice)
            .into_iter()
            .filter(|hint| !hint.already_wrapped)
            .map(|hint| (hint.segment, hint.credentials))
            .collect(),
    }
}

/// Every `$NAME` and `${NAME}` reference in a string.
fn dollar_refs(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'$' {
            index += 1;
            continue;
        }
        let mut end = index + 1;
        if bytes.get(end) == Some(&b'{') {
            end += 1;
        }
        let start = end;
        while end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_') {
            end += 1;
        }
        if end > start {
            out.push(&text[start..end]);
        }
        index = (index + 1).max(end);
    }
    out
}

/// The credential a segment would print, if it prints one.
///
/// `printenv` is handled separately from `echo`/`printf` because it names
/// variables as bare words rather than as `$` references.
fn echoed_credential<'a>(segment: &str, known: &'a [String]) -> Option<&'a String> {
    let candidates: Vec<&str> = match leading_program(segment) {
        "echo" | "printf" => dollar_refs(segment),
        "printenv" => {
            let mut refs = dollar_refs(segment);
            refs.extend(
                segment
                    .split_whitespace()
                    .skip(1)
                    .filter(|token| !token.starts_with('-') && !is_assignment(token)),
            );
            refs
        }
        _ => return None,
    };
    known
        .iter()
        .find(|name| candidates.contains(&name.as_str()))
}

/// A bare `env` that dumps everything, as opposed to `env FOO=1 prog`, which
/// merely uses `env` to set something up.
fn is_bare_env_dump(segment: &str) -> bool {
    let mut saw_env = false;
    for token in segment.split_whitespace() {
        if is_assignment(token) {
            continue;
        }
        if !saw_env {
            if base(token) == "env" {
                saw_env = true;
                continue;
            }
            if crate::hint::WRAPPERS.contains(&base(token)) {
                continue;
            }
            return false;
        }
        // After `env`: a flag is still a dump (`env -0`); a program is not.
        if !token.starts_with('-') {
            return false;
        }
    }
    saw_env
}

/// Does this token name a file Lepidy should be the source for?
fn is_credential_path(token: &str) -> bool {
    let name = base(token);
    if name == ".env" || name.starts_with(".env.") {
        return !ENV_TEMPLATE_SUFFIXES
            .iter()
            .any(|suffix| name.ends_with(suffix));
    }
    match name {
        ".netrc" | ".pgpass" => true,
        // Far too generic on its own — half the repositories in the world have
        // a file called `credentials`. Only the AWS one counts.
        "credentials" => token.contains("/.aws/") || token.contains("\\.aws\\"),
        "config.json" => token.contains("/.docker/") || token.contains("\\.docker\\"),
        // Private SSH keys, but not the `.pub` half of the pair.
        _ => name.starts_with("id_") && !name.ends_with(".pub"),
    }
}

/// The credential file a segment reads, if it reads one.
fn credential_file_read(segment: &str) -> Option<&str> {
    if !READERS.contains(&leading_program(segment)) {
        return None;
    }
    segment
        .split_whitespace()
        .skip(1)
        .filter(|token| !token.starts_with('-') && !is_assignment(token))
        .find(|token| is_credential_path(token))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn known(names: &[&str]) -> Facts {
        Facts {
            known: names.iter().map(|name| name.to_string()).collect(),
            ..Facts::default()
        }
    }

    fn blocked(ruling: Ruling) -> String {
        match ruling {
            Ruling::Block(message) => message,
            Ruling::Allow => panic!("expected a block, got allow"),
        }
    }

    fn assert_allowed(command: &str, facts: &Facts) {
        assert_eq!(
            evaluate(command, facts),
            Ruling::Allow,
            "{command:?} should have been allowed"
        );
    }

    /// VAULT-CLI-RULE-053
    #[test]
    fn a_correct_command_is_never_coached() {
        // Rule 1 wins even when every other rule would fire: running
        // `lepidy run --with X -- printenv X` is the *right* thing to do.
        let facts = Facts {
            known: vec!["GITHUB_TOKEN".into()],
            value_hits: vec!["GITHUB_TOKEN".into()],
            hints: vec![("gh pr list".into(), vec!["GITHUB_TOKEN".into()])],
        };
        assert_allowed("lepidy run --with GITHUB_TOKEN -- gh pr list", &facts);
        assert_allowed(
            "lp run --with GITHUB_TOKEN -- printenv GITHUB_TOKEN",
            &facts,
        );
        assert_allowed(
            "/usr/local/bin/lepidy run --with GITHUB_TOKEN -- gh pr list",
            &facts,
        );
        assert_allowed("sudo lepidy run --with X -- true", &facts);
    }

    /// VAULT-CLI-RULE-054
    #[test]
    fn a_literal_credential_value_in_the_command_is_blocked() {
        let facts = Facts {
            value_hits: vec!["GITHUB_TOKEN".into()],
            ..Facts::default()
        };
        let message = blocked(evaluate("curl -H 'Authorization: ghp_real'", &facts));
        assert!(message.contains("GITHUB_TOKEN"));
        assert!(message.contains("argv is readable"), "{message}");
        assert!(message.contains("rotate"), "{message}");
    }

    /// VAULT-CLI-RULE-055
    #[test]
    fn printing_an_injected_value_is_blocked() {
        let facts = known(&["GITHUB_TOKEN"]);
        for command in [
            "echo $GITHUB_TOKEN",
            "echo \"$GITHUB_TOKEN\"",
            "echo ${GITHUB_TOKEN}",
            "printf '%s' $GITHUB_TOKEN",
            "printenv GITHUB_TOKEN",
            "ls && echo $GITHUB_TOKEN",
        ] {
            let message = blocked(evaluate(command, &facts));
            assert!(message.contains("GITHUB_TOKEN"), "{command}: {message}");
            assert!(message.contains("transcript"), "{command}: {message}");
        }
    }

    /// VAULT-CLI-RULE-056
    #[test]
    fn printing_something_that_is_not_a_credential_is_fine() {
        // The rule keys off what the vault holds, not off the word "token".
        let facts = known(&["GITHUB_TOKEN"]);
        assert_allowed("echo $HOME", &facts);
        assert_allowed("echo $SOME_OTHER_TOKEN", &facts);
        assert_allowed("echo hello world", &facts);
        // With an empty cache nothing is a credential.
        assert_allowed("echo $GITHUB_TOKEN", &Facts::default());
    }

    /// VAULT-CLI-RULE-057
    #[test]
    fn a_bare_env_dump_is_blocked_but_env_as_a_wrapper_is_not() {
        let facts = known(&["GITHUB_TOKEN"]);
        for command in ["env", "env | grep TOKEN", "env -0"] {
            assert!(
                matches!(evaluate(command, &facts), Ruling::Block(_)),
                "{command}"
            );
        }
        assert_allowed("env FOO=1 ls -la", &facts);
        assert_allowed("env RUST_LOG=debug cargo test", &facts);
        assert_allowed("env", &Facts::default());
    }

    /// VAULT-CLI-RULE-058
    #[test]
    fn reading_a_credential_file_is_blocked() {
        let facts = Facts::default();
        for command in [
            "cat .env",
            "cat /home/maya/dev/app/.env",
            "grep TOKEN .env.local",
            "head ~/.aws/credentials",
            "cat ~/.netrc",
            "cat ~/.ssh/id_rsa",
            "cat ~/.ssh/id_ed25519",
            "cat ~/.pgpass",
            "cat ~/.docker/config.json",
        ] {
            assert!(
                matches!(evaluate(command, &facts), Ruling::Block(_)),
                "{command} should have been blocked"
            );
        }
    }

    /// VAULT-CLI-RULE-059
    #[test]
    fn ordinary_file_reads_are_left_alone() {
        // False coaching is the failure mode that makes people disable a hook,
        // and a disabled hook teaches nobody anything.
        let facts = Facts::default();
        for command in [
            "cat README.md",
            "cat src/main.rs",
            "grep -r TODO .",
            "head -20 Cargo.toml",
            "cat .envrc",
            "cat .gitignore",
            "cat ~/.ssh/id_rsa.pub",
            "cat .env.example",
            "cat .env.sample",
            "cat .env.template",
        ] {
            assert_allowed(command, &facts);
        }
    }

    /// VAULT-CLI-RULE-060
    #[test]
    fn an_unwrapped_command_gets_the_exact_rewrite() {
        let facts = Facts {
            hints: vec![("gh pr list".into(), vec!["GITHUB_TOKEN".into()])],
            ..Facts::default()
        };
        let message = blocked(evaluate("gh pr list", &facts));
        assert!(
            message.contains("lepidy run --with GITHUB_TOKEN -- gh pr list"),
            "the rewrite must be copy-pasteable: {message}"
        );
        assert!(message.contains("not into this conversation"), "{message}");

        let several = Facts {
            hints: vec![(
                "aws s3 ls".into(),
                vec!["AWS_ACCESS_KEY_ID".into(), "AWS_SECRET_ACCESS_KEY".into()],
            )],
            ..Facts::default()
        };
        assert!(blocked(evaluate("aws s3 ls", &several))
            .contains("--with AWS_ACCESS_KEY_ID,AWS_SECRET_ACCESS_KEY -- aws s3 ls"));
    }

    /// VAULT-CLI-RULE-061
    #[test]
    fn a_command_needing_nothing_is_allowed() {
        assert_allowed("ls -la", &Facts::default());
        assert_allowed("cargo test", &known(&["GITHUB_TOKEN"]));
        let empty_hint = Facts {
            hints: vec![("ls -la".into(), vec![])],
            ..Facts::default()
        };
        assert_allowed("ls -la", &empty_hint);
    }

    /// VAULT-CLI-RULE-062
    #[test]
    fn only_bash_calls_are_examined_and_anything_odd_is_allowed() {
        assert_eq!(
            bash_command(r#"{"tool_name":"Bash","tool_input":{"command":"ls -la"}}"#).as_deref(),
            Some("ls -la")
        );
        // Every one of these means allow. A hook that failed closed would block
        // every command the agent runs.
        for raw in [
            "",
            "not json at all",
            "{",
            "[]",
            "null",
            r#"{"tool_name":"Read","tool_input":{"file_path":"/etc/passwd"}}"#,
            r#"{"tool_name":"Bash"}"#,
            r#"{"tool_name":"Bash","tool_input":{}}"#,
            r#"{"tool_input":{"command":"ls"}}"#,
            r#"{"tool_name":42,"tool_input":{"command":"ls"}}"#,
            r#"{"tool_name":"Bash","tool_input":{"command":"   "}}"#,
        ] {
            assert_eq!(bash_command(raw), None, "{raw:?} should have been ignored");
        }
    }

    /// VAULT-CLI-RULE-063
    #[test]
    fn the_first_matching_rule_wins() {
        // A literal value (rule 2) outranks a missing wrapper (rule 5): the
        // exposed credential is the more urgent thing to say.
        let facts = Facts {
            known: vec!["GITHUB_TOKEN".into()],
            value_hits: vec!["GITHUB_TOKEN".into()],
            hints: vec![("gh auth login".into(), vec!["GITHUB_TOKEN".into()])],
        };
        assert!(
            blocked(evaluate("gh auth login --with-token ghp_real", &facts))
                .contains("argv is readable")
        );
    }

    /// VAULT-CLI-RULE-064
    #[test]
    fn a_pipeline_is_judged_one_segment_at_a_time() {
        let facts = Facts {
            hints: vec![("gh pr list".into(), vec!["GITHUB_TOKEN".into()])],
            ..Facts::default()
        };
        assert!(blocked(evaluate("ls | gh pr list", &facts))
            .contains("lepidy run --with GITHUB_TOKEN -- gh pr list"));
    }
}

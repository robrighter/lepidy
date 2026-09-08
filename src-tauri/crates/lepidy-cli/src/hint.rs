//! `lepidy hint` — which credentials does this command need?
//!
//! Layer 2 of the onboarding model, in its local form. The MCP server answers
//! the same question with `credential_hint`, and a harness on this machine can
//! ask without a round trip and without a passphrase, from the advice cache.
//!
//! Everything below is pure: a command string and a catalogue in, names and a
//! rewrite out. That is what makes the hook's whole rule set testable without a
//! workspace, a network or a vault.

use serde_json::json;

use crate::advice::{load, Advice};
use crate::args::Args;
use crate::error::CliResult;

/// Wrappers that stand in front of the program that actually matters, so
/// `sudo aws s3 ls` is an `aws` command. `env` is here too, which is why a bare
/// `env` dump is recognised separately by the hook.
pub const WRAPPERS: &[&str] = &["sudo", "command", "exec", "time", "nohup", "env"];

/// Conventional program-to-variable mappings, used only to *recognise* a
/// credential this workspace already holds.
///
/// Nothing here invents one: a program matches only when the vault has a
/// credential whose name or environment variable is on the list, or whose own
/// `commands` metadata names the program. Guessing wider would coach for
/// credentials that do not exist, and false coaching is what makes somebody
/// turn the hook off — after which none of this helps anybody.
///
/// This table is the same one `src/domain/agent-onboarding.ts` carries. The two
/// are duplicated deliberately: the hook must answer in milliseconds with no
/// network, and the MCP tool must answer for a client that has no local CLI.
const CONVENTIONAL: &[(&str, &[&str])] = &[
    (
        "aws",
        &[
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
            "AWS_SESSION_TOKEN",
        ],
    ),
    ("claude", &["ANTHROPIC_API_KEY"]),
    ("doctl", &["DIGITALOCEAN_ACCESS_TOKEN"]),
    ("fly", &["FLY_API_TOKEN"]),
    ("gh", &["GITHUB_TOKEN"]),
    ("heroku", &["HEROKU_API_KEY"]),
    ("kubectl", &["KUBECONFIG"]),
    ("npm", &["NPM_TOKEN"]),
    ("openai", &["OPENAI_API_KEY"]),
    ("psql", &["DATABASE_URL", "PGPASSWORD"]),
    ("railway", &["RAILWAY_TOKEN"]),
    ("sentry-cli", &["SENTRY_TOKEN"]),
    ("stripe", &["STRIPE_API_KEY", "STRIPE_SECRET_KEY"]),
    ("supabase", &["SUPABASE_ACCESS_TOKEN"]),
    ("terraform", &["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]),
    ("vercel", &["VERCEL_TOKEN"]),
    ("wrangler", &["CLOUDFLARE_API_TOKEN"]),
];

#[derive(Debug, PartialEq, Eq)]
pub struct Hint {
    pub segment: String,
    pub program: String,
    pub credentials: Vec<String>,
    /// The command to run instead, or `None` when it is already correct.
    pub rewrite: Option<String>,
    pub already_wrapped: bool,
}

/// Split a shell line into roughly independent commands.
///
/// Deliberately naive — no quoting, no subshells. Getting this wrong costs a
/// missed coaching opportunity and never a wrong release, so simple and
/// permissive is the right trade. Every separator is ASCII, so slicing at one
/// is always on a UTF-8 boundary.
pub fn segments(command: &str) -> Vec<&str> {
    let bytes = command.as_bytes();
    let mut out = Vec::new();
    let (mut start, mut index) = (0usize, 0usize);
    while index < bytes.len() {
        let width = match bytes[index] {
            b'|' if bytes.get(index + 1) == Some(&b'|') => 2,
            b'&' if bytes.get(index + 1) == Some(&b'&') => 2,
            b'|' | b';' | b'&' | b'\n' => 1,
            _ => {
                index += 1;
                continue;
            }
        };
        out.push(&command[start..index]);
        index += width;
        start = index;
    }
    out.push(&command[start..]);
    out.into_iter()
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .collect()
}

pub fn base(token: &str) -> &str {
    token.rsplit(['/', '\\']).next().unwrap_or(token)
}

pub fn is_assignment(token: &str) -> bool {
    token.contains('=') && !token.starts_with('-')
}

/// The first real program in a segment, skipping `FOO=bar` prefixes and wrappers.
pub fn leading_program(segment: &str) -> &str {
    for token in segment.split_whitespace() {
        if is_assignment(token) || WRAPPERS.contains(&base(token)) {
            continue;
        }
        return base(token);
    }
    ""
}

/// Does any part of this command already go through the Lepidy CLI?
pub fn is_wrapped(command: &str) -> bool {
    segments(command)
        .iter()
        .any(|segment| matches!(leading_program(segment), "lepidy" | "lp"))
}

fn credentials_for(program: &str, advice: &Advice) -> Vec<String> {
    if program.is_empty() {
        return Vec::new();
    }
    let conventional = CONVENTIONAL
        .iter()
        .find(|(name, _)| *name == program)
        .map(|(_, variables)| *variables)
        .unwrap_or(&[]);
    advice
        .credentials
        .iter()
        .filter(|entry| {
            entry.commands.iter().any(|command| command == program)
                || conventional.contains(&entry.name.as_str())
                || conventional.contains(&entry.env_var.as_str())
        })
        .map(|entry| entry.name.clone())
        .collect()
}

/// One hint per segment that needs something, plus any segment that is already
/// correct — because "you are already doing this right" is a useful answer to
/// something that asked.
pub fn hints(command: &str, advice: &Advice) -> Vec<Hint> {
    let mut hints = Vec::new();
    for segment in segments(command) {
        let program = leading_program(segment);
        let already_wrapped = matches!(program, "lepidy" | "lp");
        let credentials = if already_wrapped {
            Vec::new()
        } else {
            credentials_for(program, advice)
        };
        if !already_wrapped && credentials.is_empty() {
            continue;
        }
        hints.push(Hint {
            segment: segment.to_string(),
            program: program.to_string(),
            rewrite: if already_wrapped {
                None
            } else {
                Some(format!(
                    "lepidy run --with {} -- {segment}",
                    credentials.join(",")
                ))
            },
            credentials,
            already_wrapped,
        });
    }
    hints
}

pub fn run(args: &Args) -> CliResult<i32> {
    let command = args.require("command")?.to_string();
    let advice = if args.flag("refresh") {
        let session = crate::session::Session::open()?;
        let project = session.project(args.option("project"));
        crate::advice::refresh(&session, &project)?
    } else {
        match load() {
            Some(advice) => advice,
            None => {
                // Not an error. There is simply nothing to say yet, and saying
                // it loudly on every Bash call would be worse than saying
                // nothing at all.
                if args.flag("json") {
                    println!("{}", json!({ "command": command, "hints": [] }));
                } else {
                    eprintln!(
                        "lepidy: no local credential list yet. Run `lepidy hint --refresh --command ...` \
                         or any authenticated command to build one."
                    );
                }
                return Ok(0);
            }
        }
    };

    let hints = hints(&command, &advice);
    if args.flag("json") {
        println!(
            "{}",
            json!({
                "command": command,
                "hints": hints.iter().map(|hint| json!({
                    "segment": hint.segment,
                    "program": hint.program,
                    "credentials": hint.credentials,
                    "run": hint.rewrite,
                    "alreadyCorrect": hint.already_wrapped,
                })).collect::<Vec<_>>(),
            })
        );
        return Ok(0);
    }
    if hints.is_empty() {
        println!("No credential this member holds is associated with that command.");
        return Ok(0);
    }
    for hint in &hints {
        if hint.already_wrapped {
            println!("`{}` already goes through lepidy.", hint.segment);
            continue;
        }
        println!(
            "`{}` needs {}. Run it as:\n    {}",
            hint.segment,
            hint.credentials.join(", "),
            hint.rewrite.as_deref().unwrap_or_default()
        );
    }
    println!("The value goes into that command's environment, not into your context.");
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::advice::{AdviceEntry, ADVICE_VERSION};

    fn advice(entries: &[(&str, &str, &[&str])]) -> Advice {
        Advice {
            version: ADVICE_VERSION,
            workspace_id: "ws".into(),
            workspace_slug: "slug".into(),
            refreshed_at: 0,
            credentials: entries
                .iter()
                .map(|(name, env_var, commands)| AdviceEntry {
                    id: format!("cred-{name}"),
                    name: (*name).to_string(),
                    env_var: (*env_var).to_string(),
                    commands: commands.iter().map(|value| (*value).to_string()).collect(),
                    ..AdviceEntry::default()
                })
                .collect(),
        }
    }

    /// VAULT-CLI-RULE-045
    #[test]
    fn splits_on_every_separator_and_finds_the_real_program() {
        assert_eq!(
            segments("a | b && c; d & e\nf"),
            vec!["a", "b", "c", "d", "e", "f"]
        );
        assert!(segments(" ; ; ").is_empty());
        assert_eq!(
            leading_program("sudo FOO=bar /usr/local/bin/gh pr list"),
            "gh"
        );
        assert_eq!(leading_program("env AWS_REGION=eu-west-1 aws s3 ls"), "aws");
        assert_eq!(leading_program(""), "");
        // Separators are ASCII, so slicing never lands mid-character.
        assert_eq!(segments("échò | wörld"), vec!["échò", "wörld"]);
    }

    /// VAULT-CLI-RULE-046
    #[test]
    fn names_the_credentials_a_command_needs_and_the_exact_rewrite() {
        let advice = advice(&[
            ("GITHUB_TOKEN", "GITHUB_TOKEN", &[]),
            ("AWS_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID", &[]),
            ("AWS_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY", &[]),
            ("HOUSE_TOKEN", "HOUSE_TOKEN", &["housectl"]),
        ]);
        let found = hints("gh pr list", &advice);
        assert_eq!(found[0].credentials, vec!["GITHUB_TOKEN"]);
        assert_eq!(
            found[0].rewrite.as_deref(),
            Some("lepidy run --with GITHUB_TOKEN -- gh pr list")
        );
        // One command, one invocation, one approval card.
        assert_eq!(
            hints("aws s3 ls", &advice)[0].rewrite.as_deref(),
            Some("lepidy run --with AWS_ACCESS_KEY_ID,AWS_SECRET_ACCESS_KEY -- aws s3 ls")
        );
        // A credential's own declared command counts as much as a convention.
        assert_eq!(
            hints("housectl deploy", &advice)[0].credentials,
            vec!["HOUSE_TOKEN"]
        );
    }

    /// VAULT-CLI-RULE-047
    #[test]
    fn never_invents_a_credential_the_vault_does_not_hold() {
        let advice = advice(&[("GITHUB_TOKEN", "GITHUB_TOKEN", &[])]);
        assert!(hints("stripe listen", &advice).is_empty());
        assert!(hints("cargo test", &advice).is_empty());
        assert!(hints("", &advice).is_empty());
    }

    /// VAULT-CLI-RULE-048
    #[test]
    fn reports_a_correct_command_as_correct() {
        let advice = advice(&[("GITHUB_TOKEN", "GITHUB_TOKEN", &[])]);
        assert!(is_wrapped("lepidy run --with GITHUB_TOKEN -- gh pr list"));
        assert!(is_wrapped("ls && lp capture TOKEN -- gh auth token"));
        assert!(!is_wrapped("echo lepidy"));
        let found = hints("lepidy run --with GITHUB_TOKEN -- gh pr list", &advice);
        assert!(found[0].already_wrapped);
        assert_eq!(found[0].rewrite, None);
    }
}

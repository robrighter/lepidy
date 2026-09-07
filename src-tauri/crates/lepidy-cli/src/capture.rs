//! `lepidy capture` — the only write path an agent has.
//!
//! Adapted from Agent Vault's `crates/av-cli/src/capture.rs` at
//! `d794820084151eddbdbb56bf9cd10b5bf3666cdc`, with its reasoning intact.
//!
//! The mirror image of injection: a command's stdout goes straight into the
//! vault and the agent sees only success or failure. The obvious alternative —
//! a tool taking the value as an argument — is self-defeating, because for the
//! agent to pass the value it must already hold it in context, so the secret is
//! in the transcript before it ever reaches the vault. It is also dangerous:
//! that shape is what makes a credential swap possible, where a prompt-injected
//! agent overwrites a token with the attacker's and everything keeps working.
//!
//! So capture is create-only, and what it creates arrives switched off until a
//! custodian has seen which program produced it.

use std::io::Read;
use std::process::{Command, Stdio};

use zeroize::Zeroize;

use crate::args::Args;
use crate::error::{CliError, CliResult};
use crate::seal::{seal_and_create, CreateRequest};
use crate::session::Session;

/// Well below any request limit. Stops a mistaken
/// `lepidy capture TOKEN -- cat huge.log` from stuffing a logfile into the vault.
const MAX_CAPTURE_BYTES: usize = 64 * 1024;

pub fn run(args: &Args) -> CliResult<i32> {
    let name = args
        .positional(0)
        .ok_or_else(|| {
            CliError::usage("name the credential: `lepidy capture API_TOKEN -- gh auth token`")
        })?
        .to_string();
    if args.trailing.is_empty() {
        return Err(CliError::usage(
            "nothing to run: put the command after `--`",
        ));
    }
    let session = Session::open()?;
    // Creating a credential is a step-up wherever it is initiated from.
    let password = crate::prompt::read_secret("account password")?;

    let mut child = Command::new(&args.trailing[0])
        .args(&args.trailing[1..])
        .stdin(Stdio::inherit())
        .stdout(Stdio::piped())
        // stderr passes through, so a failing command is still debuggable.
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| {
            CliError::failure(format!("could not run `{}`: {error}", args.trailing[0]))
        })?;

    let mut stdout = child.stdout.take().expect("stdout was piped");
    let mut captured = Vec::new();
    let mut chunk = [0u8; 4096];
    let mut overflowed = false;
    loop {
        match stdout.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                if captured.len() + read > MAX_CAPTURE_BYTES {
                    overflowed = true;
                    break;
                }
                captured.extend_from_slice(&chunk[..read]);
            }
        }
    }
    let status = child
        .wait()
        .map_err(|error| CliError::failure(format!("could not wait for the command: {error}")))?;

    if overflowed {
        captured.zeroize();
        return Err(CliError::failure(format!(
            "that command produced more than {MAX_CAPTURE_BYTES} bytes; nothing was stored"
        )));
    }
    if !status.success() {
        // A failed command's output is a diagnostic, not a credential.
        captured.zeroize();
        return Err(CliError::failure(format!(
            "`{}` exited without success; nothing was stored",
            args.trailing[0]
        )));
    }

    let mut value = String::from_utf8(captured.clone()).map_err(|_| {
        captured.zeroize();
        CliError::failure("that command's output was not text; nothing was stored".to_string())
    })?;
    captured.zeroize();
    // One trailing newline is how every one of these tools prints a token, and
    // it is not part of the token.
    while value.ends_with('\n') || value.ends_with('\r') {
        value.pop();
    }
    if value.is_empty() {
        return Err(CliError::failure(
            "that command printed nothing; nothing was stored".to_string(),
        ));
    }

    let program = program_name(&args.trailing[0]);
    let created = seal_and_create(
        &session,
        CreateRequest {
            name: &name,
            value: &mut value,
            description: args.option("description").unwrap_or(""),
            env_var: args.option("env-var"),
            tags: args.list("tag"),
            commands: Vec::new(),
            // The most restrictive policy there is. A human loosens it
            // afterwards, deliberately, having seen what it is.
            mode: "ask",
            deliveries: vec!["inject".to_string()],
            kind: "opaque",
            fields: Vec::new(),
            rotate_at: None,
            captured_from: Some(&program),
            high_risk: false,
            policy_projects: args.list("policy-project"),
            project: &session.project(args.option("project")),
            password: &password,
        },
    )?;

    println!("Captured {name} as {created}.");
    println!("The value came from `{program}` and was never printed here or held by the agent.");
    println!("It is switched off until a custodian confirms it in the vault.");
    Ok(0)
}

/// The program's name, without its path or arguments.
///
/// This is all that may reach the workspace: arguments are where a path or
/// another secret would be, and the authorization contract keeps local commands
/// out of cloud state.
pub fn program_name(command: &str) -> String {
    let trimmed = command.rsplit(['/', '\\']).next().unwrap_or(command);
    trimmed
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
        .take(64)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::program_name;

    /// VAULT-CLI-RULE-030
    #[test]
    fn keeps_the_program_and_discards_the_path_around_it() {
        assert_eq!(program_name("gh"), "gh");
        assert_eq!(program_name("/usr/local/bin/gh"), "gh");
        assert_eq!(program_name("C:\\Program Files\\gh.exe"), "gh.exe");
        // Nothing that could carry a path or another secret survives.
        assert_eq!(program_name("gh auth token"), "ghauthtoken");
    }
}

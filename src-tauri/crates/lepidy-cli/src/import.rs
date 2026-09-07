//! `lepidy import` — seeding the vault from a `.env` file.
//!
//! Adapted from Agent Vault's `crates/av-cli/src/import.rs` at
//! `d794820084151eddbdbb56bf9cd10b5bf3666cdc`.
//!
//! Create-only, like every other write path: an existing name is reported and
//! skipped, never overwritten. And no value is ever printed — not in the
//! summary, not in a dry run, not in an error. Lengths are, because a length is
//! what justifies the short-value warning and is not itself the secret.
//!
//! The source file is left alone unless somebody asks for it to go. Deleting a
//! developer's `.env` because a tool decided it was redundant is not a
//! convenience, and a half-imported file whose original has been removed is
//! unrecoverable.

use std::fs;

use crate::args::Args;
use crate::envfile::parse_env;
use crate::error::{CliError, CliResult};
use crate::prompt::read_secret;
use crate::seal::{seal_and_create, CreateRequest};
use crate::session::Session;

pub fn run(args: &Args) -> CliResult<i32> {
    let path = args
        .positional(0)
        .ok_or_else(|| CliError::usage("name the file to import: `lepidy import .env`"))?
        .to_string();
    let contents = fs::read_to_string(&path)
        .map_err(|error| CliError::usage(format!("could not read {path}: {error}")))?;
    let mut file = parse_env(&contents);
    let dry_run = args.flag("dry-run");

    for skip in &file.skipped {
        let name = skip.name.as_deref().unwrap_or("that line");
        eprintln!(
            "lepidy: line {} ({name}) was skipped — {}",
            skip.line,
            skip.reason.describe()
        );
    }
    if file.entries.is_empty() {
        println!("Nothing in {path} could be imported.");
        return Ok(0);
    }
    if dry_run {
        for entry in &file.entries {
            // A length, never a value: it is what justifies the short-value
            // warning and is not itself the secret.
            println!(
                "{} — {} bytes, would be created",
                entry.name,
                entry.value.len()
            );
        }
        println!(
            "{} credential(s) would be created. Nothing was sent.",
            file.entries.len()
        );
        return Ok(0);
    }

    let session = Session::open()?;
    let password = read_secret("account password")?;
    let project = session.project(args.option("project"));
    let tags = args.list("tag");

    let mut created = 0usize;
    let mut refused: Vec<String> = Vec::new();
    for entry in &mut file.entries {
        let short = entry.value.len() < 8;
        match seal_and_create(
            &session,
            CreateRequest {
                name: &entry.name,
                value: &mut entry.value,
                description: format!("Imported from {path}").as_str(),
                env_var: Some(&entry.name),
                tags: tags.clone(),
                commands: Vec::new(),
                // The same most-restrictive policy every new credential gets.
                mode: "ask",
                deliveries: vec!["inject".to_string()],
                kind: "opaque",
                fields: Vec::new(),
                rotate_at: None,
                captured_from: None,
                high_risk: false,
                policy_projects: Vec::new(),
                project: &project,
                password: &password,
            },
        ) {
            Ok(_) => {
                created += 1;
                if short {
                    // Too short to redact from a child's output safely, so it
                    // is flagged now rather than silently going unscrubbed.
                    eprintln!(
                        "lepidy: {} is short enough that output scrubbing will not catch it.",
                        entry.name
                    );
                }
            }
            Err(error) => refused.push(format!("{}: {}", entry.name, error.message)),
        }
    }

    println!(
        "Created {created} of {} credential(s) from {path}.",
        file.entries.len()
    );
    for line in &refused {
        eprintln!("lepidy: {line}");
    }

    if args.flag("shred") {
        if !refused.is_empty() {
            return Err(CliError::failure(format!(
                "{path} was left in place: {} credential(s) were refused, and removing the source now would lose them",
                refused.len()
            )));
        }
        // Overwritten before unlinking, which is better than nothing and not the
        // same as gone: on a copy-on-write filesystem or an SSD with wear
        // levelling the old bytes may still be on the medium.
        let blanked = "\n".repeat(contents.len().min(1024 * 1024));
        fs::write(&path, blanked)
            .and_then(|()| fs::remove_file(&path))
            .map_err(|error| CliError::failure(format!("could not remove {path}: {error}")))?;
        println!("Removed {path}. Overwriting before unlinking is not shredding: assume the old bytes may survive on the medium.");
    } else {
        println!("{path} was left where it is. Pass --shred to remove it once you are satisfied.");
    }
    Ok(if refused.is_empty() { 0 } else { 1 })
}

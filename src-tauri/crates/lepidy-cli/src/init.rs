//! `lepidy init` — register Lepidy with Claude Code.
//!
//! Adapted from Agent Vault's `crates/av-cli/src/init.rs` at
//! `d794820084151eddbdbb56bf9cd10b5bf3666cdc`, keeping its central judgement:
//! **write only the configuration whose shape is documented and stable, verify
//! that the pieces actually work, and then say what is left rather than editing
//! files whose schema is a guess.** Silently rewriting somebody's agent
//! configuration on the strength of a guess is a bad trade, and the failure
//! shows up much later as a broken client.
//!
//! What differs from the reference is the transport. Agent Vault's MCP server
//! was a local process; Lepidy's is the workspace itself over HTTPS, so the
//! `.mcp.json` entry names a URL taken from this machine's profile rather than
//! a command to spawn.
//!
//! Nothing here needs the local vault passphrase. `init` reads the profile's
//! plain half — which deployment and workspace this machine belongs to — and
//! writes files. It opens no keystore and sends no request.

use std::path::{Path, PathBuf};

use crate::advice;
use crate::args::Args;
use crate::error::CliResult;
use crate::profile::{load_profile, profile_path, Profile};

const SERVER_NAME: &str = "lepidy";

/// The skill, baked into the binary.
///
/// Embedded rather than read from disk so `init` works from anywhere, including
/// from inside an installed app bundle where the repository it came from does
/// not exist. It also means the skill and the CLI can never be different
/// versions of each other, which matters because the skill documents this
/// CLI's exact behaviour.
const SKILL: &str = include_str!("../../../../plugin/lepidy/skills/lepidy/SKILL.md");

/// The `PreToolUse` registration, likewise embedded.
const HOOKS: &str = include_str!("../../../../plugin/lepidy/hooks/hooks.json");

pub fn run(args: &Args) -> CliResult<i32> {
    let force = args.flag("force");
    let profile = load_profile().ok();

    println!("Lepidy setup\n");
    let mut ready = true;

    match &profile {
        Some(profile) => println!(
            "  workspace   {} at {}",
            profile.workspace_slug, profile.server_url
        ),
        None => {
            println!(
                "  workspace   NOT enrolled — no profile at {}",
                profile_path().display()
            );
            ready = false;
        }
    }

    match which("lepidy") {
        Some(path) => println!("  lepidy      on PATH at {}", path.display()),
        None => {
            println!("  lepidy      NOT on PATH — the hook and the skill both invoke it by name");
            ready = false;
        }
    }

    match advice::load() {
        Some(cache) => println!(
            "  advice      {} credential(s) known locally",
            cache.credentials.len()
        ),
        None => println!(
            "  advice      none yet — run `lepidy list` once so `scan`, `hint` and the hook have something to work from"
        ),
    }

    if args.flag("global") {
        return global(profile.as_ref(), force, ready);
    }

    let cwd = std::env::current_dir()?;
    println!("  {}", install_mcp(&cwd, profile.as_ref(), force));
    println!(
        "  {}",
        install_file(
            &cwd.join(".claude/skills/lepidy"),
            "SKILL.md",
            SKILL,
            force,
            "skill"
        )
    );
    println!("  {}", install_hooks(&cwd));

    println!("\nStill to do by hand, if the lines above did not do it:");
    println!("  • The hook is advice, never a boundary. It only sees Bash calls, it fails open,");
    println!("    and the workspace's policy engine is the thing that actually decides.");
    println!("  • Add credentials with `lepidy add NAME`, or capture one a command mints with");
    println!("    `lepidy capture NAME -- <command>`.");
    println!("\nThis registered Lepidy for this project only, and `.mcp.json` is meant to be");
    println!("committed so your team gets it too. For every project on this machine instead:");
    println!("    lepidy init --global");

    if !ready {
        println!("\nFinish the lines marked NOT above, then run this again to verify.");
        return Ok(1);
    }
    println!("\nReady. Claude Code picks up the server, the skill and the hook on its next start.");
    Ok(0)
}

/// Register for every project, through Claude Code's own CLI.
///
/// Delegated rather than written by hand: the user-level configuration is
/// Claude Code's own file with its own shape, and editing it from outside means
/// guessing at a format that is free to change — while getting it wrong would
/// damage a file the user needs for everything else.
fn global(profile: Option<&Profile>, force: bool, ready: bool) -> CliResult<i32> {
    let Some(profile) = profile else {
        println!("\nEnrol this machine first: `lepidy login --server URL --workspace SLUG`.");
        return Ok(1);
    };
    let Some(claude) = which("claude") else {
        println!("  claude      NOT on PATH");
        println!(
            "\nGlobal setup goes through Claude Code's own CLI. Once `claude` is available, run:\n\n    \
             claude mcp add --transport http {SERVER_NAME} -s user {}\n",
            mcp_url(profile)
        );
        return Ok(1);
    };
    println!("  claude      {}", claude.display());

    let output = std::process::Command::new(&claude)
        .args([
            "mcp",
            "add",
            "--transport",
            "http",
            SERVER_NAME,
            "-s",
            "user",
            &mcp_url(profile),
        ])
        .output()?;
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if output.status.success() {
        println!("  scope       user — available in every project");
    } else if combined.contains("already exists") {
        // Not a failure. Re-running setup should be safe and boring.
        println!("  scope       user — already registered, left alone");
    } else {
        println!("\nclaude mcp add failed:\n{}", combined.trim());
        return Ok(1);
    }

    let home = PathBuf::from(
        std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .unwrap_or_default(),
    );
    println!(
        "  {}",
        install_file(
            &home.join(".claude/skills/lepidy"),
            "SKILL.md",
            SKILL,
            force,
            "skill"
        )
    );
    println!(
        "\nThe PreToolUse hook is per-project by design, because it runs a binary. Add it with\n\
         `lepidy init` inside each project, or paste this into your user settings:\n\n{HOOKS}"
    );
    if !ready {
        return Ok(1);
    }
    Ok(0)
}

fn mcp_url(profile: &Profile) -> String {
    format!(
        "{}/w/{}/mcp",
        profile.server_url.trim_end_matches('/'),
        profile.workspace_slug
    )
}

/// The project-scoped MCP entry.
///
/// `.mcp.json` is a documented, stable format meant to be committed, so it is
/// safe to write directly — but only when it does not exist. Merging JSON
/// somebody else wrote, in a file they may have hand-tuned, is exactly the kind
/// of helpfulness that loses a configuration.
fn install_mcp(directory: &Path, profile: Option<&Profile>, force: bool) -> String {
    let Some(profile) = profile else {
        return ".mcp.json   skipped — this machine is not enrolled in a workspace".to_string();
    };
    let path = directory.join(".mcp.json");
    let entry = format!(
        "{{\n  \"mcpServers\": {{\n    \"{SERVER_NAME}\": {{\n      \"type\": \"http\",\n      \"url\": \"{}\"\n    }}\n  }}\n}}\n",
        mcp_url(profile)
    );
    if path.exists() && !force {
        let existing = std::fs::read_to_string(&path).unwrap_or_default();
        if existing.contains(&format!("\"{SERVER_NAME}\"")) {
            return format!(".mcp.json   already lists {SERVER_NAME}; left alone");
        }
        return format!(
            ".mcp.json   exists and does not list {SERVER_NAME}; left alone. Add:\n              \
             \"{SERVER_NAME}\": {{ \"type\": \"http\", \"url\": \"{}\" }}",
            mcp_url(profile)
        );
    }
    match std::fs::write(&path, entry) {
        Ok(()) => format!(".mcp.json   wrote {}", path.display()),
        Err(error) => format!(".mcp.json   could not write {}: {error}", path.display()),
    }
}

/// Register the `PreToolUse` hook in the project's settings.
///
/// Deliberately with no `--force` path. `settings.json` carries far more than
/// hooks, and a flag that replaced somebody's whole configuration with four
/// lines of ours would eventually be used by accident. If the file exists and
/// does not already name the hook, this prints what to add and changes nothing.
fn install_hooks(directory: &Path) -> String {
    let path = directory.join(".claude/settings.json");
    if let Ok(existing) = std::fs::read_to_string(&path) {
        if existing.contains("lepidy hook pretooluse") {
            return format!("hooks       already registered in {}", path.display());
        }
        return format!(
            "hooks       {} exists; left alone. Add to its \"hooks\" object:\n{HOOKS}",
            path.display()
        );
    }
    if let Err(error) = std::fs::create_dir_all(directory.join(".claude")) {
        return format!(
            "hooks       could not create {}: {error}",
            directory.join(".claude").display()
        );
    }
    match std::fs::write(&path, HOOKS) {
        Ok(()) => format!("hooks       installed at {}", path.display()),
        Err(error) => format!("hooks       could not write {}: {error}", path.display()),
    }
}

/// Write one file, refusing to overwrite one that differs.
///
/// A file that differs was either edited by somebody or written by an older
/// version of this CLI, and from here the two are indistinguishable. Say so
/// instead of quietly discarding whatever it says.
fn install_file(directory: &Path, name: &str, contents: &str, force: bool, label: &str) -> String {
    let path = directory.join(name);
    if let Ok(existing) = std::fs::read_to_string(&path) {
        if existing == contents {
            return format!("{label:<11} already current at {}", path.display());
        }
        if !force {
            return format!(
                "{label:<11} {} differs from this version; left alone (use --force to replace)",
                path.display()
            );
        }
    }
    if let Err(error) = std::fs::create_dir_all(directory) {
        return format!(
            "{label:<11} could not create {}: {error}",
            directory.display()
        );
    }
    match std::fs::write(&path, contents) {
        Ok(()) => format!("{label:<11} installed at {}", path.display()),
        Err(error) => format!("{label:<11} could not write {}: {error}", path.display()),
    }
}

/// A minimal `which`, so setup does not depend on one being installed.
pub fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let candidates: Vec<String> = if cfg!(windows) {
        vec![
            name.to_string(),
            format!("{name}.exe"),
            format!("{name}.cmd"),
            format!("{name}.bat"),
        ]
    } else {
        vec![name.to_string()]
    };
    std::env::split_paths(&path)
        .flat_map(|directory| {
            candidates
                .iter()
                .map(move |candidate| directory.join(candidate))
        })
        .find(|candidate| is_executable(candidate))
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    // Windows has no executable bit; the extension is the convention, and the
    // candidate list above has already applied it.
    std::fs::metadata(path)
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// VAULT-CLI-RULE-065
    #[test]
    fn the_embedded_skill_and_hooks_are_the_shipped_ones() {
        // Embedded rather than read at runtime, so the skill can never be a
        // different version from the CLI it documents.
        assert!(SKILL.contains("Never ask for a credential's value"));
        assert!(SKILL.contains("lepidy run --with"));
        assert!(SKILL.contains("A denial is an answer"));
        assert!(HOOKS.contains("\"PreToolUse\""));
        assert!(HOOKS.contains("lepidy hook pretooluse"));
    }

    /// VAULT-CLI-RULE-066
    #[test]
    fn a_file_that_differs_is_left_alone_unless_forced() {
        let dir = std::env::temp_dir().join(format!("lepidy-init-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a directory");

        assert!(install_file(&dir, "SKILL.md", "one", false, "skill").contains("installed at"));
        assert!(install_file(&dir, "SKILL.md", "one", false, "skill").contains("already current"));
        let untouched = install_file(&dir, "SKILL.md", "two", false, "skill");
        assert!(untouched.contains("differs"), "{untouched}");
        assert_eq!(
            std::fs::read_to_string(dir.join("SKILL.md")).unwrap(),
            "one"
        );
        assert!(install_file(&dir, "SKILL.md", "two", true, "skill").contains("installed at"));
        assert_eq!(
            std::fs::read_to_string(dir.join("SKILL.md")).unwrap(),
            "two"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// VAULT-CLI-RULE-067
    #[test]
    fn an_existing_mcp_configuration_is_never_merged_into() {
        let dir = std::env::temp_dir().join(format!("lepidy-init-mcp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a directory");
        std::fs::write(dir.join(".mcp.json"), r#"{"mcpServers":{"other":{}}}"#).expect("a file");

        let profile = None;
        assert!(install_mcp(&dir, profile, false).contains("not enrolled"));
        // The file somebody else wrote is still exactly as they wrote it.
        assert_eq!(
            std::fs::read_to_string(dir.join(".mcp.json")).unwrap(),
            r#"{"mcpServers":{"other":{}}}"#
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// VAULT-CLI-RULE-069
    #[test]
    fn existing_project_settings_are_never_rewritten() {
        let dir = std::env::temp_dir().join(format!("lepidy-init-hooks-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".claude")).expect("a directory");
        let settings = dir.join(".claude/settings.json");
        std::fs::write(&settings, r#"{"permissions":{"allow":["Bash(ls:*)"]}}"#).expect("a file");

        let reported = install_hooks(&dir);
        assert!(reported.contains("left alone"), "{reported}");
        assert!(
            reported.contains("PreToolUse"),
            "it should show what to add: {reported}"
        );
        // Somebody's own settings are exactly as they left them. There is no
        // flag anywhere that would have replaced them.
        assert_eq!(
            std::fs::read_to_string(&settings).unwrap(),
            r#"{"permissions":{"allow":["Bash(ls:*)"]}}"#
        );

        std::fs::remove_file(&settings).expect("removed");
        assert!(install_hooks(&dir).contains("installed at"));
        assert!(install_hooks(&dir).contains("already registered"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// VAULT-CLI-RULE-068
    #[test]
    fn which_finds_something_that_exists_and_not_something_that_does_not() {
        let present = if cfg!(windows) { "cmd" } else { "sh" };
        assert!(which(present).is_some(), "{present} should be on PATH");
        assert!(which("definitely-not-a-real-binary-xyz").is_none());
    }
}

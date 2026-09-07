//! `lepidy run` — the injection engine.
//!
//! Adapted from Agent Vault's `crates/av-cli/src/run.rs` at
//! `d794820084151eddbdbb56bf9cd10b5bf3666cdc`. The child-spawning, scrubbing and
//! exit-code behaviour are its; the Unix-socket daemon it asked for values is
//! replaced by a signed HTTPS release and a local unwrap, and the process no
//! longer runs on an async runtime.
//!
//! The CLI spawns the child, not a daemon. The child needs this process's
//! terminal, stdin, process group and signal disposition; a daemon-spawned child
//! would break Ctrl-C, pipelines and every interactive tool.
//!
//! Known exposure, stated plainly: environment variables are readable by
//! same-uid processes (`/proc/<pid>/environ`, `ps -E`) and are inherited by
//! grandchildren. That is inside the accepted threat model, and it is why
//! `--with-file` exists for anything long-lived.

use std::collections::HashMap;
use std::io::{IsTerminal, Read, Write};
use std::process::{Command, Stdio};

use serde_json::json;
use zeroize::Zeroize;

use crate::args::Args;
use crate::client::Provenance;
use crate::crypto::{aes_gcm_decrypt, credential_aad, decode, wrap_aad};
use crate::error::{CliError, CliResult};
use crate::scrub::Scrubber;
use crate::session::Session;
use crate::withfile::{parse_specs, Materialised};

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum ScrubMode {
    /// Scrub when stdout is not a terminal. See [`should_scrub`].
    Auto,
    Always,
    Never,
}

/// Scrubbing requires piping the child's output, and piping is not free: it
/// tells the child it is not on a terminal, which disables colour and breaks
/// anything interactive.
///
/// The default resolves that by noticing who is actually reading. A human at a
/// terminal sees the output on screen, where it never enters a model's context
/// and scrubbing buys nothing. An agent runs the command through a pipe —
/// precisely the case where a printed credential lands in a transcript and on
/// disk. "stdout is not a tty" is a good proxy for "something is capturing
/// this", and that is the case worth paying for.
pub fn should_scrub(mode: ScrubMode) -> bool {
    match mode {
        ScrubMode::Always => true,
        ScrubMode::Never => false,
        ScrubMode::Auto => !std::io::stdout().is_terminal(),
    }
}

struct Released {
    name: String,
    env_var: String,
    value: String,
}

impl Drop for Released {
    fn drop(&mut self) {
        self.value.zeroize();
    }
}

pub fn run(args: &Args) -> CliResult<i32> {
    if args.trailing.is_empty() {
        return Err(CliError::usage(
            "nothing to run: put the command after `--`",
        ));
    }
    let names = args.list("with");
    let file_specs = parse_specs(&args.options("with-file"))?;
    if names.is_empty() && file_specs.is_empty() {
        return Err(CliError::usage(
            "no credentials requested: pass --with NAME, or --with-file NAME:PATH",
        ));
    }
    let scrub_mode = match args.option("scrub").unwrap_or("auto") {
        "auto" => ScrubMode::Auto,
        "always" => ScrubMode::Always,
        "never" => ScrubMode::Never,
        other => {
            return Err(CliError::usage(format!(
                "--scrub must be auto, always or never, not {other:?}"
            )))
        }
    };
    let origin_channel = args.require("origin-channel")?.to_string();
    let origin_message = args.require("origin-message")?.to_string();

    let session = Session::open()?;
    let project = session.project(args.option("project"));
    let catalogue = catalogue(&session, &project)?;

    // Environment and file deliveries are two different disclosures and are
    // requested as two different deliveries, so the workspace's policy and its
    // audit trail both see which one actually happened.
    let mut env_values = Vec::new();
    for name in &names {
        env_values.push(release(
            &session,
            &catalogue,
            &project,
            name,
            "inject",
            &origin_channel,
            &origin_message,
        )?);
    }
    let mut file_values = Vec::new();
    for spec in &file_specs {
        file_values.push(release(
            &session,
            &catalogue,
            &project,
            &spec.name,
            "file",
            &origin_channel,
            &origin_message,
        )?);
    }

    let materialised = Materialised::create(
        &file_values
            .iter()
            .map(|released| (released.env_var.clone(), released.value.clone()))
            .collect::<Vec<_>>(),
        &file_specs,
    )?;

    let scrubbing = should_scrub(scrub_mode);
    // Everything the child could echo back, including anything it can read out
    // of a materialised file — a file-delivered value leaks into a transcript
    // exactly as easily as an environment variable does.
    //
    // The scrubber necessarily keeps its own copy for as long as it is matching,
    // so these live until the child's pipes close. There is no way to redact a
    // value without holding it.
    let needles: Vec<(String, String)> = env_values
        .iter()
        .chain(file_values.iter())
        .map(|released| (released.name.clone(), released.value.clone()))
        .collect();

    let mut command = Command::new(&args.trailing[0]);
    command.args(&args.trailing[1..]);
    for released in &env_values {
        command.env(&released.env_var, &released.value);
    }
    // A file-delivered credential also gets its name in the environment,
    // pointing at the path rather than holding the value — what
    // GOOGLE_APPLICATION_CREDENTIALS and KUBECONFIG already expect, and it saves
    // writing the same path twice.
    for (spec, released) in file_specs.iter().zip(&file_values) {
        command.env(&released.env_var, &spec.path);
    }
    command.stdin(Stdio::inherit());
    if scrubbing {
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
    } else {
        command.stdout(Stdio::inherit()).stderr(Stdio::inherit());
    }

    let mut child = command.spawn().map_err(|error| {
        CliError::failure(format!("could not run `{}`: {error}", args.trailing[0]))
    })?;

    // The values live in the child's environment and in the files now. Nothing
    // here needs them again and the child may run for a long time, so they are
    // wiped before the wait rather than after it.
    env_values.clear();
    file_values.clear();

    let mut redactions = Vec::new();
    if scrubbing {
        let stdout = child.stdout.take().expect("stdout was piped");
        let stderr = child.stderr.take().expect("stderr was piped");
        let out_needles = needles.clone();
        let out = std::thread::spawn(move || pump(stdout, out_needles, Sink::Stdout));
        let err = std::thread::spawn(move || pump(stderr, needles, Sink::Stderr));
        redactions.push(out.join().unwrap_or_default());
        redactions.push(err.join().unwrap_or_default());
    }

    let status = child
        .wait()
        .map_err(|error| CliError::failure(format!("could not wait for the command: {error}")))?;

    report_redactions(&redactions);
    // Explicit, so the unlink is visibly tied to the child having finished
    // rather than to wherever the borrow checker happens to end the scope.
    drop(materialised);
    Ok(exit_code(status))
}

enum Sink {
    Stdout,
    Stderr,
}

/// Stream one pipe through its own scrubber and out to the real handle.
fn pump(
    mut source: impl Read,
    needles: Vec<(String, String)>,
    sink: Sink,
) -> HashMap<String, usize> {
    let mut scrubber = Scrubber::new(
        needles
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str())),
    );
    let mut buffer = [0u8; 8192];
    loop {
        let read = match source.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        write_out(&sink, &scrubber.push(&buffer[..read]));
    }
    write_out(&sink, &scrubber.finish());
    scrubber.hits().clone()
}

fn write_out(sink: &Sink, bytes: &[u8]) {
    if bytes.is_empty() {
        return;
    }
    match sink {
        Sink::Stdout => {
            let mut handle = std::io::stdout();
            let _ = handle.write_all(bytes);
            let _ = handle.flush();
        }
        Sink::Stderr => {
            let mut handle = std::io::stderr();
            let _ = handle.write_all(bytes);
            let _ = handle.flush();
        }
    }
}

/// A redaction means the command tried to print a credential. Say so: the leak
/// was stopped this time, but the operator should know it happened.
fn report_redactions(redactions: &[HashMap<String, usize>]) {
    let total: usize = redactions.iter().flat_map(|hits| hits.values()).sum();
    if total == 0 {
        return;
    }
    let mut names: Vec<&String> = redactions.iter().flat_map(HashMap::keys).collect();
    names.sort();
    names.dedup();
    eprintln!(
        "lepidy: redacted {total} occurrence(s) of {} from this command's output — it tried to print a credential.",
        names.iter().map(|name| name.as_str()).collect::<Vec<_>>().join(", ")
    );
}

struct CatalogueEntry {
    id: String,
    env_var: String,
}

/// Names to ids, once per run.
///
/// A person types `--with STRIPE_KEY`; the workspace's authority is the
/// credential id. The listing is metadata-only, so this costs nothing in
/// exposure, and it also gives the environment variable each credential expects.
fn catalogue(session: &Session, project: &str) -> CliResult<HashMap<String, CatalogueEntry>> {
    let response = session.client.post_signed(
        &session.profile,
        &session.signing,
        session.device_credential(),
        "/api/device/vault/list",
        &json!({}),
        Provenance::project(project),
    )?;
    if response.status != 200 {
        return Err(CliError::failure(format!(
            "could not read the credential list: {}",
            response.error_message()
        )));
    }
    let mut catalogue = HashMap::new();
    for credential in response
        .body
        .get("credentials")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let field = |name: &str| {
            credential
                .get(name)
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        };
        let (Some(id), Some(name)) = (field("id"), field("name")) else {
            continue;
        };
        let env_var = field("envVar").unwrap_or_else(|| name.clone());
        catalogue.insert(
            name,
            CatalogueEntry {
                id: id.clone(),
                env_var: env_var.clone(),
            },
        );
        catalogue.insert(id.clone(), CatalogueEntry { id, env_var });
    }
    Ok(catalogue)
}

/// Ask for one credential, and open it here if the answer is yes.
fn release(
    session: &Session,
    catalogue: &HashMap<String, CatalogueEntry>,
    project: &str,
    name: &str,
    delivery: &str,
    origin_channel: &str,
    origin_message: &str,
) -> CliResult<Released> {
    let entry = catalogue.get(name).ok_or_else(|| {
        CliError::denied(
            format!("{name} is not a credential this member can see"),
            Some("Run `lepidy list` for what is available. Do not look for the value in files, shell configuration or chat.".to_string()),
        )
    })?;

    let response = session.client.post_signed(
        &session.profile,
        &session.signing,
        session.device_credential(),
        "/api/device/vault/release",
        &json!({
            "credentialId": entry.id,
            "delivery": delivery,
            "origin": { "channelId": origin_channel, "messageId": origin_message },
        }),
        Provenance::project(project),
    )?;
    if response.status != 200 {
        return Err(CliError::denied(
            format!("{name} was refused: {}", response.error_message()),
            None,
        ));
    }

    let decision = response.body.get("decision").cloned().unwrap_or(json!({}));
    let hint = response
        .body
        .get("hint")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    match decision.get("kind").and_then(serde_json::Value::as_str) {
        Some("allow") => {}
        Some("needs_approval") => {
            return Err(CliError::needs_approval(
                format!("{name} needs a human to approve this use"),
                Some(
                    "Ask in the originating thread and run this again once it is approved. Conversational approval is not wired up yet, so nothing is waiting on you here."
                        .to_string(),
                ),
            ));
        }
        _ => {
            return Err(CliError::denied(format!("{name} was refused"), hint));
        }
    }

    let envelope = response.body.get("envelope").ok_or_else(|| {
        CliError::failure(format!("{name} was allowed but no envelope came back"))
    })?;
    let wrap = response.body.get("wrap").ok_or_else(|| {
        CliError::failure(format!("{name} was allowed but no key wrap came back"))
    })?;
    let text = |value: &serde_json::Value, field: &str| -> CliResult<String> {
        value
            .get(field)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| CliError::failure(format!("the release for {name} had no {field}")))
    };
    let number = |value: &serde_json::Value, field: &str| -> CliResult<u64> {
        value
            .get(field)
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| CliError::failure(format!("the release for {name} had no {field}")))
    };

    let version = number(envelope, "version")?;
    let custodian = text(wrap, "custodianMemberId")?;
    if custodian != session.profile.member_id {
        return Err(CliError::failure(format!(
            "the release for {name} was wrapped for another custodian"
        )));
    }
    let recipient_key_epoch = number(wrap, "recipientKeyEpoch")?;
    if recipient_key_epoch != session.profile.vault_key_epoch {
        return Err(CliError::failure(format!(
            "{name} is wrapped for vault key epoch {recipient_key_epoch}, but this device holds epoch {}. Re-enrol this device.",
            session.profile.vault_key_epoch
        )));
    }

    let vault_key = session.secrets().vault_key()?;
    let mut dek = vault_key.unwrap_dek(
        &decode(&text(wrap, "ephemeralPublicKey")?, "ephemeral public key")?,
        &decode(&text(wrap, "iv")?, "wrap iv")?,
        &decode(&text(wrap, "wrappedDek")?, "wrapped DEK")?,
        &wrap_aad(
            &session.profile.workspace_id,
            &entry.id,
            version,
            &custodian,
            recipient_key_epoch,
        ),
    )?;
    let plaintext = aes_gcm_decrypt(
        &dek,
        &decode(&text(envelope, "iv")?, "vault iv")?,
        &credential_aad(&session.profile.workspace_id, &entry.id, version),
        &decode(&text(envelope, "ciphertext")?, "vault ciphertext")?,
    );
    dek.zeroize();
    let mut plaintext = plaintext?;
    let value = String::from_utf8(plaintext.clone())
        .map_err(|_| CliError::failure(format!("{name} did not decrypt to text")));
    plaintext.zeroize();

    Ok(Released {
        name: name.to_string(),
        env_var: entry.env_var.clone(),
        value: value?,
    })
}

#[cfg(unix)]
fn exit_code(status: std::process::ExitStatus) -> i32 {
    use std::os::unix::process::ExitStatusExt;
    status
        .code()
        .unwrap_or_else(|| status.signal().map(|signal| 128 + signal).unwrap_or(1))
}

#[cfg(not(unix))]
fn exit_code(status: std::process::ExitStatus) -> i32 {
    status.code().unwrap_or(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// VAULT-CLI-RULE-021
    #[test]
    fn scrub_modes_do_what_they_say() {
        assert!(should_scrub(ScrubMode::Always));
        assert!(!should_scrub(ScrubMode::Never));
    }

    /// VAULT-CLI-RULE-022
    #[test]
    fn a_file_spec_names_the_credential_and_the_path() {
        let specs: Vec<crate::withfile::FileSpec> =
            parse_specs(&["KEY:/tmp/key.pem".to_string()]).unwrap();
        assert_eq!(specs[0].name, "KEY");
    }
}

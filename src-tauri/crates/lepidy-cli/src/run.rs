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
use crate::withfile::{parse_specs, FileSpec, Materialised};

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
    /// Present for a structured credential: its fields, already parsed.
    fields: Option<Vec<(String, String)>>,
}

impl Drop for Released {
    fn drop(&mut self) {
        self.value.zeroize();
        if let Some(fields) = &mut self.fields {
            for (_, value) in fields {
                value.zeroize();
            }
        }
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
    if names.is_empty()
        && file_specs.is_empty()
        && args.list("all-tagged").is_empty()
        && args.options("with-template").is_empty()
    {
        return Err(CliError::usage(
            "no credentials requested: pass --with NAME, --with-file NAME:PATH, --with-template SOURCE:PATH, or --all-tagged TAG",
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
    // Mandatory, always. The approver is only ever shown what the request said,
    // and a card with no reason on it is one nobody can answer well.
    let reason = args.require("reason")?.to_string();

    let session = Session::open()?;
    let project = session.project(args.option("project"));
    let catalogue = catalogue(&session, &project)?;

    // A whole tagged group under one approval, which is the point of tags: an
    // `aws` command wants four credentials and should not produce four cards.
    let mut names = names;
    for tag in args.list("all-tagged") {
        let mut tagged: Vec<String> = catalogue
            .iter()
            .filter(|(key, entry)| {
                **key == entry.id && entry.tags.iter().any(|candidate| *candidate == tag)
            })
            .map(|(_, entry)| entry.id.clone())
            .collect();
        if tagged.is_empty() {
            return Err(CliError::usage(format!(
                "no credential this member can see carries the tag {tag}"
            )));
        }
        tagged.sort();
        for id in tagged {
            if !names.contains(&id) {
                names.push(id);
            }
        }
    }

    // A template names its own credentials, so they join the same request and
    // the same card as everything else this command needs.
    let template_specs = crate::template::parse_specs(&args.options("with-template"))?;
    let mut templates = Vec::new();
    for spec in &template_specs {
        let source = std::fs::read_to_string(&spec.source).map_err(|error| {
            CliError::usage(format!(
                "could not read the template {}: {error}",
                spec.source.display()
            ))
        })?;
        let wanted = crate::template::placeholders(&source)?;
        templates.push((spec.clone(), source, wanted));
    }
    let template_names: Vec<String> = {
        let mut collected: Vec<String> = Vec::new();
        for (_, _, wanted) in &templates {
            for name in wanted {
                if !collected.contains(name) {
                    collected.push(name.clone());
                }
            }
        }
        collected
    };

    // Environment and file deliveries are two different disclosures and are
    // requested as two different deliveries, so the workspace's policy and its
    // audit trail both see which one actually happened. Within a delivery it is
    // one request, so one command produces one card rather than one per value.
    let request = ReleaseRequest {
        project: &project,
        origin_channel: &origin_channel,
        origin_message: &origin_message,
        reason: &reason,
    };
    let mut env_values = release_batch(&session, &catalogue, &request, &names, "inject")?;
    let mut file_names: Vec<String> = file_specs.iter().map(|spec| spec.name.clone()).collect();
    // A rendered config is a plaintext credential on the disk, which is what the
    // `file` delivery means, so the policy decides it as one.
    file_names.extend(template_names.iter().cloned());
    let mut file_values = release_batch(&session, &catalogue, &request, &file_names, "file")?;
    let template_values: Vec<(String, String)> = file_values
        .iter()
        .filter(|released| template_names.contains(&released.name))
        .map(|released| (released.name.clone(), released.value.clone()))
        .collect();
    let rendered = Materialised::create(
        &templates
            .iter()
            .map(|(spec, source, _)| {
                crate::template::render(source, &template_values)
                    .map(|body| (template_variable(&spec.source.display().to_string()), body))
            })
            .collect::<CliResult<Vec<_>>>()?,
        &template_specs
            .iter()
            .map(|spec| FileSpec {
                // A rendered template is named after its source, so the file it
                // produces is traceable to the document that described it.
                name: template_variable(&spec.source.display().to_string()),
                path: spec.destination.clone(),
            })
            .collect::<Vec<_>>(),
    )?;

    let materialised = Materialised::create(
        &file_specs
            .iter()
            .map(|spec| {
                let released = file_values
                    .iter()
                    .find(|candidate| candidate.name == spec.name)
                    .ok_or_else(|| CliError::failure(format!("{} was not released", spec.name)))?;
                Ok((released.env_var.clone(), released.value.clone()))
            })
            .collect::<CliResult<Vec<_>>>()?,
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
        .flat_map(|released| match &released.fields {
            // A structured credential reaches the child as one variable per
            // field, so it is the field values a command can print back — the
            // undivided JSON never appears in the environment and matching only
            // that would redact nothing.
            Some(fields) => fields
                .iter()
                .map(|(field, value)| (format!("{}_{field}", released.name), value.clone()))
                .collect::<Vec<_>>(),
            None => vec![(released.name.clone(), released.value.clone())],
        })
        .collect();

    let mut command = Command::new(&args.trailing[0]);
    command.args(&args.trailing[1..]);
    for released in &env_values {
        match &released.fields {
            // A structured credential is one record that expands into one
            // variable per field, so a database credential arrives as five
            // rather than as a JSON blob every tool would have to parse.
            Some(fields) => {
                for (field, value) in fields {
                    command.env(format!("{}_{field}", released.env_var), value);
                }
            }
            None => {
                command.env(&released.env_var, &released.value);
            }
        }
    }
    // A file-delivered credential also gets its name in the environment,
    // pointing at the path rather than holding the value — what
    // GOOGLE_APPLICATION_CREDENTIALS and KUBECONFIG already expect, and it saves
    // writing the same path twice.
    for spec in &file_specs {
        if let Some(released) = file_values
            .iter()
            .find(|candidate| candidate.name == spec.name)
        {
            command.env(&released.env_var, &spec.path);
        }
    }
    for (spec, _, _) in &templates {
        // The rendered path is offered under the template's own name, so a
        // command can point at it without the operator writing the path twice.
        command.env(
            format!(
                "LEPIDY_TEMPLATE_{}",
                template_variable(&spec.source.display().to_string())
            ),
            &spec.destination,
        );
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
    drop(rendered);
    Ok(exit_code(status))
}

enum Sink {
    Stdout,
    Stderr,
}

/// Split a structured value into the fields its metadata promised.
///
/// A field the metadata names but the value does not carry is an error rather
/// than an empty variable: a command that authenticates with a blank password
/// fails somewhere far away from the cause.
fn structured_fields(
    name: &str,
    entry: &CatalogueEntry,
    value: &str,
) -> CliResult<Vec<(String, String)>> {
    let parsed: serde_json::Value = serde_json::from_str(value).map_err(|_| {
        CliError::failure(format!(
            "{name} is structured but did not decrypt to a JSON object"
        ))
    })?;
    let object = parsed.as_object().ok_or_else(|| {
        CliError::failure(format!(
            "{name} is structured but did not decrypt to a JSON object"
        ))
    })?;
    let mut fields = Vec::new();
    for field in &entry.fields {
        let found = object
            .get(field)
            .ok_or_else(|| CliError::failure(format!("{name} has no {field} field")))?;
        fields.push((
            field.clone(),
            match found {
                serde_json::Value::String(text) => text.clone(),
                other => other.to_string(),
            },
        ));
    }
    Ok(fields)
}

/// A template's source path, as a usable environment-variable suffix.
fn template_variable(source: &str) -> String {
    source
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(source)
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .take(48)
        .collect()
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

#[derive(Clone)]
pub struct CatalogueEntry {
    pub id: String,
    pub env_var: String,
    pub version: u64,
    pub key_epoch: u64,
    pub tags: Vec<String>,
    /// `structured` values expand into one variable per field.
    pub kind: String,
    pub fields: Vec<String>,
}

/// Names to ids, once per run.
///
/// A person types `--with STRIPE_KEY`; the workspace's authority is the
/// credential id. The listing is metadata-only, so this costs nothing in
/// exposure, and it also gives the environment variable each credential expects.
pub fn catalogue(session: &Session, project: &str) -> CliResult<HashMap<String, CatalogueEntry>> {
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
        let strings = |name: &str| {
            credential
                .get(name)
                .and_then(serde_json::Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(|value| value.as_str().map(str::to_string))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        };
        let number = |name: &str| {
            credential
                .get(name)
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(1)
        };
        let (Some(id), Some(name)) = (field("id"), field("name")) else {
            continue;
        };
        let entry = CatalogueEntry {
            id: id.clone(),
            env_var: field("envVar").unwrap_or_else(|| name.clone()),
            version: number("version"),
            key_epoch: number("keyEpoch"),
            tags: strings("tags"),
            kind: field("kind").unwrap_or_else(|| "opaque".to_string()),
            fields: strings("fields"),
        };
        // Reachable by either name, because a person types the name and the
        // workspace answers by id.
        catalogue.insert(name, entry.clone());
        catalogue.insert(id, entry);
    }
    Ok(catalogue)
}

/// What one command is asking for, and why.
struct ReleaseRequest<'a> {
    project: &'a str,
    origin_channel: &'a str,
    origin_message: &'a str,
    reason: &'a str,
}

/// Ask for every credential of one delivery at once, and open what comes back.
///
/// One request, because one command's worth of credentials is one question. The
/// workspace turns whatever it cannot answer on its own into as few approval
/// cards as the ownership of those credentials allows; asking one at a time
/// would produce a card each and teach the person answering them to stop
/// reading.
fn release_batch(
    session: &Session,
    catalogue: &HashMap<String, CatalogueEntry>,
    request: &ReleaseRequest<'_>,
    names: &[String],
    delivery: &str,
) -> CliResult<Vec<Released>> {
    if names.is_empty() {
        return Ok(Vec::new());
    }
    // Names are resolved before anything is asked for, so a typo is refused
    // here rather than becoming a card somebody has to answer.
    let mut entries = Vec::new();
    for name in names {
        let entry = catalogue.get(name.as_str()).ok_or_else(|| {
            CliError::denied(
                format!("{name} is not a credential this member can see"),
                Some("Run `lepidy list` for what is available. Do not look for the value in files, shell configuration or chat.".to_string()),
            )
        })?;
        entries.push((name.clone(), entry));
    }

    let response = session.client.post_signed(
        &session.profile,
        &session.signing,
        session.device_credential(),
        "/api/device/vault/release",
        &json!({
            "credentialIds": entries.iter().map(|(_, entry)| entry.id.clone()).collect::<Vec<_>>(),
            "delivery": delivery,
            "reason": request.reason,
            "origin": { "channelId": request.origin_channel, "messageId": request.origin_message },
        }),
        Provenance::project(request.project),
    )?;
    if response.status != 200 {
        return Err(CliError::denied(
            format!("that release was refused: {}", response.error_message()),
            None,
        ));
    }

    // A card was raised: somebody has to decide, and this process is finished.
    // Reported with the deadline, because "wait" without a deadline is how an
    // agent ends up polling.
    let approvals = response
        .body
        .get("approvals")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    if let Some(approval) = approvals.first() {
        let hint = approval
            .get("hint")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("Stop and wait to be asked again; do not retry in a loop.")
            .to_string();
        let ids = approvals
            .iter()
            .filter_map(|item| item.get("approvalId").and_then(serde_json::Value::as_str))
            .collect::<Vec<_>>()
            .join(", ");
        return Err(CliError::needs_approval(
            format!("a human has to approve this use (request {ids})"),
            Some(hint),
        ));
    }

    let results = response
        .body
        .get("results")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut released = Vec::new();
    for (name, entry) in &entries {
        let result = results
            .iter()
            .find(|item| {
                item.get("credentialId").and_then(serde_json::Value::as_str)
                    == Some(entry.id.as_str())
            })
            .ok_or_else(|| CliError::failure(format!("the workspace said nothing about {name}")))?;
        let decision = result.get("decision").cloned().unwrap_or(json!({}));
        let hint = result
            .get("hint")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        match decision.get("kind").and_then(serde_json::Value::as_str) {
            Some("allow") => released.push(open_release(session, name, entry, result)?),
            _ => return Err(CliError::denied(format!("{name} was refused"), hint)),
        }
    }
    Ok(released)
}

/// Open one allowed release: unwrap the DEK with this device's key, then the
/// envelope with the DEK. Both are bound to the exact credential and version,
/// so a substituted release fails here rather than reaching the child.
fn open_release(
    session: &Session,
    name: &str,
    entry: &CatalogueEntry,
    result: &serde_json::Value,
) -> CliResult<Released> {
    let envelope = result.get("envelope").ok_or_else(|| {
        CliError::failure(format!("{name} was allowed but no envelope came back"))
    })?;
    let wrap = result.get("wrap").ok_or_else(|| {
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

    let value = value?;
    let fields = match entry.kind.as_str() {
        "structured" => Some(structured_fields(name, entry, &value)?),
        _ => None,
    };
    Ok(Released {
        name: name.to_string(),
        env_var: entry.env_var.clone(),
        value,
        fields,
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
    /// VAULT-CLI-RULE-031
    #[test]
    fn names_a_rendered_template_after_its_source_file() {
        assert_eq!(template_variable("config/wrangler.toml"), "WRANGLER_TOML");
        assert_eq!(template_variable("/tmp/.npmrc"), "_NPMRC");
    }

    #[test]
    fn a_file_spec_names_the_credential_and_the_path() {
        let specs: Vec<crate::withfile::FileSpec> =
            parse_specs(&["KEY:/tmp/key.pem".to_string()]).unwrap();
        assert_eq!(specs[0].name, "KEY");
    }
}

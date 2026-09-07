//! Resolving credentials into a config file.
//!
//! Adapted from Agent Vault's `crates/av-cli/src/template.rs` at
//! `d794820084151eddbdbb56bf9cd10b5bf3666cdc`, including the asymmetric rule
//! about what counts as a placeholder.
//!
//! Some tools will only read a credential out of a larger document: a `.npmrc`,
//! a `wrangler.toml`, a database config, a CI manifest. Injection does not fit
//! because the tool reads a file rather than the environment, and `--with-file`
//! does not fit because the credential is one field inside a document rather
//! than the whole of it. So the operator keeps a template with
//! `${lepidy:NAME}` in it and the CLI resolves it for the life of one command.
//!
//! # The limit of this, stated plainly
//!
//! The rendered file is a plaintext credential on the disk for as long as the
//! command runs. It is owner-only and unlinked afterwards, but unlinking is not
//! shredding. This is the most exposed of the delivery methods and it is last
//! for that reason: if the tool can read an environment variable, `--with`
//! keeps the value off the platter entirely.

use std::path::PathBuf;

use crate::error::{CliError, CliResult};

const PREFIX: &str = "${lepidy:";

/// One `SOURCE=DESTINATION` request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TemplateSpec {
    pub source: PathBuf,
    pub destination: PathBuf,
}

/// Parse `SOURCE=DESTINATION` specs.
///
/// `=` rather than the `:` that `--with-file` uses, and the difference is not
/// cosmetic: `--with-file` separates a credential NAME from a path, and a name
/// can never contain a colon. Here both halves are paths, and on Windows a path
/// begins `C:\` — so a colon would split `C:\in.tmpl:C:\out.toml` in the
/// wrong place on the platform this product ships.
pub fn parse_specs(specs: &[String]) -> CliResult<Vec<TemplateSpec>> {
    let mut parsed = Vec::with_capacity(specs.len());
    for raw in specs {
        let Some((source, destination)) = raw.split_once('=') else {
            return Err(CliError::usage(format!(
                "--with-template wants SOURCE=DESTINATION, but got {raw:?} with no `=` in it"
            )));
        };
        if source.is_empty() || destination.is_empty() {
            return Err(CliError::usage(format!(
                "--with-template {raw:?} is missing the source or the destination"
            )));
        }
        parsed.push(TemplateSpec {
            source: PathBuf::from(source),
            destination: PathBuf::from(destination),
        });
    }
    Ok(parsed)
}

/// One placeholder: its byte range in the source, and the name inside it.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Found {
    start: usize,
    end: usize,
    name: String,
}

/// Locate every `${lepidy:NAME}`.
///
/// The rule for what counts is deliberately asymmetric. A document may
/// legitimately contain `${HOME}`, `$PATH` or any other shell-looking thing,
/// and silently mangling those would be a nasty surprise — so anything not
/// prefixed `${lepidy:` is left completely alone.
///
/// But the prefix itself is unambiguous intent. Once somebody has typed it, a
/// malformed placeholder is a typo rather than a coincidence, and leaving a
/// literal `${lepidy:}` in a rendered config would fail later and far more
/// confusingly than failing here.
fn scan(input: &str) -> CliResult<Vec<Found>> {
    let mut found = Vec::new();
    let mut index = 0;
    while let Some(relative) = input[index..].find(PREFIX) {
        let start = index + relative;
        let name_at = start + PREFIX.len();
        let Some(relative_close) = input[name_at..].find('}') else {
            return Err(CliError::usage(format!(
                "unterminated placeholder near {:?}: `{PREFIX}` with no closing brace",
                snippet(input, start)
            )));
        };
        let close = name_at + relative_close;
        let name = &input[name_at..close];
        if name.is_empty() {
            return Err(CliError::usage(format!(
                "`{PREFIX}}}` at byte {start} names no credential"
            )));
        }
        found.push(Found {
            start,
            end: close + 1,
            name: name.to_string(),
        });
        index = close + 1;
    }
    Ok(found)
}

/// A short, char-boundary-safe excerpt for an error message.
fn snippet(input: &str, from: usize) -> &str {
    let mut end = (from + 32).min(input.len());
    while end > from && !input.is_char_boundary(end) {
        end -= 1;
    }
    &input[from..end]
}

/// Every distinct credential the template names, in the order first seen.
///
/// Deduplicated: the same placeholder used three times resolves to one value
/// and must raise one request, not three, or a config that mentions a token in
/// three places would produce three cards.
pub fn placeholders(input: &str) -> CliResult<Vec<String>> {
    let mut names: Vec<String> = Vec::new();
    for item in scan(input)? {
        if !names.contains(&item.name) {
            names.push(item.name);
        }
    }
    Ok(names)
}

/// Replace every placeholder with its value.
///
/// A name the caller did not resolve is an error rather than a blank: a config
/// silently missing a credential fails somewhere far away from the cause.
pub fn render(input: &str, values: &[(String, String)]) -> CliResult<String> {
    let mut out = String::with_capacity(input.len());
    let mut cursor = 0;
    for item in scan(input)? {
        let value = values
            .iter()
            .find(|(name, _)| *name == item.name)
            .map(|(_, value)| value.as_str())
            .ok_or_else(|| {
                CliError::failure(format!(
                    "the template names {}, which was not released",
                    item.name
                ))
            })?;
        out.push_str(&input[cursor..item.start]);
        out.push_str(value);
        cursor = item.end;
    }
    out.push_str(&input[cursor..]);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// VAULT-CLI-RULE-027
    #[test]
    fn finds_every_placeholder_once_and_leaves_other_syntax_alone() {
        let template = "url=${lepidy:DB_URL}\nhome=${HOME}\nliteral=$PATH\nagain=${lepidy:DB_URL}\nkey=${lepidy:API_KEY}";
        assert_eq!(placeholders(template).unwrap(), vec!["DB_URL", "API_KEY"]);
    }

    /// VAULT-CLI-RULE-028
    #[test]
    fn renders_only_its_own_placeholders() {
        let rendered = render(
            "url=${lepidy:DB_URL}\nhome=${HOME}\nagain=${lepidy:DB_URL}",
            &[("DB_URL".to_string(), "postgres://x".to_string())],
        )
        .unwrap();
        assert_eq!(
            rendered,
            "url=postgres://x\nhome=${HOME}\nagain=postgres://x"
        );
    }

    /// VAULT-CLI-RULE-032
    #[test]
    fn separates_two_paths_without_tripping_over_a_drive_letter() {
        let specs = parse_specs(&["C:\\in.tmpl=C:\\out.toml".to_string()]).unwrap();
        assert_eq!(specs[0].source, PathBuf::from("C:\\in.tmpl"));
        assert_eq!(specs[0].destination, PathBuf::from("C:\\out.toml"));
        assert_eq!(
            parse_specs(&["a.tmpl=/tmp/a".to_string()]).unwrap()[0].destination,
            PathBuf::from("/tmp/a")
        );
        assert!(parse_specs(&["only-one-path".to_string()]).is_err());
        assert!(parse_specs(&["=/tmp/a".to_string()]).is_err());
    }

    /// VAULT-CLI-RULE-029
    #[test]
    fn refuses_a_typo_rather_than_writing_it_into_a_config() {
        assert!(placeholders("url=${lepidy:DB_URL").is_err());
        assert!(placeholders("url=${lepidy:}").is_err());
        // A name nothing released is an error here rather than a blank that
        // fails somewhere far away from the cause.
        assert!(render("url=${lepidy:MISSING}", &[]).is_err());
    }
}

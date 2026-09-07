//! Reading a `.env` file well enough to seed a vault from it.
//!
//! Adapted from Agent Vault's `crates/av-cli/src/import.rs` at
//! `d794820084151eddbdbb56bf9cd10b5bf3666cdc`, including its reasoning: adoption
//! dies if seeding the vault is manual, because nobody types twelve tokens in
//! one at a time.
//!
//! Two rules carry over from every other write path. **Create-only** — an
//! existing name is reported and skipped, never overwritten, because import is
//! reachable by an agent exactly as `capture` is and the credential-swap control
//! has to hold here too. And **no value is ever printed** — not in the summary,
//! not in a dry run, not in an error. Lengths are, because a length is what
//! justifies a short-value warning and is not itself the secret.

use zeroize::Zeroize;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SkipReason {
    /// Not usable as a credential name, which is also an environment variable.
    InvalidName,
    /// `KEY=` with nothing after it.
    EmptyValue,
    /// The same key appeared earlier in this file.
    DuplicateInFile,
    /// A quote was opened and never closed.
    UnterminatedQuote,
    /// A line that is not blank, not a comment, and has no `=` in it.
    NoAssignment,
}

impl SkipReason {
    pub fn describe(self) -> &'static str {
        match self {
            SkipReason::InvalidName => "the name is not usable as an environment variable",
            SkipReason::EmptyValue => "no value",
            SkipReason::DuplicateInFile => "a duplicate of an earlier line in this file",
            SkipReason::UnterminatedQuote => "a quote was opened and never closed",
            SkipReason::NoAssignment => "no `=` in the line",
        }
    }
}

pub struct EnvEntry {
    pub line: usize,
    pub name: String,
    pub value: String,
}

impl Drop for EnvEntry {
    fn drop(&mut self) {
        self.value.zeroize();
    }
}

pub struct EnvSkip {
    pub line: usize,
    pub name: Option<String>,
    pub reason: SkipReason,
}

pub struct EnvFile {
    pub entries: Vec<EnvEntry>,
    pub skipped: Vec<EnvSkip>,
}

/// Parse a `.env`, keeping every reason a line was passed over.
///
/// Being told "3 of 12 imported" and nothing else is useless, so the skips are
/// as much of the output as the entries are.
pub fn parse_env(input: &str) -> EnvFile {
    let mut entries: Vec<EnvEntry> = Vec::new();
    let mut skipped = Vec::new();
    let mut seen: Vec<String> = Vec::new();

    for (index, raw) in input.lines().enumerate() {
        let line = index + 1;
        let trimmed = raw.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        // `export FOO=bar` is what half the world's `.env` files look like.
        let body = trimmed
            .strip_prefix("export ")
            .unwrap_or(trimmed)
            .trim_start();
        let Some((name, value)) = body.split_once('=') else {
            skipped.push(EnvSkip {
                line,
                name: None,
                reason: SkipReason::NoAssignment,
            });
            continue;
        };
        let name = name.trim().to_string();
        if !is_env_name(&name) {
            skipped.push(EnvSkip {
                line,
                name: Some(name),
                reason: SkipReason::InvalidName,
            });
            continue;
        }
        let value = match unquote(value.trim()) {
            Ok(value) => value,
            Err(reason) => {
                skipped.push(EnvSkip {
                    line,
                    name: Some(name),
                    reason,
                });
                continue;
            }
        };
        if value.is_empty() {
            skipped.push(EnvSkip {
                line,
                name: Some(name),
                reason: SkipReason::EmptyValue,
            });
            continue;
        }
        if seen.contains(&name) {
            skipped.push(EnvSkip {
                line,
                name: Some(name),
                reason: SkipReason::DuplicateInFile,
            });
            continue;
        }
        seen.push(name.clone());
        entries.push(EnvEntry { line, name, value });
    }
    EnvFile { entries, skipped }
}

/// Upper-case, digits and underscores, starting with a letter — the same shape
/// the workspace holds a credential name to, so a file that parses here is a
/// file that will import.
pub fn is_env_name(name: &str) -> bool {
    let mut characters = name.chars();
    characters
        .next()
        .is_some_and(|first| first.is_ascii_uppercase())
        && name.len() <= 64
        && characters.all(|character| {
            character.is_ascii_uppercase() || character.is_ascii_digit() || character == '_'
        })
}

/// Strip one layer of matching quotes, and refuse an unbalanced one.
///
/// An unterminated quote is a broken line rather than a value that happens to
/// start with `"`, and importing it would put a stray quote in a credential
/// nobody would notice until something failed to authenticate.
fn unquote(value: &str) -> Result<String, SkipReason> {
    for quote in ['"', '\''] {
        if let Some(rest) = value.strip_prefix(quote) {
            return match rest.strip_suffix(quote) {
                Some(inner) if !rest.is_empty() => Ok(inner.to_string()),
                _ => Err(SkipReason::UnterminatedQuote),
            };
        }
    }
    // An unquoted trailing comment is a comment, not part of the value.
    Ok(match value.split_once(" #") {
        Some((head, _)) => head.trim_end().to_string(),
        None => value.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(file: &EnvFile) -> Vec<&str> {
        file.entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect()
    }

    /// VAULT-CLI-RULE-024
    #[test]
    fn reads_the_shapes_a_real_env_file_comes_in() {
        let file = parse_env(
            "# a comment\n\nAPI_TOKEN=plain\nexport EXPORTED=value\nQUOTED=\"in quotes\"\nSINGLE='single'\nTRAILING=value # note\n",
        );
        assert_eq!(
            names(&file),
            vec!["API_TOKEN", "EXPORTED", "QUOTED", "SINGLE", "TRAILING"]
        );
        assert_eq!(file.entries[2].value, "in quotes");
        assert_eq!(file.entries[3].value, "single");
        assert_eq!(file.entries[4].value, "value");
        assert!(file.skipped.is_empty());
    }

    /// VAULT-CLI-RULE-025
    #[test]
    fn keeps_every_reason_a_line_was_passed_over() {
        let file = parse_env(
            "no assignment\nlower=value\nEMPTY=\nOPEN=\"unterminated\nDUPE=one\nDUPE=two\n",
        );
        assert!(file.entries.iter().all(|entry| entry.name == "DUPE"));
        assert_eq!(file.entries.len(), 1);
        let reasons: Vec<SkipReason> = file.skipped.iter().map(|skip| skip.reason).collect();
        assert_eq!(
            reasons,
            vec![
                SkipReason::NoAssignment,
                SkipReason::InvalidName,
                SkipReason::EmptyValue,
                SkipReason::UnterminatedQuote,
                SkipReason::DuplicateInFile,
            ]
        );
        // Every skip can say which line it was, so a big file is fixable.
        assert_eq!(file.skipped[0].line, 1);
        assert_eq!(file.skipped.last().unwrap().line, 6);
    }

    /// VAULT-CLI-RULE-026
    #[test]
    fn holds_a_name_to_the_shape_the_workspace_accepts() {
        assert!(is_env_name("API_TOKEN"));
        assert!(is_env_name("T"));
        assert!(!is_env_name("api_token"));
        assert!(!is_env_name("1TOKEN"));
        assert!(!is_env_name("API-TOKEN"));
        assert!(!is_env_name(""));
    }
}

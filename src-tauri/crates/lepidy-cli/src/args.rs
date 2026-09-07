//! A small argument reader.
//!
//! Hand-written rather than reached for from a crate, for one reason worth the
//! lines: this CLI's central promise is that no credential ever appears in
//! `argv`, and the surface that could break that promise should be small enough
//! to read in one sitting. Every option below takes an identifier, a path or a
//! mode — never a value.

use std::collections::HashMap;

use crate::error::{CliError, CliResult};

pub struct Args {
    values: HashMap<String, Vec<String>>,
    flags: Vec<String>,
    positional: Vec<String>,
    /// Everything after `--`, untouched: the command to run.
    pub trailing: Vec<String>,
}

impl Args {
    /// `flag_names` are the options that stand alone; everything else that
    /// starts with `--` takes the next argument as its value.
    pub fn parse(raw: &[String], flag_names: &[&str]) -> CliResult<Self> {
        let mut values: HashMap<String, Vec<String>> = HashMap::new();
        let mut flags = Vec::new();
        let mut positional = Vec::new();
        let mut trailing = Vec::new();
        let mut index = 0;
        while index < raw.len() {
            let argument = &raw[index];
            if argument == "--" {
                trailing = raw[index + 1..].to_vec();
                break;
            }
            if let Some(name) = argument.strip_prefix("--") {
                let (name, inline) = match name.split_once('=') {
                    Some((name, value)) => (name, Some(value.to_string())),
                    None => (name, None),
                };
                if flag_names.contains(&name) {
                    if inline.is_some() {
                        return Err(CliError::usage(format!("--{name} does not take a value")));
                    }
                    flags.push(name.to_string());
                    index += 1;
                    continue;
                }
                let (value, step) = match inline {
                    Some(value) => (value, 1),
                    None => (
                        raw.get(index + 1)
                            .cloned()
                            .ok_or_else(|| CliError::usage(format!("--{name} needs a value")))?,
                        2,
                    ),
                };
                values.entry(name.to_string()).or_default().push(value);
                index += step;
                continue;
            }
            positional.push(argument.clone());
            index += 1;
        }
        Ok(Self {
            values,
            flags,
            positional,
            trailing,
        })
    }

    pub fn flag(&self, name: &str) -> bool {
        self.flags.iter().any(|flag| flag == name)
    }

    pub fn option(&self, name: &str) -> Option<&str> {
        self.values
            .get(name)
            .and_then(|values| values.last())
            .map(String::as_str)
    }

    pub fn options(&self, name: &str) -> Vec<String> {
        self.values.get(name).cloned().unwrap_or_default()
    }

    /// Repeated options and comma-separated lists mean the same thing, because
    /// both spellings are what people actually type.
    pub fn list(&self, name: &str) -> Vec<String> {
        self.options(name)
            .iter()
            .flat_map(|value| value.split(','))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .collect()
    }

    pub fn require(&self, name: &str) -> CliResult<&str> {
        self.option(name)
            .ok_or_else(|| CliError::usage(format!("--{name} is required")))
    }

    pub fn positional(&self, index: usize) -> Option<&str> {
        self.positional.get(index).map(String::as_str)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(raw: &[&str]) -> Args {
        Args::parse(
            &raw.iter()
                .map(|value| value.to_string())
                .collect::<Vec<_>>(),
            &["json", "high-risk"],
        )
        .unwrap()
    }

    /// VAULT-CLI-RULE-007
    #[test]
    fn separates_options_flags_positionals_and_the_command() {
        let parsed = args(&["NAME", "--mode", "auto", "--json", "--", "printf", "--mode"]);
        assert_eq!(parsed.positional(0), Some("NAME"));
        assert_eq!(parsed.option("mode"), Some("auto"));
        assert!(parsed.flag("json"));
        assert_eq!(
            parsed.trailing,
            vec!["printf".to_string(), "--mode".to_string()]
        );
    }

    /// VAULT-CLI-RULE-008
    #[test]
    fn accepts_repeated_and_comma_separated_lists() {
        let parsed = args(&["--tag", "one,two", "--tag", "three"]);
        assert_eq!(parsed.list("tag"), vec!["one", "two", "three"]);
    }

    /// VAULT-CLI-RULE-009
    #[test]
    fn accepts_an_inline_value() {
        let parsed = args(&["--mode=auto", "--json"]);
        assert_eq!(parsed.option("mode"), Some("auto"));
        assert!(parsed.flag("json"));
    }

    /// VAULT-CLI-RULE-010
    #[test]
    fn refuses_an_option_with_nothing_after_it() {
        let raw = vec!["--mode".to_string()];
        assert!(Args::parse(&raw, &[]).is_err());
    }
}

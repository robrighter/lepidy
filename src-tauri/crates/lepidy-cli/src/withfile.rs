//! `--with-file` — handing a value to a command as a file.
//!
//! Adapted from Agent Vault's `crates/av-cli/src/withfile.rs` at
//! `d794820084151eddbdbb56bf9cd10b5bf3666cdc`, with its Unix-only assumptions
//! replaced: Lepidy ships Windows, and a `NAME:C:\path` spec has to parse there.
//!
//! Some tools will not take a credential any other way — `ssh -i`, a kubeconfig,
//! a `.pem`, a service-account JSON. For anything long-lived a file is also the
//! better choice: an environment variable sits readable in `/proc/<pid>/environ`
//! for the whole life of the process and is inherited by every grandchild,
//! whereas this file is owner-only and unlinked the moment the command exits.
//!
//! # The limit of this, stated plainly
//!
//! Unlinking is not shredding. On a copy-on-write filesystem or any SSD with
//! wear levelling the bytes may survive on the medium after the file is gone.
//! The window is short and the file is owner-only, so this is a real improvement
//! on a long-lived environment variable — but for a high-value key a command
//! needs only briefly, `--with` keeps the value off the platter entirely.
//! Neither mode leaves no trace.

use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{CliError, CliResult};

/// One `NAME:/path` request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileSpec {
    pub name: String,
    pub path: PathBuf,
}

/// Parse `NAME:/path` specs.
///
/// The split is on the first colon that follows the name, and a Windows drive
/// letter is not that colon: `KEY:C:\keys\id` is the file `C:\keys\id`. Unix
/// paths may contain colons too, so everything after the first separator is the
/// path, whatever is in it.
pub fn parse_specs(specs: &[String]) -> CliResult<Vec<FileSpec>> {
    let mut parsed = Vec::with_capacity(specs.len());
    for raw in specs {
        let Some((name, path)) = raw.split_once(':') else {
            return Err(CliError::usage(format!(
                "--with-file wants NAME:PATH, but got {raw:?} with no colon in it"
            )));
        };
        if name.is_empty() {
            return Err(CliError::usage(format!(
                "--with-file {raw:?} has no credential name before the colon"
            )));
        }
        if path.is_empty() {
            return Err(CliError::usage(format!(
                "--with-file {raw:?} has no path after the colon"
            )));
        }
        parsed.push(FileSpec {
            name: name.to_string(),
            path: PathBuf::from(path),
        });
    }
    Ok(parsed)
}

/// Files written for the life of one command, and removed after it.
///
/// Cleanup is in `Drop` rather than at the end of the run, so an error path or
/// a panic still unlinks. It is best effort: a failed unlink is never allowed to
/// mask whatever went wrong first.
#[derive(Debug, Default)]
pub struct Materialised {
    paths: Vec<PathBuf>,
}

impl Materialised {
    /// Write each value to its path, owner-only, refusing to clobber.
    ///
    /// `values` are paired with `specs` by index, in request order.
    pub fn create(values: &[(String, String)], specs: &[FileSpec]) -> CliResult<Self> {
        if values.len() != specs.len() {
            return Err(CliError::failure(format!(
                "the workspace released {} value(s) for {} file request(s); nothing was written",
                values.len(),
                specs.len()
            )));
        }

        let mut materialised = Self::default();
        for (spec, (_, value)) in specs.iter().zip(values) {
            if let Some(directory) = spec.path.parent() {
                if !directory.as_os_str().is_empty() && !directory.exists() {
                    // Only when this is the process creating it. Tightening the
                    // mode of a directory that already exists would be a nasty
                    // surprise — consider what `--with-file KEY:/tmp/k` would do
                    // to `/tmp`.
                    fs::create_dir_all(directory).map_err(|error| {
                        CliError::failure(format!(
                            "could not create {}: {error}",
                            directory.display()
                        ))
                    })?;
                    crate::profile::restrict_to_owner(directory)?;
                }
            }

            let mut file = create_owner_only(&spec.path, &spec.name)?;
            // Registered once this process is the one that created the file, and
            // before the write — so a partial write is cleaned up when
            // `materialised` drops on the error path below, while a file this
            // process refused to clobber is never touched.
            materialised.paths.push(spec.path.clone());
            std::io::Write::write_all(&mut file, value.as_bytes()).map_err(|error| {
                CliError::failure(format!(
                    "could not write {} for {}: {error}",
                    spec.path.display(),
                    spec.name
                ))
            })?;
        }
        Ok(materialised)
    }

    pub fn paths(&self) -> &[PathBuf] {
        &self.paths
    }
}

impl Drop for Materialised {
    fn drop(&mut self) {
        for path in &self.paths {
            let _ = fs::remove_file(path);
        }
    }
}

/// `O_CREAT|O_EXCL` and an owner-only file on both platforms.
///
/// Refusing to overwrite matters twice over: it protects a file the user cares
/// about, and it stops a pre-created symlink from redirecting a credential
/// somewhere the attacker can read.
///
/// The mode bit is set at creation on Unix, so the file is never briefly
/// readable. Windows has no such flag, so the file is created and then its
/// inherited access is stripped — a window of microseconds during which the
/// file exists with its directory's permissions and no content, which is why
/// the value is written only after this returns.
fn create_owner_only(path: &Path, name: &str) -> CliResult<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path).map_err(|error| {
        CliError::failure(format!(
            "could not create {} for {name}: {error}",
            path.display()
        ))
    })?;
    #[cfg(windows)]
    restrict_to_current_user(path, name)?;
    Ok(file)
}

/// Drop every inherited access-control entry and grant this user alone (R04).
///
/// Until this existed, a delivered credential inherited whatever the containing
/// directory allowed. That is usually a per-user profile directory and usually
/// fine — but "usually" is not a guarantee anybody should rest a private key
/// on, and a shared or misconfigured directory would hand the file to everyone
/// it grants. `/inheritance:r` removes the inherited entries and the grant puts
/// exactly one principal back.
///
/// Failing here removes the file rather than leaving a credential behind under
/// permissions nobody checked.
#[cfg(windows)]
fn restrict_to_current_user(path: &Path, name: &str) -> CliResult<()> {
    use std::process::Command;

    let user = std::env::var("USERNAME").unwrap_or_default();
    if user.is_empty() {
        let _ = fs::remove_file(path);
        return Err(CliError::failure(format!(
            "could not determine the current user to secure {} for {name}",
            path.display()
        )));
    }
    let output = Command::new("icacls")
        .arg(path)
        .arg("/inheritance:r")
        .arg("/grant")
        .arg(format!("{user}:(R,W)"))
        .output();
    let ok = matches!(&output, Ok(output) if output.status.success());
    if !ok {
        let _ = fs::remove_file(path);
        return Err(CliError::failure(format!(
            "could not secure {} for {name}; refusing to write a credential to a file whose permissions are unknown",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(raw: &str) -> CliResult<Vec<FileSpec>> {
        parse_specs(&[raw.to_string()])
    }

    /// VAULT-CLI-RULE-017
    #[test]
    fn parses_a_plain_spec() {
        assert_eq!(
            spec("KEY:/tmp/key.pem").unwrap(),
            vec![FileSpec {
                name: "KEY".to_string(),
                path: PathBuf::from("/tmp/key.pem")
            }]
        );
    }

    /// VAULT-CLI-RULE-018
    #[test]
    fn keeps_colons_that_belong_to_the_path() {
        assert_eq!(
            spec("KEY:C:\\keys\\id").unwrap()[0].path,
            PathBuf::from("C:\\keys\\id")
        );
        assert_eq!(
            spec("KEY:/tmp/a:b").unwrap()[0].path,
            PathBuf::from("/tmp/a:b")
        );
    }

    /// VAULT-CLI-RULE-019
    #[test]
    fn refuses_a_spec_with_a_missing_half() {
        assert!(spec("KEY").is_err());
        assert!(spec(":/tmp/key").is_err());
        assert!(spec("KEY:").is_err());
    }

    /// VAULT-CLI-RULE-020
    #[test]
    fn refuses_to_clobber_and_unlinks_what_it_wrote() {
        let directory =
            std::env::temp_dir().join(format!("lepidy-withfile-{}", std::process::id()));
        let path = directory.join("key");
        let specs = vec![FileSpec {
            name: "KEY".to_string(),
            path: path.clone(),
        }];
        let values = vec![("KEY".to_string(), "canary-value-0001".to_string())];

        {
            let materialised = Materialised::create(&values, &specs).unwrap();
            assert_eq!(fs::read_to_string(&path).unwrap(), "canary-value-0001");
            // A refusal to clobber leaves the file it refused to overwrite alone.
            assert!(Materialised::create(&values, &specs).is_err());
            assert_eq!(fs::read_to_string(&path).unwrap(), "canary-value-0001");
            drop(materialised);
        }
        assert!(!path.exists());
        let _ = fs::remove_dir_all(&directory);
    }
}

//! What a build must have before it may emit something a person could install.
//!
//! Everything here is about one asymmetry. A Lepidy desktop build supervises a
//! process that holds injected credentials, and it replaces itself over the
//! network. An unsigned installer that reaches somebody is a program nobody can
//! attribute; an updater artifact with no signature is an update nobody can
//! verify, delivered by a mechanism designed to run without asking. Neither is
//! a thing to discover after shipping.
//!
//! So the rules are enforced by a gate that runs before `tauri build`, and they
//! **refuse rather than warn**. A warning in a build log is a warning nobody
//! reads on the one occasion it mattered.
//!
//! The gate checks for the *presence* of a signing identity, not its validity —
//! only the platform's own tooling can say whether a certificate is good. What
//! it prevents is the specific accident this repository can actually have: a
//! build that quietly produced distributable artifacts because the machine it
//! ran on had none of the credentials configured.

/// The three platforms this product ships on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Windows,
    MacOs,
    Linux,
}

impl Platform {
    /// The platform this build is running on.
    pub fn host() -> Self {
        #[cfg(target_os = "windows")]
        return Self::Windows;
        #[cfg(target_os = "macos")]
        return Self::MacOs;
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        return Self::Linux;
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Windows => "Windows",
            Self::MacOs => "macOS",
            Self::Linux => "Linux",
        }
    }
}

/// Something a distributable build needs and this environment does not have.
///
/// Each carries the environment variables that would satisfy it, because a
/// refusal that does not say what would fix it is a refusal somebody works
/// around by passing `--unsigned`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Missing {
    pub what: &'static str,
    pub any_of: &'static [&'static str],
    pub why: &'static str,
}

/// The minisign key Tauri signs updater artifacts with.
const UPDATER_KEY: [&str; 1] = ["TAURI_SIGNING_PRIVATE_KEY"];

/// Its public half, compiled into the application so it can verify what it
/// downloads. A distributable build without one has no update mechanism at all
/// — see [`crate::updater`] — which is safe, and is also a release nobody can
/// ever fix in place.
const UPDATER_PUBKEY: [&str; 1] = ["LEPIDY_UPDATER_PUBKEY"];

/// Windows: a certificate thumbprint in the machine's store.
const WINDOWS_SIGNING: [&str; 2] = [
    "LEPIDY_WINDOWS_CERTIFICATE_THUMBPRINT",
    "TAURI_WINDOWS_SIGNING_CERTIFICATE_THUMBPRINT",
];

/// macOS: a Developer ID identity, by name or as an imported certificate.
const APPLE_SIGNING: [&str; 2] = ["APPLE_SIGNING_IDENTITY", "APPLE_CERTIFICATE"];

/// macOS: credentials for notarisation, in either of the two shapes Apple
/// accepts. Gatekeeper refuses an un-notarised Developer ID build on a machine
/// that has never seen it, so signing without notarising ships something that
/// does not open.
const APPLE_NOTARISATION: [&str; 2] = ["APPLE_API_KEY", "APPLE_ID"];

/// What is missing before this build may emit distributable artifacts.
///
/// `lookup` is passed in rather than read here so the rules can be exercised
/// without touching the process environment, and so a test cannot pass because
/// the machine running it happened to have a variable set.
pub fn missing(
    platform: Platform,
    updater_artifacts: bool,
    lookup: &dyn Fn(&str) -> Option<String>,
) -> Vec<Missing> {
    let mut missing = Vec::new();
    let present = |names: &[&str]| {
        names.iter().any(|name| {
            lookup(name)
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false)
        })
    };

    if updater_artifacts && !present(&UPDATER_KEY) {
        missing.push(Missing {
            what: "the updater signing key",
            any_of: &UPDATER_KEY,
            why: "an update artifact with no signature is an update nobody can verify, \
                  delivered by a mechanism designed to run without asking",
        });
    }

    if !present(&UPDATER_PUBKEY) {
        missing.push(Missing {
            what: "the updater public key",
            any_of: &UPDATER_PUBKEY,
            why: "a build compiled without one has no update mechanism, which is safe \
                  and is also a release that can never be fixed in place",
        });
    }

    match platform {
        Platform::Windows => {
            if !present(&WINDOWS_SIGNING) {
                missing.push(Missing {
                    what: "the Windows code-signing certificate",
                    any_of: &WINDOWS_SIGNING,
                    why: "an unsigned installer is a program nobody can attribute, and \
                          SmartScreen tells every person who downloads it so",
                });
            }
        }
        Platform::MacOs => {
            if !present(&APPLE_SIGNING) {
                missing.push(Missing {
                    what: "the Apple Developer ID identity",
                    any_of: &APPLE_SIGNING,
                    why: "an unsigned macOS build is a build Gatekeeper refuses to open",
                });
            }
            if !present(&APPLE_NOTARISATION) {
                missing.push(Missing {
                    what: "Apple notarisation credentials",
                    any_of: &APPLE_NOTARISATION,
                    why: "signing without notarising ships something that still does not \
                          open on a machine that has never seen it",
                });
            }
        }
        // Deliberate, and stated rather than left as an empty branch: a `.deb`
        // and an AppImage carry no code signature, and the integrity story for
        // both is the updater signature above plus the checksum beside the
        // download. Inventing a requirement here would be theatre.
        Platform::Linux => {}
    }
    missing
}

/// The message the gate prints when it refuses.
///
/// It names variables and never reads their values, so a build log — which is
/// exactly the sort of place this product spends its time keeping credentials
/// out of — cannot end up carrying a signing key because a build failed.
pub fn refusal(platform: Platform, missing: &[Missing]) -> String {
    let mut message = format!(
        "Refusing to build a distributable {} bundle: this environment has none of the \
         signing material it needs.\n",
        platform.label(),
    );
    for item in missing {
        message.push_str(&format!(
            "\n  - {} — set one of {}\n    {}\n",
            item.what,
            item.any_of.join(" or "),
            item.why,
        ));
    }
    message.push_str(
        "\nTo build something for this machine only, pass --unsigned. What that \
         produces is not distributable and is not an update.\n",
    );
    message
}

/// The name Tauri expects a bundled sidecar binary to have.
///
/// Sidecars are staged with the target triple in the file name and shipped
/// beside the application with it stripped, which is what lets
/// `agentd_path()` in the shell find the daemon next to itself.
pub fn sidecar_name(binary: &str, triple: &str) -> String {
    if triple.contains("windows") {
        format!("{binary}-{triple}.exe")
    } else {
        format!("{binary}-{triple}")
    }
}

/// The binaries a direct-download build carries beside the application.
///
/// PRD §10.1: **the direct-download desktop build is the full one, CLI
/// included**, and it is what the developer documentation points at. The Mac
/// App Store build is the one that cannot carry these, because a sandboxed
/// store app may not spawn an arbitrary child process with an injected
/// environment — which is exactly and only what `lepidy run` does. That split
/// belongs to P02; this list is the direct build's.
pub const BUNDLED_BINARIES: [&str; 2] = ["lepidy", "lepidy-agentd"];

#[cfg(test)]
mod tests {
    use super::*;

    fn nothing(_: &str) -> Option<String> {
        None
    }

    #[test]
    fn a_machine_with_no_signing_material_cannot_build_something_distributable() {
        for platform in [Platform::Windows, Platform::MacOs] {
            let missing = missing(platform, true, &nothing);
            assert!(
                missing.len() >= 2,
                "{platform:?} was allowed to build with nothing: {missing:?}",
            );
        }
        // Linux carries no code signature, and saying so is better than
        // inventing a requirement. Both halves of the updater key are still
        // required.
        let missing = missing(Platform::Linux, true, &nothing);
        assert_eq!(missing.len(), 2);
        assert_eq!(missing[0].any_of, &UPDATER_KEY);
        assert_eq!(missing[1].any_of, &UPDATER_PUBKEY);
    }

    #[test]
    fn either_shape_of_each_credential_satisfies_it() {
        // Tauri and Apple each accept two spellings, and a gate that knew only
        // one would refuse a correctly configured machine — which is how a gate
        // gets disabled.
        for name in WINDOWS_SIGNING {
            let lookup = |asked: &str| {
                (asked == name || asked == UPDATER_PUBKEY[0]).then(|| "present".to_string())
            };
            let missing = missing(Platform::Windows, false, &lookup);
            assert!(
                missing.is_empty(),
                "{name} did not satisfy Windows: {missing:?}"
            );
        }
        for signing in APPLE_SIGNING {
            for notarising in APPLE_NOTARISATION {
                let lookup = |asked: &str| {
                    (asked == signing || asked == notarising || asked == UPDATER_PUBKEY[0])
                        .then(|| "present".to_string())
                };
                let missing = missing(Platform::MacOs, false, &lookup);
                assert!(missing.is_empty(), "{signing}+{notarising}: {missing:?}");
            }
        }
    }

    #[test]
    fn an_empty_variable_is_not_a_credential() {
        // The specific accident this catches: a CI environment that defines
        // every secret name and populates none of them on a fork build.
        let blank = |_: &str| Some("   ".to_string());
        assert!(!missing(Platform::Windows, true, &blank).is_empty());
    }

    #[test]
    fn signing_without_notarising_is_still_refused_on_macos() {
        // Gatekeeper refuses an un-notarised Developer ID build on a machine
        // that has never seen it, so this combination ships something that does
        // not open — which looks like a broken app rather than a missing step.
        let lookup = |asked: &str| {
            matches!(asked, "APPLE_SIGNING_IDENTITY" | "LEPIDY_UPDATER_PUBKEY")
                .then(|| "present".to_string())
        };
        let missing = missing(Platform::MacOs, false, &lookup);
        assert_eq!(missing.len(), 1);
        assert_eq!(missing[0].any_of, &APPLE_NOTARISATION);
    }

    #[test]
    fn the_updater_key_is_only_required_when_an_update_is_produced() {
        // A build that emits no updater artifact needs no updater key. Asking
        // for one anyway would mean every local packaging run needed the key
        // that signs releases, which is the opposite of keeping it rare.
        let signed = |asked: &str| {
            matches!(
                asked,
                "LEPIDY_WINDOWS_CERTIFICATE_THUMBPRINT" | "LEPIDY_UPDATER_PUBKEY"
            )
            .then(|| "present".to_string())
        };
        assert!(missing(Platform::Windows, false, &signed).is_empty());
        assert_eq!(missing(Platform::Windows, true, &signed).len(), 1);
        assert_eq!(
            missing(Platform::Windows, true, &signed)[0].any_of,
            &UPDATER_KEY
        );
    }

    #[test]
    fn the_refusal_names_variables_and_never_reads_them() {
        let secret = "s3cret-signing-key-value";
        let lookup = |_: &str| Some(secret.to_string());
        // Everything present: nothing to refuse. The point is the other case.
        assert!(missing(Platform::Windows, true, &lookup).is_empty());

        let message = refusal(
            Platform::Windows,
            &missing(Platform::Windows, true, &nothing),
        );
        assert!(message.contains("TAURI_SIGNING_PRIVATE_KEY"), "{message}");
        assert!(
            message.contains("LEPIDY_WINDOWS_CERTIFICATE_THUMBPRINT"),
            "{message}"
        );
        // A build log is exactly the sort of place this product spends its time
        // keeping credentials out of.
        assert!(!message.contains(secret), "{message}");
        // And it says what would fix it, so nobody reaches for --unsigned to
        // make the message go away.
        assert!(message.contains("--unsigned"), "{message}");
        assert!(message.contains("not distributable"), "{message}");
    }

    #[test]
    fn a_sidecar_is_named_for_the_triple_it_was_built_for() {
        assert_eq!(
            sidecar_name("lepidy", "x86_64-pc-windows-msvc"),
            "lepidy-x86_64-pc-windows-msvc.exe",
        );
        assert_eq!(
            sidecar_name("lepidy-agentd", "aarch64-apple-darwin"),
            "lepidy-agentd-aarch64-apple-darwin",
        );
        assert_eq!(
            sidecar_name("lepidy-agentd", "x86_64-unknown-linux-gnu"),
            "lepidy-agentd-x86_64-unknown-linux-gnu",
        );
    }

    #[test]
    fn the_direct_build_carries_the_injection_engine() {
        // PRD §10.1. The daemon has to be here because the shell looks for it
        // beside its own executable; the CLI has to be here because the direct
        // download is the build the developer documentation points at.
        assert!(BUNDLED_BINARIES.contains(&"lepidy"));
        assert!(BUNDLED_BINARIES.contains(&"lepidy-agentd"));
    }
}

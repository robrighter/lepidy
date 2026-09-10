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

/// Which channel this build is for.
///
/// One store rule cuts right through the middle of this product, so the answer
/// is not cosmetic. **A sandboxed Mac App Store application may not spawn an
/// arbitrary child process with an injected environment** — which is exactly
/// and only what `lepidy run --with GITHUB_TOKEN -- gh pr list` does. There is
/// no entitlement that fixes it and no workaround worth shipping (PRD §10.1).
///
/// That rule has **two** consequences, and they should always be stated in the
/// same breath because they have the same cause: the Mac App Store build has no
/// injection engine, and it cannot host a runner either. It can configure a
/// local agent and watch its sessions; it cannot be the machine one runs on.
///
/// Windows is unconstrained: an MSIX package declares `runFullTrust`, so the
/// Microsoft Store build is the whole product.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Variant {
    /// Direct download. The full product, and what the developer docs point at.
    Direct,
    /// Mac App Store: the collaboration and approvals client.
    MacAppStore,
    /// Microsoft Store, via MSIX with `runFullTrust`. The full product.
    MicrosoftStore,
}

/// Chosen at build time, because it decides what is *in* the bundle.
///
/// A runtime switch would be a build claiming capabilities its package does not
/// have — and on the store builds, claiming them is precisely what gets an
/// application rejected or, worse, accepted and then broken for everybody.
pub const VARIANT: Option<&str> = option_env!("LEPIDY_VARIANT");

impl Variant {
    /// The variant this binary was built as. Direct unless told otherwise, so
    /// a developer build is the full product.
    pub fn current() -> Self {
        match VARIANT.map(str::trim) {
            Some("mas") | Some("mac-app-store") => Self::MacAppStore,
            Some("msix") | Some("microsoft-store") => Self::MicrosoftStore,
            _ => Self::Direct,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Direct => "direct download",
            Self::MacAppStore => "Mac App Store",
            Self::MicrosoftStore => "Microsoft Store",
        }
    }

    /// The extra bundle configuration merged over the base for this channel.
    pub fn config_file(self) -> &'static str {
        match self {
            Self::Direct => "bundle.direct.json",
            Self::MacAppStore => "bundle.mas.json",
            Self::MicrosoftStore => "bundle.msix.json",
        }
    }

    /// Does this package carry `lepidy` and `lepidy-agentd` beside the app?
    pub fn carries_injection_engine(self) -> bool {
        !matches!(self, Self::MacAppStore)
    }

    /// May this build be the machine an agent session runs on?
    ///
    /// The same sandbox rule, and it is worth keeping as its own question
    /// because it is the consequence people forget: a Mac App Store build can
    /// *configure* a local agent and watch its sessions, and cannot host one.
    pub fn can_host_a_runner(self) -> bool {
        !matches!(self, Self::MacAppStore)
    }

    /// Does this channel take its updates from Lepidy's own updater?
    ///
    /// A store build must not: the store is the update path, and shipping a
    /// self-updater inside a store package is a rejection in both stores and a
    /// way to strand people on a version the store thinks it replaced.
    pub fn self_updates(self) -> bool {
        matches!(self, Self::Direct)
    }
}

/// The one line a build without the injection engine says, and where it points.
///
/// PRD §10.1 asks for one line with a link, and the wording matters more than
/// its length: somebody reading it is trying to work out whether they installed
/// the wrong thing. So it says what is missing, why it cannot be fixed here,
/// and where the working thing is — rather than reading as a failure.
pub fn injection_unavailable() -> String {
    "This build cannot inject credentials into a command: an App Store      application may not start one with an injected environment. Install the      lepidy command-line tool separately — see https://lepidy.app/cli"
        .to_string()
}

/// And the second consequence of the same rule.
pub fn runner_unavailable() -> String {
    "This build cannot run an agent on this Mac, for the same reason it cannot      inject credentials: an App Store application may not start one. It can      still configure a local agent and watch its sessions. See      https://lepidy.app/cli"
        .to_string()
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
    variant: Variant,
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

    // A store package takes its updates from the store, so neither half of the
    // updater key is required for one — and requiring them would mean the key
    // that signs releases had to be present for a build that will never emit an
    // update, which is the opposite of keeping it rare.
    let self_updating = variant.self_updates();

    if self_updating && updater_artifacts && !present(&UPDATER_KEY) {
        missing.push(Missing {
            what: "the updater signing key",
            any_of: &UPDATER_KEY,
            why: "an update artifact with no signature is an update nobody can verify, \
                  delivered by a mechanism designed to run without asking",
        });
    }

    if self_updating && !present(&UPDATER_PUBKEY) {
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
pub fn refusal(platform: Platform, variant: Variant, missing: &[Missing]) -> String {
    let mut message = format!(
        "Refusing to build a distributable {} {} bundle: this environment has none of \
         the signing material it needs.\n",
        platform.label(),
        variant.label(),
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

/// The binaries a build carries beside the application, when it carries any.
///
/// PRD §10.1: the direct download and the Microsoft Store package are the full
/// product, CLI included. The Mac App Store build carries neither, and
/// [`Variant::carries_injection_engine`] is the single place that decides.
pub const BUNDLED_BINARIES: [&str; 2] = ["lepidy", "lepidy-agentd"];

/// What this variant must ship beside the application.
pub fn bundled_binaries(variant: Variant) -> &'static [&'static str] {
    if variant.carries_injection_engine() {
        &BUNDLED_BINARIES
    } else {
        &[]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nothing(_: &str) -> Option<String> {
        None
    }

    #[test]
    fn a_machine_with_no_signing_material_cannot_build_something_distributable() {
        for platform in [Platform::Windows, Platform::MacOs] {
            let missing = missing(platform, Variant::Direct, true, &nothing);
            assert!(
                missing.len() >= 2,
                "{platform:?} was allowed to build with nothing: {missing:?}",
            );
        }
        // Linux carries no code signature, and saying so is better than
        // inventing a requirement. Both halves of the updater key are still
        // required.
        let missing = missing(Platform::Linux, Variant::Direct, true, &nothing);
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
            let missing = missing(Platform::Windows, Variant::Direct, false, &lookup);
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
                let missing = missing(Platform::MacOs, Variant::Direct, false, &lookup);
                assert!(missing.is_empty(), "{signing}+{notarising}: {missing:?}");
            }
        }
    }

    #[test]
    fn an_empty_variable_is_not_a_credential() {
        // The specific accident this catches: a CI environment that defines
        // every secret name and populates none of them on a fork build.
        let blank = |_: &str| Some("   ".to_string());
        assert!(!missing(Platform::Windows, Variant::Direct, true, &blank).is_empty());
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
        let missing = missing(Platform::MacOs, Variant::Direct, false, &lookup);
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
        assert!(missing(Platform::Windows, Variant::Direct, false, &signed).is_empty());
        assert_eq!(
            missing(Platform::Windows, Variant::Direct, true, &signed).len(),
            1
        );
        assert_eq!(
            missing(Platform::Windows, Variant::Direct, true, &signed)[0].any_of,
            &UPDATER_KEY
        );
    }

    #[test]
    fn the_refusal_names_variables_and_never_reads_them() {
        let secret = "s3cret-signing-key-value";
        let lookup = |_: &str| Some(secret.to_string());
        // Everything present: nothing to refuse. The point is the other case.
        assert!(missing(Platform::Windows, Variant::Direct, true, &lookup).is_empty());

        let message = refusal(
            Platform::Windows,
            Variant::Direct,
            &missing(Platform::Windows, Variant::Direct, true, &nothing),
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
    fn one_sandbox_rule_removes_two_things_and_only_on_one_channel() {
        // PRD §10.1 and §7: the Mac App Store build has no injection engine and
        // cannot host a runner, for the same reason. Both consequences, or the
        // second one gets forgotten and somebody ships a build that offers to
        // start an agent it cannot start.
        assert!(!Variant::MacAppStore.carries_injection_engine());
        assert!(!Variant::MacAppStore.can_host_a_runner());
        // And nowhere else. Windows is unconstrained: an MSIX package declares
        // runFullTrust, so the store build is the whole product.
        for variant in [Variant::Direct, Variant::MicrosoftStore] {
            assert!(variant.carries_injection_engine(), "{variant:?}");
            assert!(variant.can_host_a_runner(), "{variant:?}");
        }
    }

    #[test]
    fn a_store_package_is_not_asked_for_the_key_that_signs_releases() {
        // The store is the update path for those channels, so neither half of
        // the updater key is required — only the platform's code signature is.
        let signed = |asked: &str| {
            (asked == "APPLE_SIGNING_IDENTITY" || asked == "APPLE_API_KEY")
                .then(|| "present".to_string())
        };
        assert!(missing(Platform::MacOs, Variant::MacAppStore, true, &signed).is_empty());
        // And the direct build on the same machine still is.
        assert!(!missing(Platform::MacOs, Variant::Direct, true, &signed).is_empty());
    }

    #[test]
    fn only_the_direct_download_updates_itself() {
        // A self-updater inside a store package is a rejection in both stores,
        // and a way to strand somebody on a version the store believes it
        // already replaced.
        assert!(Variant::Direct.self_updates());
        assert!(!Variant::MacAppStore.self_updates());
        assert!(!Variant::MicrosoftStore.self_updates());
    }

    #[test]
    fn a_build_says_what_it_cannot_do_and_where_the_working_thing_is() {
        for sentence in [injection_unavailable(), runner_unavailable()] {
            // What is missing, why it cannot be fixed here, and where to go.
            // Somebody reading this is working out whether they installed the
            // wrong thing, so it must not read as a failure.
            assert!(sentence.contains("App Store"), "{sentence}");
            assert!(sentence.contains("https://lepidy.app/cli"), "{sentence}");
            assert!(!sentence.to_lowercase().contains("error"), "{sentence}");
        }
        // The second one names the thing the build can still do, because "it
        // cannot run an agent" reads as "it is useless for agents" otherwise.
        assert!(runner_unavailable().contains("configure a local agent"));
    }

    #[test]
    fn every_variant_names_its_own_configuration() {
        let mut seen = std::collections::HashSet::new();
        for variant in [
            Variant::Direct,
            Variant::MacAppStore,
            Variant::MicrosoftStore,
        ] {
            assert!(
                seen.insert(variant.config_file()),
                "two variants share a configuration file",
            );
            assert!(variant.config_file().starts_with("bundle."));
        }
    }

    #[test]
    fn an_unknown_variant_is_the_full_product_rather_than_a_crippled_one() {
        // `current()` reads a build-time string. An unrecognised one must mean
        // a developer build, not a silently sandboxed one: a build that
        // withheld the engine because of a typo would be a confusing bug, and
        // the store packages are produced by a script that names the variant.
        assert_eq!(Variant::current().carries_injection_engine(), true);
    }

    #[test]
    fn the_direct_build_carries_the_injection_engine() {
        // PRD §10.1. The daemon has to be here because the shell looks for it
        // beside its own executable; the CLI has to be here because the direct
        // download is the build the developer documentation points at.
        assert!(BUNDLED_BINARIES.contains(&"lepidy"));
        assert!(BUNDLED_BINARIES.contains(&"lepidy-agentd"));
        assert_eq!(bundled_binaries(Variant::Direct), &BUNDLED_BINARIES);
        assert_eq!(bundled_binaries(Variant::MicrosoftStore), &BUNDLED_BINARIES);
        // And the store build that may not spawn a child carries neither.
        assert!(bundled_binaries(Variant::MacAppStore).is_empty());
    }
}

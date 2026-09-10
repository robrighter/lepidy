//! The gate that runs before `tauri build`.
//!
//! It answers one question — *may this environment emit something a person
//! could install?* — and it answers by refusing, not by warning. A warning in a
//! build log is a warning nobody reads on the one occasion it mattered, and the
//! artifact it was about is already on a download page by then.
//!
//! The rules themselves are in `distribution.rs` and `updater.rs`, where they
//! are ordinary tested Rust. This binary is only the part that reads the real
//! configuration and the real environment, which is exactly the part a test
//! should not be doing.

use std::path::{Path, PathBuf};

use lepidy_desktop_lib::{distribution, updater};

/// The direct-download build's extra configuration, merged over the base by
/// `npm run desktop:build`. See the file itself for why it is a separate one.
const DIRECT_BUNDLE: &str = "bundle.direct.json";

fn main() {
    let unsigned = std::env::args().any(|argument| argument == "--unsigned");
    let root = manifest_dir();
    let config = read_config(&root.join("tauri.conf.json"));
    let direct = read_config(&root.join(DIRECT_BUNDLE));

    let updater_artifacts = config["bundle"]["createUpdaterArtifacts"]
        .as_bool()
        .unwrap_or(false);

    // The endpoints are checked whatever the build is for. A plain-http
    // endpoint in a development build is a plain-http endpoint that ships the
    // day somebody flips the other switch.
    let endpoints: Vec<String> = config["plugins"]["updater"]["endpoints"]
        .as_array()
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if let Err(error) = updater::check_endpoints(&endpoints) {
        fail(&format!("lepidy: {error}"));
    }

    // The direct build has to *declare* the injection engine and then have it.
    // Either half missing is a bundle that installs an application which cannot
    // inject a credential — PRD §10.1 says the direct download is the full
    // product — and it is the kind of gap nobody notices until somebody runs
    // `lepidy run` on a fresh machine.
    let declared: Vec<String> = direct["bundle"]["externalBin"]
        .as_array()
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    for binary in distribution::BUNDLED_BINARIES {
        if !declared
            .iter()
            .any(|entry| entry.ends_with(&format!("/{binary}")))
        {
            fail(&format!(
                "lepidy: {DIRECT_BUNDLE} does not carry {binary}. A direct download \
                 without it installs an application that cannot inject a credential.",
            ));
        }
    }

    let triple = env!("LEPIDY_TARGET_TRIPLE");
    let staging = root.join("binaries");
    let mut absent = Vec::new();
    for binary in distribution::BUNDLED_BINARIES {
        let name = distribution::sidecar_name(binary, triple);
        if !staging.join(&name).is_file() {
            absent.push(name);
        }
    }
    if !absent.is_empty() {
        fail(&format!(
            "lepidy: the bundle is missing {}.\n\
             Stage them with `npm run desktop:build`, which builds and names them \
             for this target; a bundle without them is a download that cannot \
             inject a credential.",
            absent.join(", "),
        ));
    }

    if unsigned {
        // Loud, and on stderr, because the one way this flag becomes a problem
        // is somebody using it in the place that publishes.
        eprintln!(
            "lepidy: building UNSIGNED for this machine only.\n\
             What this produces must not be published and is not an update."
        );
        return;
    }

    let platform = distribution::Platform::host();
    let missing = distribution::missing(platform, updater_artifacts, &|name| {
        std::env::var(name).ok()
    });
    if !missing.is_empty() {
        fail(&distribution::refusal(platform, &missing));
    }

    println!(
        "lepidy: {} bundle may be signed; {} sidecars staged for {triple}.",
        platform.label(),
        distribution::BUNDLED_BINARIES.len(),
    );
}

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn read_config(path: &Path) -> serde_json::Value {
    let text = std::fs::read_to_string(path)
        .unwrap_or_else(|error| fail(&format!("lepidy: {}: {error}", path.display())));
    serde_json::from_str(&text)
        .unwrap_or_else(|error| fail(&format!("lepidy: {}: {error}", path.display())))
}

fn fail(message: &str) -> ! {
    eprintln!("{message}");
    std::process::exit(1);
}

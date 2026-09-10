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

fn main() {
    let unsigned = std::env::args().any(|argument| argument == "--unsigned");
    let root = manifest_dir();
    let config = read_config(&root.join("tauri.conf.json"));
    // Which channel this bundle is for. It decides what must be in the package
    // and what must not — see `distribution::Variant`.
    let variant = distribution::Variant::current();
    let variant_config = variant.config_file();
    let extras = read_config(&root.join(variant_config));

    let updater_artifacts = extras["bundle"]["createUpdaterArtifacts"]
        .as_bool()
        .or_else(|| config["bundle"]["createUpdaterArtifacts"].as_bool())
        .unwrap_or(false);
    if updater_artifacts && !variant.self_updates() {
        fail(&format!(
            "lepidy: {variant_config} produces updater artifacts for the {} build.\n\
             The store is the update path for that channel; a self-updater inside a \
             store package is a rejection, and a way to strand somebody on a version \
             the store believes it already replaced.",
            variant.label(),
        ));
    }

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

    // The build has to *declare* the injection engine and then have it.
    // Either half missing is a bundle that installs an application which cannot
    // inject a credential — PRD §10.1 says the direct download is the full
    // product — and it is the kind of gap nobody notices until somebody runs
    // `lepidy run` on a fresh machine.
    let declared: Vec<String> = extras["bundle"]["externalBin"]
        .as_array()
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let required = distribution::bundled_binaries(variant);

    // The inversion matters more than the omission. A package whose sandbox
    // forbids spawning a child must not carry the thing whose only job is to
    // spawn one: shipping it is a review rejection at best, and at worst an
    // accepted build with a tool in it that cannot work.
    if required.is_empty() && !declared.is_empty() {
        fail(&format!(
            "lepidy: {variant_config} carries {} in the {} build, which may not spawn \n\
             a child process at all. {}",
            declared.join(", "),
            variant.label(),
            distribution::injection_unavailable(),
        ));
    }
    for binary in required {
        if !declared
            .iter()
            .any(|entry| entry.ends_with(&format!("/{binary}")))
        {
            fail(&format!(
                "lepidy: {variant_config} does not carry {binary}. A {} without it \
                 installs an application that cannot inject a credential.",
                variant.label(),
            ));
        }
    }

    let triple = env!("LEPIDY_TARGET_TRIPLE");
    let staging = root.join("binaries");
    let mut absent = Vec::new();
    for binary in required {
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
    let missing = distribution::missing(platform, variant, updater_artifacts, &|name| {
        std::env::var(name).ok()
    });
    if !missing.is_empty() {
        fail(&distribution::refusal(platform, variant, &missing));
    }

    println!(
        "lepidy: {} {} bundle may be signed; {} sidecars staged for {triple}.",
        platform.label(),
        variant.label(),
        required.len(),
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

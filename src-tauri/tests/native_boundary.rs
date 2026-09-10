//! The native surface, as configuration.
//!
//! Everything the desktop shell can do is decided in three files: the command
//! list in `lib.rs`, the capability grants in `capabilities/default.json`, and
//! the window security settings in `tauri.conf.json`. None of those fails a
//! compile when it grows, and all three are exactly where a capability creeps
//! in — somebody adds a plugin permission to make one feature work and nobody
//! notices it also handed the page a filesystem.
//!
//! So they are asserted here, by content rather than by shape, and a change to
//! any of them has to be made deliberately with this test in front of it.

use serde_json::Value;

fn read(relative: &str) -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
    std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

/// The whole native surface a page can reach. Adding to this list is the point
/// at which somebody should have to think.
const COMMANDS: [&str; 7] = [
    "runner_status",
    "runner_stop",
    "runner_start",
    "local_verify",
    "platform_name",
    "notify",
    "set_badge",
];

#[test]
fn native_int_001_exposes_exactly_the_listed_commands() {
    let source = read("src/lib.rs");
    let handler = source
        .split_once("generate_handler![")
        .expect("the shell registers an invoke handler")
        .1
        .split_once(']')
        .expect("the handler list is closed")
        .0;
    let listed: Vec<String> = handler
        .split(',')
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .collect();
    assert_eq!(listed, COMMANDS, "the native command surface changed");

    // And each one is actually defined as a command, so the list is not
    // aspirational.
    for command in COMMANDS {
        assert!(
            source.contains(&format!("fn {command}(")),
            "{command} is registered but not defined",
        );
    }

    // The same list, declared to the access-control layer. A command missing
    // here is a command a remote origin is refused — silently, at runtime, in
    // a window nobody compiles.
    let build = read("build.rs");
    let declared = build
        .split_once("const COMMANDS: &[&str] = &[")
        .expect("build.rs declares the command surface")
        .1
        .split_once("];")
        .expect("the declaration closes")
        .0;
    let declared: Vec<String> = declared
        .split(',')
        .map(|name| name.trim().trim_matches('"').to_string())
        .filter(|name| !name.is_empty() && !name.starts_with("//"))
        .collect();
    assert_eq!(declared, COMMANDS, "build.rs and the handler disagree");
}

#[test]
fn native_int_002_every_command_checks_where_it_came_from() {
    let ipc = read("src/ipc.rs");
    // The check is one function, and every entry point calls it. A command that
    // forgot to would be a command any page could reach.
    for entry in [
        "runner_status",
        "runner_stop",
        "runner_start",
        "local_verify",
        "notify",
        "set_badge",
    ] {
        let body = ipc
            .split_once(&format!("pub fn {entry}("))
            .unwrap_or_else(|| panic!("{entry} is not defined in ipc.rs"))
            .1;
        let body = body.split_once("\n}").expect("a function body").0;
        assert!(
            body.contains("require_trusted_caller"),
            "{entry} does not check the caller's origin",
        );
    }
    // `platform_name` lives in lib.rs because it answers with a constant, and
    // it checks too.
    let shell = read("src/lib.rs");
    let platform = shell
        .split_once("fn platform_name(")
        .expect("platform_name is defined")
        .1
        .split_once("\n}")
        .expect("a function body")
        .0;
    assert!(platform.contains("require_trusted_caller"));
}

#[test]
fn native_int_003_grants_no_capability_that_reaches_past_the_window() {
    let capability: Value = serde_json::from_str(&read("capabilities/default.json"))
        .expect("the capability file is json");
    let permissions: Vec<String> = capability["permissions"]
        .as_array()
        .expect("permissions is a list")
        .iter()
        .map(|value| {
            value
                .as_str()
                .expect("a permission is a string")
                .to_string()
        })
        .collect();

    // Window chrome and nothing else. These are the plugins whose permissions
    // would hand the page the machine, and none of them is granted.
    for forbidden in [
        "shell",
        "fs:",
        "process",
        "http",
        "updater",
        "notification",
        "clipboard",
        "dialog",
        // P01a's three plugins. Each is used from Rust, and none of them is
        // granted to a page: a page that could register a global shortcut could
        // take a key away from the whole machine, and a page that could raise a
        // notification directly would skip `presence::prepare`.
        "global-shortcut",
        "deep-link",
        "autostart",
    ] {
        assert!(
            !permissions
                .iter()
                .any(|permission| permission.contains(forbidden)),
            "the capability file grants {forbidden}: {permissions:?}",
        );
    }
    // Everything granted is either window chrome or one of this shell's own
    // commands, named one at a time. A permission that is neither is a plugin
    // reaching past the window.
    let commands: Vec<String> = COMMANDS
        .iter()
        .map(|command| format!("allow-{}", command.replace('_', "-")))
        .collect();
    for permission in &permissions {
        assert!(
            permission.starts_with("core:") || commands.contains(permission),
            "an unexpected permission appeared: {permission}",
        );
    }
    // And every command is granted, or it is a command the page cannot reach —
    // which is how `platform_name` came to be unreachable until a real window
    // was driven at one.
    for command in &commands {
        assert!(
            permissions.contains(command),
            "{command} is registered but never granted",
        );
    }
    // Scoped to the one window, so a future window does not inherit this.
    assert_eq!(capability["windows"], serde_json::json!(["main"]));
}

#[test]
fn native_int_004_keeps_the_window_from_being_a_general_purpose_browser() {
    let config: Value = serde_json::from_str(&read("tauri.conf.json")).expect("the config is json");
    // No global Tauri object: a page reaches the native side through the
    // generated bindings or not at all.
    assert_eq!(config["app"]["withGlobalTauri"], Value::Bool(false));

    let csp = config["app"]["security"]["csp"]
        .as_str()
        .expect("a content security policy is set");
    assert!(csp.starts_with("default-src 'self'"), "{csp}");
    // `unsafe-eval` in this window would make every string a page can build
    // into code, and the content in this product is written by strangers.
    assert!(!csp.contains("unsafe-eval"), "{csp}");
    assert!(
        !csp.contains("script-src") || !csp.contains("unsafe-inline"),
        "{csp}"
    );

    // The one remote origin the capability file admits is loopback, for
    // development. A production origin is given at runtime and checked by
    // `TrustedOrigin`, not baked in here.
    let capability: Value = serde_json::from_str(&read("capabilities/default.json"))
        .expect("the capability file is json");
    let remotes: Vec<String> = capability["remote"]["urls"]
        .as_array()
        .expect("remote urls")
        .iter()
        .map(|value| value.as_str().expect("a url").to_string())
        .collect();
    for remote in &remotes {
        assert!(
            remote.starts_with("http://localhost") || remote.starts_with("https://"),
            "a plain-http remote origin was admitted: {remote}",
        );
    }
}

#[test]
fn native_int_005_stop_is_the_one_thing_that_never_asks() {
    let ipc = read("src/ipc.rs");
    let stop = ipc
        .split_once("pub fn runner_stop(")
        .expect("runner_stop is defined")
        .1
        .split_once("\n}")
        .expect("a function body")
        .0;
    // No confirmation in the way. A stop that can be refused is a stop that
    // gets skipped at the moment it is needed, and the worst case of an
    // unnecessary stop is that somebody's agents go idle.
    assert!(
        !stop.contains("consume") && !stop.contains("verify"),
        "runner_stop asks for something first: {stop}",
    );

    // The tray's stop goes straight to the supervisor for the same reason.
    let shell = read("src/lib.rs");
    let tray = shell
        .split_once("\"stop\" => {")
        .expect("the tray has a stop item")
        .1
        .split_once("\n            }")
        .expect("a match arm")
        .0;
    assert!(tray.contains("supervisor"), "{tray}");
    assert!(
        !tray.contains("verify") && !tray.contains("consume"),
        "{tray}"
    );
}

/* -------------------------------------------------------------------------- */
/* Desktop presence (P01a)                                                     */
/* -------------------------------------------------------------------------- */

#[test]
fn native_int_006_grants_the_workspace_origin_exactly_what_the_file_grants_loopback() {
    // Two places name what a window may do: the checked-in capability file, and
    // the capability the shell adds at startup for the configured origin. They
    // have to be the same list, or the production window quietly has a
    // permission the reviewed file does not mention.
    let shell = read("src/lib.rs");
    let listed = shell
        .split_once("const WINDOW_PERMISSIONS: [&str; ")
        .expect("the shell names the permissions it grants")
        .1
        .split_once('[')
        .expect("the list opens")
        .1
        .split_once(']')
        .expect("the list closes")
        .0;
    // Line by line, keeping only the entries: the list is commented, and a
    // comma inside a comment is not a permission.
    let granted: Vec<String> = listed
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with('"'))
        .map(|line| line.trim_end_matches(',').trim_matches('"').to_string())
        .collect();

    let capability: Value = serde_json::from_str(&read("capabilities/default.json"))
        .expect("the capability file is json");
    let from_file: Vec<String> = capability["permissions"]
        .as_array()
        .expect("permissions is a list")
        .iter()
        .map(|value| value.as_str().expect("a permission").to_string())
        .collect();
    assert_eq!(granted, from_file, "the two permission lists disagree");

    // And the runtime grant is remote-only and scoped to the one window, so it
    // cannot widen what the bundled fallback document may do.
    let builder = shell
        .split_once("fn grant_workspace_capability(")
        .expect("the shell grants a capability")
        .1
        .split_once("\n}")
        .expect("a function body")
        .0;
    assert!(builder.contains(".local(false)"), "{builder}");
    assert!(builder.contains(".window(\"main\")"), "{builder}");
    // One origin, and it is the one `TrustedOrigin` validated — never a string
    // from anywhere else.
    assert!(builder.contains("origin.as_str()"), "{builder}");
    assert_eq!(builder.matches(".remote(").count(), 2, "{builder}");
}

#[test]
fn native_int_007_registers_one_scheme_and_the_parser_knows_it() {
    let config: Value = serde_json::from_str(&read("tauri.conf.json")).expect("the config is json");
    let schemes: Vec<String> = config["plugins"]["deep-link"]["desktop"]["schemes"]
        .as_array()
        .expect("the deep-link scheme is declared")
        .iter()
        .map(|value| value.as_str().expect("a scheme").to_string())
        .collect();
    // One scheme. A second one is a second entry point from the whole operating
    // system into this process, and it would not go through `deeplink::parse`
    // unless somebody remembered.
    assert_eq!(schemes, vec!["lepidy".to_string()]);

    let parser = read("src/deeplink.rs");
    assert!(
        parser.contains("pub const SCHEME: &str = \"lepidy\";"),
        "the parser and the bundle disagree about the scheme",
    );
}

#[test]
fn native_int_008_the_offline_document_asks_for_nothing_and_claims_nothing() {
    let page = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../desktop-shell/index.html"),
    )
    .expect("the bundled fallback document");

    // The shell writes the machine's state in here after the load. An empty
    // placeholder is the point: a fixed sentence about what is running would
    // eventually be the wrong one.
    assert!(page.contains("id=\"state\""), "no placeholder to fill");
    assert!(
        !page.contains("<script"),
        "the fallback document runs script of its own",
    );
    // It is shown when the network is unreachable, so anything it fetches is a
    // thing that will not load. Everything it needs is beside it in the bundle.
    for remote in ["http://", "https://", "//cdn", "@import"] {
        assert!(
            !page.contains(remote),
            "the fallback document fetches {remote}"
        );
    }
    // And it must not carry a stop control: this document is not the trusted
    // origin, so no native command answers it, and a button that did nothing
    // would be worse than the sentence that says where the stop actually is.
    assert!(
        !page.contains("<button"),
        "the fallback document offers a control"
    );
    assert!(
        !page.contains("invoke"),
        "the fallback document calls a command"
    );
}

#[test]
fn native_int_009_the_kill_switch_only_ever_stops() {
    let shell = read("src/lib.rs");
    let handler = shell
        .split_once(".with_handler(move |_app, _shortcut, event| {")
        .expect("the global shortcut has a handler")
        .1
        .split_once("\n                })")
        .expect("the handler closes")
        .0;
    // The one input on this machine that works when Lepidy is not in front of
    // anybody. It goes straight to the supervisor's stop, it asks nothing
    // first, and there is no branch in it that starts anything.
    assert!(handler.contains("stop()"), "{handler}");
    assert!(!handler.contains("start"), "{handler}");
    assert!(
        !handler.contains("consume") && !handler.contains("verify"),
        "the kill switch asks for something first: {handler}",
    );

    // Exactly one is registered, and its action is not configurable.
    assert_eq!(shell.matches("global_shortcut().register(").count(), 1);
    let hotkey = read("src/hotkey.rs");
    assert!(
        hotkey.contains("pub const CHORD_ENV"),
        "the chord is chosen on the machine",
    );
    // The page has no way to name a chord: no command takes one.
    let ipc = read("src/ipc.rs");
    assert!(
        !ipc.contains("Chord"),
        "a command reaches the kill-switch chord"
    );
}

/* -------------------------------------------------------------------------- */
/* Signed builds and the updater (P01b)                                        */
/* -------------------------------------------------------------------------- */

#[test]
fn native_int_010_fetches_updates_over_nothing_but_https() {
    let config: Value = serde_json::from_str(&read("tauri.conf.json")).expect("the config is json");
    let updater = &config["plugins"]["updater"];

    let endpoints: Vec<String> = updater["endpoints"]
        .as_array()
        .expect("the updater declares its endpoints")
        .iter()
        .map(|value| value.as_str().expect("an endpoint").to_string())
        .collect();
    assert!(!endpoints.is_empty(), "an updater with no endpoint");
    for endpoint in &endpoints {
        // The signature is what makes an update trustworthy, so plain http
        // would not let somebody forge one. It would let them see which version
        // every machine in a company runs, and withhold the release that fixes
        // something.
        assert!(endpoint.starts_with("https://"), "{endpoint}");
    }

    // The three escape hatches Tauri offers, none of them taken. Each one is a
    // single boolean away from an update path that trusts the network.
    for dangerous in [
        "dangerousInsecureTransportProtocol",
        "dangerousAcceptInvalidCerts",
        "dangerousAcceptInvalidHostnames",
    ] {
        assert!(
            updater[dangerous].is_null() || updater[dangerous] == Value::Bool(false),
            "the updater sets {dangerous}",
        );
    }
}

#[test]
fn native_int_011_keeps_the_verifying_key_out_of_the_files_beside_the_application() {
    let config: Value = serde_json::from_str(&read("tauri.conf.json")).expect("the config is json");
    // Empty on purpose. The real key is compiled in from the environment, so
    // changing it is a rebuild rather than something anybody who can write a
    // file next to the application can do — which is the whole attack the
    // signature exists to stop.
    assert_eq!(
        config["plugins"]["updater"]["pubkey"],
        Value::String(String::new())
    );

    let updater = read("src/updater.rs");
    assert!(
        updater.contains("option_env!(\"LEPIDY_UPDATER_PUBKEY\")"),
        "the key is not read at build time",
    );
    // And a build that was given none registers no updater at all, rather than
    // one that trusts whatever answers the endpoint.
    let shell = read("src/lib.rs");
    assert!(
        shell.contains("if updater::is_configured()"),
        "the updater plugin is registered unconditionally",
    );
}

#[test]
fn native_int_012_never_lets_a_page_cause_a_restart() {
    let shell = read("src/lib.rs");
    // Updating replaces the process supervising somebody's agents. There is no
    // command that checks, downloads, installs or restarts, and the pending
    // update is module-private with no accessor.
    let handler = shell
        .split_once("generate_handler![")
        .expect("an invoke handler")
        .1
        .split_once(']')
        .expect("the handler list closes")
        .0;
    for forbidden in ["update", "restart", "install"] {
        assert!(
            !handler.contains(forbidden),
            "a command mentions {forbidden}: {handler}",
        );
    }
    assert!(
        !shell.contains("pub fn install_pending_update")
            && !shell.contains("pub fn pending_update"),
        "the update path is reachable from outside the shell",
    );

    // And the tray's update item stops the runner before anything is
    // downloaded. Stopping afterwards would be stopping nothing, because this
    // process is already gone.
    let arm = shell
        .split_once("\"update\" => {")
        .expect("the tray has an update item")
        .1
        .split_once("\n            }")
        .expect("a match arm")
        .0;
    let stop_at = arm
        .find("prepare_to_install")
        .expect("the update item stops the runner");
    let install_at = arm
        .find("install_pending_update")
        .expect("the update item installs");
    assert!(
        stop_at < install_at,
        "the install happens before the stop: {arm}"
    );
}

#[test]
fn native_int_013_the_direct_download_carries_the_injection_engine() {
    let config: Value = serde_json::from_str(&read("tauri.conf.json")).expect("the config is json");
    assert_eq!(config["bundle"]["active"], Value::Bool(true));
    // An updater artifact is produced, which is what makes the signing key a
    // requirement rather than an option — see `distribution::missing`.
    assert_eq!(
        config["bundle"]["createUpdaterArtifacts"],
        Value::Bool(true)
    );
    // The base configuration must not declare the sidecars: Tauri validates
    // them when the crate is compiled, and the local gate compiles this crate
    // on every run without building a release CLI.
    assert!(
        config["bundle"]["externalBin"].is_null(),
        "the base configuration declares sidecars, which breaks `cargo check`",
    );

    let direct: Value =
        serde_json::from_str(&read("bundle.direct.json")).expect("the direct bundle config");
    let sidecars: Vec<String> = direct["bundle"]["externalBin"]
        .as_array()
        .expect("the direct build declares its sidecars")
        .iter()
        .map(|value| value.as_str().expect("a sidecar").to_string())
        .collect();
    // PRD §10.1: the direct download is the full product, CLI included. A
    // bundle without these installs an application that cannot inject a
    // credential, which nobody notices until `lepidy run` on a fresh machine.
    for binary in ["lepidy", "lepidy-agentd"] {
        assert!(
            sidecars
                .iter()
                .any(|entry| entry.ends_with(&format!("/{binary}"))),
            "the direct build does not carry {binary}: {sidecars:?}",
        );
    }

    // Every icon the bundle names is actually there. A missing one fails the
    // bundle late, on the machine that publishes.
    for icon in config["bundle"]["icon"].as_array().expect("icons") {
        let relative = icon.as_str().expect("an icon path");
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
        assert!(
            path.is_file(),
            "the bundle names a missing icon: {relative}"
        );
    }
}

/* -------------------------------------------------------------------------- */
/* Store variants (P02)                                                        */
/* -------------------------------------------------------------------------- */

#[test]
fn native_int_014_gives_each_channel_a_configuration_and_only_the_direct_one_self_updates() {
    let base: Value = serde_json::from_str(&read("tauri.conf.json")).expect("the config is json");
    assert_eq!(base["bundle"]["createUpdaterArtifacts"], Value::Bool(true));

    for (file, self_updates) in [
        ("bundle.direct.json", true),
        ("bundle.mas.json", false),
        ("bundle.msix.json", false),
    ] {
        let config: Value =
            serde_json::from_str(&read(file)).unwrap_or_else(|error| panic!("{file}: {error}"));
        let produces = config["bundle"]["createUpdaterArtifacts"]
            .as_bool()
            // The direct build inherits the base configuration's `true`.
            .unwrap_or(true);
        assert_eq!(
            produces, self_updates,
            "{file} disagrees about whether this channel updates itself",
        );
        // A store package takes its updates from the store. Shipping a
        // self-updater inside one is a rejection, and a way to strand somebody
        // on a version the store believes it already replaced.
        if !self_updates {
            assert_eq!(
                config["bundle"]["createUpdaterArtifacts"],
                Value::Bool(false),
                "{file} must say so rather than inherit",
            );
        }
    }
}

#[test]
fn native_int_015_keeps_the_injection_engine_out_of_the_package_that_may_not_spawn_one() {
    let sidecars = |file: &str| -> Vec<String> {
        let config: Value =
            serde_json::from_str(&read(file)).unwrap_or_else(|error| panic!("{file}: {error}"));
        config["bundle"]["externalBin"]
            .as_array()
            .map(|values| {
                values
                    .iter()
                    .map(|value| value.as_str().expect("a sidecar").to_string())
                    .collect()
            })
            .unwrap_or_default()
    };

    // Windows is unconstrained: an MSIX package declares runFullTrust, so the
    // Microsoft Store build is the whole product (PRD §10.1).
    for file in ["bundle.direct.json", "bundle.msix.json"] {
        let declared = sidecars(file);
        for binary in ["lepidy", "lepidy-agentd"] {
            assert!(
                declared
                    .iter()
                    .any(|entry| entry.ends_with(&format!("/{binary}"))),
                "{file} does not carry {binary}: {declared:?}",
            );
        }
    }

    // And the one that may not spawn a child process carries neither. Shipping
    // the injection engine in a sandboxed App Store build is a review rejection
    // at best, and at worst an accepted build with a tool in it that cannot
    // work — which is worse, because somebody would rely on it.
    assert!(
        sidecars("bundle.mas.json").is_empty(),
        "the Mac App Store build carries the injection engine",
    );
}

#[test]
fn native_int_016_asks_for_no_entitlement_that_would_reach_for_the_forbidden_capability() {
    let mas: Value = serde_json::from_str(&read("bundle.mas.json")).expect("the mas config");
    let entitlements = mas["bundle"]["macOS"]["entitlements"]
        .as_str()
        .expect("the Mac App Store build names its entitlements");
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(entitlements);
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    // Comments stripped first: the file explains at length which entitlements
    // it deliberately does not ask for, and a check that read the explanation
    // as a declaration would fail on the very documentation that makes the
    // decision legible.
    let plist = strip_xml_comments(&raw);

    // The sandbox itself, and outgoing network. That is the client.
    assert!(plist.contains("com.apple.security.app-sandbox"), "{plist}");
    assert!(
        plist.contains("com.apple.security.network.client"),
        "{plist}"
    );

    // What must never appear: every one of these is a way of reaching for the
    // capability the sandbox exists to withhold — starting a child process with
    // an environment we chose — and asking for one is how a build ends up
    // rejected, or shipped pretending it can inject a credential.
    for forbidden in [
        "com.apple.security.inherit",
        "com.apple.security.cs.allow-jit",
        "com.apple.security.cs.allow-unsigned-executable-memory",
        "com.apple.security.cs.allow-dyld-environment-variables",
        "com.apple.security.cs.disable-library-validation",
        "com.apple.security.temporary-exception",
    ] {
        assert!(
            !plist.contains(forbidden),
            "the entitlements ask for {forbidden}"
        );
    }
}

/// Everything outside `<!-- … -->`.
fn strip_xml_comments(source: &str) -> String {
    let mut out = String::with_capacity(source.len());
    let mut rest = source;
    while let Some(start) = rest.find("<!--") {
        out.push_str(&rest[..start]);
        match rest[start..].find("-->") {
            Some(end) => rest = &rest[start + end + 3..],
            None => return out,
        }
    }
    out.push_str(rest);
    out
}

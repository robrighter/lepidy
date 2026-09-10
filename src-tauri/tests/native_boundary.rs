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
    assert!(
        permissions
            .iter()
            .all(|permission| permission.starts_with("core:")),
        "a non-core permission appeared: {permissions:?}",
    );
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
    let granted: Vec<String> = listed
        .split(',')
        .map(|entry| entry.trim().trim_matches('"').to_string())
        .filter(|entry| !entry.is_empty())
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

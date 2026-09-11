use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

pub mod deeplink;
pub mod distribution;
pub mod hotkey;
pub mod ipc;
pub mod local_store;
pub mod offline;
pub mod origin;
pub mod presence;
pub mod supervisor;
pub mod updater;
pub mod verification;

/// Everything a window in this shell is allowed to do that is not a command.
///
/// Window chrome and the command list, and that is the whole of it: no `shell`, no `fs`, no
/// `process`, no `http`, no `updater`, no `notification`, no `global-shortcut`,
/// no `deep-link`, no `clipboard`, no `dialog`. The three plugins this shell
/// uses are Rust dependencies, driven from this file — a page reaches a
/// notification or the kill switch through `ipc.rs` or not at all.
///
/// Mirrored in `capabilities/default.json`, which is what a development
/// loopback window gets; [`grant_workspace_capability`] gives the same list to
/// the configured workspace origin. `native_boundary.rs` asserts the two agree.
const WINDOW_PERMISSIONS: [&str; 14] = [
    "core:default",
    "core:window:allow-start-dragging",
    "core:window:allow-minimize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-close",
    "core:window:allow-show",
    "core:window:allow-set-focus",
    // The seven commands, named one at a time. Tauri refuses a custom command
    // to a remote origin unless a capability names it, and this workspace is
    // remote — so without these the shell's own commands are unreachable from
    // the only page that is ever meant to call them. P01b's GUI harness found
    // that, because it is the only test that goes through the real webview.
    "allow-runner-status",
    "allow-runner-stop",
    "allow-runner-start",
    "allow-local-verify",
    "allow-platform-name",
    "allow-notify",
    "allow-set-badge",
];

/// Grant the configured workspace origin the window chrome it needs.
///
/// A capability file is decided when the binary is built, and the origin this
/// shell trusts is decided when it starts — R03's decision, because a
/// production origin baked into a binary is a default nobody notices is wrong.
/// This is the join between the two, and it is deliberately narrow: one window,
/// the list above, and the one origin `TrustedOrigin` already validated. It
/// cannot admit a second origin, because there is only ever one.
fn grant_workspace_capability(
    app: &tauri::AppHandle,
    origin: &origin::TrustedOrigin,
) -> tauri::Result<()> {
    let mut capability = tauri::ipc::CapabilityBuilder::new("workspace-origin")
        // Remote only: the bundled offline document's grants come from the
        // checked-in file, and it gets no command either way.
        .local(false)
        .window("main")
        .remote(origin.as_str())
        .remote(format!("{}/*", origin.as_str()));
    for permission in WINDOW_PERMISSIONS {
        capability = capability.permission(permission);
    }
    app.add_capability(capability)
}

fn desktop_platform() -> &'static str {
    #[cfg(target_os = "macos")]
    return "macos";
    #[cfg(target_os = "windows")]
    return "windows";
    #[cfg(target_os = "linux")]
    return "linux";
}

fn build_main_window(
    app: &tauri::AppHandle,
    state: std::sync::Arc<ipc::NativeState>,
) -> tauri::Result<()> {
    let origin = state.origin.clone();
    // The window opens on the workspace, in every build. `workspace_origin`
    // has already decided what that is — loopback in development, and a release
    // build with nothing configured refused to start rather than guessing. The
    // bundled document is no longer where a release build begins; it is where
    // it lands when the workspace cannot be reached, which is what makes it an
    // offline fallback rather than a permanent connection screen. It opens on
    // Home's path, not the bare origin, which serves the public marketing site.
    let url = WebviewUrl::External(
        workspace_home(&origin)
            .parse()
            .expect("a parsed origin is a parseable URL"),
    );

    let initialization_script = format!(
        "(() => {{ const apply = () => document.documentElement.dataset.desktopPlatform = '{}'; if (document.documentElement) apply(); else addEventListener('DOMContentLoaded', apply, {{ once: true }}); }})();",
        desktop_platform()
    );

    let watch_state = std::sync::Arc::clone(&state);
    let mut builder = WebviewWindowBuilder::new(app, "main", url)
        // The boundary, enforced rather than described. Messages in this
        // product are written by agents and by strangers, so a link that
        // navigates this window somewhere else is not hypothetical — and a
        // window that has navigated elsewhere is a window whose page can call
        // every native command below.
        //
        // Two things are admitted: the trusted origin, and the bundled offline
        // document. The second is admitted so it can be *shown*; it is not the
        // trusted origin, so `require_trusted_caller` refuses every command to
        // it, which is why admitting it costs nothing.
        .on_navigation(move |url| {
            let url = url.as_str();
            let allowed = origin.allows(url) || offline::is_fallback_document(url);
            if !allowed {
                eprintln!("lepidy: refused to navigate the desktop window to {url}");
            }
            allowed
        })
        // Whether the workspace is answering. A window that never finished
        // loading is the only thing that puts this shell on the fallback: an
        // HTTP error or a sign-in redirect is the workspace talking, and
        // replacing that with "you are offline" would name the wrong problem.
        .on_page_load(move |webview, payload| {
            let url = payload.url().to_string();
            let finished = matches!(payload.event(), tauri::webview::PageLoadEvent::Finished);
            if watch_state.origin.allows(&url) {
                let mut watch = watch_state.watch.lock().expect("watch");
                if finished {
                    watch.finished();
                } else {
                    watch.started(verification::now_ms());
                }
                return;
            }
            // The fallback document is static, so what it says about this
            // machine is written into it here — after it has loaded, from the
            // supervisor, so it cannot be stale and cannot overstate.
            if finished && offline::is_fallback_document(&url) {
                let runner = watch_state.supervisor.lock().expect("supervisor").state();
                let _ = webview.eval(&offline::status_script(&offline::fallback_status(runner)));
            }
        })
        .title("Lepidy")
        .inner_size(1320.0, 860.0)
        .min_inner_size(880.0, 620.0)
        .shadow(true)
        .initialization_script(&initialization_script);

    // Match Slipchat's platform chrome: macOS keeps native traffic lights over
    // the branded web strip; Windows uses the web strip and caption controls.
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }

    #[cfg(target_os = "windows")]
    {
        builder = builder.decorations(false);
    }

    builder.build()?;
    Ok(())
}

/// The tray: what a person sees when the window is closed.
///
/// A runner keeps answering with no window open — that is the whole point of a
/// headless daemon — so the one thing a machine must never do is answer for
/// somebody's agents with no visible sign that it is. The tray is that sign,
/// and it carries the stop.
#[cfg(desktop)]
fn build_tray(
    app: &tauri::AppHandle,
    state: std::sync::Arc<ipc::NativeState>,
    chord: Option<&hotkey::Chord>,
) -> tauri::Result<tauri::menu::MenuItem<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::TrayIconBuilder;

    let status = MenuItem::with_id(
        app,
        "status",
        state.supervisor.lock().expect("supervisor").state().label(),
        false,
        None::<&str>,
    )?;
    // Stop is always enabled, and always first. A person reaching for the tray
    // in a hurry is reaching for this. Its label names the global chord when
    // one was registered, because the fastest path to a stop is worth teaching
    // at the moment somebody is already looking for it.
    let stop_label = match chord {
        Some(chord) => format!("Stop the runner   {}", chord.accelerator()),
        None => "Stop the runner".to_string(),
    };
    let stop = MenuItem::with_id(app, "stop", stop_label, true, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open Lepidy", true, None::<&str>)?;
    // Present and disabled until an update has actually been found, so the tray
    // reads the same whether or not this build has an updater at all. An item
    // that appeared and disappeared would be a thing people learn to distrust.
    let update = MenuItem::with_id(app, "update", "No update waiting", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &status,
            &PredefinedMenuItem::separator(app)?,
            &stop,
            &open,
            &update,
            &quit,
        ],
    )?;

    let handle = app.clone();
    let waiting = update.clone();
    TrayIconBuilder::with_id("lepidy")
        .tooltip("Lepidy")
        .menu(&menu)
        .on_menu_event(move |_app, event| match event.id().as_ref() {
            "stop" => {
                // Straight to the supervisor, with no confirmation in the way:
                // a stop that can be refused is a stop that gets skipped at the
                // moment it is needed.
                let stopped = state.supervisor.lock().expect("supervisor").stop();
                let _ = status.set_text(stopped.label());
            }
            "open" => {
                if let Some(window) = tauri::Manager::get_webview_window(&handle, "main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "update" => {
                // The order is the point. An update swaps out the process
                // supervising a harness that may be holding injected
                // credentials, so the runner stops first — every time, before
                // a byte is downloaded — and the tray says what happened.
                let interrupted =
                    updater::prepare_to_install(&mut state.supervisor.lock().expect("supervisor"));
                let _ = status.set_text(format!(
                    "Updating — {}",
                    if interrupted.is_running() {
                        "runner stopped first"
                    } else {
                        "nothing was running"
                    },
                ));
                install_pending_update(&handle);
            }
            "quit" => handle.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(waiting)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The one origin this shell trusts, resolved once at startup. A shell that
    // decided this per navigation would be a shell an agent-authored link could
    // argue with.
    let origin = origin::TrustedOrigin::parse(&workspace_origin())
        .expect("LEPIDY_ORIGIN must be an https origin, or loopback for development");
    let state = std::sync::Arc::new(ipc::NativeState {
        origin,
        supervisor: std::sync::Mutex::new(supervisor::RunnerSupervisor::new(
            agentd_path(),
            std::env::var_os("LEPIDY_HOME").map(std::path::PathBuf::from),
        )),
        ledger: std::sync::Mutex::new(verification::VerificationLedger::new()),
        watch: std::sync::Mutex::new(offline::LoadWatch::new()),
    });

    // The kill-switch chord, chosen on this machine and never by a page. A
    // mistyped override is fatal here rather than quietly replaced by the
    // default: a person who believes they configured a kill switch and got a
    // different key would find out at the worst possible moment.
    let chord = hotkey::Chord::from_environment(std::env::var(hotkey::CHORD_ENV).ok().as_deref())
        .unwrap_or_else(|error| panic!("{}: {error}", hotkey::CHORD_ENV));

    let mut builder = tauri::Builder::default();

    // The global shortcut. Its handler goes straight to the supervisor for
    // exactly the reason the tray's does: a stop that can be refused is a stop
    // that gets skipped at the moment it is needed.
    #[cfg(desktop)]
    {
        let stop_state = std::sync::Arc::clone(&state);
        builder = builder.plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |_app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        let stopped = stop_state.supervisor.lock().expect("supervisor").stop();
                        eprintln!("lepidy: kill switch pressed — {}", stopped.label());
                    }
                })
                .build(),
        );
    }

    // No key, no updater. A build that was given no public key at compile time
    // has no update mechanism at all, rather than one that trusts whatever
    // answers the endpoint.
    #[cfg(desktop)]
    if updater::is_configured() {
        builder = builder.plugin(
            tauri_plugin_updater::Builder::new()
                .pubkey(updater::PUBKEY.expect("a configured build has a key"))
                .build(),
        );
    }

    builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(std::sync::Arc::clone(&state))
        // The whole native surface. Seven commands, listed here so the list is
        // readable in one sitting: adding one is a deliberate act, not
        // something that happens by writing a function somewhere.
        .invoke_handler(tauri::generate_handler![
            runner_status,
            runner_stop,
            runner_start,
            local_verify,
            platform_name,
            notify,
            set_badge
        ])
        .setup(move |app| {
            grant_workspace_capability(app.handle(), &state.origin)?;
            build_main_window(app.handle(), std::sync::Arc::clone(&state))?;

            #[cfg(desktop)]
            let registered = register_kill_switch(app.handle(), &chord);
            #[cfg(not(desktop))]
            let registered: Option<hotkey::Chord> = None;

            #[cfg(desktop)]
            {
                let waiting = build_tray(
                    app.handle(),
                    std::sync::Arc::clone(&state),
                    registered.as_ref(),
                )?;
                if updater::is_configured() {
                    watch_for_updates(app.handle(), waiting);
                }
            }

            #[cfg(desktop)]
            listen_for_deep_links(app.handle(), std::sync::Arc::clone(&state));

            watch_for_an_unreachable_workspace(app.handle(), std::sync::Arc::clone(&state));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Lepidy");
}

/// Where this shell points.
///
/// Loopback in a debug build so `next dev` works; otherwise it must be given,
/// because a default production origin baked into a binary is a default nobody
/// notices is wrong.
fn workspace_origin() -> String {
    if let Ok(configured) = std::env::var("LEPIDY_ORIGIN") {
        return configured;
    }
    #[cfg(debug_assertions)]
    return "http://localhost:3000".to_string();
    #[cfg(not(debug_assertions))]
    panic!("LEPIDY_ORIGIN must be set for a release build");
}

/// The daemon this shell supervises. Beside the shell by default, so a person
/// who installed Lepidy has it, and overridable for a developer running one
/// from a build directory.
fn agentd_path() -> std::path::PathBuf {
    if let Some(configured) = std::env::var_os("LEPIDY_AGENTD") {
        return std::path::PathBuf::from(configured);
    }
    let name = if cfg!(windows) {
        "lepidy-agentd.exe"
    } else {
        "lepidy-agentd"
    };
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|parent| parent.join(name)))
        .unwrap_or_else(|| std::path::PathBuf::from(name))
}

/* -------------------------------------------------------------------------- */
/* Deep links, the kill switch and the offline fallback (P01a)                  */
/* -------------------------------------------------------------------------- */

/// Register the one global chord, and say so either way.
///
/// Returns the chord when the operating system gave it up, so the tray can name
/// it — and `None` when it did not, because a kill switch that is silently not
/// registered is a kill switch that does not exist and the moment a person
/// discovers that is the moment they needed it.
#[cfg(desktop)]
fn register_kill_switch(app: &tauri::AppHandle, chord: &hotkey::Chord) -> Option<hotkey::Chord> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    match app.global_shortcut().register(chord.accelerator()) {
        Ok(()) => {
            eprintln!("lepidy: {}", chord.describe());
            Some(chord.clone())
        }
        Err(error) => {
            eprintln!(
                "lepidy: {}",
                hotkey::registration_failed(chord, &error.to_string())
            );
            None
        }
    }
}

/// Listen for `lepidy://` links handed over by the operating system.
#[cfg(desktop)]
fn listen_for_deep_links(app: &tauri::AppHandle, state: std::sync::Arc<ipc::NativeState>) {
    use tauri_plugin_deep_link::DeepLinkExt;

    // Windows and Linux need the scheme claimed at runtime for a development
    // build; an installed build has it from the installer. A failure here is
    // reported and survivable: no deep link works, and everything else does.
    #[cfg(any(windows, target_os = "linux"))]
    if let Err(error) = app.deep_link().register(deeplink::SCHEME) {
        eprintln!(
            "lepidy: could not claim the {}: scheme ({error})",
            deeplink::SCHEME
        );
    }

    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            open_deep_link(&handle, &state, url.as_str());
        }
    });
}

/// Open a `lepidy://` link, or refuse it out loud.
///
/// The address is built here, from the trusted origin and a validated
/// destination's path. Nothing that arrived in the link is navigated to, which
/// is what makes a registered URL scheme safe to have: the operating system
/// hands this process input from anywhere, without asking anybody.
fn open_deep_link(app: &tauri::AppHandle, state: &ipc::NativeState, link: &str) {
    let destination = match deeplink::parse(link) {
        Ok(destination) => destination,
        Err(error) => {
            eprintln!("lepidy: refused to open {link} ({error})");
            return;
        }
    };
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let target = format!("{}{}", state.origin.as_str(), destination.path());
    match target.parse::<tauri::Url>() {
        // `on_navigation` checks this again. Deliberately: the check that makes
        // the window safe should not depend on every caller having been careful.
        Ok(url) => {
            let _ = window.navigate(url);
        }
        Err(error) => eprintln!("lepidy: could not open {target} ({error})"),
    }
    let _ = window.show();
    let _ = window.set_focus();
}

/// Show the bundled fallback once the workspace has stopped answering, then
/// keep trying.
///
/// A thread rather than an alarm because it must keep running while the window
/// is showing a page that cannot ask for anything: the fallback document is not
/// the trusted origin, so it has no native commands, and the retry has to come
/// from this side.
fn watch_for_an_unreachable_workspace(
    app: &tauri::AppHandle,
    state: std::sync::Arc<ipc::NativeState>,
) {
    let handle = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(1_000));
        let attempts = {
            let mut watch = state.watch.lock().expect("watch");
            if !watch.timed_out(verification::now_ms()) {
                continue;
            }
            watch.gave_up();
            watch.attempts()
        };
        show_fallback(&handle, &state);
        std::thread::sleep(std::time::Duration::from_millis(offline::retry_delay_ms(
            attempts,
        )));
        if let Some(window) = handle.get_webview_window("main") {
            if let Ok(url) = workspace_home(&state.origin).parse::<tauri::Url>() {
                let _ = window.navigate(url);
            }
        }
    });
}

/// Where the window lands: the workspace's Home, never the bare origin, which
/// is the public marketing site. Shared with `lepidy://home` so the two cannot
/// drift apart.
fn workspace_home(origin: &origin::TrustedOrigin) -> String {
    format!("{}{}", origin.as_str(), deeplink::Destination::Home.path())
}

/// Put the window on the bundled document, carrying the true local state.
fn show_fallback(app: &tauri::AppHandle, state: &ipc::NativeState) {
    let runner = state.supervisor.lock().expect("supervisor").state();
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    // The document is bundled and static; what it says about this machine is
    // written in by `on_page_load` once it has loaded, because the one thing
    // worse than a window that cannot reach the workspace is a window that
    // tells somebody their agents are stopped when they are not.
    if let Ok(url) = offline::fallback_url().parse::<tauri::Url>() {
        let _ = window.navigate(url);
    }
    #[cfg(desktop)]
    if let Some(tray) = app.tray_by_id("lepidy") {
        let _ = tray.set_tooltip(Some(offline::fallback_tooltip(runner)));
    }
}

/// Put the unread count where the operating system shows one.
///
/// Three surfaces, because no single one of them exists everywhere: the dock
/// badge on macOS and Linux, the tray tooltip on all three, and nothing on the
/// Windows taskbar, whose badge is an overlay icon this shell does not draw.
fn apply_badge(app: &tauri::AppHandle, unread: u64, label: Option<&str>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_badge_count(presence::badge_count(unread));
        #[cfg(target_os = "macos")]
        let _ = window.set_badge_label(label.map(str::to_string));
    }
    #[cfg(desktop)]
    if let Some(tray) = app.tray_by_id("lepidy") {
        let tooltip = match label {
            Some(label) => format!("Lepidy — {label} unread"),
            None => "Lepidy".to_string(),
        };
        let _ = tray.set_tooltip(Some(tooltip));
    }
    let _ = label;
}

/* -------------------------------------------------------------------------- */
/* Replacing this application (P01b)                                           */
/* -------------------------------------------------------------------------- */

/// The update that has been found and not yet installed.
///
/// One slot, module-private, and never reachable from a page: there is no
/// command that reads it, sets it or acts on it. Updating is something the
/// person at the machine chooses from the tray, and a page that could cause an
/// update could cause a restart of the process supervising somebody's agents.
#[cfg(desktop)]
fn pending_update() -> &'static std::sync::Mutex<Option<tauri_plugin_updater::Update>> {
    static PENDING: std::sync::OnceLock<std::sync::Mutex<Option<tauri_plugin_updater::Update>>> =
        std::sync::OnceLock::new();
    PENDING.get_or_init(|| std::sync::Mutex::new(None))
}

/// Ask, on a schedule, whether there is a newer Lepidy.
///
/// Not at startup — see `updater::FIRST_CHECK_DELAY_MS` — and not often. A
/// failed check is reported and forgotten: the machine tries again in six
/// hours, and an update check that could stop the application from working
/// would be a worse bargain than a stale version.
#[cfg(desktop)]
fn watch_for_updates(app: &tauri::AppHandle, waiting: tauri::menu::MenuItem<tauri::Wry>) {
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(
            updater::FIRST_CHECK_DELAY_MS,
        ));
        loop {
            check_for_an_update(&handle, &waiting);
            std::thread::sleep(std::time::Duration::from_millis(updater::CHECK_INTERVAL_MS));
        }
    });
}

#[cfg(desktop)]
fn check_for_an_update(app: &tauri::AppHandle, waiting: &tauri::menu::MenuItem<tauri::Wry>) {
    use tauri_plugin_updater::UpdaterExt;

    let found = tauri::async_runtime::block_on(async {
        match app.updater() {
            Ok(updater) => updater.check().await,
            Err(error) => Err(error),
        }
    });
    match found {
        Ok(Some(update)) => {
            let version = update.version.clone();
            *pending_update().lock().expect("pending update") = Some(update);
            // The label carries the consequence, because a person supervising
            // agents needs it before they choose the item, not after.
            let _ = waiting.set_text(updater::ready_label(&version));
            let _ = waiting.set_enabled(true);
        }
        Ok(None) => {}
        Err(error) => eprintln!("lepidy: could not check for an update ({error})"),
    }
}

/// Download and install the update the tray is offering.
///
/// The runner has already been stopped by the tray handler, through
/// `updater::prepare_to_install`, before this is reached. That order is not an
/// implementation detail: an update swaps out the process supervising a harness
/// that may be holding injected credentials, and stopping afterwards would be
/// stopping nothing, because this process is already gone.
#[cfg(desktop)]
fn install_pending_update(app: &tauri::AppHandle) {
    let Some(update) = pending_update().lock().expect("pending update").take() else {
        return;
    };
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        match update.download_and_install(|_, _| {}, || {}).await {
            Ok(()) => handle.restart(),
            Err(error) => eprintln!("lepidy: the update did not install ({error})"),
        }
    });
}

/* -------------------------------------------------------------------------- */
/* The native command surface (R03)                                            */
/* -------------------------------------------------------------------------- */

/// The origin a command actually came from.
///
/// Read from the webview itself, never from the message. A caller that could
/// name its own origin would not be being checked at all — which is the whole
/// difference between a boundary and a comment.
fn caller_url(webview: &tauri::Webview) -> String {
    webview.url().map(|url| url.to_string()).unwrap_or_default()
}

type NativeHandle<'a> = tauri::State<'a, std::sync::Arc<ipc::NativeState>>;

#[tauri::command]
fn runner_status(webview: tauri::Webview, state: NativeHandle<'_>) -> Result<String, String> {
    ipc::runner_status(&state, &caller_url(&webview))
        .map(|status| status.label())
        .map_err(|error| error.to_string())
}

/// Stop, with nothing in the way. See `ipc::runner_stop` for why.
#[tauri::command]
fn runner_stop(webview: tauri::Webview, state: NativeHandle<'_>) -> Result<String, String> {
    ipc::runner_stop(&state, &caller_url(&webview))
        .map(|status| status.label())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn runner_start(webview: tauri::Webview, state: NativeHandle<'_>) -> Result<String, String> {
    ipc::runner_start(&state, &caller_url(&webview), verification::now_ms())
        .map(|status| status.label())
        .map_err(|error| error.to_string())
}

/// Ask the operating system to confirm the person, for one named action.
///
/// The action is chosen from a fixed list rather than taken as free text: a
/// page that could compose its own prompt could describe a harmless action and
/// have a confirmation recorded against a different one.
#[tauri::command]
fn local_verify(
    webview: tauri::Webview,
    state: NativeHandle<'_>,
    action: String,
    subject: Option<String>,
) -> Result<(), String> {
    let subject = subject.unwrap_or_default();
    let action = match action.as_str() {
        "start_runner" => verification::LocalAction::StartRunner,
        "edit_preset" => verification::LocalAction::EditPreset { preset_id: subject },
        "loosen_posture" => verification::LocalAction::LoosenPosture { preset_id: subject },
        _ => return Err("that is not something this machine can be asked to confirm".to_string()),
    };
    ipc::local_verify(
        &state,
        &caller_url(&webview),
        action,
        verification::now_ms(),
    )
    .map_err(|error| error.to_string())
}

/// Show one native notification, and say where clicking it should lead.
///
/// The path that comes back is on this workspace by construction: it was built
/// from a destination the deep-link parser accepted, and that parser is the
/// same one the operating system's links go through. So the page navigates
/// itself, and no URL it composed ever decided anything.
#[tauri::command]
fn notify(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: NativeHandle<'_>,
    title: String,
    body: String,
    destination: String,
) -> Result<String, String> {
    let notification = ipc::notify(&state, &caller_url(&webview), &title, &body, &destination)
        .map_err(|error| error.to_string())?;
    #[cfg(desktop)]
    {
        use tauri_plugin_notification::NotificationExt;
        app.notification()
            .builder()
            .title(notification.title())
            .body(notification.body())
            .show()
            .map_err(|error| error.to_string())?;
    }
    let _ = &app;
    Ok(notification.destination().path())
}

/// Set the unread badge. A count, never text — see `presence::badge_label`.
#[tauri::command]
fn set_badge(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: NativeHandle<'_>,
    unread: u64,
) -> Result<(), String> {
    let label =
        ipc::set_badge(&state, &caller_url(&webview), unread).map_err(|error| error.to_string())?;
    apply_badge(&app, unread, label.as_deref());
    Ok(())
}

#[tauri::command]
fn platform_name(webview: tauri::Webview, state: NativeHandle<'_>) -> Result<&'static str, String> {
    ipc::require_trusted_caller(&state, &caller_url(&webview))
        .map_err(|error| error.to_string())?;
    Ok(desktop_platform())
}

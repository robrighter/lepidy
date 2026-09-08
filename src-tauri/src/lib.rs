use tauri::{WebviewUrl, WebviewWindowBuilder};

pub mod ipc;
pub mod local_store;
pub mod origin;
pub mod supervisor;
pub mod verification;

fn desktop_platform() -> &'static str {
    #[cfg(target_os = "macos")]
    return "macos";
    #[cfg(target_os = "windows")]
    return "windows";
    #[cfg(target_os = "linux")]
    return "linux";
}

fn build_main_window(app: &tauri::AppHandle, origin: origin::TrustedOrigin) -> tauri::Result<()> {
    #[cfg(debug_assertions)]
    let url = WebviewUrl::External(
        "http://localhost:3000"
            .parse()
            .expect("valid development URL"),
    );
    #[cfg(not(debug_assertions))]
    let url = WebviewUrl::App("index.html".into());

    let initialization_script = format!(
        "(() => {{ const apply = () => document.documentElement.dataset.desktopPlatform = '{}'; if (document.documentElement) apply(); else addEventListener('DOMContentLoaded', apply, {{ once: true }}); }})();",
        desktop_platform()
    );

    let mut builder = WebviewWindowBuilder::new(app, "main", url)
        // The boundary, enforced rather than described. Messages in this
        // product are written by agents and by strangers, so a link that
        // navigates this window somewhere else is not hypothetical — and a
        // window that has navigated elsewhere is a window whose page can call
        // every native command below.
        .on_navigation(move |url| {
            let allowed = origin.allows(url.as_str());
            if !allowed {
                eprintln!("lepidy: refused to navigate the desktop window to {url}");
            }
            allowed
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
) -> tauri::Result<()> {
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
    // in a hurry is reaching for this.
    let stop = MenuItem::with_id(app, "stop", "Stop the runner", true, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open Lepidy", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &status,
            &PredefinedMenuItem::separator(app)?,
            &stop,
            &open,
            &quit,
        ],
    )?;

    let handle = app.clone();
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
            "quit" => handle.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
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
    });

    tauri::Builder::default()
        .manage(std::sync::Arc::clone(&state))
        // The whole native surface. Five commands, listed here so the list is
        // readable in one sitting: adding one is a deliberate act, not
        // something that happens by writing a function somewhere.
        .invoke_handler(tauri::generate_handler![
            runner_status,
            runner_stop,
            runner_start,
            local_verify,
            platform_name
        ])
        .setup(move |app| {
            build_main_window(app.handle(), state.origin.clone())?;
            #[cfg(desktop)]
            build_tray(app.handle(), std::sync::Arc::clone(&state))?;
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

#[tauri::command]
fn platform_name(webview: tauri::Webview, state: NativeHandle<'_>) -> Result<&'static str, String> {
    ipc::require_trusted_caller(&state, &caller_url(&webview))
        .map_err(|error| error.to_string())?;
    Ok(desktop_platform())
}

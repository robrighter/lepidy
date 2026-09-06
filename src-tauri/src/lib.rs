use tauri::{WebviewUrl, WebviewWindowBuilder};

pub mod local_store;

fn desktop_platform() -> &'static str {
    #[cfg(target_os = "macos")]
    return "macos";
    #[cfg(target_os = "windows")]
    return "windows";
    #[cfg(target_os = "linux")]
    return "linux";
}

fn build_main_window(app: &tauri::AppHandle) -> tauri::Result<()> {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            build_main_window(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Lepidy");
}

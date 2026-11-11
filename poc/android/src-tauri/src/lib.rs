//! Android background probe: does a Tauri app keep receiving messages when it is in the background?

use probe_core::{Probe, Status};
use tauri::Manager;

/// The laptop on the home network, where `npm run sender` runs the relay.
const DEFAULT_RELAY: &str = "192.168.0.10:7400";
const MAX_NOTE_LENGTH: usize = 200;

#[tauri::command]
fn status(probe: tauri::State<'_, Probe>) -> Status {
    probe.status()
}

#[tauri::command]
fn set_relay(probe: tauri::State<'_, Probe>, relay: String) -> Result<(), String> {
    if relay.len() > 260 || !relay.contains(':') {
        return Err("expected host:port".into());
    }
    probe.set_relay(relay);
    Ok(())
}

#[tauri::command]
fn mark(probe: tauri::State<'_, Probe>, note: String) {
    probe.mark(note.chars().take(MAX_NOTE_LENGTH).collect());
}

#[tauri::command]
fn set_foreground_service(
    app: tauri::AppHandle,
    probe: tauri::State<'_, Probe>,
    enabled: bool,
) -> Result<(), String> {
    service::set_enabled(&app, enabled)?;
    probe.mark(format!("foreground service {}", if enabled { "on" } else { "off" }));
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(service::init())
        .setup(|app| {
            let log_path = app.path().app_data_dir()?.join("probe.jsonl");
            if let Some(dir) = log_path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let probe = Probe::new(DEFAULT_RELAY.into(), log_path);
            probe.start();
            app.manage(probe);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![status, set_relay, mark, set_foreground_service])
        .run(tauri::generate_context!())
        .expect("error while running the probe");
}

/// The Android foreground service ("FHP Probe synchroniseert…") lives in Kotlin, see
/// `gen/android/app/src/main/java/org/freehouseholdplanner/probe/`.
mod service {
    use tauri::plugin::{Builder, TauriPlugin};
    use tauri::{AppHandle, Runtime};

    #[cfg(target_os = "android")]
    struct ServiceHandle<R: Runtime>(tauri::plugin::PluginHandle<R>);

    pub fn init<R: Runtime>() -> TauriPlugin<R> {
        Builder::new("probe-service")
            .setup(|_app, _api| {
                #[cfg(target_os = "android")]
                {
                    use tauri::Manager;
                    let handle = _api
                        .register_android_plugin("org.freehouseholdplanner.probe", "ServicePlugin")?;
                    _app.manage(ServiceHandle(handle));
                }
                Ok(())
            })
            .build()
    }

    #[cfg(target_os = "android")]
    pub fn set_enabled<R: Runtime>(app: &AppHandle<R>, enabled: bool) -> Result<(), String> {
        use tauri::Manager;
        let handle = app.state::<ServiceHandle<R>>();
        let command = if enabled { "start" } else { "stop" };
        handle
            .0
            .run_mobile_plugin::<serde_json::Value>(command, ())
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    #[cfg(not(target_os = "android"))]
    pub fn set_enabled<R: Runtime>(_app: &AppHandle<R>, _enabled: bool) -> Result<(), String> {
        Err("a foreground service only exists on Android".into())
    }
}

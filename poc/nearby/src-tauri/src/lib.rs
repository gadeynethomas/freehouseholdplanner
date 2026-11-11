//! Nearby sync PoC (K12): two phones sync over Bluetooth LE and Wi-Fi Aware without a shared network.
//!
//! The radio work uses Android APIs, so it lives in Kotlin (`NearbyPlugin` and friends under
//! `gen/android/app/src/main/java/org/freehouseholdplanner/nearby/`). Rust only forwards the UI's
//! calls to that plugin.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Runtime};

/// Plugin methods the UI may call; anything else is refused before it reaches Kotlin.
const COMMANDS: &[&str] = &[
    "status",
    "edit",
    "setService",
    "setBackgroundScan",
    "setAware",
    "clearLog",
    "askPermissions",
];

#[tauri::command]
fn nearby(
    app: AppHandle,
    command: String,
    args: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    if !COMMANDS.contains(&command.as_str()) {
        return Err(format!("unknown command {command}"));
    }
    plugin::call(&app, &command, args.unwrap_or(serde_json::Value::Null))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(plugin::init())
        .invoke_handler(tauri::generate_handler![nearby])
        .run(tauri::generate_context!())
        .expect("error while running the nearby PoC");
}

mod plugin {
    use super::*;

    #[cfg(target_os = "android")]
    struct Handle<R: Runtime>(tauri::plugin::PluginHandle<R>);

    pub fn init<R: Runtime>() -> TauriPlugin<R> {
        Builder::new("nearby")
            .setup(|_app, _api| {
                #[cfg(target_os = "android")]
                {
                    use tauri::Manager;
                    let handle = _api.register_android_plugin(
                        "org.freehouseholdplanner.nearby",
                        "NearbyPlugin",
                    )?;
                    _app.manage(Handle(handle));
                }
                Ok(())
            })
            .build()
    }

    #[cfg(target_os = "android")]
    pub fn call<R: Runtime>(
        app: &AppHandle<R>,
        command: &str,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        use tauri::Manager;
        app.state::<Handle<R>>()
            .0
            .run_mobile_plugin::<serde_json::Value>(command, args)
            .map_err(|error| error.to_string())
    }

    #[cfg(not(target_os = "android"))]
    pub fn call<R: Runtime>(
        _app: &AppHandle<R>,
        _command: &str,
        _args: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        Err("Bluetooth LE and Wi-Fi Aware sync only exist on Android in this PoC".into())
    }
}

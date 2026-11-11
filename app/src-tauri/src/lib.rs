//! The Tauri shell: maps commands from the UI onto the core (`docs/TECHNICAL.md`, section 2).

#[tauri::command]
fn about() -> fhp_core::About {
    fhp_core::about()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![about])
        .run(tauri::generate_context!())
        .expect("the app failed to start");
}

#[cfg(test)]
mod tests {
    /// Tauri takes the app version (and the Android versionCode) from tauri.conf.json, the core
    /// reports the workspace version: they must never differ.
    #[test]
    fn tauri_config_has_the_workspace_version() {
        let config = include_str!("../tauri.conf.json");
        let expected = format!("\"version\": \"{}\"", env!("CARGO_PKG_VERSION"));
        assert!(config.contains(&expected), "tauri.conf.json must contain {expected}");
    }
}

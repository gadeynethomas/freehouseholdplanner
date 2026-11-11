//! The core of freehouseholdplanner: the household data, its business rules, storage and sync
//! (`docs/TECHNICAL.md`, section 2). It has no dependency on Tauri, so the app and the headless
//! always-on device (K6) share it, and it is tested with plain `cargo test`.

use serde::Serialize;

/// What the UI shows about the running core.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct About {
    pub version: &'static str,
}

pub fn about() -> About {
    About {
        version: env!("CARGO_PKG_VERSION"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn about_reports_the_workspace_version() {
        assert_eq!(about().version, env!("CARGO_PKG_VERSION"));
        assert!(!about().version.is_empty());
    }
}

//! The core of freehouseholdplanner: the household data, its business rules, storage and sync
//! (`docs/TECHNICAL.md`, section 2). It has no dependency on Tauri, so the app and the headless
//! always-on device (K6) share it, and it is tested with plain `cargo test`.

mod error;
mod ids;
mod model;
mod storage;
mod text;

pub use error::{Error, Result};
pub use ids::{DeviceId, HouseholdId, MemberId, RoomId, actor_for};
pub use model::{
    Device, Founder, Household, HouseholdInfo, Member, NewHousehold, Role, Room, SCHEMA_VERSION,
    STATIC_KEY_LEN,
};
pub use storage::{ChunkStats, StorageKey, Store};
pub use text::MAX_NAME_CHARS;

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

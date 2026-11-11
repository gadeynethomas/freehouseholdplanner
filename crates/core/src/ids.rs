//! Random ids for households, members, devices and rooms (`docs/TECHNICAL.md`, section 3).

use std::fmt;
use std::str::FromStr;

use automerge::ActorId;
use serde::{Serialize, Serializer};
use uuid::Uuid;

use crate::error::{Error, Result};

macro_rules! id_type {
    ($(#[$doc:meta])* $name:ident, $what:literal) => {
        $(#[$doc])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub struct $name(Uuid);

        /// As text, the same form the document stores.
        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
                serializer.collect_str(self)
            }
        }

        impl $name {
            /// A new random id. Never derived from content, so two devices creating "the same"
            /// item get two items.
            pub fn random() -> Self {
                Self(Uuid::new_v4())
            }

            pub fn as_bytes(&self) -> &[u8; 16] {
                self.0.as_bytes()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                self.0.hyphenated().fmt(f)
            }
        }

        impl FromStr for $name {
            type Err = Error;

            fn from_str(text: &str) -> Result<Self> {
                Uuid::try_parse(text).map(Self).map_err(|_| Error::Corrupt(concat!("bad ", $what, " id")))
            }
        }
    };
}

id_type!(
    /// One household: one document, one database, one encrypted unit (A4).
    HouseholdId,
    "household"
);
id_type!(
    /// A person in the household (A1).
    MemberId,
    "member"
);
id_type!(
    /// A phone or PC running the app (glossary: apparaat).
    DeviceId,
    "device"
);
id_type!(
    /// A part of the house (R1).
    RoomId,
    "room"
);

/// The Automerge actor a device writes under: its device id plus a generation, which goes up when
/// the device rebuilds its document after a purge (K8, `poc/sync`). Every change thus names the
/// device that wrote it.
pub fn actor_for(device: DeviceId, generation: u8) -> ActorId {
    let mut bytes = [0u8; 17];
    bytes[..16].copy_from_slice(device.as_bytes());
    bytes[16] = generation;
    ActorId::from(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_round_trip_through_text() {
        let id = RoomId::random();
        assert_eq!(id.to_string().parse::<RoomId>().unwrap(), id);
    }

    #[test]
    fn random_ids_differ() {
        assert_ne!(MemberId::random(), MemberId::random());
    }

    #[test]
    fn malformed_ids_are_refused() {
        for text in ["", "kitchen", "123", "00000000-0000-0000-0000-00000000000g"] {
            assert!(text.parse::<RoomId>().is_err(), "{text:?} was accepted");
        }
    }

    #[test]
    fn actor_names_device_and_generation() {
        let device = DeviceId::random();
        let actor = actor_for(device, 3);
        assert_eq!(&actor.to_bytes()[..16], device.as_bytes());
        assert_eq!(actor.to_bytes()[16], 3);
        assert_ne!(actor_for(device, 0), actor_for(device, 1));
    }
}

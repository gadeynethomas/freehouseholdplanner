//! The household document (`docs/TECHNICAL.md`, section 3): one Automerge document per household
//! with maps keyed by id. This module covers the household itself, members (A1), devices (K2)
//! and rooms (R1).
//!
//! Everything read from the document may come from another device, so reading never panics:
//! malformed records are skipped instead.

use std::borrow::Cow;

use automerge::transaction::{CommitOptions, Transactable};
use automerge::{AutoCommit, ObjId, ObjType, ROOT, ReadDoc, ScalarValue, Value};
use serde::{Serialize, Serializer};

use crate::error::{Error, Result};
use crate::ids::{DeviceId, HouseholdId, MemberId, RoomId, actor_for};
use crate::text::{check_timezone, clean_name, same_name};

/// The data format this app version writes. Raised when a release adds data that older releases
/// must not edit blindly (K9).
pub const SCHEMA_VERSION: u64 = 1;

/// Length of a device's static X25519 public key (Noise, `docs/TECHNICAL.md` section 6).
pub const STATIC_KEY_LEN: usize = 32;

mod key {
    pub const HOUSEHOLD: &str = "household";
    pub const MEMBERS: &str = "members";
    pub const DEVICES: &str = "devices";
    pub const ROOMS: &str = "rooms";

    pub const ID: &str = "id";
    pub const NAME: &str = "name";
    pub const TIMEZONE: &str = "timezone";
    pub const SCHEMA_VERSION: &str = "schemaVersion";
    pub const MIN_APP_VERSION: &str = "minAppVersion";
    pub const ROLE: &str = "role";
    pub const MEMBER_ID: &str = "memberId";
    pub const STATIC_KEY: &str = "staticKey";
    pub const ADDED_BY: &str = "addedBy";
    pub const ADDED_AT: &str = "addedAt";
    pub const REMOVED_AT: &str = "removedAt";
    pub const CREATED_AT: &str = "createdAt";
    pub const ARCHIVED_AT: &str = "archivedAt";
}

/// What a member may do (A2). Unknown roles from a newer app version are kept as they are (K9).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Role {
    Admin,
    Member,
    Unknown(String),
}

impl Role {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Admin => "admin",
            Self::Member => "member",
            Self::Unknown(other) => other,
        }
    }

    fn parse(text: &str) -> Self {
        match text {
            "admin" => Self::Admin,
            "member" => Self::Member,
            other => Self::Unknown(other.to_owned()),
        }
    }
}

impl Serialize for Role {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HouseholdInfo {
    pub id: HouseholdId,
    pub name: String,
    pub timezone: String,
    pub schema_version: u64,
    pub min_app_version: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub id: MemberId,
    pub name: String,
    pub role: Role,
    pub added_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: DeviceId,
    pub name: String,
    pub member_id: MemberId,
    #[serde(skip)]
    pub static_key: [u8; STATIC_KEY_LEN],
    pub added_by: DeviceId,
    pub added_at: i64,
    pub removed_at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Room {
    pub id: RoomId,
    pub name: String,
    pub created_at: i64,
    pub archived_at: Option<i64>,
}

impl Room {
    pub fn is_active(&self) -> bool {
        self.archived_at.is_none()
    }
}

/// The first device of a new household and the person using it (K1).
pub struct Founder<'a> {
    pub device_id: DeviceId,
    pub device_name: &'a str,
    pub static_key: [u8; STATIC_KEY_LEN],
    pub member_name: &'a str,
}

pub struct NewHousehold<'a> {
    pub name: &'a str,
    pub timezone: &'a str,
    pub founder: Founder<'a>,
}

/// One household's data. Times are UTC milliseconds, passed in by the caller so that the rules
/// stay pure and testable.
pub struct Household {
    doc: AutoCommit,
}

impl Household {
    /// Creates a household on its first device (K1). Only the founder does this: a joining device
    /// starts empty and writes nothing before its first sync (`poc/sync` lesson 1).
    pub fn create(new: NewHousehold<'_>, now: i64) -> Result<Self> {
        let household_name = clean_name(new.name)?;
        check_timezone(new.timezone)?;
        let device_name = clean_name(new.founder.device_name)?;
        let member_name = clean_name(new.founder.member_name)?;
        let device_id = new.founder.device_id;
        let member_id = MemberId::random();

        let mut doc = AutoCommit::new().with_actor(actor_for(device_id, 0));
        let household = doc.put_object(ROOT, key::HOUSEHOLD, ObjType::Map)?;
        doc.put(&household, key::ID, HouseholdId::random().to_string())?;
        doc.put(&household, key::NAME, household_name)?;
        doc.put(&household, key::TIMEZONE, new.timezone)?;
        doc.put(&household, key::SCHEMA_VERSION, SCHEMA_VERSION)?;
        doc.put(&household, key::MIN_APP_VERSION, SCHEMA_VERSION)?;

        let members = doc.put_object(ROOT, key::MEMBERS, ObjType::Map)?;
        let member = doc.put_object(&members, member_id.to_string(), ObjType::Map)?;
        doc.put(&member, key::NAME, member_name)?;
        doc.put(&member, key::ROLE, Role::Admin.as_str())?;
        doc.put(&member, key::ADDED_AT, ScalarValue::Timestamp(now))?;

        let devices = doc.put_object(ROOT, key::DEVICES, ObjType::Map)?;
        let device = doc.put_object(&devices, device_id.to_string(), ObjType::Map)?;
        doc.put(&device, key::NAME, device_name)?;
        doc.put(&device, key::MEMBER_ID, member_id.to_string())?;
        doc.put(&device, key::STATIC_KEY, new.founder.static_key.to_vec())?;
        doc.put(&device, key::ADDED_BY, device_id.to_string())?;
        doc.put(&device, key::ADDED_AT, ScalarValue::Timestamp(now))?;
        doc.put(&device, key::REMOVED_AT, ScalarValue::Null)?;

        doc.put_object(ROOT, key::ROOMS, ObjType::Map)?;

        let mut household = Self { doc };
        household.commit(now);
        Ok(household)
    }

    /// Wraps a document loaded from storage. It must at least name its household.
    pub(crate) fn from_document(doc: AutoCommit) -> Result<Self> {
        let household = Self { doc };
        household.info()?;
        Ok(household)
    }

    pub(crate) fn document(&mut self) -> &mut AutoCommit {
        &mut self.doc
    }

    pub fn info(&self) -> Result<HouseholdInfo> {
        let household = self
            .map(&ROOT, key::HOUSEHOLD)
            .ok_or(Error::Corrupt("household record missing"))?;
        let id = self
            .str_field(&household, key::ID)
            .and_then(|id| id.parse().ok())
            .ok_or(Error::Corrupt("household id"))?;
        Ok(HouseholdInfo {
            id,
            name: self.str_field(&household, key::NAME).unwrap_or_default(),
            timezone: self
                .str_field(&household, key::TIMEZONE)
                .unwrap_or_else(|| "UTC".into()),
            schema_version: self
                .uint_field(&household, key::SCHEMA_VERSION)
                .unwrap_or(0),
            min_app_version: self
                .uint_field(&household, key::MIN_APP_VERSION)
                .unwrap_or(0),
        })
    }

    pub fn id(&self) -> Result<HouseholdId> {
        Ok(self.info()?.id)
    }

    /// False when a newer app version requires itself for editing: this device turns read-only
    /// and asks to update, but keeps syncing (K9).
    pub fn can_edit(&self) -> bool {
        self.info()
            .is_ok_and(|info| info.min_app_version <= SCHEMA_VERSION)
    }

    /// Members sorted by name.
    pub fn members(&self) -> Vec<Member> {
        let mut members = self.records(key::MEMBERS, |id, record| {
            Some(Member {
                id: id.parse().ok()?,
                name: self.str_field(record, key::NAME)?,
                role: Role::parse(&self.str_field(record, key::ROLE)?),
                added_at: self.time_field(record, key::ADDED_AT)?,
            })
        });
        members.sort_by_key(|member| member.name.to_lowercase());
        members
    }

    /// Paired devices, including removed ones (their record stays for K8), sorted by name.
    pub fn devices(&self) -> Vec<Device> {
        let mut devices = self.records(key::DEVICES, |id, record| {
            Some(Device {
                id: id.parse().ok()?,
                name: self.str_field(record, key::NAME)?,
                member_id: self.str_field(record, key::MEMBER_ID)?.parse().ok()?,
                static_key: self.bytes_field(record, key::STATIC_KEY)?.try_into().ok()?,
                added_by: self.str_field(record, key::ADDED_BY)?.parse().ok()?,
                added_at: self.time_field(record, key::ADDED_AT)?,
                removed_at: self.time_field(record, key::REMOVED_AT),
            })
        });
        devices.sort_by_key(|device| device.name.to_lowercase());
        devices
    }

    /// Rooms, archived ones included, sorted by name.
    pub fn rooms(&self) -> Vec<Room> {
        let mut rooms = self.records(key::ROOMS, |id, record| {
            Some(Room {
                id: id.parse().ok()?,
                name: self.str_field(record, key::NAME)?,
                created_at: self.time_field(record, key::CREATED_AT)?,
                archived_at: self.time_field(record, key::ARCHIVED_AT),
            })
        });
        rooms.sort_by_key(|room| room.name.to_lowercase());
        rooms
    }

    /// Adds a member (A1). Pairing (K2) links a device to it.
    pub fn add_member(&mut self, name: &str, role: Role, now: i64) -> Result<MemberId> {
        self.ensure_editable()?;
        let name = clean_name(name)?;
        let members = self
            .map(&ROOT, key::MEMBERS)
            .ok_or(Error::Corrupt("members missing"))?;
        let id = MemberId::random();
        let member = self
            .doc
            .put_object(&members, id.to_string(), ObjType::Map)?;
        self.doc.put(&member, key::NAME, name)?;
        self.doc.put(&member, key::ROLE, role.as_str())?;
        self.doc
            .put(&member, key::ADDED_AT, ScalarValue::Timestamp(now))?;
        self.commit(now);
        Ok(id)
    }

    pub fn rename_member(&mut self, id: MemberId, name: &str, now: i64) -> Result<()> {
        self.ensure_editable()?;
        let name = clean_name(name)?;
        let member = self
            .record(key::MEMBERS, &id.to_string())
            .ok_or(Error::NotFound("member"))?;
        self.doc.put(&member, key::NAME, name)?;
        self.commit(now);
        Ok(())
    }

    /// Adds a room (R1). Names are unique among active rooms, ignoring case.
    pub fn add_room(&mut self, name: &str, now: i64) -> Result<RoomId> {
        self.ensure_editable()?;
        let name = clean_name(name)?;
        self.ensure_room_name_free(&name, None)?;
        let rooms = self
            .map(&ROOT, key::ROOMS)
            .ok_or(Error::Corrupt("rooms missing"))?;
        let id = RoomId::random();
        let room = self.doc.put_object(&rooms, id.to_string(), ObjType::Map)?;
        self.doc.put(&room, key::NAME, name)?;
        self.doc
            .put(&room, key::CREATED_AT, ScalarValue::Timestamp(now))?;
        self.doc.put(&room, key::ARCHIVED_AT, ScalarValue::Null)?;
        self.commit(now);
        Ok(id)
    }

    pub fn rename_room(&mut self, id: RoomId, name: &str, now: i64) -> Result<()> {
        self.ensure_editable()?;
        let name = clean_name(name)?;
        let room = self
            .record(key::ROOMS, &id.to_string())
            .ok_or(Error::NotFound("room"))?;
        self.ensure_room_name_free(&name, Some(id))?;
        self.doc.put(&room, key::NAME, name)?;
        self.commit(now);
        Ok(())
    }

    /// Archives a room instead of deleting it: tasks and appliances may still refer to it
    /// (`docs/TECHNICAL.md` section 3).
    pub fn archive_room(&mut self, id: RoomId, now: i64) -> Result<()> {
        self.ensure_editable()?;
        let room = self
            .record(key::ROOMS, &id.to_string())
            .ok_or(Error::NotFound("room"))?;
        self.doc
            .put(&room, key::ARCHIVED_AT, ScalarValue::Timestamp(now))?;
        self.commit(now);
        Ok(())
    }

    fn ensure_editable(&self) -> Result<()> {
        if self.can_edit() {
            Ok(())
        } else {
            Err(Error::UpdateRequired)
        }
    }

    fn ensure_room_name_free(&self, name: &str, except: Option<RoomId>) -> Result<()> {
        let taken = self
            .rooms()
            .iter()
            .any(|room| room.is_active() && Some(room.id) != except && same_name(&room.name, name));
        if taken {
            Err(Error::DuplicateRoomName)
        } else {
            Ok(())
        }
    }

    /// Commits the pending operations as one change, stamped with the time for the history (H6).
    fn commit(&mut self, now: i64) {
        self.doc
            .commit_with(CommitOptions::default().with_time(now.div_euclid(1000)));
    }

    fn map(&self, parent: &ObjId, name: &str) -> Option<ObjId> {
        match self.doc.get(parent, name) {
            Ok(Some((Value::Object(ObjType::Map), id))) => Some(id),
            _ => None,
        }
    }

    fn record(&self, collection: &str, id: &str) -> Option<ObjId> {
        let collection = self.map(&ROOT, collection)?;
        self.map(&collection, id)
    }

    /// Reads every record of a collection, skipping those `read` cannot make sense of.
    fn records<T>(&self, collection: &str, read: impl Fn(&str, &ObjId) -> Option<T>) -> Vec<T> {
        let Some(collection) = self.map(&ROOT, collection) else {
            return Vec::new();
        };
        self.doc
            .keys(&collection)
            .filter_map(|id| {
                let record = self.map(&collection, &id)?;
                read(&id, &record)
            })
            .collect()
    }

    fn scalar(&self, obj: &ObjId, field: &str) -> Option<ScalarValue> {
        match self.doc.get(obj, field) {
            Ok(Some((Value::Scalar(value), _))) => Some(Cow::into_owned(value)),
            _ => None,
        }
    }

    fn str_field(&self, obj: &ObjId, field: &str) -> Option<String> {
        match self.scalar(obj, field)? {
            ScalarValue::Str(text) => Some(text.to_string()),
            _ => None,
        }
    }

    fn uint_field(&self, obj: &ObjId, field: &str) -> Option<u64> {
        match self.scalar(obj, field)? {
            ScalarValue::Uint(value) => Some(value),
            ScalarValue::Int(value) => u64::try_from(value).ok(),
            _ => None,
        }
    }

    fn time_field(&self, obj: &ObjId, field: &str) -> Option<i64> {
        match self.scalar(obj, field)? {
            ScalarValue::Timestamp(ms) | ScalarValue::Int(ms) => Some(ms),
            _ => None,
        }
    }

    fn bytes_field(&self, obj: &ObjId, field: &str) -> Option<Vec<u8>> {
        match self.scalar(obj, field)? {
            ScalarValue::Bytes(bytes) => Some(bytes),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_794_000_000_000;

    fn founder_device() -> DeviceId {
        DeviceId::random()
    }

    fn new_household(device_id: DeviceId) -> Household {
        Household::create(
            NewHousehold {
                name: " Ons huis ",
                timezone: "Europe/Brussels",
                founder: Founder {
                    device_id,
                    device_name: "gsm A",
                    static_key: [7; STATIC_KEY_LEN],
                    member_name: "lid A",
                },
            },
            NOW,
        )
        .unwrap()
    }

    /// A second device with its own copy, as after a sync.
    fn copy_on_other_device(household: &mut Household) -> Household {
        let mut doc = household.doc.fork();
        doc.set_actor(actor_for(DeviceId::random(), 0));
        Household { doc }
    }

    #[test]
    fn a_new_household_has_its_founder_as_admin_and_device() {
        let device = founder_device();
        let household = new_household(device);
        let info = household.info().unwrap();
        assert_eq!(info.name, "Ons huis");
        assert_eq!(info.timezone, "Europe/Brussels");
        assert_eq!(info.schema_version, SCHEMA_VERSION);

        let members = household.members();
        assert_eq!(members.len(), 1);
        assert_eq!(members[0].name, "lid A");
        assert_eq!(members[0].role, Role::Admin);

        let devices = household.devices();
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].id, device);
        assert_eq!(devices[0].member_id, members[0].id);
        assert_eq!(devices[0].static_key, [7; STATIC_KEY_LEN]);
        assert_eq!(devices[0].added_by, device);
        assert_eq!(devices[0].removed_at, None);
        assert!(household.rooms().is_empty());
    }

    #[test]
    fn creating_a_household_validates_its_input() {
        let attempt = |name: &str, timezone: &str, member_name: &str| {
            Household::create(
                NewHousehold {
                    name,
                    timezone,
                    founder: Founder {
                        device_id: DeviceId::random(),
                        device_name: "gsm A",
                        static_key: [0; STATIC_KEY_LEN],
                        member_name,
                    },
                },
                NOW,
            )
        };
        assert!(matches!(
            attempt("", "UTC", "lid A"),
            Err(Error::InvalidName(_))
        ));
        assert!(matches!(
            attempt("Huis", "Brussels time", "lid A"),
            Err(Error::InvalidTimezone)
        ));
        assert!(matches!(
            attempt("Huis", "UTC", " "),
            Err(Error::InvalidName(_))
        ));
    }

    #[test]
    fn every_change_is_written_by_the_device_actor() {
        let device = founder_device();
        let mut household = new_household(device);
        household.add_room("Keuken", NOW).unwrap();
        assert_eq!(household.doc.get_actor(), &actor_for(device, 0));
    }

    #[test]
    fn rooms_can_be_added_renamed_and_archived() {
        let mut household = new_household(founder_device());
        let kitchen = household.add_room(" Keuken ", NOW).unwrap();
        let attic = household.add_room("zolder", NOW + 1).unwrap();
        household.rename_room(attic, "Zolder", NOW + 2).unwrap();

        let names: Vec<_> = household
            .rooms()
            .into_iter()
            .map(|room| room.name)
            .collect();
        assert_eq!(names, ["Keuken", "Zolder"]);

        household.archive_room(kitchen, NOW + 3).unwrap();
        let kitchen = household
            .rooms()
            .into_iter()
            .find(|room| room.id == kitchen)
            .unwrap();
        assert_eq!(kitchen.archived_at, Some(NOW + 3));
        assert!(!kitchen.is_active());
    }

    #[test]
    fn room_names_are_unique_among_active_rooms() {
        let mut household = new_household(founder_device());
        let kitchen = household.add_room("Keuken", NOW).unwrap();
        assert!(matches!(
            household.add_room(" keuken", NOW),
            Err(Error::DuplicateRoomName)
        ));

        let cellar = household.add_room("Kelder", NOW).unwrap();
        assert!(matches!(
            household.rename_room(cellar, "KEUKEN", NOW),
            Err(Error::DuplicateRoomName)
        ));
        household.rename_room(kitchen, "keuken", NOW).unwrap();

        household.archive_room(kitchen, NOW).unwrap();
        household.add_room("Keuken", NOW).unwrap();
    }

    #[test]
    fn unknown_records_are_reported_as_not_found() {
        let mut household = new_household(founder_device());
        let missing = RoomId::random();
        assert!(matches!(
            household.rename_room(missing, "Kelder", NOW),
            Err(Error::NotFound(_))
        ));
        assert!(matches!(
            household.archive_room(missing, NOW),
            Err(Error::NotFound(_))
        ));
        let member = MemberId::random();
        assert!(matches!(
            household.rename_member(member, "x", NOW),
            Err(Error::NotFound(_))
        ));
    }

    #[test]
    fn members_can_be_added_and_renamed() {
        let mut household = new_household(founder_device());
        let member = household.add_member("lid B", Role::Member, NOW).unwrap();
        household.rename_member(member, "lid C", NOW).unwrap();
        let added = household
            .members()
            .into_iter()
            .find(|m| m.id == member)
            .unwrap();
        assert_eq!(added.name, "lid C");
        assert_eq!(added.role, Role::Member);
        assert_eq!(added.added_at, NOW);
    }

    #[test]
    fn concurrent_rooms_from_two_devices_both_survive_a_merge() {
        let mut a = new_household(founder_device());
        let mut b = copy_on_other_device(&mut a);
        a.add_room("Keuken", NOW).unwrap();
        b.add_room("Tuin", NOW).unwrap();
        a.doc.merge(&mut b.doc).unwrap();
        b.doc.merge(&mut a.doc).unwrap();
        assert_eq!(a.rooms(), b.rooms());
        assert_eq!(a.rooms().len(), 2);
    }

    #[test]
    fn concurrent_renames_pick_the_same_winner_everywhere() {
        let mut a = new_household(founder_device());
        let room = a.add_room("Badkamer", NOW).unwrap();
        let mut b = copy_on_other_device(&mut a);
        a.rename_room(room, "Badkamer boven", NOW + 1).unwrap();
        b.rename_room(room, "Badkamer beneden", NOW + 1).unwrap();
        a.doc.merge(&mut b.doc).unwrap();
        b.doc.merge(&mut a.doc).unwrap();
        assert_eq!(
            a.rooms(),
            b.rooms(),
            "K5: one winner, the same on both devices"
        );
    }

    #[test]
    fn a_newer_schema_makes_the_household_read_only() {
        let mut household = new_household(founder_device());
        let record = household.map(&ROOT, key::HOUSEHOLD).unwrap();
        household
            .doc
            .put(&record, key::MIN_APP_VERSION, SCHEMA_VERSION + 1)
            .unwrap();
        assert!(!household.can_edit());
        assert!(matches!(
            household.add_room("Keuken", NOW),
            Err(Error::UpdateRequired)
        ));
        assert_eq!(household.members().len(), 1, "reading still works");
    }

    #[test]
    fn unknown_roles_from_newer_versions_are_kept() {
        let mut household = new_household(founder_device());
        let member = household
            .add_member("lid B", Role::Unknown("guest".into()), NOW)
            .unwrap();
        let read = household
            .members()
            .into_iter()
            .find(|m| m.id == member)
            .unwrap();
        assert_eq!(read.role, Role::Unknown("guest".into()));
    }

    #[test]
    fn malformed_records_are_skipped_not_fatal() {
        let mut household = new_household(founder_device());
        household.add_room("Keuken", NOW).unwrap();
        let rooms = household.map(&ROOT, key::ROOMS).unwrap();
        household.doc.put(&rooms, "not-an-id", "garbage").unwrap();
        let broken = household
            .doc
            .put_object(&rooms, RoomId::random().to_string(), ObjType::Map)
            .unwrap();
        household.doc.put(&broken, key::NAME, 42).unwrap();
        assert_eq!(household.rooms().len(), 1);
    }
}

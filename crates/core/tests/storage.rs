//! Storage against real SQLite files (CLAUDE.md: no mocks for storage).

use std::path::{Path, PathBuf};

use fhp_core::{
    DeviceId, Error, Founder, Household, HouseholdId, NewHousehold, STATIC_KEY_LEN, StorageKey,
    Store, actor_for,
};
use rusqlite::{Connection, params};

const NOW: i64 = 1_794_000_000_000;

/// A fresh directory per test, removed afterwards.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("fhp-core-test-{}", HouseholdId::random()));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn file(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn new_household(device: DeviceId) -> Household {
    Household::create(
        NewHousehold {
            name: "Ons huis",
            timezone: "Europe/Brussels",
            founder: Founder {
                device_id: device,
                device_name: "gsm A",
                static_key: [1; STATIC_KEY_LEN],
                member_name: "lid A",
            },
        },
        NOW,
    )
    .unwrap()
}

/// A device's household saved in its own database.
struct Setup {
    _dir: TempDir,
    path: PathBuf,
    key: StorageKey,
    device: DeviceId,
    household: Household,
    store: Store,
}

fn setup() -> Setup {
    setup_with_key(StorageKey::generate().unwrap())
}

fn setup_with_key(key: StorageKey) -> Setup {
    let dir = TempDir::new();
    let path = dir.file("household.sqlite");
    let device = DeviceId::random();
    let mut household = new_household(device);
    let store = Store::create(&path, &key, &mut household).unwrap();
    Setup {
        _dir: dir,
        path,
        key,
        device,
        household,
        store,
    }
}

fn reopen(path: &Path, key: &StorageKey, household: HouseholdId) -> fhp_core::Result<Store> {
    Store::open(path, &StorageKey::from_bytes(key.to_bytes()), household)
}

fn raw(path: &Path) -> Connection {
    Connection::open(path).unwrap()
}

#[test]
fn a_household_survives_closing_and_reopening() {
    let mut s = setup();
    let kitchen = s.household.add_room("Keuken", NOW).unwrap();
    s.store.save_changes(&mut s.household).unwrap();
    s.household.add_room("Tuin", NOW).unwrap();
    s.store.save_changes(&mut s.household).unwrap();
    let id = s.household.id().unwrap();
    drop(s.store);

    let store = reopen(&s.path, &s.key, id).unwrap();
    let loaded = store.load(actor_for(s.device, 0)).unwrap();
    assert_eq!(loaded.info().unwrap(), s.household.info().unwrap());
    assert_eq!(loaded.members(), s.household.members());
    assert_eq!(loaded.devices(), s.household.devices());
    assert_eq!(loaded.rooms(), s.household.rooms());
    assert!(loaded.rooms().iter().any(|room| room.id == kitchen));
}

#[test]
fn a_loaded_household_keeps_writing_as_this_device() {
    let s = setup();
    let id = s.household.id().unwrap();
    drop(s.store);
    let mut store = reopen(&s.path, &s.key, id).unwrap();
    let mut loaded = store.load(actor_for(s.device, 0)).unwrap();
    loaded.add_room("Kelder", NOW).unwrap();
    store.save_changes(&mut loaded).unwrap();
    let again = store.load(actor_for(s.device, 0)).unwrap();
    assert_eq!(again.rooms().len(), 1);
}

#[test]
fn saving_without_changes_adds_nothing() {
    let mut s = setup();
    let before = s.store.stats().unwrap();
    s.store.save_changes(&mut s.household).unwrap();
    assert_eq!(s.store.stats().unwrap(), before);
}

#[test]
fn the_wrong_key_is_refused() {
    let s = setup();
    let id = s.household.id().unwrap();
    drop(s.store);
    let other = StorageKey::generate().unwrap();
    assert!(matches!(
        Store::open(&s.path, &other, id),
        Err(Error::WrongKey)
    ));
}

#[test]
fn another_households_database_is_refused() {
    let s = setup();
    drop(s.store);
    let result = reopen(&s.path, &s.key, HouseholdId::random());
    assert!(matches!(result, Err(Error::WrongHousehold)));
}

#[test]
fn a_database_cannot_take_a_second_household() {
    let s = setup();
    drop(s.store);
    let mut other = new_household(DeviceId::random());
    let result = Store::create(&s.path, &s.key, &mut other);
    assert!(matches!(result, Err(Error::WrongHousehold)));
}

#[test]
fn a_missing_database_is_reported() {
    let dir = TempDir::new();
    let key = StorageKey::generate().unwrap();
    let result = Store::open(&dir.file("absent.sqlite"), &key, HouseholdId::random());
    assert!(matches!(result, Err(Error::NotFound(_))));
}

#[test]
fn nothing_readable_is_stored_in_plain_text() {
    let mut s = setup();
    s.household.add_room("Geheime zolderkamer", NOW).unwrap();
    s.store.save_changes(&mut s.household).unwrap();
    drop(s.store);
    let mut bytes = std::fs::read(&s.path).unwrap();
    let wal = s.path.with_extension("sqlite-wal");
    if let Ok(wal) = std::fs::read(&wal) {
        bytes.extend(wal);
    }
    let haystack = String::from_utf8_lossy(&bytes);
    for secret in [
        "Geheime zolderkamer",
        "Ons huis",
        "lid A",
        "Europe/Brussels",
    ] {
        assert!(!haystack.contains(secret), "{secret} is readable on disk");
    }
}

#[test]
fn a_tampered_chunk_is_detected() {
    let mut s = setup();
    s.household.add_room("Keuken", NOW).unwrap();
    s.store.save_changes(&mut s.household).unwrap();
    let id = s.household.id().unwrap();
    drop(s.store);

    let conn = raw(&s.path);
    let mut ciphertext: Vec<u8> = conn
        .query_row(
            "SELECT ciphertext FROM doc_chunks ORDER BY seq DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    ciphertext[0] ^= 1;
    conn.execute(
        "UPDATE doc_chunks SET ciphertext = ?1 WHERE seq = (SELECT MAX(seq) FROM doc_chunks)",
        params![ciphertext],
    )
    .unwrap();
    drop(conn);

    let store = reopen(&s.path, &s.key, id).unwrap();
    assert!(matches!(
        store.load(actor_for(s.device, 0)),
        Err(Error::Corrupt(_))
    ));
}

#[test]
fn chunks_cannot_be_reordered() {
    let mut s = setup();
    s.household.add_room("Keuken", NOW).unwrap();
    s.store.save_changes(&mut s.household).unwrap();
    let id = s.household.id().unwrap();
    drop(s.store);

    let conn = raw(&s.path);
    let seqs: Vec<i64> = conn
        .prepare("SELECT seq FROM doc_chunks ORDER BY seq")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(seqs.len(), 2);
    conn.execute(
        "UPDATE doc_chunks SET seq = -1 WHERE seq = ?1",
        params![seqs[0]],
    )
    .unwrap();
    conn.execute(
        "UPDATE doc_chunks SET seq = ?1 WHERE seq = ?2",
        params![seqs[0], seqs[1]],
    )
    .unwrap();
    conn.execute(
        "UPDATE doc_chunks SET seq = ?1 WHERE seq = -1",
        params![seqs[1]],
    )
    .unwrap();
    drop(conn);

    let store = reopen(&s.path, &s.key, id).unwrap();
    assert!(matches!(
        store.load(actor_for(s.device, 0)),
        Err(Error::Corrupt(_))
    ));
}

#[test]
fn a_chunk_from_another_household_is_refused() {
    // The same key on both devices on purpose: only the household binding may stop the copy.
    let key = StorageKey::generate().unwrap();
    let a = setup_with_key(StorageKey::from_bytes(key.to_bytes()));
    let b = setup_with_key(key);
    let id_b = b.household.id().unwrap();
    drop(a.store);
    drop(b.store);

    let copied: (Vec<u8>, Vec<u8>) = raw(&a.path)
        .query_row(
            "SELECT nonce, ciphertext FROM doc_chunks WHERE seq = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    let key_check: Vec<u8> = raw(&b.path)
        .query_row("SELECT value FROM meta WHERE key = 'key_check'", [], |r| {
            r.get(0)
        })
        .unwrap();
    let conn = raw(&a.path);
    conn.execute(
        "UPDATE meta SET value = ?1 WHERE key = 'household'",
        params![id_b.as_bytes().as_slice()],
    )
    .unwrap();
    conn.execute(
        "UPDATE meta SET value = ?1 WHERE key = 'key_check'",
        params![key_check],
    )
    .unwrap();
    conn.execute(
        "UPDATE doc_chunks SET nonce = ?1, ciphertext = ?2 WHERE seq = 1",
        params![copied.0, copied.1],
    )
    .unwrap();
    drop(conn);

    let store = reopen(&a.path, &b.key, id_b).unwrap();
    assert!(matches!(
        store.load(actor_for(a.device, 0)),
        Err(Error::Corrupt(_))
    ));
}

#[test]
fn compaction_keeps_the_data_in_one_snapshot() {
    let mut s = setup();
    for index in 0..30 {
        s.household
            .add_room(&format!("Ruimte {index}"), NOW + index)
            .unwrap();
        s.store.save_changes(&mut s.household).unwrap();
    }
    assert_eq!(s.store.stats().unwrap().change_chunks, 30);

    s.store.compact(&mut s.household).unwrap();
    let stats = s.store.stats().unwrap();
    assert_eq!(stats.change_chunks, 0);
    assert!(stats.snapshot_bytes > 0);

    s.household.add_room("Na het compacteren", NOW).unwrap();
    s.store.save_changes(&mut s.household).unwrap();
    let loaded = s.store.load(actor_for(s.device, 0)).unwrap();
    assert_eq!(loaded.rooms(), s.household.rooms());
    assert_eq!(loaded.rooms().len(), 31);
}

#[test]
fn a_database_from_a_newer_app_is_not_touched() {
    let s = setup();
    let id = s.household.id().unwrap();
    drop(s.store);
    raw(&s.path)
        .pragma_update(None, "user_version", 99)
        .unwrap();
    assert!(matches!(
        reopen(&s.path, &s.key, id),
        Err(Error::UpdateRequired)
    ));
}

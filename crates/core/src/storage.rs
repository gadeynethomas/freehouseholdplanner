//! Local storage of one household on one device (`docs/TECHNICAL.md`, section 4): a SQLite file
//! holding the Automerge document as a snapshot plus incremental changes, every chunk encrypted
//! with the device's storage key before it reaches SQLite (K8).

use std::fmt;
use std::path::Path;

use automerge::{ActorId, AutoCommit};
use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use rusqlite::{Connection, OptionalExtension, params};

use crate::error::{Error, Result};
use crate::ids::HouseholdId;
use crate::model::Household;

/// Database schema migrations, applied in order. Never edit one that has shipped; add a new one.
const MIGRATIONS: &[&str] = &[r"
    CREATE TABLE meta (
        key   TEXT PRIMARY KEY,
        value BLOB NOT NULL
    ) STRICT;
    CREATE TABLE doc_chunks (
        seq        INTEGER PRIMARY KEY,
        kind       INTEGER NOT NULL CHECK (kind IN (0, 1)),
        nonce      BLOB NOT NULL,
        ciphertext BLOB NOT NULL
    ) STRICT;
"];

const META_HOUSEHOLD: &str = "household";
const META_KEY_CHECK: &str = "key_check";
const KEY_CHECK_PLAINTEXT: &[u8] = b"freehouseholdplanner storage key check";

const NONCE_LEN: usize = 24;

/// Compact once this many incremental chunks have piled up, or once they are this many times
/// larger than the snapshot (`poc/sync` lesson 3: the log grows about 16 times a compact save).
const COMPACT_AFTER_CHUNKS: u64 = 200;
const COMPACT_AFTER_GROWTH: u64 = 4;
/// Below this snapshot size the growth rule does not apply: a new household is tiny.
const COMPACT_MIN_SNAPSHOT_BYTES: u64 = 64 * 1024;

#[derive(Clone, Copy, PartialEq, Eq)]
enum ChunkKind {
    Snapshot = 0,
    Changes = 1,
}

/// The 256-bit key that encrypts a device's stored data. The platform keeps it wrapped in its
/// keystore (Android Keystore, OS keyring); the core only ever holds it in memory.
pub struct StorageKey([u8; 32]);

impl StorageKey {
    pub fn generate() -> Result<Self> {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).map_err(|_| Error::Random)?;
        Ok(Self(bytes))
    }

    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    /// The raw key, for the platform to wrap and store.
    pub fn to_bytes(&self) -> [u8; 32] {
        self.0
    }
}

impl fmt::Debug for StorageKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("StorageKey(..)")
    }
}

impl Drop for StorageKey {
    fn drop(&mut self) {
        // Wipe the key when it is no longer needed. `black_box` keeps the compiler from removing
        // the write as dead; a best effort without `unsafe`, which the workspace forbids.
        self.0.fill(0);
        std::hint::black_box(&self.0);
    }
}

/// Size of the stored chunks, to decide when to compact.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ChunkStats {
    pub change_chunks: u64,
    pub change_bytes: u64,
    pub snapshot_bytes: u64,
}

impl ChunkStats {
    pub fn should_compact(&self) -> bool {
        let base = self.snapshot_bytes.max(COMPACT_MIN_SNAPSHOT_BYTES);
        self.change_chunks >= COMPACT_AFTER_CHUNKS
            || self.change_bytes > base.saturating_mul(COMPACT_AFTER_GROWTH)
    }
}

/// One household's database on this device.
pub struct Store {
    conn: Connection,
    cipher: XChaCha20Poly1305,
    household: HouseholdId,
}

impl Store {
    /// Creates the database for a household that is new on this device and stores a first
    /// snapshot of it. The file must not hold another household yet.
    pub fn create(path: &Path, key: &StorageKey, household: &mut Household) -> Result<Self> {
        let household_id = household.id()?;
        let conn = open_connection(path)?;
        let store = Self {
            conn,
            cipher: cipher(key),
            household: household_id,
        };
        if store.meta(META_HOUSEHOLD)?.is_some() {
            return Err(Error::WrongHousehold);
        }
        let (nonce, check) = store.seal(&store.key_check_aad(), KEY_CHECK_PLAINTEXT)?;
        let mut stored_check = nonce.to_vec();
        stored_check.extend_from_slice(&check);
        store.conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2), (?3, ?4)",
            params![
                META_HOUSEHOLD,
                household_id.as_bytes().as_slice(),
                META_KEY_CHECK,
                stored_check
            ],
        )?;
        let mut store = store;
        store.compact(household)?;
        Ok(store)
    }

    /// Opens an existing household database, checking that it is this household's and that the
    /// key fits.
    pub fn open(path: &Path, key: &StorageKey, household: HouseholdId) -> Result<Self> {
        if !path.exists() {
            return Err(Error::NotFound("household database"));
        }
        let conn = open_connection(path)?;
        let store = Self {
            conn,
            cipher: cipher(key),
            household,
        };
        match store.meta(META_HOUSEHOLD)? {
            Some(stored) if stored == household.as_bytes() => {}
            _ => return Err(Error::WrongHousehold),
        }
        let check = store
            .meta(META_KEY_CHECK)?
            .ok_or(Error::Corrupt("key check missing"))?;
        if check.len() < NONCE_LEN {
            return Err(Error::Corrupt("key check"));
        }
        let (nonce, sealed) = check.split_at(NONCE_LEN);
        match store.unseal(&store.key_check_aad(), nonce, sealed) {
            Some(plaintext) if plaintext == KEY_CHECK_PLAINTEXT => Ok(store),
            _ => Err(Error::WrongKey),
        }
    }

    /// Loads the household document. `actor` is the identity this device writes under.
    pub fn load(&self, actor: ActorId) -> Result<Household> {
        let mut statement = self
            .conn
            .prepare("SELECT seq, kind, nonce, ciphertext FROM doc_chunks ORDER BY seq")?;
        let mut rows = statement.query([])?;
        let mut doc = AutoCommit::new();
        let mut chunks = 0;
        while let Some(row) = rows.next()? {
            let seq: i64 = row.get(0)?;
            let kind = match row.get::<_, i64>(1)? {
                0 => ChunkKind::Snapshot,
                1 => ChunkKind::Changes,
                _ => return Err(Error::Corrupt("chunk kind")),
            };
            let nonce: Vec<u8> = row.get(2)?;
            let ciphertext: Vec<u8> = row.get(3)?;
            let bytes = self
                .unseal(&self.chunk_aad(kind, seq), &nonce, &ciphertext)
                .ok_or(Error::Corrupt("document chunk"))?;
            doc.load_incremental(&bytes)
                .map_err(|_| Error::Corrupt("document chunk"))?;
            chunks += 1;
        }
        if chunks == 0 {
            return Err(Error::Corrupt("no document stored"));
        }
        doc.set_actor(actor);
        let household = Household::from_document(doc)?;
        if household.id()? != self.household {
            return Err(Error::WrongHousehold);
        }
        Ok(household)
    }

    /// Appends the changes made since the last save. Cheap; call it after every edit.
    pub fn save_changes(&mut self, household: &mut Household) -> Result<()> {
        let bytes = household.document().save_incremental();
        if bytes.is_empty() {
            return Ok(());
        }
        let tx = self.conn.transaction()?;
        let seq = next_seq(&tx)?;
        let (nonce, ciphertext) = seal_with(
            &self.cipher,
            &chunk_aad(self.household, ChunkKind::Changes, seq),
            &bytes,
        )?;
        tx.execute(
            "INSERT INTO doc_chunks (seq, kind, nonce, ciphertext) VALUES (?1, ?2, ?3, ?4)",
            params![seq, ChunkKind::Changes as i64, nonce.as_slice(), ciphertext],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Replaces all stored chunks by one snapshot, in a single transaction: a crash leaves either
    /// the old chunks or the new snapshot.
    pub fn compact(&mut self, household: &mut Household) -> Result<()> {
        let bytes = household.document().save();
        let tx = self.conn.transaction()?;
        let seq = next_seq(&tx)?;
        let (nonce, ciphertext) = seal_with(
            &self.cipher,
            &chunk_aad(self.household, ChunkKind::Snapshot, seq),
            &bytes,
        )?;
        tx.execute(
            "INSERT INTO doc_chunks (seq, kind, nonce, ciphertext) VALUES (?1, ?2, ?3, ?4)",
            params![
                seq,
                ChunkKind::Snapshot as i64,
                nonce.as_slice(),
                ciphertext
            ],
        )?;
        tx.execute("DELETE FROM doc_chunks WHERE seq < ?1", params![seq])?;
        tx.commit()?;
        Ok(())
    }

    pub fn stats(&self) -> Result<ChunkStats> {
        let mut statement = self.conn.prepare(
            "SELECT kind, COUNT(*), COALESCE(SUM(LENGTH(ciphertext)), 0) FROM doc_chunks GROUP BY kind",
        )?;
        let mut rows = statement.query([])?;
        let mut stats = ChunkStats::default();
        while let Some(row) = rows.next()? {
            let count = u64::try_from(row.get::<_, i64>(1)?).unwrap_or(0);
            let bytes = u64::try_from(row.get::<_, i64>(2)?).unwrap_or(0);
            match row.get::<_, i64>(0)? {
                0 => stats.snapshot_bytes += bytes,
                _ => {
                    stats.change_chunks += count;
                    stats.change_bytes += bytes;
                }
            }
        }
        Ok(stats)
    }

    fn meta(&self, key: &str) -> Result<Option<Vec<u8>>> {
        Ok(self
            .conn
            .query_row(
                "SELECT value FROM meta WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()?)
    }

    fn seal(&self, aad: &[u8], plaintext: &[u8]) -> Result<([u8; NONCE_LEN], Vec<u8>)> {
        seal_with(&self.cipher, aad, plaintext)
    }

    fn unseal(&self, aad: &[u8], nonce: &[u8], ciphertext: &[u8]) -> Option<Vec<u8>> {
        let nonce: [u8; NONCE_LEN] = nonce.try_into().ok()?;
        self.cipher
            .decrypt(
                &XNonce::from(nonce),
                Payload {
                    msg: ciphertext,
                    aad,
                },
            )
            .ok()
    }

    fn key_check_aad(&self) -> Vec<u8> {
        let mut aad = b"fhp/key-check/v1".to_vec();
        aad.extend_from_slice(self.household.as_bytes());
        aad
    }

    fn chunk_aad(&self, kind: ChunkKind, seq: i64) -> Vec<u8> {
        chunk_aad(self.household, kind, seq)
    }
}

fn open_connection(path: &Path) -> Result<Connection> {
    let mut conn = Connection::open(path)?;
    conn.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(()))?;
    conn.pragma_update(None, "synchronous", "FULL")?;
    migrate(&mut conn)?;
    Ok(conn)
}

fn migrate(conn: &mut Connection) -> Result<()> {
    let applied: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let applied = usize::try_from(applied).map_err(|_| Error::Corrupt("schema version"))?;
    if applied > MIGRATIONS.len() {
        return Err(Error::UpdateRequired);
    }
    for (index, migration) in MIGRATIONS.iter().enumerate().skip(applied) {
        let tx = conn.transaction()?;
        tx.execute_batch(migration)?;
        let version = i64::try_from(index + 1).map_err(|_| Error::Corrupt("schema version"))?;
        tx.pragma_update(None, "user_version", version)?;
        tx.commit()?;
    }
    Ok(())
}

fn next_seq(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM doc_chunks",
        [],
        |row| row.get(0),
    )?)
}

fn cipher(key: &StorageKey) -> XChaCha20Poly1305 {
    XChaCha20Poly1305::new(&key.0.into())
}

/// Binds a chunk to its household, kind and position, so chunks cannot be swapped, reordered or
/// moved to another household's database without failing authentication.
fn chunk_aad(household: HouseholdId, kind: ChunkKind, seq: i64) -> Vec<u8> {
    let mut aad = b"fhp/doc-chunk/v1".to_vec();
    aad.extend_from_slice(household.as_bytes());
    aad.push(kind as u8);
    aad.extend_from_slice(&seq.to_be_bytes());
    aad
}

fn seal_with(
    cipher: &XChaCha20Poly1305,
    aad: &[u8],
    plaintext: &[u8],
) -> Result<([u8; NONCE_LEN], Vec<u8>)> {
    let mut nonce = [0u8; NONCE_LEN];
    getrandom::fill(&mut nonce).map_err(|_| Error::Random)?;
    let ciphertext = cipher
        .encrypt(
            &XNonce::from(nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| Error::Corrupt("encryption failed"))?;
    Ok((nonce, ciphertext))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compaction_waits_for_enough_changes() {
        let small = ChunkStats {
            change_chunks: 10,
            change_bytes: 1_000,
            snapshot_bytes: 500,
        };
        assert!(!small.should_compact());
        assert!(!ChunkStats::default().should_compact());
    }

    #[test]
    fn compaction_after_many_chunks() {
        let stats = ChunkStats {
            change_chunks: COMPACT_AFTER_CHUNKS,
            ..ChunkStats::default()
        };
        assert!(stats.should_compact());
    }

    #[test]
    fn compaction_when_changes_outgrow_the_snapshot() {
        let snapshot_bytes = 1_000_000;
        let at_limit = ChunkStats {
            change_chunks: 1,
            change_bytes: 4_000_000,
            snapshot_bytes,
        };
        assert!(!at_limit.should_compact());
        let over = ChunkStats {
            change_bytes: 4_000_001,
            ..at_limit
        };
        assert!(over.should_compact());
    }

    #[test]
    fn a_tiny_snapshot_does_not_force_early_compaction() {
        let stats = ChunkStats {
            change_chunks: 5,
            change_bytes: 200_000,
            snapshot_bytes: 300,
        };
        assert!(!stats.should_compact());
    }

    #[test]
    fn storage_keys_never_print() {
        let key = StorageKey::from_bytes([42; 32]);
        assert_eq!(format!("{key:?}"), "StorageKey(..)");
    }

    #[test]
    fn chunk_aad_differs_by_household_kind_and_position() {
        let household = HouseholdId::random();
        let base = chunk_aad(household, ChunkKind::Changes, 1);
        assert_ne!(
            base,
            chunk_aad(HouseholdId::random(), ChunkKind::Changes, 1)
        );
        assert_ne!(base, chunk_aad(household, ChunkKind::Snapshot, 1));
        assert_ne!(base, chunk_aad(household, ChunkKind::Changes, 2));
    }
}

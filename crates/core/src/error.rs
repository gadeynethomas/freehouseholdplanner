use std::fmt;

/// Everything that can go wrong in the core. The UI maps these to Dutch messages.
#[derive(Debug)]
pub enum Error {
    /// A name is empty, too long or contains control characters.
    InvalidName(&'static str),
    /// A timezone is not an IANA-style name such as `Europe/Brussels`.
    InvalidTimezone,
    /// Another active room already has this name (R1).
    DuplicateRoomName,
    /// The record does not exist (or no longer).
    NotFound(&'static str),
    /// The household was written by a newer app that this version may not edit (K9).
    UpdateRequired,
    /// The storage key does not open this database.
    WrongKey,
    /// The database belongs to another household (A4).
    WrongHousehold,
    /// Stored data failed its integrity check or does not decode.
    Corrupt(&'static str),
    /// The operating system could not provide random bytes.
    Random,
    Storage(rusqlite::Error),
    Document(automerge::AutomergeError),
}

pub type Result<T> = std::result::Result<T, Error>;

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidName(reason) => write!(f, "invalid name: {reason}"),
            Self::InvalidTimezone => f.write_str("invalid timezone"),
            Self::DuplicateRoomName => f.write_str("a room with this name already exists"),
            Self::NotFound(what) => write!(f, "{what} not found"),
            Self::UpdateRequired => f.write_str("a newer app version wrote this household"),
            Self::WrongKey => f.write_str("the storage key does not match"),
            Self::WrongHousehold => f.write_str("the database belongs to another household"),
            Self::Corrupt(what) => write!(f, "corrupt data: {what}"),
            Self::Random => f.write_str("no random bytes available"),
            Self::Storage(error) => write!(f, "storage: {error}"),
            Self::Document(error) => write!(f, "document: {error}"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Storage(error) => Some(error),
            Self::Document(error) => Some(error),
            _ => None,
        }
    }
}

impl From<rusqlite::Error> for Error {
    fn from(error: rusqlite::Error) -> Self {
        Self::Storage(error)
    }
}

impl From<automerge::AutomergeError> for Error {
    fn from(error: automerge::AutomergeError) -> Self {
        Self::Document(error)
    }
}

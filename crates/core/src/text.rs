//! Validation of names and other short text that users type.

use crate::error::{Error, Result};

/// Longest name for a household, member, device or room, in characters.
pub const MAX_NAME_CHARS: usize = 80;

/// Trims a name and checks it: not empty, at most [`MAX_NAME_CHARS`] characters, no control
/// characters (they break layouts and can hide text).
pub fn clean_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(Error::InvalidName("empty"));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(Error::InvalidName("too long"));
    }
    if name.chars().any(char::is_control) {
        return Err(Error::InvalidName("control character"));
    }
    Ok(name.to_owned())
}

/// Checks that a timezone looks like an IANA name (`Europe/Brussels`, `UTC`). Whether the zone
/// exists is up to the platform's timezone data, which the UI uses to offer the choices.
pub fn check_timezone(timezone: &str) -> Result<()> {
    let valid_char = |c: char| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-' | '+');
    let looks_valid = (1..=64).contains(&timezone.len())
        && timezone.chars().all(valid_char)
        && !timezone.starts_with('/')
        && !timezone.ends_with('/')
        && !timezone.contains("//");
    if looks_valid {
        Ok(())
    } else {
        Err(Error::InvalidTimezone)
    }
}

/// Compares names the way people do: case and surrounding spaces do not matter.
pub fn same_name(a: &str, b: &str) -> bool {
    a.trim().to_lowercase() == b.trim().to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_trimmed() {
        assert_eq!(clean_name("  Keuken \n").unwrap(), "Keuken");
    }

    #[test]
    fn empty_names_are_refused() {
        assert!(clean_name("").is_err());
        assert!(clean_name("   ").is_err());
    }

    #[test]
    fn name_length_is_counted_in_characters() {
        let longest = "é".repeat(MAX_NAME_CHARS);
        assert_eq!(clean_name(&longest).unwrap(), longest);
        assert!(clean_name(&"é".repeat(MAX_NAME_CHARS + 1)).is_err());
    }

    #[test]
    fn control_characters_are_refused() {
        assert!(clean_name("Bad\u{0}kamer").is_err());
        assert!(clean_name("Bad\nkamer").is_err());
    }

    #[test]
    fn timezones_must_look_like_iana_names() {
        for zone in [
            "Europe/Brussels",
            "UTC",
            "America/Argentina/Buenos_Aires",
            "Etc/GMT+1",
        ] {
            assert!(check_timezone(zone).is_ok(), "{zone} was refused");
        }
        for zone in [
            "",
            "Europe/",
            "/UTC",
            "Europe//Brussels",
            "Europe/Brüssel",
            "a b",
        ] {
            assert!(check_timezone(zone).is_err(), "{zone:?} was accepted");
        }
        assert!(check_timezone(&"A".repeat(65)).is_err());
    }

    #[test]
    fn same_name_ignores_case_and_spaces() {
        assert!(same_name("Keuken", " keuken "));
        assert!(same_name("ÉTAGE", "étage"));
        assert!(!same_name("Keuken", "Kelder"));
    }
}

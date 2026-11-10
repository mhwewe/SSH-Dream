// =============================================================================
// secrets.rs — wrapper around the `keyring` crate (Windows Credential Manager).
// Entry: service "ssh-clone", account "<profileId>:<kind>", kind = ssh | rdp | key_passphrase
// (README §5.4). Called by: commands/secrets.rs, profiles.rs (save_as/delete), rdp.rs,
// and later Handoff 2 (session connect).
// RULE: `get` is INTERNAL ONLY. It must never be exposed as a Tauri command, and values
// must never be logged or emitted.
// =============================================================================
use crate::error::{AppError, AppResult};
use keyring::Entry;

const SERVICE: &str = "ssh-clone";
pub const KINDS: [&str; 3] = ["ssh", "rdp", "key_passphrase"];

fn entry(profile_id: &str, kind: &str) -> AppResult<Entry> {
    if !KINDS.contains(&kind) {
        return Err(AppError::invalid(format!("unknown secret kind '{kind}'")));
    }
    Ok(Entry::new(SERVICE, &format!("{profile_id}:{kind}"))?)
}

/// Store a secret. Empty string = "no secret" => delete (the keyring can error on empty values).
pub fn set(profile_id: &str, kind: &str, value: &str) -> AppResult<()> {
    if value.is_empty() {
        return delete(profile_id, kind);
    }
    entry(profile_id, kind)?.set_password(value)?;
    Ok(())
}

pub fn exists(profile_id: &str, kind: &str) -> AppResult<bool> {
    match entry(profile_id, kind)?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(e.into()),
    }
}

/// Deleting something that does not exist is not an error.
pub fn delete(profile_id: &str, kind: &str) -> AppResult<()> {
    match entry(profile_id, kind)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// INTERNAL: read a secret (None if absent). Used by save_as, rdp.rs and Handoff 2.
pub fn get(profile_id: &str, kind: &str) -> AppResult<Option<String>> {
    match entry(profile_id, kind)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Delete all secrets of a profile (used by profile delete).
pub fn delete_all(profile_id: &str) -> AppResult<()> {
    for k in KINDS {
        delete(profile_id, k)?;
    }
    Ok(())
}

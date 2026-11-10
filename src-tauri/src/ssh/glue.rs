//! ssh/glue.rs — the ONLY place where Handoff 2 touches Handoff-1 data.
//!
//! I did not have the Handoff-1 code, so this file reads the two things it needs straight from
//! their documented contract (README §5.4 / §5.5):
//!   * profile JSON:  <app_data_dir>/profiles/<id>.json   (only the fields we need)
//!   * secrets:       keyring service "ssh-clone", account "<profileId>:<kind>"
//!
//! If Handoff 1 exposes `profiles::get(...)` / `secrets::get(...)`, you can replace the two
//! function bodies below with calls to them — nothing else in the ssh/ folder needs to change.

use serde::Deserialize;
use tauri::{AppHandle, Manager};

use super::{SshErr, SshResult};

/// Subset of README `Profile` that the SSH layer needs (unknown JSON fields are ignored).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileLite {
    pub id: String,
    pub ssh: SshLite,
    #[serde(default)]
    pub terminal: TermLite,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshLite {
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub username: String,
    /// "password" | "publickey"
    pub auth_method: String,
    pub key_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TermLite {
    #[serde(default = "default_term")]
    pub term_type: String,
}

impl Default for TermLite {
    fn default() -> Self {
        Self { term_type: default_term() }
    }
}

fn default_port() -> u16 {
    22
}
fn default_term() -> String {
    "xterm-256color".to_string()
}

/// Load a profile by id from `<app_data_dir>/profiles/<id>.json`.
pub fn load_profile(app: &AppHandle, profile_id: &str) -> SshResult<ProfileLite> {
    // Profile ids are uuids; refuse anything that could escape the folder.
    if profile_id.is_empty() || profile_id.contains(['/', '\\', '.']) {
        return Err(SshErr::new("invalid", "Invalid profile id."));
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| SshErr::new("io", format!("Cannot find the app data folder: {e}")))?;
    let path = dir.join("profiles").join(format!("{profile_id}.json"));
    let text = std::fs::read_to_string(&path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            SshErr::new("not_found", "Profile not found.")
        } else {
            SshErr::new("io", format!("Cannot read the profile: {e}"))
        }
    })?;
    serde_json::from_str(&text).map_err(|e| SshErr::new("invalid", format!("Profile file is invalid: {e}")))
}

/// Read a secret from the OS keyring. `kind` = "ssh" | "rdp" | "key_passphrase".
/// Returns Ok(None) when nothing is stored. The value is never logged.
pub fn get_secret(profile_id: &str, kind: &str) -> SshResult<Option<String>> {
    let account = format!("{profile_id}:{kind}");
    let entry = keyring::Entry::new("ssh-clone", &account)
        .map_err(|e| SshErr::new("secret_store", format!("Keyring error: {e}")))?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(SshErr::new("secret_store", format!("Keyring error: {e}"))),
    }
}

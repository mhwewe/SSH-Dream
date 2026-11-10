// =============================================================================
// profiles.rs — profile CRUD on disk, defaults, import/export, and ui_state.json.
// Files: <app_data_dir>/profiles/<uuid>.json (one per profile, no secrets inside),
//        <app_data_dir>/ui_state.json (last active profile id).
// Called by: commands/profiles.rs, rdp.rs (load a profile), Handoff 2 (load on connect).
// Calls: secrets.rs (copy/delete secrets), logging.rs.
// Shape of `Profile` = README §5.1 (camelCase over the wire). If you change it: bump
// schemaVersion, add a migration in `read_file`, and update README first.
// =============================================================================
use crate::error::{AppError, AppResult};
use crate::logging::{emit_log, LogLevel};
use crate::secrets;
use chrono::SecondsFormat;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

// ---------------------------------------------------------------- data model

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    #[serde(default = "schema_v1")]
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub ssh: SshConfig,
    #[serde(default)]
    pub rdp: RdpConfig,
    #[serde(default)]
    pub terminal: TerminalConfig,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    /// "password" | "publickey"
    pub auth_method: String,
    pub key_path: Option<String>,
    pub store_password: bool,
    /// true = this profile is logged in automatically when the app starts (frontend, App.tsx).
    pub auto_login: bool,
}
impl Default for SshConfig {
    fn default() -> Self {
        Self { host: String::new(), port: 22, username: String::new(),
               auth_method: "password".into(), key_path: None, store_password: false, auto_login: true }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct RdpConfig {
    pub host: Option<String>,      // None = reuse ssh.host
    pub port: u16,
    pub username: Option<String>,  // None = reuse ssh.username
    pub store_password: bool,
    pub fullscreen: bool,
    /// "1920x1080"; None / "" = let mstsc pick its default size. Parsed by rdp::parse_resolution.
    pub resolution: Option<String>,
    /// true = resizing the mstsc window resizes the remote desktop too ("dynamic resolution").
    pub smart_resize: bool,
}
impl Default for RdpConfig {
    fn default() -> Self {
        Self { host: None, port: 3389, username: None, store_password: false, fullscreen: false,
               resolution: None, smart_resize: true }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct TerminalConfig {
    pub font_family: String,
    pub font_size: u32,
    pub scrollback: u32,
    pub term_type: String,
}
impl Default for TerminalConfig {
    fn default() -> Self {
        Self { font_family: "Cascadia Mono".into(), font_size: 14, scrollback: 5000,
               term_type: "xterm-256color".into() }
    }
}

fn schema_v1() -> u32 { 1 }

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

impl Profile {
    /// Fresh profile with all README defaults (new random uuid).
    pub fn default_new(name: &str) -> Self {
        let now = now_iso();
        Self {
            schema_version: 1, id: Uuid::new_v4().to_string(), name: name.to_string(),
            ssh: SshConfig::default(), rdp: RdpConfig::default(), terminal: TerminalConfig::default(),
            created_at: now.clone(), updated_at: now,
        }
    }
}

// ---------------------------------------------------------------- paths + io helpers

fn app_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app.path().app_data_dir().map_err(|e| AppError::internal(e.to_string()))?;
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn profiles_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app_dir(app)?.join("profiles");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// The id becomes a file name, so it MUST be a uuid (blocks "../" path tricks).
fn profile_path(app: &AppHandle, id: &str) -> AppResult<PathBuf> {
    Uuid::parse_str(id).map_err(|_| AppError::invalid("profile id must be a UUID"))?;
    Ok(profiles_dir(app)?.join(format!("{id}.json")))
}

/// Atomic write: write a temp file next to the target, then rename over it,
/// so a crash can never leave a half-written profile.
fn atomic_write(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

/// Parse a profile file. MIGRATION HOOK: when schemaVersion > 1 exists, upgrade here.
fn read_file(path: &Path) -> AppResult<Profile> {
    let text = fs::read_to_string(path)?;
    let p: Profile = serde_json::from_str(&text)?;
    Ok(p)
}

fn validate(p: &Profile) -> AppResult<()> {
    if p.name.trim().is_empty() { return Err(AppError::invalid("Profile name must not be empty")); }
    if p.ssh.port == 0 { return Err(AppError::invalid("SSH port must be 1-65535")); }
    if p.rdp.port == 0 { return Err(AppError::invalid("RDP port must be 1-65535")); }
    crate::rdp::parse_resolution(p.rdp.resolution.as_deref().unwrap_or("")).map_err(AppError::invalid)?;
    if p.ssh.auth_method != "password" && p.ssh.auth_method != "publickey" {
        return Err(AppError::invalid("authMethod must be 'password' or 'publickey'"));
    }
    // NOTE: ssh.host may be empty on a draft; the Log in button validates it later.
    Ok(())
}

// ---------------------------------------------------------------- CRUD

/// All profiles, sorted by name. Unreadable files are skipped with a warning (never crash).
pub fn list(app: &AppHandle) -> AppResult<Vec<Profile>> {
    let dir = profiles_dir(app)?;
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir)? {
        let path = entry?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") { continue; }
        match read_file(&path) {
            Ok(p) => out.push(p),
            Err(e) => emit_log(app, None, LogLevel::Warn,
                format!("Skipping unreadable profile file {:?}: {}", path.file_name().unwrap_or_default(), e.message)),
        }
    }
    out.sort_by_key(|p| p.name.to_lowercase());
    Ok(out)
}

pub fn get(app: &AppHandle, id: &str) -> AppResult<Profile> {
    let path = profile_path(app, id)?;
    if !path.exists() { return Err(AppError::not_found(format!("profile {id} not found"))); }
    read_file(&path)
}

/// Create or overwrite. Sets updatedAt; keeps the original createdAt when overwriting.
pub fn save(app: &AppHandle, mut p: Profile) -> AppResult<Profile> {
    validate(&p)?;
    let path = profile_path(app, &p.id)?;
    p.schema_version = 1;
    let now = now_iso();
    p.created_at = match read_file(&path) {
        Ok(old) if !old.created_at.is_empty() => old.created_at,
        _ => if p.created_at.is_empty() { now.clone() } else { p.created_at.clone() },
    };
    p.updated_at = now;
    atomic_write(&path, serde_json::to_string_pretty(&p)?.as_bytes())?;
    emit_log(app, None, LogLevel::Info, format!("Profile saved: {}", p.name));
    Ok(p)
}

/// Copy of `source` under a new id/name. Secrets are copied backend-side (the UI can't read them).
pub fn save_as(app: &AppHandle, source: Profile, new_name: &str) -> AppResult<Profile> {
    let old_id = source.id.clone();
    let mut copy = source;
    copy.id = Uuid::new_v4().to_string();
    copy.name = new_name.trim().to_string();
    copy.created_at = String::new(); // save() stamps it
    let saved = save(app, copy)?;
    for kind in secrets::KINDS {
        if let Some(v) = secrets::get(&old_id, kind)? {
            secrets::set(&saved.id, kind, &v)?;
        }
    }
    Ok(saved)
}

/// Remove the file and every keyring entry of the profile.
pub fn delete(app: &AppHandle, id: &str) -> AppResult<()> {
    let path = profile_path(app, id)?;
    let name = read_file(&path).map(|p| p.name).unwrap_or_else(|_| id.to_string());
    if !path.exists() { return Err(AppError::not_found(format!("profile {id} not found"))); }
    fs::remove_file(&path)?;
    secrets::delete_all(id)?;
    emit_log(app, None, LogLevel::Info, format!("Profile deleted: {name}"));
    Ok(())
}

/// Write the profile JSON (never any secrets) to a user-chosen path.
pub fn export(app: &AppHandle, id: &str, dest: &str) -> AppResult<()> {
    let p = get(app, id)?;
    fs::write(dest, serde_json::to_string_pretty(&p)?)?;
    emit_log(app, None, LogLevel::Info, format!("Profile exported: {}", p.name));
    Ok(())
}

/// Read a profile JSON from `src`, give it a NEW id and save it.
pub fn import(app: &AppHandle, src: &str) -> AppResult<Profile> {
    let mut p: Profile = serde_json::from_str(&fs::read_to_string(src)?)?;
    p.id = Uuid::new_v4().to_string();
    p.created_at = String::new();
    let saved = save(app, p)?;
    emit_log(app, None, LogLevel::Info, format!("Profile imported: {}", saved.name));
    Ok(saved)
}

// ---------------------------------------------------------------- ui_state.json

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct UiState {
    pub last_active_profile_id: Option<String>,
}

pub fn ui_state_get(app: &AppHandle) -> AppResult<UiState> {
    let path = app_dir(app)?.join("ui_state.json");
    match fs::read_to_string(&path) {
        Ok(t) => Ok(serde_json::from_str(&t).unwrap_or_default()), // corrupt => defaults
        Err(_) => Ok(UiState::default()),
    }
}

pub fn ui_state_set(app: &AppHandle, last_active: Option<String>) -> AppResult<()> {
    let path = app_dir(app)?.join("ui_state.json");
    let st = UiState { last_active_profile_id: last_active };
    atomic_write(&path, serde_json::to_string_pretty(&st)?.as_bytes())
}

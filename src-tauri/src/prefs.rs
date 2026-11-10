// =============================================================================
// prefs.rs — one small JSON file for per-profile SFTP UI memory: the last folder and bookmarks.
// File: <app_data_dir>/sftp_prefs.json   (no secrets; plain remote folder paths)
// Shape (owned by the frontend, store/sftpPrefs.ts — the backend only stores it):
//   { "version": 1, "profiles": { "<profileId>": { "lastPath": "/srv", "bookmarks": [{ "path": "/srv", "name": "srv" }] } } }
// Called by: commands/prefs.rs.
// The file is rewritten atomically (temp file + rename), like profiles and ui_state.json.
// =============================================================================
use crate::error::{AppError, AppResult};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Safety net: bookmarks are tiny; anything near this size is a bug, not data.
const MAX_BYTES: usize = 1_000_000;

fn file_path(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app.path().app_data_dir().map_err(|e| AppError::internal(e.to_string()))?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join("sftp_prefs.json"))
}

/// Missing or corrupt file => an empty object (the UI then starts with no bookmarks, never crashes).
pub fn load(app: &AppHandle) -> AppResult<Value> {
    let path = file_path(app)?;
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return Ok(json!({})),
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(v) if v.is_object() => Ok(v),
        _ => Ok(json!({})),
    }
}

pub fn save(app: &AppHandle, value: Value) -> AppResult<()> {
    if !value.is_object() {
        return Err(AppError::invalid("prefs must be a JSON object"));
    }
    let bytes = serde_json::to_string_pretty(&value)?.into_bytes();
    if bytes.len() > MAX_BYTES {
        return Err(AppError::invalid("prefs are too large"));
    }
    let path = file_path(app)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &bytes)?;
    fs::rename(&tmp, &path)?;
    Ok(())
}

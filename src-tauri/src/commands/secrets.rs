// commands/secrets.rs — set / exists / delete ONLY. There is deliberately NO "get" command:
// the frontend must never be able to read a secret back (README §3 idea 4).
use crate::error::AppResult;
use crate::logging::{emit_log, LogLevel};
use crate::secrets;
use tauri::AppHandle;

#[tauri::command]
pub async fn secret_set(app: AppHandle, profile_id: String, kind: String, value: String) -> AppResult<()> {
    secrets::set(&profile_id, &kind, &value)?;
    // Log the fact, never the value.
    emit_log(&app, None, LogLevel::Info, format!("Stored encrypted secret ({kind})"));
    Ok(())
}

#[tauri::command]
pub async fn secret_exists(profile_id: String, kind: String) -> AppResult<bool> {
    secrets::exists(&profile_id, &kind)
}

#[tauri::command]
pub async fn secret_delete(app: AppHandle, profile_id: String, kind: String) -> AppResult<()> {
    secrets::delete(&profile_id, &kind)?;
    emit_log(&app, None, LogLevel::Info, format!("Removed stored secret ({kind})"));
    Ok(())
}

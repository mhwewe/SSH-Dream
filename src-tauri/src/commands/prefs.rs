// commands/prefs.rs — `sftp_prefs_get() -> object` and `sftp_prefs_set(value) -> void`. Logic in crate::prefs.
use crate::error::AppResult;
use tauri::AppHandle;

#[tauri::command]
pub async fn sftp_prefs_get(app: AppHandle) -> AppResult<serde_json::Value> { crate::prefs::load(&app) }

#[tauri::command]
pub async fn sftp_prefs_set(app: AppHandle, value: serde_json::Value) -> AppResult<()> {
    crate::prefs::save(&app, value)
}

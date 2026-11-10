// commands/profiles.rs — Tauri commands for profiles (README §5.2) + ui_state helpers.
// All async + owned args so they run off the main thread. Logic lives in crate::profiles.
use crate::error::AppResult;
use crate::profiles::{self, Profile, UiState};
use tauri::AppHandle;

#[tauri::command]
pub async fn profile_list(app: AppHandle) -> AppResult<Vec<Profile>> { profiles::list(&app) }

#[tauri::command]
pub async fn profile_get(app: AppHandle, id: String) -> AppResult<Profile> { profiles::get(&app, &id) }

#[tauri::command]
pub async fn profile_save(app: AppHandle, profile: Profile) -> AppResult<Profile> { profiles::save(&app, profile) }

#[tauri::command]
pub async fn profile_save_as(app: AppHandle, profile: Profile, new_name: String) -> AppResult<Profile> {
    profiles::save_as(&app, profile, &new_name)
}

#[tauri::command]
pub async fn profile_delete(app: AppHandle, id: String) -> AppResult<()> { profiles::delete(&app, &id) }

#[tauri::command]
pub async fn profile_export(app: AppHandle, id: String, path: String) -> AppResult<()> {
    profiles::export(&app, &id, &path)
}

#[tauri::command]
pub async fn profile_import(app: AppHandle, path: String) -> AppResult<Profile> { profiles::import(&app, &path) }

/// H1 contract addition: `ui_state_get() -> { lastActiveProfileId: string | null }`
#[tauri::command]
pub async fn ui_state_get(app: AppHandle) -> AppResult<UiState> { profiles::ui_state_get(&app) }

/// H1 contract addition: `ui_state_set(lastActiveProfileId) -> void`
#[tauri::command]
pub async fn ui_state_set(app: AppHandle, last_active_profile_id: Option<String>) -> AppResult<()> {
    profiles::ui_state_set(&app, last_active_profile_id)
}

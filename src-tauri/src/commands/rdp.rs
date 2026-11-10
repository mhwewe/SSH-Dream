// commands/rdp.rs — `rdp_launch(profileId)`. Logic in crate::rdp.
use crate::error::AppResult;
use tauri::AppHandle;

#[tauri::command]
pub async fn rdp_launch(app: AppHandle, profile_id: String) -> AppResult<()> {
    crate::rdp::launch(&app, &profile_id).await
}

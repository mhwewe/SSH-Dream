//! commands/ssh_cmds.rs — thin Tauri commands for sessions, host keys and terminals.
//!
//! Rule (README §6.3): validation + one call into a module, no protocol logic here.
//! Command names and argument names are EXACTLY the README §5.2 contract (Tauri converts the
//! camelCase argument names used by the frontend into the snake_case parameters below).
//!
//! These REPLACE the Handoff-1 stubs `session_connect`, `session_disconnect`, `session_state`.
//! Register them in lib.rs (see INTEGRATION.md).

use tauri::ipc::Channel;
use tauri::AppHandle;

use crate::ssh::{self, Overrides, SessionState, SshResult};

// ---- Session ---------------------------------------------------------------------------------

#[tauri::command]
pub async fn session_connect(app: AppHandle, profile_id: String, overrides: Option<Overrides>) -> SshResult<String> {
    ssh::session::connect(&app, &profile_id, overrides.unwrap_or_default()).await
}

#[tauri::command]
pub async fn session_disconnect(app: AppHandle, session_id: String) -> SshResult<()> {
    ssh::session::disconnect(&app, &session_id).await
}

#[tauri::command]
pub fn session_state(app: AppHandle, session_id: String) -> SessionState {
    ssh::session::state(&app, &session_id)
}

// ---- Host keys -------------------------------------------------------------------------------

#[tauri::command]
pub fn host_key_decide(app: AppHandle, prompt_id: String, accept: bool, remember: bool) -> SshResult<()> {
    ssh::hostkeys::decide(&app, &prompt_id, accept, remember)
}

// ---- Terminal --------------------------------------------------------------------------------

/// `onData` (JS) arrives here as `on_data`; bytes are sent as a JSON array of numbers.
#[tauri::command]
pub async fn term_open(app: AppHandle, session_id: String, cols: u32, rows: u32, on_data: Channel<Vec<u8>>) -> SshResult<String> {
    ssh::terminal::open(&app, &session_id, cols, rows, on_data).await
}

#[tauri::command]
pub fn term_write(app: AppHandle, channel_id: String, data: Vec<u8>) -> SshResult<()> {
    ssh::terminal::write(&app, &channel_id, data)
}

#[tauri::command]
pub fn term_resize(app: AppHandle, channel_id: String, cols: u32, rows: u32) -> SshResult<()> {
    ssh::terminal::resize(&app, &channel_id, cols, rows)
}

#[tauri::command]
pub fn term_close(app: AppHandle, channel_id: String) -> SshResult<()> {
    ssh::terminal::close(&app, &channel_id)
}

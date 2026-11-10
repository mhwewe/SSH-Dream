//! commands/sftp_cmds.rs — thin Tauri commands for SFTP and transfers (README §5.2, Handoff 3).
//!
//! Rule (README §6.3): validation + ONE call into a module (sftp/remote.rs or sftp/transfer.rs).
//! Argument names are the README contract (camelCase in JS -> snake_case here).

use tauri::ipc::Channel;
use tauri::AppHandle;

use crate::sftp::remote::{self, FileEntry};
use crate::sftp::transfer::{self, Action, Direction, TransferProgress};
use crate::ssh::SshResult;

#[tauri::command]
pub async fn sftp_open(app: AppHandle, session_id: String) -> SshResult<String> {
    remote::open(&app, &session_id).await
}

#[tauri::command]
pub async fn sftp_close(app: AppHandle, sftp_id: String) -> SshResult<()> {
    remote::close(&app, &sftp_id).await
}

#[tauri::command]
pub async fn sftp_home(app: AppHandle, sftp_id: String) -> SshResult<String> {
    remote::home(&app, &sftp_id).await
}

#[tauri::command]
pub async fn sftp_list(app: AppHandle, sftp_id: String, path: String) -> SshResult<Vec<FileEntry>> {
    remote::list(&app, &sftp_id, &path).await
}

#[tauri::command]
pub async fn sftp_mkdir(app: AppHandle, sftp_id: String, path: String) -> SshResult<()> {
    remote::mkdir(&app, &sftp_id, &path).await
}

/// `from` / `to` are full remote paths.
#[tauri::command]
pub async fn sftp_rename(app: AppHandle, sftp_id: String, from: String, to: String) -> SshResult<()> {
    remote::rename(&app, &sftp_id, &from, &to).await
}

/// File, symlink or folder (folders are removed recursively).
#[tauri::command]
pub async fn sftp_remove(app: AppHandle, sftp_id: String, path: String) -> SshResult<()> {
    remote::remove(&app, &sftp_id, &path).await
}

/// `local_path` / `remote_path` = full path of the item on each side (see transfer.rs header).
#[tauri::command]
pub fn transfer_start(
    app: AppHandle,
    sftp_id: String,
    direction: Direction,
    local_path: String,
    remote_path: String,
    on_progress: Channel<TransferProgress>,
) -> SshResult<String> {
    transfer::start(&app, &sftp_id, direction, local_path, remote_path, on_progress)
}

#[tauri::command]
pub fn transfer_cancel(app: AppHandle, transfer_id: String) -> SshResult<()> {
    transfer::cancel(&app, &transfer_id)
}

#[tauri::command]
pub fn transfer_resolve(app: AppHandle, transfer_id: String, action: Action, apply_to_all: bool) -> SshResult<()> {
    transfer::resolve(&app, &transfer_id, action, apply_to_all)
}

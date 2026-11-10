//! commands/sftp_cmds.rs — thin Tauri commands for SFTP and transfers (README §5.2, Handoff 3).
//!
//! Rule (README §6.3): validation + ONE call into a module (sftp/remote.rs or sftp/transfer.rs).
//! Argument names are the README contract (camelCase in JS -> snake_case here).

use tauri::ipc::Channel;
use tauri::AppHandle;

use crate::sftp::dragout::{self, DragFile};
use crate::sftp::edit::{self, EditEvent};
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

/// A fresh temp folder for files that are about to be dragged out into Explorer. Folders older than a day
/// (left by earlier runs) are removed first, best effort.
#[tauri::command]
pub fn drag_cache_dir() -> Result<String, String> {
    let root = std::env::temp_dir().join("ssh-dream-drag");
    if let Ok(rd) = std::fs::read_dir(&root) {
        for e in rd.flatten() {
            let old = e
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .map(|d| d.as_secs() > 86_400)
                .unwrap_or(false);
            if old {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }
    let dir = root.join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Drag-out step 1: flatten the dragged remote items (folders are walked) into a list of files.
/// Called by the UI as soon as the user starts dragging rows, so it is ready when the pointer reaches the window edge.
#[tauri::command]
pub async fn sftp_drag_plan(app: AppHandle, sftp_id: String, remote_paths: Vec<String>) -> SshResult<Vec<DragFile>> {
    dragout::plan(&app, &sftp_id, remote_paths).await
}

/// Drag-out step 2: start Windows' own drag with virtual files (Explorer pulls the bytes straight from the server).
/// Resolves when the drag ends. The mouse button must still be held when this is called.
/// `on_progress` feeds the Transfers list (one row per dragged item; same events as `transfer_start`).
#[tauri::command]
pub async fn sftp_drag_start(
    app: AppHandle,
    sftp_id: String,
    files: Vec<DragFile>,
    on_progress: Channel<TransferProgress>,
) -> SshResult<()> {
    dragout::start(&app, &sftp_id, files, on_progress).await
}

/// "Open in default app": download the remote file to a temp folder, launch the program Windows associates with it,
/// and upload the file back every time it is saved. Resolves once the app was launched; `on_event` keeps reporting
/// (uploading / saved / conflict / error ...) for as long as the SFTP view stays open. Returns the editId.
#[tauri::command]
pub async fn sftp_edit_open(app: AppHandle, sftp_id: String, remote_path: String, on_event: Channel<EditEvent>) -> SshResult<String> {
    edit::open(&app, &sftp_id, &remote_path, on_event).await
}

/// Answer to an edit event with state "conflict" (the server copy changed meanwhile):
/// `overwrite` = true replaces the server copy with the edited file, false keeps the server copy.
#[tauri::command]
pub fn sftp_edit_resolve(app: AppHandle, edit_id: String, overwrite: bool) -> SshResult<()> {
    edit::resolve(&app, &edit_id, overwrite)
}

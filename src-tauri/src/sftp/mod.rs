//! sftp/mod.rs — shared state for the SFTP layer (Handoff 3).
//!
//! PURPOSE
//!   Holds the managed state `SftpManager` (registered once in lib.rs with
//!   `.manage(sftp::SftpManager::new())`) and the cleanup hook `close_session` that
//!   `ssh::session::cleanup` calls when a session ends.
//!
//! WHO CALLS IT
//!   commands/sftp_cmds.rs (thin Tauri commands) and ssh/session.rs (close_session).
//! WHAT IT CALLS
//!   remote.rs (SFTP handle + remote file operations), transfer.rs (upload/download jobs).
//!
//! DESIGN NOTE (deviation from HANDOFF-3 §4.1, recorded in HANDOFF-LOG)
//!   The plan suggests `SessionEntry.sftp`. H2 keeps its state in `SshManager`; to avoid touching
//!   H2's struct (and holding its std mutex around SFTP bookkeeping) the SFTP handles live in this
//!   separate manager, keyed by `sftpId`, and remember which `sessionId` they belong to.
//!   Rule (same as H2): never hold a std mutex guard across an `.await`.

use std::collections::HashMap;
use std::sync::atomic::AtomicUsize;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh_sftp::client::SftpSession;
use tauri::AppHandle;
use tokio::sync::Semaphore;

use crate::ssh::{emit_log, lock};

pub mod dragout;   // drag remote items OUT into Windows Explorer (virtual files, no temp files)
pub mod dragprogress; // progress bookkeeping of those drags (rows of the Transfers list; pure std, unit-tested)
pub mod edit;      // open a remote file in the default Windows app, upload every save back (notify + tauri-plugin-opener)
pub mod remote;
pub mod transfer;

/// How many transfers may run at the same time (HANDOFF-3 §4.3). Others stay "queued".
pub const MAX_CONCURRENT_TRANSFERS: usize = 2;

/// One open SFTP subsystem channel.
pub struct SftpEntry {
    pub session_id: String,
    /// `SftpSession` methods take `&self`, so an `Arc` can be shared with transfer tasks.
    pub sftp: Arc<SftpSession>,
}

/// Managed Tauri state for SFTP.
pub struct SftpManager {
    /// sftpId -> open SFTP channel.
    pub entries: Mutex<HashMap<String, SftpEntry>>,
    /// transferId -> control block of a queued/running transfer.
    pub jobs: Mutex<HashMap<String, Arc<transfer::JobCtl>>>,
    /// "Apply to all" answer for file conflicts. Lives while at least one transfer is active and is
    /// cleared when the queue becomes idle again (so it never leaks into the next batch).
    pub apply_all: Mutex<Option<transfer::Action>>,
    /// Number of transfers that were started and have not finished yet.
    pub active: AtomicUsize,
    /// Limits running transfers to MAX_CONCURRENT_TRANSFERS (FIFO fair).
    pub slots: Arc<Semaphore>,
}

impl SftpManager {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            jobs: Mutex::new(HashMap::new()),
            apply_all: Mutex::new(None),
            active: AtomicUsize::new(0),
            slots: Arc::new(Semaphore::new(MAX_CONCURRENT_TRANSFERS)),
        }
    }
}

/// Called by `ssh::session::cleanup` (single teardown function of H2). Idempotent.
/// * every SFTP handle of the session is dropped,
/// * every transfer that belongs to one of them is aborted and reports an `error`
///   ("connection closed"), never a panic or a hang.
pub async fn close_session(app: &AppHandle, session_id: &str) {
    use tauri::Manager;
    let mgr = app.state::<SftpManager>();

    // 1. Remove the handles (short lock, no await inside).
    let removed: Vec<(String, SftpEntry)> = {
        let mut g = lock(&mgr.entries);
        let ids: Vec<String> = g.iter().filter(|(_, e)| e.session_id == session_id).map(|(k, _)| k.clone()).collect();
        ids.into_iter().filter_map(|id| g.remove(&id).map(|e| (id, e))).collect()
    };
    if removed.is_empty() {
        return;
    }

    // 2. Abort their transfers.
    for (sftp_id, _) in &removed {
        transfer::abort_for_sftp(app, sftp_id, "The connection was closed during the transfer.");
        edit::abort_for_sftp(app, sftp_id, "The connection was closed."); // "Open in default app" sessions
    }

    // 3. Best-effort close (the connection is going away anyway, so keep it short).
    for (_, e) in removed {
        let _ = tokio::time::timeout(Duration::from_millis(500), e.sftp.close()).await;
    }
    emit_log(app, Some(session_id), "info", "SFTP channel closed.");
}

//! ssh/mod.rs — shared types and state for the SSH layer (Handoff 2).
//!
//! PURPOSE
//!   Holds everything the other ssh/* files share: the error type returned to the frontend,
//!   the session manager (`SshManager`, registered once with `app.manage(...)`), and the two
//!   small emit helpers for the `session://log` and `session://state` events (README §5.3).
//!
//! WHO CALLS IT
//!   commands/ssh_cmds.rs (thin Tauri commands) and ssh/{session,terminal,hostkeys}.rs.
//!
//! DEVIATION FROM HANDOFF-2 §4.1 (recorded in HANDOFF-LOG): the plan puts the session map into
//! `AppState` (state.rs). Since the Handoff-1 code was not available while writing this, the
//! manager is a SEPARATE managed state (`SshManager`). Handoff 3 should add its SFTP handles to
//! `SessionEntry` here, and use `session::get_handle()` to open channels.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use russh::client::Handle;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};

pub mod glue;
pub mod hostkeys;
pub mod session;
pub mod terminal;

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/// Error returned by every ssh command. Serializes to `{ code, message }` = README `AppError`.
/// If Handoff 1 already has `crate::error::AppError`, add `impl From<SshErr> for AppError`
/// (or replace this type by it) — the JSON shape is identical.
#[derive(Debug, Clone, Serialize)]
pub struct SshErr {
    pub code: String,
    pub message: String,
}

impl SshErr {
    /// `code` must be one of the README codes ("auth_failed", "network", "invalid", ...).
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.to_string(), message: message.into() }
    }
}

pub type SshResult<T> = Result<T, SshErr>;

/// Lock a std mutex and keep going even if another thread panicked while holding it.
pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

// ---------------------------------------------------------------------------------------------
// Contract types
// ---------------------------------------------------------------------------------------------

/// README `SessionState`. Serializes as "disconnected" | "connecting" | "connected" | "error".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionState {
    Disconnected,
    Connecting,
    Connected,
    Error,
}

/// Optional secrets the frontend passes to `session_connect` (README §5.2).
/// NOTE: deliberately no `Debug` derive, so a password can never end up in a log by accident.
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Overrides {
    pub ssh_password: Option<String>,
    pub key_passphrase: Option<String>,
}

/// The user's answer to a host-key prompt (`host_key_decide`).
pub struct Decision {
    pub accept: bool,
    pub remember: bool,
}

// ---------------------------------------------------------------------------------------------
// Session manager
// ---------------------------------------------------------------------------------------------

/// Handle to one open terminal: commands are pushed into the terminal's tokio task.
pub struct TerminalHandle {
    pub tx: mpsc::UnboundedSender<terminal::TermCmd>,
}

/// One live SSH connection (README: "profile != connection").
pub struct SessionEntry {
    pub profile_id: String,
    /// THE one ssh connection. Every terminal / SFTP is a channel opened on it.
    /// Lock it only briefly (open a channel, disconnect); never hold it across long awaits.
    pub handle: Arc<AsyncMutex<Handle<session::ClientHandler>>>,
    /// channelId -> terminal task handle.
    pub terminals: HashMap<String, TerminalHandle>,
    // H3 adds here:  pub sftp: HashMap<String, SftpHandle>,
}

/// Everything protected by ONE std mutex (so related maps can never disagree).
/// Rule: never hold this lock across an `.await` — clone the Arc / sender out first.
#[derive(Default)]
pub struct Inner {
    /// sessionId -> live session.
    pub sessions: HashMap<String, SessionEntry>,
    /// profileId -> sessionId (a second "Log in" returns the existing id).
    pub by_profile: HashMap<String, String>,
    /// profileId -> sessionId for logins currently in progress.
    pub connecting: HashMap<String, String>,
    /// channelId -> sessionId, so term_write/resize/close find their terminal quickly.
    pub term_index: HashMap<String, String>,
}

/// A host-key prompt waiting for the user (resolved by `host_key_decide`).
pub struct PendingPrompt {
    pub session_id: String,
    pub tx: oneshot::Sender<Decision>,
}

/// Managed Tauri state. Register once:  `.manage(ssh::SshManager::default())`.
#[derive(Default)]
pub struct SshManager {
    pub inner: Mutex<Inner>,
    /// promptId -> waiting oneshot. Entries are removed on decision, timeout and disconnect.
    pub prompts: Mutex<HashMap<String, PendingPrompt>>,
}

// ---------------------------------------------------------------------------------------------
// Events (README §5.3)
// ---------------------------------------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LogEvent {
    session_id: Option<String>,
    ts: String,
    level: &'static str,
    message: String,
}

/// Emit `session://log`. `level` = "info" | "warn" | "error". NEVER pass secrets in `message`.
pub fn emit_log(app: &AppHandle, session_id: Option<&str>, level: &'static str, message: impl Into<String>) {
    let ev = LogEvent {
        session_id: session_id.map(str::to_string),
        ts: chrono::Utc::now().to_rfc3339(),
        level,
        message: message.into(),
    };
    let _ = app.emit("session://log", ev);
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StateEvent<'a> {
    session_id: &'a str,
    profile_id: &'a str,
    state: SessionState,
}

/// Emit `session://state`.
pub fn emit_state(app: &AppHandle, session_id: &str, profile_id: &str, state: SessionState) {
    let _ = app.emit("session://state", StateEvent { session_id, profile_id, state });
}

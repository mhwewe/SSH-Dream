// =============================================================================
// state.rs — global app state managed by Tauri (`app.manage`). Commands receive it as
// `State<'_, AppState>`.
// H1: the sessions map stays EMPTY. Handoff 2 stores live russh sessions here
// (profile_id -> session handle, channels...). Never hold a Mutex guard across an `.await`.
// =============================================================================
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;

/// README §5.1 `SessionState` (serialized lowercase: "disconnected", "connecting", ...).
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[allow(dead_code)]
pub enum SessionState { Disconnected, Connecting, Connected, Error }

/// Placeholder per-session record; Handoff 2 will extend it (handle, channels, ...).
#[allow(dead_code)]
pub struct SessionInfo {
    pub profile_id: String,
    pub state: SessionState,
}

#[derive(Default)]
#[allow(dead_code)]
pub struct AppState {
    /// sessionId -> info. One profile has at most one live session (README §3, idea 1).
    pub sessions: Mutex<HashMap<String, SessionInfo>>,
}

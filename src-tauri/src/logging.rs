// =============================================================================
// logging.rs — emits `session://log` events that the frontend Log pane displays.
// Called by: every module/command that does something noteworthy.
// RULE: NEVER pass a password/passphrase/secret into `msg`.
// =============================================================================
use chrono::SecondsFormat;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
#[allow(dead_code)] // `Error` is part of the log contract even if nothing emits it yet
pub enum LogLevel { Info, Warn, Error }

/// Shape = README §5.1 `LogEvent`.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LogEvent {
    pub session_id: Option<String>,
    pub ts: String,
    pub level: LogLevel,
    pub message: String,
}

pub fn emit_log(app: &AppHandle, session_id: Option<&str>, level: LogLevel, msg: impl Into<String>) {
    let ev = LogEvent {
        session_id: session_id.map(|s| s.to_string()),
        ts: chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        level,
        message: msg.into(),
    };
    // Ignore emit errors: logging must never break a command.
    let _ = app.emit("session://log", ev);
}

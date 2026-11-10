// =============================================================================
// error.rs — the single error type every command returns (README §5.1 `AppError`).
// Serialized to JS as { code, message }. Codes in use: not_found | io | invalid | auth_failed |
// network | host_key_rejected | secret_store | not_implemented | cancelled | internal
// Called by: every module.
// =============================================================================
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Clone, Serialize, Error)]
#[error("{code}: {message}")]
pub struct AppError {
    pub code: String,
    pub message: String,
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.to_string(), message: message.into() }
    }
    pub fn invalid(m: impl Into<String>) -> Self { Self::new("invalid", m) }
    pub fn not_found(m: impl Into<String>) -> Self { Self::new("not_found", m) }
    pub fn io(m: impl Into<String>) -> Self { Self::new("io", m) }
    pub fn internal(m: impl Into<String>) -> Self { Self::new("internal", m) }
    pub fn not_implemented(m: impl Into<String>) -> Self { Self::new("not_implemented", m) }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self { Self::io(e.to_string()) }
}
impl From<serde_json::Error> for AppError {
    // A JSON that cannot be parsed is bad input, not an internal bug.
    fn from(e: serde_json::Error) -> Self { Self::invalid(format!("JSON error: {e}")) }
}
impl From<keyring::Error> for AppError {
    fn from(e: keyring::Error) -> Self { Self::new("secret_store", e.to_string()) }
}

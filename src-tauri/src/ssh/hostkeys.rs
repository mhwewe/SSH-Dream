//! ssh/hostkeys.rs — known_hosts.json storage + the "do you trust this server?" prompt flow.
//!
//! WHO CALLS IT:  session.rs (`ClientHandler::check_server_key` calls `verify`) and the
//!                `host_key_decide` command (calls `decide`).
//! FILE FORMAT (README §5.5 / HANDOFF-2 §4.3):
//!   { "version":1, "hosts": { "host:port": { "algorithm", "fingerprintSha256", "firstSeen" } } }
//!
//! Flow in `verify`: known+equal -> trust silently; unknown/changed -> emit `hostkey://prompt`,
//! wait (max 120 s) on a oneshot that `host_key_decide` fulfils; timeout = reject.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

use super::{emit_log, lock, Decision, PendingPrompt, SshErr, SshManager, SshResult};

const PROMPT_TIMEOUT: Duration = Duration::from_secs(120);

/// Serializes read-modify-write of the file when two connections finish at the same time.
static FILE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize, Default)]
struct KnownFile {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    hosts: HashMap<String, KnownHost>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct KnownHost {
    algorithm: String,
    fingerprint_sha256: String,
    first_seen: String,
}

/// Payload of `hostkey://prompt` (README `HostKeyPrompt`).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct HostKeyPrompt {
    prompt_id: String,
    session_id: String,
    host: String,
    port: u16,
    algorithm: String,
    fingerprint_sha256: String,
    /// "unknown" | "changed"
    status: &'static str,
}

#[derive(PartialEq, Eq)]
enum Verdict {
    Unknown,
    Match,
    Changed,
}

fn file_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("known_hosts.json"))
}

fn load(app: &AppHandle) -> KnownFile {
    // A missing or corrupt file simply means "nothing known yet".
    file_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save(app: &AppHandle, mut file: KnownFile) -> SshResult<()> {
    file.version = 1;
    let path = file_path(app).ok_or_else(|| SshErr::new("io", "No app data folder."))?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| SshErr::new("io", format!("Cannot create folder: {e}")))?;
    }
    let text = serde_json::to_string_pretty(&file).map_err(|e| SshErr::new("internal", e.to_string()))?;
    // Write to a temp file first so a crash cannot leave a half-written known_hosts.json.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| SshErr::new("io", format!("Cannot write known hosts: {e}")))?;
    std::fs::rename(&tmp, &path).map_err(|e| SshErr::new("io", format!("Cannot write known hosts: {e}")))
}

fn key_of(host: &str, port: u16) -> String {
    format!("{}:{}", host.to_lowercase(), port)
}

fn check(app: &AppHandle, host: &str, port: u16, fingerprint: &str) -> Verdict {
    let _g = lock_file();
    match load(app).hosts.get(&key_of(host, port)) {
        None => Verdict::Unknown,
        Some(k) if k.fingerprint_sha256 == fingerprint => Verdict::Match,
        Some(_) => Verdict::Changed,
    }
}

fn lock_file() -> std::sync::MutexGuard<'static, ()> {
    FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

fn remember(app: &AppHandle, host: &str, port: u16, algorithm: &str, fingerprint: &str) -> SshResult<()> {
    let _g = lock_file();
    let mut file = load(app);
    file.hosts.insert(
        key_of(host, port),
        KnownHost {
            algorithm: algorithm.to_string(),
            fingerprint_sha256: fingerprint.to_string(),
            first_seen: chrono::Utc::now().to_rfc3339(),
        },
    );
    save(app, file)
}

/// Decide whether to trust the server key. Returns true = continue the connection.
/// Called from `ClientHandler::check_server_key` (inside russh's key exchange), so it may
/// legitimately wait for the user for up to 120 s.
pub async fn verify(app: &AppHandle, session_id: &str, host: &str, port: u16, algorithm: &str, fingerprint: &str) -> bool {
    let verdict = check(app, host, port, fingerprint);
    if verdict == Verdict::Match {
        return true;
    }
    let status = if verdict == Verdict::Changed { "changed" } else { "unknown" };
    if verdict == Verdict::Changed {
        emit_log(app, Some(session_id), "warn", "WARNING: the host key of this server has CHANGED since the last connection.");
    }

    let mgr = app.state::<SshManager>();
    let prompt_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel::<Decision>();
    lock(&mgr.prompts).insert(prompt_id.clone(), PendingPrompt { session_id: session_id.to_string(), tx });

    let _ = app.emit(
        "hostkey://prompt",
        HostKeyPrompt {
            prompt_id: prompt_id.clone(),
            session_id: session_id.to_string(),
            host: host.to_string(),
            port,
            algorithm: algorithm.to_string(),
            fingerprint_sha256: fingerprint.to_string(),
            status,
        },
    );

    let outcome = tokio::time::timeout(PROMPT_TIMEOUT, rx).await;
    // Always drop the pending entry (timeout / disconnect must not leak senders).
    lock(&mgr.prompts).remove(&prompt_id);

    match outcome {
        Ok(Ok(d)) => {
            if d.accept && d.remember {
                if let Err(e) = remember(app, host, port, algorithm, fingerprint) {
                    emit_log(app, Some(session_id), "warn", format!("Could not save the host key: {}", e.message));
                }
            }
            d.accept
        }
        // Sender dropped: the session was cancelled/disconnected while the prompt was open.
        Ok(Err(_)) => false,
        Err(_) => {
            emit_log(app, Some(session_id), "warn", "Host key prompt timed out; connection refused.");
            false
        }
    }
}

/// `host_key_decide(promptId, accept, remember)` — resolves the waiting `verify`.
pub fn decide(app: &AppHandle, prompt_id: &str, accept: bool, remember: bool) -> SshResult<()> {
    let mgr = app.state::<SshManager>();
    let pending = lock(&mgr.prompts).remove(prompt_id);
    match pending {
        Some(p) => {
            // If the receiver is already gone (timeout) the send simply fails; that's fine.
            let _ = p.tx.send(Decision { accept, remember });
            Ok(())
        }
        None => Err(SshErr::new("not_found", "This host key prompt is no longer active.")),
    }
}

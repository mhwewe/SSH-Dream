//! ssh/session.rs — real SSH sessions (HANDOFF-2 §4.1, §4.2, §4.5).
//!
//! WHO CALLS IT:  commands/ssh_cmds.rs  (session_connect / session_disconnect / session_state).
//! WHAT IT CALLS: glue.rs (profile + secrets), hostkeys.rs (via ClientHandler), russh.
//!
//! Written against russh 0.65.x (latest at time of writing). API facts used, taken from that
//! version's bundled examples:
//!   * `client::Handler::check_server_key(&mut self, &PublicKeyOrCertificate)`  (native async fn)
//!   * `client::connect_stream(config, stream, handler)`
//!   * `authenticate_password / authenticate_publickey` return `AuthResult` (`.success()`)
//!   * `PrivateKeyWithHashAlg::new(Arc<PrivateKey>, handle.best_supported_rsa_hash()...flatten())`
//!   * `Handler::disconnected(DisconnectReason<Self::Error>)`
//! If you pin a different russh version, these are the lines to re-check.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, DisconnectReason, Handle, KeyboardInteractiveAuthResponse};
use russh::keys::{HashAlg, PrivateKey, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::Disconnect;
use tauri::{AppHandle, Manager};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Mutex as AsyncMutex};

use super::glue::{self, ProfileLite};
use super::{
    emit_log, emit_state, hostkeys, lock, Overrides, SessionEntry, SessionState, SshErr, SshManager, SshResult,
};

const TCP_TIMEOUT: Duration = Duration::from_secs(15);
/// Key exchange + host key check. Must be longer than the 120 s host-key prompt timeout.
const KEX_TIMEOUT: Duration = Duration::from_secs(150);
const AUTH_TIMEOUT: Duration = Duration::from_secs(30);
const KEEPALIVE: Duration = Duration::from_secs(30);

// ---------------------------------------------------------------------------------------------
// russh handler
// ---------------------------------------------------------------------------------------------

/// Error type required by `client::Handler` (must be `From<russh::Error> + Send + Debug`).
#[derive(Debug)]
#[allow(dead_code)] // the payload is only used through Debug
pub enum HandlerErr {
    Russh(russh::Error),
}

impl From<russh::Error> for HandlerErr {
    fn from(e: russh::Error) -> Self {
        HandlerErr::Russh(e)
    }
}

/// One per connection. Receives russh callbacks.
pub struct ClientHandler {
    app: AppHandle,
    session_id: String,
    host: String,
    port: u16,
    /// Set when the USER (or the 120 s timeout) refused the host key, so `connect` can report
    /// `host_key_rejected` instead of a generic network error.
    rejected: Arc<AtomicBool>,
    /// Tells the watcher task that the connection ended (text = reason for the log).
    lost_tx: mpsc::UnboundedSender<String>,
}

impl client::Handler for ClientHandler {
    type Error = HandlerErr;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        // Host certificates are not supported (out of scope); refuse them explicitly.
        let PublicKeyOrCertificate::PublicKey { key, .. } = key else {
            emit_log(&self.app, Some(&self.session_id), "error", "The server presented a host certificate, which is not supported.");
            self.rejected.store(true, Ordering::SeqCst);
            return Ok(false);
        };

        // Standard "SHA256:base64" form, from the ssh-key crate (no hand-rolled hashing).
        let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
        let algorithm = key.algorithm().to_string();
        emit_log(&self.app, Some(&self.session_id), "info", format!("Host key fingerprint: {fingerprint}"));

        let ok = hostkeys::verify(&self.app, &self.session_id, &self.host, self.port, &algorithm, &fingerprint).await;
        if !ok {
            self.rejected.store(true, Ordering::SeqCst);
        }
        Ok(ok)
    }

    /// Called when the connection ends for any reason (server closed, network error, our own
    /// disconnect). We forward a human-readable reason to the watcher and keep russh's contract:
    /// re-return the error if the reason was an error.
    async fn disconnected(&mut self, reason: DisconnectReason<Self::Error>) -> Result<(), Self::Error> {
        let text = match &reason {
            DisconnectReason::ReceivedDisconnect(info) => {
                let m = info.message.trim();
                if m.is_empty() {
                    "The server closed the connection.".to_string()
                } else {
                    format!("The server closed the connection: {m}")
                }
            }
            DisconnectReason::Error(e) => format!("Connection lost: {e:?}"),
        };
        let _ = self.lost_tx.send(text);
        match reason {
            DisconnectReason::ReceivedDisconnect(_) => Ok(()),
            DisconnectReason::Error(e) => Err(e),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------------------------

enum Cred {
    Password(String),
    Key(Arc<PrivateKey>),
}

/// Collect/prepare credentials BEFORE touching the network, so "password_required" and
/// "passphrase_required" come back immediately and the user is not asked about the host key first.
async fn prepare_credentials(profile: &ProfileLite, ov: &Overrides) -> SshResult<Cred> {
    if profile.ssh.auth_method == "publickey" {
        let path = profile
            .ssh
            .key_path
            .clone()
            .filter(|p| !p.trim().is_empty())
            .ok_or_else(|| SshErr::new("invalid", "No private key file is set in this profile."))?;
        let passphrase = match ov.key_passphrase.clone().filter(|p| !p.is_empty()) {
            Some(p) => Some(p),
            None => glue::get_secret(&profile.id, "key_passphrase")?,
        };
        let has_pass = passphrase.is_some();
        // Key decryption is slow on purpose (KDF) -> do it on the blocking pool.
        let loaded = tokio::task::spawn_blocking(move || russh::keys::load_secret_key(path, passphrase.as_deref()))
            .await
            .map_err(|e| SshErr::new("internal", format!("Key loading task failed: {e}")))?;
        return match loaded {
            Ok(k) => Ok(Cred::Key(Arc::new(k))),
            Err(e) => {
                let msg = e.to_string().to_lowercase();
                if !has_pass && msg.contains("encrypted") {
                    Err(SshErr::new("auth_failed", "passphrase_required"))
                } else if has_pass {
                    // Never echo the passphrase; the underlying error text does not contain it.
                    Err(SshErr::new("auth_failed", format!("Could not unlock the private key (wrong passphrase?): {e}")))
                } else {
                    Err(SshErr::new("invalid", format!("Could not read the private key file: {e}")))
                }
            }
        };
    }

    // Password auth.
    let pw = match ov.ssh_password.clone().filter(|p| !p.is_empty()) {
        Some(p) => Some(p),
        None => glue::get_secret(&profile.id, "ssh")?,
    };
    match pw {
        Some(p) => Ok(Cred::Password(p)),
        None => Err(SshErr::new("auth_failed", "password_required")),
    }
}

fn net(e: impl std::fmt::Debug) -> SshErr {
    SshErr::new("network", format!("{e:?}"))
}

// ---------------------------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------------------------

/// `session_connect`. Returns the (new or existing) session id.
pub async fn connect(app: &AppHandle, profile_id: &str, ov: Overrides) -> SshResult<String> {
    let mgr = app.state::<SshManager>();
    let session_id = uuid::Uuid::new_v4().to_string();

    // Existing session -> no-op returning its id. Login already running -> refuse politely.
    {
        let mut g = lock(&mgr.inner);
        if let Some(existing) = g.by_profile.get(profile_id) {
            return Ok(existing.clone());
        }
        if g.connecting.contains_key(profile_id) {
            return Err(SshErr::new("invalid", "A login for this profile is already in progress."));
        }
        g.connecting.insert(profile_id.to_string(), session_id.clone());
    }
    emit_state(app, &session_id, profile_id, SessionState::Connecting);

    let result = establish(app, &session_id, profile_id, &ov).await;

    // Login is over (either way): leave the "connecting" set.
    lock(&mgr.inner).connecting.remove(profile_id);

    match result {
        Ok((handle, lost_rx)) => {
            {
                let mut g = lock(&mgr.inner);
                g.sessions.insert(
                    session_id.clone(),
                    SessionEntry {
                        profile_id: profile_id.to_string(),
                        handle: Arc::new(AsyncMutex::new(handle)),
                        terminals: Default::default(),
                    },
                );
                g.by_profile.insert(profile_id.to_string(), session_id.clone());
            }
            emit_state(app, &session_id, profile_id, SessionState::Connected);
            spawn_watcher(app.clone(), session_id.clone(), lost_rx);
            Ok(session_id)
        }
        Err(e) => {
            // password_required / passphrase_required are not failures, just "ask the user".
            let soft = e.code == "auth_failed" && (e.message == "password_required" || e.message == "passphrase_required");
            if !soft {
                emit_log(app, Some(&session_id), "error", e.message.clone());
            }
            let state = if soft { SessionState::Disconnected } else { SessionState::Error };
            emit_state(app, &session_id, profile_id, state);
            Err(e)
        }
    }
}

/// TCP + key exchange (+ host key check) + authentication. Returns the live handle and the
/// receiver on which the handler will report that the connection ended.
async fn establish(
    app: &AppHandle,
    session_id: &str,
    profile_id: &str,
    ov: &Overrides,
) -> SshResult<(Handle<ClientHandler>, mpsc::UnboundedReceiver<String>)> {
    let profile = glue::load_profile(app, profile_id)?;
    let host = profile.ssh.host.trim().to_string();
    let user = profile.ssh.username.trim().to_string();
    if host.is_empty() || user.is_empty() {
        return Err(SshErr::new("invalid", "Host and username are required."));
    }
    let port = profile.ssh.port;

    let cred = prepare_credentials(&profile, ov).await?;

    emit_log(app, Some(session_id), "info", format!("Connecting to {host}:{port}…"));
    let tcp = tokio::time::timeout(TCP_TIMEOUT, TcpStream::connect((host.as_str(), port)))
        .await
        .map_err(|_| SshErr::new("network", format!("Connection to {host}:{port} timed out.")))?
        .map_err(|e| SshErr::new("network", format!("Cannot connect to {host}:{port}: {e}")))?;
    let _ = tcp.set_nodelay(true);

    let config = Arc::new(client::Config {
        keepalive_interval: Some(KEEPALIVE),
        keepalive_max: 3,
        inactivity_timeout: None,
        ..Default::default()
    });

    let (lost_tx, lost_rx) = mpsc::unbounded_channel();
    let rejected = Arc::new(AtomicBool::new(false));
    let handler = ClientHandler {
        app: app.clone(),
        session_id: session_id.to_string(),
        host: host.clone(),
        port,
        rejected: rejected.clone(),
        lost_tx,
    };

    let connected = tokio::time::timeout(KEX_TIMEOUT, client::connect_stream(config, tcp, handler)).await;
    let mut handle = match connected {
        Err(_) => return Err(SshErr::new("network", "Key exchange timed out.")),
        Ok(Err(e)) => {
            return Err(if rejected.load(Ordering::SeqCst) {
                SshErr::new("host_key_rejected", "The host key was not accepted. Connection cancelled.")
            } else {
                net(e)
            });
        }
        Ok(Ok(h)) => h,
    };
    // russh does not hand us the negotiated cipher without extra handler hooks, so keep it simple
    // (HANDOFF-2 §4.2 step 4 allows this).
    emit_log(app, Some(session_id), "info", "Key exchange completed.");

    let authed = tokio::time::timeout(AUTH_TIMEOUT, authenticate(app, session_id, &mut handle, &user, cred)).await;
    match authed {
        Err(_) => {
            let _ = handle.disconnect(Disconnect::ByApplication, "", "en").await;
            Err(SshErr::new("network", "Authentication timed out."))
        }
        Ok(Err(e)) => {
            let _ = handle.disconnect(Disconnect::ByApplication, "", "en").await;
            Err(e)
        }
        Ok(Ok(())) => Ok((handle, lost_rx)),
    }
}

async fn authenticate(app: &AppHandle, session_id: &str, handle: &mut Handle<ClientHandler>, user: &str, cred: Cred) -> SshResult<()> {
    let ok = match cred {
        Cred::Password(pw) => {
            emit_log(app, Some(session_id), "info", "Attempting password authentication.");
            let r = handle.authenticate_password(user, pw.as_str()).await.map_err(net)?;
            if r.success() {
                true
            } else {
                // Bitvise-style "password over keyboard-interactive" fallback (HANDOFF-2 §3).
                emit_log(app, Some(session_id), "info", "Password authentication was refused; trying keyboard-interactive.");
                kbdi_with_password(handle, user, &pw).await
            }
        }
        Cred::Key(key) => {
            emit_log(app, Some(session_id), "info", "Attempting public key authentication.");
            let hash = handle.best_supported_rsa_hash().await.map_err(net)?.flatten();
            let r = handle.authenticate_publickey(user, PrivateKeyWithHashAlg::new(key, hash)).await.map_err(net)?;
            r.success()
        }
    };
    if ok {
        emit_log(app, Some(session_id), "info", "Authentication completed.");
        Ok(())
    } else {
        emit_log(app, Some(session_id), "error", "Authentication failed.");
        Err(SshErr::new("auth_failed", "Authentication failed."))
    }
}

/// Answer every keyboard-interactive prompt with the password (max 5 rounds).
/// Any protocol error simply counts as "failed" — the caller reports `auth_failed`.
async fn kbdi_with_password(handle: &mut Handle<ClientHandler>, user: &str, pw: &str) -> bool {
    let Ok(mut reply) = handle.authenticate_keyboard_interactive_start(user, None::<String>).await else {
        return false;
    };
    for _ in 0..5 {
        match reply {
            KeyboardInteractiveAuthResponse::Success => return true,
            KeyboardInteractiveAuthResponse::Failure { .. } => return false,
            KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                let answers: Vec<String> = prompts.iter().map(|_| pw.to_string()).collect();
                match handle.authenticate_keyboard_interactive_respond(answers).await {
                    Ok(next) => reply = next,
                    Err(_) => return false,
                }
            }
        }
    }
    false
}

// ---------------------------------------------------------------------------------------------
// Disconnect / cleanup (single function — H3 extends it to close SFTP handles)
// ---------------------------------------------------------------------------------------------

/// Waits for the handler to report the end of the connection, then cleans up.
fn spawn_watcher(app: AppHandle, session_id: String, mut rx: mpsc::UnboundedReceiver<String>) {
    tauri::async_runtime::spawn(async move {
        // `None` = handler dropped without a message; treat it the same way.
        let reason = rx.recv().await.unwrap_or_else(|| "The connection ended.".to_string());
        cleanup(&app, &session_id, Some(reason)).await;
    });
}

/// Tear a session down. Idempotent: a second call finds nothing and returns.
/// `reason = None` means the user logged out; `Some(text)` means the server/network ended it.
pub async fn cleanup(app: &AppHandle, session_id: &str, reason: Option<String>) {
    let mgr = app.state::<SshManager>();

    // 1. Remove from the maps (short lock, no await inside).
    let entry = {
        let mut g = lock(&mgr.inner);
        let e = g.sessions.remove(session_id);
        if let Some(e) = &e {
            g.by_profile.remove(&e.profile_id);
            for ch in e.terminals.keys() {
                g.term_index.remove(ch);
            }
        }
        e
    };
    let Some(entry) = entry else { return };

    // 2. Cancel host-key prompts that belong to this session (drops their senders).
    lock(&mgr.prompts).retain(|_, p| p.session_id != session_id);

    // 3. Ask every terminal task to stop; each emits its own `term://closed`.
    for t in entry.terminals.values() {
        let _ = t.tx.send(super::terminal::TermCmd::Close);
    }
    // H3: drop this session's SFTP handles and abort its running transfers (they report an error).
    crate::sftp::close_session(app, session_id).await;

    // 4. Close the SSH connection (best effort, bounded).
    {
        let h = entry.handle.lock().await;
        let _ = tokio::time::timeout(Duration::from_secs(2), h.disconnect(Disconnect::ByApplication, "", "en")).await;
    }

    // 5. Tell the UI.
    match reason {
        None => emit_log(app, Some(session_id), "info", "Connection closed."),
        Some(r) => emit_log(app, Some(session_id), "warn", r),
    }
    emit_state(app, session_id, &entry.profile_id, SessionState::Disconnected);
}

/// `session_disconnect`.
pub async fn disconnect(app: &AppHandle, session_id: &str) -> SshResult<()> {
    cleanup(app, session_id, None).await;
    Ok(())
}

/// `session_state`.
pub fn state(app: &AppHandle, session_id: &str) -> SessionState {
    let mgr = app.state::<SshManager>();
    let g = lock(&mgr.inner);
    if g.sessions.contains_key(session_id) {
        SessionState::Connected
    } else if g.connecting.values().any(|s| s == session_id) {
        SessionState::Connecting
    } else {
        SessionState::Disconnected
    }
}

/// Helper for Handoff 3 (and terminal.rs): get the shared connection handle of a live session
/// so a new channel can be opened without touching this file.
pub fn get_handle(app: &AppHandle, session_id: &str) -> SshResult<Arc<AsyncMutex<Handle<ClientHandler>>>> {
    let mgr = app.state::<SshManager>();
    let g = lock(&mgr.inner);
    g.sessions
        .get(session_id)
        .map(|e| e.handle.clone())
        .ok_or_else(|| SshErr::new("not_found", "This session is not connected."))
}

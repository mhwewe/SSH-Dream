//! ssh/terminal.rs — terminal channels (PTY + shell) on an existing session (HANDOFF-2 §4.4).
//!
//! WHO CALLS IT:  commands/ssh_cmds.rs (term_open / term_write / term_resize / term_close).
//! WHAT IT CALLS: session::get_handle (to open a channel on the session's single connection).
//!
//! Design: ONE tokio task per terminal. The task `select!`s between
//!   * messages coming from the server channel  -> forwarded to the frontend through a
//!     `tauri::ipc::Channel` (ordered, fast) — coalesced to at most one send per ~8 ms;
//!   * commands pushed by term_write / term_resize / term_close through an mpsc queue.
//! The commands themselves only push into the queue (cheap, never blocks the UI thread).
//!
//! When the channel ends (shell exit, server drop, session logout) the task emits
//! `term://closed { channelId, sessionId, exitStatus? }` — the ONLY place that event is emitted.

use std::time::Duration;

use russh::ChannelMsg;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;
use tokio::time::Instant;

use super::{emit_log, glue, lock, session, SshErr, SshManager, SshResult, TerminalHandle};

/// Flush the output buffer at most this often (keeps IPC calm during `cat bigfile`).
const FLUSH_EVERY: Duration = Duration::from_millis(8);
/// ...or immediately when this much is buffered.
const FLUSH_BYTES: usize = 64 * 1024;

/// Messages for the terminal task.
pub enum TermCmd {
    Write(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

/// Payload of `term://closed` (README §5.3).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TermClosed {
    channel_id: String,
    session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_status: Option<u32>,
}

/// `term_open`: open a channel, request a PTY and a shell, start the task, return the channelId.
pub async fn open(app: &AppHandle, session_id: &str, cols: u32, rows: u32, on_data: Channel<Vec<u8>>) -> SshResult<String> {
    let mgr = app.state::<SshManager>();

    // Which profile does this session belong to? (for terminal.termType)
    let profile_id = {
        let g = lock(&mgr.inner);
        g.sessions
            .get(session_id)
            .map(|e| e.profile_id.clone())
            .ok_or_else(|| SshErr::new("not_found", "This session is not connected."))?
    };
    let term_type = glue::load_profile(app, &profile_id)?.terminal.term_type;

    // Open the channel on the shared connection (lock only for the open itself).
    let handle = session::get_handle(app, session_id)?;
    let channel = {
        let h = handle.lock().await;
        h.channel_open_session()
            .await
            .map_err(|e| SshErr::new("network", format!("Cannot open a terminal channel: {e:?}")))?
    };
    // want_reply=false for the PTY (as in russh's own example); shell with reply so errors show up.
    channel
        .request_pty(false, &term_type, cols.max(1), rows.max(1), 0, 0, &[])
        .await
        .map_err(|e| SshErr::new("network", format!("PTY request failed: {e:?}")))?;
    channel
        .request_shell(true)
        .await
        .map_err(|e| SshErr::new("network", format!("Shell request failed: {e:?}")))?;

    let channel_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::unbounded_channel::<TermCmd>();

    // Register. If the session vanished meanwhile (logout during open), close the channel again.
    // NOTE: the std MutexGuard must be fully out of scope BEFORE any `.await`, otherwise the
    // command future is not `Send` and Tauri refuses to compile it ("future cannot be sent between
    // threads safely"). So the lock lives in its own block that only computes a bool; the
    // `channel.close().await` happens after the block has ended.
    let registered = {
        let mut g = lock(&mgr.inner);
        if let Some(entry) = g.sessions.get_mut(session_id) {
            entry.terminals.insert(channel_id.clone(), TerminalHandle { tx });
            g.term_index.insert(channel_id.clone(), session_id.to_string());
            true
        } else {
            false
        }
    };
    if !registered {
        let _ = channel.close().await;
        return Err(SshErr::new("not_found", "The session was closed."));
    }

    emit_log(app, Some(session_id), "info", "Opened a terminal.");
    tauri::async_runtime::spawn(run_terminal(app.clone(), session_id.to_string(), channel_id.clone(), channel, rx, on_data));
    Ok(channel_id)
}

/// The per-terminal task (see module comment).
async fn run_terminal(
    app: AppHandle,
    session_id: String,
    channel_id: String,
    mut channel: russh::Channel<russh::client::Msg>,
    mut rx: mpsc::UnboundedReceiver<TermCmd>,
    on_data: Channel<Vec<u8>>,
) {
    let mut buf: Vec<u8> = Vec::new();
    let mut flush_at: Option<Instant> = None;
    let mut exit_status: Option<u32> = None;

    loop {
        // Timer branch: only "armed" while there is buffered output.
        let timer = flush_at;
        let flush_timer = async move {
            match timer {
                Some(t) => tokio::time::sleep_until(t).await,
                None => std::future::pending::<()>().await,
            }
        };

        tokio::select! {
            msg = channel.wait() => {
                match msg {
                    // stdout, and stderr (ExtendedData) both go to the terminal.
                    Some(ChannelMsg::Data { data }) => queue(&mut buf, &mut flush_at, &data),
                    Some(ChannelMsg::ExtendedData { data, .. }) => queue(&mut buf, &mut flush_at, &data),
                    Some(ChannelMsg::ExitStatus { exit_status: s }) => exit_status = Some(s),
                    Some(ChannelMsg::Failure) => {
                        emit_log(&app, Some(&session_id), "warn", "The server refused a terminal request (PTY or shell).");
                    }
                    // Channel finished (Close) or the whole connection is gone (None).
                    Some(ChannelMsg::Close) | None => break,
                    // Eof, Success, WindowAdjusted, ... nothing to do.
                    Some(_) => {}
                }
                if buf.len() >= FLUSH_BYTES && !flush(&mut buf, &mut flush_at, &on_data) {
                    break; // frontend side is gone
                }
            }
            cmd = rx.recv() => {
                match cmd {
                    Some(TermCmd::Write(bytes)) => {
                        if channel.data(&bytes[..]).await.is_err() { break; }
                    }
                    Some(TermCmd::Resize { cols, rows }) => {
                        // Errors here are harmless (channel closing); the wait() branch will notice.
                        let _ = channel.window_change(cols.max(1), rows.max(1), 0, 0).await;
                    }
                    // Explicit close, or every sender dropped.
                    Some(TermCmd::Close) | None => {
                        let _ = channel.close().await;
                        break;
                    }
                }
            }
            _ = flush_timer => {
                if !flush(&mut buf, &mut flush_at, &on_data) { break; }
            }
        }
    }

    // Final flush so the last bytes (e.g. the shell's goodbye) are not lost.
    let _ = flush(&mut buf, &mut flush_at, &on_data);

    // Unregister this terminal.
    {
        let mgr = app.state::<SshManager>();
        let mut g = lock(&mgr.inner);
        g.term_index.remove(&channel_id);
        if let Some(entry) = g.sessions.get_mut(&session_id) {
            entry.terminals.remove(&channel_id);
        }
    }

    match exit_status {
        Some(s) => emit_log(&app, Some(&session_id), "info", format!("Terminal closed (exit status {s}).")),
        None => emit_log(&app, Some(&session_id), "info", "Terminal closed."),
    }
    let _ = app.emit("term://closed", TermClosed { channel_id, session_id, exit_status });
}

/// Append bytes and arm the flush timer if it is not armed yet.
fn queue(buf: &mut Vec<u8>, flush_at: &mut Option<Instant>, data: &[u8]) {
    buf.extend_from_slice(data);
    if flush_at.is_none() {
        *flush_at = Some(Instant::now() + FLUSH_EVERY);
    }
}

/// Send the buffer to the frontend. Returns false if the frontend channel is dead.
fn flush(buf: &mut Vec<u8>, flush_at: &mut Option<Instant>, on_data: &Channel<Vec<u8>>) -> bool {
    *flush_at = None;
    if buf.is_empty() {
        return true;
    }
    on_data.send(std::mem::take(buf)).is_ok()
}

// ---------------------------------------------------------------------------------------------
// Fire-and-forget commands (only push into the task's queue)
// ---------------------------------------------------------------------------------------------

fn sender_of(app: &AppHandle, channel_id: &str) -> SshResult<mpsc::UnboundedSender<TermCmd>> {
    let mgr = app.state::<SshManager>();
    let g = lock(&mgr.inner);
    let session_id = g.term_index.get(channel_id).ok_or_else(|| SshErr::new("not_found", "Terminal not found."))?;
    g.sessions
        .get(session_id)
        .and_then(|e| e.terminals.get(channel_id))
        .map(|t| t.tx.clone())
        .ok_or_else(|| SshErr::new("not_found", "Terminal not found."))
}

pub fn write(app: &AppHandle, channel_id: &str, data: Vec<u8>) -> SshResult<()> {
    sender_of(app, channel_id)?
        .send(TermCmd::Write(data))
        .map_err(|_| SshErr::new("not_found", "Terminal is closed."))
}

pub fn resize(app: &AppHandle, channel_id: &str, cols: u32, rows: u32) -> SshResult<()> {
    sender_of(app, channel_id)?
        .send(TermCmd::Resize { cols, rows })
        .map_err(|_| SshErr::new("not_found", "Terminal is closed."))
}

pub fn close(app: &AppHandle, channel_id: &str) -> SshResult<()> {
    // Closing an already-closed terminal is not an error.
    if let Ok(tx) = sender_of(app, channel_id) {
        let _ = tx.send(TermCmd::Close);
    }
    Ok(())
}

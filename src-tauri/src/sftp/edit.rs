//! sftp/edit.rs — "Open in default app": edit a remote file with the program Windows associates with it.
//!
//! WHO CALLS IT:  commands/sftp_cmds.rs (`sftp_edit_open`, `sftp_edit_resolve`), sftp/mod.rs + sftp/remote.rs
//!                (`abort_for_sftp` when a session / SFTP view closes).
//! WHAT IT CALLS: remote.rs (SFTP channel lookup, stat), russh-sftp (read / write the remote file),
//!                `tauri-plugin-opener` (open the local copy in the default app), `notify` (file watcher).
//!
//! HOW IT WORKS (one "edit session" per remote file)
//!  1. The remote file is downloaded to  %TEMP%\ssh-clone-edit\<uuid>\<same file name>  (the name keeps its
//!     extension, so Windows picks the right program).
//!  2. A `notify` watcher is started on that temp folder BEFORE the program is launched (no save can be missed).
//!  3. The local copy is opened with the default app (`tauri-plugin-opener`, called from Rust: no JS permission needed).
//!  4. Every time the file changes the watcher fires; events are debounced (editors write in several steps, Word
//!     saves via a temp file + rename), then the file is uploaded back to the SAME remote path.
//!  5. The upload writes IN PLACE (`sftp.create` = open + truncate): the remote file keeps its permissions
//!     (e.g. the executable bit of a script) and its owner. A new file + rename would lose both.
//!  6. Before uploading we compare the server copy (size + modified time) with what we saw at download / our last
//!     upload. If somebody else changed it meanwhile we ask the user (event `conflict` -> command `sftp_edit_resolve`)
//!     instead of silently overwriting.
//!  7. The session ends when the SFTP view / SSH session closes. Local copies are NOT deleted at that moment (the user's
//!     editor may still have the file open and unsaved edits must not vanish); folders older than 7 days are removed
//!     the next time a file is opened.
//!
//! EVENTS: everything is reported through one `Channel<EditEvent>` per `sftp_edit_open` call (see `EditEvent`).
//! Reopening a file that already has an active session just launches the app again on the SAME local copy
//! (re-downloading would overwrite the user's unsaved work).
//!
//! ⚠ Written without a Rust toolchain at hand (not compiled). The only API-sensitive spots are `start_watcher`
//!   (notify 8: `RecommendedWatcher::new`, `Watcher::watch`) and `open_default` (tauri-plugin-opener 2: `open_path`).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use russh_sftp::client::SftpSession;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use super::remote::{self, base_name, map_err};
use crate::ssh::{emit_log, lock, SshErr, SshResult};

/// Copy buffer (same value as transfer.rs: safely below every server's SFTP packet limit).
const CHUNK: usize = 64 * 1024;
/// Editors write a file in several steps: upload only after the folder has been quiet for this long.
const DEBOUNCE: Duration = Duration::from_millis(700);
/// Bigger files are refused (they would fill the temp folder): the user should Download them instead.
const MAX_EDIT_BYTES: u64 = 512 * 1024 * 1024;
/// Local copies older than this are removed the next time a file is opened.
const KEEP_DAYS: u64 = 7;

// ---------------------------------------------------------------------------------------------
// Contract types
// ---------------------------------------------------------------------------------------------

/// What the UI is told about an edit session. `state` is one of:
///   "downloading"  the remote file is being fetched
///   "opened"       the default app was launched (`message` says so)
///   "uploading"    a save was detected, the file is going back to the server
///   "saved"        the server now has the edited file
///   "conflict"     the server copy changed meanwhile -> the UI must answer with `sftp_edit_resolve`
///   "skipped"      the user chose to keep the server copy: this save was NOT uploaded
///   "error"        an upload failed / the session ended with unsaved edits (`message` explains, edits stay local)
///   "stopped"      the session ended (connection closed) and nothing is lost
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EditEvent {
    pub edit_id: String,
    pub file_name: String,
    pub remote_path: String,
    pub local_path: String,
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

/// Managed Tauri state (registered in lib.rs): all active edit sessions, keyed by editId.
#[derive(Default)]
pub struct EditManager {
    sessions: Mutex<HashMap<String, Arc<EditCtl>>>,
}

/// Control block of one edit session.
pub struct EditCtl {
    id: String,
    sftp_id: String,
    session_id: String,
    remote_path: String,
    local_path: PathBuf,
    /// Cancelled when the session ends (connection closed, or opening failed).
    token: CancellationToken,
    /// Why the session was ended by the system (shown to the user). `None` = silent end.
    reason: Mutex<Option<String>>,
    /// Set while we wait for the user's answer to a conflict (true = overwrite the server copy).
    pending: Mutex<Option<oneshot::Sender<bool>>>,
}

/// Identity of the LOCAL file at one moment (size + modified time): "did the editor save again?".
#[derive(Clone, Copy, PartialEq, Eq)]
struct LocalSig {
    len: u64,
    modified: Option<SystemTime>,
}

impl LocalSig {
    fn of(md: &std::fs::Metadata) -> Self {
        Self { len: md.len(), modified: md.modified().ok() }
    }
}

/// Identity of the REMOTE file as we last saw it (download or our own last upload): "did somebody else change it?".
#[derive(Clone, Copy, PartialEq, Eq)]
struct RemoteSig {
    size: u64,
    mtime: Option<SystemTime>,
}

fn io_err(path: &Path, e: std::io::Error) -> SshErr {
    SshErr::new("io", format!("{}: {e}", path.display()))
}

fn emit(chan: &Channel<EditEvent>, ctl: &EditCtl, state: &'static str, message: Option<String>) {
    // A Channel whose frontend is gone errors on send: nothing useful to do about it.
    let _ = chan.send(EditEvent {
        edit_id: ctl.id.clone(),
        file_name: base_name(&ctl.remote_path).to_string(),
        remote_path: ctl.remote_path.clone(),
        local_path: ctl.local_path.to_string_lossy().into_owned(),
        state,
        message,
    });
}

// ---------------------------------------------------------------------------------------------
// Entry points (called by commands/sftp_cmds.rs)
// ---------------------------------------------------------------------------------------------

/// `sftp_edit_open`: download `remote_path`, launch the default app on it, and keep uploading saves.
/// Resolves as soon as the app was launched (the watching continues in a background task). Returns the editId.
pub async fn open(app: &AppHandle, sftp_id: &str, remote_path: &str, chan: Channel<EditEvent>) -> SshResult<String> {
    let (sftp, session_id) = remote::get(app, sftp_id)?;
    let mgr = app.state::<EditManager>();

    // Already being edited? Launch the app again on the same local copy (never re-download over unsaved edits).
    let existing = lock(&mgr.sessions)
        .values()
        .find(|c| c.sftp_id == sftp_id && c.remote_path == remote_path && !c.token.is_cancelled())
        .cloned();
    if let Some(ctl) = existing {
        open_default(app, &ctl.local_path)?;
        emit(&chan, &ctl, "opened", Some("Opened again (your earlier edits are still in the same local copy).".into()));
        return Ok(ctl.id.clone());
    }

    // Only plain files, and not absurdly big ones.
    let st = remote::stat(&sftp, remote_path).await?;
    if st.is_dir {
        return Err(SshErr::new("invalid", "Folders cannot be opened in an app."));
    }
    if st.size > MAX_EDIT_BYTES {
        return Err(SshErr::new(
            "invalid",
            format!("This file is larger than {} MB. Use Download instead.", MAX_EDIT_BYTES / (1024 * 1024)),
        ));
    }

    // Local copy: %TEMP%\ssh-clone-edit\<uuid>\<name>
    let root = edit_root();
    let active_dirs: HashSet<PathBuf> =
        lock(&mgr.sessions).values().filter_map(|c| c.local_path.parent().map(Path::to_path_buf)).collect();
    cleanup_old(&root, &active_dirs);
    let dir = root.join(uuid::Uuid::new_v4().to_string());
    tokio::fs::create_dir_all(&dir).await.map_err(|e| io_err(&dir, e))?;
    let local = dir.join(safe_name(base_name(remote_path)));

    let ctl = Arc::new(EditCtl {
        id: uuid::Uuid::new_v4().to_string(),
        sftp_id: sftp_id.to_string(),
        session_id,
        remote_path: remote_path.to_string(),
        local_path: local.clone(),
        token: CancellationToken::new(),
        reason: Mutex::new(None),
        pending: Mutex::new(None),
    });

    emit(&chan, &ctl, "downloading", None);
    if let Err(e) = download(&sftp, remote_path, &local).await {
        let _ = tokio::fs::remove_dir_all(&dir).await;
        return Err(e);
    }
    let local_sig = match std::fs::metadata(&local) {
        Ok(md) => LocalSig::of(&md),
        Err(e) => return Err(io_err(&local, e)),
    };
    let remote_sig = Some(RemoteSig { size: st.size, mtime: st.mtime });

    // Start watching BEFORE the app is launched, so an immediate save cannot be missed.
    let (tx, rx) = mpsc::unbounded_channel();
    let stop = match start_watcher(dir.clone(), tx).await {
        Ok(s) => s,
        Err(e) => {
            let _ = tokio::fs::remove_dir_all(&dir).await;
            return Err(e);
        }
    };
    lock(&mgr.sessions).insert(ctl.id.clone(), ctl.clone());
    tauri::async_runtime::spawn(watch_loop(app.clone(), ctl.clone(), sftp, rx, stop, chan.clone(), local_sig, remote_sig));

    if let Err(e) = open_default(app, &local) {
        ctl.token.cancel(); // silent end (no `reason`): the caller gets the error
        return Err(e);
    }
    emit_log(app, Some(&ctl.session_id), "info", format!("Opened {} in its default app; saves are uploaded back.", base_name(remote_path)));
    emit(&chan, &ctl, "opened", None);
    Ok(ctl.id.clone())
}

/// `sftp_edit_resolve`: the user's answer to an `edit` event with state "conflict".
/// `overwrite` = true: replace the server copy with the edited file; false: keep the server copy (this save is not uploaded).
pub fn resolve(app: &AppHandle, edit_id: &str, overwrite: bool) -> SshResult<()> {
    let mgr = app.state::<EditManager>();
    let ctl = lock(&mgr.sessions).get(edit_id).cloned();
    let Some(ctl) = ctl else {
        return Err(SshErr::new("not_found", "This edit session has ended."));
    };
    let tx = lock(&ctl.pending).take();
    match tx {
        Some(tx) => {
            let _ = tx.send(overwrite);
            Ok(())
        }
        None => Err(SshErr::new("not_found", "This edit is not waiting for an answer.")),
    }
}

/// Called when an SFTP view / its session closes (sftp/mod.rs, sftp/remote.rs): end every edit session on it.
/// The watcher tasks tell the user whether unsaved edits remain (and where the local copy is).
pub fn abort_for_sftp(app: &AppHandle, sftp_id: &str, reason: &str) {
    let mgr = app.state::<EditManager>();
    let list: Vec<Arc<EditCtl>> = lock(&mgr.sessions).values().filter(|c| c.sftp_id == sftp_id).cloned().collect();
    for c in list {
        *lock(&c.reason) = Some(reason.to_string());
        c.token.cancel();
    }
}

// ---------------------------------------------------------------------------------------------
// Watching + uploading
// ---------------------------------------------------------------------------------------------

enum SyncOutcome {
    Uploaded,
    /// The user chose "keep the server copy".
    Skipped,
    /// The upload failed (the edits stay local; the next save tries again).
    Failed,
    /// The session ended while we were waiting for an answer.
    Cancelled,
}

/// The background task of one edit session. Ends when the session is cancelled or the watcher dies.
#[allow(clippy::too_many_arguments)]
async fn watch_loop(
    app: AppHandle,
    ctl: Arc<EditCtl>,
    sftp: Arc<SftpSession>,
    mut rx: mpsc::UnboundedReceiver<notify::Result<Event>>,
    _stop: std::sync::mpsc::Sender<()>, // dropping it (when this task ends) stops the watcher thread
    chan: Channel<EditEvent>,
    mut synced: LocalSig,
    mut remote_sig: Option<RemoteSig>,
) {
    // Folder events also report neighbours (Word's `~$name.docx` lock file, temp files): only this file counts.
    let name_lc = ctl.local_path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();

    'outer: loop {
        // 1. Wait for the first relevant event.
        loop {
            let ev = tokio::select! {
                _ = ctl.token.cancelled() => break 'outer,
                e = rx.recv() => e,
            };
            match ev {
                None => {
                    // The watcher thread ended by itself: nothing more can be detected.
                    let mut r = lock(&ctl.reason);
                    if r.is_none() {
                        *r = Some("The file watcher stopped.".to_string());
                    }
                    break 'outer;
                }
                Some(r) if relevant(&r, &name_lc) => break,
                Some(_) => {}
            }
        }

        // 2. Debounce: wait until the file has been quiet for DEBOUNCE.
        loop {
            let next = tokio::select! {
                _ = ctl.token.cancelled() => break 'outer,
                r = tokio::time::timeout(DEBOUNCE, rx.recv()) => r,
            };
            match next {
                Err(_) => break,         // quiet: go and look at the file
                Ok(None) => break 'outer,
                Ok(Some(_)) => {}        // more writes: keep waiting
            }
        }

        // 3. Did the file really change? (An editor may delete + recreate it: a missing file is not a save.)
        let md = match tokio::fs::metadata(&ctl.local_path).await {
            Ok(m) => m,
            Err(_) => continue 'outer,
        };
        let sig = LocalSig::of(&md);
        if sig == synced {
            continue 'outer;
        }

        // 4. Upload (with the conflict check).
        match sync_once(&app, &ctl, &sftp, &chan, &mut remote_sig).await {
            SyncOutcome::Uploaded => synced = sig,
            SyncOutcome::Skipped | SyncOutcome::Failed => {}
            SyncOutcome::Cancelled => break 'outer,
        }
    }

    // The session is over: forget it, and tell the user if the system ended it.
    {
        let mgr = app.state::<EditManager>();
        lock(&mgr.sessions).remove(&ctl.id);
    }
    let reason = lock(&ctl.reason).clone();
    if let Some(reason) = reason {
        let name = base_name(&ctl.remote_path).to_string();
        let unsynced = std::fs::metadata(&ctl.local_path).map(|m| LocalSig::of(&m) != synced).unwrap_or(false);
        if unsynced {
            let msg = format!("{reason} Your last edits were NOT uploaded. They are kept in {}", ctl.local_path.display());
            emit_log(&app, Some(&ctl.session_id), "warn", format!("{name}: {msg}"));
            emit(&chan, &ctl, "error", Some(msg));
        } else {
            emit_log(&app, Some(&ctl.session_id), "info", format!("Stopped watching {name}: {reason}"));
            emit(&chan, &ctl, "stopped", Some(reason));
        }
    }
}

/// Is this watcher event about OUR file (and not just somebody reading it)?
fn relevant(res: &notify::Result<Event>, name_lc: &str) -> bool {
    match res {
        Ok(ev) => {
            !matches!(ev.kind, EventKind::Access(_))
                && ev
                    .paths
                    .iter()
                    .any(|p| p.file_name().map(|n| n.to_string_lossy().to_lowercase() == name_lc).unwrap_or(false))
        }
        Err(_) => true, // watcher problem (e.g. event buffer overflow): look at the file anyway
    }
}

/// One upload attempt: conflict check -> upload in place -> remember the new server signature.
async fn sync_once(
    app: &AppHandle,
    ctl: &EditCtl,
    sftp: &SftpSession,
    chan: &Channel<EditEvent>,
    remote_sig: &mut Option<RemoteSig>,
) -> SyncOutcome {
    let name = base_name(&ctl.remote_path).to_string();

    // Conflict check: has the server copy changed since we downloaded it / uploaded it last?
    // (If the remote file is gone or cannot be read, we simply go on: the upload recreates it / reports the real error.)
    if let Some(snap) = *remote_sig {
        if let Ok(cur) = remote::stat(sftp, &ctl.remote_path).await {
            if cur.size != snap.size || cur.mtime != snap.mtime {
                // Register the receiver BEFORE telling the UI, so a fast answer cannot get lost.
                let (tx, rx) = oneshot::channel();
                *lock(&ctl.pending) = Some(tx);
                emit(chan, ctl, "conflict", Some(format!("\"{name}\" was changed on the server after you opened it.")));
                let answer = tokio::select! {
                    _ = ctl.token.cancelled() => return SyncOutcome::Cancelled,
                    r = rx => r.ok(),
                };
                match answer {
                    Some(true) => {} // overwrite: carry on below
                    Some(false) => {
                        let msg = "Your changes were NOT uploaded (server copy kept). Save again in the app to be asked again.".to_string();
                        emit_log(app, Some(&ctl.session_id), "info", format!("{name}: upload skipped, server copy kept."));
                        emit(chan, ctl, "skipped", Some(msg));
                        return SyncOutcome::Skipped;
                    }
                    None => return SyncOutcome::Cancelled,
                }
            }
        }
    }

    emit(chan, ctl, "uploading", None);
    match upload_in_place(sftp, &ctl.local_path, &ctl.remote_path).await {
        Ok(bytes) => {
            // Remember what the server has NOW, so our own upload is not reported as a foreign change next time.
            *remote_sig = remote::stat(sftp, &ctl.remote_path).await.ok().map(|i| RemoteSig { size: i.size, mtime: i.mtime });
            emit_log(app, Some(&ctl.session_id), "info", format!("Saved {name} to the server ({bytes} bytes)."));
            emit(chan, ctl, "saved", None);
            SyncOutcome::Uploaded
        }
        Err(e) => {
            let msg = format!("Upload failed: {} The server copy may be incomplete; save again in the app to retry.", e.message);
            emit_log(app, Some(&ctl.session_id), "error", format!("{name}: {msg}"));
            emit(chan, ctl, "error", Some(msg));
            SyncOutcome::Failed
        }
    }
}

/// Write the local file over the remote one IN PLACE (open + truncate keeps the remote permissions and owner).
async fn upload_in_place(sftp: &SftpSession, local: &Path, remote_path: &str) -> SshResult<u64> {
    // Some programs (Office) keep the file locked for a moment after saving: retry opening a few times.
    let mut input = None;
    let mut last_err: Option<std::io::Error> = None;
    for _ in 0..6 {
        match tokio::fs::File::open(local).await {
            Ok(f) => {
                input = Some(f);
                break;
            }
            Err(e) => {
                last_err = Some(e);
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    }
    let Some(mut input) = input else {
        return Err(io_err(local, last_err.unwrap_or_else(|| std::io::Error::other("cannot open the file"))));
    };

    let mut output = sftp.create(remote_path).await.map_err(map_err)?;
    let mut buf = vec![0u8; CHUNK];
    let mut total = 0u64;
    loop {
        let n = input.read(&mut buf).await.map_err(|e| io_err(local, e))?;
        if n == 0 {
            break;
        }
        output.write_all(&buf[..n]).await.map_err(map_err)?;
        total += n as u64;
    }
    // Close the remote handle so the server has really written everything.
    output.flush().await.map_err(map_err)?;
    output.shutdown().await.map_err(map_err)?;
    Ok(total)
}

/// Remote file -> local file (plain copy, no progress rows: edit-sized files are small).
async fn download(sftp: &SftpSession, remote_path: &str, local: &Path) -> SshResult<()> {
    let mut input = sftp.open(remote_path).await.map_err(map_err)?;
    let mut output = tokio::fs::File::create(local).await.map_err(|e| io_err(local, e))?;
    let mut buf = vec![0u8; CHUNK];
    loop {
        let n = input.read(&mut buf).await.map_err(map_err)?;
        if n == 0 {
            break;
        }
        output.write_all(&buf[..n]).await.map_err(|e| io_err(local, e))?;
    }
    output.flush().await.map_err(|e| io_err(local, e))?;
    drop(output); // close before the app opens it (Windows sharing rules)
    let _ = input.shutdown().await;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// notify + opener adapters (the only API-sensitive code, see the module comment)
// ---------------------------------------------------------------------------------------------

/// Start an OS file watcher on `dir` (not recursive). Events are sent into `tx`.
/// The watcher lives in its OWN thread (so it never has to be moved between threads); dropping the returned
/// sender ends that thread and with it the watcher.
async fn start_watcher(dir: PathBuf, tx: mpsc::UnboundedSender<notify::Result<Event>>) -> SshResult<std::sync::mpsc::Sender<()>> {
    let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();

    std::thread::spawn(move || {
        let handler = move |res: notify::Result<Event>| {
            let _ = tx.send(res); // the receiver is gone when the session ended: ignore
        };
        let made = RecommendedWatcher::new(handler, Config::default()).and_then(|mut w| w.watch(&dir, RecursiveMode::NonRecursive).map(|_| w));
        match made {
            Ok(watcher) => {
                let _ = ready_tx.send(Ok(()));
                let _ = stop_rx.recv(); // blocks until the sender is dropped (session over)
                drop(watcher);
            }
            Err(e) => {
                let _ = ready_tx.send(Err(e.to_string()));
            }
        }
    });

    match tokio::task::spawn_blocking(move || ready_rx.recv_timeout(Duration::from_secs(5))).await {
        Ok(Ok(Ok(()))) => Ok(stop_tx),
        Ok(Ok(Err(msg))) => Err(SshErr::new("io", format!("Cannot watch the file for changes: {msg}"))),
        _ => Err(SshErr::new("io", "Cannot watch the file for changes (the watcher did not start).")),
    }
}

/// Open `path` with the program Windows associates with it (tauri-plugin-opener; no JS permission involved).
fn open_default(app: &AppHandle, path: &Path) -> SshResult<()> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(path.to_string_lossy().to_string(), None::<String>)
        .map_err(|e| SshErr::new("io", format!("Cannot open {}: {e}", path.display())))
}

// ---------------------------------------------------------------------------------------------
// Local temp folder helpers
// ---------------------------------------------------------------------------------------------

fn edit_root() -> PathBuf {
    std::env::temp_dir().join("ssh-clone-edit")
}

/// Remove edit folders older than KEEP_DAYS (best effort; folders of active sessions are never touched).
fn cleanup_old(root: &Path, active: &HashSet<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(root) else { return };
    for e in rd.flatten() {
        if active.contains(&e.path()) {
            continue;
        }
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .map(|d| d.as_secs() > KEEP_DAYS * 86_400)
            .unwrap_or(false);
        if old {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

/// A remote file name that is valid on Windows (illegal characters become `_`; the extension is kept).
fn safe_name(name: &str) -> String {
    let cleaned: String = name.chars().map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '_' } else { c }).collect();
    let cleaned = cleaned.trim_end_matches(|c| c == ' ' || c == '.').to_string();
    if cleaned.is_empty() {
        "file".to_string()
    } else {
        cleaned
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_name_keeps_extension_and_fixes_illegal_characters() {
        assert_eq!(safe_name("report.txt"), "report.txt");
        assert_eq!(safe_name("a:b*c?.log"), "a_b_c_.log");
        assert_eq!(safe_name(".bashrc"), ".bashrc");
        assert_eq!(safe_name("name. "), "name");
        assert_eq!(safe_name("..."), "file");
    }

    #[test]
    fn only_events_about_our_file_count() {
        let mk = |kind: EventKind, file: &str| -> notify::Result<Event> {
            Ok(Event::new(kind).add_path(PathBuf::from(format!("C:\\t\\{file}"))))
        };
        let modify = EventKind::Modify(notify::event::ModifyKind::Any);
        assert!(relevant(&mk(modify, "Notes.TXT"), "notes.txt"));
        assert!(!relevant(&mk(modify, "~$notes.txt"), "notes.txt"));
        assert!(!relevant(&mk(EventKind::Access(notify::event::AccessKind::Any), "notes.txt"), "notes.txt"));
    }
}

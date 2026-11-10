//! sftp/dragout.rs — drag remote SFTP items OUT of the window into Windows Explorer (virtual files).
//!
//! WHY THIS EXISTS (read this first, AI reader)
//!   The old way (still in the app as a FALLBACK, see SftpTab.tsx `dragOutLegacy`) downloaded every dragged file to a
//!   temp folder BEFORE the native drag could start, and the mouse button had to still be held when the download
//!   finished. Big files failed, there was a 1 GB cap, and the user stared at "Preparing files…".
//!   This module uses Windows "virtual files" (CFSTR_FILEDESCRIPTORW + CFSTR_FILECONTENTS with a lazy IStream — the
//!   same thing Outlook attachments and zip folders use): the drag starts INSTANTLY, and Explorer pulls the bytes
//!   straight from the SFTP server while it copies (its own progress dialog, its own cancel button). No temp files,
//!   no size cap, folders work.
//!
//! THE LIBRARY DOES THE OLE WORK
//!   We do NOT implement IDataObject / IStream ourselves. The maintained crate `virtual-file-transfer` (Windows only,
//!   v0.1.x) does. We only hand it a list of `VirtualFile { relative name, size, FileSource }`.
//!
//! TWO STEPS (commands in commands/sftp_cmds.rs)
//!   1. `plan`  (sftp_drag_plan)  — called by the UI as soon as the user starts dragging rows INSIDE the window.
//!                                  Stats the items and walks folders -> a flat list of files (`DragFile`).
//!   2. `start` (sftp_drag_start) — called when the pointer leaves the window (mouse button still down). Builds the
//!                                  virtual files and runs Windows' own drag loop (`DoDragDrop`) on the UI thread.
//!                                  The command resolves when the drag ends.
//!   Splitting them means the slow part (listing folders) happens while the pointer is still travelling to the
//!   window edge, so `start` is instant and the mouse button is still held.
//!
//! HOW THE BYTES FLOW (important, easy to break)
//!   Explorer calls IStream::Read on the UI thread (the OLE drag loop runs there) -> `SftpStreamReader::read`
//!   (a blocking std::io::Read) -> a small tokio channel <- a background task that reads the remote file with
//!   russh-sftp in 64 KiB chunks and keeps a few chunks ahead ("read-ahead"). When Explorer stops (cancel/finished)
//!   the reader is dropped, the channel closes and the background task ends by itself.
//!   The reader is LAZY: the remote file is only opened on the first `read` (Explorer may open a stream just to ask
//!   for its size, and we must not waste an SFTP open for that).
//!
//! LIMITS (v0.1 of the crate, documented for the user in docs/DRAG-OUT.md)
//!   * Only Explorer-like targets that understand virtual files accept the drop (Explorer, most file managers).
//!     Targets that only accept real files (browser upload areas, chat apps) do not — use Download for those.
//!   * Empty folders are not created (the crate can only describe files). Empty files are fine.
//!   * File times / permissions are not set (Explorer stamps "now").
//!   * Names Windows cannot store (":" "*" "?" … trailing dots, CON/NUL…) are renamed ("_"), duplicates that differ
//!     only by case get " (2)". Explorer's own conflict dialog handles files that already exist.
//!
//! TRANSFERS LIST (progress)
//!   Explorer pulls the bytes itself, so transfer.rs never sees them. To make the drag show up in the "Transfers" list
//!   `start` creates one `DragGroup` per dragged top-level item (file = one group, folder = one group with all its files)
//!   and registers it in `SftpManager.jobs`, so the normal Cancel button (`transfer_cancel`) and the "connection closed"
//!   abort (`transfer::abort_for_sftp`) work on it too. Every `SftpStreamReader` reports the bytes it hands to Explorer into
//!   its group; the counting / "which event to send" logic lives in dragprogress.rs (pure, unit-tested).
//!   Cancel / abort make the reader fail, so Explorer stops and shows its own error. A watchdog finishes groups that
//!   Explorer stopped asking for (its own Cancel button, or a drop target that never read anything).
//!
//! WHO CALLS IT: commands/sftp_cmds.rs.   WHAT IT CALLS: remote.rs (stat / read_items / get), dragprogress.rs, the crate.

// The streaming half is Windows-only; on other OSes (dev `cargo check`) its helpers would only produce warnings.
#![cfg_attr(not(windows), allow(dead_code, unused_imports))]

use std::collections::HashSet;
use std::io;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::AppHandle;

use super::remote::{self, base_name, join_remote};
use super::transfer::TransferProgress;
use crate::ssh::{emit_log, SshErr, SshResult};

#[cfg(windows)]
use std::sync::{Arc, Mutex};
#[cfg(windows)]
use std::time::Instant;
#[cfg(windows)]
use tauri::Manager;
#[cfg(windows)]
use tokio_util::sync::CancellationToken;
#[cfg(windows)]
use super::dragprogress::{group_by_top, GroupProgress, Update};
#[cfg(windows)]
use super::transfer::JobCtl;
#[cfg(windows)]
use super::SftpManager;
#[cfg(windows)]
use crate::ssh::lock;

/// Read-ahead: how many 64 KiB chunks the background task may be in front of Explorer (= 4 MiB).
const PREFETCH_CHUNKS: usize = 64;
/// One SFTP read. 64 KiB is safely below every server's packet limit (same value as transfer.rs).
const CHUNK: usize = 64 * 1024;
/// If the network gives nothing for this long, the Explorer copy fails instead of hanging forever.
const STALL_TIMEOUT: Duration = Duration::from_secs(60);
/// Safety net against dragging a whole filesystem by accident.
const MAX_FILES: usize = 20_000;
/// After the drag ended: how often the watchdog looks at the groups ...
#[cfg(windows)]
const WATCHDOG_TICK: Duration = Duration::from_secs(1);
/// ... and how long Explorer may stay silent (no stream open, no bytes) before the unfinished groups are given up.
#[cfg(windows)]
const IDLE_GRACE: Duration = Duration::from_secs(5);

// ---------------------------------------------------------------------------------------------
// Contract type (serialized to/from the UI; camelCase like the rest of the contract)
// ---------------------------------------------------------------------------------------------

/// One file that will appear in Explorer. `rel_path` is relative to the drop folder and '/'-separated
/// ("MyFolder/sub/a.txt" for a file inside a dragged folder, "a.txt" for a plain file).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DragFile {
    pub rel_path: String,
    pub remote_path: String,
    pub size: u64,
}

// ---------------------------------------------------------------------------------------------
// Step 1: plan (platform independent, pure SFTP)
// ---------------------------------------------------------------------------------------------

/// Turn the dragged remote paths into a flat list of files. Folders are walked (iteratively, no recursion).
/// Symlinks to folders are NOT followed (no loops, no surprises); symlinks to files are copied as files.
pub async fn plan(app: &AppHandle, sftp_id: &str, remote_paths: Vec<String>) -> SshResult<Vec<DragFile>> {
    let (sftp, session_id) = remote::get(app, sftp_id)?;

    // Stat all top-level items in parallel (one round trip in total instead of one per item).
    let mut set = tokio::task::JoinSet::new();
    for (i, p) in remote_paths.iter().enumerate() {
        let sftp = sftp.clone();
        let p = p.clone();
        set.spawn(async move { (i, remote::stat(&sftp, &p).await) });
    }
    let mut tops: Vec<Option<remote::Item>> = (0..remote_paths.len()).map(|_| None).collect();
    while let Some(joined) = set.join_next().await {
        let (i, res) = joined.map_err(|e| SshErr::new("internal", format!("Drag preparation failed: {e}")))?;
        tops[i] = Some(res?);
    }

    let mut out: Vec<DragFile> = Vec::new();
    for (path, top) in remote_paths.iter().zip(tops.into_iter()) {
        let top = top.expect("every index was filled above");
        let name = base_name(path).to_string();
        if !top.is_dir {
            out.push(DragFile { rel_path: name, remote_path: path.clone(), size: top.size });
            continue;
        }
        // Folder: walk it. Stack entries are (remote folder, relative path of that folder in Explorer).
        let mut stack = vec![(path.clone(), name)];
        while let Some((dir, rel)) = stack.pop() {
            for it in remote::read_items(&sftp, &dir).await? {
                let full = join_remote(&dir, &it.name);
                let rel_child = format!("{rel}/{}", it.name);
                if it.is_dir {
                    if it.is_symlink {
                        emit_log(app, Some(&session_id), "info", format!("Drag: skipped the link to a folder {full}"));
                    } else {
                        stack.push((full, rel_child));
                    }
                } else {
                    out.push(DragFile { rel_path: rel_child, remote_path: full, size: it.size });
                }
                if out.len() > MAX_FILES {
                    return Err(SshErr::new(
                        "invalid",
                        format!("More than {MAX_FILES} files in the selection. Use Download for this."),
                    ));
                }
            }
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// Name clean-up (Windows cannot store every name a Linux server can)
// ---------------------------------------------------------------------------------------------

/// Make ONE path component legal on Windows. Returns the (possibly changed) name.
fn sanitize_component(name: &str) -> String {
    const BAD: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
    let mut s: String = name.chars().map(|c| if BAD.contains(&c) || (c as u32) < 0x20 { '_' } else { c }).collect();
    // Windows silently strips trailing dots/spaces, which would break the name we promised.
    while s.ends_with('.') || s.ends_with(' ') {
        s.pop();
    }
    if s.is_empty() {
        s.push('_');
    }
    // Reserved device names (with or without an extension): CON, PRN, AUX, NUL, COM1-9, LPT1-9.
    let stem = s.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && matches!(stem.as_bytes()[3], b'1'..=b'9'));
    if reserved {
        s.insert(0, '_');
    }
    s
}

/// Sanitize every component of every path and make the full paths unique (case-insensitive, like NTFS).
/// Returns the new list and how many names had to change.
pub fn finalize(files: Vec<DragFile>) -> (Vec<DragFile>, usize) {
    let mut seen: HashSet<String> = HashSet::new();
    let mut changed = 0usize;
    let mut out = Vec::with_capacity(files.len());
    for mut f in files {
        let comps: Vec<String> = f.rel_path.split('/').filter(|c| !c.is_empty()).map(sanitize_component).collect();
        let mut path = comps.join("/");
        if seen.contains(&path.to_lowercase()) {
            // Same name differing only by case (legal on Linux): "a.txt" + "A.txt" -> "A (2).txt".
            let (dir, file) = match path.rfind('/') {
                Some(i) => (&path[..=i], &path[i + 1..]),
                None => ("", path.as_str()),
            };
            let (stem, ext) = match file.rfind('.') {
                Some(i) if i > 0 => (&file[..i], &file[i..]),
                _ => (file, ""),
            };
            let mut n = 2;
            let candidate = loop {
                let c = format!("{dir}{stem} ({n}){ext}");
                if !seen.contains(&c.to_lowercase()) {
                    break c;
                }
                n += 1;
            };
            path = candidate;
        }
        if path != f.rel_path {
            changed += 1;
        }
        seen.insert(path.to_lowercase());
        f.rel_path = path;
        out.push(f);
    }
    (out, changed)
}

// ---------------------------------------------------------------------------------------------
// Step 2: start (Windows only)
// ---------------------------------------------------------------------------------------------

/// One dragged top-level item as ONE row of the Transfers list (see the module comment, "TRANSFERS LIST").
/// Shared (Arc) by the readers of its files, the cancel watcher and the end-of-drag watchdog.
#[cfg(windows)]
struct DragGroup {
    app: AppHandle,
    id: String,
    name: String,
    session_id: String,
    /// Registered in `SftpManager.jobs` while the group is alive: `transfer_cancel` / `abort_for_sftp` cancel its token.
    ctl: Arc<JobCtl>,
    chan: Channel<TransferProgress>,
    /// Never held across an `.await` (project rule). Events are sent while it is held, so they cannot be reordered.
    state: Mutex<GroupProgress>,
    /// Fired when the group reached a terminal state (stops the cancel watcher).
    finished: CancellationToken,
}

#[cfg(windows)]
impl DragGroup {
    fn send(&self, u: Update) {
        let ev = TransferProgress {
            transfer_id: self.id.clone(),
            file_name: self.name.clone(),
            direction: "download",
            bytes_done: u.done,
            bytes_total: u.total,
            state: u.state,
            error: u.error,
        };
        // A Channel whose frontend is gone errors on send: cancel instead of panicking (same rule as transfer.rs).
        if self.chan.send(ev).is_err() {
            self.ctl.token.cancel();
        }
    }

    /// Change the state and send the resulting event (if any). A terminal state also unregisters the job.
    fn apply<F: FnOnce(&mut GroupProgress) -> Option<Update>>(&self, f: F) {
        let terminal = {
            let mut st = lock(&self.state);
            let Some(u) = f(&mut *st) else { return };
            self.send(u);
            st.is_terminal()
        };
        if terminal {
            self.finished.cancel();
            let mgr = self.app.state::<SftpManager>();
            lock(&mgr.jobs).remove(&self.id);
        }
    }

    /// The error a reader returns after Cancel / "connection closed". NOT `Interrupted`: std helpers retry that kind.
    fn stop_error(&self) -> io::Error {
        let reason = lock(&self.ctl.abort_reason).clone().unwrap_or_else(|| "The transfer was cancelled.".to_string());
        io::Error::new(io::ErrorKind::Other, reason)
    }

    fn fail_with(&self, message: &str) {
        emit_log(&self.app, Some(&self.session_id), "error", format!("Drag of {} failed: {message}", self.name));
        self.apply(|g| g.fail(message.to_string()));
    }
}

/// Lazy, blocking `Read` over one remote file (see the module comment, "HOW THE BYTES FLOW").
#[cfg(windows)]
struct SftpStreamReader {
    app: AppHandle,
    sftp_id: String,
    remote_path: String,
    /// Bytes still to deliver. The size we told Explorer must match exactly what we deliver.
    remaining: u64,
    /// `None` until the first read (lazy start).
    rx: Option<tokio::sync::mpsc::Receiver<io::Result<Vec<u8>>>>,
    cur: Vec<u8>,
    pos: usize,
    /// Row of the Transfers list this file belongs to, the file's number inside it, and the bytes this reader delivered.
    group: Arc<DragGroup>,
    idx: usize,
    delivered: u64,
}

#[cfg(windows)]
impl SftpStreamReader {
    fn new(app: AppHandle, sftp_id: String, remote_path: String, size: u64, group: Arc<DragGroup>, idx: usize) -> Self {
        group.apply(|g| g.reader_opened(idx, Instant::now()));
        Self { app, sftp_id, remote_path, remaining: size, rx: None, cur: Vec::new(), pos: 0, group, idx, delivered: 0 }
    }

    /// Open the remote file in a background task that reads ahead into a bounded channel.
    fn start(&mut self) -> io::Result<()> {
        let (sftp, _) = remote::get(&self.app, &self.sftp_id).map_err(|e| io::Error::new(io::ErrorKind::NotConnected, e.message))?;
        let (tx, rx) = tokio::sync::mpsc::channel::<io::Result<Vec<u8>>>(PREFETCH_CHUNKS);
        let path = self.remote_path.clone();
        tauri::async_runtime::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let mut file = match sftp.open(&path).await {
                Ok(f) => f,
                Err(e) => {
                    let _ = tx.send(Err(io::Error::new(io::ErrorKind::Other, e.to_string()))).await;
                    return;
                }
            };
            loop {
                let mut buf = vec![0u8; CHUNK];
                // Race the network read against "Explorer stopped listening" so a cancel is instant.
                let n = tokio::select! {
                    r = file.read(&mut buf) => r,
                    _ = tx.closed() => break,
                };
                match n {
                    Ok(0) => break, // end of file: dropping `tx` tells the reader
                    Ok(n) => {
                        buf.truncate(n);
                        if tx.send(Ok(buf)).await.is_err() {
                            break; // Explorer stopped
                        }
                    }
                    Err(e) => {
                        let _ = tx.send(Err(e)).await;
                        break;
                    }
                }
            }
            let _ = file.shutdown().await;
        });
        self.rx = Some(rx);
        Ok(())
    }
}

#[cfg(windows)]
impl Drop for SftpStreamReader {
    fn drop(&mut self) {
        // Explorer finished with this stream (or stopped). The group's end is decided by its byte count / the watchdog.
        self.group.apply(|g| {
            g.reader_closed(Instant::now());
            None
        });
    }
}

#[cfg(windows)]
impl io::Read for SftpStreamReader {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if out.is_empty() || self.remaining == 0 {
            return Ok(0);
        }
        // The user pressed Cancel in the Transfers list (or the connection closed): fail, Explorer stops and says so.
        if self.group.ctl.token.is_cancelled() {
            return Err(self.group.stop_error());
        }
        if self.pos >= self.cur.len() {
            if self.rx.is_none() {
                if let Err(e) = self.start() {
                    self.group.fail_with(&e.to_string());
                    return Err(e);
                }
            }
            let token = self.group.ctl.token.clone();
            let rx = self.rx.as_mut().expect("started above");
            // Blocks this (non-runtime) thread until the next chunk arrives, but never forever, and a Cancel ends the wait at once.
            let next = tauri::async_runtime::block_on(async {
                tokio::select! {
                    r = tokio::time::timeout(STALL_TIMEOUT, rx.recv()) => Some(r),
                    _ = token.cancelled() => None,
                }
            });
            match next {
                None => return Err(self.group.stop_error()),
                Some(Ok(Some(Ok(chunk)))) => {
                    self.cur = chunk;
                    self.pos = 0;
                }
                Some(Ok(Some(Err(e)))) => {
                    self.group.fail_with(&e.to_string());
                    return Err(e);
                }
                // The server's file ended before the size we announced (it changed after the listing).
                Some(Ok(None)) => {
                    let e = io::Error::new(io::ErrorKind::UnexpectedEof, "The remote file is shorter than listed (it changed on the server).");
                    self.group.fail_with(&e.to_string());
                    return Err(e);
                }
                Some(Err(_)) => {
                    let e = io::Error::new(io::ErrorKind::TimedOut, "The server stopped sending data.");
                    self.group.fail_with(&e.to_string());
                    return Err(e);
                }
            }
        }
        let n = out.len().min(self.cur.len() - self.pos).min(self.remaining as usize);
        out[..n].copy_from_slice(&self.cur[self.pos..self.pos + n]);
        self.pos += n;
        self.remaining -= n as u64;
        self.delivered += n as u64;
        // Tell the Transfers list (throttled to ~10 events/s inside GroupProgress; the last byte ends the row at once).
        self.group.apply(|g| g.add(self.idx, self.delivered, Instant::now()));
        Ok(n)
    }
}

/// Give up every group that did not finish (end of drag with nothing more to come, or the drag could not start).
#[cfg(windows)]
fn abandon(groups: &[Arc<DragGroup>]) {
    for g in groups {
        g.apply(|s| s.give_up());
    }
}

/// Runs after `begin_drag` returned. Explorer may keep copying for a while (its progress dialog), so wait until it has
/// been silent for IDLE_GRACE (no open stream, no bytes), then close the rows that are still open: a row Explorer never
/// opened is removed by the UI (marker `UNUSED`), a half-copied one shows "Cancelled" (Explorer's own Cancel button).
#[cfg(windows)]
async fn watchdog(groups: Vec<Arc<DragGroup>>) {
    loop {
        tokio::time::sleep(WATCHDOG_TICK).await;
        let now = Instant::now();
        let (mut open, mut busy) = (false, false);
        for g in &groups {
            let st = lock(&g.state);
            if st.is_terminal() {
                continue;
            }
            open = true;
            if st.readers() > 0 || now.duration_since(st.last_touch()) < IDLE_GRACE {
                busy = true;
            }
        }
        if !open {
            return;
        }
        if !busy {
            abandon(&groups);
            return;
        }
    }
}

/// Run Windows' drag loop with the planned files. Resolves when the drag ends (dropped or cancelled).
/// The mouse button must still be held when this is called, otherwise Windows ends the drag at once.
/// `on_progress` receives the rows of the Transfers list (one per dragged top-level item, see "TRANSFERS LIST").
#[cfg(windows)]
pub async fn start(app: &AppHandle, sftp_id: &str, files: Vec<DragFile>, on_progress: Channel<TransferProgress>) -> SshResult<()> {
    use virtual_file_transfer::{begin_drag, FactorySource, SourceReader, VirtualFile};

    // Fail early (and clearly) if the SFTP view was closed in the meantime.
    let (_, session_id) = remote::get(app, sftp_id)?;
    if files.is_empty() {
        return Err(SshErr::new("invalid", "Nothing to drag."));
    }
    let (files, renamed) = finalize(files);
    if renamed > 0 {
        emit_log(app, Some(&session_id), "info", format!("Drag: {renamed} name(s) changed because Windows does not allow them."));
    }

    // ---- one Transfers row ("group") per dragged top-level item, all shown as "queued" from the start ----
    let rels: Vec<&str> = files.iter().map(|f| f.rel_path.as_str()).collect();
    let layout = group_by_top(&rels);
    let now = Instant::now();
    let mgr = app.state::<SftpManager>();
    let mut groups: Vec<Arc<DragGroup>> = Vec::with_capacity(layout.len());
    // file index -> (group index, file number inside the group)
    let mut slot: Vec<(usize, usize)> = vec![(0, 0); files.len()];
    for (gi, (name, idxs)) in layout.into_iter().enumerate() {
        for (k, &i) in idxs.iter().enumerate() {
            slot[i] = (gi, k);
        }
        let progress = GroupProgress::new(idxs.iter().map(|&i| files[i].size).collect(), now);
        let queued = progress.queued_update();
        let id = uuid::Uuid::new_v4().to_string();
        let ctl = Arc::new(JobCtl {
            token: CancellationToken::new(),
            sftp_id: sftp_id.to_string(),
            session_id: session_id.clone(),
            pending: Mutex::new(None),
            abort_reason: Mutex::new(None),
        });
        lock(&mgr.jobs).insert(id.clone(), ctl.clone());
        let group = Arc::new(DragGroup {
            app: app.clone(),
            id,
            name,
            session_id: session_id.clone(),
            ctl,
            chan: on_progress.clone(),
            state: Mutex::new(progress),
            finished: CancellationToken::new(),
        });
        group.send(queued);
        // Cancel button / connection closed -> the row ends as "cancelled" / "error" even if Explorer is not reading it.
        let watcher = group.clone();
        tauri::async_runtime::spawn(async move {
            tokio::select! {
                _ = watcher.ctl.token.cancelled() => {
                    let abort = lock(&watcher.ctl.abort_reason).clone();
                    watcher.apply(|s| match abort {
                        Some(reason) => s.fail(reason),
                        None => s.cancel(),
                    });
                }
                _ = watcher.finished.cancelled() => {}
            }
        });
        groups.push(group);
    }
    drop(mgr);

    let mut virtual_files = Vec::with_capacity(files.len());
    for (i, f) in files.iter().enumerate() {
        let (app2, sid, rp, size) = (app.clone(), sftp_id.to_string(), f.remote_path.clone(), f.size);
        let (gi, k) = slot[i];
        let group = groups[gi].clone();
        // `open` is called by the crate every time Explorer asks for a fresh stream of this file.
        let source = FactorySource::new(move || {
            Ok(SourceReader::streaming(SftpStreamReader::new(app2.clone(), sid.clone(), rp.clone(), size, group.clone(), k)))
        });
        // `with_size` is REQUIRED: Explorer asks the stream for its size (IStream::Stat) before it copies.
        match VirtualFile::new(&f.rel_path, Box::new(source)) {
            Ok(vf) => virtual_files.push(vf.with_size(f.size)),
            Err(e) => {
                abandon(&groups);
                return Err(SshErr::new("invalid", format!("Cannot drag \"{}\": {e:?}", f.rel_path)));
            }
        }
    }

    // DoDragDrop needs a thread with a message loop = the UI thread. We wait for it through a oneshot.
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    if let Err(e) = app.run_on_main_thread(move || {
        let res = begin_drag(virtual_files).map(|_| ()).map_err(|e| format!("{e:?}"));
        let _ = tx.send(res);
    }) {
        abandon(&groups);
        return Err(SshErr::new("internal", format!("Cannot start the drag: {e}")));
    }

    match rx.await {
        Ok(Ok(())) => {
            // Explorer may still be copying: the watchdog closes whatever stays open once Explorer is silent.
            tauri::async_runtime::spawn(watchdog(groups));
            emit_log(app, Some(&session_id), "info", format!("Drag to Explorer finished ({} file(s)).", files.len()));
            Ok(())
        }
        Ok(Err(e)) => {
            abandon(&groups);
            Err(SshErr::new("io", format!("Windows drag failed: {e}")))
        }
        Err(_) => {
            abandon(&groups);
            Err(SshErr::new("internal", "The drag was interrupted."))
        }
    }
}

/// Non-Windows builds (only used for `cargo check` on a dev machine): the UI falls back to the temp-file drag.
#[cfg(not(windows))]
pub async fn start(_app: &AppHandle, _sftp_id: &str, _files: Vec<DragFile>, _on_progress: Channel<TransferProgress>) -> SshResult<()> {
    Err(SshErr::new("invalid", "Virtual-file drag is only available on Windows."))
}

// ---------------------------------------------------------------------------------------------
// Tests for the pure part (run with `cargo test` on any OS)
// ---------------------------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    fn f(p: &str) -> DragFile {
        DragFile { rel_path: p.into(), remote_path: format!("/r/{p}"), size: 1 }
    }

    #[test]
    fn bad_chars_and_reserved_names() {
        assert_eq!(sanitize_component("a:b*c?.txt"), "a_b_c_.txt");
        assert_eq!(sanitize_component("name. "), "name");
        assert_eq!(sanitize_component("CON"), "_CON");
        assert_eq!(sanitize_component("nul.txt"), "_nul.txt");
        assert_eq!(sanitize_component("COM1"), "_COM1");
        assert_eq!(sanitize_component("COM10"), "COM10");
        assert_eq!(sanitize_component("..."), "_");
    }

    #[test]
    fn case_duplicates_get_a_counter() {
        let (out, changed) = finalize(vec![f("d/a.txt"), f("d/A.txt"), f("d/a.TXT")]);
        let names: Vec<_> = out.iter().map(|x| x.rel_path.as_str()).collect();
        assert_eq!(names, vec!["d/a.txt", "d/A (2).txt", "d/a (3).TXT"]);
        assert_eq!(changed, 2);
    }
}

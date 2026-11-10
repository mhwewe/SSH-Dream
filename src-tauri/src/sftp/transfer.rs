//! sftp/transfer.rs — upload / download jobs (HANDOFF-3 §4.3).
//!
//! WHO CALLS IT:  commands/sftp_cmds.rs (transfer_start / transfer_cancel / transfer_resolve),
//!                sftp/mod.rs + remote.rs (abort_for_sftp when a session or SFTP view closes).
//! WHAT IT CALLS: remote.rs (SFTP helpers), russh-sftp file handles, tokio::fs for local files.
//!
//! HOW IT WORKS
//!  * `start` registers a `JobCtl`, spawns ONE task per transfer and returns the transferId at once.
//!  * The task waits for a free slot (a semaphore with MAX_CONCURRENT_TRANSFERS permits, FIFO), so big
//!    batches never open dozens of file handles. While waiting the state is "queued".
//!  * A transfer is ONE file or ONE folder (recursive). A folder is pre-walked to get `bytesTotal`,
//!    destination folders are created, then the files are copied one after another.
//!  * Every file is written as `<name>.part` and renamed on success, so an interrupted transfer never
//!    looks complete. Cancel / error deletes the `.part` file.
//!  * Memory stays flat: a single CHUNK-sized buffer per transfer, never a whole file.
//!  * Cancel = `CancellationToken`. The copy future is raced against the token (`select!`), so a stuck
//!    network read is cancelled too, not only "between chunks".
//!  * Paths: `localPath` / `remotePath` are the FULL paths of the item on each side (for an upload the
//!    remote path already includes the final name; for a download the local path = chosen folder + name).
//!    Local = Windows paths (PathBuf), remote = always '/'-separated Strings. Never mixed.
//!
//! NEW CONTRACT ITEMS (README §5.2/§5.3 updated): command `transfer_resolve`, event `transfer://conflict`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::remote::{self, base_name, join_remote, map_err};
use super::SftpManager;
use crate::ssh::{emit_log, lock, SshErr, SshResult};

/// Copy buffer. 64 KiB is safely below every server's SFTP packet limit (OpenSSH: 256 KiB).
const CHUNK: usize = 64 * 1024;
/// Progress events are throttled to ~10 per second (HANDOFF-3 §4.3).
const PROGRESS_EVERY: Duration = Duration::from_millis(100);

// ---------------------------------------------------------------------------------------------
// Contract types
// ---------------------------------------------------------------------------------------------

#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Upload,
    Download,
}

impl Direction {
    fn as_str(self) -> &'static str {
        match self {
            Direction::Upload => "upload",
            Direction::Download => "download",
        }
    }
}

/// Answer to a `transfer://conflict` (command `transfer_resolve`).
#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Overwrite,
    Skip,
    Rename,
}

/// README §5.1 `TransferProgress`.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub transfer_id: String,
    pub file_name: String,
    pub direction: &'static str,
    pub bytes_done: u64,
    pub bytes_total: u64,
    /// "queued" | "running" | "done" | "error" | "cancelled"
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// README §5.3 `transfer://conflict` payload.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ConflictEvent {
    transfer_id: String,
    path: String,
}

// ---------------------------------------------------------------------------------------------
// Job control block
// ---------------------------------------------------------------------------------------------

pub struct JobCtl {
    pub token: CancellationToken,
    pub sftp_id: String,
    pub session_id: String,
    /// Set while the job waits for the user's answer to a conflict.
    pub pending: Mutex<Option<oneshot::Sender<(Action, bool)>>>,
    /// Set when the job is aborted by the system (connection closed) instead of by the user.
    pub abort_reason: Mutex<Option<String>>,
}

fn cancelled() -> SshErr {
    SshErr::new("cancelled", "The transfer was cancelled.")
}

fn io_err(path: &Path, e: std::io::Error) -> SshErr {
    SshErr::new("io", format!("{}: {e}", path.display()))
}

/// Abort every queued/running transfer that belongs to `sftp_id` and mark it as system-aborted.
pub fn abort_for_sftp(app: &AppHandle, sftp_id: &str, reason: &str) {
    let mgr = app.state::<SftpManager>();
    let jobs: Vec<Arc<JobCtl>> = lock(&mgr.jobs).values().filter(|j| j.sftp_id == sftp_id).cloned().collect();
    for j in jobs {
        *lock(&j.abort_reason) = Some(reason.to_string());
        j.token.cancel();
    }
}

// ---------------------------------------------------------------------------------------------
// Progress reporter
// ---------------------------------------------------------------------------------------------

struct Reporter {
    chan: Channel<TransferProgress>,
    id: String,
    direction: &'static str,
    name: String,
    done: u64,
    total: u64,
    last: Instant,
    token: CancellationToken,
}

impl Reporter {
    fn emit(&mut self, state: &'static str, error: Option<String>) {
        let ev = TransferProgress {
            transfer_id: self.id.clone(),
            file_name: self.name.clone(),
            direction: self.direction,
            bytes_done: self.done,
            bytes_total: self.total,
            state,
            error,
        };
        // A Channel whose frontend is gone errors on send: cancel instead of panicking (§8).
        if self.chan.send(ev).is_err() {
            self.token.cancel();
        }
        self.last = Instant::now();
    }

    /// Count bytes and send a "running" event at most ~10x per second.
    fn add(&mut self, n: u64) {
        self.done += n;
        if self.last.elapsed() >= PROGRESS_EVERY {
            self.emit("running", None);
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Planning (what has to be copied)
// ---------------------------------------------------------------------------------------------

/// A folder that must exist on the destination (parents come before children).
struct DirPair {
    local: PathBuf,
    remote: String,
}

struct FileItem {
    local: PathBuf,
    remote: String,
    size: u64,
}

#[derive(Default)]
struct Plan {
    dirs: Vec<DirPair>,
    files: Vec<FileItem>,
    total: u64,
}

async fn plan_upload(local: &Path, remote: &str) -> SshResult<Plan> {
    let md = tokio::fs::metadata(local).await.map_err(|e| io_err(local, e))?;
    let mut plan = Plan::default();
    if md.is_file() {
        plan.total = md.len();
        plan.files.push(FileItem { local: local.to_path_buf(), remote: remote.to_string(), size: md.len() });
        return Ok(plan);
    }
    if !md.is_dir() {
        return Err(SshErr::new("invalid", format!("{} is neither a file nor a folder.", local.display())));
    }
    plan.dirs.push(DirPair { local: local.to_path_buf(), remote: remote.to_string() });
    let mut stack = vec![(local.to_path_buf(), remote.to_string())];
    while let Some((ldir, rdir)) = stack.pop() {
        let mut rd = tokio::fs::read_dir(&ldir).await.map_err(|e| io_err(&ldir, e))?;
        while let Some(e) = rd.next_entry().await.map_err(|e| io_err(&ldir, e))? {
            let lp = e.path();
            let rp = join_remote(&rdir, &e.file_name().to_string_lossy());
            let Ok(ft) = e.file_type().await else { continue };
            // Follow links to files, but skip links to folders (avoids loops with junctions).
            let Ok(md) = tokio::fs::metadata(&lp).await else { continue };
            if md.is_dir() {
                if ft.is_symlink() {
                    continue;
                }
                plan.dirs.push(DirPair { local: lp.clone(), remote: rp.clone() });
                stack.push((lp, rp));
            } else if md.is_file() {
                plan.total += md.len();
                plan.files.push(FileItem { local: lp, remote: rp, size: md.len() });
            }
        }
    }
    Ok(plan)
}

async fn plan_download(sftp: &SftpSession, remote_path: &str, local: &Path) -> SshResult<Plan> {
    let top = remote::stat(sftp, remote_path).await?;
    let mut plan = Plan::default();
    if !top.is_dir {
        plan.total = top.size;
        plan.files.push(FileItem { local: local.to_path_buf(), remote: remote_path.to_string(), size: top.size });
        return Ok(plan);
    }
    plan.dirs.push(DirPair { local: local.to_path_buf(), remote: remote_path.to_string() });
    let mut stack = vec![(remote_path.to_string(), local.to_path_buf())];
    while let Some((rdir, ldir)) = stack.pop() {
        for it in remote::read_items(sftp, &rdir).await? {
            let rp = join_remote(&rdir, &it.name);
            let lp = ldir.join(&it.name);
            if it.is_dir {
                if it.is_symlink {
                    continue; // never follow folder links (loops)
                }
                plan.dirs.push(DirPair { local: lp.clone(), remote: rp.clone() });
                stack.push((rp, lp));
            } else {
                plan.total += it.size;
                plan.files.push(FileItem { local: lp, remote: rp, size: it.size });
            }
        }
    }
    Ok(plan)
}

// ---------------------------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------------------------

/// Ask the user what to do with an existing destination file (or reuse an "apply to all" answer).
async fn ask_conflict(app: &AppHandle, ctl: &JobCtl, id: &str, path: &str) -> SshResult<Action> {
    let mgr = app.state::<SftpManager>();
    let remembered = *lock(&mgr.apply_all);
    if let Some(a) = remembered {
        return Ok(a);
    }
    let (tx, rx) = oneshot::channel();
    *lock(&ctl.pending) = Some(tx);
    let _ = app.emit("transfer://conflict", ConflictEvent { transfer_id: id.to_string(), path: path.to_string() });
    match rx.await {
        Ok((action, all)) => {
            if all {
                *lock(&mgr.apply_all) = Some(action);
            }
            Ok(action)
        }
        Err(_) => Err(cancelled()),
    }
}

/// "report.txt" + 1 -> "report (1).txt"; names without extension -> "name (1)".
fn numbered_name(name: &str, n: u32) -> String {
    match name.rfind('.') {
        Some(i) if i > 0 => format!("{} ({}){}", &name[..i], n, &name[i..]),
        _ => format!("{name} ({n})"),
    }
}

// ---------------------------------------------------------------------------------------------
// Copying one file
// ---------------------------------------------------------------------------------------------

/// The temporary file of the transfer in progress (deleted on cancel/error).
enum Part {
    Local(PathBuf),
    Remote(String),
}

fn local_part_path(dst: &Path) -> PathBuf {
    let mut s = dst.as_os_str().to_os_string();
    s.push(".part");
    PathBuf::from(s)
}

async fn copy_upload(
    sftp: &SftpSession,
    src: &Path,
    dst: &str,
    overwrite: bool,
    rep: &mut Reporter,
    part: &mut Option<Part>,
) -> SshResult<()> {
    let part_path = format!("{dst}.part");
    let mut input = tokio::fs::File::open(src).await.map_err(|e| io_err(src, e))?;
    *part = Some(Part::Remote(part_path.clone()));
    let mut output = sftp.create(&part_path).await.map_err(map_err)?;
    let mut buf = vec![0u8; CHUNK];
    loop {
        let n = input.read(&mut buf).await.map_err(|e| io_err(src, e))?;
        if n == 0 {
            break;
        }
        output.write_all(&buf[..n]).await.map_err(map_err)?;
        rep.add(n as u64);
    }
    // Close the remote handle BEFORE renaming (HANDOFF-3 §8).
    output.flush().await.map_err(map_err)?;
    output.shutdown().await.map_err(map_err)?;
    drop(output);
    if overwrite && sftp.try_exists(dst).await.unwrap_or(false) {
        sftp.remove_file(dst).await.map_err(map_err)?; // SFTP rename refuses to replace
    }
    sftp.rename(&part_path, dst).await.map_err(map_err)?;
    *part = None;
    Ok(())
}

async fn copy_download(
    sftp: &SftpSession,
    src: &str,
    dst: &Path,
    rep: &mut Reporter,
    part: &mut Option<Part>,
) -> SshResult<()> {
    if let Some(parent) = dst.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| io_err(parent, e))?;
    }
    let part_path = local_part_path(dst);
    let mut input = sftp.open(src).await.map_err(map_err)?;
    *part = Some(Part::Local(part_path.clone()));
    let mut output = tokio::fs::File::create(&part_path).await.map_err(|e| io_err(&part_path, e))?;
    let mut buf = vec![0u8; CHUNK];
    loop {
        let n = input.read(&mut buf).await.map_err(map_err)?;
        if n == 0 {
            break;
        }
        output.write_all(&buf[..n]).await.map_err(|e| io_err(&part_path, e))?;
        rep.add(n as u64);
    }
    output.flush().await.map_err(|e| io_err(&part_path, e))?;
    drop(output); // handle closed before the rename (Windows would refuse otherwise)
    let _ = input.shutdown().await;
    // On Windows std/tokio rename replaces an existing destination.
    tokio::fs::rename(&part_path, dst).await.map_err(|e| io_err(dst, e))?;
    *part = None;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------------------------

/// Does the destination of `f` already exist?
async fn dest_exists(sftp: &SftpSession, dir: Direction, local: &Path, remote: &str) -> SshResult<bool> {
    match dir {
        Direction::Upload => sftp.try_exists(remote).await.map_err(map_err),
        Direction::Download => tokio::fs::try_exists(local).await.map_err(|e| io_err(local, e)),
    }
}

/// Everything after "a slot is free": plan, create folders, copy files.
#[allow(clippy::too_many_arguments)]
async fn run(
    app: &AppHandle,
    sftp: &Arc<SftpSession>,
    ctl: &JobCtl,
    id: &str,
    dir: Direction,
    local: &Path,
    remote: &str,
    rep: &mut Reporter,
    part: &mut Option<Part>,
) -> SshResult<()> {
    let plan = match dir {
        Direction::Upload => plan_upload(local, remote).await?,
        Direction::Download => plan_download(sftp, remote, local).await?,
    };
    rep.total = plan.total;
    rep.emit("running", None);

    // Destination folders first (parents before children). Existing folders are simply merged.
    for d in &plan.dirs {
        match dir {
            Direction::Upload => {
                if !sftp.try_exists(&d.remote).await.map_err(map_err)? {
                    sftp.create_dir(&d.remote).await.map_err(map_err)?;
                }
            }
            Direction::Download => tokio::fs::create_dir_all(&d.local).await.map_err(|e| io_err(&d.local, e))?,
        }
    }

    for f in plan.files {
        rep.name = match dir {
            Direction::Upload => f.local.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
            Direction::Download => base_name(&f.remote).to_string(),
        };

        let mut target_local = f.local.clone();
        let mut target_remote = f.remote.clone();
        let mut overwrite = false;

        if dest_exists(sftp, dir, &target_local, &target_remote).await? {
            let shown = if dir == Direction::Upload { target_remote.clone() } else { target_local.display().to_string() };
            match ask_conflict(app, ctl, id, &shown).await? {
                Action::Skip => {
                    rep.add(f.size); // keep the bar honest: skipped bytes count as done
                    continue;
                }
                Action::Overwrite => overwrite = true,
                Action::Rename => {
                    // First free "name (n).ext" in the destination folder.
                    for n in 1..10_000u32 {
                        match dir {
                            Direction::Upload => {
                                let (parent, name) = match f.remote.rsplit_once('/') {
                                    Some((p, nm)) => (if p.is_empty() { "/" } else { p }, nm),
                                    None => ("", f.remote.as_str()),
                                };
                                let cand = if parent.is_empty() { numbered_name(name, n) } else { join_remote(parent, &numbered_name(name, n)) };
                                if !sftp.try_exists(&cand).await.map_err(map_err)? {
                                    target_remote = cand;
                                    break;
                                }
                            }
                            Direction::Download => {
                                let name = f.local.file_name().map(|x| x.to_string_lossy().to_string()).unwrap_or_default();
                                let cand = f.local.with_file_name(numbered_name(&name, n));
                                if !dest_exists(sftp, dir, &cand, "").await? {
                                    target_local = cand;
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }

        match dir {
            Direction::Upload => copy_upload(sftp, &f.local, &target_remote, overwrite, rep, part).await?,
            Direction::Download => copy_download(sftp, &f.remote, &target_local, rep, part).await?,
        }
        rep.emit("running", None); // make sure the end of every file is visible
    }
    Ok(())
}

/// Delete the leftover `.part` file after a cancel or an error (best effort).
async fn cleanup_part(sftp: &SftpSession, part: Option<Part>) {
    match part {
        Some(Part::Remote(p)) => {
            let _ = tokio::time::timeout(Duration::from_secs(2), sftp.remove_file(&p)).await;
        }
        Some(Part::Local(p)) => {
            let _ = tokio::fs::remove_file(&p).await;
        }
        None => {}
    }
}

/// The spawned task: queue -> run -> final event -> bookkeeping.
#[allow(clippy::too_many_arguments)]
async fn run_job(
    app: AppHandle,
    ctl: Arc<JobCtl>,
    id: String,
    sftp: Arc<SftpSession>,
    dir: Direction,
    local: PathBuf,
    remote: String,
    chan: Channel<TransferProgress>,
) {
    let mgr = app.state::<SftpManager>();
    let first_name = match dir {
        Direction::Upload => local.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        Direction::Download => base_name(&remote).to_string(),
    };
    let mut rep = Reporter {
        chan,
        id: id.clone(),
        direction: dir.as_str(),
        name: first_name,
        done: 0,
        total: 0,
        last: Instant::now(),
        token: ctl.token.clone(),
    };
    rep.emit("queued", None);

    // Wait for a free slot (or for a cancel while still queued).
    let permit = tokio::select! {
        p = mgr.slots.clone().acquire_owned() => p.ok(),
        _ = ctl.token.cancelled() => None,
    };

    let outcome: SshResult<()> = if permit.is_none() {
        Err(cancelled())
    } else {
        let mut part: Option<Part> = None;
        let r: SshResult<()> = tokio::select! {
            _ = ctl.token.cancelled() => Err(cancelled()),
            r = run(&app, &sftp, &ctl, &id, dir, &local, &remote, &mut rep, &mut part) => r,
        };
        if r.is_err() {
            cleanup_part(&sftp, part).await;
        }
        r
    };
    drop(permit);

    // Final event.
    let abort = lock(&ctl.abort_reason).clone();
    match outcome {
        Ok(()) => {
            rep.done = rep.total;
            rep.emit("done", None);
        }
        Err(e) => {
            if let Some(reason) = abort {
                emit_log(&app, Some(&ctl.session_id), "warn", format!("Transfer of {} stopped: {reason}", rep.name));
                rep.emit("error", Some(reason));
            } else if e.code == "cancelled" {
                rep.emit("cancelled", None);
            } else {
                emit_log(&app, Some(&ctl.session_id), "error", format!("Transfer of {} failed: {}", rep.name, e.message));
                rep.emit("error", Some(e.message));
            }
        }
    }

    // Bookkeeping: forget the job; when the queue is idle, forget "apply to all".
    lock(&mgr.jobs).remove(&id);
    if mgr.active.fetch_sub(1, std::sync::atomic::Ordering::SeqCst) == 1 {
        *lock(&mgr.apply_all) = None;
    }
}

// ---------------------------------------------------------------------------------------------
// Commands' entry points
// ---------------------------------------------------------------------------------------------

/// `transfer_start`.
pub fn start(
    app: &AppHandle,
    sftp_id: &str,
    direction: Direction,
    local_path: String,
    remote_path: String,
    on_progress: Channel<TransferProgress>,
) -> SshResult<String> {
    if local_path.trim().is_empty() || remote_path.trim().is_empty() {
        return Err(SshErr::new("invalid", "Both a local and a remote path are required."));
    }
    let (sftp, session_id) = remote::get(app, sftp_id)?;
    let id = uuid::Uuid::new_v4().to_string();
    let ctl = Arc::new(JobCtl {
        token: CancellationToken::new(),
        sftp_id: sftp_id.to_string(),
        session_id,
        pending: Mutex::new(None),
        abort_reason: Mutex::new(None),
    });

    let mgr = app.state::<SftpManager>();
    lock(&mgr.jobs).insert(id.clone(), ctl.clone());
    mgr.active.fetch_add(1, std::sync::atomic::Ordering::SeqCst);

    tauri::async_runtime::spawn(run_job(
        app.clone(),
        ctl,
        id.clone(),
        sftp,
        direction,
        PathBuf::from(local_path),
        remote_path,
        on_progress,
    ));
    Ok(id)
}

/// `transfer_cancel`. Cancelling a finished/unknown transfer is not an error.
pub fn cancel(app: &AppHandle, transfer_id: &str) -> SshResult<()> {
    let mgr = app.state::<SftpManager>();
    let ctl = lock(&mgr.jobs).get(transfer_id).cloned();
    if let Some(c) = ctl {
        c.token.cancel();
    }
    Ok(())
}

/// `transfer_resolve`: the user's answer to `transfer://conflict`.
pub fn resolve(app: &AppHandle, transfer_id: &str, action: Action, apply_to_all: bool) -> SshResult<()> {
    let mgr = app.state::<SftpManager>();
    let ctl = lock(&mgr.jobs).get(transfer_id).cloned();
    let Some(ctl) = ctl else {
        return Err(SshErr::new("not_found", "This transfer is no longer running."));
    };
    let tx = lock(&ctl.pending).take();
    match tx {
        Some(tx) => {
            let _ = tx.send((action, apply_to_all));
            Ok(())
        }
        None => Err(SshErr::new("not_found", "This transfer is not waiting for an answer.")),
    }
}

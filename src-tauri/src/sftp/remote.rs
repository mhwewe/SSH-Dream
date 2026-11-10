//! sftp/remote.rs — the remote side: SFTP channel per session + browse / mkdir / rename / delete.
//!
//! WHO CALLS IT:  commands/sftp_cmds.rs and sftp/transfer.rs (read_items, map_err, join_remote).
//! WHAT IT CALLS: ssh::session::get_handle (to open a channel on the session's single connection),
//!                russh-sftp (the SFTP protocol; we implement NO protocol ourselves).
//!
//! ⚠ VERSION RISK (code was written without compiling): everything that touches russh-sftp's
//!   metadata types is isolated in `item_from_entry` / `item_from_metadata` / `perm_string`.
//!   If the pinned russh-sftp differs from 2.x, those three functions are the ONLY places to adapt.

use std::sync::Arc;
use std::time::SystemTime;

use russh_sftp::client::fs::{DirEntry, Metadata};
use russh_sftp::client::SftpSession;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use super::{SftpEntry, SftpManager};
use crate::ssh::{emit_log, lock, session, SshErr, SshResult};

// ---------------------------------------------------------------------------------------------
// Contract type (README §5.1 `FileEntry`)
// ---------------------------------------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    /// ISO-8601 or null
    pub modified: Option<String>,
    /// e.g. "rwxr-xr-x"
    pub permissions: Option<String>,
}

/// Internal, library-independent view of one remote directory entry.
pub struct Item {
    pub name: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub mtime: Option<SystemTime>,
    pub perms: Option<String>,
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

/// Map an SFTP library error to the README error codes: a dead channel is `network`, everything
/// else (permission denied, no such file, ...) is `io` with the server's own message.
pub fn map_err<E: std::fmt::Display>(e: E) -> SshErr {
    let msg = e.to_string();
    let low = msg.to_lowercase();
    let dead = ["eof", "channel", "closed", "broken pipe", "connection reset", "timeout", "timed out"];
    if dead.iter().any(|k| low.contains(k)) {
        SshErr::new("network", format!("SFTP connection problem: {msg}"))
    } else {
        SshErr::new("io", msg)
    }
}

/// Remote paths are ALWAYS '/'-separated (README: never mix with Windows paths).
pub fn join_remote(dir: &str, name: &str) -> String {
    if dir.is_empty() || dir == "/" {
        format!("/{name}")
    } else if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// Last path component of a remote path ("/a/b/c.txt" -> "c.txt").
pub fn base_name(path: &str) -> &str {
    path.trim_end_matches('/').rsplit('/').next().unwrap_or(path)
}

/// Look up the open SFTP channel of `sftp_id`.
pub fn get(app: &AppHandle, sftp_id: &str) -> SshResult<(Arc<SftpSession>, String)> {
    let mgr = app.state::<SftpManager>();
    let g = lock(&mgr.entries);
    g.get(sftp_id)
        .map(|e| (e.sftp.clone(), e.session_id.clone()))
        .ok_or_else(|| SshErr::new("not_found", "This SFTP view is not open (log in again)."))
}

// ---------------------------------------------------------------------------------------------
// russh-sftp adapters (the only version-sensitive code, see module comment)
// ---------------------------------------------------------------------------------------------

/// "rwxr-xr-x" from the library's permission flags.
fn perm_string(md: &Metadata) -> Option<String> {
    let p = md.permissions();
    let c = |b: bool, ch: char| if b { ch } else { '-' };
    Some(format!(
        "{}{}{}{}{}{}{}{}{}",
        c(p.owner_read, 'r'), c(p.owner_write, 'w'), c(p.owner_exec, 'x'),
        c(p.group_read, 'r'), c(p.group_write, 'w'), c(p.group_exec, 'x'),
        c(p.other_read, 'r'), c(p.other_write, 'w'), c(p.other_exec, 'x'),
    ))
}

fn item_from_metadata(name: String, md: &Metadata) -> Item {
    let ft = md.file_type();
    Item {
        name,
        is_dir: ft.is_dir(),
        is_symlink: ft.is_symlink(),
        size: md.len(),
        mtime: md.modified().ok(),
        perms: perm_string(md),
    }
}

fn item_from_entry(e: &DirEntry) -> Item {
    item_from_metadata(e.file_name(), &e.metadata())
}

// ---------------------------------------------------------------------------------------------
// open / close
// ---------------------------------------------------------------------------------------------

/// `sftp_open`: open the `sftp` subsystem as a new channel on the session's single connection.
pub async fn open(app: &AppHandle, session_id: &str) -> SshResult<String> {
    let handle = session::get_handle(app, session_id)?;
    let channel = {
        // Lock only for the open itself (H2 rule).
        let h = handle.lock().await;
        h.channel_open_session()
            .await
            .map_err(|e| SshErr::new("network", format!("Cannot open an SFTP channel: {e:?}")))?
    };
    if let Err(e) = channel.request_subsystem(true, "sftp").await {
        // Some servers disable the subsystem: say so in plain words (HANDOFF-3 §8).
        let msg = "The server refused the SFTP subsystem (SFTP may be disabled on this server).";
        emit_log(app, Some(session_id), "error", format!("{msg} ({e:?})"));
        return Err(SshErr::new("io", msg));
    }
    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| SshErr::new("io", format!("SFTP initialisation failed: {e}")))?;

    let sftp_id = uuid::Uuid::new_v4().to_string();
    {
        let mgr = app.state::<SftpManager>();
        // The session may have vanished while we were opening (logout during open): re-check.
        if session::get_handle(app, session_id).is_err() {
            return Err(SshErr::new("not_found", "The session was closed."));
        }
        lock(&mgr.entries).insert(sftp_id.clone(), SftpEntry { session_id: session_id.to_string(), sftp: Arc::new(sftp) });
    }
    emit_log(app, Some(session_id), "info", "SFTP channel opened.");
    Ok(sftp_id)
}

/// `sftp_close`: drop the handle and abort its transfers.
pub async fn close(app: &AppHandle, sftp_id: &str) -> SshResult<()> {
    let entry = {
        let mgr = app.state::<SftpManager>();
        let e = lock(&mgr.entries).remove(sftp_id);
        e
    };
    super::transfer::abort_for_sftp(app, sftp_id, "The SFTP view was closed during the transfer.");
    super::edit::abort_for_sftp(app, sftp_id, "The SFTP view was closed.");
    if let Some(e) = entry {
        let _ = tokio::time::timeout(std::time::Duration::from_millis(500), e.sftp.close()).await;
        emit_log(app, Some(&e.session_id), "info", "SFTP channel closed.");
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Browsing
// ---------------------------------------------------------------------------------------------

/// Read one directory into `Item`s (no sorting). Symlinks are resolved with a follow-up `stat` so
/// that a link to a folder behaves like a folder; a broken link stays a (size 0) non-folder.
pub async fn read_items(sftp: &SftpSession, dir: &str) -> SshResult<Vec<Item>> {
    let rd = sftp.read_dir(dir).await.map_err(map_err)?;
    let mut out = Vec::new();
    for e in rd {
        let mut it = item_from_entry(&e);
        if it.name == "." || it.name == ".." {
            continue;
        }
        if it.is_symlink {
            if let Ok(md) = sftp.metadata(join_remote(dir, &it.name)).await {
                let target = item_from_metadata(it.name.clone(), &md);
                it.is_dir = target.is_dir;
                it.size = target.size;
                if it.mtime.is_none() {
                    it.mtime = target.mtime;
                }
            }
        }
        out.push(it);
    }
    Ok(out)
}

/// `stat` one remote path (follows symlinks). Used by transfer planning.
pub async fn stat(sftp: &SftpSession, path: &str) -> SshResult<Item> {
    let md = sftp.metadata(path).await.map_err(map_err)?;
    Ok(item_from_metadata(base_name(path).to_string(), &md))
}

/// `sftp_home`: the server's start directory ("." canonicalized).
pub async fn home(app: &AppHandle, sftp_id: &str) -> SshResult<String> {
    let (sftp, _) = get(app, sftp_id)?;
    sftp.canonicalize(".").await.map_err(map_err)
}

/// `sftp_list`: directories first, then by name (case-insensitive).
pub async fn list(app: &AppHandle, sftp_id: &str, path: &str) -> SshResult<Vec<FileEntry>> {
    let (sftp, _) = get(app, sftp_id)?;
    let mut items = read_items(&sftp, path).await?;
    items.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(items
        .into_iter()
        .map(|i| FileEntry {
            path: join_remote(path, &i.name),
            name: i.name,
            is_dir: i.is_dir,
            size: i.size,
            modified: i.mtime.map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339()),
            permissions: i.perms,
        })
        .collect())
}

// ---------------------------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------------------------

pub async fn mkdir(app: &AppHandle, sftp_id: &str, path: &str) -> SshResult<()> {
    let (sftp, _) = get(app, sftp_id)?;
    sftp.create_dir(path).await.map_err(map_err)
}

pub async fn rename(app: &AppHandle, sftp_id: &str, from: &str, to: &str) -> SshResult<()> {
    let (sftp, _) = get(app, sftp_id)?;
    sftp.rename(from, to).await.map_err(map_err)
}

/// `sftp_remove`: a file, a symlink, or a (non-empty) folder. Folders are walked iteratively
/// (children first, then the folder itself) — no recursion, so no boxed futures.
pub async fn remove(app: &AppHandle, sftp_id: &str, path: &str) -> SshResult<()> {
    let (sftp, _) = get(app, sftp_id)?;
    let md = sftp.symlink_metadata(path).await.map_err(map_err)?;
    let top = item_from_metadata(base_name(path).to_string(), &md);
    if !top.is_dir || top.is_symlink {
        // Plain file or a symlink (remove the link, never its target).
        return sftp.remove_file(path).await.map_err(map_err);
    }

    let mut to_visit = vec![path.to_string()];
    let mut dirs_in_order = Vec::new(); // parents before children
    while let Some(dir) = to_visit.pop() {
        for it in read_items_no_follow(&sftp, &dir).await? {
            let full = join_remote(&dir, &it.name);
            if it.is_dir && !it.is_symlink {
                to_visit.push(full);
            } else {
                sftp.remove_file(&full).await.map_err(map_err)?;
            }
        }
        dirs_in_order.push(dir);
    }
    // Children were pushed after their parents, so reverse order removes deepest folders first.
    for d in dirs_in_order.into_iter().rev() {
        sftp.remove_dir(&d).await.map_err(map_err)?;
    }
    Ok(())
}

/// Like `read_items` but never follows symlinks (deleting must not wander into link targets).
async fn read_items_no_follow(sftp: &SftpSession, dir: &str) -> SshResult<Vec<Item>> {
    let rd = sftp.read_dir(dir).await.map_err(map_err)?;
    Ok(rd.map(|e| item_from_entry(&e)).filter(|i| i.name != "." && i.name != "..").collect())
}

# Drag-out to Explorer (SFTP -> Windows) — design note

Audience: other AIs and the maintainer. Read `src-tauri/src/sftp/dragout.rs` (heavily commented) together with this file.

## What the user sees
Select rows in the SFTP file list, drag them out of the window onto an Explorer folder / the desktop. The drag starts at once; Explorer
shows its own copy dialog while it pulls the bytes from the server. Cancel in that dialog stops the transfer. No temp files, no size cap.

## Why virtual files
Real files must exist on disk before a classic file drag (CF_HDROP) starts, so the old code downloaded first. Windows also supports
*virtual files*: the drag carries only names + sizes (`CFSTR_FILEDESCRIPTORW`) and the receiver asks for the bytes lazily through an
`IStream` (`CFSTR_FILECONTENTS`). That is what Outlook attachments and zip folders do. We use the maintained crate
`virtual-file-transfer` for the OLE plumbing instead of writing `IDataObject`/`IStream` ourselves.

## Flow
1. User presses on a row and moves 5 px -> `FileTable.beginDrag` calls `onDragBegin(entries, "start")`.
2. `SftpTab.beginPlan` -> store `planDrag` -> command `sftp_drag_plan` -> `dragout::plan`: stats the items (in parallel), walks folders,
   returns `DragFile { relPath, remotePath, size }[]`. Plain files are planned at once; folders only when the pointer gets within 250 px
   of the window edge (`"near-edge"`), so an ordinary move inside the list never walks a big tree.
3. Pointer leaves the window (button still down) -> `onDragOut` -> `SftpTab.dragOut` awaits the plan -> `sftp_drag_start` ->
   `dragout::start`: sanitizes names, builds one `VirtualFile` per file (lazy `FactorySource`), then `begin_drag` (OLE `DoDragDrop`) on the
   UI thread via `AppHandle::run_on_main_thread`. The command resolves when the drag ends.
4. Explorer calls `IStream::Read` -> `SftpStreamReader::read` (blocking `Read`) -> bounded tokio channel <- background task reading the
   remote file with russh-sftp in 64 KiB chunks (read-ahead 4 MiB). Reader dropped = task ends.

## Transfers list (progress of a drag)
Explorer pulls the bytes itself, so `transfer.rs` never sees them; a drag used to leave the "Transfers" list empty. Now:
* `dragout::start` takes a Tauri `Channel<TransferProgress>` (the UI passes one from `store/sftp.ts startVirtualDrag`) and creates
  ONE `DragGroup` per dragged top-level item (a file = one row, a folder = one row summing all files inside). All rows appear as
  `queued` when the drag starts; the first bytes Explorer reads switch a row to `running`; the last byte makes it `done`.
* Each group is registered in `SftpManager.jobs`, so the normal **Cancel** button (`transfer_cancel`) and the "connection closed"
  abort (`transfer::abort_for_sftp`) work. Cancel makes `SftpStreamReader::read` fail, so Explorer stops and shows its own error.
* The counting / event-throttling state machine is `sftp/dragprogress.rs` (pure std, unit tests: `cargo test dragprogress`).
* After `begin_drag` returns, a watchdog waits until Explorer has been silent for 5 s (no open stream, no bytes) and then closes
  rows that are still open: never-read rows carry `error: "drag-unused"` and the UI removes them (drag ended on something that
  does not read virtual files, or Esc); half-copied rows show "Cancelled" (Explorer's own Cancel button).
* Reader errors (network, file shorter than listed, 60 s stall) end the row as `error` with the message.

## Rules that are easy to break
* The size given with `VirtualFile::with_size` MUST equal the bytes delivered (Explorer calls `IStream::Stat`). The reader delivers exactly
  `size` bytes, or fails with an error if the server file is shorter (never a silently short file).
* The reader is lazy: the SFTP file is opened on the first `read`, not when Explorer opens the stream.
* `begin_drag` must run on the UI thread and needs the mouse button held. Never call it from a tokio worker.
* Never hold a std mutex guard across an `.await` (project rule).
* Names: `finalize` removes characters/devices Windows rejects and de-duplicates names that differ only by case.

## Known limits (crate v0.1)
* Drop targets must support virtual files. Explorer does; browser upload areas and many chat apps do not -> use **Download**.
* Empty folders are not created (only files can be described). File times/permissions are not applied.
* Throughput equals the normal Download (sequential 64 KiB reads). A later improvement could read several ranges in parallel.
* While Explorer copies, its reads run on the UI thread, so the app window may feel busy until the copy ends.
* Symlinks to folders are skipped; symlinks to files are copied as files. More than 20,000 files in one drag is refused (use Download).

## Fallback
`SftpTab.dragOutLegacy` (old method: temp folder + `tauri-plugin-drag`) runs only when the new method fails to start for a technical
reason. "invalid" errors (e.g. too many files) are shown to the user instead of silently falling back.

## Test list (Windows 11)
- [ ] Drag 1 small file to the desktop: appears, content identical (compare hash).
- [ ] Drag 3 files + 1 folder with sub-folders: structure preserved.
- [ ] Drag a 2 GB file: drag starts at once, Explorer progress runs, app memory stays flat; Cancel in Explorer's dialog stops it.
- [ ] Release the mouse before leaving the window: nothing happens, no error.
- [ ] File names with `:` `?` and `CON`: renamed with `_`, no failure. Two names differing only by case: second gets ` (2)`.
- [ ] Disconnect mid-copy: Explorer shows a clear error, the app does not hang.
- [ ] Drop onto a browser upload page: refused by the browser (expected, see limits).
- [ ] Moving rows onto a folder row inside the list still works and triggers no folder walk.
- [ ] Drag 2 files + 1 folder: three rows appear as "queued" in Transfers, then run one after another and end as "Done".
- [ ] Click Cancel on a running drag row: Explorer's copy stops with an error, the row says "Cancelled".
- [ ] Drag out of the window and back in / press Esc: the queued rows disappear after ~5 s (no "Cancelled" clutter).
- [ ] Press Cancel in Explorer's own copy dialog: the open row ends as "Cancelled" within ~5 s.
- [ ] Disconnect mid-copy: the row shows "Error: The connection was closed during the transfer."

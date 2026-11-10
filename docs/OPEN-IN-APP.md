# Open in default app (SFTP): edit a remote file with any Windows program

**What the user sees**
- SFTP tab: double-click a file (or select it and press Enter, or right-click > *Open in default app*).
- The file is downloaded to `%TEMP%\ssh-clone-edit\<uuid>\<same name>` and opened with the program Windows associates with it.
- Edit and save in that program: every save is uploaded back to the SAME remote path ("Saved ... to the server" toast).
- If the server copy changed meanwhile, a dialog asks: *Overwrite server copy* or *Keep server copy* (default / Esc = keep).

**Where the code is**
| Part | File |
|---|---|
| Whole feature (download, open, watch, upload, conflict check) | `src-tauri/src/sftp/edit.rs` |
| Commands `sftp_edit_open`, `sftp_edit_resolve` | `src-tauri/src/commands/sftp_cmds.rs` (registered in `lib.rs`) |
| Ends sessions when the SFTP view / SSH session closes | `sftp/mod.rs` (`close_session`), `sftp/remote.rs` (`close`) |
| JS wrappers | `src/api/sftp.ts` (`sftpEditOpen`, `sftpEditResolve`), type `EditEvent` in `src/api/types.ts` |
| Reacting to events (toasts, conflict dialog) | `src/store/sftp.ts` (`openInDefaultApp`, `handleEditEvent`) |
| Double-click / Enter / context menu | `src/tabs/SftpTab.tsx` (`openEntry`) |

**Libraries (no custom file watching or launching code)**
- `tauri-plugin-opener` (official Tauri plugin): opens the local copy in the default app. Called from Rust only, so no capability entry is needed.
- `notify` 8 (maintained file-watcher crate): fires when the editor saves. Events are debounced (700 ms), because editors write in several steps and Word saves via temp file + rename.

**Behaviour worth knowing**
- Upload is IN PLACE (open + truncate), so the remote file keeps its permissions and owner (e.g. executable scripts). If a connection drops mid-upload the server copy can be incomplete: the error toast says so and the next save retries (the edits always stay in the local copy).
- Opening a file that is already being edited reuses the same local copy (no re-download over unsaved edits).
- Files over 512 MB are refused (use Download). Local copies older than 7 days are removed the next time a file is opened; they are NOT deleted when the connection closes.
- If the connection closes with edits not yet uploaded, an error toast names the local copy that still holds them.

**Not verified here** (no Rust toolchain in the authoring sandbox): run `npm run tauri dev` once; `cargo test` covers `safe_name` and the watcher event filter.

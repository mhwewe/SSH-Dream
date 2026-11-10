# HANDOFF-LOG.md

<!-- AI READER NOTE: append one entry per handoff. Never delete older entries. -->

## Handoff 1 — Foundation, Profiles, Passwords, RDP

### Status
All Handoff 1 source files are written. **NOT YET COMPILED OR RUN**: the author's sandbox had no
network, no Rust toolchain and no Windows. The first thing the user/next AI must do is run the
bring-up steps below and fix any compile errors (most likely spots are listed under "Risk spots").

### Bring-up steps (Windows 11, from the repo root)
1. Install prerequisites: Node 20+, Rust (rustup, MSVC toolchain), WebView2 (ships with Win 11).
2. `npm install`
3. `npm run tauri dev` (first Rust build takes several minutes)
4. Tick the checklist in HANDOFF-1-foundation.md §7.
5. Fill the "Pinned versions" table below from `package-lock.json` / `src-tauri/Cargo.lock`.
6. Replace the placeholder icons when wanted: `npm run tauri icon path/to/logo.png`.

### Pinned versions (TO FILL after first install)
| Package | Range used in manifest | Exact version after install |
|---|---|---|
| tauri / tauri-build | 2 | ? |
| tauri-plugin-dialog | 2 | ? |
| keyring | 3 (feature `windows-native`) | ? |
| windows | 0.58 | ? |
| @tauri-apps/api, plugin-dialog, cli | ^2 | ? |
| react / react-dom | ^18.3.1 | ? |
| zustand | ^5 | ? |
| vite / typescript | ^5 / ^5.5 | ? |

### Where things are
* Session STUBS: `src-tauri/src/commands/session_stub.rs` (3 functions). Handoff 2 replaces the **bodies**
  and keeps names/signatures. Frontend side already calls them via `src/api/session.ts` and listens to
  `session://state` in `src/store/sessions.ts`.
* `AppState.sessions` (state.rs) is empty; Handoff 2 fills it.
* Tabs `TerminalTab.tsx` / `SftpTab.tsx` are placeholders for Handoff 2 / 3.
* Log pane: backend `logging::emit_log` -> `session://log` -> `src/store/logs.ts` -> `LogPane.tsx`.

### Deviations from the contract / Handoff text
1. **Contract addition (README updated):** `ui_state_get` / `ui_state_set` commands. Needed because
   README §5.5 defines `ui_state.json` but no command to read/write it.
2. Extra frontend files not in the §4 list: `store/toasts.ts`, `store/dialogs.ts`, `components/Dialogs.tsx`,
   `api/invoke.ts`. Reason: WebView2 has no usable `window.prompt/confirm` (needed for rename, save-as
   name, delete confirm and the Save/Discard/Cancel dialog), and one place to normalize errors.
3. Credential deletion after RDP launch uses `cmdkey /delete:<target>` (no secret in args); only the
   *write* uses `CredWriteW` (the secret-carrying step). Avoids depending on the exact `CredDeleteW` signature.
4. `Log in` and RDP `Connect` **auto-save the profile first**, because the backend reads the saved profile
   and keyring, not the unsaved draft.
5. Passwords typed for a profile whose "Store encrypted password" box is unticked stay in memory for that
   profile's session only (used as one-time `overrides` on Log in) and are cleared when switching profiles.
6. Which flag controls which secret: `ssh` and `key_passphrase` follow `ssh.storePassword`; `rdp` follows
   `rdp.storePassword` (the contract has no separate passphrase flag).
7. "Rename" writes only the name; other unsaved edits stay unsaved in the draft.

### Risk spots to check first if the build fails (code was never compiled)
* `src-tauri/src/rdp.rs` `wincred::write`: field names/types of `CREDENTIALW` in the pinned `windows` version.
* `keyring` v3: needs feature `windows-native` (set); API used: `Entry::new`, `set_password`, `get_password`, `delete_credential`.
* `tauri.conf.json` icon list expects the files in `src-tauri/icons/` (placeholders included).
* `npm run build` runs `tsc` with `strict`; fix any type complaints (unused vars are allowed).
* Capabilities: `dialog:default`, `core:window:allow-set-title`, `core:window:allow-close` in `capabilities/default.json`.

### Known limitations / open questions for the user
* RDP credential lifetime is 20 s (`CLEANUP_DELAY_SECS` in rdp.rs). Lengthen if mstsc is slow to read it.
* Deleting a profile whose session is connected does not disconnect it yet (no real sessions until H2).
* Window title is set from the frontend; the OS title bar shows `<profile>[*] - SSH Clone`.
* App name is the working name `ssh-clone` (ask the user if they want another).
## Handoff 2 — SSH sessions, host keys, terminal  (append this to HANDOFF-LOG.md)

**Status: code written, NOT compiled or run.** The build sandbox had no package installs, so
`cargo build`, `npm run tauri dev`, `cargo clippy` and the §6 test plan still have to be done on
a Windows machine. Do not tick the §8 acceptance checklist until they pass.

### Versions
* russh: target **0.65.x** (0.65.1 was the latest on docs.rs when this was written). Code follows that
  version's `client_exec_interactive.rs` example: `check_server_key(&PublicKeyOrCertificate)`,
  `connect_stream`, `AuthResult::success()`, `PrivateKeyWithHashAlg`, `Handler::disconnected`.
* Others: see `Cargo-additions.toml` (tokio 1, uuid 1, chrono 0.4, keyring 3). Record the exact
  locked versions from `Cargo.lock` here after the first build.
* Frontend: `@xterm/xterm`, `@xterm/addon-fit` (latest at install time).

### How it works
* `SshManager` (managed state) holds sessions, a profile->session index, logins in progress, a
  channel->session index and pending host-key prompts. One std Mutex, never held across `.await`.
* One SSH connection per session; terminals are channels on it. `session::get_handle()` gives H3 the
  shared handle; `session::cleanup()` is the single teardown function (H3: add SFTP closing there).
* **Terminal-closed notification:** each terminal runs in its own task (`terminal::run_terminal`). When its
  channel ends (shell exit, server drop, logout) the task emits `term://closed {channelId, sessionId, exitStatus?}`.
  This is the only emitter of that event. Output is sent via `tauri::ipc::Channel`, coalesced to ~8 ms.
* Host keys: `known_hosts.json` (README format). Unknown/changed key -> `hostkey://prompt` and a 120 s wait.
* Auth: password (+ keyboard-interactive fallback answering every prompt with the password) and
  public key (+ optional passphrase). Missing secrets are reported as `auth_failed` with message
  `password_required` / `passphrase_required` BEFORE any network traffic.

### Deviations from the plan
1. Session map lives in its own managed `SshManager`, not in `AppState` (H1 code not available).
2. `ssh/glue.rs` reads the profile JSON and the keyring directly (contract-defined) instead of calling H1 modules.
3. Own error type `SshErr` (same JSON shape as `AppError`).
4. KEX log line is the generic `Key exchange completed.` (cipher/kex names are not logged; allowed by §4.2 step 4).
5. No new events or commands were added to README §5.2/§5.3.

### Known limitations / open questions
* Log out while still "connecting" does nothing (no cancel hook yet); rejecting the host-key prompt cancels it.
* Host certificates are refused (out of scope). ssh-agent/Pageant, jump hosts, auto-reconnect are out (per plan).
* Closing a tab while the shell is alive closes the channel; there is no confirmation.
* Possible first-build fixes: russh feature flags on Windows (crypto backend), keyring backend feature.


## Handoff 3 — SFTP, transfers, release prep

**Status: code written, NOT compiled or run.** Same situation as H1/H2: the build sandbox had no Rust
toolchain, no network and no Windows. The §9 acceptance checklist of HANDOFF-3 is therefore **not ticked**.
H2's entry above was appended here by the H3 author (H2 shipped it as a separate file).

### What was done
* **Merged H1 + H2** into one tree first (H2 had been written without H1's code): applied H2's
  `INTEGRATION.md` (lib.rs, commands/mod.rs, Cargo.toml, App.tsx, ActionBar, main.tsx), deleted
  `commands/session_stub.rs`, and replaced H1's `store/sessions.ts` by H2's (H1's `stateOf` /
  `initSessionListener` no longer exist; App.tsx was adapted).
* **Backend** `src-tauri/src/sftp/`: `mod.rs` (SftpManager, `close_session`), `remote.rs` (open/close/list/home/
  mkdir/rename/recursive remove), `transfer.rs` (queue + worker limit 2, folders, progress throttle 10/s,
  cancel, conflicts, `.part` + rename). Commands in `commands/sftp_cmds.rs`. Hook added in
  `ssh/session.rs::cleanup` (`crate::sftp::close_session`).
* **Frontend**: `api/sftp.ts`, `store/sftp.ts`, `lib/paths.ts` (`joinLocal`, `joinRemote`, ...),
  `tabs/SftpTab.tsx`, `components/sftp/{FileTable,TransferQueue,ConflictDialog}.tsx`, `sftp.css`.
* **Packaging config**: CSP + devCsp, WebView2 `downloadBootstrapper`, NSIS per-user install, bundle metadata
  in `tauri.conf.json`. README status section + `USER-GUIDE.md` written.

### Library choice (user said "choose whatever")
**TanStack Table v8 + TanStack Virtual v3** (headless, maintained). Sorting is `manualSorting` (we sort so folders
stay on top); selection logic is ours; rows are virtualized.

### Versions to pin after the first `npm install` / `cargo update` (fill in)
| Package | Range in manifest | Exact |
|---|---|---|
| russh | 0.65 | ? |
| russh-sftp | 2 | ? |
| tokio-util | 0.7 | ? |
| @tanstack/react-table / react-virtual | ^8.20 / ^3.10 | ? |
| @xterm/xterm / addon-fit | ^5.5 / ^0.10 | ? |

### Contract additions / clarifications (README updated)
* `transfer_resolve` and `transfer://conflict` (already listed in README §5.2/§5.3) are implemented.
* Argument shapes fixed: `sftp_mkdir(sftpId, path)`, `sftp_rename(sftpId, from, to)`, `sftp_remove(sftpId, path)`;
  `transfer_start` paths are the full path of the item on each side.
* "Apply to all" is remembered by the backend while any transfer is active, and cleared when the queue is idle.

### Deviations from HANDOFF-3
1. SFTP handles live in their own managed `SftpManager`, not in `SessionEntry` (H2's struct untouched).
2. `sftp_list` returns exactly the contract `FileEntry`; no extra `isSymlink` field. Symlinks to folders are
   shown as folders; folder symlinks are never followed during transfers or deletes (loop protection).
3. Not done (needs a real machine): the whole §6 regression/QA pass, the §7 clean-VM install test, icon and
   `identifier` decisions (`com.sshclone.app` is still the placeholder — ask the user).
4. Modification times are not preserved (optional in the plan).

### Risk spots if the build fails (most likely first)
* `sftp/remote.rs` — `perm_string`, `item_from_metadata`, `item_from_entry`: written from memory of russh-sftp 2.x
  (`Metadata::{len,file_type,modified,permissions}`, `FilePermissions` bool fields, `FileType::{is_dir,is_symlink}`).
  These three functions are the ONLY place that touches those types; adapt them to the pinned version.
* `russh-sftp` calls used: `SftpSession::new(channel.into_stream())`, `read_dir`, `metadata`, `symlink_metadata`,
  `canonicalize`, `create_dir`, `remove_file`, `remove_dir`, `rename`, `try_exists`, `open`, `create`, `close`.
* H2's untested russh code (`ssh/session.rs`) and H1's `rdp.rs` `CREDENTIALW` fields — see their entries.
* Frontend: `npm run build` runs `tsc --strict`; only a syntax-level check was possible here.

### Known limitations
* Throughput: one 64 KiB request in flight per file (no pipelining) — fine on LAN, slower on high-latency links.
* Cancelling a transfer that is waiting on a stalled server can take until the server answers or the session drops.
* The UI shows one SFTP view per profile; the backend API supports several `sftpId`s.
* Drag-and-drop only reacts over the file list (not the toolbar/queue) — by design.

### Still to run (HANDOFF-3 §6, nothing below has been executed)
- [ ] H1 + H2 acceptance checklists
- [ ] Two profiles with SFTP + terminals open: each keeps path, selection, queue
- [ ] Upload/download: 1 B, 1 GB (flat memory), 2,000 small files, unicode/space names, read-only destination
- [ ] Cancel mid-transfer: no `.part` leftovers; conflict dialog overwrite/skip/rename + "apply to all"
- [ ] Disconnect during a transfer: row shows error, app stable
- [ ] Delete a non-empty remote folder
- [ ] Security sweep (grep app data dir/logs/profile JSON for test passwords; CSP in place, capabilities minimal)
- [ ] Terminal flood while transferring: UI responsive
- [ ] `npm run tauri build`; install on a clean user; smoke test; restart keeps profiles

### Suggested next features
Port forwarding, ssh-agent/Pageant, auto-reconnect, resumable transfers, request pipelining for speed,
preserve mtimes, code signing.

## Bring-up fix log (first real run on Windows)
* `npm run tauri dev` crashed with `EBUSY: resource busy or locked, watch ...src-tauri\target\debug\build\...exe`
  (Vite's file watcher tried to watch cargo's build output). Fixed in `vite.config.ts` with
  `server.watch.ignored: ["**/src-tauri/**"]`. The Rust build itself had started fine (no Rust compile errors seen yet).
* `cargo` error "future cannot be sent between threads safely" in `ssh/terminal.rs::open` (`term_open`): a std `MutexGuard` was
  still alive across `channel.close().await`. Fixed by computing a `registered: bool` inside a lock-only block and awaiting after it.
  RULE for all code here: never keep a `lock(...)` guard in scope across an `.await`.
* `aws-lc-sys` (russh's crypto backend) needs NASM on Windows: `choco install nasm -y`, then open a NEW terminal.


## UI update — square sidebar, SFTP history/bookmarks/last folder, RDP smart resize
**Not compiled here** (no node_modules/crates available in the sandbox). Checked: `tsc` strict on the store/lib files with stubbed
zustand/tauri modules, no errors; Rust: `parse_resolution` + `build_rdp_text` compiled standalone and their 3 unit tests pass
(they are now in `rdp.rs` under `#[cfg(test)]`, run with `cargo test`). Everything else needs `npm run tauri dev` on Windows.

* **Sidebar** — `ActionBar.tsx` is now icon-only square buttons (inline SVG, tooltips). Size = `--ab-size` on `.actionbar` in `styles.css`.
* **Back / Forward** — there were NO such buttons before. Added to the SFTP toolbar: per-profile history (max 100) in `store/sftp.ts`
  (`Pane.history`, `Pane.histIdx`; actions `back`, `forward`; `navigate(profileId, path, "push"|"keep")`). Also Alt+Left/Right and
  mouse buttons 4/5 (`SftpTab.tsx`; the browser's own history navigation is cancelled).
* **Last folder + bookmarks** — new backend file `sftp_prefs.json` (`prefs.rs`, `commands/prefs.rs`, commands `sftp_prefs_get/set`
  registered in `lib.rs`). Frontend: `api/prefs.ts`, `store/sftpPrefs.ts` (debounced 400 ms write; refuses to write before the first read).
  `ensureOpen` starts in this run's last folder, else the saved one, else home; if that folder is gone it falls back to home, then `/`.
  Bookmarks panel (left of the file list, outside the drag-and-drop zone), ☆/★ in the path bar, ✎ rename, × remove. Data is keyed by
  profile id, so "Save profile as" starts with no bookmarks.
* **RDP** — `RdpConfig` gained `resolution: Option<String>` and `smart_resize: bool` (default true; old profile files load fine thanks to
  `#[serde(default)]`). `.rdp` now contains `dynamic resolution:i:1|0`, `smart sizing:i:0` (we want a real resize, not scaling),
  `use multimon:i:0` and, when set, `desktopwidth/desktopheight`. Resolution is validated in `lib/resolution.ts` (UI + save) and
  `rdp::parse_resolution` (profiles.rs `validate` + launch).
* **Test on Windows**: (1) RDP to a Win 10/11 host, drag the mstsc window edge → remote desktop resizes (if it only scales or shows
  scrollbars, the host does not support dynamic resolution); (2) set `1600x900`, Connect → window opens at that size;
  (3) SFTP: navigate a few folders, Back/Forward, restart the app, log in → same folder; add/rename/remove bookmarks, restart.

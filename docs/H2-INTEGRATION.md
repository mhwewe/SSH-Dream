# Handoff 2 — how to plug these files into the Handoff-1 repo

Handoff 2 was written WITHOUT the Handoff-1 code, from the README contract only. Everything is
new files; the few edits to existing H1 files are listed here. Nothing was compiled or run
(no package installs in the build sandbox), so expect to fix small compile errors on first build,
most likely in `ssh/session.rs` (russh API).

## 1. Copy the files
Copy the contents of this zip's `src-tauri/` and `src/` into the repo root (they only add files).

## 2. Cargo
Merge `src-tauri/Cargo-additions.toml` into `src-tauri/Cargo.toml`. Keep any version H1 already pinned.

## 3. npm
```
npm i @xterm/xterm @xterm/addon-fit
```
(zustand and @tauri-apps/api are already H1 dependencies.)

## 4. Rust edits in existing files
**`src-tauri/src/lib.rs`**
```rust
mod ssh;                               // new module folder
// commands/mod.rs: add   pub mod ssh_cmds;

.manage(ssh::SshManager::default())    // next to H1's other .manage(...)

// In tauri::generate_handler![ ... ]: REMOVE the three H1 stubs
//   session_connect, session_disconnect, session_state
// and ADD:
commands::ssh_cmds::session_connect,
commands::ssh_cmds::session_disconnect,
commands::ssh_cmds::session_state,
commands::ssh_cmds::host_key_decide,
commands::ssh_cmds::term_open,
commands::ssh_cmds::term_write,
commands::ssh_cmds::term_resize,
commands::ssh_cmds::term_close,
```
Delete the H1 stub implementations (and any fake `session://state` emitter) so they cannot clash.

**Optional:** if H1 has `crate::error::AppError`, add `impl From<ssh::SshErr> for AppError`
(same `{code,message}` shape). `ssh/glue.rs` can call H1's profile/secret helpers instead of
reading the JSON file / keyring directly (two functions, nothing else changes).

## 5. Frontend edits in existing files
* `main.tsx`: `import "./ssh.css";`
* `App.tsx`:
  * call `useSessions.getState().init()` once (e.g. in a `useEffect(() => { void useSessions.getState().init(); }, [])`);
  * mount `<HostKeyDialog />` and `<PasswordDialog />` once, at the root;
  * render `<TerminalTab profile={activeProfile} active={tab === "terminal"} />` and keep it
    MOUNTED when another top-level tab is selected (hide with `display:none`, do not unmount).
* ActionBar: **Log in** -> `useSessions.getState().connect(activeProfile.id)`;
  **Log out** -> `disconnect(activeProfile.id)`; **New terminal console** -> `openTerminal(activeProfile)`
  (and switch to the Terminal tab).
* ProfileSwitcher dots: `useSessions(s => s.byProfile[profile.id]?.state ?? "disconnected")`.
* Remove H1's stub `store/sessions.ts` wiring if one exists (this file replaces it; keep the same path).

## 6. Tauri v2 capabilities
No new permission is needed for commands, events or `Channel`. Clipboard access in xterm uses the
WebView's `navigator.clipboard` (works on user gestures inside WebView2).

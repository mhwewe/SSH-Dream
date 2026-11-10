# SSH Client Clone (Bitvise-style) — Master Build Plan

## Status (updated by Handoff 3)

| | |
|---|---|
| **Version** | 0.1.0 |
| **Code complete** | Profiles + in-app switching, password/key auth, host-key verification, SSH terminals (xterm.js), single-pane SFTP with transfer queue (upload/download of files and folders, cancel, overwrite/skip/rename), RDP launch via `mstsc.exe`, Windows Credential Manager secrets, NSIS/MSI packaging config. |
| **Verified** | **Nothing has been compiled or run yet** (H1, H2 and H3 were all written in sandboxes without a Rust toolchain or Windows). First step on a Windows machine: `npm install` then `npm run tauri dev`, fix compile errors (see HANDOFF-LOG.md "Risk spots"), then run the checklists. |
| **Known limitations** | No dual-pane/local browser (by decision); no resumable transfers, sync, chmod editor, port forwarding, ssh-agent, auto-reconnect; host certificates refused; installer is unsigned (SmartScreen warns); transfer speed is limited by one request in flight per file (no pipelining yet). |
| **User docs** | `USER-GUIDE.md` |


<!--
  AI READER NOTE
  --------------
  This file is the SINGLE SOURCE OF TRUTH for architecture and for the IPC contract
  (command names, event names, data shapes). Each HANDOFF-*.md file refers back to it.
  If you must change the contract, change it HERE first, then note it in HANDOFF-LOG.md.
  Do not silently rename commands/events: the other handoffs depend on the exact names.
-->

## 1. What we are building

A Windows desktop app that looks and behaves like **Bitvise SSH Client** (the reference
screenshot: left action bar, tabbed Login/Options/Terminal/RDP/SFTP area, log pane at the bottom),
but with **profile switching inside the app** (no relaunching, no "Log out then open another .tlp").

### In scope (confirmed by the user)
| Feature | Notes |
|---|---|
| SSH terminal | xterm.js tabs, multiple terminals per connection |
| SFTP | **single remote pane** + transfer queue; upload/download via native dialogs and Explorer drag-and-drop (user rejected dual-pane) |
| RDP | launches Windows' built-in `mstsc.exe` (no embedded RDP engine) |
| Password saving | encrypted by the OS (Windows Credential Manager) — never in the profile file |
| Profile saving | one JSON file per profile, switchable inside the app |

### Scope decisions I made on the user's behalf (user said "no preference")
<!-- The user can veto any of these; if they do, edit this table and tell the affected handoff owner. -->
| Extra | Decision | Why |
|---|---|---|
| SSH key auth (private key + optional passphrase) | **IN** | Very common, small cost on top of password auth |
| Host key verification (known_hosts + fingerprint prompt) | **IN** | Security basics; Bitvise has a Host key manager |
| Dual-pane SFTP / local file browser pane | **OUT** (user explicitly rejected it) | Single remote pane + Upload/Download buttons + Explorer drop instead |
| Profile import/export | **Export/import of the JSON file only** | Cheap; no Bitvise `.tlp` parsing |
| Port forwarding / C2S / S2C / Kerberos / proxy / obfuscation | **OUT** | User said "that's about it" |

## 2. Stack (decided: user picked Tauri)

<!-- Do NOT swap libraries without asking the user. Rule from the user: use maintained libraries,
     never build complex components (terminal emulator, SSH protocol, SFTP protocol) from scratch. -->

| Layer | Choice | Role |
|---|---|---|
| App shell | **Tauri v2** (Rust backend + WebView2 frontend) | Window, IPC, packaging (MSI/NSIS) |
| Frontend | **React + TypeScript + Vite** | UI |
| UI state | **zustand** | Small store, easy for other AIs |
| Terminal | **@xterm/xterm** + **@xterm/addon-fit** (+ optional webgl addon) | Terminal emulator (do not write one) |
| SSH + SFTP | **russh** + **russh-sftp** (Rust, async/tokio) | One TCP/SSH connection, many channels |
| Secrets | **keyring** crate | Windows Credential Manager |
| RDP | `std::process::Command` → `mstsc.exe` + generated `.rdp` file | Windows only |
| IDs/serde | `uuid`, `serde`, `serde_json`, `thiserror`, `tokio` | Plumbing |

Always pin the **latest stable** versions at build time and record them in `HANDOFF-LOG.md`.
(russh's API has changed between minor versions — read the docs/examples of the exact version you pin.)

## 3. Architecture

```
┌───────────────────────── React UI (WebView2) ──────────────────────────┐
│ ProfileSwitcher │ Tabs: Login | Options | Terminal | RDP | SFTP | Log  │
└───────────────▲──────────────────────────────────────┬─────────────────┘
                │ events / Channel streams             │ invoke(command)
┌───────────────┴──────────────────────────────────────▼─────────────────┐
│ Tauri commands (src-tauri/src/commands/*.rs)  — thin, no business logic │
├───────────────────────────────────────────────────────────────────────┤
│ profiles.rs   secrets.rs   rdp.rs   ssh/{session,hostkeys,terminal}.rs │
│ sftp/{remote,transfer}.rs                                         │
└───────────────────────────────────────────────────────────────────────┘
```

Key ideas:
1. **Profile ≠ connection.** A *profile* is a saved JSON file. A *session* is a live SSH connection
   created from a profile. One profile → at most one live session at a time.
2. **Many profiles can be open (connected) at once.** The top bar switcher selects the *active* profile;
   every tab/pane below shows the active profile's session. Switching never disconnects anything.
3. **One SSH connection, many channels** (like Bitvise): terminals and SFTP are channels on the
   profile's single session.
4. The **backend owns all secrets**. The frontend can *set* a password (`secret_set`) and ask
   *whether one exists* (`secret_exists`), but can never read it back.

### Folder layout (final repo)
```
ssh-clone/
├─ README.md                      (this file, copied into repo root)
├─ HANDOFF-LOG.md
├─ package.json  vite.config.ts  tsconfig.json
├─ src/                           ← React frontend
│  ├─ main.tsx  App.tsx
│  ├─ api/            (typed wrappers around invoke(); ONE file per domain)
│  │   ├─ profiles.ts  secrets.ts  rdp.ts  session.ts  terminal.ts  sftp.ts
│  │   └─ types.ts               ← contract types from §5
│  ├─ store/          (zustand stores: profiles, sessions, logs, transfers)
│  ├─ components/     (ActionBar, ProfileSwitcher, LogPane, ...)
│  └─ tabs/           (LoginTab, OptionsTab, TerminalTab, RdpTab, SftpTab)
└─ src-tauri/
   ├─ Cargo.toml  tauri.conf.json  capabilities/
   └─ src/
      ├─ main.rs  lib.rs  error.rs  state.rs
      ├─ profiles.rs  secrets.rs  rdp.rs
      ├─ ssh/   (mod.rs session.rs hostkeys.rs terminal.rs)
      └─ sftp/  (mod.rs remote.rs transfer.rs)
```

## 4. Handoff order

| # | File | Owner delivers | Depends on |
|---|---|---|---|
| 1 | `HANDOFF-1-foundation.md` | Tauri scaffold, app shell, in-app profile switching, profile store, password saving, RDP launch, log pane, **stubs** for session commands | nothing |
| 2 | `HANDOFF-2-ssh-terminal.md` | Real SSH sessions (password + key), host key verification, terminal tabs | Handoff 1 |
| 3 | `HANDOFF-3-sftp-and-release.md` | SFTP single-pane + transfers, packaging, QA pass | Handoff 2 |

Each handoff **must end with a working, runnable app** and an entry in `HANDOFF-LOG.md`.

## 5. THE CONTRACT (exact names — do not rename)

### 5.1 Types (TypeScript view; the Rust structs use `#[serde(rename_all = "camelCase")]`)

```ts
// ---- Profile (stored as <app_data>/profiles/<id>.json) -------------------------------
export interface Profile {
  schemaVersion: 1;                 // bump + write a migration if the shape ever changes
  id: string;                       // uuid v4, also the file name
  name: string;                     // shown in the switcher, e.g. "Mobin host"
  ssh: {
    host: string;
    port: number;                   // default 22
    username: string;
    authMethod: "password" | "publickey";
    keyPath: string | null;         // path to private key file when authMethod = "publickey"
    storePassword: boolean;         // the "Store encrypted password in profile" checkbox
    autoLogin: boolean;             // default false: log in automatically when the app starts
  };
  rdp: {
    host: string | null;            // null = reuse ssh.host
    port: number;                   // default 3389
    username: string | null;        // null = reuse ssh.username
    storePassword: boolean;
    fullscreen: boolean;
    resolution: string | null;      // "1920x1080" (200-8192 per side); null/"" = mstsc's default size
    smartResize: boolean;           // default true: resizing the RDP window resizes the remote desktop
  };
  terminal: {
    fontFamily: string;             // default "Cascadia Mono"
    fontSize: number;               // default 14
    scrollback: number;             // default 5000
    termType: string;               // default "xterm-256color"
  };
  createdAt: string;                // ISO-8601
  updatedAt: string;                // ISO-8601
}

// ---- Errors: every command rejects with this ------------------------------------------
export interface AppError { code: string; message: string; }
// codes in use: "not_found" | "io" | "invalid" | "auth_failed" | "network" | "host_key_rejected"
//               | "secret_store" | "not_implemented" | "cancelled" | "internal"

// ---- Sessions / logging -----------------------------------------------------------------
export type SessionState = "disconnected" | "connecting" | "connected" | "error";
export interface LogEvent { sessionId: string | null; ts: string; level: "info" | "warn" | "error"; message: string; }
export interface HostKeyPrompt {
  promptId: string; sessionId: string; host: string; port: number;
  algorithm: string; fingerprintSha256: string;
  status: "unknown" | "changed";    // "changed" = DANGER, show a red warning
}

// ---- SFTP ------------------------------------------------------------------------------
export interface FileEntry {
  name: string; path: string; isDir: boolean; size: number;
  modified: string | null;          // ISO-8601 or null
  permissions: string | null;       // e.g. "rwxr-xr-x" (remote only)
}
export interface TransferProgress {
  transferId: string; fileName: string; direction: "upload" | "download";
  bytesDone: number; bytesTotal: number;
  state: "queued" | "running" | "done" | "error" | "cancelled"; error?: string;
}
```

### 5.2 Commands (`invoke("<name>", args)`; args are camelCase on the JS side)

| Domain | Command | Args → Returns | Owner |
|---|---|---|---|
| Profiles | `profile_list` | `() → Profile[]` | H1 |
| | `profile_get` | `(id) → Profile` | H1 |
| | `profile_save` | `(profile) → Profile` (create or overwrite; sets `updatedAt`) | H1 |
| | `profile_save_as` | `(profile, newName) → Profile` (new id, copies secrets) | H1 |
| | `profile_delete` | `(id) → void` (also deletes its secrets) | H1 |
| | `profile_export` / `profile_import` | `(id, path) → void` / `(path) → Profile` | H1 |
| | `ui_state_get` / `ui_state_set` | `() → { lastActiveProfileId: string \| null }` / `(lastActiveProfileId) → void` (persists the last active profile in `ui_state.json`; **added by H1**, see HANDOFF-LOG.md) | H1 |
| Secrets | `secret_set` | `(profileId, kind, value) → void` — `kind`: `"ssh" \| "rdp" \| "key_passphrase"` | H1 |
| | `secret_exists` | `(profileId, kind) → boolean` | H1 |
| | `secret_delete` | `(profileId, kind) → void` | H1 |
| RDP | `rdp_launch` | `(profileId) → void` | H1 |
| SFTP memory | `sftp_prefs_get` / `sftp_prefs_set` | `() → object` / `(value: object) → void` — per-profile last SFTP folder + bookmarks in `sftp_prefs.json` (shape owned by `store/sftpPrefs.ts`) | post-H3 |
| Session | `session_connect` | `(profileId, overrides?: {sshPassword?, keyPassphrase?}) → sessionId` | stub H1 / real H2 |
| | `session_disconnect` | `(sessionId) → void` | stub H1 / real H2 |
| | `session_state` | `(sessionId) → SessionState` | stub H1 / real H2 |
| | `host_key_decide` | `(promptId, accept, remember) → void` | H2 |
| Terminal | `term_open` | `(sessionId, cols, rows, onData: Channel<number[]>) → channelId` | H2 |
| | `term_write` | `(channelId, data: number[]) → void` | H2 |
| | `term_resize` | `(channelId, cols, rows) → void` | H2 |
| | `term_close` | `(channelId) → void` | H2 |
| SFTP | `sftp_open` | `(sessionId) → sftpId` | H3 |
| | `sftp_close` | `(sftpId) → void` | H3 |
| | `sftp_list` | `(sftpId, path) → FileEntry[]` | H3 |
| | `sftp_home` | `(sftpId) → string` (remote start dir) | H3 |
| | `sftp_mkdir` | `(sftpId, path) → void` | H3 |
| | `sftp_rename` | `(sftpId, from, to) → void` (both full remote paths) | H3 |
| | `sftp_remove` | `(sftpId, path) → void` (file, symlink or folder; folders are deleted recursively) | H3 |
| | `transfer_start` | `(sftpId, direction, localPath, remotePath, onProgress: Channel<TransferProgress>) → transferId` — `localPath`/`remotePath` are the FULL paths of one file or folder on each side (upload: remote path already ends with the name; download: local path = chosen folder + name) | H3 |
| | `transfer_cancel` | `(transferId) → void` | H3 |
| | `transfer_resolve` | `(transferId, action: "overwrite" \| "skip" \| "rename", applyToAll: boolean) → void` (answers a `transfer://conflict`) | H3 |

### 5.3 Events (backend → frontend, via `app.emit`)
| Event | Payload | Emitted by |
|---|---|---|
| `session://log` | `LogEvent` | any backend module (goes to the Log pane) |
| `session://state` | `{ sessionId, profileId, state: SessionState }` | H1 stub / H2 real |
| `hostkey://prompt` | `HostKeyPrompt` | H2 |
| `term://closed` | `{ channelId: string, sessionId: string, exitStatus?: number }` (terminal channel ended or session dropped) | H2 |
| `transfer://conflict` | `{ transferId: string, path: string }` (destination exists; UI answers with `transfer_resolve`) | H3 |

### 5.4 Secrets storage rules
* Keyring **service** = `"ssh-clone"`, **account** = `"<profileId>:<kind>"` (kind = `ssh`, `rdp`, `key_passphrase`).
* Passwords are **never** written to profile JSON, logs, or events. Do not `console.log`/`println!` them.
* The `storePassword` flag in the profile only records the user's *intent*; the secret itself lives in the keyring.

### 5.5 Data locations
* Profiles: `<app_data_dir>/profiles/<id>.json` (use Tauri's `app_data_dir()`).
* Known hosts: `<app_data_dir>/known_hosts.json` (own simple format, see Handoff 2).
* "Last active profile id": `<app_data_dir>/ui_state.json`.

## 6. Global rules for every AI working on this repo
1. **Comment generously.** Every file needs a header comment (purpose, who calls it, what it calls)
   and comments on every non-obvious block. Other AIs will pick this up cold.
2. **Never build a complex component from scratch** (terminal emulator, SSH/SFTP protocol, file-table
   virtualization, etc.). If you think you need to, stop and ask the user, proposing a maintained library in 3 lines.
3. **Keep commands thin**: validation + call into a module. No protocol logic in `commands/`.
4. **Run it before you hand off**: `npm run tauri dev` must start, and your acceptance checklist must pass.
5. **Update `HANDOFF-LOG.md`** (what you did, versions pinned, deviations, known bugs, open questions).
6. If you edit a plan file, keep this README's contract consistent with it.
7. The user works on Windows 11. Target Windows first; do not add Linux/macOS code paths unless trivial.

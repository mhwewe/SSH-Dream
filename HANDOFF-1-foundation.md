# HANDOFF 1 — Foundation, Profiles, Passwords, RDP

<!--
  AI READER NOTE
  --------------
  You are the FIRST builder. Read README.md fully before starting (contract in §5 is binding).
  Your job: give the next AI a runnable Tauri app with the complete UI shell, working profile
  management with in-app switching, working encrypted password saving, a working RDP launcher,
  and STUBS for everything SSH/SFTP so Handoff 2 can plug in without touching the UI shell.
  When done: tick the checklist in §7 and write your entry in HANDOFF-LOG.md.
-->

## 1. Goal
A Windows app that looks like the Bitvise client screenshot, where the user can:
* create / edit / save / "save as" / delete / export / import **profiles**,
* **switch profiles inside the app** (no restart),
* tick "Store encrypted password in profile" and have the password saved in **Windows Credential Manager**,
* click **New Remote Desktop** (or the RDP tab's Connect) and get `mstsc.exe` opened, pre-filled,
* see a **log pane** that shows backend log events.

SSH login/terminal/SFTP are **stubs** in this handoff (they return `not_implemented`, UI shows a friendly toast).

## 2. Before you write code (user rule)
The stack is already approved (README §2). If you want to add **any additional library** beyond that
table (e.g. a UI kit, a table lib), first propose it to the user in 3 lines and wait for an OK.
Suggested pre-approved extras: none. Plain CSS modules or a tiny CSS file is fine for the Bitvise look.

## 3. Scope

### In
1. Tauri v2 + React + TS + Vite scaffold (`npm create tauri-app@latest`, template: React + TypeScript).
2. App shell (layout from the screenshot):
   * **Header**: app title, **ProfileSwitcher** (dropdown of profiles + "New profile" + status dot per profile).
   * **Left ActionBar**: `Save profile`, `Save profile as`, `New terminal console`, `New SFTP window`, `New Remote Desktop`
     (the last three just focus the matching tab for now; terminal/SFTP are wired in H2/H3).
     Skip the "Server Control Panel" button (out of scope).
   * **Tab strip**: `Login | Options | Terminal | RDP | SFTP` (no S2C/C2S/Services/SSH/Notes/About).
   * **LoginTab**: Server (Host, Port), Authentication (Username, Initial method = Password / Public key,
     "Store encrypted password in profile" checkbox, Password field, Key file picker + passphrase when Public key).
   * **OptionsTab**: terminal font family, font size, scrollback, term type (maps to `Profile.terminal`).
   * **RdpTab**: host (blank = same as SSH host), port, username (blank = same), store-password checkbox + password,
     fullscreen checkbox, **Connect** button.
   * **TerminalTab / SftpTab**: placeholder panels ("Implemented in Handoff 2/3") — keep the files so later AIs just fill them.
   * **LogPane** (bottom): scrolling list of `LogEvent`s, auto-scroll, "Clear" button, max 1000 lines.
   * **Bottom buttons**: `Log in` / `Log out` (calls `session_connect`/`session_disconnect` stubs), `Exit`.
3. Profile store (Rust) — one JSON file per profile, atomic writes (write temp file then rename).
4. Secrets (Rust) with the `keyring` crate — set / exists / delete.
5. RDP launcher (Rust) — generates a temp `.rdp` and runs `mstsc.exe`.
6. Session **stubs** + `session://state` and `session://log` plumbing so the UI is already event-driven.
7. Remember last active profile (`ui_state.json`).

### Out
Real SSH, terminal, SFTP, host keys (Handoffs 2 and 3). Themes, i18n, auto-update, tray icon.

## 4. Files to create

```
src-tauri/src/
  main.rs          # just calls lib::run()
  lib.rs           # builds the Tauri app, registers commands, manages AppState
  error.rs         # AppError { code, message } + From<io::Error> etc.; implements Serialize
  state.rs         # AppState { sessions: Mutex<HashMap<..>> } — empty map for now, H2 fills it
  profiles.rs      # profile CRUD on disk + schema defaults + migration hook
  secrets.rs       # keyring wrapper: set/exists/delete by (profileId, kind)
  rdp.rs           # build .rdp text, write temp file, spawn mstsc, credential handling
  logging.rs       # helper: emit_log(app, session_id, level, msg) -> emits "session://log"
  commands/mod.rs
  commands/profiles.rs  commands/secrets.rs  commands/rdp.rs  commands/session_stub.rs
src/
  api/types.ts     # copy of README §5.1 types — keep identical
  api/profiles.ts  api/secrets.ts  api/rdp.ts  api/session.ts   # typed invoke wrappers
  store/profiles.ts  store/sessions.ts  store/logs.ts            # zustand
  components/ActionBar.tsx  ProfileSwitcher.tsx  LogPane.tsx  StatusDot.tsx  Toasts.tsx
  tabs/LoginTab.tsx  OptionsTab.tsx  RdpTab.tsx  TerminalTab.tsx  SftpTab.tsx
  App.tsx  main.tsx  styles.css
```

## 5. Step-by-step

### Step 1 — Scaffold
1. `npm create tauri-app@latest` → React + TypeScript. Name the app (working name `ssh-clone`; ask the user if they want another).
2. Add Rust deps: `serde`, `serde_json`, `thiserror`, `uuid` (v4), `chrono` (for ISO timestamps), `keyring`, `tokio` (features `rt-multi-thread`, `macros`, `sync`, `time`).
3. Add Tauri plugin `tauri-plugin-dialog` (open/save file dialogs for key file picker and export/import) and enable its capability in `src-tauri/capabilities/default.json`.
4. Add npm deps: `zustand` only (plus whatever the template gives you).
5. Window defaults: ~760×720, min 700×600 (Bitvise is a compact fixed-feel window), title `"<profile name> - SSH Clone"` updated when switching.

### Step 2 — Errors and logging plumbing
* `AppError { code: String, message: String }` implementing `Serialize`. Tauri commands return `Result<T, AppError>`.
  Use the codes listed in README §5.1. Add `From<std::io::Error>` → code `"io"`.
* `logging::emit_log(&AppHandle, Option<&str>, level, msg)` emits `session://log` with a `LogEvent` (timestamp as ISO-8601).
  Every command that does something noteworthy should log one line (e.g. "Profile saved: Mobin host"). **Never log secrets.**

### Step 3 — Profiles (`profiles.rs`)
* Directory: `app_data_dir()/profiles/`, create if missing.
* `Profile::default_new(name)` fills defaults from README §5.1 (port 22, rdp port 3389, font Cascadia Mono 14, scrollback 5000, `xterm-256color`, authMethod `"password"`).
* `list()` reads all `*.json`; skip (and log a warning for) files that fail to parse — never crash on a corrupt file.
* `save()` writes `<id>.json` atomically; sets `updatedAt`; sets `createdAt` on first save.
* `save_as(profile, new_name)`: new uuid, copy the profile, **copy the keyring secrets** (read via secrets module internally, write under the new id). The frontend can't read secrets, so this must be backend-side.
* `delete(id)`: remove the file and its keyring entries (`ssh`, `rdp`, `key_passphrase`; ignore "not found").
* `export(id, path)`: write the profile JSON (without secrets) to `path`. `import(path)`: parse, assign a **new id**, save.
* Validate: name non-empty, port 1–65535, host may be empty on a draft (the Log in button validates later).

### Step 4 — Secrets (`secrets.rs`)
* `keyring::Entry::new("ssh-clone", &format!("{profile_id}:{kind}"))`.
* `set`, `exists` (true if `get_password` succeeds; map `NoEntry` → false), `delete` (ignore `NoEntry`).
* Add an **internal** `get(profile_id, kind)` used by Handoff 2/RDP — **do not expose it as a Tauri command**.
* Windows Credential Manager has a size limit on a credential blob (a few KB) — enough for passwords/passphrases. Do not store private keys here; keys stay as files referenced by `keyPath`.

### Step 5 — RDP launcher (`rdp.rs`)
Flow for `rdp_launch(profileId)`:
1. Load the profile; resolve `host = rdp.host ?? ssh.host`, `username = rdp.username ?? ssh.username`; error `invalid` if host empty.
2. Build the `.rdp` text (one setting per line):
   ```
   full address:s:<host>
   server port:i:<port>
   username:s:<username>
   screen mode id:i:<2 if fullscreen else 1>
   prompt for credentials:i:0
   ```
   (`mstsc` ignores unknown keys; do not put passwords in this file — plain text.)
3. Credentials, **only if `rdp.storePassword` and a secret exists**: pre-register the password with Windows so
   mstsc doesn't prompt. Create a generic credential with target name `TERMSRV/<host>`, the username and the password.
   * **Recommended**: use the `windows` crate's `CredWriteW` (type `CRED_TYPE_GENERIC`, persist `CRED_PERSIST_SESSION`),
     so the password never appears on a command line.
   * **Fallback** (simpler, weaker): run `cmdkey /generic:TERMSRV/<host> /user:<u> /pass:<p>` — the password is visible
     in the process arguments for a moment. If you use this, note it in HANDOFF-LOG.md.
   * Schedule removal of that credential ~20 s after launch (spawn a tokio task) so it does not linger.
     **Test this on a real machine**: if mstsc reads the credential later than expected, lengthen the delay.
4. Write the `.rdp` to the OS temp dir (`<uuid>.rdp`), spawn `mstsc.exe <file>` (don't wait for it), delete the temp file after ~20 s.
5. Log `"Launching Remote Desktop to <host>:<port>"` (no secrets). If not on Windows: return error `invalid` with message "RDP launcher is Windows-only".

### Step 6 — Session stubs (`commands/session_stub.rs`)
* `session_connect` → logs "SSH not implemented yet (Handoff 2)" and returns `Err(not_implemented)`.
* `session_disconnect`, `session_state` → no-ops returning sensible values (`"disconnected"`).
* Keep the **exact signatures from README §5.2** so Handoff 2 only replaces bodies.
* On the frontend `store/sessions.ts` keeps `Record<profileId, {sessionId?, state}>` and subscribes to `session://state`.

### Step 7 — Frontend shell
* **ProfileSwitcher**: dropdown listing profiles (name + state dot: grey = disconnected, amber = connecting, green = connected, red = error).
  Actions in the dropdown: *New profile*, *Rename*, *Duplicate* (= save as), *Delete* (confirm dialog), *Import…*, *Export…*.
  Selecting a profile sets `activeProfileId` (persist to `ui_state.json`) and swaps what the tabs show — **without** touching other profiles' state.
* **Dirty tracking**: keep an edited copy of the active profile in the store; show an asterisk in the title when it differs from the saved one;
  when switching profiles with unsaved changes, ask Save / Discard / Cancel.
* **LoginTab** password field: when `storePassword` is ticked and the field is non-empty on Save, call `secret_set(profileId,"ssh",value)` then **clear the field** and show a placeholder like `•••••••• (saved)` using `secret_exists`.
  If the user unticks the box and saves → `secret_delete`.
* Same pattern for the RDP password and the key passphrase.
* **Log in** button: validates host/username, calls `session_connect`, shows the returned error as a toast (stub says not implemented).
* **Log pane** subscribes once at app start to `session://log` (`@tauri-apps/api/event` `listen`) and appends lines in the Bitvise style `HH:MM:SS.mmm  message` with an icon per level.
* Styling: compact, Segoe UI 12px, blue section headings, white inputs — see the screenshot. Do not spend time on pixel perfection; layout fidelity is enough.

## 6. Gotchas
* Tauri v2 **capabilities**: the dialog plugin and event listening need to be allowed in `capabilities/default.json`, otherwise calls silently fail.
* Tauri converts JS camelCase args to Rust snake_case params for commands automatically; keep names per README §5.2.
* `keyring` on Windows may return errors for empty strings — treat an empty password as "no secret" (delete instead of set).
* Don't hold a `Mutex` guard across an `.await` in async commands.
* Windows path separators: store `keyPath` exactly as the dialog returns it.
* WebView2 must be present (it ships with Windows 11).

## 7. Acceptance checklist (all must pass)
- [ ] `npm run tauri dev` starts; window looks like the screenshot layout (action bar, tabs, log pane, bottom buttons).
- [ ] Create two profiles A and B; edit fields; Save; restart the app → both still there, last active profile is restored.
- [ ] Switch A → B → A inside the app; fields change correctly; unsaved-changes prompt appears when expected.
- [ ] "Save profile as" creates a copy with its own id **and** its stored password still works.
- [ ] Tick "Store encrypted password", save, restart: placeholder shows "saved"; the profile JSON contains **no** password (open the file and check); the entry appears in Windows *Credential Manager → Windows Credentials* as `ssh-clone` / `<id>:ssh`.
- [ ] Delete a profile → its credential entries are gone.
- [ ] RDP: with stored password → `mstsc` opens and connects without a credential prompt (test against any RDP host, e.g. a Windows VM); without it → mstsc prompts.
- [ ] Export a profile to a file, delete it, import it back → works, new id.
- [ ] Log pane shows events for save/delete/launch; no secret ever appears in it.
- [ ] Log in button shows a "not implemented" toast (stub) and the app stays stable.
- [ ] `cargo clippy` and `npm run build` are clean (warnings reviewed).

## 8. What to hand to Handoff 2 (write this in HANDOFF-LOG.md)
* Exact crate/npm versions pinned.
* Where session stubs live and which functions to replace.
* Any deviation from the contract (there should be none).
* Known bugs / open questions for the user.

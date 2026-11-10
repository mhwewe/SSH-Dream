# MERGE NOTES (Handoff 1 + 2 + 3 combined)

<!--
  AI READER NOTE: this repo is the three handoff zips merged by following docs/H2-INTEGRATION.md
  and docs/H3-APPLY.md. Read README.md (contract) and HANDOFF-LOG.md (per-handoff notes) next.
  NOTHING HAS BEEN COMPILED OR RUN yet. The first job on a Windows machine is the bring-up below.
-->

## How it was merged
1. Started from the Handoff 1 repo (`ssh-clone-handoff1.zip`).
2. Copied Handoff 2 files over it (new `ssh/*`, `commands/ssh_cmds.rs`, terminal/dialog components, `ssh.css`).
   H2 replaced `src/store/sessions.ts`, `src/api/session.ts`, `src/tabs/TerminalTab.tsx` (as its notes say).
3. Deleted `src-tauri/src/commands/session_stub.rs`.
4. Unzipped Handoff 3 over the root. Its copies of `lib.rs`, `commands/mod.rs`, `App.tsx`, `ActionBar.tsx`,
   `main.tsx`, `Cargo.toml`, `package.json`, `tauri.conf.json`, `README.md`, `HANDOFF-LOG.md` already contain the H2
   integration edits; each was diffed against the H1+H2 version first and only adds H2/H3 wiring (nothing from H1 was dropped).
5. Moved the apply notes into `docs/` (`H2-INTEGRATION.md`, `H2-LOG-ENTRY.md`, `H3-APPLY.md`).

## Checks done without a compiler
* All JSON files parse (package.json, tsconfig, tauri.conf.json, capabilities).
* Every `#[tauri::command]` in the Rust sources is registered in `lib.rs` and every registered name exists.
* Every `mod` declared has a file; no leftover references to the H1 session stub or the old store API.
* Rust files parse with rustfmt; TypeScript files have no syntax errors.
* No dual-pane / local-listing code anywhere (single remote pane, as decided).

## Bring-up on Windows 11
1. Node 20+, Rust (MSVC toolchain), WebView2.
2. `npm install`, then `npm run tauri dev`.
3. Fix compile errors. Most likely spots: `src-tauri/src/sftp/remote.rs` (russh-sftp adapters), `src-tauri/src/ssh/session.rs` (russh API),
   `src-tauri/src/rdp.rs` (`windows` crate CREDENTIALW fields).
4. Fill the pinned-versions tables in `HANDOFF-LOG.md`, then run the acceptance checklists in the three HANDOFF-*.md plan files.

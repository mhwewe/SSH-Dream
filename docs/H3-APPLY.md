# Applying the Handoff 3 files

This zip holds ONLY the files that are new or changed, at their repo paths. Nothing was compiled
(no Rust toolchain / network in the build sandbox).

## Order
1. Start from your H1 repo and copy the Handoff 2 zip into it (`src/`, `src-tauri/`) as INTEGRATION.md says.
2. **Delete** `src-tauri/src/commands/session_stub.rs` (replaced by `ssh_cmds.rs`).
3. Unzip THIS archive over the repo root. It also contains the H2 integration edits, so these files
   replace your copies: `src-tauri/src/lib.rs`, `src-tauri/src/commands/mod.rs`, `src/App.tsx`,
   `src/components/ActionBar.tsx`, `src/main.tsx`, `src-tauri/Cargo.toml`, `package.json`.
   If you already edited any of them yourself, merge instead of overwriting.
4. `npm install` then `npm run tauri dev`. Fix compile errors (see HANDOFF-LOG.md "Risk spots":
   `src-tauri/src/sftp/remote.rs` adapters first).

## New (H3)
src-tauri/src/sftp/{mod,remote,transfer}.rs, src-tauri/src/commands/sftp_cmds.rs,
src/api/sftp.ts, src/store/sftp.ts, src/lib/paths.ts, src/tabs/SftpTab.tsx (replaces the placeholder),
src/components/sftp/{FileTable,TransferQueue,ConflictDialog}.tsx, src/sftp.css, USER-GUIDE.md

## Edited
ssh/session.rs (one line: `crate::sftp::close_session` in cleanup), tauri.conf.json (CSP, bundle),
Cargo.toml (russh, russh-sftp, tokio-util, tokio features), package.json (TanStack + xterm),
README.md (status + contract rows), HANDOFF-LOG.md (H2 + H3 entries).

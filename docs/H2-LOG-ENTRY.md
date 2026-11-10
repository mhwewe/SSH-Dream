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

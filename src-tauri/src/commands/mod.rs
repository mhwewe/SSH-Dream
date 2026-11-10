// commands/mod.rs — thin Tauri command layer (README rule 3: validation + one call into a module).
pub mod prefs;     // SFTP last folder + bookmarks (sftp_prefs.json)
pub mod profiles;
pub mod rdp;
pub mod secrets;
pub mod sftp_cmds; // Handoff 3: SFTP + transfers
pub mod ssh_cmds;  // Handoff 2: sessions, host keys, terminals (replaced the H1 session_stub)

// =============================================================================
// lib.rs — builds the Tauri app, registers plugins, state and ALL commands.
// Called by: main.rs.   Calls: every module below.
// AI READER NOTE: Handoff 2/3 add their commands to `generate_handler!` below. Command names
// must match README §5.2 exactly. Keep commands in src/commands/* thin (validation + a call
// into a module); protocol logic belongs in ssh/ and sftp/ modules.
// =============================================================================
pub mod commands;
mod error;
mod logging;
mod prefs;  // SFTP last folder + bookmarks
mod profiles;
mod rdp;
mod secrets;
mod sftp;   // Handoff 3: SFTP + transfers
mod ssh;    // Handoff 2: real SSH sessions, host keys, terminals
mod state;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Native file dialogs. Permission is granted in capabilities/default.json.
        .plugin(tauri_plugin_dialog::init())
        // Shared state (sessions map is empty in Handoff 1; Handoff 2 fills it).
        .manage(state::AppState::default())
        // H2: live SSH sessions / terminals / pending host-key prompts.
        .manage(ssh::SshManager::default())
        // H3: SFTP handles + transfer jobs (concurrency limit lives inside).
        .manage(sftp::SftpManager::new())
        .invoke_handler(tauri::generate_handler![
            // ---- Profiles (H1) ----
            commands::profiles::profile_list,
            commands::profiles::profile_get,
            commands::profiles::profile_save,
            commands::profiles::profile_save_as,
            commands::profiles::profile_delete,
            commands::profiles::profile_export,
            commands::profiles::profile_import,
            // UI state (H1 addition to the contract, documented in README §5.2)
            commands::profiles::ui_state_get,
            commands::profiles::ui_state_set,
            // ---- Secrets (H1) ----
            commands::secrets::secret_set,
            commands::secrets::secret_exists,
            commands::secrets::secret_delete,
            // ---- RDP (H1) ----
            commands::rdp::rdp_launch,
            // ---- Session + host keys + terminal (H2; replaced the H1 stubs) ----
            commands::ssh_cmds::session_connect,
            commands::ssh_cmds::session_disconnect,
            commands::ssh_cmds::session_state,
            commands::ssh_cmds::host_key_decide,
            commands::ssh_cmds::term_open,
            commands::ssh_cmds::term_write,
            commands::ssh_cmds::term_resize,
            commands::ssh_cmds::term_close,
            // ---- SFTP + transfers (H3) ----
            commands::sftp_cmds::sftp_open,
            commands::sftp_cmds::sftp_close,
            commands::sftp_cmds::sftp_home,
            commands::sftp_cmds::sftp_list,
            commands::sftp_cmds::sftp_mkdir,
            commands::sftp_cmds::sftp_rename,
            commands::sftp_cmds::sftp_remove,
            commands::sftp_cmds::transfer_start,
            commands::sftp_cmds::transfer_cancel,
            commands::sftp_cmds::transfer_resolve,
            // ---- SFTP memory: last folder + bookmarks ----
            commands::prefs::sftp_prefs_get,
            commands::prefs::sftp_prefs_set,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// main.rs — entry point only. All logic lives in lib.rs (Tauri v2 convention).
// Hides the extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ssh_clone_lib::run()
}

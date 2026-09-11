// commands/mod.rs — Central module registry for all Tauri command modules.
//
// Every new command module must be declared here AND registered in
// lib.rs's `invoke_handler`. This keeps the command surface tidy and
// grep-verifiable.

pub mod settings;
pub mod python_detect;
pub mod gpu_detect;
pub mod app_info;
pub mod workspace;
pub mod tracker;

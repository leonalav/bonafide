#[allow(unused_imports)]
pub mod orchestrator;
#[allow(unused_imports)]
pub mod threads;
#[allow(unused_imports)]
pub mod engine;
#[allow(unused_imports)]
pub mod llm;
#[allow(unused_imports)]
pub mod migrations;
#[allow(unused_imports)]
pub mod approval;
#[allow(unused_imports)]
pub mod tools;          // WS2-T1 + WS2-T2: full 37-tool registry
#[allow(unused_imports)]
pub mod budget;          // WS2-T4: real dollar + GPU-hour governor
#[allow(unused_imports)]
pub mod ipc;             // WS2-T5: agent_send_message + approval commands
#[allow(unused_imports)]
pub mod modes;           // WS3-T1..T6: per-mode protocol + ModeRegistry
#[allow(unused_imports)]
pub mod experiments;     // WS4-T1: Experiment CRUD
#[allow(unused_imports)]
pub mod critic;          // WS4-T4: ML review pipeline
#[allow(unused_imports)]
pub mod memory;          // WS4-T2: Project memory
#[allow(unused_imports)]
pub mod researcher;      // WS4-T3: arXiv integration
#[allow(unused_imports)]
pub mod monitoring;      // WS4-T5: Anomaly detection

// The WS1 stubs remain available for tests that want a no-op budget or
// a tool registry without the full catalog. WS2-T1 / WS2-T4 replace them
// at runtime via `Default::default()` — see engine.rs for the wiring.
#[allow(unused_imports)]
pub mod tools_stub;
#[allow(unused_imports)]
pub mod budget_stub;

#[allow(unused_imports)]
pub use orchestrator::*;
#[allow(unused_imports)]
pub use threads::*;
#[allow(unused_imports)]
pub use engine::*;
#[allow(unused_imports)]
pub use llm::*;
#[allow(unused_imports)]
pub use migrations::*;
#[allow(unused_imports)]
pub use approval::*;
#[allow(unused_imports)]
pub use tools::*;
#[allow(unused_imports)]
pub use budget::*;
#[allow(unused_imports)]
pub use ipc::*;
#[allow(unused_imports)]
pub use tools_stub::*;
#[allow(unused_imports)]
pub use budget_stub::*;

/// Shared workspace-hash helper. Canonicalizes the path, hashes with SHA-256,
/// and returns the first 8 bytes as a lowercase hex string.
/// Used by orchestrator/threads/lib to keep the hash key consistent.
pub fn compute_workspace_hash(root: &std::path::Path) -> String {
    let normalized = root.canonicalize()
        .unwrap_or_else(|_| root.to_path_buf())
        .to_string_lossy()
        .to_string();
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    sha2::Digest::update(&mut hasher, normalized.as_bytes());
    let digest = hasher.finalize();
    hex::encode(&digest[..8])
}

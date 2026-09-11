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
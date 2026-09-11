#[allow(unused_imports)]
pub mod orchestrator;
#[allow(unused_imports)]
pub mod threads;
#[allow(unused_imports)]
pub mod experiments;
#[allow(unused_imports)]
pub mod budget;
#[allow(unused_imports)]
pub mod engine;
#[allow(unused_imports)]
pub mod planner;
#[allow(unused_imports)]
pub mod scaffolder;
#[allow(unused_imports)]
pub mod memory;
#[allow(unused_imports)]
pub mod researcher;
#[allow(unused_imports)]
pub mod critic;
#[allow(unused_imports)]
pub mod monitoring;
#[allow(unused_imports)]
pub use orchestrator::*;
#[allow(unused_imports)]
pub use threads::*;
#[allow(unused_imports)]
pub use experiments::*;
#[allow(unused_imports)]
pub use budget::*;
#[allow(unused_imports)]
pub use engine::*;
#[allow(unused_imports)]
pub use planner::*;
#[allow(unused_imports)]
pub use scaffolder::*;
#[allow(unused_imports)]
pub use memory::*;
#[allow(unused_imports)]
pub use researcher::*;
#[allow(unused_imports)]
pub use critic::*;
#[allow(unused_imports)]
pub use monitoring::*;

/// Shared workspace-hash helper. Canonicalizes the path, hashes with SHA-256,
/// and returns the first 8 bytes as a lowercase hex string.
/// Used by budget/engine/planner/lib to keep the hash key consistent.
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

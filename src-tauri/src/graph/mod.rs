pub mod storage;
pub mod code_graph;
pub mod run_graph;

use std::path::{Path, PathBuf};

#[allow(unused_imports)]
pub use code_graph::{CodeGraphHit, IndexSummary};
#[allow(unused_imports)]
pub use run_graph::{query_run_graph, sync_from_mlflow, sync_from_wandb, RunEdgeKind, RunGraphNode, SyncSummary};

/// Lightweight per-workspace metadata stored in Tauri app state.
///
/// We deliberately do NOT store the rusqlite `Connection` here because
/// `Connection` is !Sync (it uses `RefCell` internally).  Instead, each
/// command opens a fresh connection to the workspace DB as needed.
pub struct Storage {
    pub(crate) root_path: PathBuf,
    pub(crate) last_opened_ts: i64,
}

impl Storage {
    pub fn new(root_path: PathBuf) -> Self {
        Self {
            root_path,
            last_opened_ts: storage::current_timestamp(),
        }
    }

    pub fn root_path(&self) -> Option<&Path> {
        if self.root_path.as_os_str().is_empty() {
            None
        } else {
            Some(&self.root_path)
        }
    }

    pub fn last_opened_ts(&self) -> i64 {
        self.last_opened_ts
    }
}


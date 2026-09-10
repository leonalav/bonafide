//! Tracker module — shim process management, credential storage, and
//! communication with the bonafide-run backend.

pub mod credentials;
pub mod error;
pub mod wandb;

pub use credentials::{delete_credential, get_credential, keyring_entry, keyring_service, set_credential};
pub use error::{TrackerError, TrackerErrorKind};
pub use wandb::{connect_tracker, disconnect_tracker, is_tracker_connected, ArtifactRef, RunConfig, RunDetail, RunPage, RunSummary, WandbProvider, Point};

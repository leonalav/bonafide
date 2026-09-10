//! Keyring-backed credential storage for the tracker module.
//!
//! Credentials are stored under the `bonafide` keyring service with entries
//! formatted as `tracker:{kind}:{workspace_hash}`.

use keyring::Entry;

use crate::tracker::error::{TrackerError, TrackerErrorKind};

/// The keyring service name used by Bonafide.
pub fn keyring_service() -> &'static str {
    "bonafide"
}

/// Constructs the full keyring entry name for a tracker credential.
///
/// Format: `tracker:{kind}:{workspace_hash}`
pub fn keyring_entry(kind: &str, workspace_hash: &str) -> String {
    format!("tracker:{kind}:{workspace_hash}")
}

/// Retrieves a credential from the OS keyring.
///
/// Returns `Ok(None)` if the entry does not exist.
pub fn get_credential(kind: &str, workspace_hash: &str) -> Result<Option<String>, TrackerError> {
    let entry_name = keyring_entry(kind, workspace_hash);
    let entry = Entry::new(keyring_service(), &entry_name)
        .map_err(|e| TrackerError {
            kind: TrackerErrorKind::AuthFailed,
            message: format!("Failed to open keyring entry: {e}"),
            hint: None,
        })?;

    match entry.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(TrackerError {
            kind: TrackerErrorKind::Unknown,
            message: format!("Failed to retrieve credential: {e}"),
            hint: None,
        }),
    }
}

/// Stores a credential in the OS keyring.
pub fn set_credential(
    kind: &str,
    workspace_hash: &str,
    value: &str,
) -> Result<(), TrackerError> {
    let entry_name = keyring_entry(kind, workspace_hash);
    let entry = Entry::new(keyring_service(), &entry_name)
        .map_err(|e| TrackerError {
            kind: TrackerErrorKind::AuthFailed,
            message: format!("Failed to open keyring entry: {e}"),
            hint: None,
        })?;

    entry
        .set_password(value)
        .map_err(|e| TrackerError {
            kind: TrackerErrorKind::Unknown,
            message: format!("Failed to store credential: {e}"),
            hint: None,
        })
}

/// Deletes a credential from the OS keyring.
pub fn delete_credential(kind: &str, workspace_hash: &str) -> Result<(), TrackerError> {
    let entry_name = keyring_entry(kind, workspace_hash);
    let entry = Entry::new(keyring_service(), &entry_name)
        .map_err(|e| TrackerError {
            kind: TrackerErrorKind::AuthFailed,
            message: format!("Failed to open keyring entry: {e}"),
            hint: None,
        })?;

    entry
        .delete_credential()
        .map_err(|e| match e {
            keyring::Error::NoEntry => TrackerError {
                kind: TrackerErrorKind::NotFound,
                message: "Credential entry not found".to_string(),
                hint: None,
            },
            _ => TrackerError {
                kind: TrackerErrorKind::Unknown,
                message: format!("Failed to delete credential: {e}"),
                hint: None,
            },
        })
}

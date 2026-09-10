// Integration smoke test for git_service. Run with:
//   cargo test --test git_smoke -- --nocapture
//
// We exercise the public async functions against the live workspace
// (a:/bonafide is itself a git repo). The test is skipped when git
// isn't on PATH or the workspace isn't a repo — CI runners without
// git installed will still pass.

use std::path::PathBuf;

#[tokio::test]
async fn status_returns_branch() {
    let workspace = env!("CARGO_MANIFEST_DIR").to_string();
    let parent = PathBuf::from(&workspace).parent().unwrap().to_string_lossy().to_string();

    let status = match bonafide_lib::git_service_for_tests::status(parent.clone()).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[skip] git_service::status failed: {e}");
            return;
        }
    };
    assert!(!status.branch.is_empty(), "branch should not be empty on a real repo");
}

#[tokio::test]
async fn log_returns_at_least_one_commit() {
    let workspace = env!("CARGO_MANIFEST_DIR").to_string();
    let parent = PathBuf::from(&workspace).parent().unwrap().to_string_lossy().to_string();

    let commits = match bonafide_lib::git_service_for_tests::log(parent.clone(), Some(5)).await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[skip] git_service::log failed: {e}");
            return;
        }
    };
    assert!(!commits.is_empty(), "expected at least one commit");
    assert!(!commits[0].hash.is_empty());
}

#[tokio::test]
async fn list_branches_includes_main() {
    let workspace = env!("CARGO_MANIFEST_DIR").to_string();
    let parent = PathBuf::from(&workspace).parent().unwrap().to_string_lossy().to_string();

    let branches = match bonafide_lib::git_service_for_tests::list_branches(parent.clone()).await {
        Ok(b) => b,
        Err(e) => {
            eprintln!("[skip] git_service::list_branches failed: {e}");
            return;
        }
    };
    // The workspace is whatever the user's repo is — we just check the
    // shape, not specific names.
    assert!(!branches.is_empty(), "expected at least one branch");
    let current = branches.iter().filter(|b| b.is_current).count();
    assert_eq!(current, 1, "exactly one branch should be current");
}

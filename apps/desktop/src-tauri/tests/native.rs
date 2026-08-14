use std::fs;

use rootline_desktop::{
    apply_plan, scan_plan, CancellationToken, Database, NativeErrorCode, Profile, ScanRequest,
};
use tempfile::tempdir;

fn request(source: &std::path::Path, target: &std::path::Path) -> ScanRequest {
    ScanRequest {
        operation_id: "scan-1".into(),
        source_path: source.to_path_buf(),
        target_path: target.to_path_buf(),
        exclusions: vec![".git".into()],
    }
}

#[test]
fn scans_additively_and_revalidates_before_mkdir() {
    let source = tempdir().unwrap();
    let target = tempdir().unwrap();
    fs::create_dir_all(source.path().join("docs/api")).unwrap();
    fs::create_dir_all(source.path().join("src/components")).unwrap();
    fs::create_dir_all(source.path().join(".git/objects")).unwrap();

    let cancellation = CancellationToken::default();
    let plan = scan_plan(&request(source.path(), target.path()), &cancellation).unwrap();
    assert_eq!(plan.missing, ["docs", "docs/api", "src", "src/components"]);

    let result = apply_plan(
        &request(source.path(), target.path()),
        &plan,
        &["docs/api".into()],
        &cancellation,
    )
    .unwrap();
    assert!(target.path().join("docs/api").is_dir());
    assert_eq!(result.directories.len(), 2);

    fs::create_dir(source.path().join("changed-after-review")).unwrap();
    let error = apply_plan(
        &request(source.path(), target.path()),
        &plan,
        &plan.missing,
        &cancellation,
    )
    .unwrap_err();
    assert_eq!(error.code, NativeErrorCode::StalePlan);
}

#[test]
fn rejects_overlapping_roots_and_honors_cancellation() {
    let source = tempdir().unwrap();
    fs::create_dir(source.path().join("child")).unwrap();
    let overlap = request(source.path(), &source.path().join("child"));
    assert_eq!(
        scan_plan(&overlap, &CancellationToken::default())
            .unwrap_err()
            .code,
        NativeErrorCode::PathOverlap,
    );

    let target = tempdir().unwrap();
    let cancelled = CancellationToken::default();
    cancelled.cancel();
    assert_eq!(
        scan_plan(&request(source.path(), target.path()), &cancelled)
            .unwrap_err()
            .code,
        NativeErrorCode::Cancelled,
    );
}

#[cfg(unix)]
#[test]
fn skips_symbolic_links_instead_of_following_them() {
    use std::os::unix::fs::symlink;

    let source = tempdir().unwrap();
    let target = tempdir().unwrap();
    let outside = tempdir().unwrap();
    fs::create_dir(outside.path().join("secret")).unwrap();
    symlink(outside.path(), source.path().join("linked")).unwrap();

    let plan = scan_plan(
        &request(source.path(), target.path()),
        &CancellationToken::default(),
    )
    .unwrap();
    assert!(plan.missing.is_empty());
    assert_eq!(plan.skipped_links, ["linked"]);
}

#[test]
fn migrates_and_persists_offline_state_with_bounded_history() {
    let directory = tempdir().unwrap();
    let database = Database::open(directory.path().join("rootline.sqlite3")).unwrap();
    let device_id = database.device_id().unwrap();
    assert_eq!(database.device_id().unwrap(), device_id);

    let profile = Profile {
        id: "profile-1".into(),
        name: "Work".into(),
        source_path: "/source".into(),
        target_path: "/target".into(),
        exclusions: vec![".git".into()],
        created_at: "2026-08-15T00:00:00Z".into(),
        updated_at: "2026-08-15T00:00:00Z".into(),
    };
    database.save_profile(&profile).unwrap();
    assert_eq!(database.list_profiles().unwrap(), [profile]);
    let saved_mutations = database.pending_outbox().unwrap();
    assert_eq!(saved_mutations.len(), 1);
    assert_eq!(saved_mutations[0].kind, "upsert");
    database
        .acknowledge_mutations(&[saved_mutations[0].mutation_id.clone()])
        .unwrap();

    database
        .enqueue_mutation(
            "mutation-1",
            "upsert",
            "{\"id\":\"profile-1\"}",
            "2026-08-15T00:00:00Z",
        )
        .unwrap();
    assert_eq!(database.pending_outbox().unwrap().len(), 1);
    database
        .acknowledge_mutations(&["mutation-1".into()])
        .unwrap();
    assert!(database.pending_outbox().unwrap().is_empty());
    database.set_sync_cursor("epoch-1", "cursor-7").unwrap();
    assert_eq!(
        database.sync_cursor().unwrap(),
        Some(("epoch-1".into(), "cursor-7".into()))
    );

    for index in 0..105 {
        database
            .record_run(
                &format!("run-{index:03}"),
                "profile-1",
                "completed",
                index,
                "[]",
            )
            .unwrap();
    }
    let history = database.run_history().unwrap();
    assert_eq!(history.len(), 100);
    assert_eq!(history.first().unwrap().id, "run-104");
    assert_eq!(history.last().unwrap().id, "run-005");

    database.delete_profile("profile-1").unwrap();
    assert!(database.list_profiles().unwrap().is_empty());
    let deleted_mutations = database.pending_outbox().unwrap();
    assert_eq!(deleted_mutations.len(), 1);
    assert_eq!(deleted_mutations[0].kind, "delete");
    drop(database);

    let reopened = Database::open(directory.path().join("rootline.sqlite3")).unwrap();
    assert_eq!(reopened.device_id().unwrap(), device_id);
}

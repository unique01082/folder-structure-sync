use std::fs;

use rootline_desktop::{
    apply_plan, detect_case_sensitive, random_vault_password, resolve_existing_vault_password,
    scan_plan, CancellationToken, Database, DirectoryStatus, NativeErrorCode, Profile, ScanRequest,
};
use rusqlite::Connection;
use tempfile::tempdir;

fn request(source: &std::path::Path, target: &std::path::Path) -> ScanRequest {
    ScanRequest {
        operation_id: "scan-1".into(),
        source_path: source.to_path_buf(),
        target_path: target.to_path_buf(),
        exclusions: vec![".git".into()],
    }
}

fn create_v5_database_with_invalid_profile(path: &std::path::Path, profile: &Profile) {
    let connection = Connection::open(path).unwrap();
    connection
        .execute_batch(&format!(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
             {}
             INSERT INTO schema_migrations(version) VALUES (1);
             {}
             INSERT INTO schema_migrations(version) VALUES (2);
             {}
             INSERT INTO schema_migrations(version) VALUES (3);
             {}
             INSERT INTO schema_migrations(version) VALUES (4);
             {}
             INSERT INTO schema_migrations(version) VALUES (5);",
            include_str!("../migrations/0001_offline_state.sql"),
            include_str!("../migrations/0002_account_scoped_sync.sql"),
            include_str!("../migrations/0003_sync_session_generation.sql"),
            include_str!("../migrations/0004_consented_epoch_adoption.sql"),
            include_str!("../migrations/0005_sync_lifecycle_generation.sql"),
        ))
        .unwrap();
    connection
        .execute(
            "INSERT INTO profiles(id, name, source_path, target_path, exclusions_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, '[]', ?5, ?6)",
            rusqlite::params![
                profile.id,
                profile.name,
                profile.source_path,
                profile.target_path,
                profile.created_at,
                profile.updated_at
            ],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO mutation_outbox(mutation_id, kind, payload, occurred_at, profile_id)
             VALUES (?1, 'upsert', ?2, ?3, ?4)",
            rusqlite::params![
                "00000000-0000-4000-8007-000000000001",
                serde_json::to_string(profile).unwrap(),
                profile.updated_at,
                profile.id
            ],
        )
        .unwrap();
}

fn create_v6_database(path: &std::path::Path) -> Connection {
    let connection = Connection::open(path).unwrap();
    connection
        .execute_batch(&format!(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
             {}
             INSERT INTO schema_migrations(version) VALUES (1);
             {}
             INSERT INTO schema_migrations(version) VALUES (2);
             {}
             INSERT INTO schema_migrations(version) VALUES (3);
             {}
             INSERT INTO schema_migrations(version) VALUES (4);
             {}
             INSERT INTO schema_migrations(version) VALUES (5);
             {}
             INSERT INTO schema_migrations(version) VALUES (6);",
            include_str!("../migrations/0001_offline_state.sql"),
            include_str!("../migrations/0002_account_scoped_sync.sql"),
            include_str!("../migrations/0003_sync_session_generation.sql"),
            include_str!("../migrations/0004_consented_epoch_adoption.sql"),
            include_str!("../migrations/0005_sync_lifecycle_generation.sql"),
            include_str!("../migrations/0006_invalid_outbox_quarantine.sql"),
        ))
        .unwrap();
    connection
}

fn insert_legacy_profile(connection: &Connection, profile: &Profile) {
    connection
        .execute(
            "INSERT INTO profiles(
               id, name, source_path, target_path, exclusions_json, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                profile.id,
                profile.name,
                profile.source_path,
                profile.target_path,
                serde_json::to_string(&profile.exclusions).unwrap(),
                profile.created_at,
                profile.updated_at
            ],
        )
        .unwrap();
}

fn insert_legacy_sync_state(connection: &Connection, subject: &str) {
    connection
        .execute(
            "INSERT INTO sync_state(singleton, epoch, cursor, subject)
             VALUES (1, '00000000-0000-4000-8000-000000000600', '', ?1)",
            [subject],
        )
        .unwrap();
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
fn binds_a_plan_to_its_canonical_roots_even_when_snapshots_match() {
    let source = tempdir().unwrap();
    let target = tempdir().unwrap();
    let other_source = tempdir().unwrap();
    let other_target = tempdir().unwrap();
    fs::create_dir(source.path().join("docs")).unwrap();
    fs::create_dir(other_source.path().join("docs")).unwrap();

    let plan = scan_plan(
        &request(source.path(), target.path()),
        &CancellationToken::default(),
    )
    .unwrap();
    assert_eq!(plan.source_root, fs::canonicalize(source.path()).unwrap());
    assert_eq!(plan.target_root, fs::canonicalize(target.path()).unwrap());

    let error = apply_plan(
        &request(other_source.path(), other_target.path()),
        &plan,
        &plan.missing,
        &CancellationToken::default(),
    )
    .unwrap_err();
    assert_eq!(error.code, NativeErrorCode::StalePlan);
    assert!(!other_target.path().join("docs").exists());
}

#[test]
fn reports_case_semantics_and_failed_directory_creation() {
    let case_root = tempdir().unwrap();
    let case_sensitive = detect_case_sensitive(case_root.path()).unwrap();
    fs::write(case_root.path().join("CaseProbe"), b"x").unwrap();
    assert_eq!(case_root.path().join("caseprobe").exists(), !case_sensitive);

    let source = tempdir().unwrap();
    let target = tempdir().unwrap();
    fs::create_dir(source.path().join("blocked")).unwrap();
    fs::write(target.path().join("blocked"), b"not a directory").unwrap();
    let plan = scan_plan(
        &request(source.path(), target.path()),
        &CancellationToken::default(),
    )
    .unwrap();
    let result = apply_plan(
        &request(source.path(), target.path()),
        &plan,
        &["blocked".into()],
        &CancellationToken::default(),
    )
    .unwrap();
    assert_eq!(result.directories[0].status, DirectoryStatus::Failed);
    assert!(result.directories[0].error.is_some());
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
fn case_detection_is_read_only_and_overlap_wins_before_target_inspection() {
    use std::os::unix::fs::PermissionsExt;

    let source = tempdir().unwrap();
    let target = tempdir().unwrap();
    fs::create_dir_all(source.path().join("docs/api")).unwrap();
    fs::create_dir(target.path().join("existing-directory")).unwrap();
    fs::write(target.path().join("keep.bin"), [0, 1, 2, 255]).unwrap();
    let before_entries = fs::read_dir(target.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<Vec<_>>();
    let before_bytes = fs::read(target.path().join("keep.bin")).unwrap();
    let original_mode = fs::metadata(target.path()).unwrap().permissions().mode();
    fs::set_permissions(target.path(), fs::Permissions::from_mode(0o555)).unwrap();

    let plan = scan_plan(
        &request(source.path(), target.path()),
        &CancellationToken::default(),
    )
    .unwrap();
    assert_eq!(plan.missing, ["docs", "docs/api"]);

    fs::set_permissions(target.path(), fs::Permissions::from_mode(original_mode)).unwrap();
    let after_entries = fs::read_dir(target.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<Vec<_>>();
    assert_eq!(after_entries, before_entries);
    assert_eq!(
        fs::read(target.path().join("keep.bin")).unwrap(),
        before_bytes
    );

    let nested_target = source.path().join("nested-target");
    fs::create_dir(&nested_target).unwrap();
    fs::write(nested_target.join("sentinel"), b"unchanged").unwrap();
    fs::set_permissions(&nested_target, fs::Permissions::from_mode(0o555)).unwrap();
    let error = scan_plan(
        &request(source.path(), &nested_target),
        &CancellationToken::default(),
    )
    .unwrap_err();
    fs::set_permissions(&nested_target, fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(error.code, NativeErrorCode::PathOverlap);
    assert_eq!(
        fs::read(nested_target.join("sentinel")).unwrap(),
        b"unchanged"
    );

    let implementation = include_str!("../src/lib.rs");
    assert!(!implementation.contains(".rootline-case-probe"));
    assert!(!implementation.contains("create_new(true)"));
    assert!(!implementation.contains("validate_relationship(&source, &target, !cfg!"));
}

#[test]
fn actual_volume_metadata_controls_case_distinct_sibling_overlap() {
    let parent = tempdir().unwrap();
    let case_sensitive = detect_case_sensitive(parent.path()).unwrap();
    let source = parent.path().join("Foo");
    let target = parent.path().join("foo");
    fs::create_dir(&source).unwrap();
    fs::create_dir(source.join("nested")).unwrap();

    if case_sensitive {
        fs::create_dir(&target).unwrap();
        let plan = scan_plan(&request(&source, &target), &CancellationToken::default()).unwrap();
        assert_eq!(plan.missing, ["nested"]);
        assert!(plan.target_case_sensitive);
    } else {
        assert_eq!(
            scan_plan(&request(&source, &target), &CancellationToken::default())
                .unwrap_err()
                .code,
            NativeErrorCode::PathOverlap,
        );
    }
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

    let linked_root = source.path().join("linked-root");
    symlink(outside.path(), &linked_root).unwrap();
    assert_eq!(
        scan_plan(
            &request(&linked_root, target.path()),
            &CancellationToken::default(),
        )
        .unwrap_err()
        .code,
        NativeErrorCode::InvalidPath,
    );

    let parent = tempdir().unwrap();
    let real_ancestor = tempdir().unwrap();
    fs::create_dir(real_ancestor.path().join("source")).unwrap();
    let linked_ancestor = parent.path().join("linked-ancestor");
    symlink(real_ancestor.path(), &linked_ancestor).unwrap();
    assert_eq!(
        scan_plan(
            &request(&linked_ancestor.join("source"), target.path()),
            &CancellationToken::default(),
        )
        .unwrap_err()
        .code,
        NativeErrorCode::InvalidPath,
    );
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

#[test]
fn native_profile_limits_are_enforced_before_profile_or_outbox_persistence() {
    let directory = tempdir().unwrap();
    let database = Database::open(directory.path().join("profile-limits.sqlite3")).unwrap();
    let exact_code_points = |count: usize| {
        format!(
            "{}{}",
            "✈️".repeat(count / 2),
            if count % 2 == 1 { "x" } else { "" }
        )
    };
    let boundary = Profile {
        id: "boundary".into(),
        name: exact_code_points(80),
        source_path: exact_code_points(4096),
        target_path: exact_code_points(4096),
        exclusions: (0..100).map(|_| exact_code_points(256)).collect(),
        created_at: "2026-08-15T00:00:00Z".into(),
        updated_at: "2026-08-15T00:00:00Z".into(),
    };
    database.save_profile(&boundary).unwrap();
    let before_profiles = database.list_profiles().unwrap();
    let before_outbox = database.pending_outbox().unwrap();

    let invalid = [
        Profile {
            id: "bad-name".into(),
            name: exact_code_points(81),
            ..boundary.clone()
        },
        Profile {
            id: "bad-source".into(),
            source_path: String::new(),
            ..boundary.clone()
        },
        Profile {
            id: "bad-target".into(),
            target_path: exact_code_points(4097),
            ..boundary.clone()
        },
        Profile {
            id: "bad-count".into(),
            exclusions: (0..101).map(|_| "x".into()).collect(),
            ..boundary.clone()
        },
        Profile {
            id: "bad-pattern".into(),
            exclusions: vec![exact_code_points(257)],
            ..boundary.clone()
        },
    ];
    for profile in invalid {
        assert_eq!(
            database.save_profile(&profile).unwrap_err().code,
            NativeErrorCode::ValidationFailed
        );
        assert_eq!(database.list_profiles().unwrap(), before_profiles);
        assert_eq!(database.pending_outbox().unwrap(), before_outbox);
    }
}

#[test]
fn v5_upgrade_quarantines_invalid_outbox_without_removing_local_profiles_and_recovers_on_save() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("v5-invalid-outbox.sqlite3");
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch(&format!(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
             {}
             INSERT INTO schema_migrations(version) VALUES (1);
             {}
             INSERT INTO schema_migrations(version) VALUES (2);
             {}
             INSERT INTO schema_migrations(version) VALUES (3);
             {}
             INSERT INTO schema_migrations(version) VALUES (4);
             {}
             INSERT INTO schema_migrations(version) VALUES (5);",
            include_str!("../migrations/0001_offline_state.sql"),
            include_str!("../migrations/0002_account_scoped_sync.sql"),
            include_str!("../migrations/0003_sync_session_generation.sql"),
            include_str!("../migrations/0004_consented_epoch_adoption.sql"),
            include_str!("../migrations/0005_sync_lifecycle_generation.sql"),
        ))
        .unwrap();
    let invalid_profile = Profile {
        id: "legacy-invalid".into(),
        name: "n".repeat(81),
        source_path: "/legacy/source".into(),
        target_path: "/legacy/target".into(),
        exclusions: vec![],
        created_at: "2026-08-15T00:00:00Z".into(),
        updated_at: "2026-08-15T00:00:00Z".into(),
    };
    connection
        .execute(
            "INSERT INTO profiles(id, name, source_path, target_path, exclusions_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, '[]', ?5, ?6)",
            rusqlite::params![
                invalid_profile.id,
                invalid_profile.name,
                invalid_profile.source_path,
                invalid_profile.target_path,
                invalid_profile.created_at,
                invalid_profile.updated_at
            ],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO mutation_outbox(mutation_id, kind, payload, occurred_at, profile_id)
             VALUES (?1, 'upsert', ?2, ?3, ?4)",
            rusqlite::params![
                "00000000-0000-4000-8007-000000000001",
                serde_json::to_string(&invalid_profile).unwrap(),
                invalid_profile.updated_at,
                invalid_profile.id
            ],
        )
        .unwrap();
    drop(connection);

    let database = Database::open(&path).unwrap();
    assert_eq!(
        database.list_profiles().unwrap().as_slice(),
        std::slice::from_ref(&invalid_profile)
    );
    assert!(database.pending_outbox().unwrap().is_empty());
    let quarantined = database.quarantined_mutations().unwrap();
    assert_eq!(quarantined.len(), 1);
    assert_eq!(quarantined[0].profile_id, invalid_profile.id);
    assert!(quarantined[0].reason.contains("name"));
    assert_eq!(quarantined[0].provenance, "pre-login");
    assert_eq!(
        database.hosted_sync_request("alice").unwrap_err().code,
        NativeErrorCode::SyncAccountClaimRequired
    );
    database.claim_hosted_account("alice", true).unwrap();
    let consented_empty = database.hosted_sync_request("alice").unwrap();
    assert_eq!(consented_empty["mutations"], serde_json::json!([]));
    let local_epoch = consented_empty["epoch"].as_str().unwrap().to_owned();
    let generation = database
        .hosted_sync_generation("alice", &local_epoch, "")
        .unwrap();
    database
        .apply_hosted_sync_response(
            "alice",
            &local_epoch,
            "",
            generation,
            &serde_json::json!({
                "epoch": local_epoch, "cursor": "empty-consented", "records": [], "receipts": []
            }),
        )
        .unwrap();
    assert!(database.preserves_consented_outbox("alice").unwrap());
    database
        .accept_account_epoch("alice", "00000000-0000-4000-8000-000000000701", false)
        .unwrap();

    let corrected = Profile {
        name: "Corrected".into(),
        updated_at: "2026-08-15T00:01:00Z".into(),
        ..invalid_profile
    };
    database.save_profile(&corrected).unwrap();
    assert!(database.quarantined_mutations().unwrap().is_empty());
    assert_eq!(database.list_profiles().unwrap(), [corrected]);
    assert_eq!(
        database.hosted_sync_request("alice").unwrap()["mutations"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(database.pending_outbox().unwrap().len(), 1);
}

#[test]
fn v6_upgrade_backfills_existing_prelogin_quarantine_provenance() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("v6-quarantine.sqlite3");
    let connection = create_v6_database(&path);
    connection
        .execute(
            "INSERT INTO mutation_quarantine(mutation_id, kind, profile_id, reason)
             VALUES ('00000000-0000-4000-8007-000000000006', 'upsert',
                     'legacy-prelogin', 'legacy invalid profile')",
            [],
        )
        .unwrap();
    drop(connection);

    let database = Database::open(&path).unwrap();
    let quarantined = database.quarantined_mutations().unwrap();
    assert_eq!(quarantined.len(), 1);
    assert_eq!(quarantined[0].profile_id, "legacy-prelogin");
    assert_eq!(quarantined[0].provenance, "pre-login");
    assert_eq!(
        database.hosted_sync_request("alice").unwrap_err().code,
        NativeErrorCode::SyncAccountClaimRequired,
    );
}

#[test]
fn v6_unbound_valid_outbox_keep_local_never_leaks_after_edit_delete_epoch_or_switch() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("v6-valid-outbox-keep.sqlite3");
    let profile = Profile {
        id: "v6-private-profile".into(),
        name: "Legacy private".into(),
        source_path: "/Users/alice/private/v6-source".into(),
        target_path: "/Volumes/alice/private/v6-target".into(),
        exclusions: vec!["secret-*".into()],
        created_at: "2026-08-15T00:00:00Z".into(),
        updated_at: "2026-08-15T00:00:00Z".into(),
    };
    let connection = create_v6_database(&path);
    insert_legacy_sync_state(&connection, "");
    connection
        .execute(
            "INSERT INTO mutation_outbox(mutation_id, kind, payload, occurred_at, profile_id)
             VALUES (?1, 'upsert', ?2, ?3, ?4)",
            rusqlite::params![
                "00000000-0000-4000-8007-000000000061",
                serde_json::to_string(&profile).unwrap(),
                profile.updated_at,
                profile.id
            ],
        )
        .unwrap();
    drop(connection);

    let database = Database::open(&path).unwrap();
    let migrated_policy: (String, String) = Connection::open(&path)
        .unwrap()
        .query_row(
            "SELECT policy, subject FROM profile_sync_policy WHERE profile_id=?1",
            [&profile.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(migrated_policy, ("unclaimed".into(), String::new()));
    assert_eq!(
        database.hosted_sync_request("alice").unwrap_err().code,
        NativeErrorCode::SyncAccountClaimRequired
    );
    database.claim_hosted_account("alice", false).unwrap();
    let mut edited = profile.clone();
    edited.name = "Private edit".into();
    edited.updated_at = "2026-08-15T00:01:00Z".into();
    database.save_profile(&edited).unwrap();
    let alice = database.hosted_sync_request("alice").unwrap();
    assert_eq!(alice["mutations"], serde_json::json!([]));
    assert!(!alice.to_string().contains("/Users/alice/private"));

    database
        .accept_account_epoch("alice", "00000000-0000-4000-8000-000000000611", false)
        .unwrap();
    assert!(database.pending_outbox().unwrap().is_empty());
    database.disconnect_hosted_account(false).unwrap();
    assert_eq!(
        database.hosted_sync_request("bob").unwrap_err().code,
        NativeErrorCode::SyncAccountClaimRequired
    );
    database.claim_hosted_account("bob", false).unwrap();
    edited.name = "Private after switch".into();
    edited.updated_at = "2026-08-15T00:02:00Z".into();
    database.save_profile(&edited).unwrap();
    assert_eq!(
        database.hosted_sync_request("bob").unwrap()["mutations"],
        serde_json::json!([])
    );
    database.delete_profile(&edited.id).unwrap();
    let after_delete = database.hosted_sync_request("bob").unwrap();
    assert_eq!(after_delete["mutations"], serde_json::json!([]));
    assert!(!after_delete.to_string().contains("/Users/alice/private"));
}

#[test]
fn v6_unbound_retained_profile_without_outbox_requires_a_fresh_claim() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("v6-retained-no-outbox.sqlite3");
    let profile = Profile {
        id: "v6-retained-only".into(),
        name: "Retained only".into(),
        source_path: "/Users/legacy/retained".into(),
        target_path: "/Volumes/legacy/retained".into(),
        exclusions: vec![],
        created_at: "2026-08-15T00:00:00Z".into(),
        updated_at: "2026-08-15T00:00:00Z".into(),
    };
    let connection = create_v6_database(&path);
    insert_legacy_sync_state(&connection, "");
    insert_legacy_profile(&connection, &profile);
    drop(connection);

    let database = Database::open(&path).unwrap();
    let migrated_policy: (String, String) = Connection::open(&path)
        .unwrap()
        .query_row(
            "SELECT policy, subject FROM profile_sync_policy WHERE profile_id=?1",
            [&profile.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(migrated_policy, ("unclaimed".into(), String::new()));
    assert_eq!(
        database.hosted_sync_request("alice").unwrap_err().code,
        NativeErrorCode::SyncAccountClaimRequired
    );
    database.claim_hosted_account("alice", false).unwrap();
    assert_eq!(
        database.hosted_sync_request("alice").unwrap()["mutations"],
        serde_json::json!([])
    );
}

#[test]
fn v6_bound_cloud_state_does_not_prompt_without_ambiguous_quarantine() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("v6-bound-clean.sqlite3");
    let profile = Profile {
        id: "v6-bound-clean".into(),
        name: "Already synced".into(),
        source_path: "/cloud/source".into(),
        target_path: "/cloud/target".into(),
        exclusions: vec![],
        created_at: "2026-08-15T00:00:00Z".into(),
        updated_at: "2026-08-15T00:00:00Z".into(),
    };
    let connection = create_v6_database(&path);
    insert_legacy_sync_state(&connection, "alice");
    insert_legacy_profile(&connection, &profile);
    drop(connection);

    let database = Database::open(&path).unwrap();
    let policy_count: i64 = Connection::open(&path)
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM profile_sync_policy WHERE profile_id=?1",
            [&profile.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(policy_count, 0);
    assert_eq!(
        database.hosted_sync_request("alice").unwrap()["mutations"],
        serde_json::json!([])
    );
}

#[test]
fn v6_quarantine_is_ambiguous_even_with_a_populated_subject_and_keep_resolves_it() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("v6-bound-quarantine-keep.sqlite3");
    let profile = Profile {
        id: "v6-bound-ambiguous".into(),
        name: "Ambiguous local".into(),
        source_path: "/Users/alice/ambiguous".into(),
        target_path: "/Volumes/alice/ambiguous".into(),
        exclusions: vec![],
        created_at: "2026-08-15T00:00:00Z".into(),
        updated_at: "2026-08-15T00:00:00Z".into(),
    };
    let connection = create_v6_database(&path);
    insert_legacy_sync_state(&connection, "alice");
    insert_legacy_profile(&connection, &profile);
    connection
        .execute(
            "INSERT INTO mutation_quarantine(mutation_id, kind, profile_id, reason)
             VALUES ('00000000-0000-4000-8007-000000000062', 'upsert', ?1, 'legacy')",
            [&profile.id],
        )
        .unwrap();
    drop(connection);

    let database = Database::open(&path).unwrap();
    let migrated_policy: (String, String) = Connection::open(&path)
        .unwrap()
        .query_row(
            "SELECT policy, subject FROM profile_sync_policy WHERE profile_id=?1",
            [&profile.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(migrated_policy, ("unclaimed".into(), String::new()));
    assert_eq!(
        database.quarantined_mutations().unwrap()[0].provenance,
        "pre-login"
    );
    assert_eq!(
        database.hosted_sync_request("alice").unwrap_err().code,
        NativeErrorCode::SyncAccountClaimRequired
    );
    database.claim_hosted_account("alice", false).unwrap();
    assert_eq!(
        database.hosted_sync_request("alice").unwrap()["mutations"],
        serde_json::json!([])
    );
}

#[test]
fn v6_bound_quarantine_upload_consent_survives_epoch_until_correction() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("v6-bound-quarantine-upload.sqlite3");
    let invalid = Profile {
        id: "v6-bound-upload".into(),
        name: "n".repeat(81),
        source_path: "/Users/alice/upload-consented".into(),
        target_path: "/Volumes/alice/upload-consented".into(),
        exclusions: vec![],
        created_at: "2026-08-15T00:00:00Z".into(),
        updated_at: "2026-08-15T00:00:00Z".into(),
    };
    let connection = create_v6_database(&path);
    insert_legacy_sync_state(&connection, "alice");
    insert_legacy_profile(&connection, &invalid);
    connection
        .execute(
            "INSERT INTO mutation_quarantine(mutation_id, kind, profile_id, reason)
             VALUES ('00000000-0000-4000-8007-000000000063', 'upsert', ?1, 'legacy')",
            [&invalid.id],
        )
        .unwrap();
    drop(connection);

    let database = Database::open(&path).unwrap();
    assert_eq!(
        database.hosted_sync_request("alice").unwrap_err().code,
        NativeErrorCode::SyncAccountClaimRequired
    );
    database.claim_hosted_account("alice", true).unwrap();
    assert_eq!(
        database.hosted_sync_request("alice").unwrap()["mutations"],
        serde_json::json!([])
    );
    assert!(database.preserves_consented_outbox("alice").unwrap());
    database
        .accept_account_epoch("alice", "00000000-0000-4000-8000-000000000612", false)
        .unwrap();

    let corrected = Profile {
        name: "Corrected after consent".into(),
        updated_at: "2026-08-15T00:01:00Z".into(),
        ..invalid
    };
    database.save_profile(&corrected).unwrap();
    let request = database.hosted_sync_request("alice").unwrap();
    assert_eq!(request["mutations"].as_array().unwrap().len(), 1);
    assert_eq!(
        request["mutations"][0]["profile"]["sourcePath"],
        corrected.source_path
    );
}

#[test]
fn keep_local_only_survives_quarantine_correction_epoch_and_account_switch_without_path_leakage() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("quarantine-local-only.sqlite3");
    let invalid = Profile {
        id: "legacy-private".into(),
        name: "n".repeat(81),
        source_path: "/Users/alice/private/source".into(),
        target_path: "/Volumes/alice/private/target".into(),
        exclusions: vec![],
        created_at: "2026-08-15T00:00:00Z".into(),
        updated_at: "2026-08-15T00:00:00Z".into(),
    };
    create_v5_database_with_invalid_profile(&path, &invalid);
    let database = Database::open(&path).unwrap();

    assert_eq!(
        database.hosted_sync_request("alice").unwrap_err().code,
        NativeErrorCode::SyncAccountClaimRequired
    );
    database.claim_hosted_account("alice", false).unwrap();
    let corrected = Profile {
        name: "Corrected local only".into(),
        updated_at: "2026-08-15T00:01:00Z".into(),
        ..invalid
    };
    database.save_profile(&corrected).unwrap();
    assert!(database.quarantined_mutations().unwrap().is_empty());
    let alice = database.hosted_sync_request("alice").unwrap();
    assert_eq!(alice["mutations"], serde_json::json!([]));
    assert!(!alice.to_string().contains("/Users/alice/private"));
    database
        .accept_account_epoch("alice", "00000000-0000-4000-8000-000000000702", false)
        .unwrap();
    assert!(database.pending_outbox().unwrap().is_empty());

    database.disconnect_hosted_account(false).unwrap();
    assert_eq!(
        database.hosted_sync_request("bob").unwrap_err().code,
        NativeErrorCode::SyncAccountClaimRequired
    );
    database.claim_hosted_account("bob", false).unwrap();
    let mut bob_correction = corrected.clone();
    bob_correction.name = "Still local only".into();
    bob_correction.updated_at = "2026-08-15T00:02:00Z".into();
    database.save_profile(&bob_correction).unwrap();
    let bob = database.hosted_sync_request("bob").unwrap();
    assert_eq!(bob["mutations"], serde_json::json!([]));
    assert!(!bob.to_string().contains("/Users/alice/private"));
}

#[test]
fn quarantined_profile_blocks_remote_upsert_and_tombstone_until_corrected_save_and_delete() {
    let directory = tempdir().unwrap();
    let database = Database::open(directory.path().join("quarantine-conflict.sqlite3")).unwrap();
    let mut local = Profile {
        id: "quarantine-conflict".into(),
        name: "Preserved local".into(),
        source_path: "/local/source".into(),
        target_path: "/local/target".into(),
        exclusions: vec![],
        created_at: "2026-08-15T00:00:00Z".into(),
        updated_at: "2026-08-15T00:00:00Z".into(),
    };
    database.save_profile(&local).unwrap();
    database.claim_hosted_account("alice", true).unwrap();
    let initial = database.hosted_sync_request("alice").unwrap();
    let epoch = initial["epoch"].as_str().unwrap().to_owned();
    let generation = database
        .hosted_sync_generation("alice", &epoch, "")
        .unwrap();
    database
        .apply_hosted_sync_response(
            "alice",
            &epoch,
            "",
            generation,
            &serde_json::json!({
                "epoch": epoch, "cursor": "baseline", "records": [],
                "receipts": [{ "mutationId": initial["mutations"][0]["mutationId"], "revision": 1 }]
            }),
        )
        .unwrap();
    let invalid = Profile {
        name: "n".repeat(81),
        ..local.clone()
    };
    database
        .enqueue_mutation(
            "00000000-0000-4000-8007-000000000099",
            "upsert",
            &serde_json::to_string(&invalid).unwrap(),
            &invalid.updated_at,
        )
        .unwrap();
    let quarantined_request = database.hosted_sync_request("alice").unwrap();
    assert_eq!(quarantined_request["mutations"], serde_json::json!([]));
    assert_eq!(database.quarantined_mutations().unwrap().len(), 1);

    let generation = database
        .hosted_sync_generation("alice", &epoch, "baseline")
        .unwrap();
    database
        .apply_hosted_sync_response(
            "alice",
            &epoch,
            "baseline",
            generation,
            &serde_json::json!({
                "epoch": epoch, "cursor": "remote-upsert", "receipts": [],
                "records": [{
                    "kind": "profile", "revision": 2,
                    "profile": {
                        "id": local.id, "name": "Remote overwrite", "sourcePath": "/remote/source",
                        "targetPath": "/remote/target", "exclusions": [],
                        "createdAt": local.created_at, "updatedAt": "2026-08-15T01:00:00Z"
                    }
                }]
            }),
        )
        .unwrap();
    assert_eq!(database.list_profiles().unwrap(), [local.clone()]);

    let generation = database
        .hosted_sync_generation("alice", &epoch, "remote-upsert")
        .unwrap();
    database
        .apply_hosted_sync_response(
            "alice",
            &epoch,
            "remote-upsert",
            generation,
            &serde_json::json!({
                "epoch": epoch, "cursor": "remote-delete", "receipts": [],
                "records": [{ "kind": "tombstone", "revision": 3, "profileId": local.id }]
            }),
        )
        .unwrap();
    assert_eq!(database.list_profiles().unwrap(), [local.clone()]);

    local.name = "Corrected local".into();
    local.updated_at = "2026-08-15T02:00:00Z".into();
    database.save_profile(&local).unwrap();
    assert!(database.quarantined_mutations().unwrap().is_empty());
    assert_eq!(database.pending_outbox().unwrap().len(), 1);
    database.delete_profile(&local.id).unwrap();
    assert!(database.list_profiles().unwrap().is_empty());
    assert_eq!(
        database.pending_outbox().unwrap().last().unwrap().kind,
        "delete"
    );
}

#[test]
fn deleting_a_quarantined_profile_clears_its_actionable_status_and_queues_a_tombstone() {
    let directory = tempdir().unwrap();
    let database = Database::open(directory.path().join("quarantine-delete.sqlite3")).unwrap();
    let profile_id = "legacy-invalid";
    let invalid = Profile {
        id: profile_id.into(),
        name: "n".repeat(81),
        source_path: "/source".into(),
        target_path: "/target".into(),
        exclusions: vec![],
        created_at: "2026-08-15T00:00:00Z".into(),
        updated_at: "2026-08-15T00:00:00Z".into(),
    };
    database
        .enqueue_mutation(
            "00000000-0000-4000-8007-000000000099",
            "upsert",
            &serde_json::to_string(&invalid).unwrap(),
            &invalid.updated_at,
        )
        .unwrap();
    assert_eq!(
        database.hosted_sync_request("alice").unwrap_err().code,
        NativeErrorCode::SyncAccountClaimRequired
    );
    database.claim_hosted_account("alice", true).unwrap();
    database.hosted_sync_request("alice").unwrap();
    assert_eq!(database.quarantined_mutations().unwrap().len(), 1);

    database.delete_profile(profile_id).unwrap();
    assert!(database.quarantined_mutations().unwrap().is_empty());
    let pending = database.pending_outbox().unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].kind, "delete");
}

#[test]
fn generates_independent_per_install_vault_passwords() {
    let first = random_vault_password();
    let second = random_vault_password();
    assert_eq!(first.len(), 64);
    assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert_ne!(first, second);
}

#[test]
fn refuses_to_replace_a_missing_os_key_for_an_existing_stronghold_snapshot() {
    assert_eq!(
        resolve_existing_vault_password(Err(keyring::Error::NoEntry), true)
            .unwrap_err()
            .code,
        NativeErrorCode::Internal,
    );
    assert_eq!(
        resolve_existing_vault_password(Err(keyring::Error::NoEntry), false).unwrap(),
        None,
    );
    assert_eq!(
        resolve_existing_vault_password(Ok("a".repeat(64)), true).unwrap(),
        Some("a".repeat(64)),
    );
}

#[test]
fn clearing_synced_local_data_is_explicit_and_keeps_run_history() {
    let directory = tempdir().unwrap();
    let database = Database::open(directory.path().join("clear.sqlite3")).unwrap();
    let profile = Profile {
        id: "00000000-0000-4000-8000-000000000001".into(),
        name: "Local".into(),
        source_path: "/source".into(),
        target_path: "/target".into(),
        exclusions: vec![],
        created_at: "2026-08-15T00:00:00Z".into(),
        updated_at: "2026-08-15T00:00:00Z".into(),
    };
    database.save_profile(&profile).unwrap();
    database
        .record_run("run", &profile.id, "completed", 1, "[]")
        .unwrap();
    database
        .set_sync_cursor("00000000-0000-4000-8000-000000000001", "cursor")
        .unwrap();
    let invalid_profile = Profile {
        name: "n".repeat(81),
        ..profile.clone()
    };
    database
        .enqueue_mutation(
            "00000000-0000-4000-8007-000000000100",
            "upsert",
            &serde_json::to_string(&invalid_profile).unwrap(),
            &invalid_profile.updated_at,
        )
        .unwrap();
    database.claim_hosted_account("alice", true).unwrap();
    let _ = database.hosted_sync_request("alice").unwrap();
    assert_eq!(database.quarantined_mutations().unwrap().len(), 1);

    database.clear_local_synced_data().unwrap();
    assert!(database.list_profiles().unwrap().is_empty());
    assert!(database.pending_outbox().unwrap().is_empty());
    assert!(database.quarantined_mutations().unwrap().is_empty());
    assert_eq!(database.sync_cursor().unwrap(), None);
    assert_eq!(database.run_history().unwrap().len(), 1);
}

#[test]
fn hosted_outbox_contains_only_profiles_and_applies_receipts_transactionally() {
    let directory = tempdir().unwrap();
    let database = Database::open(directory.path().join("hosted.sqlite3")).unwrap();
    let profile = Profile {
        id: "00000000-0000-4000-8000-000000000010".into(),
        name: "Local".into(),
        source_path: "/source".into(),
        target_path: "/target".into(),
        exclusions: vec![".git".into()],
        created_at: "2026-08-15T00:00:00Z".into(),
        updated_at: "2026-08-15T00:00:00Z".into(),
    };
    database.save_profile(&profile).unwrap();
    database
        .record_run("private-run", &profile.id, "completed", 7, "secret history")
        .unwrap();
    database.claim_hosted_account("subject", true).unwrap();
    let request = database.hosted_sync_request("subject").unwrap();
    let serialized = serde_json::to_string(&request).unwrap();
    assert!(serialized.contains("sourcePath"));
    assert!(!serialized.contains("private-run"));
    assert!(!serialized.contains("secret history"));
    let mutation_id = request["mutations"][0]["mutationId"]
        .as_str()
        .unwrap()
        .to_owned();
    let epoch = request["epoch"].as_str().unwrap().to_owned();
    database.apply_hosted_sync_response("subject", &epoch, "", 1, &serde_json::json!({
        "epoch": epoch,
        "cursor": "cursor-1",
        "records": [{
            "kind": "profile", "revision": 1,
            "profile": { "id": profile.id, "name": "Remote arrival", "sourcePath": "/source", "targetPath": "/target",
                "exclusions": [], "createdAt": profile.created_at, "updatedAt": "2026-08-15T01:00:00Z", "syncMode": "additive" }
        }],
        "receipts": [{ "mutationId": mutation_id, "revision": 1 }]
    })).unwrap();
    assert!(database.pending_outbox().unwrap().is_empty());
    assert_eq!(
        database.sync_cursor().unwrap(),
        Some((request["epoch"].as_str().unwrap().into(), "cursor-1".into()))
    );
    assert_eq!(database.list_profiles().unwrap()[0].name, "Remote arrival");
    assert_eq!(database.run_history().unwrap()[0].id, "private-run");
}

#[test]
fn invalid_hosted_profile_is_rejected_before_profile_or_cursor_persistence() {
    let directory = tempdir().unwrap();
    let database = Database::open(directory.path().join("invalid-hosted.sqlite3")).unwrap();
    let request = database.hosted_sync_request("subject").unwrap();
    let epoch = request["epoch"].as_str().unwrap();
    let generation = database
        .hosted_sync_generation("subject", epoch, "")
        .unwrap();

    let error = database
        .apply_hosted_sync_response(
            "subject",
            epoch,
            "",
            generation,
            &serde_json::json!({
                "epoch": epoch,
                "cursor": "must-not-commit",
                "records": [{
                    "kind": "profile",
                    "revision": 1,
                    "profile": {
                        "id": "invalid-hosted-profile",
                        "name": "n".repeat(81),
                        "sourcePath": "/source",
                        "targetPath": "/target",
                        "exclusions": [],
                        "createdAt": "2026-08-15T00:00:00Z",
                        "updatedAt": "2026-08-15T00:00:00Z"
                    }
                }],
                "receipts": []
            }),
        )
        .unwrap_err();

    assert_eq!(error.code, NativeErrorCode::ValidationFailed);
    assert!(database.list_profiles().unwrap().is_empty());
    assert_eq!(
        database.sync_cursor().unwrap(),
        Some((epoch.into(), String::new()))
    );
}

#[test]
fn accepting_a_rotated_account_epoch_drops_stale_outbox_and_respects_local_choice() {
    let directory = tempdir().unwrap();
    let database = Database::open(directory.path().join("epoch.sqlite3")).unwrap();
    let profile = Profile {
        id: "00000000-0000-4000-8000-000000000020".into(),
        name: "Keep me".into(),
        source_path: "/source".into(),
        target_path: "/target".into(),
        exclusions: vec![],
        created_at: "2026-08-15T00:00:00Z".into(),
        updated_at: "2026-08-15T00:00:00Z".into(),
    };
    database.save_profile(&profile).unwrap();
    assert_eq!(database.pending_outbox().unwrap().len(), 1);

    database
        .accept_account_epoch("subject", "00000000-0000-4000-8000-000000000021", false)
        .unwrap();
    assert_eq!(database.list_profiles().unwrap().first(), Some(&profile));
    assert!(database.pending_outbox().unwrap().is_empty());
    assert_eq!(
        database.sync_cursor().unwrap(),
        Some(("00000000-0000-4000-8000-000000000021".into(), String::new()))
    );

    database.save_profile(&profile).unwrap();
    database
        .accept_account_epoch("subject", "00000000-0000-4000-8000-000000000022", true)
        .unwrap();
    assert!(database.list_profiles().unwrap().is_empty());
    assert!(database.pending_outbox().unwrap().is_empty());
}

#[test]
fn hosted_outbox_batches_offline_replay_within_api_count_and_body_limits() {
    let directory = tempdir().unwrap();
    let database = Database::open(directory.path().join("batch.sqlite3")).unwrap();
    for index in 0..105 {
        database
            .enqueue_mutation(
                &format!("00000000-0000-4000-8001-{index:012}"),
                "upsert",
                &serde_json::json!({
                    "id": format!("00000000-0000-4000-8002-{index:012}"),
                    "name": "Offline",
                    "sourcePath": format!("/source/{}", "s".repeat(4080)),
                    "targetPath": format!("/target/{}", "t".repeat(4080)),
                    "exclusions": [],
                    "createdAt": "2026-08-15T00:00:00Z",
                    "updatedAt": "2026-08-15T00:00:00Z",
                })
                .to_string(),
                "2026-08-15T00:00:00Z",
            )
            .unwrap();
    }
    database.claim_hosted_account("subject", true).unwrap();

    let mut acknowledged = 0;
    let mut batches = 0;
    while !database.pending_outbox().unwrap().is_empty() {
        let request = database.hosted_sync_request("subject").unwrap();
        let mutations = request["mutations"].as_array().unwrap();
        assert!(!mutations.is_empty());
        assert!(mutations.len() <= 100);
        assert!(serde_json::to_vec(&request).unwrap().len() <= 256 * 1024);
        acknowledged += mutations.len();
        batches += 1;
        let receipts: Vec<_> = mutations
            .iter()
            .enumerate()
            .map(|(index, mutation)| {
                serde_json::json!({
                    "mutationId": mutation["mutationId"],
                    "revision": acknowledged - mutations.len() + index + 1,
                })
            })
            .collect();
        let expected_cursor = request["cursor"].as_str().unwrap_or_default().to_owned();
        let generation = database
            .hosted_sync_generation(
                "subject",
                request["epoch"].as_str().unwrap(),
                &expected_cursor,
            )
            .unwrap();
        database
            .apply_hosted_sync_response(
                "subject",
                request["epoch"].as_str().unwrap(),
                &expected_cursor,
                generation,
                &serde_json::json!({
                    "epoch": request["epoch"],
                    "cursor": format!("batch-{batches}"),
                    "records": [],
                    "receipts": receipts,
                }),
            )
            .unwrap();
    }
    assert_eq!(acknowledged, 105);
    assert!(batches > 1);
}

#[test]
fn first_batch_response_cannot_overwrite_a_same_profile_edit_queued_in_the_next_batch() {
    let directory = tempdir().unwrap();
    let database = Database::open(directory.path().join("batch-edit-fence.sqlite3")).unwrap();
    database.hosted_sync_request("alice").unwrap();
    let mut profile = Profile {
        id: "batch-profile".into(),
        name: String::new(),
        source_path: "/batch/source".into(),
        target_path: "/batch/target".into(),
        exclusions: vec![],
        created_at: "2026-08-15T00:00:00Z".into(),
        updated_at: "2026-08-15T00:00:00Z".into(),
    };
    for index in 0..=100 {
        profile.name = format!("Local {index}");
        profile.updated_at = format!("2026-08-15T00:{:02}:00Z", index % 60);
        database.save_profile(&profile).unwrap();
    }
    let first = database.hosted_sync_request("alice").unwrap();
    assert_eq!(first["mutations"].as_array().unwrap().len(), 100);
    let epoch = first["epoch"].as_str().unwrap();
    let generation = database.hosted_sync_generation("alice", epoch, "").unwrap();
    let server_profile = first["mutations"][99]["profile"].clone();
    database
        .apply_hosted_sync_response(
            "alice",
            epoch,
            "",
            generation,
            &serde_json::json!({
                "epoch": epoch,
                "cursor": "batch-one",
                "hasMore": false,
                "records": [{ "kind": "profile", "revision": 100, "profile": server_profile }],
                "receipts": first["mutations"].as_array().unwrap().iter().enumerate().map(|(index, mutation)| {
                    serde_json::json!({ "mutationId": mutation["mutationId"], "revision": index + 1 })
                }).collect::<Vec<_>>()
            }),
        )
        .unwrap();
    assert_eq!(database.list_profiles().unwrap()[0].name, "Local 100");
    assert_eq!(database.pending_outbox().unwrap().len(), 1);
}

#[test]
fn first_batch_response_cannot_resurrect_a_delete_queued_in_the_next_batch() {
    let directory = tempdir().unwrap();
    let database = Database::open(directory.path().join("batch-delete-fence.sqlite3")).unwrap();
    database.hosted_sync_request("alice").unwrap();
    let mut profile = Profile {
        id: "batch-profile".into(),
        name: String::new(),
        source_path: "/batch/source".into(),
        target_path: "/batch/target".into(),
        exclusions: vec![],
        created_at: "2026-08-15T00:00:00Z".into(),
        updated_at: "2026-08-15T00:00:00Z".into(),
    };
    for index in 0..100 {
        profile.name = format!("Local {index}");
        profile.updated_at = format!("2026-08-15T00:{:02}:00Z", index % 60);
        database.save_profile(&profile).unwrap();
    }
    database.delete_profile(&profile.id).unwrap();
    let first = database.hosted_sync_request("alice").unwrap();
    assert_eq!(first["mutations"].as_array().unwrap().len(), 100);
    let epoch = first["epoch"].as_str().unwrap();
    let generation = database.hosted_sync_generation("alice", epoch, "").unwrap();
    let server_profile = first["mutations"][99]["profile"].clone();
    database
        .apply_hosted_sync_response(
            "alice",
            epoch,
            "",
            generation,
            &serde_json::json!({
                "epoch": epoch,
                "cursor": "batch-one",
                "hasMore": false,
                "records": [{ "kind": "profile", "revision": 100, "profile": server_profile }],
                "receipts": first["mutations"].as_array().unwrap().iter().enumerate().map(|(index, mutation)| {
                    serde_json::json!({ "mutationId": mutation["mutationId"], "revision": index + 1 })
                }).collect::<Vec<_>>()
            }),
        )
        .unwrap();
    assert!(database.list_profiles().unwrap().is_empty());
    let pending = database.pending_outbox().unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].kind, "delete");
}

#[test]
fn delayed_sync_responses_are_fenced_after_disconnect_switch_reset_and_out_of_order_apply() {
    let directory = tempdir().unwrap();
    let database = Database::open(directory.path().join("fenced.sqlite3")).unwrap();
    database.claim_hosted_account("alice", true).unwrap();
    let alice = database.hosted_sync_request("alice").unwrap();
    let alice_epoch = alice["epoch"].as_str().unwrap().to_owned();
    let alice_generation = database
        .hosted_sync_generation("alice", &alice_epoch, "")
        .unwrap();
    let alice_response = serde_json::json!({
        "epoch": alice_epoch,
        "cursor": "alice-cursor",
        "records": [{
            "kind": "profile", "revision": 1,
            "profile": {
                "id": "alice-remote", "name": "Alice remote", "sourcePath": "/alice/private",
                "targetPath": "/alice/target", "exclusions": [],
                "createdAt": "2026-08-15T00:00:00Z", "updatedAt": "2026-08-15T00:00:00Z"
            }
        }],
        "receipts": []
    });

    database.disconnect_hosted_account(true).unwrap();
    database.claim_hosted_account("bob", false).unwrap();
    assert!(database
        .apply_hosted_sync_response(
            "alice",
            alice["epoch"].as_str().unwrap(),
            "",
            alice_generation,
            &alice_response
        )
        .is_err());
    assert!(database.list_profiles().unwrap().is_empty());
    assert!(database.hosted_sync_request("bob").is_ok());

    let bob = database.hosted_sync_request("bob").unwrap();
    let bob_epoch = bob["epoch"].as_str().unwrap().to_owned();
    let bob_generation = database
        .hosted_sync_generation("bob", &bob_epoch, "")
        .unwrap();
    database
        .accept_account_epoch("bob", "00000000-0000-4000-8000-000000000099", false)
        .unwrap();
    assert!(database
        .apply_hosted_sync_response(
            "bob",
            &bob_epoch,
            "",
            bob_generation,
            &serde_json::json!({
                "epoch": bob_epoch, "cursor": "stale", "records": [], "receipts": []
            })
        )
        .is_err());
    assert_eq!(
        database.sync_cursor().unwrap(),
        Some(("00000000-0000-4000-8000-000000000099".into(), String::new()))
    );

    let current = database.hosted_sync_request("bob").unwrap();
    let current_epoch = current["epoch"].as_str().unwrap().to_owned();
    let current_generation = database
        .hosted_sync_generation("bob", &current_epoch, "")
        .unwrap();
    database
        .apply_hosted_sync_response(
            "bob",
            &current_epoch,
            "",
            current_generation,
            &serde_json::json!({
                "epoch": current_epoch, "cursor": "newer", "records": [], "receipts": []
            }),
        )
        .unwrap();
    assert!(database
        .apply_hosted_sync_response(
            "bob",
            current["epoch"].as_str().unwrap(),
            "",
            current_generation,
            &serde_json::json!({
                "epoch": current["epoch"], "cursor": "older", "records": [], "receipts": []
            })
        )
        .is_err());
    assert_eq!(database.sync_cursor().unwrap().unwrap().1, "newer");

    let deletion_generation = database
        .hosted_sync_generation("bob", current["epoch"].as_str().unwrap(), "newer")
        .unwrap();
    database.disconnect_hosted_account(false).unwrap();
    database.claim_hosted_account("carol", false).unwrap();
    assert!(database
        .accept_account_epoch_if_current(
            "bob",
            current["epoch"].as_str().unwrap(),
            "newer",
            deletion_generation,
            "00000000-0000-4000-8000-000000000100",
            true,
        )
        .is_err());
    assert!(database.hosted_sync_request("carol").is_ok());
}

#[test]
fn claiming_the_same_subject_twice_preserves_the_committed_epoch() {
    let directory = tempdir().unwrap();
    let database = Database::open(directory.path().join("claim-idempotent.sqlite3")).unwrap();
    database.claim_hosted_account("alice", true).unwrap();
    let epoch = database.hosted_sync_request("alice").unwrap()["epoch"]
        .as_str()
        .unwrap()
        .to_owned();
    database.claim_hosted_account("alice", false).unwrap();
    assert_eq!(
        database.hosted_sync_request("alice").unwrap()["epoch"],
        epoch
    );
}

#[test]
fn local_save_invalidates_an_inflight_response_before_it_can_overwrite_the_new_profile() {
    let directory = tempdir().unwrap();
    let database = Database::open(directory.path().join("save-race.sqlite3")).unwrap();
    let mut profile = Profile {
        id: "profile-race-save".into(),
        name: "Before request".into(),
        source_path: "/new/local/source".into(),
        target_path: "/new/local/target".into(),
        exclusions: vec![],
        created_at: "2026-08-15T00:00:00Z".into(),
        updated_at: "2026-08-15T00:00:00Z".into(),
    };
    database.save_profile(&profile).unwrap();
    database.claim_hosted_account("alice", true).unwrap();
    let request = database.hosted_sync_request("alice").unwrap();
    let epoch = request["epoch"].as_str().unwrap().to_owned();
    let generation = database
        .hosted_sync_generation("alice", &epoch, "")
        .unwrap();

    profile.name = "Edited while response was delayed".into();
    profile.updated_at = "2026-08-15T01:00:00Z".into();
    database.save_profile(&profile).unwrap();
    let stale = serde_json::json!({
        "epoch": epoch, "cursor": "stale-save", "hasMore": false,
        "records": [{
            "kind": "profile", "revision": 1,
            "profile": {
                "id": profile.id, "name": "Remote stale value", "sourcePath": "/remote/stale",
                "targetPath": "/remote/stale", "exclusions": [],
                "createdAt": profile.created_at, "updatedAt": "2026-08-14T00:00:00Z"
            }
        }],
        "receipts": [{ "mutationId": request["mutations"][0]["mutationId"], "revision": 1 }]
    });
    assert_eq!(
        database
            .apply_hosted_sync_response("alice", &epoch, "", generation, &stale)
            .unwrap_err()
            .code,
        NativeErrorCode::SyncStateChanged,
    );
    assert_eq!(database.list_profiles().unwrap(), [profile.clone()]);
    let replay = database.hosted_sync_request("alice").unwrap();
    assert_eq!(replay["mutations"].as_array().unwrap().len(), 2);
    assert!(replay
        .to_string()
        .contains("Edited while response was delayed"));
}

#[test]
fn local_delete_invalidates_an_inflight_profile_before_it_can_resurrect_the_profile() {
    let directory = tempdir().unwrap();
    let database = Database::open(directory.path().join("delete-race.sqlite3")).unwrap();
    let profile = Profile {
        id: "profile-race-delete".into(),
        name: "Delete locally".into(),
        source_path: "/source".into(),
        target_path: "/target".into(),
        exclusions: vec![],
        created_at: "2026-08-15T00:00:00Z".into(),
        updated_at: "2026-08-15T00:00:00Z".into(),
    };
    database.save_profile(&profile).unwrap();
    database.claim_hosted_account("alice", true).unwrap();
    let initial = database.hosted_sync_request("alice").unwrap();
    let epoch = initial["epoch"].as_str().unwrap().to_owned();
    let initial_generation = database
        .hosted_sync_generation("alice", &epoch, "")
        .unwrap();
    database
        .apply_hosted_sync_response(
            "alice",
            &epoch,
            "",
            initial_generation,
            &serde_json::json!({
                "epoch": epoch, "cursor": "cursor-before-delete", "hasMore": false,
                "records": [],
                "receipts": [{ "mutationId": initial["mutations"][0]["mutationId"], "revision": 1 }]
            }),
        )
        .unwrap();
    let request = database.hosted_sync_request("alice").unwrap();
    let generation = database
        .hosted_sync_generation("alice", &epoch, "cursor-before-delete")
        .unwrap();

    database.delete_profile(&profile.id).unwrap();
    assert_eq!(
        database
            .apply_hosted_sync_response(
                "alice",
                &epoch,
                "cursor-before-delete",
                generation,
                &serde_json::json!({
                    "epoch": epoch, "cursor": "stale-delete", "hasMore": false,
                    "records": [{ "kind": "profile", "revision": 2, "profile": profile }],
                    "receipts": []
                })
            )
            .unwrap_err()
            .code,
        NativeErrorCode::SyncStateChanged,
    );
    assert!(database.list_profiles().unwrap().is_empty());
    let replay = database.hosted_sync_request("alice").unwrap();
    assert_eq!(replay["mutations"][0]["kind"], "delete");
    assert_eq!(request["mutations"], serde_json::json!([]));
}

#[test]
fn adopting_an_existing_server_epoch_preserves_only_explicitly_consented_unclaimed_outbox() {
    let directory = tempdir().unwrap();
    let database = Database::open(directory.path().join("epoch-adoption.sqlite3")).unwrap();
    let profile = Profile {
        id: "device-two-local".into(),
        name: "Explicitly consented".into(),
        source_path: "/device-two/private".into(),
        target_path: "/device-two/backup".into(),
        exclusions: vec![],
        created_at: "2026-08-15T00:00:00Z".into(),
        updated_at: "2026-08-15T00:00:00Z".into(),
    };
    database.save_profile(&profile).unwrap();
    database.claim_hosted_account("alice", true).unwrap();
    database
        .accept_account_epoch("alice", "00000000-0000-4000-8000-000000000111", false)
        .unwrap();
    let adopted = database.hosted_sync_request("alice").unwrap();
    assert_eq!(adopted["mutations"].as_array().unwrap().len(), 1);
    assert!(adopted.to_string().contains("/device-two/private"));

    let epoch = adopted["epoch"].as_str().unwrap().to_owned();
    let generation = database
        .hosted_sync_generation("alice", &epoch, "")
        .unwrap();
    database
        .apply_hosted_sync_response(
            "alice",
            &epoch,
            "",
            generation,
            &serde_json::json!({
                "epoch": epoch, "cursor": "cloud-owned", "hasMore": false, "records": [],
                "receipts": [{ "mutationId": adopted["mutations"][0]["mutationId"], "revision": 1 }]
            }),
        )
        .unwrap();
    database
        .save_profile(&Profile {
            name: "Cloud-owned edit".into(),
            ..profile
        })
        .unwrap();
    database
        .accept_account_epoch("alice", "00000000-0000-4000-8000-000000000112", false)
        .unwrap();
    assert!(database.pending_outbox().unwrap().is_empty());
}

#[test]
fn epoch_adoption_keeps_only_unreceipted_consented_mutations_and_drops_new_cloud_edits() {
    let directory = tempdir().unwrap();
    let database = Database::open(directory.path().join("partial-consent.sqlite3")).unwrap();
    for id in ["consented-one", "consented-two"] {
        database
            .save_profile(&Profile {
                id: id.into(),
                name: id.into(),
                source_path: format!("/{id}/source"),
                target_path: format!("/{id}/target"),
                exclusions: vec![],
                created_at: "2026-08-15T00:00:00Z".into(),
                updated_at: "2026-08-15T00:00:00Z".into(),
            })
            .unwrap();
    }
    database.claim_hosted_account("alice", true).unwrap();
    database
        .accept_account_epoch("alice", "00000000-0000-4000-8000-000000000121", false)
        .unwrap();
    let request = database.hosted_sync_request("alice").unwrap();
    let epoch = request["epoch"].as_str().unwrap().to_owned();
    let generation = database
        .hosted_sync_generation("alice", &epoch, "")
        .unwrap();
    database
        .apply_hosted_sync_response(
            "alice",
            &epoch,
            "",
            generation,
            &serde_json::json!({
                "epoch": epoch, "cursor": "partial", "hasMore": false, "records": [],
                "receipts": [{ "mutationId": request["mutations"][0]["mutationId"], "revision": 1 }]
            }),
        )
        .unwrap();
    assert_eq!(database.pending_outbox().unwrap().len(), 1);
    database
        .save_profile(&Profile {
            id: "cloud-owned-new-edit".into(),
            name: "Cloud-owned new edit".into(),
            source_path: "/cloud/source".into(),
            target_path: "/cloud/target".into(),
            exclusions: vec![],
            created_at: "2026-08-15T00:01:00Z".into(),
            updated_at: "2026-08-15T00:01:00Z".into(),
        })
        .unwrap();
    assert_eq!(database.pending_outbox().unwrap().len(), 2);
    database
        .accept_account_epoch("alice", "00000000-0000-4000-8000-000000000122", false)
        .unwrap();
    let preserved = database.pending_outbox().unwrap();
    assert_eq!(preserved.len(), 1);
    assert!(preserved[0].payload.contains("consented-two"));
    assert!(!preserved[0].payload.contains("cloud-owned-new-edit"));
}

#[test]
fn editing_a_consented_profile_before_epoch_adoption_preserves_the_newer_edit() {
    let directory = tempdir().unwrap();
    let database = Database::open(directory.path().join("consented-edit.sqlite3")).unwrap();
    let mut profile = Profile {
        id: "consented-profile".into(),
        name: "Old value".into(),
        source_path: "/old/source".into(),
        target_path: "/old/target".into(),
        exclusions: vec![],
        created_at: "2026-08-15T00:00:00Z".into(),
        updated_at: "2026-08-15T00:00:00Z".into(),
    };
    database.save_profile(&profile).unwrap();
    database.claim_hosted_account("alice", true).unwrap();
    profile.name = "New value".into();
    profile.updated_at = "2026-08-15T00:01:00Z".into();
    database.save_profile(&profile).unwrap();

    database
        .accept_account_epoch("alice", "00000000-0000-4000-8000-000000000131", false)
        .unwrap();
    let request = database.hosted_sync_request("alice").unwrap();
    assert_eq!(request["mutations"].as_array().unwrap().len(), 2);
    assert_eq!(request["mutations"][1]["profile"]["name"], "New value");
    let epoch = request["epoch"].as_str().unwrap();
    let generation = database.hosted_sync_generation("alice", epoch, "").unwrap();
    database
        .apply_hosted_sync_response(
            "alice",
            epoch,
            "",
            generation,
            &serde_json::json!({
                "epoch": epoch,
                "cursor": "edited",
                "hasMore": false,
                "records": [{ "kind": "profile", "revision": 2, "profile": profile }],
                "receipts": request["mutations"].as_array().unwrap().iter().enumerate().map(|(index, mutation)| {
                    serde_json::json!({ "mutationId": mutation["mutationId"], "revision": index + 1 })
                }).collect::<Vec<_>>()
            }),
        )
        .unwrap();
    assert_eq!(database.list_profiles().unwrap()[0].name, "New value");
    assert!(database.pending_outbox().unwrap().is_empty());
}

#[test]
fn deleting_a_consented_profile_before_epoch_adoption_preserves_the_tombstone() {
    let directory = tempdir().unwrap();
    let database = Database::open(directory.path().join("consented-delete.sqlite3")).unwrap();
    let profile = Profile {
        id: "consented-profile".into(),
        name: "Delete me".into(),
        source_path: "/delete/source".into(),
        target_path: "/delete/target".into(),
        exclusions: vec![],
        created_at: "2026-08-15T00:00:00Z".into(),
        updated_at: "2026-08-15T00:00:00Z".into(),
    };
    database.save_profile(&profile).unwrap();
    database.claim_hosted_account("alice", true).unwrap();
    database.delete_profile(&profile.id).unwrap();

    database
        .accept_account_epoch("alice", "00000000-0000-4000-8000-000000000132", false)
        .unwrap();
    let request = database.hosted_sync_request("alice").unwrap();
    assert_eq!(request["mutations"].as_array().unwrap().len(), 2);
    assert_eq!(request["mutations"][1]["kind"], "delete");
    assert_eq!(request["mutations"][1]["profileId"], profile.id);
    assert!(database.list_profiles().unwrap().is_empty());
    let epoch = request["epoch"].as_str().unwrap();
    let generation = database.hosted_sync_generation("alice", epoch, "").unwrap();
    database
        .apply_hosted_sync_response(
            "alice",
            epoch,
            "",
            generation,
            &serde_json::json!({
                "epoch": epoch,
                "cursor": "deleted",
                "hasMore": false,
                "records": [{ "kind": "tombstone", "revision": 2, "profileId": profile.id }],
                "receipts": request["mutations"].as_array().unwrap().iter().enumerate().map(|(index, mutation)| {
                    serde_json::json!({ "mutationId": mutation["mutationId"], "revision": index + 1 })
                }).collect::<Vec<_>>()
            }),
        )
        .unwrap();
    assert!(database.list_profiles().unwrap().is_empty());
    assert!(database.pending_outbox().unwrap().is_empty());
}

#[test]
fn hosted_state_cannot_cross_accounts_and_signout_quarantines_pending_paths() {
    let directory = tempdir().unwrap();
    let database = Database::open(directory.path().join("accounts.sqlite3")).unwrap();
    let profile = Profile {
        id: "profile-from-alice".into(),
        name: "Alice private path".into(),
        source_path: "/Users/alice/private".into(),
        target_path: "/Volumes/alice".into(),
        exclusions: vec![],
        created_at: "2026-08-15T00:00:00Z".into(),
        updated_at: "2026-08-15T00:00:00Z".into(),
    };
    database.save_profile(&profile).unwrap();
    assert_eq!(
        database
            .hosted_sync_request("account-alice")
            .unwrap_err()
            .code,
        NativeErrorCode::SyncAccountClaimRequired,
    );
    database
        .claim_hosted_account("account-alice", true)
        .unwrap();
    let alice = database.hosted_sync_request("account-alice").unwrap();
    assert!(alice.to_string().contains("/Users/alice/private"));
    assert_eq!(
        database
            .hosted_sync_request("account-bob")
            .unwrap_err()
            .code,
        NativeErrorCode::AuthRequired,
    );

    database.disconnect_hosted_account(false).unwrap();
    assert_eq!(database.list_profiles().unwrap(), [profile]);
    assert_eq!(
        database
            .hosted_sync_request("account-bob")
            .unwrap_err()
            .code,
        NativeErrorCode::SyncAccountClaimRequired
    );
    database.claim_hosted_account("account-bob", false).unwrap();
    let bob = database.hosted_sync_request("account-bob").unwrap();
    assert_eq!(bob["mutations"], serde_json::json!([]));
    assert!(uuid::Uuid::parse_str(bob["epoch"].as_str().unwrap()).is_ok());
    assert!(!bob.to_string().contains("/Users/alice/private"));
}

#[test]
fn upgrades_task3_database_and_claims_opaque_profile_ids_only_by_consent() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("task3-upgrade.sqlite3");
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch(&format!(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
             {}
             INSERT INTO schema_migrations(version) VALUES (1);",
            include_str!("../migrations/0001_offline_state.sql")
        ))
        .unwrap();
    drop(connection);

    let database = Database::open(&path).unwrap();
    let profile = Profile {
        id: "profile-task3-existing".into(),
        name: "Task 3 profile".into(),
        source_path: "/legacy/source".into(),
        target_path: "/legacy/target".into(),
        exclusions: vec![],
        created_at: "2026-08-15T00:00:00Z".into(),
        updated_at: "2026-08-15T00:00:00Z".into(),
    };
    database.save_profile(&profile).unwrap();
    assert_eq!(
        database.hosted_sync_request("alice").unwrap_err().code,
        NativeErrorCode::SyncAccountClaimRequired,
    );
    database.claim_hosted_account("alice", false).unwrap();
    assert_eq!(database.list_profiles().unwrap(), [profile]);
    assert_eq!(
        database.hosted_sync_request("alice").unwrap()["mutations"],
        serde_json::json!([]),
    );
}

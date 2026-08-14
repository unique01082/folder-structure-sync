use std::fs;

use rootline_desktop::{
    apply_plan, detect_case_sensitive, random_vault_password, resolve_existing_vault_password,
    scan_plan, strict_auth_callback_arg, CancellationToken, Database, DirectoryStatus,
    NativeErrorCode, Profile, ScanRequest,
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
fn filters_single_instance_arguments_to_the_exact_auth_callback() {
    assert_eq!(
        strict_auth_callback_arg(&[
            "rootline".into(),
            "rootline://auth/callback?code=x&state=y".into()
        ]),
        Some("rootline://auth/callback?code=x&state=y".into()),
    );
    for invalid in [
        "https://auth/callback?code=x&state=y",
        "rootline://evil/callback?code=x&state=y",
        "rootline://auth/callback/extra?code=x&state=y",
        "rootline://auth/callback?state=y",
    ] {
        assert_eq!(strict_auth_callback_arg(&[invalid.into()]), None);
    }
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
    database.clear_local_synced_data().unwrap();
    assert!(database.list_profiles().unwrap().is_empty());
    assert!(database.pending_outbox().unwrap().is_empty());
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

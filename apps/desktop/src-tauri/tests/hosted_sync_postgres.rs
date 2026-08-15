use rootline_desktop::{Database, Profile};
use serde_json::Value;
use tempfile::tempdir;

fn post_sync(
    client: &reqwest::blocking::Client,
    api_url: &str,
    token: &str,
    body: &Value,
) -> reqwest::blocking::Response {
    client
        .post(format!("{api_url}/v1/sync"))
        .bearer_auth(token)
        .json(body)
        .send()
        .unwrap()
}

fn exact_code_points(count: usize) -> String {
    format!(
        "{}{}",
        "✈️".repeat(count / 2),
        if count % 2 == 1 { "x" } else { "" }
    )
}

#[test]
#[ignore = "run by the real PostgreSQL API harness"]
fn replays_a_consented_device_two_outbox_without_leaking_paths_to_another_account() {
    let api_url = std::env::var("ROOTLINE_E2E_API_URL").expect("ROOTLINE_E2E_API_URL");
    let alice_token = std::env::var("ROOTLINE_E2E_ALICE_TOKEN").expect("ROOTLINE_E2E_ALICE_TOKEN");
    let bob_token = std::env::var("ROOTLINE_E2E_BOB_TOKEN").expect("ROOTLINE_E2E_BOB_TOKEN");
    let directory = tempdir().unwrap();
    let database = Database::open(directory.path().join("device-two.sqlite3")).unwrap();
    let local = Profile {
        id: "device-two-offline-profile".into(),
        name: exact_code_points(80),
        source_path: exact_code_points(4096),
        target_path: exact_code_points(4096),
        exclusions: (0..100).map(|_| exact_code_points(256)).collect(),
        created_at: "2026-08-15T00:00:00.000Z".into(),
        updated_at: "2026-08-15T00:00:00.000Z".into(),
    };
    database.save_profile(&local).unwrap();
    database.claim_hosted_account("seam-alice", true).unwrap();
    let client = reqwest::blocking::Client::new();

    let first = database.hosted_sync_request("seam-alice").unwrap();
    let conflict = post_sync(&client, &api_url, &alice_token, &first);
    assert_eq!(conflict.status(), reqwest::StatusCode::CONFLICT);
    let server_epoch = conflict.json::<Value>().unwrap()["epoch"]
        .as_str()
        .unwrap()
        .to_owned();
    database
        .accept_account_epoch("seam-alice", &server_epoch, false)
        .unwrap();
    assert_eq!(database.pending_outbox().unwrap().len(), 1);

    let reconnect = database.hosted_sync_request("seam-alice").unwrap();
    assert_eq!(reconnect["mutations"][0]["profile"]["name"], local.name);
    assert_eq!(
        reconnect["mutations"][0]["profile"]["sourcePath"],
        local.source_path
    );
    let generation = database
        .hosted_sync_generation("seam-alice", &server_epoch, "")
        .unwrap();
    let response = post_sync(&client, &api_url, &alice_token, &reconnect);
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let body = response.json::<Value>().unwrap();
    assert_eq!(body["receipts"].as_array().unwrap().len(), 1);
    database
        .apply_hosted_sync_response("seam-alice", &server_epoch, "", generation, &body)
        .unwrap();
    assert!(database.pending_outbox().unwrap().is_empty());
    let persisted = database
        .list_profiles()
        .unwrap()
        .into_iter()
        .find(|profile| profile.id == local.id)
        .expect("accepted Unicode profile must reach desktop SQLite");
    assert_eq!(persisted, local);
    assert_eq!(database.sync_cursor().unwrap().unwrap().1, body["cursor"]);

    database.disconnect_hosted_account(false).unwrap();
    assert_eq!(
        database.hosted_sync_request("seam-bob").unwrap_err().code,
        rootline_desktop::NativeErrorCode::SyncAccountClaimRequired
    );
    database.claim_hosted_account("seam-bob", false).unwrap();
    let bob = database.hosted_sync_request("seam-bob").unwrap();
    assert_eq!(bob["mutations"], serde_json::json!([]));
    assert!(!bob.to_string().contains(&local.source_path));
    let bob_epoch = bob["epoch"].as_str().unwrap().to_owned();
    let bob_generation = database
        .hosted_sync_generation("seam-bob", &bob_epoch, "")
        .unwrap();
    let response = post_sync(&client, &api_url, &bob_token, &bob);
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let bob_body = response.json::<Value>().unwrap();
    assert_eq!(bob_body["records"], serde_json::json!([]));
    database
        .apply_hosted_sync_response("seam-bob", &bob_epoch, "", bob_generation, &bob_body)
        .unwrap();
}

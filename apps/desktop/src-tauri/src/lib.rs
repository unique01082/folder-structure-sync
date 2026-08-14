use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{Manager, State};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum NativeErrorCode {
    Cancelled,
    InvalidPath,
    PathOverlap,
    SourceNotFound,
    TargetNotFound,
    UnreadablePath,
    StalePlan,
    Internal,
}

#[derive(Debug, Serialize, thiserror::Error)]
#[error("{message}")]
pub struct NativeError {
    pub code: NativeErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl NativeError {
    fn new(code: NativeErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: None,
        }
    }

    fn at(code: NativeErrorCode, message: impl Into<String>, path: &Path) -> Self {
        Self {
            code,
            message: message.into(),
            details: Some(json!({ "path": path })),
        }
    }
}

impl From<rusqlite::Error> for NativeError {
    fn from(error: rusqlite::Error) -> Self {
        Self::new(
            NativeErrorCode::Internal,
            format!("Local database error: {error}"),
        )
    }
}

#[derive(Clone, Default)]
pub struct CancellationToken(Arc<AtomicBool>);

impl CancellationToken {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }

    fn check(&self) -> Result<(), NativeError> {
        if self.0.load(Ordering::Acquire) {
            Err(NativeError::new(
                NativeErrorCode::Cancelled,
                "The operation was cancelled.",
            ))
        } else {
            Ok(())
        }
    }

    fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

#[derive(Default)]
struct OperationRegistry(Mutex<HashMap<String, CancellationToken>>);

impl OperationRegistry {
    fn begin(&self, id: &str) -> CancellationToken {
        let token = CancellationToken::default();
        self.0
            .lock()
            .expect("operation registry poisoned")
            .insert(id.into(), token.clone());
        token
    }

    fn finish(&self, id: &str) {
        self.0
            .lock()
            .expect("operation registry poisoned")
            .remove(id);
    }

    fn cancel(&self, id: &str) {
        if let Some(token) = self.0.lock().expect("operation registry poisoned").get(id) {
            token.cancel();
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanRequest {
    pub operation_id: String,
    pub source_path: PathBuf,
    pub target_path: PathBuf,
    #[serde(default)]
    pub exclusions: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DirectoryStatus {
    Created,
    AlreadyExists,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryResult {
    pub relative_path: String,
    pub status: DirectoryStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanPlan {
    pub operation_id: String,
    pub source_root: PathBuf,
    pub target_root: PathBuf,
    pub source_fingerprint: String,
    pub target_fingerprint: String,
    pub target_case_sensitive: bool,
    pub plan_fingerprint: String,
    pub missing: Vec<String>,
    pub skipped_links: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub run_id: String,
    pub started_at: String,
    pub finished_at: String,
    pub directories: Vec<DirectoryResult>,
    pub cancelled: bool,
}

#[derive(Debug)]
struct Snapshot {
    entries: Vec<String>,
    fingerprint: String,
    skipped_links: Vec<String>,
}

fn absolute(path: &Path) -> Result<PathBuf, NativeError> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .map_err(|error| NativeError::new(NativeErrorCode::InvalidPath, error.to_string()))
    }
}

fn canonical_directory(path: &Path, role: &str) -> Result<PathBuf, NativeError> {
    assert_not_link(path)?;
    let canonical = fs::canonicalize(path).map_err(|error| {
        let code = if error.kind() == std::io::ErrorKind::NotFound {
            if role == "source" {
                NativeErrorCode::SourceNotFound
            } else {
                NativeErrorCode::TargetNotFound
            }
        } else {
            NativeErrorCode::UnreadablePath
        };
        NativeError::at(code, format!("The {role} folder cannot be read."), path)
    })?;
    if !canonical.is_dir() {
        return Err(NativeError::at(
            NativeErrorCode::UnreadablePath,
            format!("The {role} path is not a folder."),
            path,
        ));
    }
    Ok(canonical)
}

fn assert_not_link(path: &Path) -> Result<(), NativeError> {
    let absolute = absolute(path)?;
    match fs::symlink_metadata(&absolute) {
        Ok(metadata) if is_link_or_junction(&metadata) => Err(NativeError::at(
            NativeErrorCode::InvalidPath,
            "A synchronization root must not be a symbolic link or junction.",
            &absolute,
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(NativeError::at(
            NativeErrorCode::UnreadablePath,
            error.to_string(),
            &absolute,
        )),
    }
}

#[cfg(not(windows))]
fn is_link_or_junction(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(windows)]
fn is_link_or_junction(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

fn assert_no_link_below(root: &Path, destination: &Path) -> Result<(), NativeError> {
    let relative = destination.strip_prefix(root).map_err(|_| {
        NativeError::at(
            NativeErrorCode::InvalidPath,
            "A destination escaped its synchronization root.",
            destination,
        )
    })?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        assert_not_link(&current)?;
    }
    Ok(())
}

fn path_key(path: &Path, case_sensitive: bool) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    if case_sensitive {
        value
    } else {
        value.to_lowercase()
    }
}

fn validate_relationship(
    source: &Path,
    target: &Path,
    case_sensitive: bool,
) -> Result<(), NativeError> {
    let source = path_key(source, case_sensitive);
    let target = path_key(target, case_sensitive);
    if source == target
        || source.starts_with(&format!("{target}/"))
        || target.starts_with(&format!("{source}/"))
    {
        return Err(NativeError::new(
            NativeErrorCode::PathOverlap,
            "Source and target roots must not overlap.",
        ));
    }
    Ok(())
}

pub fn detect_case_sensitive(directory: &Path) -> Result<bool, NativeError> {
    let probe_name = format!(".rootline-case-probe-{}", Uuid::new_v4().simple());
    let probe = directory.join(&probe_name);
    let alternate = directory.join(probe_name.to_uppercase());
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .map_err(|error| {
            NativeError::at(
                NativeErrorCode::UnreadablePath,
                error.to_string(),
                directory,
            )
        })?;
    let outcome = (|| {
        file.write_all(b"rootline").map_err(|error| {
            NativeError::at(NativeErrorCode::UnreadablePath, error.to_string(), &probe)
        })?;
        Ok(!alternate.exists())
    })();
    drop(file);
    let _ = fs::remove_file(probe);
    outcome
}

fn normalize_relative(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn glob_segment_matches(value: &str, pattern: &str) -> bool {
    let value: Vec<_> = value.chars().collect();
    let pattern: Vec<_> = pattern.chars().collect();
    let mut matches = vec![false; value.len() + 1];
    matches[0] = true;
    for token in pattern {
        if token == '*' {
            for index in 1..=value.len() {
                matches[index] = matches[index] || matches[index - 1];
            }
        } else {
            for index in (1..=value.len()).rev() {
                matches[index] = matches[index - 1] && value[index - 1] == token;
            }
            matches[0] = false;
        }
    }
    matches[value.len()]
}

fn excluded(relative: &str, patterns: &[String]) -> bool {
    patterns.iter().any(|pattern| {
        let normalized = pattern.replace('\\', "/");
        if normalized.contains('/') {
            glob_segment_matches(relative, &normalized)
        } else {
            relative
                .split('/')
                .any(|segment| glob_segment_matches(segment, &normalized))
        }
    })
}

fn fingerprint(values: &[String]) -> String {
    let mut hash = 0x811c9dc5_u32;
    for value in values {
        for byte in value.as_bytes() {
            hash ^= u32::from(*byte);
            hash = hash.wrapping_mul(0x01000193);
        }
        hash ^= 10;
        hash = hash.wrapping_mul(0x01000193);
    }
    format!("fnv1a-{hash:08x}")
}

fn scan_root(
    root: &Path,
    exclusions: &[String],
    token: &CancellationToken,
) -> Result<Snapshot, NativeError> {
    let mut entries = Vec::new();
    let mut skipped_links = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(current) = pending.pop() {
        token.check()?;
        if current.join(".ignore").exists() {
            continue;
        }
        let mut children = fs::read_dir(&current)
            .map_err(|error| {
                NativeError::at(NativeErrorCode::UnreadablePath, error.to_string(), &current)
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| {
                NativeError::at(NativeErrorCode::UnreadablePath, error.to_string(), &current)
            })?;
        children.sort_by_key(|entry| entry.file_name());
        for child in children.into_iter().rev() {
            token.check()?;
            let path = child.path();
            let relative =
                normalize_relative(path.strip_prefix(root).expect("entry is below root"));
            if excluded(&relative, exclusions) {
                continue;
            }
            let metadata = fs::symlink_metadata(&path).map_err(|error| {
                NativeError::at(NativeErrorCode::UnreadablePath, error.to_string(), &path)
            })?;
            if is_link_or_junction(&metadata) {
                skipped_links.push(relative);
            } else if metadata.is_dir() {
                entries.push(relative);
                pending.push(path);
            }
        }
    }
    entries.sort();
    skipped_links.sort();
    let fingerprint = fingerprint(&entries);
    Ok(Snapshot {
        entries,
        fingerprint,
        skipped_links,
    })
}

pub fn scan_plan(
    request: &ScanRequest,
    token: &CancellationToken,
) -> Result<ScanPlan, NativeError> {
    token.check()?;
    let source = canonical_directory(&request.source_path, "source")?;
    let target = canonical_directory(&request.target_path, "target")?;
    let target_case_sensitive = detect_case_sensitive(&target)?;
    validate_relationship(&source, &target, target_case_sensitive)?;
    let source_snapshot = scan_root(&source, &request.exclusions, token)?;
    let target_snapshot = scan_root(&target, &request.exclusions, token)?;
    let comparable = |value: &str| {
        if target_case_sensitive {
            value.to_owned()
        } else {
            value.to_lowercase()
        }
    };
    let target_entries: HashSet<_> = target_snapshot
        .entries
        .iter()
        .map(|entry| comparable(entry))
        .collect();
    let missing: Vec<_> = source_snapshot
        .entries
        .iter()
        .filter(|entry| !target_entries.contains(&comparable(entry)))
        .cloned()
        .collect();
    let mut plan_values = vec![
        source.to_string_lossy().into_owned(),
        target.to_string_lossy().into_owned(),
        source_snapshot.fingerprint.clone(),
        target_snapshot.fingerprint.clone(),
        if target_case_sensitive {
            "case-sensitive".into()
        } else {
            "case-insensitive".into()
        },
    ];
    plan_values.extend(missing.iter().cloned());
    Ok(ScanPlan {
        operation_id: request.operation_id.clone(),
        source_root: source,
        target_root: target,
        source_fingerprint: source_snapshot.fingerprint,
        target_fingerprint: target_snapshot.fingerprint,
        target_case_sensitive,
        plan_fingerprint: fingerprint(&plan_values),
        missing,
        skipped_links: source_snapshot.skipped_links,
    })
}

fn selected_with_parents(plan: &ScanPlan, requested: &[String]) -> Vec<String> {
    let missing: HashSet<_> = plan.missing.iter().cloned().collect();
    let mut selected = HashSet::new();
    for path in requested {
        if !missing.contains(path) {
            continue;
        }
        let parts: Vec<_> = path.split('/').collect();
        for depth in 1..=parts.len() {
            let parent = parts[..depth].join("/");
            if missing.contains(&parent) {
                selected.insert(parent);
            }
        }
    }
    let mut selected: Vec<_> = selected.into_iter().collect();
    selected.sort_by(|left, right| {
        left.matches('/')
            .count()
            .cmp(&right.matches('/').count())
            .then(left.cmp(right))
    });
    selected
}

pub fn apply_plan(
    request: &ScanRequest,
    plan: &ScanPlan,
    selected: &[String],
    token: &CancellationToken,
) -> Result<ApplyResult, NativeError> {
    let started_at = timestamp();
    let source = canonical_directory(&request.source_path, "source")?;
    let target = canonical_directory(&request.target_path, "target")?;
    if source != plan.source_root || target != plan.target_root {
        return Err(NativeError::new(
            NativeErrorCode::StalePlan,
            "The selected roots differ from the reviewed plan.",
        ));
    }
    let current = scan_plan(request, token)?;
    if current.source_fingerprint != plan.source_fingerprint
        || current.target_fingerprint != plan.target_fingerprint
        || current.plan_fingerprint != plan.plan_fingerprint
        || current.missing != plan.missing
    {
        return Err(NativeError::new(
            NativeErrorCode::StalePlan,
            "The folders changed after review. Scan again before applying.",
        ));
    }
    let mut directories = Vec::new();
    for relative in selected_with_parents(plan, selected) {
        if token.is_cancelled() {
            break;
        }
        if relative
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err(NativeError::new(
                NativeErrorCode::InvalidPath,
                "A plan contains an invalid relative path.",
            ));
        }
        let destination = relative
            .split('/')
            .fold(target.clone(), |path, part| path.join(part));
        assert_no_link_below(&target, &destination)?;
        directories.push(create_directory_result(relative, &destination));
    }
    Ok(ApplyResult {
        run_id: Uuid::new_v4().to_string(),
        started_at,
        finished_at: timestamp(),
        directories,
        cancelled: token.is_cancelled(),
    })
}

fn create_directory_result(relative_path: String, destination: &Path) -> DirectoryResult {
    match fs::create_dir(destination) {
        Ok(()) => DirectoryResult {
            relative_path,
            status: DirectoryStatus::Created,
            error: None,
        },
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && destination.is_dir() => {
            DirectoryResult {
                relative_path,
                status: DirectoryStatus::AlreadyExists,
                error: None,
            }
        }
        Err(error) => DirectoryResult {
            relative_path,
            status: DirectoryStatus::Failed,
            error: Some(error.to_string()),
        },
    }
}

fn timestamp() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .to_string()
        })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub source_path: String,
    pub target_path: String,
    pub exclusions: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxMutation {
    pub mutation_id: String,
    pub kind: String,
    pub payload: String,
    pub occurred_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub id: String,
    pub profile_id: String,
    pub status: String,
    pub created_count: i64,
    pub result_json: String,
}

pub struct Database(Mutex<Connection>);

const MIGRATIONS: &[(i64, &str)] = &[(1, include_str!("../migrations/0001_offline_state.sql"))];

impl Database {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, NativeError> {
        let mut connection = Connection::open(path)?;
        connection.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY);",
        )?;
        let current_version: i64 = connection.query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )?;
        for (version, sql) in MIGRATIONS
            .iter()
            .filter(|(version, _)| *version > current_version)
        {
            let transaction = connection.transaction()?;
            transaction.execute_batch(sql)?;
            transaction.execute(
                "INSERT INTO schema_migrations(version) VALUES (?1)",
                [version],
            )?;
            transaction.commit()?;
        }
        Ok(Self(Mutex::new(connection)))
    }

    fn connection(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.0.lock().expect("database mutex poisoned")
    }

    pub fn device_id(&self) -> Result<String, NativeError> {
        let connection = self.connection();
        if let Some(id) = connection
            .query_row(
                "SELECT value FROM settings WHERE key = 'device_id'",
                [],
                |row| row.get(0),
            )
            .optional()?
        {
            return Ok(id);
        }
        let id = Uuid::new_v4().to_string();
        connection.execute(
            "INSERT INTO settings(key, value) VALUES ('device_id', ?1)",
            [&id],
        )?;
        Ok(id)
    }

    pub fn save_profile(&self, profile: &Profile) -> Result<(), NativeError> {
        let payload = serde_json::to_string(profile)
            .map_err(|error| NativeError::new(NativeErrorCode::Internal, error.to_string()))?;
        let mut connection = self.connection();
        let transaction = connection.transaction()?;
        transaction.execute(
            "INSERT INTO profiles(id, name, source_path, target_path, exclusions_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, source_path=excluded.source_path,
             target_path=excluded.target_path, exclusions_json=excluded.exclusions_json, updated_at=excluded.updated_at",
            params![profile.id, profile.name, profile.source_path, profile.target_path,
                serde_json::to_string(&profile.exclusions).map_err(|error| NativeError::new(NativeErrorCode::Internal, error.to_string()))?,
                profile.created_at, profile.updated_at],
        )?;
        transaction.execute(
            "INSERT INTO mutation_outbox(mutation_id, kind, payload, occurred_at) VALUES (?1, 'upsert', ?2, ?3)",
            params![Uuid::new_v4().to_string(), payload, profile.updated_at],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn list_profiles(&self) -> Result<Vec<Profile>, NativeError> {
        let connection = self.connection();
        let mut statement = connection.prepare(
            "SELECT id, name, source_path, target_path, exclusions_json, created_at, updated_at
             FROM profiles ORDER BY updated_at DESC, id ASC",
        )?;
        let rows = statement.query_map([], |row| {
            let exclusions: String = row.get(4)?;
            Ok(Profile {
                id: row.get(0)?,
                name: row.get(1)?,
                source_path: row.get(2)?,
                target_path: row.get(3)?,
                exclusions: serde_json::from_str(&exclusions).unwrap_or_default(),
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn delete_profile(&self, id: &str) -> Result<(), NativeError> {
        let mut connection = self.connection();
        let transaction = connection.transaction()?;
        transaction.execute("DELETE FROM profiles WHERE id = ?1", [id])?;
        transaction.execute(
            "INSERT INTO mutation_outbox(mutation_id, kind, payload, occurred_at) VALUES (?1, 'delete', ?2, ?3)",
            params![Uuid::new_v4().to_string(), json!({ "profileId": id }).to_string(), timestamp()],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn enqueue_mutation(
        &self,
        id: &str,
        kind: &str,
        payload: &str,
        occurred_at: &str,
    ) -> Result<(), NativeError> {
        self.connection().execute(
            "INSERT OR IGNORE INTO mutation_outbox(mutation_id, kind, payload, occurred_at) VALUES (?1, ?2, ?3, ?4)",
            params![id, kind, payload, occurred_at],
        )?;
        Ok(())
    }

    pub fn pending_outbox(&self) -> Result<Vec<OutboxMutation>, NativeError> {
        let connection = self.connection();
        let mut statement = connection.prepare(
            "SELECT mutation_id, kind, payload, occurred_at FROM mutation_outbox ORDER BY sequence ASC",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(OutboxMutation {
                mutation_id: row.get(0)?,
                kind: row.get(1)?,
                payload: row.get(2)?,
                occurred_at: row.get(3)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn acknowledge_mutations(&self, ids: &[String]) -> Result<(), NativeError> {
        let mut connection = self.connection();
        let transaction = connection.transaction()?;
        for id in ids {
            transaction.execute("DELETE FROM mutation_outbox WHERE mutation_id = ?1", [id])?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn set_sync_cursor(&self, epoch: &str, cursor: &str) -> Result<(), NativeError> {
        self.connection().execute(
            "INSERT INTO sync_state(singleton, epoch, cursor) VALUES (1, ?1, ?2)
             ON CONFLICT(singleton) DO UPDATE SET epoch=excluded.epoch, cursor=excluded.cursor",
            params![epoch, cursor],
        )?;
        Ok(())
    }

    pub fn sync_cursor(&self) -> Result<Option<(String, String)>, NativeError> {
        Ok(self
            .connection()
            .query_row(
                "SELECT epoch, cursor FROM sync_state WHERE singleton = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?)
    }

    pub fn record_run(
        &self,
        id: &str,
        profile_id: &str,
        status: &str,
        created_count: i64,
        result_json: &str,
    ) -> Result<(), NativeError> {
        let mut connection = self.connection();
        let transaction = connection.transaction()?;
        transaction.execute(
            "INSERT INTO run_history(id, profile_id, status, created_count, result_json) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, profile_id, status, created_count, result_json],
        )?;
        transaction.execute(
            "DELETE FROM run_history WHERE sequence NOT IN (SELECT sequence FROM run_history ORDER BY sequence DESC LIMIT 100)",
            [],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn run_history(&self) -> Result<Vec<RunRecord>, NativeError> {
        let connection = self.connection();
        let mut statement = connection.prepare(
            "SELECT id, profile_id, status, created_count, result_json FROM run_history ORDER BY sequence DESC LIMIT 100",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(RunRecord {
                id: row.get(0)?,
                profile_id: row.get(1)?,
                status: row.get(2)?,
                created_count: row.get(3)?,
                result_json: row.get(4)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }
}

#[tauri::command]
fn choose_folder(_role: String) -> Option<String> {
    rfd::FileDialog::new()
        .pick_folder()
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
async fn scan_directories(
    request: ScanRequest,
    operations: State<'_, Arc<OperationRegistry>>,
) -> Result<ScanPlan, NativeError> {
    let operation_id = request.operation_id.clone();
    let token = operations.begin(&operation_id);
    let spawned = tauri::async_runtime::spawn_blocking(move || scan_plan(&request, &token)).await;
    operations.finish(&operation_id);
    spawned.map_err(|error| NativeError::new(NativeErrorCode::Internal, error.to_string()))?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApplyCommand {
    request: ScanRequest,
    plan: ScanPlan,
    selected: Vec<String>,
    profile_id: Option<String>,
}

fn record_apply_result(
    database: &Database,
    result: &ApplyResult,
    profile_id: Option<&str>,
) -> Result<(), NativeError> {
    let created = result
        .directories
        .iter()
        .filter(|entry| entry.status == DirectoryStatus::Created)
        .count() as i64;
    let payload = serde_json::to_string(&result.directories)
        .map_err(|error| NativeError::new(NativeErrorCode::Internal, error.to_string()))?;
    let status = if result.cancelled {
        "cancelled"
    } else if result
        .directories
        .iter()
        .any(|entry| entry.status == DirectoryStatus::Failed)
    {
        "partial"
    } else {
        "completed"
    };
    database.record_run(
        &result.run_id,
        profile_id.unwrap_or(""),
        status,
        created,
        &payload,
    )
}

#[tauri::command]
async fn apply_directories(
    command: ApplyCommand,
    operations: State<'_, Arc<OperationRegistry>>,
    database: State<'_, Database>,
) -> Result<ApplyResult, NativeError> {
    let operation_id = command.request.operation_id.clone();
    let token = operations.begin(&operation_id);
    let spawned = tauri::async_runtime::spawn_blocking(move || {
        apply_plan(&command.request, &command.plan, &command.selected, &token)
            .map(|result| (result, command.profile_id))
    })
    .await;
    operations.finish(&operation_id);
    let result =
        spawned.map_err(|error| NativeError::new(NativeErrorCode::Internal, error.to_string()))?;
    let (result, profile_id) = result?;
    record_apply_result(&database, &result, profile_id.as_deref())?;
    Ok(result)
}

#[tauri::command]
fn cancel_operation(operation_id: String, operations: State<'_, Arc<OperationRegistry>>) {
    operations.cancel(&operation_id);
}

#[tauri::command]
fn list_profiles(database: State<'_, Database>) -> Result<Vec<Profile>, NativeError> {
    database.list_profiles()
}

#[tauri::command]
fn save_profile(profile: Profile, database: State<'_, Database>) -> Result<Profile, NativeError> {
    database.save_profile(&profile)?;
    Ok(profile)
}

#[tauri::command]
fn delete_profile(id: String, database: State<'_, Database>) -> Result<(), NativeError> {
    database.delete_profile(&id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let directory = app.path().app_data_dir()?;
            fs::create_dir_all(&directory)?;
            let database = Database::open(directory.join("rootline.sqlite3"))
                .map_err(|error| Box::<dyn std::error::Error>::from(error.to_string()))?;
            database
                .device_id()
                .map_err(|error| Box::<dyn std::error::Error>::from(error.to_string()))?;
            app.manage(database);
            app.manage(Arc::new(OperationRegistry::default()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            choose_folder,
            scan_directories,
            apply_directories,
            cancel_operation,
            list_profiles,
            save_profile,
            delete_profile,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Rootline");
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn mkdir_reports_already_existing_directories() {
        let target = tempdir().unwrap();
        let existing = target.path().join("existing");
        fs::create_dir(&existing).unwrap();
        let result = create_directory_result("existing".into(), &existing);
        assert_eq!(result.status, DirectoryStatus::AlreadyExists);
        assert!(result.error.is_none());
    }

    #[test]
    fn cancelled_apply_results_are_recorded_as_cancelled_history() {
        let directory = tempdir().unwrap();
        let database = Database::open(directory.path().join("history.sqlite3")).unwrap();
        let result = ApplyResult {
            run_id: "cancelled-run".into(),
            started_at: "x".into(),
            finished_at: "y".into(),
            directories: vec![DirectoryResult {
                relative_path: "docs".into(),
                status: DirectoryStatus::Created,
                error: None,
            }],
            cancelled: true,
        };
        record_apply_result(&database, &result, Some("profile-1")).unwrap();
        let history = database.run_history().unwrap();
        assert_eq!(history[0].status, "cancelled");
        assert_eq!(history[0].created_count, 1);
    }
}

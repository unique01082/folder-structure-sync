use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use keyring::Entry;
use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Manager, State};
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
    AuthRequired,
    AuthCallbackInvalid,
    ResetRequired,
    SyncAccountClaimRequired,
    SyncStateChanged,
    ValidationFailed,
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

fn internal_error(error: impl std::fmt::Display) -> NativeError {
    NativeError::new(NativeErrorCode::Internal, error.to_string())
}

pub fn random_vault_password() -> String {
    let mut key = [0_u8; 32];
    rand::rng().fill_bytes(&mut key);
    key.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn resolve_existing_vault_password(
    stored: Result<String, keyring::Error>,
    snapshot_exists: bool,
) -> Result<Option<String>, NativeError> {
    match stored {
        Ok(password)
            if password.len() == 64 && password.bytes().all(|byte| byte.is_ascii_hexdigit()) =>
        {
            Ok(Some(password))
        }
        Ok(_) => Err(NativeError::new(
            NativeErrorCode::Internal,
            "The OS credential vault contains an invalid Rootline key.",
        )),
        Err(keyring::Error::NoEntry) if snapshot_exists => Err(NativeError::new(
            NativeErrorCode::Internal,
            "The Stronghold vault exists but its OS-protected key is missing.",
        )),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(internal_error(error)),
    }
}

#[tauri::command]
fn auth_vault_password(app: AppHandle) -> Result<String, NativeError> {
    let directory = app.path().app_data_dir().map_err(internal_error)?;
    let snapshot = directory.join("rootline-auth.stronghold");
    let credential =
        Entry::new("space.baole.rootline", "stronghold-vault-key").map_err(internal_error)?;
    match resolve_existing_vault_password(credential.get_password(), snapshot.exists())? {
        Some(password) => Ok(password),
        None => {
            let password = random_vault_password();
            credential.set_password(&password).map_err(internal_error)?;
            Ok(password)
        }
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DiffStatus {
    Missing,
    Exists,
    Excluded,
    Unreadable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffEntry {
    pub relative_path: String,
    pub status: DiffStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileRootAvailability {
    pub source_available: bool,
    pub target_available: bool,
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
    pub diff_entries: Vec<DiffEntry>,
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
    excluded: Vec<String>,
    unreadable: Vec<String>,
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
    assert_no_link_ancestors(path)?;
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

fn assert_no_link_ancestors(path: &Path) -> Result<(), NativeError> {
    let absolute = absolute(path)?;
    let mut current = PathBuf::new();
    for component in absolute.components() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata)
                if is_link_or_junction(&metadata) && !is_allowed_platform_root_alias(&current) =>
            {
                return Err(NativeError {
                    code: NativeErrorCode::InvalidPath,
                    message:
                        "A synchronization root must not traverse a symbolic link or junction."
                            .into(),
                    details: Some(json!({ "path": absolute, "linkedAncestor": current })),
                });
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => {
                return Err(NativeError::at(
                    NativeErrorCode::UnreadablePath,
                    error.to_string(),
                    &current,
                ));
            }
        }
    }
    Ok(())
}

fn profile_root_available(path: &Path) -> Result<bool, NativeError> {
    let absolute = absolute(path)?;
    if assert_no_link_ancestors(&absolute).is_err() {
        return Ok(false);
    }
    match fs::symlink_metadata(&absolute) {
        Ok(metadata) => Ok(metadata.is_dir() && !is_link_or_junction(&metadata)),
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound
                || error.kind() == std::io::ErrorKind::PermissionDenied =>
        {
            Ok(false)
        }
        Err(error) => Err(NativeError::at(
            NativeErrorCode::UnreadablePath,
            error.to_string(),
            &absolute,
        )),
    }
}

pub fn inspect_profile_roots(
    source_path: &Path,
    target_path: &Path,
) -> Result<ProfileRootAvailability, NativeError> {
    Ok(ProfileRootAvailability {
        source_available: profile_root_available(source_path)?,
        target_available: profile_root_available(target_path)?,
    })
}

#[cfg(target_os = "macos")]
fn is_allowed_platform_root_alias(path: &Path) -> bool {
    let expected = if path == Path::new("/var") {
        Some(Path::new("/private/var"))
    } else if path == Path::new("/tmp") {
        Some(Path::new("/private/tmp"))
    } else if path == Path::new("/etc") {
        Some(Path::new("/private/etc"))
    } else {
        None
    };
    expected.is_some_and(|expected| fs::canonicalize(path).is_ok_and(|actual| actual == expected))
}

#[cfg(not(target_os = "macos"))]
fn is_allowed_platform_root_alias(_path: &Path) -> bool {
    false
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

fn nearest_existing_ancestor(path: &Path) -> Result<PathBuf, NativeError> {
    let mut current = absolute(path)?;
    loop {
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.is_dir() => return Ok(current),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(NativeError::at(
                    NativeErrorCode::UnreadablePath,
                    error.to_string(),
                    &current,
                ));
            }
        }
        if !current.pop() {
            return Err(NativeError::at(
                NativeErrorCode::InvalidPath,
                "The path has no existing directory ancestor.",
                path,
            ));
        }
    }
}

#[cfg(target_os = "macos")]
fn case_sensitive_from_os(directory: &Path) -> Result<bool, NativeError> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};

    #[repr(C)]
    struct VolumeCapabilitiesBuffer {
        length: u32,
        capabilities: [u32; 4],
        valid: [u32; 4],
    }

    let path = CString::new(directory.as_os_str().as_bytes()).map_err(|_| {
        NativeError::at(
            NativeErrorCode::InvalidPath,
            "The target path contains a null byte.",
            directory,
        )
    })?;
    let mut attributes = libc::attrlist {
        bitmapcount: libc::ATTR_BIT_MAP_COUNT,
        reserved: 0,
        commonattr: 0,
        volattr: libc::ATTR_VOL_CAPABILITIES,
        dirattr: 0,
        fileattr: 0,
        forkattr: 0,
    };
    let mut buffer = VolumeCapabilitiesBuffer {
        length: 0,
        capabilities: [0; 4],
        valid: [0; 4],
    };
    // SAFETY: `path`, `attributes`, and `buffer` remain valid for this synchronous
    // call, and the buffer exactly matches the requested fixed-size volume attribute.
    let result = unsafe {
        libc::getattrlist(
            path.as_ptr(),
            (&mut attributes as *mut libc::attrlist).cast(),
            (&mut buffer as *mut VolumeCapabilitiesBuffer).cast(),
            std::mem::size_of::<VolumeCapabilitiesBuffer>(),
            0,
        )
    };
    if result != 0 {
        return Err(NativeError::at(
            NativeErrorCode::UnreadablePath,
            std::io::Error::last_os_error().to_string(),
            directory,
        ));
    }
    let capability = libc::VOL_CAP_FMT_CASE_SENSITIVE;
    Ok(buffer.valid[0] & capability != 0 && buffer.capabilities[0] & capability != 0)
}

#[cfg(windows)]
fn case_sensitive_from_os(directory: &Path) -> Result<bool, NativeError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        Storage::FileSystem::{
            CreateFileW, FileCaseSensitiveInfo, GetFileInformationByHandleEx,
            FILE_CASE_SENSITIVE_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES,
            FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
        },
    };

    let wide = directory
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: the UTF-16 path is null-terminated and all other arguments are constants/null.
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(NativeError::at(
            NativeErrorCode::UnreadablePath,
            std::io::Error::last_os_error().to_string(),
            directory,
        ));
    }
    let mut information = FILE_CASE_SENSITIVE_INFO::default();
    // SAFETY: `handle` is live and `information` is the exact structure requested.
    let result = unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileCaseSensitiveInfo,
            (&mut information as *mut FILE_CASE_SENSITIVE_INFO).cast(),
            std::mem::size_of::<FILE_CASE_SENSITIVE_INFO>() as u32,
        )
    };
    // SAFETY: the handle came from CreateFileW and is closed exactly once here.
    unsafe { CloseHandle(handle) };
    if result == 0 {
        return Err(NativeError::at(
            NativeErrorCode::UnreadablePath,
            std::io::Error::last_os_error().to_string(),
            directory,
        ));
    }
    Ok(information.Flags & 1 != 0)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn case_sensitive_from_os(_directory: &Path) -> Result<bool, NativeError> {
    Ok(true)
}

pub fn detect_case_sensitive(directory: &Path) -> Result<bool, NativeError> {
    case_sensitive_from_os(&nearest_existing_ancestor(directory)?)
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
    fn visit(
        value: &[char],
        pattern: &[char],
        value_index: usize,
        pattern_index: usize,
        memo: &mut HashMap<(usize, usize), bool>,
    ) -> bool {
        if let Some(result) = memo.get(&(value_index, pattern_index)) {
            return *result;
        }
        let result = if pattern_index == pattern.len() {
            value_index == value.len()
        } else if pattern[pattern_index] == '*' && pattern.get(pattern_index + 1) == Some(&'*') {
            let after_globstar = pattern_index + 2;
            let skips_empty_segment = pattern.get(after_globstar) == Some(&'/')
                && visit(value, pattern, value_index, after_globstar + 1, memo);
            skips_empty_segment
                || visit(value, pattern, value_index, after_globstar, memo)
                || (value_index < value.len()
                    && visit(value, pattern, value_index + 1, pattern_index, memo))
        } else if pattern[pattern_index] == '*' {
            visit(value, pattern, value_index, pattern_index + 1, memo)
                || (value_index < value.len()
                    && value[value_index] != '/'
                    && visit(value, pattern, value_index + 1, pattern_index, memo))
        } else if pattern[pattern_index] == '?' {
            value_index < value.len()
                && value[value_index] != '/'
                && visit(value, pattern, value_index + 1, pattern_index + 1, memo)
        } else {
            value_index < value.len()
                && value[value_index] == pattern[pattern_index]
                && visit(value, pattern, value_index + 1, pattern_index + 1, memo)
        };
        memo.insert((value_index, pattern_index), result);
        result
    }
    visit(&value, &pattern, 0, 0, &mut HashMap::new())
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
    let mut excluded_entries = Vec::new();
    let mut unreadable = Vec::new();
    let mut pending = vec![(root.to_path_buf(), String::new())];
    while let Some((current, current_relative)) = pending.pop() {
        token.check()?;
        if current.join(".ignore").exists() {
            continue;
        }
        let mut children = match fs::read_dir(&current)
            .and_then(|entries| entries.collect::<Result<Vec<_>, _>>())
        {
            Ok(children) => children,
            Err(_error) if !current_relative.is_empty() => {
                unreadable.push(current_relative);
                continue;
            }
            Err(error) => {
                return Err(NativeError::at(
                    NativeErrorCode::UnreadablePath,
                    error.to_string(),
                    &current,
                ));
            }
        };
        children.sort_by_key(|entry| entry.file_name());
        for child in children.into_iter().rev() {
            token.check()?;
            let path = child.path();
            let relative =
                normalize_relative(path.strip_prefix(root).expect("entry is below root"));
            if excluded(&relative, exclusions) {
                excluded_entries.push(relative);
                continue;
            }
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(_) => {
                    unreadable.push(relative);
                    continue;
                }
            };
            if is_link_or_junction(&metadata) {
                skipped_links.push(relative);
            } else if metadata.is_dir() {
                entries.push(relative.clone());
                pending.push((path, relative));
            }
        }
    }
    entries.sort();
    skipped_links.sort();
    excluded_entries.sort();
    unreadable.sort();
    let mut fingerprint_values = entries.clone();
    fingerprint_values.extend(
        excluded_entries
            .iter()
            .map(|path| format!("excluded:{path}")),
    );
    fingerprint_values.extend(unreadable.iter().map(|path| format!("unreadable:{path}")));
    fingerprint_values.extend(skipped_links.iter().map(|path| format!("linked:{path}")));
    let fingerprint = fingerprint(&fingerprint_values);
    Ok(Snapshot {
        entries,
        fingerprint,
        skipped_links,
        excluded: excluded_entries,
        unreadable,
    })
}

fn contains_path_or_ancestor(paths: &HashSet<String>, relative: &str) -> bool {
    let mut current = relative;
    loop {
        if paths.contains(current) {
            return true;
        }
        let Some(separator) = current.rfind('/') else {
            return false;
        };
        current = &current[..separator];
    }
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
    let source_unreadable: HashSet<_> = source_snapshot.unreadable.iter().cloned().collect();
    let target_unreadable: HashSet<_> = target_snapshot
        .unreadable
        .iter()
        .map(|entry| comparable(entry))
        .collect();
    let mut statuses = HashMap::new();
    for entry in &source_snapshot.entries {
        let comparable_entry = comparable(entry);
        let status = if contains_path_or_ancestor(&source_unreadable, entry)
            || contains_path_or_ancestor(&target_unreadable, &comparable_entry)
        {
            DiffStatus::Unreadable
        } else if target_entries.contains(&comparable_entry) {
            DiffStatus::Exists
        } else {
            DiffStatus::Missing
        };
        statuses.insert(entry.clone(), status);
    }
    for entry in &source_snapshot.excluded {
        statuses.insert(entry.clone(), DiffStatus::Excluded);
    }
    for entry in &source_snapshot.unreadable {
        statuses.insert(entry.clone(), DiffStatus::Unreadable);
    }
    let mut diff_entries: Vec<_> = statuses
        .into_iter()
        .map(|(relative_path, status)| DiffEntry {
            relative_path,
            status,
        })
        .collect();
    diff_entries.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    let missing: Vec<_> = diff_entries
        .iter()
        .filter(|entry| entry.status == DiffStatus::Missing)
        .map(|entry| entry.relative_path.clone())
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
    plan_values.extend(
        diff_entries
            .iter()
            .map(|entry| format!("{:?}:{}", entry.status, entry.relative_path)),
    );
    Ok(ScanPlan {
        operation_id: request.operation_id.clone(),
        source_root: source,
        target_root: target,
        source_fingerprint: source_snapshot.fingerprint,
        target_fingerprint: target_snapshot.fingerprint,
        target_case_sensitive,
        plan_fingerprint: fingerprint(&plan_values),
        missing,
        diff_entries,
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
    apply_plan_with_observer(request, plan, selected, token, |_| {})
}

fn apply_plan_with_observer(
    request: &ScanRequest,
    plan: &ScanPlan,
    selected: &[String],
    token: &CancellationToken,
    mut after_directory: impl FnMut(&DirectoryResult),
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
        || current.diff_entries != plan.diff_entries
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
        let entry = create_directory_result(relative, &destination);
        after_directory(&entry);
        directories.push(entry);
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

#[derive(Debug, Deserialize)]
struct CharacterLimits {
    min: usize,
    max: usize,
}

#[derive(Debug, Deserialize)]
struct ExclusionLimits {
    max: usize,
    pattern: CharacterLimits,
}

#[derive(Debug, Deserialize)]
struct ProfileLimits {
    #[serde(rename = "lengthUnit")]
    length_unit: String,
    name: CharacterLimits,
    path: CharacterLimits,
    exclusions: ExclusionLimits,
}

fn profile_limits() -> &'static ProfileLimits {
    static LIMITS: OnceLock<ProfileLimits> = OnceLock::new();
    LIMITS.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../../packages/contracts/src/profile-limits.json"
        ))
        .expect("shared profile limits must be valid JSON")
    })
}

fn profile_validation_error(field: &str, min: Option<usize>, max: usize) -> NativeError {
    NativeError {
        code: NativeErrorCode::ValidationFailed,
        message: "The profile exceeds Rootline's hosted profile limits.".into(),
        details: Some(json!({ "field": field, "min": min, "max": max })),
    }
}

fn validate_profile(profile: &Profile) -> Result<(), NativeError> {
    let id_length = profile.id.chars().count();
    if !(1..=128).contains(&id_length) {
        return Err(profile_validation_error("id", Some(1), 128));
    }
    let limits = profile_limits();
    assert_eq!(limits.length_unit, "unicode-code-points");
    for (field, value, limit) in [
        ("name", profile.name.as_str(), &limits.name),
        ("sourcePath", profile.source_path.as_str(), &limits.path),
        ("targetPath", profile.target_path.as_str(), &limits.path),
    ] {
        let length = value.chars().count();
        if length < limit.min || length > limit.max {
            return Err(profile_validation_error(field, Some(limit.min), limit.max));
        }
    }
    if profile.exclusions.len() > limits.exclusions.max {
        return Err(profile_validation_error(
            "exclusions",
            None,
            limits.exclusions.max,
        ));
    }
    for (index, pattern) in profile.exclusions.iter().enumerate() {
        let length = pattern.chars().count();
        let limit = &limits.exclusions.pattern;
        if length < limit.min || length > limit.max {
            return Err(profile_validation_error(
                &format!("exclusions[{index}]"),
                Some(limit.min),
                limit.max,
            ));
        }
    }
    Ok(())
}

fn outbox_validation_error(
    mutation_id: &str,
    kind: &str,
    payload: &str,
    occurred_at: &str,
) -> Option<String> {
    if Uuid::parse_str(mutation_id).is_err() {
        return Some("mutationId is not a UUID".into());
    }
    if OffsetDateTime::parse(occurred_at, &Rfc3339).is_err() {
        return Some("occurredAt is not an RFC 3339 timestamp".into());
    }
    match kind {
        "upsert" => {
            let profile: Profile = match serde_json::from_str(payload) {
                Ok(profile) => profile,
                Err(_) => return Some("profile payload is invalid JSON".into()),
            };
            if OffsetDateTime::parse(&profile.created_at, &Rfc3339).is_err()
                || OffsetDateTime::parse(&profile.updated_at, &Rfc3339).is_err()
            {
                return Some("profile timestamps are invalid".into());
            }
            validate_profile(&profile).err().map(|error| {
                let field = error
                    .details
                    .as_ref()
                    .and_then(|details| details.get("field"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("profile");
                format!("profile {field} exceeds the hosted limit")
            })
        }
        "delete" => {
            let profile_id = serde_json::from_str::<serde_json::Value>(payload)
                .ok()
                .and_then(|value| {
                    value
                        .get("profileId")
                        .and_then(serde_json::Value::as_str)
                        .map(ToOwned::to_owned)
                });
            match profile_id {
                Some(profile_id) if (1..=128).contains(&profile_id.chars().count()) => None,
                _ => Some("delete profileId is invalid".into()),
            }
        }
        _ => Some("mutation kind is invalid".into()),
    }
}

fn quarantine_invalid_outbox(connection: &mut Connection) -> Result<usize, NativeError> {
    let owner = connection
        .query_row(
            "SELECT subject FROM sync_state WHERE singleton=1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .unwrap_or_default();
    let candidates = {
        let mut statement = connection.prepare(
            "SELECT sequence, mutation_id, kind, payload, occurred_at, profile_id,
                    preserve_on_epoch_adopt
             FROM mutation_outbox ORDER BY sequence ASC",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, i64>(6)?,
            ))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    let transaction = connection.transaction()?;
    let mut quarantined = 0;
    for (sequence, mutation_id, kind, payload, occurred_at, profile_id, preserve) in candidates {
        let Some(reason) = outbox_validation_error(&mutation_id, &kind, &payload, &occurred_at)
        else {
            continue;
        };
        transaction.execute(
            "INSERT INTO mutation_quarantine(
               mutation_id, kind, profile_id, reason, provenance, subject
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(mutation_id) DO UPDATE SET kind=excluded.kind,
               profile_id=excluded.profile_id, reason=excluded.reason,
               provenance=excluded.provenance, subject=excluded.subject,
               quarantined_at=CURRENT_TIMESTAMP",
            params![
                mutation_id,
                kind,
                profile_id,
                reason,
                if owner.is_empty() {
                    "pre-login"
                } else {
                    "account-bound"
                },
                owner
            ],
        )?;
        if !profile_id.is_empty() && owner.is_empty() {
            transaction.execute(
                "INSERT INTO profile_sync_policy(profile_id, policy, subject)
                 VALUES (?1, 'unclaimed', '')
                 ON CONFLICT(profile_id) DO NOTHING",
                [&profile_id],
            )?;
        } else if !profile_id.is_empty() && preserve == 1 {
            transaction.execute(
                "INSERT INTO profile_sync_policy(profile_id, policy, subject)
                 VALUES (?1, 'consented', ?2)
                 ON CONFLICT(profile_id) DO UPDATE SET policy='consented', subject=excluded.subject",
                params![profile_id, owner],
            )?;
        }
        transaction.execute(
            "DELETE FROM mutation_outbox WHERE sequence = ?1",
            [sequence],
        )?;
        quarantined += 1;
    }
    if quarantined > 0 {
        transaction.execute(
            "UPDATE sync_state SET session_generation=session_generation + 1 WHERE singleton=1",
            [],
        )?;
    }
    transaction.commit()?;
    Ok(quarantined)
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
pub struct QuarantinedMutation {
    pub mutation_id: String,
    pub profile_id: String,
    pub reason: String,
    pub provenance: String,
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

const MIGRATIONS: &[(i64, &str)] = &[
    (1, include_str!("../migrations/0001_offline_state.sql")),
    (
        2,
        include_str!("../migrations/0002_account_scoped_sync.sql"),
    ),
    (
        3,
        include_str!("../migrations/0003_sync_session_generation.sql"),
    ),
    (
        4,
        include_str!("../migrations/0004_consented_epoch_adoption.sql"),
    ),
    (
        5,
        include_str!("../migrations/0005_sync_lifecycle_generation.sql"),
    ),
    (
        6,
        include_str!("../migrations/0006_invalid_outbox_quarantine.sql"),
    ),
    (
        7,
        include_str!("../migrations/0007_profile_sync_provenance.sql"),
    ),
];
const HOSTED_SYNC_MUTATION_LIMIT: usize = 100;
const HOSTED_SYNC_BODY_LIMIT: usize = 256 * 1024;

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
        quarantine_invalid_outbox(&mut connection)?;
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
        validate_profile(profile)?;
        let payload = serde_json::to_string(profile)
            .map_err(|error| NativeError::new(NativeErrorCode::Internal, error.to_string()))?;
        let mut connection = self.connection();
        let transaction = connection.transaction()?;
        let owner = transaction
            .query_row(
                "SELECT subject FROM sync_state WHERE singleton=1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .unwrap_or_default();
        if owner.is_empty() {
            transaction.execute(
                "INSERT INTO profile_sync_policy(profile_id, policy, subject)
                 VALUES (?1, 'unclaimed', '')
                 ON CONFLICT(profile_id) DO UPDATE SET policy='unclaimed', subject=''",
                [&profile.id],
            )?;
        }
        let policy = transaction
            .query_row(
                "SELECT policy, subject FROM profile_sync_policy WHERE profile_id=?1",
                [&profile.id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        let policy_matches_owner = policy
            .as_ref()
            .is_some_and(|(_, subject)| subject == &owner);
        let local_only = policy_matches_owner
            && policy
                .as_ref()
                .is_some_and(|(policy, _)| policy == "local-only");
        let policy_owner_mismatch = !owner.is_empty()
            && policy
                .as_ref()
                .is_some_and(|(_, subject)| subject != &owner);
        let preserve = policy_matches_owner
            && policy
                .as_ref()
                .is_some_and(|(policy, _)| policy == "consented")
            || transaction.query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM mutation_outbox
                   WHERE profile_id=?1 AND preserve_on_epoch_adopt=1
                 )",
                [&profile.id],
                |row| row.get::<_, i64>(0),
            )? == 1;
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
            "DELETE FROM mutation_quarantine WHERE profile_id = ?1",
            [&profile.id],
        )?;
        if local_only || policy_owner_mismatch {
            transaction.execute(
                "DELETE FROM mutation_outbox WHERE profile_id=?1",
                [&profile.id],
            )?;
        } else {
            transaction.execute(
                "INSERT INTO mutation_outbox(
                   mutation_id, kind, payload, occurred_at, profile_id, preserve_on_epoch_adopt
                 ) VALUES (?1, 'upsert', ?2, ?3, ?4, ?5)",
                params![
                    Uuid::new_v4().to_string(),
                    payload,
                    profile.updated_at,
                    profile.id,
                    i64::from(preserve)
                ],
            )?;
        }
        transaction.execute(
            "UPDATE sync_state SET session_generation=session_generation + 1 WHERE singleton=1",
            [],
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
        let owner = transaction
            .query_row(
                "SELECT subject FROM sync_state WHERE singleton=1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .unwrap_or_default();
        let policy = transaction
            .query_row(
                "SELECT policy, subject FROM profile_sync_policy WHERE profile_id=?1",
                [id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        let local_only = policy
            .as_ref()
            .is_some_and(|(policy, subject)| policy == "local-only" && subject == &owner);
        let preserve = policy
            .as_ref()
            .is_some_and(|(policy, subject)| policy == "consented" && subject == &owner)
            || transaction.query_row(
                "SELECT EXISTS(
               SELECT 1 FROM mutation_outbox
               WHERE profile_id=?1 AND preserve_on_epoch_adopt=1
             )",
                [id],
                |row| row.get::<_, i64>(0),
            )? == 1;
        transaction.execute("DELETE FROM profiles WHERE id = ?1", [id])?;
        transaction.execute(
            "DELETE FROM mutation_quarantine WHERE profile_id = ?1",
            [id],
        )?;
        if local_only {
            transaction.execute("DELETE FROM mutation_outbox WHERE profile_id=?1", [id])?;
            transaction.execute("DELETE FROM profile_sync_policy WHERE profile_id=?1", [id])?;
        } else {
            transaction.execute(
                "INSERT INTO mutation_outbox(
                   mutation_id, kind, payload, occurred_at, profile_id, preserve_on_epoch_adopt
                 ) VALUES (?1, 'delete', ?2, ?3, ?4, ?5)",
                params![
                    Uuid::new_v4().to_string(),
                    json!({ "profileId": id }).to_string(),
                    timestamp(),
                    id,
                    i64::from(preserve)
                ],
            )?;
        }
        transaction.execute(
            "UPDATE sync_state SET session_generation=session_generation + 1 WHERE singleton=1",
            [],
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
        let parsed: serde_json::Value = serde_json::from_str(payload).map_err(internal_error)?;
        let profile_id = parsed
            .get(if kind == "upsert" { "id" } else { "profileId" })
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                NativeError::new(
                    NativeErrorCode::Internal,
                    "A local outbox mutation is invalid.",
                )
            })?;
        self.connection().execute(
            "INSERT OR IGNORE INTO mutation_outbox(
               mutation_id, kind, payload, occurred_at, profile_id
             ) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, kind, payload, occurred_at, profile_id],
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

    pub fn quarantined_mutations(&self) -> Result<Vec<QuarantinedMutation>, NativeError> {
        let connection = self.connection();
        let mut statement = connection.prepare(
            "SELECT mutation_id, profile_id, reason, provenance
             FROM mutation_quarantine ORDER BY sequence ASC",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(QuarantinedMutation {
                mutation_id: row.get(0)?,
                profile_id: row.get(1)?,
                reason: row.get(2)?,
                provenance: row.get(3)?,
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
        let lifecycle_generation = Uuid::new_v4().to_string();
        self.connection().execute(
            "INSERT INTO sync_state(singleton, epoch, cursor, subject, lifecycle_generation)
             VALUES (1, ?1, ?2, '', ?3)
             ON CONFLICT(singleton) DO UPDATE SET epoch=excluded.epoch, cursor=excluded.cursor,
             lifecycle_generation=excluded.lifecycle_generation",
            params![epoch, cursor, lifecycle_generation],
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

    fn sync_binding(&self) -> Result<Option<(String, String, String, i64)>, NativeError> {
        Ok(self
            .connection()
            .query_row(
                "SELECT subject, epoch, cursor, session_generation FROM sync_state WHERE singleton = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?)
    }

    pub fn clear_local_synced_data(&self) -> Result<(), NativeError> {
        let mut connection = self.connection();
        let transaction = connection.transaction()?;
        transaction.execute("DELETE FROM profiles", [])?;
        transaction.execute("DELETE FROM mutation_outbox", [])?;
        transaction.execute("DELETE FROM mutation_quarantine", [])?;
        transaction.execute("DELETE FROM profile_sync_policy", [])?;
        transaction.execute("DELETE FROM sync_state", [])?;
        transaction.commit()?;
        Ok(())
    }

    pub fn disconnect_hosted_account(
        &self,
        remove_local_profiles: bool,
    ) -> Result<(), NativeError> {
        let mut connection = self.connection();
        let transaction = connection.transaction()?;
        let lifecycle_generation = Uuid::new_v4().to_string();
        transaction.execute("DELETE FROM mutation_outbox", [])?;
        transaction.execute("DELETE FROM profile_sync_policy", [])?;
        if !remove_local_profiles {
            transaction.execute(
                "INSERT INTO profile_sync_policy(profile_id, policy, subject)
                 SELECT id, 'unclaimed', '' FROM profiles",
                [],
            )?;
            transaction.execute(
                "UPDATE mutation_quarantine SET provenance='pre-login', subject=''",
                [],
            )?;
        }
        transaction.execute(
            "INSERT INTO sync_state(singleton, subject, epoch, cursor, session_generation,
             preserve_outbox_on_epoch_adopt, lifecycle_generation)
             VALUES (1, '', '', '', 1, 0, ?1)
             ON CONFLICT(singleton) DO UPDATE SET subject='', epoch='', cursor='',
             session_generation=sync_state.session_generation + 1, preserve_outbox_on_epoch_adopt=0,
             lifecycle_generation=excluded.lifecycle_generation",
            [lifecycle_generation],
        )?;
        if remove_local_profiles {
            transaction.execute("DELETE FROM profiles", [])?;
            transaction.execute("DELETE FROM mutation_quarantine", [])?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn claim_hosted_account(
        &self,
        subject: &str,
        upload_existing: bool,
    ) -> Result<(), NativeError> {
        if subject.is_empty() {
            return Err(NativeError::new(
                NativeErrorCode::AuthRequired,
                "An account subject is required.",
            ));
        }
        let mut connection = self.connection();
        let transaction = connection.transaction()?;
        let owner: Option<String> = transaction
            .query_row(
                "SELECT subject FROM sync_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if owner
            .as_deref()
            .is_some_and(|value| !value.is_empty() && value != subject)
        {
            return Err(NativeError::new(
                NativeErrorCode::AuthRequired,
                "Local hosted-sync state belongs to another account.",
            ));
        }
        let same_owner = owner.as_deref() == Some(subject);
        let unresolved_claim: i64 = transaction.query_row(
            "SELECT EXISTS(
               SELECT 1 FROM profile_sync_policy WHERE policy='unclaimed'
               UNION ALL
               SELECT 1
               FROM mutation_quarantine quarantine
               LEFT JOIN profile_sync_policy policy ON policy.profile_id=quarantine.profile_id
               WHERE quarantine.provenance='pre-login'
                 AND (policy.profile_id IS NULL OR policy.policy='unclaimed')
             )",
            [],
            |row| row.get(0),
        )?;
        if same_owner && !upload_existing && unresolved_claim == 0 {
            transaction.commit()?;
            return Ok(());
        }
        if !upload_existing {
            if same_owner {
                transaction.execute(
                    "INSERT OR IGNORE INTO profile_sync_policy(profile_id, policy, subject)
                     SELECT profile_id, 'unclaimed', '' FROM mutation_quarantine
                     WHERE provenance='pre-login' AND profile_id<>''",
                    [],
                )?;
                transaction.execute(
                    "UPDATE profile_sync_policy SET policy='local-only', subject=?1
                     WHERE policy='unclaimed'",
                    [subject],
                )?;
                transaction.execute(
                    "DELETE FROM mutation_outbox
                     WHERE profile_id IN (
                       SELECT profile_id FROM profile_sync_policy
                       WHERE policy='local-only' AND subject=?1
                     )",
                    [subject],
                )?;
            } else {
                transaction.execute(
                    "INSERT OR REPLACE INTO profile_sync_policy(profile_id, policy, subject)
                     SELECT id, 'local-only', ?1 FROM profiles",
                    [subject],
                )?;
                transaction.execute(
                    "INSERT OR REPLACE INTO profile_sync_policy(profile_id, policy, subject)
                     SELECT profile_id, 'local-only', ?1 FROM mutation_outbox
                     WHERE profile_id<>''",
                    [subject],
                )?;
                transaction.execute(
                    "INSERT OR REPLACE INTO profile_sync_policy(profile_id, policy, subject)
                     SELECT profile_id, 'local-only', ?1 FROM mutation_quarantine
                     WHERE profile_id<>''",
                    [subject],
                )?;
                transaction.execute(
                    "UPDATE profile_sync_policy SET policy='local-only', subject=?1
                     WHERE policy='unclaimed'",
                    [subject],
                )?;
                transaction.execute("DELETE FROM mutation_outbox", [])?;
            }
            transaction.execute(
                "UPDATE mutation_quarantine SET subject=?1
                 WHERE provenance='pre-login' AND profile_id IN (
                   SELECT profile_id FROM profile_sync_policy
                   WHERE policy='local-only' AND subject=?1
                 )",
                [subject],
            )?;
        } else {
            if same_owner {
                transaction.execute(
                    "INSERT OR IGNORE INTO profile_sync_policy(profile_id, policy, subject)
                     SELECT profile_id, 'unclaimed', '' FROM mutation_quarantine
                     WHERE provenance='pre-login' AND profile_id<>''",
                    [],
                )?;
                transaction.execute(
                    "UPDATE profile_sync_policy SET policy='consented', subject=?1
                     WHERE policy='unclaimed' OR (policy='local-only' AND subject=?1)",
                    [subject],
                )?;
                transaction.execute(
                    "UPDATE mutation_outbox SET preserve_on_epoch_adopt=1
                     WHERE profile_id IN (
                       SELECT profile_id FROM profile_sync_policy
                       WHERE policy='consented' AND subject=?1
                     )",
                    [subject],
                )?;
            } else {
                transaction.execute("UPDATE mutation_outbox SET preserve_on_epoch_adopt=1", [])?;
                transaction.execute(
                    "INSERT OR REPLACE INTO profile_sync_policy(profile_id, policy, subject)
                     SELECT id, 'consented', ?1 FROM profiles",
                    [subject],
                )?;
                transaction.execute(
                    "INSERT OR REPLACE INTO profile_sync_policy(profile_id, policy, subject)
                     SELECT profile_id, 'consented', ?1 FROM mutation_outbox
                     WHERE profile_id<>''",
                    [subject],
                )?;
                transaction.execute(
                    "INSERT OR REPLACE INTO profile_sync_policy(profile_id, policy, subject)
                     SELECT profile_id, 'consented', ?1 FROM mutation_quarantine
                     WHERE profile_id<>''",
                    [subject],
                )?;
                transaction.execute(
                    "UPDATE profile_sync_policy SET policy='consented', subject=?1
                     WHERE policy='unclaimed'",
                    [subject],
                )?;
            }
            let profiles_to_upload = {
                let mut statement = transaction.prepare(
                    "SELECT p.id, p.name, p.source_path, p.target_path, p.exclusions_json,
                            p.created_at, p.updated_at
                     FROM profiles p
                     JOIN profile_sync_policy policy ON policy.profile_id=p.id
                     WHERE policy.policy='consented' AND policy.subject=?1",
                )?;
                let rows = statement.query_map([subject], |row| {
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
                rows.collect::<Result<Vec<_>, _>>()?
            };
            for profile in profiles_to_upload {
                if validate_profile(&profile).is_err() {
                    continue;
                }
                let already_queued: i64 = transaction.query_row(
                    "SELECT EXISTS(SELECT 1 FROM mutation_outbox WHERE profile_id=?1)",
                    [&profile.id],
                    |row| row.get(0),
                )?;
                if already_queued == 0 {
                    transaction.execute(
                        "INSERT INTO mutation_outbox(
                           mutation_id, kind, payload, occurred_at, profile_id,
                           preserve_on_epoch_adopt
                         ) VALUES (?1, 'upsert', ?2, ?3, ?4, 1)",
                        params![
                            Uuid::new_v4().to_string(),
                            serde_json::to_string(&profile).map_err(internal_error)?,
                            profile.updated_at,
                            profile.id
                        ],
                    )?;
                }
            }
            transaction.execute(
                "UPDATE mutation_quarantine SET subject=?1
                 WHERE provenance='pre-login' AND profile_id IN (
                   SELECT profile_id FROM profile_sync_policy
                   WHERE policy='consented' AND subject=?1
                 )",
                [subject],
            )?;
        }
        if same_owner {
            let lifecycle_generation = Uuid::new_v4().to_string();
            transaction.execute(
                "UPDATE sync_state SET
                   session_generation=session_generation + 1,
                   preserve_outbox_on_epoch_adopt=CASE WHEN EXISTS(
                     SELECT 1 FROM mutation_outbox WHERE preserve_on_epoch_adopt=1
                     UNION ALL
                     SELECT 1 FROM profile_sync_policy
                     WHERE policy='consented' AND subject=?2
                   ) THEN 1 ELSE preserve_outbox_on_epoch_adopt END,
                   lifecycle_generation=?1
                 WHERE singleton=1 AND subject=?2",
                params![lifecycle_generation, subject],
            )?;
            transaction.commit()?;
            return Ok(());
        }
        let epoch = Uuid::new_v4().to_string();
        let lifecycle_generation = Uuid::new_v4().to_string();
        transaction.execute(
            "INSERT INTO sync_state(singleton, subject, epoch, cursor, session_generation,
             preserve_outbox_on_epoch_adopt, lifecycle_generation)
             VALUES (1, ?1, ?2, '', 1, ?3, ?4)
             ON CONFLICT(singleton) DO UPDATE SET subject=excluded.subject, epoch=excluded.epoch,
             cursor='', session_generation=sync_state.session_generation + 1,
             preserve_outbox_on_epoch_adopt=excluded.preserve_outbox_on_epoch_adopt,
             lifecycle_generation=excluded.lifecycle_generation",
            params![
                subject,
                epoch,
                i64::from(upload_existing),
                lifecycle_generation
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn accept_account_epoch(
        &self,
        subject: &str,
        epoch: &str,
        remove_local_profiles: bool,
    ) -> Result<(), NativeError> {
        let mut connection = self.connection();
        let transaction = connection.transaction()?;
        let preserve_consented_outbox = !remove_local_profiles
            && transaction
                .query_row(
                    "SELECT EXISTS(
                    SELECT 1 FROM mutation_outbox WHERE preserve_on_epoch_adopt=1
                    UNION ALL
                    SELECT 1 FROM profile_sync_policy
                    WHERE policy='consented' AND subject=?1
                 ) FROM sync_state
                 WHERE singleton=1 AND subject=?1",
                    [subject],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                == Some(1);
        if preserve_consented_outbox {
            transaction.execute(
                "DELETE FROM mutation_outbox WHERE preserve_on_epoch_adopt=0",
                [],
            )?;
        } else {
            transaction.execute("DELETE FROM mutation_outbox", [])?;
        }
        if remove_local_profiles {
            transaction.execute("DELETE FROM profiles", [])?;
            transaction.execute("DELETE FROM mutation_quarantine", [])?;
            transaction.execute("DELETE FROM profile_sync_policy", [])?;
        }
        let lifecycle_generation = Uuid::new_v4().to_string();
        transaction.execute(
            "INSERT INTO sync_state(singleton, subject, epoch, cursor, session_generation,
             preserve_outbox_on_epoch_adopt, lifecycle_generation)
             VALUES (1, ?1, ?2, '', 1, 0, ?4)
             ON CONFLICT(singleton) DO UPDATE SET subject=excluded.subject, epoch=excluded.epoch,
             cursor='', session_generation=sync_state.session_generation + 1,
             preserve_outbox_on_epoch_adopt=CASE WHEN ?3 THEN 1 ELSE 0 END,
             lifecycle_generation=excluded.lifecycle_generation",
            params![
                subject,
                epoch,
                preserve_consented_outbox,
                lifecycle_generation
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn preserves_consented_outbox(&self, subject: &str) -> Result<bool, NativeError> {
        Ok(self
            .connection()
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM mutation_outbox WHERE preserve_on_epoch_adopt=1
                    UNION ALL
                    SELECT 1 FROM profile_sync_policy
                    WHERE policy='consented' AND subject=?1
                 ) FROM sync_state
                 WHERE singleton=1 AND subject=?1",
                [subject],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            == Some(1))
    }

    pub fn accept_account_epoch_if_current(
        &self,
        expected_subject: &str,
        expected_epoch: &str,
        expected_cursor: &str,
        expected_generation: i64,
        next_epoch: &str,
        remove_local_profiles: bool,
    ) -> Result<(), NativeError> {
        let mut connection = self.connection();
        let transaction = connection.transaction()?;
        let current: Option<(String, String, String, i64)> = transaction
            .query_row(
                "SELECT subject, epoch, cursor, session_generation FROM sync_state WHERE singleton = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        if current.as_ref()
            != Some(&(
                expected_subject.to_owned(),
                expected_epoch.to_owned(),
                expected_cursor.to_owned(),
                expected_generation,
            ))
        {
            return Err(NativeError::new(
                NativeErrorCode::SyncStateChanged,
                "Hosted sync state changed; the stale account response was discarded.",
            ));
        }
        transaction.execute("DELETE FROM mutation_outbox", [])?;
        if remove_local_profiles {
            transaction.execute("DELETE FROM profiles", [])?;
            transaction.execute("DELETE FROM mutation_quarantine", [])?;
            transaction.execute("DELETE FROM profile_sync_policy", [])?;
        } else {
            transaction.execute("DELETE FROM profile_sync_policy", [])?;
            transaction.execute(
                "INSERT INTO profile_sync_policy(profile_id, policy, subject)
                 SELECT id, 'local-only', ?1 FROM profiles",
                [expected_subject],
            )?;
            transaction.execute(
                "UPDATE mutation_quarantine SET subject=?1 WHERE provenance='pre-login'",
                [expected_subject],
            )?;
        }
        let lifecycle_generation = Uuid::new_v4().to_string();
        transaction.execute(
            "UPDATE sync_state SET epoch=?1, cursor='', session_generation=session_generation + 1,
             preserve_outbox_on_epoch_adopt=0, lifecycle_generation=?6
             WHERE singleton=1 AND subject=?2 AND epoch=?3 AND cursor=?4 AND session_generation=?5",
            params![
                next_epoch,
                expected_subject,
                expected_epoch,
                expected_cursor,
                expected_generation,
                lifecycle_generation
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }

    fn build_hosted_sync_request(
        &self,
        subject: &str,
        expected_lifecycle_generation: Option<&str>,
    ) -> Result<(serde_json::Value, String), NativeError> {
        let mut connection = self.connection();
        let unbound_claim_required_before_quarantine: i64 = connection.query_row(
            "SELECT EXISTS(
               SELECT 1 FROM mutation_outbox
               UNION ALL
               SELECT 1 FROM profiles
               UNION ALL
               SELECT 1 FROM profile_sync_policy WHERE policy='unclaimed'
               UNION ALL
               SELECT 1
               FROM mutation_quarantine quarantine
               LEFT JOIN profile_sync_policy policy ON policy.profile_id=quarantine.profile_id
               WHERE quarantine.provenance='pre-login'
                 AND (policy.profile_id IS NULL OR policy.policy='unclaimed')
             )",
            [],
            |row| row.get(0),
        )?;
        quarantine_invalid_outbox(&mut connection)?;
        let unresolved_account_claim: i64 = connection.query_row(
            "SELECT EXISTS(
               SELECT 1 FROM profile_sync_policy WHERE policy='unclaimed'
               UNION ALL
               SELECT 1
               FROM mutation_quarantine quarantine
               LEFT JOIN profile_sync_policy policy ON policy.profile_id=quarantine.profile_id
               WHERE quarantine.provenance='pre-login'
                 AND (policy.profile_id IS NULL OR policy.policy='unclaimed')
             )",
            [],
            |row| row.get(0),
        )?;
        let unbound_account_claim_required =
            unbound_claim_required_before_quarantine == 1 || unresolved_account_claim == 1;
        let device_id: String = match connection
            .query_row(
                "SELECT value FROM settings WHERE key='device_id'",
                [],
                |row| row.get(0),
            )
            .optional()?
        {
            Some(device_id) => device_id,
            None => {
                let device_id = Uuid::new_v4().to_string();
                connection.execute(
                    "INSERT INTO settings(key, value) VALUES ('device_id', ?1)",
                    [&device_id],
                )?;
                device_id
            }
        };
        let pending = {
            let mut statement = connection.prepare(
                "SELECT mutation_id, kind, payload, occurred_at
                 FROM mutation_outbox ORDER BY sequence ASC",
            )?;
            let rows = statement.query_map([], |row| {
                Ok(OutboxMutation {
                    mutation_id: row.get(0)?,
                    kind: row.get(1)?,
                    payload: row.get(2)?,
                    occurred_at: row.get(3)?,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let current: Option<(String, String, String, String)> = connection
            .query_row(
                "SELECT subject, epoch, cursor, lifecycle_generation
                 FROM sync_state WHERE singleton=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        let (epoch, cursor, lifecycle_generation) = if let Some(expected_lifecycle_generation) =
            expected_lifecycle_generation
        {
            match current {
                Some((owner, epoch, cursor, lifecycle_generation))
                    if owner == subject
                        && lifecycle_generation == expected_lifecycle_generation =>
                {
                    (epoch, cursor, lifecycle_generation)
                }
                _ => {
                    return Err(NativeError::new(
                        NativeErrorCode::SyncStateChanged,
                        "Hosted sync lifecycle changed; the stale request was stopped.",
                    ))
                }
            }
        } else {
            match current {
                    Some((owner, epoch, cursor, lifecycle_generation)) if owner == subject => {
                        if unresolved_account_claim == 1 {
                            return Err(NativeError::new(
                                NativeErrorCode::SyncAccountClaimRequired,
                                "Choose whether this account may upload existing local profiles.",
                            ));
                        }
                        (epoch, cursor, lifecycle_generation)
                    }
                    Some((owner, _, _, _)) if owner.is_empty() => {
                        if unbound_account_claim_required {
                            return Err(NativeError::new(
                                NativeErrorCode::SyncAccountClaimRequired,
                                "Choose whether this account may upload existing local profiles.",
                            ));
                        }
                        let epoch = Uuid::new_v4().to_string();
                        let lifecycle_generation = Uuid::new_v4().to_string();
                        connection.execute(
                            "UPDATE sync_state SET subject=?1, epoch=?2, cursor='',
                             session_generation=session_generation + 1,
                             preserve_outbox_on_epoch_adopt=0, lifecycle_generation=?3
                             WHERE singleton=1",
                            params![subject, epoch, lifecycle_generation],
                        )?;
                        (epoch, String::new(), lifecycle_generation)
                    }
                    Some(_) => {
                        return Err(NativeError::new(
                            NativeErrorCode::AuthRequired,
                            "Local hosted-sync state belongs to another account. Sign out before switching accounts.",
                        ))
                    }
                    None => {
                        if unbound_account_claim_required {
                            return Err(NativeError::new(
                                NativeErrorCode::SyncAccountClaimRequired,
                                "Choose whether this account may upload existing local profiles.",
                            ));
                        }
                        let epoch = Uuid::new_v4().to_string();
                        let lifecycle_generation = Uuid::new_v4().to_string();
                        connection.execute(
                            "INSERT INTO sync_state(
                               singleton, subject, epoch, cursor, session_generation,
                               preserve_outbox_on_epoch_adopt, lifecycle_generation
                             ) VALUES (1, ?1, ?2, '', 1, 0, ?3)",
                            params![subject, epoch, lifecycle_generation],
                        )?;
                        (epoch, String::new(), lifecycle_generation)
                    }
                }
        };
        let mut mutations = Vec::new();
        for mutation in pending.into_iter().take(HOSTED_SYNC_MUTATION_LIMIT) {
            let payload: serde_json::Value =
                serde_json::from_str(&mutation.payload).map_err(internal_error)?;
            let value = if mutation.kind == "upsert" {
                json!({
                    "mutationId": mutation.mutation_id,
                    "kind": "upsert",
                    "profile": payload,
                    "occurredAt": mutation.occurred_at,
                })
            } else {
                json!({
                    "mutationId": mutation.mutation_id,
                    "kind": "delete",
                    "profileId": payload.get("profileId").and_then(serde_json::Value::as_str)
                        .ok_or_else(|| NativeError::new(NativeErrorCode::Internal, "A local delete mutation is invalid."))?,
                    "occurredAt": mutation.occurred_at,
                })
            };
            mutations.push(value);
            let candidate = json!({
                "deviceId": device_id,
                "epoch": epoch,
                "cursor": cursor,
                "mutations": mutations,
            });
            if serde_json::to_vec(&candidate)
                .map_err(internal_error)?
                .len()
                > HOSTED_SYNC_BODY_LIMIT
            {
                mutations.pop();
                if mutations.is_empty() {
                    return Err(NativeError::new(
                        NativeErrorCode::Internal,
                        "A local profile exceeds the hosted sync request limit.",
                    ));
                }
                break;
            }
        }
        let mut request = json!({ "deviceId": device_id, "epoch": epoch, "mutations": mutations });
        if !cursor.is_empty() {
            request["cursor"] = serde_json::Value::String(cursor);
        }
        Ok((request, lifecycle_generation))
    }

    fn initial_hosted_sync_request(
        &self,
        subject: &str,
    ) -> Result<(serde_json::Value, String), NativeError> {
        self.build_hosted_sync_request(subject, None)
    }

    fn hosted_sync_request_for_lifecycle(
        &self,
        subject: &str,
        lifecycle_generation: &str,
    ) -> Result<(serde_json::Value, String), NativeError> {
        self.build_hosted_sync_request(subject, Some(lifecycle_generation))
    }

    pub fn hosted_sync_request(&self, subject: &str) -> Result<serde_json::Value, NativeError> {
        self.initial_hosted_sync_request(subject)
            .map(|(request, _)| request)
    }

    pub fn hosted_sync_generation(
        &self,
        subject: &str,
        epoch: &str,
        cursor: &str,
    ) -> Result<i64, NativeError> {
        self.sync_binding()?
            .filter(|(owner, current_epoch, current_cursor, _)| {
                owner == subject && current_epoch == epoch && current_cursor == cursor
            })
            .map(|(_, _, _, generation)| generation)
            .ok_or_else(|| {
                NativeError::new(
                    NativeErrorCode::Internal,
                    "Hosted sync state changed; retry with the current account session.",
                )
            })
    }

    fn is_hosted_sync_lifecycle_current(
        &self,
        subject: &str,
        epoch: &str,
        cursor: &str,
        lifecycle_generation: &str,
    ) -> Result<bool, NativeError> {
        Ok(self
            .connection()
            .query_row(
                "SELECT 1 FROM sync_state
                 WHERE singleton=1 AND subject=?1 AND epoch=?2 AND cursor=?3
                 AND lifecycle_generation=?4",
                params![subject, epoch, cursor, lifecycle_generation],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    pub fn apply_hosted_sync_response(
        &self,
        expected_subject: &str,
        expected_epoch: &str,
        expected_cursor: &str,
        expected_generation: i64,
        response: &serde_json::Value,
    ) -> Result<(), NativeError> {
        let epoch = response
            .get("epoch")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                NativeError::new(
                    NativeErrorCode::Internal,
                    "Hosted sync returned an invalid epoch.",
                )
            })?;
        let cursor = response
            .get("cursor")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                NativeError::new(
                    NativeErrorCode::Internal,
                    "Hosted sync returned an invalid cursor.",
                )
            })?;
        let records = response
            .get("records")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| {
                NativeError::new(
                    NativeErrorCode::Internal,
                    "Hosted sync returned invalid records.",
                )
            })?;
        let receipts = response
            .get("receipts")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| {
                NativeError::new(
                    NativeErrorCode::Internal,
                    "Hosted sync returned invalid receipts.",
                )
            })?;

        let mut connection = self.connection();
        let transaction = connection.transaction()?;
        let current: Option<(String, String, String, i64)> = transaction
            .query_row(
                "SELECT subject, epoch, cursor, session_generation FROM sync_state WHERE singleton = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        if epoch != expected_epoch
            || current.as_ref()
                != Some(&(
                    expected_subject.to_owned(),
                    expected_epoch.to_owned(),
                    expected_cursor.to_owned(),
                    expected_generation,
                ))
        {
            return Err(NativeError::new(
                NativeErrorCode::SyncStateChanged,
                "Hosted sync state changed; the stale response was discarded.",
            ));
        }
        for receipt in receipts {
            let mutation_id = receipt
                .get("mutationId")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| {
                    NativeError::new(
                        NativeErrorCode::Internal,
                        "A hosted mutation receipt is invalid.",
                    )
                })?;
            transaction.execute(
                "DELETE FROM profile_sync_policy
                 WHERE policy='consented' AND subject=?1
                   AND profile_id=(
                     SELECT profile_id FROM mutation_outbox WHERE mutation_id=?2
                   )",
                params![expected_subject, mutation_id],
            )?;
            transaction.execute(
                "DELETE FROM mutation_outbox WHERE mutation_id = ?1",
                [mutation_id],
            )?;
        }
        for record in records {
            match record.get("kind").and_then(serde_json::Value::as_str) {
                Some("profile") => {
                    let profile: Profile = serde_json::from_value(
                        record.get("profile").cloned().ok_or_else(|| {
                            NativeError::new(
                                NativeErrorCode::Internal,
                                "A hosted profile record is missing.",
                            )
                        })?,
                    )
                    .map_err(internal_error)?;
                    validate_profile(&profile)?;
                    let has_pending_local_mutation: i64 = transaction.query_row(
                        "SELECT EXISTS(
                           SELECT 1 FROM mutation_outbox WHERE profile_id=?1
                           UNION ALL
                           SELECT 1 FROM mutation_quarantine WHERE profile_id=?1
                           UNION ALL
                           SELECT 1 FROM profile_sync_policy WHERE profile_id=?1
                         )",
                        [&profile.id],
                        |row| row.get(0),
                    )?;
                    if has_pending_local_mutation == 1 {
                        continue;
                    }
                    transaction.execute(
                        "INSERT INTO profiles(id, name, source_path, target_path, exclusions_json, created_at, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                         ON CONFLICT(id) DO UPDATE SET name=excluded.name, source_path=excluded.source_path,
                         target_path=excluded.target_path, exclusions_json=excluded.exclusions_json, updated_at=excluded.updated_at",
                        params![profile.id, profile.name, profile.source_path, profile.target_path,
                            serde_json::to_string(&profile.exclusions).map_err(internal_error)?, profile.created_at, profile.updated_at],
                    )?;
                }
                Some("tombstone") => {
                    let profile_id = record
                        .get("profileId")
                        .and_then(serde_json::Value::as_str)
                        .ok_or_else(|| {
                            NativeError::new(
                                NativeErrorCode::Internal,
                                "A hosted tombstone is invalid.",
                            )
                        })?;
                    let has_pending_local_mutation: i64 = transaction.query_row(
                        "SELECT EXISTS(
                           SELECT 1 FROM mutation_outbox WHERE profile_id=?1
                           UNION ALL
                           SELECT 1 FROM mutation_quarantine WHERE profile_id=?1
                           UNION ALL
                           SELECT 1 FROM profile_sync_policy WHERE profile_id=?1
                         )",
                        [profile_id],
                        |row| row.get(0),
                    )?;
                    if has_pending_local_mutation == 1 {
                        continue;
                    }
                    transaction.execute("DELETE FROM profiles WHERE id = ?1", [profile_id])?;
                }
                _ => {
                    return Err(NativeError::new(
                        NativeErrorCode::Internal,
                        "Hosted sync returned an unknown record kind.",
                    ))
                }
            }
        }
        let updated = transaction.execute(
            "UPDATE sync_state SET cursor = ?1,
             preserve_outbox_on_epoch_adopt=CASE
               WHEN EXISTS(
                 SELECT 1 FROM mutation_outbox WHERE preserve_on_epoch_adopt=1
                 UNION ALL
                 SELECT 1 FROM profile_sync_policy
                 WHERE policy='consented' AND subject=?2
               ) THEN 1
               ELSE 0
             END
             WHERE singleton = 1 AND subject = ?2 AND epoch = ?3 AND cursor = ?4 AND session_generation = ?5",
            params![cursor, expected_subject, expected_epoch, expected_cursor, expected_generation],
        )?;
        if updated != 1 {
            return Err(NativeError::new(
                NativeErrorCode::SyncStateChanged,
                "Hosted sync state changed; the stale response was discarded.",
            ));
        }
        transaction.commit()?;
        Ok(())
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
fn inspect_saved_profile_roots(
    source_path: PathBuf,
    target_path: PathBuf,
) -> Result<ProfileRootAvailability, NativeError> {
    inspect_profile_roots(&source_path, &target_path)
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostedSyncOutcome {
    acknowledged: usize,
    records_applied: usize,
    quarantined_mutations: usize,
    cursor: String,
}

#[derive(Default)]
struct HostedSyncLock(tokio::sync::Mutex<()>);

fn validate_exact_receipt_ids(
    response: &serde_json::Value,
    sent_ids: &HashSet<String>,
) -> Result<usize, NativeError> {
    let receipts = response
        .get("receipts")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            NativeError::new(
                NativeErrorCode::Internal,
                "Hosted sync returned invalid mutation receipts; local data remains queued.",
            )
        })?;
    let mut received_ids = HashSet::with_capacity(receipts.len());
    for receipt in receipts {
        let mutation_id = receipt
            .get("mutationId")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                NativeError::new(
                    NativeErrorCode::Internal,
                    "Hosted sync returned an invalid mutation receipt; local data remains queued.",
                )
            })?;
        if !received_ids.insert(mutation_id.to_owned()) {
            return Err(NativeError::new(
                NativeErrorCode::Internal,
                "Hosted sync returned duplicate mutation receipts; local data remains queued.",
            ));
        }
    }
    if &received_ids != sent_ids {
        return Err(NativeError::new(
            NativeErrorCode::Internal,
            "Hosted sync receipts did not exactly match the sent mutations; local data remains queued.",
        ));
    }
    Ok(receipts.len())
}

async fn run_hosted_sync_loop<Send, Response>(
    database: &Database,
    subject: &str,
    mut send: Send,
) -> Result<HostedSyncOutcome, NativeError>
where
    Send: FnMut(serde_json::Value) -> Response,
    Response:
        std::future::Future<Output = Result<(reqwest::StatusCode, serde_json::Value), NativeError>>,
{
    let mut acknowledged = 0;
    let mut records_applied = 0;
    let mut lifecycle_generation: Option<String> = None;
    let cursor = loop {
        let (payload, request_lifecycle_generation) = if let Some(expected_lifecycle_generation) =
            lifecycle_generation.as_deref()
        {
            database.hosted_sync_request_for_lifecycle(subject, expected_lifecycle_generation)?
        } else {
            database.initial_hosted_sync_request(subject)?
        };
        let expected_epoch = payload["epoch"].as_str().unwrap_or_default().to_owned();
        let expected_cursor = payload["cursor"].as_str().unwrap_or_default().to_owned();
        lifecycle_generation = Some(request_lifecycle_generation.clone());
        let expected_generation =
            database.hosted_sync_generation(subject, &expected_epoch, &expected_cursor)?;
        let sent_ids: HashSet<String> = payload["mutations"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|mutation| mutation["mutationId"].as_str().map(ToOwned::to_owned))
            .collect();
        let (status, body) = send(payload).await?;
        if !database.is_hosted_sync_lifecycle_current(
            subject,
            &expected_epoch,
            &expected_cursor,
            &request_lifecycle_generation,
        )? {
            return Err(NativeError::new(
                NativeErrorCode::SyncStateChanged,
                "Hosted sync lifecycle changed; the stale response was stopped.",
            ));
        }
        if status == reqwest::StatusCode::CONFLICT
            && body
                .get("code")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|code| code == "RESET_REQUIRED" || code == "SYNC_EPOCH_RESET_REQUIRED")
        {
            let preserves_consented_outbox = database.preserves_consented_outbox(subject)?;
            return Err(NativeError {
                code: NativeErrorCode::ResetRequired,
                message: if preserves_consented_outbox {
                    "This account already has hosted data. Review the explicitly consented local profiles before uploading."
                } else {
                    "Hosted profile data was reset. Review this device before uploading again."
                }
                .into(),
                details: body.get("epoch").cloned().map(|epoch| {
                    json!({
                        "epoch": epoch,
                        "preservesConsentedOutbox": preserves_consented_outbox
                    })
                }),
            });
        }
        if !status.is_success() {
            return Err(NativeError::new(
                if status == reqwest::StatusCode::UNAUTHORIZED {
                    NativeErrorCode::AuthRequired
                } else {
                    NativeErrorCode::Internal
                },
                "Hosted sync was rejected; local data remains safe.",
            ));
        }
        let receipt_count = validate_exact_receipt_ids(&body, &sent_ids)?;
        let response_cursor = body
            .get("cursor")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned();
        match database.apply_hosted_sync_response(
            subject,
            &expected_epoch,
            &expected_cursor,
            expected_generation,
            &body,
        ) {
            Ok(()) => {}
            Err(error) if error.code == NativeErrorCode::SyncStateChanged => {
                if database.is_hosted_sync_lifecycle_current(
                    subject,
                    &expected_epoch,
                    &expected_cursor,
                    &request_lifecycle_generation,
                )? {
                    continue;
                }
                return Err(error);
            }
            Err(error) => return Err(error),
        }
        acknowledged += receipt_count;
        records_applied += body
            .get("records")
            .and_then(serde_json::Value::as_array)
            .map_or(0, Vec::len);
        let has_more = body
            .get("hasMore")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);

        if sent_ids.is_empty() {
            if has_more {
                continue;
            }
            break response_cursor;
        }
        let pending: HashSet<String> = database
            .pending_outbox()?
            .into_iter()
            .map(|mutation| mutation.mutation_id)
            .collect();
        if sent_ids.iter().any(|id| pending.contains(id)) {
            return Err(NativeError::new(
                NativeErrorCode::Internal,
                "Hosted sync returned incomplete mutation receipts; local data remains queued.",
            ));
        }
        if pending.is_empty() && !has_more {
            break response_cursor;
        }
    };
    Ok(HostedSyncOutcome {
        acknowledged,
        records_applied,
        quarantined_mutations: database.quarantined_mutations()?.len(),
        cursor,
    })
}

#[tauri::command]
async fn sync_hosted_profiles(
    api_url: String,
    access_token: String,
    subject: String,
    database: State<'_, Database>,
    sync_lock: State<'_, HostedSyncLock>,
) -> Result<HostedSyncOutcome, NativeError> {
    let _sync_guard = sync_lock.0.lock().await;
    let base = url::Url::parse(&api_url).map_err(|_| {
        NativeError::new(
            NativeErrorCode::Internal,
            "Hosted sync configuration is invalid.",
        )
    })?;
    if base.scheme() != "https" || base.host_str().is_none() {
        return Err(NativeError::new(
            NativeErrorCode::Internal,
            "Hosted sync requires an HTTPS endpoint.",
        ));
    }
    let endpoint = base.join("/v1/sync").map_err(|_| {
        NativeError::new(
            NativeErrorCode::Internal,
            "Hosted sync configuration is invalid.",
        )
    })?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|_| {
            NativeError::new(
                NativeErrorCode::Internal,
                "Hosted sync is unavailable; local data remains safe.",
            )
        })?;
    run_hosted_sync_loop(&database, &subject, move |payload| {
        let client = client.clone();
        let endpoint = endpoint.clone();
        let access_token = access_token.clone();
        async move {
            let mut response = client
                .post(endpoint)
                .bearer_auth(access_token)
                .json(&payload)
                .send()
                .await
                .map_err(|_| {
                    NativeError::new(
                        NativeErrorCode::Internal,
                        "Hosted sync is unavailable; local data remains safe.",
                    )
                })?;
            let status = response.status();
            if response
                .content_length()
                .is_some_and(|length| length > 2 * 1024 * 1024)
            {
                return Err(NativeError::new(
                    NativeErrorCode::Internal,
                    "Hosted sync returned an oversized response.",
                ));
            }
            let mut response_bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| {
                NativeError::new(
                    NativeErrorCode::Internal,
                    "Hosted sync returned an invalid response.",
                )
            })? {
                if response_bytes.len() + chunk.len() > 2 * 1024 * 1024 {
                    return Err(NativeError::new(
                        NativeErrorCode::Internal,
                        "Hosted sync returned an oversized response.",
                    ));
                }
                response_bytes.extend_from_slice(&chunk);
            }
            let body = serde_json::from_slice(&response_bytes).map_err(|_| {
                NativeError::new(
                    NativeErrorCode::Internal,
                    "Hosted sync returned an invalid response.",
                )
            })?;
            Ok((status, body))
        }
    })
    .await
}

#[tauri::command]
fn clear_local_synced_data(database: State<'_, Database>) -> Result<(), NativeError> {
    database.clear_local_synced_data()
}

#[tauri::command]
fn disconnect_hosted_account(
    remove_local_profiles: bool,
    database: State<'_, Database>,
) -> Result<(), NativeError> {
    database.disconnect_hosted_account(remove_local_profiles)
}

#[tauri::command]
fn claim_hosted_account(
    subject: String,
    upload_existing: bool,
    database: State<'_, Database>,
) -> Result<(), NativeError> {
    database.claim_hosted_account(&subject, upload_existing)
}

#[tauri::command]
fn accept_hosted_epoch(
    subject: String,
    epoch: String,
    remove_local_profiles: bool,
    database: State<'_, Database>,
) -> Result<(), NativeError> {
    if subject.is_empty() || Uuid::parse_str(&epoch).is_err() {
        return Err(NativeError::new(
            NativeErrorCode::ResetRequired,
            "Hosted sync returned an invalid account reset.",
        ));
    }
    database.accept_account_epoch(&subject, &epoch, remove_local_profiles)
}

#[tauri::command]
async fn delete_hosted_account_data(
    api_url: String,
    access_token: String,
    subject: String,
    remove_local_profiles: bool,
    database: State<'_, Database>,
    sync_lock: State<'_, HostedSyncLock>,
) -> Result<(), NativeError> {
    let _sync_guard = sync_lock.0.lock().await;
    let base = url::Url::parse(&api_url).map_err(|_| {
        NativeError::new(
            NativeErrorCode::Internal,
            "Hosted sync configuration is invalid.",
        )
    })?;
    if base.scheme() != "https" || base.host_str().is_none() {
        return Err(NativeError::new(
            NativeErrorCode::Internal,
            "Hosted sync requires an HTTPS endpoint.",
        ));
    }
    let request = database.hosted_sync_request(&subject)?;
    let epoch = request["epoch"].as_str().unwrap_or_default().to_owned();
    let cursor = request["cursor"].as_str().unwrap_or_default().to_owned();
    let generation = database.hosted_sync_generation(&subject, &epoch, &cursor)?;
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|_| {
            NativeError::new(
                NativeErrorCode::Internal,
                "Hosted account deletion is unavailable.",
            )
        })?
        .delete(base.join("/v1/account-data").map_err(internal_error)?)
        .bearer_auth(access_token)
        .json(&json!({ "epoch": epoch }))
        .send()
        .await
        .map_err(|_| {
            NativeError::new(
                NativeErrorCode::Internal,
                "Hosted account deletion is unavailable.",
            )
        })?;
    if !response.status().is_success() {
        return Err(NativeError::new(
            if response.status() == reqwest::StatusCode::UNAUTHORIZED {
                NativeErrorCode::AuthRequired
            } else {
                NativeErrorCode::Internal
            },
            "Hosted account deletion was rejected; local data was not changed.",
        ));
    }
    let body: serde_json::Value = response.json().await.map_err(|_| {
        NativeError::new(
            NativeErrorCode::Internal,
            "Hosted account deletion returned an invalid response.",
        )
    })?;
    let next_epoch = body
        .get("epoch")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            NativeError::new(
                NativeErrorCode::Internal,
                "Hosted account deletion returned an invalid epoch.",
            )
        })?;
    if Uuid::parse_str(next_epoch).is_err() {
        return Err(NativeError::new(
            NativeErrorCode::Internal,
            "Hosted account deletion returned an invalid epoch.",
        ));
    }
    database.accept_account_epoch_if_current(
        &subject,
        &epoch,
        &cursor,
        generation,
        next_epoch,
        remove_local_profiles,
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let directory = app.path().app_data_dir()?;
            fs::create_dir_all(&directory)?;
            app.handle().plugin(
                tauri_plugin_stronghold::Builder::with_argon2(
                    &directory.join("rootline-auth.salt"),
                )
                .build(),
            )?;
            let database = Database::open(directory.join("rootline.sqlite3"))
                .map_err(|error| Box::<dyn std::error::Error>::from(error.to_string()))?;
            database
                .device_id()
                .map_err(|error| Box::<dyn std::error::Error>::from(error.to_string()))?;
            app.manage(database);
            app.manage(HostedSyncLock::default());
            app.manage(Arc::new(OperationRegistry::default()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            choose_folder,
            inspect_saved_profile_roots,
            scan_directories,
            apply_directories,
            cancel_operation,
            list_profiles,
            save_profile,
            delete_profile,
            auth_vault_password,
            sync_hosted_profiles,
            clear_local_synced_data,
            disconnect_hosted_account,
            claim_hosted_account,
            accept_hosted_epoch,
            delete_hosted_account_data,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Rootline");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tempfile::tempdir;
    use tokio::sync::oneshot;

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

    #[test]
    fn cancellation_after_a_mkdir_returns_that_accumulated_result_deterministically() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        fs::create_dir(source.path().join("first")).unwrap();
        fs::create_dir(source.path().join("second")).unwrap();
        let request = ScanRequest {
            operation_id: "observed-apply".into(),
            source_path: source.path().into(),
            target_path: target.path().into(),
            exclusions: Vec::new(),
        };
        let plan = scan_plan(&request, &CancellationToken::default()).unwrap();
        let token = CancellationToken::default();
        let observer_token = token.clone();
        let result =
            apply_plan_with_observer(&request, &plan, &plan.missing, &token, move |entry| {
                assert_eq!(entry.relative_path, "first");
                observer_token.cancel();
            })
            .unwrap();
        assert!(result.cancelled);
        assert_eq!(result.directories.len(), 1);
        assert_eq!(result.directories[0].status, DirectoryStatus::Created);
        assert!(target.path().join("first").is_dir());
        assert!(!target.path().join("second").exists());
    }

    #[test]
    fn command_loop_stops_after_disconnect_and_allows_bob_without_rebinding_alice() {
        for stale_status in [reqwest::StatusCode::OK, reqwest::StatusCode::CONFLICT] {
            for remove_local_profiles in [false, true] {
                tauri::async_runtime::block_on(async {
                    let directory = tempdir().unwrap();
                    let database = Arc::new(
                        Database::open(directory.path().join(format!(
                            "disconnect-command-loop-{remove_local_profiles}-{}.sqlite3",
                            stale_status.as_u16()
                        )))
                        .unwrap(),
                    );
                    let profile = Profile {
                        id: "alice-local".into(),
                        name: "Alice local".into(),
                        source_path: "/alice/private".into(),
                        target_path: "/alice/target".into(),
                        exclusions: vec![],
                        created_at: "2026-08-15T00:00:00Z".into(),
                        updated_at: "2026-08-15T00:00:00Z".into(),
                    };
                    database.save_profile(&profile).unwrap();
                    database.claim_hosted_account("alice", true).unwrap();

                    let alice_sends = Arc::new(AtomicUsize::new(0));
                    let (request_started_tx, request_started_rx) = oneshot::channel();
                    let (response_tx, response_rx) = oneshot::channel();
                    let task_database = Arc::clone(&database);
                    let task_sends = Arc::clone(&alice_sends);
                    let sync = tauri::async_runtime::spawn(async move {
                        let mut request_started_tx = Some(request_started_tx);
                        let mut response_rx = Some(response_rx);
                        run_hosted_sync_loop(&task_database, "alice", move |payload| {
                            task_sends.fetch_add(1, Ordering::SeqCst);
                            let started = request_started_tx.take();
                            let response = response_rx.take();
                            async move {
                                if let Some(started) = started {
                                    let _ = started.send(payload);
                                }
                                match response {
                                    Some(response) => response.await.unwrap(),
                                    None => Err(NativeError::new(
                                        NativeErrorCode::Internal,
                                        "Alice transport was reused after disconnect.",
                                    )),
                                }
                            }
                        })
                        .await
                    });

                    let alice_request = request_started_rx.await.unwrap();
                    database
                        .disconnect_hosted_account(remove_local_profiles)
                        .unwrap();
                    response_tx
                    .send(Ok((
                        stale_status,
                        if stale_status == reqwest::StatusCode::CONFLICT {
                            json!({
                                "code": "SYNC_EPOCH_RESET_REQUIRED",
                                "epoch": alice_request["epoch"]
                            })
                        } else {
                            json!({
                                "epoch": alice_request["epoch"],
                                "cursor": "alice-stale",
                                "hasMore": false,
                                "records": [],
                                "receipts": alice_request["mutations"].as_array().unwrap().iter().enumerate().map(|(index, mutation)| {
                                    json!({ "mutationId": mutation["mutationId"], "revision": index + 1 })
                                }).collect::<Vec<_>>()
                            })
                        },
                    )))
                    .unwrap();
                    let error = sync.await.unwrap().unwrap_err();
                    assert_eq!(error.code, NativeErrorCode::SyncStateChanged);
                    assert_eq!(alice_sends.load(Ordering::SeqCst), 1);

                    database.claim_hosted_account("bob", false).unwrap();
                    let bob_sends = Arc::new(AtomicUsize::new(0));
                    let counted_bob_sends = Arc::clone(&bob_sends);
                    run_hosted_sync_loop(&database, "bob", move |payload| {
                        counted_bob_sends.fetch_add(1, Ordering::SeqCst);
                        async move {
                            Ok((
                                reqwest::StatusCode::OK,
                                json!({
                                    "epoch": payload["epoch"],
                                    "cursor": "bob-current",
                                    "hasMore": false,
                                    "records": [],
                                    "receipts": []
                                }),
                            ))
                        }
                    })
                    .await
                    .unwrap();
                    assert_eq!(bob_sends.load(Ordering::SeqCst), 1);
                    assert_eq!(database.sync_cursor().unwrap().unwrap().1, "bob-current");
                });
            }
        }
    }

    #[test]
    fn strict_followup_request_cannot_rebind_after_preflight_disconnect_interleaving() {
        let directory = tempdir().unwrap();
        let database =
            Database::open(directory.path().join("strict-followup-request.sqlite3")).unwrap();
        database.claim_hosted_account("alice", false).unwrap();
        let (_, lifecycle_generation) = database.initial_hosted_sync_request("alice").unwrap();

        database.disconnect_hosted_account(false).unwrap();
        let error = database
            .hosted_sync_request_for_lifecycle("alice", &lifecycle_generation)
            .unwrap_err();
        assert_eq!(error.code, NativeErrorCode::SyncStateChanged);
        assert!(database.hosted_sync_request("bob").is_ok());
    }

    #[test]
    fn command_loop_preflights_lifecycle_before_building_a_followup_page() {
        tauri::async_runtime::block_on(async {
            let directory = tempdir().unwrap();
            let database =
                Database::open(directory.path().join("post-success-race.sqlite3")).unwrap();
            database.claim_hosted_account("alice", false).unwrap();
            database
                .connection()
                .execute_batch(
                    "CREATE TRIGGER disconnect_after_page_one
                     AFTER UPDATE OF cursor ON sync_state
                     WHEN NEW.cursor='page-one'
                     BEGIN
                       DELETE FROM mutation_outbox;
                       UPDATE sync_state SET subject='', epoch='', cursor='',
                         session_generation=session_generation + 1,
                         lifecycle_generation=lower(hex(randomblob(16)))
                       WHERE singleton=1;
                     END;",
                )
                .unwrap();
            let sends = Arc::new(AtomicUsize::new(0));
            let counted_sends = Arc::clone(&sends);
            let error = run_hosted_sync_loop(&database, "alice", move |payload| {
                let attempt = counted_sends.fetch_add(1, Ordering::SeqCst);
                async move {
                    if attempt > 0 {
                        return Err(NativeError::new(
                            NativeErrorCode::Internal,
                            "Alice follow-up transport ran after lifecycle invalidation.",
                        ));
                    }
                    Ok((
                        reqwest::StatusCode::OK,
                        json!({
                            "epoch": payload["epoch"],
                            "cursor": "page-one",
                            "hasMore": true,
                            "records": [],
                            "receipts": []
                        }),
                    ))
                }
            })
            .await
            .unwrap_err();

            assert_eq!(error.code, NativeErrorCode::SyncStateChanged);
            assert_eq!(sends.load(Ordering::SeqCst), 1);
            assert!(database.hosted_sync_request("bob").is_ok());
        });
    }

    #[test]
    fn command_loop_rejects_same_account_aba_after_disconnect_and_rebind() {
        tauri::async_runtime::block_on(async {
            let directory = tempdir().unwrap();
            let database = Arc::new(
                Database::open(directory.path().join("same-account-aba.sqlite3")).unwrap(),
            );
            database.claim_hosted_account("alice", false).unwrap();
            let sends = Arc::new(AtomicUsize::new(0));
            let (request_started_tx, request_started_rx) = oneshot::channel();
            let (response_tx, response_rx) = oneshot::channel();
            let task_database = Arc::clone(&database);
            let task_sends = Arc::clone(&sends);
            let sync = tauri::async_runtime::spawn(async move {
                let mut request_started_tx = Some(request_started_tx);
                let mut response_rx = Some(response_rx);
                run_hosted_sync_loop(&task_database, "alice", move |payload| {
                    task_sends.fetch_add(1, Ordering::SeqCst);
                    let started = request_started_tx.take();
                    let response = response_rx.take();
                    async move {
                        if let Some(started) = started {
                            let _ = started.send(payload);
                        }
                        match response {
                            Some(response) => response.await.unwrap(),
                            None => Err(NativeError::new(
                                NativeErrorCode::Internal,
                                "Old Alice transport was reused after account ABA.",
                            )),
                        }
                    }
                })
                .await
            });

            let request = request_started_rx.await.unwrap();
            let old_epoch = request["epoch"].as_str().unwrap();
            database.disconnect_hosted_account(false).unwrap();
            database.claim_hosted_account("alice", false).unwrap();
            database
                .accept_account_epoch("alice", old_epoch, false)
                .unwrap();
            response_tx
                .send(Ok((
                    reqwest::StatusCode::OK,
                    json!({
                        "epoch": old_epoch,
                        "cursor": "stale-aba",
                        "hasMore": false,
                        "records": [],
                        "receipts": []
                    }),
                )))
                .unwrap();

            let error = sync.await.unwrap().unwrap_err();
            assert_eq!(error.code, NativeErrorCode::SyncStateChanged);
            assert_eq!(sends.load(Ordering::SeqCst), 1);
        });
    }

    #[test]
    fn command_loop_retries_a_same_subject_edit_generation() {
        tauri::async_runtime::block_on(async {
            let directory = tempdir().unwrap();
            let database = Arc::new(
                Database::open(directory.path().join("edit-command-loop.sqlite3")).unwrap(),
            );
            let profile = Profile {
                id: "alice-edit".into(),
                name: "Before request".into(),
                source_path: "/alice/source".into(),
                target_path: "/alice/target".into(),
                exclusions: vec![],
                created_at: "2026-08-15T00:00:00Z".into(),
                updated_at: "2026-08-15T00:00:00Z".into(),
            };
            database.save_profile(&profile).unwrap();
            database.claim_hosted_account("alice", true).unwrap();
            let sends = Arc::new(AtomicUsize::new(0));
            let transport_database = Arc::clone(&database);
            let counted_sends = Arc::clone(&sends);
            let edited_profile = Profile {
                name: "Edited during request".into(),
                updated_at: "2026-08-15T00:01:00Z".into(),
                ..profile
            };

            run_hosted_sync_loop(&database, "alice", move |payload| {
                let attempt = counted_sends.fetch_add(1, Ordering::SeqCst);
                let transport_database = Arc::clone(&transport_database);
                let edited_profile = edited_profile.clone();
                async move {
                    if attempt == 0 {
                        transport_database.save_profile(&edited_profile).unwrap();
                    }
                    let receipts = payload["mutations"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .enumerate()
                        .map(|(index, mutation)| {
                            json!({ "mutationId": mutation["mutationId"], "revision": index + 1 })
                        })
                        .collect::<Vec<_>>();
                    Ok((
                        reqwest::StatusCode::OK,
                        json!({
                            "epoch": payload["epoch"],
                            "cursor": format!("edit-attempt-{attempt}"),
                            "hasMore": false,
                            "records": [],
                            "receipts": receipts
                        }),
                    ))
                }
            })
            .await
            .unwrap();

            assert_eq!(sends.load(Ordering::SeqCst), 2);
            assert_eq!(
                database.list_profiles().unwrap()[0].name,
                "Edited during request"
            );
            assert!(database.pending_outbox().unwrap().is_empty());
        });
    }

    fn assert_invalid_receipt_set_preserves_outbox(fault: &str) {
        tauri::async_runtime::block_on(async {
            let directory = tempdir().unwrap();
            let database = Database::open(
                directory
                    .path()
                    .join(format!("invalid-{fault}-receipts.sqlite3")),
            )
            .unwrap();
            for index in 0..101 {
                database
                    .enqueue_mutation(
                        &format!("00000000-0000-4000-8006-{index:012}"),
                        "upsert",
                        &json!({
                            "id": format!("profile-{index}"),
                            "name": format!("Profile {index}"),
                            "sourcePath": format!("/source/{index}"),
                            "targetPath": format!("/target/{index}"),
                            "exclusions": [],
                            "createdAt": "2026-08-15T00:00:00Z",
                            "updatedAt": "2026-08-15T00:00:00Z"
                        })
                        .to_string(),
                        "2026-08-15T00:00:00Z",
                    )
                    .unwrap();
            }
            database.claim_hosted_account("alice", true).unwrap();
            let before = database.pending_outbox().unwrap();
            let before_cursor = database.sync_cursor().unwrap();
            let sends = Arc::new(AtomicUsize::new(0));
            let counted_sends = Arc::clone(&sends);
            let fault = fault.to_owned();

            let error = run_hosted_sync_loop(&database, "alice", move |payload| {
                let attempt = counted_sends.fetch_add(1, Ordering::SeqCst);
                let fault = fault.clone();
                async move {
                    if attempt > 0 {
                        return Err(NativeError::new(
                            NativeErrorCode::Internal,
                            "Transport was reused after an invalid receipt set.",
                        ));
                    }
                    let mutations = payload["mutations"].as_array().unwrap();
                    assert_eq!(mutations.len(), 100);
                    let mut receipts = mutations
                        .iter()
                        .enumerate()
                        .map(|(index, mutation)| {
                            json!({ "mutationId": mutation["mutationId"], "revision": index + 1 })
                        })
                        .collect::<Vec<_>>();
                    match fault.as_str() {
                        "missing" => {
                            receipts.pop();
                        }
                        "duplicate" => receipts.push(receipts[0].clone()),
                        "extra-101" => receipts.push(json!({
                            "mutationId": "00000000-0000-4000-8006-000000000100",
                            "revision": 101
                        })),
                        _ => unreachable!(),
                    }
                    Ok((
                        reqwest::StatusCode::OK,
                        json!({
                            "epoch": payload["epoch"],
                            "cursor": "must-not-commit",
                            "hasMore": false,
                            "records": [],
                            "receipts": receipts
                        }),
                    ))
                }
            })
            .await
            .unwrap_err();

            assert_eq!(error.code, NativeErrorCode::Internal);
            assert_eq!(sends.load(Ordering::SeqCst), 1);
            assert_eq!(database.pending_outbox().unwrap(), before);
            assert_eq!(database.sync_cursor().unwrap(), before_cursor);
        });
    }

    #[test]
    fn command_loop_rejects_missing_receipts_before_mutating_sqlite() {
        assert_invalid_receipt_set_preserves_outbox("missing");
    }

    #[test]
    fn command_loop_rejects_duplicate_receipts_before_mutating_sqlite() {
        assert_invalid_receipt_set_preserves_outbox("duplicate");
    }

    #[test]
    fn command_loop_rejects_an_extra_101st_receipt_before_mutating_sqlite() {
        assert_invalid_receipt_set_preserves_outbox("extra-101");
    }

    #[test]
    fn command_loop_reports_quarantined_legacy_mutations_without_fifo_wedging() {
        tauri::async_runtime::block_on(async {
            let directory = tempdir().unwrap();
            let database =
                Database::open(directory.path().join("quarantine-status.sqlite3")).unwrap();
            database
                .enqueue_mutation(
                    "00000000-0000-4000-8007-000000000010",
                    "upsert",
                    &json!({
                        "id": "legacy-invalid",
                        "name": "n".repeat(81),
                        "sourcePath": "/source",
                        "targetPath": "/target",
                        "exclusions": [],
                        "createdAt": "2026-08-15T00:00:00Z",
                        "updatedAt": "2026-08-15T00:00:00Z"
                    })
                    .to_string(),
                    "2026-08-15T00:00:00Z",
                )
                .unwrap();
            database.claim_hosted_account("alice", true).unwrap();

            let outcome = run_hosted_sync_loop(&database, "alice", |payload| async move {
                assert_eq!(payload["mutations"], json!([]));
                Ok((
                    reqwest::StatusCode::OK,
                    json!({
                        "epoch": payload["epoch"],
                        "cursor": "quarantine-observed",
                        "hasMore": false,
                        "records": [],
                        "receipts": []
                    }),
                ))
            })
            .await
            .unwrap();

            assert_eq!(outcome.quarantined_mutations, 1);
            assert!(database.pending_outbox().unwrap().is_empty());
            assert_eq!(database.quarantined_mutations().unwrap().len(), 1);
        });
    }
}

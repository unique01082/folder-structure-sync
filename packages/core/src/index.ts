import {
  ROOTLINE_ERROR_CODES,
  RootlineError,
  createRootlineError,
} from "@rootline/contracts";

export { ROOTLINE_ERROR_CODES, RootlineError, createRootlineError };

export type CaseSensitivity = "sensitive" | "insensitive";

export interface DirectorySnapshot {
  readonly rootPath: string;
  readonly caseSensitivity: CaseSensitivity;
  readonly directories: readonly string[];
  readonly skippedLinks: readonly string[];
  readonly entries: readonly string[];
  readonly fingerprint: string;
}

export interface PlanOperation {
  readonly id: string;
  readonly type: "create-directory";
  readonly relativePath: string;
}

export interface SyncPlan {
  readonly sourceRoot: string;
  readonly targetRoot: string;
  readonly operations: readonly PlanOperation[];
  readonly sourceFingerprint: string;
  readonly targetFingerprint: string;
  readonly targetCaseSensitive: boolean;
  readonly missing: readonly string[];
  readonly fingerprint: string;
}

export interface CancellationSignalLike {
  readonly aborted: boolean;
}

function invalidPath(message: string, value: string): never {
  throw createRootlineError({
    code: ROOTLINE_ERROR_CODES.INVALID_PATH,
    message,
    details: { path: value },
  });
}

/** Converts a relative directory name to the portable format used by snapshots. */
export function normalizeRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (normalized === "" || normalized === ".") {
    return "";
  }
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    return invalidPath("A relative path must not be absolute.", value);
  }

  const parts = normalized.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    return invalidPath("A relative path must not traverse outside its root.", value);
  }
  return parts.join("/");
}

function globToRegExp(pattern: string): RegExp {
  let expression = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const token = pattern[index]!;
    if (token === "*" && pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") {
        index += 1;
        expression += "(?:.*/)?";
      } else {
        expression += ".*";
      }
    } else if (token === "*") {
      expression += "[^/]*";
    } else if (token === "?") {
      expression += "[^/]";
    } else {
      expression += token.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`^${expression}$`);
}

/** Matches complete path segments, so `.git` never also excludes `.github`. */
export function matchesExclusion(relativePath: string, patterns: readonly string[]): boolean {
  const path = normalizeRelativePath(relativePath);
  if (!path) {
    return false;
  }
  const segments = path.split("/");
  return patterns.some((rawPattern) => {
    const pattern = normalizeRelativePath(rawPattern);
    if (!pattern) {
      return false;
    }
    if (pattern.includes("/")) {
      return globToRegExp(pattern).test(path);
    }
    const matcher = globToRegExp(pattern);
    return segments.some((segment) => matcher.test(segment));
  });
}

/** Stable, dependency-free fingerprint for an already sorted sequence of paths. */
export function fingerprint(entries: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const entry of entries) {
    for (let index = 0; index < entry.length; index += 1) {
      hash ^= entry.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 10;
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/** Locale-independent ordering keeps plans and fingerprints portable across hosts. */
export function compareRelativePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface SnapshotMetadata {
  readonly rootPath?: string;
  readonly caseSensitivity?: CaseSensitivity;
  readonly skippedLinks?: readonly string[];
}

export function createSnapshot(entries: readonly string[], metadata: SnapshotMetadata = {}): DirectorySnapshot {
  const normalized = [...new Set(entries.map(normalizeRelativePath).filter(Boolean))].sort(compareRelativePaths);
  const directories = Object.freeze(normalized);
  return Object.freeze({
    rootPath: metadata.rootPath ?? "",
    caseSensitivity: metadata.caseSensitivity ?? "sensitive",
    directories,
    skippedLinks: Object.freeze([...(metadata.skippedLinks ?? [])]),
    entries: directories,
    fingerprint: fingerprint(normalized),
  });
}

export function createSyncPlan(
  source: DirectorySnapshot,
  target: DirectorySnapshot,
  targetCaseSensitive = target.caseSensitivity === "sensitive",
): SyncPlan {
  const comparable = (entry: string) => targetCaseSensitive ? entry : entry.toLowerCase();
  const targetEntries = new Set(target.entries.map(comparable));
  const missing = source.entries.filter((entry) => !targetEntries.has(comparable(entry)));
  const operations = missing.map((relativePath) => Object.freeze({
    id: fingerprint([source.rootPath, target.rootPath, relativePath]),
    type: "create-directory" as const,
    relativePath,
  }));
  const rootBinding = source.rootPath || target.rootPath ? [source.rootPath, target.rootPath] : [];
  const planEntries = [...rootBinding, source.fingerprint, target.fingerprint, targetCaseSensitive ? "case-sensitive" : "case-insensitive", ...missing];
  return Object.freeze({
    sourceRoot: source.rootPath,
    targetRoot: target.rootPath,
    operations: Object.freeze(operations),
    sourceFingerprint: source.fingerprint,
    targetFingerprint: target.fingerprint,
    targetCaseSensitive,
    missing: Object.freeze(missing),
    fingerprint: fingerprint(planEntries),
  });
}

/** Expands a requested subtree with only the parents that are also missing. */
export function selectPlanSubtree(plan: SyncPlan, requested: readonly string[]): string[] {
  const missing = new Set(plan.missing);
  const selected = new Set<string>();
  for (const rawPath of requested) {
    const path = normalizeRelativePath(rawPath);
    if (!missing.has(path)) {
      continue;
    }
    const parts = path.split("/");
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const parent = parts.slice(0, depth).join("/");
      if (missing.has(parent)) {
        selected.add(parent);
      }
    }
  }
  return [...selected].sort((left, right) => {
    const depth = left.split("/").length - right.split("/").length;
    return depth === 0 ? compareRelativePaths(left, right) : depth;
  });
}

function normalizeRootPath(value: string, caseSensitive: boolean): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
  return caseSensitive ? normalized : normalized.toLowerCase();
}

/** Rejects equal, ancestor, and descendant roots before any filesystem mutation. */
export function validateRootRelationship(sourcePath: string, targetPath: string, caseSensitive: boolean): void {
  const source = normalizeRootPath(sourcePath, caseSensitive);
  const target = normalizeRootPath(targetPath, caseSensitive);
  if (!source || !target) {
    invalidPath("A synchronization root must not be empty.", !source ? sourcePath : targetPath);
  }
  if (source === target || source.startsWith(`${target}/`) || target.startsWith(`${source}/`)) {
    throw createRootlineError({
      code: ROOTLINE_ERROR_CODES.PATH_OVERLAP,
      message: "Source and target roots must not overlap.",
      details: { sourcePath, targetPath },
    });
  }
}

export function assertPlanFresh(
  plan: SyncPlan,
  source: DirectorySnapshot,
  target: DirectorySnapshot,
): void {
  const expectedSource = plan.sourceRoot ? source : createSnapshot(source.entries);
  const expectedTarget = plan.targetRoot ? target : createSnapshot(target.entries);
  const expected = createSyncPlan(expectedSource, expectedTarget, plan.targetCaseSensitive);
  if (
    plan.sourceFingerprint !== source.fingerprint ||
    plan.targetFingerprint !== target.fingerprint ||
    plan.fingerprint !== expected.fingerprint ||
    plan.missing.length !== expected.missing.length ||
    plan.missing.some((entry, index) => entry !== expected.missing[index])
  ) {
    throw createRootlineError({
      code: ROOTLINE_ERROR_CODES.STALE_PLAN,
      message: "The filesystem changed after this plan was created.",
      details: { expectedPlan: plan.fingerprint },
    });
  }
}

export function throwIfCancelled(signal?: CancellationSignalLike): void {
  if (signal?.aborted) {
    throw createRootlineError({
      code: ROOTLINE_ERROR_CODES.CANCELLED,
      message: "The synchronization was cancelled.",
    });
  }
}

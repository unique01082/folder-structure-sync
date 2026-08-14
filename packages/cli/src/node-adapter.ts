import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";

import {
  ROOTLINE_ERROR_CODES,
  assertPlanFresh,
  createRootlineError,
  createSnapshot,
  matchesExclusion,
  selectPlanSubtree,
  throwIfCancelled,
  type CancellationSignalLike,
  type DirectorySnapshot,
  type SyncPlan,
} from "@rootline/core";

export const DEFAULT_EXCLUSIONS = [
  ".git",
  ".svn",
  ".hg",
  "node_modules",
  ".npm",
  ".yarn",
  "bower_components",
  ".DS_Store",
  "Thumbs.db",
  ".vscode",
  ".idea",
  "*.tmp",
  "*.temp",
  "*.log",
  ".cache",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "coverage",
  ".nyc_output",
] as const;

export interface ResolvedConfig {
  readonly path?: string;
  readonly exclusions: readonly string[];
  readonly targetCaseSensitive: boolean;
}

export interface ResolveConfigOptions {
  readonly cwd: string;
  readonly explicitPath?: string | undefined;
}

interface ConfigFile {
  readonly defaultExclusions?: unknown;
  readonly customExclusions?: unknown;
  readonly targetCaseSensitive?: unknown;
}

function configError(message: string, path: string, cause?: unknown): never {
  throw createRootlineError({
    code: ROOTLINE_ERROR_CODES.CONFIG_INVALID,
    message,
    details: { path, ...(cause instanceof Error ? { cause: cause.message } : {}) },
  });
}

function requireStringArray(value: unknown, name: string, path: string): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    return configError(`${name} must be an array of non-empty strings.`, path);
  }
  return value;
}

/** Resolves only an explicit config or `sync-config.json` in the requested cwd. */
export async function resolveConfig(options: ResolveConfigOptions): Promise<ResolvedConfig> {
  const cwdConfig = join(options.cwd, "sync-config.json");
  const candidate = options.explicitPath ? resolve(options.cwd, options.explicitPath) : cwdConfig;
  let raw: string;
  try {
    raw = await fs.readFile(candidate, "utf8");
  } catch (error: unknown) {
    if (!options.explicitPath && isMissing(error)) {
      return { exclusions: DEFAULT_EXCLUSIONS, targetCaseSensitive: defaultCaseSensitivity() };
    }
    return configError("Unable to read the configuration file.", candidate, error);
  }

  let parsed: ConfigFile;
  try {
    parsed = JSON.parse(raw) as ConfigFile;
  } catch (error: unknown) {
    return configError("The configuration file is not valid JSON.", candidate, error);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return configError("The configuration file must contain an object.", candidate);
  }
  if (parsed.targetCaseSensitive !== undefined && typeof parsed.targetCaseSensitive !== "boolean") {
    return configError("targetCaseSensitive must be a boolean.", candidate);
  }
  const defaults = requireStringArray(parsed.defaultExclusions, "defaultExclusions", candidate);
  const custom = requireStringArray(parsed.customExclusions, "customExclusions", candidate);
  return {
    path: candidate,
    exclusions: [...(defaults.length > 0 ? defaults : DEFAULT_EXCLUSIONS), ...custom],
    targetCaseSensitive: parsed.targetCaseSensitive ?? defaultCaseSensitivity(),
  };
}

function defaultCaseSensitivity(): boolean {
  return process.platform !== "win32" && process.platform !== "darwin";
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export interface DirectoryScan {
  readonly snapshot: DirectorySnapshot;
  readonly skippedSymlinks: readonly string[];
}

export type DirectoryResultStatus = "created" | "already-exists" | "would-create" | "failed";

export interface DirectoryResult {
  readonly relativePath: string;
  readonly status: DirectoryResultStatus;
  readonly error?: string;
}

export interface ApplyResult {
  readonly directories: readonly DirectoryResult[];
}

export interface ApplyOptions {
  readonly exclusions: readonly string[];
  readonly selected?: readonly string[];
  readonly dryRun?: boolean;
  readonly signal?: CancellationSignalLike;
}

export class NodeFileSystemAdapter {
  async scanDirectories(
    rootPath: string,
    exclusions: readonly string[],
    role: "source" | "target" = "source",
    signal?: CancellationSignalLike,
  ): Promise<DirectoryScan> {
    throwIfCancelled(signal);
    const absoluteRoot = resolve(rootPath);
    let rootStat;
    try {
      rootStat = await fs.lstat(absoluteRoot);
    } catch (error: unknown) {
      if (isMissing(error)) {
        throw createRootlineError({
          code: role === "source" ? ROOTLINE_ERROR_CODES.SOURCE_NOT_FOUND : ROOTLINE_ERROR_CODES.TARGET_NOT_FOUND,
          message: `${role === "source" ? "Source" : "Target"} directory does not exist.`,
          details: { path: absoluteRoot },
        });
      }
      throw unreadable(absoluteRoot, error);
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw unreadable(absoluteRoot);
    }

    const entries: string[] = [];
    const skippedSymlinks: string[] = [];
    const visit = async (currentPath: string, relativePath: string): Promise<void> => {
      throwIfCancelled(signal);
      if (await exists(join(currentPath, ".ignore"))) {
        return;
      }
      let names: string[];
      try {
        names = (await fs.readdir(currentPath)).sort((left, right) => left.localeCompare(right));
      } catch (error: unknown) {
        throw unreadable(currentPath, error);
      }
      for (const name of names) {
        throwIfCancelled(signal);
        const childRelativePath = relativePath ? `${relativePath}/${name}` : name;
        if (matchesExclusion(childRelativePath, exclusions)) {
          continue;
        }
        const childPath = join(currentPath, name);
        let stat;
        try {
          stat = await fs.lstat(childPath);
        } catch (error: unknown) {
          throw unreadable(childPath, error);
        }
        if (stat.isSymbolicLink()) {
          skippedSymlinks.push(childRelativePath);
          continue;
        }
        if (!stat.isDirectory()) {
          continue;
        }
        entries.push(childRelativePath);
        await visit(childPath, childRelativePath);
      }
    };

    await visit(absoluteRoot, "");
    return { snapshot: createSnapshot(entries), skippedSymlinks: Object.freeze(skippedSymlinks) };
  }

  async ensureTarget(targetPath: string, dryRun = false): Promise<"created" | "already-exists" | "would-create"> {
    const absoluteTarget = resolve(targetPath);
    try {
      const stat = await fs.lstat(absoluteTarget);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw unreadable(absoluteTarget);
      }
      return "already-exists";
    } catch (error: unknown) {
      if (!isMissing(error)) {
        throw error;
      }
    }
    if (dryRun) {
      return "would-create";
    }
    try {
      await fs.mkdir(absoluteTarget, { recursive: true });
      return "created";
    } catch (error: unknown) {
      throw unreadable(absoluteTarget, error);
    }
  }

  async applyDirectories(
    targetPath: string,
    source: DirectorySnapshot,
    plan: SyncPlan,
    options: ApplyOptions,
  ): Promise<ApplyResult> {
    throwIfCancelled(options.signal);
    const currentTarget = (await this.scanDirectories(targetPath, options.exclusions, "target", options.signal)).snapshot;
    assertPlanFresh(plan, source, currentTarget);
    const selected = options.selected ?? plan.missing;
    const directories = selectPlanSubtree(plan, selected);
    const result: DirectoryResult[] = [];
    for (const relativePath of directories) {
      throwIfCancelled(options.signal);
      const fullPath = join(resolve(targetPath), ...relativePath.split("/"));
      if (options.dryRun) {
        result.push({ relativePath, status: "would-create" });
        continue;
      }
      try {
        const existing = await fs.lstat(fullPath).catch((error: unknown) => (isMissing(error) ? undefined : Promise.reject(error)));
        if (existing?.isDirectory()) {
          result.push({ relativePath, status: "already-exists" });
          continue;
        }
        if (existing) {
          result.push({ relativePath, status: "failed", error: "A non-directory already exists at this path." });
          continue;
        }
        await fs.mkdir(fullPath);
        result.push({ relativePath, status: "created" });
      } catch (error: unknown) {
        result.push({
          relativePath,
          status: "failed",
          error: error instanceof Error ? error.message : "Unable to create directory.",
        });
      }
    }
    return { directories: Object.freeze(result) };
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch (error: unknown) {
    if (isMissing(error)) {
      return false;
    }
    throw unreadable(path, error);
  }
}

function unreadable(path: string, cause?: unknown): ReturnType<typeof createRootlineError> {
  return createRootlineError({
    code: ROOTLINE_ERROR_CODES.UNREADABLE_PATH,
    message: "A required path cannot be read as a directory.",
    details: { path, ...(cause instanceof Error ? { cause: cause.message } : {}) },
  });
}

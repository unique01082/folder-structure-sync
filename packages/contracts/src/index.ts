/** The only synchronization direction supported by Rootline v1. */
import profileLimits from "./profile-limits.json" with { type: "json" };

export const PROFILE_LIMITS = profileLimits;

export interface ProfileValidationIssue {
  field: string;
  min?: number;
  max: number;
}

function characterLength(value: string): number {
  return [...value].length;
}

/** Runtime validation shared by profile editors and transport boundaries. */
export function validateSyncProfile(
  profile: Pick<SyncProfile, "name" | "sourcePath" | "targetPath" | "exclusions">,
): ProfileValidationIssue[] {
  const issues: ProfileValidationIssue[] = [];
  const lengths = [
    ["name", profile.name, PROFILE_LIMITS.name],
    ["sourcePath", profile.sourcePath, PROFILE_LIMITS.path],
    ["targetPath", profile.targetPath, PROFILE_LIMITS.path],
  ] as const;
  for (const [field, value, limits] of lengths) {
    const length = characterLength(value);
    if (length < limits.min || length > limits.max) {
      issues.push({ field, min: limits.min, max: limits.max });
    }
  }
  if (profile.exclusions.length > PROFILE_LIMITS.exclusions.max) {
    issues.push({ field: "exclusions", max: PROFILE_LIMITS.exclusions.max });
  }
  profile.exclusions.forEach((pattern, index) => {
    const length = characterLength(pattern);
    const limits = PROFILE_LIMITS.exclusions.pattern;
    if (length < limits.min || length > limits.max) {
      issues.push({ field: `exclusions[${index}]`, min: limits.min, max: limits.max });
    }
  });
  return issues;
}

export const SYNC_MODES = ["additive"] as const;

export type SyncMode = (typeof SYNC_MODES)[number];

/** A complete local profile, including the absolute paths intentionally synced by cloud. */
export interface SyncProfile {
  id: string;
  name: string;
  sourcePath: string;
  targetPath: string;
  exclusions: readonly string[];
  createdAt: string;
  updatedAt: string;
  syncMode?: SyncMode;
}

export const CLOUD_MUTATION_KINDS = ["upsert", "delete"] as const;

export type CloudMutationKind = (typeof CLOUD_MUTATION_KINDS)[number];

export interface ProfileUpsertMutation {
  mutationId: string;
  kind: "upsert";
  profile: SyncProfile;
  occurredAt: string;
}

export interface ProfileDeleteMutation {
  mutationId: string;
  kind: "delete";
  profileId: string;
  occurredAt: string;
}

export type ProfileMutation = ProfileUpsertMutation | ProfileDeleteMutation;

/** Client-to-server profile changes. The server assigns ordering by arrival. */
export interface CloudSyncRequest {
  deviceId: string;
  epoch: string;
  cursor?: string;
  mutations: readonly ProfileMutation[];
}

export const PROFILE_RECORD_KINDS = ["profile", "tombstone"] as const;

export type ProfileRecordKind = (typeof PROFILE_RECORD_KINDS)[number];

export interface SyncedProfileRecord {
  kind: "profile";
  profile: SyncProfile;
  revision: number;
}

export interface ProfileTombstoneRecord {
  kind: "tombstone";
  profileId: string;
  deletedAt: string;
  revision: number;
}

/** A server projection is either a complete profile or a delete tombstone. */
export type ProfileRecord = SyncedProfileRecord | ProfileTombstoneRecord;

export interface CloudMutationReceipt {
  mutationId: string;
  revision: number;
}

export interface CloudSyncResponse {
  epoch: string;
  cursor: string;
  hasMore: boolean;
  records: readonly ProfileRecord[];
  receipts: readonly CloudMutationReceipt[];
}

export interface AccountDataDeletionRequest {
  epoch: string;
}

export interface AccountDataDeletionResponse {
  epoch: string;
}

export const ROOTLINE_ERROR_CODES = {
  CANCELLED: "CANCELLED",
  CONFIG_INVALID: "CONFIG_INVALID",
  INVALID_PATH: "INVALID_PATH",
  PATH_OVERLAP: "PATH_OVERLAP",
  SOURCE_NOT_FOUND: "SOURCE_NOT_FOUND",
  TARGET_NOT_FOUND: "TARGET_NOT_FOUND",
  UNREADABLE_PATH: "UNREADABLE_PATH",
  SYMLINK_SKIPPED: "SYMLINK_SKIPPED",
  STALE_PLAN: "STALE_PLAN",
  PARTIAL_FAILURE: "PARTIAL_FAILURE",
  AUTH_REQUIRED: "AUTH_REQUIRED",
  AUTH_CALLBACK_INVALID: "AUTH_CALLBACK_INVALID",
  PROFILE_CONFLICT: "PROFILE_CONFLICT",
  SYNC_EPOCH_RESET_REQUIRED: "SYNC_EPOCH_RESET_REQUIRED",
  SYNC_ACCOUNT_CLAIM_REQUIRED: "SYNC_ACCOUNT_CLAIM_REQUIRED",
  SYNC_STATE_CHANGED: "SYNC_STATE_CHANGED",
  RATE_LIMITED: "RATE_LIMITED",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  INTERNAL: "INTERNAL",
} as const;

export type RootlineErrorCode =
  (typeof ROOTLINE_ERROR_CODES)[keyof typeof ROOTLINE_ERROR_CODES];

export interface RootlineErrorInput {
  code: RootlineErrorCode;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

/** A serializable error shape shared by CLI, desktop, and API boundaries. */
export class RootlineError extends Error {
  readonly code: RootlineErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor({ code, message, retryable = false, details }: RootlineErrorInput) {
    super(message);
    this.name = "RootlineError";
    this.code = code;
    this.retryable = retryable;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export function createRootlineError(input: RootlineErrorInput): RootlineError {
  return new RootlineError(input);
}

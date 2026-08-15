import { expectTypeOf, test } from "vitest";

import type {
  CloudSyncRequest,
  CaseSensitivity,
  DirectorySnapshot,
  PlanOperation,
  ProfileRecord,
  RootlineErrorCode,
  SyncMutation,
  SyncProfileV1,
  SyncRequest,
  SyncResponse,
  SyncPlan,
  SyncProfile,
} from "../src/index.js";

test("public domain and cloud contracts retain their transport shapes", () => {
  expectTypeOf<CaseSensitivity>().toEqualTypeOf<"sensitive" | "insensitive">();
  expectTypeOf<DirectorySnapshot>().toEqualTypeOf<{
    rootPath: string;
    caseSensitivity: CaseSensitivity;
    directories: readonly string[];
    skippedLinks: readonly string[];
  }>();
  expectTypeOf<PlanOperation>().toEqualTypeOf<{
    id: string;
    type: "create-directory";
    relativePath: string;
  }>();
  expectTypeOf<SyncPlan>().toEqualTypeOf<{
    sourceRoot: string;
    targetRoot: string;
    operations: readonly PlanOperation[];
    fingerprint: string;
  }>();
  expectTypeOf<SyncProfile>().toMatchTypeOf<{
    id: string;
    name: string;
    sourcePath: string;
    targetPath: string;
    exclusions: readonly string[];
    createdAt: string;
    updatedAt: string;
  }>();

  expectTypeOf<CloudSyncRequest>().toMatchTypeOf<{
    deviceId: string;
    epoch: string;
    mutations: readonly unknown[];
  }>();

  expectTypeOf<ProfileRecord>().toMatchTypeOf<
    | { kind: "profile"; profile: SyncProfile; revision: number }
    | { kind: "tombstone"; profileId: string; deletedAt: string; revision: number }
  >();

  expectTypeOf<SyncProfileV1>().toEqualTypeOf<{
    id: string;
    schemaVersion: 1;
    name: string;
    sourcePath: string;
    targetPath: string;
    exclusions: string[];
    revision: string;
    deletedAt: string | null;
  }>();
  expectTypeOf<SyncMutation>().toEqualTypeOf<
    | { mutationId: string; type: "upsert"; profile: SyncProfileV1 }
    | { mutationId: string; type: "delete"; profileId: string }
  >();
  expectTypeOf<SyncRequest>().toEqualTypeOf<{
    deviceId: string;
    accountEpoch: string | null;
    cursor: string;
    mutations: SyncMutation[];
  }>();
  expectTypeOf<SyncResponse>().toEqualTypeOf<{
    accountEpoch: string;
    cursor: string;
    acknowledgedMutationIds: string[];
    profiles: SyncProfileV1[];
  }>();

  expectTypeOf<RootlineErrorCode>().toEqualTypeOf<
    | "CANCELLED"
    | "CONFIG_INVALID"
    | "INVALID_PATH"
    | "PATH_OVERLAP"
    | "SOURCE_NOT_FOUND"
    | "TARGET_NOT_FOUND"
    | "UNREADABLE_PATH"
    | "SYMLINK_SKIPPED"
    | "STALE_PLAN"
    | "PARTIAL_FAILURE"
    | "AUTH_REQUIRED"
    | "AUTH_CALLBACK_INVALID"
    | "PROFILE_CONFLICT"
    | "SYNC_EPOCH_RESET_REQUIRED"
    | "SYNC_ACCOUNT_CLAIM_REQUIRED"
    | "SYNC_STATE_CHANGED"
    | "RATE_LIMITED"
    | "VALIDATION_FAILED"
    | "INTERNAL"
    | "INVALID_ROOT"
    | "OVERLAPPING_ROOTS"
    | "CREATE_FAILED"
    | "SYNC_OFFLINE"
    | "SYNC_REJECTED"
    | "RESET_REQUIRED"
    | "SCHEMA_UNSUPPORTED"
  >();
});

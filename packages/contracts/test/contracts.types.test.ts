import { expectTypeOf, test } from "vitest";

import type {
  CloudSyncRequest,
  ProfileRecord,
  RootlineErrorCode,
  SyncProfile,
} from "../src/index.js";

test("public domain and cloud contracts retain their transport shapes", () => {
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
    | "RATE_LIMITED"
    | "VALIDATION_FAILED"
    | "INTERNAL"
  >();
});

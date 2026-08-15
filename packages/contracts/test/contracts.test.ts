import { describe, expect, it } from "vitest";

import * as contracts from "../src/index.js";

describe("Rootline contracts", () => {
  it("exposes stable shared error codes and structured errors", () => {
    expect(contracts.ROOTLINE_ERROR_CODES).toEqual({
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
    });

    const error = contracts.createRootlineError({
      code: contracts.ROOTLINE_ERROR_CODES.PATH_OVERLAP,
      message: "Source and target overlap.",
      details: { sourcePath: "/source", targetPath: "/source/target" },
    });

    expect(error).toBeInstanceOf(contracts.RootlineError);
    expect(error).toMatchObject({
      code: "PATH_OVERLAP",
      message: "Source and target overlap.",
      retryable: false,
      details: { sourcePath: "/source", targetPath: "/source/target" },
    });
  });

  it("uses explicit discriminants for additive profiles and cloud mutations", () => {
    expect(contracts.SYNC_MODES).toEqual(["additive"]);
    expect(contracts.CLOUD_MUTATION_KINDS).toEqual(["upsert", "delete"]);
    expect(contracts.PROFILE_RECORD_KINDS).toEqual(["profile", "tombstone"]);
  });
});

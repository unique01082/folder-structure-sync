import { describe, expect, it } from "vitest";

import * as contracts from "../src/index.js";

describe("Rootline contracts", () => {
  it("exposes stable shared error codes and structured errors", () => {
    expect(contracts.ROOTLINE_ERROR_CODES).toMatchObject({
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
      SYNC_ACCOUNT_CLAIM_REQUIRED: "SYNC_ACCOUNT_CLAIM_REQUIRED",
      SYNC_STATE_CHANGED: "SYNC_STATE_CHANGED",
      RATE_LIMITED: "RATE_LIMITED",
      VALIDATION_FAILED: "VALIDATION_FAILED",
      INTERNAL: "INTERNAL",
      INVALID_ROOT: "INVALID_ROOT",
      OVERLAPPING_ROOTS: "OVERLAPPING_ROOTS",
      CREATE_FAILED: "CREATE_FAILED",
      SYNC_OFFLINE: "SYNC_OFFLINE",
      SYNC_REJECTED: "SYNC_REJECTED",
      RESET_REQUIRED: "RESET_REQUIRED",
      SCHEMA_UNSUPPORTED: "SCHEMA_UNSUPPORTED",
    });
    expect(contracts.ROOTLINE_ERROR_CODES).not.toHaveProperty("SYNC_EPOCH_RESET_REQUIRED");

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

  it("exports the exact shared profile limits and runtime validation", () => {
    expect(contracts.PROFILE_LIMITS).toEqual({
      lengthUnit: "unicode-code-points",
      name: { min: 1, max: 80 },
      path: { min: 1, max: 4096 },
      exclusions: { max: 100, pattern: { min: 1, max: 256 } },
    });
    expect(contracts.codePointLength("✈️")).toBe(2);
    const exactCodePoints = (count: number) => "✈️".repeat(Math.floor(count / 2)) + (count % 2 ? "x" : "");
    const valid = {
      id: "profile",
      name: exactCodePoints(80),
      sourcePath: exactCodePoints(4096),
      targetPath: exactCodePoints(4096),
      exclusions: Array.from({ length: 100 }, () => exactCodePoints(256)),
      createdAt: "2026-08-15T00:00:00Z",
      updatedAt: "2026-08-15T00:00:00Z",
    };
    expect(contracts.validateSyncProfile(valid)).toEqual([]);
    expect(contracts.validateSyncProfile({
      ...valid,
      name: exactCodePoints(81),
      sourcePath: "",
      targetPath: exactCodePoints(4097),
      exclusions: [...valid.exclusions, "", exactCodePoints(257)],
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "name" }),
      expect.objectContaining({ field: "sourcePath" }),
      expect.objectContaining({ field: "targetPath" }),
      expect.objectContaining({ field: "exclusions" }),
      expect.objectContaining({ field: "exclusions[100]" }),
      expect.objectContaining({ field: "exclusions[101]" }),
    ]));
  });
});

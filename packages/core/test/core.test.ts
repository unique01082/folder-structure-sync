import { describe, expect, it } from "vitest";

import {
  assertPlanFresh,
  createSnapshot,
  createSyncPlan,
  matchesExclusion,
  normalizeRelativePath,
  selectPlanSubtree,
  throwIfCancelled,
  validateRootRelationship,
} from "../src/index.js";

describe("Rootline synchronization core", () => {
  it("normalizes portable relative paths and rejects traversal", () => {
    expect(normalizeRelativePath("src\\components//ui")).toBe("src/components/ui");
    expect(normalizeRelativePath(" docs ")).toBe(" docs ");
    expect(() => normalizeRelativePath("../outside")).toThrow("relative path");
  });

  it("excludes an exact path segment without excluding similarly named directories", () => {
    expect(matchesExclusion(".git/hooks", [".git"])).toBe(true);
    expect(matchesExclusion(".github/workflows", [".git"])).toBe(false);
    expect(matchesExclusion("build/cache", ["build"])).toBe(true);
    expect(matchesExclusion("notes/error.log", ["*.log"])).toBe(true);
  });

  it("creates deterministic snapshots and dependency-complete subtree selections", () => {
    const source = createSnapshot(["app/routes", "app", "docs", "app/routes/admin"]);
    const target = createSnapshot(["docs"]);
    const plan = createSyncPlan(source, target);

    expect(source.entries).toEqual(["app", "app/routes", "app/routes/admin", "docs"]);
    expect(plan.missing).toEqual(["app", "app/routes", "app/routes/admin"]);
    expect(selectPlanSubtree(plan, ["app/routes/admin"])).toEqual([
      "app",
      "app/routes",
      "app/routes/admin",
    ]);
    expect(createSnapshot([...source.entries].reverse()).fingerprint).toBe(source.fingerprint);
    expect(createSnapshot(["z", "ä", "a"]).entries).toEqual(["a", "z", "ä"]);
  });

  it("rejects equal or overlapping synchronization roots", () => {
    expect(() => validateRootRelationship("/work/source", "/work/source/nested", true)).toThrow(
      "overlap",
    );
    expect(() => validateRootRelationship("C:\\Source", "c:/source", false)).toThrow("overlap");
  });

  it("does not depend on the host locale for case-insensitive overlap safety", () => {
    const localeLowerCase = String.prototype.toLocaleLowerCase;
    String.prototype.toLocaleLowerCase = function localeSensitiveLowerCase(): string {
      return this.toString();
    };
    try {
      expect(() => validateRootRelationship("/work/I", "/work/i", false)).toThrow("overlap");
    } finally {
      String.prototype.toLocaleLowerCase = localeLowerCase;
    }
  });

  it("uses the target case policy and rejects stale or cancelled work", () => {
    const source = createSnapshot(["Components"]);
    const target = createSnapshot(["components"]);
    const plan = createSyncPlan(source, createSnapshot([]));

    expect(createSyncPlan(source, target, false).missing).toEqual([]);
    expect(() => assertPlanFresh(plan, source, target)).toThrow("changed");
    expect(() => throwIfCancelled({ aborted: true })).toThrow("cancelled");

    const forgedPlan = { ...plan, missing: ["outside"], fingerprint: plan.fingerprint };
    expect(() => assertPlanFresh(forgedPlan, source, createSnapshot([]))).toThrow("changed");
  });
});

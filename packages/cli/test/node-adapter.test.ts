import { chmod, lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSnapshot, createSyncPlan } from "@rootline/core";
import { NodeFileSystemAdapter, resolveConfig } from "../src/node-adapter.js";

const temporaryDirectories: string[] = [];

async function tempDirectory(): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "rootline-cli-test-")));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Node filesystem adapter", () => {
  it("resolves an explicit config ahead of the working-directory config", async () => {
    const cwd = await tempDirectory();
    const explicit = join(cwd, "explicit.json");
    await writeFile(join(cwd, "sync-config.json"), JSON.stringify({ customExclusions: ["cwd-only"] }));
    await writeFile(explicit, JSON.stringify({ customExclusions: ["explicit-only"] }));

    await expect(resolveConfig({ cwd, explicitPath: explicit })).resolves.toMatchObject({
      path: explicit,
      exclusions: expect.arrayContaining(["explicit-only"]),
    });
    await expect(resolveConfig({ cwd })).resolves.toMatchObject({
      path: join(cwd, "sync-config.json"),
      exclusions: expect.arrayContaining(["cwd-only"]),
    });

    await writeFile(explicit, JSON.stringify({ defaultExclusions: [], customExclusions: [] }));
    await expect(resolveConfig({ cwd, explicitPath: explicit })).resolves.toMatchObject({ exclusions: [] });
  });

  it("skips symlinks and exact excluded segments while retaining .github", async () => {
    const root = await tempDirectory();
    await mkdir(join(root, ".git", "objects"), { recursive: true });
    await mkdir(join(root, ".github", "workflows"), { recursive: true });
    await mkdir(join(root, "real"), { recursive: true });
    await symlink(join(root, "real"), join(root, "linked"));

    const scan = await new NodeFileSystemAdapter().scanDirectories(root, [".git"]);

    expect(scan.snapshot.entries).toEqual([".github", ".github/workflows", "real"]);
    expect(scan.skippedSymlinks).toEqual(["linked"]);
  });

  it("honors legacy .ignore pruning and maps non-directory roots to unreadable errors", async () => {
    const root = await tempDirectory();
    const file = join(root, "file");
    await mkdir(join(root, "ignored", "child"), { recursive: true });
    await writeFile(join(root, "ignored", ".ignore"), "");
    await writeFile(file, "not a directory");

    await expect(new NodeFileSystemAdapter().scanDirectories(root, [])).resolves.toMatchObject({
      snapshot: { entries: ["ignored"] },
    });
    await expect(new NodeFileSystemAdapter().scanDirectories(file, [])).rejects.toMatchObject({
      code: "UNREADABLE_PATH",
    });
  });

  it("reports an unreadable child directory instead of silently creating an incomplete snapshot", async () => {
    const root = await tempDirectory();
    const locked = join(root, "locked");
    await mkdir(locked);
    await chmod(locked, 0o000);

    try {
      await expect(new NodeFileSystemAdapter().scanDirectories(root, [])).rejects.toMatchObject({
        code: "UNREADABLE_PATH",
      });
    } finally {
      await chmod(locked, 0o700);
    }
  });

  it("reports target mkdir states and observes cancellation at operation boundaries", async () => {
    const target = join(await tempDirectory(), "target");
    const adapter = new NodeFileSystemAdapter();

    await expect(adapter.ensureTarget(target, true)).resolves.toBe("would-create");
    await expect(adapter.ensureTarget(target)).resolves.toBe("created");
    await expect(adapter.ensureTarget(target)).resolves.toBe("already-exists");
    await expect(adapter.scanDirectories(target, [], "source", { aborted: true })).rejects.toMatchObject({
      code: "CANCELLED",
    });
  });

  it("detects the target filesystem case policy without mutating the scanned directory", async () => {
    const root = await tempDirectory();
    const sentinel = join(root, "CasePolicySentinel");
    await writeFile(sentinel, "unchanged");
    const before = await readFile(sentinel, "utf8");
    const adapter = new NodeFileSystemAdapter();

    const detected = await adapter.detectCaseSensitivity(root);
    const actual = !(await lstat(join(root, "casepolicysentinel")).then(() => true, () => false));

    expect(detected).toBe(actual);
    expect(await readFile(sentinel, "utf8")).toBe(before);
  });

  it("revalidates stale plans before mkdir and reports per-directory results", async () => {
    const target = await tempDirectory();
    const sourceRoot = await tempDirectory();
    const adapter = new NodeFileSystemAdapter();
    const source = createSnapshot(["blocked", "blocked/child", "created"]);
    const originalTarget = createSnapshot([]);
    const plan = createSyncPlan(source, originalTarget);
    await Promise.all(source.entries.map((entry) => mkdir(join(sourceRoot, entry), { recursive: true })));
    await mkdir(join(target, "changed-after-plan"));
    await writeFile(join(target, "blocked"), "not a directory");

    await expect(
      adapter.applyDirectories(target, plan, { exclusions: [], sourcePath: sourceRoot }),
    ).rejects.toMatchObject({ code: "STALE_PLAN" });

    const currentPlan = createSyncPlan(source, (await adapter.scanDirectories(target, [])).snapshot);
    const result = await adapter.applyDirectories(target, currentPlan, { exclusions: [], sourcePath: sourceRoot });

    expect(result.directories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relativePath: "created", status: "created" }),
        expect.objectContaining({ relativePath: "blocked/child", status: "failed" }),
      ]),
    );
    await expect(readFile(join(target, "created"), "utf8")).rejects.toThrow();
  });

  it("rejects a source tree that changed after planning", async () => {
    const sourceRoot = await tempDirectory();
    const target = await tempDirectory();
    const adapter = new NodeFileSystemAdapter();
    await mkdir(join(sourceRoot, "planned"));
    const source = (await adapter.scanDirectories(sourceRoot, [])).snapshot;
    const plan = createSyncPlan(source, createSnapshot([]));
    await mkdir(join(sourceRoot, "added-after-plan"));

    await expect(adapter.applyDirectories(target, plan, { exclusions: [], sourcePath: sourceRoot })).rejects.toMatchObject({
      code: "STALE_PLAN",
    });
  });

  it("does not follow a target child symlink introduced after planning", async () => {
    const sourceRoot = await tempDirectory();
    const target = await tempDirectory();
    const external = await tempDirectory();
    const adapter = new NodeFileSystemAdapter();
    await mkdir(join(sourceRoot, "parent", "child"), { recursive: true });
    const source = (await adapter.scanDirectories(sourceRoot, [])).snapshot;
    const plan = createSyncPlan(source, createSnapshot([]));
    await symlink(external, join(target, "parent"), "dir");

    const result = await adapter.applyDirectories(target, plan, { exclusions: [], sourcePath: sourceRoot });

    expect(result.directories).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: "parent", status: "failed" }),
      expect.objectContaining({ relativePath: "parent/child", status: "failed" }),
    ]));
    await expect(lstat(join(external, "child"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

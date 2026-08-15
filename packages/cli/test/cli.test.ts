import { lstat, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { run as runProgram } from "../src/index.js";

const directories: string[] = [];
const cliPath = join(process.cwd(), "dist", "index.js");

async function tempDirectory(): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "rootline-command-test-")));
  directories.push(directory);
  return directory;
}

function run(...arguments_: string[]) {
  return spawnSync(process.execPath, [cliPath, ...arguments_], { encoding: "utf8" });
}

beforeAll(() => {
  const build = spawnSync("pnpm", ["--filter", "folder-structure-sync", "build"], {
    cwd: join(process.cwd(), "../.."),
    encoding: "utf8",
  });
  if (build.status !== 0) {
    throw new Error(build.stderr || build.stdout);
  }
});

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("folder-sync command", () => {
  it("reads --version from the package metadata", () => {
    const result = run("--version");

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("2.0.0");
  });

  it("creates a missing target in auto JSON mode without prompting", async () => {
    const workspace = await tempDirectory();
    const source = join(workspace, "source");
    const target = join(workspace, "target");
    await mkdir(join(source, "src", "components"), { recursive: true });

    const result = run(source, target, "--auto", "--json");

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ target: { status: "created" } });
  });

  it("rejects JSON mode unless it is explicitly dry-run or auto", async () => {
    const workspace = await tempDirectory();
    const source = join(workspace, "source");
    const target = join(workspace, "target");
    await mkdir(join(source, "src"), { recursive: true });

    const result = run(source, target, "--json");

    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: { code: "CONFIG_INVALID" },
    });
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("emits JSON validation errors with the filesystem-failure exit code", async () => {
    const workspace = await tempDirectory();
    const target = join(workspace, "target");
    await mkdir(target);

    const result = run(join(workspace, "missing"), target, "--auto", "--json");

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ error: { code: "SOURCE_NOT_FOUND" } });
  });

  it("rejects an invalid explicit config as a filesystem/config failure", async () => {
    const workspace = await tempDirectory();
    const source = join(workspace, "source");
    const target = join(workspace, "target");
    const config = join(workspace, "invalid.json");
    await Promise.all([mkdir(source), mkdir(target), writeFile(config, "{not json")]);

    const result = run(source, target, "--auto", "--json", "--config", config);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ error: { code: "CONFIG_INVALID" } });
  });

  it("returns the filesystem-failure exit code for overlapping roots", async () => {
    const workspace = await tempDirectory();
    const source = join(workspace, "source");
    await mkdir(join(source, "nested"), { recursive: true });

    const result = run(source, join(source, "nested"), "--auto", "--json");

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ error: { code: "PATH_OVERLAP" } });
  });

  it("returns the filesystem-failure exit code with partial mkdir statuses", async () => {
    const workspace = await tempDirectory();
    const source = join(workspace, "source");
    const target = join(workspace, "target");
    await mkdir(join(source, "blocked", "child"), { recursive: true });
    await mkdir(source, { recursive: true });
    await mkdir(target);
    await writeFile(join(target, "blocked"), "not a directory");

    const result = run(source, target, "--auto", "--json");
    const output = JSON.parse(result.stdout);

    expect(result.status).toBe(1);
    expect(output).toMatchObject({ error: { code: "PARTIAL_FAILURE" } });
    expect(output.directories).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: "blocked", status: "failed" }),
    ]));
  });

  it("keeps the legacy verbose flag observable in text output", async () => {
    const workspace = await tempDirectory();
    const source = join(workspace, "source");
    const target = join(workspace, "target");
    await Promise.all([mkdir(join(source, "src"), { recursive: true }), mkdir(target)]);

    const result = run(source, target, "--auto", "--verbose");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Source entries: 1");
  });

  it("treats an interactive user decline as a successful no-op", async () => {
    const workspace = await tempDirectory();
    const source = join(workspace, "source");
    const target = join(workspace, "target");
    await Promise.all([mkdir(join(source, "src"), { recursive: true }), mkdir(target)]);

    const result = await runProgram([source, target], workspace, async () => false);

    expect(result.exitCode).toBe(0);
    expect(result.output).toMatchObject({ cancelled: true });
  });

  it("uses the usage exit code only for argument parsing errors", async () => {
    const workspace = await tempDirectory();
    const source = join(workspace, "source");
    const target = join(workspace, "target");
    await Promise.all([mkdir(source), mkdir(target)]);

    const unknownFlag = run(source, target, "--not-a-flag", "--json");
    const missingConfigValue = run(source, target, "--config", "--json");

    expect(unknownFlag.status).toBe(2);
    expect(JSON.parse(unknownFlag.stdout)).toMatchObject({ error: { code: "CONFIG_INVALID" } });
    expect(missingConfigValue.status).toBe(2);
    expect(JSON.parse(missingConfigValue.stdout)).toMatchObject({ error: { code: "CONFIG_INVALID" } });
  });

  it("rejects a missing target whose existing ancestor is a source alias before mkdir", async () => {
    const workspace = await tempDirectory();
    const source = join(workspace, "source");
    const alias = join(workspace, "alias");
    const target = join(alias, "nested");
    await mkdir(join(source, "planned"), { recursive: true });
    await symlink(source, alias, "dir");

    const result = run(source, target, "--auto", "--json");

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ error: { code: "INVALID_PATH" } });
    await expect(lstat(join(source, "nested"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a supplied target symlink before it can create directories outside target", async () => {
    const workspace = await tempDirectory();
    const source = join(workspace, "source");
    const external = join(workspace, "external");
    const targetAlias = join(workspace, "target-alias");
    await Promise.all([mkdir(join(source, "required"), { recursive: true }), mkdir(external)]);
    await symlink(external, targetAlias, "dir");

    const result = run(source, targetAlias, "--auto", "--json");

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ error: { code: "INVALID_PATH" } });
    await expect(lstat(join(external, "required"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a non-overlapping target ancestor link before mkdir", async () => {
    const workspace = await tempDirectory();
    const source = join(workspace, "source");
    const external = join(workspace, "external");
    const targetAlias = join(workspace, "target-alias");
    await Promise.all([mkdir(join(source, "required"), { recursive: true }), mkdir(external)]);
    await symlink(external, targetAlias, "dir");

    const result = run(source, join(targetAlias, "nested"), "--auto", "--json");

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ error: { code: "INVALID_PATH" } });
    await expect(lstat(join(external, "nested"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a supplied source symlink before scanning it", async () => {
    const workspace = await tempDirectory();
    const source = join(workspace, "source");
    const sourceAlias = join(workspace, "source-alias");
    const target = join(workspace, "target");
    await Promise.all([mkdir(join(source, "required"), { recursive: true }), mkdir(target)]);
    await symlink(source, sourceAlias, "dir");

    const result = run(sourceAlias, target, "--auto", "--json");

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ error: { code: "INVALID_PATH" } });
    await expect(lstat(join(target, "required"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

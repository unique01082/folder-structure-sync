import { lstat, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

const directories: string[] = [];
const cliPath = join(process.cwd(), "dist", "index.js");

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rootline-command-test-"));
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

  it("keeps a missing target untouched in JSON mode without --auto", async () => {
    const workspace = await tempDirectory();
    const source = join(workspace, "source");
    const target = join(workspace, "target");
    await mkdir(join(source, "src"), { recursive: true });

    const result = run(source, target, "--json");

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ target: { status: "would-create" } });
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("emits JSON validation errors with their documented exit code", async () => {
    const workspace = await tempDirectory();
    const target = join(workspace, "target");
    await mkdir(target);

    const result = run(join(workspace, "missing"), target, "--auto", "--json");

    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ error: { code: "SOURCE_NOT_FOUND" } });
  });

  it("rejects an invalid explicit config without writing prose to JSON output", async () => {
    const workspace = await tempDirectory();
    const source = join(workspace, "source");
    const target = join(workspace, "target");
    const config = join(workspace, "invalid.json");
    await Promise.all([mkdir(source), mkdir(target), writeFile(config, "{not json")]);

    const result = run(source, target, "--auto", "--json", "--config", config);

    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ error: { code: "CONFIG_INVALID" } });
  });

  it("returns the validation exit code for overlapping roots", async () => {
    const workspace = await tempDirectory();
    const source = join(workspace, "source");
    await mkdir(join(source, "nested"), { recursive: true });

    const result = run(source, join(source, "nested"), "--auto", "--json");

    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ error: { code: "PATH_OVERLAP" } });
  });

  it("returns the partial-failure exit code with per-directory statuses", async () => {
    const workspace = await tempDirectory();
    const source = join(workspace, "source");
    const target = join(workspace, "target");
    await mkdir(join(source, "blocked", "child"), { recursive: true });
    await mkdir(source, { recursive: true });
    await mkdir(target);
    await writeFile(join(target, "blocked"), "not a directory");

    const result = run(source, target, "--auto", "--json");
    const output = JSON.parse(result.stdout);

    expect(result.status).toBe(3);
    expect(output).toMatchObject({ error: { code: "PARTIAL_FAILURE" } });
    expect(output.directories).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: "blocked", status: "failed" }),
    ]));
  });
});

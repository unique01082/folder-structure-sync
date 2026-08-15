import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const workspace = join(process.cwd(), "../..");
const scratch = await realpath(await mkdtemp(join(tmpdir(), "rootline-package-smoke-")));
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function execute(command: string, arguments_: string[], cwd = workspace) {
  const result = spawnSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: join(scratch, "npm-cache") },
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${arguments_.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return result;
}

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("published CLI package", () => {
  it("installs from the public CLI tarball alone and runs the folder-sync binary", async () => {
    execute(pnpmCommand, ["--filter", "@rootline/contracts", "build"]);
    execute(pnpmCommand, ["--filter", "@rootline/core", "build"]);
    execute(pnpmCommand, ["--filter", "folder-structure-sync", "build"]);
    execute(pnpmCommand, ["--filter", "folder-structure-sync", "pack", "--pack-destination", scratch]);

    const install = join(scratch, "install");
    const source = join(scratch, "source");
    const target = join(scratch, "target");
    await Promise.all([mkdir(install), mkdir(join(source, "nested"), { recursive: true })]);
    const tarball = join(scratch, "folder-structure-sync-2.0.0.tgz");
    const listing = execute("tar", ["-tzf", tarball]).stdout.split(/\r?\n/);
    expect(listing).toEqual(expect.arrayContaining(["package/LICENSE", "package/README.md"]));
    execute("tar", ["-xzf", tarball, "-C", scratch, "package/package.json"]);
    const packedManifest = JSON.parse(await readFile(join(scratch, "package", "package.json"), "utf8"));
    expect(packedManifest).toMatchObject({
      engines: { node: ">=20" },
      repository: {
        type: "git",
        url: "git+https://github.com/unique01082/folder-structure-sync.git",
      },
    });
    execute("npm", ["install", "--ignore-scripts", tarball], install);

    const result = execute(join(install, "node_modules", ".bin", "folder-sync"), [source, target, "--auto", "--json"], install);
    expect(JSON.parse(result.stdout)).toMatchObject({ target: { status: "created" } });
  }, 30_000);
});

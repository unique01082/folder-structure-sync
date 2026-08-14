import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const workspace = join(process.cwd(), "../..");
const scratch = await mkdtemp(join(tmpdir(), "rootline-package-smoke-"));

function execute(command: string, arguments_: string[], cwd = workspace) {
  const result = spawnSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: join(scratch, "npm-cache") },
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
  it("installs from packed workspace tarballs and runs the folder-sync binary", async () => {
    execute("pnpm", ["--filter", "@rootline/contracts", "build"]);
    execute("pnpm", ["--filter", "@rootline/core", "build"]);
    execute("pnpm", ["--filter", "folder-structure-sync", "build"]);
    execute("pnpm", ["--filter", "@rootline/contracts", "pack", "--pack-destination", scratch]);
    execute("pnpm", ["--filter", "@rootline/core", "pack", "--pack-destination", scratch]);
    execute("pnpm", ["--filter", "folder-structure-sync", "pack", "--pack-destination", scratch]);

    const install = join(scratch, "install");
    const source = join(scratch, "source");
    const target = join(scratch, "target");
    await Promise.all([mkdir(install), mkdir(join(source, "nested"), { recursive: true })]);
    const tarballs = [
      join(scratch, "rootline-contracts-2.0.0.tgz"),
      join(scratch, "rootline-core-2.0.0.tgz"),
      join(scratch, "folder-structure-sync-2.0.0.tgz"),
    ];
    execute("npm", ["install", "--ignore-scripts", ...tarballs], install);

    const result = execute(join(install, "node_modules", ".bin", "folder-sync"), [source, target, "--auto", "--json"], install);
    expect(JSON.parse(result.stdout)).toMatchObject({ target: { status: "created" } });
  }, 30_000);
});

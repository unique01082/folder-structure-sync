import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

test("builds a complete updater manifest for every supported runtime target", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "rootline-updater-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const artifacts = [
    ["rootline-2.0.0-darwin-universal.app.tar.gz", "signature-darwin-universal"],
    ["rootline-2.0.0-windows-x86_64-setup.exe", "signature-windows-x86_64"],
    ["rootline-2.0.0-windows-aarch64-setup.exe", "signature-windows-aarch64"],
  ];
  for (const [name, signature] of artifacts) {
    writeFileSync(join(directory, name), "artifact");
    writeFileSync(join(directory, `${name}.sig`), signature);
  }
  const output = join(directory, "latest.json");

  execFileSync(process.execPath, ["scripts/create-updater-manifest.mjs", directory, "https://github.com/example/rootline/releases/download/v2.0.0", output], {
    cwd: process.cwd(),
    env: { ...process.env, RELEASE_PUBLISHED_AT: "2026-08-15T00:00:00.000Z" },
  });

  const manifest = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(manifest.version, "2.0.0");
  assert.equal(manifest.pub_date, "2026-08-15T00:00:00.000Z");
  assert.deepEqual(Object.keys(manifest.platforms).sort(), [
    "darwin-aarch64",
    "darwin-x86_64",
    "windows-aarch64",
    "windows-x86_64",
  ]);
  assert.match(manifest.platforms["windows-aarch64"].url, /rootline-2\.0\.0-windows-aarch64-setup\.exe$/);
  assert.equal(manifest.platforms["darwin-aarch64"].signature, "signature-darwin-universal");
  assert.equal(manifest.platforms["darwin-x86_64"].signature, "signature-darwin-universal");
});

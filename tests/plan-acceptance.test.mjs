import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");
const json = (...parts) => JSON.parse(read(...parts));

test("Task 1 preserves the exact npm 1.1.0 baseline and workspace contract", () => {
  const tarballPath = join(root, "docs", "baseline", "folder-structure-sync-1.1.0.tgz");
  const tarball = readFileSync(tarballPath);
  assert.equal(createHash("sha1").update(tarball).digest("hex"), "5cbc1470b492f36bad11653f2b8545a62daf5929");
  assert.equal(
    createHash("sha512").update(tarball).digest("base64"),
    "DMLwBKls8g/9ZSx2iSTW6ChOkuZSFjoe8cnn3k1NO7oM0D0sRNGXy2GuipFqhtukoUGwI1YdfENsHfzCZTjY1w==",
  );
  const recoveredManifest = JSON.parse(execFileSync("tar", ["-xOzf", tarballPath, "package/package.json"], { encoding: "utf8" }));
  const recoveredSource = execFileSync("tar", ["-xOzf", tarballPath, "package/index.js"], { encoding: "utf8" });
  assert.equal(recoveredManifest.version, "1.1.0");
  assert.match(recoveredSource, /\.ignore/);

  const evidence = read("docs", "baseline", "npm-1.1.0-recovery.md");
  assert.match(evidence, /a9cb35279f65db6e939c884a0503f2e13b3a5d93/);
  assert.match(evidence, /not present in this clone/);
  assert.match(evidence, /does not amend, reset, or otherwise rewrite repository history/);

  const manifests = [
    json("package.json"), json("apps", "api", "package.json"), json("apps", "desktop", "package.json"),
    json("packages", "core", "package.json"), json("packages", "contracts", "package.json"), json("packages", "cli", "package.json"),
  ];
  assert.deepEqual(manifests.map((manifest) => manifest.version), Array(6).fill("2.0.0"));
  assert.deepEqual(manifests.map((manifest) => manifest.license), Array(6).fill("ISC"));
  assert.deepEqual(manifests.filter((manifest) => manifest.private !== true).map((manifest) => manifest.name), ["folder-structure-sync"]);
  assert.equal(manifests[0].private, true);
  assert.match(manifests[0].engines.node, />=20/);
  assert.match(read("pnpm-workspace.yaml"), /apps\/\*/);
  assert.match(read("pnpm-workspace.yaml"), /packages\/\*/);
});

test("Tasks 2 and 3 keep the public CLI identity and desktop safety, identity, theme, and scope contracts", () => {
  const cli = json("packages", "cli", "package.json");
  assert.equal(cli.name, "folder-structure-sync");
  assert.equal(cli.bin["folder-sync"], "./dist/index.js");
  assert.match(cli.engines.node, />=20/);

  const tauri = json("apps", "desktop", "src-tauri", "tauri.conf.json");
  assert.equal(tauri.productName, "Rootline by baole.space");
  assert.equal(tauri.identifier, "space.baole.rootline");
  assert.equal(tauri.version, "2.0.0");
  assert.deepEqual(tauri.plugins["deep-link"].desktop.schemes, ["rootline"]);
  assert.equal(tauri.bundle.createUpdaterArtifacts, true);
  assert.deepEqual(Object.keys(tauri.plugins.opener ?? {}).filter((key) => key !== "requireLiteralLeadingDot"), []);
  assert.ok(json("apps", "desktop", "src-tauri", "capabilities", "default.json").permissions.includes("opener:default"));

  const css = read("apps", "desktop", "src", "styles.css");
  for (const token of ["--graphite-950", "--fog-50", "--cyan-500", "--moss-500", "--amber-500"]) assert.match(css, new RegExp(token));
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\.root-copy strong[^}]*ui-monospace/);
  assert.deepEqual([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((match) => match[1]), ["rootline-scan"]);
  assert.match(css, /\.scan-line[^}]*animation:\s*rootline-scan/);

  const readme = read("README.md");
  assert.match(readme, /one-way|source.+target/i);
  assert.match(readme, /never directory trees, files, file contents, or run history/i);
  assert.match(readme, /no usage telemetry/i);
  const plan = read("docs", "superpowers", "plans", "2026-08-15-rootline-desktop-cli-v2.md");
  assert.match(plan, /No Linux, mobile, watcher, scheduler, mirror mode, or CLI cloud profiles/);

  const dependencyNames = Object.keys(json("apps", "desktop", "package.json").dependencies).join(" ");
  assert.doesNotMatch(dependencyNames, /analytics|posthog|segment|sentry|telemetry/i);
});

test("Task 4 keeps Authentik, cloud privacy, profile-only sync, and reset contracts covered", () => {
  const authTests = read("apps", "desktop", "src", "test", "auth.test.ts");
  for (const contract of ["openid profile email permissions offline_access", "rootline://auth/callback", "code_challenge_method", "nonce", "Storage.prototype"]) {
    assert.match(authTests, new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  const strongholdTests = read("apps", "desktop", "src", "test", "stronghold-storage.test.ts");
  assert.match(strongholdTests, /OS-keyed Stronghold store/);
  assert.match(strongholdTests, /fails closed/);

  const dto = read("apps", "api", "src", "sync.dto.ts");
  assert.doesNotMatch(dto, /runHistory|directoryTree|fileContents/);
  const apiTests = read("apps", "api", "test", "sync.e2e.spec.ts");
  for (const coverage of [
    "wrong issuer, audience, or permission", "tenant scoped", "idempotency", "LWW", "cursor deltas", "tombstones",
    "offline", "90-day receipt", "account deletion", "shared profile limits", "body, and per-user request limits", "RESET_REQUIRED",
  ]) assert.match(apiTests, new RegExp(coverage, "i"));
  for (const forbiddenPayload of ["directoryTree", "runHistory", "secret-source-that-must-not-be-logged"]) {
    assert.match(apiTests, new RegExp(forbiddenPayload));
  }

  const hostedDocs = read("docs", "hosted-profile-sync.md");
  assert.match(hostedDocs, /Application slug[^\n]*`rootline`/i);
  assert.match(hostedDocs, /TLS validation/);
  assert.match(hostedDocs, /encrypted backups/i);
  assert.match(hostedDocs, /Directory trees, files, file contents, and run history never enter the hosted outbox/i);
});

test("Task 5 keeps every build, release, updater, documentation, and portal gate represented", () => {
  const ci = read(".github", "workflows", "ci.yml");
  for (const gate of ["pnpm audit", "pnpm lint", "pnpm typecheck", "pnpm test:unit", "pnpm test:api-image", "cargo fmt", "cargo clippy", "cargo test", "test:pack"]) {
    assert.match(ci, new RegExp(gate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  for (const target of ["universal-apple-darwin", "x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"]) assert.match(ci, new RegExp(target));

  const release = read("docs", "release.md");
  for (const gate of ["notarization", "Authenticode", "updater", "blocked", "npm provenance"]) assert.match(release, new RegExp(gate, "i"));
  assert.doesNotThrow(() => read("SECURITY.md"));
  for (const document of ["privacy.md", "architecture.md", "configuration.md", "migration-v1-to-v2.md", "operations.md"]) {
    assert.doesNotThrow(() => read("docs", document));
  }

  const releaseTests = read("tests", "release-workflows.test.mjs");
  assert.match(releaseTests, /desktop release requires platform signing and updater signing/i);
  assert.match(releaseTests, /production image/i);
  assert.match(releaseTests, /updater/i);
  assert.match(read("tests", "updater-manifest.test.mjs"), /every supported runtime target/i);

  assert.match(release, /portal wording reflects actual availability/i);
});

test("the executable suites retain behavior-level coverage for every plan task", () => {
  const suites = [
    read("packages", "core", "test", "core.test.ts"),
    read("packages", "cli", "test", "node-adapter.test.ts"),
    read("packages", "cli", "test", "cli.test.ts"),
    read("apps", "desktop", "src", "test", "App.test.tsx"),
    read("apps", "desktop", "src-tauri", "tests", "native.rs"),
    read("apps", "desktop", "src", "test", "auth.test.ts"),
    read("apps", "api", "test", "sync.e2e.spec.ts"),
  ].join("\n");
  for (const behavior of [
    ".git", ".github", "traversal", "deterministic", "parent dependency", "overlapping", "case policy", "stale", "cancel",
    "--help", "--version", "--dry-run", "--verbose", "--auto", "--config", "--json", "partial", "junction",
    "50,000", "keyboard", "axe", "rebind", "Expand all", "Collapse all", "bounded[_ ]history", "outbox", "cursor", "vault",
    "PKCE", "nonce", "offline", "tombstone", "rate", "RESET_REQUIRED",
  ]) {
    const expression = behavior === "bounded[_ ]history"
      ? /bounded[_ ]history/i
      : new RegExp(behavior.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    assert.match(suites, expression);
  }
});

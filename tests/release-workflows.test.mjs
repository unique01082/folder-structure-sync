import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";

const root = process.cwd();
const workflows = ["ci.yml", "release-npm.yml", "release-api.yml", "release-desktop.yml"];

function workflow(name) {
  return readFileSync(join(root, ".github", "workflows", name), "utf8");
}

function parsedWorkflow(name) {
  return parse(workflow(name));
}

function jobScopedSecrets(name) {
  return Object.entries(parsedWorkflow(name).jobs).flatMap(([jobName, job]) =>
    Object.entries(job.env ?? {})
      .filter(([, value]) => String(value).includes("secrets."))
      .map(([key]) => `${jobName}.${key}`),
  );
}

test("all workflows are valid YAML", () => {
  for (const name of workflows) {
    assert.doesNotThrow(() => parsedWorkflow(name));
  }
});

test("CI covers TypeScript quality, real PostgreSQL, Rust, npm smoke, and the supported Tauri targets", () => {
  const ci = workflow("ci.yml");
  for (const expected of [
    "pnpm lint",
    "pnpm typecheck",
    "pnpm test:unit",
    "postgres:16-alpine",
    "prisma:migrate:deploy",
    "test:e2e",
    "cargo fmt --check",
    "cargo clippy",
    "cargo test",
    "test:pack",
    "universal-apple-darwin",
    "x86_64-pc-windows-msvc",
    "aarch64-pc-windows-msvc",
    "windows-11-arm",
  ]) assert.match(ci, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const postgresSteps = parsedWorkflow("ci.yml").jobs["postgres-integration"].steps;
  assert.ok(postgresSteps.some((step) => String(step.run ?? "").includes("libwebkit2gtk-4.1-dev")));
});

test("npm 2.0.0 release fails closed before provenance publishing", () => {
  const release = workflow("release-npm.yml");
  for (const expected of [
    "refs/tags/v2.0.0",
    "NPM_TOKEN",
    "test:pack",
    "npm publish",
    "--provenance",
    "--access public",
    "sha256sum",
    "actions/upload-artifact",
    "actions/download-artifact",
  ]) assert.match(release, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(release, /needs:\s*preflight/);
  assert.match(release, /if \[ "\$\{GITHUB_REF\}" != "refs\/tags\/v2\.0\.0" \]/);
  assert.equal(parsedWorkflow("release-npm.yml").jobs.preflight.environment, "npm-production");
  assert.deepEqual(jobScopedSecrets("release-npm.yml"), []);
  const npmJobs = parsedWorkflow("release-npm.yml").jobs;
  assert.equal(npmJobs.pack.permissions["id-token"], undefined);
  assert.equal(npmJobs.pack.outputs.checksum, "${{ steps.checksum.outputs.sha256 }}");
  assert.doesNotMatch(JSON.stringify(npmJobs.publish.steps), /pnpm install|actions\/checkout/);
  const publishSetup = npmJobs.publish.steps.find((step) => String(step.uses ?? "").includes("actions/setup-node"));
  assert.equal(publishSetup.with["registry-url"], "https://registry.npmjs.org");
  assert.equal(publishSetup.with.cache, undefined);
  const publishStep = npmJobs.publish.steps.find((step) => String(step.run ?? "").includes("npm publish"));
  assert.equal(publishStep.env.NODE_AUTH_TOKEN, "${{ secrets.NPM_TOKEN }}");
  const manifest = JSON.parse(readFileSync(join(root, "packages", "cli", "package.json"), "utf8"));
  assert.deepEqual(manifest.repository, {
    type: "git",
    url: "git+https://github.com/unique01082/folder-structure-sync.git",
  });
  assert.equal(manifest.engines.node, ">=20");
});

test("API release gates registry, migration, deployment, and HTTPS health secrets", () => {
  const release = workflow("release-api.yml");
  for (const expected of [
    "ROOTLINE_API_DATABASE_URL",
    "ROOTLINE_API_DEPLOY_WEBHOOK_URL",
    "ROOTLINE_API_BASE_URL",
    "ROOTLINE_JWT_JWKS_B64",
    "sslaccept",
    "prisma migrate deploy",
    "/healthz",
    "docker/build-push-action",
    "Refuse to overwrite stable image tag",
  ]) assert.match(release, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(release, /needs:\s*preflight/);
  assert.match(release, /refs\/tags\/v2\.0\.0/);
  assert.match(release, /steps\.build\.outputs\.digest/);
  assert.match(release, /image=.*@\$\{DIGEST\}/);
  assert.match(release, /ROOTLINE_BUILD_ID/);
  assert.match(release, /EXPECTED_BUILD_ID/);
  assert.match(release, /\.buildId == env\.EXPECTED_BUILD_ID/);
  assert.match(release, /sslmode"\) !== "require"/);
  assert.match(release, /sslaccept"\) !== "strict"/);
  assert.equal(parsedWorkflow("release-api.yml").jobs.preflight.environment, "api-production");
  assert.deepEqual(jobScopedSecrets("release-api.yml"), []);
  const apiJobs = parsedWorkflow("release-api.yml").jobs;
  assert.deepEqual(apiJobs.promote.needs, ["image", "health"]);
  assert.match(release, /candidate-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}/);
  assert.match(JSON.stringify(apiJobs.promote.steps), /imagetools create --tag/);
  const dockerfile = readFileSync(join(root, "apps", "api", "Dockerfile"), "utf8");
  assert.match(dockerfile, /^FROM node:20-bookworm-slim@sha256:[a-f0-9]{64} AS base$/m);
});

test("desktop release requires platform signing and updater signing for every stable artifact", () => {
  const release = workflow("release-desktop.yml");
  for (const expected of [
    "APPLE_CERTIFICATE",
    "APPLE_CERTIFICATE_PASSWORD",
    "APPLE_SIGNING_IDENTITY",
    "APPLE_ID",
    "APPLE_PASSWORD",
    "APPLE_TEAM_ID",
    "WINDOWS_CERTIFICATE",
    "WINDOWS_CERTIFICATE_PASSWORD",
    "TAURI_SIGNING_PRIVATE_KEY",
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    "TAURI_UPDATER_PUBLIC_KEY",
    "universal-apple-darwin",
    "x86_64-pc-windows-msvc",
    "aarch64-pc-windows-msvc",
    "latest.json",
  ]) assert.match(release, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(release, /TAURI_SIGNING_PRIVATE_KEY:\s*["']?["']?\s*$/m);
  assert.doesNotMatch(release, /adhoc|ad-hoc|disable.*sign/i);
  assert.doesNotMatch(release, /nsis\.zip/);
  assert.match(release, /setup\.exe\.sig/);
  assert.match(release, /needs:\s*preflight/);
  assert.equal(parsedWorkflow("release-desktop.yml").jobs.preflight.environment, "desktop-production");
  assert.deepEqual(jobScopedSecrets("release-desktop.yml"), []);
});

test("desktop updater is registered and serves every default runtime target", () => {
  const config = JSON.parse(readFileSync(join(root, "apps", "desktop", "src-tauri", "tauri.conf.json"), "utf8"));
  const cargo = readFileSync(join(root, "apps", "desktop", "src-tauri", "Cargo.toml"), "utf8");
  const rust = readFileSync(join(root, "apps", "desktop", "src-tauri", "src", "lib.rs"), "utf8");
  const capability = JSON.parse(readFileSync(join(root, "apps", "desktop", "src-tauri", "capabilities", "default.json"), "utf8"));
  const manifest = readFileSync(join(root, "scripts", "create-updater-manifest.mjs"), "utf8");

  assert.equal(config.bundle.createUpdaterArtifacts, true);
  assert.deepEqual(config.plugins.updater.endpoints, [
    "https://github.com/unique01082/folder-structure-sync/releases/latest/download/latest.json",
  ]);
  assert.match(cargo, /tauri-plugin-updater/);
  assert.match(rust, /tauri_plugin_updater::Builder::new\(\)\.build\(\)/);
  assert.ok(capability.permissions.includes("updater:default"));
  for (const target of ["darwin-aarch64", "darwin-x86_64", "windows-x86_64", "windows-aarch64"]) {
    assert.match(manifest, new RegExp(`\\"${target}\\"`));
  }
});

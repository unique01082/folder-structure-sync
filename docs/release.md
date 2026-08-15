# Rootline 2.0.0 release process

Stable releases are performed only by the checked-in GitHub Actions workflows. Local validation never publishes, deploys, signs, or creates a GitHub release.

## Pull request CI

`.github/workflows/ci.yml` runs:

- ESLint, TypeScript typecheck, unit tests, builds, workflow contract tests;
- isolated npm tarball install and `folder-sync` execution;
- real PostgreSQL 16 migration/API/desktop seam integration;
- Rust `fmt`, `clippy -D warnings`, and tests;
- Tauri compile matrices for macOS Universal, Windows x64, and Windows ARM64.

Windows ARM64 uses GitHub's native `windows-11-arm` runner. CI uses `--no-bundle` for compile coverage; it does not create an unsigned installer.

Validate workflow syntax/contracts without publishing:

```bash
pnpm validate:workflows
pnpm test:release
```

## npm

`release-npm.yml` runs only from the existing `v2.0.0` tag (with an additional exact confirmation for manual runs), checks the package version, and stops if `NPM_TOKEN` is missing. An unprivileged job reruns quality/unit gates, installs the packed CLI in isolation, and uploads the exact tarball plus an independent checksum output. A minimal protected `npm-production` job verifies that checksum and packed identity, then exposes `NPM_TOKEN` only to `npm publish` with provenance and public access.

Required external gate: repository secret `NPM_TOKEN` with publish access and approval for the `npm-production` environment.

## API

`release-api.yml` requires the existing `v2.0.0` tag, an exact manual confirmation, and every production database/auth/deployment secret. It uses a digest-pinned Node base and refuses to run if GHCR tag `rootline-api:2.0.0` already exists. It pushes a unique candidate tag, deploys by the resulting immutable digest, applies the checked-in migrations, calls the HTTPS deployment webhook with the digest and unique workflow build identity, then polls HTTPS `/healthz` until that exact identity is live. Only after health succeeds does it promote that verified digest to `rootline-api:2.0.0`; a failed attempt leaves stable identity unused and safely retryable. A healthy response from an older replica cannot pass the gate.

Required external gates: `ROOTLINE_API_DATABASE_URL`, `ROOTLINE_API_DEPLOY_WEBHOOK_URL`, `ROOTLINE_API_DEPLOY_TOKEN`, `ROOTLINE_API_BASE_URL`, `ROOTLINE_JWT_ISSUER`, `ROOTLINE_JWT_AUDIENCE`, `ROOTLINE_JWT_JWKS_B64`, GHCR permissions, and `api-production` approval. PostgreSQL TLS/backup and provider runtime configuration are operator responsibilities.

## Desktop

`release-desktop.yml` runs only from the existing `v2.0.0` tag. macOS Universal is Developer ID signed, notarized, and stapled. Windows x64 and ARM64 installer/updater executables are Authenticode signed and timestamped. Tauri updater artifacts cover the default `darwin-aarch64`, `darwin-x86_64`, `windows-x86_64`, and `windows-aarch64` runtime keys; `latest.json` is generated from their non-empty `.sig` files. Release publication occurs only after code-signature/staple verification succeeds.

Required external gates:

- Apple: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`, `APPLE_KEYCHAIN_PASSWORD`.
- Windows: `WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD`.
- Updater: `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and matching public environment variable `TAURI_UPDATER_PUBLIC_KEY`; custody and rotation must be defined before the first stable release.
- Hosted profile build variables: `VITE_AUTHENTIK_ISSUER`, `VITE_AUTHENTIK_CLIENT_ID`, `VITE_ROOTLINE_SYNC_API`.
- Protected `desktop-production` approval and a reviewed `v2.0.0` git tag.

Missing values produce an actionable preflight error. Do not replace a missing production identity with ad-hoc signing, an empty updater key, `--skip-stapling`, or an unsigned artifact.

## Release verification and rollback

After an authorized workflow completes, verify npm provenance and a clean install; image digest, migration log, and HTTPS health; Apple signature/notarization/staple; Windows Authenticode status/timestamp; updater URLs, checksums, and signatures; and that portal wording reflects actual availability. If any platform fails, keep the release blocked rather than publishing a partial stable claim.

Published versions and migrations are immutable. Fix forward with a new version and migration. Revoke compromised installers/updater keys through the release provider and rotate keys; never overwrite `2.0.0` with different bytes.

## Related

- [Operations](operations.md) - API rollout and incidents.
- [Security policy](../SECURITY.md) - Stable supply-chain controls.
- [Privacy](privacy.md) - Data boundaries that releases must preserve.

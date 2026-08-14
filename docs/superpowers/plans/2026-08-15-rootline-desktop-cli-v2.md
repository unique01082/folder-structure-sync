# Rootline Desktop + CLI v2 Implementation Plan

> **For agentic workers:** Use subagent-driven development and test-driven development. Every production behavior starts with a focused failing test, and every task ends with its own verification and commit.

**Goal:** Turn `folder-structure-sync` into Rootline by baole.space: a safe visual desktop directory-structure synchronizer for macOS and Windows, backed by the same core as the backwards-compatible CLI and an optional hosted profile-sync API.

**Architecture:** A pnpm workspace contains an environment-independent TypeScript core, the published Node CLI, shared cloud contracts, a React/Tauri 2 desktop app, and a NestJS/Prisma API. Filesystem data and run history remain local; only explicitly saved profiles are synchronized.

**Tech stack:** Node.js 20, pnpm, TypeScript, Vitest, Commander, React/Vite, Tauri 2/Rust, SQLite, oidc-client-ts, NestJS 11, Prisma/PostgreSQL.

## Global Constraints

- Product display name is `Rootline by baole.space`; Tauri identifier is `space.baole.rootline`.
- Keep npm package `folder-structure-sync` and binary `folder-sync`; release all workspace packages as product version `2.0.0` where public.
- Sync is one-way source to target and additive only: create missing directories, never copy/delete files or directories.
- Source and target may not be equal, ancestors, or descendants. Skip symlinks and Windows junctions.
- Node minimum is 20. CLI keeps `--dry-run`, `--verbose`, and `--auto`, and adds `--config` and `--json`.
- Desktop v1 targets macOS Universal and Windows x64/ARM64 only. No Linux, mobile, watcher, scheduler, mirror mode, or CLI cloud profiles.
- Desktop works offline. Optional Authentik login synchronizes complete profiles including absolute paths.
- Cloud conflict policy is server-commit-arrival last-write-wins. Deletes are tombstones. Account-data deletion rotates an epoch so stale devices cannot silently recreate deleted cloud data.
- Absolute paths and tokens never appear in API production logs. Tokens are not stored in localStorage.
- Keep the existing ISC license. No usage telemetry in v1.
- External stable-release gates (Authentik registration, PostgreSQL encrypted deployment, Apple notarization, Windows signing, updater key) must be documented and fail closed when secrets are absent.

---

### Task 1: Recover the Published Baseline and Establish Workspace Contracts

Recover the exact npm `1.1.0` tarball, verify its registry integrity, document its unreachable original git head, and preserve the `.ignore` directory-pruning behavior without rewriting history. Convert the repository into a pnpm workspace with root orchestration, shared TypeScript/Vitest configuration, `packages/contracts`, and skeleton packages/apps. Define and test the public domain/cloud types and shared error codes. Do not implement filesystem algorithms, UI behavior, database persistence, or API endpoints yet.

Acceptance: frozen pnpm install succeeds; contracts tests, typecheck, and package builds pass; npm `1.1.0` recovery evidence is checked into docs; old root implementation remains available as migration evidence but is no longer the future package entry point.

### Task 2: Implement the Shared Core and Backwards-Compatible CLI v2

Use TDD to implement normalized relative paths, exclusion matching, deterministic snapshots/plans/fingerprints, subtree dependency selection, overlap/traversal validation, and shared error objects. Implement the Node filesystem adapter, explicit config resolution, symlink/junction skipping, target case-comparison policy, revalidation, mkdir result statuses, and cancellation boundaries. Build the CLI with the required legacy/new flags, JSON/no-prompt behavior, version sourced from package metadata, and exact exit codes.

Acceptance: unit/integration/smoke tests cover `.git` versus `.github`, missing target, overlapping roots, symlinks, unreadable paths, stale plans, partial failures, config precedence, auto mode, JSON output, packaging and exit codes. `pnpm --filter folder-structure-sync test` and pack/install smoke pass.

### Task 3: Implement Rootline Desktop Offline Workflow

Build the React/Vite/Tauri 2 desktop shell and Rust native boundary. Native code owns folder dialogs, filesystem scan/apply/revalidation/cancellation, filesystem case semantics, SQLite migrations/repositories, device identity, mutation outbox, sync cursor, and capped run history. Build the approved profile rail and `Choose -> Scan -> Review -> Apply` workflow with virtualized diff tree, filters, subtree selection, rebind state, results, Vietnamese/English copy, system light/dark, keyboard/accessibility behavior and reduced motion.

Acceptance: Rust unit/integration tests cover native safety and SQLite migration/repository behavior; React tests cover workflow, error/empty/loading states, keyboard/focus and 50,000-folder virtualization fixture; Tauri development build starts on macOS and production build succeeds for the host target.

### Task 4: Implement Authentik and Hosted Profile Sync

Implement the Rootline public-client OIDC flow with Authorization Code + PKCE, system browser, `rootline://auth/callback`, strict state/nonce/callback validation, Stronghold-backed state/token persistence and OS-protected per-install vault key. Implement the NestJS/Prisma/PostgreSQL API with static-JWKS RS256 validation, tenant scoping by `sub`, permission `rootline:profiles:sync`, DTO limits, rate/body limits, `GET /healthz`, `POST /v1/sync`, and `DELETE /v1/account-data`. Implement idempotent mutation receipts, per-user revisions, delta cursors, LWW, tombstones, epoch reset, offline outbox replay and account-data removal UX.

Acceptance: API tests with real PostgreSQL cover invalid issuer/audience, cross-tenant access, idempotency, arrival-order LWW, cursor deltas, tombstones, offline replay, limits and reset-required behavior; desktop auth/sync tests prove raw tokens are hidden from components, offline usage is unaffected, and sign-out keeps or explicitly removes local synced data.

### Task 5: Harden CI, Distribution, Documentation, and Ecosystem Integration

Add CI for lint/typecheck/tests/builds, Rust fmt/clippy/test, npm tarball smoke and Tauri macOS/Windows build matrices. Add fail-closed release workflows for npm, API image/migration health, signed/notarized installers and signed updater manifests. Update README, security/privacy, architecture, configuration/migration and operations documentation. Add a Rootline product/download entry to the sibling `baole.space` portal using its existing catalog pattern without modifying unrelated portal work.

Acceptance: all local gates pass; release workflow validation passes without publishing; missing signing/auth/deployment secrets block stable jobs with actionable messages; final branch review has no Critical/Important findings. External credentials and live provider/signing operations are reported as explicit blocked gates, not claimed complete.

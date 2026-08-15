# Rootline documentation

Rootline by baole.space is a local-first, additive directory-structure synchronizer with a Node CLI, a Tauri desktop app, and optional hosted profile synchronization.

## Users

- [Configuration](configuration.md) - CLI flags, JSON configuration, desktop profiles, and hosted-sync build configuration.
- [Migrate from npm 1.1.0](migration-v1-to-v2.md) - Behavior changes and a safe migration sequence.
- [Privacy](privacy.md) - Exact local, hosted, and telemetry boundaries.
- [Security policy](../SECURITY.md) - Supported versions, reporting, and trust boundaries.

## Operators and releasers

- [Architecture](architecture.md) - Components, data ownership, and trust boundaries.
- [Hosted profile sync](hosted-profile-sync.md) - Authentik, API contract, reset semantics, and provider setup.
- [Operations](operations.md) - API/PostgreSQL deployment, migrations, health, backups, and incidents.
- [Release process](release.md) - CI matrix and fail-closed npm/API/desktop stable gates.

## Contributors

- [Contributing](../CONTRIBUTING.md) - Local setup, tests, and pull request workflow.
- [Rootline Desktop + CLI v2 implementation plan](superpowers/plans/2026-08-15-rootline-desktop-cli-v2.md) - Approved product constraints.
- [npm 1.1.0 recovery](baseline/npm-1.1.0-recovery.md) - Published baseline and integrity evidence.

## Related

- [Rootline README](../README.md) - Product overview and supported installation paths.
- [Release process](release.md) - Distribution status and external gates.

# Publishing Rootline

Rootline `2.0.0` is published only through the fail-closed GitHub Actions workflows. Do not run `npm publish`, push the API image, upload installers, or synthesize `latest.json` manually.

See [the release runbook](docs/release.md) for the exact preflight, credential, migration, signing, notarization, updater, verification, and rollback gates.

## Related

- [Release runbook](docs/release.md) - Single source of truth for stable releases.
- [Operations](docs/operations.md) - API deployment and health checks.
- [Security policy](SECURITY.md) - Supply-chain requirements.

# Rootline by baole.space

Rootline safely reproduces a directory structure from one location into another without copying files or deleting existing content.

> **Release status:** `2.0.0` is a release candidate. Stable npm and desktop downloads are available only after the fail-closed release workflows complete with real signing and deployment credentials. Check [GitHub Releases](https://github.com/unique01082/folder-structure-sync/releases) and [npm](https://www.npmjs.com/package/folder-structure-sync) before installing; this repository does not claim unpublished artifacts are live.

## Quick start

1. **Choose:** use the desktop application on macOS Universal or Windows x64/ARM64, or use the `folder-sync` CLI with Node.js 20 or newer.
2. **Install:** after `2.0.0` appears on the official release pages, download a signed installer or run `npm install --global folder-structure-sync@2.0.0`.
3. **Authenticate (optional):** sign in only if you want saved profiles synchronized. Rootline works fully offline and never requires an account for local synchronization.
4. **Try safely:** preview before applying: `folder-sync ./source ./target --dry-run`.

## What Rootline does

| Capability | Desktop | CLI |
|---|---:|---:|
| Scan source and target directories | Yes | Yes |
| Preview and select missing directories | Yes | Yes |
| Create missing directories additively | Yes | Yes |
| Copy files or delete content | Never | Never |
| Save local profiles and run history | Yes | No |
| Optional hosted profile sync | Yes | No |

Rootline rejects source/target overlap, skips symbolic links and Windows junctions, revalidates a plan immediately before applying it, and keeps filesystem data and run history local. Hosted sync contains complete saved profile documents—including absolute source and target paths—but never directory trees, files, file contents, or run history. Rootline has no usage telemetry.

## CLI

```text
folder-sync <source> <target> [options]

--dry-run       Preview without creating directories
--verbose       Print scan details
--auto          Select all missing directories without prompting
--config PATH   Read an explicit JSON configuration
--json          Emit one JSON document and never prompt
```

`--json` is intended for automation. Exit code `0` means success or a deliberate no-op, `1` means a filesystem/configuration/apply failure, and `2` means invalid command usage.

## Documentation

- [Documentation hub](docs/README.md)
- [Configuration reference](docs/configuration.md)
- [Architecture and data boundaries](docs/architecture.md)
- [Migrate from npm 1.1.0](docs/migration-v1-to-v2.md)
- [Privacy](docs/privacy.md)
- [Operations](docs/operations.md)
- [Release process](docs/release.md)
- [Security policy](SECURITY.md)
- [Contributor workflow](CONTRIBUTING.md)

## License

Rootline remains available under the [ISC License](LICENSE).

## Related

- [Rootline documentation](docs/README.md) - Complete user, operator, and contributor navigation.
- [npm 1.1.0 recovery evidence](docs/baseline/npm-1.1.0-recovery.md) - Provenance of the preserved legacy behavior.

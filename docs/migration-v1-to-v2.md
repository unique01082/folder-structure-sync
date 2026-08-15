# Migrate from folder-structure-sync 1.1.0 to Rootline 2.0.0

## Before upgrading

`2.0.0` keeps the npm package name `folder-structure-sync`, binary `folder-sync`, ISC license, `.ignore` subtree pruning, and the legacy `--dry-run`, `--verbose`, and `--auto` flags. It raises the minimum Node.js version to 20 and replaces the original interactive presentation with deterministic planning, explicit safety errors, JSON automation, and optional configuration paths.

The stable release is not assumed to exist merely because this branch has version `2.0.0`. Confirm the version on [npm](https://www.npmjs.com/package/folder-structure-sync) before upgrading.

## Safe migration

1. Upgrade automation hosts to Node.js 20 or newer.
2. Preserve the current `sync-config.json` and verify it is strict JSON; comments are invalid.
3. Install `folder-structure-sync@2.0.0` only after npm shows that exact version.
4. Run the existing source/target pair with `--dry-run --json` and archive the output.
5. Resolve any `PATH_OVERLAP`, `INVALID_PATH`, or configuration error rather than bypassing it.
6. Run once interactively, or add `--auto --json` only after reviewing the plan.

Example automation migration:

```bash
folder-sync "$SOURCE" "$TARGET" --dry-run --json --config ./sync-config.json
folder-sync "$SOURCE" "$TARGET" --auto --json --config ./sync-config.json
```

## Behavior differences

| Area | 1.1.0 | 2.0.0 |
|---|---|---|
| Node minimum | 12 | 20 |
| Missing target | Legacy creation behavior | Previewed or explicitly created |
| Root overlap/link aliases | Limited checks | Rejected before mutation |
| Automation output | Human-oriented | One JSON document with `--json` |
| Config selection | Working-directory file | Same default plus explicit `--config` |
| Desktop | None | Local-first macOS/Windows application |
| Cloud | None | Optional profile-only sync; CLI remains local-only |

There is no v1 cloud or desktop database to migrate. Creating a desktop profile is an explicit local action. Profiles created before first sign-in remain unclaimed until the user chooses whether to upload them.

## Rollback

Keep a v1.1.0 lockfile or tarball reference during rollout. Because both versions only add directories, rolling the CLI binary back does not require undoing filesystem mutations. Do not delete directories to simulate rollback. The preserved tarball integrity and behavior evidence is in the baseline document.

## Related

- [npm 1.1.0 recovery](baseline/npm-1.1.0-recovery.md) - Integrity and unreachable-source evidence.
- [Configuration](configuration.md) - v2 flags and JSON schema.
- [Privacy](privacy.md) - Optional hosted profile implications.

# Rootline architecture

## Components

| Component | Ownership |
|---|---|
| `packages/contracts` | Stable domain, cloud, error, and DTO contracts |
| `packages/core` | Environment-independent snapshot, exclusion, planning, selection, and validation logic |
| `packages/cli` | Node filesystem adapter and the public `folder-sync` binary |
| `apps/desktop` | React workflow plus the Tauri 2 native boundary |
| `apps/api` | Optional NestJS/Prisma hosted profile synchronization |

The npm CLI bundles its private workspace implementation into one public tarball. Desktop filesystem access, dialogs, SQLite, device identity, outbox, tokens, and remote sync live behind the Rust/native boundary. React receives projected profile and workflow state, not bearer tokens.

## Local synchronization

```text
source scan -> deterministic snapshot -> additive plan -> user selection
            -> source/target revalidation -> ordered mkdir operations -> local history
```

The source is read-only. Rootline creates missing target directories and never copies files or deletes files/directories. Equal, ancestor, descendant, symlink, and Windows junction relationships are rejected. Excluded subtrees and directories containing `.ignore` are pruned. A stale source or target invalidates the plan before mutation.

## Desktop persistence

SQLite owns profiles, device identity, capped run history, account binding, mutation outbox, receipts, cursor, epoch, and lifecycle generations. Migrations are append-only and applied by the native process. Sign-out, account deletion, account switching, and epoch adoption rotate lifecycle state so an in-flight response cannot rebind or resurrect stale data.

OIDC protocol state and tokens use Stronghold. Its per-install vault secret uses the operating-system credential manager. Tokens are not written to localStorage, SQLite, logs, or React state.

## Hosted profile sync

Hosted sync is optional and never needed for scanning or applying locally. Only an explicitly saved complete profile is eligible for upload after account consent. A profile includes its name, absolute source/target paths, exclusions, timestamps, and additive mode. Directory trees, file names/content, and run history are outside the cloud contract.

The API validates static Authentik RS256 keys, exact issuer/audience, the verified subject, and `rootline:profiles:sync`. Tenant ownership cannot be selected in a request body. Server commit-arrival order is last-write-wins; deletes are tombstones; idempotent mutation receipts are content-bound. Account-data deletion rotates the epoch and stale devices must explicitly adopt the new epoch.

## Distribution trust boundary

Pull requests build code but never publish. Stable release workflows require exact `2.0.0` refs/confirmations, protected production environments, immutable versions, and complete credentials. npm uses provenance; the API migrates before deployment and must pass HTTPS health; desktop installers use Apple Developer ID/notarization or Windows Authenticode and every updater archive has a Tauri signature. No release path disables signatures.

## Related

- [Configuration](configuration.md) - Runtime and build-time settings.
- [Privacy](privacy.md) - Data inventory and retention.
- [Operations](operations.md) - Hosted deployment responsibilities.
- [Release process](release.md) - CI and distribution gates.

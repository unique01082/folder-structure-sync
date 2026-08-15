# Rootline privacy

Rootline is local-first and has no usage telemetry.

## Data inventory

| Data | Local desktop | Hosted API | Product telemetry |
|---|---:|---:|---:|
| Saved profile name and absolute source/target paths | Yes | Only after sign-in and explicit consent | Never |
| Profile exclusions and timestamps | Yes | Only with the saved profile | Never |
| Directory tree, file names, or file contents | Used transiently for local scans | Never | Never |
| Run history and selected plan | Yes | Never | Never |
| Device ID, cursor, epoch, mutation receipts | Yes | Protocol-scoped values only | Never |
| OIDC tokens/protocol state | Native encrypted vault | Token verified in memory | Never |

The CLI has no cloud profile feature and sends no product data. The desktop works without an account. Hosted sync is a convenience for complete saved profile documents, not a backup of filesystem content.

## Consent and account separation

Profiles made before sign-in are not silently claimed. The user chooses whether to upload existing profiles or keep them local. Account switching clears the previous subject's cursor and queued mutations. Keeping local data on sign-out does not make it eligible for a later account automatically.

Because profiles contain absolute paths, they can reveal usernames, drive layouts, organization names, or project names. Use hosted sync only when that disclosure is appropriate. The API derives tenant ownership from the verified OIDC subject and never accepts a tenant selector from the client.

## Retention and deletion

Local profiles and capped run history remain until the user removes them or chooses local-data removal during sign-out/account removal. Hosted mutation receipts are retained for 90 days for idempotency. Deleting account data removes hosted profiles, tombstones, changes, and receipts, then rotates the epoch so a stale device cannot silently restore them.

Production logs are metadata-only. Operators must not log bearer tokens, request bodies, profile fields, or absolute paths. Backups containing hosted profiles must be encrypted and governed by the deployment's retention policy.

## Related

- [Security policy](../SECURITY.md) - Vulnerability handling and enforcement boundaries.
- [Architecture](architecture.md) - Local/native/API ownership.
- [Hosted profile sync](hosted-profile-sync.md) - Account deletion and reset protocol.
- [Release process](release.md) - Distribution gates that preserve these boundaries.

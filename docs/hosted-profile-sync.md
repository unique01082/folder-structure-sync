# Hosted profile sync operations

Rootline's hosted sync is optional. An unconfigured desktop remains fully local; a partially configured desktop fails closed instead of attempting authentication. The API also refuses to start until its database and token-verification inputs are complete.

Only saved profile documents are uploaded. A profile contains its name, absolute source and target paths, exclusions, timestamps, and additive sync mode. Directory trees, files, file contents, and run history never enter the hosted outbox.

## Authentik registration

Production registration is an external deployment gate. Create an Authentik OAuth2/OIDC provider and application with these exact properties:

| Setting | Required value |
|---------|----------------|
| **Application slug** | `rootline` |
| **Client type** | Public |
| **Grant** | Authorization Code with PKCE |
| **Redirect URI** | `rootline://auth/callback` |
| **Scopes** | `openid profile email permissions offline_access` |
| **Audience** | The value deployed as `JWT_AUDIENCE` |
| **Permission claim** | `rootline:profiles:sync` in the `permissions` array |
| **Signing algorithm** | RS256 |

Do not issue or embed a client secret. The desktop opens the system browser and validates the exact callback scheme, host, path, state, PKCE verifier, and OIDC nonce before accepting a session. A browser flow left unfinished returns to a cancelable, retryable state after five minutes instead of leaving the desktop busy indefinitely. The Tauri deep-link listener is installed before vault loading, cached cold-start URLs are read with `getCurrent`, and each callback state is consumed once. The deep-link plugin is the only URL delivery path, including Windows single-instance forwarding. OIDC state and tokens use Tauri Stronghold; the per-install random vault password is stored in the operating-system credential manager, never browser storage or React component state.

Set all three desktop build variables together:

```dotenv
VITE_AUTHENTIK_ISSUER=https://auth.example.com/application/o/rootline/
VITE_AUTHENTIK_CLIENT_ID=rootline-desktop
VITE_ROOTLINE_SYNC_API=https://rootline-api.example.com
```

When all are absent, account controls are disabled and offline use continues. If only some are present, or either endpoint is not HTTPS, startup fails with an actionable configuration error.

Profiles saved before the first sign-in remain unclaimed. Because they contain absolute paths, Rootline requires an explicit **Upload existing profiles** or **Keep local only** decision before binding their outbox to an OIDC subject. Signing out always removes that subject's cursor and queued mutations; choosing to keep local profiles does not make them eligible for a later account automatically. A different account therefore cannot inherit the previous account's paths or cursor.

If a second device explicitly consents to upload pre-login profiles but discovers an existing server epoch, accepting that epoch preserves only those consented, not-yet-cloud-owned mutation chains. Each mutation keeps that provenance until its own successful receipt. An edit or deletion of the same consented profile before adoption inherits the marker, preserving order and preventing an older upsert from overwriting or resurrecting it; unrelated edits queued after account binding are cloud-owned and are discarded by a later reset. Once every consented chain is acknowledged, later reset adoption clears the outbox so deleted hosted data cannot be resurrected.

Native sync calls are serialized. Each request captures the verified subject plus the local epoch, starting cursor, mutation generation, and a random lifecycle generation. Before opening a SQLite transaction, a successful response must contain exactly one receipt for every mutation sent—no duplicate, missing, or extra IDs. The response must still match the captured state inside the same transaction before any profile, receipt, or cursor is applied. Sign-out, account changes, and epoch acceptance rotate the lifecycle generation; local profile save/delete changes only the mutation generation. After receipts are removed, a response also skips any profile or tombstone that still has a pending local mutation in a later batch. Every follow-up request is constructed under one database critical section that requires the captured lifecycle and prohibits auto-binding; lifecycle is checked again immediately after transport, before interpreting even a reset response. The loop retries a rejected response only while that lifecycle remains current. This permits same-session local-edit replay while sign-out, removal, account switch, epoch adoption, and same-account ABA stop without rebuilding a stale request, rebinding the old subject, or reusing its captured token. Invalid legacy outbox mutations are removed from the FIFO transactionally and recorded in a metadata-only quarantine; the local profile remains available to edit and save again. Repeating an already committed claim for the same subject is idempotent.

## API deployment

The API requires:

```dotenv
DATABASE_URL=postgresql://rootline:REDACTED@postgres.example.com:5432/rootline?sslmode=require&sslaccept=strict
JWT_ISSUER=https://auth.example.com/application/o/rootline/
JWT_AUDIENCE=rootline-desktop
JWT_JWKS_PATH=/run/secrets/rootline-authentik-jwks.json
RATE_LIMIT_PER_MINUTE=60
PORT=3000
```

`JWT_JWKS_PATH` must be a deployment-mounted static JWKS containing the current Authentik RS256 public signing keys. Missing or empty files stop startup. Key rotation is an explicit rollout: mount a JWKS containing both accepted public keys, restart the API, rotate Authentik, then remove the retired key after all old access tokens expire. Never fetch keys dynamically from an untrusted token header.

Provision encrypted PostgreSQL separately, then apply the checked-in migration before starting the API:

```bash
pnpm --filter @rootline/api prisma:generate
pnpm --filter @rootline/api prisma:migrate:deploy
pnpm --filter @rootline/api start
```

The stable deployment must provide TLS termination for the API, TLS validation for PostgreSQL, encrypted backups, and a protected JWKS mount. Those production credentials and infrastructure are intentionally not committed to this repository.

## Service contract and privacy limits

| Endpoint | Contract |
|----------|----------|
| **`GET /healthz`** | Public liveness plus non-sensitive deployment build identity; no account data |
| **`POST /v1/sync`** | Authenticated profile mutations and cursor delta |
| **`DELETE /v1/account-data`** | Deletes hosted data and rotates the user's epoch |

`POST /v1/sync` accepts the stable ecosystem v1 fields (`accountEpoch`, mutation `type`, and `SyncProfileV1`) as well as the desktop's paginated transport (`epoch`, mutation `kind`, receipts, records, and `hasMore`). A request must use one shape consistently. Responses contain both projections: `accountEpoch`, `acknowledgedMutationIds`, and `profiles` for the public contract, plus the paginated fields used by the desktop. The public projection preserves tombstone profile metadata so a delete delta includes `deletedAt`; account deletion still removes every profile and tombstone.

Both account endpoints require an RS256 token with the configured issuer, audience, subject, and `rootline:profiles:sync` permission. Tenant ownership always comes from the verified `sub`; request bodies cannot select another tenant. Requests are limited to 256 KiB, 100 mutations, and 60 authenticated requests per user per rolling minute. Profile names contain 1–80 characters, source and target paths contain 1–4096 characters, and exclusions contain at most 100 patterns of 1–256 characters each. The shared contract, API DTO, desktop editor, and native persistence boundary enforce these same limits.

The built-in rolling limiter is process-local. Run one API replica for this version. Horizontal scaling requires a shared, subject-keyed limiter before adding replicas; an ingress-only IP limit is not equivalent to the per-user contract. Every committed profile/tombstone also records the last device ID that submitted it, without logging profile paths.

Server commit arrival order is last-write-wins. Every new mutation advances a per-user revision and deletes become tombstones. Mutation receipt rows are physically retained for 90 days and purged opportunistically during a later sync, while a compact content-bound deduplication record remains for the lifetime of the account epoch. Replaying the same mutation ID and payload after receipt expiry therefore acknowledges its original revision without another write; reusing the ID with different content returns 409. Account deletion clears profiles, tombstones, changes, receipts, and deduplication records, then rotates the epoch. A stale device receives `RESET_REQUIRED` and cannot silently resurrect deleted data; clients still recognize the pre-release `SYNC_EPOCH_RESET_REQUIRED` spelling during upgrades.

Mutation IDs are bound to a canonical content hash; reuse with different content returns 409 instead of silently dropping a change. Delta pages contain at most 100 records and approximately 1 MiB of record JSON. `hasMore` and the returned cursor let the desktop drain long-offline deltas while enforcing a 2 MiB streaming response cap.

Production logs must remain metadata-only: never log bearer tokens, request bodies, profile fields, or absolute paths.

For a reproducible local integration run, Docker can provision a disposable PostgreSQL 16 instance, apply every real migration, execute the API e2e suite, and remove the instance automatically:

```bash
pnpm --filter @rootline/api test:e2e:postgres
```

The root test command uses that same provision/migrate/test/cleanup harness automatically and needs no pre-existing `DATABASE_URL`:

```bash
pnpm test
```

The API suite includes a real seam test that starts from the desktop's SQLite profile/outbox, adopts an existing device-one server epoch, reconnects through NestJS/PostgreSQL, verifies receipts, and proves the absolute path is not sent to a different OIDC subject.

## Operator validation

- [ ] Authentik registration is a public client with the exact redirect URI and scopes.
- [ ] The deployed static JWKS and Authentik signing keys agree.
- [ ] PostgreSQL connections and backups are encrypted.
- [ ] Database migrations completed before the API rollout.
- [ ] API ingress enforces HTTPS and the 256 KiB request limit is not raised upstream.
- [ ] Logs contain no tokens, request bodies, or absolute paths.
- [ ] Account deletion is tested with a second stale device and returns reset-required.

## Related

- [Rootline documentation](README.md) - Documentation navigation.
- [Configuration](configuration.md) - Desktop and API environment variables.
- [Operations](operations.md) - Production rollout, backups, and incident handling.
- [Rootline Desktop + CLI v2 implementation plan](superpowers/plans/2026-08-15-rootline-desktop-cli-v2.md) - Product constraints and acceptance criteria.

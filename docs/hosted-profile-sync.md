# Hosted profile sync operations

Rootline's hosted sync is optional. An unconfigured desktop remains fully local; a partially configured desktop fails closed instead of attempting authentication. The API also refuses to start until its database and token-verification inputs are complete.

Only saved profile documents are uploaded. A profile contains its name, absolute source and target paths, exclusions, timestamps, and additive sync mode. Directory trees, files, file contents, and run history never enter the hosted outbox.

## Authentik registration

Production registration is an external deployment gate. Create an Authentik OAuth2/OIDC provider and application with these exact properties:

| Setting | Required value |
|---------|----------------|
| **Client type** | Public |
| **Grant** | Authorization Code with PKCE |
| **Redirect URI** | `rootline://auth/callback` |
| **Scopes** | `openid profile email permissions offline_access` |
| **Audience** | The value deployed as `JWT_AUDIENCE` |
| **Permission claim** | `rootline:profiles:sync` in the `permissions` array |
| **Signing algorithm** | RS256 |

Do not issue or embed a client secret. The desktop opens the system browser and validates the exact callback scheme, host, path, state, PKCE verifier, and OIDC nonce before accepting a session. OIDC state and tokens use Tauri Stronghold; the per-install random vault password is stored in the operating-system credential manager, never browser storage or React component state.

Set all three desktop build variables together:

```dotenv
VITE_AUTHENTIK_ISSUER=https://auth.example.com/application/o/rootline/
VITE_AUTHENTIK_CLIENT_ID=rootline-desktop
VITE_ROOTLINE_SYNC_API=https://rootline-api.example.com
```

When all are absent, account controls are disabled and offline use continues. If only some are present, or either endpoint is not HTTPS, startup fails with an actionable configuration error.

Profiles saved before the first sign-in remain unclaimed. Because they contain absolute paths, Rootline requires an explicit **Upload existing profiles** or **Keep local only** decision before binding their outbox to an OIDC subject. Signing out always removes that subject's cursor and queued mutations; choosing to keep local profiles does not make them eligible for a later account automatically. A different account therefore cannot inherit the previous account's paths or cursor.

Native sync calls are serialized. Each request captures the verified subject plus the local epoch, starting cursor, and session generation; the response must still match all four values inside the same SQLite transaction before any profile, receipt, or cursor is applied. Sign-out, account changes, and epoch acceptance advance the generation, so delayed or out-of-order responses are discarded. Repeating an already committed claim for the same subject is idempotent.

## API deployment

The API requires:

```dotenv
DATABASE_URL=postgresql://rootline:REDACTED@postgres.example.com:5432/rootline?sslmode=require
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
| **`GET /healthz`** | Public liveness response; no account data |
| **`POST /v1/sync`** | Authenticated profile mutations and cursor delta |
| **`DELETE /v1/account-data`** | Deletes hosted data and rotates the user's epoch |

Both account endpoints require an RS256 token with the configured issuer, audience, subject, and `rootline:profiles:sync` permission. Tenant ownership always comes from the verified `sub`; request bodies cannot select another tenant. Requests are limited to 256 KiB, 100 mutations, and 60 authenticated requests per user per rolling minute. Profile names are limited to 120 characters, paths to 4096 characters, and exclusions to 100 entries of 512 characters each.

The built-in rolling limiter is process-local. Run one API replica for this version. Horizontal scaling requires a shared, subject-keyed limiter before adding replicas; an ingress-only IP limit is not equivalent to the per-user contract.

Server commit arrival order is last-write-wins. Every accepted mutation advances a per-user revision, deletes become tombstones, and mutation receipts remain idempotent for 90 days. Account deletion clears profiles, tombstones, changes, and receipts, then rotates the epoch. A stale device receives `SYNC_EPOCH_RESET_REQUIRED` and cannot silently resurrect deleted data.

Mutation IDs are bound to a canonical content hash; reuse with different content returns 409 instead of silently dropping a change. Delta pages contain at most 100 records and approximately 1 MiB of record JSON. `hasMore` and the returned cursor let the desktop drain long-offline deltas while enforcing a 2 MiB streaming response cap.

Production logs must remain metadata-only: never log bearer tokens, request bodies, profile fields, or absolute paths.

For a reproducible local integration run, Docker can provision a disposable PostgreSQL 16 instance, apply every real migration, execute the API e2e suite, and remove the instance automatically:

```bash
pnpm --filter @rootline/api test:e2e:postgres
```

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
- [Rootline Desktop + CLI v2 implementation plan](superpowers/plans/2026-08-15-rootline-desktop-cli-v2.md) - Product constraints and acceptance criteria.

# Rootline operations

## Deployment order

1. Provision encrypted PostgreSQL 16 with encrypted, tested backups.
2. Register the Authentik public client exactly as documented and mount a static RS256 JWKS.
3. Configure the API production environment without placing secrets in the image.
4. Build from the digest-pinned base and push a unique candidate image only if stable tag `rootline-api:2.0.0` does not already exist.
5. Apply every checked-in Prisma migration to the production database.
6. Deploy the immutable image through the configured HTTPS provider webhook.
7. Require `GET /healthz` to return `status: "ok"` and the unique build identity requested by the current workflow over HTTPS.
8. Promote that verified digest to stable tag `rootline-api:2.0.0`; never overwrite the stable tag.

The release workflow enforces this order. A migration failure prevents deployment; a deployment or health failure prevents a successful stable release.

## Local integration validation

```bash
pnpm --filter @rootline/api test:e2e:postgres
```

This uses disposable PostgreSQL 16 and real migrations. For a manually managed test database:

```bash
pnpm --filter @rootline/api prisma:generate
DATABASE_URL=postgresql://... pnpm --filter @rootline/api prisma:migrate:deploy
DATABASE_URL=postgresql://... pnpm --filter @rootline/api test:e2e
```

## Health and logs

`/healthz` is public and contains only health state plus a non-sensitive deployment build identity; it contains no account data. Monitor non-2xx responses, migration failures, authentication failure rates, request-limit rejections, and PostgreSQL capacity. Do not add request-body or authorization-header logging during incident response. Absolute profile paths must remain absent from production logs.

The built-in rate limiter is process-local. Run one API replica for this release. A shared subject-keyed limiter is required before horizontal scaling.

## Backup and recovery

- Encrypt database connections, storage, snapshots, and off-site backups.
- Restore backups into an isolated environment and validate migrations plus `/healthz` regularly.
- Treat a restore as hosted profile recovery only; filesystem trees and run history are not server data.
- Coordinate restore timestamps with epoch/account-deletion semantics so deleted accounts are not accidentally reintroduced.

## Key rotation and incidents

For Authentik signing-key rotation, mount a JWKS containing old and new public keys, restart, rotate the issuer, wait for old access tokens to expire, then remove the retired key. Never choose a JWKS URL from an unverified token header.

If a deployment secret leaks, stop the release, rotate it at the provider, replace the repository environment secret, invalidate affected sessions when applicable, and only then re-run preflight. If the API becomes unhealthy after migration, do not rewrite or delete migration history; halt deployment and use a reviewed forward migration or provider rollback compatible with the applied schema.

## External production gates

The repository cannot complete Authentik registration, production PostgreSQL/TLS/backup provisioning, provider webhook setup, Apple notarization, Windows certificate issuance, or updater-key custody. Until operators configure and exercise these gates, stable distribution remains blocked and must not be described as live.

## Related

- [Hosted profile sync](hosted-profile-sync.md) - Authentik and protocol details.
- [Release process](release.md) - Workflow inputs and validation.
- [Privacy](privacy.md) - Operational data limits.

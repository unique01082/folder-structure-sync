# Rootline configuration

## CLI

Rootline requires Node.js 20 or newer. The command is:

```text
folder-sync <source> <target> [--dry-run] [--verbose] [--auto] [--config PATH] [--json]
```

Configuration resolution is deliberately narrow: an explicit `--config` path wins; otherwise Rootline reads `sync-config.json` only from the current working directory; if that file is absent, built-in exclusions and operating-system case behavior apply. Invalid explicit files fail—there is no silent fallback.

```json
{
  "defaultExclusions": [".git", "node_modules", ".DS_Store", "dist", "build"],
  "customExclusions": ["private-cache", "*.generated"],
  "targetCaseSensitive": false
}
```

`defaultExclusions` replaces the built-in list when present. `customExclusions` is appended. Patterns without `/` match a basename at any depth; patterns with `/` match a complete POSIX relative path. `*`, `?`, and `**` are supported and a match prunes the complete subtree. Rootline detects the target filesystem's case behavior without writing probe files; `targetCaseSensitive` is an explicit override for unusual or unavailable platform metadata.

`--dry-run` never creates a missing target. `--json` is valid only with `--dry-run` or `--auto` and never prompts. Use `--auto --json` for non-interactive application, and treat exit codes `1` and `2` as failures.

## Desktop profiles

A saved profile contains a display name, absolute source and target paths, exclusions, timestamps, and additive sync mode. Names contain 1–80 characters, each path 1–4096 characters, and the exclusion list at most 100 patterns of 1–256 characters. It is local by default. Changing a folder outside Rootline may require re-binding the profile before a new scan. The desktop always supports offline profiles and run history without authentication. Removing a local profile does not remove its run history.

## Optional hosted sync build variables

Set either all three values or none:

```dotenv
VITE_AUTHENTIK_ISSUER=https://auth.example.com/application/o/rootline/
VITE_AUTHENTIK_CLIENT_ID=rootline-desktop
VITE_ROOTLINE_SYNC_API=https://rootline-api.example.com
```

Both URLs must use HTTPS. With no values, account controls are absent and offline behavior is unchanged. A partial or insecure configuration stops startup with an actionable error. The Authentik client is public: never add a client secret.

## API environment

```dotenv
DATABASE_URL=postgresql://rootline:REDACTED@postgres.example.com:5432/rootline?sslmode=require&sslaccept=strict
JWT_ISSUER=https://auth.example.com/application/o/rootline/
JWT_AUDIENCE=rootline-desktop
JWT_JWKS_PATH=/run/secrets/rootline-authentik-jwks.json
RATE_LIMIT_PER_MINUTE=60
PORT=3000
```

All first four values are required. `JWT_JWKS_PATH` must be a mounted JSON Web Key Set containing at least one Authentik RS256 public key. Production database connections require `sslmode=require&sslaccept=strict` so Prisma verifies the server certificate. Secret values belong in the deployment provider, not environment files committed to git.

## Related

- [Architecture](architecture.md) - How configuration crosses trust boundaries.
- [Hosted profile sync](hosted-profile-sync.md) - Exact Authentik registration and API contract.
- [Operations](operations.md) - Production secret and migration handling.

# Rootline security policy

## Supported versions

| Version | Status |
|---|---|
| `2.0.x` | Supported after the stable `2.0.0` release |
| `1.1.x` | Security fixes only during the v2 migration window |
| Earlier | Unsupported |

## Report a vulnerability

Use a private GitHub security advisory for `unique01082/folder-structure-sync`. Do not include tokens, absolute filesystem paths, database credentials, signing keys, or personal data in a public issue. Include affected version/platform, impact, reproduction steps, and any known mitigations.

Release signing or hosted-service credentials are never accepted through issues or pull requests. Rotate any credential accidentally disclosed in logs or source before continuing a release.

## Security boundaries

- Local synchronization is one-way and additive: Rootline creates missing directories only.
- Source and target cannot be equal, ancestors, descendants, symbolic links, or Windows junction aliases.
- The plan is revalidated before mutation; cancellation stops between directory operations.
- Offline profiles, directory trees, file names/content, device state, and run history remain local.
- Optional hosted sync sends complete saved profiles, including absolute source and target paths, only after explicit sign-in and consent.
- OIDC uses Authorization Code with PKCE. Tokens and protocol state are held behind the native Stronghold/OS credential boundary, not localStorage or React state.
- API tenant identity comes only from the verified RS256 token subject and permission claim.
- Production logs must not contain bearer tokens, request bodies, profile values, or absolute paths.
- Rootline contains no usage telemetry.

## Supply-chain and stable release controls

Stable npm publication is restricted to `v2.0.0`, requires npm provenance, and installs the packed CLI in isolation before publishing. Stable API deployment requires an immutable image, checked-in PostgreSQL migrations, HTTPS deployment/health endpoints, and complete production secrets. Desktop release requires Apple signing and notarization, Windows Authenticode signing, and a non-empty Tauri updater signature for every platform. Missing inputs stop the release with an actionable error; signatures are never disabled as a fallback.

## Related

- [Privacy](docs/privacy.md) - Data collection and hosted profile scope.
- [Architecture](docs/architecture.md) - Trust boundaries and ownership.
- [Release process](docs/release.md) - Fail-closed release gates.

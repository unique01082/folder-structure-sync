# Contributing to Rootline

## Local setup

Requirements: Node.js 20+, pnpm 10.33.0, stable Rust with `rustfmt` and `clippy`, Docker with Compose, and the native Tauri 2 prerequisites for your operating system.

```bash
git clone https://github.com/unique01082/folder-structure-sync.git
cd folder-structure-sync
corepack enable
pnpm install --frozen-lockfile
```

## Development commands

```bash
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm build
pnpm --filter folder-structure-sync test:pack
pnpm --filter @rootline/api test:e2e:postgres
cargo fmt --check --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

The API integration command provisions disposable PostgreSQL 16, applies the real Prisma migrations, runs the full NestJS/PostgreSQL suite (including the desktop SQLite seam), and removes the database. The npm smoke test packs and installs only the public CLI tarball; workspace packages must not hide missing registry dependencies.

For desktop development, run `pnpm --filter @rootline/desktop tauri dev`. Local source builds are developer workflows, not user installation instructions.

## Change workflow

1. Write a focused failing test for every behavior change and verify the expected failure.
2. Implement the smallest change that passes it.
3. Run the focused test, then the relevant package suite and repository gates.
4. Update the owning document once and link to it instead of duplicating content.
5. Preserve the additive-only synchronization, local-data, privacy, and signing boundaries.

Do not publish npm packages, push images, create releases, deploy the API, or sign artifacts from a pull request. Release workflows are intentionally isolated behind production environments and exact version confirmations.

## Pull request checklist

- [ ] Red/green test evidence is included.
- [ ] TypeScript and Rust gates relevant to the change pass.
- [ ] npm tarball or Tauri target smoke ran when distribution changed.
- [ ] Real PostgreSQL tests ran when API/database behavior changed.
- [ ] No tokens, absolute paths, generated credentials, or production data appear in logs/fixtures.
- [ ] Documentation links resolve and every new doc has a Related section.

## Related

- [Architecture](docs/architecture.md) - Package and trust boundaries.
- [Operations](docs/operations.md) - Local and hosted service validation.
- [Release process](docs/release.md) - Production-only gates.

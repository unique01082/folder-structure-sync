# Rootline release quick reference

Stable Rootline releases are workflow-only and fail closed. Do not run `npm publish`, create a GitHub release, deploy the API, or sign installers from a local checkout.

Use [the release runbook](docs/release.md) for the exact npm, API, and desktop gates. The runbook identifies the protected GitHub environments, required production configuration, validation sequence, and external credentials that currently block a real `2.0.0` release.

Local validation is safe and does not publish:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:release
pnpm validate:workflows
```

Rootline `2.0.0` must not be described as shipped until every protected workflow completes from the reviewed `v2.0.0` tag.

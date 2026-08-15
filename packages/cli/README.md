# Rootline CLI

`folder-structure-sync` provides the `folder-sync` command for safe, additive directory-structure synchronization. It creates missing directories only; it does not copy, move, rename, or delete files.

Rootline `2.0.0` requires Node.js 20 or newer. Until the protected release workflow succeeds, install from a reviewed local tarball rather than assuming `2.0.0` is live on npm.

```bash
folder-sync ./source ./target --dry-run
folder-sync ./source ./target --auto --json
```

Use `--dry-run` to preview. `--json` never prompts and is accepted only with `--dry-run` or `--auto`; use the latter for non-interactive application. Run `folder-sync --help` for the complete command reference.

Documentation, source, security policy, and release status: <https://github.com/unique01082/folder-structure-sync>

# Rootline CLI examples

These examples cover the `2.0.0` `folder-sync` command. The preserved root `node index.js` program is `1.x` migration evidence and is not the v2 entry point.

## Preview safely

```bash
folder-sync ./source ./target --dry-run
```

Dry-run mode scans both roots and reports missing directories without creating them. A missing target remains untouched.

## Apply every missing directory

```bash
folder-sync ./source ./target --auto
```

Without `--auto`, Rootline asks for confirmation in an interactive terminal. Rootline creates directories only; it does not copy, move, rename, or delete files.

## Automation with JSON

```bash
folder-sync ./source ./target --auto --json
```

`--json` emits one JSON document and never prompts. Combine it with `--auto` to apply a plan in automation. Exit code `0` means success or a deliberate no-op, `1` means an operational failure, and `2` means invalid usage.

## Explicit configuration

```bash
folder-sync ./source ./target --dry-run --config ./rootline.config.json
```

```json
{
  "defaultExclusions": [".git", "node_modules", "dist", "build"],
  "customExclusions": ["private-cache"],
  "targetCaseSensitive": true
}
```

Configuration precedence and validation are documented in [Configuration](docs/configuration.md). The safe upgrade sequence from the published `1.1.0` behavior is documented in [Migration from 1.x to 2.0.0](docs/migration-v1-to-v2.md).

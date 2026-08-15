# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - Unreleased

### Added

- Rootline Desktop for macOS Universal and Windows x64/ARM64.
- A shared, deterministic additive-sync core and the `folder-sync` Node.js 20 CLI.
- Optional Authentik-hosted profile sync backed by PostgreSQL; local-only profiles remain the default.
- Fail-closed CI and protected npm, API, desktop signing, notarization, and updater workflows.

### Changed

- The v2 CLI entry point is `folder-sync`; the root `node index.js` program is retained only as `1.x` migration evidence.
- Stable distribution remains blocked until the documented production environments, credentials, signing identities, updater key, and reviewed `v2.0.0` tag exist and pass.

## [1.1.0] - 2025-08-10

### Preserved

- Published npm behavior recovered byte-for-byte as migration evidence. See [the 1.1.0 recovery record](docs/baseline/npm-1.1.0-recovery.md) for registry integrity and provenance details.

## [1.0.0] - 2025-08-09

### 🎉 Initial Release

**Package published to npm:** `npm install -g folder-structure-sync`  
**NPM Package:** https://www.npmjs.com/package/folder-structure-sync

### Added

- 🎯 Interactive folder selection with checkbox interface
- 🧠 Smart dependency resolution (auto-include parent folders)
- 🚫 Configurable exclusion patterns via sync-config.json
- 🎨 Beautiful colored output with progress bars
- 📋 Dry run mode for safe previewing
- ⚡ Auto mode for automation and scripts
- 📊 Detailed operation reporting
- 🔧 Cross-platform support (Windows, macOS, Linux)
- 💡 Multiple selection methods (checkboxes and number input)
- ⚙️ Comprehensive error handling
- 📖 Extensive documentation and examples

### Features

- CLI interface using Commander.js
- Interactive prompts with Inquirer.js
- Colorful terminal output with Chalk
- Progress bars with cli-progress
- Recursive directory scanning
- Smart exclusion pattern matching
- Parent-child dependency resolution
- Configurable exclusion patterns
- Verbose logging option
- Help system and usage examples

### Security

- No file content modification (folders only)
- Respects filesystem permissions
- No external command execution
- Local configuration files only
- No network communication

### Installation

```bash
# Global installation
npm install -g folder-structure-sync

# Local installation
npm install folder-structure-sync

# Use with npx (no installation)
npx folder-structure-sync source target --dry-run
```

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial release preparation
- GitHub repository setup
- Comprehensive documentation

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

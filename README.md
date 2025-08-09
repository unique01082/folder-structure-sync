# 📁 Folder Structure Sync

[![npm version](https://img.shields.io/npm/v/folder-structure-sync.svg?style=flat-square)](https://www.npmjs.com/package/folder-structure-sync)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg?style=flat-square)](https://opensource.org/licenses/ISC)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D12.0.0-brightgreen.svg?style=flat-square)](https://nodejs.org/)

> 🚀 **Interactive CLI tool for syncing folder structures with smart selection, dependency handling, and beautiful output**

Perfect for project templates, development environments, team onboarding, and automated deployments. Sync only what you need with intelligent dependency resolution and comprehensive exclusion patterns.

## 📚 Table of Contents

- [✨ Features](#-features)
- [🚀 Quick Start](#-quick-start)
- [📦 Installation](#-installation)
- [📖 Usage](#-usage)
  - [🎮 Interactive Mode](#-interactive-mode)
  - [🔧 Command Options](#-command-options)
  - [💡 Common Use Cases](#-common-use-cases)
- [⚙️ Configuration](#️-configuration)
- [🎯 Smart Features](#-smart-features)
  - [🎮 Interactive Selection](#-interactive-selection)
  - [🧠 Dependency Resolution](#-dependency-resolution)
  - [🎨 Beautiful Output](#-beautiful-output)
- [📸 Screenshots & Examples](#-screenshots--examples)
  - [✅ Success Output](#-success-output)
  - [📋 Dry Run Output](#-dry-run-output)
  - [⚠️ Error Handling](#️-error-handling)
- [🛠️ Development](#️-development)
- [🤝 Contributing](#-contributing)
- [📋 Roadmap](#-roadmap)
- [❓ FAQ](#-faq)
- [🔧 Troubleshooting](#-troubleshooting)
- [📄 License](#-license)
- [🙏 Acknowledgments](#-acknowledgments)

## ✨ Features

- 🎯 **Interactive Selection**: Choose folders with checkbox interface or comma-separated numbers
- 🧠 **Smart Dependencies**: Auto-includes parent folders when children are selected
- 🚫 **Smart Exclusions**: Configurable patterns with sensible defaults (`.git`, `node_modules`, etc.)
- 🎨 **Beautiful Output**: Colorful, hierarchical display with progress bars
- 📋 **Dry Run Mode**: Preview changes safely before execution
- ⚡ **Auto Mode**: Perfect for scripts and CI/CD pipelines
- 📊 **Detailed Reporting**: Comprehensive operation summaries
- 🔧 **Cross-Platform**: Works on Windows, macOS, and Linux

## 🚀 Quick Start

```bash
# Install globally from npm
npm install -g folder-structure-sync

# Or install locally in your project
npm install folder-structure-sync

# Run interactively
folder-sync ./source-folder ./target-folder

# Preview changes (recommended first run)
folder-sync ./source-folder ./target-folder --dry-run

# Auto-sync everything
folder-sync ./source-folder ./target-folder --auto
```

## 📦 Installation

```bash
# Global installation (recommended)
npm install -g folder-structure-sync

# Local installation
npm install folder-structure-sync

# Or run directly with npx (no installation needed)
npx folder-structure-sync ./source ./target --dry-run
```

## 📖 Usage

### 🎮 Interactive Mode

The default mode provides a user-friendly selection interface:

```bash
folder-sync ./source-project ./target-project
```

**Example interaction:**

```
📂 Found 5 missing folders in target:
[1] ✓ src/
[2] ✓ src/components/
[3] ✗ src/utils/
[4] ✓ docs/
[5] ✓ tests/

🎯 Select folders to create:
   Use arrow keys to navigate, space to toggle, enter to confirm
```

### 🔧 Command Options

- `-d, --dry-run`: Preview changes without executing
- `-v, --verbose`: Show detailed output
- `-a, --auto`: Auto-create all missing folders without prompting
- `-h, --help`: Show help information

### 💡 Common Use Cases

```bash
# 🔍 Preview changes (recommended first!)
folder-sync ./my-template ./new-project --dry-run

# 🏗️ Project template setup
folder-sync ./project-template ./new-project --auto

# 👥 Team environment replication
folder-sync ./team-structure ./my-local-copy

# 📦 Selective sync with verbose output
folder-sync ./large-project ./partial-copy --verbose

# 🤖 Automation/CI-CD pipeline
folder-sync "$SOURCE" "$TARGET" --auto
```

## ⚙️ Configuration

The tool uses a `sync-config.json` file for exclusion patterns:

```json
{
  "defaultExclusions": [
    ".git",
    ".svn",
    ".hg", // Version control
    "node_modules",
    ".npm",
    ".yarn", // Package managers
    ".DS_Store",
    "Thumbs.db", // OS files
    ".vscode",
    ".idea", // IDE files
    "*.tmp",
    "*.log",
    "*.cache", // Temporary files
    "dist",
    "build",
    ".next" // Build outputs
  ],
  "customExclusions": [
    "my-custom-folder", // Add your patterns here
    "*.backup"
  ]
}
```

**💡 Pro tip**: Customize `customExclusions` for project-specific needs!

## 🎯 Smart Features

### 🎮 Interactive Selection

**Two ways to select folders:**

1. **Checkbox Interface**: Navigate with `↑↓`, toggle with `Space`, confirm with `Enter`
2. **Number Input**: Type comma-separated numbers like `1,3,5` or ranges `1-5`

### 🧠 Dependency Resolution

When you select `src/components/buttons/`, the tool automatically:

- ✅ Includes parent folders: `src/` → `src/components/` → `src/components/buttons/`
- 📋 Shows you the complete dependency tree
- ⚡ Creates folders in the correct order

### 🎨 Beautiful Output

```
🔍 Validating paths...
📁 Scanning directories...

📂 Found 5 missing folders:
  [1] src/                    # Root level - cyan
    [2] src/components/       # Level 1 - yellow
      [3] src/components/ui/  # Level 2 - green
  [4] docs/                   # Root level - cyan
  [5] tests/                  # Root level - cyan

🚀 Creating folders...
Progress |████████████████████| 100% | 5/5 folders

🎉 Success: 5 created, 0 errors
```

## 📸 Screenshots & Examples

### ✅ Success Output

```
🎉 Successfully processed 5 folders!
📊 Summary: 5 created, 0 errors
```

### 📋 Dry Run Output

```
📋 Dry run - folders that would be created:
  1. /target/src
  2. /target/src/components
  3. /target/docs
  4. /target/tests

📋 This was a dry run - no actual changes were made.
```

### ⚠️ Error Handling

```
❌ Error creating /restricted/folder: EACCES: permission denied
📊 Summary: 4 created, 1 error
```

## 🛠️ Development

```bash
# Clone and setup
git clone https://github.com/unique01082/folder-structure-sync.git
cd folder-structure-sync
npm install

# Run tests (when available)
npm test

# Test with sample data
node index.js ./test-source ./test-target --dry-run
```

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request. For major changes, please open an issue first to discuss what you would like to change.

1. Fork the project
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📋 Roadmap

- [x] 📦 NPM package publication
- [ ] 🧪 Comprehensive test suite
- [ ] 📊 File sync capabilities (not just folders)
- [ ] 🌐 Configuration presets for popular frameworks
- [ ] 🔍 Advanced filtering with regex patterns
- [ ] 📱 Interactive web interface
- [ ] ⚡ Performance optimizations for large directories

## ❓ FAQ

**Q: Does this tool copy files?**  
A: No, it only creates folder structures. Files are not copied or modified.

**Q: Is it safe to use in production?**  
A: Yes, especially with `--dry-run` first. The tool only creates folders and includes comprehensive error handling.

**Q: Can I exclude specific patterns?**  
A: Absolutely! Use `sync-config.json` to customize exclusion patterns.

**Q: Does it work with network drives?**  
A: Yes, as long as you have appropriate permissions.

## 🔧 Troubleshooting

**Permission Errors**: Run with elevated privileges or check folder permissions  
**Large Directories**: Use `--verbose` to monitor progress  
**Configuration Issues**: Check `sync-config.json` syntax with a JSON validator

## 📄 License

This project is licensed under the ISC License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- Built with ❤️ using [Commander.js](https://github.com/tj/commander.js/), [Chalk](https://github.com/chalk/chalk), [Inquirer.js](https://github.com/SBoudrias/Inquirer.js/), and [CLI Progress](https://github.com/npkgz/cli-progress)
- Inspired by the need for better development environment synchronization

---

**⭐ Star this repo if it helped you!** | **🐛 [Report bugs](https://github.com/unique01082/folder-structure-sync/issues)** | **💡 [Request features](https://github.com/unique01082/folder-structure-sync/issues)**

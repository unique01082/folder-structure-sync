# 📦 Publishing Guide

This guide covers the complete process for publishing new versions of `folder-structure-sync` to npm.

## 🚀 Quick Release Commands

```bash
# For bug fixes (1.0.0 → 1.0.1)
npm run release:patch

# For new features (1.0.0 → 1.1.0)
npm run release:minor

# For breaking changes (1.0.0 → 2.0.0)
npm run release:major

# Full safety check before publishing
npm run publish:check

# Safe publish with all checks
npm run publish:safe
```

## 📋 Step-by-Step Process

### 1. Pre-Release Preparation

```bash
# Run comprehensive checks
npm run precheck

# Test package functionality
npm run test-package
```

**What the pre-check validates:**

- ✅ All required files exist
- ✅ package.json has all required fields
- ✅ Git working directory is clean
- ✅ Logged in to npm
- ✅ Tests pass (if any)
- ⚠️ Checks for TODO/FIXME comments

### 2. Choose Release Type

| Type      | When to Use                        | Version Change | Example                  |
| --------- | ---------------------------------- | -------------- | ------------------------ |
| **patch** | Bug fixes, minor improvements      | 1.0.0 → 1.0.1  | Fix CLI argument parsing |
| **minor** | New features (backward compatible) | 1.0.0 → 1.1.0  | Add new command option   |
| **major** | Breaking changes                   | 1.0.0 → 2.0.0  | Change CLI interface     |

### 3. Execute Release

```bash
# Example: releasing a minor version
npm run release:minor
```

**What the release script does:**

1. 🔍 Checks current branch is master
2. 📥 Pulls latest changes
3. 🧪 Runs tests (if available)
4. 📈 Updates version in package.json
5. 📝 Updates CHANGELOG.md with new version
6. 📦 Stages and commits changes
7. 🏷️ Creates git tag
8. 📤 Pushes changes and tags
9. 📋 Shows instructions for npm publish

### 4. Review and Publish

After running the release script:

1. **Review the changes:**

   ```bash
   git log --oneline -5
   git show HEAD
   ```

2. **Publish to npm:**

   ```bash
   npm publish
   ```

3. **Create GitHub Release:**
   - Go to: https://github.com/unique01082/folder-structure-sync/releases/new
   - Select the new tag
   - Add release notes from CHANGELOG.md
   - Publish release

## 🔧 Manual Process (if needed)

If you prefer manual control:

### 1. Version Update

```bash
# Update version manually
npm version patch  # or minor/major
```

### 2. Update CHANGELOG.md

Add new section with current date:

```markdown
## [1.0.1] - 2025-08-09

### Fixed

- Bug fixes and improvements

### Changed

- Minor updates and optimizations
```

### 3. Commit and Tag

```bash
git add .
git commit -m "chore: release v1.0.1"
git tag v1.0.1
git push origin master --tags
```

### 4. Publish

```bash
npm publish
```

## 🧪 Testing Before Release

### Local Testing

```bash
# Test package creation and functionality
npm run test-package
```

### Test Installation

```bash
# Create package and test locally
npm pack
npm install -g folder-structure-sync-1.0.1.tgz

# Test commands
folder-sync --help
folder-sync ./test-source ./test-target --dry-run

# Cleanup
npm uninstall -g folder-structure-sync
rm folder-structure-sync-1.0.1.tgz
```

## 📊 Post-Release Tasks

### 1. Verify Publication

```bash
# Check package on npm
npm view folder-structure-sync

# Test installation
npx folder-structure-sync@latest --help
```

### 2. Update Documentation

- [ ] Update README.md if needed
- [ ] Update examples in EXAMPLES.md
- [ ] Check all links work correctly

### 3. Monitor and Promote

- [ ] Check npm download stats
- [ ] Share on social media
- [ ] Update relevant communities

## 🚨 Troubleshooting

### Common Issues

**Git not clean:**

```bash
git status
git stash  # if you want to save changes
# or
git add . && git commit -m "WIP: save changes"
```

**Not logged in to npm:**

```bash
npm login
npm whoami  # verify
```

**Version already exists:**

```bash
# If you need to republish same version (not recommended)
npm publish --force

# Better: increment version
npm version patch
npm publish
```

**Permission denied:**

```bash
# Check if you're a maintainer
npm owner ls folder-structure-sync

# Or contact current maintainer
```

### Recovery from Failed Release

If release script fails midway:

```bash
# Reset version if needed
git reset --hard HEAD~1
git tag -d v1.0.1  # if tag was created

# Or continue from where it failed
git push origin master
git push origin --tags
npm publish
```

## 📈 Version Strategy

### Semantic Versioning (SemVer)

- **MAJOR**: Breaking changes (2.0.0)

  - Change CLI interface
  - Remove features
  - Change file formats

- **MINOR**: New features (1.1.0)

  - Add new options
  - Add new commands
  - Enhance existing features

- **PATCH**: Bug fixes (1.0.1)
  - Fix bugs
  - Update dependencies
  - Improve performance

### Pre-release Versions

For testing major changes:

```bash
npm version 2.0.0-beta.1
npm publish --tag beta

# Users can test with:
npm install folder-structure-sync@beta
```

## 🎯 Checklist Template

Before each release:

- [ ] All features implemented and tested
- [ ] Documentation updated
- [ ] CHANGELOG.md entries added
- [ ] No TODO/FIXME in critical code
- [ ] Git working directory clean
- [ ] Logged in to npm
- [ ] Pre-publish checks pass
- [ ] Package tests pass

After release:

- [ ] npm package verified
- [ ] GitHub release created
- [ ] Documentation links updated
- [ ] Social media announcement
- [ ] Monitor for issues

## 📝 Release Notes Template

```markdown
## 🎉 folder-structure-sync v1.1.0

### ✨ New Features

- Added support for custom configuration profiles
- Improved interactive selection with keyboard shortcuts

### 🐛 Bug Fixes

- Fixed issue with Windows path handling
- Resolved memory leak with large directory structures

### 📖 Documentation

- Updated examples with new features
- Added troubleshooting guide

### 📦 Installation

\`\`\`bash
npm install -g folder-structure-sync@latest
\`\`\`

### 🔗 Links

- [Full Changelog](https://github.com/unique01082/folder-structure-sync/blob/master/CHANGELOG.md)
- [Documentation](https://github.com/unique01082/folder-structure-sync#readme)
- [Issues](https://github.com/unique01082/folder-structure-sync/issues)
```

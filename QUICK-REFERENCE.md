# 🚀 Quick Reference - Publishing New Versions

## ⚡ One-Command Publishing

```bash
# Bug fixes (1.0.0 → 1.0.1)
npm run release:patch

# New features (1.0.0 → 1.1.0)
npm run release:minor

# Breaking changes (1.0.0 → 2.0.0)
npm run release:major
```

Then: `npm publish`

## 🔍 Pre-Flight Checks

```bash
# Run all checks
npm run precheck

# Test package functionality
npm run test-package

# Both checks + publish
npm run publish:safe
```

## 📊 Post-Release Tools

```bash
# Package stats
npm run workflow:stats

# Social media posts
npm run workflow:social

# Promotion checklist
npm run workflow:promotion

# Command reference
npm run workflow:commands
```

## 🎯 Release Workflow

1. **Prepare** → `npm run precheck`
2. **Release** → `npm run release:minor`
3. **Publish** → `npm publish`
4. **Promote** → `npm run workflow:social`

## 🆘 Emergency Commands

```bash
# Check what will be published
npm pack --dry-run

# Verify npm login
npm whoami

# Check package on npm
npm view folder-structure-sync

# Test installation
npx folder-structure-sync@latest --help
```

## 📁 Files Created

- `scripts/release.js` - Automated release process
- `scripts/pre-publish-check.js` - Pre-flight validation
- `scripts/test-package.js` - Package functionality testing
- `scripts/workflow.js` - Workflow automation helpers
- `PUBLISHING.md` - Detailed publishing guide

## 🎉 Ready to Ship!

Your package is now equipped with professional release automation. Just run the commands and follow the prompts!

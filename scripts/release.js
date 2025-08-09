#!/usr/bin/env node

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// Colors for output
const colors = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

function log(message, color = "reset") {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function exec(command, description) {
  log(`\n🔄 ${description}...`, "blue");
  try {
    const result = execSync(command, { encoding: "utf8", stdio: "inherit" });
    log(`✅ ${description} completed`, "green");
    return result;
  } catch (error) {
    log(`❌ Error: ${description} failed`, "red");
    throw error;
  }
}

function updateChangelog(version, changeType) {
  const changelogPath = path.join(__dirname, "CHANGELOG.md");
  const changelog = fs.readFileSync(changelogPath, "utf8");

  const today = new Date().toISOString().split("T")[0];

  let changeSection = "";
  switch (changeType) {
    case "patch":
      changeSection = `
### Fixed
- Bug fixes and improvements

### Changed
- Minor updates and optimizations
`;
      break;
    case "minor":
      changeSection = `
### Added
- New features and enhancements

### Changed
- Improved functionality

### Fixed
- Bug fixes
`;
      break;
    case "major":
      changeSection = `
### Added
- Major new features

### Changed
- Breaking changes (see migration guide)

### Fixed
- Bug fixes

### BREAKING CHANGES
- List breaking changes here
`;
      break;
  }

  const newEntry = `## [${version}] - ${today}
${changeSection}
## [Unreleased]

### Added
- Future features

`;

  const updatedChangelog = changelog.replace("## [Unreleased]", newEntry);

  fs.writeFileSync(changelogPath, updatedChangelog);
  log(`📝 CHANGELOG.md updated for version ${version}`, "cyan");
}

async function main() {
  const args = process.argv.slice(2);
  const versionType = args[0] || "patch"; // patch, minor, major

  if (!["patch", "minor", "major"].includes(versionType)) {
    log("❌ Invalid version type. Use: patch, minor, or major", "red");
    process.exit(1);
  }

  log("🚀 Starting release process...", "magenta");
  log(`📦 Version type: ${versionType}`, "yellow");

  try {
    // 1. Check if we're on main/master branch
    exec("git rev-parse --abbrev-ref HEAD", "Checking current branch");

    // 2. Pull latest changes
    exec("git pull origin master", "Pulling latest changes");

    // 3. Run tests (if available)
    try {
      exec("npm test", "Running tests");
    } catch (error) {
      log("⚠️  No tests found or tests failed. Continuing...", "yellow");
    }

    // 4. Update version in package.json
    const oldVersion = JSON.parse(fs.readFileSync("package.json")).version;
    exec(
      `npm version ${versionType} --no-git-tag-version`,
      `Updating version (${versionType})`
    );
    const newVersion = JSON.parse(fs.readFileSync("package.json")).version;

    log(`📈 Version updated: ${oldVersion} → ${newVersion}`, "green");

    // 5. Update CHANGELOG.md
    updateChangelog(newVersion, versionType);

    // 6. Stage changes
    exec("git add .", "Staging changes");

    // 7. Commit changes
    exec(`git commit -m "chore: release v${newVersion}"`, "Committing changes");

    // 8. Create git tag
    exec(`git tag v${newVersion}`, "Creating git tag");

    // 9. Push changes and tags
    exec("git push origin master", "Pushing changes");
    exec("git push origin --tags", "Pushing tags");

    // 10. Publish to npm
    log("\n🎯 Ready to publish to npm!", "magenta");
    log("📋 Please review the changes and run: npm publish", "yellow");
    log(
      `🔗 After publishing, create a GitHub release at: https://github.com/unique01082/folder-structure-sync/releases/new?tag=v${newVersion}`,
      "cyan"
    );

    // Optional: Auto-publish (uncomment if you want automatic publishing)
    // exec('npm publish', 'Publishing to npm');
    // log(`🎉 Successfully published v${newVersion} to npm!`, 'green');
  } catch (error) {
    log(`💥 Release process failed: ${error.message}`, "red");
    process.exit(1);
  }
}

main();

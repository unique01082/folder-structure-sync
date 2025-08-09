#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

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

function checkFile(filePath, description) {
  if (fs.existsSync(filePath)) {
    log(`✅ ${description}`, "green");
    return true;
  } else {
    log(`❌ ${description}`, "red");
    return false;
  }
}

function checkPackageJson() {
  const packagePath = path.join(process.cwd(), "package.json");
  if (!fs.existsSync(packagePath)) {
    log("❌ package.json not found", "red");
    return false;
  }

  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  let allGood = true;

  // Check required fields
  const requiredFields = [
    "name",
    "version",
    "description",
    "main",
    "bin",
    "repository",
    "keywords",
    "author",
    "license",
  ];

  requiredFields.forEach((field) => {
    if (pkg[field]) {
      log(`✅ package.json has ${field}`, "green");
    } else {
      log(`❌ package.json missing ${field}`, "red");
      allGood = false;
    }
  });

  // Check version format
  const versionRegex = /^\d+\.\d+\.\d+$/;
  if (versionRegex.test(pkg.version)) {
    log(`✅ Version format valid: ${pkg.version}`, "green");
  } else {
    log(`❌ Invalid version format: ${pkg.version}`, "red");
    allGood = false;
  }

  return allGood;
}

function checkGitStatus() {
  try {
    const status = execSync("git status --porcelain", { encoding: "utf8" });
    if (status.trim() === "") {
      log("✅ Git working directory clean", "green");
      return true;
    } else {
      log("⚠️  Git working directory has uncommitted changes:", "yellow");
      log(status, "yellow");
      return false;
    }
  } catch (error) {
    log("❌ Error checking git status", "red");
    return false;
  }
}

function checkNpmLogin() {
  try {
    const whoami = execSync("npm whoami", { encoding: "utf8" });
    log(`✅ Logged in to npm as: ${whoami.trim()}`, "green");
    return true;
  } catch (error) {
    log("❌ Not logged in to npm. Run: npm login", "red");
    return false;
  }
}

function checkTests() {
  const packagePath = path.join(process.cwd(), "package.json");
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));

  if (
    pkg.scripts &&
    pkg.scripts.test &&
    !pkg.scripts.test.includes("no test specified")
  ) {
    try {
      execSync("npm test", { stdio: "pipe" });
      log("✅ Tests pass", "green");
      return true;
    } catch (error) {
      log("❌ Tests fail", "red");
      return false;
    }
  } else {
    log("⚠️  No tests found", "yellow");
    return true; // Not a failure, just a warning
  }
}

function main() {
  log("🔍 Pre-publish checklist", "magenta");
  log("========================\n", "magenta");

  let allChecksPass = true;

  // File existence checks
  log("📁 Checking required files:", "blue");
  allChecksPass &= checkFile("package.json", "package.json exists");
  allChecksPass &= checkFile("README.md", "README.md exists");
  allChecksPass &= checkFile("LICENSE", "LICENSE exists");
  allChecksPass &= checkFile("CHANGELOG.md", "CHANGELOG.md exists");
  allChecksPass &= checkFile("index.js", "index.js (main file) exists");
  allChecksPass &= checkFile("sync-config.json", "sync-config.json exists");

  log("\n📦 Checking package.json:", "blue");
  allChecksPass &= checkPackageJson();

  log("\n🔧 Checking git status:", "blue");
  allChecksPass &= checkGitStatus();

  log("\n🔑 Checking npm authentication:", "blue");
  allChecksPass &= checkNpmLogin();

  log("\n🧪 Checking tests:", "blue");
  allChecksPass &= checkTests();

  // Additional checks
  log("\n🔍 Additional checks:", "blue");

  // Check if there are any TODO comments
  try {
    const result = execSync(
      'grep -r "TODO\\|FIXME\\|XXX" --include="*.js" --include="*.md" .',
      { encoding: "utf8" }
    );
    if (result.trim()) {
      log("⚠️  Found TODO/FIXME comments:", "yellow");
      log(result, "yellow");
    }
  } catch (error) {
    log("✅ No TODO/FIXME comments found", "green");
  }

  // Summary
  log("\n" + "=".repeat(50), "magenta");
  if (allChecksPass) {
    log("🎉 All checks passed! Ready to publish.", "green");
    log("\n📋 Next steps:", "cyan");
    log("1. Run: node scripts/release.js [patch|minor|major]", "cyan");
    log("2. Review the changes", "cyan");
    log("3. Run: npm publish", "cyan");
    log("4. Create GitHub release", "cyan");
  } else {
    log(
      "❌ Some checks failed. Please fix the issues before publishing.",
      "red"
    );
    process.exit(1);
  }
}

main();

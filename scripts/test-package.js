#!/usr/bin/env node

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

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

function exec(command, description, options = {}) {
  log(`\n🔄 ${description}...`, "blue");
  try {
    const result = execSync(command, {
      encoding: "utf8",
      stdio: options.silent ? "pipe" : "inherit",
      ...options,
    });
    log(`✅ ${description} completed`, "green");
    return result;
  } catch (error) {
    log(`❌ Error: ${description} failed`, "red");
    if (options.continueOnError) {
      return null;
    }
    throw error;
  }
}

function createTestStructure(testDir) {
  const sourceDir = path.join(testDir, "test-source");
  const targetDir = path.join(testDir, "test-target");

  // Create source structure
  const sourceDirs = [
    "src",
    "src/components",
    "src/utils",
    "src/components/ui",
    "docs",
    "docs/api",
    "tests",
    "tests/unit",
    "tests/integration",
    "config",
    "scripts",
  ];

  sourceDirs.forEach((dir) => {
    fs.mkdirSync(path.join(sourceDir, dir), { recursive: true });
  });

  // Create partial target structure (missing some folders)
  const targetDirs = ["src", "docs"];

  targetDirs.forEach((dir) => {
    fs.mkdirSync(path.join(targetDir, dir), { recursive: true });
  });

  log(`📁 Created test structure in ${testDir}`, "cyan");
  return { sourceDir, targetDir };
}

function cleanup(testDir) {
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
    log(`🧹 Cleaned up test directory: ${testDir}`, "cyan");
  }
}

async function main() {
  log("🧪 Testing package functionality", "magenta");
  log("================================\n", "magenta");

  const testDir = path.join(os.tmpdir(), `folder-sync-test-${Date.now()}`);
  let packageTarball = null;

  try {
    // 1. Create package tarball
    log("📦 Creating package tarball for testing...", "blue");
    const packResult = exec("npm pack", "Creating package");
    packageTarball = packResult?.trim().split("\n").pop();

    if (!packageTarball) {
      throw new Error("Failed to create package tarball");
    }

    // 2. Create test environment
    fs.mkdirSync(testDir, { recursive: true });
    const { sourceDir, targetDir } = createTestStructure(testDir);

    // 3. Test local installation
    log("\n📥 Testing local installation...", "blue");
    const installDir = path.join(testDir, "install-test");
    fs.mkdirSync(installDir, { recursive: true });

    // Copy tarball to test directory
    const tarballPath = path.join(process.cwd(), packageTarball);
    const testTarballPath = path.join(installDir, packageTarball);
    fs.copyFileSync(tarballPath, testTarballPath);

    // Install package locally
    exec(`npm install ${testTarballPath}`, "Installing package locally", {
      cwd: installDir,
    });

    // 4. Test CLI functionality
    log("\n🎮 Testing CLI functionality...", "blue");

    // Test help command
    exec("npx folder-structure-sync --help", "Testing help command", {
      cwd: installDir,
    });

    // Test version command
    exec("npx folder-structure-sync --version", "Testing version command", {
      cwd: installDir,
    });

    // Test dry run
    exec(
      `npx folder-structure-sync "${sourceDir}" "${targetDir}" --dry-run`,
      "Testing dry run",
      { cwd: installDir }
    );

    // Test auto mode
    exec(
      `npx folder-structure-sync "${sourceDir}" "${targetDir}" --auto`,
      "Testing auto mode",
      { cwd: installDir }
    );

    // 5. Verify results
    log("\n🔍 Verifying results...", "blue");
    const expectedDirs = [
      "src/components",
      "src/utils",
      "src/components/ui",
      "docs/api",
      "tests",
      "tests/unit",
      "tests/integration",
      "config",
      "scripts",
    ];

    let verificationPassed = true;
    expectedDirs.forEach((dir) => {
      const dirPath = path.join(targetDir, dir);
      if (fs.existsSync(dirPath)) {
        log(`✅ Directory created: ${dir}`, "green");
      } else {
        log(`❌ Directory missing: ${dir}`, "red");
        verificationPassed = false;
      }
    });

    // 6. Test npx usage (simulate global usage)
    log("\n🌐 Testing npx usage...", "blue");
    const npxTestDir = path.join(testDir, "npx-test");
    fs.mkdirSync(npxTestDir, { recursive: true });

    // This would test the actual npm package if published
    // exec(`npx folder-structure-sync@latest --help`, 'Testing npx with published package', {
    //   cwd: npxTestDir,
    //   continueOnError: true
    // });

    // 7. Performance test with larger structure
    log("\n⚡ Testing performance with larger structure...", "blue");
    const perfSourceDir = path.join(testDir, "perf-source");
    const perfTargetDir = path.join(testDir, "perf-target");

    // Create a larger directory structure
    for (let i = 0; i < 50; i++) {
      fs.mkdirSync(
        path.join(perfSourceDir, `dir-${i}`, "subdirs", `sub-${i}`),
        { recursive: true }
      );
    }
    fs.mkdirSync(perfTargetDir, { recursive: true });

    const startTime = Date.now();
    exec(
      `npx folder-structure-sync "${perfSourceDir}" "${perfTargetDir}" --auto`,
      "Testing with large structure",
      { cwd: installDir }
    );
    const endTime = Date.now();

    log(`⏱️  Performance test completed in ${endTime - startTime}ms`, "cyan");

    // Summary
    log("\n" + "=".repeat(50), "magenta");
    if (verificationPassed) {
      log("🎉 All tests passed! Package is working correctly.", "green");
      log("\n📋 Test Summary:", "cyan");
      log("✅ Package creation", "green");
      log("✅ Local installation", "green");
      log("✅ CLI commands (help, version)", "green");
      log("✅ Dry run functionality", "green");
      log("✅ Auto mode functionality", "green");
      log("✅ Directory creation verification", "green");
      log("✅ Performance test", "green");
    } else {
      log("❌ Some tests failed. Please check the issues.", "red");
      process.exit(1);
    }
  } catch (error) {
    log(`💥 Testing failed: ${error.message}`, "red");
    process.exit(1);
  } finally {
    // Cleanup
    cleanup(testDir);
    if (packageTarball && fs.existsSync(packageTarball)) {
      fs.unlinkSync(packageTarball);
      log(`🧹 Removed package tarball: ${packageTarball}`, "cyan");
    }
  }
}

main();

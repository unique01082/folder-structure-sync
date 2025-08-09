#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { Command } = require("commander");
const chalk = require("chalk");
const inquirer = require("inquirer");
const cliProgress = require("cli-progress");

// Configuration
let config = {};
try {
  config = require("./sync-config.json");
} catch (error) {
  console.log(
    chalk.yellow("⚠️  No config file found, using default exclusions")
  );
  config = {
    defaultExclusions: [".git", "node_modules", ".DS_Store"],
    customExclusions: [],
  };
}

const program = new Command();

// CLI Setup
program
  .name("folder-sync")
  .description("Sync folder structures between source and target directories")
  .version("1.0.0")
  .argument("<source>", "Source directory path")
  .argument("<target>", "Target directory path")
  .option("-d, --dry-run", "Preview changes without executing")
  .option("-v, --verbose", "Show detailed output")
  .option("-a, --auto", "Auto-create all missing folders without prompting")
  .action(async (source, target, options) => {
    try {
      await syncFolders(source, target, options);
    } catch (error) {
      console.error(chalk.red("❌ Error:"), error.message);
      process.exit(1);
    }
  });

// Main sync function
async function syncFolders(sourcePath, targetPath, options) {
  // Validate paths
  console.log(chalk.blue("🔍 Validating paths..."));

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source directory does not exist: ${sourcePath}`);
  }

  if (!fs.existsSync(targetPath)) {
    console.log(
      chalk.yellow(`⚠️  Target directory does not exist: ${targetPath}`)
    );
    const { createTarget } = await inquirer.prompt([
      {
        type: "confirm",
        name: "createTarget",
        message: "Would you like to create the target directory?",
        default: true,
      },
    ]);

    if (createTarget) {
      if (!options.dryRun) {
        fs.mkdirSync(targetPath, { recursive: true });
        console.log(chalk.green(`✅ Created target directory: ${targetPath}`));
      } else {
        console.log(
          chalk.blue(`📋 Would create target directory: ${targetPath}`)
        );
      }
    } else {
      throw new Error("Cannot proceed without target directory");
    }
  }

  // Get exclusion patterns
  const exclusions = [...config.defaultExclusions, ...config.customExclusions];

  // Scan directories
  console.log(chalk.blue("📁 Scanning source directory..."));
  const sourceFolders = await scanDirectory(sourcePath, exclusions);

  console.log(chalk.blue("📁 Scanning target directory..."));
  const targetFolders = await scanDirectory(targetPath, exclusions);

  // Find missing folders
  const missingFolders = findMissingFolders(
    sourceFolders,
    targetFolders,
    sourcePath,
    targetPath
  );

  if (missingFolders.length === 0) {
    console.log(chalk.green("✅ All folders are already synchronized!"));
    return;
  }

  // Display missing folders
  console.log(
    chalk.yellow(
      `\n📂 Found ${missingFolders.length} missing folders in target:`
    )
  );
  missingFolders.forEach((folder, index) => {
    const depth = folder.relativePath.split(path.sep).length - 1;
    const indent = "  ".repeat(depth);
    const color = getColorForDepth(depth);
    console.log(chalk[color](`${indent}[${index + 1}] ${folder.relativePath}`));
  });

  let selectedFolders = [];

  if (options.auto) {
    selectedFolders = missingFolders;
    console.log(
      chalk.blue("\n🚀 Auto mode: All missing folders will be created")
    );
  } else {
    // Interactive selection
    selectedFolders = await selectFolders(missingFolders);
  }

  if (selectedFolders.length === 0) {
    console.log(chalk.yellow("👋 No folders selected. Exiting..."));
    return;
  }

  // Handle dependencies (auto-select parent folders)
  const finalSelection = handleDependencies(selectedFolders, missingFolders);

  // Show final confirmation
  if (!options.auto) {
    console.log(chalk.cyan("\n📋 Folders to be created:"));
    finalSelection.forEach((folder, index) => {
      const fullPath = path.join(targetPath, folder.relativePath);
      console.log(chalk.white(`  ${index + 1}. ${fullPath}`));
    });

    const { confirm } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirm",
        message: `Create ${finalSelection.length} folder(s)?`,
        default: true,
      },
    ]);

    if (!confirm) {
      console.log(chalk.yellow("👋 Operation cancelled."));
      return;
    }
  }

  // Create folders
  await createFolders(finalSelection, targetPath, options);

  // Summary
  console.log(
    chalk.green(`\n🎉 Successfully processed ${finalSelection.length} folders!`)
  );
  if (options.dryRun) {
    console.log(
      chalk.blue("📋 This was a dry run - no actual changes were made.")
    );
  }
}

// Scan directory for folders
async function scanDirectory(dirPath, exclusions) {
  const folders = [];

  function scanRecursively(currentPath, relativePath = "") {
    try {
      const items = fs.readdirSync(currentPath);

      for (const item of items) {
        const itemPath = path.join(currentPath, item);
        const itemRelativePath = path.join(relativePath, item);

        // Skip excluded patterns
        if (
          exclusions.some((pattern) => {
            if (pattern.includes("*")) {
              const regex = new RegExp(pattern.replace(/\*/g, ".*"));
              return regex.test(item);
            }
            return item === pattern || itemRelativePath.includes(pattern);
          })
        ) {
          continue;
        }

        const stats = fs.statSync(itemPath);
        if (stats.isDirectory()) {
          folders.push({
            name: item,
            fullPath: itemPath,
            relativePath: itemRelativePath,
          });

          // Recursively scan subdirectories
          scanRecursively(itemPath, itemRelativePath);
        }
      }
    } catch (error) {
      console.warn(
        chalk.yellow(
          `⚠️  Warning: Could not scan ${currentPath}: ${error.message}`
        )
      );
    }
  }

  scanRecursively(dirPath);
  return folders;
}

// Find missing folders
function findMissingFolders(
  sourceFolders,
  targetFolders,
  sourcePath,
  targetPath
) {
  const targetRelativePaths = new Set(targetFolders.map((f) => f.relativePath));

  return sourceFolders.filter((sourceFolder) => {
    return !targetRelativePaths.has(sourceFolder.relativePath);
  });
}

// Interactive folder selection
async function selectFolders(missingFolders) {
  console.log(chalk.cyan("\n🎯 Select folders to create:"));
  console.log(
    chalk.gray(
      "   Use arrow keys to navigate, space to toggle, enter to confirm"
    )
  );

  const choices = missingFolders.map((folder, index) => {
    const depth = folder.relativePath.split(path.sep).length - 1;
    const indent = "  ".repeat(depth);
    return {
      name: `${indent}${folder.relativePath}`,
      value: folder,
      checked: true,
    };
  });

  const { selectedFolders } = await inquirer.prompt([
    {
      type: "checkbox",
      name: "selectedFolders",
      message: "Select folders to create:",
      choices: choices,
      pageSize: 15,
    },
  ]);

  // Also allow manual number input
  if (selectedFolders.length === 0) {
    const { manualSelection } = await inquirer.prompt([
      {
        type: "input",
        name: "manualSelection",
        message: "Or enter folder numbers separated by commas (e.g., 1,3,5):",
        validate: (input) => {
          if (!input.trim()) return true; // Allow empty for no selection
          const numbers = input.split(",").map((n) => parseInt(n.trim()));
          const invalid = numbers.some(
            (n) => isNaN(n) || n < 1 || n > missingFolders.length
          );
          return invalid
            ? `Please enter valid numbers between 1 and ${missingFolders.length}`
            : true;
        },
      },
    ]);

    if (manualSelection.trim()) {
      const indices = manualSelection
        .split(",")
        .map((n) => parseInt(n.trim()) - 1);
      return indices.map((i) => missingFolders[i]);
    }
  }

  return selectedFolders;
}

// Handle dependencies (ensure parent folders are included)
function handleDependencies(selectedFolders, allMissingFolders) {
  const selectedPaths = new Set(selectedFolders.map((f) => f.relativePath));
  const result = [...selectedFolders];

  // For each selected folder, ensure all parent folders are included
  selectedFolders.forEach((folder) => {
    const pathParts = folder.relativePath.split(path.sep);

    // Check each parent path
    for (let i = 1; i < pathParts.length; i++) {
      const parentPath = pathParts.slice(0, i).join(path.sep);

      if (!selectedPaths.has(parentPath)) {
        // Find the parent folder in missing folders
        const parentFolder = allMissingFolders.find(
          (f) => f.relativePath === parentPath
        );
        if (parentFolder) {
          result.push(parentFolder);
          selectedPaths.add(parentPath);
        }
      }
    }
  });

  // Sort by path depth to create parent folders first
  return result.sort((a, b) => {
    const depthA = a.relativePath.split(path.sep).length;
    const depthB = b.relativePath.split(path.sep).length;
    return depthA - depthB;
  });
}

// Create folders with progress
async function createFolders(folders, targetPath, options) {
  if (options.dryRun) {
    console.log(chalk.blue("\n📋 Dry run - folders that would be created:"));
    folders.forEach((folder, index) => {
      const fullPath = path.join(targetPath, folder.relativePath);
      console.log(chalk.white(`  ${index + 1}. ${fullPath}`));
    });
    return;
  }

  console.log(chalk.blue("\n🚀 Creating folders..."));

  const progressBar = new cliProgress.SingleBar({
    format:
      "Progress |" +
      chalk.cyan("{bar}") +
      "| {percentage}% | {value}/{total} folders | {folder}",
    barCompleteChar: "\u2588",
    barIncompleteChar: "\u2591",
    hideCursor: true,
  });

  progressBar.start(folders.length, 0, { folder: "" });

  let created = 0;
  let errors = 0;

  for (let i = 0; i < folders.length; i++) {
    const folder = folders[i];
    const fullPath = path.join(targetPath, folder.relativePath);

    progressBar.update(i + 1, { folder: folder.relativePath });

    try {
      fs.mkdirSync(fullPath, { recursive: true });
      created++;

      if (options.verbose) {
        console.log(`\n${chalk.green("✅")} Created: ${fullPath}`);
      }
    } catch (error) {
      errors++;
      console.log(
        `\n${chalk.red("❌")} Error creating ${fullPath}: ${error.message}`
      );
    }

    // Small delay for visual effect
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  progressBar.stop();

  console.log(
    chalk.green(`\n📊 Summary: ${created} created, ${errors} errors`)
  );
}

// Get color based on folder depth
function getColorForDepth(depth) {
  const colors = ["cyan", "yellow", "green", "magenta", "blue", "white"];
  return colors[depth % colors.length];
}

// Parse command line arguments
program.parse();

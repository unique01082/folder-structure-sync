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

function generateStats() {
  try {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    const packageSize = execSync(
      'npm pack --dry-run 2>/dev/null | grep "package size" || echo "Size: Unknown"',
      { encoding: "utf8" }
    ).trim();

    log("\n📊 Package Statistics:", "cyan");
    log(`Name: ${pkg.name}`, "white");
    log(`Version: ${pkg.version}`, "white");
    log(`${packageSize}`, "white");
    log(`Dependencies: ${Object.keys(pkg.dependencies || {}).length}`, "white");
    log(`Keywords: ${(pkg.keywords || []).length}`, "white");

    // File analysis
    const jsFiles = execSync(
      'find . -name "*.js" -not -path "./node_modules/*" -not -path "./scripts/*" | wc -l',
      { encoding: "utf8" }
    ).trim();
    const mdFiles = execSync(
      'find . -name "*.md" -not -path "./node_modules/*" | wc -l',
      { encoding: "utf8" }
    ).trim();

    log(`JavaScript files: ${jsFiles}`, "white");
    log(`Documentation files: ${mdFiles}`, "white");
  } catch (error) {
    log("⚠️  Could not generate full statistics", "yellow");
  }
}

function generateSocialPosts(version) {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));

  log("\n📱 Social Media Posts:", "cyan");
  log("=".repeat(50), "cyan");

  // Twitter/X post
  log("\n🐦 Twitter/X:", "blue");
  log(
    `🎉 Just released ${pkg.name} v${version}!

📁 Interactive CLI tool for syncing folder structures
✨ Smart selection, dependency handling, beautiful output

Perfect for:
🏗️ Project templates
👥 Team environments  
🤖 CI/CD automation

Try it: npm install -g ${pkg.name}

#npm #nodejs #cli #opensource #developer`,
    "white"
  );

  // LinkedIn post
  log("\n💼 LinkedIn:", "blue");
  log(
    `Excited to announce the release of ${pkg.name} v${version}! 🚀

This interactive CLI tool helps developers sync folder structures with smart selection and dependency handling. 

Key features:
• Interactive checkbox selection
• Automatic parent folder inclusion
• Configurable exclusion patterns
• Beautiful progress bars and colored output
• Cross-platform support

Perfect for project templates, team environment setup, and automation workflows.

Installation: npm install -g ${pkg.name}
GitHub: https://github.com/unique01082/${pkg.name}

#SoftwareDevelopment #OpenSource #NodeJS #CLI #DeveloperTools`,
    "white"
  );

  // Dev.to post structure
  log("\n📝 Dev.to Post Outline:", "blue");
  log(
    `Title: "Building an Interactive CLI Tool for Folder Structure Synchronization"

Intro:
- Problem: Managing consistent folder structures across projects
- Solution: Interactive CLI with smart features

Features showcase:
- Interactive selection with demos
- Smart dependency resolution
- Configuration and exclusions
- Cross-platform compatibility

Technical highlights:
- Node.js with Commander.js, Inquirer.js, Chalk
- Recursive directory scanning
- Progress tracking

Installation and usage examples

Conclusion and future roadmap`,
    "white"
  );
}

function generatePromotionPlan(version) {
  log("\n📈 Promotion Plan:", "cyan");
  log("=".repeat(40), "cyan");

  const tasks = [
    "📦 Verify npm package is live",
    "🏷️ Create GitHub release with changelog",
    "📱 Post on Twitter/X",
    "💼 Share on LinkedIn",
    "📝 Write Dev.to article",
    "💬 Share in relevant Discord servers",
    "🗣️ Post in Reddit communities (r/node, r/programming)",
    "📧 Email to relevant newsletters",
    "🌟 Submit to awesome-nodejs lists",
    "📊 Monitor download stats",
    "🐛 Monitor for issues and feedback",
  ];

  tasks.forEach((task, index) => {
    log(`${index + 1}. ${task}`, "white");
  });

  log("\n🎯 Target Communities:", "yellow");
  const communities = [
    "Reddit: r/node, r/programming, r/webdev",
    "Discord: Reactiflux, NodeJS, The Coding Den",
    "Slack: NodeJS community",
    "Dev.to: #node, #cli, #opensource tags",
    "Hacker News (if gets traction)",
    "Product Hunt (for more visibility)",
  ];

  communities.forEach((community) => {
    log(`• ${community}`, "white");
  });
}

function showQuickCommands() {
  log("\n⚡ Quick Commands Reference:", "cyan");
  log("=".repeat(35), "cyan");

  const commands = [
    ["Check before release", "npm run precheck"],
    ["Test package", "npm run test-package"],
    ["Release patch", "npm run release:patch"],
    ["Release minor", "npm run release:minor"],
    ["Release major", "npm run release:major"],
    ["Safe publish", "npm run publish:safe"],
    ["Check npm stats", "npm view folder-structure-sync"],
    ["Test installation", "npx folder-structure-sync@latest --help"],
  ];

  commands.forEach(([desc, cmd]) => {
    log(`${desc.padEnd(20)} : ${cmd}`, "white");
  });
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  log("🛠️  Folder Structure Sync - Workflow Helper", "magenta");
  log("=".repeat(50), "magenta");

  switch (command) {
    case "stats":
      generateStats();
      break;

    case "social":
      const version = JSON.parse(
        fs.readFileSync("package.json", "utf8")
      ).version;
      generateSocialPosts(version);
      break;

    case "promotion":
      const currentVersion = JSON.parse(
        fs.readFileSync("package.json", "utf8")
      ).version;
      generatePromotionPlan(currentVersion);
      break;

    case "commands":
      showQuickCommands();
      break;

    default:
      log("\n📋 Available commands:", "blue");
      log(
        "node scripts/workflow.js stats      - Show package statistics",
        "white"
      );
      log(
        "node scripts/workflow.js social     - Generate social media posts",
        "white"
      );
      log("node scripts/workflow.js promotion  - Show promotion plan", "white");
      log("node scripts/workflow.js commands   - Show quick commands", "white");

      log("\n🚀 Quick Start:", "green");
      log("1. npm run precheck", "white");
      log("2. npm run release:patch|minor|major", "white");
      log("3. npm publish", "white");
      log("4. node scripts/workflow.js social", "white");
      break;
  }
}

main();

# Folder Structure Sync - Usage Examples

## Example 1: Basic Interactive Sync

```bash
node index.js ./my-project-source ./my-project-target
```

This will:

1. Scan both directories
2. Show missing folders with colored, indented display
3. Let you select which folders to create using checkboxes
4. Auto-include parent folders for dependencies
5. Show confirmation before creating
6. Create folders with progress bar

## Example 2: Dry Run (Preview Only)

```bash
node index.js ./source ./target --dry-run
```

Perfect for:

- Checking what would be created without making changes
- Planning your sync strategy
- Verifying exclusion rules work correctly

## Example 3: Auto Mode (No Prompts)

```bash
node index.js ./source ./target --auto
```

Great for:

- Automated scripts
- CI/CD pipelines
- When you trust the source structure completely

## Example 4: Verbose Output

```bash
node index.js ./source ./target --verbose
```

Shows:

- Detailed folder creation messages
- Full paths being created
- Any warnings or errors encountered

## Example 5: Combined Options

```bash
node index.js ./source ./target --dry-run --verbose --auto
```

Ultimate preview mode:

- Shows everything that would happen
- No actual changes made
- Detailed output

## Interactive Selection Examples

### Checkbox Interface

```
Missing folders found in target:
[1] ✓ src/
[2] ✓ src/components/
[3] ✗ src/utils/
[4] ✓ docs/
[5] ✗ docs/images/
[6] ✓ tests/

Use arrow keys to navigate, space to toggle, enter to confirm
```

### Manual Number Input

```
Or enter folder numbers separated by commas (e.g., 1,3,5): 2,4,6
```

## Configuration Examples

### Default sync-config.json

```json
{
  "defaultExclusions": [
    ".git",
    "node_modules",
    ".DS_Store",
    "Thumbs.db",
    ".vscode",
    ".idea",
    "*.tmp",
    "*.log",
    "dist",
    "build"
  ],
  "customExclusions": []
}
```

### Custom Exclusions

```json
{
  "defaultExclusions": [...],
  "customExclusions": [
    "my-temp-folder",
    "*.backup",
    "old-*",
    ".custom-cache"
  ]
}
```

## Common Use Cases

### 1. Project Template Sync

Keep your project templates in sync across different environments:

```bash
node index.js ./project-template ./new-project --auto
```

### 2. Development Environment Setup

Replicate folder structure for new team members:

```bash
node index.js ./team-project-structure ./my-local-copy
```

### 3. Backup Folder Structure

Create folder structure in backup location:

```bash
node index.js ./production ./backup-structure --dry-run
# Review, then:
node index.js ./production ./backup-structure --auto
```

### 4. Migration Planning

Preview folder structure changes before migration:

```bash
node index.js ./old-structure ./new-structure --dry-run --verbose
```

## Error Handling Examples

### Missing Source Directory

```
❌ Error: Source directory does not exist: ./non-existent-path
```

### Missing Target Directory

```
⚠️  Target directory does not exist: ./new-target
? Would you like to create the target directory? (Y/n)
```

### Permission Errors

```
❌ Error creating C:\restricted\folder: EACCES: permission denied
📊 Summary: 4 created, 1 errors
```

## Advanced Tips

### 1. Test Before Production

Always use `--dry-run` first:

```bash
# Test
node index.js ./source ./target --dry-run

# Execute
node index.js ./source ./target --auto
```

### 2. Selective Sync

Use interactive mode to sync only specific parts:

```bash
node index.js ./large-project ./partial-copy
# Select only the folders you need
```

### 3. Automation Integration

For scripts and automation:

```bash
# Silent, automatic execution
node index.js "$SOURCE_DIR" "$TARGET_DIR" --auto > sync.log 2>&1
```

### 4. Configuration Management

Keep different config files for different scenarios:

```bash
# Copy appropriate config before running
cp sync-config-production.json sync-config.json
node index.js ./source ./target --auto
```

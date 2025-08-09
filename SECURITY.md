# Security Policy

## Supported Versions

We support the latest version of folder-structure-sync. Please ensure you're using the most recent version before reporting security issues.

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it by emailing [your-email@example.com] or creating a private security advisory on GitHub.

**Please do NOT report security vulnerabilities through public GitHub issues.**

When reporting a vulnerability, please include:

- Description of the vulnerability
- Steps to reproduce the issue
- Potential impact
- Any suggested fixes

We will respond to security reports within 48 hours and provide regular updates on our progress.

## Security Considerations

This tool:

- Only creates directories (never modifies or deletes existing content)
- Respects filesystem permissions
- Does not execute any external commands
- Does not transmit data over the network
- Reads configuration only from local JSON files

## Best Practices

When using this tool:

- Always use `--dry-run` first in production environments
- Review the list of folders to be created before confirming
- Ensure you have appropriate permissions for the target directory
- Use version control for your configuration files
- Regularly update to the latest version

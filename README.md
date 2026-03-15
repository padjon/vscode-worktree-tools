# Worktree Tools

[![Install on Marketplace](https://img.shields.io/badge/Marketplace-Worktree%20Tools-0078D4?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=padjon.vscode-worktree-tools)
[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor-GitHub%20Sponsors-EA4AAA?style=for-the-badge&logo=githubsponsors&logoColor=white)](https://github.com/sponsors/padjon)

Utilities for Git worktree workflows in VS Code.

The first command in this extension is:

- `Worktree: Migrate Configured Worktree Changes`

It runs VS Code's built-in `Git: Migrate Worktree Changes` behavior for a predefined list of worktrees, one after another.

## Why This Exists

If you work with several linked Git worktrees, migrating changes back into one destination repository is repetitive. This extension lets you define that list once and run the sequence with a single command.

The migration logic itself is not reimplemented here. `Worktree Tools` uses VS Code's built-in Git extension API so migration behavior stays aligned with core VS Code.

## Features

- Run the built-in worktree migration flow across multiple configured worktrees.
- Resolve worktrees by absolute path, workspace-relative path, or unique folder name.
- Stop on conflicts so you can resolve them immediately.
- Optionally continue after individual migration failures.

## Configuration

Add settings like:

```json
{
  "worktreeTools.migrationTargets": [
    "../1",
    "../3",
    "feature-a"
  ],
  "worktreeTools.continueOnMigrationError": false
}
```

`worktreeTools.migrationTargets` supports:

- absolute paths
- paths relative to the current workspace folder
- unique worktree folder names

`worktreeTools.continueOnMigrationError` controls whether the command should continue with later configured worktrees after one migration fails.

## Current Behavior

When you run `Worktree: Migrate Configured Worktree Changes`, the extension:

1. Uses the current repository as the destination.
2. Resolves configured worktree targets.
3. Runs migrations sequentially.
4. Stops if conflicts are introduced.

Detailed progress and failures are written to the `Worktree Tools` output channel.

## Requirements

- VS Code with the built-in Git extension enabled
- A repository with linked Git worktrees

## Roadmap

This extension is intended to grow into a broader toolbox for worktree workflows. Batch migration is the first command, not the final scope.

## Release Notes

### 0.2.0

- Rename the extension to `Worktree Tools`
- Rename the extension id to `padjon.vscode-worktree-tools`
- Add broader positioning for future worktree utilities

### 0.1.0

Initial batch migration release.

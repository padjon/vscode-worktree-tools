# Change Log

## 0.2.3

- Improve worktree target resolution for copied workspace settings
- Avoid basename fallback for path-like targets
- Show resolved migration targets in the output channel before the batch starts

## 0.2.2

- Fix loading the built-in Git API when the Git extension is already active

## 0.2.1

- Add repository and package funding metadata

## 0.2.0

- Rename the extension to `Worktree Tools`
- Rename the extension id to `padjon.vscode-worktree-tools`
- Rename settings to `worktreeTools.migrationTargets` and `worktreeTools.continueOnMigrationError`
- Position the project as a broader worktree utility extension

## 0.1.0

- Initial release.
- Adds `Git: Migrate Configured Worktree Changes`.
- Reuses VS Code's built-in Git worktree migration flow for a predefined list of worktrees.

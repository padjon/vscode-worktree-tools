# Worktree Tools

[![Install on Marketplace](https://img.shields.io/badge/Marketplace-Worktree%20Tools-0078D4?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=padjon.vscode-worktree-tools)
[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor-GitHub%20Sponsors-EA4AAA?style=for-the-badge&logo=githubsponsors&logoColor=white)](https://github.com/sponsors/padjon)

Utilities for Git worktree workflows in VS Code.

Commands in this extension:

- `Worktree: Sync Worktrees => Main Workdir`
- `Worktree: Sync Main Workdir => Worktrees`
- `Worktree: Sync Worktrees => Main Workdir (Rebase Main First)`

`Sync Worktrees => Main Workdir` runs VS Code's built-in `Git: Migrate Worktree Changes` behavior for a predefined list of worktrees, one after another.
`Sync Main Workdir => Worktrees` rebases each configured worktree onto the local `main` branch with `--autostash`, so dirty worktree changes are reapplied afterward.
`Sync Worktrees => Main Workdir (Rebase Main First)` first rebases selected configured worktree(s) onto the local `main` branch with `--autostash`, then runs the normal worktree-to-main-workdir sync for that same worktree when the rebase is conflict-free.
All three commands let you choose either one configured worktree or an `All configured worktrees` entry, which is the default selection.

## Why This Exists

If you work with several linked Git worktrees, migrating changes back into one destination repository or syncing the latest local `main` changes into each worktree is repetitive. This extension lets you define that list once and run the sequence with a single command.

The migration logic itself is not reimplemented here. `Worktree Tools` uses VS Code's built-in Git extension API so migration behavior stays aligned with core VS Code.

## Features

- Run the built-in worktree migration flow across multiple configured worktrees.
- Merge the latest local `main` branch state into multiple configured worktrees.
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

`worktreeTools.continueOnMigrationError` controls whether the migration command should continue with later configured worktrees after one migration fails.

## Current Behavior

When you run `Worktree: Sync Worktrees => Main Workdir`, the extension:

1. Uses the current repository as the destination.
2. Resolves configured worktree targets.
3. Lets you choose one configured worktree or the default `All configured worktrees` option.
4. Runs the built-in worktree migration flow for the chosen scope.
5. Stops if conflicts are introduced.

When you run `Worktree: Sync Main Workdir => Worktrees`, the extension:

1. Uses the current repository to resolve linked worktrees.
2. Resolves configured worktree targets.
3. Lets you choose one configured worktree or the default `All configured worktrees` option.
4. Runs `git rebase --autostash refs/heads/main` for the chosen worktree scope.
5. Stops on the first sync failure or rebase-conflict state and logs the result.

When you run `Worktree: Sync Worktrees => Main Workdir (Rebase Main First)`, the extension:

1. Uses the current repository to resolve linked worktrees.
2. Resolves configured worktree targets.
3. Lets you choose one configured worktree or the default `All configured worktrees` option.
4. Runs `git rebase --autostash refs/heads/main` in each chosen worktree.
5. If that succeeds without conflict, runs the same built-in worktree migration flow used by `Sync Worktrees => Main Workdir`.
6. Stops on the first worktree rebase conflict so you can resolve it there before rerunning.

Detailed progress and failures are written to the `Worktree Tools` output channel.

## Requirements

- VS Code with the built-in Git extension enabled
- A repository with linked Git worktrees

## Roadmap

This extension is intended to grow into a broader toolbox for worktree workflows.

## Release Notes

### 0.3.11

- Change both rebase-based commands to use `git rebase --autostash refs/heads/main` so dirty worktree changes are reapplied automatically

### 0.3.10

- Change both main-to-worktree flows from `merge` to `rebase` against local `refs/heads/main`
- Rename the combined command to `Worktree: Sync Worktrees => Main Workdir (Rebase Main First)`

### 0.3.9

- Prevent the configured-worktree picker from auto-accepting the default `All configured worktrees` entry when launched from the command palette

### 0.3.8

- Change the third command to `Worktree: Sync Worktrees => Main Workdir (Merge Main First)`
- After merging `main` into a worktree without conflicts, run the normal worktree-to-main sync instead of a branch fast-forward

### 0.3.7

- Change the third command into `Worktree: Merge Worktrees => Main Workdir`
- After merging `main` into a worktree without conflicts, fast-forward the main workdir to that worktree branch

### 0.3.6

- Add `Worktree: Prepare Worktree Sync => Main Workdir` as an explicit pre-sync command for resolving merge issues in worktrees first
- Refactor the local-main merge flow into shared command logic

### 0.3.5

- Add a configured-worktree picker to both commands with `All configured worktrees` as the default selection
- Allow running either command against one selected worktree or the full configured set

### 0.3.4

- Change `Sync Main Workdir => Worktrees` to merge from local `refs/heads/main` instead of `origin/main`
- Avoid the first-worktree stall caused by the remote `git pull` path

### 0.3.2

- Rename the commands to `Worktree: Sync Worktrees => Main Workdir` and `Worktree: Sync Main Workdir => Worktrees`

### 0.3.1

- Rename `Worktree: Migrate Configured Worktree Changes` to `Worktree: Sync Configured Worktrees To Current Repository`
- Clarify the two-way sync wording in the docs

### 0.3.0

- Add `Worktree: Sync Configured Worktrees From Main`
- Reuse configured target resolution for both batch commands

### 0.2.0

- Rename the extension to `Worktree Tools`
- Rename the extension id to `padjon.vscode-worktree-tools`
- Add broader positioning for future worktree utilities

### 0.1.0

Initial batch migration release.

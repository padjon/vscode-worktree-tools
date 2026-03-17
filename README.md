# Worktree Tools

[![Install on Marketplace](https://img.shields.io/badge/Marketplace-Worktree%20Tools-0078D4?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=padjon.vscode-worktree-tools)
[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor-GitHub%20Sponsors-EA4AAA?style=for-the-badge&logo=githubsponsors&logoColor=white)](https://github.com/sponsors/padjon)

Utilities for Git worktree workflows in VS Code.

Commands in this extension:

- `Worktree: Initialize or Reinitialize Worktrees`
- `Worktree: Sync Worktrees => Main Workdir Branch`
- `Worktree: Sync Main Workdir Branch => Worktrees`
- `Worktree: Sync Worktrees => Main Workdir Branch (Rebase First)`

`Initialize or Reinitialize Worktrees` lets you choose whether to create new sibling worktrees under `../<projectName>.worktrees/<foldername>` or reinitialize existing linked worktrees from the branch currently checked out in the main workdir. New worktrees use matching `wt-<foldername>` branches, and reinitialize keeps gitignored files.
`Sync Worktrees => Main Workdir Branch` runs VS Code's built-in `Git: Migrate Worktree Changes` behavior for the selected linked worktree or for `All worktrees`.
`Sync Main Workdir Branch => Worktrees` rebases the selected linked worktree or `All worktrees` onto the branch currently checked out in the main workdir with `--autostash`, so dirty worktree changes are reapplied afterward.
`Sync Worktrees => Main Workdir Branch (Rebase First)` first rebases the selected linked worktree or `All worktrees` onto the branch currently checked out in the main workdir with `--autostash`, then runs the normal worktree-to-main-workdir sync for that same worktree when the rebase is conflict-free.

## Why This Exists

If you work with several linked Git worktrees, migrating changes back into one destination repository or syncing the latest main-workdir branch changes into each worktree is repetitive. This extension lets you act on the linked worktrees that already belong to the current worktree set.

The migration logic itself is not reimplemented here. `Worktree Tools` uses VS Code's built-in Git extension API so migration behavior stays aligned with core VS Code.

## Features

- Create a batch of new worktrees from the main workdir's current branch.
- Put new worktrees under a sibling `<projectName>.worktrees` folder structure.
- Create matching `wt-<foldername>` branches automatically.
- Preview which folders will initialize vs reinitialize before anything changes.
- Run the built-in worktree migration flow across selected linked worktrees into the branch currently checked out in the main workdir.
- Rebase selected linked worktrees onto the branch currently checked out in the main workdir.
- Pick a single worktree or `All worktrees` for every command except initialize.
- Stop on conflicts so you can resolve them immediately.
- Optionally continue after individual migration failures.

## Initialize Or Reinitialize Worktrees

When you run `Worktree: Initialize or Reinitialize Worktrees`, the extension:

1. Resolves the repository's main workdir.
2. Uses the current branch checked out there as the source branch.
3. Lets you choose `Initialize` or `Reinitialize`.
4. For `Initialize`, prompts for one or more folder names.
5. For `Reinitialize`, lets you choose one existing linked worktree or `All worktrees`.
6. Shows a preview that separates initialize and reinitialize targets.
7. Creates each new worktree at `../<projectName>.worktrees/<foldername>`.
8. Reinitializes each selected existing worktree by resetting its current branch from the main workdir branch.
9. Keeps gitignored files during reinitialization.

## Configuration

`worktreeTools.continueOnMigrationError` controls whether the migration command should continue with later worktrees after one migration fails.

## Current Behavior

When you run `Worktree: Sync Worktrees => Main Workdir Branch`, the extension:

1. Resolves the repository's main workdir.
2. Uses the branch currently checked out there as the sync target.
3. Uses the main workdir repository as the destination, even if you started from another linked worktree.
4. Resolves the linked worktrees in that worktree set.
5. Lets you choose one worktree or the default `All worktrees` option.
6. Runs the built-in worktree migration flow for the chosen scope.
7. Stops if conflicts are introduced.

When you run `Worktree: Sync Main Workdir Branch => Worktrees`, the extension:

1. Resolves the repository's main workdir.
2. Uses the branch currently checked out there as the sync source.
3. Resolves the linked worktrees in that worktree set.
4. Lets you choose one worktree or the default `All worktrees` option.
5. Runs `git rebase --autostash refs/heads/<current-branch>` for the chosen worktree scope.
6. Stops on the first sync failure or rebase-conflict state and logs the result.

When you run `Worktree: Sync Worktrees => Main Workdir Branch (Rebase First)`, the extension:

1. Resolves the repository's main workdir.
2. Uses the branch currently checked out there as the rebase source and sync target.
3. Resolves the linked worktrees in that worktree set.
4. Lets you choose one worktree or the default `All worktrees` option.
5. Runs `git rebase --autostash refs/heads/<current-branch>` in each chosen worktree.
6. If that succeeds without conflict, runs the same built-in worktree migration flow used by `Sync Worktrees => Main Workdir Branch`.
7. Stops on the first worktree rebase conflict so you can resolve it there before rerunning.

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

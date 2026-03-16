# Change Log

## 0.4.0

- Add `Worktree: Initialize or Reinitialize Worktrees` to create sibling worktrees from the main workdir's current branch
- Prompt for folder names and create or recreate matching `wt-<foldername>` branches automatically
- Add a preview step that shows which folders will initialize versus reinitialize before execution
- Reinitialize existing worktrees by dropping and recreating their branches while keeping gitignored files
- Make all sync commands use the branch currently checked out in the main workdir instead of a fixed `main` branch
- Rename the sync command titles to be explicit about the main workdir branch as the sync target or source
- Block reinitialize when the target worktree folder or `wt-*` branch does not match the expected linked worktree pair

## 0.3.11

- Change both rebase-based commands to use `git rebase --autostash refs/heads/main` so dirty worktree changes are reapplied automatically

## 0.3.10

- Change both main-to-worktree flows from `merge` to `rebase` against local `refs/heads/main`
- Rename the combined command to `Worktree: Sync Worktrees => Main Workdir (Rebase Main First)`

## 0.3.9

- Prevent the configured-worktree picker from auto-accepting the default `All configured worktrees` entry when launched from the command palette

## 0.3.8

- Change the third command to `Worktree: Sync Worktrees => Main Workdir (Merge Main First)`
- After merging `main` into a worktree without conflicts, run the normal worktree-to-main sync instead of a branch fast-forward

## 0.3.7

- Change the third command into `Worktree: Merge Worktrees => Main Workdir`
- After merging `main` into a worktree without conflicts, fast-forward the main workdir to that worktree branch

## 0.3.6

- Add `Worktree: Prepare Worktree Sync => Main Workdir` as an explicit pre-sync command for resolving merge issues in worktrees first
- Refactor the local-main merge flow into shared command logic

## 0.3.5

- Add a configured-worktree picker to both commands with `All configured worktrees` as the default selection
- Allow either command to run against one selected worktree or all configured worktrees

## 0.3.4

- Change `Sync Main Workdir => Worktrees` to merge from local `refs/heads/main` instead of `origin/main`
- Treat merge conflicts as a stop condition for the main-to-worktrees sync flow
- Avoid hanging on the first worktree by removing the remote `git pull` step

## 0.3.3

- Add the Marketplace-specific `sponsor.url` manifest field so the sponsorship link can appear on the extension listing

## 0.3.2

- Rename the commands to `Worktree: Sync Worktrees => Main Workdir` and `Worktree: Sync Main Workdir => Worktrees`

## 0.3.1

- Rename `Worktree: Migrate Configured Worktree Changes` to `Worktree: Sync Configured Worktrees To Current Repository`
- Align command wording around the new two-way sync model while keeping the existing command ids

## 0.3.0

- Add `Worktree: Sync Configured Worktrees From Main` to pull `origin/main` into each configured worktree
- Reuse configured worktree resolution across both batch commands

## 0.2.4

- Skip clean worktrees before calling the built-in migration API
- Avoid apparent hangs caused by built-in "no changes to migrate" notifications

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

# Git Worktree Batch Migrate

Run VS Code's built-in `Git: Migrate Worktree Changes` flow for a predefined list of worktrees in one command.

This extension adds:

- `Git: Migrate Configured Worktree Changes`

It uses the built-in Git extension API rather than reimplementing migration logic, so the actual file migration behavior stays aligned with VS Code itself.

## What It Does

When you run the command, the extension:

1. Picks the current repository as the migration destination.
2. Resolves a predefined ordered list of worktrees from your settings.
3. Runs the same built-in migration flow for each matching worktree, one after another.
4. Stops if a migration introduces conflicts, or on the first error unless you explicitly allow continuation.

## Configuration

Add your worktrees to settings:

```json
{
  "gitWorktreeBatch.targets": [
    "../1",
    "../3",
    "feature-a"
  ],
  "gitWorktreeBatch.continueOnError": false
}
```

`gitWorktreeBatch.targets` supports:

- absolute paths
- paths relative to the current workspace folder
- unique worktree folder names

`gitWorktreeBatch.continueOnError` controls whether later configured worktrees should still run after a failed migration.

## Typical Use Case

You keep several linked worktrees for parallel tasks and regularly want to pull changes back into one main working tree. Instead of manually running `Git: Migrate Worktree Changes` once per worktree, this extension lets you define the sequence once and run it with a single command.

## Behavior Notes

- Migrations run sequentially, not in parallel.
- The active repository is the destination.
- The extension ignores configured targets that do not match a currently linked worktree.
- If a migration produces merge conflicts, the batch stops so you can resolve them before continuing.
- The extension depends on VS Code's built-in Git extension.

## Output

Detailed progress and failures are written to the `Git Worktree Batch Migrate` output channel.

## Requirements

- VS Code with the built-in Git extension enabled
- A repository with linked Git worktrees

## Release Notes

### 0.1.0

Initial release.

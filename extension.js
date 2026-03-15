const path = require('path');
const vscode = require('vscode');

const COMMAND_ID = 'gitWorktreeBatch.migrateConfigured';
const CONFIG_NAMESPACE = 'gitWorktreeBatch';
const OUTPUT_CHANNEL_NAME = 'Git Worktree Batch Migrate';
const GIT_EXTENSION_ID = 'vscode.git';

let outputChannel;

function activate(context) {
  outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);

  context.subscriptions.push(
    outputChannel,
    vscode.commands.registerCommand(COMMAND_ID, async () => {
      try {
        await migrateConfiguredWorktrees();
      } catch (error) {
        log(`Unexpected failure: ${asErrorMessage(error)}`);
        await vscode.window.showErrorMessage(asErrorMessage(error));
      }
    })
  );
}

async function migrateConfiguredWorktrees() {
  const git = await getGitApi();
  if (!git) {
    return;
  }

  const repository = await pickRepository(git);
  if (!repository) {
    return;
  }

  const configuredTargets = getConfiguredTargets(repository);
  if (configuredTargets.length === 0) {
    await vscode.window.showWarningMessage(
      'Set gitWorktreeBatch.targets in settings before running this command.'
    );
    return;
  }

  const availableWorktrees = getAvailableWorktreePaths(repository);
  if (availableWorktrees.length === 0) {
    await vscode.window.showInformationMessage('This repository has no linked worktrees.');
    return;
  }

  const resolution = resolveConfiguredTargets(configuredTargets, availableWorktrees, repository.rootUri.fsPath);
  if (resolution.ambiguous.length > 0) {
    const detail = resolution.ambiguous
      .map((entry) => `- ${entry.target}: ${entry.matches.join(', ')}`)
      .join('\n');

    outputChannel.clear();
    log('Ambiguous configured worktree targets:');
    log(detail);
    outputChannel.show(true);

    await vscode.window.showErrorMessage(
      'Some configured worktree targets are ambiguous. See the output channel for details.'
    );
    return;
  }

  const currentRoot = normalizeFsPath(repository.rootUri.fsPath);
  const targets = resolution.matches.filter((target) => target !== currentRoot);

  if (resolution.unmatched.length > 0) {
    log(`Unmatched configured targets: ${resolution.unmatched.join(', ')}`);
  }

  if (targets.length === 0) {
    await vscode.window.showInformationMessage(
      'No configured worktrees resolved to linked worktrees other than the current repository.'
    );
    return;
  }

  const destinationLabel = path.basename(repository.rootUri.fsPath);
  const detailLines = [
    `Destination: ${repository.rootUri.fsPath}`,
    'Sources:',
    ...targets.map((target) => `- ${target}`)
  ];

  if (resolution.unmatched.length > 0) {
    detailLines.push('', `Ignored unmatched entries: ${resolution.unmatched.join(', ')}`);
  }

  const confirmation = await vscode.window.showWarningMessage(
    `Migrate changes from ${targets.length} configured worktree(s) into ${destinationLabel}?`,
    {
      modal: true,
      detail: detailLines.join('\n')
    },
    'Migrate'
  );

  if (confirmation !== 'Migrate') {
    return;
  }

  const continueOnError = vscode.workspace
    .getConfiguration(CONFIG_NAMESPACE, repository.rootUri)
    .get('continueOnError', false);

  const summary = {
    migrated: [],
    failed: [],
    stoppedOnConflicts: null
  };

  outputChannel.clear();
  log(`Starting batch migration into ${repository.rootUri.fsPath}`);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Migrating configured worktree changes',
      cancellable: false
    },
    async (progress) => {
      for (let index = 0; index < targets.length; index += 1) {
        const target = targets[index];
        progress.report({
          increment: 100 / targets.length,
          message: `${index + 1}/${targets.length}: ${path.basename(target)}`
        });

        log(`Migrating ${target}`);

        try {
          await repository.migrateChanges(target, {
            confirmation: false,
            deleteFromSource: true,
            untracked: true
          });
          summary.migrated.push(target);

          if ((repository.state.mergeChanges ?? []).length > 0) {
            summary.stoppedOnConflicts = target;
            log(`Stopping after merge conflicts were introduced by ${target}`);
            break;
          }
        } catch (error) {
          const message = asErrorMessage(error);
          summary.failed.push({ target, message });
          log(`Failed to migrate ${target}: ${message}`);

          if (!continueOnError) {
            break;
          }
        }
      }
    }
  );

  outputChannel.show(true);

  const migratedCount = summary.migrated.length;
  const failedCount = summary.failed.length;

  if (summary.stoppedOnConflicts) {
    await vscode.window.showWarningMessage(
      `Migrated ${migratedCount} worktree(s). Merge conflicts were introduced while applying ${path.basename(summary.stoppedOnConflicts)}. Resolve them before running the command again.`
    );
    return;
  }

  if (failedCount > 0) {
    await vscode.window.showWarningMessage(
      `Migrated ${migratedCount} worktree(s); ${failedCount} failed. See the "${OUTPUT_CHANNEL_NAME}" output for details.`
    );
    return;
  }

  const unmatchedSuffix =
    resolution.unmatched.length > 0 ? ` Ignored ${resolution.unmatched.length} unmatched setting entr${resolution.unmatched.length === 1 ? 'y' : 'ies'}.` : '';

  await vscode.window.showInformationMessage(
    `Migrated ${migratedCount} configured worktree(s) into ${destinationLabel}.${unmatchedSuffix}`
  );
}

async function getGitApi() {
  const extension = vscode.extensions.getExtension(GIT_EXTENSION_ID);
  if (!extension) {
    await vscode.window.showErrorMessage('The built-in Git extension is not available.');
    return undefined;
  }

  const gitExtension = extension.isActive ? extension : await extension.activate();
  if (!gitExtension || typeof gitExtension.getAPI !== 'function') {
    await vscode.window.showErrorMessage('The built-in Git API could not be loaded.');
    return undefined;
  }

  return gitExtension.getAPI(1);
}

async function pickRepository(git) {
  const repositories = git.repositories ?? [];
  if (repositories.length === 0) {
    await vscode.window.showWarningMessage('No Git repositories are open in this window.');
    return undefined;
  }

  const activeUri =
    vscode.window.activeTextEditor?.document?.uri ??
    vscode.workspace.workspaceFolders?.[0]?.uri;

  if (activeUri && typeof git.getRepository === 'function') {
    const activeRepository = git.getRepository(activeUri);
    if (activeRepository) {
      return activeRepository;
    }
  }

  if (repositories.length === 1) {
    return repositories[0];
  }

  const picked = await vscode.window.showQuickPick(
    repositories.map((repository) => ({
      label: path.basename(repository.rootUri.fsPath),
      description: repository.rootUri.fsPath,
      repository
    })),
    {
      placeHolder: 'Select the repository that should receive the migrated worktree changes'
    }
  );

  return picked?.repository;
}

function getConfiguredTargets(repository) {
  const values = vscode.workspace
    .getConfiguration(CONFIG_NAMESPACE, repository.rootUri)
    .get('targets', []);

  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean);
}

function getAvailableWorktreePaths(repository) {
  const worktrees = Array.isArray(repository.state.worktrees) ? repository.state.worktrees : [];

  return worktrees
    .map((worktree) => worktree?.path)
    .filter((worktreePath) => typeof worktreePath === 'string')
    .map((worktreePath) => normalizeFsPath(worktreePath));
}

function resolveConfiguredTargets(configuredTargets, availableWorktrees, repositoryRoot) {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
  const seen = new Set();
  const matches = [];
  const unmatched = [];
  const ambiguous = [];

  for (const target of configuredTargets) {
    const candidatePaths = new Set();

    if (path.isAbsolute(target)) {
      candidatePaths.add(normalizeFsPath(target));
    } else {
      if (workspaceRoot) {
        candidatePaths.add(normalizeFsPath(path.resolve(workspaceRoot, target)));
      }

      candidatePaths.add(normalizeFsPath(path.resolve(repositoryRoot, target)));
    }

    const directMatch = availableWorktrees.find((worktreePath) => candidatePaths.has(worktreePath));
    if (directMatch) {
      if (!seen.has(directMatch)) {
        seen.add(directMatch);
        matches.push(directMatch);
      }
      continue;
    }

    const basenameMatches = availableWorktrees.filter((worktreePath) => path.basename(worktreePath) === target);
    if (basenameMatches.length === 1) {
      const match = basenameMatches[0];
      if (!seen.has(match)) {
        seen.add(match);
        matches.push(match);
      }
      continue;
    }

    if (basenameMatches.length > 1) {
      ambiguous.push({
        target,
        matches: basenameMatches
      });
      continue;
    }

    unmatched.push(target);
  }

  return { matches, unmatched, ambiguous };
}

function normalizeFsPath(value) {
  return path.normalize(path.resolve(value));
}

function asErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return String(error);
}

function log(message) {
  outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};

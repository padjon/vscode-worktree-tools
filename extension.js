const path = require('path');
const { execFile } = require('child_process');
const vscode = require('vscode');

const MIGRATE_COMMAND_ID = 'worktreeTools.migrateConfiguredWorktrees';
const SYNC_COMMAND_ID = 'worktreeTools.syncConfiguredWorktreesFromMain';
const MERGE_SYNC_COMMAND_ID = 'worktreeTools.prepareWorktreeSyncToMainWorkdir';
const CONFIG_NAMESPACE = 'worktreeTools';
const OUTPUT_CHANNEL_NAME = 'Worktree Tools';
const GIT_EXTENSION_ID = 'vscode.git';
const MAIN_BRANCH_NAME = 'main';
const MAIN_BRANCH_REF = `refs/heads/${MAIN_BRANCH_NAME}`;

let outputChannel;

function activate(context) {
  outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);

  context.subscriptions.push(
    outputChannel,
    vscode.commands.registerCommand(MIGRATE_COMMAND_ID, () => runCommand(syncConfiguredWorktreesToCurrentRepository)),
    vscode.commands.registerCommand(SYNC_COMMAND_ID, () => runCommand(syncConfiguredWorktreesFromMain)),
    vscode.commands.registerCommand(MERGE_SYNC_COMMAND_ID, () => runCommand(mergeWorktreesIntoMainWorkdir))
  );
}

async function runCommand(callback) {
  try {
    await callback();
  } catch (error) {
    log(`Unexpected failure: ${asErrorMessage(error)}`);
    await vscode.window.showErrorMessage(asErrorMessage(error));
  }
}

async function syncConfiguredWorktreesToCurrentRepository() {
  const git = await getGitApi();
  if (!git) {
    return;
  }

  const repository = await pickRepository(
    git,
    'Select the repository that should receive the migrated worktree changes'
  );
  if (!repository) {
    return;
  }

  const selection = await getConfiguredWorktreeSelection(repository);
  if (!selection) {
    return;
  }

  const targets = await pickConfiguredWorktreeTargets(
    selection.targets,
    'Select which configured worktree changes should be synced into the main workdir'
  );
  if (!targets) {
    return;
  }

  outputChannel.clear();
  log(`Destination repository: ${repository.rootUri.fsPath}`);
  log(`Configured targets: ${selection.configuredTargets.join(', ')}`);
  log(`Resolved targets: ${selection.targets.join(', ')}`);
  log(`Selected targets: ${targets.join(', ')}`);

  if (selection.unmatched.length > 0) {
    log(`Unmatched configured targets: ${selection.unmatched.join(', ')}`);
  }

  const destinationLabel = path.basename(repository.rootUri.fsPath);
  const detailLines = [
    `Destination: ${repository.rootUri.fsPath}`,
    'Sync sources:',
    ...targets.map((target) => `- ${target}`)
  ];

  if (selection.unmatched.length > 0) {
    detailLines.push('', `Ignored unmatched entries: ${selection.unmatched.join(', ')}`);
  }

  const confirmation = await vscode.window.showWarningMessage(
    `Sync changes from ${targets.length} configured worktree(s) into ${destinationLabel}?`,
    {
      modal: true,
      detail: detailLines.join('\n')
    },
    'Sync'
  );

  if (confirmation !== 'Sync') {
    return;
  }

  const continueOnError = vscode.workspace
    .getConfiguration(CONFIG_NAMESPACE, repository.rootUri)
    .get('continueOnMigrationError', false);

  const summary = {
    synced: [],
    failed: [],
    stoppedOnConflicts: null
  };

  log(`Starting batch sync into ${repository.rootUri.fsPath}`);
  outputChannel.show(true);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Syncing configured worktrees to current repository',
      cancellable: false
    },
    async (progress) => {
      for (let index = 0; index < targets.length; index += 1) {
        const target = targets[index];
        progress.report({
          increment: 100 / targets.length,
          message: `${index + 1}/${targets.length}: ${path.basename(target)}`
        });

        log(`Syncing ${target} into ${repository.rootUri.fsPath}`);

        try {
          const sourceHasChanges = await hasWorktreeChanges(target);
          if (!sourceHasChanges) {
            log(`Skipping ${target}: no changes to sync`);
            continue;
          }

          await repository.migrateChanges(target, {
            confirmation: false,
            deleteFromSource: true,
            untracked: true
          });
          summary.synced.push(target);

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

  const syncedCount = summary.synced.length;
  const failedCount = summary.failed.length;

  if (summary.stoppedOnConflicts) {
    await vscode.window.showWarningMessage(
      `Synced ${syncedCount} worktree(s). Merge conflicts were introduced while applying ${path.basename(summary.stoppedOnConflicts)}. Resolve them before running the command again.`
    );
    return;
  }

  if (failedCount > 0) {
    await vscode.window.showWarningMessage(
      `Synced ${syncedCount} worktree(s); ${failedCount} failed. See the "${OUTPUT_CHANNEL_NAME}" output for details.`
    );
    return;
  }

  const unmatchedSuffix =
    selection.unmatched.length > 0
      ? ` Ignored ${selection.unmatched.length} unmatched setting entr${selection.unmatched.length === 1 ? 'y' : 'ies'}.`
      : '';

  await vscode.window.showInformationMessage(
    `Synced ${syncedCount} configured worktree(s) into ${destinationLabel}.${unmatchedSuffix}`
  );
}

async function syncConfiguredWorktreesFromMain() {
  await rebaseConfiguredWorktreesOntoLocalMain({
    repositoryPlaceHolder: 'Select the repository whose configured worktrees should be synced from main',
    targetPlaceHolder: 'Select which configured worktrees should be synced from the main workdir',
    confirmationMessage: (count) => `Rebase ${count} configured worktree(s) onto local ${MAIN_BRANCH_NAME}?`,
    progressTitle: `Syncing configured worktrees from local ${MAIN_BRANCH_NAME} via rebase`,
    startLogMessage: `Starting batch sync from local ${MAIN_BRANCH_REF} via rebase`,
    targetLogMessage: (target) => `Rebasing ${target} onto local ${MAIN_BRANCH_REF}`,
    conflictLogMessage: (target, message) =>
      `Stopping after rebase conflicts were introduced by ${target}: ${message}`,
    failureLogMessage: (target, message) => `Failed to rebase ${target}: ${message}`,
    conflictWarningMessage: (count, target) =>
      `Synced ${count} worktree(s). Rebase conflicts were introduced while applying ${path.basename(target)}. Resolve them before running the command again.`,
    failureWarningMessage: (count, failedCount) =>
      `Synced ${count} worktree(s); ${failedCount} failed. See the "${OUTPUT_CHANNEL_NAME}" output for details.`,
    successMessage: (count, unmatchedSuffix) =>
      `Synced ${count} configured worktree(s) from local ${MAIN_BRANCH_NAME}.${unmatchedSuffix}`
  });
}

async function mergeWorktreesIntoMainWorkdir() {
  const git = await getGitApi();
  if (!git) {
    return;
  }

  const repository = await pickRepository(
    git,
    'Select the main workdir that should receive merged worktree branches'
  );
  if (!repository) {
    return;
  }

  const selection = await getConfiguredWorktreeSelection(repository);
  if (!selection) {
    return;
  }

  const targets = await pickConfiguredWorktreeTargets(
    selection.targets,
    'Select which configured worktrees should be merged into the main workdir'
  );
  if (!targets) {
    return;
  }

  const mainBranchExists = await localBranchExists(repository.rootUri.fsPath, MAIN_BRANCH_REF);
  if (!mainBranchExists) {
    await vscode.window.showErrorMessage(
      `Local branch ${MAIN_BRANCH_REF} does not exist in this repository.`
    );
    return;
  }

  outputChannel.clear();
  log(`Combined sync destination repository: ${repository.rootUri.fsPath}`);
  log(`Configured targets: ${selection.configuredTargets.join(', ')}`);
  log(`Resolved targets: ${selection.targets.join(', ')}`);
  log(`Selected targets: ${targets.join(', ')}`);

  if (selection.unmatched.length > 0) {
    log(`Unmatched configured targets: ${selection.unmatched.join(', ')}`);
  }

  const detailLines = [
    `Destination: ${repository.rootUri.fsPath}`,
    `Process: rebase each selected worktree onto ${MAIN_BRANCH_REF}, then sync that worktree into the main workdir`,
    'Targets:',
    ...targets.map((target) => `- ${target}`)
  ];

  if (selection.unmatched.length > 0) {
    detailLines.push('', `Ignored unmatched entries: ${selection.unmatched.join(', ')}`);
  }

  const confirmation = await vscode.window.showWarningMessage(
    `Rebase ${targets.length} configured worktree(s) onto local ${MAIN_BRANCH_NAME}, then sync them into ${path.basename(repository.rootUri.fsPath)}?`,
    {
      modal: true,
      detail: detailLines.join('\n')
    },
    'Merge'
  );

  if (confirmation !== 'Merge') {
    return;
  }

  const summary = {
    synced: [],
    failed: [],
    stoppedOnWorktreeConflicts: null
  };

  log(`Starting combined rebase and sync into ${repository.rootUri.fsPath} from local ${MAIN_BRANCH_REF}`);
  outputChannel.show(true);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Rebasing worktrees onto main, then syncing to main workdir',
      cancellable: false
    },
    async (progress) => {
      for (let index = 0; index < targets.length; index += 1) {
        const target = targets[index];
        progress.report({
          increment: 100 / targets.length,
          message: `${index + 1}/${targets.length}: ${path.basename(target)}`
        });

        log(`Rebasing ${target} onto ${MAIN_BRANCH_REF}`);

        try {
          await execFileText('git', [
            '-C',
            target,
            'rebase',
            '--autostash',
            MAIN_BRANCH_REF
          ]);
        } catch (error) {
          const message = asErrorMessage(error);
          const hasConflicts = await hasGitConflicts(target);
          if (hasConflicts) {
            summary.stoppedOnWorktreeConflicts = target;
            log(`Stopping after rebase conflicts were introduced in ${target}: ${message}`);
          } else {
            summary.failed.push({ target, message });
            log(`Failed to rebase ${target} onto ${MAIN_BRANCH_REF}: ${message}`);
          }
          break;
        }

        log(`Syncing ${target} into ${repository.rootUri.fsPath}`);

        try {
          const sourceHasChanges = await hasWorktreeChanges(target);
          if (!sourceHasChanges) {
            log(`Skipping sync from ${target}: no worktree changes to migrate after merging ${MAIN_BRANCH_NAME}`);
            summary.synced.push(target);
            continue;
          }

          await repository.migrateChanges(target, {
            confirmation: false,
            deleteFromSource: true,
            untracked: true
          });
          summary.synced.push(target);

          if ((repository.state.mergeChanges ?? []).length > 0) {
            summary.stoppedOnWorktreeConflicts = target;
            log(`Stopping after sync introduced conflicts from ${target}`);
            break;
          }
        } catch (error) {
          const message = asErrorMessage(error);
          summary.failed.push({ target, message });
          log(`Failed to sync ${target} into ${repository.rootUri.fsPath}: ${message}`);
          break;
        }
      }
    }
  );

  outputChannel.show(true);

  const syncedCount = summary.synced.length;
  const failedCount = summary.failed.length;

  if (summary.stoppedOnWorktreeConflicts) {
    await vscode.window.showWarningMessage(
      `Synced ${syncedCount} worktree(s). Rebase or sync conflicts were introduced while processing ${path.basename(summary.stoppedOnWorktreeConflicts)}. Resolve them in that worktree or in the main workdir before running the command again.`
    );
    return;
  }

  if (failedCount > 0) {
    await vscode.window.showWarningMessage(
      `Synced ${syncedCount} worktree(s); ${failedCount} failed. See the "${OUTPUT_CHANNEL_NAME}" output for details.`
    );
    return;
  }

  const unmatchedSuffix =
    selection.unmatched.length > 0
      ? ` Ignored ${selection.unmatched.length} unmatched setting entr${selection.unmatched.length === 1 ? 'y' : 'ies'}.`
      : '';

  await vscode.window.showInformationMessage(
    `Rebased onto local ${MAIN_BRANCH_NAME} and synced ${syncedCount} configured worktree(s) into ${path.basename(repository.rootUri.fsPath)}.${unmatchedSuffix}`
  );
}

async function rebaseConfiguredWorktreesOntoLocalMain(options) {
  const git = await getGitApi();
  if (!git) {
    return;
  }

  const repository = await pickRepository(git, options.repositoryPlaceHolder);
  if (!repository) {
    return;
  }

  const selection = await getConfiguredWorktreeSelection(repository);
  if (!selection) {
    return;
  }

  const targets = await pickConfiguredWorktreeTargets(
    selection.targets,
    options.targetPlaceHolder
  );
  if (!targets) {
    return;
  }

  const mainBranchExists = await localBranchExists(repository.rootUri.fsPath, MAIN_BRANCH_REF);
  if (!mainBranchExists) {
    await vscode.window.showErrorMessage(
      `Local branch ${MAIN_BRANCH_REF} does not exist in this repository.`
    );
    return;
  }

  outputChannel.clear();
  log(`Sync repository: ${repository.rootUri.fsPath}`);
  log(`Configured targets: ${selection.configuredTargets.join(', ')}`);
  log(`Resolved targets: ${selection.targets.join(', ')}`);
  log(`Selected targets: ${targets.join(', ')}`);

  if (selection.unmatched.length > 0) {
    log(`Unmatched configured targets: ${selection.unmatched.join(', ')}`);
  }

  const detailLines = [
    `Repository: ${repository.rootUri.fsPath}`,
    `Sync source: local ${MAIN_BRANCH_NAME} branch (${MAIN_BRANCH_REF}) via rebase`,
    'Targets:',
    ...targets.map((target) => `- ${target}`)
  ];

  if (selection.unmatched.length > 0) {
    detailLines.push('', `Ignored unmatched entries: ${selection.unmatched.join(', ')}`);
  }

  const confirmation = await vscode.window.showWarningMessage(
    options.confirmationMessage(targets.length),
    {
      modal: true,
      detail: detailLines.join('\n')
    },
    'Sync'
  );

  if (confirmation !== 'Sync') {
    return;
  }

  const summary = {
    synced: [],
    failed: [],
    stoppedOnConflicts: null
  };

  log(options.startLogMessage);
  outputChannel.show(true);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: options.progressTitle,
      cancellable: false
    },
    async (progress) => {
      for (let index = 0; index < targets.length; index += 1) {
        const target = targets[index];
        progress.report({
          increment: 100 / targets.length,
          message: `${index + 1}/${targets.length}: ${path.basename(target)}`
        });

        log(options.targetLogMessage(target));

        try {
          await execFileText('git', [
            '-C',
            target,
            'rebase',
            '--autostash',
            MAIN_BRANCH_REF
          ]);
          summary.synced.push(target);
        } catch (error) {
          const message = asErrorMessage(error);
          const hasConflicts = await hasGitConflicts(target);
          if (hasConflicts) {
            summary.stoppedOnConflicts = target;
            log(options.conflictLogMessage(target, message));
          } else {
            summary.failed.push({ target, message });
            log(options.failureLogMessage(target, message));
          }
          break;
        }
      }
    }
  );

  outputChannel.show(true);

  const syncedCount = summary.synced.length;
  const failedCount = summary.failed.length;

  if (summary.stoppedOnConflicts) {
    await vscode.window.showWarningMessage(options.conflictWarningMessage(syncedCount, summary.stoppedOnConflicts));
    return;
  }

  if (failedCount > 0) {
    await vscode.window.showWarningMessage(options.failureWarningMessage(syncedCount, failedCount));
    return;
  }

  const unmatchedSuffix =
    selection.unmatched.length > 0
      ? ` Ignored ${selection.unmatched.length} unmatched setting entr${selection.unmatched.length === 1 ? 'y' : 'ies'}.`
      : '';

  await vscode.window.showInformationMessage(options.successMessage(syncedCount, unmatchedSuffix));
}

async function getGitApi() {
  const extension = vscode.extensions.getExtension(GIT_EXTENSION_ID);
  if (!extension) {
    await vscode.window.showErrorMessage('The built-in Git extension is not available.');
    return undefined;
  }

  if (!extension.isActive) {
    await extension.activate();
  }

  const gitExtension = extension.exports;
  if (!gitExtension || typeof gitExtension.getAPI !== 'function') {
    await vscode.window.showErrorMessage('The built-in Git API could not be loaded.');
    return undefined;
  }

  return gitExtension.getAPI(1);
}

async function pickRepository(git, placeHolder) {
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
      placeHolder
    }
  );

  return picked?.repository;
}

async function getConfiguredWorktreeSelection(repository) {
  const configuredTargets = getConfiguredTargets(repository);
  if (configuredTargets.length === 0) {
    await vscode.window.showWarningMessage(
      'Set worktreeTools.migrationTargets in settings before running this command.'
    );
    return undefined;
  }

  const availableWorktrees = getAvailableWorktreePaths(repository);
  if (availableWorktrees.length === 0) {
    await vscode.window.showInformationMessage('This repository has no linked worktrees.');
    return undefined;
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
    return undefined;
  }

  const currentRoot = normalizeFsPath(repository.rootUri.fsPath);
  const targets = resolution.matches.filter((target) => target !== currentRoot);

  if (targets.length === 0) {
    await vscode.window.showInformationMessage(
      'No configured worktrees resolved to linked worktrees other than the current repository.'
    );
    return undefined;
  }

  return {
    configuredTargets,
    targets,
    unmatched: resolution.unmatched
  };
}

async function pickConfiguredWorktreeTargets(targets, placeHolder) {
  const items = [
    {
      label: 'All configured worktrees',
      description: `${targets.length} worktree(s)`,
      targetPaths: targets
    },
    ...targets.map((target) => ({
      label: path.basename(target),
      description: target,
      targetPaths: [target]
    }))
  ];

  return new Promise((resolve) => {
    const quickPick = vscode.window.createQuickPick();
    const acceptDelayMs = 150;
    let acceptEnabled = false;
    let settled = false;
    const acceptTimer = setTimeout(() => {
      acceptEnabled = true;
    }, acceptDelayMs);

    const finish = (value) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(acceptTimer);
      quickPick.hide();
      quickPick.dispose();
      resolve(value);
    };

    quickPick.title = 'Configured Worktrees';
    quickPick.placeholder = placeHolder;
    quickPick.matchOnDescription = true;
    quickPick.items = items;
    quickPick.activeItems = [items[0]];
    quickPick.selectedItems = [items[0]];

    quickPick.onDidAccept(() => {
      if (!acceptEnabled) {
        return;
      }

      const pickedItem = quickPick.selectedItems[0] ?? quickPick.activeItems[0] ?? items[0];
      finish(pickedItem.targetPaths);
    });

    quickPick.onDidHide(() => {
      finish(undefined);
    });

    quickPick.show();
  });
}

function getConfiguredTargets(repository) {
  const values = vscode.workspace
    .getConfiguration(CONFIG_NAMESPACE, repository.rootUri)
    .get('migrationTargets', []);

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
        candidatePaths.add(normalizeFsPath(path.resolve(path.dirname(workspaceRoot), target)));
      }

      candidatePaths.add(normalizeFsPath(path.resolve(repositoryRoot, target)));
      candidatePaths.add(normalizeFsPath(path.resolve(path.dirname(repositoryRoot), target)));
    }

    const directMatch = availableWorktrees.find((worktreePath) => candidatePaths.has(worktreePath));
    if (directMatch) {
      if (!seen.has(directMatch)) {
        seen.add(directMatch);
        matches.push(directMatch);
      }
      continue;
    }

    if (!target.includes('/') && !target.includes('\\')) {
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
    }

    unmatched.push(target);
  }

  return { matches, unmatched, ambiguous };
}

function normalizeFsPath(value) {
  return path.normalize(path.resolve(value));
}

async function hasWorktreeChanges(worktreePath) {
  const stdout = await execFileText('git', [
    '-C',
    worktreePath,
    'status',
    '--porcelain=v1',
    '--untracked-files=all'
  ]);

  return stdout.trim().length > 0;
}

async function hasGitConflicts(worktreePath) {
  const stdout = await execFileText('git', [
    '-C',
    worktreePath,
    'diff',
    '--name-only',
    '--diff-filter=U'
  ]);

  return stdout.trim().length > 0;
}

async function execFileText(command, args) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0'
        }
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message));
          return;
        }

        resolve(stdout);
      }
    );
  });
}

async function localBranchExists(repositoryPath, branchRef) {
  try {
    await execFileText('git', ['-C', repositoryPath, 'rev-parse', '--verify', branchRef]);
    return true;
  } catch {
    return false;
  }
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

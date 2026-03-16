const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const vscode = require('vscode');

const INIT_COMMAND_ID = 'worktreeTools.initializeWorktrees';
const MIGRATE_COMMAND_ID = 'worktreeTools.migrateConfiguredWorktrees';
const SYNC_COMMAND_ID = 'worktreeTools.syncConfiguredWorktreesFromMain';
const MERGE_SYNC_COMMAND_ID = 'worktreeTools.prepareWorktreeSyncToMainWorkdir';
const CONFIG_NAMESPACE = 'worktreeTools';
const OUTPUT_CHANNEL_NAME = 'Worktree Tools';
const GIT_EXTENSION_ID = 'vscode.git';
let outputChannel;

function activate(context) {
  outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);

  context.subscriptions.push(
    outputChannel,
    vscode.commands.registerCommand(INIT_COMMAND_ID, () => runCommand(initializeWorktrees)),
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

async function initializeWorktrees() {
  const git = await getGitApi();
  if (!git) {
    return;
  }

  const repository = await pickRepository(
    git,
    'Select any worktree in the set; initialization uses the main workdir branch'
  );
  if (!repository) {
    return;
  }

  const { mainRoot, sourceBranch, worktrees } = await getMainWorktreeContext(repository.rootUri.fsPath);
  const folderNames = await promptForWorktreeFolderNames();
  if (folderNames.length === 0) {
    return;
  }

  const projectName = path.basename(mainRoot);
  const worktreesRoot = normalizeFsPath(path.resolve(mainRoot, '..', `${projectName}.worktrees`));
  const plan = await planWorktreeSetup(mainRoot, worktreesRoot, sourceBranch, folderNames, worktrees);

  if (plan.errors.length > 0) {
    outputChannel.clear();
    log('Cannot initialize or reinitialize worktrees:');
    for (const error of plan.errors) {
      log(`- ${error}`);
    }
    outputChannel.show(true);

    await vscode.window.showErrorMessage(
      'Some requested worktrees cannot be initialized or reinitialized. See the output channel for details.'
    );
    return;
  }

  outputChannel.clear();
  log(`Main worktree: ${mainRoot}`);
  log(`Source branch: ${sourceBranch}`);
  log(`Worktrees root: ${worktreesRoot}`);
  for (const item of plan.items) {
    log(`Planned: ${item.action} ${item.folderName} -> ${item.worktreePath} (${item.branchName})`);
  }

  const initializeCount = plan.items.filter((item) => item.action === 'initialize').length;
  const reinitializeCount = plan.items.length - initializeCount;
  const actionLabel = formatInitializationActionSummary(initializeCount, reinitializeCount);
  const previewAccepted = await showWorktreeSetupPreview(plan.items, worktreesRoot, sourceBranch);
  if (!previewAccepted) {
    return;
  }

  const confirmation = await vscode.window.showWarningMessage(
    `${actionLabel} from ${sourceBranch}?`,
    {
      modal: true,
      detail: [
        `Main worktree: ${mainRoot}`,
        `Source branch: ${sourceBranch}`,
        `Destination root: ${worktreesRoot}`,
        'Worktrees:',
        ...plan.items.map((item) => `- ${item.action}: ${item.folderName} -> ${item.branchName}`),
        '',
        'Reinitialize keeps gitignored files and recreates the branch from the main workdir branch.'
      ].join('\n')
    },
    'Run'
  );

  if (confirmation !== 'Run') {
    return;
  }

  await fs.mkdir(worktreesRoot, { recursive: true });

  const summary = {
    initialized: [],
    reinitialized: [],
    failed: []
  };

  outputChannel.show(true);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Initializing or reinitializing worktrees',
      cancellable: false
    },
    async (progress) => {
      for (let index = 0; index < plan.items.length; index += 1) {
        const item = plan.items[index];
        progress.report({
          increment: 100 / plan.items.length,
          message: `${index + 1}/${plan.items.length}: ${item.folderName}`
        });

        log(`${capitalize(item.action)} ${item.worktreePath} from ${sourceBranch} on ${item.branchName}`);

        try {
          await runWorktreeSetupItem(mainRoot, item);
          if (item.action === 'initialize') {
            summary.initialized.push(item);
          } else {
            summary.reinitialized.push(item);
          }
        } catch (error) {
          const message = asErrorMessage(error);
          summary.failed.push({ item, message });
          log(`Failed to ${item.action} ${item.folderName}: ${message}`);
        }
      }
    }
  );

  outputChannel.show(true);

  if (summary.failed.length > 0) {
    await vscode.window.showWarningMessage(
      `${formatInitializationResultSummary(summary.initialized.length, summary.reinitialized.length)}; ${summary.failed.length} failed. See the "${OUTPUT_CHANNEL_NAME}" output for details.`
    );
    return;
  }

  await vscode.window.showInformationMessage(
    `${formatInitializationResultSummary(summary.initialized.length, summary.reinitialized.length)} in ${worktreesRoot}.`
  );
}

async function syncConfiguredWorktreesToCurrentRepository() {
  const git = await getGitApi();
  if (!git) {
    return;
  }

  const selectedRepository = await pickRepository(
    git,
    'Select any worktree in the set; sync goes => main workdir branch'
  );
  if (!selectedRepository) {
    return;
  }

  const { destinationRepository, mainRoot, sourceBranch } = await resolveMainWorktreeRepository(
    git,
    selectedRepository
  );

  const selection = await getConfiguredWorktreeSelection(destinationRepository, {
    emptyMessage: `Set worktreeTools.migrationTargets in settings before syncing into ${destinationRepository.rootUri.fsPath} on ${sourceBranch}.`,
    noWorktreesMessage: `This worktree set has no linked worktrees to sync into ${destinationRepository.rootUri.fsPath} on ${sourceBranch}.`,
    noTargetsMessage: `No configured worktrees resolved to linked worktrees other than the destination ${destinationRepository.rootUri.fsPath} on ${sourceBranch}.`
  });
  if (!selection) {
    return;
  }

  const targets = await pickConfiguredWorktreeTargets(
    selection.targets,
    'Select which configured worktree changes should be synced => main workdir branch'
  );
  if (!targets) {
    return;
  }

  outputChannel.clear();
  log(`Main workdir: ${mainRoot}`);
  log(`Sync branch: ${sourceBranch}`);
  log(`Destination repository: ${destinationRepository.rootUri.fsPath}`);
  log(`Configured targets: ${selection.configuredTargets.join(', ')}`);
  log(`Resolved targets: ${selection.targets.join(', ')}`);
  log(`Selected targets: ${targets.join(', ')}`);

  if (selection.unmatched.length > 0) {
    log(`Unmatched configured targets: ${selection.unmatched.join(', ')}`);
  }

  const destinationLabel = path.basename(destinationRepository.rootUri.fsPath);
  const detailLines = [
    `Main workdir: ${mainRoot}`,
    `Sync => branch: ${sourceBranch}`,
    `Sync => destination: ${destinationRepository.rootUri.fsPath}`,
    'Sources:',
    ...targets.map((target) => `- ${target}`)
  ];

  if (selection.unmatched.length > 0) {
    detailLines.push('', `Ignored unmatched entries: ${selection.unmatched.join(', ')}`);
  }

  const confirmationAction = `Sync to ${sourceBranch}`;
  const confirmation = await vscode.window.showWarningMessage(
    `Sync ${targets.length} configured worktree(s) => ${destinationLabel} (${sourceBranch})?`,
    {
      modal: true,
      detail: detailLines.join('\n')
    },
    confirmationAction
  );

  if (confirmation !== confirmationAction) {
    return;
  }

  const continueOnError = vscode.workspace
    .getConfiguration(CONFIG_NAMESPACE, destinationRepository.rootUri)
    .get('continueOnMigrationError', false);

  const summary = {
    synced: [],
    failed: [],
    stoppedOnConflicts: null
  };

  log(`Starting batch migration into ${destinationRepository.rootUri.fsPath} on ${sourceBranch}`);
  outputChannel.show(true);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Syncing configured worktree changes => ${destinationLabel} (${sourceBranch})`,
      cancellable: false
    },
    async (progress) => {
      for (let index = 0; index < targets.length; index += 1) {
        const target = targets[index];
        progress.report({
          increment: 100 / targets.length,
          message: `${index + 1}/${targets.length}: ${path.basename(target)}`
        });

        log(`Sync ${target} => ${destinationRepository.rootUri.fsPath} (${sourceBranch})`);

        try {
          const sourceHasChanges = await hasWorktreeChanges(target);
          if (!sourceHasChanges) {
            log(`Skipping ${target}: no changes to sync => ${destinationRepository.rootUri.fsPath} (${sourceBranch})`);
            continue;
          }

          await destinationRepository.migrateChanges(target, {
            confirmation: false,
            deleteFromSource: true,
            untracked: true
          });
          summary.synced.push(target);

          if ((destinationRepository.state.mergeChanges ?? []).length > 0) {
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
      `Synced ${syncedCount} worktree(s) => ${destinationLabel} (${sourceBranch}). Merge conflicts were introduced while applying ${path.basename(summary.stoppedOnConflicts)}. Resolve them before running the command again.`
    );
    return;
  }

  if (failedCount > 0) {
    await vscode.window.showWarningMessage(
      `Synced ${syncedCount} worktree(s) => ${destinationLabel} (${sourceBranch}); ${failedCount} failed. See the "${OUTPUT_CHANNEL_NAME}" output for details.`
    );
    return;
  }

  const unmatchedSuffix =
    selection.unmatched.length > 0
      ? ` Ignored ${selection.unmatched.length} unmatched setting entr${selection.unmatched.length === 1 ? 'y' : 'ies'}.`
      : '';

  await vscode.window.showInformationMessage(
    `Synced ${syncedCount} configured worktree(s) => ${destinationLabel} (${sourceBranch}).${unmatchedSuffix}`
  );
}

async function syncConfiguredWorktreesFromMain() {
  const git = await getGitApi();
  if (!git) {
    return;
  }

  const selectedRepository = await pickRepository(
    git,
    'Select any worktree in the set; sync comes from the main workdir branch'
  );
  if (!selectedRepository) {
    return;
  }

  const { destinationRepository, mainRoot, sourceBranch } = await resolveMainWorktreeRepository(
    git,
    selectedRepository
  );

  await rebaseConfiguredWorktreesOntoCurrentMainBranch(destinationRepository, {
    mainRoot,
    sourceBranch,
    targetPlaceHolder: `Select which configured worktrees should be rebased onto ${sourceBranch}`,
    confirmationMessage: (count) => `Rebase ${count} configured worktree(s) onto ${sourceBranch}?`,
    progressTitle: `Syncing configured worktrees from ${sourceBranch} via rebase`,
    startLogMessage: `Starting batch sync from ${sourceBranch} (${mainRoot}) via rebase`,
    targetLogMessage: (target) => `Rebasing ${target} onto ${sourceBranch}`,
    conflictLogMessage: (target, message) =>
      `Stopping after rebase conflicts were introduced by ${target}: ${message}`,
    failureLogMessage: (target, message) => `Failed to rebase ${target}: ${message}`,
    conflictWarningMessage: (count, target) =>
      `Synced ${count} worktree(s) from ${sourceBranch}. Rebase conflicts were introduced while applying ${path.basename(target)}. Resolve them before running the command again.`,
    failureWarningMessage: (count, failedCount) =>
      `Synced ${count} worktree(s) from ${sourceBranch}; ${failedCount} failed. See the "${OUTPUT_CHANNEL_NAME}" output for details.`,
    successMessage: (count, unmatchedSuffix) =>
      `Synced ${count} configured worktree(s) from ${sourceBranch}.${unmatchedSuffix}`
  });
}

async function mergeWorktreesIntoMainWorkdir() {
  const git = await getGitApi();
  if (!git) {
    return;
  }

  const selectedRepository = await pickRepository(
    git,
    'Select any worktree in the set; rebased worktrees sync => main workdir branch'
  );
  if (!selectedRepository) {
    return;
  }

  const { destinationRepository, mainRoot, sourceBranch } = await resolveMainWorktreeRepository(
    git,
    selectedRepository
  );

  const selection = await getConfiguredWorktreeSelection(destinationRepository, {
    emptyMessage: `Set worktreeTools.migrationTargets in settings before rebasing and syncing into ${destinationRepository.rootUri.fsPath} on ${sourceBranch}.`,
    noWorktreesMessage: `This worktree set has no linked worktrees to rebase and sync into ${destinationRepository.rootUri.fsPath} on ${sourceBranch}.`,
    noTargetsMessage: `No configured worktrees resolved to linked worktrees other than the destination ${destinationRepository.rootUri.fsPath} on ${sourceBranch}.`
  });
  if (!selection) {
    return;
  }

  const targets = await pickConfiguredWorktreeTargets(
    selection.targets,
    `Select which configured worktrees should be rebased onto ${sourceBranch} and synced => main workdir`
  );
  if (!targets) {
    return;
  }

  const sourceBranchRef = toLocalBranchRef(sourceBranch);
  const sourceBranchExists = await localBranchExists(destinationRepository.rootUri.fsPath, sourceBranchRef);
  if (!sourceBranchExists) {
    await vscode.window.showErrorMessage(
      `Local branch ${sourceBranchRef} does not exist in this repository.`
    );
    return;
  }

  outputChannel.clear();
  log(`Main workdir: ${mainRoot}`);
  log(`Combined sync branch: ${sourceBranch}`);
  log(`Combined sync destination repository: ${destinationRepository.rootUri.fsPath}`);
  log(`Configured targets: ${selection.configuredTargets.join(', ')}`);
  log(`Resolved targets: ${selection.targets.join(', ')}`);
  log(`Selected targets: ${targets.join(', ')}`);

  if (selection.unmatched.length > 0) {
    log(`Unmatched configured targets: ${selection.unmatched.join(', ')}`);
  }

  const detailLines = [
    `Main workdir: ${mainRoot}`,
    `Destination: ${destinationRepository.rootUri.fsPath}`,
    `Process: rebase each selected worktree onto ${sourceBranchRef}, then sync that worktree into the main workdir branch ${sourceBranch}`,
    'Targets:',
    ...targets.map((target) => `- ${target}`)
  ];

  if (selection.unmatched.length > 0) {
    detailLines.push('', `Ignored unmatched entries: ${selection.unmatched.join(', ')}`);
  }

  const confirmation = await vscode.window.showWarningMessage(
    `Rebase ${targets.length} configured worktree(s) onto ${sourceBranch}, then sync them into ${path.basename(destinationRepository.rootUri.fsPath)}?`,
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

  log(`Starting combined rebase and sync into ${destinationRepository.rootUri.fsPath} from ${sourceBranchRef}`);
  outputChannel.show(true);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Rebasing worktrees onto ${sourceBranch}, then syncing to main workdir`,
      cancellable: false
    },
    async (progress) => {
      for (let index = 0; index < targets.length; index += 1) {
        const target = targets[index];
        progress.report({
          increment: 100 / targets.length,
          message: `${index + 1}/${targets.length}: ${path.basename(target)}`
        });

        log(`Rebasing ${target} onto ${sourceBranchRef}`);

        try {
          await execFileText('git', [
            '-C',
            target,
            'rebase',
            '--autostash',
            sourceBranchRef
          ]);
        } catch (error) {
          const message = asErrorMessage(error);
          const hasConflicts = await hasGitConflicts(target);
          if (hasConflicts) {
            summary.stoppedOnWorktreeConflicts = target;
            log(`Stopping after rebase conflicts were introduced in ${target}: ${message}`);
          } else {
            summary.failed.push({ target, message });
            log(`Failed to rebase ${target} onto ${sourceBranchRef}: ${message}`);
          }
          break;
        }

        log(`Syncing ${target} into ${destinationRepository.rootUri.fsPath} (${sourceBranch})`);

        try {
          const sourceHasChanges = await hasWorktreeChanges(target);
          if (!sourceHasChanges) {
            log(`Skipping sync from ${target}: no worktree changes to migrate after rebasing onto ${sourceBranch}`);
            summary.synced.push(target);
            continue;
          }

          await destinationRepository.migrateChanges(target, {
            confirmation: false,
            deleteFromSource: true,
            untracked: true
          });
          summary.synced.push(target);

          if ((destinationRepository.state.mergeChanges ?? []).length > 0) {
            summary.stoppedOnWorktreeConflicts = target;
            log(`Stopping after sync introduced conflicts from ${target}`);
            break;
          }
        } catch (error) {
          const message = asErrorMessage(error);
          summary.failed.push({ target, message });
          log(`Failed to sync ${target} into ${destinationRepository.rootUri.fsPath}: ${message}`);
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
      `Synced ${syncedCount} worktree(s) via ${sourceBranch}. Rebase or sync conflicts were introduced while processing ${path.basename(summary.stoppedOnWorktreeConflicts)}. Resolve them in that worktree or in the main workdir before running the command again.`
    );
    return;
  }

  if (failedCount > 0) {
    await vscode.window.showWarningMessage(
      `Synced ${syncedCount} worktree(s) via ${sourceBranch}; ${failedCount} failed. See the "${OUTPUT_CHANNEL_NAME}" output for details.`
    );
    return;
  }

  const unmatchedSuffix =
    selection.unmatched.length > 0
      ? ` Ignored ${selection.unmatched.length} unmatched setting entr${selection.unmatched.length === 1 ? 'y' : 'ies'}.`
      : '';

  await vscode.window.showInformationMessage(
    `Rebased onto ${sourceBranch} and synced ${syncedCount} configured worktree(s) into ${path.basename(destinationRepository.rootUri.fsPath)}.${unmatchedSuffix}`
  );
}

async function rebaseConfiguredWorktreesOntoCurrentMainBranch(repository, options) {
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

  const sourceBranchRef = toLocalBranchRef(options.sourceBranch);
  const sourceBranchExists = await localBranchExists(repository.rootUri.fsPath, sourceBranchRef);
  if (!sourceBranchExists) {
    await vscode.window.showErrorMessage(
      `Local branch ${sourceBranchRef} does not exist in this repository.`
    );
    return;
  }

  outputChannel.clear();
  log(`Main workdir: ${options.mainRoot}`);
  log(`Sync source branch: ${options.sourceBranch}`);
  log(`Sync repository: ${repository.rootUri.fsPath}`);
  log(`Configured targets: ${selection.configuredTargets.join(', ')}`);
  log(`Resolved targets: ${selection.targets.join(', ')}`);
  log(`Selected targets: ${targets.join(', ')}`);

  if (selection.unmatched.length > 0) {
    log(`Unmatched configured targets: ${selection.unmatched.join(', ')}`);
  }

  const detailLines = [
    `Main workdir: ${options.mainRoot}`,
    `Repository: ${repository.rootUri.fsPath}`,
    `Sync source: local ${options.sourceBranch} branch (${sourceBranchRef}) via rebase`,
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
            sourceBranchRef
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

async function resolveMainWorktreeRepository(git, repository) {
  const context = await getMainWorktreeContext(repository.rootUri.fsPath);
  const repositoryRoot = normalizeFsPath(repository.rootUri.fsPath);
  if (repositoryRoot === context.mainRoot) {
    return {
      destinationRepository: repository,
      ...context
    };
  }

  const mainRepository = findRepositoryByRootPath(git, context.mainRoot);
  if (!mainRepository) {
    throw new Error(
      `Open the main workdir at ${context.mainRoot} in this VS Code window to sync changes into branch ${context.sourceBranch}.`
    );
  }

  return {
    destinationRepository: mainRepository,
    ...context
  };
}

async function getMainWorktreeContext(repositoryRoot) {
  const worktrees = await listGitWorktrees(repositoryRoot);
  if (worktrees.length === 0) {
    throw new Error('No Git worktrees were found for this repository.');
  }

  const mainWorktree = worktrees[0];
  const sourceBranch = parseBranchRef(mainWorktree.branch);
  if (!sourceBranch) {
    throw new Error(`The main worktree at ${mainWorktree.path} is not currently on a branch.`);
  }

  return {
    mainRoot: mainWorktree.path,
    sourceBranch,
    worktrees
  };
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

function findRepositoryByRootPath(git, repositoryRoot) {
  const targetRoot = normalizeFsPath(repositoryRoot);
  return (git.repositories ?? []).find(
    (repository) => normalizeFsPath(repository.rootUri.fsPath) === targetRoot
  );
}

async function getConfiguredWorktreeSelection(repository, messages = {}) {
  const configuredTargets = getConfiguredTargets(repository);
  if (configuredTargets.length === 0) {
    await vscode.window.showWarningMessage(
      messages.emptyMessage ?? 'Set worktreeTools.migrationTargets in settings before running this command.'
    );
    return undefined;
  }

  const availableWorktrees = getAvailableWorktreePaths(repository);
  if (availableWorktrees.length === 0) {
    await vscode.window.showInformationMessage(
      messages.noWorktreesMessage ?? 'This repository has no linked worktrees.'
    );
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
      messages.noTargetsMessage ?? 'No configured worktrees resolved to linked worktrees other than the current repository.'
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

async function promptForWorktreeFolderNames() {
  const value = await vscode.window.showInputBox({
    title: 'Initialize or Reinitialize Worktrees',
    prompt: 'Enter the folder names to initialize or reinitialize',
    placeHolder: 'feature-a, feature-b',
    ignoreFocusOut: true,
    validateInput: (input) => validateWorktreeFolderNameInput(input)
  });

  if (!value) {
    return [];
  }

  return parseWorktreeFolderNameInput(value).folderNames;
}

function validateWorktreeFolderNameInput(input) {
  const { folderNames, errors } = parseWorktreeFolderNameInput(input);
  if (errors.length > 0) {
    return errors[0];
  }

  if (folderNames.length === 0) {
    return 'Enter at least one folder name.';
  }

  return undefined;
}

function parseWorktreeFolderNameInput(input) {
  const folderNames = [];
  const errors = [];
  const seen = new Set();
  const values = input
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter(Boolean);

  for (const value of values) {
    const validationError = validateWorktreeFolderName(value);
    if (validationError) {
      errors.push(validationError);
      continue;
    }

    if (seen.has(value)) {
      errors.push(`Duplicate folder name: ${value}`);
      continue;
    }

    seen.add(value);
    folderNames.push(value);
  }

  return { folderNames, errors };
}

function validateWorktreeFolderName(folderName) {
  if (!folderName) {
    return 'Enter at least one folder name.';
  }

  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(folderName)) {
    return `Invalid folder name: ${folderName}. Use letters, numbers, dots, dashes, or underscores.`;
  }

  return undefined;
}

async function planWorktreeSetup(mainRoot, worktreesRoot, sourceBranch, folderNames, worktrees) {
  const existingBranches = await listLocalBranches(mainRoot);
  const existingWorktrees = new Map(
    worktrees.map((worktree) => [normalizeFsPath(worktree.path), worktree])
  );
  const worktreeByBranch = new Map();
  const items = [];
  const errors = [];

  for (const worktree of worktrees) {
    const branchName = parseBranchRef(worktree.branch);
    if (branchName) {
      worktreeByBranch.set(branchName, worktree);
    }
  }

  for (const folderName of folderNames) {
    const branchName = `wt-${folderName}`;
    const worktreePath = normalizeFsPath(path.join(worktreesRoot, folderName));
    const existingWorktree = existingWorktrees.get(worktreePath);
    const worktreeUsingBranch = worktreeByBranch.get(branchName);

    if (existingWorktree && existingWorktree.path === mainRoot) {
      errors.push(`Cannot reinitialize the main worktree: ${worktreePath}`);
      continue;
    }

    if (worktreeUsingBranch && normalizeFsPath(worktreeUsingBranch.path) !== worktreePath) {
      errors.push(`Branch ${branchName} is already checked out in another worktree: ${worktreeUsingBranch.path}`);
      continue;
    }

    if (existingWorktree) {
      const existingWorktreeBranch = parseBranchRef(existingWorktree.branch);
      if (existingWorktreeBranch !== branchName) {
        errors.push(
          `Worktree ${worktreePath} is already linked to branch ${existingWorktreeBranch ?? '(detached HEAD)'}, expected ${branchName} for reinitialize.`
        );
        continue;
      }

      items.push({
        action: 'reinitialize',
        folderName,
        branchName,
        worktreePath,
        sourceBranch
      });
      continue;
    }

    if (await pathExists(worktreePath)) {
      errors.push(`Path already exists and is not a linked worktree: ${worktreePath}`);
      continue;
    }

    if (existingBranches.has(branchName)) {
      errors.push(
        `Branch already exists without a matching linked worktree: ${branchName}. Remove it or create the linked worktree manually before reinitializing.`
      );
      continue;
    }

    items.push({
      action: 'initialize',
      folderName,
      branchName,
      worktreePath,
      sourceBranch
    });
  }

  return { items, errors };
}

async function runWorktreeSetupItem(mainRoot, item) {
  if (item.action === 'initialize') {
    await createWorktree(mainRoot, item.worktreePath, item.branchName, item.sourceBranch);
    return;
  }

  if (await pathExists(item.worktreePath)) {
    await execFileText('git', ['-C', item.worktreePath, 'reset', '--hard']);
    await execFileText('git', ['-C', item.worktreePath, 'clean', '-ffd']);
    await execFileText('git', ['-C', item.worktreePath, 'checkout', '--detach']);
    await deleteLocalBranchIfExists(mainRoot, item.branchName);
    await execFileText('git', ['-C', item.worktreePath, 'checkout', '-B', item.branchName, item.sourceBranch]);
    return;
  }

  await deleteLocalBranchIfExists(mainRoot, item.branchName);
  await createWorktree(mainRoot, item.worktreePath, item.branchName, item.sourceBranch);
}

async function createWorktree(mainRoot, worktreePath, branchName, sourceBranch) {
  await execFileText('git', [
    '-C',
    mainRoot,
    'worktree',
    'add',
    '-b',
    branchName,
    worktreePath,
    sourceBranch
  ]);
}

async function deleteLocalBranch(repositoryRoot, branchName) {
  await execFileText('git', ['-C', repositoryRoot, 'branch', '-D', branchName]);
}

async function deleteLocalBranchIfExists(repositoryRoot, branchName) {
  if (!(await localBranchExistsByShortName(repositoryRoot, branchName))) {
    return;
  }

  await deleteLocalBranch(repositoryRoot, branchName);
}

async function localBranchExistsByShortName(repositoryRoot, branchName) {
  const stdout = await execFileText('git', [
    '-C',
    repositoryRoot,
    'for-each-ref',
    '--format=%(refname:short)',
    `refs/heads/${branchName}`
  ]);

  return stdout.trim() === branchName;
}

function formatInitializationActionSummary(initializeCount, reinitializeCount) {
  const parts = [];

  if (initializeCount > 0) {
    parts.push(`initialize ${initializeCount} worktree${initializeCount === 1 ? '' : 's'}`);
  }

  if (reinitializeCount > 0) {
    parts.push(`reinitialize ${reinitializeCount} worktree${reinitializeCount === 1 ? '' : 's'}`);
  }

  return capitalize(joinWithAnd(parts));
}

async function showWorktreeSetupPreview(items, worktreesRoot, sourceBranch) {
  const initializeItems = items.filter((item) => item.action === 'initialize');
  const reinitializeItems = items.filter((item) => item.action === 'reinitialize');
  const quickPick = vscode.window.createQuickPick();
  quickPick.title = 'Preview Initialize or Reinitialize Worktrees';
  quickPick.placeholder = `Source branch ${sourceBranch} -> ${worktreesRoot}`;
  quickPick.ignoreFocusOut = true;
  quickPick.items = [
    {
      label: 'Initialize',
      kind: vscode.QuickPickItemKind.Separator
    },
    ...initializeItems.map((item) => ({
      label: item.folderName,
      description: item.branchName,
      detail: item.worktreePath
    })),
    {
      label: 'Reinitialize',
      kind: vscode.QuickPickItemKind.Separator
    },
    ...reinitializeItems.map((item) => ({
      label: item.folderName,
      description: item.branchName,
      detail: `${item.worktreePath} - keeps gitignored files`
    }))
  ];

  quickPick.buttons = [
    {
      iconPath: new vscode.ThemeIcon('check'),
      tooltip: `Continue with ${items.length} worktree${items.length === 1 ? '' : 's'}`
    }
  ];

  return new Promise((resolve) => {
    let settled = false;

    const finish = (value) => {
      if (settled) {
        return;
      }

      settled = true;
      quickPick.hide();
      quickPick.dispose();
      resolve(value);
    };

    quickPick.onDidAccept(() => finish(true));
    quickPick.onDidTriggerButton(() => finish(true));
    quickPick.onDidHide(() => finish(false));
    quickPick.show();
  });
}

function formatInitializationResultSummary(initializeCount, reinitializeCount) {
  const parts = [];

  if (initializeCount > 0) {
    parts.push(`initialized ${initializeCount} worktree${initializeCount === 1 ? '' : 's'}`);
  }

  if (reinitializeCount > 0) {
    parts.push(`reinitialized ${reinitializeCount} worktree${reinitializeCount === 1 ? '' : 's'}`);
  }

  return capitalize(joinWithAnd(parts));
}

function joinWithAnd(values) {
  if (values.length === 0) {
    return 'processed 0 worktrees';
  }

  if (values.length === 1) {
    return values[0];
  }

  return `${values.slice(0, -1).join(', ')} and ${values[values.length - 1]}`;
}

function capitalize(value) {
  if (!value) {
    return value;
  }

  return value.charAt(0).toUpperCase() + value.slice(1);
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

async function listGitWorktrees(repositoryRoot) {
  const stdout = await execFileText('git', ['-C', repositoryRoot, 'worktree', 'list', '--porcelain']);
  return parseGitWorktreeList(stdout);
}

function parseGitWorktreeList(stdout) {
  const worktrees = [];
  let currentWorktree;

  for (const line of stdout.split(/\r?\n/)) {
    if (!line) {
      if (currentWorktree) {
        worktrees.push(currentWorktree);
        currentWorktree = undefined;
      }
      continue;
    }

    const separatorIndex = line.indexOf(' ');
    const key = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
    const value = separatorIndex === -1 ? '' : line.slice(separatorIndex + 1);

    if (key === 'worktree') {
      if (currentWorktree) {
        worktrees.push(currentWorktree);
      }

      currentWorktree = {
        path: normalizeFsPath(value)
      };
      continue;
    }

    if (currentWorktree) {
      currentWorktree[key] = value;
    }
  }

  if (currentWorktree) {
    worktrees.push(currentWorktree);
  }

  return worktrees;
}

function parseBranchRef(value) {
  const prefix = 'refs/heads/';
  if (typeof value !== 'string' || !value.startsWith(prefix)) {
    return undefined;
  }

  return value.slice(prefix.length);
}

function toLocalBranchRef(branchName) {
  return `refs/heads/${branchName}`;
}

async function listLocalBranches(repositoryRoot) {
  const stdout = await execFileText('git', [
    '-C',
    repositoryRoot,
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads'
  ]);

  return new Set(
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  );
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
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

// Pure JavaScript module for polkit stack management.
// No GJS/GObject imports — runs under plain Node and is unit-tested.

// ---------------------------------------------------------------------------
// Constants: paths and names for the v2 polkit stack.
// ---------------------------------------------------------------------------

export const WRAPPER_PATH = '/usr/local/bin/nvme-smart-log-json';
export const UNINSTALL_PATH = '/usr/local/bin/nvme-smart-uninstall.sh';
export const SETUP_SCRIPT_NAME = 'setup-polkit.sh';
export const SMART_GROUP_NAME = 'nvme-smart';

// ---------------------------------------------------------------------------
// Check if the v2 polkit stack is installed by testing for the wrapper.
// `fileExistsFn` is a function that takes a path and returns true if it exists.
// ---------------------------------------------------------------------------

export function isV2Installed(fileExistsFn) {
    return fileExistsFn(WRAPPER_PATH);
}

// ---------------------------------------------------------------------------
// Check if the uninstall script is available.
// `fileExistsFn` is a function that takes a path and returns true if it exists.
// ---------------------------------------------------------------------------

export function isUninstallAvailable(fileExistsFn) {
    return fileExistsFn(UNINSTALL_PATH);
}

// ---------------------------------------------------------------------------
// Check if the current user is a member of the SMART group.
// `runCommandSyncFn` is a function that runs a command and returns
// { ok, exitCode, stdout, stderr }.
// ---------------------------------------------------------------------------

export function isCurrentUserInSmartGroup(runCommandSyncFn, getUserNameFn = () => '') {
    const user = getUserNameFn();
    const result = runCommandSyncFn(['id', '-nG', user]);
    if (!result.ok || result.exitCode !== 0) return false;
    return result.stdout.trim().split(/\s+/).includes(SMART_GROUP_NAME);
}

// ---------------------------------------------------------------------------
// Result object returned by command execution.
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} CommandResult
 * @property {boolean} ok - Whether the command executed without throwing.
 * @property {number} exitCode - The process exit code.
 * @property {string} stdout - Standard output.
 * @property {string} stderr - Standard error.
 */

// ---------------------------------------------------------------------------
// Run a command via pkexec synchronously.
// `runCommandSyncFn` runs the actual command (platform-specific).
// `findProgramInPathFn` locates pkexec in PATH (platform-specific).
// ---------------------------------------------------------------------------

export function runPkexecSync(runCommandSyncFn, findProgramInPathFn, argv) {
    const pkexecPath = findProgramInPathFn('pkexec');
    if (!pkexecPath) {
        return { ok: false, exitCode: -1, stdout: '', stderr: 'pkexec not found' };
    }
    return runCommandSyncFn([pkexecPath, ...argv]);
}

// ---------------------------------------------------------------------------
// Check if the setup script exists at a given extension path.
// `fileExistsFn` tests file existence.
// `buildFilenamevFn` joins path components (platform-specific).
// ---------------------------------------------------------------------------

export function checkSetupScriptExists(extensionPath, fileExistsFn, buildFilenamevFn) {
    const setupPath = buildFilenamevFn([extensionPath || '', SETUP_SCRIPT_NAME]);
    return fileExistsFn(setupPath);
}

// ---------------------------------------------------------------------------
// Install the v2 polkit stack.
// Returns a result object with success status and messages.
// `options` contains all the platform-specific functions and values:
//   - runPkexecSyncFn: function to run pkexec commands
//   - buildFilenamevFn: function to build file paths
//   - fileExistsFn: function to check file existence
//   - extensionPath: the extension directory path
//   - isCurrentUserInSmartGroupFn: function to check group membership
// ---------------------------------------------------------------------------

export function installV2Stack(options) {
    const {
        runPkexecSyncFn,
        buildFilenamevFn,
        fileExistsFn,
        extensionPath,
        isCurrentUserInSmartGroupFn,
    } = options;

    const setupPath = buildFilenamevFn([extensionPath || '', SETUP_SCRIPT_NAME]);

    if (!fileExistsFn(setupPath)) {
        return {
            ok: false,
            error: 'setup_script_not_found',
            message: `setup-polkit.sh not found: ${setupPath}`,
            setupPath,
        };
    }

    const wasInSmartGroup = isCurrentUserInSmartGroupFn();

    const result = runPkexecSyncFn([setupPath]);

    if (result.ok && result.exitCode === 0) {
        return {
            ok: true,
            wasInSmartGroup,
            stderr: result.stderr,
            stdout: result.stdout,
        };
    }

    return {
        ok: false,
        error: 'installation_failed',
        exitCode: result.exitCode,
        stderr: result.stderr,
        stdout: result.stdout,
    };
}

// ---------------------------------------------------------------------------
// Uninstall the v2 polkit stack.
// Returns a result object with success status and messages.
// `options` contains all the platform-specific functions and values:
//   - runPkexecSyncFn: function to run pkexec commands
//   - isUninstallAvailableFn: function to check if uninstall script exists
//   - buildFilenamevFn: function to build file paths
//   - fileExistsFn: function to check file existence
// ---------------------------------------------------------------------------

export function uninstallV2Stack(options) {
    const {
        runPkexecSyncFn,
        isUninstallAvailableFn,
    } = options;

    if (!isUninstallAvailableFn()) {
        return {
            ok: false,
            error: 'uninstall_script_not_found',
            message: 'Uninstall script not found.',
        };
    }

    const result = runPkexecSyncFn([UNINSTALL_PATH]);

    if (result.ok && result.exitCode === 0) {
        return {
            ok: true,
            stderr: result.stderr,
            stdout: result.stdout,
        };
    }

    return {
        ok: false,
        error: 'uninstall_failed',
        exitCode: result.exitCode,
        stderr: result.stderr,
        stdout: result.stdout,
    };
}

// ---------------------------------------------------------------------------
// Toggle the v2 polkit stack installation state.
// This is the main function to be called from the UI toggle.
// Returns a result object that the UI can use to update state.
// `options` contains all the platform-specific functions and values:
//   - state: boolean - true to install, false to uninstall
//   - extensionPath: the extension directory path
//   - fileExistsFn: function to check file existence
//   - buildFilenamevFn: function to build file paths
//   - findProgramInPathFn: function to find programs in PATH
//   - runCommandSyncFn: function to run commands
//   - getUserNameFn: function to get current username
// ---------------------------------------------------------------------------

export function toggleV2Stack(options) {
    const {
        state,
        extensionPath,
        fileExistsFn,
        buildFilenamevFn,
        findProgramInPathFn,
        runCommandSyncFn,
        getUserNameFn,
    } = options;

    if (state) {
        // Install
        const setupPath = buildFilenamevFn([extensionPath || '', SETUP_SCRIPT_NAME]);

        if (!fileExistsFn(setupPath)) {
            return {
                ok: false,
                action: 'install',
                error: 'setup_script_not_found',
                message: `setup-polkit.sh not found: ${setupPath}`,
                setupPath,
            };
        }

        const wasInSmartGroup = isCurrentUserInSmartGroup(
            runCommandSyncFn,
            getUserNameFn,
        );

        const result = runPkexecSync(
            runCommandSyncFn,
            findProgramInPathFn,
            [setupPath],
        );

        if (result.ok && result.exitCode === 0) {
            return {
                ok: true,
                action: 'install',
                wasInSmartGroup,
                stderr: result.stderr,
                stdout: result.stdout,
            };
        }

        return {
            ok: false,
            action: 'install',
            error: 'installation_failed',
            exitCode: result.exitCode,
            stderr: result.stderr,
            stdout: result.stdout,
        };
    } else {
        // Uninstall
        if (!isUninstallAvailable(fileExistsFn)) {
            return {
                ok: false,
                action: 'uninstall',
                error: 'uninstall_script_not_found',
                message: 'Uninstall script not found.',
            };
        }

        const result = runPkexecSync(
            runCommandSyncFn,
            findProgramInPathFn,
            [UNINSTALL_PATH],
        );

        if (result.ok && result.exitCode === 0) {
            return {
                ok: true,
                action: 'uninstall',
                stderr: result.stderr,
                stdout: result.stdout,
            };
        }

        return {
            ok: false,
            action: 'uninstall',
            error: 'uninstall_failed',
            exitCode: result.exitCode,
            stderr: result.stderr,
            stdout: result.stdout,
        };
    }
}

// Pure JavaScript module for polkit stack management.
// No GJS/GObject imports — runs under plain Node and is unit-tested.

// ---------------------------------------------------------------------------
// Constants: paths and names for the v2 polkit stack.
// ---------------------------------------------------------------------------

export const WRAPPER_PATH = '/usr/local/bin/nvme-smart-log-json';
export const UNINSTALL_PATH = '/usr/local/bin/nvme-smart-uninstall.sh';
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
// Uninstall the v2 polkit stack.
// Returns a result object with success status and messages.
// `options` contains all the platform-specific functions and values:
//   - runPkexecSyncFn: function to run pkexec commands
//   - isUninstallAvailableFn: function to check if uninstall script exists
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


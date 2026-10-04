import test from 'node:test';
import assert from 'node:assert/strict';

import {
    WRAPPER_PATH,
    UNINSTALL_PATH,
    SMART_GROUP_NAME,
    isV2Installed,
    isUninstallAvailable,
    isCurrentUserInSmartGroup,
    runPkexecSync,
    uninstallV2Stack,
} from '../nvme-monitor@rloutrel.github.com/polkitManager.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test('polkitManager: exports correct constant values', () => {
    assert.equal(WRAPPER_PATH, '/usr/local/bin/nvme-smart-log-json');
    assert.equal(UNINSTALL_PATH, '/usr/local/bin/nvme-smart-uninstall.sh');
    assert.equal(SMART_GROUP_NAME, 'nvme-smart');
});

// ---------------------------------------------------------------------------
// isV2Installed
// ---------------------------------------------------------------------------

test('isV2Installed: returns true when wrapper exists', () => {
    const fileExistsFn = (path) => path === WRAPPER_PATH;
    assert.equal(isV2Installed(fileExistsFn), true);
});

test('isV2Installed: returns false when wrapper does not exist', () => {
    const fileExistsFn = () => false;
    assert.equal(isV2Installed(fileExistsFn), false);
});

// ---------------------------------------------------------------------------
// isUninstallAvailable
// ---------------------------------------------------------------------------

test('isUninstallAvailable: returns true when uninstall script exists', () => {
    const fileExistsFn = (path) => path === UNINSTALL_PATH;
    assert.equal(isUninstallAvailable(fileExistsFn), true);
});

test('isUninstallAvailable: returns false when uninstall script does not exist', () => {
    const fileExistsFn = () => false;
    assert.equal(isUninstallAvailable(fileExistsFn), false);
});

// ---------------------------------------------------------------------------
// isCurrentUserInSmartGroup
// ---------------------------------------------------------------------------

test('isCurrentUserInSmartGroup: returns true when user is in smart group', () => {
    const runCommandSyncFn = (argv) => {
        assert.deepEqual(argv, ['id', '-nG', 'testuser']);
        return {
            ok: true,
            exitCode: 0,
            stdout: `nvme-smart other-group\n`,
            stderr: '',
        };
    };
    const getUserNameFn = () => 'testuser';
    assert.equal(isCurrentUserInSmartGroup(runCommandSyncFn, getUserNameFn), true);
});

test('isCurrentUserInSmartGroup: returns false when user is not in smart group', () => {
    const runCommandSyncFn = () => ({
        ok: true,
        exitCode: 0,
        stdout: 'other-group another-group\n',
        stderr: '',
    });
    const getUserNameFn = () => 'testuser';
    assert.equal(isCurrentUserInSmartGroup(runCommandSyncFn, getUserNameFn), false);
});

test('isCurrentUserInSmartGroup: returns false when command fails', () => {
    const runCommandSyncFn = () => ({ ok: false, exitCode: 1, stdout: '', stderr: 'error' });
    const getUserNameFn = () => 'testuser';
    assert.equal(isCurrentUserInSmartGroup(runCommandSyncFn, getUserNameFn), false);
});

test('isCurrentUserInSmartGroup: returns false when exit code is non-zero', () => {
    const runCommandSyncFn = () => ({ ok: true, exitCode: 1, stdout: '', stderr: '' });
    const getUserNameFn = () => 'testuser';
    assert.equal(isCurrentUserInSmartGroup(runCommandSyncFn, getUserNameFn), false);
});

// ---------------------------------------------------------------------------
// runPkexecSync
// ---------------------------------------------------------------------------

test('runPkexecSync: returns error when pkexec not found', () => {
    const runCommandSyncFn = () => ({ ok: true, exitCode: 0, stdout: '', stderr: '' });
    const findProgramInPathFn = () => null;
    const result = runPkexecSync(runCommandSyncFn, findProgramInPathFn, ['echo', 'test']);
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, -1);
    assert.equal(result.stderr, 'pkexec not found');
});

test('runPkexecSync: runs command with pkexec when found', () => {
    const runCommandSyncFn = (argv) => {
        assert.deepEqual(argv, ['/usr/bin/pkexec', 'echo', 'test']);
        return { ok: true, exitCode: 0, stdout: 'test\n', stderr: '' };
    };
    const findProgramInPathFn = () => '/usr/bin/pkexec';
    const result = runPkexecSync(runCommandSyncFn, findProgramInPathFn, ['echo', 'test']);
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'test\n');
});

// ---------------------------------------------------------------------------
// uninstallV2Stack
// ---------------------------------------------------------------------------

test('uninstallV2Stack: returns uninstall_script_not_found when script missing', () => {
    const runPkexecSyncFn = () => ({ ok: true, exitCode: 0, stdout: '', stderr: '' });
    const isUninstallAvailableFn = () => false;
    const result = uninstallV2Stack({
        runPkexecSyncFn,
        isUninstallAvailableFn,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'uninstall_script_not_found');
});

test('uninstallV2Stack: returns success when uninstallation succeeds', () => {
    const runPkexecSyncFn = () => ({ ok: true, exitCode: 0, stdout: 'done', stderr: '' });
    const isUninstallAvailableFn = () => true;
    const result = uninstallV2Stack({
        runPkexecSyncFn,
        isUninstallAvailableFn,
    });
    assert.equal(result.ok, true);
    assert.equal(result.stdout, 'done');
});

test('uninstallV2Stack: returns uninstall_failed when command fails', () => {
    const runPkexecSyncFn = () => ({ ok: false, exitCode: 1, stdout: '', stderr: 'error' });
    const isUninstallAvailableFn = () => true;
    const result = uninstallV2Stack({
        runPkexecSyncFn,
        isUninstallAvailableFn,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'uninstall_failed');
    assert.equal(result.exitCode, 1);
});

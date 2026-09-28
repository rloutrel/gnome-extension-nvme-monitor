// GJS-specific subprocess and file helpers wrapping the pure polkitManager
// module, plus nvme-cli version detection.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {_debug, _warn, notifyError} from './logger.js';
import {parseNvmeVersion, assessNvmeCliVersion, FORMAT_CHANGE_ISSUE_URL} from './versionUtils.js';
import {
    isV2Installed,
    isUninstallAvailable,
    isCurrentUserInSmartGroup,
    runPkexecSync,
} from './polkitManager.js';

// Run a command synchronously (no pkexec).
// Returns { ok, exitCode, stdout, stderr }.
export function runCommandSync(argv) {
    try {
        const proc = new Gio.Subprocess({
            argv: argv,
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        });
        proc.init(null);

        const result = proc.communicate_utf8(null, null);

        return {
            ok: true,
            exitCode: proc.get_exit_status(),
            stdout: result[1] || '',
            stderr: result[2] || '',
        };
    } catch (e) {
        return {ok: false, exitCode: -1, stdout: '', stderr: e.message};
    }
}

export function fileExists(path) {
    return GLib.file_test(path, GLib.FileTest.EXISTS);
}

export function checkV2Installed() {
    return isV2Installed(fileExists);
}

export function checkCurrentUserInSmartGroup() {
    return isCurrentUserInSmartGroup(runCommandSync, GLib.get_user_name);
}

export function checkUninstallAvailable() {
    return isUninstallAvailable(fileExists);
}

export function runPkexec(argv) {
    // The no-password polkit rule only matches nvme-smart group members with
    // an active local session. Without membership pkexec falls back to
    // auth_admin: the GNOME Shell polkit agent runs on the same main loop this
    // synchronous call blocks, so a prompt here deadlocks the session.
    if (!checkCurrentUserInSmartGroup()) {
        return {
            ok: false,
            exitCode: -1,
            stdout: '',
            stderr: 'nvme-smart group membership is not active in this session',
        };
    }

    return runPkexecSync(runCommandSync, GLib.find_program_in_path, argv);
}

// Run a command asynchronously. Resolves with
// { ok, exitCode, stdout, stderr }, rejects if the process cannot spawn.
// The main loop keeps running while waiting, so polkit authentication
// prompts (shown by the GNOME Shell agent) remain possible.
export function runCommandAsync(argv) {
    return new Promise((resolve, reject) => {
        let proc;
        try {
            proc = new Gio.Subprocess({
                argv: argv,
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            });
            proc.init(null);
        } catch (e) {
            reject(e);
            return;
        }
        proc.communicate_utf8_async(null, null, (p, res) => {
            try {
                const result = p.communicate_utf8_finish(res);
                resolve({
                    ok: true,
                    exitCode: p.get_exit_status(),
                    stdout: result[1] || '',
                    stderr: result[2] || '',
                });
            } catch (e) {
                reject(e);
            }
        });
    });
}

// Run a command via pkexec asynchronously.
// Resolves with { ok, exitCode, stdout, stderr }, rejects on spawn failure.
export function runPkexecAsync(argv) {
    const pkexecPath = GLib.find_program_in_path('pkexec');
    if (!pkexecPath) {
        return Promise.reject(new Error('pkexec not found'));
    }
    return runCommandAsync([pkexecPath, ...argv]);
}

// Detect the installed nvme-cli version once and warn the user if it is
// affected by a known `nvme list -o json` software bug.
export function checkNvmeCliVersion(nvmeBin) {
    if (!nvmeBin) {
        _warn('nvme-cli not found; skipping version check');
        return;
    }

    const result = runCommandSync([nvmeBin, 'version']);
    if (!result.ok || result.exitCode !== 0) {
        _warn(`nvme version failed (exit ${result.exitCode})`);
        return;
    }

    const version = parseNvmeVersion(result.stdout);
    if (!version) {
        _warn(`nvme version: unparseable output: ${result.stdout?.trim() || '(empty)'}`);
        return;
    }

    _debug(`nvme-cli version: ${version.join('.')}`);

    const assessment = assessNvmeCliVersion(version);
    if (assessment.affected) {
        const versionStr = version.join('.');
        const detail = assessment.reasons.join(' ');
        const body = `${_('nvme-cli compatibility warning')} (v${versionStr}): ${detail}`;
        notifyError(_('NVMe Monitor'), `${body}\n${FORMAT_CHANGE_ISSUE_URL}`);
    }
}

// v2 polkit stack install/uninstall flow orchestration. GJS module: runs
// pkexec asynchronously and reports progress through a `ui` interface so the
// Indicator class stays free of flow logic.
//
// The `ui` interface:
//   setToggleSensitive(sensitive)  enable/disable the toggle widget
//   setToggleState(active)         set the toggle visual state
//   setUpdating(updating)          set the re-entrancy guard
//   onInstalled()                  stack installed (start polling + refresh)
//   onUninstalled()                stack uninstalled (stop polling + refresh)

import GLib from 'gi://GLib';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {_debug, _warn, _error, notify, notifyError} from './logger.js';
import {runPkexecAsync} from './subprocess.js';
import {UNINSTALL_PATH, SETUP_SCRIPT_NAME} from './polkitManager.js';
import {
    KILL_THRESHOLD,
    buildSetupPath,
    handleUninstallNotFound,
} from './v2decisions.js';

export {KILL_THRESHOLD, buildSetupPath, handleUninstallNotFound};

// Install the polkit stack via setup-polkit.sh (pkexec, async). Returns
// {started}: false when the setup script is missing (toggle disabled).
export function installV2Stack({extensionPath, wasInSmartGroup, ui}) {
    const setupPath = buildSetupPath(extensionPath, SETUP_SCRIPT_NAME);
    _debug(`installV2Stack: setupPath=${setupPath}`);

    if (!GLib.file_test(setupPath, GLib.FileTest.EXISTS)) {
        _warn(`setup-polkit.sh not found: ${setupPath}`);
        notifyError(_('setup-polkit.sh not found. Place it in the extension directory.'));
        ui.setToggleSensitive(false);
        ui.setUpdating(false);
        return {started: false};
    }

    _debug('Running pkexec setup-polkit.sh...');
    ui.setToggleSensitive(false);
    runPkexecAsync([setupPath]).then(result => {
        ui.setToggleSensitive(true);
        if (result.stderr) _debug(`stderr: ${result.stderr.trim()}`);
        if (result.stdout) _debug(`stdout: ${result.stdout.trim()}`);
        if (result.ok && result.exitCode === 0) {
            _debug('Installation complete');
            const body = wasInSmartGroup
                ? ''
                : _('Please log out and back in for new group membership.');
            notify(_('NVMe polkit stack installed!'), body);
            ui.setToggleState(true);
            ui.onInstalled();
        } else {
            _warn(`Installation failed (exit code ${result.exitCode}): ${result.stderr || result.stdout}`);
            const errorMsg = result.stderr ? result.stderr.trim() : `Exit code: ${result.exitCode}`;
            notifyError(_('Installation failed'), errorMsg);
            ui.setToggleState(false);
        }
        ui.setUpdating(false);
    }).catch(e => {
        ui.setToggleSensitive(true);
        _warn(`Installation failed: ${e.message}`);
        notifyError(_('Installation failed'), e.message);
        ui.setToggleState(false);
        ui.setUpdating(false);
    });
    return {started: true};
}

// Uninstall the polkit stack via nvme-smart-uninstall.sh (pkexec, async).
// The caller is responsible for the not-found branch (see
// handleUninstallNotFound); this runs once the script is confirmed present.
export function uninstallV2Stack({ui}) {
    _debug('Running pkexec nvme-smart-uninstall.sh...');
    ui.setToggleSensitive(false);
    runPkexecAsync([UNINSTALL_PATH]).then(result => {
        ui.setToggleSensitive(true);
        if (result.stderr) _debug(`stderr: ${result.stderr.trim()}`);
        if (result.stdout) _debug(`stdout: ${result.stdout.trim()}`);
        if (result.ok && result.exitCode === 0) {
            _debug('Uninstall complete');
            notify(_('NVMe polkit stack uninstalled.'), '');
            ui.setToggleState(false);
            ui.onUninstalled();
        } else {
            _warn(`Uninstall failed (exit code ${result.exitCode}): ${result.stderr || result.stdout}`);
            const errorMsg = result.stderr ? result.stderr.trim() : `Exit code: ${result.exitCode}`;
            notifyError(_('Uninstall failed'), errorMsg);
            ui.setToggleState(true);
        }
        ui.setUpdating(false);
    }).catch(e => {
        ui.setToggleSensitive(true);
        _warn(`Uninstall failed: ${e.message}`);
        notifyError(_('Uninstall failed'), e.message);
        ui.setToggleState(true);
        ui.setUpdating(false);
    });
}

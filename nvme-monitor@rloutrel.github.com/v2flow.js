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
import Gio from 'gi://Gio';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {_debug, _warn, _error, notify, notifyError} from './logger.js';
import {runPkexecAsync} from './subprocess.js';
import {UNINSTALL_PATH} from './polkitManager.js';
import {
    KILL_THRESHOLD,
    handleUninstallNotFound,
} from './v2decisions.js';
import {preparePastedSetupScript, setupScriptErrorMessage, buildSetupTempName} from './v2script.js';

export {KILL_THRESHOLD, handleUninstallNotFound};

// Request that GNOME Shell disable this extension via D-Bus. Used to break
// the uninstall-not-found toggle loop once the kill threshold is reached.
export function disableSelfViaDbus(uuid) {
    try {
        const dbus = Gio.DBus.session;
        dbus.call_sync(
            'org.gnome.Shell.Extensions',
            '/org/gnome/Shell/Extensions',
            'org.gnome.Shell.Extensions',
            'DisableExtension',
            new GLib.Variant('(s)', [uuid]),
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null
        );
    } catch (e) {
        _warn(`Could not disable via D-Bus: ${e.message}`);
    }
}

// Install the polkit stack by executing the setup script the user pasted
// from the GitHub repository into the setup dialog. The script content is
// first validated (v2script.js), then written to a 0700 temp file owned by
// the user and run via pkexec (async). The file is always deleted afterwards.
// Returns {started}: false when the pasted content is invalid (the dialog
// shows the reason and stays open).
export function installV2StackFromPastedScript({scriptContent, wasInSmartGroup, ui, writeFileFn = null, tempDirFn = null}) {
    const prepared = preparePastedSetupScript(scriptContent);
    if (!prepared.ok) {
        _warn(`pasted setup script rejected: ${prepared.reason}`);
        notifyError(_('Setup script rejected'), setupScriptErrorMessage(prepared.reason, _));
        return {started: false};
    }

    const writeFile = writeFileFn || ((path, contents) => new Promise((resolve, reject) => {
        const file = Gio.File.new_for_path(path);
        file.replace_contents_bytes_async(
            new TextEncoder().encode(contents), null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null,
            (source, result) => {
                try {
                    source.replace_contents_finish(result);
                    source.set_attribute_uint32(
                        'unix::mode', 0o700, Gio.FileQueryInfoFlags.NONE, null);
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
    }));
    const dir = tempDirFn
        ? tempDirFn()
        : GLib.build_filenamev([GLib.get_user_runtime_dir(), 'nvme-monitor-setup']);
    GLib.mkdir_with_parents(dir, 0o700);
    const scriptPath = GLib.build_filenamev([dir, buildSetupTempName()]);

    const runInstall = () => writeFile(scriptPath, prepared.script)
        .then(() => {
            _debug(`installV2StackFromPastedScript: ${scriptPath}`);
            ui.setToggleSensitive(false);
            return runPkexecAsync([scriptPath]);
        })
        .then((result) => {
        GLib.unlink(scriptPath);
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
        try {
            GLib.unlink(scriptPath);
        } catch {
            // Already gone.
        }
        ui.setToggleSensitive(true);
        _warn(`Installation failed: ${e.message}`);
        notifyError(_('Installation failed'), e.message);
        ui.setToggleState(false);
        ui.setUpdating(false);
    });
    runInstall().catch((e) => {
        _warn(`could not write temp setup script: ${e.message}`);
        notifyError(_('Installation failed'), e.message);
        ui.setToggleSensitive(true);
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

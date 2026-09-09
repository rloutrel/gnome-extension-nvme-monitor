import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {PopupBaseMenuItem, PopupMenuItem, PopupSwitchMenuItem, PopupSeparatorMenuItem, PopupMenuSection} from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Import the SMART parser
import { parseSmart } from './smartParser.js';

// ---------------------------------------------------------------------------
// Unified logger + simple loop detector.
//

const LOG_PREFIX = '[NVMe-monitor]';
const LOOP_THRESHOLD = 20;          // max 20 log lines per second
const LOOP_WINDOW_US = 1_000_000;   // 1 second in microseconds
const LOOP_CONTEXT_LINES = 10;      // lines to dump when loop detected

// Global fail counter — incremented each time "Uninstall script not found"
// is reached.  When it reaches KILL_THRESHOLD, the extension disables itself
// to break the infinite toggle loop.
const KILL_THRESHOLD = 4;
let _uninstallNotFoundCount = 0;

const _logTimestamps = [];  // sliding window of timestamps (microseconds)
const _logRecent = [];      // recent messages for context dump
let _loopDetected = false;

function _log(message) {
    const text = `${LOG_PREFIX} ${message}`;
    console.log(text);

    if (_loopDetected) return;

    const ts = GLib.get_monotonic_time(); // microseconds

    // Sliding window: remove timestamps older than 1 second.
    while (_logTimestamps.length > 0 && (ts - _logTimestamps[0]) > LOOP_WINDOW_US) {
        _logTimestamps.shift();
    }
    _logTimestamps.push(ts);

    // Keep recent messages for context.
    _logRecent.push(message);
    if (_logRecent.length > LOOP_CONTEXT_LINES) {
        _logRecent.shift();
    }

    // Detect: too many calls in 1 second → loop.
    if (_logTimestamps.length > LOOP_THRESHOLD) {
        _loopDetected = true;
        console.log(`${LOG_PREFIX} ⛔ LOOP DETECTED — ${_logTimestamps.length} log calls in 1 second.`);
        console.log(`${LOG_PREFIX} ⛔ Last ${_logRecent.length} messages before detection:`);
        for (let i = 0; i < _logRecent.length; i++) {
            console.log(`${LOG_PREFIX} ⛔   [${i + 1}] ${_logRecent[i]}`);
        }
        Main.notify(`NVMe Monitor: boucle détectée — ${_logTimestamps.length} appels/seconde. Voir les logs.`);
        return;
    }
}

function logAndNotify(title, body) {
    _log(`${title}${body ? ' — ' + body : ''}`);
    Main.notify(title, body || '');
}

// ---------------------------------------------------------------------------
// v2: New polkit stack paths (installed by setup-polkit.sh)
// ---------------------------------------------------------------------------
const WRAPPER_PATH = '/usr/local/bin/nvme-smart-log-json';
const UNINSTALL_PATH = '/usr/local/bin/nvme-smart-uninstall.sh';
const SETUP_SCRIPT_NAME = 'setup-polkit.sh';

const ICONS_DIR = 'icons';
const ICONS_BOOTSTRAP = 'bootstrap';
const ICON_EXTENSION = '.svg';

// Bundled SVG icons (shipped in icons/bootstrap/) referenced by bare name.
// System fallback (not bundled) for the panel placeholder.
const ICONS = Object.freeze({
    NvmeDark: 'nvme-dark',
    Nvme: 'nvme',
    ThermometerLow: 'thermometer-low',
    ThermometerHalf: 'thermometer-half',
    ThermometerHigh: 'thermometer-high',
    PanelFallback: 'drive-harddisk-symbolic',
});

// Build a Gio.FileIcon from an absolute path, or null if the file is missing.
function fileIcon(iconPath) {
    if (!GLib.file_test(iconPath, GLib.FileTest.EXISTS)) return null;
    return new Gio.FileIcon({ file: Gio.File.new_for_path(iconPath) });
}

function isV2Installed() {
    return GLib.file_test(WRAPPER_PATH, GLib.FileTest.EXISTS);
}

function isUninstallAvailable() {
    return GLib.file_test(UNINSTALL_PATH, GLib.FileTest.EXISTS);
}

// ---------------------------------------------------------------------------
// Run a command synchronously (no pkexec).
// Returns { ok, exitCode, stdout, stderr }.
// ---------------------------------------------------------------------------
function runCommandSync(argv) {
    try {
        const proc = new Gio.Subprocess({
            argv: argv,
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        });
        proc.init(null);

        // communicate_utf8() returns [success, stdout, stderr] as strings.
        const result = proc.communicate_utf8(null, null);

        return {
            ok: true,
            exitCode: proc.get_exit_status(),
            stdout: result[1] || '',
            stderr: result[2] || '',
        };
    } catch (e) {
        return { ok: false, exitCode: -1, stdout: '', stderr: e.message };
    }
}

// ---------------------------------------------------------------------------
// Run a command via pkexec synchronously.
// Returns { ok, exitCode, stdout, stderr }.
// ---------------------------------------------------------------------------
function runPkexecSync(argv) {
    const pkexecPath = GLib.find_program_in_path('pkexec');
    if (!pkexecPath) {
        return { ok: false, exitCode: -1, stdout: '', stderr: 'pkexec not found' };
    }
    return runCommandSync([pkexecPath, ...argv]);
}

// ---------------------------------------------------------------------------
// Indicator
// ---------------------------------------------------------------------------

const Indicator = GObject.registerClass(
    class Indicator extends PanelMenu.Button {
        _init() {
            super._init(0.0, _('NVMe Monitor'));

            // Panel icon — single NVMe outline icon.
            this._panelIcon = new St.Icon({
                icon_name: ICONS.PanelFallback,
                style_class: 'system-status-icon',
            });
            this.add_child(this._panelIcon);

            // Cached device icon (loaded in _setupIcon)
            this._deviceIcon = null;
            this._iconCache = {};
            // Cached NVMe device list (fetched once)
            this._cachedDevices = null;

            // ---------------------------------------------------------------
            // Menu structure:
            //   [device section]  ← dynamically rebuilt on menu open
            //   [separator]
            //   [NVMe Stack toggle]
            //   [separator]
            //   [Heartbeat toggle]
            // ---------------------------------------------------------------

            // Device info section — cleared and rebuilt on each refresh.
            this._devicesSection = new PopupMenuSection();
            this.menu.addMenuItem(this._devicesSection);

            this.menu.addMenuItem(new PopupSeparatorMenuItem());

            // ---------------------------------------------------------------
            // v2: NVMe Stack toggle (install/uninstall)
            // ---------------------------------------------------------------
            const v2Installed = isV2Installed();
            _log(`init: isV2Installed=${v2Installed}`);

            this._v2Updating = false;

            this._v2Toggle = new PopupSwitchMenuItem(_('NVMe Stack'), v2Installed);

            // If the stack is NOT installed and setup-polkit.sh is missing,
            // the user cannot install — disable the toggle entirely.
            // (check deferred to _checkSetupScript() called from enable())

            this._v2ToggleHandlerId = this._v2Toggle.connect('toggled', (item, state) => {
                _log(`toggled(state=${state}) _v2Updating=${this._v2Updating}`);
                if (this._v2Updating) return;
                this._v2Updating = true;

                if (state) {
                    this._installV2Stack();
                } else {
                    this._uninstallV2Stack();
                }
            });
            this.menu.addMenuItem(this._v2Toggle);

            // Separator
            this.menu.addMenuItem(new PopupSeparatorMenuItem());

            // Heartbeat toggle — OFF, disabled (debug placeholder)
            this._heartbeatToggle = new PopupSwitchMenuItem(_('Heartbeat'), false);
            this._heartbeatToggle.setSensitive(false);
            this._heartbeatToggle.connect('toggled', (item, state) => {
                _log(`Heartbeat toggled: ${state}`);
            });
            this.menu.addMenuItem(this._heartbeatToggle);

            // Refresh device data when the menu is opened.
            this._lastRefreshTime = 0;
            this._pollingTimer = null;
            this.menu.connect('open-state-changed', (menu, open) => {
                if (open) this._refreshDevices();
            });
        }

        // -------------------------------------------------------------------
        // Load the NVMe SVG icon for the panel (outline).
        // -------------------------------------------------------------------
        _setupIcon() {
            const panelIcon = this._loadIconByName(ICONS.NvmeDark)
                || this._loadIconByName(ICONS.Nvme);
            if (panelIcon) {
                this._panelIcon.set_gicon(panelIcon);
                _log(`Panel icon loaded: ${ICONS.NvmeDark}`);
            } else {
                _log(`Panel icon not found: ${ICONS.NvmeDark}`);
            }

            // Cache the device icon for menu headers.
            this._deviceIcon = panelIcon;
        }

        // -------------------------------------------------------------------
        // Start/stop the 5-second polling timer.
        // Only active when the polkit stack is installed.
        // -------------------------------------------------------------------
        _startPolling() {
            if (this._pollingTimer) return;
            this._pollingTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
                this._refreshDevices();
                return GLib.SOURCE_CONTINUE;
            });
            _log('Polling timer started (5s interval)');
        }

        _stopPolling() {
            if (this._pollingTimer) {
                GLib.source_remove(this._pollingTimer);
                this._pollingTimer = null;
                _log('Polling timer stopped');
            }
        }

        // -------------------------------------------------------------------
        // Check if setup-polkit.sh exists; disable toggle if not installed
        // and script is missing. Called from enable() after path is set.
        // -------------------------------------------------------------------
        _checkSetupScript() {
            if (isV2Installed()) return;
            const setupPath = GLib.build_filenamev([this._extensionPath || '', SETUP_SCRIPT_NAME]);
            if (!GLib.file_test(setupPath, GLib.FileTest.EXISTS)) {
                _log(`setup-polkit.sh missing — disabling toggle`);
                this._v2Toggle.setSensitive(false);
            }
        }

        // -------------------------------------------------------------------
        // Fetch NVMe device list once and cache it.
        // Returns the cached devices or null on failure.
        // -------------------------------------------------------------------
        _fetchAndCacheDevices() {
            if (this._cachedDevices !== null) {
                return this._cachedDevices;
            }

            const nvmeBin = GLib.find_program_in_path('nvme');
            if (!nvmeBin) {
                _log('nvme-cli not found');
                return null;
            }

            const listResult = runCommandSync([nvmeBin, 'list', '-o', 'json']);
            _log(`nvme list: ok=${listResult.ok} exitCode=${listResult.exitCode} stdout_len=${listResult.stdout?.length || 0} stderr_len=${listResult.stderr?.length || 0}`);
            if (!listResult.ok || listResult.exitCode !== 0) {
                _log('Failed to list NVMe devices');
                return null;
            }

            try {
                const parsed = JSON.parse(listResult.stdout);
                this._cachedDevices = parsed.Devices || [];
                _log(`nvme list: found ${this._cachedDevices.length} devices (cached)`);
                return this._cachedDevices;
            } catch (e) {
                _log(`nvme list: JSON parse error: ${e.message}`);
                _log(`nvme list: raw stdout: ${listResult.stdout?.substring(0, 200) || '(empty)'}`);
                _log(`nvme list: raw stderr: ${listResult.stderr?.substring(0, 200) || '(empty)'}`);
                return null;
            }
        }

        // -------------------------------------------------------------------
        // Collect NVMe devices and populate the device section.
        // Called on menu open and by the polling timer (every 5 seconds
        // when the polkit stack is installed).
        // -------------------------------------------------------------------
        _refreshDevices() {
            // Clear previous content.
            this._devicesSection.removeAll();

            // Load device icon (cached).
            if (!this._deviceIcon) {
                this._deviceIcon = this._loadIconByName(ICONS.Nvme);
            }

            // --- Step 1: get cached NVMe devices ---
            const devices = this._fetchAndCacheDevices();
            if (devices === null) {
                this._addInfoLine(_('nvme-cli not installed'));
                return;
            }

            if (devices.length === 0) {
                this._addInfoLine(_('No NVMe devices found'));
                return;
            }

            const v2Installed = isV2Installed();

            // --- Step 2: for each device, show info + SMART data ---

            for (let i = 0; i < devices.length; i++) {
                const dev = devices[i];

                if (i > 0) {
                    this._devicesSection.addMenuItem(new PopupSeparatorMenuItem());
                }

                // Device header: icon + bold model name
                this._addDeviceHeader(dev.ModelNumber || dev.DevicePath);

                // Device path + firmware (dimmed)
                this._addInfoLine(`${dev.DevicePath} — FW: ${dev.Firmware}`, 'nvme-device-meta');

                // SMART data (requires polkit stack)
                if (v2Installed) {
                    const smartResult = runPkexecSync([WRAPPER_PATH, dev.DevicePath]);
                    if (smartResult.ok && smartResult.exitCode === 0) {
                        try {
                            const smart = JSON.parse(smartResult.stdout);
                            this._addSmartInfo(smart);
                        } catch (e) {
                            this._addInfoLine(_('  SMART: parse error'));
                        }
                    } else {
                        this._addInfoLine(_('  SMART: unavailable'), 'nvme-smart-info');
                    }
                } else {
                    this._addInfoLine(_('  Install NVMe Stack for SMART data'), 'nvme-smart-info');
                }
            }
        }

        // -------------------------------------------------------------------
        // Add a device header line: icon + bold label, non-interactive.
        // -------------------------------------------------------------------
        _addDeviceHeader(modelName) {
            const header = new PopupBaseMenuItem({ reactive: false, can_focus: false });

            if (this._deviceIcon) {
                header.add_child(new St.Icon({
                    gicon: this._deviceIcon,
                    icon_size: 16,
                }));
            }

            const label = new St.Label({ text: modelName });
            label.set_x_expand(true);
            label.add_style_class_name('nvme-device-header');
            header.add_child(label);

            this._devicesSection.addMenuItem(header);
        }

        // -------------------------------------------------------------------
        // Load a bundled icon by name from icons/bootstrap/ as a GIcon.
        // Returns a cached Gio.FileIcon, or null if the file is missing.
        // `iconName` is the bare icon name (no extension), e.g.
        // ICONS.ThermometerLow, resolved to icons/bootstrap/thermometer-low.svg.
        // -------------------------------------------------------------------
        _loadIconByName(iconName) {
            if (!iconName) return null;
            if (iconName in this._iconCache) return this._iconCache[iconName];

            const iconPath = GLib.build_filenamev([
                this._extensionPath || '', ICONS_DIR, ICONS_BOOTSTRAP,
                `${iconName}${ICON_EXTENSION}`,
            ]);
            const gicon = fileIcon(iconPath);
            if (gicon === null) {
                _log(`icon not found: ${iconPath}`);
            }
            this._iconCache[iconName] = gicon;
            return gicon;
        }

        // -------------------------------------------------------------------
        // Build an St.Icon for a bundled icon name: GIcon when the bundled SVG
        // exists, falling back to icon_name (system theme) otherwise.
        // -------------------------------------------------------------------
        _createIcon(iconName, iconSize = 16, styleClass = 'nvme-info-icon') {
            const gicon = this._loadIconByName(iconName);
            return new St.Icon({
                gicon,
                icon_name: gicon ? null : iconName,
                icon_size: iconSize,
                style_class: styleClass,
            });
        }

        // -------------------------------------------------------------------
        // Add a non-interactive info line with optional icon.
        // -------------------------------------------------------------------
        _addInfoLine(text, styleClass = '', iconName = null) {
            const item = new PopupMenuItem(text);
            item.reactive = false;
            if (styleClass && item.label) {
                item.label.add_style_class_name(styleClass);
            }
            // Prepend icon if provided
            if (iconName) {
                const icon = this._createIcon(iconName);
                // Insert icon at the beginning of the item's children
                const children = item.get_children();
                if (children.length > 0) {
                    item.insert_child_at_index(icon, 0);
                    // Add spacing between icon and text
                    const spacer = new St.Label({ text: ' ', y_align: Clutter.ActorAlign.CENTER });
                    item.insert_child_at_index(spacer, 1);
                } else {
                    item.add_child(icon);
                }
            }
            this._devicesSection.addMenuItem(item);
        }

        // -------------------------------------------------------------------
        // Get thermometer icon based on temperature range.
        // ---------------------------------------------------------------------------
        _getThermometerIcon(tempCelsius) {
            if (tempCelsius === null || tempCelsius === undefined) {
                return null;
            }
            if (tempCelsius < 40) {
                return ICONS.ThermometerLow;
            } else if (tempCelsius < 60) {
                return ICONS.ThermometerHalf;
            } else {
                return ICONS.ThermometerHigh;
            }
        }

        // -------------------------------------------------------------------
        // Get temperature style class based on range.
        // ---------------------------------------------------------------------------
        _getTempStyle(tempCelsius) {
            if (tempCelsius === null || tempCelsius === undefined) {
                return 'nvme-smart-attr';
            }
            if (tempCelsius < 40) {
                return 'nvme-smart-attr';
            } else if (tempCelsius < 60) {
                return 'nvme-smart-warning-orange';
            } else {
                return 'nvme-smart-warning-red';
            }
        }

        // -------------------------------------------------------------------
        // Parse SMART JSON and add structured sections to the device section.
        // Uses the modular parser (BaseParser / SamsungParser).
        // -------------------------------------------------------------------
        _addSmartInfo(smartRaw) {
            const smart = parseSmart(smartRaw);
            const manuf = smart.manufacturer;

            // ---------------------------------------------------------------
            // Temperature Section
            // ---------------------------------------------------------------
            if (smart.temperature.composite !== null) {
                const icon = this._getThermometerIcon(smart.temperature.composite);
                const style = this._getTempStyle(smart.temperature.composite);

                if (manuf === 'Samsung' && smart.temperature.sensors.length >= 2) {
                    // Samsung: T_icon: yyy°C (controller: xxx ; NAND: zzz)
                    const sensor1 = smart.temperature.sensors[0] || '?';
                    const sensor2 = smart.temperature.sensors[1] || '?';
                    this._addInfoLine(
                        `${smart.temperature.composite}°C (controller: ${sensor1} ; NAND: ${sensor2})`,
                        style,
                        icon
                    );
                } else {
                    // Generic: T_icon: yyy°C
                    this._addInfoLine(
                        `${smart.temperature.composite}°C`,
                        style,
                        icon
                    );
                }

                // Additional sensors (if any, not Samsung or Samsung with >2 sensors)
                if (manuf !== 'Samsung' && smart.temperature.sensors.length > 0) {
                    for (let i = 0; i < smart.temperature.sensors.length; i++) {
                        const sensorTemp = smart.temperature.sensors[i];
                        const sensorIcon = this._getThermometerIcon(sensorTemp);
                        const sensorStyle = this._getTempStyle(sensorTemp);
                        this._addInfoLine(`  ${_('Sensor')} ${i + 1}: ${sensorTemp}°C`, sensorStyle, sensorIcon);
                    }
                }
            }

            // ---------------------------------------------------------------
            // Health Section
            // ---------------------------------------------------------------
            if (smart.health.availableSparePercent !== undefined) {
                this._addInfoLine(`  ${_('Available Spare')}: ${smart.health.availableSparePercent}%`, 'nvme-smart-attr');
            }
            if (smart.health.percentageUsed !== undefined) {
                this._addInfoLine(`  ${_('Percentage Used')}: ${smart.health.percentageUsed}%`, 'nvme-smart-attr');
            }

            // ---------------------------------------------------------------
            // Endurance Section
            // ---------------------------------------------------------------
            if (smart.endurance.powerCycles !== undefined) {
                this._addInfoLine(`  ${_('Power Cycles')}: ${smart.endurance.powerCycles}`, 'nvme-smart-attr');
            }
            if (smart.endurance.powerOnHours !== undefined) {
                this._addInfoLine(`  ${_('Power On Hours')}: ${smart.endurance.powerOnHours}h`, 'nvme-smart-attr');
            }
            if (smart.endurance.dataUnitsRead !== undefined) {
                this._addInfoLine(`  ${_('Data Read')}: ${smart.endurance.dataUnitsRead} units`, 'nvme-smart-attr');
            }
            if (smart.endurance.dataUnitsWritten !== undefined) {
                this._addInfoLine(`  ${_('Data Written')}: ${smart.endurance.dataUnitsWritten} units`, 'nvme-smart-attr');
            }
            if (smart.endurance.unsafeShutdowns !== undefined) {
                this._addInfoLine(`  ${_('Unsafe Shutdowns')}: ${smart.endurance.unsafeShutdowns}`, 'nvme-smart-attr');
            }

            // Samsung-specific: host reads/writes
            if (manuf === 'Samsung') {
                if (smart.endurance.hostReads !== undefined) {
                    this._addInfoLine(`  ${_('Host Reads')}: ${smart.endurance.hostReads}`, 'nvme-smart-attr');
                }
                if (smart.endurance.hostWrites !== undefined) {
                    this._addInfoLine(`  ${_('Host Writes')}: ${smart.endurance.hostWrites}`, 'nvme-smart-attr');
                }
            }

            // ---------------------------------------------------------------
            // Alerts Section
            // ---------------------------------------------------------------
            if (smart.alerts.mediaErrors !== undefined && smart.alerts.mediaErrors > 0) {
                this._addInfoLine(`  ${_('Media Errors')}: ${smart.alerts.mediaErrors}`, 'nvme-smart-warning');
            }
            if (smart.alerts.criticalWarning !== undefined && smart.alerts.criticalWarning !== 0) {
                this._addInfoLine(`  ${_('Critical Warning')}: ${smart.alerts.criticalWarning}`, 'nvme-smart-warning');
            }
        }

        // -------------------------------------------------------------------
        // v2: Toggle state helper — bypass setToggleState() entirely.
        // setToggleState() emits 'toggled' asynchronously, bypassing the
        // _v2Updating guard. Set the internal state + visual switch directly.
        // -------------------------------------------------------------------
        _updateV2ToggleState(active) {
            this._v2Toggle._state = active;
            if (this._v2Toggle._switch)
                this._v2Toggle._switch.state = active;
            _log(`_updateV2ToggleState(${active}) — state set directly, no signal emitted`);
        }

        // -------------------------------------------------------------------
        // v2: Install the new polkit stack via setup-polkit.sh
        // -------------------------------------------------------------------
        _installV2Stack() {
            const setupPath = GLib.build_filenamev([this._extensionPath || '', SETUP_SCRIPT_NAME]);
            _log(`_installV2Stack: setupPath=${setupPath}`);

            if (!GLib.file_test(setupPath, GLib.FileTest.EXISTS)) {
                _log(`setup-polkit.sh not found: ${setupPath}`);
                Main.notify(_('setup-polkit.sh not found. Place it in the extension directory.'));
                this._v2Toggle.setSensitive(false);
                this._v2Updating = false;
                return;
            }

            _log('Running pkexec setup-polkit.sh...');
            this._v2Toggle.setSensitive(false);

            const result = runPkexecSync([setupPath]);

            this._v2Toggle.setSensitive(true);

            if (result.stderr) _log(`stderr: ${result.stderr.trim()}`);
            if (result.stdout) _log(`stdout: ${result.stdout.trim()}`);

            if (result.ok && result.exitCode === 0) {
                _log('✓ Installation complete');
                logAndNotify(_('NVMe polkit stack installed!'), _('Please log out and back in for new group membership.'));
                this._updateV2ToggleState(true);
                this._startPolling();
            } else {
                _log(`✗ Installation failed (exit code ${result.exitCode})`);
                Main.notify(_('Installation failed (exit code ') + result.exitCode + ')');
                this._updateV2ToggleState(false);
            }

            this._v2Updating = false;
        }

        // -------------------------------------------------------------------
        // v2: Uninstall the polkit stack via nvme-smart-uninstall.sh
        // -------------------------------------------------------------------
        _uninstallV2Stack() {
            if (!isUninstallAvailable()) {
                _uninstallNotFoundCount++;
                _log(`Uninstall script not found. (count=${_uninstallNotFoundCount}/${KILL_THRESHOLD})`);

                if (_uninstallNotFoundCount >= KILL_THRESHOLD) {
                    _log(`⛔ Kill threshold reached (${KILL_THRESHOLD}). Disabling extension to break loop.`);
                    Main.notify(`NVMe Monitor: boucle détectée — extension désactivée.`);
                    try {
                        const dbus = Gio.DBus.session;
                        dbus.call_sync(
                            'org.gnome.Shell.Extensions',
                            '/org/gnome/Shell/Extensions',
                            'org.gnome.Shell.Extensions',
                            'DisableExtension',
                            new GLib.Variant('(s)', ['nvme-monitor@rloutrel.github.com']),
                            null,
                            Gio.DBusCallFlags.NONE,
                            -1,
                            null
                        );
                    } catch (e) {
                        _log(`Could not disable via D-Bus: ${e.message}`);
                    }
                    return;
                }

                Main.notify(_('Uninstall script not found.'));
                this._updateV2ToggleState(true);
                this._v2Updating = false;
                return;
            }

            _log('Running pkexec nvme-smart-uninstall.sh...');
            this._v2Toggle.setSensitive(false);

            const result = runPkexecSync([UNINSTALL_PATH]);

            this._v2Toggle.setSensitive(true);

            if (result.stderr) _log(`stderr: ${result.stderr.trim()}`);
            if (result.stdout) _log(`stdout: ${result.stdout.trim()}`);

            if (result.ok && result.exitCode === 0) {
                _log('✓ Uninstall complete');
                logAndNotify(_('NVMe polkit stack uninstalled.'), '');
                this._updateV2ToggleState(false);
                this._stopPolling();
            } else {
                _log(`✗ Uninstall failed (exit code ${result.exitCode})`);
                Main.notify(_('Uninstall failed (exit code ') + result.exitCode + ')');
                this._updateV2ToggleState(true);
            }

            this._v2Updating = false;
        }


        destroy() {
            this._stopPolling();
            super.destroy();
        }
    });

export default class IndicatorExampleExtension extends Extension {
    enable() {
        _log('enable() enter');
        this._indicator = new Indicator();
        this._indicator._extensionPath = this.path;
        this._indicator._setupIcon();
        this._indicator._checkSetupScript();
        // Start polling if the polkit stack is already installed.
        if (isV2Installed()) {
            this._indicator._startPolling();
        }
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        // Load extension stylesheet (device header, meta lines, smart values)
        this._stylesheet = Gio.File.new_for_path(GLib.build_filenamev([this.path, 'stylesheet.css']));
        St.ThemeContext.get_for_stage(global.stage).get_theme().load_stylesheet(this._stylesheet);
        _log('enable() exit');
    }

    disable() {
        _log('disable() enter');
        if (this._stylesheet) {
            St.ThemeContext.get_for_stage(global.stage).get_theme().unload_stylesheet(this._stylesheet);
            this._stylesheet = null;
        }
        if (this._indicator) {
            this._indicator.destroy();
        }
        this._indicator = null;
        _log('disable() exit');
    }
}
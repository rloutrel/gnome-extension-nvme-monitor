import GObject from 'gi://GObject';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Import Switch from GNOME Shell UI - using synchronous import
let Switch = null;
try {
    // In GNOME Shell, Switch is available from the internal modules
    Switch = imports.ui.switch.Switch;
} catch (e) {
    try {
        // Try alternative path
        Switch = imports.misc.switch.Switch;
    } catch (e2) {
        try {
            Switch = new Gtk.Switch();
            Switch.connect("state-set", (sw, state) => {
                console.log("Nouvel état :", state);
            });
        } catch (e2) {
            console.log('[explore-ui] Shell Switch module not found, falling back to text toggles');
        }
    }
}

function logAndNotify(message) {
    console.log(`[explore-ui] ${message}`);
    Main.notify(message);
}

const POLKIT_POLICY_CONTENT = '<?xml version="1.0" encoding="UTF-8"?>\n' +
'<!DOCTYPE policyconfig PUBLIC\n' +
'  "-//freedesktop//DTD PolicyKit Policy Configuration 1.0//EN"\n' +
'  "http://www.freedesktop.org/standards/PolicyKit/1/policyconfig.dtd">\n' +
'<policyconfig>\n' +
'\n' +
'  <action id="com.custom.extension.nvme">\n' +
'    <description>Access NVMe information</description>\n' +
'    <message>Access NVMe drive information</message>\n' +
'    <defaults>\n' +
'      <allow_any>auth_admin_keep</allow_any>\n' +
'      <allow_inactive>auth_admin_keep</allow_inactive>\n' +
'      <allow_active>auth_admin_keep</allow_active>\n' +
'    </defaults>\n' +
'    <annotate key="org.freedesktop.policykit.exec.path">/usr/bin/nvme</annotate>\n' +
'  </action>\n' +
'\n' +
'  <action id="com.custom.extension.whoami">\n' +
'    <description>Get root user identity</description>\n' +
'    <message>Get root user identity</message>\n' +
'    <defaults>\n' +
'      <allow_any>auth_admin_keep</allow_any>\n' +
'      <allow_inactive>auth_admin_keep</allow_inactive>\n' +
'      <allow_active>auth_admin_keep</allow_active>\n' +
'    </defaults>\n' +
'    <annotate key="org.freedesktop.policykit.exec.path">/usr/bin/whoami</annotate>\n' +
'  </action>\n' +
'\n' +
'</policyconfig>';

function isPolicyInstalled() {
    const policyFilePath = '/usr/share/polkit-1/actions/com.custom.extension.policy';
    return GLib.file_test(policyFilePath, GLib.FileTest.EXISTS);
}

const Indicator = GObject.registerClass(
    class Indicator extends PanelMenu.Button {
        _init() {
            super._init(0.0, _('My Shiny Indicator'));

            this.add_child(new St.Icon({
                icon_name: 'face-smile-symbolic',
                style_class: 'system-status-icon',
            }));

            // NVMe devices - fetched once
            this._nvmeDevices = [];
            this._fetchNVMeDevices();

            // Temperature display as menu item (below activation button)
            this._tempMenuItem = new PopupMenu.PopupMenuItem(_('NVMe: Loading...'));
            this._tempMenuItem.label_actor.set_style('font-weight: bold;');
            this.menu.addMenuItem(this._tempMenuItem);

            // Polkit Policy toggle - use Switch if available
            this._useShellSwitch = !!Switch;
            
            if (this._useShellSwitch) {
                const policyInstalled = isPolicyInstalled();
                this._polkitToggle = new PopupMenu.PopupMenuItem(_('Polkit Policy'));
                this._polkitSwitch = new Switch({ active: policyInstalled, halign: Clutter.ActorAlign.END });
                this._polkitToggle.add_child(this._polkitSwitch);
                this._polkitSwitch.connect('state-set', (sw, state) => {
                    if (state) {
                        this._installPolkitPolicy();
                    } else {
                        this._removePolkitPolicy();
                    }
                    return true;
                });
                this.menu.addMenuItem(this._polkitToggle);
                
                this._refreshToggle = new PopupMenu.PopupMenuItem(_('Auto-Refresh (5s)'));
                this._refreshSwitch = new Switch({ active: false, halign: Clutter.ActorAlign.END, sensitive: policyInstalled });
                this._refreshToggle.add_child(this._refreshSwitch);
                this._refreshSwitch.connect('state-set', (sw, state) => {
                    if (state) {
                        this._startTemperaturePolling();
                    } else {
                        this._stopTemperaturePolling();
                    }
                    return true;
                });
                this.menu.addMenuItem(this._refreshToggle);
            } else {
                // Fallback to text toggles
                const policyInstalled = isPolicyInstalled();
                this._polkitToggle = new PopupMenu.PopupMenuItem(policyInstalled ? _('Polkit Policy: ON') : _('Polkit Policy: OFF'));
                this._polkitToggle.connect('activate', () => {
                    if (isPolicyInstalled()) {
                        this._removePolkitPolicy();
                    } else {
                        this._installPolkitPolicy();
                    }
                });
                this.menu.addMenuItem(this._polkitToggle);
                
                this._refreshToggle = new PopupMenu.PopupMenuItem(_('Auto-Refresh (5s): OFF'));
                this._refreshToggle.setSensitive(policyInstalled);
                this._refreshToggle.connect('activate', () => {
                    if (this._tempPollId) {
                        this._stopTemperaturePolling();
                        this._refreshToggle.label_actor.set_text(_('Auto-Refresh (5s): OFF'));
                    } else {
                        this._startTemperaturePolling();
                        this._refreshToggle.label_actor.set_text(_('Auto-Refresh (5s): ON'));
                    }
                });
                this.menu.addMenuItem(this._refreshToggle);
            }

            // Don't auto-start temperature polling - user must toggle Auto-Refresh ON
            // this._startTemperaturePolling();

            // Separator
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }

        _updatePolkitToggleState(active) {
            if (this._useShellSwitch) {
                this._polkitSwitch.setActive(active);
                this._refreshSwitch.setSensitive(active);
            } else {
                this._polkitToggle.label_actor.set_text(active ? _('Polkit Policy: ON') : _('Polkit Policy: OFF'));
                this._refreshToggle.setSensitive(active);
            }
        }

        _updateRefreshToggleState(active) {
            if (this._useShellSwitch) {
                this._refreshSwitch.setActive(active);
            } else {
                this._refreshToggle.label_actor.set_text(active ? _('Auto-Refresh (5s): ON') : _('Auto-Refresh (5s): OFF'));
            }
        }

        _installPolkitPolicy() {
            try {
                const policyFilePath = '/usr/share/polkit-1/actions/com.custom.extension.policy';
                
                // Create a temporary file with the policy content
                const tmpDir = GLib.get_tmp_dir();
                const tmpFilePath = `${tmpDir}/com.custom.extension.policy`;
                
                // Write to temp file
                const writeTmpSuccess = GLib.file_set_contents(tmpFilePath, POLKIT_POLICY_CONTENT);
                
                if (!writeTmpSuccess) {
                    logAndNotify(_('Failed to create temp file in /tmp'));
                    return;
                }
                
                // Copy to system location with pkexec
                const copyCmd = `pkexec cp ${tmpFilePath} ${policyFilePath}`;
                const [copySuccess, , copyStderr] = GLib.spawn_command_line_sync(copyCmd);
                
                if (!copySuccess) {
                    logAndNotify(_('Failed to copy policy: ') + new TextDecoder().decode(copyStderr));
                    GLib.unlink(tmpFilePath);
                    return;
                }
                
                // Clean up temp file
                GLib.unlink(tmpFilePath);
                
                // Restart polkit
                const restartCmd = 'pkexec systemctl restart polkit';
                const [restartSuccess, , restartStderr] = GLib.spawn_command_line_sync(restartCmd);
                
                if (!restartSuccess) {
                    logAndNotify(_('Failed to restart polkit: ') + new TextDecoder().decode(restartStderr));
                    return;
                }
                
                logAndNotify(_('Polkit policy installed successfully!\nAuthentication prompts should now remember for 5-10 minutes.'));
                
                // Update toggle states
                this._updatePolkitToggleState(true);
                // Don't auto-start polling - user must toggle Auto-Refresh
                // this._startTemperaturePolling();
                
            } catch (e) {
                logAndNotify(_('Error: ') + e.message);
            }
        }

        _removePolkitPolicy() {
            try {
                const policyFilePath = '/usr/share/polkit-1/actions/com.custom.extension.policy';
                
                if (!isPolicyInstalled()) {
                    logAndNotify(_('Polkit policy is not installed.'));
                    return;
                }
                
                // Remove policy file with pkexec
                const removeCmd = `pkexec rm ${policyFilePath}`;
                const [removeSuccess, , removeStderr] = GLib.spawn_command_line_sync(removeCmd);
                
                if (!removeSuccess) {
                    logAndNotify(_('Failed to remove policy: ') + new TextDecoder().decode(removeStderr));
                    return;
                }
                
                // Restart polkit
                const restartCmd = 'pkexec systemctl restart polkit';
                const [restartSuccess, , restartStderr] = GLib.spawn_command_line_sync(restartCmd);
                
                if (!restartSuccess) {
                    logAndNotify(_('Failed to restart polkit: ') + new TextDecoder().decode(restartStderr));
                    return;
                }
                
                logAndNotify(_('Polkit policy removed successfully!\nAuthentication prompts will return to default behavior.'));
                
                // Update toggle states
                this._updatePolkitToggleState(false);
                this._updateRefreshToggleState(false);
                // Stop polling
                this._stopTemperaturePolling();
                this._tempMenuItem.label_actor.set_text(_('NVMe: Polkit required'));
                
            } catch (e) {
                logAndNotify(_('Error: ') + e.message);
            }
        }

        _startTemperaturePolling() {
            if (this._tempPollId) {
                GLib.source_remove(this._tempPollId);
            }
            const pkexecPath = GLib.find_program_in_path('pkexec');
            if (pkexecPath && isPolicyInstalled()) {
                this._tempPollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
                    this._pollTemperatures();
                    return GLib.SOURCE_CONTINUE;
                });
                this._tempMenuItem.label_actor.set_text(_('NVMe: Loading...'));
                this._pollTemperatures(); // Immediate first read
                this._updateRefreshToggleState(true);
            } else {
                this._tempMenuItem.label_actor.set_text(_('NVMe: Polkit required'));
            }
        }

        _stopTemperaturePolling() {
            if (this._tempPollId) {
                GLib.source_remove(this._tempPollId);
                this._tempPollId = null;
            }
            this._updateRefreshToggleState(false);
        }

        _fetchNVMeDevices() {
            try {
                // Get device list with JSON output to get model names
                const [success, listOutput, stderr] = GLib.spawn_command_line_sync('nvme list -o json');
                if (!success) {
                    console.log(`[explore-ui] Error getting NVMe list: ${new TextDecoder().decode(stderr)}`);
                    this._tempMenuItem.label_actor.set_text(_('NVMe: Error'));
                    return;
                }

                const listData = JSON.parse(new TextDecoder().decode(listOutput));
                this._nvmeDevices = [];
                
                if (listData.Devices && Array.isArray(listData.Devices)) {
                    for (const device of listData.Devices) {
                        this._nvmeDevices.push({
                            path: device.DevicePath,
                            model: device.ModelNumber || _('Unknown')
                        });
                    }
                }

                if (this._nvmeDevices.length === 0) {
                    this._tempMenuItem.label_actor.set_text(_('NVMe: No devices'));
                }
            } catch (e) {
                console.log(`[explore-ui] Error: ${e.message}`);
                this._tempMenuItem.label_actor.set_text(_('NVMe: Error'));
            }
        }

        _pollTemperatures() {
            if (this._nvmeDevices.length === 0) return;

            let results = [];
            for (const device of this._nvmeDevices) {
                try {
                    const [smartSuccess, smartOutput, smartStderr] = GLib.spawn_command_line_sync(`pkexec nvme smart-log ${device.path} -o json`);
                    
                    if (smartSuccess) {
                        const smartData = JSON.parse(new TextDecoder().decode(smartOutput));
                        
                        // Extract main temperature and all sensors
                        let mainTemp = null;
                        let allTemps = [];
                        for (const [key, value] of Object.entries(smartData)) {
                            if (key.startsWith('temperature') && typeof value === 'number') {
                                const tempC = Math.round((value - 273.15) * 10) / 10;
                                if (key === 'temperature') {
                                    mainTemp = tempC;
                                }
                                else {
                                    allTemps.push(tempC);
                                }
                            }
                        }
                        
                        if (mainTemp !== null) {
                            // Format: ModelName: main_temp (sensor1,sensor2,...)
                            const sensorsCsv = allTemps.join(',');
                            results.push(`${device.model}: ${mainTemp}\u00b0C (${sensorsCsv})`);
                        }
                    } else {
                        results.push(`${device.model}: Error`);
                    }
                } catch (e) {
                    results.push(`${device.model}: Error`);
                }
            }

            if (results.length > 0) {
                this._tempMenuItem.label_actor.set_text(results.join('\n'));
            }
        }
    });

export default class IndicatorExampleExtension extends Extension {
    enable() {
        this._indicator = new Indicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        if (this._indicator) {
            this._indicator._stopTemperaturePolling();
        }
        this._indicator.destroy();
        this._indicator = null;
    }
}

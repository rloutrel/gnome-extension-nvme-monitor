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
// Import endurance value formatting (pure, unit-tested)
import { formatCompactNumber, formatDataUnits, formatPowerOnHours, spareGaugeColor, usedGaugeColor, COLOR_TRACK } from './format.js';
// Import temperature line formatting (pure, unit-tested)
import { formatTemperatureLine, formatSensorRows } from './tempFormat.js';
// Import nvme-cli version detection (pure, unit-tested)
import {
    parseNvmeVersion,
    assessNvmeCliVersion,
    FORMAT_CHANGE_ISSUE_URL,
} from './versionUtils.js';
// Import device-list normalization for both flat and nested JSON layouts (pure)
import { normalizeDeviceList } from './deviceList.js';

// ---------------------------------------------------------------------------
// Unified logger + simple loop detector.
//

const LOG_PREFIX = '[NVMe-monitor]';

// Global fail counter — incremented each time "Uninstall script not found"
// is reached.  When it reaches KILL_THRESHOLD, the extension disables itself
// to break the infinite toggle loop.
const KILL_THRESHOLD = 4;
let _uninstallNotFoundCount = 0;

// Logging helpers conforming to the GJS debugging guide:
// https://gjs.guide/extensions/development/debugging.html#logging
//   console.debug()  → dev-only info (GLib.LogLevelFlags.LEVEL_DEBUG)
//   console.warn()   → unexpected errors, possible bugs (LEVEL_WARNING)
//   console.error()  → programmer errors, failures (LEVEL_CRITICAL)
function _debug(message) {
    console.debug(`${LOG_PREFIX} ${message}`);
}

function _warn(message) {
    console.warn(`${LOG_PREFIX} ${message}`);
}

function _error(message) {
    console.error(`${LOG_PREFIX} ${message}`);
}

function notify(title, body = '') {
    if (body) _debug(`${title} — ${body}`);
    else _debug(title);
    Main.notify(title, body);
}

function notifyError(title, body = '') {
    _warn(`${title}${body ? ' — ' + body : ''}`);
    Main.notify(title, body);
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

// Leading section icons (plug, database, thermometer, device header) are
// rendered larger than the per-value inline icons.
const SECTION_ICON_SIZE = 22;
const VALUE_ICON_SIZE = 16;

// Temperature thresholds (°C) for the heuristic green/orange tiers.
// The red tier is driven by the drive's own critical_warning signal, not a
// guessed °C value (see CRITICAL_WARNING_TEMP). 70°C aligns with where most
// consumer NVMe drives begin thermal throttling.
const TEMP_WARM_C = 50;
const TEMP_HOT_C = 70;

// NVMe SMART critical_warning bitmap (Log Page 02h). Bit 1 signals the
// controller's configured temperature threshold was exceeded — the
// manufacturer-true over-temperature signal.
const CRITICAL_WARNING_TEMP = 0x02;

// Bundled SVG icons (shipped in icons/bootstrap/) referenced by bare name.
// System fallback (not bundled) for the panel placeholder.
const ICONS = Object.freeze({
    NvmeDark: 'nvme-dark',
    Nvme: 'nvme',
    ThermometerLow: 'thermometer-low',
    ThermometerHalf: 'thermometer-half',
    ThermometerHigh: 'thermometer-high',
    Plug: 'plugin',
    Database: 'database',
    ArrowLeftRight: 'arrow-left-right',
    Eyeglasses: 'eyeglasses',
    VectorPen: 'vector-pen',
    PanelFallback: 'drive-harddisk-symbolic',
});

// Build a Gio.FileIcon from an absolute path, or null if the file is missing.
function fileIcon(iconPath) {
    if (!GLib.file_test(iconPath, GLib.FileTest.EXISTS)) return null;
    return new Gio.FileIcon({ file: Gio.File.new_for_path(iconPath) });
}

// Detect the installed nvme-cli version once and warn the user if it is
// affected by a known `nvme list -o json` software bug.  Called from
// enable() after the binary is located.
function _checkNvmeCliVersion(nvmeBin) {
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
            //   [Service Setup toggle]
            //   [separator]
            //   [device section]  ← dynamically rebuilt on menu open
            // ---------------------------------------------------------------

            // ---------------------------------------------------------------
            // v2: NVMe Stack toggle (install/uninstall)
            // ---------------------------------------------------------------
            const v2Installed = isV2Installed();
            _debug(`init: isV2Installed=${v2Installed}`);

            this._v2Updating = false;

            this._v2Toggle = new PopupSwitchMenuItem(_('Service Setup'), v2Installed);

            // If the stack is NOT installed and setup-polkit.sh is missing,
            // the user cannot install — disable the toggle entirely.
            // (check deferred to _checkSetupScript() called from enable())

            this._v2ToggleHandlerId = this._v2Toggle.connect('toggled', (item, state) => {
                _debug(`toggled(state=${state}) _v2Updating=${this._v2Updating}`);
                if (this._v2Updating) return;
                this._v2Updating = true;

                if (state) {
                    this._installV2Stack();
                } else {
                    this._uninstallV2Stack();
                }
            });
            this.menu.addMenuItem(this._v2Toggle);

            this.menu.addMenuItem(new PopupSeparatorMenuItem());

            // Device info section — cleared and rebuilt on each refresh.
            this._devicesSection = new PopupMenuSection();
            this.menu.addMenuItem(this._devicesSection);

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
                _debug(`Panel icon loaded: ${ICONS.NvmeDark}`);
            } else {
                _warn(`Panel icon not found: ${ICONS.NvmeDark}`);
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
            _debug('Polling timer started (5s interval)');
        }

        _stopPolling() {
            if (this._pollingTimer) {
                GLib.source_remove(this._pollingTimer);
                this._pollingTimer = null;
                _debug('Polling timer stopped');
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
                _warn('setup-polkit.sh missing — disabling toggle');
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
                _warn('nvme-cli not found');
                return null;
            }

            const listResult = runCommandSync([nvmeBin, 'list', '-o', 'json']);
            _debug(`nvme list: ok=${listResult.ok} exitCode=${listResult.exitCode} stdout_len=${listResult.stdout?.length || 0} stderr_len=${listResult.stderr?.length || 0}`);
            if (!listResult.ok || listResult.exitCode !== 0) {
                _warn('Failed to list NVMe devices');
                return null;
            }

            try {
                const parsed = JSON.parse(listResult.stdout);
                this._cachedDevices = normalizeDeviceList(parsed);
                _debug(`nvme list: found ${this._cachedDevices.length} devices (cached)`);
                return this._cachedDevices;
            } catch (e) {
                _warn(`nvme list: JSON parse error: ${e.message}`);
                _debug(`nvme list: raw stdout: ${listResult.stdout?.substring(0, 200) || '(empty)'}`);
                _debug(`nvme list: raw stderr: ${listResult.stderr?.substring(0, 200) || '(empty)'}`);
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

                // SMART data (requires polkit stack). Fetched first so the
                // health gauges (if any) can be placed on the meta line.
                let smartObj = null;
                let smartParseError = false;
                if (v2Installed) {
                    const smartResult = runPkexecSync([WRAPPER_PATH, dev.DevicePath]);
                    if (smartResult.ok && smartResult.exitCode === 0) {
                        try {
                            smartObj = JSON.parse(smartResult.stdout);
                        } catch {
                            smartParseError = true;
                        }
                    }
                }

                // Extract health gauges from the parsed SMART object.
                let healthGauges = null;
                if (smartObj) {
                    const smart = parseSmart(smartObj, dev.ModelNumber);
                    const gauges = [];
                    if (smart.health.availableSparePercent !== undefined) {
                        const pct = smart.health.availableSparePercent;
                        gauges.push({
                            label: _('Available Spare'),
                            percent: pct,
                            color: spareGaugeColor(pct),
                            title: _('Available Spare'),
                            body: _('Reserved capacity the drive can swap in to replace failing blocks. ' +
                                   'Red below 15%, orange below 50%, green otherwise.'),
                        });
                    }
                    if (smart.health.percentageUsed !== undefined) {
                        const pct = smart.health.percentageUsed;
                        gauges.push({
                            label: _('Percentage Used'),
                            percent: pct,
                            color: usedGaugeColor(pct),
                            title: _('Percentage Used'),
                            body: _('Estimated portion of the drive endurance consumed. ' +
                                   'Green below 50%, orange up to 85%, red above (inverted logic).'),
                        });
                    }
                    if (gauges.length > 0) healthGauges = gauges;
                }

                // Device path + firmware (dimmed), with the health gauges on
                // the right half of the line when available.
                this._addDeviceMeta(dev.DevicePath, dev.Firmware, healthGauges);

                if (v2Installed) {
                    if (smartParseError) {
                        this._addInfoLine(_('  SMART: parse error'));
                    } else if (smartObj) {
                        this._addSmartInfo(smartObj, dev.ModelNumber);
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
                    icon_size: SECTION_ICON_SIZE,
                }));
            }

            const label = new St.Label({ text: modelName });
            label.set_x_expand(true);
            label.add_style_class_name('nvme-device-header');
            header.add_child(label);

            this._devicesSection.addMenuItem(header);
        }

        // -------------------------------------------------------------------
        // Add the device meta line: path + firmware (left, dimmed) with the
        // health gauges (if any) on the right half. Each gauge is rendered
        // as a label followed by the camembert diagram; the percent value is
        // revealed on hover, not shown inline.
        // -------------------------------------------------------------------
        _addDeviceMeta(devicePath, firmware, gauges = null) {
            const item = new PopupBaseMenuItem({ reactive: false, can_focus: false });

            const meta = new St.Label({ text: `${devicePath} \u2014 FW: ${firmware}`, x_expand: true });
            meta.add_style_class_name('nvme-device-meta');
            meta.y_align = Clutter.ActorAlign.CENTER;
            item.add_child(meta);

            if (gauges && gauges.length > 0) {
                const right = new St.BoxLayout({
                    vertical: true,
                    x_expand: true,
                    x_align: Clutter.ActorAlign.END,
                    y_align: Clutter.ActorAlign.CENTER,
                    style_class: 'nvme-gauge-stack',
                });
                for (const g of gauges) {
                    right.add_child(this._gaugeSegment(g));
                }
                item.add_child(right);
            }

            this._devicesSection.addMenuItem(item);
        }

        // -------------------------------------------------------------------
        // Build a single gauge segment: a label followed by the camembert
        // diagram. The percent value is revealed on hover.
        // -------------------------------------------------------------------
        _gaugeSegment(g) {
            const box = new St.BoxLayout({ x_align: Clutter.ActorAlign.END, style_class: 'nvme-gauge-segment' });

            const label = new St.Label({ text: g.label, y_align: Clutter.ActorAlign.CENTER });
            label.add_style_class_name('nvme-smart-attr');
            label.reactive = true;
            this._attachHoverTooltip(label, `${g.label}: ${g.percent}%`);
            label.connect('button-press-event', () => {
                this._showExplanationOverlay(label, g.title, g.body);
                return Clutter.EVENT_STOP;
            });
            box.add_child(label);

            const gauge = this._createGauge(
                g.percent, g.color, 22, g.title, g.body, `${g.label}: ${g.percent}%`);
            box.add_child(gauge);

            return box;
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
                _warn(`icon not found: ${iconPath}`);
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
            // Prepend section icon (larger) if provided
            if (iconName) {
                const icon = this._createIcon(iconName, SECTION_ICON_SIZE);
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
        // Attach a custom hover tooltip to an actor. GNOME 50/51 St.Widget has
        // no native tooltip API, so this connects enter/leave/destroy events
        // and shows a transient St.Label in Main.uiGroup near the actor.
        // `text` is the raw value revealed on hover. Handlers are stored on the
        // actor for cleanup.
        // -------------------------------------------------------------------
        _attachHoverTooltip(actor, text) {
            if (!actor) return;
            actor._nvmeTooltipText = text;
            actor._nvmeTooltip = null;

            const _showTooltip = (a) => {
                if (a._nvmeTooltip || !a._nvmeTooltipText) return;
                const label = new St.Label({
                    text: a._nvmeTooltipText,
                    style_class: 'nvme-hover-tooltip',
                });
                Main.uiGroup.add_child(label);
                a._nvmeTooltip = label;

                const [stageX, stageY] = a.get_transformed_position();
                const [, h] = a.get_size();
                // Position below the actor, left-aligned to its left edge.
                let x = Math.round(stageX);
                let y = Math.round(stageY + h + 6);
                // Keep the tooltip on the current monitor.
                const idx = Main.layoutManager.find_index_for_actor(a);
                const area = Main.layoutManager.monitors[idx];
                if (area) {
                    const [, natWidth] = label.get_preferred_width(-1);
                    x = Math.max(area.x, Math.min(x, area.x + area.width - natWidth));
                    if (y + 40 > area.y + area.height) {
                        y = Math.round(stageY) - 6 - 24;
                    }
                }
                label.set_position(x, y);
            };

            const _hideTooltip = (a) => {
                if (a._nvmeTooltip) {
                    a._nvmeTooltip.destroy();
                    a._nvmeTooltip = null;
                }
            };

            const enterId = actor.connect('enter-event', () => _showTooltip(actor));
            const leaveId = actor.connect('leave-event', () => _hideTooltip(actor));
            const destroyId = actor.connect('destroy', () => _hideTooltip(actor));
            actor._nvmeTooltipHandlers = [enterId, leaveId, destroyId];
        }

        // -------------------------------------------------------------------
        // Add a non-interactive line of icon+value segments, each with a
        // hover tooltip revealing the raw value. Segments are grouped into
        // sections by `sectionIcon`; the line width is distributed evenly
        // across the sections, and within a section the subsections (icon +
        // value pairs) are laid out. Each segment is
        // { iconName, value, tooltip?, sectionIcon? }.
        // -------------------------------------------------------------------
        _addMetricSegmentsLine(segments, styleClass = 'nvme-smart-attr') {
            if (!segments || segments.length === 0) return;

            // Group segments into consecutive sections. A segment starts a
            // new section when it carries a `sectionIcon`.
            const sections = [];
            for (const seg of segments) {
                if (seg.sectionIcon || sections.length === 0) {
                    sections.push({ sectionIcon: seg.sectionIcon || null, items: [seg] });
                } else {
                    sections[sections.length - 1].items.push(seg);
                }
            }

            const item = new PopupBaseMenuItem({ reactive: false, can_focus: false });

            for (let s = 0; s < sections.length; s++) {
                const section = sections[s];
                const box = new St.BoxLayout({ x_expand: true, x_align: Clutter.ActorAlign.START });

                if (section.sectionIcon) {
                    box.add_child(this._createIcon(section.sectionIcon, SECTION_ICON_SIZE, 'nvme-metric-section-icon'));
                }

                const subBox = new St.BoxLayout({ x_expand: true, x_align: Clutter.ActorAlign.CENTER, style_class: 'nvme-metric-section' });
                box.add_child(subBox);

                for (let i = 0; i < section.items.length; i++) {
                    const seg = section.items[i];

                    const iconActor = this._createIcon(seg.iconName, VALUE_ICON_SIZE, 'nvme-info-icon');
                    if (seg.tooltip) {
                        iconActor.reactive = true;
                        this._attachHoverTooltip(iconActor, seg.tooltip);
                    }
                    subBox.add_child(iconActor);

                    const valueLabel = new St.Label({ text: seg.value, x_expand: true });
                    valueLabel.add_style_class_name(styleClass);
                    valueLabel.y_align = Clutter.ActorAlign.CENTER;
                    if (seg.tooltip) {
                        valueLabel.reactive = true;
                        this._attachHoverTooltip(valueLabel, seg.tooltip);
                    }
                    subBox.add_child(valueLabel);
                }

                item.add_child(box);
            }

            this._devicesSection.addMenuItem(item);
        }

        // -------------------------------------------------------------------
        // Get thermometer icon for a temperature reading.
        // The red tier is driven by the drive's critical_warning bit 1
        // (controller-configured threshold exceeded), not a guessed °C value.
        // `criticalWarning` is the raw NVMe SMART critical_warning byte.
        // ---------------------------------------------------------------------------
        _getThermometerIcon(tempCelsius, criticalWarning) {
            if (tempCelsius === null || tempCelsius === undefined) {
                return null;
            }
            if (criticalWarning & CRITICAL_WARNING_TEMP) {
                return ICONS.ThermometerHigh;
            }
            if (tempCelsius < TEMP_WARM_C) {
                return ICONS.ThermometerLow;
            } else if (tempCelsius < TEMP_HOT_C) {
                return ICONS.ThermometerHalf;
            } else {
                return ICONS.ThermometerHigh;
            }
        }

        // -------------------------------------------------------------------
        // Get temperature style class. Red when the drive signals an
        // over-threshold condition (critical_warning bit 1); otherwise the
        // green/orange heuristic tiers.
        // ---------------------------------------------------------------------------
        _getTempStyle(tempCelsius, criticalWarning) {
            if (tempCelsius === null || tempCelsius === undefined) {
                return 'nvme-smart-attr';
            }
            if (criticalWarning & CRITICAL_WARNING_TEMP) {
                return 'nvme-smart-warning-red';
            }
            if (tempCelsius < TEMP_WARM_C) {
                return 'nvme-smart-attr';
            } else if (tempCelsius < TEMP_HOT_C) {
                return 'nvme-smart-warning-orange';
            } else {
                return 'nvme-smart-warning-red';
            }
        }

        // -------------------------------------------------------------------
        // Show a click-triggered explanation overlay near `actor`. It is a
        // transient St.BoxLayout (title + body) in Main.uiGroup, dismissed
        // by the next pointer click anywhere on the stage.
        // -------------------------------------------------------------------
        _showExplanationOverlay(actor, title, body) {
            this._hideExplanationOverlay();

            const box = new St.BoxLayout({
                vertical: true,
                style_class: 'nvme-explain-overlay',
                x_expand: false,
            });
            const titleLabel = new St.Label({ text: title, style_class: 'nvme-explain-title' });
            titleLabel.clutter_text.line_wrap = true;
            const bodyLabel = new St.Label({ text: body, style_class: 'nvme-explain-body' });
            bodyLabel.clutter_text.line_wrap = true;
            box.add_child(titleLabel);
            box.add_child(bodyLabel);

            Main.uiGroup.add_child(box);
            this._explainOverlay = box;

            const [stageX, stageY] = actor.get_transformed_position();
            const [, h] = actor.get_size();
            let x = Math.round(stageX);
            let y = Math.round(stageY + h + 6);
            const idx = Main.layoutManager.find_index_for_actor(actor);
            const area = Main.layoutManager.monitors[idx];
            if (area) {
                const [, natWidth] = box.get_preferred_width(-1);
                const [, natHeight] = box.get_preferred_height(-1);
                x = Math.max(area.x, Math.min(x, area.x + area.width - natWidth));
                if (y + natHeight > area.y + area.height) {
                    y = Math.round(stageY) - 6 - natHeight;
                }
            }
            box.set_position(x, y);

            this._explainClickId = global.stage.connect('button-press-event', () => {
                this._hideExplanationOverlay();
                return Clutter.EVENT_PROPAGATE;
            });
        }

        _hideExplanationOverlay() {
            if (this._explainClickId) {
                global.stage.disconnect(this._explainClickId);
                this._explainClickId = null;
            }
            if (this._explainOverlay) {
                this._explainOverlay.destroy();
                this._explainOverlay = null;
            }
        }

        // -------------------------------------------------------------------
        // Build a circular "camembert" gauge: a pie whose filled arc is
        // `percent` of a full circle, colored by `color` ([r,g,b]). The rest
        // of the ring uses the dim track color, and the whole circle gets a
        // thin black outline. Hovering reveals `tooltipText` (the percent);
        // clicking shows an explanation overlay (title/body).
        // -------------------------------------------------------------------
        _createGauge(percent, color, size, title, body, tooltipText = null) {
            const area = new St.DrawingArea({
                width: size,
                height: size,
                reactive: true,
                can_focus: true,
                track_hover: true,
            });
            area._gaugePercent = Math.max(0, Math.min(100, Number(percent) || 0));
            area._gaugeColor = color;

            area.connect('repaint', (a) => {
                const cr = a.get_context();
                const [w, h] = a.get_surface_size();
                const cx = w / 2;
                const cy = h / 2;
                const r = Math.min(w, h) / 2 - 1;

                // Track (full ring background).
                cr.setSourceRGB(COLOR_TRACK[0], COLOR_TRACK[1], COLOR_TRACK[2]);
                cr.arc(cx, cy, r, 0, 2 * Math.PI);
                cr.fill();

                // Filled arc.
                const p = a._gaugePercent / 100;
                if (p > 0) {
                    cr.setSourceRGB(a._gaugeColor[0], a._gaugeColor[1], a._gaugeColor[2]);
                    cr.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + p * 2 * Math.PI);
                    cr.lineTo(cx, cy);
                    cr.fill();
                }

                // Thin black outline.
                cr.setSourceRGB(0, 0, 0);
                cr.setLineWidth(1);
                cr.arc(cx, cy, r, 0, 2 * Math.PI);
                cr.stroke();

                cr.$dispose();
            });

            if (tooltipText) {
                this._attachHoverTooltip(area, tooltipText);
            }
            if (title && body) {
                area.connect('button-press-event', () => {
                    this._showExplanationOverlay(area, title, body);
                    return Clutter.EVENT_STOP;
                });
            }

            return area;
        }

        // -------------------------------------------------------------------
        // Parse SMART JSON and add structured sections to the device section.
        // Uses the modular parser (BaseParser / SamsungParser).
        // -------------------------------------------------------------------
        _addSmartInfo(smartRaw, modelHint = null) {
            const smart = parseSmart(smartRaw, modelHint);
            const manuf = smart.manufacturer;

            // ---------------------------------------------------------------
            // Temperature Section
            // ---------------------------------------------------------------
            if (smart.temperature.composite !== null) {
                const cw = smart.alerts.criticalWarning || 0;
                const icon = this._getThermometerIcon(smart.temperature.composite, cw);
                const style = this._getTempStyle(smart.temperature.composite, cw);

                const tempLabels = {
                    controller: _('Controller'),
                    nand: _('NAND'),
                    sensor: _('Sensor'),
                };
                const line = formatTemperatureLine(
                    manuf,
                    smart.temperature.composite,
                    smart.temperature.sensors,
                    tempLabels
                );
                this._addInfoLine(line, style, icon);

                // Additional sensors as separate rows (non-Samsung only).
                for (const row of formatSensorRows(manuf, smart.temperature.sensors, tempLabels)) {
                    const sensorIcon = this._getThermometerIcon(row.temp, cw);
                    const sensorStyle = this._getTempStyle(row.temp, cw);
                    this._addInfoLine(row.text, sensorStyle, sensorIcon);
                }
            }

            // ---------------------------------------------------------------
            // Endurance Section
            // ---------------------------------------------------------------
            // Power line: cycles (human-readable) · hours (human-readable) ·
            // unsafe shutdowns. Raw value revealed on hover via tooltip.
            const powerParts = [];
            if (smart.endurance.powerCycles !== undefined) {
                powerParts.push(_('Power Cycles') + ': ' +
                    smart.endurance.powerCycles.toLocaleString('en-US'));
            }
            if (smart.endurance.powerOnHours !== undefined) {
                powerParts.push(_('Power On') + ': ' +
                    formatPowerOnHours(smart.endurance.powerOnHours));
            }
            if (smart.endurance.unsafeShutdowns !== undefined) {
                powerParts.push(`${_('Unsafe Shutdowns')}: ${smart.endurance.unsafeShutdowns}`);
            }
            if (powerParts.length > 0) {
                this._addInfoLine(`  ${powerParts.join(' · ')}`, 'nvme-smart-attr', ICONS.Plug);
            }

            // Data + Host on a single line. Each group keeps its own section
            // icon: database for data units, arrow-left-right for host
            // commands (Samsung). Read uses the eyeglasses icon, write uses
            // the vector-pen icon. The human-readable value is shown; the raw
            // value is revealed on hover.
            const segments = [];
            if (smart.endurance.dataUnitsRead !== undefined) {
                segments.push({
                    sectionIcon: ICONS.Database,
                    iconName: ICONS.Eyeglasses,
                    value: formatDataUnits(smart.endurance.dataUnitsRead),
                    tooltip: `${_('Data Read')}: ${smart.endurance.dataUnitsRead} units`,
                });
            }
            if (smart.endurance.dataUnitsWritten !== undefined) {
                segments.push({
                    iconName: ICONS.VectorPen,
                    value: formatDataUnits(smart.endurance.dataUnitsWritten),
                    tooltip: `${_('Data Written')}: ${smart.endurance.dataUnitsWritten} units`,
                });
            }
            if (manuf === 'Samsung') {
                if (smart.endurance.hostReads !== undefined) {
                    segments.push({
                        sectionIcon: ICONS.ArrowLeftRight,
                        iconName: ICONS.Eyeglasses,
                        value: formatCompactNumber(smart.endurance.hostReads),
                        tooltip: `${_('Host Reads')}: ${smart.endurance.hostReads.toLocaleString('en-US')}`,
                    });
                }
                if (smart.endurance.hostWrites !== undefined) {
                    segments.push({
                        iconName: ICONS.VectorPen,
                        value: formatCompactNumber(smart.endurance.hostWrites),
                        tooltip: `${_('Host Writes')}: ${smart.endurance.hostWrites.toLocaleString('en-US')}`,
                    });
                }
            }
            this._addMetricSegmentsLine(segments);

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
            _debug(`_updateV2ToggleState(${active}) — state set directly, no signal emitted`);
        }

        // -------------------------------------------------------------------
        // v2: Install the new polkit stack via setup-polkit.sh
        // -------------------------------------------------------------------
        _installV2Stack() {
            const setupPath = GLib.build_filenamev([this._extensionPath || '', SETUP_SCRIPT_NAME]);
            _debug(`_installV2Stack: setupPath=${setupPath}`);

            if (!GLib.file_test(setupPath, GLib.FileTest.EXISTS)) {
                _warn(`setup-polkit.sh not found: ${setupPath}`);
                notifyError(_('setup-polkit.sh not found. Place it in the extension directory.'));
                this._v2Toggle.setSensitive(false);
                this._v2Updating = false;
                return;
            }

            _debug('Running pkexec setup-polkit.sh...');
            this._v2Toggle.setSensitive(false);

            const result = runPkexecSync([setupPath]);

            this._v2Toggle.setSensitive(true);

            if (result.stderr) _debug(`stderr: ${result.stderr.trim()}`);
            if (result.stdout) _debug(`stdout: ${result.stdout.trim()}`);

            if (result.ok && result.exitCode === 0) {
                _debug('Installation complete');
                notify(_('NVMe polkit stack installed!'), _('Please log out and back in for new group membership.'));
                this._updateV2ToggleState(true);
                this._startPolling();
            } else {
                _warn(`Installation failed (exit code ${result.exitCode})`);
                notifyError(_('Installation failed (exit code ') + result.exitCode + ')');
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
                _debug(`Uninstall script not found. (count=${_uninstallNotFoundCount}/${KILL_THRESHOLD})`);

                if (_uninstallNotFoundCount >= KILL_THRESHOLD) {
                    _error(`Kill threshold reached (${KILL_THRESHOLD}). Disabling extension to break loop.`);
                    notifyError(`NVMe Monitor`, `Loop detected — extension disabled.`);
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
                        _warn(`Could not disable via D-Bus: ${e.message}`);
                    }
                    return;
                }

                notifyError(_('Uninstall script not found.'));
                this._updateV2ToggleState(true);
                this._v2Updating = false;
                return;
            }

            _debug('Running pkexec nvme-smart-uninstall.sh...');
            this._v2Toggle.setSensitive(false);

            const result = runPkexecSync([UNINSTALL_PATH]);

            this._v2Toggle.setSensitive(true);

            if (result.stderr) _debug(`stderr: ${result.stderr.trim()}`);
            if (result.stdout) _debug(`stdout: ${result.stdout.trim()}`);

            if (result.ok && result.exitCode === 0) {
                _debug('Uninstall complete');
                notify(_('NVMe polkit stack uninstalled.'), '');
                this._updateV2ToggleState(false);
                this._stopPolling();
            } else {
                _warn(`Uninstall failed (exit code ${result.exitCode})`);
                notifyError(_('Uninstall failed (exit code ') + result.exitCode + ')');
                this._updateV2ToggleState(true);
            }

            this._v2Updating = false;
        }


        destroy() {
            this._hideExplanationOverlay();
            this._stopPolling();
            super.destroy();
        }
    });

export default class IndicatorExampleExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this.initTranslations();
    }

    enable() {
        _debug('enable() enter');
        this._indicator = new Indicator();
        this._indicator._extensionPath = this.path;
        this._indicator._setupIcon();
        this._indicator._checkSetupScript();
        // Detect the installed nvme-cli version once and warn if affected.
        _checkNvmeCliVersion(GLib.find_program_in_path('nvme'));
        // Start polling if the polkit stack is already installed.
        if (isV2Installed()) {
            this._indicator._startPolling();
        }
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        // Load extension stylesheet (device header, meta lines, smart values)
        this._stylesheet = Gio.File.new_for_path(GLib.build_filenamev([this.path, 'stylesheet.css']));
        St.ThemeContext.get_for_stage(global.stage).get_theme().load_stylesheet(this._stylesheet);
        _debug('enable() exit');
    }

    disable() {
        _debug('disable() enter');
        if (this._stylesheet) {
            St.ThemeContext.get_for_stage(global.stage).get_theme().unload_stylesheet(this._stylesheet);
            this._stylesheet = null;
        }
        if (this._indicator) {
            this._indicator.destroy();
        }
        this._indicator = null;
        _debug('disable() exit');
    }
}
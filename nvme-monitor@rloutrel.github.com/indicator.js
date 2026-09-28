// Panel indicator: menu construction, device rendering, polling timers,
// temperature history persistence, and the polkit stack install/uninstall
// flows.

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {PopupBaseMenuItem, PopupMenuItem, PopupSwitchMenuItem, PopupSeparatorMenuItem, PopupMenuSection} from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {_debug, _warn, notifyError} from './logger.js';
import {
    runCommandSync,
    fileExists,
    checkV2Installed,
    checkCurrentUserInSmartGroup,
    checkUninstallAvailable,
    runPkexec,
} from './subprocess.js';
import {ICONS, DARK_ICON_VARIANTS, fileIcon} from './icons.js';
import {createTempChartArea} from './tempChart.js';
import {buildHealthGauges, getSmartStatusLine} from './smartStatus.js';
import {
    handleUninstallNotFound,
    installV2Stack,
    uninstallV2Stack,
    disableSelfViaDbus,
} from './v2flow.js';
import {
    TEMP_HOT_C,
    isCriticalTemp,
    getThermometerIcon,
    getTempStyle,
} from './tempTiers.js';
import {formatDiskUsageBytes, describeDiskUsageEntry, buildDiskUsageDetails} from './usageFormatting.js';
import {computeOverlayPosition} from './overlayGeometry.js';

// Import the SMART parser
import { parseSmart } from './smartParser.js';
// Import endurance value formatting + temperature tier color (pure, unit-tested)
import { formatCompactNumber, formatDataUnits, formatPowerOnHours, COLOR_TRACK } from './format.js';
// Import temperature line formatting (pure, unit-tested)
import { formatTemperatureLine, formatSensorRows } from './tempFormat.js';
import { calculateUsageSegmentWidths, createUsageBarFromSegments } from './diskUsage.js';
import { collectFilesystemUsage, collectLvmInfo, writeDiskUsageDiagnostic } from './diskDiscovery.js';
import { buildDiskUsageEntries } from './diskUsageModel.js';
// Import device-list normalization for both flat and nested JSON layouts (pure)
import { normalizeDeviceList } from './deviceList.js';
// Import temperature unit handling (pure, unit-tested).
import { TEMP_UNIT_CELSIUS } from './tempUnit.js';
// Import rolling per-device temperature history (pure, unit-tested).
import { TempHistory, TEMP_HISTORY_WINDOW_MS } from './tempHistory.js';
// Import polkit management (pure, unit-tested)
import { WRAPPER_PATH, SETUP_SCRIPT_NAME } from './polkitManager.js';

// Persisted rolling temperature history (last 30 minutes, per device). The file
// is written atomically by GLib.file_set_contents after each capture so a
// crash/restart keeps the recent curve, and it is pruned on load.
const TEMP_HISTORY_PATH = GLib.build_filenamev(
    [GLib.get_user_runtime_dir(), 'nvme-monitor-temp-history.json']);

// Normal polling interval (seconds), matching the existing live polling.
const POLL_INTERVAL_S = 5;
// Fast refresh interval (ms) for a device in the critical/hot (red) tier.
const CRITICAL_REFRESH_MS = 500;
// Stale-data threshold: SMART info older than this is still valid data,
// but it should be clearly marked as stale instead of being treated as a
// drive-usage metric.
const STALE_DATA_MS = 10 * 60 * 1000;

const ICONS_DIR = 'icons';
const ICONS_BOOTSTRAP = 'bootstrap';
const ICON_EXTENSION = '.svg';

// Leading section icons (plug, database, thermometer, device header) are
// rendered larger than the per-value inline icons.
const SECTION_ICON_SIZE = 22;
const VALUE_ICON_SIZE = 16;

const PANEL_WARNING_CLASS = 'nvme-panel-warning';
const DISK_USAGE_DEBUG_DIR = GLib.build_filenamev(
    [GLib.get_user_runtime_dir(), 'found_dev_path']);

// Global fail counter for the uninstall-not-found loop (see v2flow.js).
let _uninstallNotFoundCount = 0;

export const Indicator = GObject.registerClass(
    class Indicator extends PanelMenu.Button {
        _init({extensionPath = '', openPreferences = null} = {}) {
            super._init(0.0, _('NVMe Monitor'));
            this._extensionPath = extensionPath;
            this._openPreferences = openPreferences;

            // Panel icon — single NVMe outline icon.
            this._panelIcon = new St.Icon({
                icon_name: ICONS.PanelFallback,
                style_class: 'system-status-icon',
            });
            this.add_child(this._panelIcon);
            this._panelWarningActive = false;

            // Cached device icon (loaded in _setupIcon)
            this._deviceIcon = null;
            this._iconCache = {};
            // Cached NVMe device list (fetched once)
            this._cachedDevices = null;
            // Track the last successful SMART read per device so stale data can
            // be shown separately from the disk-usage gauge.
            this._lastSmartReadAt = {};

            // Rolling per-device temperature history (last 30 minutes). Loaded
            // from /tmp in enable() so a restart keeps the recent curve.
            this._tempHistory = new TempHistory({ windowMs: TEMP_HISTORY_WINDOW_MS });
            // Display temperature unit, set by the extension from GSettings.
            this._tempUnit = TEMP_UNIT_CELSIUS;
            // Per-device fast (500ms) timers for drives in the critical/hot
            // (red) tier. Only the matching device's SMART is re-fetched.
            this._criticalTimers = {};

            // ---------------------------------------------------------------
            // Menu structure:
            //   [Enable NVMe smart-log access toggle]
            //   [separator]
            //   [device section]  ← dynamically rebuilt on menu open
            // ---------------------------------------------------------------

            // ---------------------------------------------------------------
            // v2: NVMe smart-log access toggle (install/uninstall polkit stack)
            // ---------------------------------------------------------------
            const v2Installed = checkV2Installed();
            _debug(`init: isV2Installed=${v2Installed}`);

            this._v2Updating = false;

            this._v2Toggle = new PopupSwitchMenuItem(_('Enable NVMe smart-log access'), v2Installed);

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
            // Gear button at the right of the toggle row: opens the
            // extension preferences window (temperature unit, ...).
            const gearIcon = this._loadMenuIconByName(ICONS.Gear);
            this._prefsButton = new St.Button({
                child: new St.Icon({
                    gicon: gearIcon,
                    icon_name: gearIcon ? null : 'emblem-system-symbolic',
                    icon_size: SECTION_ICON_SIZE,
                }),
                can_focus: true,
                reactive: true,
                track_hover: true,
                style_class: 'nvme-prefs-button',
            });
            this._prefsButton.set_accessible_name(_('Preferences'));
            this._prefsButton.connect('clicked', () => {
                if (this._openPreferences)
                    this._openPreferences();
            });
            this._v2Toggle.add_child(this._prefsButton);

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
        // Start/stop the polling timer. The base interval is 5s; while a
        // device is in the critical/hot (red) temperature tier it also gets
        // a per-device 500ms fast timer (see _syncCriticalTimers) that
        // re-fetches only that device's SMART, records the temperature and
        // repaints its graph in place. Only active when the polkit stack is
        // installed.
        // -------------------------------------------------------------------
        _startPolling() {
            if (this._pollingTimer) return;
            this._pollingTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_INTERVAL_S, () => {
                this._refreshDevices();
                return GLib.SOURCE_CONTINUE;
            });
            _debug(`Polling timer started (${POLL_INTERVAL_S}s interval)`);
        }

        _stopPolling() {
            if (this._pollingTimer) {
                GLib.source_remove(this._pollingTimer);
                this._pollingTimer = null;
                _debug('Polling timer stopped');
            }
            this._stopAllCriticalTimers();
        }

        // -------------------------------------------------------------------
        // Reconcile the per-device 500ms timers with the current critical
        // set. `criticalPaths` is the set of device paths that should poll
        // fast right now (red tier). Timers for devices no longer critical
        // are removed; timers are (re)created for newly critical devices.
        // -------------------------------------------------------------------
        _syncCriticalTimers(criticalPaths) {
            const wanted = new Set(criticalPaths);

            for (const path of Object.keys(this._criticalTimers)) {
                if (!wanted.has(path)) {
                    GLib.source_remove(this._criticalTimers[path]);
                    delete this._criticalTimers[path];
                    _debug(`Critical 0.5s timer stopped for ${path}`);
                }
            }

            for (const path of wanted) {
                if (this._criticalTimers[path]) continue;
                this._criticalTimers[path] = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CRITICAL_REFRESH_MS, () => {
                    this._refreshCriticalDevice(path);
                    return GLib.SOURCE_CONTINUE;
                });
                _debug(`Critical 0.5s timer started for ${path}`);
            }
        }

        _stopAllCriticalTimers() {
            for (const path of Object.keys(this._criticalTimers)) {
                GLib.source_remove(this._criticalTimers[path]);
                delete this._criticalTimers[path];
            }
        }

        // -------------------------------------------------------------------
        // Check if setup-polkit.sh exists; disable toggle if not installed
        // and script is missing. Called from enable() after path is set.
        // -------------------------------------------------------------------
        _checkSetupScript() {
            if (checkV2Installed()) return;
            const setupPath = GLib.build_filenamev([this._extensionPath || '', SETUP_SCRIPT_NAME]);
            if (!fileExists(setupPath)) {
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
        // when the polkit stack is installed). On each successful SMART read
        // the composite temperature is recorded into the rolling history and
        // rendered as a 30-minute line graph; devices in the red tier get a
        // dedicated 500ms refresh (see _syncCriticalTimers).
        // -------------------------------------------------------------------
        _refreshDevices() {
            // Clear previous content and drop stale chart references; new
            // charts are re-registered as they are added below.
            this._devicesSection.removeAll();
            this._tempCharts = {};
            this._setPanelWarning(false);

            // Load device icon (cached) — prefer the white-fill -dark
            // variant so the header icon stays visible on a dark menu.
            if (!this._deviceIcon) {
                this._deviceIcon = this._loadMenuIconByName(ICONS.Nvme);
            }

            // --- Step 1: get cached NVMe devices ---
            const devices = this._fetchAndCacheDevices();
            if (devices === null) {
                this._addInfoLine(_('nvme-cli not installed'));
                this._syncCriticalTimers([]);
                return;
            }

            if (devices.length === 0) {
                this._addInfoLine(_('No NVMe devices found'));
                this._syncCriticalTimers([]);
                return;
            }

            const v2Installed = checkV2Installed();
            const now = Date.now();
            const criticalPaths = [];
            const lvmInfo = collectLvmInfo(
                runCommandSync,
                {notAssigned: _('Not assigned')},
                _debug,
            );

            // Logical volumes are device-mapper views of the physical NVMe
            // volumes, so show them once above the per-drive sections.
            this._addLvmLogicalVolumes(lvmInfo);

            // --- Step 2: render devices in stable path order ---
            const sortedDevices = [...devices].sort((left, right) =>
                String(left.DevicePath || '').localeCompare(String(right.DevicePath || ''), undefined, {
                    numeric: true,
                })
            );
            for (let i = 0; i < sortedDevices.length; i++) {
                if (i > 0) {
                    this._devicesSection.addMenuItem(new PopupSeparatorMenuItem());
                }
                if (this._renderDevice(sortedDevices[i], v2Installed, now, lvmInfo)) {
                    criticalPaths.push(sortedDevices[i].DevicePath);
                }
            }

            this._syncCriticalTimers(criticalPaths);
        }

        // -------------------------------------------------------------------
        // Render a single device (header, meta, SMART info) into the device
        // section. On a successful SMART read the composite temperature is
        // recorded into the rolling history and a 30-minute line graph is
        // added. Returns true when the device is in the red (critical/hot)
        // tier and should get a 500ms fast refresh.
        // -------------------------------------------------------------------
        _renderDevice(dev, v2Installed, now, lvmInfo) {
            // SMART data (requires polkit stack). Fetched first so the
            // health gauges (if any) can be placed on the meta line.
            let smartObj = null;
            let smartParseError = false;
            if (v2Installed) {
                if (checkCurrentUserInSmartGroup()) {
                    const smartResult = runPkexec([WRAPPER_PATH, dev.DevicePath]);
                    if (smartResult.ok && smartResult.exitCode === 0) {
                        try {
                            smartObj = JSON.parse(smartResult.stdout);
                        } catch {
                            smartParseError = true;
                        }
                    }
                }
            }

            // Extract health gauges from the parsed SMART object.
            let healthGauges = null;
            let parsedSmart = null;
            if (smartObj) {
                parsedSmart = parseSmart(smartObj, dev.ModelNumber);
                this._setPanelWarning(
                    this._panelWarningActive || this._hasHotTemperatureSensor(parsedSmart.temperature));
                this._lastSmartReadAt[dev.DevicePath] = now;
                healthGauges = buildHealthGauges(parsedSmart, this._smartLabels());
            }

            // Device header: icon + bold model name + health gauges
            this._addDeviceHeader(dev.ModelNumber || dev.DevicePath, healthGauges);

            // Device path + firmware (dimmed), with the disk usage bar above it.
            const diskUsage = this._collectDiskUsageInfo(dev.DevicePath, lvmInfo);
            this._addDeviceMeta(dev.DevicePath, dev.Firmware, null, diskUsage);

            if (v2Installed && smartObj && !smartParseError) {
                this._addSmartInfo(smartObj, dev.ModelNumber);
            } else {
                const statusLine = getSmartStatusLine(
                    {v2Installed, smartObj, smartParseError, inGroup: checkCurrentUserInSmartGroup()},
                    this._smartLabels());
                if (statusLine)
                    this._addInfoLine(statusLine.text, statusLine.styleClass);
            }

            if (this._isStaleSmartData(dev.DevicePath, now)) {
                this._addInfoLine(_('  Stale data'), 'nvme-smart-info');
            }

            // Record the temperature reading into the rolling history and
            // render the 30-minute line graph. The red tier (drive's
            // critical_warning bit 1, or composite >= TEMP_HOT_C) drives a
            // dedicated 500ms refresh for this device.
            if (parsedSmart && parsedSmart.temperature.composite !== null) {
                const cw = parsedSmart.alerts.criticalWarning || 0;
                this._tempHistory.add(dev.DevicePath, {
                    t: now,
                    c: parsedSmart.temperature.composite,
                    s: parsedSmart.temperature.sensors || [],
                });
                this._saveTempHistory();
                this._addTempChart(dev.DevicePath, cw);
                if (this._isCriticalTemp(parsedSmart.temperature.composite, cw)) {
                    return true;
                }
            }
            return false;
        }

        // -------------------------------------------------------------------
        // True when a temperature reading is in the red (critical/hot) tier:
        // the drive's own critical_warning bit 1 is set, or the composite
        // temperature reached the heuristic hot threshold. Such devices get a
        // 500ms fast refresh (see _syncCriticalTimers).
        // -------------------------------------------------------------------
        _isCriticalTemp(tempCelsius, criticalWarning) {
            if (tempCelsius === null || tempCelsius === undefined) return false;
            return isCriticalTemp(tempCelsius, criticalWarning);
        }

        _hasHotTemperatureSensor(temperature) {
            if (!temperature || typeof temperature !== 'object') return false;
            const values = [temperature.composite, ...(temperature.sensors || [])];
            return values.some(value => Number.isFinite(value) && value >= TEMP_HOT_C);
        }

        _setPanelWarning(active) {
            if (this._panelWarningActive === active) return;
            this._panelWarningActive = active;
            if (active) {
                this.add_style_class_name(PANEL_WARNING_CLASS);
            } else {
                this.remove_style_class_name(PANEL_WARNING_CLASS);
            }
        }

        _isStaleSmartData(devicePath, now) {
            const lastReadAt = this._lastSmartReadAt[devicePath];
            if (lastReadAt === undefined || lastReadAt === null) return false;
            return (now - lastReadAt) > STALE_DATA_MS;
        }

        // -------------------------------------------------------------------
        // Load the persisted rolling temperature history from /tmp (if any) and
        // prune readings older than the window relative to now. Called once
        // from enable() so a restart keeps the recent curve.
        // -------------------------------------------------------------------
        _loadTempHistory() {
            try {
                const [ok, contents] = GLib.file_get_contents(TEMP_HISTORY_PATH);
                if (!ok || !contents) return;
                const decoder = new TextDecoder();
                const str = decoder.decode(contents);
                this._tempHistory = TempHistory.deserialize(str, Date.now());
                _debug(`Temp history loaded from ${TEMP_HISTORY_PATH} (${this._tempHistory.devices().length} devices)`);
            } catch (e) {
                _debug(`Temp history load skipped: ${e.message}`);
            }
        }

        // -------------------------------------------------------------------
        // Persist the rolling temperature history to /tmp atomically.
        // GLib.file_set_contents writes via a temp file then renames, so a
        // crash mid-write cannot leave a truncated file. Failures are
        // debug-logged only (the history is best-effort).
        // -------------------------------------------------------------------
        _saveTempHistory() {
            try {
                const str = this._tempHistory.serialize();
                const encoder = new TextEncoder();
                const bytes = encoder.encode(str);
                if (!GLib.file_set_contents(TEMP_HISTORY_PATH, bytes)) {
                    _debug('Temp history save failed (file_set_contents returned false)');
                }
            } catch (e) {
                _debug(`Temp history save failed: ${e.message}`);
            }
        }

        // -------------------------------------------------------------------
        // Fast path for a single critical device: re-fetch only that
        // device's SMART, record the temperature and repaint its graph in
        // place (without rebuilding the whole menu). Falls back to a full
        // _refreshDevices() if the device's chart actor is no longer present
        // (e.g. the menu was closed/reopened).
        // -------------------------------------------------------------------
        _refreshCriticalDevice(devicePath) {
            if (!checkV2Installed()) return;
            if (!checkCurrentUserInSmartGroup()) return;
            const devices = this._fetchAndCacheDevices();
            if (!devices) return;
            const dev = devices.find(d => d.DevicePath === devicePath);
            if (!dev) return;

            const smartResult = runPkexec([WRAPPER_PATH, devicePath]);
            if (!smartResult.ok || smartResult.exitCode !== 0) return;
            let smartObj;
            try {
                smartObj = JSON.parse(smartResult.stdout);
            } catch {
                return;
            }
            const smart = parseSmart(smartObj, dev.ModelNumber);
            if (smart.temperature.composite === null) return;

            const cw = smart.alerts.criticalWarning || 0;
            this._setPanelWarning(this._hasHotTemperatureSensor(smart.temperature));
            const now = Date.now();
            this._tempHistory.add(devicePath, {
                t: now,
                c: smart.temperature.composite,
                s: smart.temperature.sensors || [],
            });
            this._saveTempHistory();

            // Repaint the chart in place if its actor still exists.
            const chart = this._tempCharts && this._tempCharts[devicePath];
            if (chart) {
                chart._nvmeReadings = this._tempHistory.get(devicePath);
                chart._nvmeCriticalWarning = cw;
                chart.queue_repaint();
            } else {
                // Menu rebuilt since the timer started; do a full refresh to
                // re-create the chart and reconcile timers.
                this._refreshDevices();
            }
        }

        // -------------------------------------------------------------------
        // Add a non-interactive last-30-minutes temperature line graph for a
        // device (built by tempChart.js). The DrawingArea is registered in
        // this._tempCharts so the fast critical timer can repaint it in
        // place without rebuilding the menu.
        // -------------------------------------------------------------------
        _addTempChart(devicePath, criticalWarning) {
            if (!this._tempCharts) this._tempCharts = {};

            const readings = this._tempHistory.get(devicePath);
            const area = createTempChartArea({
                readings,
                criticalWarning,
                tempUnit: this._tempUnit,
            });

            const item = new PopupBaseMenuItem({ reactive: false, can_focus: false });
            item.add_child(area);
            this._devicesSection.addMenuItem(item);

            this._tempCharts[devicePath] = area;
        }

        // -------------------------------------------------------------------
        // Add a device header line: icon + bold label, non-interactive.
        // -------------------------------------------------------------------
        _addDeviceHeader(modelName, gauges = null) {
            const header = new PopupBaseMenuItem({ reactive: false, can_focus: false });

            if (this._deviceIcon) {
                header.add_child(new St.Icon({
                    gicon: this._deviceIcon,
                    icon_size: SECTION_ICON_SIZE,
                }));
            }

            const label = new St.Label({ text: modelName });
            label.add_style_class_name('nvme-device-header');
            header.add_child(label);

            if (gauges && gauges.length > 0) {
                const gaugeRow = new St.BoxLayout({
                    x_expand: true,
                    x_align: Clutter.ActorAlign.END,
                    style_class: 'nvme-gauge-header',
                });
                for (const gauge of gauges) {
                    gaugeRow.add_child(this._gaugeSegment(gauge));
                }
                header.add_child(gaugeRow);
            }

            this._devicesSection.addMenuItem(header);
        }

        // -------------------------------------------------------------------
        // Add the device metadata line and one interactive usage row per
        // matching mounted partition.
        // -------------------------------------------------------------------
        _addDeviceMeta(devicePath, firmware, gauges = null, diskUsage = null) {
            const item = new PopupBaseMenuItem({ reactive: false, can_focus: false });
            const gaugeList = gauges || [];
            const content = new St.BoxLayout({ x_expand: true, style_class: 'nvme-meta-columns' });
            const leftColumn = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                style_class: 'nvme-meta-stack',
            });

            if (diskUsage && diskUsage.length > 0) {
                const usageBar = this._createUsageBarFromSegments(diskUsage, 1, 8);
                this._attachPartitionUsageInteraction(usageBar, diskUsage);
                leftColumn.add_child(usageBar);
            }
            const meta = new St.Label({ text: `${devicePath} \u2014 FW: ${firmware}`, x_expand: true });
            meta.add_style_class_name('nvme-device-meta');
            meta.y_align = Clutter.ActorAlign.CENTER;
            leftColumn.add_child(meta);
            content.add_child(leftColumn);

            const rightColumn = new St.BoxLayout({
                vertical: true,
                x_expand: false,
                x_align: Clutter.ActorAlign.END,
                style_class: 'nvme-gauge-stack',
            });
            if (gaugeList.length > 0) {
                rightColumn.add_child(this._gaugeSegment(gaugeList[0]));
            }
            if (gaugeList.length > 1) {
                rightColumn.add_child(this._gaugeSegment(gaugeList[1]));
            }
            if (gaugeList.length > 0) {
                content.add_child(rightColumn);
            }

            item.add_child(content);

            this._devicesSection.addMenuItem(item);
        }

        _addHealthGauges(gauges) {
            if (!gauges || gauges.length === 0) return;

            const item = new PopupBaseMenuItem({ reactive: false, can_focus: false });
            const right = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                x_align: Clutter.ActorAlign.END,
                style_class: 'nvme-gauge-stack nvme-gauge-below-chart',
            });
            for (const gauge of gauges) {
                right.add_child(this._gaugeSegment(gauge));
            }
            item.add_child(right);
            this._devicesSection.addMenuItem(item);
        }

        _addDiskUsageRow(entries) {
            const item = new PopupBaseMenuItem({ reactive: false, can_focus: false });
            const row = new St.BoxLayout({ x_expand: true, style_class: 'nvme-disk-row' });

            row.add_child(this._createUsageBarFromSegments(entries, 1, 8));

            item.add_child(row);
            this._devicesSection.addMenuItem(item);
        }

        _createUsageBarFromSegments(entries, width = 120, height = 8) {
            return createUsageBarFromSegments(entries, width, height);
        }

        // -------------------------------------------------------------------
        // Build a single gauge segment: a label followed by the camembert
        // diagram. The percent value is revealed on hover.
        // -------------------------------------------------------------------
        _gaugeSegment(g) {
            const percent = Number(g.percent);
            const percentText = Number.isFinite(percent) ? `${g.percent}%` : '?';
            const gauge = this._createGauge(
                g.percent, g.color, 22, g.title, g.body, `${g.label}: ${percentText}`);
            return gauge;
        }

        _attachHelperCursor(actor) {
            actor.reactive = true;
            actor.add_style_class_name('nvme-clickable');
        }

        _formatDiskUsageBytes(kilobytes) {
            return formatDiskUsageBytes(kilobytes, _('Unknown'));
        }

        _describeDiskUsageEntry(entry) {
            return describeDiskUsageEntry(entry, this._usageLabels());
        }

        _smartLabels() {
            return {
                availableSpare: _('Available Spare'),
                lifetimeUsed: _('Lifetime Used'),
                spareBody: _('Reserved capacity the drive can swap in to replace failing blocks. ' +
                              'Critical below 15%, warning below 50%, OK otherwise.'),
                usedBody: _('Estimated portion of the drive endurance consumed. ' +
                            'OK below 50%, warning up to 85%, critical above.'),
                install: _('  Install NVMe Stack for SMART data'),
                parseError: _('  SMART: parse error'),
                relogin: _('  SMART: log out and back in to enable access'),
                unavailable: _('  SMART: unavailable'),
            };
        }

        _usageLabels() {
            return {
                device: _('Device'),
                mount: _('Mount'),
                type: _('Type'),
                contains: _('Contains'),
                usage: _('Usage'),
                used: _('used'),
                available: _('available'),
                total: _('total'),
                unknown: _('Unknown'),
            };
        }

        _diskUsageEntryAtPointer(actor, entries) {
            const [stageX] = actor.get_transformed_position();
            const [width] = actor.get_size();
            const relativeX = Math.max(0, Math.min(width, global.get_pointer()[0] - stageX));
            const segments = entries.filter(entry => entry && Number(entry.total) > 0);
            const segmentWidths = calculateUsageSegmentWidths(segments, width);
            if (segmentWidths.length === 0) return entries[0] || null;
            let offset = 0;
            for (let index = 0; index < segments.length; index++) {
                offset += segmentWidths[index];
                if (relativeX <= offset) return segments[index];
            }
            return entries[entries.length - 1] || null;
        }

        _attachPartitionUsageInteraction(actor, entries) {
            actor.reactive = true;
            actor.track_hover = true;
            actor.add_style_class_name('nvme-clickable');
            actor._partitionTooltip = null;
            actor._partitionEntry = null;

            const hideTooltip = () => {
                if (actor._partitionTooltip) {
                    actor._partitionTooltip.destroy();
                    actor._partitionTooltip = null;
                }
                actor._partitionEntry = null;
            };
            const showTooltip = () => {
                const entry = this._diskUsageEntryAtPointer(actor, entries);
                if (!entry) return;
                if (actor._partitionTooltip && actor._partitionEntry === entry) return;
                if (actor._partitionTooltip) actor._partitionTooltip.destroy();
                const label = new St.Label({
                    text: `${entry.source}\n${_('Click to know more')}`,
                    style_class: 'nvme-hover-tooltip',
                });
                Main.uiGroup.add_child(label);
                actor._partitionTooltip = label;
                actor._partitionEntry = entry;
                const [pointerX, pointerY] = global.get_pointer();
                const [, labelWidth] = label.get_preferred_width(-1);
                const [, labelHeight] = label.get_preferred_height(-1);
                const pos = computeOverlayPosition(
                    {x: pointerX, y: pointerY},
                    Main.layoutManager.monitors,
                    {width: labelWidth, height: labelHeight});
                if (pos)
                    label.set_position(pos.x, pos.y);
            };

            actor.connect('enter-event', () => {
                showTooltip();
                return Clutter.EVENT_PROPAGATE;
            });
            actor.connect('motion-event', () => {
                showTooltip();
                return Clutter.EVENT_PROPAGATE;
            });
            actor.connect('leave-event', () => {
                hideTooltip();
                return Clutter.EVENT_PROPAGATE;
            });
            actor.connect('destroy', hideTooltip);
            actor.connect('button-press-event', () => {
                const entry = this._diskUsageEntryAtPointer(actor, entries);
                if (!entry) return Clutter.EVENT_PROPAGATE;
                const usageDetails = buildDiskUsageDetails(entry, this._usageLabels());
                this._showExplanationOverlay(actor, _('Disk usage'), usageDetails);
                return Clutter.EVENT_STOP;
            });
        }

        _createHelpButton(title, body) {
            const button = new St.Button({
                style_class: 'nvme-help-button',
                can_focus: true,
                reactive: true,
                track_hover: true,
            });
            button.set_child(new St.Label({text: '?'}));
            button.set_accessible_name(title);
            this._attachHelperCursor(button);
            this._attachHoverTooltip(button, title);
            button.connect('clicked', () => {
                this._showExplanationOverlay(button, title, body);
            });
            return button;
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
        // Load the menu icon for `iconName`, preferring its white-fill
        // `-dark` variant (kept visible on a dark menu/panel surface) and
        // falling back to the base icon when the variant is missing.
        // Names already carrying the `-dark` suffix are passed through.
        // -------------------------------------------------------------------
        _loadMenuIconByName(iconName) {
            if (!iconName) return null;
            const darkName = DARK_ICON_VARIANTS[iconName];
            if (darkName) {
                const dark = this._loadIconByName(darkName);
                if (dark) return dark;
            }
            return this._loadIconByName(iconName);
        }

        // -------------------------------------------------------------------
        // Build an St.Icon for a bundled icon name: GIcon when the bundled SVG
        // exists, falling back to icon_name (system theme) otherwise.
        // Prefers the white-fill `-dark` variant so the icon stays visible on
        // a dark menu surface, falling back to the base icon when absent.
        // -------------------------------------------------------------------
        _createIcon(iconName, iconSize = 16, styleClass = 'nvme-info-icon') {
            const gicon = this._loadMenuIconByName(iconName);
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

                const [pointerX, pointerY] = global.get_pointer();
                // Position just below and to the right of the pointer.
                let x = Math.round(pointerX + 12);
                let y = Math.round(pointerY + 12);
                // Keep the tooltip on the monitor under the pointer.
                const area = Main.layoutManager.monitors.find(monitor =>
                    pointerX >= monitor.x && pointerX < monitor.x + monitor.width &&
                    pointerY >= monitor.y && pointerY < monitor.y + monitor.height
                );
                if (area) {
                    const [, natWidth] = label.get_preferred_width(-1);
                    const [, natHeight] = label.get_preferred_height(-1);
                    x = Math.max(area.x, Math.min(x, area.x + area.width - natWidth));
                    if (y + natHeight > area.y + area.height) {
                        y = Math.round(pointerY) - 12 - natHeight;
                    }
                    y = Math.max(area.y, y);
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

                const subBox = new St.BoxLayout({ x_expand: true, x_align: Clutter.ActorAlign.START, style_class: 'nvme-metric-section' });
                box.add_child(subBox);

                for (let i = 0; i < section.items.length; i++) {
                    const seg = section.items[i];

                    const iconActor = this._createIcon(seg.iconName, VALUE_ICON_SIZE, 'nvme-info-icon');
                    if (seg.tooltip) {
                        iconActor.reactive = true;
                        this._attachHoverTooltip(iconActor, seg.tooltip);
                    }
                    subBox.add_child(iconActor);

                    const valueLabel = new St.Label({ text: seg.value, x_expand: false });
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
            const name = getThermometerIcon(tempCelsius, criticalWarning);
            return name === null ? null : ICONS[name];
        }

        // -------------------------------------------------------------------
        // Get temperature style class. Red when the drive signals an
        // over-threshold condition (critical_warning bit 1); otherwise the
        // green/orange heuristic tiers.
        // ---------------------------------------------------------------------------
        _getTempStyle(tempCelsius, criticalWarning) {
            return getTempStyle(tempCelsius, criticalWarning);
        }

        // -------------------------------------------------------------------
        // Show a click-triggered explanation box near the pointer. It is a
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
            bodyLabel.clutter_text.ellipsize = 0;
            box.add_child(titleLabel);
            box.add_child(bodyLabel);

            Main.uiGroup.add_child(box);
            this._explainOverlay = box;

            const [pointerX, pointerY] = global.get_pointer();
            const [, natWidth] = box.get_preferred_width(-1);
            const [, natHeight] = box.get_preferred_height(-1);
            const pos = computeOverlayPosition(
                {x: pointerX, y: pointerY},
                Main.layoutManager.monitors,
                {width: natWidth, height: natHeight});
            if (pos)
                box.set_position(pos.x, pos.y);

            this._explainClickId = global.stage.connect('captured-event', (_stage, event) => {
                if (event.type() !== Clutter.EventType.BUTTON_PRESS) {
                    return Clutter.EVENT_PROPAGATE;
                }
                const [clickX, clickY] = event.get_coords();
                const [boxX, boxY] = box.get_transformed_position();
                const [boxWidth, boxHeight] = box.get_size();
                const insideBox = clickX >= boxX && clickX <= boxX + boxWidth &&
                    clickY >= boxY && clickY <= boxY + boxHeight;
                if (insideBox) {
                    return Clutter.EVENT_PROPAGATE;
                }
                this._hideExplanationOverlay();
                return Clutter.EVENT_PROPAGATE;
            });
            this._explainMenuClickId = this.menu.actor.connect('captured-event', (_menuActor, event) => {
                if (event.type() === Clutter.EventType.BUTTON_PRESS) {
                    this._hideExplanationOverlay();
                }
                return Clutter.EVENT_PROPAGATE;
            });
        }

        _hideExplanationOverlay() {
            if (this._explainClickId) {
                global.stage.disconnect(this._explainClickId);
                this._explainClickId = null;
            }
            if (this._explainMenuClickId) {
                this.menu.actor.disconnect(this._explainMenuClickId);
                this._explainMenuClickId = null;
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
                this._attachHelperCursor(area);
                area.connect('button-press-event', () => {
                    this._showExplanationOverlay(area, title, body);
                    return Clutter.EVENT_STOP;
                });
            }

            return area;
        }

        _addLvmLogicalVolumes(lvmInfo) {
            if (!lvmInfo || lvmInfo.logicalVolumes.length === 0) return;

            this._addInfoLine(_('Logical volumes'), 'nvme-device-header');
            const filesystemUsage = collectFilesystemUsage(runCommandSync);
            const sorted = [...lvmInfo.logicalVolumes].sort((left, right) =>
                String(left.source).localeCompare(String(right.source), undefined, {numeric: true}));
            for (const logicalVolume of sorted) {
                const usage = filesystemUsage.find(entry => entry.source === logicalVolume.source);
                const item = new PopupBaseMenuItem({reactive: false, can_focus: false});
                const row = new St.BoxLayout({x_expand: true, style_class: 'nvme-lvm-row'});
                const label = new St.Label({
                    text: `${logicalVolume.volumeGroup}/${logicalVolume.logicalVolume}`,
                    x_expand: true,
                });
                label.add_style_class_name('nvme-device-meta');
                row.add_child(label);
                if (usage) {
                    const bar = this._createUsageBarFromSegments([usage], 1, 8);
                    this._attachPartitionUsageInteraction(bar, [usage]);
                    row.add_child(bar);
                }
                item.add_child(row);
                this._devicesSection.addMenuItem(item);
            }
            this._devicesSection.addMenuItem(new PopupSeparatorMenuItem());
        }

        _collectDiskUsageInfo(devicePath, lvmInfo = null) {
            const filesystemEntries = collectFilesystemUsage(runCommandSync);
            const entries = buildDiskUsageEntries(
                devicePath,
                filesystemEntries,
                lvmInfo,
                {
                    lvmFilesystem: _('LVM physical volume'),
                    volumeGroup: _('Volume group'),
                },
            );
            writeDiskUsageDiagnostic(
                GLib,
                DISK_USAGE_DEBUG_DIR,
                devicePath,
                {
                    devicePath,
                    lvmCommands: lvmInfo?.diagnostics,
                    lvmInfo,
                    filesystemEntries,
                    allPhysicalVolumes: lvmInfo?.physicalVolumes || [],
                    matchedEntries: entries,
                    testBar: entries.map(entry => ({
                        source: entry.source,
                        isLvm: Boolean(entry.isLvm),
                        total: entry.total,
                        used: entry.used,
                        avail: entry.avail,
                        order: entry.isLvm ? 'purple' : 'red-used-then-green-free',
                    })),
                },
                _debug,
            );
            return entries;
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
                    tempLabels,
                    this._tempUnit
                );
                this._addInfoLine(line, style, icon);

                // Additional sensors as separate rows (non-Samsung only).
                for (const row of formatSensorRows(manuf, smart.temperature.sensors, tempLabels, this._tempUnit)) {
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
                this._addInfoLine(`${powerParts.join(' · ')}`, 'nvme-smart-attr', ICONS.Plug);
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
            installV2Stack({
                extensionPath: this._extensionPath,
                wasInSmartGroup: checkCurrentUserInSmartGroup(),
                ui: this._v2Ui(),
            });
        }
        // -------------------------------------------------------------------
        // v2: Uninstall the polkit stack via nvme-smart-uninstall.sh
        // -------------------------------------------------------------------
        _uninstallV2Stack() {
            if (!checkUninstallAvailable()) {
                const {count, action} = handleUninstallNotFound(_uninstallNotFoundCount, {
                    notifyError,
                    _,
                });
                _uninstallNotFoundCount = count;
                if (action === 'disable') {
                    disableSelfViaDbus('nvme-monitor@rloutrel.github.com');
                    return;
                }
                notifyError(_('Uninstall script not found.'));
                this._updateV2ToggleState(true);
                this._v2Updating = false;
                return;
            }
            uninstallV2Stack({ui: this._v2Ui()});
        }

        _v2Ui() {
            return {
                setToggleSensitive: s => this._v2Toggle.setSensitive(s),
                setToggleState: a => this._updateV2ToggleState(a),
                setUpdating: u => {
                    this._v2Updating = u;
                },
                onInstalled: () => {
                    this._startPolling();
                    this._refreshDevices();
                },
                onUninstalled: () => {
                    this._stopPolling();
                    this._refreshDevices();
                },
            };
        }

        destroy() {
            this._hideExplanationOverlay();
            this._stopAllCriticalTimers();
            this._stopPolling();
            super.destroy();
        }    }
);

// Panel indicator: menu construction, device rendering, polling timers,
// temperature history persistence, and the polkit stack install/uninstall
// flows.

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Pango from 'gi://Pango';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Atk from 'gi://Atk';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {ModalDialog} from 'resource:///org/gnome/shell/ui/modalDialog.js';
import {PopupBaseMenuItem, PopupMenuItem, PopupSwitchMenuItem, PopupSeparatorMenuItem, PopupMenuSection} from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {_debug, _warn, notifyError} from './logger.js';
import {
    runCommandSync,
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
    installV2StackFromPastedScript,
    uninstallV2Stack,
    disableSelfViaDbus,
} from './v2flow.js';
import {SETUP_SCRIPT_URL, checkSetupScriptHash} from './v2script.js';
import {computeSha256, fetchSetupScript} from './setupScriptFetch.js';
import {
    TEMP_HOT_C,
    isCriticalTemp,
    getThermometerIcon,
    getTempStyle,
} from './tempTiers.js';
import {formatDiskUsageBytes, describeDiskUsageEntry, buildDiskUsageDetails} from './usageFormatting.js';
import {computeOverlayPosition} from './overlayGeometry.js';

// Import the SMART parser
import { parseSmart, detectManufacturer, getSupportLevel, SUPPORTED_MANUFACTURERS } from './smartParser.js';
// Import the firmware registry helpers (pure, unit-tested)
import { assessFirmware } from './firmwareRegistry.js';
// Validated-devices registry (ModelNumber -> manufacturer), loaded at
// runtime because GJS in GNOME Shell 50 does not support JSON import
// attributes. Falls back to an empty registry if the file is unreadable.
function loadValidatedDevices() {
    try {
        const path = GLib.build_filenamev([
            GLib.path_get_dirname(import.meta.url.replace('file://', '')),
            'validatedDevices.json',
        ]);
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok)
            return {};
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {
        _warn(`Failed to load validatedDevices.json: ${e}`);
        return {};
    }
}
const VALIDATED_DEVICES = loadValidatedDevices();

// ---------------------------------------------------------------------------
// Controller PCI device ID for a device path (e.g. '/dev/nvme0' ->
// '0xa808'), read unprivileged from sysfs. Samsung ships hardware
// revisions under the same ModelNumber (e.g. 970 EVO Plus Phoenix vs
// Elpis), each with its own firmware line; the PCI device ID is the
// discriminator the registry's per-revision firmware data keys on.
// Returns '' when the sysfs files are unreadable (non-pci transport or
// unexpected layout), letting the firmware check degrade to 'unknown'.
// ---------------------------------------------------------------------------
function readPciDeviceId(devicePath) {
    // `nvme list -o json` reports namespace paths (/dev/nvme1n1), but sysfs
    // indexes controllers (/sys/class/nvme/nvme1); strip the namespace suffix.
    const name = String(devicePath || '')
        .replace(/^\/dev\//, '')
        .replace(/n\d+$/, '');
    try {
        const vendorFile = Gio.File.new_for_path(`/sys/class/nvme/${name}/device/vendor`);
        const deviceFile = Gio.File.new_for_path(`/sys/class/nvme/${name}/device/device`);
        const [vendorOk, vendorContents] = vendorFile.load_contents(null);
        const [deviceOk, deviceContents] = deviceFile.load_contents(null);
        if (!vendorOk || !deviceOk)
            return '';
        const decoder = new TextDecoder();
        const vendor = decoder.decode(vendorContents).trim();
        const device = decoder.decode(deviceContents).trim();
        if (vendor === '' || device === '')
            return '';
        return `0x${Number.parseInt(device, 16).toString(16)}`;
    } catch (e) {
        _warn(`Failed to read PCI device ID for ${name}: ${e}`);
        return '';
    }
}

// ---------------------------------------------------------------------------
// PCI bus address of an NVMe controller (e.g. '/dev/nvme0' -> '0000:01:00.0'),
// resolved from the sysfs symlink /sys/class/nvme/<name>/device. Returns ''
// when the address cannot be resolved.
// ---------------------------------------------------------------------------
function readPciAddress(devicePath) {
    const name = String(devicePath || '')
        .replace(/^\/dev\//, '')
        .replace(/n\d+$/, '');
    try {
        // /sys/class/nvme/<name>/device is a relative symlink to the
        // controller's PCI device directory; follow it to read the target.
        const deviceLink = GLib.build_filenamev(['/sys/class/nvme', name, 'device']);
        const target = GLib.file_read_link(deviceLink);
        if (!target)
            return '';
        // The symlink points into the controller's PCI device directory:
        // ../../../devices/pci0000:00/0000:04:00.0/nvme/nvme1. Scan the
        // target components for the PCI bus address pattern instead of
        // assuming its position (the exact layout varies).
        const parts = target.split('/');
        for (let i = parts.length - 1; i >= 0; i--) {
            if (/^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f]$/i.test(parts[i]))
                return parts[i].toLowerCase();
        }
        return '';
    } catch (e) {
        _warn(`Failed to read PCI address for ${name}: ${e}`);
        return '';
    }
}

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
import { WRAPPER_PATH } from './polkitManager.js';

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
// Deep link to the "Support new device" GitHub issue template, preselected
// so the user lands directly on the form to fill in.
const SUPPORT_ISSUE_URL =
    'https://github.com/rloutrel/gnome-extension-nvme-monitor/issues/new?template=support-new-device.yml';
// Firmware download pages per manufacturer, opened when a drive reports a
// firmware older than the last known version in the registry.
const FIRMWARE_PAGE_URLS = Object.freeze({
    Samsung: 'https://semiconductor.samsung.com/consumer-storage/support/tools/',
});
// Max characters of the SMART JSON shown in the support overlay before the
// text is ellipsized; the full text is always copied to the clipboard.
const SUPPORT_JSON_PREVIEW_CHARS = 1500;
const DISK_USAGE_DEBUG_DIR = GLib.build_filenamev(
    [GLib.get_user_runtime_dir(), 'found_dev_path']);

// Global fail counter for the uninstall-not-found loop (see v2flow.js).
let _uninstallNotFoundCount = 0;

// ---------------------------------------------------------------------------
// Device support dialog: a classic GNOME Shell modal dialog for a device
// whose manufacturer is not recognized. Unlike a transient overlay it holds
// a modal grab, so clicks outside the dialog do not dismiss it; it closes
// via the Close button or Escape. Shows the call to action, the supported
// manufacturer list, the raw nvme list and smart-log JSON (each with a
// copy-to-clipboard button), and the GitHub issue deep link.
// ---------------------------------------------------------------------------
export const DeviceSupportDialog = GObject.registerClass(
    class DeviceSupportDialog extends ModalDialog {
        _init({smartRaw, listRaw, lspciRaw = null, modelNumber, supportLevel = 'report', createCopyableJsonBox, openSupportIssue, attachDrag = null}) {
            super._init({styleClass: 'nvme-support-dialog', shellReactive: true}, true);
            this.reactive = false;
            this.dialogLayout.reactive = true;
            this._createCopyableJsonBox = createCopyableJsonBox;
            this._openSupportIssue = openSupportIssue;

            const content = this.contentLayout;

            // Full-width draggable header bar: title on the left, close
            // button on the right. Pressing anywhere on the bar (except the
            // close button) moves the dialog.
            const headerBar = new St.BoxLayout({
                style_class: 'nvme-support-dialog-headerbar',
            });
            const title = new St.Label({
                text: supportLevel === 'confirm'
                    ? _('Confirm device rendering')
                    : _('Unknown device'),
                style_class: 'nvme-support-dialog-title',
                x_expand: true,
            });
            title.clutter_text.line_wrap = true;
            headerBar.add_child(title);
            const closeButton = new St.Button({
                style_class: 'nvme-support-close-button',
                can_focus: true,
                reactive: true,
                track_hover: true,
            });
            closeButton.set_child(new St.Label({text: '\u2715'}));
            closeButton.set_accessible_name(_('Close'));
            closeButton.connect('clicked', () => this.close());
            headerBar.add_child(closeButton);
            if (attachDrag)
                attachDrag(headerBar, this.dialogLayout);
            content.add_child(headerBar);

            const introText = supportLevel === 'confirm'
                ? _('This device (%s) belongs to a supported manufacturer, but '
                    + 'it has not been explicitly confirmed as working yet. '
                    + 'Please open a GitHub issue to confirm that it works, or '
                    + 'to describe the problem that you are encountering, and '
                    + 'share the data below.').format(modelNumber)
                : _('This device (%s) has not been explicitly confirmed '
                    + 'as working yet. Sharing the data below via a GitHub issue '
                    + 'helps improve support for this model.').format(modelNumber);
            const intro = new St.Label({
                text: introText,
                style_class: 'nvme-support-dialog-body',
            });
            intro.clutter_text.line_wrap = true;
            content.add_child(intro);

            const supported = new St.Label({
                text: _('Supported manufacturers: %s')
                    .format(SUPPORTED_MANUFACTURERS.join(', ')),
                style_class: 'nvme-support-dialog-manufacturers',
            });
            supported.clutter_text.line_wrap = true;
            content.add_child(supported);

            const listTitle = new St.Label({
                text: _('Output of nvme list:'),
                style_class: 'nvme-support-json-title',
            });
            const smartTitle = new St.Label({
                text: _('Output of nvme smart-log:'),
                style_class: 'nvme-support-json-title',
            });
            const lspciTitle = new St.Label({
                text: _('Controller PCI device ID:'),
                style_class: 'nvme-support-json-title',
            });
            const jsonText = smartRaw ? JSON.stringify(smartRaw, null, 2) : '';
            content.add_child(this._createCopyableJsonBox(
                listTitle, listRaw || '', 'nvme list -o json'));
            content.add_child(this._createCopyableJsonBox(
                smartTitle, jsonText, 'sudo nvme smart-log [device_path] -o json'));
            content.add_child(this._createCopyableJsonBox(
                lspciTitle, lspciRaw || '', 'lspci -nn | grep -i nvme'));

            this.setButtons([
                {
                    label: _('Close'),
                    action: () => this.close(),
                    key: Clutter.KEY_Escape,
                    isDefault: true,
                },
                {
                    label: _('Open a support issue'),
                    action: () => this._openSupportIssue(),
                    style_class: 'nvme-support-issue-button',
                },
            ]);
        }

        // Show the dialog without taking the modal grab, so the session
        // stays interactive (the Shell is not blocked while it is open).
        // close() still works: without a pushed modal it pops nothing and
        // just fades out and destroys.
        openNonModal() {
            if (this.state === null || this.state === undefined)
                return;
            this._monitorConstraint.index = global.display.get_current_monitor();
            this.show();
            this.opacity = 255;
            this._setState(0);
        }
    }
);

// ---------------------------------------------------------------------------
// Setup script dialog: opened by the "Use NVMe SMART access" toggle
// when the stack is not installed. The setup script is intentionally NOT
// shipped/executed from the local extension directory (a local file run as
// root would be a privilege-escalation vector for anything that can write
// into it). Instead the dialog downloads the script from the GitHub
// repository, presents it read-only for review (selectable text and a
// copy-to-clipboard button), and runs the reviewed content as root via
// pkexec when the
// user presses Run. Integrity is checked internally: the fetched script's
// SHA-256 must match the checksum pinned in the extension (a malicious
// commit changing the script is refused); a transitory second hash may be
// approved explicitly once, until the extension ships the new pinned hash.
// If the download fails the dialog falls back to manual paste.
// ---------------------------------------------------------------------------
export const SetupScriptDialog = GObject.registerClass(
    class SetupScriptDialog extends ModalDialog {
        _init({attachDrag = null, onRun, copyToClipboard = null, loadMenuIcon = null}) {
            super._init({styleClass: 'nvme-support-dialog', shellReactive: true}, true);
            this.reactive = false;
            this.dialogLayout.reactive = true;
            this._onRun = onRun;
            this._copyToClipboard = copyToClipboard;
            this._scriptContent = '';
            this._runAllowed = false;

            const content = this.contentLayout;

            const headerBar = new St.BoxLayout({
                style_class: 'nvme-support-dialog-headerbar',
            });
            const title = new St.Label({
                text: _('Install NVMe SMART access'),
                style_class: 'nvme-support-dialog-title',
                x_expand: true,
            });
            title.clutter_text.line_wrap = true;
            headerBar.add_child(title);
            const closeButton = new St.Button({
                style_class: 'nvme-support-close-button',
                can_focus: true,
                reactive: true,
                track_hover: true,
            });
            closeButton.set_child(new St.Label({text: '\u2715'}));
            closeButton.set_accessible_name(_('Close'));
            closeButton.connect('clicked', () => this.close());
            headerBar.add_child(closeButton);
            if (attachDrag)
                attachDrag(headerBar, this.dialogLayout);
            content.add_child(headerBar);

            // The disclaimer and the FAQ share a tabbed layout: one page
            // visible at a time, inside one capped scroll view. The
            // disclaimer ("Your action is required") is shown by default.
            const why = new St.Label({
                text: _('Enabling SMART access needs a small root component '
                    + 'to be installed (a wrapper, a system group and a polkit '
                    + 'policy). This is not 100% automatic, so that the '
                    + 'extension never runs a local script as root — it might '
                    + 'have been created by a malicious program. '
                    + 'Instead, the script below was fetched from GitHub and '
                    + 'compared to the checksum pinned in the extension: '
                    + 'review it, then press Run to install it as sudo '
                    + '(pkexec). You will need to log out and back in '
                    + 'afterwards, for the group rights to be applied.'),
                style_class: 'nvme-support-dialog-body',
            });
            const whyCaveat = new St.Label({
                text: _('This is still not ideal: a modification of the '
                    + 'extension could call pkexec with a locally created '
                    + 'script, different from the one shown. Therefore the '
                    + 'safest way is to download the script yourself (see '
                    + 'the link below) and run it with pkexec on your own.'),
                style_class: 'nvme-setup-disclaimer-caveat',
            });
            why.clutter_text.line_wrap = true;
            whyCaveat.clutter_text.line_wrap = true;
            // Keep the wrapped lines: without this the label ellipsizes
            // ('...') and its natural height collapses to the visible box,
            // hiding the overflow from the scroll adjustment.
            why.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            whyCaveat.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            const whyPage = new St.BoxLayout({vertical: true});
            whyPage.add_child(why);
            whyPage.add_child(whyCaveat);

            const faqBox = new St.BoxLayout({
                vertical: true,
                style_class: 'nvme-setup-faq-box',
            });
            const faqEntries = [
                {
                    question: _('Why are polkit rules required?'),
                    answer: _('Reading the SMART log requires root rights. '
                        + 'The polkit action lets the extension run the wrapper '
                        + 'as root via pkexec without a password prompt on every '
                        + 'read; a second action allows the uninstaller to run '
                        + 'the same way. The initial install itself is not '
                        + 'covered by these rules: it runs once via pkexec with '
                        + 'your password.'),
                },
                {
                    question: _('Why create a group?'),
                    answer: _('The polkit rules would otherwise grant passwordless '
                        + 'root execution to every user of the machine. '
                        + 'Restricting them to members of the nvme-smart group, '
                        + 'from a local and active session, limits the grant to '
                        + 'the user who installed the component.'),
                },
                {
                    question: _('Why a wrapper?'),
                    answer: _('A polkit action is bound to one exact executable. '
                        + 'The wrapper hardcodes the resolved nvme binary path '
                        + 'and only accepts smart-log -o json on /dev/nvme* '
                        + 'devices, so the granted root access cannot be turned '
                        + 'into an arbitrary command.'),
                },
            ];
            for (const entry of faqEntries) {
                const question = new St.Label({
                    text: entry.question,
                    style_class: 'nvme-setup-faq-question',
                });
                const answer = new St.Label({
                    text: entry.answer,
                    style_class: 'nvme-setup-faq-answer',
                });
                question.clutter_text.line_wrap = true;
                answer.clutter_text.line_wrap = true;
                // Same wrapping pitfall as the disclaimer labels.
                question.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
                answer.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
                faqBox.add_child(question);
                faqBox.add_child(answer);
            }
            faqBox.hide();
            this._faqBox = faqBox;

            // Tab row: one toggle button per page; the active one carries
            // the -active style class.
            const tabRow = new St.BoxLayout({
                style_class: 'nvme-setup-tab-row',
            });
            const actionTab = new St.Button({
                style_class: 'nvme-setup-tab nvme-setup-tab-active',
                label: _('Your action is required'),
                can_focus: true,
                reactive: true,
                track_hover: true,
                x_expand: true,
            });
            const faqTab = new St.Button({
                style_class: 'nvme-setup-tab',
                label: _('FAQ'),
                can_focus: true,
                reactive: true,
                track_hover: true,
                x_expand: true,
            });
            actionTab.set_accessible_role(Atk.Role.TAB);
            faqTab.set_accessible_role(Atk.Role.TAB);
            tabRow.add_child(actionTab);
            tabRow.add_child(faqTab);
            content.add_child(tabRow);

            // Both pages live in the same capped scroll view: 10 lines
            // visible, anything longer scrolls. A wrapping label's minimum
            // height is a single line, so AUTOMATIC never detects the
            // overflow; ALWAYS shows the bar and the adjustment scrolls
            // over the natural height.
            const infoScroll = new St.ScrollView({
                style_class: 'nvme-setup-disclaimer-scroll',
                overlay_scrollbars: false,
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.ALWAYS,
            });
            const infoContent = new St.BoxLayout({vertical: true});
            infoContent.add_child(whyPage);
            infoContent.add_child(faqBox);
            infoScroll.set_child(infoContent);
            content.add_child(infoScroll);

            actionTab.connect('clicked', () =>
                this._selectInfoTab(actionTab, faqTab, whyPage, faqBox));
            faqTab.connect('clicked', () =>
                this._selectInfoTab(faqTab, actionTab, faqBox, whyPage));
            this._infoScroll = infoScroll;

            const urlBox = new St.BoxLayout({
                style_class: 'nvme-setup-script-link-box',
            });
            const urlText = new St.Label({
                text: _('Script location: %s').format(SETUP_SCRIPT_URL),
                style_class: 'nvme-support-dialog-manufacturers',
                x_expand: true,
            });
            urlText.clutter_text.line_wrap = true;
            urlBox.add_child(urlText);
            // Only the icon is clickable: it opens the script page in the
            // browser. External-open icon candidates:
            //   bundled: ICONS.BoxArrowUpRight via loadMenuIcon
            //   system:  'window-open-new-symbolic'
            //   system:  'web-browser-symbolic' (generic 'opens online')
            const urlIcon = new St.Icon({
                gicon: loadMenuIcon
                    ? loadMenuIcon(ICONS.BoxArrowUpRight)
                    : null,
                icon_name: loadMenuIcon ? null : 'window-open-new-symbolic',
                icon_size: 14,
            });
            const urlButton = new St.Button({
                style_class: 'nvme-setup-script-link',
                can_focus: true,
                reactive: true,
                track_hover: true,
            });
            urlButton.set_child(urlIcon);
            urlButton.set_accessible_name(_('Open the script on GitHub'));
            urlButton.connect('clicked', () => {
                try {
                    Gio.AppInfo.launch_default_for_uri(SETUP_SCRIPT_URL, null);
                } catch (e) {
                    _warn(`failed to open setup script URL: ${e.message}`);
                }
            });
            urlBox.add_child(urlButton);
            content.add_child(urlBox);

            this._integrityLabel = new St.Label({
                text: _('Fetching the setup script\u2026'),
                style_class: 'nvme-setup-status',
            });
            this._integrityLabel.clutter_text.line_wrap = true;
            content.add_child(this._integrityLabel);

            const scriptTitle = new St.Label({
                text: _('Script content:'),
                style_class: 'nvme-support-json-title',
                x_expand: true,
            });

            const scriptHeader = new St.BoxLayout({
                style_class: 'nvme-support-json-header',
                x_expand: true,
            });
            scriptHeader.add_child(scriptTitle);
            const copyButton = new St.Button({
                style_class: 'nvme-support-copy-button',
                can_focus: true,
                reactive: true,
                track_hover: true,
            });
            copyButton.set_child(new St.Icon({
                icon_name: 'edit-copy-symbolic',
                icon_size: VALUE_ICON_SIZE,
            }));
            copyButton.set_accessible_name(_('Copy to clipboard'));
            copyButton.connect('clicked', () => {
                if (this._copyToClipboard)
                    this._copyToClipboard(this._getScriptContent(), copyButton);
            });
            scriptHeader.add_child(copyButton);

            const scriptText = new St.Label({
                text: '',
                style_class: 'nvme-support-json',
            });
            scriptText.reactive = true;
            const text = scriptText.clutter_text;
            text.reactive = true;
            text.line_wrap = false;
            text.editable = false;
            text.selectable = true;
            text.single_line_mode = false;
            // Without this the label ellipsizes long lines ('...') and never
            // reports its natural width, so the horizontal scrollbar sees
            // nothing to scroll.
            text.ellipsize = Pango.EllipsizeMode.NONE;
            const selBg = new Cogl.Color({red: 211, green: 211, blue: 211, alpha: 255});
            const selText = new Cogl.Color({red: 0, green: 0, blue: 0, alpha: 255});
            text.selection_background_color = selBg;
            text.selected_text_color = selText;
            this._scriptLabel = scriptText;

            // Hidden multi-line entry used as the manual-paste fallback when
            // the automatic download fails: the user pastes the script copied
            // from GitHub and the same Run flow applies.
            const pasteEntry = new St.Entry({
                style_class: 'nvme-setup-script-entry',
            });
            const entryText = pasteEntry.clutter_text;
            entryText.editable = true;
            entryText.single_line_mode = false;
            entryText.line_wrap = true;
            entryText.reactive = true;
            entryText.selection_background_color = selBg;
            entryText.selected_text_color = selText;
            pasteEntry.hide();
            this._pasteEntry = pasteEntry;

            // Only the code area scrolls: the header stays fixed above it,
            // so the scrollbar applies to the script text alone.
            const codeContent = new St.BoxLayout({
                vertical: true,
                style_class: 'nvme-support-json-content',
            });
            codeContent.add_child(scriptText);
            codeContent.add_child(pasteEntry);
            const scrollView = new St.ScrollView({
                style_class: 'nvme-setup-script-scroll',
                overlay_scrollbars: false,
                hscrollbar_policy: St.PolicyType.ALWAYS,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
            });
            scrollView.set_child(codeContent);

            const frame = new St.BoxLayout({
                vertical: true,
                style_class: 'nvme-support-json-frame',
            });
            frame.add_child(scriptHeader);
            frame.add_child(scrollView);
            content.add_child(frame);

            this.setButtons([
                {
                    label: _('Cancel'),
                    action: () => this.close(),
                    key: Clutter.KEY_Escape,
                    isDefault: false,
                },
                {
                    label: _('Run'),
                    action: () => {
                        if (this._runAllowed)
                            this._onRun(this._getScriptContent());
                    },
                    style_class: 'nvme-support-issue-button',
                    isDefault: true,
                },
            ]);
        }

        // Switch the info area to `page`: move it into the scroll view,
        // update the tab style classes and scroll back to the top.
        _selectInfoTab(tab, otherTab, page, otherPage) {
            if (page.visible)
                return;
            page.show();
            otherPage.hide();
            tab.add_style_class_name('nvme-setup-tab-active');
            otherTab.remove_style_class_name('nvme-setup-tab-active');
            const vadj = this._infoScroll.vscroll.adjustment;
            vadj.value = vadj.lower;
        }

        // Current script content: the fetched text, or the pasted text in
        // the manual fallback.
        _getScriptContent() {
            if (this._pasteEntry.visible)
                return this._pasteEntry.get_text();
            return this._scriptContent;
        }

        // Fill the read-only review area with the fetched script. `hashStatus`
        // is the v2script.js check result: 'pinned' (trusted checksum),
        // 'transitory' (new script pending an extension update; the user must
        // explicitly approve it once) or 'unknown' (refused).
        presentFetchedScript(content, hashStatus) {
            this._scriptContent = content;
            this._scriptLabel.text = content;
            this._integrityLabel.show();
            if (hashStatus === 'pinned') {
                this._runAllowed = true;
                this._setStatusLabel(_('Checksum verified: the fetched script '
                    + 'matches the SHA-256 pinned in this extension.'), 'ok');
            } else if (hashStatus === 'transitory') {
                this._integrityLabel.text = _('The setup script was updated on GitHub '
                    + 'after this extension version was released, and its checksum '
                    + 'is only approved temporarily. You can review and run it now; '
                    + 'update the extension when a newer version is available.');
                this._runAllowed = true;
            } else {
                this._setStatusLabel(_('The fetched script does not match the '
                    + 'checksum pinned in this extension version: it may have been '
                    + 'modified on GitHub. For safety it cannot be run. Update the '
                    + 'extension to get the newly pinned checksum.'), 'error');
                this._runAllowed = false;
            }
        }

        // One-line feedback for the install steps triggered by Run: keeps the
        // user informed about what the dialog is currently doing. `tone` is
        // 'ok' (dark green), 'error' (dark red) or null (neutral).
        presentStep(message, tone = null) {
            this._integrityLabel.show();
            this._setStatusLabel(message, tone);
        }

        // Update the status label text and its ok/error tone.
        _setStatusLabel(text, tone) {
            this._integrityLabel.text = text;
            this._integrityLabel.remove_style_class_name('nvme-setup-status-ok');
            this._integrityLabel.remove_style_class_name('nvme-setup-status-error');
            if (tone === 'ok')
                this._integrityLabel.add_style_class_name('nvme-setup-status-ok');
            else if (tone === 'error')
                this._integrityLabel.add_style_class_name('nvme-setup-status-error');
        }

        // Download failed: switch the dialog to the manual paste fallback.
        presentFetchError(errorMessage) {
            this._scriptContent = '';
            this._integrityLabel.text = errorMessage === 'HTTP 404'
                ? _('The script was not found at its expected location (%s). '
                    + 'It is published with the extension version that ships '
                    + 'it, so it may not be available there yet. Please open '
                    + 'the location link above, copy the whole file and paste '
                    + 'it below instead.').format(errorMessage)
                : _('The script could not be fetched automatically (%s). '
                    + 'Please open it on GitHub, copy the whole file and paste '
                    + 'it below.').format(errorMessage);
            this._scriptLabel.hide();
            this._pasteEntry.show();
            this._runAllowed = true;
        }

        // Show without the modal grab, matching DeviceSupportDialog: the
        // session stays interactive (the pkexec prompt must be reachable).
        openNonModal() {
            if (this.state === null || this.state === undefined)
                return;
            this._monitorConstraint.index = global.display.get_current_monitor();
            this.show();
            this.opacity = 255;
            this._setState(0);
        }
    }
);

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
            // Actors carrying a hover tooltip. Tracked so their transient
            // tooltip labels can be destroyed without connecting a GC-unsafe
            // ::destroy signal on the actor itself.
            this._tooltipActors = [];

            // ---------------------------------------------------------------
            // Menu structure:
            //   [Use NVMe SMART access toggle]
            //   [separator]
            //   [device section]  ← dynamically rebuilt on menu open
            // ---------------------------------------------------------------

            // ---------------------------------------------------------------
            // v2: NVMe SMART access toggle (install/uninstall polkit stack)
            // ---------------------------------------------------------------
            const v2Installed = checkV2Installed();
            _debug(`init: isV2Installed=${v2Installed}`);

            this._v2Updating = false;
            // Logical stack state the extension expects. The 'toggled' signal
            // is also emitted for programmatic state changes (Switch emits
            // notify::state on every assignment), so the handler compares the
            // reported state against this target to tell user actions apart
            // from echoes of _updateV2ToggleState().
            this._v2DesiredState = v2Installed;

            this._v2Toggle = new PopupSwitchMenuItem(_('Use NVMe SMART access'), v2Installed);


            this._v2ToggleHandlerId = this._v2Toggle.connect('toggled', (item, state) => {
                _debug(`toggled(state=${state}) desired=${this._v2DesiredState} _v2Updating=${this._v2Updating}`);
                // 'toggled' is re-emitted for programmatic state changes;
                // anything matching the expected state is such an echo.
                if (state === this._v2DesiredState)
                    return;
                if (this._v2Updating) return;
                this._v2Updating = true;

                if (state) {
                    // Install goes through the fetch-and-review dialog. Flip
                    // the switch back off until the stack is really installed
                    // (desired state becomes false, so the echo is ignored).
                    this._updateV2ToggleState(false);
                    this._v2Updating = false;
                    this._showSetupScriptDialog();
                } else {
                    this._uninstallV2Stack();
                }
            });
            // Gear button at the right of the toggle row: opens the
            // extension preferences window (temperature unit, ...).
            this._prefsButton = new St.Button({
                child: new St.Icon({
                    icon_name: 'emblem-system-symbolic',
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
                if (open)
                    this._refreshDevices();
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
        // Fetch NVMe device list once and cache it.
        // Returns the cached devices or null on failure.
        // -------------------------------------------------------------------
        _fetchAndCacheDevices() {
            if (this._cachedDevices !== null) {
                return this._cachedDevices;
            }
            this._cachedListJson = null;

            const nvmeBin = GLib.find_program_in_path('nvme');
            if (!nvmeBin) {
                _warn('nvme-cli not found');
                return null;
            }

            const listResult = runCommandSync([nvmeBin, 'list', '-o', 'json']);
            if (!listResult.ok || listResult.exitCode !== 0) {
                _warn('Failed to list NVMe devices');
                return null;
            }

            // Some nvme-cli builds emit the JSON on stderr and leave stdout
            // nearly empty; accept whichever stream carries the JSON.
            const listJson = this._pickNvmeListJson(listResult);
            if (listJson === null) {
                _warn('nvme list: no JSON output on stdout or stderr');
                _debug(`nvme list: raw stdout: ${listResult.stdout?.substring(0, 200) || '(empty)'}`);
                _debug(`nvme list: raw stderr: ${listResult.stderr?.substring(0, 200) || '(empty)'}`);
                return null;
            }
            try {
                const parsed = JSON.parse(listJson);
                this._cachedDevices = normalizeDeviceList(parsed);
                this._cachedListJson = JSON.stringify(parsed, null, 2);
                _debug(`nvme list: found ${this._cachedDevices.length} devices (cached)`);
                return this._cachedDevices;
            } catch (e) {
                _warn(`nvme list: JSON parse error: ${e.message}`);
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
            // Re-sync the toggle with the installed stack: the state can
            // change outside the extension (manual uninstall script).
            const v2Now = checkV2Installed();
            if (v2Now !== this._v2DesiredState && !this._v2Updating)
                this._updateV2ToggleState(v2Now);

            // Clear previous content and drop stale chart references; new
            // charts are re-registered as they are added below.
            this._destroyHoverTooltips();
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

        // Shared drag-to-move helper: while the pointer button is pressed on
        // `handle`, `actor` follows the pointer via translation offsets. The
        // motion is tracked on the stage so the drag keeps working even when
        // the pointer leaves the handle (fixes the previous non-moving drag).
        _attachDragHandler(handle, actor) {
            let dragging = false;
            let stageMotionId = 0;
            let stageReleaseId = 0;
            let startX = 0;
            let startY = 0;
            let baseX = 0;
            let baseY = 0;
            handle.reactive = true;
            const endDrag = () => {
                dragging = false;
                if (stageMotionId) {
                    global.stage.disconnect(stageMotionId);
                    stageMotionId = 0;
                }
                if (stageReleaseId) {
                    global.stage.disconnect(stageReleaseId);
                    stageReleaseId = 0;
                }
            };
            handle.connect('button-press-event', (_h, event) => {
                if (dragging)
                    return Clutter.EVENT_PROPAGATE;
                dragging = true;
                [startX, startY] = event.get_coords();
                baseX = actor.translation_x;
                baseY = actor.translation_y;
                stageMotionId = global.stage.connect('motion-event', (_s, motionEvent) => {
                    if (!dragging)
                        return Clutter.EVENT_PROPAGATE;
                    const [x, y] = motionEvent.get_coords();
                    actor.translation_x = baseX + x - startX;
                    actor.translation_y = baseY + y - startY;
                    return Clutter.EVENT_PROPAGATE;
                });
                stageReleaseId = global.stage.connect('button-release-event', () => {
                    if (dragging)
                        endDrag();
                    return Clutter.EVENT_PROPAGATE;
                });
                return Clutter.EVENT_PROPAGATE;
            });
            // If the dragged actor is destroyed mid-drag (dialog closed),
            // release the stage handlers: otherwise every mouse move keeps
            // setting translation properties on the disposed actor.
            handle.connect('destroy', () => endDrag());
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

            // Device header: icon + bold model name + health gauges. The
            // support "!" button opens the device-support call to action
            // overlay: yellow when the manufacturer is supported but the
            // exact model is not confirmed working yet (ask to confirm the
            // rendering), red when the device seems badly handled (ask to
            // provide information).
            const support = this._unknownDeviceSupport(parsedSmart, smartObj, dev, smartParseError);
            this._addDeviceHeader(
                dev.ModelNumber || dev.DevicePath,
                healthGauges,
                support);

            // Device path + firmware (dimmed), with the disk usage bar above
            // it, plus a red firmware button when the registry knows a newer
            // firmware for this device's hardware revision.
            const diskUsage = this._collectDiskUsageInfo(dev.DevicePath, lvmInfo);
            this._addDeviceMeta(
                dev.DevicePath, dev.Firmware, null, diskUsage,
                this._firmwareButtonFor(dev));

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
        // Support payload for a device whose manufacturer could not be
        // detected, or null when the manufacturer is known. Manufacturer
        // detection also works without SMART data (smart-log stack not
        // installed/enabled): it falls back to the model number from
        // `nvme list`, so the dialog opens with the smart-log command in
        // the text area instead of the output.
        // -------------------------------------------------------------------
        _unknownDeviceSupport(parsedSmart, smartRaw, dev, smartParseError = false) {
            const manufacturer = parsedSmart
                ? parsedSmart.manufacturer
                : detectManufacturer(dev.ModelNumber || '');
            // The controller PCI device ID discriminates hardware
            // revisions under the same ModelNumber; known models with an
            // unregistered revision get the orange '!' so their owners
            // report the revision and we can document it.
            const pciDeviceId = readPciDeviceId(dev.DevicePath);
            _debug(`support level: model='${dev.ModelNumber || ''}' `
                + `pciDeviceId='${pciDeviceId}' manufacturer='${manufacturer}'`);
            const level = getSupportLevel(
                dev.ModelNumber || '', manufacturer, smartParseError, VALIDATED_DEVICES,
                pciDeviceId);
            if (level === 'validated')
                return null;
            let listRaw = this._cachedListJson;
            if (!listRaw) {
                listRaw = this._fetchListJson();
            }
            return {
                smartRaw,
                listRaw,
                lspciRaw: this._fetchPciDeviceId(dev.DevicePath),
                modelNumber: dev.ModelNumber || '',
                supportLevel: level,
            };
        }

        // -------------------------------------------------------------------
        // Controller PCI device ID of this drive, in the 'vendor:device'
        // form lspci prints (e.g. '144d:a808'). This is the key the
        // validated-devices registry's per-revision entries are indexed
        // on, so it is the main data point to collect for a support ticket.
        // Primary source: sysfs (no external binary needed); fallback:
        // extract the [vendor:device] token from this drive's line in the
        // `lspci -nn` output. Returns null when both fail.
        // -------------------------------------------------------------------
        _fetchPciDeviceId(devicePath) {
            // Primary: sysfs. readPciDeviceId() returns the bare device ID
            // (e.g. '0xa808'); combine it with the vendor file's value to
            // build the 'vendor:device' form (144d:a808).
            const name = String(devicePath || '')
                .replace(/^\/dev\//, '')
                .replace(/n\d+$/, '');
            try {
                const [vendorOk, vendorContents] = Gio.File
                    .new_for_path(`/sys/class/nvme/${name}/device/vendor`)
                    .load_contents(null);
                const deviceId = readPciDeviceId(devicePath);
                if (vendorOk && deviceId !== '') {
                    const vendor = new TextDecoder().decode(vendorContents).trim();
                    const vendorHex = vendor.replace(/^0x/, '').toLowerCase();
                    const deviceHex = deviceId.replace(/^0x/, '');
                    return `${vendorHex}:${deviceHex}`;
                }
            } catch (e) {
                _warn(`support dialog: sysfs PCI ID read failed for ${name}: ${e}`);
            }
            // Fallback: this drive's `lspci -nn` line, extracting the
            // [vendor:device] token from the trailing brackets.
            const lspciBin = GLib.find_program_in_path('lspci');
            if (!lspciBin) {
                _warn('support dialog: lspci binary not found in PATH');
                return null;
            }
            const result = runCommandSync([lspciBin, '-nn']);
            if (!result.ok || result.exitCode !== 0) {
                _warn(`support dialog: lspci failed: exit=${result.exitCode} stderr=${result.stderr.substring(0, 200) || '(empty)'}`);
                return null;
            }
            const pciAddress = readPciAddress(devicePath);
            if (pciAddress === '')
                return null;
            const shortAddress = pciAddress.replace(/^0000:/, '');
            const line = result.stdout
                .split('\n')
                .find(l => l.trim().startsWith(shortAddress));
            const match = line ? line.match(/\[([0-9a-f]{4}:[0-9a-f]{4})\]$/) : null;
            return match ? match[1].toLowerCase() : null;
        }

        // -------------------------------------------------------------------
        // Pick the `nvme list -o json` output stream that carries the JSON:
        // stdout normally, but some nvme-cli builds emit the JSON on stderr
        // (stdout then holds only a few whitespace bytes). Returns the raw
        // JSON text, or null when neither stream parses.
        // -------------------------------------------------------------------
        _pickNvmeListJson(result) {
            for (const stream of ['stdout', 'stderr']) {
                const trimmed = (result[stream] || '').trim();
                if (!trimmed) {
                    continue;
                }
                try {
                    JSON.parse(trimmed);
                    return trimmed;
                } catch {
                    // Not JSON on this stream; try the next one.
                }
            }
            return null;
        }

        // -------------------------------------------------------------------
        // Run `nvme list -o json` and return the raw JSON text, or null on
        // failure. Unlike the SMART log, this needs no polkit/pkexec, so it
        // is used to (re)fill the cache on demand for the support overlay.
        // -------------------------------------------------------------------
        _fetchListJson() {
            const nvmeBin = GLib.find_program_in_path('nvme');
            if (!nvmeBin) {
                _warn('support dialog: nvme binary not found in PATH');
                return null;
            }
            const result = runCommandSync([nvmeBin, 'list', '-o', 'json']);
            if (!result.ok || result.exitCode !== 0) {
                _warn(`support dialog: nvme list failed: exit=${result.exitCode} stderr=${result.stderr?.substring(0, 200) || '(empty)'}`);
                return null;
            }
            // Some nvme-cli builds emit the JSON on stderr; accept either.
            const listJson = this._pickNvmeListJson(result);
            if (listJson === null) {
                _warn('support dialog: nvme list produced no JSON output');
                return null;
            }
            this._cachedListJson = listJson;
            return this._cachedListJson;
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
        _addDeviceHeader(modelName, gauges = null, support = null) {
            const header = new PopupBaseMenuItem({ reactive: false, can_focus: false });

            if (support)
                header.add_child(this._createUnknownDeviceButton(support));

            if (this._deviceIcon) {
                header.add_child(new St.Icon({
                    gicon: this._deviceIcon,
                    icon_size: SECTION_ICON_SIZE,
                }));
            }

            const label = new St.Label({ text: modelName, x_expand: true });
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
        _addDeviceMeta(devicePath, firmware, gauges = null, diskUsage = null, firmwareButton = null) {
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
            const metaBox = new St.BoxLayout({ x_expand: true, style_class: 'nvme-meta-line' });
            const meta = new St.Label({ text: `${devicePath} \u2014 FW: ${firmware}`, x_expand: true });
            meta.add_style_class_name('nvme-device-meta');
            meta.y_align = Clutter.ActorAlign.CENTER;
            metaBox.add_child(meta);
            if (firmwareButton)
                metaBox.add_child(firmwareButton);
            leftColumn.add_child(metaBox);
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
                install: _('  Install the NVMe SMART stack'),
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
            this._tooltipActors.push(actor);

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
            actor.connect('button-press-event', () => {
                const entry = this._diskUsageEntryAtPointer(actor, entries);
                if (!entry) return Clutter.EVENT_PROPAGATE;
                const usageDetails = buildDiskUsageDetails(entry, this._usageLabels());
                this._showExplanationOverlay(actor, _('Disk usage'), usageDetails);
                return Clutter.EVENT_STOP;
            });
        }

        // -------------------------------------------------------------------
        // Red "!" button shown next to a device whose manufacturer is unknown.
        // Opens the device-support call to action overlay: the idea (add the
        // missing manufacturer detection pattern), what the user can do
        // (report the device), the SMART JSON to attach, the supported
        // manufacturer list, and the GitHub issue deep link.
        // -------------------------------------------------------------------
        // -------------------------------------------------------------------
        // Red button shown next to the firmware line when the reported
        // firmware does not match the last known version for the device.
        // Returns null when the registry has no firmware data for the
        // device (or its hardware revision, matched via the controller's
        // PCI device ID read from sysfs), so nothing is rendered.
        // -------------------------------------------------------------------
        _firmwareButtonFor(dev) {
            const entry = VALIDATED_DEVICES[String(dev.ModelNumber || '').trim()];
            if (!entry)
                return null;
            const pciDeviceId = readPciDeviceId(dev.DevicePath);
            if (assessFirmware(entry, dev.Firmware, pciDeviceId) !== 'outdated')
                return null;
            return this._createFirmwareButton(entry.manufacturer);
        }

        // The button itself: opens the manufacturer's firmware download page.
        _createFirmwareButton(manufacturer) {
            const button = new St.Button({
                style_class: 'nvme-support-button',
                can_focus: true,
                reactive: true,
                track_hover: true,
            });
            button.set_child(new St.Icon({
                gicon: this._loadMenuIconByName(ICONS.BoxArrowUpRight),
                icon_size: VALUE_ICON_SIZE,
            }));
            button.set_accessible_name(_('Firmware update available'));
            this._attachHelperCursor(button);
            this._attachHoverTooltip(button, _('Firmware update available'));
            button.connect('clicked', () => {
                const url = FIRMWARE_PAGE_URLS[manufacturer];
                if (url)
                    Gio.AppInfo.launch_default_for_uri(url, null);
            });
            return button;
        }

        _createUnknownDeviceButton({smartRaw, listRaw, lspciRaw, modelNumber, supportLevel}) {
            const button = new St.Button({
                style_class: 'nvme-support-button',
                can_focus: true,
                reactive: true,
                track_hover: true,
            });
            if (supportLevel === 'confirm')
                button.add_style_class_name('nvme-support-button-confirm');
            button.set_child(new St.Label({text: '!'}));
            button.set_accessible_name(_('Device support'));
            this._attachHelperCursor(button);
            this._attachHoverTooltip(button, _('Device support'));
            button.connect('clicked', () => {
                this.menu.close();
                this._showDeviceSupportDialog({smartRaw, listRaw, lspciRaw, modelNumber, supportLevel});
            });
            return button;
        }

        // -------------------------------------------------------------------
        // Open the device-support dialog: a real modal Shell dialog (not a
        // transient overlay), so a stray click does not dismiss it; it grabs
        // the pointer/keyboard until Closed or Escape.
        // -------------------------------------------------------------------
        _showDeviceSupportDialog({smartRaw, listRaw, lspciRaw, modelNumber, supportLevel}) {
            if (this._supportDialog) {
                this._supportDialog.close();
            }
            const dialog = new DeviceSupportDialog({
                smartRaw,
                listRaw,
                lspciRaw,
                modelNumber,
                supportLevel,
                createCopyableJsonBox: (title, text, command) =>
                    this._createCopyableJsonBox(title, text, command),
                openSupportIssue: () => this._openSupportIssue(),
                attachDrag: (handle, movedActor) => this._attachDragHandler(handle, movedActor),
            });
            dialog.openNonModal();
            this._supportDialog = dialog;
        }

        // -------------------------------------------------------------------
        // A JSON text box for the support dialog: a monospace, 10-line-tall
        // scrollable body with selectable text and a small copy-icon
        // copy button at its top right corner. `title` is the caption above
        // the text.
        // -------------------------------------------------------------------
        _createCopyableJsonBox(title, jsonText, command = null) {
            const frame = new St.BoxLayout({
                vertical: true,
                style_class: 'nvme-support-json-frame',
            });
            const header = new St.BoxLayout({
                style_class: 'nvme-support-json-header',
                x_expand: true,
            });
            const titleLabel = title;
            titleLabel.x_expand = true;
            header.add_child(titleLabel);
            const copyButton = new St.Button({
                style_class: 'nvme-support-copy-button',
                can_focus: true,
                reactive: true,
                track_hover: true,
            });
            copyButton.set_child(new St.Icon({
                icon_name: 'edit-copy-symbolic',
                icon_size: VALUE_ICON_SIZE,
            }));
            copyButton.set_accessible_name(_('Copy to clipboard'));
            this._attachHelperCursor(copyButton);
            this._attachHoverTooltip(copyButton, _('Copy to clipboard'));
            copyButton.connect('clicked', () => {
                const clipboard = St.Clipboard.get_default();
                clipboard.set_text(St.ClipboardType.CLIPBOARD,
                    jsonText.length > 0 ? jsonText : (command || ''));
                this._showCopiedFeedback(copyButton);
            });
            header.add_child(copyButton);
            const missing = jsonText.length === 0;
            let hint = null;
            if (missing && command) {
                hint = new St.Label({
                    text: _('The output could not be collected automatically. '
                        + 'Run the command below in a terminal, then paste the '
                        + 'result in the issue.'),
                    style_class: 'nvme-support-json-hint',
                });
                hint.clutter_text.line_wrap = true;
            }
            const bodyLabel = new St.Label({
                text: missing
                    ? (command || '')
                    : (jsonText.length > SUPPORT_JSON_PREVIEW_CHARS
                        ? `${jsonText.slice(0, SUPPORT_JSON_PREVIEW_CHARS)}\u2026`
                        : jsonText),
                style_class: 'nvme-support-json',
            });
            bodyLabel.reactive = true;
            const text = bodyLabel.clutter_text;
            text.reactive = true;
            text.line_wrap = false;
            text.editable = false;
            text.selectable = true;
            text.single_line_mode = false;
            // Selection colors: the default highlight is white-on-white on
            // the black area, leaving the selected text unreadable. Use a
            // light gray highlight with black text so the selection stays
            // legible in the JSON boxes.
            const selBg = new Cogl.Color({red: 211, green: 211, blue: 211, alpha: 255});
            const selText = new Cogl.Color({red: 0, green: 0, blue: 0, alpha: 255});
            text.selection_background_color = selBg;
            text.selected_text_color = selText;
            // St.ScrollView requires a StScrollable child; St.Label is not
            // one, so wrap the label in a vertical St.BoxLayout (the same
            // pattern GNOME Shell uses for its own scroll views).
            const content = new St.BoxLayout({
                vertical: true,
                style_class: 'nvme-support-json-content',
            });
            content.add_child(bodyLabel);
            const scrollView = new St.ScrollView({
                style_class: 'nvme-support-json-scroll',
                overlay_scrollbars: false,
                hscrollbar_policy: St.PolicyType.AUTOMATIC,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
            });
            scrollView.set_child(content);
            frame.add_child(header);
            if (hint)
                frame.add_child(hint);
            frame.add_child(scrollView);
            return frame;
        }

        _showCopiedFeedback(copyButton) {
            const tooltip = new St.Label({
                text: _('Copied!'),
                style_class: 'nvme-hover-tooltip',
            });
            Main.uiGroup.add_child(tooltip);
            const [bx, by] = copyButton.get_transformed_position();
            const [bw, bh] = copyButton.get_size();
            const [, tw] = tooltip.get_preferred_width(-1);
            tooltip.set_position(bx + bw / 2 - tw / 2, by - bh - 8);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1200, () => {
                tooltip.destroy();
                return GLib.SOURCE_REMOVE;
            });
        }

        _openSupportIssue() {
            try {
                Gio.AppInfo.launch_default_for_uri(SUPPORT_ISSUE_URL, null);
            } catch (e) {
                _warn(`failed to open support issue URL: ${e}`);
                notifyError(
                    _('Could not open the support issue page'),
                    SUPPORT_ISSUE_URL);
            }
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
            actor._nvmeTooltipHandlers = [enterId, leaveId];
            this._tooltipActors.push(actor);
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

        _destroyHoverTooltips() {
            for (const actor of this._tooltipActors) {
                if (actor._nvmeTooltip) {
                    actor._nvmeTooltip.destroy();
                    actor._nvmeTooltip = null;
                }
                if (actor._partitionTooltip) {
                    actor._partitionTooltip.destroy();
                    actor._partitionTooltip = null;
                }
            }
            this._tooltipActors = [];
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
            this._v2DesiredState = active;
            this._v2Toggle._state = active;
            if (this._v2Toggle._switch)
                this._v2Toggle._switch.state = active;
            _debug(`_updateV2ToggleState(${active}) — desired state updated`);
        }

        // -------------------------------------------------------------------
        // v2: open the setup-script dialog (toggle install path). The dialog
        // stays open when the pasted content is rejected; on success the
        // toggle flips on and polling starts (ui.onInstalled).
        // -------------------------------------------------------------------
        _showSetupScriptDialog() {
            this.menu.close();
            if (this._setupDialog) {
                try {
                    this._setupDialog.close();
                } catch (e) {
                    _debug(`stale setup dialog close skipped: ${e.message}`);
                }
                this._setupDialog = null;
            }
            const dialog = new SetupScriptDialog({
                attachDrag: (handle, movedActor) => this._attachDragHandler(handle, movedActor),
                loadMenuIcon: iconName => this._loadMenuIconByName(iconName),
                onRun: scriptContent => {
                    dialog.presentStep(_('Running the installer (pkexec)\u2026'));
                    const started = installV2StackFromPastedScript({
                        scriptContent,
                        wasInSmartGroup: checkCurrentUserInSmartGroup(),
                        ui: this._v2Ui(),
                    });
                    if (!started)
                        dialog.presentStep(
                            _('The script was rejected before execution.'), 'error');
                    else
                        dialog.close();
                },
                copyToClipboard: (text, button) => {
                    const clipboard = St.Clipboard.get_default();
                    clipboard.set_text(St.ClipboardType.CLIPBOARD, text || '');
                    this._showCopiedFeedback(button);
                },
            });
            dialog.openNonModal();
            this._setupDialog = dialog;
            // Drop the reference when the dialog is destroyed (closed), so a
            // late fetch callback never touches destroyed St.Labels (which
            // triggers spurious clutter_actor_allocate warnings).
            dialog.connect('destroy', () => {
                if (this._setupDialog === dialog)
                    this._setupDialog = null;
            });
            fetchSetupScript().then(content => {
                if (dialog !== this._setupDialog)
                    return;
                const {status} = checkSetupScriptHash(computeSha256(content));
                _debug(`setup script fetch: sha256 status=${status}`);
                dialog.presentFetchedScript(content, status);
            }).catch(e => {
                _warn(`setup script fetch failed: ${e.message}`);
                if (dialog === this._setupDialog)
                    dialog.presentFetchError(e.message);
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
            this._destroyHoverTooltips();
            this._hideExplanationOverlay();
            this._stopAllCriticalTimers();
            this._stopPolling();
            super.destroy();
        }    }
);

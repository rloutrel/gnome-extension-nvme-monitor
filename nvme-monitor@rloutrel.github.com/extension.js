import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {_debug} from './logger.js';
import {checkV2Installed, checkNvmeCliVersion} from './subprocess.js';
import {Indicator} from './indicator.js';
// Import temperature unit handling (pure, unit-tested).
import {detectTemperatureUnit} from './tempUnit.js';

export default class IndicatorExampleExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this.initTranslations();
    }

    enable() {
        _debug('enable() enter');
        this._indicator = new Indicator({
            extensionPath: this.path,
            openPreferences: () => this.openPreferences(),
        });
        this._indicator._setupIcon();
        this._indicator._checkSetupScript();
        // Restore the persisted rolling temperature history from /tmp so a
        // restart keeps the recent 30-minute curve.
        this._indicator._loadTempHistory();
        // Detect the installed nvme-cli version once and warn if affected.
        checkNvmeCliVersion(GLib.find_program_in_path('nvme'));
        // Start polling if the polkit stack is already installed.
        if (checkV2Installed()) {
            this._indicator._startPolling();
        }
        this._loadSettings();
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        // Load extension stylesheet (device header, meta lines, smart values)
        this._stylesheet = Gio.File.new_for_path(GLib.build_filenamev([this.path, 'stylesheet.css']));
        St.ThemeContext.get_for_stage(global.stage).get_theme().load_stylesheet(this._stylesheet);
        _debug('enable() exit');
    }

    // Load GSettings; pre-fill the temperature unit from the session locale
    // on first launch, then keep the indicator in sync with the stored value.
    _loadSettings() {
        this._settings = this.getSettings();
        if (!this._settings.get_boolean('unit-initialized')) {
            const detected = detectTemperatureUnit(GLib.getenv);
            this._settings.set_string('temperature-unit', detected);
            this._settings.set_boolean('unit-initialized', true);
            _debug(`temperature unit pre-filled from locale: ${detected}`);
        }
        this._indicator._tempUnit = this._settings.get_string('temperature-unit');
        this._settingsId = this._settings.connect('changed::temperature-unit', (settings) => {
            this._indicator._tempUnit = settings.get_string('temperature-unit');
            this._indicator._refreshDevices();
        });
    }

    disable() {
        _debug('disable() enter');
        if (this._stylesheet) {
            St.ThemeContext.get_for_stage(global.stage).get_theme().unload_stylesheet(this._stylesheet);
            this._stylesheet = null;
        }
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        if (this._settingsId) {
            this._settings.disconnect(this._settingsId);
            this._settingsId = null;
        }
        this._settings = null;
        _debug('disable() exit');
    }
}

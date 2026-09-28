// Preferences page for the NVMe Monitor extension.
// Runs in a separate GTK4/Adwaita process, without access to GNOME Shell.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    TEMP_UNIT_CELSIUS,
    TEMP_UNIT_FAHRENHEIT,
} from './tempUnit.js';

export default class NvmeMonitorPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const group = new Adw.PreferencesGroup({
            title: _('Temperature'),
            description: _('Unit used to display drive temperatures'),
        });
        page.add(group);

        const celsiusRow = new Adw.ActionRow({
            title: `Celsius (\u00b0C)`,
        });
        const celsiusCheck = new Gtk.CheckButton();
        celsiusCheck.valign = Gtk.Align.CENTER;
        celsiusRow.add_prefix(celsiusCheck);
        celsiusCheck.connect('toggled', () => {
            if (celsiusCheck.active)
                settings.set_string('temperature-unit', TEMP_UNIT_CELSIUS);
        });
        group.add(celsiusRow);

        const fahrenheitRow = new Adw.ActionRow({
            title: `Fahrenheit (\u00b0F)`,
        });
        const fahrenheitCheck = new Gtk.CheckButton({
            group: celsiusCheck,
        });
        fahrenheitCheck.valign = Gtk.Align.CENTER;
        fahrenheitRow.add_prefix(fahrenheitCheck);
        fahrenheitCheck.connect('toggled', () => {
            if (fahrenheitCheck.active)
                settings.set_string('temperature-unit', TEMP_UNIT_FAHRENHEIT);
        });
        group.add(fahrenheitRow);

        const syncRows = () => {
            const unit = settings.get_string('temperature-unit');
            celsiusCheck.active = unit === TEMP_UNIT_CELSIUS;
            fahrenheitCheck.active = unit === TEMP_UNIT_FAHRENHEIT;
        };
        settings.connect('changed::temperature-unit', syncRows);
        syncRows();

        const creditsGroup = new Adw.PreferencesGroup({
            title: _('Credits'),
        });
        page.add(creditsGroup);

        const creditsRow = new Adw.ActionRow({
            title: _('Assisted by'),
        });
        const mistralLink = new Gtk.Label({
            label: `<a href="https://mistral.ai">Mistral Code</a>`,
            use_markup: true,
            valign: Gtk.Align.CENTER,
        });
        creditsRow.add_suffix(mistralLink);
        creditsGroup.add(creditsRow);
    }
}

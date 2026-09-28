// Bundled SVG icon registry (icons/bootstrap/) and GJS icon helpers.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

// Bundled SVG icons (shipped in icons/bootstrap/) referenced by bare name.
// System fallback (not bundled) for the panel placeholder.
//
// Each menu icon has a paired `-dark` variant (white fill) shipped beside it.
// On a dark GNOME menu/panel the theme-aware `currentColor` icons render dark
// and become invisible; the white-fill `-dark` SVGs stay visible there.
// The panel already uses ICONS.NvmeDark directly; the menu resolves the
// `-dark` variant first and falls back to the base icon when missing.
export const ICONS = Object.freeze({
    NvmeDark: 'nvme-dark',
    Nvme: 'nvme',
    ThermometerLow: 'thermometer-low',
    ThermometerLowDark: 'thermometer-low-dark',
    ThermometerHalf: 'thermometer-half',
    ThermometerHalfDark: 'thermometer-half-dark',
    ThermometerHigh: 'thermometer-high',
    ThermometerHighDark: 'thermometer-high-dark',
    Plug: 'plugin',
    PlugDark: 'plugin-dark',
    Database: 'database',
    DatabaseDark: 'database-dark',
    ArrowLeftRight: 'arrow-left-right',
    ArrowLeftRightDark: 'arrow-left-right-dark',
    Eyeglasses: 'eyeglasses',
    EyeglassesDark: 'eyeglasses-dark',
    VectorPen: 'vector-pen',
    VectorPenDark: 'vector-pen-dark',
    Gear: 'gear',
    GearDark: 'gear-dark',
    PanelFallback: 'drive-harddisk-symbolic',
});

// Maps a base menu icon name to its white-fill `-dark` counterpart, used to
// keep icons visible on a dark menu/panel surface. Add new pairs here as
// `-dark` variants are shipped in icons/bootstrap/.
export const DARK_ICON_VARIANTS = Object.freeze({
    [ICONS.Nvme]: ICONS.NvmeDark,
    [ICONS.ThermometerLow]: ICONS.ThermometerLowDark,
    [ICONS.ThermometerHalf]: ICONS.ThermometerHalfDark,
    [ICONS.ThermometerHigh]: ICONS.ThermometerHighDark,
    [ICONS.Plug]: ICONS.PlugDark,
    [ICONS.Database]: ICONS.DatabaseDark,
    [ICONS.ArrowLeftRight]: ICONS.ArrowLeftRightDark,
    [ICONS.Eyeglasses]: ICONS.EyeglassesDark,
    [ICONS.VectorPen]: ICONS.VectorPenDark,
    [ICONS.Gear]: ICONS.GearDark,
});

// Build a Gio.FileIcon from an absolute path, or null if the file is missing.
export function fileIcon(iconPath) {
    if (!GLib.file_test(iconPath, GLib.FileTest.EXISTS)) return null;
    return new Gio.FileIcon({file: Gio.File.new_for_path(iconPath)});
}

/**
 * Temperature display formatting — pure module (no GJS imports).
 *
 * Manufacturer-specific temperature line formatting for the NVMe monitor.
 * Exported so it can be unit-tested with Node's built-in test runner.
 *
 * Translatable labels ("Controller", "NAND", "Sensor") are passed in by the
 * caller via the `labels` option so this module stays free of gettext. When
 * omitted, English defaults are used (preserving the existing test suite).
 */

// Default English labels, used when no `labels` option is provided (e.g.
// unit tests) or when a requested label is missing.
const DEFAULT_LABELS = {
    controller: 'Controller',
    nand: 'NAND',
    sensor: 'Sensor',
};

// Resolve the label set, filling missing keys with the English defaults.
function resolveLabels(labels) {
    return Object.assign({}, DEFAULT_LABELS, labels || {});
}

// Format a single temperature value with one decimal place using a French
// decimal comma (e.g. 42 -> "42,0", 42.5 -> "42,5"). Returns '?' for
// null/undefined so a missing sensor still renders a readable placeholder.
export function formatTempCelsius(tempC) {
    if (tempC === null || tempC === undefined) return '?';
    return Number(tempC).toFixed(1).replace('.', ',');
}

// Build the main composite temperature line, appending manufacturer-specific
// sensor information when available.
//
// Samsung with >= 2 sensors appends controller + NAND:
//   "42,0°C (Controller: 41,0°C; NAND: 45,0°C)"
// Other manufacturers with sensors append them generically as "Sensor N":
//   "42,0°C (Sensor 1: 41,0°C; Sensor 2: 45,0°C)"
// No sensors → just the composite: "42,0°C"
//
// `labels` (optional): { controller, nand, sensor } translated labels.
export function formatTemperatureLine(manufacturer, composite, sensors, labels) {
    if (composite === null || composite === undefined) return null;

    const L = resolveLabels(labels);
    let line = `${formatTempCelsius(composite)}\u00b0C`;

    const sensorList = sensors || [];
    let detail = '';

    if (manufacturer === 'Samsung' && sensorList.length >= 2) {
        detail = `${L.controller}: ${formatTempCelsius(sensorList[0])}\u00b0C; ${L.nand}: ${formatTempCelsius(sensorList[1])}\u00b0C`;
    } else if (sensorList.length > 0) {
        const parts = sensorList.map((t, i) => `${L.sensor} ${i + 1}: ${formatTempCelsius(t)}\u00b0C`);
        detail = parts.join('; ');
    }

    if (detail) {
        line += ` (${detail})`;
    }
    return line;
}

// Build per-sensor detail rows for manufacturers that show sensors as
// separate menu lines (currently: non-Samsung drives with sensors).
// Returns an array of { text, temp } pairs (temp may be null/undefined),
// empty when none. The caller computes the icon/style from `temp`.
//
// `labels` (optional): { sensor } translated label.
export function formatSensorRows(manufacturer, sensors, labels) {
    const sensorList = sensors || [];
    if (manufacturer === 'Samsung' || sensorList.length === 0) {
        return [];
    }
    const L = resolveLabels(labels);
    return sensorList.map((t, i) => ({
        text: `  ${L.sensor} ${i + 1}: ${formatTempCelsius(t)}\u00b0C`,
        temp: t,
    }));
}

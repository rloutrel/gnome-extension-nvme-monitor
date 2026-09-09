/**
 * Temperature display formatting — pure module (no GJS imports).
 *
 * Manufacturer-specific temperature line formatting for the NVMe monitor.
 * Exported so it can be unit-tested with Node's built-in test runner.
 */

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
export function formatTemperatureLine(manufacturer, composite, sensors) {
    if (composite === null || composite === undefined) return null;

    let line = `${formatTempCelsius(composite)}°C`;

    const sensorList = sensors || [];
    let detail = '';

    if (manufacturer === 'Samsung' && sensorList.length >= 2) {
        detail = `Controller: ${formatTempCelsius(sensorList[0])}°C; NAND: ${formatTempCelsius(sensorList[1])}°C`;
    } else if (sensorList.length > 0) {
        const parts = sensorList.map((t, i) => `Sensor ${i + 1}: ${formatTempCelsius(t)}°C`);
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
export function formatSensorRows(manufacturer, sensors) {
    const sensorList = sensors || [];
    if (manufacturer === 'Samsung' || sensorList.length === 0) {
        return []
    }
    return sensorList.map((t, i) => ({
        text: `  Sensor ${i + 1}: ${formatTempCelsius(t)}°C`,
        temp: t,
    }));
}

/**
 * Temperature unit handling — pure module (no GJS imports).
 *
 * Unit conversion and locale-based detection for the NVMe monitor.
 * Exported so it can be unit-tested with Node's built-in test runner.
 * The environment accessor is injected by the caller so this module
 * stays free of GLib imports.
 */

export const TEMP_UNIT_CELSIUS = 'celsius';
export const TEMP_UNIT_FAHRENHEIT = 'fahrenheit';

// Convert a Celsius temperature to Fahrenheit.
export function celsiusToFahrenheit(tempC) {
    return tempC * 9 / 5 + 32;
}

// Convert an internal (always Celsius) temperature to the display unit.
// Returns null for null/undefined input so callers can render a placeholder.
export function toDisplayTemp(tempC, unit) {
    if (tempC === null || tempC === undefined) return null;
    const value = Number(tempC);
    return unit === TEMP_UNIT_FAHRENHEIT ? celsiusToFahrenheit(value) : value;
}

// Degree suffix for a display unit ('\u00b0C' or '\u00b0F').
export function tempSuffix(unit) {
    return unit === TEMP_UNIT_FAHRENHEIT ? '\u00b0F' : '\u00b0C';
}

// Whether `unit` is one of the supported temperature units.
export function isValidUnit(unit) {
    return unit === TEMP_UNIT_CELSIUS || unit === TEMP_UNIT_FAHRENHEIT;
}

// Detect the temperature unit from the session locale.
//
// glibc resolves LC_MEASUREMENT through, in order: LC_MEASUREMENT,
// LC_ALL, LC_CTYPE, LANG. The only metric-system holdouts relevant to
// temperature are US locales, so any non-US locale maps to Celsius and
// a US locale maps to Fahrenheit. Falls back to Celsius when no
// locale is set or it is the neutral 'C'/'POSIX'.
//
// `getenvFn` is an environment accessor such as GLib.getenv; injected
// so this module stays testable under plain Node.
export function detectTemperatureUnit(getenvFn) {
    const candidates = [
        getenvFn('LC_MEASUREMENT'),
        getenvFn('LC_ALL'),
        getenvFn('LC_CTYPE'),
        getenvFn('LANG'),
    ];
    const lc = candidates.find(v => v && v !== 'C' && v !== 'POSIX') || '';
    return /(^|_)(us|US)$/.test(lc.split('.')[0].replace(/[^a-zA-Z_]/g, ''))
        ? TEMP_UNIT_FAHRENHEIT
        : TEMP_UNIT_CELSIUS;
}

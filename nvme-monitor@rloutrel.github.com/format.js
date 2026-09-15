// ---------------------------------------------------------------------------
// Human-readable formatting helpers for NVMe SMART endurance values.
//
// Pure module: zero GJS/GObject imports. Unit-tested under Node.
// ---------------------------------------------------------------------------

// NVMe SMART data units are counted in 512000-byte units (Log Page 02h).
const DATA_UNIT_BYTES = 512000;
const GIB_BYTES = 1024 ** 3;
const TIB_BYTES = 1024 ** 4;

/**
 * Format a large count with a compact SI-like suffix (K, M, G, T, P).
 * Used for host read/write command counts.
 * @param {number|null|undefined} value
 * @returns {string}
 */
export function formatCompactNumber(value) {
    if (value === null || value === undefined) return '';
    const n = Number(value);
    if (!Number.isFinite(n)) return String(value);
    if (n < 1000) return String(n);
    const units = ['', 'K', 'M', 'G', 'T', 'P'];
    let tier = Math.floor(Math.log10(n) / 3);
    if (tier >= units.length) tier = units.length - 1;
    const scaled = n / 1000 ** tier;
    const str = scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(scaled >= 10 ? 1 : 2);
    return `${str}${units[tier]}`;
}

/**
 * Convert NVMe SMART data_units_read / data_units_written into a human-
 * readable size (MiB / GiB / TiB).
 * @param {number|null|undefined} units
 * @returns {string}
 */
export function formatDataUnits(units) {
    if (units === null || units === undefined) return '';
    const bytes = units * DATA_UNIT_BYTES;
    if (bytes >= TIB_BYTES) return `${(bytes / TIB_BYTES).toFixed(2)} TiB`;
    if (bytes >= GIB_BYTES) return `${(bytes / GIB_BYTES).toFixed(1)} GiB`;
    return `${(bytes / (1024 ** 2)).toFixed(0)} MiB`;
}

/**
 * Format power-on hours as a compact duration: "2y 50d", "2d 0h", or "5h".
 * @param {number|null|undefined} hours
 * @returns {string}
 */
export function formatPowerOnHours(hours) {
    if (hours === null || hours === undefined) return '';
    const h = Number(hours);
    if (!Number.isFinite(h)) return `${hours}h`;
    const days = Math.floor(h / 24);
    const years = Math.floor(days / 365);
    const remDays = days % 365;
    if (years > 0) return `${years}y ${remDays}d`;
    if (days > 0) return `${days}d ${h % 24}h`;
    return `${h}h`;
}

// Thresholds for the Available Spare gauge color code (percent).
const SPARE_RED = 15;
const SPARE_ORANGE = 50;

// Thresholds for the Lifetime Used gauge color code (percent).
// The logic is inverted relative to Available Spare: high usage is bad.
const USED_ORANGE = 50;
const USED_RED = 85;

// RGB triples (0-1) for the gauge segments.
const COLOR_RED = [0.75, 0.11, 0.14];
const COLOR_ORANGE = [0.88, 0.48, 0.14];
const COLOR_GREEN = [0.18, 0.68, 0.34];
const COLOR_TRACK = [0.2, 0.2, 0.2];

/**
 * Available Spare gauge color: red below 15%, orange below 50%, else green.
 * @param {number} percent
 * @returns {number[]} [r, g, b]
 */
export function spareGaugeColor(percent) {
    if (percent < SPARE_RED) return COLOR_RED;
    if (percent < SPARE_ORANGE) return COLOR_ORANGE;
    return COLOR_GREEN;
}

/**
 * Lifetime Used gauge color: red above 85%, orange above 50%, else green
 * (inverted logic).
 * @param {number} percent
 * @returns {number[]} [r, g, b]
 */
export function usedGaugeColor(percent) {
    if (percent >= USED_RED) return COLOR_RED;
    if (percent >= USED_ORANGE) return COLOR_ORANGE;
    return COLOR_GREEN;
}

/**
 * Format a duration in milliseconds as a compact string: "1m 5s", "42s",
 * "0s". Values under a second round up to 1s so a tiny non-zero duration is
 * still visible.
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatDurationMs(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '0s';
    const totalS = Math.round(ms / 1000);
    if (totalS <= 0) return ms > 0 ? '1s' : '0s';
    const minutes = Math.floor(totalS / 60);
    const seconds = totalS % 60;
    if (minutes > 0) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
    return `${seconds}s`;
}

// Temperature tier thresholds (°C) for the line-graph color coding. These
// mirror the heuristic tiers in extension.js (TEMP_WARM_C / TEMP_HOT_C); the
// red tier is also taken when the drive signals over-temperature via its
// critical_warning bit 1.
const TEMP_WARM_C = 50;
const TEMP_HOT_C = 70;

/**
 * Color for a temperature reading, mirroring the menu thermometer tiers.
 * Pass the raw critical_warning byte so the manufacturer-true over-temperature
 * signal drives the red tier rather than a guessed °C value.
 *
 * @param {number|null|undefined} tempCelsius
 * @param {number} [criticalWarning] - Raw NVMe SMART critical_warning byte.
 * @returns {number[]} [r, g, b]
 */
export function tempTierColor(tempCelsius, criticalWarning = 0) {
    if (tempCelsius === null || tempCelsius === undefined) return COLOR_TRACK;
    if (criticalWarning & 0x02) return COLOR_RED;
    if (tempCelsius < TEMP_WARM_C) return COLOR_GREEN;
    if (tempCelsius < TEMP_HOT_C) return COLOR_ORANGE;
    return COLOR_RED;
}

export { COLOR_TRACK, COLOR_RED, COLOR_ORANGE, COLOR_GREEN };


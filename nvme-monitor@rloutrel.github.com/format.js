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

/**
 * Rolling per-device temperature history (last 10 minutes).
 *
 * Pure module: no GJS/GObject imports, so it can be unit-tested with Node.
 *
 * The extension captures a temperature reading on every poll and stores it
 * here, keyed by device path. Each reading is a compact object:
 *   { t: number (ms epoch), c: number|null (composite °C), s: number[] (sensors °C) }
 *
 * Entries older than the rolling window (default 10 minutes) are pruned on
 * insert and on load, so the structure always represents roughly "the last
 * 10 minutes".
 *
 * Persistence is delegated to the caller: serialize() returns a JSON string
 * the caller writes to /tmp, and deserialize() rebuilds from that string.
 */

const DEFAULT_WINDOW_MS = 600_000;

/**
 * Per-device rolling temperature history.
 *
 * @typedef {Object} TempReading
 * @property {number} t  - Capture timestamp, ms since epoch.
 * @property {number|null} c - Composite temperature in °C (null when unavailable).
 * @property {number[]} s  - Per-sensor temperatures in °C (empty when none).
 */
export class TempHistory {
    /**
     * @param {Object} [options]
     * @param {number} [options.windowMs=600000] - Rolling window length in ms.
     */
    constructor({ windowMs = DEFAULT_WINDOW_MS } = {}) {
        this._windowMs = windowMs > 0 ? windowMs : DEFAULT_WINDOW_MS;
        /** @type {Map<string, TempReading[]>} devicePath -> readings (oldest..newest) */
        this._devices = new Map();
    }

    /**
     * Append a reading for a device and prune anything older than the window.
     * `now` defaults to the reading timestamp; pass an explicit ms epoch to
     * prune relative to a different reference time (e.g. on reload).
     *
     * @param {string} devicePath
     * @param {TempReading} reading
     * @param {number} [now]
     */
    add(devicePath, reading, now) {
        if (!devicePath || !reading) return;
        const ref = now !== undefined && now !== null ? now : reading.t;
        let list = this._devices.get(devicePath);
        if (!list) {
            list = [];
            this._devices.set(devicePath, list);
        }
        list.push(reading);
        this._prune(list, ref);
    }

    /**
     * Return a shallow copy of the readings for a device (oldest..newest),
     * or an empty array when the device is unknown.
     *
     * @param {string} devicePath
     * @returns {TempReading[]}
     */
    get(devicePath) {
        const list = this._devices.get(devicePath);
        return list ? list.slice() : [];
    }

    /**
     * Return the latest reading for a device, or null when none.
     * @param {string} devicePath
     * @returns {TempReading|null}
     */
    latest(devicePath) {
        const list = this._devices.get(devicePath);
        if (!list || list.length === 0) return null;
        return list[list.length - 1];
    }

    /**
     * Return the min and max composite temperature over the window for a
     * device, based on the readings currently kept. Returns null when the
     * device has no usable (finite, non-null) readings.
     *
     * @param {string} devicePath
     * @returns {{min: number, max: number}|null}
     */
    range(devicePath) {
        const list = this._devices.get(devicePath);
        if (!list || list.length === 0) return null;
        let min = Infinity;
        let max = -Infinity;
        for (const r of list) {
            if (r.c === null || r.c === undefined || !Number.isFinite(r.c)) continue;
            if (r.c < min) min = r.c;
            if (r.c > max) max = r.c;
        }
        if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
        return { min, max };
    }

    /**
     * List the device paths that currently have history.
     * @returns {string[]}
     */
    devices() {
        return [...this._devices.keys()];
    }

    /**
     * Drop all readings older than the window for every device, relative to
     * `now` (ms epoch). Useful after loading stale persisted data.
     *
     * @param {number} now - Reference time, ms since epoch.
     */
    pruneStale(now) {
        for (const list of this._devices.values()) {
            this._prune(list, now);
        }
        // Drop devices left empty after pruning.
        for (const [path, list] of this._devices.entries()) {
            if (list.length === 0) this._devices.delete(path);
        }
    }

    /**
     * Remove the history for a single device.
     * @param {string} devicePath
     */
    remove(devicePath) {
        this._devices.delete(devicePath);
    }

    /**
     * Clear all history for all devices.
     */
    clear() {
        this._devices.clear();
    }

    /**
     * Serialize the whole history to a JSON string for /tmp persistence.
     * @returns {string}
     */
    serialize() {
        const devices = {};
        for (const [path, list] of this._devices.entries()) {
            devices[path] = list;
        }
        return JSON.stringify({ windowMs: this._windowMs, devices });
    }

    /**
     * Rebuild a TempHistory from a JSON string produced by serialize().
     * Readings older than the window are pruned relative to `now` (ms epoch);
     * omit `now` to keep everything (e.g. tests).
     *
     * @param {string} str
     * @param {number} [now] - Reference time, ms since epoch, for stale pruning.
     * @returns {TempHistory}
     */
    static deserialize(str, now) {
        const parsed = JSON.parse(str);
        const windowMs = Number.isFinite(parsed?.windowMs) && parsed.windowMs > 0
            ? parsed.windowMs
            : DEFAULT_WINDOW_MS;
        const h = new TempHistory({ windowMs });
        const devices = parsed?.devices || {};
        for (const [path, list] of Object.entries(devices)) {
            if (Array.isArray(list)) h._devices.set(path, list);
        }
        if (now !== undefined && now !== null) h.pruneStale(now);
        return h;
    }

    /**
     * Prune the front of `list`, dropping readings older than the window
     * relative to `ref` (ms epoch).
     */
    _prune(list, ref) {
        const cutoff = ref - this._windowMs;
        while (list.length > 0 && list[0].t < cutoff) list.shift();
    }
}

export const TEMP_HISTORY_WINDOW_MS = DEFAULT_WINDOW_MS;

/**
 * Compute the total time the composite temperature spent at or above each of
 * the given thresholds over the window, using linear interpolation between
 * consecutive usable readings to account for variable sampling rates.
 *
 * For each pair of consecutive readings (a, b) with finite composite temps,
 * the segment between them is traversed; the fraction of the segment at or
 * above a threshold is determined by linear interpolation of the crossing
 * point, and that fraction of the segment duration is added to that
 * threshold's total. Readings with null/undefined/non-finite composite are
 * skipped (segments crossing them are not counted).
 *
 * @param {TempReading[]} readings - Readings for a device (oldest..newest).
 * @param {number[]} thresholds - Threshold values in °C (any order).
 * @returns {Object<number, number>} Map threshold -> ms spent at/above it.
 */
export function computeTimeAboveThresholds(readings, thresholds) {
    const result = {};
    for (const th of thresholds) result[th] = 0;

    const list = Array.isArray(readings) ? readings : [];
    for (let i = 1; i < list.length; i++) {
        const a = list[i - 1];
        const b = list[i];
        if (a.c === null || a.c === undefined || !Number.isFinite(a.c)) continue;
        if (b.c === null || b.c === undefined || !Number.isFinite(b.c)) continue;
        const dt = b.t - a.t;
        if (dt <= 0) continue;
        const ta = a.c;
        const tb = b.c;
        for (const th of thresholds) {
            const aAbove = ta >= th;
            const bAbove = tb >= th;
            if (aAbove && bAbove) {
                result[th] += dt;
            } else if (aAbove || bAbove) {
                // Crossing: interpolate the crossing time fraction.
                const crossFrac = (th - ta) / (tb - ta);
                const aboveFrac = aAbove ? crossFrac : (1 - crossFrac);
                result[th] += aboveFrac * dt;
            }
        }
    }
    return result;
}

/**
 * Determine which thresholds were crossed (reached at least once) by the
 * composite temperature over the window.
 *
 * @param {TempReading[]} readings - Readings for a device (oldest..newest).
 * @param {number[]} thresholds - Threshold values in °C.
 * @returns {number[]} Thresholds crossed at least once (original order).
 */
export function crossedThresholds(readings, thresholds) {
    const list = Array.isArray(readings) ? readings : [];
    const crossed = [];
    for (const th of thresholds) {
        let found = false;
        for (const r of list) {
            if (r.c !== null && r.c !== undefined && Number.isFinite(r.c) && r.c >= th) {
                found = true;
                break;
            }
        }
        if (found) crossed.push(th);
    }
    return crossed;
}

/**
 * NVMe firmware registry helpers — PURE module.
 *
 * The validated-devices registry keys entries by ModelNumber (the
 * human-readable identity), but the authoritative unit inside an entry
 * is the hardware revision: manufacturers ship different controller
 * revisions under the same model name (e.g. Samsung SSD 970 EVO Plus
 * 2TB exists with a Phoenix controller, PCI device 0xa808, firmware
 * 2B2QEXM7, and an Elpis revision with its own 4B2QEXM7 line), so
 * `confirmed` and `latestFirmware` live per revision in a `revisions`
 * array keyed by the controller's PCI device ID (readable unprivileged
 * from sysfs).
 *
 * Every accessor returns a "no data" value (null / 'unknown') whenever
 * no revision matches the drive, so callers apply the "do nothing
 * when unknown" rule instead of guessing.
 */

/**
 * Normalize a PCI device ID to the lowercase '0x...' form used in the
 * registry. Accepts 'a808', '0xa808', '0xA808', 43016 (number).
 *
 * @param {string|number} pciDeviceId
 * @returns {string} normalized ID, or '' when unparseable
 */
export function normalizePciDeviceId(pciDeviceId) {
    if (pciDeviceId === null || pciDeviceId === undefined)
        return '';
    let raw = String(pciDeviceId).trim().toLowerCase();
    if (raw === '')
        return '';
    if (!raw.startsWith('0x')) {
        const n = Number(raw);
        if (Number.isInteger(n) && n >= 0)
            raw = '0x' + n.toString(16);
        else
            raw = '0x' + raw;
    }
    return raw;
}

/**
 * Registry revision entry matching the drive's controller PCI device ID.
 *
 * @param {Object} entry - Validated-devices registry entry
 *   ({manufacturer, revisions: [{pciDeviceId, confirmed, latestFirmware}]}).
 * @param {string} [pciDeviceId] - Controller PCI device ID (e.g. '0xa808').
 * @returns {Object|null} the matching revision entry, or null when the
 *   entry has no revisions or none matches.
 */
export function findRevision(entry, pciDeviceId) {
    if (!entry || !Array.isArray(entry.revisions))
        return null;
    const wanted = normalizePciDeviceId(pciDeviceId);
    if (wanted === '')
        return null;
    for (const rev of entry.revisions) {
        if (rev && typeof rev === 'object' &&
            normalizePciDeviceId(rev.pciDeviceId) === wanted)
            return rev;
    }
    return null;
}

/**
 * Support level for a device against the registry, revision-aware.
 * Companion to smartParser.js getSupportLevel(), which keeps the
 * legacy ModelNumber-only behaviour for entries without `revisions`.
 *
 * @param {Object} entry - Validated-devices registry entry.
 * @param {string} pciDeviceId - Controller PCI device ID.
 * @returns {string} 'validated' (this exact revision is confirmed
 *   working), 'confirm' (the model is known but this hardware revision
 *   is not in the registry: ask the user to report it, orange '!') or
 *   'unknown' (no registry entry for the model at all).
 */
export function getRevisionSupportLevel(entry, pciDeviceId) {
    if (!entry || !Array.isArray(entry.revisions) || entry.revisions.length === 0)
        return 'unknown';
    const rev = findRevision(entry, pciDeviceId);
    if (!rev)
        return 'confirm';
    return rev.confirmed === true ? 'validated' : 'confirm';
}

/**
 * Last known firmware version for a registry entry's revision.
 *
 * @param {Object} entry - Validated-devices registry entry.
 * @param {string} [pciDeviceId] - Controller PCI device ID used to
 *   select the revision. A legacy single-string `latestFirmware` on
 *   the entry still applies to any revision.
 * @returns {string|null} the firmware version, or null when no
 *   revision matches or no version is filled.
 */
export function getLatestFirmware(entry, pciDeviceId) {
    if (!entry || typeof entry !== 'object')
        return null;
    if (typeof entry.latestFirmware === 'string') {
        const v = entry.latestFirmware.trim();
        return v === '' ? null : v;
    }
    const rev = findRevision(entry, pciDeviceId);
    if (rev && typeof rev.latestFirmware === 'string') {
        const v = rev.latestFirmware.trim();
        return v === '' ? null : v;
    }
    return null;
}

/**
 * Firmware state for a detected drive, comparing the firmware reported
 * by `nvme list` with the last known version from the registry.
 *
 * @param {Object} entry - Validated-devices registry entry.
 * @param {string} currentFirmware - Firmware reported by nvme list.
 * @param {string} [pciDeviceId] - Controller PCI device ID used to
 *   select the revision.
 * @returns {string} 'unknown' (no registry data, nothing to do),
 *   'current' (matches the last known version) or 'outdated'.
 */
export function assessFirmware(entry, currentFirmware, pciDeviceId) {
    const latest = getLatestFirmware(entry, pciDeviceId);
    if (latest === null)
        return 'unknown';
    const current = String(currentFirmware || '').trim();
    if (current === '')
        return 'unknown';
    return current === latest ? 'current' : 'outdated';
}

/**
 * nvme-cli version detection helpers.
 *
 * Pure module: no GJS imports, so it can be unit-tested with Node.
 *
 * Background — two nvme-cli software bugs affect this extension:
 *
 *  Bug A (int32 overflow): `nvme list -o json` reports negative
 *    `UsedBytes`/`PhysicalSize` (e.g. -2147483648).  Fixed in
 *    nvme-cli 2.3 / libnvme 1.3.
 *
 *  Bug B (JSON format change): `nvme list -o json` switched from the
 *    flat `.Devices[].DevicePath` layout to the nested
 *    `.Devices[].Subsystems[].Controllers[].Namespaces[]` layout in
 *    2.11.  It was reverted in 2.13, but the nested layout is back for
 *    good in 3.0+.  This extension parses the flat layout.
 *    Reference: https://github.com/linux-nvme/nvme-cli/issues/2749
 *
 * The extension now parses both layouts, so Bug B no longer breaks
 * device listing.  We still warn affected users because the flat
 * `nvme list` output they relied on historically changed, and because
 * newer nvme-cli versions are worth installing.
 */

// nvme-cli release whose JSON `list` output reverted to the flat format.
export const FLAT_FORMAT_RESTORED = '2.13';

// First nvme-cli release that reintroduced the nested `list` JSON layout.
export const NESTED_FORMAT_REINTRODUCED = '3.0';

// Issue documenting the `nvme list -o json` format change.
export const FORMAT_CHANGE_ISSUE_URL =
    'https://github.com/linux-nvme/nvme-cli/issues/2749';

// nvme-cli release that fixed the int32 `UsedBytes`/`PhysicalSize` overflow.
export const BYTES_OVERFLOW_FIXED = '2.3';

/**
 * Parse the `nvme version` output into a [major, minor, patch] tuple.
 *
 * `nvme version` prints (since the 2.x series):
 *
 *     nvme version 2.3 (git 2.3)
 *     libnvme version 1.3 (git 1.3)
 *
 * and on the 1.x series:
 *
 *     nvme-1.14
 *
 * Both shapes are handled.  Pre-release suffixes (e.g. `3.0-rc1`,
 * `3.0-b.5`) are stripped before parsing.
 *
 * @param {string} output - Raw `nvme version` stdout.
 * @returns {number[]|null} [major, minor, patch] or null if unparseable.
 */
export function parseNvmeVersion(output) {
    if (!output) return null;

    const lines = output.split('\n');
    for (const line of lines) {
        if (!line) continue;

        // 2.x shape: "nvme version 2.3 (git 2.3)"
        const m2 = line.match(/\bnvme\b[^\d]*(\d+(?:\.\d+){0,2})/i);
        if (m2) {
            return versionToTuple(m2[1]);
        }
        // 1.x shape: "nvme-1.14"
        const m1 = line.match(/nvme-(\d+(?:\.\d+){0,2})/i);
        if (m1) {
            return versionToTuple(m1[1]);
        }
    }
    return null;
}

function versionToTuple(version) {
    if (!version) return null;
    // Strip pre-release suffix: "3.0-rc1" → "3.0", "2.0-b.5" → "2.0".
    const base = String(version).split(/[-+]/)[0];
    const parts = base.split('.').map(p => {
        const n = parseInt(p, 10);
        return Number.isNaN(n) ? 0 : n;
    });
    while (parts.length < 3) parts.push(0);
    return parts.slice(0, 3);
}

/**
 * Compare two version tuples.
 * @returns {number} -1, 0, or 1.
 */
export function compareVersions(a, b) {
    const ta = Array.isArray(a) ? a : versionToTuple(a);
    const tb = Array.isArray(b) ? b : versionToTuple(b);
    if (!ta || !tb) return 0;
    for (let i = 0; i < 3; i++) {
        if (ta[i] < tb[i]) return -1;
        if (ta[i] > tb[i]) return 1;
    }
    return 0;
}

/**
 * Determine whether the detected nvme-cli version is affected by the
 * `nvme list -o json` format change (Bug B).
 *
 * Affected ranges:
 *   - 2.11 up to and including 2.12 (nested layout, before the revert)
 *   - 3.0 and newer (nested layout reintroduced)
 *
 * @param {number[]} version - [major, minor, patch] from parseNvmeVersion.
 * @returns {boolean}
 */
export function isFormatChangeAffected(version) {
    if (!version) return false;
    // 3.0+ — nested layout reintroduced.
    if (compareVersions(version, NESTED_FORMAT_REINTRODUCED) >= 0) {
        return true;
    }
    // 2.11–2.12 — nested layout before the 2.13 revert.
    if (version[0] === 2 && (version[1] === 11 || version[1] === 12)) {
        return true;
    }
    return false;
}

/**
 * Determine whether the detected nvme-cli version is affected by the
 * `UsedBytes`/`PhysicalSize` int32 overflow (Bug A).
 *
 * Affected: nvme-cli 2.0–2.2.  Fixed in 2.3 / libnvme 1.3.
 *
 * @param {number[]} version - [major, minor, patch] from parseNvmeVersion.
 * @returns {boolean}
 */
export function isBytesOverflowAffected(version) {
    if (!version) return false;
    if (version[0] !== 2) return false;
    return version[1] <= 2;
}

/**
 * Full compatibility assessment for the detected nvme-cli version.
 *
 * @param {number[]} version - [major, minor, patch] from parseNvmeVersion.
 * @returns {Object} { affected, reasons[], formatChange, bytesOverflow }
 */
export function assessNvmeCliVersion(version) {
    const formatChange = isFormatChangeAffected(version);
    const bytesOverflow = isBytesOverflowAffected(version);
    const affected = formatChange || bytesOverflow;
    const reasons = [];

    if (formatChange) {
        reasons.push(
            'The `nvme list -o json` output uses the nested layout this ' +
            'version of the extension parses with a compatibility shim. ' +
            'See issue #2749 for details.'
        );
    }
    if (bytesOverflow) {
        reasons.push(
            '`nvme list -o json` reports negative UsedBytes/PhysicalSize ' +
            'due to an int32 overflow fixed in nvme-cli 2.3.'
        );
    }

    return { affected, reasons, formatChange, bytesOverflow };
}

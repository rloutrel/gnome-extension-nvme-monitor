/**
 * Normalize the JSON output of `nvme list -o json` into a flat device list.
 *
 * Pure module: no GJS imports, so it can be unit-tested with Node.
 *
 * nvme-cli changed the `nvme list -o json` layout twice (issue #2749):
 *
 *  Flat layout (pre-2.11, 2.13–2.x, 2.3 fixed):
 *      { "Devices": [ { "DevicePath": "/dev/nvme0n1", "ModelNumber": "...",
 *                       "Firmware": "...", "NameSpace": 1, ... } ] }
 *
 *  Nested layout (2.11–2.12, 3.0+):
 *      { "Devices": [ { "Subsystems": [ { "Controllers": [ {
 *          "ModelNumber": "...", "Firmware": "...",
 *          "Namespaces": [ { "NameSpace": "nvme0n1", ... } ] } ] } ] } ] }
 *
 * This normalizer flattens both into a single array of device entries with
 * the same field names the extension already consumes:
 *   { DevicePath, ModelNumber, Firmware, NameSpace, SerialNumber }
 */

/**
 * Normalize parsed `nvme list` JSON into a flat array of device entries.
 *
 * Each entry has at least: DevicePath, ModelNumber, Firmware.
 * Returns [] when the input is empty or unparseable.
 *
 * @param {Object} parsed - Parsed JSON object from `nvme list -o json`.
 * @returns {Object[]}
 */
export function normalizeDeviceList(parsed) {
    if (!parsed || !Array.isArray(parsed.Devices)) return [];

    // Detect the nested layout: Devices[].Subsystems[].Controllers[].Namespaces[].
    const first = parsed.Devices[0];
    const nested = first && Array.isArray(first.Subsystems);

    if (nested) {
        return _normalizeNested(parsed.Devices);
    }
    return _normalizeFlat(parsed.Devices);
}

function _normalizeFlat(devices) {
    return devices.map(dev => ({
        DevicePath: dev.DevicePath || null,
        ModelNumber: dev.ModelNumber || null,
        Firmware: dev.Firmware || null,
        NameSpace: dev.NameSpace,
        SerialNumber: dev.SerialNumber || null,
    }));
}

function _normalizeNested(devices) {
    const out = [];
    for (const host of devices) {
        for (const subsys of host.Subsystems || []) {
            for (const ctrl of subsys.Controllers || []) {
                for (const ns of ctrl.Namespaces || []) {
                    const nameSpace = ns.NameSpace || null;
                    out.push({
                        DevicePath: nameSpace ? `/dev/${nameSpace}` : null,
                        ModelNumber: ctrl.ModelNumber || null,
                        Firmware: ctrl.Firmware || null,
                        NameSpace: ns.NSID ?? nameSpace,
                        SerialNumber: ctrl.SerialNumber || null,
                    });
                }
            }
        }
    }
    return out;
}

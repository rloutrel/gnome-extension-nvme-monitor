// LVM report parsing: pvs/lvs JSON reports into PV/LV entry lists.
// Pure module — no GJS imports, unit-tested under plain Node.

import {normalizeDevicePath} from './diskUsageModel.js';

// Parse one `pvs --reportformat json` stdout into PV entries
// (source, volumeGroup, total, avail in KiB), merged over an optional
// previous PV map (lsblk-sourced entries take precedence for missing
// fields). Invalid/missing sizes fall back to the previous entry.
export function parsePvReport(stdout, {previous = new Map(), notAssigned = 'Not assigned'} = {}) {
    let report;
    try {
        report = JSON.parse(stdout).report || [];
    } catch {
        return {physicalVolumes: [...previous.values()], parseError: true};
    }
    const merged = new Map([...previous.entries()].map(([k, v]) => [k, {...v}]));
    for (const pv of report[0]?.pv || []) {
        const source = normalizeDevicePath(pv.pv_name);
        if (!source) continue;
        const total = Number(pv.pv_size) / 1024;
        const avail = Number(pv.pv_free) / 1024;
        const prev = merged.get(source);
        merged.set(source, {
            source,
            volumeGroup: pv.vg_name || notAssigned,
            total: Number.isFinite(total) ? total : (prev?.total ?? 0),
            avail: Number.isFinite(avail) ? avail : (prev?.avail ?? 0),
        });
    }
    return {physicalVolumes: [...merged.values()]};
}

// Keep only usable PV entries: a source and a positive finite total.
export function filterUsablePhysicalVolumes(pvs) {
    return pvs.filter(pv => pv.source && Number.isFinite(pv.total) && pv.total > 0);
}

// Parse one `lvs --segments --reportformat json` stdout into LV entries
// (source, volumeGroup, logicalVolume, size, attr, devices), keeping only
// entries with a source and a volume group.
export function parseLvReport(stdout) {
    let report;
    try {
        report = JSON.parse(stdout).report || [];
    } catch {
        return {logicalVolumes: [], parseError: true};
    }
    const logicalVolumes = (report[0]?.lv || []).map(lv => ({
        source: lv.lv_path,
        volumeGroup: lv.vg_name,
        logicalVolume: lv.lv_name,
        size: Number(lv.lv_size),
        attr: lv.lv_attr || '',
        devices: lv.devices || '',
    })).filter(lv => lv.source && lv.volumeGroup);
    return {logicalVolumes};
}

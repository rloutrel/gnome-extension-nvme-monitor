import Gio from 'gi://Gio';
import {parseFilesystemUsage} from './diskUsageModel.js';
import {parsePvReport, filterUsablePhysicalVolumes, parseLvReport} from './lvmReport.js';

export function collectFilesystemUsage(runCommandSync) {
    const result = runCommandSync(['df', '-P', '-T', '-k']);
    if (!result.ok || result.exitCode !== 0 || !result.stdout) return [];
    return parseFilesystemUsage(result.stdout);
}

export function collectLvmInfo(runCommandSync, labels = {}, debug = () => {}) {
    const empty = {physicalVolumes: [], logicalVolumes: []};
    const pvsResult = runCommandSync([
        'pvs', '--reportformat', 'json', '--units', 'b', '--nosuffix',
        '-o', 'pv_name,vg_name,pv_size,pv_free',
    ]);
    const lvsResult = runCommandSync([
        'lvs', '--segments', '--reportformat', 'json', '--units', 'b', '--nosuffix',
        '-o', 'lv_path,vg_name,lv_name,lv_size,lv_attr,devices',
    ]);
    const diagnostics = {
        pvs: commandDiagnostic(pvsResult),
        lvs: commandDiagnostic(lvsResult),
    };

    try {
        const lsblk = collectLsblkPvInfo(runCommandSync, labels, debug);
        diagnostics.lsblk = lsblk.diagnostics;

        const previousPvs = new Map(lsblk.physicalVolumes.map(pv => [pv.source, {...pv}]));
        const pvParse = pvsResult.ok && pvsResult.exitCode === 0
            ? parsePvReport(pvsResult.stdout, {
                previous: previousPvs,
                notAssigned: labels.notAssigned || 'Not assigned',
            })
            : {physicalVolumes: [...previousPvs.values()]};
        const lvParse = lvsResult.ok && lvsResult.exitCode === 0
            ? parseLvReport(lvsResult.stdout)
            : {logicalVolumes: []};

        return {
            physicalVolumes: filterUsablePhysicalVolumes(pvParse.physicalVolumes),
            logicalVolumes: lvParse.logicalVolumes,
            diagnostics,
        };
    } catch (error) {
        debug(`LVM metadata parse skipped: ${error.message}`);
        return {...empty, diagnostics};
    }
}

function collectLsblkPvInfo(runCommandSync, labels, debug) {
    const result = runCommandSync([
        'lsblk', '--paths', '--bytes', '--json',
        '--output', 'NAME,TYPE,FSTYPE,SIZE',
    ]);
    const diagnostics = commandDiagnostic(result);
    if (!result.ok || result.exitCode !== 0 || !result.stdout) {
        return {physicalVolumes: [], diagnostics};
    }

    try {
        const devices = JSON.parse(result.stdout).blockdevices || [];
        const pvMap = new Map();
        const visit = (device) => {
            if (!device?.name) return;
            const type = String(device.type || '').trim();
            const fstype = String(device.fstype || device.FSTYPE || '').trim();
            if (type === 'lvm' || type === 'LVM2_member' || /lvm/i.test(type) || /lvm/i.test(fstype)) {
                const totalKib = Number(device.size || 0) / 1024;
                pvMap.set(device.name, {
                    source: device.name,
                    volumeGroup: labels.notAssigned || 'Not assigned',
                    total: Number.isFinite(totalKib) ? totalKib : 0,
                    avail: 0,
                });
            }
            for (const child of device.children || []) visit(child);
        };
        for (const device of devices) visit(device);
        return {
            physicalVolumes: [...pvMap.values()].filter(pv => pv.total > 0),
            diagnostics: {...diagnostics, physicalVolumes: [...pvMap.values()]},
        };
    } catch (error) {
        debug(`lsblk PV metadata parse skipped: ${error.message}`);
        return {physicalVolumes: [], diagnostics: {...diagnostics, parseError: error.message}};
    }
}

function commandDiagnostic(result) {
    return {
        ok: result.ok,
        exitCode: result.exitCode,
        stderr: result.stderr,
    };
}

export function writeDiskUsageDiagnostic(GLib, directory, devicePath, diagnostic, debug = () => {}) {
    try {
        if (!GLib.file_test(directory, GLib.FileTest.IS_DIR)) GLib.mkdir_with_parents(directory, 0o700);
        const baseName = String(devicePath).replace(/^\/dev\//, '').replace(/[^A-Za-z0-9_.-]/g, '_');
        const path = GLib.build_filenamev([directory, `${baseName}.json`]);
        Gio.File.new_for_path(path).replace_contents_bytes_async(
            new TextEncoder().encode(`${JSON.stringify(diagnostic, null, 2)}\n`),
            null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null,
            (source, result) => {
                try {
                    source.replace_contents_finish(result);
                } catch (error) {
                    debug(`disk usage diagnostic write skipped: ${error.message}`);
                }
            });
    } catch (error) {
        debug(`disk usage diagnostic write skipped: ${error.message}`);
    }
}

import {normalizeDevicePath, parseFilesystemUsage} from './diskUsageModel.js';

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
        const pvReport = pvsResult.ok && pvsResult.exitCode === 0
            ? JSON.parse(pvsResult.stdout).report || [] : [];
        const lvReport = lvsResult.ok && lvsResult.exitCode === 0
            ? JSON.parse(lvsResult.stdout).report || [] : [];
        const lsblk = collectLsblkPvInfo(runCommandSync, labels, debug);
        diagnostics.lsblk = lsblk.diagnostics;
        const mergedPvMap = new Map(lsblk.physicalVolumes.map(pv => [pv.source, {...pv}]));

        for (const pv of pvReport[0]?.pv || []) {
            const source = normalizeDevicePath(pv.pv_name);
            if (!source) continue;
            const total = Number(pv.pv_size) / 1024;
            const avail = Number(pv.pv_free) / 1024;
            const previous = mergedPvMap.get(source);
            mergedPvMap.set(source, {
                source,
                volumeGroup: pv.vg_name || labels.notAssigned || 'Not assigned',
                total: Number.isFinite(total) ? total : (previous?.total ?? 0),
                avail: Number.isFinite(avail) ? avail : (previous?.avail ?? 0),
            });
        }

        return {
            physicalVolumes: [...mergedPvMap.values()]
                .filter(pv => pv.source && Number.isFinite(pv.total) && pv.total > 0),
            logicalVolumes: (lvReport[0]?.lv || []).map(lv => ({
                source: lv.lv_path,
                volumeGroup: lv.vg_name,
                logicalVolume: lv.lv_name,
                size: Number(lv.lv_size),
                attr: lv.lv_attr || '',
                devices: lv.devices || '',
            })).filter(lv => lv.source && lv.volumeGroup),
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
        GLib.file_set_contents(path, `${JSON.stringify(diagnostic, null, 2)}\n`);
    } catch (error) {
        debug(`disk usage diagnostic write skipped: ${error.message}`);
    }
}

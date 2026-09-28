const DEFAULT_USED_COLOR = [0.68, 0.88, 0.70];

export function parseFilesystemUsage(output) {
    return String(output || '').trim().split(/\n/).slice(1).map(line => {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 7)
            return null;
        const [source, filesystem, , usedK, availK, pctText, ...mountParts] = parts;
        if (!pctText.endsWith('%'))
            return null;
        const mount = mountParts.join(' ');
        const used = Number(usedK);
        const avail = Number(availK);
        const percent = Number(pctText.slice(0, -1));
        const total = used + avail;
        if (!Number.isFinite(percent) || !Number.isFinite(total) || total <= 0) return null;
        return {source, filesystem, mount, used, avail, total, percent, isLvm: source.startsWith('/dev/mapper/')};
    }).filter(Boolean);
}

export function isSourceOnDisk(source, disk) {
    const sourcePath = normalizeDevicePath(source);
    const diskPath = normalizeDevicePath(disk);
    if (sourcePath === diskPath) return true;
    const suffix = sourcePath.slice(diskPath.length);
    return sourcePath.startsWith(`${diskPath}p`) && /^p\d+$/.test(suffix)
        || sourcePath.startsWith(`${diskPath}n`) && /^n\d+$/.test(suffix);
}

export function stripPartitionSuffix(device) {
    const paren = device.lastIndexOf('(');
    const end = device.lastIndexOf(')');
    if (paren === -1 || end !== device.length - 1 || paren > end)
        return device;
    return device.slice(0, paren);
}

export function normalizeDevicePath(source) {
    const value = String(source || '');
    return value.startsWith('/dev/') ? value : `/dev/${value}`;
}

export function buildDiskUsageEntries(devicePath, filesystemEntries, lvmInfo, labels = {}) {
    const physicalVolumes = lvmInfo?.physicalVolumes || [];
    const logicalVolumes = lvmInfo?.logicalVolumes || [];
    const entries = [];
    const physicalVolumeEntries = physicalVolumes
        .filter(pv => isSourceOnDisk(pv.source, devicePath))
        .map(pv => {
            const free = Math.max(0, pv.avail);
            const pvPath = normalizeDevicePath(pv.source);
            const logicalVolumeNames = logicalVolumes
                .filter(lv => {
                    if (lv.volumeGroup !== pv.volumeGroup) return false;
                    if (!lv.devices) return true;
                    return String(lv.devices).split(',').some(device =>
                        normalizeDevicePath(stripPartitionSuffix(device.trim())) === pvPath);
                })
                .map(lv => lv.logicalVolume || lv.source)
                .filter(Boolean)
                .filter((name, index, names) => names.indexOf(name) === index);

            return {
                source: pv.source,
                filesystem: labels.lvmFilesystem || 'LVM physical volume',
                mount: `${labels.volumeGroup || 'Volume group'}: ${pv.volumeGroup}`,
                used: Math.max(0, pv.total - free),
                avail: free,
                total: pv.total,
                percent: Math.round((100 * (pv.total - free)) / pv.total || 0),
                color: [0.54, 0.29, 0.72],
                isLvm: true,
                logicalVolumes: logicalVolumeNames,
            };
        });

    for (const entry of filesystemEntries || []) {
        if (entry.source.startsWith('/dev/mapper/') || !isSourceOnDisk(entry.source, devicePath)) continue;
        entries.push({...entry, color: DEFAULT_USED_COLOR, isLvm: false});
    }
    entries.push(...physicalVolumeEntries);

    return entries.sort((left, right) => {
        const leftPath = normalizeDevicePath(left.source);
        const rightPath = normalizeDevicePath(right.source);
        const leftSuffix = leftPath.startsWith(normalizeDevicePath(devicePath))
            ? leftPath.slice(normalizeDevicePath(devicePath).length) : leftPath;
        const rightSuffix = rightPath.startsWith(normalizeDevicePath(devicePath))
            ? rightPath.slice(normalizeDevicePath(devicePath).length) : rightPath;
        const leftNum = Number.parseFloat(leftSuffix.replace(/^p|^n/, '')) || 0;
        const rightNum = Number.parseFloat(rightSuffix.replace(/^p|^n/, '')) || 0;
        if (leftNum !== rightNum) return leftNum - rightNum;
        return leftPath.localeCompare(rightPath, undefined, {numeric: true});
    });
}

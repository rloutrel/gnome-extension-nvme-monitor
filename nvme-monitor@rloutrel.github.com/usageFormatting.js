// Disk usage display helpers: byte formatting and usage-entry descriptions.
// Pure module — no GJS imports, unit-tested under plain Node.

// Human-readable binary units for a byte count, e.g. "1.5 GiB".
export function formatDiskUsageBytes(kilobytes, unknownLabel = 'Unknown') {
    const bytes = Number(kilobytes) * 1024;
    if (!Number.isFinite(bytes)) return unknownLabel;
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

// Multi-line description of a usage entry (device, mount, type, LVs).
export function describeDiskUsageEntry(entry, labels) {
    const l = labels || {};
    const device = l.device || 'Device';
    const type = l.type || 'Type';
    const mount = l.mount || 'Mount';
    const contains = l.contains || 'Contains';
    const lines = [
        `${device}: ${entry.source}`,
        `${type}: ${entry.filesystem}`,
    ];
    if (!entry.isLvm) {
        lines.splice(1, 0, `${mount}: ${entry.mount}`);
    }
    if (entry.isLvm && Array.isArray(entry.logicalVolumes) && entry.logicalVolumes.length > 0) {
        lines.push(`${contains}: ${entry.logicalVolumes.join(', ')}`);
    }
    return lines.join('\n');
}

// Full click-details body for a usage entry: the description plus, for
// non-LVM entries, the used/available/total breakdown.
export function buildDiskUsageDetails(entry, labels) {
    let details = describeDiskUsageEntry(entry, labels);
    if (!entry.isLvm) {
        const usage = labels?.usage || 'Usage';
        const used = labels?.used || 'used';
        const available = labels?.available || 'available';
        const total = labels?.total || 'total';
        details += `\n${usage}: ${entry.percent}% ` +
            `(${formatDiskUsageBytes(entry.used, labels?.unknown)} ${used}, ` +
            `${formatDiskUsageBytes(entry.avail, labels?.unknown)} ${available}, ` +
            `${formatDiskUsageBytes(entry.total, labels?.unknown)} ${total})`;
    }
    return details;
}

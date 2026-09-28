// SMART reading presentation: health gauge construction and the SMART
// status line resolution shown under each device.
// Pure module — no GJS imports, unit-tested under plain Node.

import {spareGaugeColor, usedGaugeColor} from './format.js';

// Build the health gauge descriptors for a parsed SMART object:
// Available Spare and Lifetime Used when the drive reports them.
// Returns null when the drive reports neither.
export function buildHealthGauges(parsedSmart, labels) {
    const l = labels || {};
    const availableSpare = l.availableSpare || 'Available Spare';
    const lifetimeUsed = l.lifetimeUsed || 'Lifetime Used';
    const gauges = [];
    if (parsedSmart.health.availableSparePercent !== undefined) {
        const pct = parsedSmart.health.availableSparePercent;
        gauges.push({
            label: availableSpare,
            percent: pct,
            color: spareGaugeColor(pct),
            title: availableSpare,
            body: l.spareBody ||
                'Reserved capacity the drive can swap in to replace failing blocks. ' +
                'Critical below 15%, warning below 50%, OK otherwise.',
        });
    }
    if (parsedSmart.health.percentageUsed !== undefined) {
        const pct = parsedSmart.health.percentageUsed;
        gauges.push({
            label: lifetimeUsed,
            percent: pct,
            color: usedGaugeColor(pct),
            title: lifetimeUsed,
            body: l.usedBody ||
                'Estimated portion of the drive endurance consumed. ' +
                'OK below 50%, warning up to 85%, critical above.',
        });
    }
    return gauges.length > 0 ? gauges : null;
}

// Resolve the SMART status line to show under a device.
// Returns {text, styleClass} or null when no status line applies
// (i.e. the stack is installed and the SMART read succeeded — the full
// SMART info block is rendered instead).
//
// Arguments:
//   status: {v2Installed, smartObj, smartParseError, inGroup}
export function getSmartStatusLine(status, labels) {
    const l = labels || {};
    const infoStyle = 'nvme-smart-info';
    if (!status.v2Installed) {
        return {
            text: l.install || '  Install NVMe Stack for SMART data',
            styleClass: infoStyle,
        };
    }
    if (status.smartParseError) {
        return {text: l.parseError || '  SMART: parse error', styleClass: null};
    }
    if (status.smartObj) {
        return null;
    }
    if (!status.inGroup) {
        return {
            text: l.relogin || '  SMART: log out and back in to enable access',
            styleClass: infoStyle,
        };
    }
    return {text: l.unavailable || '  SMART: unavailable', styleClass: infoStyle};
}

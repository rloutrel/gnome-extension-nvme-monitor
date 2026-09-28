import test from 'node:test';
import assert from 'node:assert/strict';

import {
    formatDiskUsageBytes,
    describeDiskUsageEntry,
    buildDiskUsageDetails,
} from '../usageFormatting.js';

test('formatDiskUsageBytes formats plain bytes', () => {
    assert.equal(formatDiskUsageBytes(1), '1.0 KiB');
    assert.equal(formatDiskUsageBytes(0), '0 B');
});

test('formatDiskUsageBytes scales to KiB/MiB/GiB/TiB', () => {
    assert.equal(formatDiskUsageBytes(1024), '1.0 MiB');
    assert.equal(formatDiskUsageBytes(1024 ** 2), '1.0 GiB');
    assert.equal(formatDiskUsageBytes(1024 ** 3), '1.0 TiB');
});

test('formatDiskUsageBytes keeps one decimal below 10, none above', () => {
    assert.equal(formatDiskUsageBytes(1.5), '1.5 KiB');
    assert.equal(formatDiskUsageBytes(10), '10 KiB');
});

test('formatDiskUsageBytes caps at the largest unit', () => {
    const exabytes = 1024 ** 4; // KiB
    assert.equal(formatDiskUsageBytes(exabytes), '1024 TiB');
});

test('formatDiskUsageBytes returns the unknown label for invalid input', () => {
    assert.equal(formatDiskUsageBytes('abc'), 'Unknown');
    assert.equal(formatDiskUsageBytes(Number.NaN), 'Unknown');
    assert.equal(formatDiskUsageBytes(undefined), 'Unknown');
    assert.equal(formatDiskUsageBytes('abc', '?'), '?');
});

test('describeDiskUsageEntry describes a mounted filesystem', () => {
    const entry = {
        source: '/dev/nvme0n1p2',
        filesystem: 'ext4',
        mount: '/',
        isLvm: false,
    };
    const lines = describeDiskUsageEntry(entry).split('\n');
    assert.equal(lines[0], 'Device: /dev/nvme0n1p2');
    assert.equal(lines[1], 'Mount: /');
    assert.equal(lines[2], 'Type: ext4');
});

test('describeDiskUsageEntry omits the mount line for LVM entries', () => {
    const entry = {
        source: '/dev/mapper/vg-root',
        filesystem: 'lvm',
        isLvm: true,
        logicalVolumes: ['root', 'swap'],
    };
    const lines = describeDiskUsageEntry(entry).split('\n');
    assert.equal(lines.length, 3);
    assert.ok(!lines.some(l => l.startsWith('Mount:')));
    assert.equal(lines[2], 'Contains: root, swap');
});

test('describeDiskUsageEntry omits Contains when LV list is empty', () => {
    const entry = {
        source: '/dev/mapper/vg-root',
        filesystem: 'lvm',
        isLvm: true,
        logicalVolumes: [],
    };
    assert.equal(describeDiskUsageEntry(entry).split('\n').length, 2);
});

test('describeDiskUsageEntry accepts translated labels', () => {
    const entry = {source: '/dev/sda1', filesystem: 'ext4', mount: '/home', isLvm: false};
    const out = describeDiskUsageEntry(entry, {
        device: 'Périphérique',
        mount: 'Point de montage',
        type: 'Type',
    });
    assert.ok(out.includes('Périphérique: /dev/sda1'));
    assert.ok(out.includes('Point de montage: /home'));
});

test('buildDiskUsageDetails appends the used/available/total breakdown', () => {
    const entry = {
        source: '/dev/nvme0n1p2',
        filesystem: 'ext4',
        mount: '/',
        isLvm: false,
        percent: 62,
        used: 620 * 1024,
        avail: 380 * 1024,
        total: 1024 * 1024,
    };
    const details = buildDiskUsageDetails(entry);
    assert.ok(details.includes('Usage: 62%'));
    assert.ok(details.includes('used'));
    assert.ok(details.includes('available'));
    assert.ok(details.includes('total'));
});

test('buildDiskUsageDetails skips the breakdown for LVM entries', () => {
    const entry = {
        source: '/dev/mapper/vg-root',
        filesystem: 'lvm',
        isLvm: true,
        logicalVolumes: ['root'],
        percent: 62,
        used: 100,
        avail: 100,
        total: 200,
    };
    const details = buildDiskUsageDetails(entry);
    assert.ok(!details.includes('Usage:'));
});

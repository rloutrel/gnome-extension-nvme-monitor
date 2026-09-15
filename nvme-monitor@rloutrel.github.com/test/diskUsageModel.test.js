import test from 'node:test';
import assert from 'node:assert/strict';

import {buildDiskUsageEntries, isSourceOnDisk, parseFilesystemUsage} from '../diskUsageModel.js';

test('disk model: parses mounted filesystem usage', () => {
    const entries = parseFilesystemUsage([
        'Filesystem Type 1024-blocks Used Available Capacity Mounted on',
        '/dev/nvme0n1p3 ext4 1000 400 600 40% /',
    ].join('\n'));

    assert.deepEqual(entries[0], {
        source: '/dev/nvme0n1p3',
        filesystem: 'ext4',
        mount: '/',
        used: 400,
        avail: 600,
        total: 1000,
        percent: 40,
        isLvm: false,
    });
});

test('disk model: matches NVMe namespaces and partitions only', () => {
    assert.equal(isSourceOnDisk('/dev/nvme0n1p2', '/dev/nvme0n1'), true);
    assert.equal(isSourceOnDisk('/dev/nvme1n1p2', '/dev/nvme0n1'), false);
    assert.equal(isSourceOnDisk('/dev/nvme0n10p2', '/dev/nvme0n1'), false);
});

test('disk model: lists logical volumes on the physical volume', () => {
    const entries = buildDiskUsageEntries('/dev/nvme0n1', [], {
        physicalVolumes: [{
            source: '/dev/nvme0n1p2',
            volumeGroup: 'vg0',
            total: 100,
            avail: 20,
        }],
        logicalVolumes: [
            {
                source: '/dev/mapper/vg0-lv0',
                volumeGroup: 'vg0',
                logicalVolume: 'lv0',
                devices: '/dev/nvme0n1p2(0)',
            },
            {
                source: '/dev/mapper/vg0-lv1',
                volumeGroup: 'vg0',
                logicalVolume: 'lv1',
                devices: '/dev/nvme1n1p2(0)',
            },
        ],
    });

    assert.equal(entries.length, 1);
    assert.equal(entries[0].isLvm, true);
    assert.deepEqual(entries[0].logicalVolumes, ['lv0']);
});

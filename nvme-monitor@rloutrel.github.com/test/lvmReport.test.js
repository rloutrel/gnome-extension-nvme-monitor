import test from 'node:test';
import assert from 'node:assert/strict';

import {
    parsePvReport,
    filterUsablePhysicalVolumes,
    parseLvReport,
} from '../lvmReport.js';

const PVS_STDOUT = JSON.stringify({report: [{pv: [
    {pv_name: '/dev/nvme0n1p3', vg_name: 'vg0', pv_size: '1024', pv_free: '512'},
    {pv_name: '/dev/sda1', vg_name: '', pv_size: '2048', pv_free: '0'},
]}]});

const LVS_STDOUT = JSON.stringify({report: [{lv: [
    {lv_path: '/dev/vg0/root', vg_name: 'vg0', lv_name: 'root', lv_size: '512', lv_attr: '-wi-ao----', devices: '/dev/nvme0n1p3(0)'},
    {lv_path: '', vg_name: 'vg0', lv_name: 'broken', lv_size: '128', lv_attr: '', devices: ''},
]}]});

test('parsePvReport parses pvs JSON into KiB entries', () => {
    const {physicalVolumes} = parsePvReport(PVS_STDOUT);
    assert.equal(physicalVolumes.length, 2);
    const pv = physicalVolumes[0];
    assert.equal(pv.source, '/dev/nvme0n1p3');
    assert.equal(pv.volumeGroup, 'vg0');
    assert.equal(pv.total, 1); // 1024 bytes = 1 KiB
    assert.equal(pv.avail, 0.5);
});

test('parsePvReport falls back to the "not assigned" label', () => {
    const {physicalVolumes} = parsePvReport(PVS_STDOUT);
    assert.equal(physicalVolumes[1].volumeGroup, 'Not assigned');
});

test('parsePvReport accepts a custom not-assigned label', () => {
    const {physicalVolumes} = parsePvReport(PVS_STDOUT, {notAssigned: 'Non assigné'});
    assert.equal(physicalVolumes[1].volumeGroup, 'Non assigné');
});

test('parsePvReport merges over previous lsblk entries', () => {
    const previous = new Map([
        ['/dev/nvme0n1p3', {source: '/dev/nvme0n1p3', volumeGroup: 'x', total: 5, avail: 3}],
    ]);
    const {physicalVolumes} = parsePvReport(PVS_STDOUT, {previous});
    const pv = physicalVolumes.find(p => p.source === '/dev/nvme0n1p3');
    assert.equal(pv.total, 1);
    assert.equal(pv.avail, 0.5);
});

test('parsePvReport keeps previous entries absent from the report', () => {
    const previous = new Map([
        ['/dev/sdb1', {source: '/dev/sdb1', volumeGroup: 'vg1', total: 9, avail: 2}],
    ]);
    const {physicalVolumes} = parsePvReport(PVS_STDOUT, {previous});
    const pv = physicalVolumes.find(p => p.source === '/dev/sdb1');
    assert.ok(pv, 'previous entry kept');
});

test('parsePvReport falls back to previous sizes on invalid numbers', () => {
    const stdout = JSON.stringify({report: [{pv: [
        {pv_name: '/dev/nvme0n1p3', vg_name: 'vg0', pv_size: 'oops', pv_free: 'nope'},
    ]}]});
    const previous = new Map([
        ['/dev/nvme0n1p3', {source: '/dev/nvme0n1p3', volumeGroup: 'x', total: 7, avail: 4}],
    ]);
    const {physicalVolumes} = parsePvReport(stdout, {previous});
    const pv = physicalVolumes[0];
    assert.equal(pv.total, 7);
    assert.equal(pv.avail, 4);
});

test('parsePvReport reports unparseable stdout without throwing', () => {
    const {physicalVolumes, parseError} = parsePvReport('not json', {
        previous: new Map([['/dev/sdb1', {source: '/dev/sdb1', total: 1, avail: 1}]]),
    });
    assert.equal(parseError, true);
    assert.equal(physicalVolumes.length, 1);
});

test('filterUsablePhysicalVolumes drops zero/invalid totals', () => {
    const pvs = [
        {source: '/dev/a', total: 100},
        {source: '/dev/b', total: 0},
        {source: '/dev/c', total: Number.NaN},
        {source: null, total: 50},
    ];
    const kept = filterUsablePhysicalVolumes(pvs);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].source, '/dev/a');
});

test('parseLvReport parses lvs JSON entries', () => {
    const {logicalVolumes} = parseLvReport(LVS_STDOUT);
    assert.equal(logicalVolumes.length, 1);
    const lv = logicalVolumes[0];
    assert.equal(lv.source, '/dev/vg0/root');
    assert.equal(lv.volumeGroup, 'vg0');
    assert.equal(lv.logicalVolume, 'root');
    assert.equal(lv.size, 512);
    assert.equal(lv.attr, '-wi-ao----');
});

test('parseLvReport drops entries without source or volume group', () => {
    const {logicalVolumes} = parseLvReport(LVS_STDOUT);
    assert.ok(!logicalVolumes.some(l => l.logicalVolume === 'broken'));
});

test('parseLvReport reports unparseable stdout without throwing', () => {
    const {logicalVolumes, parseError} = parseLvReport('not json');
    assert.equal(parseError, true);
    assert.deepEqual(logicalVolumes, []);
});

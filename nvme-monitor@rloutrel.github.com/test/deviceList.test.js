/**
 * Unit tests for device-list JSON normalization.
 *
 * Run with: node --test nvme-monitor@rloutrel.github.com/test/deviceList.test.js
 *
 * Fixtures are real nvme-cli `list -o json` outputs from issue #2749,
 * capturing the flat (pre-2.11, 2.13+) and nested (2.11–2.12, 3.0+)
 * layouts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDeviceList } from '../deviceList.js';

// ---------------------------------------------------------------------------
// Fixture: flat layout (pre-2.11, 2.13–2.x)
// @flat_format
// ---------------------------------------------------------------------------
const FLAT_JSON = {
    Devices: [
        {
            NameSpace: 1,
            DevicePath: '/dev/nvme0n1',
            GenericPath: '/dev/ng0n1',
            Firmware: '5B2QGXA7',
            ModelNumber: 'Samsung SSD 980 PRO 2TB',
            SerialNumber: 'S6B0NL0T924753T',
            UsedBytes: 185560145920,
            MaximumLBA: 3907029168,
            PhysicalSize: 2000398934016,
            SectorSize: 512,
        },
        {
            NameSpace: 1,
            DevicePath: '/dev/nvme1n1',
            GenericPath: '/dev/ng1n1',
            Firmware: '3B2QGXA7',
            ModelNumber: 'Samsung SSD 970 EVO Plus 2TB',
            SerialNumber: 'S5H9NS0N504753T',
            UsedBytes: 500107862016,
            MaximumLBA: 3907029168,
            PhysicalSize: 2000398934016,
            SectorSize: 512,
        },
    ],
};

// ---------------------------------------------------------------------------
// Fixture: nested layout (2.11–2.12, 3.0+)
// @nested_format
// ---------------------------------------------------------------------------
const NESTED_JSON = {
    Devices: [
        {
            HostNQN: 'nqn.2014-08.org.nvmexpress:uuid:4c4c4544-0037-4410-8032-b1c04f505433',
            HostID: '579f640c-2adb-44a2-a43c-006ec4c2bba6',
            Subsystems: [
                {
                    Subsystem: 'nvme-subsys0',
                    SubsystemNQN: 'nqn.1994-11.com.samsung:nvme:980PRO:M.2:S6B0NL0T924753T',
                    Controllers: [
                        {
                            Controller: 'nvme0',
                            Cntlid: '6',
                            SerialNumber: 'S6B0NL0T924753T',
                            ModelNumber: 'Samsung SSD 980 PRO 2TB',
                            Firmware: '5B2QGXA7',
                            Transport: 'pcie',
                            Address: '0000:01:00.0',
                            Slot: '',
                            Namespaces: [
                                {
                                    NameSpace: 'nvme0n1',
                                    Generic: 'ng0n1',
                                    NSID: 1,
                                    UsedBytes: 185566969856,
                                    MaximumLBA: 3907029168,
                                    PhysicalSize: 2000398934016,
                                    SectorSize: 512,
                                },
                            ],
                            Paths: [],
                        },
                    ],
                    Namespaces: [],
                },
            ],
        },
    ],
};

// ---------------------------------------------------------------------------
// Flat layout
// ---------------------------------------------------------------------------

test('flat_format: normalizes two Samsung devices', () => {
    const out = normalizeDeviceList(FLAT_JSON);
    assert.strictEqual(out.length, 2);
});

test('flat_format: preserves DevicePath', () => {
    const out = normalizeDeviceList(FLAT_JSON);
    assert.strictEqual(out[0].DevicePath, '/dev/nvme0n1');
    assert.strictEqual(out[1].DevicePath, '/dev/nvme1n1');
});

test('flat_format: preserves ModelNumber', () => {
    const out = normalizeDeviceList(FLAT_JSON);
    assert.strictEqual(out[0].ModelNumber, 'Samsung SSD 980 PRO 2TB');
});

test('flat_format: preserves Firmware', () => {
    const out = normalizeDeviceList(FLAT_JSON);
    assert.strictEqual(out[0].Firmware, '5B2QGXA7');
});

test('flat_format: preserves SerialNumber', () => {
    const out = normalizeDeviceList(FLAT_JSON);
    assert.strictEqual(out[0].SerialNumber, 'S6B0NL0T924753T');
});

// ---------------------------------------------------------------------------
// Nested layout
// ---------------------------------------------------------------------------

test('nested_format: flattens subsystems/controllers/namespaces', () => {
    const out = normalizeDeviceList(NESTED_JSON);
    assert.strictEqual(out.length, 1);
});

test('nested_format: builds DevicePath from NameSpace', () => {
    const out = normalizeDeviceList(NESTED_JSON);
    assert.strictEqual(out[0].DevicePath, '/dev/nvme0n1');
});

test('nested_format: lifts ModelNumber from Controller', () => {
    const out = normalizeDeviceList(NESTED_JSON);
    assert.strictEqual(out[0].ModelNumber, 'Samsung SSD 980 PRO 2TB');
});

test('nested_format: lifts Firmware from Controller', () => {
    const out = normalizeDeviceList(NESTED_JSON);
    assert.strictEqual(out[0].Firmware, '5B2QGXA7');
});

test('nested_format: lifts SerialNumber from Controller', () => {
    const out = normalizeDeviceList(NESTED_JSON);
    assert.strictEqual(out[0].SerialNumber, 'S6B0NL0T924753T');
});

test('nested_format: uses NSID for NameSpace field', () => {
    const out = normalizeDeviceList(NESTED_JSON);
    assert.strictEqual(out[0].NameSpace, 1);
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test('empty Devices array returns []', () => {
    assert.deepStrictEqual(normalizeDeviceList({Devices: []}), []);
});

test('null input returns []', () => {
    assert.deepStrictEqual(normalizeDeviceList(null), []);
});

test('undefined input returns []', () => {
    assert.deepStrictEqual(normalizeDeviceList(undefined), []);
});

test('missing Devices key returns []', () => {
    assert.deepStrictEqual(normalizeDeviceList({}), []);
});

// ---------------------------------------------------------------------------
// Cross-format equivalence: both layouts yield the same key fields
// ---------------------------------------------------------------------------

test('both layouts produce equivalent key fields for the same drive', () => {
    const flat = normalizeDeviceList(FLAT_JSON)[0];
    const nested = normalizeDeviceList(NESTED_JSON)[0];
    assert.strictEqual(flat.DevicePath, nested.DevicePath);
    assert.strictEqual(flat.ModelNumber, nested.ModelNumber);
    assert.strictEqual(flat.Firmware, nested.Firmware);
    assert.strictEqual(flat.SerialNumber, nested.SerialNumber);
});

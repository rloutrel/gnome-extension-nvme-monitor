/**
 * Unit tests for the firmware registry helpers.
 *
 * Run with: node --test nvme-monitor@rloutrel.github.com/test/firmwareRegistry.test.js
 *
 * firmwareRegistry.js is a pure module (no GJS imports) so it can be
 * tested outside GNOME Shell.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizePciDeviceId,
    findRevision,
    getRevisionSupportLevel,
    getLatestFirmware,
    assessFirmware,
} from '../firmwareRegistry.js';
import VALIDATED_DEVICES from '../validatedDevices.json' with {type: 'json'};

test('normalizePciDeviceId accepts the common textual forms', () => {
    assert.equal(normalizePciDeviceId('a808'), '0xa808');
    assert.equal(normalizePciDeviceId('0xa808'), '0xa808');
    assert.equal(normalizePciDeviceId('0xA808'), '0xa808');
    assert.equal(normalizePciDeviceId('0Xa808'), '0xa808');
    assert.equal(normalizePciDeviceId(43016), '0xa808');
    assert.equal(normalizePciDeviceId(''), '');
    assert.equal(normalizePciDeviceId(null), '');
    assert.equal(normalizePciDeviceId(undefined), '');
});

test('findRevision: selects the entry matching the PCI device ID', () => {
    const entry = {
        revisions: [
            {pciDeviceId: '0xa808', confirmed: true, latestFirmware: '2B2QEXM7'},
            {pciDeviceId: '0xa80a', confirmed: true, latestFirmware: '4B2QEXM7'},
        ],
    };
    assert.equal(findRevision(entry, '0xa808').latestFirmware, '2B2QEXM7');
    assert.equal(findRevision(entry, '0xA80A').latestFirmware, '4B2QEXM7');
    assert.equal(findRevision(entry, '0x1234'), null);
    assert.equal(findRevision(entry, ''), null);
    assert.equal(findRevision(entry), null);
    assert.equal(findRevision({}, '0xa808'), null);
    assert.equal(findRevision(null, '0xa808'), null);
});

test('getRevisionSupportLevel: validated only for a confirmed revision', () => {
    const entry = VALIDATED_DEVICES['Samsung SSD 970 EVO Plus 2TB'];
    assert.equal(getRevisionSupportLevel(entry, '0xa808'), 'validated');
    // Unregistered revision (e.g. the Elpis 4B2QEXM7 drive): orange '!',
    // so the owner reports the revision and we can document it.
    assert.equal(getRevisionSupportLevel(entry, '0xa80a'), 'confirm');
    assert.equal(getRevisionSupportLevel(entry, ''), 'confirm');
    assert.equal(getRevisionSupportLevel(entry), 'confirm');
    assert.equal(getRevisionSupportLevel({}, '0xa808'), 'unknown');
    assert.equal(getRevisionSupportLevel(null, '0xa808'), 'unknown');
    const unconfirmed = {
        revisions: [{pciDeviceId: '0xa808', confirmed: false, latestFirmware: ''}],
    };
    assert.equal(getRevisionSupportLevel(unconfirmed, '0xa808'), 'confirm');
});

test('getLatestFirmware: per-revision versions select by PCI device ID', () => {
    const entry = VALIDATED_DEVICES['Samsung SSD 970 EVO Plus 2TB'];
    assert.equal(getLatestFirmware(entry, '0xa808'), '2B2QEXM7');
    // Unknown revision or unreadable PCI ID: no guess.
    assert.equal(getLatestFirmware(entry), null);
    assert.equal(getLatestFirmware(entry, '0xa80a'), null);
    assert.equal(getLatestFirmware(entry, ''), null);
});

test('getLatestFirmware: legacy single string applies to any revision', () => {
    const entry = {manufacturer: 'Samsung', confirmed: true, latestFirmware: '1B4QFXO7'};
    assert.equal(getLatestFirmware(entry), '1B4QFXO7');
    assert.equal(getLatestFirmware(entry, '0xa809'), '1B4QFXO7');
    assert.equal(getLatestFirmware(entry, '0xdead'), '1B4QFXO7');
});

test('getLatestFirmware: revision entry with empty firmware returns null', () => {
    const entry = {
        revisions: [{pciDeviceId: '0xa808', confirmed: true, latestFirmware: ''}],
    };
    assert.equal(getLatestFirmware(entry, '0xa808'), null);
});

test('getLatestFirmware: missing or empty data returns null', () => {
    assert.equal(getLatestFirmware(null), null);
    assert.equal(getLatestFirmware({}), null);
    assert.equal(getLatestFirmware({latestFirmware: ''}), null);
    assert.equal(getLatestFirmware({manufacturer: 'Samsung'}), null);
});

test('assessFirmware: states from a single-version entry', () => {
    const entry = {latestFirmware: '1B4QFXO7'};
    assert.equal(assessFirmware(entry, '1B4QFXO7'), 'current');
    assert.equal(assessFirmware(entry, '1B4QFXO6'), 'outdated');
    assert.equal(assessFirmware(entry, ''), 'unknown');
    assert.equal(assessFirmware(entry, null), 'unknown');
    assert.equal(assessFirmware({}, '1B4QFXO7'), 'unknown');
});

test('assessFirmware: per-revision entry only judges the matching revision', () => {
    const entry = VALIDATED_DEVICES['Samsung SSD 970 EVO Plus 2TB'];
    assert.equal(assessFirmware(entry, '2B2QEXM7', '0xa808'), 'current');
    assert.equal(assessFirmware(entry, '2B2QEXM3', '0xa808'), 'outdated');
    // Unknown revision (other hardware revision, or unreadable sysfs):
    // no firmware data applies, do nothing.
    assert.equal(assessFirmware(entry, '2B2QEXM3', '0xa80a'), 'unknown');
    assert.equal(assessFirmware(entry, '2B2QEXM3', ''), 'unknown');
});

test('registry: every entry carries per-revision data', () => {
    for (const [model, entry] of Object.entries(VALIDATED_DEVICES)) {
        assert.ok(Array.isArray(entry.revisions) && entry.revisions.length > 0,
            `entry "${model}" must carry a revisions array`);
        assert.equal(typeof entry.manufacturer, 'string',
            `entry "${model}" must name its manufacturer`);
        for (const rev of entry.revisions) {
            assert.equal(typeof rev.pciDeviceId, 'string');
            assert.ok(rev.pciDeviceId.trim() !== '',
                `entry "${model}" has a revision without pciDeviceId`);
            assert.equal(typeof rev.confirmed, 'boolean',
                `entry "${model}" revision ${rev.pciDeviceId} must set confirmed`);
            assert.ok(typeof rev.latestFirmware === 'string' ||
                rev.latestFirmware === undefined,
                `entry "${model}" revision ${rev.pciDeviceId} has an invalid latestFirmware`);
        }
    }
});

test('registry: confirmed devices each map to a smartParser fixture', () => {
    // The fixture map lives in smartParser.test.js; here we only assert
    // that confirmed revisions exist so the registry cannot silently
    // drop all confirmations.
    const confirmed = Object.entries(VALIDATED_DEVICES)
        .filter(([, entry]) => entry.revisions.some(rev => rev.confirmed === true));
    assert.ok(confirmed.length > 0, 'registry has no confirmed revision');
});

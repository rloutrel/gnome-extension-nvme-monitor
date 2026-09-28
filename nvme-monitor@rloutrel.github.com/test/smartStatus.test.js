import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildHealthGauges,
    getSmartStatusLine,
} from '../smartStatus.js';

const SMART_WITH_HEALTH = {
    health: {
        availableSparePercent: 100,
        percentageUsed: 4,
    },
};

const SMART_WITHOUT_HEALTH = {
    health: {},
};

test('buildHealthGauges builds both gauges when reported', () => {
    const gauges = buildHealthGauges(SMART_WITH_HEALTH);
    assert.equal(gauges.length, 2);
    assert.equal(gauges[0].label, 'Available Spare');
    assert.equal(gauges[0].percent, 100);
    assert.equal(gauges[1].label, 'Lifetime Used');
    assert.equal(gauges[1].percent, 4);
});

test('buildHealthGauges returns null when the drive reports neither', () => {
    assert.equal(buildHealthGauges(SMART_WITHOUT_HEALTH), null);
});

test('buildHealthGauges builds only the reported gauge', () => {
    const gauges = buildHealthGauges({health: {percentageUsed: 12}});
    assert.equal(gauges.length, 1);
    assert.equal(gauges[0].label, 'Lifetime Used');
});

test('buildHealthGauges uses injected labels', () => {
    const gauges = buildHealthGauges(SMART_WITH_HEALTH, {
        availableSpare: 'Réserve disponible',
        lifetimeUsed: 'Durée de vie utilisée',
    });
    assert.equal(gauges[0].label, 'Réserve disponible');
    assert.equal(gauges[1].label, 'Durée de vie utilisée');
});

test('getSmartStatusLine asks to install when the stack is missing', () => {
    const line = getSmartStatusLine({v2Installed: false});
    assert.equal(line.text, '  Install NVMe Stack for SMART data');
    assert.equal(line.styleClass, 'nvme-smart-info');
});

test('getSmartStatusLine reports parse errors', () => {
    const line = getSmartStatusLine({
        v2Installed: true,
        smartObj: null,
        smartParseError: true,
    });
    assert.equal(line.text, '  SMART: parse error');
    assert.equal(line.styleClass, null);
});

test('getSmartStatusLine returns null when SMART data is available', () => {
    const line = getSmartStatusLine({
        v2Installed: true,
        smartObj: {data: true},
        smartParseError: false,
    });
    assert.equal(line, null);
});

test('getSmartStatusLine hints re-login when not in the smart group', () => {
    const line = getSmartStatusLine({
        v2Installed: true,
        smartObj: null,
        smartParseError: false,
        inGroup: false,
    });
    assert.equal(line.text, '  SMART: log out and back in to enable access');
    assert.equal(line.styleClass, 'nvme-smart-info');
});

test('getSmartStatusLine reports unavailable reads for group members', () => {
    const line = getSmartStatusLine({
        v2Installed: true,
        smartObj: null,
        smartParseError: false,
        inGroup: true,
    });
    assert.equal(line.text, '  SMART: unavailable');
});

test('getSmartStatusLine prefers parse error over re-login hint', () => {
    const line = getSmartStatusLine({
        v2Installed: true,
        smartObj: null,
        smartParseError: true,
        inGroup: false,
    });
    assert.equal(line.text, '  SMART: parse error');
});

test('getSmartStatusLine accepts translated labels', () => {
    const line = getSmartStatusLine(
        {v2Installed: true, smartObj: null, smartParseError: false, inGroup: true},
        {unavailable: '  SMART : indisponible'});
    assert.equal(line.text, '  SMART : indisponible');
});

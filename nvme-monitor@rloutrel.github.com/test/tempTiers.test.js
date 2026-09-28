import test from 'node:test';
import assert from 'node:assert/strict';

import {
    TEMP_WARM_C,
    TEMP_HOT_C,
    CRITICAL_WARNING_TEMP,
    THERMOMETER_LOW,
    THERMOMETER_HALF,
    THERMOMETER_HIGH,
    getThermometerIcon,
    getTempStyle,
    isCriticalTemp,
    hasHotTemperatureSensor,
} from '../tempTiers.js';

test('threshold constants keep their values', () => {
    assert.equal(TEMP_WARM_C, 50);
    assert.equal(TEMP_HOT_C, 70);
    assert.equal(CRITICAL_WARNING_TEMP, 0x02);
});

test('getThermometerIcon returns null for unknown temperature', () => {
    assert.equal(getThermometerIcon(null, 0), null);
    assert.equal(getThermometerIcon(undefined, 0), null);
});

test('getThermometerIcon picks the heuristic tiers', () => {
    assert.equal(getThermometerIcon(35, 0), THERMOMETER_LOW);
    assert.equal(getThermometerIcon(55, 0), THERMOMETER_HALF);
    assert.equal(getThermometerIcon(75, 0), THERMOMETER_HIGH);
    assert.equal(getThermometerIcon(TEMP_WARM_C, 0), THERMOMETER_HALF);
    assert.equal(getThermometerIcon(TEMP_HOT_C, 0), THERMOMETER_HIGH);
});

test('getThermometerIcon forces the high icon on critical_warning bit 1', () => {
    assert.equal(getThermometerIcon(20, CRITICAL_WARNING_TEMP), THERMOMETER_HIGH);
});

test('getTempStyle returns the default style for unknown temperature', () => {
    assert.equal(getTempStyle(null, 0), 'nvme-smart-attr');
    assert.equal(getTempStyle(undefined, 0), 'nvme-smart-attr');
});

test('getTempStyle maps tiers to style classes', () => {
    assert.equal(getTempStyle(35, 0), 'nvme-smart-attr');
    assert.equal(getTempStyle(55, 0), 'nvme-smart-warning-orange');
    assert.equal(getTempStyle(75, 0), 'nvme-smart-warning-red');
});

test('getTempStyle forces red on critical_warning bit 1', () => {
    assert.equal(getTempStyle(20, CRITICAL_WARNING_TEMP), 'nvme-smart-warning-red');
});

test('isCriticalTemp is driven by critical_warning or the hot threshold', () => {
    assert.equal(isCriticalTemp(75, 0), true);
    assert.equal(isCriticalTemp(69, 0), false);
    assert.equal(isCriticalTemp(20, CRITICAL_WARNING_TEMP), true);
    assert.equal(isCriticalTemp(20, 0), false);
});

test('hasHotTemperatureSensor scans all sensor values', () => {
    assert.equal(hasHotTemperatureSensor({Composite: 40, Sensor1: 72}), true);
    assert.equal(hasHotTemperatureSensor({Composite: 40, Sensor1: 50}), false);
    assert.equal(hasHotTemperatureSensor({Composite: 40, Sensor1: null}), false);
    assert.equal(hasHotTemperatureSensor(null), false);
    assert.equal(hasHotTemperatureSensor('oops'), false);
});

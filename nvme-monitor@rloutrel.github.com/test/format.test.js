/**
 * Unit tests for endurance value formatting.
 *
 * Run with: node --test nvme-monitor@rloutrel.github.com/test/format.test.js
 *
 * Uses Node's built-in test runner (no dependencies) since this GNOME
 * Shell extension has no Node/npm test infrastructure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    formatCompactNumber,
    formatDataUnits,
    formatPowerOnHours,
    spareGaugeColor,
    usedGaugeColor,
} from '../format.js';

// ---------------------------------------------------------------------------
// formatCompactNumber
// ---------------------------------------------------------------------------

test('formatCompactNumber: empty for null/undefined', () => {
    assert.equal(formatCompactNumber(null), '');
    assert.equal(formatCompactNumber(undefined), '');
});

test('formatCompactNumber: under 1000 stays literal', () => {
    assert.equal(formatCompactNumber(0), '0');
    assert.equal(formatCompactNumber(500), '500');
    assert.equal(formatCompactNumber(999), '999');
});

test('formatCompactNumber: thousands get K suffix', () => {
    assert.equal(formatCompactNumber(25000), '25.0K');
    assert.equal(formatCompactNumber(1000), '1.00K');
});

test('formatCompactNumber: billions get G suffix', () => {
    assert.equal(formatCompactNumber(1234567890), '1.23G');
});

test('formatCompactNumber: non-finite returned as string', () => {
    assert.equal(formatCompactNumber(NaN), 'NaN');
});

// ---------------------------------------------------------------------------
// formatDataUnits
// ---------------------------------------------------------------------------

test('formatDataUnits: empty for null/undefined', () => {
    assert.equal(formatDataUnits(null), '');
    assert.equal(formatDataUnits(undefined), '');
});

test('formatDataUnits: small values in MiB', () => {
    assert.equal(formatDataUnits(1000), '488 MiB');
});

test('formatDataUnits: mid values in GiB', () => {
    assert.equal(formatDataUnits(500000), '238.4 GiB');
    assert.equal(formatDataUnits(2000000), '953.7 GiB');
});

test('formatDataUnits: large values in TiB', () => {
    // 1 TiB = 2^40 bytes; units threshold = 2^40 / 512000 = 2147484.8 units
    assert.equal(formatDataUnits(2200000), '1.02 TiB');
});

// ---------------------------------------------------------------------------
// formatPowerOnHours
// ---------------------------------------------------------------------------

test('formatPowerOnHours: empty for null/undefined', () => {
    assert.equal(formatPowerOnHours(null), '');
    assert.equal(formatPowerOnHours(undefined), '');
});

test('formatPowerOnHours: sub-day shows hours', () => {
    assert.equal(formatPowerOnHours(5), '5h');
    assert.equal(formatPowerOnHours(23), '23h');
});

test('formatPowerOnHours: under a year shows days and hours', () => {
    assert.equal(formatPowerOnHours(48), '2d 0h');
    assert.equal(formatPowerOnHours(8000), '333d 8h');
});

test('formatPowerOnHours: over a year shows years and days', () => {
    // 18720h = 780 days = 2y 50d
    assert.equal(formatPowerOnHours(18720), '2y 50d');
});

test('formatPowerOnHours: non-finite falls back to <n>h', () => {
    assert.equal(formatPowerOnHours('abc'), 'abch');
});

// ---------------------------------------------------------------------------
// spareGaugeColor
// ---------------------------------------------------------------------------

const COLOR_RED = [0.75, 0.11, 0.14];
const COLOR_ORANGE = [0.88, 0.48, 0.14];
const COLOR_GREEN = [0.18, 0.68, 0.34];

test('spareGaugeColor: red below 15%', () => {
    assert.deepEqual(spareGaugeColor(0), COLOR_RED);
    assert.deepEqual(spareGaugeColor(14), COLOR_RED);
});

test('spareGaugeColor: orange below 50%', () => {
    assert.deepEqual(spareGaugeColor(15), COLOR_ORANGE);
    assert.deepEqual(spareGaugeColor(49), COLOR_ORANGE);
});

test('spareGaugeColor: green at 50% and above', () => {
    assert.deepEqual(spareGaugeColor(50), COLOR_GREEN);
    assert.deepEqual(spareGaugeColor(100), COLOR_GREEN);
});

// ---------------------------------------------------------------------------
// usedGaugeColor (inverted logic)
// ---------------------------------------------------------------------------

test('usedGaugeColor: green below 50%', () => {
    assert.deepEqual(usedGaugeColor(0), COLOR_GREEN);
    assert.deepEqual(usedGaugeColor(49), COLOR_GREEN);
});

test('usedGaugeColor: orange at 50% and up to 84%', () => {
    assert.deepEqual(usedGaugeColor(50), COLOR_ORANGE);
    assert.deepEqual(usedGaugeColor(84), COLOR_ORANGE);
});

test('usedGaugeColor: red at 85% and above', () => {
    assert.deepEqual(usedGaugeColor(85), COLOR_RED);
    assert.deepEqual(usedGaugeColor(100), COLOR_RED);
});

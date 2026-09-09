/**
 * Unit tests for temperature line formatting.
 *
 * Run with: node --test nvme-monitor@rloutrel.github.com/test/tempFormat.test.js
 *
 * Uses Node's built-in test runner (no dependencies) since this GNOME
 * Shell extension has no Node/npm test infrastructure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    formatTempCelsius,
    formatTemperatureLine,
    formatSensorRows,
} from '../tempFormat.js';

// ---------------------------------------------------------------------------
// formatTempCelsius
// ---------------------------------------------------------------------------
test('formatTempCelsius: rounds to one decimal with French comma', () => {
    assert.strictEqual(formatTempCelsius(42), '42,0');
    assert.strictEqual(formatTempCelsius(42.5), '42,5');
    assert.strictEqual(formatTempCelsius(41.04), '41,0');
    assert.strictEqual(formatTempCelsius(41.06), '41,1');
});

test('formatTempCelsius: returns ? for null/undefined', () => {
    assert.strictEqual(formatTempCelsius(null), '?');
    assert.strictEqual(formatTempCelsius(undefined), '?');
});

// ---------------------------------------------------------------------------
// formatTemperatureLine — Samsung
// ---------------------------------------------------------------------------
test('Samsung with 2 sensors appends Controller + NAND', () => {
    const line = formatTemperatureLine('Samsung', 42, [41, 45]);
    assert.strictEqual(line, '42,0°C (Controller: 41,0°C; NAND: 45,0°C)');
});

test('Samsung with >2 sensors uses the first two (controller, NAND)', () => {
    const line = formatTemperatureLine('Samsung', 55.5, [54, 57, 60]);
    assert.strictEqual(line, '55,5°C (Controller: 54,0°C; NAND: 57,0°C)');
});

test('Samsung with only 1 sensor falls back to generic detail', () => {
    const line = formatTemperatureLine('Samsung', 42, [41]);
    assert.strictEqual(line, '42,0°C (Sensor 1: 41,0°C)');
});

test('Samsung with no sensors renders only the composite', () => {
    const line = formatTemperatureLine('Samsung', 42, []);
    assert.strictEqual(line, '42,0°C');
});

// ---------------------------------------------------------------------------
// formatTemperatureLine — generic / other manufacturers
// ---------------------------------------------------------------------------
test('Generic manufacturer with sensors appends Sensor N list', () => {
    const line = formatTemperatureLine('WD', 42, [41, 45]);
    assert.strictEqual(line, '42,0°C (Sensor 1: 41,0°C; Sensor 2: 45,0°C)');
});

test('Unknown manufacturer with sensors appends Sensor N list', () => {
    const line = formatTemperatureLine('Unknown', 38.5, [37]);
    assert.strictEqual(line, '38,5°C (Sensor 1: 37,0°C)');
});

test('Generic manufacturer with no sensors renders only the composite', () => {
    const line = formatTemperatureLine('WD', 42, []);
    assert.strictEqual(line, '42,0°C');
});

test('null composite returns null (no temperature line)', () => {
    assert.strictEqual(formatTemperatureLine('Samsung', null, [41, 45]), null);
    assert.strictEqual(formatTemperatureLine('WD', undefined, []), null);
});

test('missing sensor values render as ? placeholder', () => {
    const line = formatTemperatureLine('Samsung', 42, [null, undefined]);
    assert.strictEqual(line, '42,0°C (Controller: ?°C; NAND: ?°C)');
});

// ---------------------------------------------------------------------------
// formatSensorRows — separate per-sensor rows (non-Samsung only)
// ---------------------------------------------------------------------------
test('non-Samsung with sensors produces one row per sensor', () => {
    const rows = formatSensorRows('WD', [41, 45, 48]);
    assert.deepStrictEqual(rows, [
        { text: '  Sensor 1: 41,0°C', temp: 41 },
        { text: '  Sensor 2: 45,0°C', temp: 45 },
        { text: '  Sensor 3: 48,0°C', temp: 48 },
    ]);
});

test('Samsung never produces separate sensor rows', () => {
    assert.deepStrictEqual(formatSensorRows('Samsung', [41, 45]), []);
});

test('no sensors produces no rows', () => {
    assert.deepStrictEqual(formatSensorRows('WD', []), []);
    assert.deepStrictEqual(formatSensorRows('Unknown', []), []);
});

test('sensor rows preserve null temp for placeholder text', () => {
    const rows = formatSensorRows('WD', [null]);
    assert.deepStrictEqual(rows, [{ text: '  Sensor 1: ?°C', temp: null }]);
});

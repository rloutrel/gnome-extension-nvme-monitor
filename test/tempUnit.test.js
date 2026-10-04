import test from 'node:test';
import assert from 'node:assert/strict';

import {
    TEMP_UNIT_CELSIUS,
    TEMP_UNIT_FAHRENHEIT,
    celsiusToFahrenheit,
    toDisplayTemp,
    tempSuffix,
    isValidUnit,
    detectTemperatureUnit,
} from '../nvme-monitor@rloutrel.github.com/tempUnit.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test('tempUnit: exports correct constant values', () => {
    assert.equal(TEMP_UNIT_CELSIUS, 'celsius');
    assert.equal(TEMP_UNIT_FAHRENHEIT, 'fahrenheit');
});

// ---------------------------------------------------------------------------
// celsiusToFahrenheit
// ---------------------------------------------------------------------------

test('celsiusToFahrenheit: converts known values', () => {
    assert.equal(celsiusToFahrenheit(0), 32);
    assert.equal(celsiusToFahrenheit(100), 212);
    assert.equal(celsiusToFahrenheit(-40), -40);
    assert.equal(celsiusToFahrenheit(42), 107.6);
});

// ---------------------------------------------------------------------------
// toDisplayTemp
// ---------------------------------------------------------------------------

test('toDisplayTemp: returns celsius unchanged for celsius unit', () => {
    assert.equal(toDisplayTemp(42, TEMP_UNIT_CELSIUS), 42);
});

test('toDisplayTemp: converts for fahrenheit unit', () => {
    assert.equal(toDisplayTemp(42, TEMP_UNIT_FAHRENHEIT), 107.6);
});

test('toDisplayTemp: passes null/undefined through', () => {
    assert.equal(toDisplayTemp(null, TEMP_UNIT_FAHRENHEIT), null);
    assert.equal(toDisplayTemp(undefined, TEMP_UNIT_CELSIUS), null);
});

// ---------------------------------------------------------------------------
// tempSuffix
// ---------------------------------------------------------------------------

test('tempSuffix: returns the degree suffix per unit', () => {
    assert.equal(tempSuffix(TEMP_UNIT_CELSIUS), '\u00b0C');
    assert.equal(tempSuffix(TEMP_UNIT_FAHRENHEIT), '\u00b0F');
});

// ---------------------------------------------------------------------------
// isValidUnit
// ---------------------------------------------------------------------------

test('isValidUnit: accepts the two supported units only', () => {
    assert.equal(isValidUnit(TEMP_UNIT_CELSIUS), true);
    assert.equal(isValidUnit(TEMP_UNIT_FAHRENHEIT), true);
    assert.equal(isValidUnit('kelvin'), false);
    assert.equal(isValidUnit(''), false);
    assert.equal(isValidUnit(null), false);
});

// ---------------------------------------------------------------------------
// detectTemperatureUnit
// ---------------------------------------------------------------------------

const makeEnv = (vars) => (name) => vars[name] ?? null;

test('detectTemperatureUnit: US locale maps to fahrenheit', () => {
    assert.equal(detectTemperatureUnit(makeEnv({ LANG: 'en_US.UTF-8' })), TEMP_UNIT_FAHRENHEIT);
    assert.equal(detectTemperatureUnit(makeEnv({ LC_ALL: 'en_US.utf8' })), TEMP_UNIT_FAHRENHEIT);
    assert.equal(detectTemperatureUnit(makeEnv({ LC_MEASUREMENT: 'es_US.UTF-8' })), TEMP_UNIT_FAHRENHEIT);
});

test('detectTemperatureUnit: non-US locale maps to celsius', () => {
    assert.equal(detectTemperatureUnit(makeEnv({ LANG: 'fr_FR.UTF-8' })), TEMP_UNIT_CELSIUS);
    assert.equal(detectTemperatureUnit(makeEnv({ LC_ALL: 'de_DE.UTF-8' })), TEMP_UNIT_CELSIUS);
    assert.equal(detectTemperatureUnit(makeEnv({ LANG: 'en_GB.UTF-8' })), TEMP_UNIT_CELSIUS);
});

test('detectTemperatureUnit: LC_MEASUREMENT takes precedence', () => {
    assert.equal(
        detectTemperatureUnit(makeEnv({ LC_MEASUREMENT: 'fr_FR.UTF-8', LANG: 'en_US.UTF-8' })),
        TEMP_UNIT_CELSIUS);
});

test('detectTemperatureUnit: LC_ALL overrides LANG', () => {
    assert.equal(
        detectTemperatureUnit(makeEnv({ LC_ALL: 'en_US.UTF-8', LANG: 'fr_FR.UTF-8' })),
        TEMP_UNIT_FAHRENHEIT);
});

test('detectTemperatureUnit: neutral or missing locale falls back to celsius', () => {
    assert.equal(detectTemperatureUnit(makeEnv({})), TEMP_UNIT_CELSIUS);
    assert.equal(detectTemperatureUnit(makeEnv({ LANG: 'C' })), TEMP_UNIT_CELSIUS);
    assert.equal(detectTemperatureUnit(makeEnv({ LANG: 'POSIX' })), TEMP_UNIT_CELSIUS);
});

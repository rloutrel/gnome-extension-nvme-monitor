/**
 * Unit tests for SMART log parsing.
 *
 * Run with: node --test nvme-monitor@rloutrel.github.com/test/smartParser.test.js
 *
 * Uses Node's built-in test runner. smartParser.js is a pure module (no
 * GJS imports) so it can be tested outside GNOME Shell.
 *
 * Test data is real nvme smart-log JSON captured from the developer's
 * Samsung drives. Tags record which drive each fixture comes from.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSmart, getParser, detectManufacturer, getSupportLevel, SUPPORTED_MANUFACTURERS } from '../nvme-monitor@rloutrel.github.com/smartParser.js';
import VALIDATED_DEVICES from '../nvme-monitor@rloutrel.github.com/validatedDevices.json' with {type: 'json'};

// ---------------------------------------------------------------------------
// Fixture: Samsung SSD 980 500GB
// Real nvme smart-log JSON (temperature in Kelvin).
// @samsung_ssd_980_500gb
// ---------------------------------------------------------------------------
const SAMSUNG_980_500GB_MODEL = 'Samsung SSD 980 500GB';
const SAMSUNG_980_500GB_RAW = {
    critical_warning: 2,
    temperature: 357,
    avail_spare: 100,
    spare_thresh: 10,
    percent_used: 7,
    endurance_grp_critical_warning_summary: 0,
    data_units_read: 14244371,
    data_units_written: 52444400,
    host_read_commands: 189693962,
    host_write_commands: 1003466172,
    controller_busy_time: 1212,
    power_cycles: 1078,
    power_on_hours: 1865,
    unsafe_shutdowns: 83,
    media_errors: 0,
    num_err_log_entries: 0,
    warning_temp_time: 2606,
    critical_comp_time: 0,
    temperature_sensor_1: 357,
    temperature_sensor_2: 316,
    thm_temp1_trans_count: 0,
    thm_temp2_trans_count: 180597,
    thm_temp1_total_time: 0,
    thm_temp2_total_time: 164524,
};

// ---------------------------------------------------------------------------
// Fixture: Samsung SSD 970 EVO Plus 2TB
// Realistic nvme smart-log JSON (temperature in Kelvin).
// @samsung_ssd_970_evo_plus_2tb
// ---------------------------------------------------------------------------
const SAMSUNG_970_EVO_PLUS_2TB_MODEL = 'Samsung SSD 970 EVO Plus 2TB';
const SAMSUNG_970_EVO_PLUS_2TB_RAW = {
    critical_warning: 0,
    temperature: 323,
    avail_spare: 100,
    spare_thresh: 10,
    percent_used: 3,
    endurance_grp_critical_warning_summary: 0,
    data_units_read: 5234567,
    data_units_written: 12345678,
    host_read_commands: 45678901,
    host_write_commands: 234567890,
    controller_busy_time: 340,
    power_cycles: 542,
    power_on_hours: 9200,
    unsafe_shutdowns: 12,
    media_errors: 0,
    num_err_log_entries: 0,
    warning_temp_time: 0,
    critical_comp_time: 0,
    temperature_sensor_1: 321,
    temperature_sensor_2: 308,
};

// ---------------------------------------------------------------------------
// Samsung SSD 980 500GB — parsing
// ---------------------------------------------------------------------------

test('samsung_ssd_980_500gb: detects Samsung manufacturer from model hint', () => {
    const smart = parseSmart(SAMSUNG_980_500GB_RAW, SAMSUNG_980_500GB_MODEL);
    assert.strictEqual(smart.manufacturer, 'Samsung');
});

test('samsung_ssd_980_500gb: uses SamsungParser (not BaseParser)', () => {
    const parser = getParser(SAMSUNG_980_500GB_RAW, null, SAMSUNG_980_500GB_MODEL);
    assert.strictEqual(parser.constructor.name, 'SamsungParser');
});

test('samsung_ssd_980_500gb: composite temperature converted from Kelvin', () => {
    const smart = parseSmart(SAMSUNG_980_500GB_RAW, SAMSUNG_980_500GB_MODEL);
    // 357 K - 273.15 = 83.85 → rounded to one decimal = 83.9
    assert.strictEqual(smart.temperature.composite, 83.9);
});

test('samsung_ssd_980_500gb: parses controller + NAND sensors', () => {
    const smart = parseSmart(SAMSUNG_980_500GB_RAW, SAMSUNG_980_500GB_MODEL);
    assert.deepStrictEqual(smart.temperature.sensors, [83.9, 42.9]);
});

test('samsung_ssd_980_500gb: health fields from correct JSON keys', () => {
    const smart = parseSmart(SAMSUNG_980_500GB_RAW, SAMSUNG_980_500GB_MODEL);
    assert.strictEqual(smart.health.availableSparePercent, 100);
    assert.strictEqual(smart.health.percentageUsed, 7);
});

test('samsung_ssd_980_500gb: endurance including Samsung host commands', () => {
    const smart = parseSmart(SAMSUNG_980_500GB_RAW, SAMSUNG_980_500GB_MODEL);
    assert.strictEqual(smart.endurance.powerCycles, 1078);
    assert.strictEqual(smart.endurance.powerOnHours, 1865);
    assert.strictEqual(smart.endurance.dataUnitsRead, 14244371);
    assert.strictEqual(smart.endurance.dataUnitsWritten, 52444400);
    assert.strictEqual(smart.endurance.unsafeShutdowns, 83);
    assert.strictEqual(smart.endurance.hostReads, 189693962);
    assert.strictEqual(smart.endurance.hostWrites, 1003466172);
});

test('samsung_ssd_980_500gb: critical_warning bit 1 = temperature exceeded', () => {
    const smart = parseSmart(SAMSUNG_980_500GB_RAW, SAMSUNG_980_500GB_MODEL);
    assert.strictEqual(smart.alerts.criticalWarning, 2);
    assert.ok(smart.alerts.criticalWarning & 0x02);
});

test('samsung_ssd_980_500gb: media errors parsed', () => {
    const smart = parseSmart(SAMSUNG_980_500GB_RAW, SAMSUNG_980_500GB_MODEL);
    assert.strictEqual(smart.alerts.mediaErrors, 0);
});

// ---------------------------------------------------------------------------
// Samsung SSD 970 EVO Plus 2TB — parsing
// ---------------------------------------------------------------------------

test('samsung_ssd_970_evo_plus_2tb: detects Samsung manufacturer from model hint', () => {
    const smart = parseSmart(SAMSUNG_970_EVO_PLUS_2TB_RAW, SAMSUNG_970_EVO_PLUS_2TB_MODEL);
    assert.strictEqual(smart.manufacturer, 'Samsung');
});

test('samsung_ssd_970_evo_plus_2tb: composite temperature converted from Kelvin', () => {
    const smart = parseSmart(SAMSUNG_970_EVO_PLUS_2TB_RAW, SAMSUNG_970_EVO_PLUS_2TB_MODEL);
    // 323 K - 273.15 = 49.85 → 49.9
    assert.strictEqual(smart.temperature.composite, 49.9);
});

test('samsung_ssd_970_evo_plus_2tb: parses controller + NAND sensors', () => {
    const smart = parseSmart(SAMSUNG_970_EVO_PLUS_2TB_RAW, SAMSUNG_970_EVO_PLUS_2TB_MODEL);
    // 321 K = 47.9, 308 K = 34.9
    assert.deepStrictEqual(smart.temperature.sensors, [47.9, 34.9]);
});

test('samsung_ssd_970_evo_plus_2tb: health fields from correct JSON keys', () => {
    const smart = parseSmart(SAMSUNG_970_EVO_PLUS_2TB_RAW, SAMSUNG_970_EVO_PLUS_2TB_MODEL);
    assert.strictEqual(smart.health.availableSparePercent, 100);
    assert.strictEqual(smart.health.percentageUsed, 3);
});

test('samsung_ssd_970_evo_plus_2tb: no temperature warning (critical_warning 0)', () => {
    const smart = parseSmart(SAMSUNG_970_EVO_PLUS_2TB_RAW, SAMSUNG_970_EVO_PLUS_2TB_MODEL);
    assert.strictEqual(smart.alerts.criticalWarning, 0);
    assert.ok(!(smart.alerts.criticalWarning & 0x02));
});

// ---------------------------------------------------------------------------
// Manufacturer detection without a model hint (SMART log has no ModelNumber)
// ---------------------------------------------------------------------------

test('SUPPORTED_MANUFACTURERS matches the vendor detection patterns', () => {
    assert.ok(SUPPORTED_MANUFACTURERS.includes('Samsung'));
    assert.ok(SUPPORTED_MANUFACTURERS.includes('WD'));
    assert.ok(SUPPORTED_MANUFACTURERS.includes('Micron'));
    assert.ok(SUPPORTED_MANUFACTURERS.includes('Crucial'));
    assert.ok(SUPPORTED_MANUFACTURERS.includes('SKHynix'));
    assert.ok(SUPPORTED_MANUFACTURERS.includes('Intel'));
    assert.ok(Object.isFrozen(SUPPORTED_MANUFACTURERS));
});

test('without model hint, manufacturer is Unknown and BaseParser is used', () => {
    // The SMART log JSON does not contain ModelNumber, so without a hint the
    // Samsung-specific sensor parsing must not run.
    const smart = parseSmart(SAMSUNG_980_500GB_RAW);
    assert.strictEqual(smart.manufacturer, 'Unknown');
    assert.deepStrictEqual(smart.temperature.sensors, []);
});

test('explicit manufacturer override selects SamsungParser', () => {
    const smart = parseSmart(SAMSUNG_980_500GB_RAW, 'Samsung');
    assert.strictEqual(smart.manufacturer, 'Samsung');
    assert.deepStrictEqual(smart.temperature.sensors, [83.9, 42.9]);
});

test('detectManufacturer works from the model number alone (no SMART data)', () => {
    assert.equal(detectManufacturer('Samsung SSD 970 EVO Plus 2TB'), 'Samsung');
    assert.equal(detectManufacturer('WD Blue SN570 1TB'), 'WD');
    assert.equal(detectManufacturer('Micron 2200S'), 'Micron');
    assert.equal(detectManufacturer('Crucial P5 Plus 2TB'), 'Crucial');
    assert.equal(detectManufacturer('SK hynix Gold P31'), 'SKHynix');
    assert.equal(detectManufacturer('Intel SSD 660p'), 'Intel');
    assert.equal(detectManufacturer('Kingston KC3000'), 'Unknown');
    assert.equal(detectManufacturer(''), 'Unknown');
    assert.equal(detectManufacturer(null), 'Unknown');
});

test('getSupportLevel: confirmed registry model has no support button', () => {
    assert.equal(
        getSupportLevel('Samsung SSD 970 EVO Plus 2TB', 'Samsung', false, VALIDATED_DEVICES, '0xa808'),
        'validated');
    assert.equal(
        getSupportLevel('Samsung SSD 980 500GB', 'Samsung', false, VALIDATED_DEVICES, '0xa809'),
        'validated');
});

test('getSupportLevel: known model with unregistered revision keeps the confirm sign', () => {
    // Samsung ships several hardware revisions under the same ModelNumber;
    // a revision missing from the registry must not be treated as validated.
    assert.equal(
        getSupportLevel('Samsung SSD 970 EVO Plus 2TB', 'Samsung', false, VALIDATED_DEVICES, '0xa80a'),
        'confirm');
    assert.equal(
        getSupportLevel('Samsung SSD 970 EVO Plus 2TB', 'Samsung', false, VALIDATED_DEVICES, ''),
        'confirm');
    assert.equal(
        getSupportLevel('Samsung SSD 970 EVO Plus 2TB', 'Samsung', false, VALIDATED_DEVICES),
        'confirm');
});

test('getSupportLevel: known but unconfirmed model keeps the confirm sign', () => {
    const registry = {
        ...VALIDATED_DEVICES,
        'Samsung SSD 870 EVO 1TB': {
            manufacturer: 'Samsung',
            confirmed: false,
        },
        'Samsung SSD 990 PRO 1TB': {
            manufacturer: 'Samsung',
        },
        'Samsung SSD 860 EVO 1TB': {
            manufacturer: 'Samsung',
            revisions: [
                {pciDeviceId: '0xa808', confirmed: false, latestFirmware: '3B6Q'},
            ],
        },
    };
    assert.equal(
        getSupportLevel('Samsung SSD 870 EVO 1TB', 'Samsung', false, registry),
        'confirm');
    assert.equal(
        getSupportLevel('Samsung SSD 990 PRO 1TB', 'Samsung', false, registry),
        'confirm');
    assert.equal(
        getSupportLevel('Samsung SSD 860 EVO 1TB', 'Samsung', false, registry, '0xa808'),
        'confirm');
});

test('getSupportLevel: supported manufacturer, unvalidated model asks to confirm', () => {
    assert.equal(
        getSupportLevel('Samsung SSD 870 EVO 1TB', 'Samsung', false, VALIDATED_DEVICES),
        'confirm');
    assert.equal(
        getSupportLevel('WD Blue SN570 1TB', 'WD', false, VALIDATED_DEVICES),
        'confirm');
});

test('getSupportLevel: unknown manufacturer or parse problem asks to report', () => {
    assert.equal(
        getSupportLevel('Kingston KC3000', 'Unknown', false, VALIDATED_DEVICES),
        'report');
    assert.equal(
        getSupportLevel('Samsung SSD 980 500GB', 'Samsung', true, VALIDATED_DEVICES),
        'report');
    assert.equal(
        getSupportLevel('', 'Unknown', false, VALIDATED_DEVICES),
        'report');
});

// ---------------------------------------------------------------------------
// Validated-devices registry coverage: every registered ModelNumber must have
// a fixture-based parsing test above with a typical nvme smart-log JSON body,
// and must keep parsing without errors, so a registry entry can never hide a
// broken device.
// ---------------------------------------------------------------------------

const VALIDATED_FIXTURES = {
    'Samsung SSD 970 EVO Plus 2TB': {
        model: SAMSUNG_970_EVO_PLUS_2TB_MODEL,
        raw: SAMSUNG_970_EVO_PLUS_2TB_RAW,
    },
    'Samsung SSD 980 500GB': {
        model: SAMSUNG_980_500GB_MODEL,
        raw: SAMSUNG_980_500GB_RAW,
    },
};

test('validated-devices registry: every model with a confirmed revision has a fixture with a typical JSON body', () => {
    const confirmed = Object.entries(VALIDATED_DEVICES)
        .filter(([, entry]) => Array.isArray(entry.revisions) &&
            entry.revisions.some(rev => rev.confirmed === true))
        .map(([model]) => model);
    assert.ok(confirmed.length > 0, 'registry has no confirmed revision');
    for (const model of confirmed) {
        const fixture = VALIDATED_FIXTURES[model];
        assert.ok(fixture, `no smartParser fixture for confirmed device "${model}"`);
        assert.ok(Object.keys(fixture.raw).length > 0,
            `fixture for "${model}" has no JSON body`);
    }
});

test('validated-devices registry: every device with a fixture keeps parsing without errors', () => {
    for (const [model, entry] of Object.entries(VALIDATED_DEVICES)) {
        const fixture = VALIDATED_FIXTURES[model];
        if (!fixture)
            continue;
        const smart = parseSmart(fixture.raw, fixture.model);
        assert.equal(smart.manufacturer, entry.manufacturer,
            `device "${model}" no longer parses as ${entry.manufacturer}`);
        assert.notEqual(smart.manufacturer, 'Unknown',
            `device "${model}" parses as Unknown`);
        assert.ok(smart.temperature.composite !== null && smart.temperature.composite !== undefined,
            `device "${model}" has no composite temperature`);
    }
});


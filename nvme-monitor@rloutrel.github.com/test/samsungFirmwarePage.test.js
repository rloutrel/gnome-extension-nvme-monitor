/**
 * Unit tests for the Samsung firmware page scraper (pure half).
 *
 * Run with: node --test nvme-monitor@rloutrel.github.com/test/samsungFirmwarePage.test.js
 *
 * samsungFirmwarePage.js is a pure module (no GJS imports, no I/O) so
 * it is tested outside GNOME Shell against realistic HTML snippets
 * mirroring Samsung's tools page layout.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseSamsungFirmwareEntries,
    planRegistryUpdate,
    buildUpdatePlan,
    SAMSUNG_MODEL_ALIASES,
} from '../tools/samsungFirmwarePage.js';
import VALIDATED_DEVICES from '../validatedDevices.json' with {type: 'json'};

// Mirrors the download-list block structure of
// semiconductor.samsung.com/consumer-storage/support/tools/.
const PAGE_SNIPPET = `
<div class="download-list">
  <div class="download-list-tit"><p>NVMe SSD-990 PRO Series Firmware</p></div>
  <div class="download-list-con"><a href="...iso" target="_blank">
    <span class="version">ISO 8B2QJXD7 | 50MB</span></a></div>
</div>
<div class="download-list">
  <div class="download-list-tit"><p>NVMe SSD-970 EVO Plus Firmware</p></div>
  <div class="download-list-con"><a href="...iso" target="_blank"
    data-an-la="nvme ssd-970 evo plus firmware">
    <span class="version">ISO 4B2QEXM7 | 26MB</span></a></div>
</div>
<div class="download-list">
  <div class="download-list-tit"><p>NVMe SSD 980 Firmware</p></div>
  <div class="download-list-con"><a href="...iso" target="_blank">
    <span class="version">ISO 3B4QFXO7 | 26MB</span></a></div>
</div>
<div class="download-list">
  <div class="download-list-tit"><p>NVMe SSD-970 EVO Firmware</p></div>
  <div class="download-list-con"><a href="...iso" target="_blank">
    <span class="version">ISO 2B2QEXE7 | 17.4MB</span></a></div>
</div>
<div class="download-list">
  <div class="download-list-tit"><p>SATA SSD-870 EVO Firmware</p></div>
  <div class="download-list-con"><a href="...iso" target="_blank">
    <span class="version">ISO SVT04B6Q | 21MB</span></a></div>
</div>
<div class="download-list">
  <div class="download-list-tit"><p>NVMe SSD-Firmware Installation Guide</p></div>
  <div class="download-list-con"><a href="...pdf" target="_blank">
    <span class="version">0.55MB</span></a></div>
</div>
`;

test('parseSamsungFirmwareEntries: extracts NVMe aliases with their version', () => {
    const entries = parseSamsungFirmwareEntries(PAGE_SNIPPET);
    assert.deepEqual(entries, [
        {pageTitle: 'NVMe SSD-990 PRO', firmware: '8B2QJXD7'},
        {pageTitle: 'NVMe SSD-970 EVO Plus', firmware: '4B2QEXM7'},
        {pageTitle: 'NVMe SSD 980', firmware: '3B4QFXO7'},
        {pageTitle: 'NVMe SSD-970 EVO', firmware: '2B2QEXE7'},
    ]);
});

test('parseSamsungFirmwareEntries: skips SATA, guides and unknown titles', () => {
    const entries = parseSamsungFirmwareEntries(PAGE_SNIPPET);
    const titles = entries.map(e => e.pageTitle);
    assert.ok(!titles.includes('SATA SSD-870 EVO'));
    assert.ok(!titles.some(t => t.includes('Installation Guide')));
});

test('parseSamsungFirmwareEntries: tolerates empty or malformed HTML', () => {
    assert.deepEqual(parseSamsungFirmwareEntries(''), []);
    assert.deepEqual(parseSamsungFirmwareEntries(null), []);
    assert.deepEqual(parseSamsungFirmwareEntries('<div>no lists</div>'), []);
    const noVersion = '<div class="download-list-tit"><p>NVMe SSD 980 Firmware</p></div>';
    assert.deepEqual(parseSamsungFirmwareEntries(noVersion), []);
});

test('planRegistryUpdate: multi-revision models always go to manual review', () => {
    const entry = {
        manufacturer: 'Samsung',
        revisions: [{pciDeviceId: '0xa808', confirmed: true, latestFirmware: '2B2QEXM7'}],
    };
    const plan = planRegistryUpdate(entry, 'Samsung SSD 970 EVO Plus 2TB', '4B2QEXM7');
    assert.equal(plan.action, 'manual-review');
});

test('planRegistryUpdate: single-revision model updates when the page differs', () => {
    const entry = {
        manufacturer: 'Samsung',
        revisions: [{pciDeviceId: '0xa999', confirmed: true, latestFirmware: '1B4QFXO7'}],
    };
    const plan = planRegistryUpdate(entry, 'Samsung SSD 990 EVO 1TB', '5B2QKXJ7');
    assert.equal(plan.action, 'update');
    assert.equal(plan.latestFirmware, '5B2QKXJ7');
});

test('planRegistryUpdate: single-revision model is current when versions match', () => {
    const entry = {
        manufacturer: 'Samsung',
        revisions: [{pciDeviceId: '0xa999', confirmed: true, latestFirmware: '5B2QKXJ7'}],
    };
    const plan = planRegistryUpdate(entry, 'Samsung SSD 990 EVO 1TB', '5B2QKXJ7');
    assert.equal(plan.action, 'current');
});

test('planRegistryUpdate: several registered revisions need manual review', () => {
    const entry = {
        manufacturer: 'Samsung',
        revisions: [
            {pciDeviceId: '0xa808', confirmed: true, latestFirmware: '2B2QEXM7'},
            {pciDeviceId: '0xa80a', confirmed: true, latestFirmware: '4B2QEXM7'},
        ],
    };
    const plan = planRegistryUpdate(entry, 'Samsung SSD 970 EVO Plus 2TB', '4B2QEXM7');
    assert.equal(plan.action, 'manual-review');
});

test('buildUpdatePlan: routes the real registry against a realistic scrape', () => {
    const scraped = [
        {pageTitle: 'NVMe SSD-970 EVO Plus', firmware: '4B2QEXM7'},
        {pageTitle: 'NVMe SSD 980', firmware: '3B4QFXO7'},
    ];
    const plan = buildUpdatePlan(VALIDATED_DEVICES, scraped);
    assert.equal(plan.length, 2);
    const byModel = Object.fromEntries(plan.map(p => [p.modelNumber, p]));
    // Both registered models are multi-revision: manual review, never
    // auto-filled, even though the page versions differ from the
    // registry values.
    assert.equal(byModel['Samsung SSD 970 EVO Plus 2TB'].action, 'manual-review');
    assert.equal(byModel['Samsung SSD 980 500GB'].action, 'manual-review');
});

test('buildUpdatePlan: 970 EVO page entry must not match a 970 EVO Plus registry entry', () => {
    const registry = {
        ...VALIDATED_DEVICES,
        'Samsung SSD 970 EVO 1TB': {
            manufacturer: 'Samsung',
            revisions: [{pciDeviceId: '0xa808', confirmed: true, latestFirmware: '2B2QEXE7'}],
        },
    };
    const plan = buildUpdatePlan(registry, [
        {pageTitle: 'NVMe SSD-970 EVO', firmware: '2B2QEXE7'},
        {pageTitle: 'NVMe SSD-970 EVO Plus', firmware: '4B2QEXM7'},
    ]);
    const matched = plan.map(p => p.modelNumber);
    assert.ok(!matched.includes('Samsung SSD 970 EVO Plus 2TB\u00a0'),
        'the 970 EVO page entry must only match the 970 EVO model');
    assert.deepEqual(matched.sort(), [
        'Samsung SSD 970 EVO 1TB',
        'Samsung SSD 970 EVO Plus 2TB',
    ]);
    // Each page entry matched exactly its own model.
    const evo = plan.find(p => p.modelNumber === 'Samsung SSD 970 EVO 1TB');
    const evoPlus = plan.find(p => p.modelNumber === 'Samsung SSD 970 EVO Plus 2TB');
    assert.equal(evo.pageFirmware, '2B2QEXE7');
    assert.equal(evoPlus.pageFirmware, '4B2QEXM7');
});

test('buildUpdatePlan: ignores registry entries from other manufacturers', () => {
    const registry = {
        'Samsung SSD 970 EVO Plus 2TB': VALIDATED_DEVICES['Samsung SSD 970 EVO Plus 2TB'],
        'WD Blue SN570 1TB': {
            manufacturer: 'WD',
            revisions: [{pciDeviceId: '0x1b4b', confirmed: true, latestFirmware: 'G221012'}],
        },
    };
    const plan = buildUpdatePlan(registry, [
        {pageTitle: 'NVMe SSD-970 EVO Plus', firmware: '4B2QEXM7'},
    ]);
    assert.equal(plan.length, 1);
    assert.equal(plan[0].modelNumber, 'Samsung SSD 970 EVO Plus 2TB');
});

test('aliases cover the NVMe models Samsung publishes firmware for', () => {
    for (const pageTitle of Object.keys(SAMSUNG_MODEL_ALIASES))
        assert.ok(pageTitle.startsWith('NVMe SSD-') || pageTitle.startsWith('NVMe SSD '),
            `unexpected alias "${pageTitle}"`);
});

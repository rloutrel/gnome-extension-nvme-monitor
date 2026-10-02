#!/usr/bin/env node
/**
 * CLI: refresh the Samsung firmware data of the validated-devices
 * registry from Samsung Semiconductor's consumer storage tools page.
 *
 * Usage:
 *   node tools/updateSamsungFirmware.mjs [--write]
 *
 * Without --write, prints the plan and exits 0. Models known to ship
 * multiple hardware revisions (970 EVO Plus, 980, 990 PRO) are always
 * routed to manual review and never auto-filled, because Samsung's
 * page publishes a single version per model name.
 *
 * Run from the extension directory:
 *   node --test test/samsungFirmwarePage.test.js   # parsing tests
 *   node tools/updateSamsungFirmware.mjs            # dry run
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
    SAMSUNG_TOOLS_URL,
    parseSamsungFirmwareEntries,
    buildUpdatePlan,
} from './samsungFirmwarePage.js';

const toolsDir = dirname(fileURLToPath(import.meta.url));
const registryPath = join(toolsDir, '..', 'validatedDevices.json');
const write = process.argv.includes('--write');

async function fetchPage() {
    const res = await fetch(SAMSUNG_TOOLS_URL);
    if (!res.ok)
        throw new Error(`fetch failed: HTTP ${res.status}`);
    return res.text();
}

const html = await fetchPage();
const scraped = parseSamsungFirmwareEntries(html);
if (scraped.length === 0) {
    console.error('No NVMe firmware entries found; the page layout ' +
        'may have changed.');
    process.exit(1);
}

const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
const plan = buildUpdatePlan(registry, scraped);

let updates = 0;
for (const item of plan) {
    const current = item.entry.revisions?.length === 1
        ? item.entry.revisions[0].latestFirmware
        : '(none)';
    if (item.action === 'update') {
        updates++;
        console.log(`UPDATE  ${item.modelNumber}: ` +
            `${current} -> ${item.pageFirmware}`);
    } else if (item.action === 'manual-review') {
        console.log(`REVIEW  ${item.modelNumber}: page says ` +
            `${item.pageFirmware}, registry has ${current} ` +
            `(${item.reason})`);
    } else {
        console.log(`OK      ${item.modelNumber}: ${current}`);
    }
}

if (!write) {
    console.log('\nDry run: nothing written. Re-run with --write to ' +
        'apply the UPDATE lines.');
    process.exit(0);
}

if (updates === 0) {
    console.log('\nNothing to update.');
    process.exit(0);
}

for (const item of plan) {
    if (item.action !== 'update' || item.entry.revisions?.length !== 1)
        continue;
    item.entry.revisions[0].latestFirmware = item.pageFirmware;
}

writeFileSync(registryPath,
    JSON.stringify(registry, null, 4) + '\n');
console.log(`\nRegistry written: ${updates} update(s). ` +
    'REVIEW items were left untouched.');

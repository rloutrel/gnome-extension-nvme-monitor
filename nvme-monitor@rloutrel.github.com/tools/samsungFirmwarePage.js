/**
 * Samsung firmware page scraper — PURE module.
 *
 * Parses the firmware section of Samsung Semiconductor's consumer
 * storage tools page and maps Samsung marketing names to registry
 * ModelNumbers. The parsing half has zero I/O so it is unit-tested
 * against saved HTML snippets; the fetch half lives in the CLI
 * (tools/updateSamsungFirmware.mjs).
 *
 * Samsung's page does not distinguish hardware revisions under the
 * same model name (e.g. it lists 4B2QEXM7 for the 970 EVO Plus while
 * the Phoenix revision tops out at 2B2QEXM7), so the tool never
 * auto-fills multi-revision models: it reports what the page says and
 * leaves the registry update to manual review.
 */

// The page titles its download blocks like "NVMe SSD-970 EVO Plus
// Firmware" or "NVMe SSD-990 PRO Series Firmware"; the suffix is
// dropped before the alias lookup.
const FIRMWARE_SUFFIX_RE = /[ \t]*Firmware[ \t]*$/;
const SERIES_SUFFIX_RE = /[ \t]+Series$/;

export const SAMSUNG_TOOLS_URL =
    'https://semiconductor.samsung.com/consumer-storage/support/tools/';

// Samsung page marketing name -> registry ModelNumber prefix.
// Only devices the registry can legitimately track are mapped; the
// page's SATA, installer and datacenter entries are ignored.
export const SAMSUNG_MODEL_ALIASES = Object.freeze({
    'NVMe SSD-970 EVO Plus': 'Samsung SSD 970 EVO Plus',
    'NVMe SSD-970 EVO': 'Samsung SSD 970 EVO',
    'NVMe SSD-970 PRO': 'Samsung SSD 970 PRO',
    'NVMe SSD-980 PRO': 'Samsung SSD 980 PRO',
    'NVMe SSD 980': 'Samsung SSD 980',
    'NVMe SSD-990 EVO': 'Samsung SSD 990 EVO',
    'NVMe SSD-990 EVO Plus': 'Samsung SSD 990 EVO Plus',
    'NVMe SSD-990 PRO': 'Samsung SSD 990 PRO',
});

// Registry models known (or strongly suspected) to ship several
// hardware revisions under the same ModelNumber, so the page's single
// version cannot be trusted for them. Keyed by ModelNumber prefix.
// - 970 EVO Plus: Phoenix (0xa808, 2B2QEXM7) and Elpis revisions.
// - 980: the page itself notes a "revised V6 process starting
//   December 2023" (3B4QFXO7) while earlier drives stay on 1B4QFXO7.
// - 990 PRO: the page notes a "mixed production between the V7 and V8
//   process starting September 2023".
export const MULTI_REVISION_MODELS = Object.freeze([
    'Samsung SSD 970 EVO Plus',
    'Samsung SSD 980',
    'Samsung SSD 990 PRO',
]);

/**
 * Extract the NVMe firmware entries from the page HTML: one
 * {pageTitle, firmware} pair per download list block whose title
 * matches a known NVMe alias.
 *
 * @param {string} html - Raw HTML of the Samsung tools page.
 * @returns {Array<{pageTitle: string, firmware: string}>} in page
 *   order; titles matching no known alias are skipped.
 */
export function parseSamsungFirmwareEntries(html) {
    const text = String(html || '');
    const entries = [];
    const blocks = text.split('download-list-tit');
    for (let i = 1; i < blocks.length; i++) {
        const titleMatch = blocks[i].match(/<p>([^<]+)<\/p>/);
        if (!titleMatch)
            continue;
        const pageTitle = titleMatch[1]
            .trim()
            .replace(FIRMWARE_SUFFIX_RE, '')
            .replace(SERIES_SUFFIX_RE, '');
        if (!SAMSUNG_MODEL_ALIASES[pageTitle])
            continue;
        const versionMatch = blocks[i].match(
            /class="version"[^>]*>\s*ISO\s+([0-9A-Z]+)\s*\|/);
        if (!versionMatch)
            continue;
        entries.push({pageTitle, firmware: versionMatch[1]});
    }
    return entries;
}

/**
 * Registry analysis for one scrape result.
 *
 * @param {Object} entry - Validated-devices registry entry
 *   ({manufacturer, revisions: [{pciDeviceId, confirmed, latestFirmware}]}).
 * @param {string} modelNumber - Full ModelNumber of the registry entry.
 * @param {string} pageFirmware - Firmware version listed on the page.
 * @returns {Object} {action, reason}:
 *   - {action: 'manual-review', ...} when the model is known to ship
 *     multiple hardware revisions: the page's single version may not
 *     apply to every revision (or any of them).
 *   - {action: 'update', latestFirmware} when the registry value
 *     differs and the model has no revision ambiguity.
 *   - {action: 'current'} when the registry is already up to date.
 */
export function planRegistryUpdate(entry, modelNumber, pageFirmware) {
    if (MULTI_REVISION_MODELS.some(m => modelNumber.startsWith(m)))
        return {action: 'manual-review', reason:
            'model ships multiple hardware revisions; the page version ' +
            'may not apply to every revision'};
    const revs = entry.revisions || [];
    if (revs.length > 1)
        return {action: 'manual-review', reason:
            'registry entry carries several revisions; per-revision ' +
            'sources are needed'};
    if (revs.length === 1 && revs[0].latestFirmware === pageFirmware)
        return {action: 'current'};
    return {action: 'update', latestFirmware: pageFirmware};
}

/**
 * Match scrape results against the registry and produce a work plan:
 * one item per registry entry whose model has a page counterpart.
 *
 * @param {Object} validated - Validated-devices registry
 *   (ModelNumber -> entry).
 * @param {Array<{pageTitle: string, firmware: string}>} scraped -
 *   parseSamsungFirmwareEntries() output.
 * @returns {Array<{modelNumber, entry, pageFirmware, action, reason?}>}
 */
export function buildUpdatePlan(validated, scraped) {
    const plan = [];
    for (const [pageTitle, pageFirmware] of
        scraped.map(e => [e.pageTitle, e.firmware])) {
        const prefix = SAMSUNG_MODEL_ALIASES[pageTitle];
        for (const [modelNumber, entry] of Object.entries(validated)) {
            if (entry.manufacturer !== 'Samsung' ||
                !modelNumber.startsWith(prefix + ' '))
                continue;
            // Word boundary: the alias must cover the full model words,
            // so 'Samsung SSD 970 EVO' does not match a
            // 'Samsung SSD 970 EVO Plus 2TB' registry entry (only the
            // capacity follows the alias, no extra model words).
            const remainder = modelNumber.slice(prefix.length + 1);
            if (!/^[0-9]/.test(remainder))
                continue;
            const decision = planRegistryUpdate(entry, modelNumber, pageFirmware);
            plan.push({modelNumber, entry, pageFirmware, ...decision});
        }
    }
    return plan;
}

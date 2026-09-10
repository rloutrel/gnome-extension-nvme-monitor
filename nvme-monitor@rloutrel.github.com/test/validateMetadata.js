import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const METADATA_PATH = new URL('../metadata.json', import.meta.url);
const metadata = JSON.parse(readFileSync(METADATA_PATH, 'utf8'));

assert.ok(typeof metadata.uuid === 'string' && metadata.uuid.length > 0,
    'metadata.json: "uuid" must be a non-empty string');
assert.ok(typeof metadata.name === 'string' && metadata.name.length > 0,
    'metadata.json: "name" must be a non-empty string');
assert.ok(typeof metadata.description === 'string' && metadata.description.length > 0,
    'metadata.json: "description" must be a non-empty string');
assert.ok(typeof metadata['gettext-domain'] === 'string' && metadata['gettext-domain'].length > 0,
    'metadata.json: "gettext-domain" must be a non-empty string');
assert.ok(typeof metadata.version === 'string' && metadata.version.length > 0,
    'metadata.json: "version" must be a non-empty string');
assert.ok(Array.isArray(metadata['shell-version']) && metadata['shell-version'].length > 0,
    'metadata.json: "shell-version" must be a non-empty array');
for (const sv of metadata['shell-version']) {
    assert.ok(typeof sv === 'string' && /^\d+(\.\d+)*$/.test(sv),
        `metadata.json: each "shell-version" entry must be a dotted numeric string, got ${JSON.stringify(sv)}`);
}

console.log('metadata.json OK:', {
    uuid: metadata.uuid,
    version: metadata.version,
    'shell-version': metadata['shell-version'],
    'gettext-domain': metadata['gettext-domain'],
});

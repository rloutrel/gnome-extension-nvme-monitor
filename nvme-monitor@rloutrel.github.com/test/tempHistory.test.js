/**
 * Unit tests for the rolling per-device temperature history.
 *
 * Run with: node --test nvme-monitor@rloutrel.github.com/test/tempHistory.test.js
 *
 * Uses Node's built-in test runner (no dependencies) since tempHistory.js is a
 * pure module (no GJS imports) and can be tested outside GNOME Shell.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TempHistory, TEMP_HISTORY_WINDOW_MS } from '../tempHistory.js';

// ---------------------------------------------------------------------------
// add / get / latest
// ---------------------------------------------------------------------------

test('add stores readings per device and get returns a copy', () => {
    const h = new TempHistory();
    h.add('/dev/nvme0n1', { t: 1000, c: 42, s: [41, 45] });
    h.add('/dev/nvme0n1', { t: 2000, c: 43, s: [42, 46] });
    assert.deepEqual(h.get('/dev/nvme0n1'), [
        { t: 1000, c: 42, s: [41, 45] },
        { t: 2000, c: 43, s: [42, 46] },
    ]);
});

test('get for an unknown device returns an empty array', () => {
    const h = new TempHistory();
    assert.deepEqual(h.get('/dev/nvme9n1'), []);
});

test('get returns a copy: mutating it does not affect the store', () => {
    const h = new TempHistory();
    h.add('/dev/nvme0n1', { t: 1000, c: 42, s: [] });
    const copy = h.get('/dev/nvme0n1');
    copy.push({ t: 9999, c: 99, s: [] });
    assert.equal(h.get('/dev/nvme0n1').length, 1);
});

test('latest returns the most recent reading, or null when none', () => {
    const h = new TempHistory();
    assert.equal(h.latest('/dev/nvme0n1'), null);
    h.add('/dev/nvme0n1', { t: 1000, c: 42, s: [] });
    h.add('/dev/nvme0n1', { t: 2000, c: 43, s: [] });
    assert.deepEqual(h.latest('/dev/nvme0n1'), { t: 2000, c: 43, s: [] });
});

test('add ignores empty devicePath or reading', () => {
    const h = new TempHistory();
    h.add('', { t: 1000, c: 42, s: [] });
    h.add('/dev/nvme0n1', null);
    assert.deepEqual(h.devices(), []);
});

test('multiple devices are tracked independently', () => {
    const h = new TempHistory();
    h.add('/dev/nvme0n1', { t: 1000, c: 40, s: [] });
    h.add('/dev/nvme1n1', { t: 1000, c: 50, s: [] });
    h.add('/dev/nvme0n1', { t: 2000, c: 41, s: [] });
    assert.deepEqual(h.devices().sort(), ['/dev/nvme0n1', '/dev/nvme1n1']);
    assert.equal(h.get('/dev/nvme0n1').length, 2);
    assert.equal(h.get('/dev/nvme1n1').length, 1);
});

// ---------------------------------------------------------------------------
// rolling window pruning
// ---------------------------------------------------------------------------

test('add prunes readings older than the window (relative to reading.t)', () => {
    const h = new TempHistory({ windowMs: 1000 });
    h.add('/dev/nvme0n1', { t: 0, c: 40, s: [] });
    h.add('/dev/nvme0n1', { t: 500, c: 41, s: [] });
    h.add('/dev/nvme0n1', { t: 1500, c: 42, s: [] });
    // t=0 is older than 1500-1000=500, so it is pruned.
    assert.deepEqual(h.get('/dev/nvme0n1'), [
        { t: 500, c: 41, s: [] },
        { t: 1500, c: 42, s: [] },
    ]);
});

test('add prunes relative to an explicit now reference', () => {
    const h = new TempHistory({ windowMs: 1000 });
    h.add('/dev/nvme0n1', { t: 0, c: 40, s: [] }, 2000);
    // t=0 is older than 2000-1000=1000, pruned immediately.
    assert.deepEqual(h.get('/dev/nvme0n1'), []);
});

test('pruneStale drops old readings across all devices and empties devices', () => {
    const h = new TempHistory({ windowMs: 1000 });
    h.add('/dev/nvme0n1', { t: 0, c: 40, s: [] });
    h.add('/dev/nvme0n1', { t: 500, c: 41, s: [] });
    h.add('/dev/nvme1n1', { t: 0, c: 50, s: [] });
    h.pruneStale(1500);
    assert.deepEqual(h.get('/dev/nvme0n1'), [{ t: 500, c: 41, s: [] }]);
    // nvme1n1's only reading is stale -> device dropped entirely.
    assert.deepEqual(h.get('/dev/nvme1n1'), []);
    assert.deepEqual(h.devices(), ['/dev/nvme0n1']);
});

test('default window is 60s (last minute)', () => {
    assert.equal(TEMP_HISTORY_WINDOW_MS, 60_000);
    const h = new TempHistory();
    h.add('/dev/nvme0n1', { t: 0, c: 40, s: [] });
    h.add('/dev/nvme0n1', { t: 59_999, c: 41, s: [] });
    assert.equal(h.get('/dev/nvme0n1').length, 2);
    h.add('/dev/nvme0n1', { t: 60_001, c: 42, s: [] });
    assert.equal(h.get('/dev/nvme0n1').length, 2);
});

test('invalid windowMs falls back to the 60s default', () => {
    const h = new TempHistory({ windowMs: -5 });
    h.add('/dev/nvme0n1', { t: 0, c: 40, s: [] });
    h.add('/dev/nvme0n1', { t: 60_001, c: 42, s: [] });
    // Effective window is 60s (not -5), so t=0 (cutoff = 60001-60000 = 1)
    // is pruned while t=60001 survives — proving the fallback to the default.
    assert.equal(h.get('/dev/nvme0n1').length, 1);
    assert.deepEqual(h.get('/dev/nvme0n1'), [{ t: 60_001, c: 42, s: [] }]);
});

// ---------------------------------------------------------------------------
// remove / clear
// ---------------------------------------------------------------------------

test('remove drops a single device, clear drops all', () => {
    const h = new TempHistory();
    h.add('/dev/nvme0n1', { t: 1000, c: 40, s: [] });
    h.add('/dev/nvme1n1', { t: 1000, c: 50, s: [] });
    h.remove('/dev/nvme0n1');
    assert.deepEqual(h.devices(), ['/dev/nvme1n1']);
    h.clear();
    assert.deepEqual(h.devices(), []);
});

// ---------------------------------------------------------------------------
// serialize / deserialize round-trip
// ---------------------------------------------------------------------------

test('serialize/deserialize round-trips readings and windowMs', () => {
    const h = new TempHistory({ windowMs: 5000 });
    h.add('/dev/nvme0n1', { t: 1000, c: 42.5, s: [41, 45] });
    h.add('/dev/nvme1n1', { t: 1000, c: 50, s: [] });
    const str = h.serialize();
    const h2 = TempHistory.deserialize(str);
    assert.deepEqual(h2.get('/dev/nvme0n1'), [{ t: 1000, c: 42.5, s: [41, 45] }]);
    assert.deepEqual(h2.get('/dev/nvme1n1'), [{ t: 1000, c: 50, s: [] }]);
});

test('deserialize prunes stale readings relative to now', () => {
    const h = new TempHistory({ windowMs: 1000 });
    h.add('/dev/nvme0n1', { t: 0, c: 40, s: [] });
    h.add('/dev/nvme0n1', { t: 500, c: 41, s: [] });
    const str = h.serialize();
    const h2 = TempHistory.deserialize(str, 1500);
    assert.deepEqual(h2.get('/dev/nvme0n1'), [{ t: 500, c: 41, s: [] }]);
});

test('deserialize tolerates missing/invalid windowMs (falls back to 60s)', () => {
    const h = TempHistory.deserialize('{"devices":{}}');
    assert.equal(h.get('/dev/nvme0n1').length, 0);
});

test('deserialize tolerates a non-array device list entry', () => {
    const str = JSON.stringify({ windowMs: 1000, devices: { '/dev/nvme0n1': 'not-an-array' } });
    const h = TempHistory.deserialize(str);
    assert.deepEqual(h.get('/dev/nvme0n1'), []);
});

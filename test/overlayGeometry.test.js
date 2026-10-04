import test from 'node:test';
import assert from 'node:assert/strict';

import {computeOverlayPosition} from '../nvme-monitor@rloutrel.github.com/overlayGeometry.js';

const MONITOR = {x: 0, y: 0, width: 1920, height: 1080};

test('positions the box 12px right/below the pointer', () => {
    const pos = computeOverlayPosition(
        {x: 100, y: 100}, [MONITOR], {width: 200, height: 80});
    assert.deepEqual(pos, {x: 112, y: 112});
});

test('clamps the box inside the monitor right edge', () => {
    const pos = computeOverlayPosition(
        {x: 1910, y: 100}, [MONITOR], {width: 200, height: 80});
    assert.equal(pos.x, 1920 - 200);
});

test('flips the box above the pointer when it would overflow the bottom', () => {
    const pos = computeOverlayPosition(
        {x: 100, y: 1060}, [MONITOR], {width: 200, height: 80});
    assert.equal(pos.y, 1060 - 12 - 80);
});

test('never places the box above the monitor top', () => {
    const pos = computeOverlayPosition(
        {x: 100, y: 0}, [MONITOR], {width: 200, height: 80});
    assert.ok(pos.y >= 0);
});

test('picks the monitor containing the pointer', () => {
    const monitors = [
        {x: 0, y: 0, width: 1920, height: 1080},
        {x: 1920, y: 0, width: 1280, height: 1024},
    ];
    const pos = computeOverlayPosition(
        {x: 3000, y: 500}, monitors, {width: 100, height: 50});
    assert.equal(pos.x, 3012);
    assert.ok(pos.x + 100 <= 1920 + 1280);
});

test('returns null when no monitor contains the pointer', () => {
    assert.equal(
        computeOverlayPosition({x: -50, y: -50}, [MONITOR], {width: 10, height: 10}),
        null);
});

test('honors a custom offset', () => {
    const pos = computeOverlayPosition(
        {x: 100, y: 100}, [MONITOR], {width: 50, height: 50}, 30);
    assert.deepEqual(pos, {x: 130, y: 130});
});

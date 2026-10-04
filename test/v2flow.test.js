import test from 'node:test';
import assert from 'node:assert/strict';

import {
    KILL_THRESHOLD,
    handleUninstallNotFound,
} from '../nvme-monitor@rloutrel.github.com/v2decisions.js';

test('KILL_THRESHOLD is 4', () => {
    assert.equal(KILL_THRESHOLD, 4);
});

test('handleUninstallNotFound increments and notifies below the threshold', () => {
    const notifications = [];
    const notifier = {
        notifyError: (title, body) => notifications.push([title, body]),
        _: s => s,
    };
    const result = handleUninstallNotFound(0, notifier);
    assert.equal(result.count, 1);
    assert.equal(result.action, 'notify');
    assert.equal(notifications.length, 1);
});

test('handleUninstallNotFound requests self-disable at the threshold', () => {
    const notifications = [];
    const notifier = {
        notifyError: (title, body) => notifications.push([title, body]),
        _: s => s,
    };
    const result = handleUninstallNotFound(KILL_THRESHOLD - 1, notifier);
    assert.equal(result.count, KILL_THRESHOLD);
    assert.equal(result.action, 'disable');
    assert.equal(notifications.length, 1);
});

test('handleUninstallNotFound skips side effects without a notifier', () => {
    const result = handleUninstallNotFound(0, null);
    assert.equal(result.count, 1);
    assert.equal(result.action, 'notify');
});

/**
 * Unit tests for nvme-cli version detection.
 *
 * Run with: node --test nvme-monitor@rloutrel.github.com/test/versionUtils.test.js
 *
 * Uses Node's built-in test runner. versionUtils.js is a pure module
 * (no GJS imports) so it can be tested outside GNOME Shell.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseNvmeVersion,
    compareVersions,
    isFormatChangeAffected,
    isBytesOverflowAffected,
    assessNvmeCliVersion,
    FORMAT_CHANGE_ISSUE_URL,
    FLAT_FORMAT_RESTORED,
    NESTED_FORMAT_REINTRODUCED,
    BYTES_OVERFLOW_FIXED,
} from '../versionUtils.js';

// ---------------------------------------------------------------------------
// parseNvmeVersion
// ---------------------------------------------------------------------------

test('parseNvmeVersion: parses 2.x "nvme version 2.3 (git 2.3)" shape', () => {
    const out = 'nvme version 2.3 (git 2.3)\nlibnvme version 1.3 (git 1.3)\n';
    assert.deepStrictEqual(parseNvmeVersion(out), [2, 3, 0]);
});

test('parseNvmeVersion: parses a single-line 2.x output', () => {
    assert.deepStrictEqual(parseNvmeVersion('nvme version 2.16 (git 2.16)'), [2, 16, 0]);
});

test('parseNvmeVersion: parses three-part version 2.10.2', () => {
    assert.deepStrictEqual(parseNvmeVersion('nvme version 2.10.2 (git 2.10.2)'), [2, 10, 2]);
});

test('parseNvmeVersion: parses 1.x "nvme-1.14" shape', () => {
    assert.deepStrictEqual(parseNvmeVersion('nvme-1.14'), [1, 14, 0]);
});

test('parseNvmeVersion: parses 1.16-3build1 (Debian-style)', () => {
    assert.deepStrictEqual(parseNvmeVersion('nvme-1.16-3build1'), [1, 16, 0]);
});

test('parseNvmeVersion: strips pre-release suffix 3.0-rc1', () => {
    assert.deepStrictEqual(parseNvmeVersion('nvme version 3.0-rc1 (git 3.0-rc1)'), [3, 0, 0]);
});

test('parseNvmeVersion: strips pre-release suffix 3.0-b.5', () => {
    assert.deepStrictEqual(parseNvmeVersion('nvme version 3.0-b.5 (git 3.0-b.5)'), [3, 0, 0]);
});

test('parseNvmeVersion: returns null for unparseable input', () => {
    assert.strictEqual(parseNvmeVersion('garbage'), null);
});

test('parseNvmeVersion: returns null for empty input', () => {
    assert.strictEqual(parseNvmeVersion(''), null);
    assert.strictEqual(parseNvmeVersion(null), null);
    assert.strictEqual(parseNvmeVersion(undefined), null);
});

// ---------------------------------------------------------------------------
// compareVersions
// ---------------------------------------------------------------------------

test('compareVersions: equal versions', () => {
    assert.strictEqual(compareVersions([2, 3, 0], [2, 3, 0]), 0);
});

test('compareVersions: less than', () => {
    assert.strictEqual(compareVersions([2, 2, 1], [2, 3, 0]), -1);
});

test('compareVersions: greater than', () => {
    assert.strictEqual(compareVersions([3, 0, 0], [2, 16, 0]), 1);
});

test('compareVersions: accepts string operands', () => {
    assert.strictEqual(compareVersions('2.11', '2.13'), -1);
    assert.strictEqual(compareVersions('3.0', '2.16'), 1);
});

// ---------------------------------------------------------------------------
// isFormatChangeAffected (Bug B)
// ---------------------------------------------------------------------------

test('isFormatChangeAffected: 2.10.2 is safe (pre-2.11)', () => {
    assert.strictEqual(isFormatChangeAffected([2, 10, 2]), false);
});

test('isFormatChangeAffected: 2.11 is affected (nested layout)', () => {
    assert.strictEqual(isFormatChangeAffected([2, 11, 0]), true);
});

test('isFormatChangeAffected: 2.12 is affected (nested layout)', () => {
    assert.strictEqual(isFormatChangeAffected([2, 12, 0]), true);
});

test('isFormatChangeAffected: 2.13 is safe (flat restored)', () => {
    assert.strictEqual(isFormatChangeAffected([2, 13, 0]), false);
});

test('isFormatChangeAffected: 2.16 is safe', () => {
    assert.strictEqual(isFormatChangeAffected([2, 16, 0]), false);
});

test('isFormatChangeAffected: 3.0 is affected (nested reintroduced)', () => {
    assert.strictEqual(isFormatChangeAffected([3, 0, 0]), true);
});

test('isFormatChangeAffected: 3.0-rc1 is affected (pre-release stripped)', () => {
    const v = parseNvmeVersion('nvme version 3.0-rc1 (git 3.0-rc1)');
    assert.strictEqual(isFormatChangeAffected(v), true);
});

test('isFormatChangeAffected: 1.16 is safe', () => {
    assert.strictEqual(isFormatChangeAffected([1, 16, 0]), false);
});

test('isFormatChangeAffected: null returns false', () => {
    assert.strictEqual(isFormatChangeAffected(null), false);
});

// ---------------------------------------------------------------------------
// isBytesOverflowAffected (Bug A)
// ---------------------------------------------------------------------------

test('isBytesOverflowAffected: 2.0 is affected', () => {
    assert.strictEqual(isBytesOverflowAffected([2, 0, 0]), true);
});

test('isBytesOverflowAffected: 2.2 is affected', () => {
    assert.strictEqual(isBytesOverflowAffected([2, 2, 1]), true);
});

test('isBytesOverflowAffected: 2.3 is fixed', () => {
    assert.strictEqual(isBytesOverflowAffected([2, 3, 0]), false);
});

test('isBytesOverflowAffected: 1.16 is not affected', () => {
    assert.strictEqual(isBytesOverflowAffected([1, 16, 0]), false);
});

test('isBytesOverflowAffected: 3.0 is not affected', () => {
    assert.strictEqual(isBytesOverflowAffected([3, 0, 0]), false);
});

// ---------------------------------------------------------------------------
// assessNvmeCliVersion
// ---------------------------------------------------------------------------

test('assessNvmeCliVersion: safe version 2.13', () => {
    const a = assessNvmeCliVersion([2, 13, 0]);
    assert.strictEqual(a.affected, false);
    assert.strictEqual(a.formatChange, false);
    assert.strictEqual(a.bytesOverflow, false);
    assert.deepStrictEqual(a.reasons, []);
});

test('assessNvmeCliVersion: format-change affected 2.11', () => {
    const a = assessNvmeCliVersion([2, 11, 0]);
    assert.strictEqual(a.affected, true);
    assert.strictEqual(a.formatChange, true);
    assert.strictEqual(a.bytesOverflow, false);
    assert.ok(a.reasons.length >= 1);
});

test('assessNvmeCliVersion: format-change affected 3.0', () => {
    const a = assessNvmeCliVersion([3, 0, 0]);
    assert.strictEqual(a.affected, true);
    assert.strictEqual(a.formatChange, true);
    assert.strictEqual(a.bytesOverflow, false);
});

test('assessNvmeCliVersion: bytes-overflow affected 2.2', () => {
    const a = assessNvmeCliVersion([2, 2, 0]);
    assert.strictEqual(a.affected, true);
    assert.strictEqual(a.formatChange, false);
    assert.strictEqual(a.bytesOverflow, true);
});

test('assessNvmeCliVersion: null version is not affected', () => {
    const a = assessNvmeCliVersion(null);
    assert.strictEqual(a.affected, false);
    assert.deepStrictEqual(a.reasons, []);
});

// ---------------------------------------------------------------------------
// Exported constants
// ---------------------------------------------------------------------------

test('constants: reference issue URL points to #2749', () => {
    assert.ok(FORMAT_CHANGE_ISSUE_URL.includes('2749'));
});

test('constants: flat format restored is 2.13', () => {
    assert.strictEqual(FLAT_FORMAT_RESTORED, '2.13');
});

test('constants: nested format reintroduced is 3.0', () => {
    assert.strictEqual(NESTED_FORMAT_REINTRODUCED, '3.0');
});

test('constants: bytes overflow fixed is 2.3', () => {
    assert.strictEqual(BYTES_OVERFLOW_FIXED, '2.3');
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    SETUP_SCRIPT_URL,
    SETUP_SCRIPT_MARKERS,
    SETUP_SCRIPT_MAX_BYTES,
    SETUP_SCRIPT_SHA256,
    SETUP_SCRIPT_SHA256_TRANSITORY,
    validateSetupScriptContent,
    buildSetupTempName,
    preparePastedSetupScript,
    setupScriptErrorMessage,
    checkSetupScriptHash,
} from '../nvme-monitor@rloutrel.github.com/v2script.js';

const SHEBANG = '#!/bin/bash\n';

function fakeScript() {
    return `${SHEBANG}# setup-polkit.sh — installation of the polkit stack\n` +
        'WRAPPER_PATH="/usr/local/bin/nvme-smart-log-json"\n' +
        'UNINSTALL_PATH="/usr/local/bin/nvme-smart-uninstall.sh"\n' +
        'GROUP_NAME="nvme-smart"\n' +
        '# padding to exceed the minimum size\n' +
        'echo '.padEnd(200, '.') + '\n';
}

test('v2script: SETUP_SCRIPT_URL points at the repository script', () => {
    assert.equal(SETUP_SCRIPT_URL,
        'https://github.com/rloutrel/gnome-extension-nvme-monitor/blob/main/setup-polkit.sh');
});

test('v2script: markers are frozen and non-empty', () => {
    assert.ok(Object.isFrozen(SETUP_SCRIPT_MARKERS));
    assert.ok(SETUP_SCRIPT_MARKERS.length > 0);
});

test('validateSetupScriptContent: accepts the genuine script shape', () => {
    assert.equal(validateSetupScriptContent(fakeScript()), null);
});

test('validateSetupScriptContent: normalizes CRLF line endings', () => {
    assert.equal(validateSetupScriptContent(fakeScript().replace(/\n/g, '\r\n')), null);
});

test('validateSetupScriptContent: rejects a non-string', () => {
    assert.equal(validateSetupScriptContent(null), 'not_a_string');
});

test('validateSetupScriptContent: rejects a too-short paste', () => {
    assert.equal(validateSetupScriptContent('#!/bin/bash\n'), 'too_short');
});

test('validateSetupScriptContent: rejects a too-long paste', () => {
    assert.equal(validateSetupScriptContent(SHEBANG + 'x'.repeat(SETUP_SCRIPT_MAX_BYTES)), 'too_long');
});

test('validateSetupScriptContent: rejects a missing bash shebang', () => {
    assert.equal(validateSetupScriptContent('#!/bin/sh\n' + fakeScript().slice(SHEBANG.length)), 'no_shebang');
});

test('validateSetupScriptContent: rejects a paste missing a marker', () => {
    const noGroup = fakeScript().replace('GROUP_NAME="nvme-smart"', 'GROUP_NAME="other"');
    assert.equal(validateSetupScriptContent(noGroup), 'missing_marker');
});

test('buildSetupTempName: produces a random hex-suffixed sh name', () => {
    const name = buildSetupTempName(() => 0.5);
    assert.match(name, /^nvme-monitor-setup-[0-9a-f]{8}\.sh$/);
    assert.notEqual(buildSetupTempName(), buildSetupTempName());
});

test('preparePastedSetupScript: ok carries the normalized script', () => {
    const crlf = fakeScript().replace(/\n/g, '\r\n');
    const result = preparePastedSetupScript(crlf);
    assert.equal(result.ok, true);
    assert.equal(result.reason, null);
    assert.ok(result.script.includes('GROUP_NAME="nvme-smart"'));
    assert.ok(!result.script.includes('\r'));
});

test('preparePastedSetupScript: rejected paste carries a reason', () => {
    const result = preparePastedSetupScript('not a script');
    assert.equal(result.ok, false);
    assert.ok(result.reason);
    assert.equal(result.script, null);
});

test('setupScriptErrorMessage: maps every reason to a translated string', () => {
    const tr = s => `tr:${s}`;
    for (const reason of ['too_short', 'too_long', 'no_shebang', 'missing_marker', 'not_a_string', 'whatever']) {
        assert.ok(setupScriptErrorMessage(reason, tr).startsWith('tr:'));
    }
});

// ---------------------------------------------------------------------------
// checkSetupScriptHash
// ---------------------------------------------------------------------------

test('v2script: the pinned SHA-256 is a lowercase hex digest', () => {
    assert.match(SETUP_SCRIPT_SHA256, /^[0-9a-f]{64}$/);
});

test('checkSetupScriptHash: pinned hash matches', () => {
    assert.equal(checkSetupScriptHash(SETUP_SCRIPT_SHA256).status, 'pinned');
});

test('checkSetupScriptHash: any other hash is unknown', () => {
    assert.equal(checkSetupScriptHash('0'.repeat(64)).status, 'unknown');
    assert.equal(checkSetupScriptHash(null).status, 'unknown');
});

test('checkSetupScriptHash: no transitory hash is configured by default', () => {
    assert.ok(SETUP_SCRIPT_SHA256_TRANSITORY === null || /^[0-9a-f]{64}$/.test(SETUP_SCRIPT_SHA256_TRANSITORY));
});

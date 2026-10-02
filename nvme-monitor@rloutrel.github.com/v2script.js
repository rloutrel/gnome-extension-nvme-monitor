// Pure decision logic for the pasted setup-script flow: validating the
// script content the user pastes from the GitHub repository and preparing
// a safe file to execute. No GJS imports, unit-tested under plain Node.
// The GJS side (v2flow.js) writes the file and drives pkexec.

// Repository blob URL of setup-polkit.sh, shown in the dialog for review.
export const SETUP_SCRIPT_URL =
    'https://github.com/rloutrel/gnome-extension-nvme-monitor/blob/main/setup-polkit.sh';
// Raw-content URL of the same file, fetched by the dialog for review.
export const SETUP_SCRIPT_RAW_URL =
    'https://raw.githubusercontent.com/rloutrel/gnome-extension-nvme-monitor/main/setup-polkit.sh';

// SHA-256 of the setup script the extension trusts, pinned so a malicious
// or compromised commit changing the script on GitHub cannot be executed
// as root through the dialog. When the script legitimately changes, release
// a new extension version with the updated hash. During the transition, a
// second (transitory) hash may be allowed — it is shown to the user for
// explicit approval and disappears once the pinned hash is updated.
export const SETUP_SCRIPT_SHA256 =
    '803eaae9c5f8cdb053a845526e977a1eb707931ffd35e7d0ab3fe717a06678fd';
// Transitory second hash accepted after explicit user approval, or null.
export const SETUP_SCRIPT_SHA256_TRANSITORY = null;

// Mandatory markers of setup-polkit.sh. The setup script is never shipped
// alongside the extension (so it can never silently execute local file
// content as root); these markers guard against running an arbitrary pasted
// file.
export const SETUP_SCRIPT_MARKERS = Object.freeze([
    'setup-polkit.sh',
    'nvme-smart-log-json',
    'nvme-smart-uninstall.sh',
    'GROUP_NAME="nvme-smart"',
]);

// Size limits for the pasted script (bytes).
export const SETUP_SCRIPT_MAX_BYTES = 512 * 1024;
export const SETUP_SCRIPT_MIN_BYTES = 200;

// ---------------------------------------------------------------------------
// Decide how the fetched script relates to the pinned hashes.
// Returns {status}:
//   'pinned'     matches the pinned hash — safe to present for review
//   'transitory' matches the transitory hash — presentation requires an
//                explicit user approval (update the extension when you can)
//   'unknown'    matches neither — the script changed on GitHub; refuse and
//                point the user to an extension update
// ---------------------------------------------------------------------------
export function checkSetupScriptHash(sha256) {
    if (sha256 === SETUP_SCRIPT_SHA256)
        return {status: 'pinned'};
    if (SETUP_SCRIPT_SHA256_TRANSITORY && sha256 === SETUP_SCRIPT_SHA256_TRANSITORY)
        return {status: 'transitory'};
    return {status: 'unknown'};
}

// ---------------------------------------------------------------------------
// Validate the pasted setup-script content.
// Returns null when the content looks like the genuine setup-polkit.sh,
// otherwise a short reason string (English, dev-facing; the caller maps it
// to a translated user message).
// ---------------------------------------------------------------------------
export function validateSetupScriptContent(content) {
    if (typeof content !== 'string')
        return 'not_a_string';
    const text = content.replace(/\r\n/g, '\n');
    if (text.length < SETUP_SCRIPT_MIN_BYTES)
        return 'too_short';
    if (text.length > SETUP_SCRIPT_MAX_BYTES)
        return 'too_long';
    if (!text.startsWith('#!/bin/bash') && !text.startsWith('#!/usr/bin/env bash'))
        return 'no_shebang';
    for (const marker of SETUP_SCRIPT_MARKERS) {
        if (!text.includes(marker))
            return 'missing_marker';
    }
    return null;
}

// ---------------------------------------------------------------------------
// Random name for the temporary script file (predictable names in a shared
// tmp would let another local user swap the file between the write and the
// pkexec run). Uses the provided random integer generator so tests stay
// deterministic; defaults to Math.random.
// ---------------------------------------------------------------------------
export function buildSetupTempName(randomIntFn = Math.random) {
    const hex = Math.floor(randomIntFn() * 0xffffffff).toString(16).padStart(8, '0');
    return `nvme-monitor-setup-${hex}.sh`;
}

// ---------------------------------------------------------------------------
// Prepare the script execution: validate the pasted content and return the
// {ok, script, reason} decision. `script` is the content to write (newline
// normalized). Pure; the caller performs the actual file write + pkexec.
// ---------------------------------------------------------------------------
export function preparePastedSetupScript(content) {
    const reason = validateSetupScriptContent(content);
    if (reason)
        return {ok: false, reason, script: null};
    return {ok: true, reason: null, script: content.replace(/\r\n/g, '\n')};
}

// ---------------------------------------------------------------------------
// Map a validation reason to a translated message. `tr` is the gettext `_()`
// function of the caller.
// ---------------------------------------------------------------------------
export function setupScriptErrorMessage(reason, tr) {
    switch (reason) {
    case 'too_short':
    case 'too_long':
        return tr('The pasted content does not look like the setup script (unexpected size).');
    case 'no_shebang':
        return tr('The pasted content does not start with a bash interpreter line (#!/bin/bash).');
    case 'missing_marker':
        return tr('The pasted content is not the expected setup script (missing markers). Please copy the whole file from the repository.');
    case 'not_a_string':
    default:
        return tr('The pasted content could not be read.');
    }
}

// Fetch the setup script from the GitHub repository and compute its SHA-256.
// GJS module: uses libsoup (HTTPS) and GLib — cannot run under plain Node.
// The fetched content is presented read-only for review in the setup dialog;
// the hash is compared (in v2script.js) against the checksum pinned in the
// extension so a malicious commit that changed the script cannot be executed
// as root. The user remains the one who triggers execution (Run button).

import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

import {_debug, _warn} from './logger.js';
import {SETUP_SCRIPT_RAW_URL} from './v2script.js';

// SHA-256 hex digest of a UTF-8 string.
export function computeSha256(text) {
    const checksum = GLib.Checksum.new(GLib.ChecksumType.SHA256);
    checksum.update(new TextEncoder().encode(text));
    return checksum.get_string();
}

// Download the raw setup script. Resolves with the script text, rejects with
// an Error carrying the HTTP status or the transport failure.
export function fetchSetupScript(url = SETUP_SCRIPT_RAW_URL) {
    return _fetchOnce(url);
}

function _fetchOnce(url) {
    return new Promise((resolve, reject) => {
        let session;
        try {
            session = new Soup.Session({timeout: 15});
        } catch (e) {
            reject(e);
            return;
        }
        const message = Soup.Message.new('GET', url);
        if (!message) {
            reject(new Error('could not build the request'));
            return;
        }
        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (s, result) => {
            try {
                const bytes = s.send_and_read_finish(result);
                if (message.status_code !== Soup.Status.OK) {
                    reject(new Error(`HTTP ${message.status_code}`));
                    return;
                }
                const content = new TextDecoder().decode(bytes.get_data());
                _debug(`fetchSetupScript: ${content.length} bytes from ${url}`);
                resolve(content);
            } catch (e) {
                _warn(`fetchSetupScript failed: ${e.message}`);
                reject(e);
            }
        });
    });
}

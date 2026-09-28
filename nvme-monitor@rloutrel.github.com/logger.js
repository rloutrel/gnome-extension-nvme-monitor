// Unified logger for the extension, conforming to the GJS debugging guide:
// https://gjs.guide/extensions/development/debugging.html#logging
//   console.debug()  → dev-only info (GLib.LogLevelFlags.LEVEL_DEBUG)
//   console.warn()   → unexpected errors, possible bugs (LEVEL_WARNING)
//   console.error()  → programmer errors, failures (LEVEL_CRITICAL)

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const LOG_PREFIX = '[NVMe-monitor]';

export function _debug(message) {
    console.debug(`${LOG_PREFIX} ${message}`);
}

export function _warn(message) {
    console.warn(`${LOG_PREFIX} ${message}`);
}

export function _error(message) {
    console.error(`${LOG_PREFIX} ${message}`);
}

export function notify(title, body = '') {
    if (body) _debug(`${title} — ${body}`);
    else _debug(title);
    Main.notify(title, body);
}

export function notifyError(title, body = '') {
    _warn(`${title}${body ? ' — ' + body : ''}`);
    Main.notify(title, body);
}

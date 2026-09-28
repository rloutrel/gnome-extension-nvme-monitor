// Pure decision logic for the v2 polkit stack flows: the uninstall-not-found
// failure counter policy and path building. No GJS imports, unit-tested
// under plain Node. The GJS side (v2flow.js) drives pkexec and applies
// these decisions.

// The extension disables itself when the uninstall flow reaches this many
// consecutive "uninstall script not found" failures, breaking an infinite
// toggle loop.
export const KILL_THRESHOLD = 4;

// Join the extension directory and the setup script name.
export function buildSetupPath(extensionPath, setupScriptName = 'setup-polkit.sh') {
    if (!extensionPath)
        return setupScriptName;
    let dir = extensionPath;
    while (dir.length > 1 && dir.endsWith('/'))
        dir = dir.slice(0, -1);
    return `${dir}/${setupScriptName}`;
}

// Decide what to do after an "uninstall script not found" failure.
// Pure: returns {count, action}; pass `notifier` to perform the user-facing
// side effects (null skips them, e.g. in tests).
//   action 'notify'  show the not-found notification, keep the toggle on
//   action 'disable' kill threshold reached, the extension disables itself
export function handleUninstallNotFound(count, notifier = null) {
    const newCount = count + 1;
    if (newCount >= KILL_THRESHOLD) {
        if (notifier)
            notifier.notifyError('NVMe Monitor', 'Loop detected \u2014 extension disabled.');
        return {count: newCount, action: 'disable'};
    }
    if (notifier)
        notifier.notifyError(notifier._('Uninstall script not found.'));
    return {count: newCount, action: 'notify'};
}

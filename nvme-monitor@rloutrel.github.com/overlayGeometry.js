// Overlay/tooltip positioning: clamp a pointer-anchored box inside the
// monitor containing the pointer.
// Pure module — no GJS imports, unit-tested under plain Node.

// Compute the position for a transient overlay/tooltip box anchored 12px
// right/below the pointer, clamped inside the monitor area containing the
// pointer (flipped above the pointer when it would overflow the bottom).
//
// Arguments:
//   pointer:   {x, y} pointer position
//   monitors:  [{x, y, width, height}] available monitor areas
//   boxSize:   {width, height} natural size of the box
// Returns {x, y} (ints), or null when no monitor contains the pointer.
export function computeOverlayPosition(pointer, monitors, boxSize, offset = 12) {
    const area = monitors.find(monitor =>
        pointer.x >= monitor.x && pointer.x < monitor.x + monitor.width &&
        pointer.y >= monitor.y && pointer.y < monitor.y + monitor.height
    );
    if (!area) return null;

    let x = Math.round(pointer.x + offset);
    let y = Math.round(pointer.y + offset);

    x = Math.max(area.x, Math.min(x, area.x + area.width - boxSize.width));
    if (y + boxSize.height > area.y + area.height) {
        y = Math.round(pointer.y) - offset - boxSize.height;
    }
    y = Math.max(area.y, y);
    return {x, y};
}

import St from 'gi://St';

const USAGE_FREE_COLOR = [0.68, 0.88, 0.70];

export function normalizeUsageSegments(entries) {
    return (entries || [])
        .filter(entry => entry && Number.isFinite(entry.total) && entry.total > 0)
        .map(entry => ({
            ...entry,
            used: Number(entry.used) || 0,
            avail: Number(entry.avail) || 0,
            total: Number(entry.total) || 0,
            isLvm: Boolean(entry.isLvm),
            color: entry.color || [0.75, 0.11, 0.14],
        }));
}

export function calculateUsageSegmentWidths(segments, width, minimumWidth = 10) {
    const total = segments.reduce((sum, segment) => sum + segment.total, 0);
    if (total <= 0 || segments.length === 0 || width <= 0) return segments.map(() => 0);

    const rawWidths = segments.map(segment => width * segment.total / total);
    if (width < minimumWidth * segments.length) {
        return segments.map(() => width / segments.length);
    }

    const fixedIndexes = rawWidths
        .map((segmentWidth, index) => segmentWidth < minimumWidth ? index : -1)
        .filter(index => index >= 0);
    const fixedWidth = fixedIndexes.length * minimumWidth;
    const flexibleIndexes = rawWidths
        .map((_, index) => index)
        .filter(index => !fixedIndexes.includes(index));
    const flexibleRawWidth = flexibleIndexes.reduce((sum, index) => sum + rawWidths[index], 0);
    const remainingWidth = Math.max(0, width - fixedWidth);

    return rawWidths.map((_, index) => {
        if (fixedIndexes.includes(index)) return minimumWidth;
        if (flexibleRawWidth <= 0) return remainingWidth / flexibleIndexes.length;
        return remainingWidth * rawWidths[index] / flexibleRawWidth;
    });
}

export function paintUsageSegment(cr, segment, x, width, height, foregroundColor) {
    if (segment.isLvm) {
        cr.setSourceRGBA(0.54, 0.29, 0.72, 0.45);
        cr.rectangle(x, 0, width, height);
        cr.fill();
        return;
    }

    const usedRatio = segment.total > 0
        ? Math.max(0, Math.min(1, segment.used / segment.total))
        : 0;
    const usedWidth = width * usedRatio;
    if (usedWidth > 0) {
        cr.setSourceRGB(segment.color[0], segment.color[1], segment.color[2]);
        cr.rectangle(x, 0, usedWidth, height);
        cr.fill();
    }

    const freeWidth = width - usedWidth;
    if (freeWidth > 0) {
        cr.setSourceRGBA(
            USAGE_FREE_COLOR[0],
            USAGE_FREE_COLOR[1],
            USAGE_FREE_COLOR[2],
            0.45,
        );
        cr.rectangle(x + usedWidth, 0, freeWidth, height);
        cr.fill();
    }

    if (foregroundColor) {
        cr.setSourceRGBA(
            foregroundColor[0],
            foregroundColor[1],
            foregroundColor[2],
            0.65,
        );
        cr.rectangle(x + width - 1, 0, 2, height);
        cr.fill();
    }
}

export function createUsageBarFromSegments(entries, width = 120, height = 8) {
    const area = new St.DrawingArea({
        width,
        height,
        reactive: false,
        can_focus: false,
        x_expand: true,
        style_class: 'nvme-disk-usage-bar',
    });

    const segments = normalizeUsageSegments(entries);
    area._usageSegments = segments;

    area.connect('repaint', (a) => {
        const cr = a.get_context();
        const [w, h] = a.get_surface_size();
        const foreground = a.get_theme_node().get_foreground_color();
        const foregroundColor = [
            foreground.red / 255,
            foreground.green / 255,
            foreground.blue / 255,
        ];

        cr.setSourceRGB(0.12, 0.12, 0.12);
        cr.rectangle(0, 0, w, h);
        cr.fill();

        const total = a._usageSegments.reduce((sum, segment) => sum + segment.total, 0);
        if (total <= 0) {
            cr.setSourceRGB(0.0, 0.0, 0.0);
            cr.setLineWidth(1);
            cr.rectangle(0, 0, w, h);
            cr.stroke();
            cr.$dispose();
            return;
        }

        let cursorX = 0;
        const segmentWidths = calculateUsageSegmentWidths(a._usageSegments, w);
        for (let index = 0; index < a._usageSegments.length; index++) {
            const segment = a._usageSegments[index];
            const segmentWidth = segmentWidths[index];
            paintUsageSegment(cr, segment, cursorX, segmentWidth, h, foregroundColor);
            cursorX += segmentWidth;
        }

        cr.setSourceRGB(0.0, 0.0, 0.0);
        cr.setLineWidth(1);
        cr.rectangle(0, 0, w, h);
        cr.stroke();

        cr.$dispose();
    });

    return area;
}

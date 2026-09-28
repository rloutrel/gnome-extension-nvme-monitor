// Temperature history chart: builds the St.DrawingArea and paints the
// 30-minute composite-temperature line graph with Cairo.

import St from 'gi://St';

import {formatTempCelsius} from './tempFormat.js';
import {tempTierColor, formatDurationMs, COLOR_TRACK, COLOR_ORANGE, COLOR_RED} from './format.js';
import {TEMP_HISTORY_WINDOW_MS, computeTimeAboveThresholds, crossedThresholds} from './tempHistory.js';

// Temperature thresholds (°C) for the heuristic green/orange tiers.
// The red tier is driven by the drive's own critical_warning signal, not a
// guessed °C value (see CRITICAL_WARNING_TEMP in indicator.js). 70°C aligns
// with where most consumer NVMe drives begin thermal throttling.
export const TEMP_WARM_C = 50;
export const TEMP_HOT_C = 70;

// Build the chart drawing area for one device. `readings` is the device's
// rolling history, `criticalWarning` the raw SMART critical_warning byte,
// `tempUnit` the display unit for the axis labels.
export function createTempChartArea({readings, criticalWarning, tempUnit}) {
    const latestReading = readings.length > 0 ? readings[readings.length - 1] : null;
    const latestTemp = latestReading ? latestReading.c : null;
    const color = tempTierColor(latestTemp, criticalWarning);

    const width = 480;
    const height = 96;
    const area = new St.DrawingArea({
        width,
        height,
        reactive: false,
        can_focus: false,
        style_class: 'nvme-temp-chart',
    });
    area._nvmeReadings = readings;
    area._nvmeCriticalWarning = criticalWarning;
    area._nvmeColor = color;
    area._nvmeWindowMs = TEMP_HISTORY_WINDOW_MS;
    area._nvmeTempUnit = tempUnit;

    area.connect('repaint', (a) => {
        drawTempChart(a);
    });

    return area;
}

// Cairo draw callback for the temperature line graph. Plots the
// composite temperature of the last 30 minutes, left = oldest, right
// = newest, with an auto-scaled y range, a baseline grid, faint
// warm/hot threshold guides, and the min/max temperature values
// annotated on the left axis at their level with markers on the line.
export function drawTempChart(area) {
    const cr = area.get_context();
    const [w, h] = area.get_surface_size();
    const readings = area._nvmeReadings || [];
    const color = area._nvmeColor || COLOR_TRACK;
    const windowMs = area._nvmeWindowMs || TEMP_HISTORY_WINDOW_MS;
    const tempUnit = area._nvmeTempUnit;

    // Left padding leaves room for the min/max axis labels; right
    // padding leaves room for the threshold time counters. A little
    // top/bottom padding keeps the line off the edges.
    const padLeft = 30;
    const padRight = 56;
    const padTop = 4;
    const padBottom = 4;
    const plotW = Math.max(1, w - padLeft - padRight);
    const plotH = Math.max(1, h - padTop - padBottom);

    // Black background across the whole plot area.
    cr.setSourceRGB(0.0, 0.0, 0.0);
    cr.rectangle(padLeft, padTop, plotW, plotH);
    cr.fill();
    // Bottom baseline.
    cr.setSourceRGB(COLOR_TRACK[0], COLOR_TRACK[1], COLOR_TRACK[2]);
    cr.setLineWidth(1);
    cr.moveTo(padLeft, padTop + plotH);
    cr.lineTo(padLeft + plotW, padTop + plotH);
    cr.stroke();

    const temps = readings
        .map(r => r.c)
        .filter(t => t !== null && t !== undefined && Number.isFinite(t));
    if (temps.length === 0) {
        cr.$dispose();
        return;
    }

    let minT = Math.min(...temps);
    let maxT = Math.max(...temps);
    // Track the actual data min/max before rounding, for the labels
    // (the axis shows the true max obtained, not the rounded bound).
    const dataMin = minT;
    const dataMax = maxT;
    // Snap the y range to whole tens: the lower bound rounds down to
    // the nearest ten and the upper bound rounds up, so the axis
    // limits always read as round numbers and a flat line is never
    // glued to an edge.
    minT = Math.floor(minT / 10) * 10;
    maxT = Math.ceil(maxT / 10) * 10;
    if (maxT === minT)
        maxT = minT + 10;
    const rangeT = maxT - minT;

    const newest = readings[readings.length - 1].t;
    const oldest = newest - windowMs;

    const xOf = (t) => {
        if (newest === oldest) return padLeft + plotW;
        const frac = Math.max(0, Math.min(1, (t - oldest) / (newest - oldest)));
        return padLeft + frac * plotW;
    };
    const yOf = (temp) => {
        const frac = (temp - minT) / rangeT;
        return padTop + (1 - frac) * plotH;
    };
    // Horizontal gridlines at every whole 10 degrees inside the
    // y range (the axis bounds are already rounded to tens).
    cr.setSourceRGB(0.35, 0.35, 0.35);
    cr.setLineWidth(0.5);
    for (let tickT = minT + 10; tickT < maxT; tickT += 10) {
        const y = yOf(tickT);
        cr.moveTo(padLeft, y);
        cr.lineTo(padLeft + plotW, y);
        cr.stroke();
    }
    // Vertical time guides every 10 minutes, labeled relative to now
    // (the right edge): -10m, -20m, -30m...
    const GUIDE_STEP_MS = 600_000;
    const TICK_LABEL_COLOR = [0.45, 0.45, 0.45];
    cr.setFontSize(7);
    for (let back = GUIDE_STEP_MS; back <= windowMs; back += GUIDE_STEP_MS) {
        const guideT = newest - back;
        const x = xOf(guideT);
        if (x < padLeft || x > padLeft + plotW) continue;
        cr.setSourceRGB(0.25, 0.25, 0.25);
        cr.setLineWidth(0.5);
        cr.moveTo(x, padTop);
        cr.lineTo(x, padTop + plotH);
        cr.stroke();
        cr.setSourceRGB(TICK_LABEL_COLOR[0], TICK_LABEL_COLOR[1], TICK_LABEL_COLOR[2]);
        cr.moveTo(x + 2, padTop + plotH - 2);
        cr.showText(`-${back / 60000}m`);
    }

    // Threshold tiers, from cool to hot, with their tier color. A
    // threshold guide is drawn only when it was crossed at least once
    // over the window; crossed guides are tinted with their tier color
    // so the user sees which intermediate thresholds were reached.
    const thresholds = [
        {value: TEMP_WARM_C, color: COLOR_ORANGE},
        {value: TEMP_HOT_C, color: COLOR_RED},
    ];
    const crossed = new Set(crossedThresholds(readings, thresholds.map(t => t.value)));
    const cw = area._nvmeCriticalWarning || 0;
    const timeAbove = computeTimeAboveThresholds(
        readings, thresholds.map(t => t.value));

    // Faint horizontal guides at the crossed threshold lines.
    cr.setLineWidth(0.5);
    for (const th of thresholds) {
        if (!crossed.has(th.value)) continue;
        if (th.value < minT || th.value > maxT) continue;
        const y = yOf(th.value);
        cr.setSourceRGB(th.color[0], th.color[1], th.color[2]);
        cr.moveTo(padLeft, y);
        cr.lineTo(padLeft + plotW, y);
        cr.stroke();
    }

    // Temperature line + min/max markers.
    drawTempLine(cr, readings, color, xOf, yOf, dataMin, dataMax, cw, tempUnit);

    // Right-side time counters for each crossed threshold.
    drawThresholdCounters(cr, thresholds, crossed, timeAbove, padLeft, plotW, padTop, yOf, plotH, tempUnit);

    cr.$dispose();
}

// Draw the temperature line and the min/max markers + left-axis labels.
// The line is drawn segment by segment: each segment takes the tier
// color of its ending point, so only the portions whose arrival
// temperature crossed a threshold are tinted with that threshold's
// color; the rest keeps the base line color. The max marker is tinted
// by its own temperature tier (green/orange/red) so an over-threshold
// maximum stands out; the min marker stays in the line color. `cw` is
// the raw critical_warning byte used to resolve tiers.
function drawTempLine(cr, readings, color, xOf, yOf, dataMin, dataMax, cw, tempUnit) {
    cr.setLineWidth(1.5);
    let started = false;
    let lastX = null;
    let lastY = null;
    let minPoint = null;
    let maxPoint = null;
    for (const r of readings) {
        if (r.c === null || r.c === undefined || !Number.isFinite(r.c)) continue;
        const x = xOf(r.t);
        const y = yOf(r.c);
        // Historical segments are tiered by their own temperature
        // only; the current critical_warning byte must not tint the
        // whole line red.
        const segColor = tempTierColor(r.c, 0);
        if (!started) {
            lastX = x;
            lastY = y;
            started = true;
        } else {
            cr.setSourceRGB(segColor[0], segColor[1], segColor[2]);
            cr.moveTo(lastX, lastY);
            cr.lineTo(x, y);
            cr.stroke();
            lastX = x;
            lastY = y;
        }
        if (r.c === dataMin && (!minPoint || r.t >= minPoint.t)) minPoint = {x, y};
        if (r.c === dataMax && (!maxPoint || r.t >= maxPoint.t)) maxPoint = {x, y};
    }

    const labelColor = [0.85, 0.85, 0.85];
    const MARKER_R = 2.5;
    const drawExtremum = (pt, value, markerColor) => {
        if (!pt) return;
        cr.setSourceRGB(markerColor[0], markerColor[1], markerColor[2]);
        cr.arc(pt.x, pt.y, MARKER_R, 0, 2 * Math.PI);
        cr.fill();
        cr.setSourceRGB(labelColor[0], labelColor[1], labelColor[2]);
        cr.setLineWidth(0.5);
        cr.arc(pt.x, pt.y, MARKER_R, 0, 2 * Math.PI);
        cr.stroke();
        cr.setFontSize(9);
        cr.moveTo(2, pt.y + 3);
        cr.showText(formatTempCelsius(value, tempUnit) + '\u00b0');
    };
    drawExtremum(minPoint, dataMin, color);
    drawExtremum(maxPoint, dataMax, tempTierColor(dataMax, cw));
}

// Draw the right-side time counters: for each crossed threshold, show
// how long the temperature spent at/above it over the window, colored
// by the threshold tier. Stacked top-down, right-aligned.
function drawThresholdCounters(cr, thresholds, crossed, timeAbove, padLeft, plotW, padTop, yOf, plotH, tempUnit) {
    cr.setFontSize(8);
    const orderedThresholds = [...thresholds].sort((left, right) => right.value - left.value);
    let lastY = -Infinity;
    for (const th of orderedThresholds) {
        if (!crossed.has(th.value)) continue;
        const ms = timeAbove[th.value] || 0;
        const text = formatDurationMs(ms);
        cr.setSourceRGB(th.color[0], th.color[1], th.color[2]);
        const x = padLeft + plotW + 4;
        // Align each counter with its threshold guide line, clamped
        // inside the plot; nudge down when labels would overlap.
        let y = yOf(th.value) + 3;
        y = Math.max(padTop + 8, Math.min(padTop + plotH - 1, y));
        if (y < lastY + 10)
            y = lastY + 10;
        lastY = y;
        cr.moveTo(x, y);
        cr.showText(`${formatTempCelsius(th.value, tempUnit)}\u00b0: ${text}`);
    }
}

// Temperature tier resolution: thermometer icon choice and style class per
// temperature/critical_warning combination.
// Pure module — no GJS imports, unit-tested under plain Node.

// Temperature thresholds (°C) for the heuristic green/orange tiers.
// The red tier is driven by the drive's own critical_warning signal, not a
// guessed °C value. 70°C aligns with where most consumer NVMe drives begin
// thermal throttling.
export const TEMP_WARM_C = 50;
export const TEMP_HOT_C = 70;

// NVMe SMART critical_warning bitmap (Log Page 02h). Bit 1 signals the
// controller's configured temperature threshold was exceeded — the
// manufacturer-true over-temperature signal.
export const CRITICAL_WARNING_TEMP = 0x02;

// Bundled thermometer icon names (see icons.js registry).
export const THERMOMETER_LOW = 'thermometer-low';
export const THERMOMETER_HALF = 'thermometer-half';
export const THERMOMETER_HIGH = 'thermometer-high';

// Thermometer icon for a composite temperature: null when unknown; the
// high icon when the drive signals an over-threshold condition
// (critical_warning bit 1); otherwise the warm/hot heuristic tiers.
export function getThermometerIcon(tempCelsius, criticalWarning) {
    if (tempCelsius === null || tempCelsius === undefined)
        return null;
    if (criticalWarning & CRITICAL_WARNING_TEMP)
        return THERMOMETER_HIGH;
    if (tempCelsius < TEMP_WARM_C)
        return THERMOMETER_LOW;
    if (tempCelsius < TEMP_HOT_C)
        return THERMOMETER_HALF;
    return THERMOMETER_HIGH;
}

// Style class for a temperature value: red when the drive signals an
// over-threshold condition; otherwise the green/orange heuristic tiers.
export function getTempStyle(tempCelsius, criticalWarning) {
    if (tempCelsius === null || tempCelsius === undefined)
        return 'nvme-smart-attr';
    if (criticalWarning & CRITICAL_WARNING_TEMP)
        return 'nvme-smart-warning-red';
    if (tempCelsius < TEMP_WARM_C)
        return 'nvme-smart-attr';
    if (tempCelsius < TEMP_HOT_C)
        return 'nvme-smart-warning-orange';
    return 'nvme-smart-warning-red';
}

// True when a device is in the critical/hot (red) tier: the drive signals
// an over-temperature condition, or the composite reached TEMP_HOT_C.
export function isCriticalTemp(tempCelsius, criticalWarning) {
    if (criticalWarning & CRITICAL_WARNING_TEMP) return true;
    return tempCelsius >= TEMP_HOT_C;
}

// True when any sensor of the temperature object reached TEMP_HOT_C.
export function hasHotTemperatureSensor(temperature) {
    if (!temperature || typeof temperature !== 'object') return false;
    const values = Object.values(temperature);
    return values.some(value => Number.isFinite(value) && value >= TEMP_HOT_C);
}

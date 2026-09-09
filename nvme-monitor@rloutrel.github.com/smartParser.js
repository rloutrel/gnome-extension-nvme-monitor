/**
 * NVMe SMART Parser — Modular architecture
 *
 * Structure:
 *   BaseParser      — Standard NVMe spec fields (Log Page 02h)
 *   SamsungParser   — Extends BaseParser with Samsung-specific vendor fields
 *
 * Usage:
 *   import { SmartParser } from './smartParser.js';
 *   const parser = SmartParser.forDevice(rawSmartData, 'Samsung');
 *   const parsed = parser.parse();
 */

import GLib from 'gi://GLib';

// ---------------------------------------------------------------------------
// Base Parser: Standard NVMe SMART fields (NVMe Specification)
// ---------------------------------------------------------------------------

/**
 * Standard NVMe SMART log page fields (Log Page 02h)
 * @typedef {Object} StandardSmartFields
 * @property {number} [critical_warning]       - Critical warning bits
 * @property {number} [temperature]            - Composite temperature (Kelvin)
 * @property {number} [available_spare]        - Available spare (%)
 * @property {number} [percentage_used]        - Percentage used (%)
 * @property {number} [data_units_read]        - Data units read
 * @property {number} [data_units_written]     - Data units written
 * @property {number} [media_errors]           - Media and data integrity errors
 * @property {number} [num_err_log_entries]    - Number of error log entries
 * @property {number} [power_cycles]           - Power cycles
 * @property {number} [power_on_hours]         - Power on hours
 * @property {number} [unsafe_shutdowns]       - Unsafe shutdowns
 */

/**
 * Normalized temperature data
 * @typedef {Object} TemperatureData
 * @property {number} [composite]   - Composite/overall temperature (°C)
 * @property {number[]} [sensors]   - Individual sensor temperatures (°C)
 */

/**
 * Normalized health data
 * @typedef {Object} HealthData
 * @property {number} [availableSparePercent]
 * @property {number} [percentageUsed]
 */

/**
 * Normalized endurance data
 * @typedef {Object} EnduranceData
 * @property {number} [powerCycles]
 * @property {number} [powerOnHours]
 * @property {number} [dataUnitsRead]
 * @property {number} [dataUnitsWritten]
 * @property {number} [unsafeShutdowns]
 */

/**
 * Normalized alert data
 * @typedef {Object} AlertData
 * @property {number} [criticalWarning]
 * @property {number} [mediaErrors]
 */

/**
 * Fully parsed and normalized SMART data
 * @typedef {Object} ParsedSmartData
 * @property {string} manufacturer
 * @property {TemperatureData} temperature
 * @property {HealthData} health
 * @property {EnduranceData} endurance
 * @property {AlertData} alerts
 * @property {Object} raw             - Original raw JSON
 */

// ---------------------------------------------------------------------------

/**
 * Base parser for standard NVMe SMART fields.
 * All temperatures are converted from Kelvin to Celsius.
 */
export class BaseParser {
    /**
     * @param {Object} raw - Raw SMART JSON from nvme smart-log
     */
    constructor(raw) {
        this.raw = raw;
    }

    /**
     * Detect manufacturer from ModelNumber or SerialNumber prefix.
     * @returns {string} Manufacturer name (normalized)
     */
    _detectManufacturer() {
        const model = this.raw?.ModelNumber || '';
        const serial = this.raw?.SerialNumber || '';

        if (model.includes('Samsung') || serial.startsWith('S')) {
            return 'Samsung';
        }
        if (model.includes('WD') || model.includes('Western Digital') || serial.startsWith('WD')) {
            return 'WD';
        }
        if (model.includes('Micron') || serial.startsWith('M')) {
            return 'Micron';
        }
        if (model.includes('Crucial') || model.includes('CT')) {
            return 'Crucial';
        }
        if (model.includes('SK hynix') || model.includes('SKHynix')) {
            return 'SKHynix';
        }
        if (model.includes('Intel')) {
            return 'Intel';
        }
        return 'Unknown';
    }

    /**
     * Convert Kelvin to Celsius. NVMe SMART returns temperature in Kelvin.
     * @param {number} kelvin
     * @returns {number|null} Temperature in °C, or null if invalid
     */
    _kelvinToCelsius(kelvin) {
        if (kelvin === undefined || kelvin === null) return null;
        // If value looks like Kelvin (> 200K = -73°C), convert
        if (kelvin > 200) {
            return Math.round((kelvin - 273.15) * 10) / 10;
        }
        // Already in Celsius
        return Math.round(kelvin * 10) / 10;
    }

    /**
     * Parse temperature data from raw SMART.
     * Base implementation: single composite temperature.
     * @returns {TemperatureData}
     */
    _parseTemperature() {
        return {
            composite: this._kelvinToCelsius(this.raw.temperature),
            sensors: [],
        };
    }

    /**
     * Parse health data from raw SMART.
     * @returns {HealthData}
     */
    _parseHealth() {
        return {
            availableSparePercent: this.raw.avail_spare,
            percentageUsed: this.raw.percent_used,
        };
    }

    /**
     * Parse endurance data from raw SMART.
     * @returns {EnduranceData}
     */
    _parseEndurance() {
        return {
            powerCycles: this.raw.power_cycles,
            powerOnHours: this.raw.power_on_hours,
            dataUnitsRead: this.raw.data_units_read,
            dataUnitsWritten: this.raw.data_units_written,
            unsafeShutdowns: this.raw.unsafe_shutdowns,
        };
    }

    /**
     * Parse alert data from raw SMART.
     * @returns {AlertData}
     */
    _parseAlerts() {
        return {
            criticalWarning: this.raw.critical_warning,
            mediaErrors: this.raw.media_errors,
        };
    }

    /**
     * Parse all SMART data into normalized structure.
     * @returns {ParsedSmartData}
     */
    parse() {
        return {
            manufacturer: this._detectManufacturer(),
            temperature: this._parseTemperature(),
            health: this._parseHealth(),
            endurance: this._parseEndurance(),
            alerts: this._parseAlerts(),
            raw: this.raw,
        };
    }
}

// ---------------------------------------------------------------------------
// Samsung Parser: Extends BaseParser with Samsung-specific fields
//
// Samsung SSDs report:
//   - temperature: composite/overall (often = sensor 1)
//   - temperature_sensor_1: Controller temperature
//   - temperature_sensor_2: NAND array temperature (typically +2-5°C)
//   - temperature_sensor_3+: Additional sensors (optional)
//
// References:
//   - nvme-cli Samsung extension: https://github.com/linux-nvme/nvme-cli/tree/master/Documentation
//   - Samsung NVMe SSD documentation
// ---------------------------------------------------------------------------

export class SamsungParser extends BaseParser {
    /**
     * Parse Samsung temperature data: composite + up to 8 sensors.
     * @returns {TemperatureData}
     */
    _parseTemperature() {
        const composite = this._kelvinToCelsius(this.raw.temperature);
        const sensors = [];

        for (let i = 1; i <= 8; i++) {
            const key = `temperature_sensor_${i}`;
            if (this.raw[key] !== undefined && this.raw[key] > 0) {
                sensors.push(this._kelvinToCelsius(this.raw[key]));
            }
        }

        return { composite, sensors };
    }

    /**
     * Samsung-specific health parsing (extends base).
     * @returns {HealthData}
     */
    _parseHealth() {
        const base = super._parseHealth();
        // Samsung may report additional health metrics
        return base;
    }

    /**
     * Samsung-specific endurance parsing (extends base).
     * @returns {EnduranceData}
     */
    _parseEndurance() {
        const base = super._parseEndurance();
        // NVMe SMART reports host_read_commands / host_write_commands.
        if (this.raw.host_read_commands !== undefined) {
            base.hostReads = this.raw.host_read_commands;
        }
        if (this.raw.host_write_commands !== undefined) {
            base.hostWrites = this.raw.host_write_commands;
        }
        return base;
    }
}

// ---------------------------------------------------------------------------
// WD (Western Digital) Parser
//
// WD NVMe SSDs may report vendor-specific SMART fields.
//
// References:
//   - nvme-wdc smart-add-log: https://github.com/linux-nvme/nvme-cli/blob/master/Documentation/nvme-wdc-smart-add-log.1
// ---------------------------------------------------------------------------

export class WDParser extends BaseParser {
    // WD-specific parsing can be added here
    // Currently uses base parser behavior
}

// ---------------------------------------------------------------------------
// Micron Parser
//
// Micron NVMe SSDs report vendor-specific SMART data.
//
// References:
//   - nvme-micron-smart-add-log: https://www.mankier.com/1/nvme-micron-smart-add-log
// ---------------------------------------------------------------------------

export class MicronParser extends BaseParser {
    // Micron-specific parsing can be added here
    // Currently uses base parser behavior
}

// ---------------------------------------------------------------------------
// Crucial Parser
//
// Crucial (Micron consumer brand) NVMe SSDs.
//
// References:
//   - Part of Micron family; uses similar vendor extensions
// ---------------------------------------------------------------------------

export class CrucialParser extends BaseParser {
    // Crucial-specific parsing can be added here
    // Currently uses base parser behavior
}

// ---------------------------------------------------------------------------
// SK Hynix Parser
//
// SK Hynix NVMe SSDs.
//
// References:
//   - Vendor-specific log pages documented in SK Hynix NVMe SSD datasheets
// ---------------------------------------------------------------------------

export class SKHynixParser extends BaseParser {
    // SK Hynix-specific parsing can be added here
    // Currently uses base parser behavior
}

// ---------------------------------------------------------------------------
// Intel Parser
//
// Intel NVMe SSDs.
//
// References:
//   - Intel SSD Toolbox documentation
//   - nvme-intel extension in nvme-cli
// ---------------------------------------------------------------------------

export class IntelParser extends BaseParser {
    // Intel-specific parsing can be added here
    // Currently uses base parser behavior
}

// ---------------------------------------------------------------------------
// Factory: Get the appropriate parser for a device
// ---------------------------------------------------------------------------

/**
 * Factory function to get the appropriate parser for a device.
 * @param {Object} raw - Raw SMART JSON
 * @param {string} [manufacturer] - Optional manufacturer override
 * @returns {BaseParser} Parser instance
 */
export function getParser(raw, manufacturer = null) {
    if (manufacturer) {
        switch (manufacturer.toLowerCase()) {
            case 'samsung':
                return new SamsungParser(raw);
            case 'wd':
            case 'western digital':
                return new WDParser(raw);
            case 'micron':
                return new MicronParser(raw);
            case 'crucial':
                return new CrucialParser(raw);
            case 'sk hynix':
            case 'skhynix':
                return new SKHynixParser(raw);
            case 'intel':
                return new IntelParser(raw);
            default:
                return new BaseParser(raw);
        }
    }

    // Auto-detect from raw data
    const detected = new BaseParser(raw)._detectManufacturer();
    switch (detected.toLowerCase()) {
        case 'samsung':
            return new SamsungParser(raw);
        case 'wd':
        case 'western digital':
            return new WDParser(raw);
        case 'micron':
            return new MicronParser(raw);
        case 'crucial':
            return new CrucialParser(raw);
        case 'sk hynix':
        case 'skhynix':
            return new SKHynixParser(raw);
        case 'intel':
            return new IntelParser(raw);
        default:
            return new BaseParser(raw);
    }
}

/**
 * Convenience function: parse SMART JSON in one call.
 * @param {Object} raw - Raw SMART JSON from nvme smart-log
 * @returns {ParsedSmartData}
 */
export function parseSmart(raw) {
    return getParser(raw).parse();
}
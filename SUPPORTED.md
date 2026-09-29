# Supported manufacturers and tested devices

NVMe Monitor distinguishes two levels of device coverage:

- **Supported manufacturer** — the manufacturer is detected from the
  drive's model/serial number and has a dedicated vendor parser. Devices
  from a supported manufacturer should work out of the box, but see the
  caveat below.
- **Tested device** — a concrete drive model that has been validated
  against real hardware, with its actual `nvme smart-log -o json` output
  captured in the unit tests (`test/smartParser.test.js` fixtures).

## Tested devices (confirmed working)

| Manufacturer | Model | Device path | Firmware | Fixture |
|--------------|-------|-------------|----------|---------|
| Samsung | SSD 970 EVO Plus 2TB | `/dev/nvme0n1` | 2B2QEXM7 | `samsung_ssd_970_evo_plus_2tb` |
| Samsung | SSD 980 500GB | `/dev/nvme1n1` | 1B4QFXO7 | `samsung_ssd_980_500gb` |

These are the only drives validated against real hardware so far.

## Supported manufacturers

| Manufacturer | Vendor parser | Real-device validated |
|--------------|---------------|------------------------|
| Samsung | `SamsungParser` (Controller/NAND sensor labels) | Yes — both models above |
| Western Digital (WD) | `WDParser` | No |
| Micron | `MicronParser` | No |
| Crucial | `CrucialParser` | No |
| SK Hynix | `SKHynixParser` | No |
| Intel | `IntelParser` | No |

## Reporting a device

- **Unknown manufacturer** (red `!` button in the menu): the detection
  pattern is missing. Please open an issue with the *Support new device*
  template — the extension's support dialog provides the raw
  `nvme list` and `nvme smart-log` JSON to attach.
- **Supported manufacturer, but something looks wrong** (missing sensors,
  odd values, mislabelled data): please open an issue too. Devices of the
  same manufacturer are *probably* similar, but not guaranteed to be —
  vendor log pages and sensor layouts differ between models and firmware
  generations. The issue template asks for the full `nvme list` and
  `nvme smart-log` output even when the manufacturer is already supported,
  so a fixture for your exact drive can be added to the test suite.

Confirmed-working devices from the community are added to the table above
(and, when the output is provided, as test fixtures) so the list keeps
growing with real-world data.

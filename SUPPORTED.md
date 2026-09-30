# Supported manufacturers and known devices

NVMe Monitor distinguishes two levels of device coverage:

- **Supported manufacturer** — the manufacturer is detected from the
  drive's model/serial number and has a dedicated vendor parser. Devices
  from a supported manufacturer should work out of the box, but see the
  caveat below.
- **Confirmed working device** — a concrete drive model that has been
  validated against real hardware, with its actual
  `nvme smart-log -o json` output captured in the unit tests
  (`test/smartParser.test.js` fixtures).

## Known devices

Each registry entry keys on the model name (human-readable identity),
but `confirmed` and `latestFirmware` live per **hardware revision**,
keyed by the controller PCI device ID (from `lspci -nn`), because
manufacturers ship different controller revisions under the same model
name. `0xa808` is the original Phoenix controller revision of the 970
EVO Plus (firmware line `2B2QEXM7`); the later Elpis-controller revision
(PCI device ID to be confirmed, expected in the `0xa80a` family) has its
own firmware line (`4B2QEXM7`). Owners of a known model whose revision is
not registered get the orange `!` button, asking them to report their
device so the revision can be documented.

| Manufacturer | Model | Confirmed working | Last firmware | Remark | Fixture |
|--------------|-------|-------------------|---------------|--------|---------|
| Samsung | SSD 970 EVO Plus 2TB | ✅ (`0xa808`) | `[{pciDeviceId: 0xa808, latestFirmware: 2B2QEXM7}]` | Two hardware revisions share this model name; the PCI device ID (from `lspci -nn`) tells them apart. | `samsung_ssd_970_evo_plus_2tb` |
| Samsung | SSD 980 500GB | ✅ (`0xa809`) | `[{pciDeviceId: 0xa809, latestFirmware: 1B4QFXO7}]` | Single revision; one firmware line for all drives. | `samsung_ssd_980_500gb` |

These are the only drives confirmed working against real hardware so
far. Other models listed here (with an empty *Confirmed working* column)
are known devices the parser handles, but they have not been validated
on real hardware yet; they keep the yellow `!` support button in the
panel until confirmed. The same applies to a known model whose hardware
revision (PCI device ID) is not registered yet.

## Supported manufacturers

| Manufacturer | Vendor parser | Firmware page |
|--------------|---------------|---------------|
| Samsung | `SamsungParser` (Controller/NAND sensor labels) | [Samsung Semiconductor — Tools & Software](https://semiconductor.samsung.com/consumer-storage/support/tools/) — refreshed by `tools/updateSamsungFirmware.mjs` |
| Western Digital (WD) | `WDParser` | |
| Micron | `MicronParser` | |
| Crucial | `CrucialParser` | |
| SK Hynix | `SKHynixParser` | |
| Intel | `IntelParser` | |

## Reporting a device

- **Unknown manufacturer** (red `!` button in the menu): the detection
  pattern is missing. Please open an issue with the *Support new device*
  template — the extension's support dialog provides the raw
  `nvme list` and `nvme smart-log` JSON to attach.
- **Known model, unknown hardware revision** (orange `!` button in the
  menu): your exact drive revision is not registered yet. Please open an
  issue with the *Support new device* template and include the output of
  `lspci -nn | grep -i nvme` so the revision can be documented.
- **Supported manufacturer, but something looks wrong** (missing sensors,
  odd values, mislabelled data): please open an issue too. Devices of
  the same manufacturer are *probably* similar, but not guaranteed to be —
  vendor log pages and sensor layouts differ between models and firmware
  generations. The issue template asks for the full `nvme list` and
  `nvme smart-log` output even when the manufacturer is already supported,
  so a fixture for your exact drive can be added to the test suite.

Confirmed-working devices from the community are added to the table above
(and, when the output is provided, as test fixtures) so the list keeps
growing with real-world data.

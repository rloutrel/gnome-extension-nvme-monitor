# AGENTS.md

Guidance for AI coding agents (Claude, Cursor, Copilot, etc.) working on this
repository. Read this before editing anything.

## Project

GNOME Shell extension that surfaces NVMe drive health (SMART log, temperature,
endurance) in the top-bar menu. Targets **GNOME Shell 50/51** (ESM imports
`resource:///org/gnome/shell/...`).

- UUID / extension dir: `nvme-monitor@rloutrel.github.com/`
- Language: JavaScript (ESM modules)
- Runtime: GJS (SpiderMonkey) inside GNOME Shell
- No build step, no bundler, no transpiler. Source files are shipped as-is.

## Architecture

```
nvme-monitor@rloutrel.github.com/
  extension.js         # GNOME Shell entry point: Indicator, menu, polling,
                       #   icon loading, command execution, nvme-cli version
                       #   check. Imports all pure modules below.
  smartParser.js       # PURE: SMART log parsing. BaseParser + vendor parsers
                       #   (Samsung, WD, Micron, Crucial, SKHynix, Intel).
                       #   getParser() factory + parseSmart() convenience.
  tempFormat.js         # PURE: temperature line formatting (French comma,
                       #   vendor sensor labels). formatTempCelsius,
                       #   formatTemperatureLine, formatSensorRows.
  versionUtils.js       # PURE: parse `nvme version` output, detect affected
                       #   ranges (2.11-2.12, >=3.0 format change; 2.0-2.2
                       #   bytes overflow). assessNvmeCliVersion().
  deviceList.js         # PURE: normalize flat + nested `nvme list -o json`
                       #   layouts into a uniform device entry list.
  stylesheet.css        # Theme-aware styles (no hardcoded colors).
  metadata.json         # Shell version, UUID, version.
  setup-polkit.sh       # Installs the polkit + wrapper stack (run as root).
  icons/bootstrap/      # Bundled SVG icons (Bootstrap Icons, MIT).
  test/                 # Unit tests (Node built-in runner).
```

### Pure vs GJS modules

A hard rule: **`smartParser.js`, `tempFormat.js`, `versionUtils.js`, and
`deviceList.js` are pure modules with zero GJS/GObject imports.** They run
under plain Node and are unit-tested there. Do **not** add `gi://` or
`resource:///` imports to these files. Anything that touches `Gio`, `GLib`,
`St`, `Clutter`, `Main`, or GObject belongs in `extension.js` (or a future
GJS-only module), never in a pure module.

### Data flow

1. `enable()` builds the `Indicator`, loads the panel icon, runs the nvme-cli
   version check, and starts polling if the polkit stack is installed.
2. On menu open (or every 5s while polling), `_refreshDevices()` rebuilds the
   device section.
3. `_fetchAndCacheDevices()` runs `nvme list -o json` once and caches the result.
   `normalizeDeviceList()` handles both the flat (pre-2.11, 2.13+) and nested
   (2.11-2.12, 3.0+) JSON layouts.
4. For each device, the cached `ModelNumber` (from `nvme list`) is passed as a
   `modelHint` through `_addSmartInfo()` → `parseSmart()` → `getParser()`.
   Manufacturer detection uses the model hint because the SMART log itself
   has no `ModelNumber`.
5. SMART data is fetched via the polkit wrapper
   (`/usr/local/bin/nvme-smart-log-json`), which restricts nvme-cli to
   `smart-log -o json` on `/dev/nvme*` devices only.

## Conventions

### Logging

Follow the [GJS debugging guide](https://gjs.guide/extensions/development/debugging.html#logging).
All log helpers live in `extension.js` and prefix with `LOG_PREFIX = '[NVMe-monitor]'`:

- `_debug(msg)` → `console.debug` — dev-only info
- `_warn(msg)` → `console.warn` — unexpected, possible bugs
- `_error(msg)` → `console.error` — failures
- `notify(title, body)` → info notification + debug log
- `notifyError(title, body)` → warning notification + warn log

Do **not** use `console.log`. Do not reintroduce the old loop-detector.

### Icons

- Bundled SVGs live in `icons/bootstrap/`, referenced by bare name (no
  extension). Load via `_loadIconByName()` which returns a cached `Gio.FileIcon`.
- Use the `ICONS` enum (Object.freeze) constant, never hardcoded icon strings.
- `_createIcon(name, size, styleClass)` builds an `St.Icon` with `gicon` from a
  bundled file, falling back to `icon_name` (system theme) only if missing.
- System fallback (not bundled): `ICONS.PanelFallback = 'drive-harddisk-symbolic'`.

### Temperature thresholds

- `TEMP_WARM_C = 50` → orange tier (heuristic)
- `TEMP_HOT_C = 70` → red tier (heuristic, thermal throttle region)
- Red tier is primarily driven by the drive's `critical_warning` bit 1
  (`CRITICAL_WARNING_TEMP = 0x02`) — the manufacturer-true over-temperature
  signal — not a guessed °C value.
- Temperature formatting: one decimal, French comma (`42,0°C`). Samsung uses
  `Controller`/`NAND` labels; others use `Sensor N`.

### nvme-cli field names

The parser uses the actual `nvme smart-log -o json` field names:
`avail_spare` (not `available_spare`), `percent_used` (not `percentage_used`),
`host_read_commands`/`host_write_commands` (not `host_reads`/`host_writes`).
Do not "fix" these to the spec names — match the JSON nvme-cli emits.

### nvme-cli version compatibility

Two known nvme-cli software bugs (not hardware) affect this extension:

- **Bug A** (int32 overflow): `UsedBytes`/`PhysicalSize` negative. nvme-cli
  2.0–2.2, fixed in 2.3 / libnvme 1.3.
- **Bug B** (JSON format change): `nvme list -o json` switched to a nested
  layout in 2.11–2.12, reverted in 2.13, reintroduced in 3.0+.
  Reference: https://github.com/linux-nvme/nvme-cli/issues/2749

The extension parses both layouts (`deviceList.js`) and warns affected users
(`versionUtils.js` + notification linking to issue #2749).

### Code style

- ESM imports only (`import ... from`).
- No code comments unless documenting a non-obvious invariant (the existing
  files use section-separator banner comments; match that style sparingly).
- Use `Object.freeze` for constant enums.
- Match the existing naming: `camelCase` functions, `PascalCase` classes,
  `UPPER_SNAKE` constants.
- Try not to add dependencies. The repo uses only GObject introspection and Node's
  built-in test runner.

## Translations (gettext)

The extension is internationalized with gettext (i18n). GNOME Shell
auto-initializes the domain named in `metadata.json` (`gettext-domain`).

- All user-visible strings in `extension.js` are wrapped in `_()`, imported
  from `resource:///org/gnome/shell/extensions/extension.js`.
- **Pure modules must stay free of gettext.** `tempFormat.js` accepts
  translated labels (Controller/NAND/Sensor) via an optional `labels`
  argument and falls back to English defaults; the caller (`extension.js`)
  passes `_(...)` results in.
- Translation sources live in `po/`:
  - `POTFILES` — list of files containing translatable strings.
  - `LINGUAS` — list of language codes with translations.
  - `nvme-monitor@rloutrel.github.com.pot` — message template.
  - `fr.po`, `de.po` — per-language translations.
- When strings are added/removed/changed, regenerate the POT template and
  update the `.po` files. With gettext installed:
  ```bash
  cd nvme-monitor@rloutrel.github.com
  xgettext --from-code=UTF-8 --output=po/nvme-monitor@rloutrel.github.com.pot \
      --files-from=po/POTFILES --keyword=_ --keyword=N_
  ```
  (No `xgettext` in the dev environment — edit the `.pot`/`.po` by hand
  instead.)
- Compiled `.mo` files (in `locale/<lang>/LC_MESSAGES/`) are produced at
  pack time via `gnome-extensions pack --podir=po`. Do not commit `.mo`
  files.

## Testing

Pure modules are unit-tested with Node's built-in runner (no test framework,
no dependencies):

```bash
node --test \
  "nvme-monitor@rloutrel.github.com/test/tempFormat.test.js" \
  "nvme-monitor@rloutrel.github.com/test/smartParser.test.js" \
  "nvme-monitor@rloutrel.github.com/test/versionUtils.test.js" \
  "nvme-monitor@rloutrel.github.com/test/deviceList.test.js"
```

- Use `node:test` + `node:assert/strict`.
- Tag tests with the source fixture they cover (e.g.
  `samsung_ssd_980_500gb`, `nested_format`).
- Test data is real `nvme smart-log` / `nvme list` JSON where available.
- Verify pure modules with `node --check <file>` before committing.

`extension.js` cannot be unit-tested outside GNOME Shell (GJS imports); verify
it with `node --check extension.js` for syntax only.

## Commit style

Conventional commits, scoped:

- `feat(temp): ...`, `fix(parser): ...`, `refactor(icons): ...`,
  `refactor(menu): ...`, `feat(version): ...`
- Keep commits focused; one logical change per commit.

## Polkit stack

`setup-polkit.sh` (run as root via pkexec from the extension) installs:
- `/usr/local/bin/nvme-smart-log-json` — wrapper restricted to
  `nvme smart-log -o json /dev/nvme*`
- A `nvme-smart` system group; the invoking user is added to it
- Polkit `.policy` + `.rules` granting passwordless access to group members
- A self-deleting uninstall script

After install, the user must log out and back in for group membership to take
effect. The wrapper hardcodes the resolved `nvme` binary path to avoid PATH
injection.

## Validation checklist before editing

1. Read `AGENTS.md` (this file), `metadata.json`, and the target file.
2. Check `git status` / current branch / recent commits.
3. For pure modules: keep them pure (no GJS imports).
4. Use existing constants/enums (`ICONS`, `TEMP_*`, `CRITICAL_WARNING_TEMP`)
   instead of hardcoded values.
5. Use the logging helpers, not `console.log`.
6. Match nvme-cli JSON field names exactly.
7. Add/adjust unit tests for pure-module changes.
8. Run `node --test` on all test files; run `node --check` on changed files.

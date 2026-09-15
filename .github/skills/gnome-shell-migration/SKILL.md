---
name: gnome-shell-migration
description: 'Use when auditing or migrating a GNOME Shell extension between Shell 50 and 51, checking metadata, deprecated APIs, St/Clutter behavior, lifecycle methods, or upgrade regressions.'
argument-hint: 'Name the extension path or migration concern to audit.'
---

# GNOME Shell 50/51 Migration

## Procedure

1. Read `AGENTS.md`, `metadata.json`, the entry point, preferences, and any
   files named by the user. Preserve the declared target Shell versions.
2. Consult the official guides for Shell 50 and Shell 51:
   - https://gjs.guide/extensions/upgrading/gnome-shell-50.html
   - https://gjs.guide/extensions/upgrading/gnome-shell-51.html
3. Search the code for affected patterns and inspect each call site rather than
   applying a blind replacement.
4. Make the smallest migration edit and explain whether it is required,
   deprecated-but-supported, or merely a preparation for Shell 51.
5. Run syntax checks and focused tests, then report any checks that require a
   real GNOME Shell session.

## Shell 50 checks

- `enable()` and `disable()` remain synchronous unless the target API explicitly
  documents otherwise; Shell 51 rejects an async `disable()`.
- Check `easeAsync()`, one-shot GLib timeout/idle helpers, and any changed
  Shell-private APIs against the guide before using them.
- Keep metadata valid; the Shell 50 guide reports no required metadata change.

## Shell 51 checks

Search for and review these high-signal migration points:

- `St` widget `vertical` properties were removed.
- Popup menu `open()` and `close()` use a parameter object such as
  `{animate: false}` rather than a legacy animation argument.
- Prefer Clutter event controllers over direct deprecated actor event signals.
- Replace `Shell.GLSLEffect` with `Clutter.ShaderEffect` where relevant.
- Replace removed `Clutter.get_default_backend()` calls with the documented
  backend access for the owning actor or global stage.
- Instantiate the class returned by `Gio.DBus.makeProxyWrapper()`.
- Use `St.ReducedMotion` and `St.Settings` when adding motion in Shell 51.
- Review any imports of removed or moved Shell-private modules.

Do not invent compatibility shims. If one code path must support both versions,
verify the exact availability and lifecycle behavior from the official guides.

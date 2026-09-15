---
name: gnome-gjs-gtk4-practices
description: 'Use when writing or reviewing GJS, GTK4, GNOME Shell extension, St, Clutter, GObject, Gio, or GJS API code; consult current official documentation and GNOME review guidance.'
argument-hint: 'Describe the GJS or GNOME API task to research or review.'
---

# GJS and GTK4 Practices

## Scope

Use this skill for current API research, design decisions, code review, and
implementation guidance. The target is GNOME Shell 50 with Shell 51 readiness.

GTK4 is the current GTK application toolkit. A Shell extension is a different
process and UI environment: its panel and menu UI normally uses `St`, `Clutter`,
`Shell`, and GNOME Shell extension APIs. Treat GTK4 documentation as the
application/UI foundation and use Shell documentation for extension UI APIs.
Do not turn GTK4 application examples into `extension.js` imports blindly.

## Source order

Consult live sources through `gnome-docs/*` when available, in this order:

1. GJS Guide: https://gjs.guide/
2. GJS API reference: https://gjs-docs.gnome.org/
3. GTK4 API and migration docs: https://docs.gtk.org/gtk4/
4. GNOME developer platform and HIG: https://developer.gnome.org/
5. GTK4 + GJS Book resources: https://rmnvgr.gitlab.io/gtk4-gjs-book/introduction/resources/
6. GNOME Shell version guides and EGO review guidance: https://gjs.guide/extensions/

Record the page and relevant version when a recommendation depends on a
versioned API. Do not claim that a GTK API is available in Shell without checking
its process and introspection context.

## Review checklist

- Use ESM imports and public `resource:///` imports appropriate to the target
  Shell version.
- Keep `extension.js`, preferences, and pure helper modules separated by runtime.
- Keep lifecycle cleanup owned by the class that creates signals, sources,
  cancellables, subprocesses, or widgets.
- Prefer current controllers and documented APIs over deprecated signal paths.
- Use `St.Icon` for Shell UI and `Gtk.Image` for GTK preferences; do not use
  Unicode characters as substitute icons.
- Avoid needless try/catch wrappers, optional chaining for guaranteed APIs, and
  compatibility branches without a documented target-version reason.
- Check accessibility, translations, theme-aware styling, and reduced-motion
  behavior when the UI or animation changes.
- Use GLib/Gio or D-Bus where appropriate; avoid expensive work in the Shell
  process and avoid unrestricted subprocess execution.

## Output

State which source was consulted, distinguish GTK4 from Shell/St APIs, identify
version assumptions, and propose the smallest idiomatic change. Pair advice
with a focused check such as `node --check`, the pure-module tests, or the
`gjs-runtime` MCP syntax check.

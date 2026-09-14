# Theme-Aware Icons - TODO

## Context

Bundled SVG icons are currently loaded as standalone files via `GIcon` /
`St.Icon` (see `extension.js` `_loadIconByName` / `_createIcon`). Because each
SVG is rasterized as its own GIcon, the actor's CSS `color` does not flow into
the SVG's `fill` attribute, so the icons cannot react to theme colors.

As a workaround, the extension ships paired `-dark` variants (white `fill="white"`)
kept visible on a dark menu/panel, with `DARK_ICON_VARIANTS` mapping each base
icon to its dark sibling.

## Goal

Make the icons theme-aware so they adapt automatically to the system accent and
light/dark variant, removing the need for the hardcoded `-dark` variants.

## Why this is the only viable theme-aware path

The GNOME Shell St CSS engine (GNOME 50/51) does **not** support the
`@define-color` at-rule. Only two runtime theme-aware color identifiers are
recognized by St (see `src/st/st-theme-node.c` `get_color_from_term`):

- `-st-accent-color`
- `-st-accent-fg-color`

These are provided by `StThemeContext` from the system accent
(`st_theme_context_get_accent_color`). They are only reachable from CSS that
applies to an St actor — i.e. via `fill="currentColor"` on an inline SVG whose
parent actor has `color: -st-accent-color`. Standalone GIcon SVGs cannot access
them.

## Plan

- [ ] Render bundled SVGs **inline** (e.g. load the SVG markup and insert it as
  the content of an `St.Bin`/widget) instead of loading each file as a `GIcon`.
- [ ] Replace the baked-in `fill="white"` / `fill="darkred"` / `fill="darkorange"`
  in the SVGs with `fill="currentColor"`, so the icon color resolves against the
  parent actor's CSS `color`.
- [ ] Drive the actor color from `stylesheet.css` using the St theme-aware
  tokens:
  - `color: -st-accent-color;` for the main icon fill
  - `color: -st-accent-fg-color;` where a foreground/accent contrast is needed
- [ ] Remove the `-dark` SVG variants and the `DARK_ICON_VARIANTS` mapping once
  inline rendering makes them redundant.
- [ ] Keep semantic warning/error colors (thermometer `darkred`/`darkorange`)
  theme-aware where possible, or document the trade-off (St exposes no
  `@warning_color`/`@error_color` equivalent on the shell side).

## References

- St theme-aware color tokens: `src/st/st-theme-node.c` (`get_color_from_term`),
  `src/st/st-theme-context.c` (`update_accent_colors`,
  `st_theme_context_get_accent_color`).
- GNOME Shell theme palette (SCSS, compile-time only):
  `data/theme/gnome-shell-sass/_palette.scss`, `_default-colors.scss`,
  `_colors.scss`.
- Current icon loading: `extension.js` `_loadIconByName`,
  `_loadMenuIconByName`, `_createIcon`, `DARK_ICON_VARIANTS`.

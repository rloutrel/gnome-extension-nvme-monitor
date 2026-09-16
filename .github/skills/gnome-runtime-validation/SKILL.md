---
name: gnome-runtime-validation
description: 'Use when validating GJS syntax, GNOME Shell extension runtime behavior, or host-versus-Docker GJS availability; supports configurable local Docker images.'
argument-hint: 'Describe the file or runtime check to perform.'
---

# GJS Runtime Validation

## Choose a runtime

Use the `gjs-runtime` MCP first when it is configured. It exposes
`check_syntax` and selects a host `gjs` binary or Docker according to the MCP
inputs. The Docker image must contain GJS and be able to run the requested
check; set the image in the MCP prompt when the default is unsuitable.

For manual checks, use:

```sh
gjs --check path/to/extension.js
node --check path/to/pure-module.js
```

The project does not have a build step. A Docker check for a source file should
mount the workspace and run from `/workspace`, for example:

```sh
docker run --rm -i -v "$PWD:/workspace:ro" "$GJS_DOCKER_IMAGE" \
  gjs --check /workspace/nvme-monitor@rloutrel.github.com/extension.js
```

Use a GNOME Shell container or a real GNOME session for checks involving
`resource:///` imports, `Main`, `St`, display state, D-Bus services, or Shell UI.
A plain GJS image can only validate JavaScript and available introspection APIs.

## Validation order

1. Syntax-check the changed GJS file with `gjs-runtime` or `gjs --check`.
2. Run `node --check` for pure modules.
3. Run the focused Node test file, then the complete pure-module test command
   from `AGENTS.md` when shared behavior changed.
4. Run ESLint, metadata validation, and ShellCheck when relevant.
5. For a migration, repeat the check against the second target runtime if it is
   available and clearly report unavailable runtime coverage.

Never present a host syntax check as proof that a Shell extension loads. Report
runtime limitations and any missing Docker image or GNOME session explicitly.

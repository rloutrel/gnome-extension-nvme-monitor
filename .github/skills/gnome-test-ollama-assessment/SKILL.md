---
name: gnome-test-ollama-assessment
description: 'Use when running the GNOME extension test, syntax, lint, metadata, and ShellCheck validations and optionally asking a local Ollama model to assess the collected results.'
argument-hint: 'Optionally provide an Ollama model name, runtime, or focused validation scope.'
---

# Test and Ollama Assessment

## Principle

Use deterministic commands as the source of truth. Ollama is an optional local
reviewer that summarizes evidence, identifies suspicious failures, and suggests
next checks; it must never convert a failed command into a pass or replace a
real GNOME Shell session.

For this repository, validation splits cleanly into:

- Node-side checks for the pure JavaScript modules and metadata
- Shell-side checks for the polkit setup script
- GNOME Shell / GJS runtime checks for `extension.js` that still require a live
  GNOME Shell 50/51 environment or a compatible GJS runtime image

## Procedure

1. Run [the validation runner](./scripts/validate-and-assess.sh) from the
   repository root.
2. Review each command's exit status and output yourself.
3. If Ollama is available, inspect its assessment as a second opinion. It must
   distinguish passed, failed, skipped, and unavailable checks and quote the
   command that supports each claim.
4. Fix source or test failures based on the deterministic output, then rerun the
   same validation scope.
5. For UI, GJS introspection, `resource:///` imports, D-Bus, polkit, or Shell
   lifecycle behavior, report that a real GNOME Shell 50/51 session or a GJS-capable
   Docker image is still required.

When Node is not installed on the host, use the Docker fallback instead of
assuming the repo is unvalidated:

```sh
VALIDATION_RUNTIME=docker \
VALIDATION_DOCKER_IMAGE=node:22-bookworm \
./.github/skills/gnome-test-ollama-assessment/scripts/validate-and-assess.sh
```

The Docker path installs ShellCheck, `jq`, and `curl`, runs `npm ci`, mounts the
repository at `/workspace`, and keeps the repo root accessible to the validation
script. It covers the Node-based checks and CI-equivalent validation, but it does
not provide a live GNOME Shell session for runtime behavior in `extension.js`.

## Commands covered

The runner mirrors the repository’s real checks locally:

- `node --test` over the six pure-module test files in
  `nvme-monitor@rloutrel.github.com/test/`
- `node --check` for each non-test JavaScript file in the extension directory
- `node nvme-monitor@rloutrel.github.com/test/validateMetadata.js`
- `shellcheck nvme-monitor@rloutrel.github.com/setup-polkit.sh`
- `eslint` when dependencies are installed

This repo’s unit tests are Node-only and intentionally avoid a UI runtime;
`extension.js` is syntax-checked only outside GNOME Shell. Missing tools are
recorded as unavailable rather than silently ignored. Its exit status is
nonzero for a failed check or unavailable required runtime, regardless of the
Ollama response.

The separate CodeQL workflow and SonarCloud workflow are not reproduced by this
runner. They depend on GitHub Actions and, for SonarCloud, credentials. Treat
those as CI-only checks unless their tools are deliberately installed and
configured locally.

## Ollama configuration

The runner uses the local Ollama HTTP API:

- `OLLAMA_URL`, default `http://127.0.0.1:11434`
- `OLLAMA_MODEL`, default `qwen3.5:9b`
- `OLLAMA_TIMEOUT`, default `120` seconds

The model receives validation output only. Do not send credentials, private
keys, or unrelated source files. If Ollama is stopped, the deterministic report
still completes and the assessment is marked unavailable.

## Interpretation

Treat an Ollama assessment as a review note, not a test oracle. Keep the exact
command output, check whether the model inferred anything unsupported, and give
priority to reproducible failures and the project's GNOME Shell 50/51 runtime
constraints.

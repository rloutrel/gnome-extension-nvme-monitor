#!/usr/bin/env bash
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)
REPORT=$(mktemp)
DETERMINISTIC_STATUS=0
UNAVAILABLE_STATUS=0

if [[ ${VALIDATION_RUNTIME:-host} == docker && ${VALIDATION_IN_CONTAINER:-0} != 1 ]]; then
    if ! command -v docker >/dev/null 2>&1; then
        printf 'Docker validation requested, but docker is not installed.\n' >&2
        exit 2
    fi

    VALIDATION_DOCKER_IMAGE=${VALIDATION_DOCKER_IMAGE:-node:22-bookworm}
    exec docker run --rm -i --network host \
        -v "$ROOT:/workspace" -w /workspace \
        -e VALIDATION_RUNTIME=host \
        -e VALIDATION_IN_CONTAINER=1 \
        -e OLLAMA_URL="${OLLAMA_URL:-http://127.0.0.1:11434}" \
        -e OLLAMA_MODEL="${OLLAMA_MODEL:-qwen3.5:9b}" \
        -e OLLAMA_TIMEOUT="${OLLAMA_TIMEOUT:-120}" \
        "$VALIDATION_DOCKER_IMAGE" \
        bash -lc 'apt-get update && apt-get install -y --no-install-recommends shellcheck jq curl && npm ci --ignore-scripts && ./.github/skills/gnome-test-ollama-assessment/scripts/validate-and-assess.sh'
fi

cleanup() {
    rm -f "$REPORT"
}
trap cleanup EXIT

run_check() {
    local label=$1
    shift
    printf '\n[%s]\n' "$label" | tee -a "$REPORT"
    printf '$' | tee -a "$REPORT"
    printf ' %q' "$@" | tee -a "$REPORT"
    printf '\n' | tee -a "$REPORT"
    if "$@" >>"$REPORT" 2>&1; then
        printf 'status: PASS\n' | tee -a "$REPORT"
    else
        local exit_code=$?
        DETERMINISTIC_STATUS=1
        printf 'status: FAIL (%s)\n' "$exit_code" | tee -a "$REPORT"
    fi
}

# This project validates the pure modules under Node, while `extension.js` is
# only syntax-checked outside GNOME Shell because it depends on GJS and Shell
# runtime APIs. The Docker fallback keeps those Node-based checks available when
# Node is not installed on the host.

record_unavailable() {
    UNAVAILABLE_STATUS=1
    printf '\n[%s]\nstatus: UNAVAILABLE\n' "$1" | tee -a "$REPORT"
}

cd "$ROOT"
printf 'Repository: %s\n' "$ROOT" | tee "$REPORT"

if command -v node >/dev/null 2>&1; then
    run_check 'pure module tests' node --test \
        --experimental-test-coverage \
        --test-coverage-include='nvme-monitor@rloutrel.github.com/**/*.js' \
        --test-coverage-exclude='**/test/**' \
        --test-reporter=spec --test-reporter-destination=stdout \
        --test-reporter=lcov --test-reporter-destination=lcov.info \
        nvme-monitor@rloutrel.github.com/test/tempFormat.test.js \
        nvme-monitor@rloutrel.github.com/test/smartParser.test.js \
        nvme-monitor@rloutrel.github.com/test/versionUtils.test.js \
        nvme-monitor@rloutrel.github.com/test/deviceList.test.js \
        nvme-monitor@rloutrel.github.com/test/format.test.js \
        nvme-monitor@rloutrel.github.com/test/tempHistory.test.js
    run_check 'JavaScript syntax' bash -c \
        'find nvme-monitor@rloutrel.github.com -name "*.js" -not -path "*/test/*" -print0 | xargs -0 -r -n1 node --check'
    run_check 'metadata validation' node nvme-monitor@rloutrel.github.com/test/validateMetadata.js
else
    record_unavailable 'Node.js checks (node is not installed on host; use VALIDATION_RUNTIME=docker)'
fi

if [[ -x node_modules/.bin/eslint ]]; then
    run_check 'ESLint' node_modules/.bin/eslint \
        nvme-monitor@rloutrel.github.com/ --ext .js
else
    record_unavailable 'ESLint (run npm ci first)'
fi

if command -v shellcheck >/dev/null 2>&1; then
    run_check 'ShellCheck' shellcheck nvme-monitor@rloutrel.github.com/setup-polkit.sh
else
    record_unavailable 'ShellCheck (not installed)'
fi

printf '\n=== Deterministic validation report ===\n'
cat "$REPORT"

OLLAMA_URL=${OLLAMA_URL:-http://127.0.0.1:11434}
OLLAMA_MODEL=${OLLAMA_MODEL:-qwen3.5:9b}
OLLAMA_TIMEOUT=${OLLAMA_TIMEOUT:-120}

if command -v curl >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
    prompt=$(cat <<EOF
Assess this GNOME Shell extension validation report as a cautious local reviewer.
Separate PASS, FAIL, UNAVAILABLE, and skipped checks. Do not infer success from
missing output. Cite the exact check label and command for every conclusion.
Explain which failures are actionable and which require a real GNOME Shell 50/51
session, GJS runtime, Docker image, or installed tool. Do not rewrite the report.

$({ cat "$REPORT"; })
EOF
)
    payload=$(jq -n --arg model "$OLLAMA_MODEL" --arg prompt "$prompt" \
        '{model: $model, prompt: $prompt, stream: false}')
    if assessment=$(curl -fsS --connect-timeout 3 --max-time "$OLLAMA_TIMEOUT" \
        "$OLLAMA_URL/api/generate" -H 'Content-Type: application/json' \
        -d "$payload" 2>&1); then
        printf '\n=== Ollama assessment (%s) ===\n' "$OLLAMA_MODEL"
        jq -r '.response // "No response field returned."' <<<"$assessment"
    else
        printf '\nOllama assessment unavailable at %s: %s\n' "$OLLAMA_URL" "$assessment" >&2
    fi
else
    printf '\nOllama assessment skipped: curl and jq are required.\n' >&2
fi

if (( DETERMINISTIC_STATUS != 0 )); then
    exit 1
fi
if (( UNAVAILABLE_STATUS != 0 )); then
    exit 2
fi

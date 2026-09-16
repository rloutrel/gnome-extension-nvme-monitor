#!/usr/bin/env bash
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)
CACHE_DIR=${GNOME_KNOWLEDGE_CACHE_DIR:-"$ROOT/.cache/gnome-extension-knowledge"}
TODAY=$(date -u +%F)
MANIFEST="$CACHE_DIR/manifest-$TODAY.json"
INDEX="$CACHE_DIR/index.md"
USER_AGENT='gnome-extension-developer-knowledge-cache/1.0'

if [[ ${GNOME_KNOWLEDGE_FORCE:-0} != 1 && -f "$MANIFEST" ]]; then
    printf 'Knowledge cache is current for %s: %s\n' "$TODAY" "$CACHE_DIR"
    exit 0
fi

mkdir -p "$CACHE_DIR/sources"
TEMP_DIR=$(mktemp -d "$CACHE_DIR/.refresh.XXXXXX")
trap 'rm -rf "$TEMP_DIR"' EXIT

sources=(
    'gjs-guide|https://gjs.guide/'
    'gjs-api|https://gjs-docs.gnome.org/'
    'extension-creation|https://gjs.guide/extensions/development/creating.html'
    'st-api|https://gjs-docs.gnome.org/st14/st.widget'
    'clutter-api|https://gjs-docs.gnome.org/clutter14/'
    'gio-api|https://gjs-docs.gnome.org/gio20/'
    'glib-api|https://gjs-docs.gnome.org/glib20/'
    'gtk4-api|https://docs.gtk.org/gtk4/'
    'gtk4-migration|https://docs.gtk.org/gtk4/migrating-3to4.html'
    'gnome-developer|https://developer.gnome.org/'
    'gtk4-gjs-book|https://rmnvgr.gitlab.io/gtk4-gjs-book/introduction/resources/'
    'shell-50|https://gjs.guide/extensions/upgrading/gnome-shell-50.html'
    'shell-51|https://gjs.guide/extensions/upgrading/gnome-shell-51.html'
    'extension-practices|https://gjs.guide/extensions/review-guidelines/best-practices.html'
)

status=0
manifest_entries=()
index_sources=()

for source in "${sources[@]}"; do
    name=${source%%|*}
    url=${source#*|}
    output="$TEMP_DIR/$name.html"
    text_output="$TEMP_DIR/$name.txt"
    http_status=$(curl -LfsS --max-time "${GNOME_KNOWLEDGE_TIMEOUT:-30}" \
        -A "$USER_AGENT" -o "$output" -w '%{http_code}' "$url" 2>/dev/null || true)

    if [[ $http_status != 2* ]]; then
        status=1
        printf 'WARN %s (%s): unavailable\n' "$name" "$http_status" >&2
        manifest_entries+=("$name|$url|$http_status|unavailable")
        continue
    fi

    if command -v python3 >/dev/null 2>&1; then
        python3 - "$output" "$text_output" <<'PY'
from html.parser import HTMLParser
from pathlib import Path
import re
import sys

class TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []
        self.skip = 0
    def handle_starttag(self, tag, attrs):
        if tag in {'script', 'style', 'noscript', 'svg'}:
            self.skip += 1
        elif not self.skip and tag in {'p', 'div', 'li', 'h1', 'h2', 'h3', 'pre', 'br'}:
            self.parts.append('\n')
    def handle_endtag(self, tag):
        if tag in {'script', 'style', 'noscript', 'svg'} and self.skip:
            self.skip -= 1
    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)

source = Path(sys.argv[1]).read_text(errors='replace')
parser = TextExtractor()
parser.feed(source)
text = ''.join(parser.parts)
text = re.sub(r'[ \t]+', ' ', text)
text = re.sub(r'\n\s*\n+', '\n\n', text)
Path(sys.argv[2]).write_text(text.strip() + '\n')
PY
    else
        cp "$output" "$text_output"
    fi

    cp "$text_output" "$CACHE_DIR/sources/$name.txt"
    bytes=$(wc -c < "$CACHE_DIR/sources/$name.txt")
    manifest_entries+=("$name|$url|$http_status|$bytes")
    index_sources+=("$name|$url|$bytes")
done

{
    printf '{\n  "date": "%s",\n  "generated_at": "%s",\n  "sources": [\n' "$TODAY" "$(date -u +%FT%TZ)"
    first=1
    for entry in "${manifest_entries[@]}"; do
        IFS='|' read -r name url source_status detail <<< "$entry"
        [[ $first == 1 ]] || printf ',\n'
        first=0
        printf '    {"name": "%s", "url": "%s", "status": "%s", "detail": "%s"}' \
            "$name" "$url" "$source_status" "$detail"
    done
    printf '\n  ]\n}\n'
} > "$TEMP_DIR/manifest.json"
mv "$TEMP_DIR/manifest.json" "$MANIFEST"

{
    printf '# GNOME Extension Knowledge Cache\n\n'
    printf -- '- Generated: `%s`\n' "$(date -u +%FT%TZ)"
    printf -- '- Target: GNOME Shell 50, prepared for 51\n'
    printf -- '- Policy: refresh at most once per UTC calendar day; use `GNOME_KNOWLEDGE_FORCE=1` to override\n'
    printf -- '- Manifest: `manifest-%s.json`\n\n' "$TODAY"
    printf '## Working Constraints\n\n'
    printf '%s\n' '- GNOME Shell extensions run in GJS and normally use Shell `St`, `Clutter`, `Gio`, and `GLib` APIs.'
    printf '%s\n' '- GTK4 is the current application toolkit; GTK4 widgets and Shell extension actors are different process/API surfaces.'
    printf '%s\n' '- Keep `enable()` and synchronous `disable()` lifecycle cleanup explicit.'
    printf '%s\n' '- Keep pure Node-testable modules free of GJS/GObject imports.'
    printf '%s\n' '- Treat Shell-private APIs as version-sensitive and check Shell 50/51 migration guidance.'
    printf '%s\n\n' '- Deterministic tests remain authoritative; local Ollama may assess results but cannot turn failures into passes.'
    printf '## Source Snapshots\n\n'
    for entry in "${index_sources[@]}"; do
        IFS='|' read -r name url bytes <<< "$entry"
        printf -- '- [%s](sources/%s.txt) (%s bytes) - %s\n' "$name" "$name" "$bytes" "$url"
    done
    if (( status != 0 )); then
        printf '\n## Refresh Status\n\nPartial refresh: one or more sources were unavailable. Check the manifest before relying on this cache.\n'
    fi
} > "$TEMP_DIR/index.md"
mv "$TEMP_DIR/index.md" "$INDEX"

if (( status != 0 )); then
    printf 'Knowledge cache refreshed partially: %s\n' "$CACHE_DIR" >&2
    exit 1
fi
printf 'Knowledge cache refreshed: %s\n' "$CACHE_DIR"

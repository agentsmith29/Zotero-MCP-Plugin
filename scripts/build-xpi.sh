#!/usr/bin/env bash
# Builds dist/zotero-mcp.xpi from the plugin sources.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/dist"
XPI="$DIST/zotero-mcp.xpi"

mkdir -p "$DIST"
cd "$ROOT"
rm -f "$XPI"

zip -r -q "$XPI" \
	manifest.json \
	bootstrap.js \
	prefs.js \
	content \
	locale \
	-x "*.DS_Store"

printf '%s\n' "$XPI"

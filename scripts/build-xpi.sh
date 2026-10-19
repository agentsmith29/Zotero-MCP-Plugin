#!/usr/bin/env bash
# Builds dist/zotero-mcp.xpi from the plugin sources.
#
#   VERSION=0.1.42      package this version instead of the one in manifest.json
#   RELEASE_URL=https://github.com/<owner>/<repo>/releases/download/v0.1.42
#                       also write dist/updates.json pointing Zotero to $RELEASE_URL/zotero-mcp.xpi
#   UPDATE_URL=...      override the manifest's update_url (for testing the update flow)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/dist"
XPI="$DIST/zotero-mcp.xpi"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$DIST"
rm -f "$XPI" "$DIST/updates.json"

cd "$ROOT"
cp -R manifest.json bootstrap.js prefs.js content locale "$STAGE/"
find "$STAGE" -name .DS_Store -delete

python3 - "$STAGE/manifest.json" <<'EOF'
import json, os, sys
path = sys.argv[1]
manifest = json.load(open(path))
if os.environ.get("VERSION"):
    manifest["version"] = os.environ["VERSION"]
if os.environ.get("UPDATE_URL"):
    manifest["applications"]["zotero"]["update_url"] = os.environ["UPDATE_URL"]
json.dump(manifest, open(path, "w"), indent=2)
print(manifest["version"])
EOF

(cd "$STAGE" && zip -r -q "$XPI" manifest.json bootstrap.js prefs.js content locale)

if [[ -n "${RELEASE_URL:-}" ]]; then
	python3 - "$STAGE/manifest.json" "$XPI" "$DIST/updates.json" <<'EOF'
import hashlib, json, os, sys
manifest_path, xpi, out = sys.argv[1:4]
manifest = json.load(open(manifest_path))
app = manifest["applications"]["zotero"]
compat = {k: app[k] for k in ("strict_min_version", "strict_max_version") if k in app}
sha = hashlib.sha256(open(xpi, "rb").read()).hexdigest()
updates = {"addons": {app["id"]: {"updates": [{
    "version": manifest["version"],
    "update_link": os.environ["RELEASE_URL"].rstrip("/") + "/zotero-mcp.xpi",
    "update_hash": "sha256:" + sha,
    "applications": {"zotero": compat},
}]}}}
json.dump(updates, open(out, "w"), indent=2)
EOF
fi

printf '%s\n' "$XPI"

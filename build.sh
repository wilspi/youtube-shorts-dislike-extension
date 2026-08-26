#!/usr/bin/env bash
#
# Packages the extension for each store.
#
#   dist/chrome/  + dist/shorts-dislike-chrome.zip   -> Chrome, Edge, Brave, Opera, Vivaldi
#   dist/firefox/ + dist/shorts-dislike-firefox.zip  -> Firefox (adds browser_specific_settings)
#
# Usage: ./build.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
DIST="$ROOT/dist"
SOURCES=(manifest.json src icons LICENSE NOTICE)

rm -rf "$DIST"
mkdir -p "$DIST/chrome" "$DIST/firefox"

for target in chrome firefox; do
  for item in "${SOURCES[@]}"; do
    cp -R "$ROOT/$item" "$DIST/$target/"
  done
done

# Firefox needs an explicit add-on id to be signed and distributed on AMO.
# Chrome warns about unknown manifest keys, so it only goes in the Firefox build.
python3 - "$DIST/firefox/manifest.json" <<'PY'
import json, sys

path = sys.argv[1]
with open(path) as fh:
    manifest = json.load(fh)

manifest["browser_specific_settings"] = {
    "gecko": {
        "id": "shorts-dislike@wilspi.github.io",
        # Firefox 140+ provides the built-in data-transmission consent prompt.
        "strict_min_version": "140.0",
        "data_collection_permissions": {
            "required": [
                "authenticationInfo",
                "browsingActivity",
                "websiteContent",
                "websiteActivity",
            ]
        },
    },
    # Firefox for Android added built-in data consent in version 142.
    "gecko_android": {
        "strict_min_version": "142.0",
    },
}

with open(path, "w") as fh:
    json.dump(manifest, fh, indent=2)
    fh.write("\n")
PY

for target in chrome firefox; do
  (cd "$DIST/$target" && zip -qr "../shorts-dislike-$target.zip" .)
done

echo "Built:"
echo "  $DIST/shorts-dislike-chrome.zip"
echo "  $DIST/shorts-dislike-firefox.zip"

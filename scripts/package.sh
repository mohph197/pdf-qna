#!/usr/bin/env bash
# Builds the Chrome Web Store upload: dist/paper-qa-<version>.zip containing
# only the files the extension loads at runtime.
#   ./scripts/package.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="$(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])')"
OUT="dist/paper-qa-${VERSION}.zip"
FILES=(manifest.json LICENSE THIRD_PARTY_NOTICES.md background shared lib src options icons vendor)

mkdir -p dist
rm -f "$OUT"
zip -qrX "$OUT" "${FILES[@]}" -x '*.DS_Store' 'icons/*.svg'
echo "$OUT ($(du -h "$OUT" | cut -f1))"

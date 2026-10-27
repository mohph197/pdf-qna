#!/usr/bin/env bash
# Re-creates vendor/ from pinned upstream releases and patches the pdf.js
# viewer so it loads the Q&A sidebar. The extension ships with vendor/
# already populated, so you only need this to upgrade or verify the libraries.
#
#   ./scripts/vendor.sh
set -euo pipefail

PDFJS_VERSION="6.4.299"
PDFLIB_VERSION="1.17.1"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading pdf.js ${PDFJS_VERSION}…"
curl -fsSL -o "$TMP/pdfjs.zip" \
  "https://github.com/mozilla/pdf.js/releases/download/v${PDFJS_VERSION}/pdfjs-${PDFJS_VERSION}-dist.zip"
mkdir -p "$TMP/pdfjs"
unzip -q "$TMP/pdfjs.zip" -d "$TMP/pdfjs"

echo "Downloading pdf-lib ${PDFLIB_VERSION}…"
curl -fsSL -o "$TMP/pdflib.tgz" "https://registry.npmjs.org/pdf-lib/-/pdf-lib-${PDFLIB_VERSION}.tgz"
mkdir -p "$TMP/pdflib"
tar xzf "$TMP/pdflib.tgz" -C "$TMP/pdflib"

rm -rf "$ROOT/vendor"
mkdir -p "$ROOT/vendor/pdfjs" "$ROOT/vendor/pdf-lib"
cp -R "$TMP/pdfjs/build" "$TMP/pdfjs/web" "$TMP/pdfjs/LICENSE" "$ROOT/vendor/pdfjs/"
cp "$TMP/pdflib/package/dist/pdf-lib.min.js" "$TMP/pdflib/package/LICENSE.md" "$ROOT/vendor/pdf-lib/"

# Trim files the extension never loads (source maps, demo PDF, debugger, and
# the sandbox that runs PDF-embedded JavaScript, which boot.mjs disables).
find "$ROOT/vendor/pdfjs" -name '*.map' -delete
rm -f "$ROOT/vendor/pdfjs/web/compressed.tracemonkey-pldi-09.pdf" \
      "$ROOT/vendor/pdfjs/build/pdf.sandbox.mjs" \
      "$ROOT/vendor/pdfjs/web/wasm/quickjs-eval.js" "$ROOT/vendor/pdfjs/web/wasm/quickjs-eval.wasm" \
      "$ROOT/vendor/pdfjs/web/debugger.mjs" "$ROOT/vendor/pdfjs/web/debugger.css"

# Patch viewer.html: our bootstrap must run before viewer.mjs (to catch the
# "webviewerloaded" event), and the sidebar loads after it.
VIEWER="$ROOT/vendor/pdfjs/web/viewer.html"
python3 - "$VIEWER" <<'PY'
import sys
path = sys.argv[1]
html = open(path, encoding="utf-8").read()
boot = '<script src="../../../src/viewer/boot.mjs" type="module"></script>\n'
tail = ('<link rel="stylesheet" href="../../../src/viewer/qa.css" />\n'
        '<script src="../../../vendor/pdf-lib/pdf-lib.min.js"></script>\n'
        '<script src="../../../src/viewer/qa.mjs" type="module"></script>\n')
anchor = '<script src="viewer.mjs" type="module"></script>'
assert anchor in html, "viewer.html layout changed; update scripts/vendor.sh"
html = html.replace(anchor, boot + anchor + "\n" + tail, 1)
# The viewer's CSP allows "connect-src *", which doesn't cover file: URLs.
csp = "connect-src * blob: data:"
assert csp in html, "viewer.html CSP changed; update scripts/vendor.sh"
html = html.replace(csp, csp + " file:", 1)
open(path, "w", encoding="utf-8").write(html)
PY

echo "Done. vendor/ now holds pdf.js ${PDFJS_VERSION} and pdf-lib ${PDFLIB_VERSION}."

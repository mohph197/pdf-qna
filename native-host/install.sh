#!/usr/bin/env bash
# Installs the helper that lets Paper Q&A use Claude Code on this computer
# (macOS and Linux). Copy the command from the extension's options page, which
# fills in the extension ID:
#   ./native-host/install.sh <extension-id>
#   ./native-host/install.sh --uninstall
# Needs Node.js 20+ and Claude Code (https://claude.com/claude-code), logged in.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
NAME="com.paperqa.claude_code"
TARGET="$HOME/.paper-qa"

case "$(uname -s)" in
  Darwin)
    BASE="$HOME/Library/Application Support"
    BROWSERS=("Google/Chrome" "Google/Chrome Beta" "Google/Chrome Canary" "Chromium" "BraveSoftware/Brave-Browser" "Microsoft Edge")
    ;;
  Linux)
    BASE="${XDG_CONFIG_HOME:-$HOME/.config}"
    BROWSERS=("google-chrome" "google-chrome-beta" "chromium" "BraveSoftware/Brave-Browser" "microsoft-edge")
    ;;
  *)
    echo "Only macOS and Linux are supported." >&2
    exit 1
    ;;
esac

if [[ "${1:-}" == "--uninstall" ]]; then
  for b in "${BROWSERS[@]}"; do rm -f "$BASE/$b/NativeMessagingHosts/$NAME.json"; done
  rm -rf "$TARGET"
  echo "Removed the Claude Code helper."
  exit 0
fi

ID="${1:-}"
if [[ ! "$ID" =~ ^[a-p]{32}$ ]]; then
  echo "Usage: $0 <extension-id>   (copy the command from Paper Q&A's options page)" >&2
  exit 1
fi

NODE="$(command -v node || true)"
if [[ -z "$NODE" ]] || ! "$NODE" -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)'; then
  echo "Node.js 20 or later is needed: https://nodejs.org" >&2
  exit 1
fi
CLAUDE="$(command -v claude || true)"
if [[ -z "$CLAUDE" ]]; then
  echo "Warning: Claude Code (claude) isn't on your PATH. Install it from https://claude.com/claude-code." >&2
fi

# Chrome starts the host with a minimal environment, so the wrapper records
# where node and claude are.
sq() { local q="'\\''"; printf "'%s'" "${1//\'/$q}"; } # single-quoted for sh
mkdir -p "$TARGET"
cp "$HERE/paper-qa-host.mjs" "$TARGET/paper-qa-host.mjs"
{
  echo '#!/bin/sh'
  echo "export PATH=$(sq "$PATH")"
  if [[ -n "$CLAUDE" ]]; then echo "export CLAUDE_PATH=$(sq "$CLAUDE")"; fi
  echo "exec $(sq "$NODE") $(sq "$TARGET/paper-qa-host.mjs") \"\$@\""
} >"$TARGET/claude-code-host"
chmod +x "$TARGET/claude-code-host"

MANIFEST="$(cat <<EOF
{
  "name": "$NAME",
  "description": "Paper Q&A: runs Claude Code on this computer",
  "path": "$TARGET/claude-code-host",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$ID/"]
}
EOF
)"
installed=()
for b in "${BROWSERS[@]}"; do
  # Always install for Chrome; for other browsers only if they're installed.
  [[ "$b" == "${BROWSERS[0]}" || -d "$BASE/$b" ]] || continue
  mkdir -p "$BASE/$b/NativeMessagingHosts"
  echo "$MANIFEST" >"$BASE/$b/NativeMessagingHosts/$NAME.json"
  installed+=("$b")
done

echo "Installed the Claude Code helper for: ${installed[*]}"
echo "Claude Code: ${CLAUDE:-not found}"
echo "Now click \"Check Claude Code\" on Paper Q&A's options page."

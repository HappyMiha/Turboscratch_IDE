#!/bin/bash
# Double-click this file (or run it in Terminal) to start TurboScratch IDE:
#   - the collaboration server on port 8090
#   - the editor on http://localhost:8601
# Press Ctrl+C in this window to stop both.

cd "$(dirname "$0")" || exit 1
export PATH="$HOME/.local/node/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
    echo "Node.js was not found. Install Node.js 22 from https://nodejs.org and try again."
    read -r -p "Press Enter to close..."
    exit 1
fi

if [ ! -d editor/node_modules ]; then
    echo "Installing editor packages (first run only, this takes a few minutes)..."
    (cd editor && npm ci --no-audit --no-fund) || exit 1
fi
if [ ! -d collab-server/node_modules ]; then
    echo "Installing collaboration server packages..."
    (cd collab-server && npm install --no-audit --no-fund) || exit 1
fi

cleanup() {
    echo
    echo "Stopping TurboScratch IDE..."
    kill "$SERVER_PID" "$EDITOR_PID" 2>/dev/null
    wait 2>/dev/null
}
trap cleanup EXIT INT TERM

(cd collab-server && npm start) &
SERVER_PID=$!

(cd editor && npm start) &
EDITOR_PID=$!

LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
echo
echo "================================================================"
echo " TurboScratch IDE is starting (the first build takes 1-3 minutes)"
echo
echo "   Open on this computer:   http://localhost:8601/editor.html"
if [ -n "$LAN_IP" ]; then
echo "   Friends on your Wi-Fi:   http://$LAN_IP:8601/editor.html"
fi
echo
echo " Click 'Collaborate' in the menu bar to start or join a room."
echo " Press Ctrl+C here to stop."
echo "================================================================"
echo

wait

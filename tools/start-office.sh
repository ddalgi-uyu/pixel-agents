#!/usr/bin/env bash
# Start (or first-time set up) the shared Pixel Agents office on this machine.
# Builds if needed, enables Watch All Sessions, launches the LAN server, and
# prints the URL + token to share with friends. Safe to re-run.
#
#   bash tools/start-office.sh          # start on port 3100
#   PORT=3200 bash tools/start-office.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
PORT="${PORT:-3100}"

# --- LAN IP (for the shareable URL + --allowed-host) ---
IP="$(ip route get 1.1.1.1 2>/dev/null | grep -oE 'src [0-9.]+' | awk '{print $2}')"
[ -z "${IP:-}" ] && IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -z "${IP:-}" ] && IP="127.0.0.1"

# --- Build on first run (or after a clean clone) ---
if [ ! -f dist/cli.js ] || [ ! -f dist/webview/index.html ]; then
  echo "[start-office] Building (first run, may take a few minutes)…"
  [ -d node_modules ] || npm install
  npm run asyncapi:generate && node esbuild.js && npm run build:webview || {
    echo "[start-office] Build failed — see output above."; exit 1; }
fi

# --- Ensure Watch All Sessions is on (so friends' agents are allowed in) ---
mkdir -p "$HOME/.pixel-agents"
CFG="$HOME/.pixel-agents/config.json"
[ -f "$CFG" ] || echo '{}' > "$CFG"
python3 - "$CFG" <<'PY' 2>/dev/null || true
import json, sys
p = sys.argv[1]
try:
    d = json.load(open(p))
    if not isinstance(d, dict): d = {}
except Exception:
    d = {}
for ns in ("standalone", "vscode"):
    d.setdefault(ns, {})["watchAllSessions"] = True
json.dump(d, open(p, "w"), indent=2)
PY

# --- Restart cleanly ---
pkill -f "dist/cli.js" 2>/dev/null || true
sleep 1
nohup node dist/cli.js --host 0.0.0.0 --port "$PORT" --allowed-host "$IP" > "$ROOT/office.log" 2>&1 &
sleep 4

if ! curl -s -o /dev/null --max-time 5 "http://127.0.0.1:$PORT/api/health"; then
  echo "[start-office] Server didn't come up — check $ROOT/office.log"; exit 1
fi
TOKEN="$(cat "$HOME/.pixel-agents/standalone-token" 2>/dev/null)"

cat <<EOF

✅ Pixel office is running.

   Open it:   http://$IP:$PORT/?token=$TOKEN

   Give friends these two lines (privately — the token grants full control):
     PIXEL_AGENTS_OFFICE=http://$IP:$PORT
     PIXEL_AGENTS_OFFICE_TOKEN=$TOKEN

   Show your own screen (optional):
     PIXEL_AGENTS_OFFICE=http://127.0.0.1:$PORT PIXEL_AGENTS_OFFICE_TOKEN=$TOKEN \\
       python3 tools/pixel_screen_capture.py
EOF

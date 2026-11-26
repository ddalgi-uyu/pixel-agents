#!/usr/bin/env python3
"""Pixel Agents — make your character say something.

POSTs a custom speech line to the office; your character shows it in a bubble
for a few seconds. Run with no text (or "") to clear.

Config (env):
  PIXEL_AGENTS_OFFICE        office URL, e.g. http://192.168.31.191:3100  (required)
  PIXEL_AGENTS_OFFICE_TOKEN  that server's token                         (required)
  PIXEL_AGENTS_SESSION       Claude session id (default: newest ~/.claude/projects/**/<id>.jsonl)

Usage:
  python3 tools/say.py "shipping the demo, back in 20!"
"""

import glob
import json
import os
import sys
import urllib.request

OFFICE = os.environ.get("PIXEL_AGENTS_OFFICE", "").rstrip("/")
TOKEN = os.environ.get("PIXEL_AGENTS_OFFICE_TOKEN", "")


def discover_session():
    s = os.environ.get("PIXEL_AGENTS_SESSION", "")
    if s:
        return s
    files = glob.glob(os.path.join(os.path.expanduser("~"), ".claude", "projects", "**", "*.jsonl"),
                      recursive=True)
    if not files:
        return None
    return os.path.splitext(os.path.basename(max(files, key=os.path.getmtime)))[0]


def main():
    if not OFFICE or not TOKEN:
        print("❌ set PIXEL_AGENTS_OFFICE and PIXEL_AGENTS_OFFICE_TOKEN")
        sys.exit(1)
    session = discover_session()
    if not session:
        print("❌ no Claude session found; set PIXEL_AGENTS_SESSION")
        sys.exit(1)
    text = sys.argv[1] if len(sys.argv) > 1 else ""
    body = json.dumps({"sessionId": session, "text": text}).encode()
    req = urllib.request.Request(
        f"{OFFICE}/api/say", data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {TOKEN}"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            ok = r.status == 200
    except Exception as e:
        print(f"⚠️  {e}")
        sys.exit(1)
    print(f'💬 said: "{text}"' if text and ok else ("💬 cleared" if ok else "⚠️  failed"))


if __name__ == "__main__":
    main()

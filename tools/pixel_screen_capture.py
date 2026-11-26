#!/usr/bin/env python3
"""Pixel Agents — live screen capture client.

Grabs a small thumbnail of your CURRENTLY FOCUSED window and POSTs it to a Pixel
Agents office's /api/screen endpoint every ~1.5s, so your character shows a live
"monitor" of what you're working on. Only the focused window is sent.

Pairs with the office's Feature B rendering. Cross-platform:
  - Linux / X11 : xprop + xwininfo (window), ffmpeg x11grab (capture)
  - Windows     : ctypes/user32 (window), Pillow ImageGrab (capture)  [pip install pillow]
  - macOS       : osascript (app), Pillow ImageGrab (full screen)      [pip install pillow]

Config (env):
  PIXEL_AGENTS_OFFICE        office URL, e.g. http://192.168.31.191:3100   (required)
  PIXEL_AGENTS_OFFICE_TOKEN  that server's token                          (required)
  PIXEL_AGENTS_SESSION       Claude session id to attach to (default: newest
                             ~/.claude/projects/**/<id>.jsonl — your active session)
  SCREEN_INTERVAL            seconds between frames (default 1.5)
  SCREEN_WIDTH               thumbnail width px (default 320)

Usage:
  PIXEL_AGENTS_OFFICE=http://192.168.31.191:3100 PIXEL_AGENTS_OFFICE_TOKEN=... \\
    python3 tools/pixel_screen_capture.py
"""

import base64
import glob
import io
import os
import platform
import re
import subprocess
import sys
import time
import urllib.request

OFFICE = os.environ.get("PIXEL_AGENTS_OFFICE", "").rstrip("/")
TOKEN = os.environ.get("PIXEL_AGENTS_OFFICE_TOKEN", "")
SESSION_ENV = os.environ.get("PIXEL_AGENTS_SESSION", "")
INTERVAL = float(os.environ.get("SCREEN_INTERVAL", "1.5"))
OUT_WIDTH = int(os.environ.get("SCREEN_WIDTH", "320"))
QUALITY = int(os.environ.get("SCREEN_QUALITY", "70"))

SYSTEM = platform.system()
IS_WINDOWS = SYSTEM == "Windows"
IS_MAC = SYSTEM == "Darwin"
IS_LINUX = SYSTEM == "Linux"
DISPLAY = os.environ.get("DISPLAY", ":0")

if IS_WINDOWS:
    try:
        import ctypes
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:
            ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass


def _sh(cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return ""


# ---------- session id discovery ----------

def discover_session():
    if SESSION_ENV:
        return SESSION_ENV
    root = os.path.join(os.path.expanduser("~"), ".claude", "projects")
    files = glob.glob(os.path.join(root, "**", "*.jsonl"), recursive=True)
    if not files:
        return None
    newest = max(files, key=lambda f: os.path.getmtime(f))
    return os.path.splitext(os.path.basename(newest))[0]


# ---------- active window geometry ----------

def screen_size():
    if IS_WINDOWS:
        try:
            u = ctypes.windll.user32
            return int(u.GetSystemMetrics(78) or u.GetSystemMetrics(0)), int(
                u.GetSystemMetrics(79) or u.GetSystemMetrics(1))
        except Exception:
            return (1920, 1080)
    if IS_LINUX:
        info = _sh(["xwininfo", "-root"])
        w, h = re.search(r"Width:\s*(\d+)", info), re.search(r"Height:\s*(\d+)", info)
        return (int(w.group(1)), int(h.group(1))) if (w and h) else (1920, 1080)
    try:
        from PIL import ImageGrab
        return ImageGrab.grab().size
    except Exception:
        return (1920, 1080)


def active_geom():
    try:
        if IS_WINDOWS:
            u = ctypes.windll.user32
            from ctypes import wintypes
            u.GetForegroundWindow.restype = wintypes.HWND
            u.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
            hwnd = u.GetForegroundWindow()
            if not hwnd:
                return None
            r = wintypes.RECT()
            u.GetWindowRect(hwnd, ctypes.byref(r))
            w, h = r.right - r.left, r.bottom - r.top
            return (r.left, r.top, w, h) if w > 0 and h > 0 else None
        if IS_MAC:
            w, h = screen_size()
            return (0, 0, w, h)
        # Linux / X11
        m = re.search(r"0x[0-9a-fA-F]+", _sh(["xprop", "-root", "_NET_ACTIVE_WINDOW"]))
        if not m or m.group(0) == "0x0":
            return None
        info = _sh(["xwininfo", "-id", m.group(0)])

        def g(pat):
            mm = re.search(pat, info)
            return int(mm.group(1)) if mm else None

        x, y = g(r"Absolute upper-left X:\s*(-?\d+)"), g(r"Absolute upper-left Y:\s*(-?\d+)")
        w, h = g(r"Width:\s*(\d+)"), g(r"Height:\s*(\d+)")
        if None in (x, y, w, h):
            return None
        rw, rh = screen_size()
        x = max(0, min(x, rw - 2)); y = max(0, min(y, rh - 2))
        w = max(2, min(w, rw - x)); h = max(2, min(h, rh - y))
        return (x, y, w - w % 2, h - h % 2)
    except Exception:
        return None


# ---------- capture ----------

def grab_jpeg(geom):
    if not geom:
        return None
    if IS_LINUX:
        x, y, w, h = geom
        import tempfile
        out = os.path.join(tempfile.gettempdir(), "pixel-agents-screen.jpg")
        qv = max(2, min(31, int(31 - (QUALITY / 100.0) * 29)))
        cmd = ["ffmpeg", "-loglevel", "error", "-f", "x11grab", "-video_size", f"{w}x{h}",
               "-i", f"{DISPLAY}+{x},{y}", "-frames:v", "1", "-vf", f"scale={OUT_WIDTH}:-2",
               "-q:v", str(qv), "-y", out]
        try:
            subprocess.run(cmd, capture_output=True, timeout=8)
            if os.path.exists(out) and os.path.getsize(out) > 0:
                with open(out, "rb") as f:
                    return f.read()
        except Exception:
            pass
        return None
    # Windows / macOS
    try:
        from PIL import ImageGrab
        x, y, w, h = geom
        kwargs = {"bbox": (x, y, x + w, y + h)}
        if IS_WINDOWS:
            kwargs["all_screens"] = True
        img = ImageGrab.grab(**kwargs)
        if OUT_WIDTH and img.width > OUT_WIDTH:
            img = img.resize((OUT_WIDTH, max(1, int(img.height * OUT_WIDTH / img.width))))
        buf = io.BytesIO()
        img.convert("RGB").save(buf, format="JPEG", quality=QUALITY)
        return buf.getvalue()
    except Exception:
        return None


def push(session, jpg):
    data_url = "data:image/jpeg;base64," + base64.b64encode(jpg).decode("ascii")
    body = ('{"sessionId":%s,"image":%s}' % (_json_str(session), _json_str(data_url))).encode()
    req = urllib.request.Request(
        f"{OFFICE}/api/screen", data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {TOKEN}"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.status


def _json_str(s):
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def main():
    if not OFFICE or not TOKEN:
        print("❌ set PIXEL_AGENTS_OFFICE and PIXEL_AGENTS_OFFICE_TOKEN")
        sys.exit(1)
    session = discover_session()
    if not session:
        print("❌ no Claude session found (no ~/.claude/projects/**/*.jsonl); "
              "set PIXEL_AGENTS_SESSION")
        sys.exit(1)
    print(f"Screen capture → {OFFICE}/api/screen  session={session[:8]}…  "
          f"every {INTERVAL}s, width={OUT_WIDTH}px. Ctrl+C to stop.")
    last_session_check = 0.0
    try:
        while True:
            # Re-discover the newest session periodically (user may switch sessions)
            now = time.time()
            if not SESSION_ENV and now - last_session_check > 10:
                session = discover_session() or session
                last_session_check = now
            jpg = grab_jpeg(active_geom())
            if jpg:
                try:
                    code = push(session, jpg)
                    if code != 200:
                        print(f"⚠️  POST {code}")
                except Exception as e:
                    print(f"⚠️  {e}")
            time.sleep(INTERVAL)
    except KeyboardInterrupt:
        print("\n👋 stopped")
        sys.exit(0)


if __name__ == "__main__":
    main()

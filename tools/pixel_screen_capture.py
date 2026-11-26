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
  PIXEL_AGENTS_CAPTURE_MATCH pin capture to a window whose title/class contains
                             this (e.g. "claude" or your terminal) instead of the
                             focused window — shows the agent while you look
                             elsewhere (Linux/X11; window must be visible)
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
# Pin capture to a specific window (e.g. your agent's terminal) by a substring of
# its title/class, instead of whatever window is focused. Great for showing "what
# the agent is doing" while you watch the office in another window.
# (Linux/X11; the window must be visible — a fully-covered window can't be grabbed.)
CAPTURE_MATCH = os.environ.get("PIXEL_AGENTS_CAPTURE_MATCH", "")
# Comma-separated app patterns the agent drives, e.g. "isaac,blender,unreal,code".
# The monitor follows whichever is open/active and labels it accordingly.
CAPTURE_PATTERNS = [p.strip().lower() for p in CAPTURE_MATCH.split(",") if p.strip()]
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


# ---------- active app name ----------

_APP_EMOJI = [
    (("isaac", "omniverse", "kit"), "🤖"), (("blender",), "🎨"), (("unreal",), "🎮"),
    (("code", "cursor", "vscode", "codium", "pycharm", "idea"), "💻"),
    (("firefox", "chrome", "chromium", "brave", "edge"), "🔎"),
    (("terminal", "konsole", "kitty", "alacritty", "wezterm"), "⌨️"),
    (("obsidian", "typora"), "📝"), (("slack", "discord", "zoom", "teams"), "💬"),
]


def active_app():
    """Short label for the focused app, e.g. '💻 code' or '🤖 isaac'. Best-effort."""
    try:
        if IS_WINDOWS:
            u = ctypes.windll.user32
            k = ctypes.windll.kernel32
            from ctypes import wintypes
            u.GetForegroundWindow.restype = wintypes.HWND
            u.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
            hwnd = u.GetForegroundWindow()
            pid = wintypes.DWORD()
            u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            k.OpenProcess.restype = wintypes.HANDLE
            h = k.OpenProcess(0x1000, False, pid.value)
            if not h:
                return ""
            buf = ctypes.create_unicode_buffer(32768)
            size = wintypes.DWORD(32768)
            name = ""
            if k.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
                name = re.sub(r"\.exe$", "", os.path.basename(buf.value), flags=re.I)
            k.CloseHandle(h)
            raw = name.lower()
        elif IS_MAC:
            raw = _sh(["osascript", "-e",
                       'tell application "System Events" to get name of first '
                       'application process whose frontmost is true']).strip().lower()
            name = raw
        else:
            m = re.search(r"0x[0-9a-fA-F]+", _sh(["xprop", "-root", "_NET_ACTIVE_WINDOW"]))
            if not m:
                return ""
            classes = re.findall(r'"([^"]*)"', _sh(["xprop", "-id", m.group(0), "WM_CLASS"]))
            raw = " ".join(classes).lower()
            name = re.split(r"[\s._-]+", classes[-1])[-1] if classes else ""
        if not raw:
            return ""
        for keys, emoji in _APP_EMOJI:
            if any(k in raw for k in keys):
                return f"{emoji} {name or keys[0]}"
        return f"🖥 {name}" if name else ""
    except Exception:
        return ""


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


# ---------- find a specific window (agent's terminal) ----------

def _label_for(cls, title):
    raw = (cls + " " + title).lower()
    for keys, emoji in _APP_EMOJI:
        hit = next((k for k in keys if k in raw), None)
        if hit:
            return f"{emoji} {hit}"
    toks = [t for t in re.split(r"[\s._-]+", cls) if t]
    return f"🖥 {toks[-1]}" if toks else ""


def _list_windows():
    """Visible top-level windows as (wid, title, wm_class, (x,y,w,h)). Linux/X11."""
    out = []
    if not IS_LINUX:
        return out
    rw, rh = screen_size()
    for wid in re.findall(r"0x[0-9a-fA-F]+", _sh(["xprop", "-root", "_NET_CLIENT_LIST"])):
        info = _sh(["xwininfo", "-id", wid])
        if "Map State: IsViewable" not in info:
            continue  # minimized / covered-unmapped — can't grab it

        def g(p):
            m = re.search(p, info)
            return int(m.group(1)) if m else None

        x, y = g(r"Absolute upper-left X:\s*(-?\d+)"), g(r"Absolute upper-left Y:\s*(-?\d+)")
        w, h = g(r"Width:\s*(\d+)"), g(r"Height:\s*(\d+)")
        if None in (x, y, w, h) or w < 50 or h < 50:
            continue
        nm = re.search(r'"(.*)"', _sh(["xprop", "-id", wid, "_NET_WM_NAME"]))
        title = nm.group(1) if nm else ""
        cls = " ".join(re.findall(r'"([^"]*)"', _sh(["xprop", "-id", wid, "WM_CLASS"])))
        x = max(0, min(x, rw - 2)); y = max(0, min(y, rh - 2))
        w = max(2, min(w, rw - x)); h = max(2, min(h, rh - y))
        out.append((wid, title, cls, (x, y, w - w % 2, h - h % 2)))
    return out


def pick_app_window(patterns):
    """Among the agent's apps (patterns), pick the window to show: the active one
    if it's one of them, else the first open one in list order. Follows whichever
    app the agent is driving (Isaac → Blender → …) and ignores the office/browser.
    Returns (geom, label) or None. Linux/X11; the window must be visible."""
    wins = _list_windows()
    if not wins:
        return None
    am = re.search(r"0x[0-9a-fA-F]+", _sh(["xprop", "-root", "_NET_ACTIVE_WINDOW"]))
    active = am.group(0) if am else None
    # Prefer the currently focused window if it's one of the agent's apps.
    for wid, title, cls, geom in wins:
        if wid == active and any(p in (title + " " + cls).lower() for p in patterns):
            return geom, _label_for(cls, title)
    # Otherwise the first open app in the user's priority order.
    for p in patterns:
        for wid, title, cls, geom in wins:
            if p in (title + " " + cls).lower():
                return geom, _label_for(cls, title)
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


def push(session, jpg, app):
    data_url = "data:image/jpeg;base64," + base64.b64encode(jpg).decode("ascii")
    body = ('{"sessionId":%s,"image":%s,"app":%s}' % (
        _json_str(session), _json_str(data_url), _json_str(app))).encode()
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
    pin = f"following apps [{', '.join(CAPTURE_PATTERNS)}]" if CAPTURE_PATTERNS else "focused window"
    print(f"Screen capture → {OFFICE}/api/screen  session={session[:8]}…  "
          f"({pin}, every {INTERVAL}s, width={OUT_WIDTH}px). Ctrl+C to stop.")
    last_session_check = 0.0
    try:
        while True:
            # Re-discover the newest session periodically (user may switch sessions)
            now = time.time()
            if not SESSION_ENV and now - last_session_check > 10:
                session = discover_session() or session
                last_session_check = now
            picked = pick_app_window(CAPTURE_PATTERNS) if CAPTURE_PATTERNS else None
            if picked:
                geom, label = picked          # the agent's app (Isaac/Blender/…)
            else:
                geom, label = active_geom(), active_app()  # fall back to focused window
            jpg = grab_jpeg(geom)
            if jpg:
                try:
                    code = push(session, jpg, label)
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

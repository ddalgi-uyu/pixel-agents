---
name: start-office
description: Start (or first-time set up) the shared Pixel Agents LAN office on this machine. Builds the project if needed, enables Watch All Sessions, launches the server on the local network, and prints the URL + token to share with friends. Use when the user wants to start their pixel office / host the shared office, especially after moving to a new computer.
---

# Start the Pixel Agents office

This hosts the shared "friends join over LAN" office (see the README's
"Share an office with your friends" section).

## Do this

Run the bootstrap script from the repo root:

```bash
bash tools/start-office.sh
```

It will, idempotently:
- build the project on first run (`npm install` + compile — can take a few minutes),
- enable **Watch All Sessions** (so friends' agents are allowed in),
- (re)start the server bound to the LAN with `--allowed-host <lan-ip>`,
- print the **office URL** (`http://<lan-ip>:3100/?token=…`) and the two
  `PIXEL_AGENTS_OFFICE` / `PIXEL_AGENTS_OFFICE_TOKEN` lines for friends.

## Then

1. Give the user the printed **office URL** to open in a browser.
2. Tell them to share the two `PIXEL_AGENTS_OFFICE*` lines with friends **privately**
   (the token grants full control of this machine).
3. Offer to also start their own screen on their character:
   ```bash
   PIXEL_AGENTS_OFFICE=http://127.0.0.1:3100 PIXEL_AGENTS_OFFICE_TOKEN=<token> \
     python3 tools/pixel_screen_capture.py
   ```

## Notes

- Requires **Node 20+**. The capture tool needs **Python 3** (+ `ffmpeg` on Linux,
  `pip install pillow` on Windows/macOS).
- Change the port with `PORT=3200 bash tools/start-office.sh`.
- If friends don't appear, confirm Watch All Sessions is on (Settings in the office)
  and that they're on the same network and used the correct URL + token.
- Logs: `office.log` in the repo root.

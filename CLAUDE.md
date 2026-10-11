# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Windows-only local web console that runs and controls several Aetheria Online game windows (https://www.aetheria-online.in.th/play, a React + Phaser web MMORPG) at once. Each game window is its own Electron process with its own `--user-data-dir`, so each keeps its own login. README and UI strings are in Thai; keep user-facing text in Thai.

It is a port of the sibling project **Lumivara Multi-Launcher** (`E:\Lumivara`, github.com/gxx898c/lumivara-multi-launcher). The architecture, routes and console page are the same; that project's CLAUDE.md is the detailed reference. This file lists what differs. The Lumivara-only automation (AFK button/OCR, auto-AFK, bot status, `/capture`) was left out because it depends on Lumivara's DOM; Aetheria's equivalents haven't been explored yet.

**Hard rule:** never add anything that clears session data or deletes `saved/Instance*`. The game's Guest account lives in that profile's `localStorage` (`aetheriaGuest`); losing it loses the character.

**Testing:** use screen 10 (`saved\Instance10`, control port 4510) for game-window tests. Never drive other screens; they may hold the user's characters. Don't push to GitHub or commit unless the user asks.

## Layout

```
server.js            launcher + JSON API + static files (Node core modules only)
public/              console page: index.html, style.css, app.js
client/main.cjs      Electron main process: one game window per process
client/preload.cjs   exposes window.aetheriaDesktop.googleLogin() to the game (same as the official client)
client/pip-bar.html  drag bar for the frameless PiP window
client/visibility-spoof.js  shim injected (CDP) before the game loads so it keeps running while hidden
client/game.ico      the site's favicon.ico (16–48 px)
runtime/             Electron runtime copied from the official client (not source, gitignored)
saved/InstanceN/     Chromium profile per screen (user data, never delete) + lv-window.json
config.json          { exePath, instancesDir: "saved", instanceCount, titles, autoStart, hiddenFps, dataDirs, order }
Aetheria Launcher.lnk  conhost.exe --headless node server.js (no console window)
```

Run with `node server.js`; the console is at `http://127.0.0.1:4322`. No build, lint or tests.

## Differences from Lumivara Multi-Launcher

- **Ports:** console `PORT = 4322`, screen N control port `4500+N` (Lumivara uses 4321 / 4400+N), so both launchers run side by side.
- **Header:** every API call needs `X-Aetheria: 1` (Lumivara: `X-Lumivara`). Host-header check is the same.
- **Global hotkey:** `Ctrl+Shift+G` → `/toggle-all` (Lumivara owns `Ctrl+Shift+H`; only one process can register a key).
- **Game URL:** `https://www.aetheria-online.in.th/play`. `loads` counts `did-finish-load` of URLs starting with it.
- **Session:** `session.defaultSession` (the official client uses the default session too, so an official profile folder from `%APPDATA%\Aetheria Online` could be used as a screen via `dataDirs`).
- **Zoom/tile reference size:** 960×540 (the official client's minimum window). Windows smaller than that zoom out; tiling picks columns for 16:9. Default window 1280×720. Background `#0e1424`.
- **Ported from the official Aetheria Online 1.0.4 client** (`resources\app.asar`: `main.js`, `preload.js`):
  - User agent: `app.userAgentFallback` with ` Electron/…`, ` aetheria-…/…` and ` Aetheria Online/…` removed.
  - Links: `setWindowOpenHandler` denies all popups; same-site URLs (`www.aetheria-online.in.th`, `aetheria-online.in.th`, `*.aetheria-online.in.th`) load in the game view, other http(s) URLs open in the default browser. `will-navigate` to another site is blocked and opened externally.
  - Google sign-in: Google refuses embedded browsers, so the game's button calls `window.aetheriaDesktop.googleLogin()` → IPC `google-login` → `googleLogin()` starts a one-time `http.createServer` on a random 127.0.0.1 port, opens `<site>/desktop-login?port=&state=` in the default browser, and resolves with the token the page sends to `/done` (token must match `^[\w-]+\.[\w-]+\.[\w-]+$`, state must match, 5-minute timeout). One pending login per screen.
  - `Ctrl+Shift+I` toggles DevTools on the game view.
  - Not ported: the single-window behaviour (the official app maximises one window), its offline page (our auto-recovery retries every 10 s instead).
- **Audio:** every screen starts muted (`userMuted = true` in `client/main.cjs`); the "เสียง" button unmutes it.
- **Electron 33** (the official runtime) lacks `webContents.setZoomMode`, so it is called with `?.`. Each screen is its own process, so per-origin zoom doesn't leak between screens.
- **Removed:** `/afk`, `/autoafk`, OCR (Tesseract), `GET /capture`, bot/saver probe and alerts, `autoAfk` config. Kept as generic tools for future automation: `GET /element?id=`, `key`, `click` actions and the "กด I" sidebar command.
- `CLIENT_VERSION = 1` in both `server.js` and `client/main.cjs`; bump both when a game-window command changes. `package.json` version 1.0.0.

## Game notes (from the web bundle, 2026-10-11)

- First visit creates a Guest account automatically and stores it in `localStorage.aetheriaGuest`; the page then shows character select ("เลือกตัวละคร"). The game offers "บัญชีชั่วคราว · ผูกบัญชี" to bind a guest to a username/password.
- The official client says two windows on one account kick each other, so every screen needs its own account.
- The server is Colyseus over WebSocket; the bundle mentions bot/auto-play and a battery-saving mode ("ประหยัดแบต"), not yet mapped to DOM ids.

## Building the runtime from scratch

1. Install the official **Aetheria Online** Windows client (1.0.4 was used; it installs to e.g. `E:\Aetheria Online`).
2. Copy that folder to `<project>\runtime`, then in the copy: delete `resources\app.asar`, `resources\elevate.exe` and `Uninstall Aetheria Online.exe`; rename `Aetheria Online.exe` to `AetheriaClient.exe`; optionally delete every `locales\*.pak` except `en-US.pak` and `th.pak`. Keep `LICENSE.electron.txt` and `LICENSES.chromium.html`.
3. Create `runtime\resources\app\package.json`: `{ "name": "aetheria-multi-client", "main": "../../../client/main.cjs" }`.
4. `client\game.ico` = `https://www.aetheria-online.in.th/favicon.ico`.
5. Shortcut: `$l=(New-Object -ComObject WScript.Shell).CreateShortcut('<project>\Aetheria Launcher.lnk'); $l.TargetPath='C:\Windows\System32\conhost.exe'; $l.Arguments='--headless node server.js'; $l.WorkingDirectory='<project>'; $l.IconLocation='<project>\client\game.ico,0'; $l.Save()`

Step 2 works because the official exe's fuse **OnlyLoadAppFromAsar is disabled**. Sentinel `dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX`, then fuse version byte, count byte, one ASCII char per fuse: 1.0.4 reads `10110001` (8 fuses), index 5 = `'0'` = disabled. If a future version sets it to `'1'`, use the stock Electron build of the same version (33.4.11) instead.

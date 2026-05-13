# RA Achievement Overlay

RetroAchievements achievement overlay for OBS Browser Source.

## Setup

### 1. Install Node.js

Download and install from **https://nodejs.org** — choose the **LTS** version.

After installing, open a new terminal and verify:
```
node --version    # should show v18 or higher
npm --version
```

### 2. Install dependencies

Open a terminal in this folder and run:
```
npm install
```

### 3. Start the server

```
npm start
```

or

```
node server.js
```

The terminal will show:
```
  Setup:   http://localhost:7890/
  OBS URL: http://localhost:7890/obs
```

Keep this terminal window open while streaming.

---

## Configuration (Setup Page)

Open **http://localhost:7890/** in your browser.

1. **Enter credentials** — your RetroAchievements username and API key
   - Get your API key at: https://retroachievements.org/settings
   - Tick "Save credentials" to persist across restarts

2. **Select a game** — choose from your 50 most recently played games
   - Optionally enable "Auto-switch to currently playing game"

3. **Choose display mode** — Tiles, Text list, or Tiles + Text (RA style)

4. **Set filters** — All achievements, Unearned only, or In-progress only

5. **Style the overlay** — Background color/opacity, text, fonts, badge size, panel position

6. **Pin achievements** — Star any achievement to pin it to the top of the overlay

---

## Adding to OBS

1. In OBS: **Sources → + → Browser Source**
2. Paste URL: `http://localhost:7890/obs`
3. Set **Width** and **Height** to match your canvas (e.g. 1920 × 1080)
4. Check **☑ Allow Transparency**
5. Click OK

The panel floats on a transparent background — position it anywhere in OBS like any other source.

### Interacting with the overlay in OBS

Right-click the browser source → **Interact** to open a window where you can:
- **Drag tiles** to reorder achievements
- **Resize individual tiles** horizontally by dragging their right edge

Order changes are saved automatically.

---

## Update interval

- Achievement progress refreshes every **2 minutes**
- "Currently playing" check runs every **60 seconds**
- The overlay polls the local server every **15 seconds**

This keeps well within RetroAchievements API rate limits.

---

## Running on startup (optional)

Create a shortcut to `start.bat`:
```bat
@echo off
cd /d "%~dp0"
node server.js
```

Or use Task Scheduler / PM2 for a background service.

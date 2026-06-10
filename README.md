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

## Alerts & Triggers (MixItUp-style)

Card **9 · Alerts & Triggers** on the setup page fires overlay alerts — any
combination of **image/GIF/WebM + sound + text** — from Twitch events:

| Trigger | Needs | Options |
|---|---|---|
| 🎁 Channel point redeem | Twitch reconnect (new scopes) | match by reward name or ID |
| 💎 Bit cheer | basic chat connection | min-bits tiers or exact amount |
| ❗ Chat `!command` | basic chat connection | permission level / custom user list, global + per-user cooldowns |
| ⭐ Sub / resub / gift | Twitch reconnect (new scopes) | tier filter, include resubs/gifts |
| 🚀 Raid | Twitch reconnect (new scopes) | minimum viewers |
| 💜 Follow | Twitch reconnect (new scopes) | — |
| 🏆 RA Achievement unlock | nothing (RA only) | minimum points |
| ☕ Ko-fi donation | Ko-fi webhook (see below) | amount tiers or exact amount, payment type filter |

- **Queue** — alerts play one at a time. The [Control Panel](http://localhost:7890/control)
  shows what's playing and queued, with **Skip**, **Clear queue**, and a **▶ Test**
  button per trigger (test alerts work without any Twitch connection).
- **Text templates** — use variables like `{user}`, `{amount}`, `{message}`,
  `{reward}`, `{tier}`, `{viewers}`, `{channel}`.
- **Re-auth** — channel points, subs, raids and follows use Twitch EventSub and
  need extra OAuth scopes. If you connected Twitch before this feature existed,
  the setup page shows a "Reconnect with Twitch" banner — one click re-consents.
- **Duration vs. sound length** — an alert ends after its configured duration;
  set the duration at least as long as the sound file or it will be cut off.

### Sound & media library

Alert media comes from two places (both browsable via the **Choose…** picker):

1. **Uploads** — the setup page now accepts `mp3 / ogg / wav / webm` in addition
   to images (max 25 MB), stored in `public/uploads/`.
2. **Local folders** — add any folder that already exists on the server's drive
   (Widgets card → *Media Library — Local Folders*). Files are served read-only
   from `/media/<folder-id>/<file>`; subfolders are ignored.
   ⚠ Anyone who can reach the server can fetch files in shared folders — only
   share folders that contain stream media.

### Ko-fi donations

The ☕ Ko-fi card on the setup page connects [Ko-fi](https://ko-fi.com) webhooks:
set the shown URL at **ko-fi.com/manage/webhooks**, paste the *Verification
Token* from Ko-fi's Advanced section, and use Ko-fi's **Send Test** button to
confirm. Events without a valid token are rejected.

Each donation carries the supporter's **name, message, amount, currency** and
membership **tier** — available as `{user}`, `{message}`, `{amount}`,
`{currency}`, `{tier}` in alert templates. Supporters who untick "public" on
Ko-fi appear as *Anonymous* with their message hidden. Create several Ko-fi
triggers for amount tiers (e.g. 2 / 5 / 10) — the highest matching tier wins
and exact amounts beat tiers; triggers can also filter by payment type
(Donation / Subscription / Shop Order / Commission).

Ko-fi must be able to reach the server from the internet — fine on a public
server; a home PC needs a tunnel (ngrok / cloudflared).

### Video alerts

Alerts can play video files (`mp4` / `webm`) — with sound — via the Image/GIF/Video
action: per-trigger loop, mute, and volume controls. Set **Alert ends → "When
sound / video finishes"** to let the media's own length end the alert (the
duration field then acts as a maximum).

### Positioning alerts by dragging

In a trigger's editor, click **📍 Position on overlay**: a sample of that alert
appears on every connected overlay (OBS Interact mode or the browser preview).
Drag it where you want it and click **✓ Done** — the position is saved as a
percentage of the canvas, so it holds at any resolution.

### Alert audio in OBS

OBS browser sources allow autoplay, so alert sounds just work in the `/obs`
source. Tick **Control audio via OBS** on the browser source to route alert
audio through the OBS mixer. When previewing in a normal browser, autoplay may
be blocked until you click the page — open `/obs?mute=1` for a silent preview
and to avoid hearing sounds twice while OBS is also open.

---

## Overlay scenes (multiple browser sources)

*Overlay & Widgets → Overlay Scenes* creates alternate layouts of the same
overlay, each with its own URL (`/obs?scene=<id>`) for a separate OBS browser
source — e.g. move the countdown elsewhere for your full-cam scene. A scene
inherits the base layout; open its preview URL and **drag elements around** to
reposition them for that scene only, and use the per-scene show/hide controls
for the panel, recent panel, rich presence, and each widget. Alerts render the
same on every scene.

Rich Presence can also be detached from the panel header into its own movable
chip (*Animations & Refresh → Float Rich Presence*).

## Backup / restore

The sidebar's **Backup** section exports a JSON file containing display
settings, widgets, triggers, scenes, and media folders — credentials and
Twitch tokens are deliberately excluded. Import it on any instance to restore
(replaces the current layout after confirmation).

---

## Update interval & unlock animations

- Achievement progress refreshes every **60 seconds** by default — configurable
  (15s–10min) in *Overlay & Widgets → Animations & Refresh*
- "Currently playing" check runs every **60 seconds**
- The overlay polls the local server every **15 seconds** as a WebSocket fallback

When a refresh detects a **freshly unlocked achievement**, the overlay flashes
that tile with a golden pulse (toggleable), and any **🏆 RA Achievement**
triggers fire — so an unlock can also play a sound/image alert. Template
variables: `{achievement}`, `{points}`, `{description}`, `{game}`. Use
`{badge}` as the alert's image file to show the unlocked achievement's real
badge (new achievement triggers default to this).

Overlay elements (achievement panel, widgets) animate in/out with a
configurable style (fade, swipe, slide, pop).

**About per-achievement progress counters** (e.g. "7/10 enemies"): the RA web
API does not currently expose measured progress — it only exists inside the
emulator overlay. The server already parses progress fields defensively, so
counters and the "In progress" filter will light up automatically if RA adds
them to the API. Until then, enable **Show live Rich Presence** to display the
in-game status line from RA (which often includes exactly this kind of
progress) in the panel header.

The defaults keep well within RetroAchievements API rate limits; the 15s
minimum refresh guards against hammering the API.

---

## Running on startup (optional)

Create a shortcut to `start.bat`:
```bat
@echo off
cd /d "%~dp0"
node server.js
```

Or use Task Scheduler / PM2 for a background service.

---

## Deploying to a remote server (AWS / DreamHost VPS)

This turns the overlay into a persistent hosted service — your OBS browser source points at your domain instead of localhost.

### 1. Clone and configure

```bash
git clone <your-repo> ra-obs-overlay
cd ra-obs-overlay
npm install
cp .env.example .env
```

Edit `.env`:
```
RA_USERNAME=yourusername
RA_API_KEY=yourkey
SETUP_USER=admin
SETUP_PASS=a-strong-password
PORT=7890
```

### 2. Run with PM2

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # follow the printed command to auto-start on reboot
```

### 3. nginx + HTTPS

Install nginx and certbot, then:

```bash
sudo cp nginx.conf.example /etc/nginx/sites-available/ra-overlay
# Edit the file — replace yourdomain.com with your actual domain
sudo ln -s /etc/nginx/sites-available/ra-overlay /etc/nginx/sites-enabled/
sudo certbot --nginx -d yourdomain.com
sudo systemctl reload nginx
```

### 4. In OBS

The setup page at `https://yourdomain.com/` will now show your actual domain URL
in the OBS Browser Source box. Copy it and add it to OBS as normal.

The overlay URL (`/obs`) is public — no password needed for OBS to load it.  
The setup page (`/`) requires the username/password from your `.env`.

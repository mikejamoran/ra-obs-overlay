'use strict';

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const https   = require('https');

const app  = express();
const PORT = 7890;

const CONFIG_FILE = path.join(__dirname, 'overlay_config.json');
const RA_BASE     = 'https://retroachievements.org/API';
const BADGE_BASE  = 'https://media.retroachievements.org/Badge';

const ACH_TTL        = 120_000;  // 2 min between achievement refreshes
const GAME_CHECK_TTL =  60_000;  // 1 min between now-playing checks

// ── In-memory state ────────────────────────────────────────────────────────────

let S = {
  creds:     { username: '', api_key: '' },
  gameId:    null,
  gameInfo:  {},
  achievements: [],
  display: {
    mode:        'both',       // tiles | text | both
    filter:      'all',        // all | unearned | inprogress
    bgColor:     '#0d0d0d',
    bgOpacity:   0.88,
    textColor:   '#e6edf3',
    accentColor: '#1f6feb',
    goldColor:   '#e3b341',
    fontSize:    13,
    fontFamily:  '"Segoe UI", system-ui, sans-serif',
    badgeSize:   56,
    tileGap:     8,
    tileRadius:  8,
    panelPos:    'top-right',  // top-left | top-right | bottom-left | bottom-right | center
    panelWidth:  440,
    showPoints:  true,
    showDesc:    true,
    pinned:      [],           // achievement IDs that float to top
    order:       [],           // full achievement ID order
    overrideNow: false,
  },
  lastAchRefresh:  0,
  lastGameCheck:   0,
  nowPlayingId:    null,
  nowPlayingTitle: '',
  connected:       false,
  fetching:        false,
};

// ── Config persistence ──────────────────────────────────────────────────────────

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return;
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (saved.creds)   Object.assign(S.creds,   saved.creds);
    if (saved.display) Object.assign(S.display, saved.display);
    if (saved.gameId)  S.gameId = saved.gameId;
  } catch (e) { console.error('[config] Load error:', e.message); }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(
      { creds: S.creds, display: S.display, gameId: S.gameId },
      null, 2
    ));
  } catch (e) { console.error('[config] Save error:', e.message); }
}

// ── RA API helpers ──────────────────────────────────────────────────────────────

/**
 * Make a GET request to the RA API.
 * @param {string} endpoint  - e.g. 'API_GetUserSummary.php'
 * @param {object} params    - query params (z/y auth added automatically)
 * @param {object} [creds]   - optional explicit {username, api_key}; defaults to S.creds
 */
function raGet(endpoint, params, creds) {
  const { username, api_key } = creds || S.creds;
  return new Promise((resolve, reject) => {
    const url = new URL(`${RA_BASE}/${endpoint}`);
    url.searchParams.set('z', username);
    url.searchParams.set('y', api_key);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    let settled = false;
    const done = (fn, val) => { if (!settled) { settled = true; fn(val); } };

    const req = https.get(url.toString(), res => {
      let body = '';
      res.on('data',  chunk => body += chunk);
      res.on('error', err  => done(reject, new Error(`Response error: ${err.message}`)));
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return done(reject, new Error(
            `RetroAchievements returned HTTP ${res.statusCode} — check your API key`
          ));
        }
        try { done(resolve, JSON.parse(body)); }
        catch { done(reject, new Error('RetroAchievements returned unexpected data')); }
      });
    });

    // Pass the error object into destroy so only one 'error' event fires
    req.setTimeout(20000, () =>
      req.destroy(new Error('Request timed out — check your internet connection'))
    );
    req.on('error', err => done(reject, new Error(`Network error: ${err.message}`)));
  });
}

async function fetchAchievements(gameId) {
  if (S.fetching) return;
  S.fetching = true;
  try {
    const data = await raGet('API_GetGameInfoAndUserProgress.php',
                             { u: S.creds.username, g: gameId });
    const raw = data.Achievements || {};
    const list = Object.entries(raw).map(([id, a]) => ({
      id:           parseInt(id),
      title:        a.Title        || '',
      description:  a.Description  || '',
      points:       parseInt(a.Points       || 0),
      badge:        a.BadgeName    || '',
      earned:       !!(a.DateEarned || a.DateEarnedHardcore),
      earnedHard:   !!a.DateEarnedHardcore,
      dateEarned:   a.DateEarned || a.DateEarnedHardcore || '',
      userProgress: parseInt(a.UserProgress || 0),
      maxProgress:  parseInt(a.MaxProgress  || 0),
      numAwarded:   parseInt(a.NumAwarded   || 0),
      displayOrder: parseInt(a.DisplayOrder || 0),
      type:         a.type || '',
    }));

    // Default sort: unearned first, then by display order
    list.sort((a, b) => (a.earned - b.earned) || (a.displayOrder - b.displayOrder));

    S.achievements  = list;
    S.gameInfo      = {
      id:      gameId,
      title:   data.Title            || '',
      console: data.ConsoleName      || '',
      boxArt:  data.ImageBoxArt      || '',
      numAch:  parseInt(data.NumAchievements || 0),
      earned:  parseInt(data.NumAwardedToUserHardcore || data.NumAwardedToUser || 0),
      points:  parseInt(data.points_total || 0),
    };
    if (!S.display.order.length) {
      S.display.order = list.map(a => a.id);
    }
    S.lastAchRefresh = Date.now();
    console.log(`[RA] ${list.length} achievements loaded for "${S.gameInfo.title}"`);
  } catch (e) {
    console.error('[RA] Achievement fetch error:', e.message);
  } finally {
    S.fetching = false;
  }
}

async function checkNowPlaying() {
  try {
    const data = await raGet('API_GetUserSummary.php', { u: S.creds.username, g: 1 });
    const nowId    = parseInt(data.LastGameID || 0) || null;
    const nowTitle = (data.RecentlyPlayed || [])[0]?.Title || '';
    S.nowPlayingId    = nowId;
    S.nowPlayingTitle = nowTitle;
    S.lastGameCheck   = Date.now();
    if (S.display.overrideNow && nowId && nowId !== S.gameId) {
      console.log(`[RA] Now playing changed → game ${nowId} (${nowTitle})`);
      S.gameId = nowId;
      S.display.order  = [];
      S.display.pinned = [];
      S.lastAchRefresh = 0;
    }
  } catch (e) {
    S.lastGameCheck = Date.now();
    console.error('[RA] Now-playing check error:', e.message);
  }
}

// ── Middleware ──────────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Routes ──────────────────────────────────────────────────────────────────────

app.get('/',    (_, res) => res.sendFile(path.join(__dirname, 'public', 'setup.html')));
app.get('/obs', (_, res) => res.sendFile(path.join(__dirname, 'public', 'overlay.html')));

// Validate credentials and store them
app.post('/api/connect', async (req, res) => {
  const raw = req.body || {};
  const username = (raw.username || '').trim();
  const api_key  = (raw.api_key  || '').trim();
  const save     = raw.save;
  if (!username || !api_key)
    return res.status(400).json({ ok: false, error: 'Username and API key required' });
  try {
    // Pass credentials explicitly — don't touch S.creds until auth succeeds
    const data = await raGet('API_GetUserSummary.php', { u: username, g: 1 },
                             { username, api_key });

    if (!data || !(data.User || data.Username))
      return res.status(401).json({ ok: false, error: 'Credentials rejected by RetroAchievements' });

    // Auth succeeded — update global state
    S.creds           = { username, api_key };
    S.connected       = true;
    S.nowPlayingId    = parseInt(data.LastGameID || 0) || null;
    S.nowPlayingTitle = (data.RecentlyPlayed || [])[0]?.Title || '';
    S.lastGameCheck   = Date.now();
    if (save) saveConfig();
    res.json({ ok: true, username: data.User || data.Username, nowPlayingId: S.nowPlayingId });
  } catch (e) {
    // S.creds is untouched — the old (possibly empty) creds remain
    res.status(502).json({ ok: false, error: e.message });
  }
});

// Recently played games list
app.get('/api/games', async (req, res) => {
  if (!S.connected) return res.status(401).json({ error: 'Not connected' });
  try {
    const games = await raGet('API_GetUserRecentlyPlayedGames.php',
                              { u: S.creds.username, c: 50 });
    res.json({ games });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Select active game
app.post('/api/select-game', (req, res) => {
  const { game_id, save } = req.body || {};
  if (!game_id) return res.status(400).json({ ok: false, error: 'game_id required' });
  const gid = parseInt(game_id);
  if (S.gameId !== gid) {
    S.gameId = gid;
    S.display.order  = [];
    S.display.pinned = [];
    S.lastAchRefresh = 0;
    fetchAchievements(gid).catch(console.error);
  }
  if (save) saveConfig();
  res.json({ ok: true });
});

// Full state poll — used by overlay every 15 s
app.get('/api/state', (req, res) => {
  const now = Date.now();
  if (S.connected && (now - S.lastGameCheck) > GAME_CHECK_TTL)
    checkNowPlaying().catch(console.error);
  if (S.connected && S.gameId && (now - S.lastAchRefresh) > ACH_TTL)
    fetchAchievements(S.gameId).catch(console.error);
  res.json({
    gameInfo:        S.gameInfo,
    achievements:    S.achievements,
    display:         S.display,
    nowPlayingId:    S.nowPlayingId,
    nowPlayingTitle: S.nowPlayingTitle,
    connected:       S.connected,
  });
});

// Achievement list for setup page pin selector
app.get('/api/achievements', (req, res) => {
  res.json({ achievements: S.achievements, gameInfo: S.gameInfo, display: S.display });
});

// Restore saved config for setup page on load
app.get('/api/config', (req, res) => {
  res.json({
    username:  S.creds.username,
    hasApiKey: !!S.creds.api_key,
    gameId:    S.gameId,
    display:   S.display,
    connected: S.connected,
    nowPlayingId:    S.nowPlayingId,
    nowPlayingTitle: S.nowPlayingTitle,
  });
});

// Update display settings (partial update supported)
app.post('/api/display', (req, res) => {
  const body = req.body || {};
  Object.assign(S.display, body);
  saveConfig();
  res.json({ ok: true });
});

// Force an immediate achievement refresh
app.post('/api/refresh', (req, res) => {
  if (!S.gameId || !S.connected)
    return res.status(400).json({ ok: false, error: 'No game selected' });
  S.lastAchRefresh = 0;
  fetchAchievements(S.gameId).catch(console.error);
  res.json({ ok: true });
});

// ── Start ───────────────────────────────────────────────────────────────────────

loadConfig();
if (S.creds.username && S.creds.api_key) {
  S.connected = true;
  console.log(`[startup] Loaded credentials for ${S.creds.username}`);
  if (S.gameId) {
    console.log(`[startup] Loading achievements for game ${S.gameId}…`);
    fetchAchievements(S.gameId).catch(console.error);
  }
}

app.listen(PORT, 'localhost', () => {
  console.log('\n  ┌─────────────────────────────────────────┐');
  console.log('  │   RA Achievement Overlay                │');
  console.log('  ├─────────────────────────────────────────┤');
  console.log(`  │  Setup:   http://localhost:${PORT}/        │`);
  console.log(`  │  OBS URL: http://localhost:${PORT}/obs     │`);
  console.log('  └─────────────────────────────────────────┘');
  console.log('\n  Press Ctrl+C to stop\n');
});

'use strict';

try { require('dotenv').config(); } catch {}

const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const https    = require('https');
const crypto   = require('crypto');
const WS       = require('ws');
const { WebSocketServer } = WS;
const multer   = require('multer');

const triggers = require('./lib/triggers');
const eventsub = require('./lib/eventsub');
const media    = require('./lib/media');

const app  = express();
const PORT = parseInt(process.env.PORT || '7890');

const CONFIG_FILE = path.join(__dirname, 'overlay_config.json');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
const RA_BASE     = 'https://retroachievements.org/API';

const GAME_CHECK_TTL = 60_000; // achievement refresh interval is display.refreshSec

// ── State ──────────────────────────────────────────────────────────────────────

let S = {
  creds:    { username: '', api_key: '' },
  gameId:   null,
  gameInfo: {},
  achievements: [],
  display: {
    mode: 'both', filter: 'all',
    bgColor: '#0d0d0d', bgOpacity: 0.88,
    textColor: '#e6edf3', accentColor: '#1f6feb',
    goldColor: '#e3b341', fontSize: 13,
    fontFamily: '"Segoe UI", system-ui, sans-serif',
    badgeSize: 56, tileGap: 8, tileRadius: 8,
    panelPos: 'top-right', panelWidth: 440,
    showPoints: true, showDesc: true,
    pinned: [], order: [],
    overrideNow: false,
    refreshSec: 60,
    showRichPresence: false,
    unlockFlash: true,
    elemAnimIn: 'fade', elemAnimOut: 'fade',
    recentEnabled: false, recentCount: 3, recentPos: 'bottom-left',
    recentMode: 'stack', recentSpeed: 80,
    recentX: null, recentY: null, recentW: null, recentH: null, recentZIndex: 9,
    panelX: null, panelY: null, panelH: 600,
    panelVisible: true, panelLocked: false,
  },
  widgets: [],
  triggers: [],
  mediaFolders: [],
  // Alternate overlay layouts served at /obs?scene=<id> — each scene stores
  // placement/visibility overrides for the panel, recent panel, rich presence
  // and widgets, on top of the base layout.
  scenes: [],
  twitchConnected:  false,
  twitchChannel:    process.env.TWITCH_CHANNEL || '',
  twitchAccessToken:  null,
  twitchRefreshToken: null,
  twitchUserId:       null,
  twitchScopes:       [],
  twitchNeedsReauth:  false,
  kofiToken:          '',     // Ko-fi webhook verification token (persisted)
  kofiLastEvent:      null,   // runtime: { at, type, from, amount, currency } for the setup UI
  lastAchRefresh:  0,
  lastGameCheck:   0,
  nowPlayingId:    null,
  nowPlayingTitle: '',
  richPresence:    '',
  connected:       false,
  fetching:        false,
};

// ── Config ──────────────────────────────────────────────────────────────────────

function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (saved.creds)         Object.assign(S.creds,   saved.creds);
      if (saved.display)       Object.assign(S.display, saved.display);
      if (saved.gameId)        S.gameId = saved.gameId;
      if (saved.widgets)       S.widgets = saved.widgets;
      if (saved.triggers)      S.triggers = saved.triggers.map(t => triggers.normalizeTrigger(t));
      if (saved.mediaFolders)  S.mediaFolders = saved.mediaFolders;
      if (saved.scenes)        S.scenes = saved.scenes;
      if (saved.twitchChannel)      S.twitchChannel      = saved.twitchChannel;
      if (saved.twitchAccessToken)  S.twitchAccessToken  = saved.twitchAccessToken;
      if (saved.twitchRefreshToken) S.twitchRefreshToken = saved.twitchRefreshToken;
      if (saved.twitchUserId)       S.twitchUserId       = saved.twitchUserId;
      if (saved.twitchScopes)       S.twitchScopes       = saved.twitchScopes;
      if (saved.kofiToken)          S.kofiToken          = saved.kofiToken;
    } catch (e) { console.error('[config] Load error:', e.message); }
  }
  if (process.env.RA_USERNAME)    S.creds.username = process.env.RA_USERNAME;
  if (process.env.RA_API_KEY)     S.creds.api_key  = process.env.RA_API_KEY;
  if (process.env.TWITCH_CHANNEL) S.twitchChannel  = process.env.TWITCH_CHANNEL;
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({
      creds: S.creds, display: S.display, gameId: S.gameId,
      widgets: S.widgets, triggers: S.triggers, mediaFolders: S.mediaFolders,
      scenes: S.scenes,
      twitchChannel: S.twitchChannel,
      twitchAccessToken: S.twitchAccessToken, twitchRefreshToken: S.twitchRefreshToken,
      twitchUserId: S.twitchUserId, twitchScopes: S.twitchScopes,
      kofiToken: S.kofiToken,
    }, null, 2));
  } catch (e) { console.error('[config] Save error:', e.message); }
}

// ── Auth ────────────────────────────────────────────────────────────────────────

function safeEqual(a, b) {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  if (ba.length !== bb.length) { crypto.timingSafeEqual(ba, ba); return false; }
  return crypto.timingSafeEqual(ba, bb);
}

function basicAuth(req, res, next) {
  const envUser = process.env.SETUP_USER || '';
  const envPass = process.env.SETUP_PASS || '';
  if (!envUser || !envPass) return next();
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="RA Overlay"');
    return res.status(401).send('Authentication required');
  }
  let u = '', p = '';
  try {
    const d = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const i = d.indexOf(':');
    u = i >= 0 ? d.slice(0, i) : d;
    p = i >= 0 ? d.slice(i + 1) : '';
  } catch { return res.status(401).send('Invalid authorization header'); }
  if (!safeEqual(u, envUser) || !safeEqual(p, envPass)) {
    res.set('WWW-Authenticate', 'Basic realm="RA Overlay"');
    return res.status(401).send('Invalid credentials');
  }
  next();
}

// ── WebSocket ────────────────────────────────────────────────────────────────────

let wss;

function broadcast(msg) {
  if (!wss) return;
  const data = JSON.stringify(msg);
  wss.clients.forEach(ws => { if (ws.readyState === 1) ws.send(data); });
}

function twitchStatus() {
  return { connected: S.twitchConnected, channel: S.twitchChannel, needsReauth: S.twitchNeedsReauth };
}

function getFullState() {
  return {
    type: 'state',
    gameInfo: S.gameInfo, achievements: S.achievements,
    display: S.display, widgets: S.widgets, scenes: S.scenes,
    connected: S.connected,
    nowPlayingId: S.nowPlayingId, nowPlayingTitle: S.nowPlayingTitle,
    richPresence: S.richPresence,
    twitch: twitchStatus(),
    // Queue summaries + the alert currently on screen (so a client connecting
    // mid-alert can render it). Full trigger configs stay out of this payload —
    // it goes to the unauthenticated overlay.
    alerts: { ...triggers.getQueueState(), playingAlert: triggers.getPlayingAlert() },
  };
}

// ── Widget utilities ────────────────────────────────────────────────────────────

const WIDGET_SIZES = {
  death_counter:  { w: 200, h: 100 },
  timer:          { w: 240, h: 100 },
  countdown:      { w: 240, h: 100 },
  social:         { w: 280, h: 64  },
  scrolling_text: { w: 800, h: 56  },
  image:          { w: 200, h: 200 },
  chat:           { w: 400, h: 500 },
};

function widgetDefaults(type) {
  const base = { fontSize: 36, labelSize: 14, color: '#e6edf3', bgColor: '#0d0d0d', bgOpacity: 0.85, showLabel: true };
  switch (type) {
    case 'death_counter':
      return { ...base, count: 0, label: 'Deaths', step: 1,
               chatCommand: '!death', chatPermission: 'mods', chatAllowedUsers: '',
               chatAnnounce: false,
               chatAnnounceTemplate: '[streamername] died again! That\'s [death count] death(s) PogChamp',
               chatAnnounceReset: '' };
    case 'timer':
      return { ...base, label: 'Timer', running: false, startedAt: null, pausedElapsed: 0 };
    case 'countdown':
      return { ...base, label: 'Countdown', running: false, startedAt: null, pausedElapsed: 0, totalMs: 600_000 };
    case 'social':
      return { platform: 'twitch', handle: '', fontSize: 18, color: '#e6edf3',
               bgColor: '#0d0d0d', bgOpacity: 0.85, showIcon: true };
    case 'scrolling_text':
      return { text: 'Welcome to the stream!', speed: 60, direction: 'left',
               fontSize: 22, color: '#e6edf3', bgColor: '#0d0d0d', bgOpacity: 0 };
    case 'image':
      return { src: '', opacity: 1, objectFit: 'contain' };
    case 'chat':
      return {
        fontSize: 14, usernameSize: 14, color: '#e6edf3',
        bgColor: '#0d0d0d', bgOpacity: 0.75,
        usernameColors: true, showBadges: true,
        maxMessages: 20, messageTimeout: 0,
        showTimestamp: false, direction: 'bottom',
        filterCommands: false, borderRadius: 8,
        showHeader: false, headerText: 'Chat',
      };
    default: return {};
  }
}

function applyWidgetAction(widget, { action, value }) {
  const c = widget.config;
  if (widget.type === 'death_counter') {
    const step = parseInt(value) || c.step || 1;
    if (action === 'increment') c.count = Math.max(0, (c.count || 0) + step);
    if (action === 'decrement') c.count = Math.max(0, (c.count || 0) - step);
    if (action === 'reset')     c.count = 0;
    if (action === 'set')       c.count = Math.max(0, parseInt(value) || 0);
  }
  if (widget.type === 'timer' || widget.type === 'countdown') {
    if (action === 'start' && !c.running) {
      c.startedAt = Date.now(); c.running = true;
    }
    if (action === 'pause' && c.running) {
      c.pausedElapsed = (c.pausedElapsed || 0) + (Date.now() - c.startedAt);
      c.running = false; c.startedAt = null;
    }
    if (action === 'reset') {
      c.running = false; c.startedAt = null; c.pausedElapsed = 0;
    }
    if (action === 'set_duration' && widget.type === 'countdown') {
      c.totalMs = Math.max(0, parseInt(value) || 0);
      c.running = false; c.startedAt = null; c.pausedElapsed = 0;
    }
  }
}

// ── Twitch IRC (native WebSocket, no tmi.js) ────────────────────────────────────

let twitchWs = null;

// Parse @key=value;key2=value2 tag string into an object.
// Badges are decoded into { broadcaster: '1', moderator: '1', ... }
function parseTags(raw) {
  const tags = {};
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    tags[part.slice(0, eq)] = part.slice(eq + 1) || null;
  }
  if (typeof tags.badges === 'string') {
    const obj = {};
    for (const b of tags.badges.split(',')) {
      const slash = b.indexOf('/');
      if (slash >= 0) obj[b.slice(0, slash)] = b.slice(slash + 1);
    }
    tags.badges = obj;
  } else {
    tags.badges = {};
  }
  return tags;
}

function checkPermission({ permission, allowedUsers }, tags) {
  const perm     = permission || 'mods';
  const username = (tags['display-name'] || tags.username || '').toLowerCase();
  const badges   = tags.badges || {};
  const isBroadcaster = !!badges.broadcaster;
  const isMod         = !!badges.moderator || tags.mod === '1';
  const isSub         = !!badges.subscriber || tags.subscriber === '1';
  if (perm === 'everyone')    return true;
  if (perm === 'followers')   return true; // follower check needs Helix API; Twitch enforces it at chat level
  if (perm === 'subscribers') return isBroadcaster || isMod || isSub;
  if (perm === 'mods')        return isBroadcaster || isMod;
  if (perm === 'broadcaster') return isBroadcaster;
  if (perm === 'custom') {
    const allowed = (allowedUsers || '').toLowerCase()
      .split(',').map(s => s.trim()).filter(Boolean);
    return isBroadcaster || allowed.includes(username);
  }
  return isBroadcaster || isMod;
}

function handleChatCommand(msg, tags) {
  const lower = msg.trim().toLowerCase();
  for (const widget of S.widgets) {
    if (widget.type !== 'death_counter') continue;
    const cmd    = (widget.config.chatCommand || '!death').toLowerCase().trim();
    if (!lower.startsWith(cmd)) continue;
    const suffix = lower.slice(cmd.length).trim();
    let action   = null;
    if (suffix === '++' || suffix === '+' || suffix === '+1') action = 'increment';
    else if (suffix === '--' || suffix === '-' || suffix === '-1') action = 'decrement';
    else if (suffix === 'reset') action = 'reset';
    if (!action || !checkPermission({ permission: widget.config.chatPermission, allowedUsers: widget.config.chatAllowedUsers }, tags)) continue;
    applyWidgetAction(widget, { action });
    announceDeathAction(widget, action);
    saveConfig();
    broadcast({ type: 'widget_update', widget });
  }
}

function onTwitchMessage(tags, message) {
  handleChatCommand(message, tags);
  if (tags.bits) {
    triggers.handleEvent({
      type:   'cheer',
      user:   tags['display-name'] || tags.username || '',
      amount: parseInt(tags.bits) || 0,
      message,
    });
  }
  triggers.checkChatTriggers(message, tags);
  if (S.widgets.some(w => w.type === 'chat' && w.visible)) {
    broadcast({
      type:      'chat_message',
      username:  tags['display-name'] || tags.username || 'anon',
      color:     tags.color || null,
      message,
      badges:    tags.badges || {},
      timestamp: Date.now(),
    });
  }
}

function connectTwitch(channel, token) {
  return new Promise((resolve, reject) => {
    disconnectTwitch();
    if (!channel || !token) return reject(new Error('channel and token required'));

    const password = token.startsWith('oauth:') ? token : `oauth:${token}`;
    const sock     = new WS('wss://irc-ws.chat.twitch.tv:443');
    let   joined   = false;

    sock.on('open', () => {
      sock.send(`PASS ${password}\r\n`);
      sock.send(`NICK ${channel.toLowerCase()}\r\n`);
      sock.send('CAP REQ :twitch.tv/tags twitch.tv/commands\r\n');
      sock.send(`JOIN #${channel.toLowerCase()}\r\n`);
    });

    sock.on('message', data => {
      for (const line of data.toString().split('\r\n').filter(Boolean)) {
        if (line.startsWith('PING')) { sock.send('PONG :tmi.twitch.tv\r\n'); continue; }

        // Extract optional @tags prefix
        let tags = {}, rest = line;
        if (rest.startsWith('@')) {
          const sp = rest.indexOf(' ');
          tags = parseTags(rest.slice(1, sp));
          rest = rest.slice(sp + 1);
        }

        // Login failure
        if (rest.includes('Login authentication failed') || rest.includes(':Login unsuccessful')) {
          sock.close();
          return reject(new Error('Twitch login failed — check your OAuth token'));
        }

        // JOIN confirmation
        if (!joined && rest.includes(`JOIN #${channel.toLowerCase()}`)) {
          joined = true;
          S.twitchConnected = true;
          S.twitchChannel   = channel;
          broadcast({ type: 'twitch_status', ...twitchStatus() });
          console.log(`[Twitch] Connected to #${channel}`);
          resolve();
        }

        // PRIVMSG — chat message (skip own messages to prevent loops)
        const pm = rest.match(/^:(\S+)!\S+ PRIVMSG #\S+ :(.+)$/);
        if (pm && pm[1].toLowerCase() !== channel.toLowerCase()) {
          onTwitchMessage(tags, pm[2]);
        }
      }
    });

    sock.on('close', () => {
      twitchWs = null;
      if (S.twitchConnected) {
        S.twitchConnected = false;
        broadcast({ type: 'twitch_status', ...twitchStatus() });
        console.log('[Twitch] Disconnected');
      }
      if (!joined) reject(new Error('Connection closed before joining channel'));
    });

    sock.on('error', err => {
      console.error('[Twitch] WebSocket error:', err.message);
      if (!joined) reject(err);
    });

    twitchWs = sock;
  });
}

function disconnectTwitch() {
  if (!twitchWs) return;
  try { twitchWs.close(); } catch {}
  twitchWs = null;
  S.twitchConnected = false;
  broadcast({ type: 'twitch_status', ...twitchStatus() });
}

function sendTwitchMessage(message) {
  if (!twitchWs || twitchWs.readyState !== 1 || !S.twitchChannel) return;
  twitchWs.send(`PRIVMSG #${S.twitchChannel.toLowerCase()} :${message}\r\n`);
}

function renderAnnounceTemplate(template, widget) {
  return template
    .replace(/\[death count\]/gi, widget.config.count ?? 0)
    .replace(/\[count\]/gi,       widget.config.count ?? 0)
    .replace(/\[streamername\]/gi, S.twitchChannel || '')
    .replace(/\[channel\]/gi,      S.twitchChannel || '')
    .replace(/\[label\]/gi,        widget.config.label || 'Deaths')
    .replace(/\[step\]/gi,         widget.config.step  || 1);
}

function announceDeathAction(widget, action) {
  if (!widget.config.chatAnnounce) return;
  let template = '';
  if ((action === 'increment' || action === 'decrement') && widget.config.chatAnnounceTemplate) {
    template = widget.config.chatAnnounceTemplate;
  } else if (action === 'reset' && widget.config.chatAnnounceReset) {
    template = widget.config.chatAnnounceReset;
  }
  if (template) sendTwitchMessage(renderAnnounceTemplate(template, widget));
}

// ── RA API ──────────────────────────────────────────────────────────────────────

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
      res.on('error', err   => done(reject, new Error(`Response error: ${err.message}`)));
      res.on('end', () => {
        if (res.statusCode >= 400)
          return done(reject, new Error(`RetroAchievements returned HTTP ${res.statusCode} — check your API key`));
        try { done(resolve, JSON.parse(body)); }
        catch { done(reject, new Error('RetroAchievements returned unexpected data')); }
      });
    });
    req.setTimeout(20000, () => req.destroy(new Error('Request timed out')));
    req.on('error', err => done(reject, new Error(`Network error: ${err.message}`)));
  });
}

async function fetchAchievements(gameId) {
  if (S.fetching) return;
  S.fetching = true;
  try {
    const data = await raGet('API_GetGameInfoAndUserProgress.php', { u: S.creds.username, g: gameId });
    const raw  = data.Achievements || {};
    const list = Object.entries(raw).map(([id, a]) => {
      // The RA web API doesn't currently expose per-achievement measured
      // progress, but parse every shape it might use so counters light up
      // automatically if/when it does ("7/10" string or numeric pair).
      let userProgress = parseInt(a.UserProgress || 0);
      let maxProgress  = parseInt(a.MaxProgress  || 0);
      const mp = typeof a.MeasuredProgress === 'string' && a.MeasuredProgress.match(/^(\d+)\s*\/\s*(\d+)/);
      if (mp) { userProgress = parseInt(mp[1]); maxProgress = parseInt(mp[2]); }
      return {
        id:           parseInt(id),
        title:        a.Title        || '',
        description:  a.Description  || '',
        points:       parseInt(a.Points       || 0),
        badge:        a.BadgeName    || '',
        earned:       !!(a.DateEarned || a.DateEarnedHardcore),
        earnedHard:   !!a.DateEarnedHardcore,
        dateEarned:   a.DateEarned || a.DateEarnedHardcore || '',
        userProgress, maxProgress,
        numAwarded:   parseInt(a.NumAwarded   || 0),
        displayOrder: parseInt(a.DisplayOrder || 0),
        type:         a.type || '',
      };
    });
    list.sort((a, b) => (a.earned - b.earned) || (a.displayOrder - b.displayOrder));

    // Detect fresh unlocks (only when refreshing the same game we already had)
    if (S.gameInfo.id === gameId && S.achievements.length) {
      const wasEarned = new Set(S.achievements.filter(a => a.earned).map(a => a.id));
      for (const a of list) {
        if (a.earned && !wasEarned.has(a.id)) {
          console.log(`[RA] Achievement unlocked: ${a.title} (${a.points} pts)`);
          broadcast({ type: 'achievement_unlocked', achievement: a });
          triggers.handleEvent({
            type: 'achievement',
            user: S.twitchChannel || S.creds.username,
            achievement: a.title, points: a.points, amount: a.points,
            description: a.description,
            badgeUrl: a.badge ? `https://media.retroachievements.org/Badge/${a.badge}.png` : '',
          });
        }
      }
    }

    S.achievements = list;
    S.gameInfo = {
      id:      gameId,
      title:   data.Title         || '',
      console: data.ConsoleName   || '',
      boxArt:  data.ImageBoxArt   || '',
      numAch:  parseInt(data.NumAchievements || 0),
      earned:  parseInt(data.NumAwardedToUserHardcore || data.NumAwardedToUser || 0),
      points:  parseInt(data.points_total || 0),
    };
    if (!S.display.order.length) S.display.order = list.map(a => a.id);
    S.lastAchRefresh = Date.now();
    broadcast({ type: 'achievements', gameInfo: S.gameInfo, achievements: S.achievements, display: S.display });
    console.log(`[RA] ${list.length} achievements loaded for "${S.gameInfo.title}"`);
  } catch (e) {
    console.error('[RA] Achievement fetch error:', e.message);
  } finally { S.fetching = false; }
}

async function checkNowPlaying() {
  try {
    const data = await raGet('API_GetUserSummary.php', { u: S.creds.username, g: 1 });
    const nowId    = parseInt(data.LastGameID || 0) || null;
    const nowTitle = (data.RecentlyPlayed || [])[0]?.Title || '';
    S.nowPlayingId    = nowId;
    S.nowPlayingTitle = nowTitle;
    S.lastGameCheck   = Date.now();
    // Rich Presence is the closest live-progress signal the RA API exposes
    // (e.g. "Stage 3 · 7/10 enemies") — surface it for the overlay header
    const rp = data.RichPresenceMsg || '';
    if (rp !== S.richPresence) {
      S.richPresence = rp;
      broadcast({ type: 'rich_presence', message: rp });
    }
    if (S.display.overrideNow && nowId && nowId !== S.gameId) {
      console.log(`[RA] Now playing changed → ${nowId} (${nowTitle})`);
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

// ── File upload ─────────────────────────────────────────────────────────────────

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, crypto.randomUUID() + ext);
  },
});
const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, media.MEDIA_EXT.test(file.originalname)),
});

// ── Middleware ──────────────────────────────────────────────────────────────────

app.set('trust proxy', 1); // trust Caddy's X-Forwarded-Proto so req.protocol returns 'https'
app.use(express.json({ limit: '5mb' })); // backup imports can exceed the 100kb default
app.use(express.urlencoded({ extended: false, limit: '1mb' })); // Ko-fi webhooks are form-encoded
app.use(express.static(path.join(__dirname, 'public')));

// ── Routes: pages ───────────────────────────────────────────────────────────────

app.get('/',        basicAuth, (_, res) => res.sendFile(path.join(__dirname, 'public', 'setup.html')));
app.get('/obs',               (_, res) => res.sendFile(path.join(__dirname, 'public', 'overlay.html')));
app.get('/control', basicAuth, (_, res) => res.sendFile(path.join(__dirname, 'public', 'control.html')));
app.get('/layout',  basicAuth, (_, res) => res.sendFile(path.join(__dirname, 'public', 'layout.html')));

// ── Routes: RA ──────────────────────────────────────────────────────────────────

app.post('/api/connect', basicAuth, async (req, res) => {
  const raw = req.body || {};
  const username = (raw.username || '').trim();
  const api_key  = (raw.api_key  || '').trim();
  if (!username || !api_key)
    return res.status(400).json({ ok: false, error: 'Username and API key required' });
  try {
    const data = await raGet('API_GetUserSummary.php', { u: username, g: 1 }, { username, api_key });
    if (!data || !(data.User || data.Username))
      return res.status(401).json({ ok: false, error: 'Credentials rejected by RetroAchievements' });
    S.creds           = { username, api_key };
    S.connected       = true;
    S.nowPlayingId    = parseInt(data.LastGameID || 0) || null;
    S.nowPlayingTitle = (data.RecentlyPlayed || [])[0]?.Title || '';
    S.lastGameCheck   = Date.now();
    if (raw.save) saveConfig();
    res.json({ ok: true, username: data.User || data.Username, nowPlayingId: S.nowPlayingId });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.get('/api/games', basicAuth, async (req, res) => {
  if (!S.connected) return res.status(401).json({ error: 'Not connected' });
  try {
    const games = await raGet('API_GetUserRecentlyPlayedGames.php', { u: S.creds.username, c: 50 });
    res.json({ games });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/select-game', basicAuth, (req, res) => {
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

app.get('/api/state', (req, res) => {
  const now = Date.now();
  const achTtl = Math.max(15, parseInt(S.display.refreshSec) || 60) * 1000;
  if (S.connected && (now - S.lastGameCheck)  > GAME_CHECK_TTL) checkNowPlaying().catch(console.error);
  if (S.connected && S.gameId && (now - S.lastAchRefresh) > achTtl) fetchAchievements(S.gameId).catch(console.error);
  res.json({
    gameInfo: S.gameInfo, achievements: S.achievements,
    display: S.display, widgets: S.widgets, scenes: S.scenes, connected: S.connected,
    nowPlayingId: S.nowPlayingId, nowPlayingTitle: S.nowPlayingTitle,
    richPresence: S.richPresence,
    twitch: twitchStatus(),
  });
});

app.get('/api/achievements', basicAuth, (req, res) => {
  res.json({ achievements: S.achievements, gameInfo: S.gameInfo, display: S.display });
});

app.get('/api/config', basicAuth, (req, res) => {
  res.json({
    username: S.creds.username, hasApiKey: !!S.creds.api_key,
    gameId: S.gameId, display: S.display, connected: S.connected,
    nowPlayingId: S.nowPlayingId, nowPlayingTitle: S.nowPlayingTitle,
    widgets: S.widgets,
    twitch: { ...twitchStatus(), scopes: S.twitchScopes, missingScopes: eventsub.missingScopes() },
    kofi: { configured: !!S.kofiToken, lastEvent: S.kofiLastEvent },
  });
});

app.post('/api/display', basicAuth, (req, res) => {
  Object.assign(S.display, req.body || {});
  saveConfig();
  broadcast({ type: 'achievements', display: S.display, gameInfo: S.gameInfo, achievements: S.achievements });
  res.json({ ok: true });
});

// When a drag/resize comes from /obs?scene=…, the new placement is stored as a
// scene override instead of changing the base layout.
function sceneOverrideTarget(sceneId, section, widgetId) {
  const sc = S.scenes.find(s => s.id === sceneId);
  if (!sc) return null;
  sc.overrides = sc.overrides || {};
  if (section === 'widgets') {
    sc.overrides.widgets = sc.overrides.widgets || {};
    return sc.overrides.widgets[widgetId] = sc.overrides.widgets[widgetId] || {};
  }
  return sc.overrides[section] = sc.overrides[section] || {};
}

function applyPos(target, body, map) {
  for (const [from, to] of Object.entries(map)) {
    if (typeof body[from] === 'number') target[to] = Math.round(body[from]);
  }
}

// No auth — overlay calls this during drag/resize
app.post('/api/display/position', (req, res) => {
  const body = req.body || {};
  const ov = body.scene ? sceneOverrideTarget(body.scene, 'panel') : null;
  if (ov) applyPos(ov, body, { x: 'x', y: 'y', w: 'w', h: 'h' });
  else    applyPos(S.display, body, { x: 'panelX', y: 'panelY', w: 'panelWidth', h: 'panelH' });
  saveConfig();
  res.json({ ok: true });
});

// No auth — floating Rich Presence drag
app.post('/api/display/rp-position', (req, res) => {
  const body = req.body || {};
  const ov = body.scene ? sceneOverrideTarget(body.scene, 'rp') : null;
  if (ov) applyPos(ov, body, { x: 'x', y: 'y' });
  else    applyPos(S.display, body, { x: 'rpX', y: 'rpY' });
  saveConfig();
  res.json({ ok: true });
});

app.post('/api/refresh', basicAuth, (req, res) => {
  if (!S.gameId || !S.connected) return res.status(400).json({ ok: false, error: 'No game selected' });
  S.lastAchRefresh = 0;
  fetchAchievements(S.gameId).catch(console.error);
  res.json({ ok: true });
});

// ── Routes: widgets ─────────────────────────────────────────────────────────────

app.get('/api/widgets', basicAuth, (req, res) => {
  res.json({ widgets: S.widgets });
});

app.post('/api/widgets', basicAuth, (req, res) => {
  const { type, label, x = 100, y = 100, config = {} } = req.body || {};
  if (!type || !WIDGET_SIZES[type]) return res.status(400).json({ error: 'invalid type' });
  const { w, h } = WIDGET_SIZES[type];
  const maxZ = S.widgets.reduce((m, ww) => Math.max(m, ww.zIndex || 0), 0);
  const widget = {
    id: crypto.randomUUID(),
    type, label: label || type.replace(/_/g, ' '),
    x, y, w, h,
    zIndex: maxZ + 1,
    visible: true, locked: false,
    config: { ...widgetDefaults(type), ...config },
  };
  S.widgets.push(widget);
  saveConfig();
  broadcast({ type: 'widget_add', widget });
  res.json({ ok: true, widget });
});

app.put('/api/widgets/:id', basicAuth, (req, res) => {
  const w = S.widgets.find(w => w.id === req.params.id);
  if (!w) return res.status(404).json({ error: 'not found' });
  const { config, ...rest } = req.body || {};
  Object.assign(w, rest);
  if (config) Object.assign(w.config, config);
  saveConfig();
  broadcast({ type: 'widget_update', widget: w });
  res.json({ ok: true, widget: w });
});

app.delete('/api/widgets/:id', basicAuth, (req, res) => {
  const idx = S.widgets.findIndex(w => w.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  S.widgets.splice(idx, 1);
  saveConfig();
  broadcast({ type: 'widget_delete', id: req.params.id });
  res.json({ ok: true });
});

// No auth — recent panel drag/resize
app.post('/api/display/recent-position', (req, res) => {
  const body = req.body || {};
  const ov = body.scene ? sceneOverrideTarget(body.scene, 'recent') : null;
  if (ov) applyPos(ov, body, { x: 'x', y: 'y', w: 'w', h: 'h' });
  else    applyPos(S.display, body, { x: 'recentX', y: 'recentY', w: 'recentW', h: 'recentH' });
  saveConfig();
  res.json({ ok: true });
});

// No auth — overlay drag/resize
app.post('/api/widgets/:id/position', (req, res) => {
  const w = S.widgets.find(w => w.id === req.params.id);
  if (!w) return res.status(404).json({ error: 'not found' });
  const body = req.body || {};
  const ov = body.scene ? sceneOverrideTarget(body.scene, 'widgets', w.id) : null;
  if (ov) applyPos(ov, body, { x: 'x', y: 'y', w: 'w', h: 'h' });
  else    applyPos(w, body, { x: 'x', y: 'y', w: 'w', h: 'h' });
  saveConfig();
  res.json({ ok: true });
});

app.post('/api/widgets/:id/action', basicAuth, (req, res) => {
  const w = S.widgets.find(w => w.id === req.params.id);
  if (!w) return res.status(404).json({ error: 'not found' });
  const body = req.body || {};
  applyWidgetAction(w, body);
  if (w.type === 'death_counter') announceDeathAction(w, body.action);
  saveConfig();
  broadcast({ type: 'widget_update', widget: w });
  res.json({ ok: true, widget: w });
});

// ── Routes: uploads ─────────────────────────────────────────────────────────────

app.post('/api/upload', basicAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ ok: true, src: `/uploads/${req.file.filename}` });
});

app.get('/api/uploads', basicAuth, (req, res) => {
  try {
    const files = fs.readdirSync(UPLOADS_DIR)
      .filter(f => media.MEDIA_EXT.test(f))
      .map(f => ({ filename: f, src: `/uploads/${f}`, kind: media.kindOf(f) }));
    res.json({ files });
  } catch { res.json({ files: [] }); }
});

app.delete('/api/uploads/:filename', basicAuth, (req, res) => {
  const name = path.basename(req.params.filename);
  const file = path.join(UPLOADS_DIR, name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'not found' });
  try { fs.unlinkSync(file); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Routes: scenes (alternate overlay layouts) ──────────────────────────────────

app.get('/api/scenes', basicAuth, (req, res) => res.json({ scenes: S.scenes }));

app.post('/api/scenes', basicAuth, (req, res) => {
  const name = ((req.body || {}).name || '').trim() || 'Scene ' + (S.scenes.length + 1);
  const scene = { id: crypto.randomUUID(), name, overrides: {} };
  S.scenes.push(scene);
  saveConfig();
  broadcast({ type: 'scenes', scenes: S.scenes });
  res.json({ ok: true, scene });
});

app.put('/api/scenes/:id', basicAuth, (req, res) => {
  const sc = S.scenes.find(s => s.id === req.params.id);
  if (!sc) return res.status(404).json({ error: 'not found' });
  const body = req.body || {};
  if (typeof body.name === 'string' && body.name.trim()) sc.name = body.name.trim();
  // Merge override patches per section; visible:null removes the override (inherit)
  if (body.overrides && typeof body.overrides === 'object') {
    sc.overrides = sc.overrides || {};
    for (const [section, patch] of Object.entries(body.overrides)) {
      if (section === 'widgets') {
        sc.overrides.widgets = sc.overrides.widgets || {};
        for (const [wid, wpatch] of Object.entries(patch || {})) {
          const t = sc.overrides.widgets[wid] = sc.overrides.widgets[wid] || {};
          for (const [k, v] of Object.entries(wpatch || {})) {
            if (v === null) delete t[k]; else t[k] = v;
          }
        }
      } else {
        const t = sc.overrides[section] = sc.overrides[section] || {};
        for (const [k, v] of Object.entries(patch || {})) {
          if (v === null) delete t[k]; else t[k] = v;
        }
      }
    }
  }
  saveConfig();
  broadcast({ type: 'scenes', scenes: S.scenes });
  res.json({ ok: true, scene: sc });
});

app.delete('/api/scenes/:id', basicAuth, (req, res) => {
  const idx = S.scenes.findIndex(s => s.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  S.scenes.splice(idx, 1);
  saveConfig();
  broadcast({ type: 'scenes', scenes: S.scenes });
  res.json({ ok: true });
});

// ── Routes: backup (export / import settings) ───────────────────────────────────

// Excludes RA credentials and Twitch tokens — those stay machine-local.
app.get('/api/backup', basicAuth, (req, res) => {
  const stamp = new Date().toISOString().slice(0, 10);
  res.set('Content-Disposition', `attachment; filename="overlay-backup-${stamp}.json"`);
  res.json({
    raOverlayBackup: 1,
    exportedAt: new Date().toISOString(),
    gameId: S.gameId,
    display: S.display,
    widgets: S.widgets,
    triggers: S.triggers,
    mediaFolders: S.mediaFolders,
    scenes: S.scenes,
  });
});

app.post('/api/backup/import', basicAuth, (req, res) => {
  const b = req.body || {};
  if (!b.raOverlayBackup) return res.status(400).json({ error: 'Not an overlay backup file' });
  try {
    if (b.display && typeof b.display === 'object') Object.assign(S.display, b.display);
    if (Array.isArray(b.widgets))      S.widgets      = b.widgets;
    if (Array.isArray(b.triggers))     S.triggers     = b.triggers.map(t => triggers.normalizeTrigger(t));
    if (Array.isArray(b.mediaFolders)) S.mediaFolders = b.mediaFolders.filter(f => f && f.id && f.path);
    if (Array.isArray(b.scenes))       S.scenes       = b.scenes.filter(s => s && s.id && s.name);
    if (b.gameId) { S.gameId = parseInt(b.gameId) || S.gameId; S.lastAchRefresh = 0; }
    saveConfig();
    eventsub.refresh();
    broadcast(getFullState());
    res.json({ ok: true, counts: { widgets: S.widgets.length, triggers: S.triggers.length, scenes: S.scenes.length } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Routes: triggers & alerts ───────────────────────────────────────────────────

app.get('/api/triggers', basicAuth, (req, res) => {
  res.json({ triggers: S.triggers, missingScopes: eventsub.missingScopes() });
});

app.post('/api/triggers', basicAuth, (req, res) => {
  const trigger = triggers.normalizeTrigger(req.body || {});
  S.triggers.push(trigger);
  saveConfig();
  eventsub.refresh();
  res.json({ ok: true, trigger });
});

app.put('/api/triggers/:id', basicAuth, (req, res) => {
  const idx = S.triggers.findIndex(t => t.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  S.triggers[idx] = triggers.normalizeTrigger(req.body || {}, S.triggers[idx]);
  saveConfig();
  eventsub.refresh();
  res.json({ ok: true, trigger: S.triggers[idx] });
});

app.delete('/api/triggers/:id', basicAuth, (req, res) => {
  const idx = S.triggers.findIndex(t => t.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  S.triggers.splice(idx, 1);
  saveConfig();
  eventsub.refresh();
  res.json({ ok: true });
});

app.post('/api/triggers/:id/test', basicAuth, (req, res) => {
  const t = S.triggers.find(t => t.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  triggers.fireTest(t);
  res.json({ ok: true });
});

// Drag-positioning: show a persistent, draggable sample of this alert on the
// overlay (outside the queue). Drag end saves via /position; ✓ or the setup
// page's Done button broadcasts preview-end.
app.post('/api/triggers/:id/preview', basicAuth, (req, res) => {
  const t = S.triggers.find(t => t.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  broadcast({ type: 'alert_preview', alert: triggers.buildTestAlert(t), triggerId: t.id });
  res.json({ ok: true });
});

// No auth — saved from the overlay while dragging the preview (like widget drag)
app.post('/api/triggers/:id/position', (req, res) => {
  const t = S.triggers.find(t => t.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const { x, y } = req.body || {};
  if (typeof x !== 'number' || typeof y !== 'number') return res.status(400).json({ error: 'x and y required' });
  t.actions.position = {
    ...t.actions.position,
    mode: 'custom',
    x: Math.min(100, Math.max(0, Math.round(x * 10) / 10)),
    y: Math.min(100, Math.max(0, Math.round(y * 10) / 10)),
  };
  saveConfig();
  res.json({ ok: true, position: t.actions.position });
});

// No auth — the ✓ button on the overlay preview also ends positioning
app.post('/api/alerts/preview-end', (req, res) => {
  broadcast({ type: 'alert_preview_end' });
  res.json({ ok: true });
});

// No auth — overlay reports the playing alert's sound/video finished
app.post('/api/alerts/finished', (req, res) => {
  const { alertId } = req.body || {};
  if (alertId) triggers.mediaFinished(alertId);
  res.json({ ok: true });
});

app.get('/api/alerts/queue', basicAuth, (req, res) => res.json(triggers.getQueueState()));
app.post('/api/alerts/skip',  basicAuth, (req, res) => { triggers.skip();  res.json({ ok: true }); });
app.post('/api/alerts/clear', basicAuth, (req, res) => { triggers.clear(); res.json({ ok: true }); });

// ── Routes: media library ───────────────────────────────────────────────────────

app.get('/api/media', basicAuth, (req, res) => {
  res.json({ media: media.listMedia() });
});

app.get('/api/media/folders', basicAuth, (req, res) => {
  res.json({ folders: S.mediaFolders });
});

app.post('/api/media/folders', basicAuth, (req, res) => {
  try {
    const folder = media.addFolder((req.body || {}).path, (req.body || {}).label);
    saveConfig();
    res.json({ ok: true, folder });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/media/folders/:id', basicAuth, (req, res) => {
  const idx = S.mediaFolders.findIndex(f => f.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  S.mediaFolders.splice(idx, 1);
  saveConfig();
  res.json({ ok: true });
});

// Public: the overlay loads alert media from here without auth.
app.get('/media/:folderId/:filename', (req, res) => media.serveFolderFile(req, res));

// ── Routes: Ko-fi webhook ───────────────────────────────────────────────────────
// Ko-fi POSTs form-encoded with a single `data` field containing JSON:
// { verification_token, message_id, timestamp, type, is_public, from_name,
//   message, amount, currency, url, email, is_subscription_payment,
//   is_first_subscription_payment, kofi_transaction_id, tier_name, shop_items }
// type ∈ Donation | Subscription | Commission | Shop Order.
// Set the URL at https://ko-fi.com/manage/webhooks and paste the verification
// token into the setup page — events without a matching token are rejected.

app.post('/webhooks/kofi', (req, res) => {
  let d = req.body || {};
  if (typeof d.data === 'string') {
    try { d = JSON.parse(d.data); }
    catch { return res.status(400).json({ error: 'Malformed data field' }); }
  }
  if (!S.kofiToken) {
    console.warn('[Ko-fi] Webhook received but no verification token is configured — ignoring. Set it in the setup page.');
    return res.status(403).json({ error: 'No verification token configured' });
  }
  if (d.verification_token !== S.kofiToken) {
    console.warn('[Ko-fi] Webhook rejected: verification token mismatch');
    return res.status(401).json({ error: 'Bad verification token' });
  }

  // Respect the supporter's privacy choice: hide name and message unless public
  const isPublic = d.is_public !== false;
  const evt = {
    type:     'kofi',
    user:     (isPublic && d.from_name) ? d.from_name : 'Anonymous',
    amount:   d.amount || '0',
    currency: d.currency || '',
    message:  isPublic ? (d.message || '') : '',
    tier:     d.tier_name || '',
    kofiType: d.type || 'Donation',
  };
  S.kofiLastEvent = { at: Date.now(), type: evt.kofiType, from: evt.user, amount: evt.amount, currency: evt.currency };
  console.log(`[Ko-fi] ${evt.kofiType}: ${evt.user} — ${evt.amount} ${evt.currency}`);
  triggers.handleEvent(evt);
  res.json({ ok: true });
});

app.post('/api/kofi', basicAuth, (req, res) => {
  S.kofiToken = ((req.body || {}).token || '').trim();
  saveConfig();
  res.json({ ok: true, configured: !!S.kofiToken });
});

// ── Routes: Twitch OAuth 2.0 ────────────────────────────────────────────────────

const TWITCH_AUTH_URL  = 'https://id.twitch.tv/oauth2/authorize';
const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const TWITCH_SCOPE     = 'chat:read chat:edit channel:read:redemptions channel:read:subscriptions moderator:read:followers';

let oauthState = null;

// ── Twitch token lifecycle ──────────────────────────────────────────────────────
// User access tokens expire after ~4h; EventSub and Helix calls need a live one.

async function refreshTwitchToken() {
  const clientId     = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!S.twitchRefreshToken || !clientId || !clientSecret)
    throw new Error('No refresh token or Twitch app credentials');
  const res = await fetch(TWITCH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId, client_secret: clientSecret,
      grant_type: 'refresh_token', refresh_token: S.twitchRefreshToken,
    }),
  });
  const data = await res.json();
  if (!data.access_token) {
    S.twitchNeedsReauth = true;
    broadcast({ type: 'twitch_status', ...twitchStatus() });
    throw new Error('Token refresh rejected: ' + JSON.stringify(data));
  }
  S.twitchAccessToken  = data.access_token;
  S.twitchRefreshToken = data.refresh_token || S.twitchRefreshToken;
  S.twitchNeedsReauth  = false;
  saveConfig();
  console.log('[Twitch] Access token refreshed');
  // IRC keeps an old token's session alive, but if we're disconnected, reconnect now
  if (!S.twitchConnected && S.twitchChannel) {
    connectTwitch(S.twitchChannel, S.twitchAccessToken).catch(e =>
      console.error('[Twitch] Reconnect after refresh failed:', e.message));
  }
  return S.twitchAccessToken;
}

// Twitch requires tokens to be validated hourly. Also records granted scopes
// so the setup page can prompt for re-auth when alerts need new ones.
async function validateTwitchToken() {
  if (!S.twitchAccessToken) return false;
  try {
    const res = await fetch('https://id.twitch.tv/oauth2/validate', {
      headers: { 'Authorization': `OAuth ${S.twitchAccessToken}` },
    });
    if (res.status === 401) {
      await refreshTwitchToken();
      return validateTwitchToken();
    }
    const data = await res.json();
    S.twitchScopes = data.scopes || [];
    if (!S.twitchUserId && data.user_id) S.twitchUserId = data.user_id;
    const missing = eventsub.missingScopes();
    if (missing.length) {
      S.twitchNeedsReauth = true;
      console.warn('[Twitch] Token is missing scopes needed by alerts:', missing.join(', '));
      broadcast({ type: 'twitch_status', ...twitchStatus() });
    }
    return true;
  } catch (e) {
    console.error('[Twitch] Token validation failed:', e.message);
    return false;
  }
}

async function helixRequest(method, apiPath, body) {
  // TWITCH_HELIX_URL override lets the Twitch CLI mock server stand in for Helix
  const doFetch = () => fetch((process.env.TWITCH_HELIX_URL || 'https://api.twitch.tv/helix') + apiPath, {
    method,
    headers: {
      'Authorization': `Bearer ${S.twitchAccessToken}`,
      'Client-Id':     process.env.TWITCH_CLIENT_ID,
      'Content-Type':  'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let res = await doFetch();
  if (res.status === 401) {
    await refreshTwitchToken();
    res = await doFetch();
  }
  return res;
}

// Step 1 — redirect to Twitch
app.get('/auth/twitch', basicAuth, (req, res) => {
  const clientId = process.env.TWITCH_CLIENT_ID;
  if (!clientId) {
    return res.status(400).send(
      '<h2>TWITCH_CLIENT_ID not set</h2>' +
      '<p>Add it to your .env file. See the Twitch setup card in the admin page for instructions.</p>' +
      '<a href="/">← Back to setup</a>'
    );
  }
  oauthState = crypto.randomBytes(16).toString('hex');
  const redirectUri = `${req.protocol}://${req.get('host')}/auth/twitch/callback`;
  const url = new URL(TWITCH_AUTH_URL);
  url.searchParams.set('client_id',     clientId);
  url.searchParams.set('redirect_uri',  redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope',         TWITCH_SCOPE);
  url.searchParams.set('state',         oauthState);
  url.searchParams.set('force_verify',  'true');
  res.redirect(url.toString());
});

// Step 2 — Twitch redirects back with a code
app.get('/auth/twitch/callback', basicAuth, async (req, res) => {
  const { code, state, error, error_description } = req.query;
  const fail = msg => res.send(`<h2>Twitch auth failed</h2><p>${msg}</p><a href="/">← Back to setup</a>`);

  if (error)         return fail(`${error}: ${error_description || ''}`);
  if (state !== oauthState) return fail('State mismatch — possible CSRF. Try again.');
  if (!code)         return fail('No code received from Twitch.');

  const clientId     = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  const redirectUri  = `${req.protocol}://${req.get('host')}/auth/twitch/callback`;

  if (!clientSecret) return fail('TWITCH_CLIENT_SECRET not set in .env');

  try {
    // Exchange code → access token
    const tokenRes = await fetch(TWITCH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret,
                                  code, grant_type: 'authorization_code', redirect_uri: redirectUri }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return fail('Token exchange failed: ' + JSON.stringify(tokenData));

    // Get the authenticated user's login name
    const userRes = await fetch('https://api.twitch.tv/helix/users', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}`, 'Client-Id': clientId },
    });
    const userData = await userRes.json();
    const channel  = userData.data?.[0]?.login;
    if (!channel) return fail('Could not retrieve Twitch username.');

    // Store token in memory (persisted to config for auto-reconnect)
    S.twitchChannel      = channel;
    S.twitchUserId       = userData.data[0].id;
    S.twitchAccessToken  = tokenData.access_token;
    S.twitchRefreshToken = tokenData.refresh_token || null;
    S.twitchScopes       = tokenData.scope || [];
    S.twitchNeedsReauth  = false;
    saveConfig();

    await connectTwitch(channel, tokenData.access_token);
    eventsub.refresh();
    res.redirect('/?twitch=connected');
  } catch (e) {
    fail(e.message);
  }
});

// Manual disconnect
app.post('/api/twitch/disconnect', basicAuth, async (req, res) => {
  eventsub.stop();
  await disconnectTwitch();
  S.twitchAccessToken  = null;
  S.twitchRefreshToken = null;
  S.twitchUserId       = null;
  S.twitchScopes       = [];
  S.twitchNeedsReauth  = false;
  saveConfig();
  res.json({ ok: true });
});

// ── Start ───────────────────────────────────────────────────────────────────────

triggers.init({ getState: () => S, saveConfig, broadcast, checkPermission });
media.init({ getState: () => S, uploadsDir: UPLOADS_DIR });
eventsub.init({
  getState: () => S,
  handleEvent: evt => triggers.handleEvent(evt),
  helixRequest,
  onAuthRevoked: () => {
    S.twitchNeedsReauth = true;
    broadcast({ type: 'twitch_status', ...twitchStatus() });
  },
});

loadConfig();
if (S.creds.username && S.creds.api_key) {
  S.connected = true;
  console.log(`[startup] Loaded credentials for ${S.creds.username}`);
  if (S.gameId) {
    console.log(`[startup] Loading achievements for game ${S.gameId}…`);
    fetchAchievements(S.gameId).catch(console.error);
  }
}

const server = app.listen(PORT, () => {
  const local = `http://localhost:${PORT}`;
  console.log('\n  ┌─────────────────────────────────────────┐');
  console.log('  │   RA Achievement Overlay                │');
  console.log('  ├─────────────────────────────────────────┤');
  console.log(`  │  Setup:   ${local}/        │`);
  console.log(`  │  OBS URL: ${local}/obs     │`);
  console.log(`  │  Control: ${local}/control │`);
  console.log('  └─────────────────────────────────────────┘\n');
});

wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  ws.send(JSON.stringify(getFullState()));
});

// Auto-reconnect Twitch using saved OAuth token (preferred) or env token (fallback)
async function autoConnectTwitch() {
  const token = S.twitchAccessToken || process.env.TWITCH_TOKEN;
  if (token && S.twitchChannel) {
    try {
      await connectTwitch(S.twitchChannel, token);
    } catch (e) {
      console.error('[Twitch] Auto-connect failed:', e.message);
      // Saved token likely expired — refresh (which reconnects IRC) and carry on
      if (S.twitchAccessToken && S.twitchRefreshToken && /login failed/i.test(e.message)) {
        try { await refreshTwitchToken(); }
        catch (e2) { console.error('[Twitch] Token refresh failed:', e2.message); }
      }
    }
  }
  // EventSub is independent of IRC — start it even if chat couldn't connect
  if (S.twitchAccessToken) {
    await validateTwitchToken();
    eventsub.refresh();
  }
}
autoConnectTwitch();

// Twitch requires hourly token validation; this also catches expiry → refresh
setInterval(() => { validateTwitchToken().catch(() => {}); }, 60 * 60 * 1000);

if ((!process.env.SETUP_USER || !process.env.SETUP_PASS) && S.mediaFolders.length) {
  console.warn('[security] SETUP_USER/SETUP_PASS not set — anyone who can reach this server can manage media folders. Set them in .env if the server is exposed.');
}

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

const triggersLib = require('./lib/triggers');
const eventsubLib = require('./lib/eventsub');
const mediaLib    = require('./lib/media');
const userStore   = require('./lib/users');

const app  = express();
const PORT = parseInt(process.env.PORT || '7890');

const UPLOADS_ROOT = path.join(__dirname, 'public', 'uploads');
const RA_BASE      = 'https://retroachievements.org/API';

const GAME_CHECK_TTL = 60_000; // achievement refresh interval is display.refreshSec

// ── Per-user state ──────────────────────────────────────────────────────────────
// Every account gets a full, isolated overlay: its own RA credentials, Twitch
// connection, Ko-fi token, widgets, triggers, scenes, uploads, alert queue.
// User pages live under /u/<username>/…; the legacy root URLs (/, /obs, …)
// map to the admin account so existing OBS sources keep working.

function defaultState() {
  return {
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
    scenes: [],
    elementPresets: [],   // saved widgets/triggers for reuse across layouts
    twitchConnected:  false,
    twitchChannel:    '',
    twitchAccessToken:  null,
    twitchRefreshToken: null,
    twitchUserId:       null,
    twitchScopes:       [],
    twitchNeedsReauth:  false,
    kofiToken:          '',
    kofiLastEvent:      null,
    lastAchRefresh:  0,
    lastGameCheck:   0,
    nowPlayingId:    null,
    nowPlayingTitle: '',
    richPresence:    '',
    connected:       false,
    fetching:        false,
  };
}

const users       = new Map(); // id -> ctx
const usersByName = new Map(); // username -> ctx

function adminCtx() {
  for (const u of users.values()) if (u.isAdmin) return u;
  return users.values().next().value;
}

function createUserCtx(record) {
  const u = { ...record };
  u.S          = defaultState();
  u.configFile = userStore.configFile(u.id);
  u.uploadsDir = u.uploadsRel ? path.join(UPLOADS_ROOT, u.uploadsRel) : UPLOADS_ROOT;
  u.uploadsUrl = u.uploadsRel ? `/uploads/${u.uploadsRel}` : '/uploads';
  u.base       = `/u/${u.username}`;
  u.twitchWs   = null;
  u.undoStack  = [];
  u.oauthState = null;
  fs.mkdirSync(u.uploadsDir, { recursive: true });

  u.saveConfig = () => saveConfig(u);
  u.broadcast  = msg => broadcastTo(u, msg);
  u.media      = mediaLib.createMedia({ getState: () => u.S, uploadsDir: u.uploadsDir, uploadsUrl: u.uploadsUrl });
  u.triggers   = triggersLib.createEngine({
    getState: () => u.S, saveConfig: u.saveConfig, broadcast: u.broadcast, checkPermission,
  });
  u.eventsub   = eventsubLib.createEventSub({
    getState: () => u.S,
    handleEvent: evt => u.triggers.handleEvent(evt),
    helixRequest: (method, apiPath, body) => helixRequest(u, method, apiPath, body),
    onAuthRevoked: () => {
      u.S.twitchNeedsReauth = true;
      u.broadcast({ type: 'twitch_status', ...twitchStatus(u) });
    },
  });

  loadConfig(u);
  users.set(u.id, u);
  usersByName.set(u.username, u);
  return u;
}

// ── Config ──────────────────────────────────────────────────────────────────────

function loadConfig(u) {
  const S = u.S;
  if (fs.existsSync(u.configFile)) {
    try {
      const saved = JSON.parse(fs.readFileSync(u.configFile, 'utf8'));
      if (saved.creds)         Object.assign(S.creds,   saved.creds);
      if (saved.display)       Object.assign(S.display, saved.display);
      if (saved.gameId)        S.gameId = saved.gameId;
      if (saved.widgets)       S.widgets = saved.widgets;
      if (saved.triggers)      S.triggers = saved.triggers.map(t => triggersLib.normalizeTrigger(t));
      if (saved.mediaFolders)  S.mediaFolders = saved.mediaFolders;
      if (saved.scenes)        S.scenes = saved.scenes;
      if (saved.elementPresets) S.elementPresets = saved.elementPresets;
      if (saved.twitchChannel)      S.twitchChannel      = saved.twitchChannel;
      if (saved.twitchAccessToken)  S.twitchAccessToken  = saved.twitchAccessToken;
      if (saved.twitchRefreshToken) S.twitchRefreshToken = saved.twitchRefreshToken;
      if (saved.twitchUserId)       S.twitchUserId       = saved.twitchUserId;
      if (saved.twitchScopes)       S.twitchScopes       = saved.twitchScopes;
      if (saved.kofiToken)          S.kofiToken          = saved.kofiToken;
    } catch (e) { console.error(`[config] Load error for ${u.username}:`, e.message); }
  }
  if (u.isAdmin) { // legacy env fallbacks apply to the admin account only
    if (process.env.RA_USERNAME)    S.creds.username = S.creds.username || process.env.RA_USERNAME;
    if (process.env.RA_API_KEY)     S.creds.api_key  = S.creds.api_key  || process.env.RA_API_KEY;
    if (process.env.TWITCH_CHANNEL) S.twitchChannel  = S.twitchChannel  || process.env.TWITCH_CHANNEL;
  }
}

function saveConfig(u) {
  const S = u.S;
  try {
    fs.mkdirSync(path.dirname(u.configFile), { recursive: true });
    fs.writeFileSync(u.configFile, JSON.stringify({
      creds: S.creds, display: S.display, gameId: S.gameId,
      widgets: S.widgets, triggers: S.triggers, mediaFolders: S.mediaFolders,
      scenes: S.scenes, elementPresets: S.elementPresets,
      twitchChannel: S.twitchChannel,
      twitchAccessToken: S.twitchAccessToken, twitchRefreshToken: S.twitchRefreshToken,
      twitchUserId: S.twitchUserId, twitchScopes: S.twitchScopes,
      kofiToken: S.kofiToken,
    }, null, 2));
  } catch (e) { console.error(`[config] Save error for ${u.username}:`, e.message); }
}

// ── Auth ────────────────────────────────────────────────────────────────────────

function safeEqual(a, b) {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  if (ba.length !== bb.length) { crypto.timingSafeEqual(ba, ba); return false; }
  return crypto.timingSafeEqual(ba, bb);
}

function parseBasicHeader(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return null;
  try {
    const d = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const i = d.indexOf(':');
    return { user: i >= 0 ? d.slice(0, i) : d, pass: i >= 0 ? d.slice(i + 1) : '' };
  } catch { return null; }
}

// Resolve the requesting identity: a user ctx, the env master credentials, or null.
function authIdentity(req) {
  const cred = parseBasicHeader(req);
  if (!cred) return null;
  const envUser = process.env.SETUP_USER || '', envPass = process.env.SETUP_PASS || '';
  if (envUser && envPass && safeEqual(cred.user, envUser) && safeEqual(cred.pass, envPass))
    return { envMaster: true, isAdmin: true };
  const ctx = usersByName.get(cred.user.toLowerCase());
  if (ctx && ctx.passwordHash && userStore.verifyPassword(cred.pass, ctx.passwordHash)) return ctx;
  return null;
}

function challenge(res) {
  res.set('WWW-Authenticate', 'Basic realm="RA Overlay"');
  return res.status(401).send('Authentication required');
}

// Access to req.u's protected pages/APIs: that user, any admin, or the env master.
function userAuth(req, res, next) {
  const u = req.u;
  // Legacy open mode: a passwordless admin with no env credentials set
  if (u.isAdmin && !u.passwordHash && !process.env.SETUP_USER) return next();
  const id = authIdentity(req);
  if (id && (id.envMaster || id.isAdmin || id.id === u.id)) return next();
  challenge(res);
}

function adminAuth(req, res, next) {
  const a = adminCtx();
  if (a && a.isAdmin && !a.passwordHash && !process.env.SETUP_USER) return next(); // legacy open mode
  const id = authIdentity(req);
  if (id && id.isAdmin) return next();
  challenge(res);
}

// ── WebSocket ────────────────────────────────────────────────────────────────────

let wss;

function broadcastTo(u, msg) {
  if (!wss) return;
  const data = JSON.stringify(msg);
  wss.clients.forEach(ws => { if (ws.readyState === 1 && ws.uid === u.id) ws.send(data); });
}

function twitchStatus(u) {
  const S = u.S;
  return { connected: S.twitchConnected, channel: S.twitchChannel, needsReauth: S.twitchNeedsReauth };
}

function getFullState(u) {
  const S = u.S;
  return {
    type: 'state',
    gameInfo: S.gameInfo, achievements: S.achievements,
    display: S.display, widgets: S.widgets, scenes: S.scenes,
    connected: S.connected,
    nowPlayingId: S.nowPlayingId, nowPlayingTitle: S.nowPlayingTitle,
    richPresence: S.richPresence,
    twitch: twitchStatus(u),
    // Queue summaries + the alert currently on screen (so a client connecting
    // mid-alert can render it). Full trigger configs stay out of this payload —
    // it goes to the unauthenticated overlay.
    alerts: { ...u.triggers.getQueueState(), playingAlert: u.triggers.getPlayingAlert() },
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

function handleChatCommand(u, msg, tags) {
  const lower = msg.trim().toLowerCase();
  for (const widget of u.S.widgets) {
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
    announceDeathAction(u, widget, action);
    saveConfig(u);
    u.broadcast({ type: 'widget_update', widget });
  }
}

function onTwitchMessage(u, tags, message) {
  handleChatCommand(u, message, tags);
  if (tags.bits) {
    u.triggers.handleEvent({
      type:   'cheer',
      user:   tags['display-name'] || tags.username || '',
      amount: parseInt(tags.bits) || 0,
      message,
    });
  }
  u.triggers.checkChatTriggers(message, tags);
  if (u.S.widgets.some(w => w.type === 'chat' && w.visible)) {
    u.broadcast({
      type:      'chat_message',
      username:  tags['display-name'] || tags.username || 'anon',
      color:     tags.color || null,
      message,
      badges:    tags.badges || {},
      timestamp: Date.now(),
    });
  }
}

function connectTwitch(u, channel, token) {
  return new Promise((resolve, reject) => {
    disconnectTwitch(u);
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
          u.S.twitchConnected = true;
          u.S.twitchChannel   = channel;
          u.broadcast({ type: 'twitch_status', ...twitchStatus(u) });
          console.log(`[Twitch:${u.username}] Connected to #${channel}`);
          resolve();
        }

        // PRIVMSG — chat message (skip own messages to prevent loops)
        const pm = rest.match(/^:(\S+)!\S+ PRIVMSG #\S+ :(.+)$/);
        if (pm && pm[1].toLowerCase() !== channel.toLowerCase()) {
          onTwitchMessage(u, tags, pm[2]);
        }
      }
    });

    sock.on('close', () => {
      if (u.twitchWs === sock) u.twitchWs = null;
      if (u.S.twitchConnected) {
        u.S.twitchConnected = false;
        u.broadcast({ type: 'twitch_status', ...twitchStatus(u) });
        console.log(`[Twitch:${u.username}] Disconnected`);
      }
      if (!joined) reject(new Error('Connection closed before joining channel'));
    });

    sock.on('error', err => {
      console.error(`[Twitch:${u.username}] WebSocket error:`, err.message);
      if (!joined) reject(err);
    });

    u.twitchWs = sock;
  });
}

function disconnectTwitch(u) {
  if (!u.twitchWs) return;
  try { u.twitchWs.close(); } catch {}
  u.twitchWs = null;
  u.S.twitchConnected = false;
  u.broadcast({ type: 'twitch_status', ...twitchStatus(u) });
}

function sendTwitchMessage(u, message) {
  if (!u.twitchWs || u.twitchWs.readyState !== 1 || !u.S.twitchChannel) return;
  u.twitchWs.send(`PRIVMSG #${u.S.twitchChannel.toLowerCase()} :${message}\r\n`);
}

function renderAnnounceTemplate(u, template, widget) {
  return template
    .replace(/\[death count\]/gi, widget.config.count ?? 0)
    .replace(/\[count\]/gi,       widget.config.count ?? 0)
    .replace(/\[streamername\]/gi, u.S.twitchChannel || '')
    .replace(/\[channel\]/gi,      u.S.twitchChannel || '')
    .replace(/\[label\]/gi,        widget.config.label || 'Deaths')
    .replace(/\[step\]/gi,         widget.config.step  || 1);
}

function announceDeathAction(u, widget, action) {
  if (!widget.config.chatAnnounce) return;
  let template = '';
  if ((action === 'increment' || action === 'decrement') && widget.config.chatAnnounceTemplate) {
    template = widget.config.chatAnnounceTemplate;
  } else if (action === 'reset' && widget.config.chatAnnounceReset) {
    template = widget.config.chatAnnounceReset;
  }
  if (template) sendTwitchMessage(u, renderAnnounceTemplate(u, template, widget));
}

// ── RA API ──────────────────────────────────────────────────────────────────────

function raGet(endpoint, params, creds) {
  const { username, api_key } = creds;
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

async function fetchAchievements(u, gameId) {
  const S = u.S;
  if (S.fetching) return;
  S.fetching = true;
  try {
    const data = await raGet('API_GetGameInfoAndUserProgress.php', { u: S.creds.username, g: gameId }, S.creds);
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
          console.log(`[RA:${u.username}] Achievement unlocked: ${a.title} (${a.points} pts)`);
          u.broadcast({ type: 'achievement_unlocked', achievement: a });
          u.triggers.handleEvent({
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
    u.broadcast({ type: 'achievements', gameInfo: S.gameInfo, achievements: S.achievements, display: S.display });
    console.log(`[RA:${u.username}] ${list.length} achievements loaded for "${S.gameInfo.title}"`);
  } catch (e) {
    console.error(`[RA:${u.username}] Achievement fetch error:`, e.message);
  } finally { S.fetching = false; }
}

async function checkNowPlaying(u) {
  const S = u.S;
  try {
    const data = await raGet('API_GetUserSummary.php', { u: S.creds.username, g: 1 }, S.creds);
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
      u.broadcast({ type: 'rich_presence', message: rp });
    }
    if (S.display.overrideNow && nowId && nowId !== S.gameId) {
      console.log(`[RA:${u.username}] Now playing changed → ${nowId} (${nowTitle})`);
      S.gameId = nowId;
      S.display.order  = [];
      S.display.pinned = [];
      S.lastAchRefresh = 0;
    }
  } catch (e) {
    S.lastGameCheck = Date.now();
    console.error(`[RA:${u.username}] Now-playing check error:`, e.message);
  }
}

// ── Twitch token lifecycle ──────────────────────────────────────────────────────
// User access tokens expire after ~4h; EventSub and Helix calls need a live one.

const TWITCH_AUTH_URL  = 'https://id.twitch.tv/oauth2/authorize';
const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const TWITCH_SCOPE     = 'chat:read chat:edit channel:read:redemptions channel:read:subscriptions moderator:read:followers';

async function refreshTwitchToken(u) {
  const S = u.S;
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
    u.broadcast({ type: 'twitch_status', ...twitchStatus(u) });
    throw new Error('Token refresh rejected: ' + JSON.stringify(data));
  }
  S.twitchAccessToken  = data.access_token;
  S.twitchRefreshToken = data.refresh_token || S.twitchRefreshToken;
  S.twitchNeedsReauth  = false;
  saveConfig(u);
  console.log(`[Twitch:${u.username}] Access token refreshed`);
  // IRC keeps an old token's session alive, but if we're disconnected, reconnect now
  if (!S.twitchConnected && S.twitchChannel) {
    connectTwitch(u, S.twitchChannel, S.twitchAccessToken).catch(e =>
      console.error(`[Twitch:${u.username}] Reconnect after refresh failed:`, e.message));
  }
  return S.twitchAccessToken;
}

// Twitch requires tokens to be validated hourly. Also records granted scopes
// so the setup page can prompt for re-auth when alerts need new ones.
async function validateTwitchToken(u) {
  const S = u.S;
  if (!S.twitchAccessToken) return false;
  try {
    const res = await fetch('https://id.twitch.tv/oauth2/validate', {
      headers: { 'Authorization': `OAuth ${S.twitchAccessToken}` },
    });
    if (res.status === 401) {
      await refreshTwitchToken(u);
      return validateTwitchToken(u);
    }
    const data = await res.json();
    S.twitchScopes = data.scopes || [];
    if (!S.twitchUserId && data.user_id) S.twitchUserId = data.user_id;
    const missing = u.eventsub.missingScopes();
    if (missing.length) {
      S.twitchNeedsReauth = true;
      console.warn(`[Twitch:${u.username}] Token is missing scopes needed by alerts:`, missing.join(', '));
      u.broadcast({ type: 'twitch_status', ...twitchStatus(u) });
    }
    return true;
  } catch (e) {
    console.error(`[Twitch:${u.username}] Token validation failed:`, e.message);
    return false;
  }
}

async function helixRequest(u, method, apiPath, body) {
  // TWITCH_HELIX_URL override lets the Twitch CLI mock server stand in for Helix
  const doFetch = () => fetch((process.env.TWITCH_HELIX_URL || 'https://api.twitch.tv/helix') + apiPath, {
    method,
    headers: {
      'Authorization': `Bearer ${u.S.twitchAccessToken}`,
      'Client-Id':     process.env.TWITCH_CLIENT_ID,
      'Content-Type':  'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let res = await doFetch();
  if (res.status === 401) {
    await refreshTwitchToken(u);
    res = await doFetch();
  }
  return res;
}

// ── Undo for deletions ──────────────────────────────────────────────────────────
// Per-user in-memory stack (last 15) — see /api/undo.

const UNDO_MAX = 15;

function pushUndo(u, kind, item, index, label) {
  u.undoStack.push({ kind, item, index, label, at: Date.now() });
  if (u.undoStack.length > UNDO_MAX) u.undoStack.shift();
}

// ── File upload ─────────────────────────────────────────────────────────────────

fs.mkdirSync(UPLOADS_ROOT, { recursive: true });

const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, req.u.uploadsDir),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, crypto.randomUUID() + ext);
  },
});
const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, mediaLib.MEDIA_EXT.test(file.originalname)),
});

// ── Middleware ──────────────────────────────────────────────────────────────────

app.set('trust proxy', 1); // trust Caddy's X-Forwarded-Proto so req.protocol returns 'https'
app.use(express.json({ limit: '5mb' })); // backup imports can exceed the 100kb default
app.use(express.urlencoded({ extended: false, limit: '1mb' })); // Ko-fi webhooks are form-encoded
app.use(express.static(path.join(__dirname, 'public')));

// ── Global routes (not user-prefixed) ───────────────────────────────────────────

// Ko-fi webhook — per-user URL /webhooks/kofi/<userId>; bare /webhooks/kofi is
// the legacy admin URL. Ko-fi POSTs form-encoded with a `data` field of JSON;
// see README for the payload shape. Token mismatch → 401.
function kofiWebhook(u, req, res) {
  let d = req.body || {};
  if (typeof d.data === 'string') {
    try { d = JSON.parse(d.data); }
    catch { return res.status(400).json({ error: 'Malformed data field' }); }
  }
  if (!u.S.kofiToken) {
    console.warn(`[Ko-fi:${u.username}] Webhook received but no verification token is configured — ignoring.`);
    return res.status(403).json({ error: 'No verification token configured' });
  }
  if (d.verification_token !== u.S.kofiToken) {
    console.warn(`[Ko-fi:${u.username}] Webhook rejected: verification token mismatch`);
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
  u.S.kofiLastEvent = { at: Date.now(), type: evt.kofiType, from: evt.user, amount: evt.amount, currency: evt.currency };
  console.log(`[Ko-fi:${u.username}] ${evt.kofiType}: ${evt.user} — ${evt.amount} ${evt.currency}`);
  u.triggers.handleEvent(evt);
  res.json({ ok: true });
}

app.post('/webhooks/kofi/:userId', (req, res) => {
  const u = users.get(req.params.userId);
  if (!u) return res.status(404).json({ error: 'Unknown user' });
  kofiWebhook(u, req, res);
});
app.post('/webhooks/kofi', (req, res) => kofiWebhook(adminCtx(), req, res));

// Local-folder media — public (overlays are unauthenticated); folder ids are
// uuids, looked up across all users.
app.get('/media/:folderId/:filename', (req, res) => {
  let folder = null;
  for (const u of users.values()) {
    folder = u.S.mediaFolders.find(f => f.id === req.params.folderId);
    if (folder) break;
  }
  mediaLib.serveFolderFile(folder, req, res);
});

// Twitch OAuth callback — single registered redirect URI for all users; the
// state nonce carries which user started the flow.
const oauthStates = new Map(); // state -> { userId, at }

app.get('/auth/twitch/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;
  const entry = oauthStates.get(state);
  const back  = entry ? (users.get(entry.userId)?.base ?? '') : '';
  const fail  = msg => res.send(`<h2>Twitch auth failed</h2><p>${msg}</p><a href="${back}/">← Back to setup</a>`);

  if (error)  return fail(`${error}: ${error_description || ''}`);
  if (!entry || Date.now() - entry.at > 10 * 60_000) return fail('State mismatch or expired — try again.');
  oauthStates.delete(state);
  const u = users.get(entry.userId);
  if (!u)     return fail('Unknown user.');
  if (!code)  return fail('No code received from Twitch.');

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

    const S = u.S;
    S.twitchChannel      = channel;
    S.twitchUserId       = userData.data[0].id;
    S.twitchAccessToken  = tokenData.access_token;
    S.twitchRefreshToken = tokenData.refresh_token || null;
    S.twitchScopes       = tokenData.scope || [];
    S.twitchNeedsReauth  = false;
    saveConfig(u);

    await connectTwitch(u, channel, tokenData.access_token);
    u.eventsub.refresh();
    res.redirect(`${u.isAdmin ? '' : u.base}/?twitch=connected`);
  } catch (e) {
    fail(e.message);
  }
});

// ── User management (admin only) ────────────────────────────────────────────────

app.get('/api/users', adminAuth, (req, res) => {
  res.json({
    users: [...users.values()].map(u => ({
      id: u.id, username: u.username, displayName: u.displayName,
      isAdmin: u.isAdmin, hasPassword: !!u.passwordHash,
      base: u.isAdmin ? '' : u.base,
      twitchChannel: u.S.twitchChannel || null,
      raUser: u.S.creds.username || null,
    })),
  });
});

app.post('/api/users', adminAuth, (req, res) => {
  try {
    const records = userStore.loadRecords() || [];
    const rec = userStore.createRecord(records, req.body || {});
    const ctx = createUserCtx(rec);
    res.json({ ok: true, user: { id: ctx.id, username: ctx.username, displayName: ctx.displayName, base: ctx.base } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/users/:id/password', adminAuth, (req, res) => {
  const u = users.get(req.params.id);
  if (!u) return res.status(404).json({ error: 'not found' });
  const password = (req.body || {}).password || '';
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  u.passwordHash = userStore.hashPassword(password);
  const records = userStore.loadRecords() || [];
  const rec = records.find(r => r.id === u.id);
  if (rec) { rec.passwordHash = u.passwordHash; userStore.saveRecords(records); }
  res.json({ ok: true });
});

app.delete('/api/users/:id', adminAuth, (req, res) => {
  const u = users.get(req.params.id);
  if (!u) return res.status(404).json({ error: 'not found' });
  if (u.isAdmin) return res.status(400).json({ error: 'Cannot delete the admin account' });
  u.eventsub.stop();
  disconnectTwitch(u);
  users.delete(u.id);
  usersByName.delete(u.username);
  const records = (userStore.loadRecords() || []).filter(r => r.id !== u.id);
  userStore.saveRecords(records);
  // Config + uploads stay on disk as a manual-recovery backup
  res.json({ ok: true });
});

// ── Per-user routes ─────────────────────────────────────────────────────────────
// Mounted at /u/:username/* for everyone, and at the root for the admin account
// (so the original single-user URLs keep working).

const ur = express.Router({ mergeParams: true });

// Pages
ur.get('/',        userAuth, (_, res) => res.sendFile(path.join(__dirname, 'public', 'setup.html')));
ur.get('/obs',               (_, res) => res.sendFile(path.join(__dirname, 'public', 'overlay.html')));
ur.get('/control', userAuth, (_, res) => res.sendFile(path.join(__dirname, 'public', 'control.html')));
ur.get('/layout',  userAuth, (_, res) => res.sendFile(path.join(__dirname, 'public', 'layout.html')));

// RA
ur.post('/api/connect', userAuth, async (req, res) => {
  const u = req.u, S = u.S;
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
    if (raw.save) saveConfig(u);
    res.json({ ok: true, username: data.User || data.Username, nowPlayingId: S.nowPlayingId });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

ur.get('/api/games', userAuth, async (req, res) => {
  const S = req.u.S;
  if (!S.connected) return res.status(401).json({ error: 'Not connected' });
  try {
    const games = await raGet('API_GetUserRecentlyPlayedGames.php', { u: S.creds.username, c: 50 }, S.creds);
    res.json({ games });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

ur.post('/api/select-game', userAuth, (req, res) => {
  const u = req.u, S = u.S;
  const { game_id, save } = req.body || {};
  if (!game_id) return res.status(400).json({ ok: false, error: 'game_id required' });
  const gid = parseInt(game_id);
  if (S.gameId !== gid) {
    S.gameId = gid;
    S.display.order  = [];
    S.display.pinned = [];
    S.lastAchRefresh = 0;
    fetchAchievements(u, gid).catch(console.error);
  }
  if (save) saveConfig(u);
  res.json({ ok: true });
});

ur.get('/api/state', (req, res) => {
  const u = req.u, S = u.S;
  const now = Date.now();
  const achTtl = Math.max(15, parseInt(S.display.refreshSec) || 60) * 1000;
  if (S.connected && (now - S.lastGameCheck)  > GAME_CHECK_TTL) checkNowPlaying(u).catch(console.error);
  if (S.connected && S.gameId && (now - S.lastAchRefresh) > achTtl) fetchAchievements(u, S.gameId).catch(console.error);
  res.json({
    gameInfo: S.gameInfo, achievements: S.achievements,
    display: S.display, widgets: S.widgets, scenes: S.scenes, connected: S.connected,
    nowPlayingId: S.nowPlayingId, nowPlayingTitle: S.nowPlayingTitle,
    richPresence: S.richPresence,
    twitch: twitchStatus(u),
  });
});

ur.get('/api/achievements', userAuth, (req, res) => {
  const S = req.u.S;
  res.json({ achievements: S.achievements, gameInfo: S.gameInfo, display: S.display });
});

ur.get('/api/config', userAuth, (req, res) => {
  const u = req.u, S = u.S;
  res.json({
    username: S.creds.username, hasApiKey: !!S.creds.api_key,
    gameId: S.gameId, display: S.display, connected: S.connected,
    nowPlayingId: S.nowPlayingId, nowPlayingTitle: S.nowPlayingTitle,
    widgets: S.widgets,
    twitch: { ...twitchStatus(u), scopes: S.twitchScopes, missingScopes: u.eventsub.missingScopes() },
    kofi: { configured: !!S.kofiToken, lastEvent: S.kofiLastEvent },
    user: { id: u.id, username: u.username, displayName: u.displayName, isAdmin: u.isAdmin, base: u.base },
  });
});

ur.post('/api/display', userAuth, (req, res) => {
  const u = req.u, S = u.S;
  Object.assign(S.display, req.body || {});
  saveConfig(u);
  u.broadcast({ type: 'achievements', display: S.display, gameInfo: S.gameInfo, achievements: S.achievements });
  res.json({ ok: true });
});

// When a drag/resize comes from /obs?scene=…, the new placement is stored as a
// scene override instead of changing the base layout.
function sceneOverrideTarget(S, sceneId, section, widgetId) {
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
ur.post('/api/display/position', (req, res) => {
  const u = req.u, body = req.body || {};
  const ov = body.scene ? sceneOverrideTarget(u.S, body.scene, 'panel') : null;
  if (ov) applyPos(ov, body, { x: 'x', y: 'y', w: 'w', h: 'h' });
  else    applyPos(u.S.display, body, { x: 'panelX', y: 'panelY', w: 'panelWidth', h: 'panelH' });
  saveConfig(u);
  res.json({ ok: true });
});

// No auth — floating Rich Presence drag
ur.post('/api/display/rp-position', (req, res) => {
  const u = req.u, body = req.body || {};
  const ov = body.scene ? sceneOverrideTarget(u.S, body.scene, 'rp') : null;
  if (ov) applyPos(ov, body, { x: 'x', y: 'y' });
  else    applyPos(u.S.display, body, { x: 'rpX', y: 'rpY' });
  saveConfig(u);
  res.json({ ok: true });
});

// No auth — recent panel drag/resize
ur.post('/api/display/recent-position', (req, res) => {
  const u = req.u, body = req.body || {};
  const ov = body.scene ? sceneOverrideTarget(u.S, body.scene, 'recent') : null;
  if (ov) applyPos(ov, body, { x: 'x', y: 'y', w: 'w', h: 'h' });
  else    applyPos(u.S.display, body, { x: 'recentX', y: 'recentY', w: 'recentW', h: 'recentH' });
  saveConfig(u);
  res.json({ ok: true });
});

ur.post('/api/refresh', userAuth, (req, res) => {
  const u = req.u, S = u.S;
  if (!S.gameId || !S.connected) return res.status(400).json({ ok: false, error: 'No game selected' });
  S.lastAchRefresh = 0;
  fetchAchievements(u, S.gameId).catch(console.error);
  res.json({ ok: true });
});

// Widgets
ur.get('/api/widgets', userAuth, (req, res) => {
  res.json({ widgets: req.u.S.widgets });
});

ur.post('/api/widgets', userAuth, (req, res) => {
  const u = req.u, S = u.S;
  const { type, label, x = 100, y = 100, config = {}, w, h, visible } = req.body || {};
  if (!type || !WIDGET_SIZES[type]) return res.status(400).json({ error: 'invalid type' });
  const size = WIDGET_SIZES[type];
  const maxZ = S.widgets.reduce((m, ww) => Math.max(m, ww.zIndex || 0), 0);
  const widget = {
    id: crypto.randomUUID(),
    type, label: label || type.replace(/_/g, ' '),
    x, y, w: parseInt(w) || size.w, h: parseInt(h) || size.h,
    zIndex: maxZ + 1,
    visible: visible !== false, locked: false,
    config: { ...widgetDefaults(type), ...config },
  };
  S.widgets.push(widget);
  saveConfig(u);
  u.broadcast({ type: 'widget_add', widget });
  res.json({ ok: true, widget });
});

ur.put('/api/widgets/:id', userAuth, (req, res) => {
  const u = req.u;
  const w = u.S.widgets.find(w => w.id === req.params.id);
  if (!w) return res.status(404).json({ error: 'not found' });
  const { config, ...rest } = req.body || {};
  Object.assign(w, rest);
  if (config) Object.assign(w.config, config);
  saveConfig(u);
  u.broadcast({ type: 'widget_update', widget: w });
  res.json({ ok: true, widget: w });
});

ur.delete('/api/widgets/:id', userAuth, (req, res) => {
  const u = req.u;
  const idx = u.S.widgets.findIndex(w => w.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  const [widget] = u.S.widgets.splice(idx, 1);
  pushUndo(u, 'widget', widget, idx, widget.label || widget.type);
  saveConfig(u);
  u.broadcast({ type: 'widget_delete', id: req.params.id });
  res.json({ ok: true, undo: { kind: 'widget', label: widget.label || widget.type } });
});

// No auth — overlay drag/resize
ur.post('/api/widgets/:id/position', (req, res) => {
  const u = req.u;
  const w = u.S.widgets.find(w => w.id === req.params.id);
  if (!w) return res.status(404).json({ error: 'not found' });
  const body = req.body || {};
  const ov = body.scene ? sceneOverrideTarget(u.S, body.scene, 'widgets', w.id) : null;
  if (ov) applyPos(ov, body, { x: 'x', y: 'y', w: 'w', h: 'h' });
  else    applyPos(w, body, { x: 'x', y: 'y', w: 'w', h: 'h' });
  saveConfig(u);
  res.json({ ok: true });
});

ur.post('/api/widgets/:id/action', userAuth, (req, res) => {
  const u = req.u;
  const w = u.S.widgets.find(w => w.id === req.params.id);
  if (!w) return res.status(404).json({ error: 'not found' });
  const body = req.body || {};
  applyWidgetAction(w, body);
  if (w.type === 'death_counter') announceDeathAction(u, w, body.action);
  saveConfig(u);
  u.broadcast({ type: 'widget_update', widget: w });
  res.json({ ok: true, widget: w });
});

// Uploads
ur.post('/api/upload', userAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ ok: true, src: `${req.u.uploadsUrl}/${req.file.filename}` });
});

ur.get('/api/uploads', userAuth, (req, res) => {
  const u = req.u;
  try {
    const files = fs.readdirSync(u.uploadsDir)
      .filter(f => mediaLib.MEDIA_EXT.test(f))
      .map(f => ({ filename: f, src: `${u.uploadsUrl}/${f}`, kind: mediaLib.kindOf(f) }));
    res.json({ files });
  } catch { res.json({ files: [] }); }
});

ur.delete('/api/uploads/:filename', userAuth, (req, res) => {
  const u = req.u;
  const name = path.basename(req.params.filename);
  const file = path.join(u.uploadsDir, name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'not found' });
  try { fs.unlinkSync(file); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Scenes
ur.get('/api/scenes', userAuth, (req, res) => res.json({ scenes: req.u.S.scenes }));

ur.post('/api/scenes', userAuth, (req, res) => {
  const u = req.u, S = u.S;
  const name = ((req.body || {}).name || '').trim() || 'Scene ' + (S.scenes.length + 1);
  const scene = { id: crypto.randomUUID(), name, overrides: {} };
  S.scenes.push(scene);
  saveConfig(u);
  u.broadcast({ type: 'scenes', scenes: S.scenes });
  res.json({ ok: true, scene });
});

ur.put('/api/scenes/:id', userAuth, (req, res) => {
  const u = req.u, S = u.S;
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
  saveConfig(u);
  u.broadcast({ type: 'scenes', scenes: S.scenes });
  res.json({ ok: true, scene: sc });
});

ur.delete('/api/scenes/:id', userAuth, (req, res) => {
  const u = req.u, S = u.S;
  const idx = S.scenes.findIndex(s => s.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  const [scene] = S.scenes.splice(idx, 1);
  pushUndo(u, 'scene', scene, idx, scene.name);
  saveConfig(u);
  u.broadcast({ type: 'scenes', scenes: S.scenes });
  res.json({ ok: true, undo: { kind: 'scene', label: scene.name } });
});

// Backup — excludes RA credentials and Twitch tokens
ur.get('/api/backup', userAuth, (req, res) => {
  const S = req.u.S;
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
    elementPresets: S.elementPresets,
  });
});

ur.post('/api/backup/import', userAuth, (req, res) => {
  const u = req.u, S = u.S;
  const b = req.body || {};
  if (!b.raOverlayBackup) return res.status(400).json({ error: 'Not an overlay backup file' });
  try {
    if (b.display && typeof b.display === 'object') Object.assign(S.display, b.display);
    if (Array.isArray(b.widgets))      S.widgets      = b.widgets;
    if (Array.isArray(b.triggers))     S.triggers     = b.triggers.map(t => triggersLib.normalizeTrigger(t));
    if (Array.isArray(b.mediaFolders)) S.mediaFolders = b.mediaFolders.filter(f => f && f.id && f.path);
    if (Array.isArray(b.scenes))       S.scenes       = b.scenes.filter(s => s && s.id && s.name);
    if (Array.isArray(b.elementPresets)) S.elementPresets = b.elementPresets.filter(x => x && x.id && x.kind);
    if (b.gameId) { S.gameId = parseInt(b.gameId) || S.gameId; S.lastAchRefresh = 0; }
    saveConfig(u);
    u.eventsub.refresh();
    u.broadcast(getFullState(u));
    res.json({ ok: true, counts: { widgets: S.widgets.length, triggers: S.triggers.length, scenes: S.scenes.length } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Undo
ur.get('/api/undo', userAuth, (req, res) => {
  const stack = req.u.undoStack;
  const top = stack[stack.length - 1];
  res.json({ available: stack.length, latest: top ? { kind: top.kind, label: top.label, at: top.at } : null });
});

ur.post('/api/undo', userAuth, (req, res) => {
  const u = req.u, S = u.S;
  const entry = u.undoStack.pop();
  if (!entry) return res.status(404).json({ error: 'Nothing to undo' });
  const insert = (arr) => arr.splice(Math.min(entry.index, arr.length), 0, entry.item);
  switch (entry.kind) {
    case 'widget':
      insert(S.widgets);
      u.broadcast({ type: 'widget_add', widget: entry.item });
      break;
    case 'trigger':
      insert(S.triggers);
      u.eventsub.refresh();
      break;
    case 'scene':
      insert(S.scenes);
      u.broadcast({ type: 'scenes', scenes: S.scenes });
      break;
    case 'mediaFolder':
      insert(S.mediaFolders);
      break;
  }
  saveConfig(u);
  res.json({ ok: true, kind: entry.kind, label: entry.label, remaining: u.undoStack.length });
});

// Triggers & alerts
ur.get('/api/triggers', userAuth, (req, res) => {
  res.json({ triggers: req.u.S.triggers, missingScopes: req.u.eventsub.missingScopes() });
});

ur.post('/api/triggers', userAuth, (req, res) => {
  const u = req.u;
  const trigger = triggersLib.normalizeTrigger(req.body || {});
  u.S.triggers.push(trigger);
  saveConfig(u);
  u.eventsub.refresh();
  res.json({ ok: true, trigger });
});

ur.put('/api/triggers/:id', userAuth, (req, res) => {
  const u = req.u;
  const idx = u.S.triggers.findIndex(t => t.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  u.S.triggers[idx] = triggersLib.normalizeTrigger(req.body || {}, u.S.triggers[idx]);
  saveConfig(u);
  u.eventsub.refresh();
  res.json({ ok: true, trigger: u.S.triggers[idx] });
});

ur.delete('/api/triggers/:id', userAuth, (req, res) => {
  const u = req.u;
  const idx = u.S.triggers.findIndex(t => t.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  const [trigger] = u.S.triggers.splice(idx, 1);
  pushUndo(u, 'trigger', trigger, idx, trigger.name);
  saveConfig(u);
  u.eventsub.refresh();
  res.json({ ok: true, undo: { kind: 'trigger', label: trigger.name } });
});

ur.post('/api/triggers/:id/test', userAuth, (req, res) => {
  const t = req.u.S.triggers.find(t => t.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  // dry run: hand back the rendered alert payload (for in-editor previews)
  // without putting it through the live queue
  if ((req.body || {}).dry) return res.json({ ok: true, alert: req.u.triggers.buildTestAlert(t) });
  req.u.triggers.fireTest(t);
  res.json({ ok: true });
});

// ── Element presets (saved widgets/triggers for reuse) ──────────────────────────

ur.get('/api/presets', userAuth, (req, res) => res.json({ presets: req.u.S.elementPresets }));

ur.post('/api/presets', userAuth, (req, res) => {
  const u = req.u;
  const { kind, name, payload } = req.body || {};
  if (!['widget', 'trigger'].includes(kind) || !payload)
    return res.status(400).json({ error: 'kind (widget|trigger) and payload required' });
  const preset = {
    id: crypto.randomUUID(),
    kind,
    name: (name || '').trim() || 'Preset ' + (u.S.elementPresets.length + 1),
    payload,
    createdAt: Date.now(),
  };
  u.S.elementPresets.push(preset);
  saveConfig(u);
  res.json({ ok: true, preset });
});

ur.delete('/api/presets/:id', userAuth, (req, res) => {
  const u = req.u;
  const idx = u.S.elementPresets.findIndex(p => p.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  u.S.elementPresets.splice(idx, 1);
  saveConfig(u);
  res.json({ ok: true });
});

// Drag-positioning: show a persistent, draggable sample of this alert on the
// overlay (outside the queue).
ur.post('/api/triggers/:id/preview', userAuth, (req, res) => {
  const u = req.u;
  const t = u.S.triggers.find(t => t.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  u.broadcast({ type: 'alert_preview', alert: u.triggers.buildTestAlert(t), triggerId: t.id });
  res.json({ ok: true });
});

// No auth — saved from the overlay while dragging the preview (like widget drag)
ur.post('/api/triggers/:id/position', (req, res) => {
  const u = req.u;
  const t = u.S.triggers.find(t => t.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const { x, y } = req.body || {};
  if (typeof x !== 'number' || typeof y !== 'number') return res.status(400).json({ error: 'x and y required' });
  t.actions.position = {
    ...t.actions.position,
    mode: 'custom',
    x: Math.min(100, Math.max(0, Math.round(x * 10) / 10)),
    y: Math.min(100, Math.max(0, Math.round(y * 10) / 10)),
  };
  saveConfig(u);
  res.json({ ok: true, position: t.actions.position });
});

// No auth — the ✓ button on the overlay preview also ends positioning
ur.post('/api/alerts/preview-end', (req, res) => {
  req.u.broadcast({ type: 'alert_preview_end' });
  res.json({ ok: true });
});

// No auth — overlay reports the playing alert's sound/video finished
ur.post('/api/alerts/finished', (req, res) => {
  const { alertId } = req.body || {};
  if (alertId) req.u.triggers.mediaFinished(alertId);
  res.json({ ok: true });
});

ur.get('/api/alerts/queue', userAuth, (req, res) => res.json(req.u.triggers.getQueueState()));
ur.post('/api/alerts/skip',  userAuth, (req, res) => { req.u.triggers.skip();  res.json({ ok: true }); });
ur.post('/api/alerts/clear', userAuth, (req, res) => { req.u.triggers.clear(); res.json({ ok: true }); });

// Media library
ur.get('/api/media', userAuth, (req, res) => {
  res.json({ media: req.u.media.listMedia() });
});

ur.get('/api/media/folders', userAuth, (req, res) => {
  res.json({ folders: req.u.S.mediaFolders });
});

ur.post('/api/media/folders', userAuth, (req, res) => {
  try {
    const folder = req.u.media.addFolder((req.body || {}).path, (req.body || {}).label);
    saveConfig(req.u);
    res.json({ ok: true, folder });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

ur.delete('/api/media/folders/:id', userAuth, (req, res) => {
  const u = req.u;
  const idx = u.S.mediaFolders.findIndex(f => f.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  const [folder] = u.S.mediaFolders.splice(idx, 1);
  pushUndo(u, 'mediaFolder', folder, idx, folder.label);
  saveConfig(u);
  res.json({ ok: true, undo: { kind: 'mediaFolder', label: folder.label } });
});

// Ko-fi token
ur.post('/api/kofi', userAuth, (req, res) => {
  const u = req.u;
  u.S.kofiToken = ((req.body || {}).token || '').trim();
  saveConfig(u);
  res.json({ ok: true, configured: !!u.S.kofiToken });
});

// Twitch OAuth start — state nonce carries the user through the shared callback
ur.get('/auth/twitch', userAuth, (req, res) => {
  const u = req.u;
  const clientId = process.env.TWITCH_CLIENT_ID;
  if (!clientId) {
    return res.status(400).send(
      '<h2>TWITCH_CLIENT_ID not set</h2>' +
      '<p>Add it to your .env file. See the Twitch setup card in the admin page for instructions.</p>' +
      `<a href="${u.base}/">← Back to setup</a>`
    );
  }
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.set(state, { userId: u.id, at: Date.now() });
  for (const [k, v] of oauthStates) if (Date.now() - v.at > 10 * 60_000) oauthStates.delete(k);
  const redirectUri = `${req.protocol}://${req.get('host')}/auth/twitch/callback`;
  const url = new URL(TWITCH_AUTH_URL);
  url.searchParams.set('client_id',     clientId);
  url.searchParams.set('redirect_uri',  redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope',         TWITCH_SCOPE);
  url.searchParams.set('state',         state);
  url.searchParams.set('force_verify',  'true');
  res.redirect(url.toString());
});

ur.post('/api/twitch/disconnect', userAuth, async (req, res) => {
  const u = req.u, S = u.S;
  u.eventsub.stop();
  disconnectTwitch(u);
  S.twitchAccessToken  = null;
  S.twitchRefreshToken = null;
  S.twitchUserId       = null;
  S.twitchScopes       = [];
  S.twitchNeedsReauth  = false;
  saveConfig(u);
  res.json({ ok: true });
});

// Mount: /u/<username>/* for everyone…
app.use('/u/:username', (req, res, next) => {
  const u = usersByName.get((req.params.username || '').toLowerCase());
  if (!u) return res.status(404).send('Unknown user');
  req.u = u;
  next();
}, ur);

// …and the bare root for the admin account (legacy URLs keep working)
app.use((req, res, next) => {
  req.u = adminCtx();
  if (!req.u) return res.status(500).send('No users configured');
  next();
}, ur);

// ── Start ───────────────────────────────────────────────────────────────────────

const records = userStore.bootstrap();
for (const rec of records) createUserCtx(rec);

for (const u of users.values()) {
  if (u.S.creds.username && u.S.creds.api_key) {
    u.S.connected = true;
    console.log(`[startup] ${u.username}: RA credentials loaded (${u.S.creds.username})`);
    if (u.S.gameId) fetchAchievements(u, u.S.gameId).catch(console.error);
  }
}

const server = app.listen(PORT, () => {
  const local = `http://localhost:${PORT}`;
  console.log('\n  ┌─────────────────────────────────────────────────┐');
  console.log('  │   RA Achievement Overlay (multi-user)           │');
  console.log('  ├─────────────────────────────────────────────────┤');
  console.log(`  │  Admin setup: ${local}/`);
  console.log(`  │  OBS URL:     ${local}/obs`);
  console.log(`  │  Per user:    ${local}/u/<username>/`);
  console.log('  └─────────────────────────────────────────────────┘\n');
  console.log('  Users:', [...users.values()].map(u => u.username + (u.isAdmin ? ' (admin)' : '')).join(', '));
});

// WebSocket — the upgrade path picks the user (/u/<name>…); bare paths = admin
wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  const m = (req.url || '').match(/^\/u\/([^/?]+)/);
  const u = (m && usersByName.get(m[1].toLowerCase())) || adminCtx();
  if (!u) { ws.close(); return; }
  ws.uid = u.id;
  ws.send(JSON.stringify(getFullState(u)));
});

// Auto-reconnect Twitch per user using saved OAuth tokens
async function autoConnectTwitch(u) {
  const S = u.S;
  const token = S.twitchAccessToken || (u.isAdmin ? process.env.TWITCH_TOKEN : null);
  if (token && S.twitchChannel) {
    try {
      await connectTwitch(u, S.twitchChannel, token);
    } catch (e) {
      console.error(`[Twitch:${u.username}] Auto-connect failed:`, e.message);
      if (S.twitchAccessToken && S.twitchRefreshToken && /login failed/i.test(e.message)) {
        try { await refreshTwitchToken(u); }
        catch (e2) { console.error(`[Twitch:${u.username}] Token refresh failed:`, e2.message); }
      }
    }
  }
  // EventSub is independent of IRC — start it even if chat couldn't connect
  if (S.twitchAccessToken) {
    await validateTwitchToken(u);
    u.eventsub.refresh();
  }
}
for (const u of users.values()) autoConnectTwitch(u);

// Twitch requires hourly token validation; this also catches expiry → refresh
setInterval(() => {
  for (const u of users.values()) validateTwitchToken(u).catch(() => {});
}, 60 * 60 * 1000);

const a = adminCtx();
if (a && !a.passwordHash && !process.env.SETUP_USER) {
  console.warn('[security] The admin account has no password and SETUP_USER/SETUP_PASS are not set — anyone who can reach this server has full access. Set them in .env if the server is exposed.');
}

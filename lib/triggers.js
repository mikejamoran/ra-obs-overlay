'use strict';

// Trigger engine + alert queue.
// Triggers map Twitch events (channel point redeems, cheers, chat commands,
// subs, raids, follows) to overlay alerts (image / audio / text combos).
// Alerts play one at a time; the server owns the queue and timing so every
// connected overlay/control client stays in sync.

const crypto = require('crypto');

let deps = null; // { getState, saveConfig, broadcast, checkPermission }

function init(d) { deps = d; }

const SOURCE_TYPES = ['channel_points', 'cheer', 'chat_command', 'subscription', 'raid', 'follow', 'achievement'];
const MAX_QUEUE    = 50;
const ANIM_GRACE_MS = 500; // extra time for the out-animation before the next alert

// ── Trigger shape ───────────────────────────────────────────────────────────────

function triggerDefaults() {
  return {
    name: 'New Alert',
    enabled: true,
    source: {
      type: 'chat_command',
      // channel_points
      rewardId: '', rewardName: '',
      // cheer
      matchType: 'min', bits: 100,
      // chat_command
      command: '!alert', permission: 'everyone', allowedUsers: '',
      cooldownGlobalSec: 0, cooldownUserSec: 0,
      // subscription
      tier: 'any', includeResubs: true, includeGifts: true,
      // raid
      minViewers: 0,
      // achievement (RetroAchievements unlock)
      minPoints: 0,
    },
    actions: {
      image: { enabled: false, src: '', widthPx: 300, fit: 'contain',
               loop: false, muted: false, volume: 1 },   // loop/muted/volume apply to video files
      audio: { enabled: false, src: '', volume: 0.8 },
      text:  { enabled: true, template: '{user} triggered an alert!',
               fontSize: 32, color: '#e6edf3', bgColor: '#0d0d0d', bgOpacity: 0.85,
               fontFamily: '' },
      durationMs: 6000,
      durationMode: 'fixed',  // 'media' = end when sound/video finishes (durationMs = max)
      position: { mode: 'preset', preset: 'center', x: 50, y: 20 },
      animation: { in: 'fade', out: 'fade' },
    },
  };
}

// Merge a partial trigger onto defaults (one level deep per section).
function normalizeTrigger(raw, existing) {
  const base = existing || triggerDefaults();
  const t = {
    id:      (existing && existing.id) || raw.id || crypto.randomUUID(),
    name:    typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : base.name,
    enabled: raw.enabled !== undefined ? !!raw.enabled : base.enabled,
    source:  { ...base.source,  ...(raw.source  || {}) },
    actions: {
      image: { ...base.actions.image, ...((raw.actions || {}).image || {}) },
      audio: { ...base.actions.audio, ...((raw.actions || {}).audio || {}) },
      text:  { ...base.actions.text,  ...((raw.actions || {}).text  || {}) },
      durationMs: (raw.actions && raw.actions.durationMs !== undefined)
                    ? Math.max(500, parseInt(raw.actions.durationMs) || 6000)
                    : base.actions.durationMs,
      durationMode: (raw.actions && raw.actions.durationMode === 'media') ? 'media'
                    : (raw.actions && raw.actions.durationMode === 'fixed') ? 'fixed'
                    : (base.actions.durationMode || 'fixed'),
      position:  { ...base.actions.position,  ...((raw.actions || {}).position  || {}) },
      animation: { ...base.actions.animation, ...((raw.actions || {}).animation || {}) },
    },
  };
  if (!SOURCE_TYPES.includes(t.source.type)) t.source.type = 'chat_command';
  return t;
}

// ── Template rendering ──────────────────────────────────────────────────────────

function renderTemplate(tpl, evt) {
  return String(tpl || '')
    .replace(/\{user\}/gi,    evt.user    ?? '')
    .replace(/\{amount\}/gi,  evt.amount  ?? '')
    .replace(/\{message\}/gi, evt.message ?? '')
    .replace(/\{reward\}/gi,  evt.reward  ?? '')
    .replace(/\{tier\}/gi,    evt.tier ? String(evt.tier).replace('1000', '1').replace('2000', '2').replace('3000', '3') : '')
    .replace(/\{viewers\}/gi, evt.viewers ?? '')
    .replace(/\{achievement\}/gi, evt.achievement ?? '')
    .replace(/\{points\}/gi,      evt.points ?? '')
    .replace(/\{description\}/gi, evt.description ?? '')
    .replace(/\{game\}/gi,    deps.getState().gameInfo?.title || '')
    .replace(/\{channel\}/gi, deps.getState().twitchChannel || '');
}

function buildAlert(trigger, evt) {
  const a = trigger.actions;
  // Image src supports {badge} → the unlocked achievement's badge image,
  // so achievement alerts can show the real badge without picking a file.
  const imageSrc = (a.image.src || '').replace(/\{badge\}/gi, evt.badgeUrl || '').trim();
  return {
    id:          crypto.randomUUID(),
    triggerId:   trigger.id,
    triggerName: trigger.name,
    image: (a.image.enabled && imageSrc)
      ? { src: imageSrc, widthPx: a.image.widthPx, fit: a.image.fit,
          loop: !!a.image.loop, muted: !!a.image.muted, volume: a.image.volume ?? 1 } : null,
    audio: (a.audio.enabled && a.audio.src)
      ? { src: a.audio.src, volume: a.audio.volume } : null,
    text: a.text.enabled
      ? { text: renderTemplate(a.text.template, evt),
          fontSize: a.text.fontSize, color: a.text.color,
          bgColor: a.text.bgColor, bgOpacity: a.text.bgOpacity,
          fontFamily: a.text.fontFamily } : null,
    durationMs:   a.durationMs,
    durationMode: a.durationMode || 'fixed',
    position:   a.position,
    animation:  a.animation,
    meta: { user: evt.user || '', amount: evt.amount ?? '', reward: evt.reward || '' },
  };
}

// ── Alert queue ─────────────────────────────────────────────────────────────────

let queue     = [];
let playing   = null;
let playTimer = null;

function alertSummary(a) {
  return { id: a.id, triggerName: a.triggerName, user: a.meta.user };
}

function getQueueState() {
  return {
    playing: playing ? alertSummary(playing) : null,
    queue:   queue.map(alertSummary),
  };
}

// Full payload of the alert currently on screen (for clients connecting mid-alert).
function getPlayingAlert() { return playing; }

function broadcastQueue() {
  deps.broadcast({ type: 'alert_queue', ...getQueueState() });
}

function enqueue(alert) {
  if (queue.length >= MAX_QUEUE) {
    console.warn('[alerts] Queue full, dropping alert from trigger:', alert.triggerName);
    return;
  }
  queue.push(alert);
  if (!playing) playNext(); else broadcastQueue();
}

function playNext() {
  if (playing || !queue.length) { broadcastQueue(); return; }
  playing = queue.shift();
  deps.broadcast({ type: 'alert_play', alert: playing });
  broadcastQueue();
  playTimer = setTimeout(advance, playing.durationMs + ANIM_GRACE_MS);
}

function advance() {
  clearTimeout(playTimer);
  playTimer = null;
  if (playing) {
    deps.broadcast({ type: 'alert_stop', alertId: playing.id });
    playing = null;
  }
  if (queue.length) playNext(); else broadcastQueue();
}

function skip() { if (playing) advance(); }

function clear() {
  queue = [];
  broadcastQueue();
}

// ── Cooldowns (in-memory; cleared on restart) ───────────────────────────────────

const cooldowns = new Map(); // triggerId -> { lastGlobal: ts, perUser: Map<username, ts> }

function onCooldown(trigger, username) {
  const cd = cooldowns.get(trigger.id);
  if (!cd) return false;
  const now = Date.now();
  const g = (trigger.source.cooldownGlobalSec || 0) * 1000;
  if (g && now - cd.lastGlobal < g) return true;
  const u = (trigger.source.cooldownUserSec || 0) * 1000;
  if (u && cd.perUser.has(username) && now - cd.perUser.get(username) < u) return true;
  return false;
}

function markCooldown(trigger, username) {
  let cd = cooldowns.get(trigger.id);
  if (!cd) { cd = { lastGlobal: 0, perUser: new Map() }; cooldowns.set(trigger.id, cd); }
  cd.lastGlobal = Date.now();
  cd.perUser.set(username, cd.lastGlobal);
}

// ── Event matching ──────────────────────────────────────────────────────────────

function fire(trigger, evt) {
  console.log(`[alerts] Trigger "${trigger.name}" fired (${evt.type}${evt.user ? ' from ' + evt.user : ''})`);
  enqueue(buildAlert(trigger, evt));
}

function matchesSource(trigger, evt) {
  const s = trigger.source;
  switch (s.type) {
    case 'channel_points':
      if (s.rewardId) return evt.rewardId === s.rewardId;
      if (s.rewardName) return (evt.reward || '').toLowerCase() === s.rewardName.toLowerCase().trim();
      return false;
    case 'subscription':
      if (s.tier !== 'any' && String(evt.tier) !== s.tier) return false;
      if (evt.isResub && !s.includeResubs) return false;
      if (evt.isGift  && !s.includeGifts)  return false;
      return true;
    case 'raid':
      return (evt.viewers || 0) >= (s.minViewers || 0);
    case 'follow':
      return true;
    case 'achievement':
      return (evt.points || 0) >= (s.minPoints || 0);
    default:
      return false;
  }
}

// evt = { type, user, amount, message, reward, rewardId, tier, viewers, isResub, isGift }
function handleEvent(evt) {
  const S = deps.getState();
  const candidates = S.triggers.filter(t => t.enabled && t.source.type === evt.type);
  if (!candidates.length) return;

  if (evt.type === 'cheer') {
    // Exact-amount triggers win; otherwise the highest min-bits tier ≤ amount.
    const amount = parseInt(evt.amount) || 0;
    let chosen = candidates.find(t => t.source.matchType === 'exact' && (parseInt(t.source.bits) || 0) === amount);
    if (!chosen) {
      chosen = candidates
        .filter(t => t.source.matchType !== 'exact' && amount >= (parseInt(t.source.bits) || 0))
        .sort((a, b) => (parseInt(b.source.bits) || 0) - (parseInt(a.source.bits) || 0))[0];
    }
    if (chosen) fire(chosen, evt);
    return;
  }

  for (const t of candidates) {
    if (matchesSource(t, evt)) fire(t, evt);
  }
}

// Called for every chat message; matches !command triggers.
function checkChatTriggers(message, tags) {
  const S = deps.getState();
  const lower    = message.trim().toLowerCase();
  const username = (tags['display-name'] || tags.username || '').toLowerCase();
  for (const t of S.triggers) {
    if (!t.enabled || t.source.type !== 'chat_command') continue;
    const cmd = (t.source.command || '').toLowerCase().trim();
    if (!cmd) continue;
    // Exact command or command followed by arguments — '!hype' must not match '!hypetrain'
    if (lower !== cmd && !lower.startsWith(cmd + ' ')) continue;
    if (!deps.checkPermission({ permission: t.source.permission, allowedUsers: t.source.allowedUsers }, tags)) continue;
    if (onCooldown(t, username)) continue;
    markCooldown(t, username);
    fire(t, {
      type:    'chat_command',
      user:    tags['display-name'] || tags.username || '',
      message: message.trim().slice(cmd.length).trim(),
    });
  }
}

// Canned event used by test-fires and the on-overlay positioning preview.
function makeTestEvent(trigger) {
  // Borrow a real badge from the loaded game so {badge} previews properly
  const S = deps.getState();
  const earned = (S.achievements || []).find(a => a.earned && a.badge) || (S.achievements || [])[0];
  const badgeUrl = earned?.badge
    ? `https://media.retroachievements.org/Badge/${earned.badge}.png`
    : 'https://static.retroachievements.org/assets/images/ra-icon.webp';
  return {
    type:     trigger.source.type,
    user:     'TestUser',
    amount:   trigger.source.type === 'cheer' ? (parseInt(trigger.source.bits) || 100) : 1,
    message:  'This is a test alert',
    reward:   trigger.source.rewardName || 'Test Reward',
    rewardId: trigger.source.rewardId || '',
    tier:     '1000',
    viewers:  25,
    achievement: 'Test Achievement',
    points:      50,
    description: 'You did the thing!',
    badgeUrl,
  };
}

// Test-fire with canned data; bypasses permissions and cooldowns.
function fireTest(trigger) {
  fire(trigger, makeTestEvent(trigger));
}

// Sample alert payload for drag-positioning on the overlay (not queued).
function buildTestAlert(trigger) {
  return buildAlert(trigger, makeTestEvent(trigger));
}

// Overlay reports that the playing alert's sound/video finished — used when
// durationMode is 'media' so the alert ends with the media instead of a timer.
function mediaFinished(alertId) {
  if (playing && playing.id === alertId && playing.durationMode === 'media') advance();
}

module.exports = {
  init, SOURCE_TYPES,
  triggerDefaults, normalizeTrigger,
  handleEvent, checkChatTriggers, fireTest, buildTestAlert, mediaFinished,
  skip, clear, getQueueState, getPlayingAlert,
};

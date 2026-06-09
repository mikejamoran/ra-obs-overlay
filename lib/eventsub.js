'use strict';

// Twitch EventSub over WebSocket (wss://eventsub.wss.twitch.tv/ws).
// Used for channel point redemptions, subs, raids, and follows — events that
// IRC doesn't carry. Bits arrive via the IRC `bits=` tag instead (no extra
// scope needed), so channel.cheer is intentionally not subscribed here.
//
// EventSub WS rules this client implements:
//  - subscriptions are created against the session id from session_welcome
//  - subscriptions die with the socket → full reconnect must re-subscribe
//  - session_reconnect supplies a new URL; subs carry over, no re-subscribe
//  - missing keepalives ⇒ the session is dead → reconnect

const WS = require('ws');

const DEFAULT_URL = 'wss://eventsub.wss.twitch.tv/ws';

let deps = null; // { getState, handleEvent, helixRequest, onAuthRevoked }

let sock          = null;
let oldSock       = null;   // kept open during session_reconnect handshake
let watchdog      = null;
let keepaliveSec  = 10;
let reconnectTimer = null;
let backoffMs     = 2000;
let desired       = '';     // serialized set of source types we're subscribed for
let stopped       = true;

function init(d) { deps = d; }

// Which EventSub subscriptions each trigger source type needs.
const SUB_DEFS = {
  channel_points: [
    { type: 'channel.channel_points_custom_reward_redemption.add', version: '1',
      condition: id => ({ broadcaster_user_id: id }) },
  ],
  subscription: [
    { type: 'channel.subscribe',            version: '1', condition: id => ({ broadcaster_user_id: id }) },
    { type: 'channel.subscription.message', version: '1', condition: id => ({ broadcaster_user_id: id }) },
    { type: 'channel.subscription.gift',    version: '1', condition: id => ({ broadcaster_user_id: id }) },
  ],
  raid: [
    { type: 'channel.raid', version: '1', condition: id => ({ to_broadcaster_user_id: id }) },
  ],
  follow: [
    { type: 'channel.follow', version: '2',
      condition: id => ({ broadcaster_user_id: id, moderator_user_id: id }) },
  ],
};

// OAuth scopes needed per source type (raid needs none).
const SCOPE_REQS = {
  channel_points: 'channel:read:redemptions',
  subscription:   'channel:read:subscriptions',
  follow:         'moderator:read:followers',
};

function neededSourceTypes() {
  const S = deps.getState();
  const types = new Set();
  for (const t of S.triggers) {
    if (t.enabled && SUB_DEFS[t.source.type]) types.add(t.source.type);
  }
  return [...types].sort();
}

// Scopes missing from the current token for the enabled triggers.
function missingScopes() {
  const S = deps.getState();
  const have = new Set(S.twitchScopes || []);
  return neededSourceTypes()
    .map(t => SCOPE_REQS[t])
    .filter(s => s && !have.has(s));
}

// Reconcile the connection with the current trigger config.
// Called at startup (after token validation) and on trigger CRUD.
function refresh() {
  const S = deps.getState();
  const want = neededSourceTypes().join(',');
  if (!want || !S.twitchAccessToken || !S.twitchUserId) { stop(); return; }
  if (!stopped && want === desired) return;
  desired = want;
  reconnect();
}

function stop() {
  stopped = true;
  desired = '';
  clearTimeout(watchdog);
  clearTimeout(reconnectTimer);
  watchdog = reconnectTimer = null;
  for (const s of [sock, oldSock]) { try { s?.close(); } catch {} }
  sock = oldSock = null;
}

function reconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  stopped = false;
  for (const s of [sock, oldSock]) { try { s?.close(); } catch {} }
  sock = oldSock = null;
  connect(process.env.EVENTSUB_WS_URL || DEFAULT_URL, false);
}

function scheduleReconnect() {
  if (stopped || reconnectTimer) return;
  clearTimeout(watchdog);
  console.log(`[EventSub] Reconnecting in ${backoffMs / 1000}s…`);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; reconnect(); }, backoffMs);
  backoffMs = Math.min(backoffMs * 2, 60_000);
}

function armWatchdog() {
  clearTimeout(watchdog);
  watchdog = setTimeout(() => {
    console.warn('[EventSub] Keepalive timeout — session presumed dead');
    scheduleReconnect();
  }, (keepaliveSec + 5) * 1000);
}

function connect(url, isReconnectHandshake) {
  const s = new WS(url);

  if (isReconnectHandshake) oldSock = sock;
  sock = s;

  s.on('message', data => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    handleMessage(s, msg, isReconnectHandshake);
  });

  s.on('close', () => {
    if (s === oldSock) { oldSock = null; return; } // expected during reconnect handshake
    if (s !== sock || stopped) return;
    console.log('[EventSub] Socket closed');
    scheduleReconnect();
  });

  s.on('error', err => {
    console.error('[EventSub] WebSocket error:', err.message);
    try { s.close(); } catch {}
  });
}

function handleMessage(s, msg, isReconnectHandshake) {
  if (s !== sock) return; // stale socket
  armWatchdog();

  const type = msg.metadata?.message_type;

  if (type === 'session_welcome') {
    const sess = msg.payload.session;
    if (sess.keepalive_timeout_seconds) keepaliveSec = sess.keepalive_timeout_seconds;
    backoffMs = 2000;
    if (isReconnectHandshake) {
      // Subscriptions carried over; just drop the old socket.
      try { oldSock?.close(); } catch {}
      oldSock = null;
      console.log('[EventSub] Reconnect handshake complete');
    } else {
      console.log('[EventSub] Connected, creating subscriptions…');
      createSubscriptions(sess.id).catch(e =>
        console.error('[EventSub] Subscription setup failed:', e.message));
    }
    return;
  }

  if (type === 'session_keepalive') return; // watchdog already re-armed

  if (type === 'session_reconnect') {
    console.log('[EventSub] Twitch requested reconnect');
    connect(msg.payload.session.reconnect_url, true);
    return;
  }

  if (type === 'revocation') {
    const sub = msg.payload.subscription || {};
    console.warn(`[EventSub] Subscription revoked: ${sub.type} (${sub.status})`);
    if (sub.status === 'authorization_revoked' || sub.status === 'user_removed') {
      deps.onAuthRevoked();
    }
    return;
  }

  if (type === 'notification') {
    const evt = normalize(msg.payload);
    if (evt) deps.handleEvent(evt);
  }
}

async function createSubscriptions(sessionId) {
  const S = deps.getState();
  const types = neededSourceTypes();
  for (const sourceType of types) {
    for (const def of SUB_DEFS[sourceType]) {
      try {
        const res = await deps.helixRequest('POST', '/eventsub/subscriptions', {
          type: def.type, version: def.version,
          condition: def.condition(S.twitchUserId),
          transport: { method: 'websocket', session_id: sessionId },
        });
        if (res.status === 202) {
          console.log(`[EventSub] Subscribed: ${def.type}`);
        } else {
          const body = await res.text();
          console.error(`[EventSub] Failed to subscribe ${def.type} (HTTP ${res.status}): ${body}`);
          if (res.status === 403) deps.onAuthRevoked();
        }
      } catch (e) {
        console.error(`[EventSub] Subscribe error for ${def.type}:`, e.message);
      }
    }
  }
}

// Normalize EventSub notifications into the trigger engine's event shape.
function normalize(payload) {
  const t = payload.subscription?.type;
  const e = payload.event || {};
  switch (t) {
    case 'channel.channel_points_custom_reward_redemption.add':
      return { type: 'channel_points', user: e.user_name || '',
               message: e.user_input || '',
               reward: e.reward?.title || '', rewardId: e.reward?.id || '',
               amount: e.reward?.cost ?? '' };
    case 'channel.subscribe':
      if (e.is_gift) return null; // gift recipients; the .gift event covers the gifter
      return { type: 'subscription', user: e.user_name || '',
               tier: e.tier || '1000', isResub: false, isGift: false,
               amount: 1, message: '' };
    case 'channel.subscription.message':
      return { type: 'subscription', user: e.user_name || '',
               tier: e.tier || '1000', isResub: true, isGift: false,
               amount: e.cumulative_months || 1,
               message: e.message?.text || '' };
    case 'channel.subscription.gift':
      return { type: 'subscription',
               user: e.is_anonymous ? 'Anonymous' : (e.user_name || ''),
               tier: e.tier || '1000', isResub: false, isGift: true,
               amount: e.total || 1, message: '' };
    case 'channel.raid':
      return { type: 'raid', user: e.from_broadcaster_user_name || '',
               viewers: e.viewers || 0, amount: e.viewers || 0 };
    case 'channel.follow':
      return { type: 'follow', user: e.user_name || '' };
    default:
      return null;
  }
}

module.exports = { init, refresh, stop, missingScopes, SCOPE_REQS };

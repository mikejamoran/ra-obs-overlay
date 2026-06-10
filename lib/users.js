'use strict';

// User accounts for multi-user mode. Records live in users/users.json; each
// user's overlay config lives in users/<id>/config.json. Passwords are stored
// as scrypt hashes. The first boot after upgrading migrates the existing
// single-user overlay_config.json into the admin account.

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const ROOT       = path.join(__dirname, '..');
const USERS_DIR  = path.join(ROOT, 'users');
const USERS_FILE = path.join(USERS_DIR, 'users.json');
const LEGACY_CONFIG = path.join(ROOT, 'overlay_config.json');

const USERNAME_RE = /^[a-z0-9_-]{2,24}$/;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key  = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${key}`;
}

function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [salt, key] = stored.split(':');
  if (!salt || !key) return false;
  const candidate = crypto.scryptSync(pw, salt, 64);
  const expected  = Buffer.from(key, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function loadRecords() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')).users || []; }
  catch { return null; }
}

function saveRecords(records) {
  fs.mkdirSync(USERS_DIR, { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify({ users: records }, null, 2));
}

function configFile(id) { return path.join(USERS_DIR, id, 'config.json'); }

// First boot: create the admin account from the env credentials and adopt the
// legacy single-user config + uploads dir so existing OBS URLs keep working.
function bootstrap() {
  let records = loadRecords();
  if (records && records.length) return records;

  const admin = {
    id: crypto.randomUUID(),
    username: (process.env.SETUP_USER || 'admin').toLowerCase(),
    displayName: process.env.SETUP_USER || 'Admin',
    passwordHash: process.env.SETUP_PASS ? hashPassword(process.env.SETUP_PASS) : null,
    isAdmin: true,
    uploadsRel: '',          // admin keeps the legacy public/uploads root
    createdAt: Date.now(),
  };
  records = [admin];
  fs.mkdirSync(path.join(USERS_DIR, admin.id), { recursive: true });
  if (fs.existsSync(LEGACY_CONFIG) && !fs.existsSync(configFile(admin.id))) {
    fs.copyFileSync(LEGACY_CONFIG, configFile(admin.id));
    console.log('[users] Migrated overlay_config.json into the admin account (original kept as backup)');
  }
  saveRecords(records);
  console.log(`[users] Created admin account "${admin.username}"`);
  return records;
}

function createRecord(records, { username, displayName, password }) {
  const name = (username || '').trim().toLowerCase();
  if (!USERNAME_RE.test(name))
    throw new Error('Username must be 2-24 chars: a-z, 0-9, dash, underscore');
  if (records.some(r => r.username === name)) throw new Error('Username already exists');
  if (!password || password.length < 4) throw new Error('Password must be at least 4 characters');
  const rec = {
    id: crypto.randomUUID(),
    username: name,
    displayName: (displayName || '').trim() || name,
    passwordHash: hashPassword(password),
    isAdmin: false,
    uploadsRel: 'u_' + name,
    createdAt: Date.now(),
  };
  records.push(rec);
  fs.mkdirSync(path.join(USERS_DIR, rec.id), { recursive: true });
  saveRecords(records);
  return rec;
}

module.exports = {
  bootstrap, loadRecords, saveRecords, createRecord, configFile,
  hashPassword, verifyPassword, USERNAME_RE,
};

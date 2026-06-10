'use strict';

// Media library: merges uploaded files (public/uploads) with user-configured
// local folders so existing sound/image collections can be used without
// re-uploading. Folder files are served read-only through /media/:folderId/:file.

const fs   = require('fs');
const path = require('path');

let deps = null; // { getState, uploadsDir }

function init(d) { deps = d; }

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;
const AUDIO_EXT = /\.(mp3|ogg|wav)$/i;
const VIDEO_EXT = /\.(webm|mp4)$/i;
const MEDIA_EXT = /\.(png|jpe?g|gif|webp|svg|mp3|ogg|wav|webm|mp4)$/i;

function kindOf(name) {
  if (AUDIO_EXT.test(name)) return 'audio';
  if (VIDEO_EXT.test(name)) return 'video';
  if (IMAGE_EXT.test(name)) return 'image';
  return null;
}

function listMedia() {
  const S = deps.getState();
  const items = [];
  try {
    for (const f of fs.readdirSync(deps.uploadsDir)) {
      const kind = kindOf(f);
      if (kind) items.push({ name: f, src: `/uploads/${encodeURIComponent(f)}`, kind, source: 'upload' });
    }
  } catch {}
  for (const folder of S.mediaFolders) {
    try {
      for (const f of fs.readdirSync(folder.path)) {
        const kind = kindOf(f);
        if (!kind) continue;
        try { if (!fs.statSync(path.join(folder.path, f)).isFile()) continue; } catch { continue; }
        items.push({
          name: f, src: `/media/${folder.id}/${encodeURIComponent(f)}`,
          kind, source: 'folder', folderId: folder.id, folderLabel: folder.label,
        });
      }
    } catch (e) {
      console.warn(`[media] Cannot read folder "${folder.path}":`, e.message);
    }
  }
  return items;
}

// Validate and register a local folder. Stores the realpath so the serve-time
// containment check has a canonical root.
function addFolder(rawPath, label) {
  const p = (rawPath || '').trim();
  if (!p) throw new Error('Path required');
  if (!path.isAbsolute(p)) throw new Error('Path must be absolute');
  let real;
  try { real = fs.realpathSync(p); } catch { throw new Error('Folder does not exist'); }
  if (!fs.statSync(real).isDirectory()) throw new Error('Path is not a directory');
  const S = deps.getState();
  if (S.mediaFolders.some(f => f.path === real)) throw new Error('Folder already added');
  const folder = {
    id: require('crypto').randomUUID(),
    path: real,
    label: (label || '').trim() || path.basename(real),
  };
  S.mediaFolders.push(folder);
  return folder;
}

// GET /media/:folderId/:filename — public route (the overlay is unauthenticated),
// hardened against path traversal and symlink escapes.
function serveFolderFile(req, res) {
  const S = deps.getState();
  const folder = S.mediaFolders.find(f => f.id === req.params.folderId);
  if (!folder) return res.status(404).send('Not found');

  const name = req.params.filename || '';
  if (name.includes('/') || name.includes('\\') || name.includes('..') || name.startsWith('.'))
    return res.status(400).send('Invalid filename');
  if (!MEDIA_EXT.test(name)) return res.status(403).send('File type not allowed');

  let real;
  try { real = fs.realpathSync(path.join(folder.path, name)); }
  catch { return res.status(404).send('Not found'); }
  // realpath defeats symlinks pointing outside the shared folder
  if (!real.startsWith(folder.path + path.sep)) return res.status(403).send('Forbidden');

  res.sendFile(real);
}

module.exports = { init, listMedia, addFolder, serveFolderFile, kindOf, MEDIA_EXT };

/**
 * UC Chat Operations — main-process logic (CommonJS).
 *
 * Faithful port of ICAC PULSE's src/main/uc/{personas,chats}.ts to VIPER's
 * vanilla-JS / better-sqlite3 stack. Phase 1 covers personas, chats, case
 * links and events + their IPC handlers. Later phases extend registerUcIpc()
 * with BrowserViews, photos, alert bus and evidence log.
 */

const fs = require('fs');
const path = require('path');
const { ipcMain, BrowserView, session, dialog } = require('electron');
const { getDb, getAvatarsDir } = require('./uc-chat-db');
const photos = require('./uc-chat-photos');
const evlog = require('./uc-chat-evidence');

const nowIso = () => new Date().toISOString();

/* ═══════════════════════════════ Personas ═══════════════════════════════ */

/** Session partition string for a persona (isolates cookies/logins per UC id). */
function partitionForPersona(personaId) {
  return `persist:uc_${personaId}`;
}

/** Copy a user-supplied avatar into the avatars dir; returns the stored path. */
function ingestAvatar(srcPath, personaId) {
  if (!srcPath || !fs.existsSync(srcPath)) return srcPath || null;
  const ext = path.extname(srcPath).toLowerCase() || '.png';
  const dest = path.join(getAvatarsDir(), `persona_${personaId}_${Date.now()}${ext}`);
  fs.copyFileSync(srcPath, dest);
  return dest;
}

function listPersonas(includeArchived = false) {
  const db = getDb();
  const sql = includeArchived
    ? 'SELECT * FROM uc_personas ORDER BY archived_at IS NULL DESC, display_name ASC'
    : 'SELECT * FROM uc_personas WHERE archived_at IS NULL ORDER BY display_name ASC';
  return db.prepare(sql).all() || [];
}

function getPersona(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM uc_personas WHERE id = ?').get(id) || null;
}

function createPersona(input) {
  const db = getDb();
  const info = db.prepare(
    `INSERT INTO uc_personas
       (display_name, real_age, displayed_age, gender, hometown, bio, backstory, avatar_path, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.display_name,
    input.real_age ?? null,
    input.displayed_age ?? null,
    input.gender ?? null,
    input.hometown ?? null,
    input.bio ?? null,
    input.backstory ?? null,
    null,                       // avatar copied below once we have the id
    input.notes ?? null
  );
  const id = Number(info.lastInsertRowid);
  if (!id) throw new Error('createPersona: failed to resolve new persona id');
  if (input.avatar_path) {
    const stored = ingestAvatar(input.avatar_path, id);
    db.prepare('UPDATE uc_personas SET avatar_path = ? WHERE id = ?').run(stored, id);
  }
  const persona = getPersona(id);
  if (!persona) throw new Error('createPersona: failed to read back row');
  return persona;
}

function updatePersona(id, input) {
  const db = getDb();
  const existing = getPersona(id);
  if (!existing) throw new Error(`updatePersona: persona ${id} not found`);

  const fields = [];
  const values = [];
  const setKey = (k, v) => { fields.push(`${k} = ?`); values.push(v); };

  if (input.display_name !== undefined) setKey('display_name', input.display_name);
  if (input.real_age !== undefined) setKey('real_age', input.real_age);
  if (input.displayed_age !== undefined) setKey('displayed_age', input.displayed_age);
  if (input.gender !== undefined) setKey('gender', input.gender);
  if (input.hometown !== undefined) setKey('hometown', input.hometown);
  if (input.bio !== undefined) setKey('bio', input.bio);
  if (input.backstory !== undefined) setKey('backstory', input.backstory);
  if (input.notes !== undefined) setKey('notes', input.notes);
  if (input.avatar_path !== undefined) {
    if (input.avatar_path && input.avatar_path !== existing.avatar_path) {
      setKey('avatar_path', ingestAvatar(input.avatar_path, id));
    } else if (input.avatar_path === null) {
      setKey('avatar_path', null);
    }
  }

  if (fields.length === 0) return existing;
  setKey('updated_at', nowIso());
  values.push(id);
  db.prepare(`UPDATE uc_personas SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getPersona(id);
}

/** Soft-archive (never delete; chain of custody requires permanence). */
function archivePersona(id) {
  getDb().prepare('UPDATE uc_personas SET archived_at = ? WHERE id = ?').run(nowIso(), id);
  return true;
}

function unarchivePersona(id) {
  getDb().prepare('UPDATE uc_personas SET archived_at = NULL WHERE id = ?').run(id);
  return true;
}

/* ════════════════════════════════ Chats ═════════════════════════════════ */

const PLATFORM_URLS = {
  discord:   'https://discord.com/app',
  telegram:  'https://web.telegram.org/a/',
  instagram: 'https://www.instagram.com/direct/inbox/',
  whatsapp:  'https://web.whatsapp.com/',
  snapchat:  'https://web.snapchat.com/',
  messenger: 'https://www.messenger.com/',
  meetme:    'https://app.meetme.com/get-started/email/login',
  sniffies:  'https://sniffies.com/',
};

const PLATFORM_LABELS = {
  discord: 'Discord', telegram: 'Telegram', instagram: 'Instagram',
  whatsapp: 'WhatsApp', snapchat: 'Snapchat', messenger: 'Messenger',
  meetme: 'MeetMe', sniffies: 'Sniffies', custom: 'Custom',
};

function listChats(opts = {}) {
  const db = getDb();
  const where = [];
  const params = [];
  if (!opts.includeArchived) where.push("c.status = 'active'");
  if (opts.personaId != null) { where.push('c.persona_id = ?'); params.push(opts.personaId); }
  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  return db.prepare(
    `SELECT c.*,
            p.display_name AS persona_name,
            p.avatar_path  AS persona_avatar
       FROM uc_chats c
       JOIN uc_personas p ON p.id = c.persona_id
       ${whereSql}
       ORDER BY COALESCE(c.last_activity_at, c.created_at) DESC`
  ).all(...params) || [];
}

function getChat(id) {
  return getDb().prepare('SELECT * FROM uc_chats WHERE id = ?').get(id) || null;
}

function createChat(input) {
  const db = getDb();
  const info = db.prepare(
    `INSERT INTO uc_chats
       (persona_id, platform, platform_url, suspect_handle, suspect_display_name, primary_case_id, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.persona_id,
    input.platform,
    input.platform_url ?? null,
    input.suspect_handle ?? null,
    input.suspect_display_name ?? null,
    input.primary_case_id ?? null,
    input.notes ?? null
  );
  const id = Number(info.lastInsertRowid);
  if (!id) throw new Error('createChat: failed to resolve new chat id');
  const chat = getChat(id);
  if (!chat) throw new Error('createChat: failed to read back row');
  if (input.primary_case_id) {
    linkCase(id, input.primary_case_id, 'primary');
    appendEvent(id, 'link', { case_id: input.primary_case_id, role: 'primary' });
  }
  return chat;
}

function updateChat(id, input) {
  const db = getDb();
  const existing = getChat(id);
  if (!existing) throw new Error(`updateChat: chat ${id} not found`);

  const fields = [];
  const values = [];
  const setKey = (k, v) => { fields.push(`${k} = ?`); values.push(v); };
  if (input.platform !== undefined) setKey('platform', input.platform);
  if (input.platform_url !== undefined) setKey('platform_url', input.platform_url);
  if (input.suspect_handle !== undefined) setKey('suspect_handle', input.suspect_handle);
  if (input.suspect_display_name !== undefined) setKey('suspect_display_name', input.suspect_display_name);
  if (input.primary_case_id !== undefined) setKey('primary_case_id', input.primary_case_id);
  if (input.notes !== undefined) setKey('notes', input.notes);
  if (fields.length === 0) return existing;
  setKey('updated_at', nowIso());
  values.push(id);
  db.prepare(`UPDATE uc_chats SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getChat(id);
}

function archiveChat(id) {
  getDb().prepare("UPDATE uc_chats SET status = 'archived', archived_at = ? WHERE id = ?").run(nowIso(), id);
  return true;
}

function unarchiveChat(id) {
  getDb().prepare("UPDATE uc_chats SET status = 'active', archived_at = NULL WHERE id = ?").run(id);
  return true;
}

function incrementUnread(chatId, delta = 1) {
  getDb().prepare(
    'UPDATE uc_chats SET unread_count = unread_count + ?, last_activity_at = ? WHERE id = ?'
  ).run(delta, nowIso(), chatId);
}

function markRead(chatId) {
  getDb().prepare('UPDATE uc_chats SET unread_count = 0 WHERE id = ?').run(chatId);
  return true;
}

function bumpActivity(chatId) {
  getDb().prepare('UPDATE uc_chats SET last_activity_at = ? WHERE id = ?').run(nowIso(), chatId);
}

/* ── Case bindings ─────────────────────────────────────── */

function listCaseLinks(chatId) {
  return getDb().prepare('SELECT * FROM uc_chat_case_links WHERE chat_id = ?').all(chatId) || [];
}

function linkCase(chatId, caseId, role = 'secondary') {
  const db = getDb();
  const caseKey = String(caseId);
  if (role === 'primary') {
    db.prepare("UPDATE uc_chat_case_links SET role = 'secondary' WHERE chat_id = ? AND role = 'primary'").run(chatId);
    db.prepare('UPDATE uc_chats SET primary_case_id = ? WHERE id = ?').run(caseKey, chatId);
  }
  db.prepare(
    `INSERT INTO uc_chat_case_links (chat_id, case_id, role)
     VALUES (?, ?, ?)
     ON CONFLICT(chat_id, case_id) DO UPDATE SET role = excluded.role`
  ).run(chatId, caseKey, role);
  return listCaseLinks(chatId);
}

function unlinkCase(chatId, caseId) {
  const db = getDb();
  const caseKey = String(caseId);
  db.prepare('DELETE FROM uc_chat_case_links WHERE chat_id = ? AND case_id = ?').run(chatId, caseKey);
  const existing = getChat(chatId);
  if (existing && String(existing.primary_case_id) === caseKey) {
    db.prepare('UPDATE uc_chats SET primary_case_id = NULL WHERE id = ?').run(chatId);
  }
  return listCaseLinks(chatId);
}

/* ── Events ─────────────────────────────────────────────── */

function appendEvent(chatId, kind, payload) {
  const db = getDb();
  const info = db.prepare(
    'INSERT INTO uc_chat_events (chat_id, kind, payload_json) VALUES (?, ?, ?)'
  ).run(chatId, kind, payload ? JSON.stringify(payload) : null);
  const id = Number(info.lastInsertRowid);
  return db.prepare('SELECT * FROM uc_chat_events WHERE id = ?').get(id);
}

function listEvents(chatId, limit = 500) {
  return getDb().prepare(
    'SELECT * FROM uc_chat_events WHERE chat_id = ? ORDER BY ts DESC LIMIT ?'
  ).all(chatId, limit) || [];
}

/* ══════════════════════════ BrowserView manager ═════════════════════════ */
/*
 * Each chat owns one BrowserView attached to the persona's session partition
 * (persist:uc_<personaId>). The renderer drives visibility/bounds via IPC,
 * mirroring VIPER's existing Flock/TLO BrowserView pattern.
 */

// chatId -> { view, chatId, personaId, attachedTo }
const _views = new Map();
const _wcIdToChatId = new Map();

/** Lookup chatId from a webContents.id (used by the alert pipeline). */
function chatIdForWebContents(wcId) {
  return _wcIdToChatId.has(wcId) ? _wcIdToChatId.get(wcId) : null;
}

/** Path to the UC notification-hook preload script (co-located, no bundler). */
function getNotifPreloadPath() {
  return path.join(__dirname, 'uc-notif-preload.js');
}

const _preloadedPartitions = new Set();

/** Attach the UC notification preload to a partition exactly once. */
function ensurePreloadAttached(partition) {
  if (_preloadedPartitions.has(partition)) return;
  try {
    const ses = session.fromPartition(partition);
    const preloads = ses.getPreloads();
    const notifPath = getNotifPreloadPath();
    if (!preloads.includes(notifPath)) ses.setPreloads([...preloads, notifPath]);
    _preloadedPartitions.add(partition);
  } catch (e) {
    console.warn('[uc-chat] failed to attach notif preload:', e && e.message);
  }
}

function getChatView(chatId) {
  const e = _views.get(chatId);
  return e ? e.view : null;
}

function getAllChatIds() {
  return Array.from(_views.keys());
}

/** @param {{ chatId:number, personaId:number, url:string, mainWindow:any }} opts */
function createChatView(opts) {
  const existing = _views.get(opts.chatId);
  if (existing) {
    if (opts.url) existing.view.webContents.loadURL(opts.url).catch(() => {});
    return true;
  }

  const partition = partitionForPersona(opts.personaId);
  ensurePreloadAttached(partition);

  const view = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      partition,
    },
  });

  // Realistic UA — most platforms refuse Electron's default UA.
  try {
    view.webContents.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
  } catch (_) {}

  _views.set(opts.chatId, { view, chatId: opts.chatId, personaId: opts.personaId, attachedTo: null });
  try { _wcIdToChatId.set(view.webContents.id, opts.chatId); } catch (_) {}

  const win = opts.mainWindow;
  if (win && !win.isDestroyed()) {
    try { win.addBrowserView(view); } catch (_) {}
    _views.get(opts.chatId).attachedTo = win;
  }

  view.setBounds({ x: 0, y: 0, width: 0, height: 0 });   // hidden until positioned
  view.setAutoResize({ width: false, height: false });
  if (opts.url) view.webContents.loadURL(opts.url).catch(() => {});
  return true;
}

function setChatViewBounds(chatId, b) {
  const e = _views.get(chatId);
  if (!e || !b) return;
  try {
    e.view.setBounds({
      x: Math.round(b.x), y: Math.round(b.y),
      width: Math.round(b.width), height: Math.round(b.height),
    });
  } catch (_) {}
}

function setChatViewVisible(chatId, visible) {
  const e = _views.get(chatId);
  if (!e) return;
  if (visible) {
    if (e.attachedTo && !e.attachedTo.isDestroyed()) {
      try { e.attachedTo.addBrowserView(e.view); } catch (_) {}
    }
  } else {
    try { e.view.setBounds({ x: 0, y: 0, width: 0, height: 0 }); } catch (_) {}
    if (e.attachedTo && !e.attachedTo.isDestroyed()) {
      try { e.attachedTo.removeBrowserView(e.view); } catch (_) {}
    }
  }
}

/** Hide every known chat BrowserView (renderer calls on mount to clear orphans). */
function hideAllChatViews() {
  for (const id of _views.keys()) setChatViewVisible(id, false);
}

function loadChatUrl(chatId, url) {
  const e = _views.get(chatId);
  if (e) e.view.webContents.loadURL(url).catch(() => {});
}

function reloadChat(chatId) {
  const e = _views.get(chatId);
  if (e) { try { e.view.webContents.reload(); } catch (_) {} }
}

function navBack(chatId) {
  const e = _views.get(chatId);
  if (e) { try { if (e.view.webContents.canGoBack()) e.view.webContents.goBack(); } catch (_) {} }
}

function destroyChatView(chatId) {
  const e = _views.get(chatId);
  if (!e) return;
  try {
    if (e.attachedTo && !e.attachedTo.isDestroyed()) e.attachedTo.removeBrowserView(e.view);
    try { _wcIdToChatId.delete(e.view.webContents.id); } catch (_) {}
    const wc = e.view.webContents;
    if (typeof wc.close === 'function') wc.close();
    else if (typeof wc.destroy === 'function') wc.destroy();
  } catch (_) {}
  _views.delete(chatId);
}

function getChatPersona(chatId) {
  const e = _views.get(chatId);
  return e ? e.personaId : null;
}

function getChatPartition(chatId) {
  const e = _views.get(chatId);
  return e ? partitionForPersona(e.personaId) : null;
}

/* ═══════════════════════════════ Alert bus ══════════════════════════════ */

let _discreetMode = false;
let _getWin = () => null;
const _recent = new Map();   // chatId -> { sig, ts }

function _shouldDedupe(chatId, sig, ts) {
  const prev = _recent.get(chatId);
  if (prev && prev.sig === sig && (ts - prev.ts) < 3000) return true;
  _recent.set(chatId, { sig, ts });
  return false;
}

function configureAlertBus(opts) {
  _getWin = (opts && opts.getMainWindow) || (() => null);
}

function setDiscreetMode(on) { _discreetMode = !!on; return _discreetMode; }
function getDiscreetMode() { return _discreetMode; }

function ingestNotification(input) {
  if (!input || !input.chatId) return;
  const ts = Date.now();
  const sig = `${input.title || ''}|${input.body || ''}`;
  if (_shouldDedupe(input.chatId, sig, ts)) return;

  try { incrementUnread(input.chatId, 1); } catch (_) {}
  try { appendEvent(input.chatId, 'alert', { title: input.title, body: input.body, icon: input.icon }); } catch (_) {}

  const win = _getWin();
  if (!win || win.isDestroyed()) return;
  const payload = _discreetMode
    ? { chatId: input.chatId, kind: 'activity', ts }
    : { chatId: input.chatId, kind: 'notification', title: input.title, body: input.body, icon: input.icon, ts };
  win.webContents.send('uc-alert', payload);
}

function ingestTitleSignal(input) {
  if (!input || !input.chatId || input.unread <= 0) return;
  const ts = Date.now();
  const sig = `title:${input.unread}`;
  if (_shouldDedupe(input.chatId, sig, ts)) return;

  try { incrementUnread(input.chatId, 1); } catch (_) {}
  const win = _getWin();
  if (!win || win.isDestroyed()) return;
  win.webContents.send('uc-alert', { chatId: input.chatId, kind: _discreetMode ? 'activity' : 'title', ts });
}

/* ═══════════════════════════════ IPC wiring ═════════════════════════════ */

let _ipcRegistered = false;

/**
 * Register all UC IPC handlers. Idempotent (safe to call once).
 * @param {{ getMainWindow: () => import('electron').BrowserWindow | null }} opts
 */
function registerUcIpc(opts = {}) {
  if (_ipcRegistered) return;
  _ipcRegistered = true;

  // Personas
  ipcMain.handle('uc-persona-list', (_e, args) => listPersonas(!!(args && args.includeArchived)));
  ipcMain.handle('uc-persona-get', (_e, id) => getPersona(id));
  ipcMain.handle('uc-persona-create', (_e, input) => createPersona(input || {}));
  ipcMain.handle('uc-persona-update', (_e, args) => updatePersona(args.id, args.input || {}));
  ipcMain.handle('uc-persona-archive', (_e, id) => archivePersona(id));
  ipcMain.handle('uc-persona-unarchive', (_e, id) => unarchivePersona(id));

  // Chats
  ipcMain.handle('uc-chat-list', (_e, args) => listChats(args || {}));
  ipcMain.handle('uc-chat-get', (_e, id) => getChat(id));
  ipcMain.handle('uc-chat-create', (_e, input) => createChat(input || {}));
  ipcMain.handle('uc-chat-update', (_e, args) => updateChat(args.id, args.input || {}));
  ipcMain.handle('uc-chat-archive', (_e, id) => archiveChat(id));
  ipcMain.handle('uc-chat-unarchive', (_e, id) => unarchiveChat(id));
  ipcMain.handle('uc-chat-mark-read', (_e, id) => markRead(id));

  // Case links
  ipcMain.handle('uc-chat-link-case', (_e, args) => linkCase(args.chatId, args.caseId, args.role));
  ipcMain.handle('uc-chat-unlink-case', (_e, args) => unlinkCase(args.chatId, args.caseId));
  ipcMain.handle('uc-chat-case-links', (_e, chatId) => listCaseLinks(chatId));

  // Events
  ipcMain.handle('uc-chat-events', (_e, args) => listEvents(args.chatId, args.limit));

  // Store the main-window getter + wire the alert bus.
  registerUcIpc._getMainWindow = opts.getMainWindow || (() => null);
  configureAlertBus({ getMainWindow: registerUcIpc._getMainWindow });

  // BrowserViews — create is request/response; the rest are fire-and-forget.
  ipcMain.handle('uc-chat-bv-create', (_e, args) => createChatView({
    chatId: args.chatId,
    personaId: args.personaId,
    url: args.url,
    mainWindow: registerUcIpc._getMainWindow(),
  }));
  ipcMain.on('uc-chat-bv-set-bounds', (_e, args) => setChatViewBounds(args.chatId, args.bounds));
  ipcMain.on('uc-chat-bv-set-visible', (_e, args) => setChatViewVisible(args.chatId, args.visible));
  ipcMain.on('uc-chat-bv-load-url', (_e, args) => loadChatUrl(args.chatId, args.url));
  ipcMain.on('uc-chat-bv-reload', (_e, chatId) => reloadChat(chatId));
  ipcMain.on('uc-chat-bv-back', (_e, chatId) => navBack(chatId));
  ipcMain.on('uc-chat-bv-destroy', (_e, chatId) => destroyChatView(chatId));
  ipcMain.on('uc-chat-bv-hide-all', () => hideAllChatViews());

  // Alert pipeline — resolve chatId from the sending BrowserView's webContents.
  ipcMain.on('uc-notif-raw', (e, payload) => {
    const chatId = chatIdForWebContents(e.sender.id);
    if (chatId) ingestNotification({ chatId, title: payload && payload.title, body: payload && payload.body, icon: payload && payload.icon });
  });
  ipcMain.on('uc-title-signal', (e, payload) => {
    const chatId = chatIdForWebContents(e.sender.id);
    if (chatId) ingestTitleSignal({ chatId, unread: payload && payload.unread });
  });

  // Discreet mode
  ipcMain.handle('uc-discreet-mode-get', () => getDiscreetMode());
  ipcMain.handle('uc-discreet-mode-set', (_e, on) => setDiscreetMode(on));

  // Evidence log
  ipcMain.handle('uc-evidence-log-list', (_e, filter) => evlog.listEvidenceLog(filter || {}));
  ipcMain.handle('uc-evidence-log-verify', (_e, id) => evlog.verifyEvidenceLogEntry(id));

  // Persona photo library
  ipcMain.handle('uc-photo-list', (_e, args) => photos.listPhotos(args.personaId, !!(args && args.includeArchived)));
  ipcMain.handle('uc-photo-add', (_e, args) => photos.addPhoto(args));
  ipcMain.handle('uc-photo-update', (_e, args) => photos.updatePhoto(args.id, args.input || {}));
  ipcMain.handle('uc-photo-archive', (_e, id) => { photos.archivePhoto(id); return true; });
  ipcMain.handle('uc-photo-unarchive', (_e, id) => { photos.unarchivePhoto(id); return true; });
  ipcMain.handle('uc-photo-uses', (_e, photoId) => photos.listPhotoUses(photoId));
  ipcMain.handle('uc-photo-copy-to-clipboard', (_e, args) => photos.copyPhotoToClipboard(args.photoId, args.chatId));

  // Open a native file picker and add each selected image to the persona.
  // Returns array of newly created photo rows.
  ipcMain.handle('uc-photo-pick-and-add', async (_e, args) => {
    const win = registerUcIpc._getMainWindow();
    const opts = {
      title: 'Add Persona Photos',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'heic', 'tiff'] },
      ],
    };
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (result.canceled || !result.filePaths || !result.filePaths.length) return [];
    const created = [];
    for (const fp of result.filePaths) {
      try {
        created.push(photos.addPhoto({ personaId: args.personaId, srcPath: fp }));
      } catch (e) {
        console.warn('[uc-photo-pick-and-add] failed for', fp, e && e.message);
      }
    }
    return created;
  });

  // Pick-only variant: returns the selected file paths so the renderer can
  // drive the import loop and show accurate per-file progress. The renderer
  // then calls `uc-photo-add` once per path.
  ipcMain.handle('uc-photo-pick-files', async () => {
    const win = registerUcIpc._getMainWindow();
    const opts = {
      title: 'Add Persona Photos',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'heic', 'tiff'] },
      ],
    };
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (result.canceled || !result.filePaths || !result.filePaths.length) return [];
    return result.filePaths.map(fp => ({ path: fp, name: fp.split(/[\\/]/).pop() || fp }));
  });
}

module.exports = {
  // persona
  partitionForPersona, listPersonas, getPersona, createPersona, updatePersona,
  archivePersona, unarchivePersona,
  // chat
  PLATFORM_URLS, PLATFORM_LABELS, listChats, getChat, createChat, updateChat,
  archiveChat, unarchiveChat, incrementUnread, markRead, bumpActivity,
  listCaseLinks, linkCase, unlinkCase, appendEvent, listEvents,
  // browserviews
  chatIdForWebContents, getChatView, getAllChatIds, createChatView,
  setChatViewBounds, setChatViewVisible, hideAllChatViews, loadChatUrl,
  reloadChat, navBack, destroyChatView, getChatPersona, getChatPartition,
  // alert bus
  configureAlertBus, setDiscreetMode, getDiscreetMode, ingestNotification, ingestTitleSignal,
  // photos + evidence log
  photos, evlog,
  // ipc
  registerUcIpc,
};

// modules/cargonet/cargonet-main.js
// CargoNet Theft Alert ingest pipeline.
//
// User configures an inbox folder. Outlook (or a forwarding rule) drops
// .eml files containing CargoNet Theft Alerts. We watch the folder,
// parse new files via mailparser, extract the structured fields, and
// store alerts in userdata/cargonet/alerts.json.
//
// Field Security: alerts.json + config.json are written as VIPENC blobs
// when SecurityManager is enabled+unlocked. Same convention as Cellebrite.
//
// Public IPC surface (all handle()-style):
//   cargonet-get-status  → { enabled, inboxFolder, watching, unreadCount, totalCount }
//   cargonet-start       → enables + starts watcher
//   cargonet-stop        → disables + stops watcher
//   cargonet-pick-folder → opens dir picker, persists choice
//   cargonet-open-folder → shell.openPath on inbox
//   cargonet-list        → array of alerts (newest first, archived excluded)
//   cargonet-mark-read   → mark a single alert read
//   cargonet-delete      → soft-archive a single alert
//   cargonet-rescan      → manual scan trigger
//
// Broadcast (no-args): 'cargonet-new-alert' fired on every new ingest.

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, dialog, shell, BrowserWindow } = require('electron');
const { simpleParser } = require('mailparser');
const parser = require('./cargonet-parser');

// ─── State ────────────────────────────────────────────────────────────
let _watcher    = null;
let _pollTimer  = null;
let _config     = null;   // { enabled, inboxFolder }
let _alerts     = null;   // array, lazy-loaded
let _security   = null;
let _mainWindow = null;
let _ingestLocks = new Set(); // file paths currently being ingested

const POLL_MS = 30 * 1000;

function setSecurityManager(sm) { _security = sm; }
function setMainWindow(win)     { _mainWindow = win; }
function _isSecActive()         { return !!(_security && _security.isEnabled() && _security.isUnlocked()); }

// ─── Paths ────────────────────────────────────────────────────────────
function _userdataDir() { return path.join(app.getPath('userData'),  'cargonet'); }
function _configPath()  { return path.join(_userdataDir(), 'config.json');  }
function _alertsPath()  { return path.join(_userdataDir(), 'alerts.json');  }
function _archiveDir()  { return path.join(_userdataDir(), 'archive');      }
function _defaultInbox(){ return path.join(app.getPath('documents'), 'VIPER', 'CargoNet', 'Inbox'); }

// ─── Secure JSON helpers (mirrors cellebrite-main.js pattern) ─────────
function _secureWriteJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const json = JSON.stringify(obj, null, 2);
  if (_isSecActive()) {
    const enc = _security.encryptBuffer(Buffer.from(json, 'utf-8'));
    fs.writeFileSync(filePath, enc);
  } else {
    fs.writeFileSync(filePath, json, 'utf-8');
  }
}

function _secureReadJson(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath); }
  catch (e) { return { ok: false, error: e.message, missing: e.code === 'ENOENT' }; }
  const isEnc = raw.length >= 6 && raw.subarray(0, 6).equals(Buffer.from('VIPENC'));
  if (!isEnc) {
    try { return { ok: true, data: JSON.parse(raw.toString('utf-8')) }; }
    catch (e) { return { ok: false, error: `parse failed: ${e.message}` }; }
  }
  if (!_security || !_security.isUnlocked()) {
    return { ok: false, locked: true, error: 'Field Security is locked — unlock to view CargoNet alerts.' };
  }
  try {
    const plain = _security.decryptBuffer(raw);
    return { ok: true, data: JSON.parse(plain.toString('utf-8')) };
  } catch (e) { return { ok: false, error: `decrypt failed: ${e.message}` }; }
}

// ─── Config / state load ──────────────────────────────────────────────
function _loadConfig() {
  if (_config) return _config;
  let cfg = { enabled: false, inboxFolder: _defaultInbox() };
  const r = _secureReadJson(_configPath());
  if (r.ok && r.data) cfg = { ...cfg, ...r.data };
  _config = cfg;
  return cfg;
}

function _saveConfig() {
  _secureWriteJson(_configPath(), _config || _loadConfig());
}

function _loadAlerts() {
  if (Array.isArray(_alerts)) return _alerts;
  const r = _secureReadJson(_alertsPath());
  if (r.ok && Array.isArray(r.data)) _alerts = r.data;
  else _alerts = [];
  return _alerts;
}

function _saveAlerts() {
  _secureWriteJson(_alertsPath(), _alerts || []);
}

function _ensureDirs() {
  try { fs.mkdirSync(_userdataDir(), { recursive: true }); } catch (_) {}
  try { fs.mkdirSync(_archiveDir(),  { recursive: true }); } catch (_) {}
  const cfg = _loadConfig();
  try { fs.mkdirSync(cfg.inboxFolder, { recursive: true }); } catch (_) {}
}

// ─── Parser wrapper ───────────────────────────────────────────────────
// Real extraction lives in cargonet-parser.js (pure, no electron deps).
function parseCargonetEmail(parsedMail, sourceFile) {
  return parser.parseCargonetEmail(parsedMail, sourceFile, {
    genId: () => 'cn_' + crypto.randomBytes(8).toString('hex'),
  });
}

// ─── Ingest ───────────────────────────────────────────────────────────
function _broadcast(channel, payload) {
  try {
    if (_mainWindow && !_mainWindow.isDestroyed()) {
      _mainWindow.webContents.send(channel, payload);
    }
    BrowserWindow.getAllWindows().forEach(w => {
      if (w !== _mainWindow && !w.isDestroyed()) {
        try { w.webContents.send(channel, payload); } catch (_) {}
      }
    });
  } catch (_) {}
}

function _isDuplicate(newAlert) {
  const list = _loadAlerts();
  if (newAlert.incidentNumber) {
    return list.some(a => a.incidentNumber && a.incidentNumber === newAlert.incidentNumber);
  }
  // Fallback: dedupe by subject + sentDate
  return list.some(a => a.subject === newAlert.subject && a.sentDate === newAlert.sentDate);
}

async function ingestFile(filePath) {
  if (_ingestLocks.has(filePath)) return { skipped: 'in-flight' };
  _ingestLocks.add(filePath);
  try {
    // Wait a beat in case the file is still being written
    await new Promise(r => setTimeout(r, 250));
    if (!fs.existsSync(filePath)) return { skipped: 'gone' };
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { skipped: 'not-file' };

    const raw = fs.readFileSync(filePath);
    const parsed = await simpleParser(raw);

    // Sanity check: must look like a CargoNet alert
    const subj = (parsed.subject || '');
    const bodyText = parsed.text || (parsed.html ? String(parsed.html).slice(0, 2000) : '');
    const looksLikeCargonet = /CargoNet/i.test(subj) || /CargoNet/i.test(bodyText) || /cargonet\.com/i.test((parsed.from && parsed.from.text) || '');
    if (!looksLikeCargonet) {
      console.log('[CargoNet] skipping non-CargoNet email:', filePath);
      return { skipped: 'not-cargonet' };
    }

    const alert = parseCargonetEmail(parsed, filePath);
    if (_isDuplicate(alert)) {
      console.log('[CargoNet] duplicate, skipping:', alert.incidentNumber || alert.subject);
      return { skipped: 'duplicate' };
    }

    _loadAlerts().push(alert);
    _saveAlerts();

    // Move source file to archive so we don't re-ingest on next scan
    try {
      const archiveName = `${alert.incidentNumber || ('alert_' + Date.now())}__${path.basename(filePath)}`;
      const dest = path.join(_archiveDir(), archiveName);
      fs.mkdirSync(_archiveDir(), { recursive: true });
      fs.renameSync(filePath, dest);
    } catch (e) {
      // If rename fails (different volume etc), copy + unlink
      try {
        const archiveName = `${alert.incidentNumber || ('alert_' + Date.now())}__${path.basename(filePath)}`;
        const dest = path.join(_archiveDir(), archiveName);
        fs.copyFileSync(filePath, dest);
        fs.unlinkSync(filePath);
      } catch (e2) { console.error('[CargoNet] archive failed:', e2.message); }
    }

    _broadcast('cargonet-new-alert', {
      id: alert.id,
      subject: alert.subject,
      incidentNumber: alert.incidentNumber,
      city: alert.subjectCity || alert.location.city,
      state: alert.subjectState || alert.location.state,
    });

    console.log('[CargoNet] ingested:', alert.incidentNumber || alert.subject);
    return { success: true, alert };
  } catch (e) {
    console.error('[CargoNet] ingest error:', filePath, e);
    return { error: e.message };
  } finally {
    _ingestLocks.delete(filePath);
  }
}

async function _scanInbox() {
  const cfg = _loadConfig();
  if (!cfg.enabled || !cfg.inboxFolder) return;
  if (!fs.existsSync(cfg.inboxFolder)) return;
  let files = [];
  try {
    files = fs.readdirSync(cfg.inboxFolder)
      .filter(f => /\.(eml|msg|txt)$/i.test(f))
      .map(f => path.join(cfg.inboxFolder, f));
  } catch (_) { return; }
  for (const f of files) {
    try { await ingestFile(f); } catch (e) { console.error('[CargoNet] scan ingest failed:', f, e.message); }
  }
}

function startWatcher() {
  const cfg = _loadConfig();
  if (!cfg.enabled || !cfg.inboxFolder) return;
  try { fs.mkdirSync(cfg.inboxFolder, { recursive: true }); } catch (_) {}

  stopWatcher();

  try {
    _watcher = fs.watch(cfg.inboxFolder, { persistent: false }, (_ev, filename) => {
      if (!filename) return;
      if (!/\.(eml|msg|txt)$/i.test(filename)) return;
      const full = path.join(cfg.inboxFolder, filename);
      // small delay to let the file finish being written
      setTimeout(() => ingestFile(full).catch(e => console.error('[CargoNet] watch ingest', e)), 800);
    });
    _watcher.on('error', (e) => console.error('[CargoNet] watcher error:', e.message));
    console.log('[CargoNet] watching', cfg.inboxFolder);
  } catch (e) {
    console.error('[CargoNet] fs.watch failed (using poll only):', e.message);
  }

  _pollTimer = setInterval(() => _scanInbox(), POLL_MS);
  _scanInbox();
}

function stopWatcher() {
  if (_watcher)   { try { _watcher.close(); } catch (_) {} _watcher = null; }
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

// ─── IPC registration ─────────────────────────────────────────────────
function registerIpc(ipc) {
  _ensureDirs();
  _loadAlerts();

  ipc.handle('cargonet-get-status', () => {
    const cfg = _loadConfig();
    const list = _loadAlerts();
    return {
      enabled:     !!cfg.enabled,
      inboxFolder: cfg.inboxFolder,
      watching:    !!_watcher || !!_pollTimer,
      unreadCount: list.filter(a => !a.read && !a.archived).length,
      totalCount:  list.filter(a => !a.archived).length,
    };
  });

  ipc.handle('cargonet-start', () => {
    _config = _loadConfig();
    _config.enabled = true;
    _saveConfig();
    _ensureDirs();
    startWatcher();
    return { success: true };
  });

  ipc.handle('cargonet-stop', () => {
    _config = _loadConfig();
    _config.enabled = false;
    _saveConfig();
    stopWatcher();
    return { success: true };
  });

  ipc.handle('cargonet-pick-folder', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose CargoNet Inbox Folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths.length) return { success: false };
    _config = _loadConfig();
    _config.inboxFolder = r.filePaths[0];
    _saveConfig();
    _ensureDirs();
    if (_config.enabled) startWatcher();
    return { success: true, folder: r.filePaths[0] };
  });

  ipc.handle('cargonet-open-folder', () => {
    const cfg = _loadConfig();
    try { fs.mkdirSync(cfg.inboxFolder, { recursive: true }); } catch (_) {}
    shell.openPath(cfg.inboxFolder);
    return { success: true, folder: cfg.inboxFolder };
  });

  ipc.handle('cargonet-list', () => {
    const list = _loadAlerts();
    return list
      .filter(a => !a.archived)
      .slice()
      .sort((a, b) => new Date(b.receivedAt || 0) - new Date(a.receivedAt || 0));
  });

  ipc.handle('cargonet-get', (_e, id) => {
    return _loadAlerts().find(a => a.id === id) || null;
  });

  ipc.handle('cargonet-mark-read', (_e, id) => {
    const a = _loadAlerts().find(x => x.id === id);
    if (a) { a.read = true; _saveAlerts(); }
    return { success: !!a };
  });

  ipc.handle('cargonet-mark-all-read', () => {
    const list = _loadAlerts();
    let n = 0;
    for (const a of list) if (!a.read && !a.archived) { a.read = true; n++; }
    if (n) _saveAlerts();
    return { success: true, count: n };
  });

  ipc.handle('cargonet-delete', (_e, id) => {
    const a = _loadAlerts().find(x => x.id === id);
    if (a) { a.archived = true; _saveAlerts(); }
    return { success: !!a };
  });

  ipc.handle('cargonet-rescan', async () => {
    await _scanInbox();
    return { success: true };
  });
}

// Lifecycle helper for electron-main to call after createWindow.
function startIfEnabled() {
  const cfg = _loadConfig();
  if (cfg.enabled) startWatcher();
}

module.exports = {
  registerIpc,
  setSecurityManager,
  setMainWindow,
  startWatcher,
  stopWatcher,
  startIfEnabled,
  // exposed for tests
  _internals: {
    parseCargonetEmail,
    extractSections:      parser.extractSections,
    kvBlock:              parser.kvBlock,
    parsePhone:           parser.parsePhone,
    parseValue:           parser.parseValue,
    findIncidentNumber:   parser.findIncidentNumber,
    findIncidentType:     parser.findIncidentType,
    normalizeBody:        parser.normalizeBody,
  },
};

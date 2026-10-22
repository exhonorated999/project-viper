/**
 * VIPER BitTorrent tab — main-process IPC (Torrential Downpour imports).
 *
 *   bt-pick-source  folder picker → TD downloads found under it
 *   bt-scan         TD downloads in cases/<n>/Evidence + linked Evidence paths
 *   bt-import       parse (and optionally copy into Evidence/BitTorrent/…) →
 *                   cases/<n>/BitTorrent/<downloadId>.json
 *   bt-read         parsed model for one download
 *   bt-delete       remove the parsed JSON (never touches Evidence files)
 *   bt-cancel       cancel a running import
 * Progress: 'bt-progress' { jobId, phase:'logs'|'copy'|'save', ... }
 *
 * Field Security: copies are encrypted per file when the vault is on, the
 * parsed JSON likewise, and encrypted copies are decrypted in memory to parse.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const Td = require('./td-log-parser');

const ENCRYPT_MAX_DEFAULT = 1900 * 1024 * 1024;
const MAGIC_PEEK = 8;

function _peek(p, n) {
  let fd = null;
  try {
    fd = fs.openSync(p, 'r');
    const b = Buffer.alloc(n);
    const r = fs.readSync(fd, b, 0, n, 0);
    return b.subarray(0, r);
  } catch (_) { return Buffer.alloc(0); } finally { if (fd != null) try { fs.closeSync(fd); } catch (_) { /* */ } }
}

function isEncryptedFile(p, security) {
  return !!(security && typeof security.isEncryptedBuffer === 'function' && security.isEncryptedBuffer(_peek(p, MAGIC_PEEK)));
}

function encrypting(security) {
  return !!(security && security.isEnabled && security.isEnabled() && security.isUnlocked && security.isUnlocked());
}

function _decryptFile(p, security) {
  if (!security || !security.isUnlocked || !security.isUnlocked()) {
    const e = new Error('This copy is protected by Field Security. Unlock VIPER to read it.');
    e.code = 'VAULT_LOCKED';
    throw e;
  }
  return security.decryptBuffer(fs.readFileSync(p));
}

/** Parser I/O hooks that transparently read Field-Security copies. */
function vaultIo(security) {
  return {
    createStream(p) {
      if (!isEncryptedFile(p, security)) return fs.createReadStream(p, { encoding: 'utf8', highWaterMark: 1 << 20 });
      const buf = _decryptFile(p, security);
      const CH = 1 << 20;
      return Readable.from((function* () { for (let i = 0; i < buf.length; i += CH) yield buf.subarray(i, i + CH); })());
    },
    readText(p) {
      return isEncryptedFile(p, security) ? _decryptFile(p, security).toString('utf8') : fs.readFileSync(p, 'utf8');
    }
  };
}

// ── Paths / guards ───────────────────────────────────────────────────────
function safeSegment(s) {
  const v = String(s == null ? '' : s);
  if (!v || v === '.' || v === '..' || /[\\/:*?"<>|\x00-\x1f]/.test(v)) return null;
  return v;
}
function safeId(id) { return /^[A-Za-z0-9._-]{1,160}$/.test(String(id || '')) && !/^\.+$/.test(String(id)) ? String(id) : null; }
function caseRoot(casesDir, caseNumber) {
  const n = safeSegment(caseNumber);
  if (!casesDir || !n) { const e = new Error('Invalid case.'); e.code = 'BAD_CASE'; throw e; }
  return path.join(casesDir, n);
}
function modelPath(casesDir, caseNumber, id) {
  const s = safeId(id);
  if (!s) { const e = new Error('Invalid download id.'); e.code = 'BAD_ID'; throw e; }
  return path.join(caseRoot(casesDir, caseNumber), 'BitTorrent', s + '.json');
}
function _within(child, parent) {
  const c = path.resolve(child).toLowerCase(), p = path.resolve(parent).toLowerCase();
  return c === p || c.startsWith(p + path.sep);
}

// ── Describe a discovered download for the renderer ──────────────────────
function describe(found, security, casesDir) {
  const f = found.files;
  const logs = [...f.details, ...f.summary].map(x => x.path);
  let logBytes = 0;
  for (const p of logs) { try { logBytes += fs.statSync(p).size; } catch (_) { /* */ } }
  const m = found.folderMeta || {};
  return {
    caseDir: found.caseDir,
    logsDir: found.logsDir,
    downloadDir: found.downloadDir || null,
    ipFolder: m.ipFolder || null,
    caseFolder: m.caseFolder || null,
    ip: m.ip || null,
    stamp: m.stamp || null,
    downloadNo: m.downloadId != null ? m.downloadId : null,
    hasDetails: f.details.length > 0,
    hasSummary: f.summary.length > 0,
    hasTorrentInfo: !!f.torrentinfo,
    hasNetstat: !!f.netstat,
    logBytes,
    encrypted: logs.length ? isEncryptedFile(logs[0], security) : false,
    inCase: !!(casesDir && _within(found.caseDir, casesDir))
  };
}

// ── Recursive copy with progress + per-file encryption ───────────────────
function _listTree(dir) {
  const out = [];
  (function walk(d, rel) {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(d, e.name), r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) walk(full, r);
      else if (e.isFile()) { let size = 0; try { size = fs.statSync(full).size; } catch (_) { /* */ } out.push({ full, rel: r, size }); }
    }
  })(dir, '');
  return out;
}

function _uniqueDir(base) {
  if (!fs.existsSync(base)) return base;
  for (let i = 2; i < 1000; i++) { const c = `${base} (${i})`; if (!fs.existsSync(c)) return c; }
  throw new Error('Could not choose a destination folder.');
}

/**
 * Copy one TD download (case folder: Logs + Download + anything else in it)
 * to <evidenceRoot>/<IP folder>/<download folder>/. A loose Logs folder is
 * copied to …/<download folder>/Logs. Returns { dest, files, bytes, logFiles[] }.
 */
async function copyDownload(found, evidenceRoot, opts) {
  opts = opts || {};
  const security = opts.security || null;
  const onProgress = opts.onProgress || (() => {});
  const isCancelled = opts.isCancelled || (() => false);
  const maxEnc = opts.encryptMaxBytes || ENCRYPT_MAX_DEFAULT;
  const m = found.folderMeta || {};
  const looseLogs = path.resolve(found.caseDir) === path.resolve(found.logsDir);
  const ipSeg = safeSegment(m.ipFolder) || 'Unknown IP';
  const dlSeg = safeSegment(m.caseFolder) || safeSegment(path.basename(looseLogs && /^logs$/i.test(path.basename(found.logsDir)) ? path.dirname(found.logsDir) : found.caseDir)) || 'TD download';
  const dest = _uniqueDir(path.join(evidenceRoot, ipSeg, dlSeg));
  const srcRoot = looseLogs ? found.logsDir : found.caseDir;
  const destRoot = looseLogs ? path.join(dest, 'Logs') : dest;
  const items = _listTree(srcRoot);
  const enc = encrypting(security);
  if (enc) {
    const big = items.find(it => it.size > maxEnc);
    if (big) {
      const e = new Error(`"${path.basename(big.full)}" is ${(big.size / 1073741824).toFixed(1)} GB, too large to encrypt into the case folder while Field Security is on. Add the folder on the Evidence tab as "Reference only" and use Find in Evidence instead.`);
      e.code = 'TOO_LARGE_TO_ENCRYPT';
      throw e;
    }
  }
  const bytesTotal = items.reduce((a, b) => a + b.size, 0);
  let bytesDone = 0, filesDone = 0, lastTick = 0;
  const fl = found.files || {};
  const logSet = new Set([...(fl.details || []), ...(fl.summary || [])].map(f => f.path)
    .concat([fl.torrentinfo, fl.netstat, fl.torrent].filter(Boolean))
    .map(p => path.resolve(p).toLowerCase()));
  const dlAbs = found.downloadDir ? path.resolve(found.downloadDir).toLowerCase() + path.sep : null;
  const logFiles = [];
  let mediaFiles = 0;
  for (const it of items) {
    if (isCancelled()) { const e = new Error('cancelled'); e.cancelled = true; throw e; }
    const to = path.join(destRoot, it.rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (enc && !isEncryptedFile(it.full, security)) {
      await fs.promises.writeFile(to, security.encryptBuffer(await fs.promises.readFile(it.full)));
    } else {
      await fs.promises.copyFile(it.full, to);
    }
    bytesDone += it.size; filesDone++;
    const abs = path.resolve(it.full).toLowerCase();
    if (logSet.has(abs)) logFiles.push({ name: path.basename(it.rel), path: to, size: it.size });
    else if (dlAbs && abs.startsWith(dlAbs)) mediaFiles++;
    const now = Date.now();
    if (now - lastTick > 150 || filesDone === items.length) {
      lastTick = now;
      onProgress({ phase: 'copy', bytesDone, bytesTotal, filesDone, filesTotal: items.length });
    }
  }
  return { dest, files: items.length, bytes: bytesTotal, logFiles, mediaFiles };
}

// ── Model storage ────────────────────────────────────────────────────────
function writeModel(file, model, security) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let buf = Buffer.from(JSON.stringify(model), 'utf8');
  if (encrypting(security)) buf = security.encryptBuffer(buf);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
  return buf.length;
}
function readModel(file, security) {
  let buf = fs.readFileSync(file);
  if (security && security.isEncryptedBuffer && security.isEncryptedBuffer(buf)) buf = _decryptFile(file, security);
  return JSON.parse(buf.toString('utf8'));
}

/** Small record kept in localStorage (bittorrent_<caseId>.imports[]). */
function metaOf(model) {
  const s = model.summary || {};
  const st = model.storage || {};
  return {
    id: model.id,
    ip: s.suspectIp || model.remote.ip || null,
    port: model.remote.port || null,
    teredo: !!model.remote.teredo,
    startedAt: model.download.startedAt || null,
    endedAt: model.download.endedAt || null,
    gmtOffsetMin: model.download.gmtOffsetMin != null ? model.download.gmtOffsetMin : null,
    tool: model.tool ? `${model.tool.name || 'Torrential Downpour'} ${model.tool.version || ''}`.trim() : null,
    infoHash: model.torrent.infoHash || null,
    torrentName: model.torrent.name || null,
    fileCount: model.torrent.fileCount != null ? model.torrent.fileCount : null,
    pieceCount: model.torrent.pieceCount != null ? model.torrent.pieceCount : null,
    location: (model.folder && model.folder.location) || null,
    primaryLog: model.primaryLog || null,
    summary: {
      attempts: s.attempts, connected: s.connected, sessionsWithData: s.sessionsWithData,
      piecesDownloaded: s.piecesDownloaded, piecesWritten: s.piecesWritten, acknowledged: s.acknowledged, haveOf: s.haveOf,
      filesReportedComplete: s.filesReportedComplete, durationSec: s.durationSec,
      files: s.files, hashesValid: s.hashesValid, outcome: s.outcome, endReason: s.endReason,
      firstContact: s.firstContact, lastContact: s.lastContact, clients: (s.clients || []).slice(0, 5)
    },
    warnings: (model.warnings || []).length,
    storage: { mode: st.mode || null, caseDir: st.caseDir || null, sourceCaseDir: st.sourceCaseDir || null },
    importedAt: (model.import && model.import.importedAt) || null
  };
}

// ── IPC registration ─────────────────────────────────────────────────────
/**
 * deps: { ipcMain, dialog, getMainWindow(), getCasesDir(), getSecurity(),
 *         restoreFocus(), sourceFingerprint(spec)?, encryptMaxBytes? }
 */
function register(deps) {
  const { ipcMain, dialog } = deps;
  const jobs = new Map();
  const sec = () => (deps.getSecurity ? deps.getSecurity() : null);
  const casesDir = () => deps.getCasesDir();

  ipcMain.handle('bt-pick-source', async () => {
    const win = deps.getMainWindow ? deps.getMainWindow() : null;
    const res = await dialog.showOpenDialog(win, {
      title: 'Select the Torrential Downpour folder (investigations, IP, or download folder)',
      properties: ['openDirectory']
    });
    if (deps.restoreFocus) deps.restoreFocus();
    if (res.canceled || !res.filePaths || !res.filePaths.length) return null;
    const picked = res.filePaths[0];
    const downloads = Td.findTdDownloads(picked, { maxDepth: 4 }).map(f => describe(f, sec(), casesDir()));
    return { path: picked, downloads };
  });

  ipcMain.handle('bt-scan', async (_e, { caseNumber, extraPaths } = {}) => {
    try {
      const out = [], seen = new Set();
      const add = (list, source) => {
        for (const f of list) {
          const k = path.resolve(f.logsDir).toLowerCase();
          if (seen.has(k)) continue;
          seen.add(k);
          out.push(Object.assign(describe(f, sec(), casesDir()), { source }));
        }
      };
      if (caseNumber) {
        const ev = path.join(caseRoot(casesDir(), caseNumber), 'Evidence');
        if (fs.existsSync(ev)) add(Td.findTdDownloads(ev, { maxDepth: 6 }), 'case');
      }
      for (const p of (Array.isArray(extraPaths) ? extraPaths.slice(0, 200) : [])) {
        if (typeof p !== 'string' || !p) continue;
        let st; try { st = fs.statSync(p); } catch (_) { continue; }
        add(Td.findTdDownloads(st.isDirectory() ? p : path.dirname(p), { maxDepth: 4 }), 'evidence-link');
      }
      return { success: true, downloads: out };
    } catch (error) {
      return { success: false, error: error.message, downloads: [] };
    }
  });

  ipcMain.handle('bt-import', async (event, { jobId, caseNumber, sourceDir, mode } = {}) => {
    const job = { cancelled: false };
    const id = String(jobId || Date.now());
    jobs.set(id, job);
    const send = (p) => { try { if (!event.sender.isDestroyed()) event.sender.send('bt-progress', Object.assign({ jobId: id }, p)); } catch (_) { /* */ } };
    try {
      const security = sec();
      const root = caseRoot(casesDir(), caseNumber);
      const found = Td.discoverLogs(sourceDir);
      if (!found) { const e = new Error('No Torrential Downpour logs (details.txt / summary.txt) were found in that folder.'); e.code = 'NOT_TD'; throw e; }
      const copy = mode === 'copy';
      const fingerprintP = deps.sourceFingerprint ? deps.sourceFingerprint({ path: found.logsDir }) : Promise.resolve(null);
      const model = await Td.parseTdDownload(found, Object.assign({
        onProgress: (p) => send(p),
        isCancelled: () => job.cancelled
      }, vaultIo(security)));
      let copied = null;
      if (copy) {
        copied = await copyDownload(found, path.join(root, 'Evidence', 'BitTorrent'), {
          security, onProgress: send, isCancelled: () => job.cancelled, encryptMaxBytes: deps.encryptMaxBytes
        });
      }
      const stored = copied ? Td.discoverLogs(copied.dest) : found;
      model.storage = {
        mode: copy ? 'copy' : (_within(found.caseDir, root) ? 'case' : 'reference'),
        caseDir: stored ? stored.caseDir : found.caseDir,
        logsDir: stored ? stored.logsDir : found.logsDir,
        downloadDir: stored ? stored.downloadDir : found.downloadDir,
        sourceCaseDir: found.caseDir
      };
      model.import = { importedAt: new Date().toISOString(), sourceIntegrity: await fingerprintP };
      send({ phase: 'save' });
      const file = modelPath(casesDir(), caseNumber, model.id);
      const bytes = writeModel(file, model, security);
      return {
        success: true,
        meta: metaOf(model),
        jsonBytes: bytes,
        copied: copied ? { dest: copied.dest, files: copied.files, bytes: copied.bytes, logFiles: copied.logFiles, mediaFiles: copied.mediaFiles } : null
      };
    } catch (error) {
      if (error && error.cancelled) return { success: false, cancelled: true, error: 'Import cancelled.' };
      console.error('BitTorrent import error:', error && error.code ? `${error.code}: ${error.message}` : (error && error.message));
      return { success: false, error: error.message, code: (error && error.code) || null };
    } finally {
      jobs.delete(id);
    }
  });

  ipcMain.handle('bt-cancel', async (_e, { jobId } = {}) => {
    const j = jobs.get(String(jobId));
    if (j) j.cancelled = true;
    return { success: !!j };
  });

  ipcMain.handle('bt-read', async (_e, { caseNumber, downloadId } = {}) => {
    try {
      const file = modelPath(casesDir(), caseNumber, downloadId);
      if (!fs.existsSync(file)) return { success: false, code: 'MISSING', error: 'The parsed results for this download are missing. Re-import it.' };
      return { success: true, model: readModel(file, sec()) };
    } catch (error) {
      return { success: false, error: error.message, code: (error && error.code) || null };
    }
  });

  ipcMain.handle('bt-delete', async (_e, { caseNumber, downloadId } = {}) => {
    try {
      const file = modelPath(casesDir(), caseNumber, downloadId);
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  return { jobs };
}

module.exports = {
  register, copyDownload, vaultIo, isEncryptedFile, writeModel, readModel, metaOf, describe,
  modelPath, safeId, safeSegment, ENCRYPT_MAX_DEFAULT
};

/**
 * VIPER BitTorrent tab — main-process IPC (Torrential Downpour imports).
 *
 *   bt-pick-source  folder picker → TD downloads found under it
 *   bt-scan         TD downloads in cases/<n>/Evidence + linked Evidence paths
 *   bt-import       parse (and optionally copy into Evidence/BitTorrent/…) →
 *                   cases/<n>/BitTorrent/<downloadId>.json
 *   bt-read         parsed model for one download
 *   bt-delete       remove the parsed JSON (never touches Evidence files)
 *   bt-cancel       cancel a running import / hash check
 *   bt-media-list   which torrent files are on disk in the Download folder
 *   bt-media-url    viper-media:// URL for one file (by index, never a path)
 *   bt-video        ffmpeg thumbnail / playback copy for one video
 *   bt-verify       re-hash files on disk against the log's SHA-1 values
 * Progress: 'bt-progress' { jobId, phase:'logs'|'copy'|'save'|'verify', ... }
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
    storage: { mode: st.mode || null, caseDir: st.caseDir || null, sourceCaseDir: st.sourceCaseDir || null, hasDownload: !!st.downloadDir },
    importedAt: (model.import && model.import.importedAt) || null,
    verify: verifySummary(model.verify)
  };
}

// ── Downloaded files: find on disk, serve, verify (BT Phase 4) ──────────
const VP = require('../_shared/video-playback');
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'jpe', 'jfif', 'png', 'gif', 'bmp', 'webp', 'avif', 'ico']);
const VIDEO_EXT = new Set(VP.ALL_VIDEO_EXT || []);
function mediaKind(name) {
  const m = /\.([^.\\/]+)$/.exec(String(name || ''));
  const e = m ? m[1].toLowerCase() : '';
  return IMAGE_EXT.has(e) ? 'image' : VIDEO_EXT.has(e) ? 'video' : 'other';
}

/*
 * ── Finding the downloaded files ─────────────────────────────────────────
 * The torrent's file list is matched to files on disk, nearest place first:
 *   1. the download's own Download folder (as recorded at import),
 *   2. the rest of its own TD folder (media beside the logs, a "Downloads"
 *      or renamed folder, files uploaded flat next to details.txt),
 *   3. only if files are still missing: this case's Evidence folder and the
 *      folders behind "reference only" Evidence items. Other TD downloads'
 *      folders are skipped there, so files are never borrowed from a
 *      different suspect's download of the same torrent.
 * Stored paths that moved (case folder relocated) are re-based onto the
 * current cases folder. Match strength, strongest first:
 *   path   the torrent path (or the path TD logged writing it) ends the disk path
 *   name~  the same after Windows-unsafe characters, spaces, '_' and '-' are dropped
 *   size   same file name (letters and digits only) and exactly the torrent's size
 *   name   same file name, unique in the torrent (own TD folder only)
 * Outside the download's own folder a match also needs the exact size (or a
 * folder+name match for a partial file), and a file found in two different
 * Evidence items is left unmatched (ambiguous) rather than guessed.
 * The renderer only ever gets indexes, counts and Evidence folder names.
 */
const ENC_HEADER = 40;                      // modules/security.js HEADER_SIZE (AES-GCM, no padding)
const ENC_MAGIC = Buffer.from('VIPENC');
const WIDE_MAX_ENTRIES = 300000;
const WIDE_MAX_DEPTH = 14;
const UNSAFE = /[<>:"\\/|?*\x00-\x1f]/g;

function _nfc(s) { s = String(s == null ? '' : s); try { return s.normalize('NFC'); } catch (_) { return s; } }
function _segsOf(p) { return _nfc(p).replace(/[\\/]+/g, '/').replace(/^\/+|\/+$/g, '').split('/').filter(Boolean); }
function _lowSeg(s) { return _nfc(s).toLowerCase(); }
/** Windows/TD-safe form: no unsafe chars, no trailing dots/spaces, no spaces, '_' or '-'. */
function _canonSeg(s) { return _lowSeg(s).replace(UNSAFE, '').replace(/[. ]+$/, '').replace(/[\s_-]+/g, ''); }
/** Letters and digits only (survives zip tools that garble non-ASCII names); falls back to _canonSeg. */
function _asciiName(s) {
  const c = _canonSeg(s);
  const m = /^(.*?)(\.[a-z0-9]{1,8})?$/.exec(c);
  const stem = (m[1] || '').replace(/[^a-z0-9]+/g, '');
  return stem ? stem + (m[2] || '') : c;
}

function _plainSize(full, size, security) {
  if (size < ENC_HEADER) return size;
  const head = _peek(full, MAGIC_PEEK);
  const enc = security && typeof security.isEncryptedBuffer === 'function' ? security.isEncryptedBuffer(head)
    : (head.length >= 6 && head.subarray(0, 6).equals(ENC_MAGIC));
  return enc ? size - ENC_HEADER : size;
}

/** Existing folder, or the same folder re-based under the current cases folder. */
function _reach(p, ctx) {
  if (!p) return null;
  try { if (fs.statSync(p).isDirectory()) return path.resolve(p); } catch (_) { /* moved? */ }
  const cn = ctx && ctx.caseNumber ? String(ctx.caseNumber).toLowerCase() : null;
  if (!cn || !ctx.casesDir) return null;
  const segs = String(p).split(/[\\/]+/);
  for (let i = segs.length - 2; i >= 0; i--) {
    if (segs[i].toLowerCase() === cn && /^evidence$/i.test(segs[i + 1])) {
      const q = path.join(ctx.casesDir, segs[i], ...segs.slice(i + 1));
      try { if (fs.statSync(q).isDirectory()) return path.resolve(q); } catch (_) { /* */ }
      return null;
    }
  }
  return null;
}

function _isTdLogFile(name) {
  return _rollIdx(name, 'details') >= 0 || _rollIdx(name, 'summary') >= 0 || /^torrentinfo\.txt$/i.test(name);
}
function _rollIdx(name, base) {
  const m = new RegExp('^' + base + '(?:_(\\d+))?\\.txt$', 'i').exec(name);
  return m ? (m[1] ? parseInt(m[1], 10) : 0) : -1;
}
/**
 * TD folder check for the Evidence-wide search.
 * → null (not a TD folder) | 'twin' (a copy of THIS download: its log files
 *   have the same names and byte sizes as the ones parsed) | 'other'.
 */
function _tdFolderKind(dir, ents, model) {
  let logsDir = null, names = null;
  if (ents.some(e => e.isFile() && _isTdLogFile(e.name))) { logsDir = dir; names = ents.filter(e => e.isFile()).map(e => e.name); }
  else {
    const logs = ents.find(e => e.isDirectory() && /^logs$/i.test(e.name));
    if (!logs) return null;
    logsDir = path.join(dir, logs.name);
    try { names = fs.readdirSync(logsDir); } catch (_) { return null; }
    if (!names.some(_isTdLogFile)) return null;
  }
  const src = new Map();
  for (const s of ((model && model.sources) || [])) if (s && s.name && s.bytes != null && _isTdLogFile(String(s.name))) src.set(String(s.name).toLowerCase(), Number(s.bytes));
  let compared = 0;
  for (const n of names) {
    if (!_isTdLogFile(n)) continue;
    const want = src.get(n.toLowerCase());
    if (want == null) continue;
    let size;
    try { size = fs.statSync(path.join(logsDir, n)).size; } catch (_) { return 'other'; }
    if (size !== want && size !== want + ENC_HEADER && size !== want - ENC_HEADER) return 'other';
    compared++;
  }
  return compared ? 'twin' : 'other';
}

/** Torrent-side lookup tables. */
function _wantTables(model) {
  const files = (model.files || []).filter(f => f && Number.isInteger(f.index));
  const exact = new Map(), canon = new Map(), bySize = new Map(), byName = new Map();
  const put = (m, k, idx) => { if (!k) return; const s = m.get(k); if (!s) m.set(k, new Set([idx])); else s.add(idx); };
  const info = new Map();
  for (const f of files) {
    const paths = [];
    if (f.path) paths.push(_segsOf(f.path));
    if (f.diskPath) { const d = _segsOf(f.diskPath).filter(s => !/^[a-z]:$/i.test(s)); paths.push(d); if (d.length > 1) paths.push(d.slice(1)); }
    for (const s of paths) {
      if (!s.length) continue;
      put(exact, s.map(_lowSeg).join('/'), f.index);
      put(canon, s.map(_canonSeg).join('/'), f.index);
    }
    const base = (paths[0] || []).slice(-1)[0] || f.name || '';
    if (!base) continue;
    const an = _asciiName(base);
    if (f.size != null) put(bySize, an + '|' + f.size, f.index);
    put(byName, _canonSeg(base), f.index);
    info.set(f.index, { size: f.size != null ? Number(f.size) : null, status: f.status || null, segs: (paths[0] || []).length });
  }
  return { exact, canon, bySize, byName, info, files };
}
const _one = (set) => (set && set.size === 1 ? set.values().next().value : null);

/**
 * Best torrent index for one disk file. → { idx, tier, segs } | null
 * own: inside the download's own TD folder (looser rules).
 */
function _matchFile(W, relSegs, size, full, own, security) {
  const low = relSegs.map(_lowSeg), can = relSegs.map(_canonSeg);
  let plain = null;
  const psize = () => (plain == null ? (plain = _plainSize(full, size, security)) : plain);
  const sizeOk = (idx, n) => {
    const want = W.info.get(idx) ? W.info.get(idx).size : null;
    if (own) return true;
    if (want == null) return n >= 2;
    const s = psize();
    return s === want || (n >= 2 && s > 0 && s <= want);
  };
  for (const [tab, segs, tier] of [[W.exact, low, 1], [W.canon, can, 2]]) {
    for (let k = 0; k < segs.length; k++) {
      const idx = _one(tab.get(segs.slice(k).join('/')));
      if (idx != null && sizeOk(idx, segs.length - k)) return { idx, tier, segs: segs.length - k };
    }
  }
  const base = relSegs[relSegs.length - 1];
  const s = psize();
  if (s > 0) {
    const idx = _one(W.bySize.get(_asciiName(base) + '|' + s));
    if (idx != null) return { idx, tier: 3, segs: 1 };
  }
  if (own && s > 0) {
    const idx = _one(W.byName.get(_canonSeg(base)));
    const want = idx != null && W.info.get(idx) ? W.info.get(idx).size : null;
    if (idx != null && (want == null || s <= want)) return { idx, tier: 4, segs: 1 };
  }
  return null;
}

const HOW = { 1: 'path', 2: 'name~', 3: 'size', 4: 'name' };

/** Own roots: Download folder first, then the rest of the TD folder. */
function _ownRoots(model, ctx) {
  const st = (model && model.storage) || {};
  const roots = [];
  const dl = _reach(st.downloadDir, ctx);
  if (dl) roots.push({ dir: dl, where: 'download' });
  const cd = _reach(st.caseDir, ctx) || _reach(st.logsDir, ctx);
  if (cd && !_tooBroad(cd, ctx) && !roots.some(r => _within(cd, r.dir))) roots.push({ dir: cd, where: 'case' });
  return { roots, downloadDir: dl, recordedDownload: st.downloadDir || null };
}

/**
 * A "TD folder" that is really a drive root, the cases folder, a case folder or
 * its whole Evidence folder (Logs uploaded straight into Evidence) is not
 * searched with the loose own-folder rules; the Evidence-wide search covers it.
 */
function _tooBroad(dir, ctx) {
  const d = path.resolve(dir);
  if (path.parse(d).root.toLowerCase() === d.toLowerCase()) return true;
  const cdir = ctx && ctx.casesDir ? path.resolve(ctx.casesDir) : null;
  if (!cdir) return false;
  if (_within(cdir, d)) return true;                       // cases folder or above
  const rel = path.relative(cdir, d).split(/[\\/]+/).filter(Boolean);
  return _within(d, cdir) && (rel.length === 1 || (rel.length === 2 && /^evidence$/i.test(rel[1])));
}

/** Own-folder listing; skips nested TD folders that belong to another download. */
function _walkOwn(root, model) {
  const out = [];
  let left = WIDE_MAX_ENTRIES;
  (function walk(d, depth) {
    if (left <= 0) return;
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    left -= ents.length;
    if (depth > 0 && _tdFolderKind(d, ents, model) === 'other') return;
    for (const e of ents) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < WIDE_MAX_DEPTH) walk(full, depth + 1); }
      else if (e.isFile()) { let size = 0; try { size = fs.statSync(full).size; } catch (_) { /* */ } out.push({ full, size }); }
    }
  })(root, 0);
  return out;
}

/** Pick per index: own before wide, then tier; wide ties across Evidence items → ambiguous. */
function _assign(cands, res) {
  const per = new Map();
  for (const c of cands) { const a = per.get(c.idx); if (a) a.push(c); else per.set(c.idx, [c]); }
  const rank = (c) => (c.own ? 0 : (c.twin ? 500 : 1000)) + c.tier * 100 + (c.where === 'download' ? 0 : 50) - Math.min(49, c.segs);
  const used = new Set();
  const order = [...per.keys()].sort((a, b) => a - b);
  for (const idx of order) {
    const list = per.get(idx).filter(c => !used.has(c.full.toLowerCase()))
      .sort((a, b) => rank(a) - rank(b) || (a.full < b.full ? -1 : a.full > b.full ? 1 : 0));
    if (!list.length) continue;
    const best = rank(list[0]);
    const top = list.filter(c => rank(c) === best);
    if (!top[0].own && !top.every(c => c.twin) && new Set(top.map(c => String(c.item || '').toLowerCase())).size > 1) { res.ambiguous.push(idx); continue; }
    const c = top[0];
    used.add(c.full.toLowerCase());
    res.byIndex.set(idx, { path: c.full, size: c.size, how: HOW[c.tier], where: c.where, item: c.item });
  }
}

function _relSegs(full, root) { return path.relative(root, full).split(/[\\/]+/).filter(Boolean); }

/**
 * Sync, own TD folder only (no Evidence-wide search).
 * → { downloadDir, exists, byIndex: Map<index,{path,size,how,where}>, extra, ambiguous[], roots[] }
 */
function resolveDownloadFiles(model, ctx) {
  ctx = ctx || {};
  const own = _ownRoots(model, ctx);
  const res = {
    downloadDir: own.recordedDownload, exists: !!own.downloadDir, caseFolderFound: own.roots.length > 0,
    byIndex: new Map(), extra: 0, ambiguous: [], roots: own.roots.map(r => r.dir),
    searchedEvidence: false, searchCapped: false
  };
  if (!own.roots.length) return res;
  const W = _wantTables(model);
  const cands = [];
  const done = [];
  for (const r of own.roots) {
    for (const it of _walkOwn(r.dir, model)) {
      if (done.some(d => _within(it.full, d))) continue;
      if (!_within(it.full, r.dir)) continue;
      const m = _matchFile(W, _relSegs(it.full, r.dir), it.size, it.full, true, ctx.security);
      if (!m) { if (r.where === 'download') res.extra++; continue; }
      cands.push({ idx: m.idx, tier: m.tier, segs: m.segs, own: true, full: it.full, size: it.size, where: r.where, item: '' });
    }
    done.push(r.dir);
  }
  _assign(cands, res);
  // Files claimed twice inside the Download folder still count as "extra" there.
  return res;
}

/** Async walk for the Evidence-wide search (keeps the main process responsive). */
async function _walkWide(root, skip, budget, model) {
  const out = [];
  async function walk(dir, depth, twin) {
    if (budget.left <= 0) { budget.capped = true; return; }
    let ents;
    try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
    budget.left -= ents.length;
    if (depth > 0 && !twin) {
      const kind = _tdFolderKind(dir, ents, model);
      if (kind === 'other') return;           // another download: never borrow its files
      if (kind === 'twin') twin = true;       // a copy of this download
    }
    for (const e of ents) {
      if (e.isSymbolicLink() || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth >= WIDE_MAX_DEPTH || skip.some(s => _within(full, s))) continue;
        await walk(full, depth + 1, twin);
      } else if (e.isFile()) out.push({ full, twin });
    }
  }
  await walk(root, 0, false);
  return out;
}

/** Name filter so only plausible files are stat'ed during the wide search. */
function _nameFilter(W) {
  const names = new Set();
  for (const f of W.files) {
    const base = _segsOf(f.path || f.name || '').slice(-1)[0];
    if (base) { names.add(_canonSeg(base)); names.add(_asciiName(base)); }
  }
  return (full) => { const b = path.basename(full); return names.has(_canonSeg(b)) || names.has(_asciiName(b)); };
}

/**
 * Own folder first, then (only if wanted files are still missing) this case's
 * Evidence folder and linked "reference only" Evidence folders.
 * ctx: { casesDir, caseNumber, extraRoots[], security, wide? (cached listing) }
 * → resolveDownloadFiles() result + { searchedEvidence, elsewhere, places[], wide }
 */
async function locateDownloadFiles(model, ctx) {
  ctx = ctx || {};
  const res = resolveDownloadFiles(model, ctx);
  const W = _wantTables(model);
  const wanted = W.files.filter(f => f.status !== 'none' && !res.byIndex.has(f.index));
  const wideRoots = [];
  if (ctx.casesDir && ctx.caseNumber && safeSegment(ctx.caseNumber)) {
    const ev = path.join(ctx.casesDir, String(ctx.caseNumber), 'Evidence');
    try { if (fs.statSync(ev).isDirectory()) wideRoots.push({ dir: path.resolve(ev), where: 'evidence' }); } catch (_) { /* */ }
  }
  for (const p of (ctx.extraRoots || [])) if (!wideRoots.some(r => _within(p, r.dir))) wideRoots.push({ dir: p, where: 'linked' });
  if (wanted.length && wideRoots.length) {
    const sig = String(model.id || '') + '|' + wideRoots.map(r => r.dir).join('|');
    let listing = ctx.wide && ctx.wide.sig === sig ? ctx.wide : null;
    if (!listing) {
      const budget = { left: WIDE_MAX_ENTRIES, capped: false };
      const keep = _nameFilter(W);
      const files = [];
      for (const r of wideRoots) {
        for (const w of await _walkWide(r.dir, res.roots, budget, model)) {
          if (!keep(w.full)) continue;
          const rel = _relSegs(w.full, r.dir);
          files.push({ full: w.full, rel, twin: w.twin, where: r.where, item: r.where === 'evidence' ? (rel.length > 1 ? rel[0] : '') : path.basename(r.dir), root: r.dir });
        }
      }
      listing = { sig, at: Date.now(), files, capped: budget.capped };
    }
    res.wide = listing;
    res.searchedEvidence = true;
    res.searchCapped = !!listing.capped;
    const cands = [];
    for (const f of listing.files) {
      if (res.roots.some(d => _within(f.full, d))) continue;
      let size = 0;
      try { const st = fs.statSync(f.full); if (!st.isFile()) continue; size = st.size; } catch (_) { continue; }
      const m = _matchFile(W, f.rel, size, f.full, !!f.twin, ctx.security);
      if (!m || res.byIndex.has(m.idx)) continue;
      cands.push({ idx: m.idx, tier: m.tier, segs: m.segs, own: false, twin: !!f.twin, full: f.full, size, where: f.where, item: f.item, root: f.root });
    }
    if (cands.length) {
      const sub = { byIndex: new Map(), ambiguous: [] };
      _assign(cands, sub);
      for (const [idx, v] of sub.byIndex) res.byIndex.set(idx, v);
      res.ambiguous.push(...sub.ambiguous);
      for (const r of wideRoots) if (!res.roots.includes(r.dir) && [...sub.byIndex.values()].some(v => _within(v.path, r.dir))) res.roots.push(r.dir);
    }
  }
  const places = new Map();
  for (const v of res.byIndex.values()) {
    if (v.where !== 'evidence' && v.where !== 'linked') continue;
    const k = v.where + '|' + v.item;
    const p = places.get(k) || { where: v.where, label: v.item || 'Evidence', count: 0 };
    p.count++;
    places.set(k, p);
  }
  res.places = [...places.values()].sort((a, b) => b.count - a.count).slice(0, 10);
  res.elsewhere = res.places.reduce((a, p) => a + p.count, 0);
  return res;
}

/** Renderer-sent linked Evidence folders: absolute, existing, never a drive root. */
function cleanExtraRoots(list) {
  const out = [];
  for (const p of (Array.isArray(list) ? list.slice(0, 200) : [])) {
    if (typeof p !== 'string' || !p || p.indexOf('\0') >= 0 || !path.isAbsolute(p)) continue;
    let d = path.resolve(p), st;
    try { st = fs.statSync(d); } catch (_) { continue; }
    if (!st.isDirectory()) d = path.dirname(d);
    if (path.parse(d).root.toLowerCase() === d.toLowerCase()) continue;
    if (!out.some(x => _within(d, x))) out.push(d);
    if (out.length >= 50) break;
  }
  return out;
}

function sha1File(p, security, isCancelled) {
  if (isEncryptedFile(p, security)) {
    return Promise.resolve(require('crypto').createHash('sha1').update(_decryptFile(p, security)).digest('hex'));
  }
  return new Promise((resolve, reject) => {
    const h = require('crypto').createHash('sha1');
    const s = fs.createReadStream(p, { highWaterMark: 1 << 20 });
    s.on('data', (b) => { if (isCancelled && isCancelled()) { s.destroy(); const e = new Error('cancelled'); e.cancelled = true; reject(e); return; } h.update(b); });
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

const VERIFY_LIST_MAX = 5000;
/**
 * Re-hash every file the log has a SHA-1 for and compare.
 * → { at, downloadFolder, withHash, checked, matched, mismatched[], missing[], unreadable[], partialOnDisk, noHashInLog }
 */
async function verifyDownload(model, resolved, opts) {
  opts = opts || {};
  const security = opts.security || null;
  const onProgress = opts.onProgress || (() => {});
  const isCancelled = opts.isCancelled || (() => false);
  const files = (model.files || []).filter(Boolean);
  const hashed = files.filter(f => /^[0-9a-f]{40}$/i.test(String(f.sha1 || '')));
  const out = {
    at: new Date().toISOString(), downloadFolder: !!resolved.exists, withHash: hashed.length,
    checked: 0, matched: 0, mismatched: [], missing: [], unreadable: [],
    partialOnDisk: 0, noHashInLog: files.length - hashed.length
  };
  for (const f of files) if (!f.sha1 && resolved.byIndex.has(f.index)) out.partialOnDisk++;
  const bytesTotal = hashed.reduce((a, f) => { const loc = resolved.byIndex.get(f.index); return a + (loc ? loc.size : 0); }, 0);
  let bytesDone = 0, lastTick = 0;
  const push = (arr, v) => { if (arr.length < VERIFY_LIST_MAX) arr.push(v); };
  for (const f of hashed) {
    if (isCancelled()) { const e = new Error('cancelled'); e.cancelled = true; throw e; }
    const loc = resolved.byIndex.get(f.index);
    if (!loc) { push(out.missing, f.index); continue; }
    let h = null;
    try { h = await sha1File(loc.path, security, isCancelled); } catch (e) {
      if (e && (e.cancelled || e.code === 'VAULT_LOCKED')) throw e;
      push(out.unreadable, f.index);
    }
    if (h) {
      out.checked++;
      if (h === String(f.sha1).toLowerCase()) out.matched++; else push(out.mismatched, f.index);
    }
    bytesDone += loc.size;
    const now = Date.now();
    if (now - lastTick > 200) { lastTick = now; onProgress({ phase: 'verify', bytesDone, bytesTotal, filesDone: out.checked + out.missing.length + out.unreadable.length, filesTotal: hashed.length }); }
  }
  onProgress({ phase: 'verify', bytesDone: bytesTotal, bytesTotal, filesDone: hashed.length, filesTotal: hashed.length });
  return out;
}
function verifySummary(v) {
  if (!v) return null;
  return { at: v.at, withHash: v.withHash, checked: v.checked, matched: v.matched, mismatched: v.mismatched.length, missing: v.missing.length, unreadable: v.unreadable.length, downloadFolder: v.downloadFolder };
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

  // ── Downloaded files (BT Phase 4) ──
  // Media is only ever looked up by { caseNumber, downloadId, index }: the
  // renderer never sends a path to serve. A file is served only if it was
  // matched by locateDownloadFiles() and sits inside one of the folders it
  // searched (own TD folder, this case's Evidence folder, linked folders).
  const resolvedCache = new Map(); // model file → { mtimeMs, at, model, res, extraSig }
  const RESOLVE_TTL = 10 * 60 * 1000;
  const WIDE_TTL = 2 * 60 * 1000;
  const lastExtra = new Map();     // case → linked Evidence folders last sent by the renderer
  const inflight = new Map();      // model file → pending locate (thumbnail bursts share one search)
  async function loadResolved(caseNumber, downloadId, opts) {
    opts = opts || {};
    const file = modelPath(casesDir(), caseNumber, downloadId);
    let st;
    try { st = fs.statSync(file); } catch (_) { const e = new Error('The parsed results for this download are missing. Re-import it.'); e.code = 'MISSING'; throw e; }
    const ck = String(caseNumber).toLowerCase();
    if (Array.isArray(opts.extraPaths)) lastExtra.set(ck, cleanExtraRoots(opts.extraPaths));
    const extraRoots = lastExtra.get(ck) || [];
    const extraSig = extraRoots.join('|');
    const hit = resolvedCache.get(file);
    if (!opts.fresh && hit && hit.mtimeMs === st.mtimeMs && hit.extraSig === extraSig && Date.now() - hit.at < RESOLVE_TTL) return hit;
    if (!opts.fresh && inflight.has(file)) return inflight.get(file);
    const job = (async () => {
      const model = readModel(file, sec());
      const wide = !opts.rescan && hit && hit.res.wide && Date.now() - hit.res.wide.at < WIDE_TTL ? hit.res.wide : null;
      const res = await locateDownloadFiles(model, { casesDir: casesDir(), caseNumber, extraRoots, security: sec(), wide });
      const v = { file, mtimeMs: st.mtimeMs, at: Date.now(), model, res, extraSig };
      resolvedCache.delete(file);
      resolvedCache.set(file, v);
      if (resolvedCache.size > 20) resolvedCache.delete(resolvedCache.keys().next().value);
      return v;
    })();
    inflight.set(file, job);
    try { return await job; } finally { if (inflight.get(file) === job) inflight.delete(file); }
  }
  async function fileFor(a) {
    const v = await loadResolved(a.caseNumber, a.downloadId);
    const idx = typeof a.index === 'number' ? a.index : (/^\d{1,9}$/.test(String(a.index == null ? '' : a.index)) ? Number(a.index) : NaN);
    if (!Number.isInteger(idx) || idx < 0) return null;
    const loc = v.res.byIndex.get(idx);
    if (!loc || !v.res.roots.some(r => _within(loc.path, r))) return null;
    try { if (!fs.statSync(loc.path).isFile()) return null; } catch (_) { return null; }
    return loc.path;
  }

  ipcMain.handle('bt-media-list', async (_e, { caseNumber, downloadId, extraPaths, rescan } = {}) => {
    try {
      const v = await loadResolved(caseNumber, downloadId, { fresh: true, rescan: !!rescan, extraPaths });
      const onDisk = {}, how = {};
      for (const [idx, loc] of v.res.byIndex) { onDisk[idx] = loc.size; how[loc.how] = (how[loc.how] || 0) + 1; }
      return {
        success: true, hasDownloadFolder: !!v.res.downloadDir, folderFound: v.res.exists,
        caseFolderFound: !!v.res.caseFolderFound, onDisk, matched: v.res.byIndex.size, extra: v.res.extra,
        ambiguous: v.res.ambiguous.length, elsewhere: v.res.elsewhere || 0,
        places: (v.res.places || []).map(p => ({ where: p.where, label: String(p.label || ''), count: p.count })),
        searchedEvidence: !!v.res.searchedEvidence, searchCapped: !!v.res.searchCapped, how,
        verify: v.model.verify || null
      };
    } catch (error) {
      return { success: false, error: error.message, code: (error && error.code) || null };
    }
  });

  ipcMain.handle('bt-media-url', async (_e, a = {}) => {
    try {
      const p = await fileFor(a);
      if (!p) return { success: false, reason: 'not-on-disk', error: 'This file was not found in the evidence.' };
      if (typeof deps.mediaUrl !== 'function') return { success: false, error: 'Viewer not available.' };
      return await deps.mediaUrl(p);
    } catch (error) {
      return { success: false, error: error.message, code: (error && error.code) || null };
    }
  });

  ipcMain.handle('bt-video', async (event, a = {}) => {
    let p = null;
    try { p = await fileFor(a); } catch (_) { p = null; }
    if (!p) return { success: false, reason: 'not-allowed', error: 'This file was not found in the evidence.' };
    const vp = deps.videoPlayback;
    if (!vp) return { success: false, noEngine: true, error: 'Video playback is not available.' };
    if (a.op === 'thumb') return vp.thumb({ filePath: p, size: a.size, anyExt: true });
    const sender = event.sender;
    const jobId = String(a.jobId || '').slice(0, 64);
    return vp.prepare({
      filePath: p, anyExt: true,
      onProgress: (x) => { try { if (!sender.isDestroyed()) sender.send('video-playback-progress', Object.assign({ jobId }, x)); } catch (_) { /* */ } }
    });
  });

  ipcMain.handle('bt-verify', async (event, { jobId, caseNumber, downloadId } = {}) => {
    const job = { cancelled: false };
    const id = String(jobId || Date.now());
    jobs.set(id, job);
    const send = (p) => { try { if (!event.sender.isDestroyed()) event.sender.send('bt-progress', Object.assign({ jobId: id }, p)); } catch (_) { /* */ } };
    try {
      const security = sec();
      const v = await loadResolved(caseNumber, downloadId, { fresh: true });
      const result = await verifyDownload(v.model, v.res, { security, onProgress: send, isCancelled: () => job.cancelled });
      const model = readModel(v.file, security);   // re-read: never write back a stale copy
      model.verify = result;
      writeModel(v.file, model, security);
      resolvedCache.delete(v.file);
      return { success: true, verify: result, summary: verifySummary(result), meta: metaOf(model) };
    } catch (error) {
      if (error && error.cancelled) return { success: false, cancelled: true, error: 'Check cancelled.' };
      return { success: false, error: error.message, code: (error && error.code) || null };
    } finally {
      jobs.delete(id);
    }
  });

  return { jobs };
}

module.exports = {
  register, copyDownload, vaultIo, isEncryptedFile, writeModel, readModel, metaOf, describe,
  modelPath, safeId, safeSegment, ENCRYPT_MAX_DEFAULT,
  resolveDownloadFiles, locateDownloadFiles, cleanExtraRoots, verifyDownload, verifySummary, sha1File, mediaKind
};

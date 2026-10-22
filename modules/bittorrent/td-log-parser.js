/**
 * VIPER — BitTorrent (TD) tab: Torrential Downpour log parser.
 *
 * MAIN-PROCESS ONLY (uses fs). Streams the Logs folder of one TD single-source
 * download (details*.txt, summary*.txt, torrentinfo.txt, netstat.txt) and
 * returns a compact JSON model. Log files reach hundreds of MB, so nothing is
 * read whole except torrentinfo/netstat.
 *
 * Every fact keeps a source reference "<file>:<line>" so the card can show
 * where it came from. Lines the parser does not recognise are counted (by
 * template) instead of silently dropped.
 *
 * Covers TD 1.2x – 1.47 wording, including the 1.27 Teredo/IPv6 lines and
 * 12-hour timestamps. TD Receptor is out of scope for v1.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const TdModel = require('./td-model');

const PARSER_VERSION = 1;
const SCHEMA = 1;

// ── Discovery ────────────────────────────────────────────────────────────
const RE_CASE_DIR = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_(\d+)$/;           // 1.47: 20120312_150308_4
const RE_CASE_DIR_OLD = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})_(\d+)$/;    // <1.47: 2012-03-12_15-03-08_4
// IPv6 folders use '-' for ':'. Short forms must contain a hex letter or '--' (or be all 8 groups) so dates like 10-21-2026 never match.
const RE_IP_DIR = /^(.*)_((?:\d{1,3}\.){3}\d{1,3}|(?=[0-9a-fA-F-]*(?:[a-fA-F]|--))[0-9a-fA-F]{0,4}(?:-[0-9a-fA-F]{0,4}){2,7}|\d{1,4}(?:-\d{1,4}){7})$/;

function _ls(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
}

function _rollIndex(name, base) {
  const m = new RegExp('^' + base + '(?:_(\\d+))?\\.txt$', 'i').exec(name);
  return m ? (m[1] ? parseInt(m[1], 10) : 0) : -1;
}

function parseFolderMeta(caseDir) {
  const meta = { caseFolder: null, stamp: null, downloadId: null, ipFolder: null, location: null, ip: null };
  if (!caseDir) return meta;
  const base = path.basename(caseDir);
  const m = RE_CASE_DIR.exec(base) || RE_CASE_DIR_OLD.exec(base);
  if (m) {
    meta.caseFolder = base;
    meta.stamp = `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
    meta.downloadId = parseInt(m[7], 10);
  }
  const parent = path.basename(path.dirname(caseDir));
  const p = RE_IP_DIR.exec(parent);
  if (p) {
    meta.ipFolder = parent;
    meta.location = p[1] || null;
    meta.ip = p[2].indexOf('-') >= 0 ? p[2].replace(/-/g, ':') : p[2];
  }
  return meta;
}

/**
 * Hand-offs (OneDrive / zip extracts) sometimes leave details.txt beside a
 * subfolder holding the rest of the same Logs folder: rolled details parts,
 * summary, torrentinfo, netstat. Pull in what is missing from exactly one
 * such subfolder. Never from a TD case / IP / Logs / Download folder, and
 * never when two subfolders qualify (we can't tell which belongs).
 */
function _mergeCompanion(logsDir, files) {
  if (files.summary.length && files.torrentinfo && files.netstat) return;
  const subs = [];
  for (const e of _ls(logsDir)) {
    if (!e.isDirectory() || e.name.startsWith('.') || /^(download|logs)$/i.test(e.name) ||
        RE_CASE_DIR.test(e.name) || RE_CASE_DIR_OLD.test(e.name) || RE_IP_DIR.test(e.name)) continue;
    const dir = path.join(logsDir, e.name);
    const got = { dir, details: [], summary: [], torrentinfo: null, netstat: null };
    for (const f of _ls(dir)) {
      if (!f.isFile()) continue;
      const full = path.join(dir, f.name);
      let i;
      if ((i = _rollIndex(f.name, 'details')) >= 0) got.details.push({ path: full, name: f.name, roll: i });
      else if ((i = _rollIndex(f.name, 'summary')) >= 0) got.summary.push({ path: full, name: f.name, roll: i });
      else if (/^torrentinfo\.txt$/i.test(f.name)) got.torrentinfo = full;
      else if (/^netstat\.txt$/i.test(f.name)) got.netstat = full;
    }
    if (got.details.length || got.summary.length || got.torrentinfo) subs.push(got);
  }
  if (subs.length !== 1) return;
  const c = subs[0];
  const haveRoll = new Set(files.details.map(d => d.roll));
  const addRolls = c.details.filter(d => !haveRoll.has(d.roll));
  // Only rolled continuations of a details log we already hold, or a whole set when we hold none.
  if (files.details.length || !files.summary.length) files.details.push(...addRolls);
  if (!files.summary.length) files.summary.push(...c.summary);
  if (!files.torrentinfo) files.torrentinfo = c.torrentinfo;
  if (!files.netstat) files.netstat = c.netstat;
  files.companionDir = c.dir;
}

/**
 * Describe one TD download given its case folder, its Logs folder, or a
 * folder that directly holds the log files. Returns null if no TD logs.
 */
function discoverLogs(dir) {
  if (!dir) return null;
  let logsDir = null;
  const entries = _ls(dir);
  const logsSub = entries.find(e => e.isDirectory() && /^logs$/i.test(e.name));
  if (logsSub) logsDir = path.join(dir, logsSub.name);
  else if (entries.some(e => e.isFile() && (_rollIndex(e.name, 'details') >= 0 || _rollIndex(e.name, 'summary') >= 0 || /^torrentinfo\.txt$/i.test(e.name)))) logsDir = dir;
  if (!logsDir) return null;

  const caseDir = logsDir === dir && !/^logs$/i.test(path.basename(dir)) ? dir
    : (logsDir === dir ? path.dirname(dir) : dir);
  const files = { details: [], summary: [], torrentinfo: null, netstat: null, torrent: null, other: [] };
  for (const e of _ls(logsDir)) {
    if (!e.isFile()) continue;
    const full = path.join(logsDir, e.name);
    let i;
    if ((i = _rollIndex(e.name, 'details')) >= 0) files.details.push({ path: full, name: e.name, roll: i });
    else if ((i = _rollIndex(e.name, 'summary')) >= 0) files.summary.push({ path: full, name: e.name, roll: i });
    else if (/^torrentinfo\.txt$/i.test(e.name)) files.torrentinfo = full;
    else if (/^netstat\.txt$/i.test(e.name)) files.netstat = full;
    else if (/^[0-9a-f]{40}\.torrent$/i.test(e.name)) files.torrent = full;
    else files.other.push(e.name);
  }
  _mergeCompanion(logsDir, files);
  if (!files.details.length && !files.summary.length) return null;
  files.details.sort((a, b) => a.roll - b.roll);
  files.summary.sort((a, b) => a.roll - b.roll);

  let downloadDir = null;
  const caseEntries = caseDir === logsDir ? [] : _ls(caseDir);
  const dl = caseEntries.find(e => e.isDirectory() && /^download$/i.test(e.name));
  if (dl) downloadDir = path.join(caseDir, dl.name);

  return { caseDir, logsDir, downloadDir, files, folderMeta: parseFolderMeta(caseDir) };
}

/**
 * Find every TD download under `root` (an investigations folder, an IP
 * folder, a case folder, or a Logs folder). Depth-limited; skips Download.
 */
function findTdDownloads(root, opts) {
  const maxDepth = (opts && opts.maxDepth) || 4;
  const out = [];
  const seen = new Set();
  (function walk(dir, depth) {
    const d = discoverLogs(dir);
    if (d) {
      const k = path.resolve(d.logsDir).toLowerCase();
      if (!seen.has(k)) { seen.add(k); out.push(d); }
      return;
    }
    if (depth >= maxDepth) return;
    for (const e of _ls(dir)) {
      if (!e.isDirectory() || /^download$/i.test(e.name) || e.name.startsWith('.')) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  })(root, 0);
  return out;
}

// ── Line splitting ───────────────────────────────────────────────────────
const RE_TS24 = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) - (.*)$/;
const RE_TS12 = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2}) ?([AP]M) - (.*)$/i;
const RE_TSISO = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2}):(\d{2}) ?([AP]M)? - (.*)$/i;

function _p2(n) { return (n < 10 ? '0' : '') + n; }

function splitLine(line) {
  let m = RE_TS24.exec(line);
  if (m) return { ts: m[1] + ' ' + m[2], msg: m[3] };
  m = RE_TS12.exec(line);
  if (m) {
    let h = +m[4]; const pm = /p/i.test(m[7]);
    if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12;
    return { ts: `${m[3]}-${_p2(+m[1])}-${_p2(+m[2])} ${_p2(h)}:${m[5]}:${m[6]}`, msg: m[8] };
  }
  m = RE_TSISO.exec(line);
  if (m) {
    let h = +m[2];
    if (m[5]) { const pm = /p/i.test(m[5]); if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
    return { ts: `${m[1]} ${_p2(h)}:${m[3]}:${m[4]}`, msg: m[6] };
  }
  return { ts: null, msg: line.trim() };
}

function _template(msg) {
  return msg.replace(/"[^"]*"/g, 'S').replace(/[0-9a-f]{32,}/gi, 'H').replace(/\d+/g, 'N').slice(0, 120);
}

function _stripBrackets(ip) { return String(ip || '').trim().replace(/^\[|\]$/g, ''); }

function _parseKv(str) {
  const out = {};
  const re = /([A-Za-z_][\w]*)=(.*?)(?=, [A-Za-z_][\w]*=|$)/g;
  let m;
  while ((m = re.exec(str))) out[m[1]] = m[2].trim();
  return out;
}

// ── torrentinfo.txt ──────────────────────────────────────────────────────
function parseTorrentInfo(text) {
  const info = { infoHash: null, meta: {}, files: [], pieceHashes: [], fileCount: null, totalBytes: null, pieceCount: null, pieceSize: null, name: null };
  const lines = String(text || '').split(/\r?\n/);
  let section = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let m;
    if ((m = /^File (\d+) \((\d+) bytes\) has name:\s*(.*?):?$/.exec(line))) {
      info.files[+m[1]] = { path: m[3], size: +m[2] };
      continue;
    }
    if ((m = /^Piece (\d+) SHA-?1 hash:\s*([0-9a-f]{40})$/i.exec(line))) {
      info.pieceHashes[+m[1]] = m[2].toLowerCase();
      continue;
    }
    if (/^[A-Z][A-Z ]+$/.test(line)) { section = line; continue; }
    if ((m = /^SUMMARY OF .* INFO HASH ([0-9A-F]{40})/i.exec(line))) { info.infoHash = m[1].toLowerCase(); continue; }
    if ((m = /^Torrent info hash(?: \(hexadecimal\))?:\s*([0-9a-f]{40})/i.exec(line))) { info.infoHash = m[1].toLowerCase(); continue; }
    if ((m = /^Number of files defined by the torrent:\s*(\d+)/i.exec(line))) { info.fileCount = +m[1]; continue; }
    if ((m = /^Total bytes of all files combined:\s*(\d+)/i.exec(line))) { info.totalBytes = +m[1]; continue; }
    if ((m = /^Number of pieces defined by the torrent:\s*(\d+)/i.exec(line))) { info.pieceCount = +m[1]; continue; }
    if ((m = /^Piece size \(bytes\):\s*(\d+)/i.exec(line))) { info.pieceSize = +m[1]; continue; }
    if ((m = /^(?:Torrent )?name:\s*(.+)$/i.exec(line)) && !info.name) { info.name = m[1]; continue; }
    if ((m = /^([A-Za-z][^:]{2,60}):\s*(.+)$/.exec(line)) && section !== 'FILES DEFINED BY THE TORRENT') {
      info.meta[m[1]] = m[2];
    }
  }
  if (info.fileCount == null && info.files.length) info.fileCount = info.files.length;
  if (info.pieceCount == null && info.pieceHashes.length) info.pieceCount = info.pieceHashes.length;
  return info;
}

// ── netstat.txt ──────────────────────────────────────────────────────────
function _hostOf(addr) {
  const a = String(addr || '');
  const b = /^\[([^\]]+)\](?::\d+)?$/.exec(a);
  if (b) return b[1].toLowerCase();
  const i = a.lastIndexOf(':');
  return (i > 0 && a.indexOf(':') === i ? a.slice(0, i) : a).toLowerCase();
}

function parseNetstat(text, remoteIps, fileName) {
  const want = new Set((remoteIps || []).filter(Boolean).map(s => _stripBrackets(s).toLowerCase()));
  const blocks = [];
  let cur = null;
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^={10,}\s*$/.test(line)) { cur = null; continue; }
    let m;
    if ((m = /^\s*Client IP address:\s*(\S+)/i.exec(line))) {
      cur = { at: null, atText: null, clientIp: _stripBrackets(m[1]), rowCount: 0, matches: [], ref: `${fileName}:${i + 1}` };
      blocks.push(cur);
      continue;
    }
    if (!cur) continue;
    if (!cur.at && /\d{4}/.test(line) && /[A-Za-z]+ \d{1,2}, \d{4}/.test(line)) {
      cur.atText = line.trim();
      cur.at = TdModel.parseLongDate(line);
      continue;
    }
    if ((m = /^\s*(TCP|UDP)\s+(\S+)\s+(\S+)(?:\s+(\S+))?/i.exec(line))) {
      cur.rowCount++;
      const host = _hostOf(m[3]);
      if (want.has(host) || want.has(_hostOf(m[3]).replace(/^::ffff:/, '')) || (cur.clientIp && host === cur.clientIp.toLowerCase())) {
        cur.matches.push({ proto: m[1].toUpperCase(), local: m[2], foreign: m[3], state: m[4] || '', line: i + 1 });
      }
    }
  }
  return blocks;
}

// ── Streaming log reader ─────────────────────────────────────────────────
function _defaultStream(file) { return fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 }); }

function _readLines(file, onLine, ctl, createStream) {
  return new Promise((resolve, reject) => {
    let stream;
    try { stream = (createStream || _defaultStream)(file); } catch (e) { reject(e); return; }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let n = 0, stopped = false;
    const finish = (err) => { if (stopped) return; stopped = true; err ? reject(err) : resolve(n); };
    rl.on('line', (line) => {
      if (stopped) return;
      n++;
      if (n === 1 && line.charCodeAt(0) === 0xfeff) line = line.slice(1);
      try { onLine(line, n); } catch (e) { stopped = true; rl.close(); stream.destroy(); reject(e); return; }
      if ((n & 8191) === 0 && ctl) {
        if (ctl.cancelled()) { const e = new Error('cancelled'); e.cancelled = true; finish(e); rl.close(); stream.destroy(); return; }
        ctl.progress(stream.bytesRead || 0, n);
      }
    });
    rl.on('close', () => finish(null));
    stream.on('error', (e) => finish(e));
  });
}

/**
 * Parse one TD download.
 * @param {string|object} input  folder path or a discoverLogs() result
 * @param {object} [opts]
 *   onProgress({ phase, file, bytesDone, bytesTotal, lines })
 *   isCancelled() → bool
 * @returns {Promise<object>} parsed model (see README in tests for shape)
 */
async function parseTdDownload(input, opts) {
  opts = opts || {};
  const found = typeof input === 'string' ? discoverLogs(input) : input;
  if (!found) throw new Error('No Torrential Downpour logs (details.txt / summary.txt) found in that folder.');
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const isCancelled = typeof opts.isCancelled === 'function' ? opts.isCancelled : () => false;
  // I/O hooks (main process passes vault-aware versions for encrypted case copies)
  const createStream = typeof opts.createStream === 'function' ? opts.createStream : null;
  const readText = typeof opts.readText === 'function' ? opts.readText : (p) => fs.readFileSync(p, 'utf8');

  const primaryKind = found.files.details.length ? 'details' : 'summary';
  const primary = found.files[primaryKind];
  const warnings = [];

  // Rolled-file gaps (details.txt, details_001.txt, details_003.txt → 002 missing)
  for (const kind of ['details', 'summary']) {
    const rolls = found.files[kind].map(f => f.roll);
    for (let i = 0; i < rolls.length; i++) {
      if (rolls[i] !== i) { warnings.push({ code: 'roll-gap', text: `${kind} log part ${i === 0 ? kind + '.txt' : kind + '_' + String(i).padStart(3, '0') + '.txt'} is missing — later parts may start mid-session.` }); break; }
    }
  }

  const sources = [];
  const statSafe = (p) => { try { return fs.statSync(p); } catch (_) { return null; } };
  const addSource = (p, role) => {
    const st = statSafe(p);
    sources.push({ name: path.basename(p), role, bytes: st ? st.size : null, mtime: st ? st.mtime.toISOString() : null, lines: null });
    return sources[sources.length - 1];
  };

  // ── torrentinfo first: authoritative names/sizes/piece hashes
  let tinfo = null;
  if (found.files.torrentinfo) {
    addSource(found.files.torrentinfo, 'torrentinfo');
    try { tinfo = parseTorrentInfo(readText(found.files.torrentinfo)); }
    catch (e) { warnings.push({ code: 'torrentinfo-read', text: 'torrentinfo.txt could not be read: ' + e.message }); }
  }

  const model = {
    schema: SCHEMA,
    parser: { name: 'td-log-parser', version: PARSER_VERSION, parsedAt: new Date().toISOString() },
    tool: { name: 'Torrential Downpour', version: null, ref: null },
    paths: { caseDir: found.caseDir, logsDir: found.logsDir, downloadDir: found.downloadDir },
    folder: found.folderMeta,
    sources,
    primaryLog: primaryKind,
    download: { startedAt: null, startedLocalText: null, startedUtcText: null, startedUtc: null, gmtOffsetMin: null, endedAt: null, ref: null },
    remote: { ip: null, port: null, ref: null, teredo: null, identifyIp: null, reportedIPv4: null, reportedIPv6: null },
    torrent: { infoHash: null, fileCount: null, totalBytes: null, pieceCount: null, pieceSize: null, name: tinfo ? tinfo.name : null, ref: null },
    investigator: { peerIds: [], publicIps: [] },
    sessions: [],
    closing: {
      acknowledgedRanges: null, acknowledged: null, filesReported: null, possessedWritten: null, definedWritten: null,
      writtenRanges: null, validation: null, limits: [], outcome: null, stopReason: null, ref: null
    },
    files: [],
    pieceHashes: tinfo ? tinfo.pieceHashes : [],
    pieceDelivery: {},
    netstat: [],
    stats: { lines: 0, unknownLines: 0, unknown: [] },
    warnings
  };

  // Files: seed from torrentinfo
  const files = model.files;
  const fileAt = (i) => files[i] || (files[i] = { index: i, path: null, name: null, size: null, firstPiece: null, lastPiece: null, status: null, bytesWritten: null, sha1: null, sha1b32: null, md5: null, ref: null });
  if (tinfo) tinfo.files.forEach((f, i) => { if (f) { const x = fileAt(i); x.path = f.path; x.size = f.size; } });

  // ── Session state
  let cur = null;
  let fileRef = '';
  let lastTs = null;
  const unknown = new Map();
  const ourIps = new Map();
  const ourPeers = new Set();
  let closingSeen = false;
  let mode = 'full'; // 'full' | 'closing'

  const ref = (line) => `${fileRef}:${line}`;
  const newSession = (ts, line) => {
    cur = { n: model.sessions.length + 1, attemptAt: ts, ref: ref(line), result: null, connectedAt: null, endedAt: null,
      failReason: null, endReason: null, encrypted: null, handshake: false, handshakeAt: null, peerId: null, clientTag: null, clientName: null,
      infoHashAffirmed: null, ourIp: null, have: null, haveOf: null, haveRanges: null, piecesDownloaded: null,
      piecesReceived: 0, sleepSec: null, closed: false, ext: null };
    model.sessions.push(cur);
    return cur;
  };
  const ensureSession = (ts, line) => (cur && !cur.closed) ? cur : newSession(ts, line);
  const endSession = (ts, reason) => {
    if (!cur) return;
    if (reason && !cur.endReason) cur.endReason = reason;
    if (ts) cur.endedAt = ts;
  };

  const handle = (raw, lineNo) => {
    if (!raw) return;
    const sp = splitLine(raw);
    const ts = sp.ts || lastTs;
    if (sp.ts) lastTs = sp.ts;
    const msg = sp.msg;
    if (!msg) return;
    let m;

    // ── Hot path: per-session file chatter (≈95% of a details log)
    if (msg.startsWith('File index ')) {
      if (!tinfo && (m = /^File index (\d+) is named "(.*)" in the torrent$/.exec(msg))) { const f = fileAt(+m[1]); if (f.name == null) f.name = m[2]; }
      return;
    }
    if (msg.startsWith('Remote client acknowledges it has ')) {
      if (msg.charCodeAt(34) !== 112 /* 'p' → per-file chatter */ && (m = /^Remote client acknowledges it has (\d+) of (\d+) pieces(?::\s*(.*))?$/.exec(msg))) {
        if (mode !== 'full') return;
        const s = ensureSession(ts, lineNo);
        s.have = +m[1]; s.haveOf = +m[2]; s.haveRanges = m[3] ? TdModel.formatRanges(m[3]) : (s.have === 0 ? '' : null);
      }
      return; // "...pieces a-b, which encompasses all of file N" — repeated per session; ignored
    }
    if (msg.startsWith('File ')) {
      if ((m = /^File (\d+): SHA-?1=([0-9a-f]{40})(?: \(([A-Z2-7]{32})\))?,\s*MD5=([0-9a-f]{32})/i.exec(msg))) {
        const f = fileAt(+m[1]); f.sha1 = m[2].toLowerCase(); f.sha1b32 = m[3] || null; f.md5 = m[4].toLowerCase(); f.ref = ref(lineNo);
        closingSeen = true; return;
      }
      if ((m = /^File (\d+): complete\b/.exec(msg))) { const f = fileAt(+m[1]); f.status = 'complete'; if (f.size != null) f.bytesWritten = f.size; closingSeen = true; return; }
      if ((m = /^File (\d+): incomplete, (\d+) of (\d+) bytes written/.exec(msg))) { const f = fileAt(+m[1]); f.status = 'incomplete'; f.bytesWritten = +m[2]; if (f.size == null) f.size = +m[3]; closingSeen = true; return; }
      if ((m = /^File (\d+): no pieces written/.exec(msg))) { const f = fileAt(+m[1]); f.status = 'none'; f.bytesWritten = 0; closingSeen = true; return; }
      if ((m = /^File (\d+) is (\d+) bytes and (?:encompassed by piece (\d+)|spans pieces (\d+)-(\d+))/.exec(msg))) {
        const f = fileAt(+m[1]);
        if (f.size == null) f.size = +m[2];
        if (f.firstPiece == null) { f.firstPiece = m[3] != null ? +m[3] : +m[4]; f.lastPiece = m[3] != null ? +m[3] : +m[5]; }
        return;
      }
      if ((m = /^File (\d+) has been completely downloaded/.exec(msg))) {
        const f = fileAt(+m[1]);
        if (!f.completedAt) { f.completedAt = ts; f.completedInSession = cur ? cur.n : null; }
        return;
      }
    }
    if (msg.startsWith('Remote client acknowledged that it has ')) {
      if ((m = /^Remote client acknowledged that it has (\d+) of (\d+) pieces/.exec(msg))) { model.closing.acknowledged = { n: +m[1], of: +m[2], ref: ref(lineNo) }; closingSeen = true; }
      else if ((m = /which encompasses all of file (\d+)/.exec(msg))) fileAt(+m[1]).acknowledged = true;
      return;
    }
    if (msg.startsWith('Created uninitialized file ')) {
      if ((m = /^Created uninitialized file (\d+): (.*)$/.exec(msg))) { const f = fileAt(+m[1]); if (!f.diskPath) f.diskPath = m[2]; }
      return;
    }
    if (msg.startsWith('Piece ')) {
      if ((m = /^Piece (\d+) has been completely received and written into files? ([\d,\s]+)/.exec(msg))) {
        if (mode !== 'full') return;
        const p = +m[1];
        if (cur) cur.piecesReceived++;
        if (!(p in model.pieceDelivery)) model.pieceDelivery[p] = cur ? cur.n : null;
        return;
      }
      if (/^Piece \d+ has expected SHA-?1 hash/i.test(msg)) {
        const v = model.closing.validation || (model.closing.validation = { allValid: null, checked: 0, ok: 0, failures: [], ref: null });
        v.checked++; v.ok++; return;
      }
      if ((m = /^Piece (\d+) (?:does not have|did not have|has an? unexpected|failed|has incorrect|hash mismatch)/i.exec(msg))) {
        const v = model.closing.validation || (model.closing.validation = { allValid: null, checked: 0, ok: 0, failures: [], ref: null });
        v.checked++; v.allValid = false; v.failures.push({ piece: +m[1], text: msg, ref: ref(lineNo) }); return;
      }
    }

    // ── Session lifecycle
    if (msg === 'Attempting to connect to remote client') { if (mode === 'full') newSession(ts, lineNo); return; }
    if (msg === 'Connected') { if (mode === 'full') { const s = ensureSession(ts, lineNo); s.result = 'connected'; s.connectedAt = ts; } return; }
    if ((m = /^Failed to connect:\s*(.*)$/.exec(msg))) {
      if (mode !== 'full') return;
      const s = ensureSession(ts, lineNo);
      s.result = 'failed';
      s.failReason = m[1].replace(/\s+\[?[0-9a-fA-F:.]+\]?:\d+\s*$/, '').trim();
      s.endedAt = ts;
      return;
    }
    if (msg === 'Completed handshake with remote client') {
      if (mode !== 'full') return;
      let s = cur;
      if (!s || s.closed || s.handshake) s = newSession(ts, lineNo); // summary logs have no "Attempting" lines
      s.handshake = true;
      if (!s.handshakeAt) s.handshakeAt = ts;
      if (!s.result) { s.result = 'connected'; s.connectedAt = s.connectedAt || ts; }
      return;
    }
    if ((m = /^Completed session with remote client; (\d+) pieces? (?:were|was) downloaded and written/.exec(msg))) {
      if (mode !== 'full') return;
      const s = ensureSession(ts, lineNo);
      s.piecesDownloaded = +m[1]; s.endedAt = ts; s.closed = true;
      return;
    }
    if ((m = /^Going to sleep for (\d+)m:(\d+)s/.exec(msg))) {
      if (cur && mode === 'full') { cur.sleepSec = +m[1] * 60 + +m[2]; cur.closed = true; if (!cur.endedAt) cur.endedAt = ts; }
      return;
    }
    if (/^Connection (?:has been reset by the remote client|to remote client has been reset|to remote client has been closed)|^Too long without activity|^Remote client rejected encryption|^Remote client closed the connection/.test(msg)) {
      if (mode === 'full') endSession(ts, msg);
      return;
    }
    if (msg === 'Encryption successfully negotiated: post-handshake messages to be sent encrypted' || /^Encryption successfully negotiated/.test(msg)) { if (cur && mode === 'full') cur.encrypted = true; return; }
    if ((m = /^Peer id we sent to remote client:\s*([0-9a-f]+)/i.exec(msg))) { ourPeers.add(m[1].toLowerCase()); if (cur) cur.ourPeerId = m[1].toLowerCase(); return; }
    if ((m = /^Remote client sent us a peer id of ([0-9a-f]+)(?: \(version: (.*)\))?/i.exec(msg))) {
      if (cur && mode === 'full') { cur.peerId = m[1].toLowerCase(); cur.clientTag = m[2] || TdModel.peerIdPrefix(m[1]); }
      return;
    }
    if ((m = /^Remote client affirmed info hash\s*=\s*([0-9a-f]{40})/i.exec(msg))) { if (cur && mode === 'full') cur.infoHashAffirmed = m[1].toLowerCase(); return; }
    if ((m = /^Extended handshake data from remote client:\s*(.*)$/.exec(msg))) {
      if (cur && mode === 'full') {
        const kv = _parseKv(m[1]);
        const keep = {};
        for (const k of ['v', 'ipv4', 'ipv6', 'p', 'yourip', 'upload_only', 'complete_ago', 'reqq', 'e', 'yp', 'metadata_size']) if (kv[k] != null) keep[k] = kv[k];
        cur.ext = keep;
        if (keep.v && !cur.clientName) cur.clientName = keep.v;
      }
      return;
    }
    if ((m = /^Received version in extended handshake:\s*(.*)$/.exec(msg))) { if (cur) cur.clientName = m[1].trim(); return; }
    if ((m = /^Extended handshake from remote client lists our public IP address as:\s*(\S+)/.exec(msg))) {
      const ip = _stripBrackets(m[1]);
      if (cur && mode === 'full') cur.ourIp = ip;
      ourIps.set(ip, (ourIps.get(ip) || 0) + 1);
      return;
    }
    if ((m = /^Extended handshake from remote client lists remote client IPv(4|6) address as:\s*(\S+)/.exec(msg))) {
      const ip = _stripBrackets(m[2]);
      if (cur) cur['reportedIPv' + m[1]] = ip;
      if (m[1] === '4' && !model.remote.reportedIPv4) model.remote.reportedIPv4 = ip;
      if (m[1] === '6' && !model.remote.reportedIPv6) model.remote.reportedIPv6 = ip;
      return;
    }
    if (msg === 'Received a have-all message') { if (cur && mode === 'full') { cur.have = model.torrent.pieceCount; cur.haveOf = model.torrent.pieceCount; cur.haveAll = true; } return; }
    if (msg === 'Received a have-none message') { if (cur && mode === 'full') { cur.have = 0; cur.haveOf = model.torrent.pieceCount; } return; }
    if ((m = /^Current local time is ([\d-]+ [\d:]+), UTC time is ([\d-]+ [\d:]+)/.exec(msg))) {
      if (model.download.gmtOffsetMin == null) {
        const mins = TdModel.minutesBetween(m[2], m[1]);
        if (mins != null) model.download.gmtOffsetMin = Math.round(mins / 15) * 15;
      }
      if (cur && !cur.utcAt) cur.utcAt = m[2];
      return;
    }

    // ── Header
    if ((m = /^Torrential Downpour version\s+(\S+)/i.exec(msg))) { if (!model.tool.version) { model.tool.version = m[1]; model.tool.ref = ref(lineNo); } return; }
    if ((m = /^Started download thread at local time\s+(.*?)\s*(\((?:GMT|UTC)[^)]*\))?$/i.exec(msg))) {
      if (!model.download.startedLocalText) {
        model.download.startedLocalText = m[1];
        model.download.startedAt = TdModel.parseLongDate(m[1]) || ts;
        model.download.ref = ref(lineNo);
        const off = TdModel.parseGmtOffset(m[2] || '');
        if (off != null) model.download.gmtOffsetMin = off;
      }
      return;
    }
    if ((m = /^Started download thread at UTC\s+(.*)$/i.exec(msg))) { if (!model.download.startedUtcText) { model.download.startedUtcText = m[1]; model.download.startedUtc = TdModel.parseLongDate(m[1]); } return; }
    if ((m = /^Remote client (?:located|will be contacted) at IP address\s+(\[[^\]]+\]|[^,\s]+),?\s*port\s+(\d+)/i.exec(msg))) {
      if (!model.remote.ip) { model.remote.ip = _stripBrackets(m[1]); model.remote.port = +m[2]; model.remote.ref = ref(lineNo); }
      return;
    }
    if ((m = /^IPv6 address\s+(\S+)\s+is a Teredo IP address that encapsulates IPv4 address\s+(\S+)/i.exec(msg))) {
      model.remote.teredo = { ipv6: _stripBrackets(m[1]), ipv4: m[2].replace(/[.,]$/, ''), ref: ref(lineNo) };
      return;
    }
    if ((m = /use IPv4 address\s+(\S+?)\s+to identify the remote client/i.exec(msg))) { model.remote.identifyIp = m[1]; return; }
    if ((m = /^Torrent info hash:\s*([0-9a-f]{40})/i.exec(msg))) { if (!model.torrent.infoHash) { model.torrent.infoHash = m[1].toLowerCase(); model.torrent.ref = ref(lineNo); } return; }
    if ((m = /^Torrent defines (\d+) files?/.exec(msg))) { if (model.torrent.fileCount == null) model.torrent.fileCount = +m[1]; return; }
    if ((m = /^Total file bytes:\s*([\d,]+)/.exec(msg))) { if (model.torrent.totalBytes == null) model.torrent.totalBytes = +m[1].replace(/,/g, ''); return; }
    if ((m = /^Torrent has (\d+) pieces?/.exec(msg))) { if (model.torrent.pieceCount == null) model.torrent.pieceCount = +m[1]; return; }
    if ((m = /^Piece size:\s*([\d,]+) bytes/.exec(msg))) { if (model.torrent.pieceSize == null) model.torrent.pieceSize = +m[1].replace(/,/g, ''); return; }

    // ── Closing block
    if ((m = /^Exceeded maximum (.*)$/i.exec(msg))) { model.closing.limits.push(msg); model.closing.ref = model.closing.ref || ref(lineNo); if (ts) model.download.endedAt = ts; closingSeen = true; return; }
    if ((m = /^Pieces acknowledged for all sessions combined:\s*(.*)$/.exec(msg))) { model.closing.acknowledgedRanges = TdModel.formatRanges(m[1]); model.closing.ref = model.closing.ref || ref(lineNo); closingSeen = true; return; }
    if ((m = /^Remote client indicated that it completely has (\d+) of (\d+) files/.exec(msg))) { model.closing.filesReported = { n: +m[1], of: +m[2], ref: ref(lineNo) }; return; }
    if ((m = /^(\d+) of (\d+) pieces possessed by the remote client were downloaded/.exec(msg))) { model.closing.possessedWritten = { n: +m[1], of: +m[2], ref: ref(lineNo) }; return; }
    if ((m = /^(\d+) of (\d+) pieces defined by the torrent were downloaded/.exec(msg))) { model.closing.definedWritten = { n: +m[1], of: +m[2], ref: ref(lineNo) }; return; }
    if ((m = /^Pieces written:\s*(.*)$/.exec(msg))) { model.closing.writtenRanges = TdModel.formatRanges(m[1]); return; }
    if ((m = /^All (\d+) written pieces have the expected SHA-?1 hash/i.exec(msg))) {
      const v = model.closing.validation || (model.closing.validation = { allValid: null, checked: 0, ok: 0, failures: [], ref: null });
      if (v.allValid !== false) v.allValid = true;
      v.count = +m[1]; v.ref = ref(lineNo); return;
    }
    if ((m = /^(\d+) of (\d+) written pieces (?:have|had) the expected SHA-?1 hash/i.exec(msg))) {
      const v = model.closing.validation || (model.closing.validation = { allValid: null, checked: 0, ok: 0, failures: [], ref: null });
      v.allValid = +m[1] === +m[2]; v.count = +m[2]; v.okCount = +m[1]; v.ref = ref(lineNo); return;
    }
    if ((m = /^The download was (complete|incomplete|successful|unsuccessful)\b/i.exec(msg))) { model.closing.outcome = m[1].toLowerCase(); if (ts) model.download.endedAt = ts; return; }
    if ((m = /^The download (?:was )?(?:stopped|ended|terminated)\b(.*)$/i.exec(msg))) { model.closing.stopReason = msg; if (ts) model.download.endedAt = ts; return; }
    if (/^No pieces were written/i.test(msg)) { model.closing.writtenRanges = model.closing.writtenRanges || ''; return; }

    // ── Known protocol chatter (no facts we keep)
    if (/^(?:Sent|Received) (?:an? )?(?:interested|not interested|unchoke|choke|keep-alive|bitfield|have-none|have-all|have|cancel|reject|allowed fast|suggest|port|extended handshake|request|piece|extended) message\b/.test(msg) ||
        /^Sent \d+ requests? for data/.test(msg) || /^Sent request message:/.test(msg) || /^Sent (?:encrypted )?handshake/.test(msg) ||
        /^Received (?:a |an )?(?:handshake|piece|block|reject|extended)/.test(msg) ||
        /^Attempting to negotiate message stream encryption/.test(msg) || /^Remote client supports /.test(msg) ||
        /^Starting validation of written pieces|^Completed validation of written pieces|^Calculating SHA-?1 and MD5 hashes/.test(msg) ||
        /^Remote client does not support /.test(msg) || /^Encryption (?:was )?not /.test(msg) ||
        /^Executing netstat/.test(msg) || /^The Teredo IPv6 address is a relay/.test(msg)) {
      if (/^The Teredo IPv6 address is a relay/.test(msg) && (m = /use IPv4 address\s+(\S+?)\s+to identify/.exec(msg))) model.remote.identifyIp = m[1];
      return;
    }

    // ── Unknown: count by template
    model.stats.unknownLines++;
    const t = _template(msg);
    const u = unknown.get(t);
    if (u) u.count++;
    else if (unknown.size < 200) unknown.set(t, { template: t, count: 1, example: msg.slice(0, 240), ref: ref(lineNo) });
  };

  // ── Byte budget for progress
  const toRead = primary.map(f => f.path);
  let bytesTotal = 0;
  for (const p of toRead) { const st = statSafe(p); bytesTotal += st ? st.size : 0; }
  let bytesBefore = 0;

  for (const f of primary) {
    const src = addSource(f.path, primaryKind);
    fileRef = f.name;
    const ctl = {
      cancelled: isCancelled,
      progress: (b, n) => onProgress({ phase: 'logs', file: f.name, bytesDone: bytesBefore + b, bytesTotal, lines: model.stats.lines + n })
    };
    const n = await _readLines(f.path, handle, ctl, createStream);
    src.lines = n;
    model.stats.lines += n;
    bytesBefore += src.bytes || 0;
    onProgress({ phase: 'logs', file: f.name, bytesDone: bytesBefore, bytesTotal, lines: model.stats.lines });
  }

  // details present but closing block missing (e.g. last roll not copied) → take it from summary
  if (primaryKind === 'details' && !closingSeen && found.files.summary.length) {
    mode = 'closing';
    for (const f of found.files.summary) {
      const src = addSource(f.path, 'summary (closing block)');
      fileRef = f.name;
      src.lines = await _readLines(f.path, handle, { cancelled: isCancelled, progress: () => {} }, createStream);
    }
    warnings.push({ code: 'closing-from-summary', text: 'details log had no closing block; file results were taken from summary.txt.' });
  }

  // ── Netstat
  if (found.files.netstat) {
    addSource(found.files.netstat, 'netstat');
    try {
      const ips = [model.remote.ip, model.remote.identifyIp, model.remote.teredo && model.remote.teredo.ipv4, model.folder && model.folder.ip];
      model.netstat = parseNetstat(readText(found.files.netstat), ips, path.basename(found.files.netstat));
    } catch (e) { warnings.push({ code: 'netstat-read', text: 'netstat.txt could not be read: ' + e.message }); }
  }

  finalize(model, tinfo, { ourIps, ourPeers, unknown });
  return model;
}

function finalize(model, tinfo, ctx) {
  const t = model.torrent;
  if (tinfo) {
    if (!t.infoHash && tinfo.infoHash) t.infoHash = tinfo.infoHash;
    for (const k of ['fileCount', 'totalBytes', 'pieceCount', 'pieceSize']) if (t[k] == null && tinfo[k] != null) t[k] = tinfo[k];
    if (tinfo.infoHash && t.infoHash && tinfo.infoHash !== t.infoHash) model.warnings.push({ code: 'infohash-mismatch', text: `torrentinfo.txt info hash (${tinfo.infoHash}) differs from the log (${t.infoHash}).` });
    if (tinfo.fileCount != null && t.fileCount != null && tinfo.fileCount !== t.fileCount) model.warnings.push({ code: 'filecount-mismatch', text: `torrentinfo.txt lists ${tinfo.fileCount} files; the log says ${t.fileCount}.` });
  }

  // Teredo: decode ourselves when the log didn't spell it out
  const r = model.remote;
  if (!r.teredo && r.ip) {
    const d = TdModel.teredoDecode(r.ip);
    if (d) r.teredo = { ipv6: r.ip, ipv4: d.clientIPv4, server: d.server, decodedByViper: true };
  } else if (r.teredo) {
    const d = TdModel.teredoDecode(r.teredo.ipv6);
    if (d) { r.teredo.server = d.server; if (d.clientIPv4 !== r.teredo.ipv4) model.warnings.push({ code: 'teredo-mismatch', text: `Teredo address decodes to ${d.clientIPv4}, log says ${r.teredo.ipv4}.` }); }
  }
  if (!r.identifyIp && r.teredo) r.identifyIp = r.teredo.ipv4;

  // Folder vs log IP
  if (model.folder && model.folder.ip && r.ip && model.folder.ip.indexOf(':') < 0 && model.folder.ip !== r.ip && model.folder.ip !== r.identifyIp) {
    model.warnings.push({ code: 'folder-ip-mismatch', text: `Folder name IP ${model.folder.ip} differs from the log's ${r.ip}.` });
  }

  // Sessions: tidy + per-session checks
  let affirmedBad = 0;
  for (const s of model.sessions) {
    delete s.closed;
    if (!s.result) s.result = s.handshake ? 'connected' : 'unknown';
    if (s.infoHashAffirmed && t.infoHash && s.infoHashAffirmed !== t.infoHash) affirmedBad++;
    if (s.ourPeerId) delete s.ourPeerId;
  }
  if (affirmedBad) model.warnings.push({ code: 'affirm-mismatch', text: `${affirmedBad} session(s) affirmed a different info hash.` });

  // UTC times
  if (model.download.gmtOffsetMin != null) {
    if (!model.download.startedUtc && model.download.startedAt) model.download.startedUtc = TdModel.localToUtc(model.download.startedAt, model.download.gmtOffsetMin);
    if (model.download.endedAt) model.download.endedUtc = TdModel.localToUtc(model.download.endedAt, model.download.gmtOffsetMin);
  }
  if (!model.download.endedAt && model.sessions.length) {
    const last = model.sessions[model.sessions.length - 1];
    model.download.endedAt = last.endedAt || last.attemptAt;
  }

  // Files: fill array holes, compute piece spans from sizes if missing
  const fc = t.fileCount != null ? t.fileCount : model.files.length;
  for (let i = 0; i < Math.max(fc, model.files.length); i++) {
    if (!model.files[i]) model.files[i] = { index: i, path: null, name: null, size: null, firstPiece: null, lastPiece: null, status: null, bytesWritten: null, sha1: null, sha1b32: null, md5: null, ref: null };
  }
  if (t.pieceSize && model.files.every(f => f.size != null)) {
    let off = 0;
    for (const f of model.files) {
      if (f.firstPiece == null) {
        f.firstPiece = Math.floor(off / t.pieceSize);
        f.lastPiece = f.size > 0 ? Math.floor((off + f.size - 1) / t.pieceSize) : f.firstPiece;
      }
      off += f.size;
    }
  }
  for (const f of model.files) {
    if (!f.path) f.path = f.diskPath ? f.diskPath.replace(/^[^\\/]+[\\/]/, '') : f.name;
    if (!f.name && f.path) f.name = f.path.split(/[\\/]/).pop();
    if (f.diskPath == null) delete f.diskPath;
  }

  // Investigator identity
  model.investigator.publicIps = [...ctx.ourIps.entries()].map(([ip, n]) => ({ ip, sessions: n }));
  model.investigator.peerIds = [...ctx.ourPeers];

  // Validation default when the log only reported per-piece lines
  const v = model.closing.validation;
  if (v && v.allValid == null) v.allValid = v.failures.length === 0 && v.ok > 0;

  model.stats.unknown = [...ctx.unknown.values()].sort((a, b) => b.count - a.count);
  if (model.stats.unknownLines) model.warnings.push({ code: 'unknown-lines', text: `${model.stats.unknownLines} log line(s) used wording VIPER does not recognise yet; they are listed under Parser details.` });

  model.summary = TdModel.summarize(model);
  model.id = makeDownloadId(model);
  return model;
}

/** Stable, filesystem-safe id for cases/<n>/BitTorrent/<id>.json */
function makeDownloadId(model) {
  const ip = (TdModel.suspectIp(model) || model.remote.ip || 'unknown').replace(/[^0-9a-zA-Z.]+/g, '-');
  const when = (model.download.startedAt || (model.folder && model.folder.stamp) || '').replace(/[^0-9]/g, '').slice(0, 14) || 'nodate';
  const ih = (model.torrent.infoHash || 'nohash').slice(0, 8);
  const dl = model.folder && model.folder.downloadId != null ? '_' + model.folder.downloadId : '';
  return `td_${ip}_${when}${dl}_${ih}`;
}

module.exports = {
  PARSER_VERSION,
  SCHEMA,
  discoverLogs,
  findTdDownloads,
  parseFolderMeta,
  parseTorrentInfo,
  parseNetstat,
  parseTdDownload,
  splitLine,
  makeDownloadId,
  _internal: { _parseKv, _template, _hostOf }
};

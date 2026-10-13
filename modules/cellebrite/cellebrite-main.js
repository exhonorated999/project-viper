/**
 * Cellebrite (Mobile Forensics) — Main-process side
 * ─────────────────────────────────────────────────────────────────────────
 * Phase 1.2 — REAL scan + import orchestration for Device + Apps + Contacts.
 * Phase 1.3 — Calls, SMS/MMS, Accounts, Wi-Fi parsers wired into the same
 *             storage layout; no IPC churn from 1.2.
 *
 * IPC surface (all on `window.electronAPI` via preload):
 *   cellebrite-pick-bundle      → file dialog, returns {ufdxPath, parentDir, bundleSize}
 *   cellebrite-scan-bundle      → opens .ufdx + scans each FileSystem NN/*.zip central dir
 *   cellebrite-import           → full import (copy/ref + extract + parse + write parsed/*.json)
 *   cellebrite-read-parsed      → lazy-load parsed/{surface}.json
 *   cellebrite-delete-import    → rm -r the importId folder + return success
 *   cellebrite-cancel-import    → set cancel flag for active import
 *
 * Storage layout written to disk (locked in plan §2):
 *   cases/{caseNumber}/Cellebrite/{importId}/
 *     manifest.json
 *     extracted/        ← selectively-pulled SQLite + XML files
 *     parsed/           ← per-surface JSON
 *     source/           ← copy of original bundle (only if sourceMode='imported')
 *     log.txt
 *
 * Progress events: `cellebrite-import-progress` on webContents.
 *   { importId, stage, current, total, label }
 *
 * Stages: 'precheck' | 'copying' | 'scanning' | 'extracting' |
 *         'parsing-device' | 'parsing-apps' | 'parsing-contacts' |
 *         'parsing-calls' | 'parsing-sms' | 'parsing-accounts' |
 *         'parsing-wifi' | 'fingerprinting' | 'done'
 */

const fs = require('fs');
const path = require('path');
const { dialog } = require('electron');

const Extractor = require('./cellebrite-extractor');
const Parser    = require('./cellebrite-parser');
const MediaIndexer = require('./cellebrite-media-indexer');

// ─── Cancel-flag map: importId → boolean ────────────────────────────────
const _cancelFlags = new Map();

function isCancelled(importId) { return _cancelFlags.get(importId) === true; }
function setCancelled(importId, v) { _cancelFlags.set(importId, !!v); }
function clearCancelled(importId) { _cancelFlags.delete(importId); }

// ─── Field Security wiring (Phase 1.4) ──────────────────────────────────
// SecurityManager is injected from electron-main.js after IPC registration.
// When security is enabled AND unlocked, parsed/*.json + manifest.json are
// written as VIPENC blobs. Reads transparently handle both encrypted and
// legacy plaintext layouts (older imports predate this).
//
// When security is enabled but LOCKED, writes proceed in plaintext (we
// won't surface the unlock UI mid-import) but reads will return a
// distinguishable {success:false, locked:true} response so the UI can
// prompt the user.
let _security = null;
function setSecurityManager(sm) { _security = sm; }
function _isSecActive() { return !!(_security && _security.isEnabled() && _security.isUnlocked()); }

// ─── Source Validation fingerprint ──────────────────────────────────────
// electron-main.js injects its _sourceFingerprint() so the record taken here
// has exactly the same shape as every other warrant module's. Only the files
// VIPER actually reads are fingerprinted (the extracted databases/XML), plus
// a separate SHA-256 of the report's own index files (.ufdx/.ufd). The whole
// multi-gigabyte dump is never hashed — that would take minutes.
let _fingerprintFn = null;
function setSourceFingerprint(fn) { _fingerprintFn = typeof fn === 'function' ? fn : null; }

function _sha256File(p) {
    return new Promise((resolve) => {
        try {
            const h = require('crypto').createHash('sha256');
            const s = fs.createReadStream(p);
            s.on('data', (d) => h.update(d));
            s.on('error', () => resolve(null));
            s.on('end', () => resolve(h.digest('hex')));
        } catch (_) { resolve(null); }
    });
}

async function _cellebriteFingerprint(extractedDir, extractedFiles, indexPaths) {
    if (!_fingerprintFn) return null;
    try {
        const root = path.resolve(extractedDir);
        const hashOnly = [];
        for (const f of (extractedFiles || [])) {
            if (!f || !f.destPath) continue;
            const rel = path.relative(root, path.resolve(f.destPath)).split(path.sep).join('/');
            // -shm is SQLite scratch space that merely opening a database can rewrite.
            if (!rel || rel.startsWith('..') || /-(shm|journal)$/i.test(rel)) continue;
            if (!hashOnly.includes(rel)) hashOnly.push(rel);
        }
        if (!hashOnly.length) return null;
        hashOnly.sort();
        const out = await _fingerprintFn({ path: root, hashOnly: hashOnly.slice(0, 256) });
        if (!out) return null;
        const indexFiles = [];
        for (const p of (indexPaths || [])) {
            if (!p || indexFiles.some(x => x.path === p)) continue;
            let size = 0;
            try { size = fs.statSync(p).size; } catch (_) { continue; }
            const sha256 = await _sha256File(p);
            if (sha256) indexFiles.push({ name: path.basename(p), path: p, size, sha256 });
        }
        if (indexFiles.length) out.indexFiles = indexFiles;
        return out;
    } catch (e) {
        console.warn('[Cellebrite] fingerprint failed:', e && e.message);
        return null;
    }
}

// ─── Media source check ─────────────────────────────────────────────────
// Pictures, videos and audio are never extracted: VIPER reads them straight
// out of the phone dump Cellebrite wrote (FileSystem NN/<device>.zip). A
// source check re-reads those exact bytes and shows:
//   1. size and CRC-32 against what Cellebrite wrote into the dump's own
//      directory for that file — the bytes are the ones Cellebrite stored;
//   2. SHA-256 and MD5 of the file, to compare with any other tool;
//   3. on request, the whole dump against the SHA-256 Cellebrite recorded in
//      its .ufd when the extraction was made. That one is slow (a dump can be
//      48 GB) so it runs in the background and its result is kept.

const _CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();

/** Running CRC-32 (the checksum ZIP files use). Start with 0. */
function _crc32(buf, prev) {
    let c = ((prev >>> 0) ^ 0xFFFFFFFF) >>> 0;
    for (let i = 0; i < buf.length; i++) c = _CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

function _importDir(caseNumber, importId) {
    return path.join('cases', String(caseNumber), 'Cellebrite', String(importId));
}

// ── One shared reader per phone dump, for previews ─────────────────────
// Opening a FileSystem zip reads its whole central directory: measured at
// ~0.5 s on a 48 GB / 195,197-entry Pixel dump, while reading one picture
// out of it takes ~1 ms. Re-opening per thumbnail made a grid of 30
// previews take ~15 s. Previews now share one open reader per dump, keyed
// on the dump's size + modified time (a changed dump gets a fresh reader),
// and closed after DUMP_READER_IDLE_MS idle so the drive can be ejected.
// The source check deliberately does NOT use this — it opens the dump fresh.
const DUMP_READER_IDLE_MS = 30 * 1000;
const _dumpReaders = new Map();   // zipPath → { key, promise, users, timer, retired }

function _closeDumpEntry(ent) {
    ent.promise.then((r) => { try { r.close(); } catch (_) {} }, () => {});
}

function _retireDumpReader(zipPath, ent) {
    if (_dumpReaders.get(zipPath) === ent) _dumpReaders.delete(zipPath);
    if (ent.timer) { clearTimeout(ent.timer); ent.timer = null; }
    if (ent.retired) return;
    ent.retired = true;
    if (ent.users === 0) _closeDumpEntry(ent);
}

async function _withDumpReader(zipPath, fn) {
    const st = fs.statSync(zipPath);
    const key = `${st.size}|${st.mtimeMs}`;
    let ent = _dumpReaders.get(zipPath);
    if (ent && ent.key !== key) { _retireDumpReader(zipPath, ent); ent = null; }
    if (!ent) {
        const { openZip } = require('../_shared/zip-reader');
        ent = { key, users: 0, timer: null, retired: false, promise: openZip(zipPath, {}) };
        ent.promise.catch(() => {});   // handled by the awaiting caller
        _dumpReaders.set(zipPath, ent);
    }
    ent.users++;
    if (ent.timer) { clearTimeout(ent.timer); ent.timer = null; }
    try {
        let reader;
        try { reader = await ent.promise; }
        catch (e) { _retireDumpReader(zipPath, ent); throw e; }
        return await fn(reader);
    } finally {
        ent.users--;
        if (ent.users === 0) {
            if (ent.retired) _closeDumpEntry(ent);
            else {
                ent.timer = setTimeout(() => _retireDumpReader(zipPath, ent), DUMP_READER_IDLE_MS);
                if (ent.timer.unref) ent.timer.unref();
            }
        }
    }
}

function _closeDumpReaders() {
    for (const [p, ent] of Array.from(_dumpReaders.entries())) _retireDumpReader(p, ent);
}

/** Look a media item up by id in the import's own index — never by a path
 *  the renderer supplies. Returns { ok, item } or { ok:false, error, locked }. */
function _loadMediaItem(caseNumber, importId, mediaId) {
    if (!caseNumber || !importId || !mediaId) {
        return { ok: false, error: 'caseNumber + importId + mediaId required' };
    }
    const p = path.join(_importDir(caseNumber, importId), 'parsed', 'media.json');
    if (!fs.existsSync(p)) return { ok: false, error: 'media.json not found for this import' };
    const r = _secureReadJson(p);
    if (!r.ok) return { ok: false, error: r.error, locked: !!r.locked };
    const item = ((r.data && r.data.items) || []).find(x => x && x.id === mediaId);
    if (!item) return { ok: false, error: `media id not found: ${mediaId}` };
    return { ok: true, item };
}

/**
 * What Cellebrite itself recorded about a dump, from the .ufd beside it:
 * the dump's SHA-256 (the [SHA256] section) plus when and with what it was
 * made. null when there is no .ufd naming this dump.
 */
function _ufdRecordFor(zipPath) {
    try {
        const dir = path.dirname(zipPath);
        const zipName = path.basename(zipPath).toLowerCase();
        for (const ent of readDirSafe(dir)) {
            if (!ent.isFile() || !/\.ufd$/i.test(ent.name)) continue;
            const full = path.join(dir, ent.name);
            let parsed;
            try { parsed = Parser.parseUfd(fs.readFileSync(full, 'utf-8')); } catch (_) { continue; }
            const d = parsed && parsed.data;
            const secs = (d && d.sections) || {};
            const pick = (secName) => {
                const sec = secs[secName] || secs[secName.toLowerCase()] || null;
                if (!sec) return null;
                const k = Object.keys(sec).find(x => x.toLowerCase() === zipName);
                return k ? String(sec[k]).trim() : null;
            };
            const sha256 = pick('SHA256');
            const md5 = pick('MD5');
            const dumpName = d && d.fileDump ? String(d.fileDump).toLowerCase() : '';
            if (!sha256 && !md5 && dumpName !== zipName) continue;
            const gen = secs.General || {};
            return {
                ufdName: ent.name,
                ufdPath: full,
                sha256: sha256 ? sha256.toLowerCase() : null,
                md5: md5 ? md5.toLowerCase() : null,
                tool: [gen.AcquisitionTool, gen.Version].filter(Boolean).join(' ') || null,
                extractedAt: gen.Date || null,
                machine: gen.MachineName || null,
            };
        }
    } catch (_) {}
    return null;
}

/** Re-read one media entry from the dump and check it. Never throws. */
/**
 * One entry's bytes, read straight from its local header with no CRC check
 * (stored or deflated). Used only after the zip library has refused an
 * entry, so the altered bytes can still be measured.
 */
async function _rawEntryStream(zipPath, meta) {
    const fd = fs.openSync(zipPath, 'r');
    let start;
    try {
        const h = Buffer.alloc(30);
        fs.readSync(fd, h, 0, 30, meta.offset);
        if (h.readUInt32LE(0) !== 0x04034b50) throw new Error('local file header not found');
        start = meta.offset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
    } finally { fs.closeSync(fd); }
    const src = meta.compressedSize > 0
        ? fs.createReadStream(zipPath, { start, end: start + meta.compressedSize - 1 })
        : require('stream').Readable.from([]);
    if (meta.method === 0) return src;
    if (meta.method !== 8) throw new Error(`unsupported compression method ${meta.method}`);
    const inf = require('zlib').createInflateRaw();
    src.on('error', (e) => inf.destroy(e));
    return src.pipe(inf);
}

async function _checkMediaItem(item) {
    const out = {
        filename: item.filename || '',
        mime: item.mime || '',
        type: item.type || '',
        entryPath: item.entryPath || '',
        rawEntryName: item.rawEntryName || '',
        sourceZip: item.sourceZip || '',
        sourceZipName: item.sourceZip ? path.basename(item.sourceZip) : '',
        sourceFolder: item.sourceZip ? path.basename(path.dirname(item.sourceZip)) : '',
        // Android's own gallery thumbnails, not the original picture.
        thumbnail: /(^|\/)\.thumbnails?\//i.test(item.entryPath || item.rawEntryName || ''),
        recorded: { size: item.size || 0, crc32: item.crc32 != null ? (item.crc32 >>> 0) : null, mtime: item.mtime || null },
        capturedAt: item.capturedAt || null,
        gps: item.gps || null,
        width: item.width || null,
        height: item.height || null,
        checkedAt: new Date().toISOString(),
    };
    if (!item.sourceZip || !fs.existsSync(item.sourceZip)) {
        out.zipMissing = true;
        return out;
    }
    try {
        const st = fs.statSync(item.sourceZip);
        out.zipSize = st.size;
        out.zipMtimeMs = Math.round(st.mtimeMs);
    } catch (_) {}
    out.ufd = _ufdRecordFor(item.sourceZip);

    const { openZip } = require('../_shared/zip-reader');
    let reader = null;
    try {
        reader = await openZip(item.sourceZip, {});
        const meta = reader._zip && typeof reader._zip.entry === 'function'
            ? reader._zip.entry(item.rawEntryName) : null;
        if (!meta) { out.entryMissing = true; return out; }
        out.container = {
            size: meta.size,
            compressedSize: meta.compressedSize,
            crc32: meta.crc != null ? (meta.crc >>> 0) : null,
            time: meta.time || null,
            stored: meta.method === 0,
        };
        const measure = async (stm) => {
            const sha = require('crypto').createHash('sha256');
            const md5 = require('crypto').createHash('md5');
            let crc = 0, size = 0;
            await new Promise((resolve, reject) => {
                stm.on('data', (b) => { sha.update(b); md5.update(b); crc = _crc32(b, crc); size += b.length; });
                stm.on('error', reject);
                stm.on('end', resolve);
            });
            out.read = { size, crc32: crc, sha256: sha.digest('hex'), md5: md5.digest('hex') };
        };
        try {
            const stm = await reader.openStream(item.rawEntryName);
            if (!stm) { out.entryMissing = true; return out; }
            await measure(stm);
        } catch (e) {
            // The zip library refuses an entry whose bytes don't fit the
            // dump's own CRC — and drops the last chunk when it does. Read
            // the entry again WITHOUT that check so the real (altered) bytes
            // can be measured and shown as a mismatch.
            const msg = (e && e.message) || String(e);
            if (!/crc/i.test(msg) || meta.offset == null) throw e;
            out.libraryRefused = msg;
            await measure(await _rawEntryStream(item.sourceZip, meta));
        }
        out.checks = {
            sizeMatch: out.read.size === out.container.size,
            crcMatch: out.container.crc32 != null && out.read.crc32 === out.container.crc32,
            // The dump's directory still says what it said when imported.
            sameAsImport: out.recorded.size === out.container.size &&
                (out.recorded.crc32 == null || out.recorded.crc32 === out.container.crc32),
            importHadCrc: out.recorded.crc32 != null,
        };
    } catch (e) {
        // A read that fails outright is a failed check, not a crash.
        out.readError = (e && e.message) || String(e);
    } finally {
        if (reader) { try { reader.close(); } catch (_) {} }
    }
    return out;
}

// Whole-dump checks: one per dump file at a time, keyed by path+size+mtime.
const _dumpJobs = new Map();

function _dumpKey(zipPath, st) { return `${path.resolve(zipPath)}|${st.size}|${Math.round(st.mtimeMs)}`; }

function _dumpCheckFile(caseNumber, importId) {
    return path.join(_importDir(caseNumber, importId), 'dump-check.json');
}

/** A finished whole-dump check saved earlier for this exact file, or null. */
function _savedDumpCheck(caseNumber, importId, key) {
    try {
        const p = _dumpCheckFile(caseNumber, importId);
        if (!fs.existsSync(p)) return null;
        const r = _secureReadJson(p);
        const rec = r.ok && r.data && r.data[key];
        return rec && rec.state === 'done' ? rec : null;
    } catch (_) { return null; }
}

function _saveDumpCheck(caseNumber, importId, key, rec) {
    try {
        const p = _dumpCheckFile(caseNumber, importId);
        let all = {};
        if (fs.existsSync(p)) { const r = _secureReadJson(p); if (r.ok && r.data) all = r.data; }
        all[key] = rec;
        _secureWriteJson(p, all);
    } catch (e) { console.warn('[Cellebrite] could not save dump check:', e && e.message); }
}

function _startDumpJob(caseNumber, importId, zipPath, key, size, expected) {
    const job = { state: 'running', done: 0, total: size, startedAt: new Date().toISOString(), expected };
    _dumpJobs.set(key, job);
    const h = require('crypto').createHash('sha256');
    const s = fs.createReadStream(zipPath, { highWaterMark: 4 * 1024 * 1024 });
    s.on('data', (b) => { h.update(b); job.done += b.length; });
    s.on('error', (e) => {
        job.state = 'error';
        job.error = (e && e.message) || String(e);
        job.finishedAt = new Date().toISOString();
    });
    s.on('end', () => {
        job.sha256 = h.digest('hex');
        job.state = 'done';
        job.finishedAt = new Date().toISOString();
        job.match = expected ? job.sha256 === expected : null;
        _saveDumpCheck(caseNumber, importId, key, {
            state: 'done', sha256: job.sha256, expected: expected || null, match: job.match,
            total: job.total, startedAt: job.startedAt, finishedAt: job.finishedAt,
        });
    });
    return job;
}

function _publicJob(j) {
    if (!j) return { state: 'none' };
    const o = { state: j.state, done: j.done || 0, total: j.total || 0 };
    for (const k of ['sha256', 'expected', 'match', 'error', 'startedAt', 'finishedAt']) if (j[k] !== undefined) o[k] = j[k];
    return o;
}

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

// Returns { ok, data, locked, error }.
// Treats a VIPENC magic header as encrypted; falls back to plaintext UTF-8.
function _secureReadJson(filePath) {
    let raw;
    try {
        raw = fs.readFileSync(filePath);
    } catch (e) {
        return { ok: false, error: e.message };
    }
    const isEnc = raw.length >= 6 && raw.subarray(0, 6).equals(Buffer.from('VIPENC'));
    if (!isEnc) {
        try {
            return { ok: true, data: JSON.parse(raw.toString('utf-8')) };
        } catch (e) {
            return { ok: false, error: `parse failed: ${e.message}` };
        }
    }
    // Encrypted blob — need unlocked security.
    if (!_security || !_security.isUnlocked()) {
        return { ok: false, locked: true, error: 'Field Security is locked — unlock to view this Cellebrite import.' };
    }
    try {
        const plain = _security.decryptBuffer(raw);
        return { ok: true, data: JSON.parse(plain.toString('utf-8')) };
    } catch (e) {
        return { ok: false, error: `decrypt failed: ${e.message}` };
    }
}

// ─── SMS/MMS/RCS dedup across stores ────────────────────────────────────
// Cross-source dedupe: when both mmssms.db AND bugle_db contain the same
// message (carrier device with Google Messages as default — mirrors all
// SMS through both), we collapse on (normalized address, body, timestamp ±1s).
// We keep the bugle_db copy when present because it carries RCS/protocol metadata.
function _cbNormAddr(s) {
    return String(s || '').replace(/[\s()\-]/g, '').replace(/^\+?/, '');
}
function _cbDedupeMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return [];
    // Sort so bugle_db wins (we iterate and keep first per key).
    const sorted = messages.slice().sort((a, b) => {
        const sa = a.source === 'bugle_db' ? 0 : 1;
        const sb = b.source === 'bugle_db' ? 0 : 1;
        return sa - sb;
    });
    const seen = new Map();
    const out = [];
    for (const m of sorted) {
        const ts = Math.round((m.timestamp || 0) / 1000); // 1s bucket
        const addr = _cbNormAddr(m.address || (m.addresses && m.addresses[0]) || '');
        const body = String(m.body || '').slice(0, 200);
        const key = `${ts}|${addr}|${body}`;
        if (!body && !addr && !ts) { out.push(m); continue; } // tombstones bypass
        if (seen.has(key)) continue;
        seen.set(key, true);
        out.push(m);
    }
    return out;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function genImportId() {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const rnd = Math.random().toString(36).slice(2, 8);
    return `cb_${ts}_${rnd}`;
}

function statSafe(p) {
    try { return fs.statSync(p); } catch { return null; }
}

function readDirSafe(p) {
    try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; }
}

function sumBundleSize(ufdxPath) {
    const parent = path.dirname(ufdxPath);
    let total = 0;
    const walk = (dir, depth) => {
        if (depth > 4) return;
        for (const ent of readDirSafe(dir)) {
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) walk(full, depth + 1);
            else if (ent.isFile()) { const s = statSafe(full); if (s) total += s.size; }
        }
    };
    walk(parent, 0);
    return total;
}

/**
 * Free space on the volume hosting `targetDir`. Best-effort: prefers
 * fs.statfsSync (Node 18+); falls back to a generous guess if statfs
 * is unavailable. NEVER throws.
 */
function freeSpaceFor(targetDir) {
    try {
        // Find an existing ancestor — statfsSync requires an existing path.
        let probe = targetDir;
        while (probe && !fs.existsSync(probe)) {
            const parent = path.dirname(probe);
            if (parent === probe) break;
            probe = parent;
        }
        if (fs.statfsSync) {
            const st = fs.statfsSync(probe);
            return Number(st.bsize) * Number(st.bavail);
        }
    } catch (_) { /* fall through */ }
    return Number.MAX_SAFE_INTEGER;
}

function writeLogLine(logPath, line) {
    try {
        fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`, 'utf-8');
    } catch (_) {}
}

function sendProgress(event, importId, payload) {
    try {
        if (event && event.sender && !event.sender.isDestroyed()) {
            event.sender.send('cellebrite-import-progress', { importId, ...payload });
        }
    } catch (_) {}
}

/**
 * Recursive directory remove with safety guard: refuses to delete anything
 * outside a path that contains 'Cellebrite' segment to avoid catastrophes.
 */
function rmrfSafe(target) {
    if (!target) return;
    const norm = path.resolve(target).replace(/\\/g, '/');
    if (!norm.includes('/Cellebrite/')) {
        throw new Error(`rmrfSafe refused: path does not contain /Cellebrite/ segment: ${target}`);
    }
    if (fs.rmSync) {
        fs.rmSync(target, { recursive: true, force: true });
    } else {
        // Fallback for very old Node
        const walk = (p) => {
            const st = fs.lstatSync(p);
            if (st.isDirectory()) {
                for (const ent of fs.readdirSync(p)) walk(path.join(p, ent));
                fs.rmdirSync(p);
            } else {
                fs.unlinkSync(p);
            }
        };
        walk(target);
    }
}

/**
 * Copy a file with simple progress reporting. Used for bundle copy in
 * sourceMode='imported'. NEVER use fs.copyFileSync on a 48GB file — it
 * pulls the whole thing into a single syscall and can stall.
 */
async function copyFileStreamed(src, dest, onProgress) {
    return new Promise((resolve, reject) => {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const total = (statSafe(src) || {}).size || 0;
        let copied = 0;
        const rs = fs.createReadStream(src, { highWaterMark: 4 * 1024 * 1024 });
        const ws = fs.createWriteStream(dest);
        rs.on('data', chunk => {
            copied += chunk.length;
            if (onProgress) onProgress({ copied, total });
        });
        rs.on('error', reject);
        ws.on('error', reject);
        ws.on('close', resolve);
        rs.pipe(ws);
    });
}

async function copyBundleDir(srcUfdxPath, destDir, isCancelledFn, onFileProgress, onOverallProgress) {
    // Copy the entire bundle directory (parent of .ufdx) to destDir.
    // Sibling files + FileSystem NN/ folders.
    const srcParent = path.dirname(srcUfdxPath);
    fs.mkdirSync(destDir, { recursive: true });

    // First pass: enumerate files for accurate progress total.
    const files = [];
    let total = 0;
    const walk = (dir, depth, relSoFar) => {
        if (depth > 6) return;
        for (const ent of readDirSafe(dir)) {
            const full = path.join(dir, ent.name);
            const rel = path.join(relSoFar, ent.name);
            if (ent.isDirectory()) walk(full, depth + 1, rel);
            else if (ent.isFile()) {
                const sz = (statSafe(full) || {}).size || 0;
                files.push({ src: full, rel, size: sz });
                total += sz;
            }
        }
    };
    walk(srcParent, 0, '');

    let copiedBytes = 0;
    for (let i = 0; i < files.length; i++) {
        if (isCancelledFn && isCancelledFn()) {
            return { cancelled: true, files: i, totalFiles: files.length, copiedBytes, totalBytes: total };
        }
        const { src, rel, size } = files[i];
        const dest = path.join(destDir, rel);
        await copyFileStreamed(src, dest, ({ copied }) => {
            if (onFileProgress) onFileProgress({ file: rel, copied, total: size });
            if (onOverallProgress) onOverallProgress({ copiedBytes: copiedBytes + copied, totalBytes: total, file: rel, idx: i, fileCount: files.length });
        });
        copiedBytes += size;
        if (onOverallProgress) onOverallProgress({ copiedBytes, totalBytes: total, file: rel, idx: i + 1, fileCount: files.length });
    }
    return { cancelled: false, files: files.length, totalFiles: files.length, copiedBytes, totalBytes: total };
}

// ─── IPC handlers ───────────────────────────────────────────────────────

function registerIpc(ipcMain) {

    // ── pick-bundle: file dialog for .ufdx ───────────────────────────────
    ipcMain.handle('cellebrite-pick-bundle', async () => {
        try {
            const result = await dialog.showOpenDialog({
                title: 'Select Cellebrite Extraction (.ufdx)',
                properties: ['openFile'],
                filters: [
                    { name: 'Cellebrite Evidence Collection', extensions: ['ufdx'] },
                    { name: 'All Files', extensions: ['*'] }
                ]
            });
            if (result.canceled || !result.filePaths?.length) {
                return { success: false, cancelled: true };
            }
            const ufdxPath = result.filePaths[0];
            const parentDir = path.dirname(ufdxPath);
            const bundleSize = sumBundleSize(ufdxPath);
            return { success: true, ufdxPath, parentDir, bundleSize };
        } catch (e) {
            console.error('[Cellebrite] pick-bundle error:', e);
            return { success: false, error: e.message };
        }
    });

    // ── scan-bundle: real scan ───────────────────────────────────────────
    // Opens .ufdx, parses XML, finds each *.ufd + each FileSystem NN/*.zip,
    // walks each zip's central directory, reports target presence + sizes.
    ipcMain.handle('cellebrite-scan-bundle', async (event, { ufdxPath } = {}) => {
        try {
            if (!ufdxPath || !fs.existsSync(ufdxPath)) {
                return { success: false, error: 'ufdx path does not exist' };
            }
            const parentDir = path.dirname(ufdxPath);

            // 1. Parse .ufdx XML.
            const ufdxText = fs.readFileSync(ufdxPath, 'utf-8');
            const ufdx = Parser.parseUfdx(ufdxText);

            // 2. Enumerate sibling files + FileSystem NN dirs.
            const fileSystems = [];
            const ufdFiles = [];
            const otherSiblings = [];

            for (const ent of readDirSafe(parentDir)) {
                const full = path.join(parentDir, ent.name);
                if (ent.isDirectory() && /^FileSystem\s+\d+$/i.test(ent.name)) {
                    fileSystems.push({ name: ent.name, path: full });
                } else if (ent.isFile()) {
                    const s = statSafe(full);
                    if (ent.name.toLowerCase().endsWith('.ufd')) {
                        ufdFiles.push({ name: ent.name, path: full, size: s?.size || 0 });
                    } else {
                        otherSiblings.push({ name: ent.name, path: full, size: s?.size || 0 });
                    }
                }
            }

            // Also walk into each FileSystem NN/ for .ufd files inside.
            for (const fsDir of fileSystems) {
                for (const ent of readDirSafe(fsDir.path)) {
                    const full = path.join(fsDir.path, ent.name);
                    if (!ent.isFile()) continue;
                    const s = statSafe(full);
                    if (ent.name.toLowerCase().endsWith('.ufd')) {
                        ufdFiles.push({ name: ent.name, path: full, size: s?.size || 0, fileSystemName: fsDir.name });
                    }
                }
            }

            // 3. Parse each .ufd
            const ufds = [];
            for (const u of ufdFiles) {
                try {
                    const text = fs.readFileSync(u.path, 'utf-8');
                    const parsed = Parser.parseUfd(text);
                    ufds.push({ name: u.name, path: u.path, size: u.size, fileSystemName: u.fileSystemName || null, parsed });
                } catch (e) {
                    ufds.push({ name: u.name, path: u.path, size: u.size, fileSystemName: u.fileSystemName || null, parsed: { success: false, errors: [e.message] } });
                }
            }

            // 4. Scan each FileSystem NN/*.zip central directory.
            const zips = [];
            for (const fsDir of fileSystems) {
                for (const ent of readDirSafe(fsDir.path)) {
                    if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.zip')) continue;
                    const full = path.join(fsDir.path, ent.name);
                    const s = statSafe(full);
                    const scan = await Extractor.scanZipTargets(full);
                    zips.push({
                        name: ent.name,
                        path: full,
                        size: s?.size || 0,
                        fileSystemName: fsDir.name,
                        entryCount: scan.entryCount,
                        targets: scan.targets,
                        dataDataPackages: scan.dataDataPackages,
                        anyDataData: scan.anyDataData,
                        errors: scan.errors,
                    });
                }
            }

            // 5. Aggregate target index across all zips.
            const targetIndex = {};
            for (const z of zips) {
                for (const t of z.targets) {
                    if (!targetIndex[t.kind]) targetIndex[t.kind] = [];
                    targetIndex[t.kind].push({ zip: z.name, path: t.path, size: t.size });
                }
            }

            // 6. Compute totals.
            const bundleSize = sumBundleSize(ufdxPath);
            const targetSizeTotal = Object.values(targetIndex).flat().reduce((a, t) => a + (t.size || 0), 0);

            return {
                success: true,
                ufdxPath,
                parentDir,
                bundleSize,
                ufdx: ufdx.data || null,
                ufdxErrors: ufdx.errors,
                ufds,
                fileSystems: fileSystems.map(f => ({ name: f.name, path: f.path })),
                otherSiblings,
                zips,
                targetIndex,
                targetSizeTotal,
                phase: '1.2',
            };
        } catch (e) {
            console.error('[Cellebrite] scan-bundle error:', e);
            return { success: false, error: e.message };
        }
    });

    // ── import: full orchestration ───────────────────────────────────────
    ipcMain.handle('cellebrite-import', async (event, opts = {}) => {
        const {
            ufdxPath,
            caseNumber,
            caseId,                  // VIPER case.id for the localStorage key
            sourceMode = 'imported', // 'imported' | 'referenced'
            evidenceTag = null,
            deviceLabel = null,
        } = opts;

        if (!ufdxPath || !fs.existsSync(ufdxPath)) {
            return { success: false, error: 'ufdx path does not exist' };
        }
        if (!caseNumber) {
            return { success: false, error: 'caseNumber required' };
        }

        const importId = genImportId();
        const caseRoot = path.join('cases', String(caseNumber), 'Cellebrite', importId);
        const extractedDir = path.join(caseRoot, 'extracted');
        const parsedDir    = path.join(caseRoot, 'parsed');
        const sourceDir    = path.join(caseRoot, 'source');
        const manifestPath = path.join(caseRoot, 'manifest.json');
        const logPath      = path.join(caseRoot, 'log.txt');

        clearCancelled(importId);
        fs.mkdirSync(extractedDir, { recursive: true });
        fs.mkdirSync(parsedDir,    { recursive: true });

        const log = (msg) => writeLogLine(logPath, msg);
        log(`Cellebrite import started — importId=${importId} ufdxPath=${ufdxPath} sourceMode=${sourceMode}`);

        const counts = { apps: 0, contacts: 0, calls: 0, sms: 0, accounts: 0, wifi: 0 };
        const errors = [];

        try {
            // ── precheck: bundle size + free disk ─────────────────────────
            sendProgress(event, importId, { stage: 'precheck', current: 0, total: 1, label: 'Checking disk space...' });
            const bundleSize = sumBundleSize(ufdxPath);
            const targetVolume = sourceMode === 'imported' ? caseRoot : extractedDir;
            const free = freeSpaceFor(targetVolume);

            // For 'imported' mode we need bundleSize + small extracted footprint.
            // For 'referenced' mode we only need extracted footprint (~100MB).
            const required = (sourceMode === 'imported' ? bundleSize : 0) + (200 * 1024 * 1024); // 200MB cushion for extracted+parsed
            if (required > free) {
                const msg = `Not enough disk space: need ${required} bytes, have ${free} on target volume`;
                log(`PRECHECK FAILED: ${msg}`);
                return { success: false, error: msg, importId, diskBlocked: true, required, free, bundleSize };
            }

            // ── copy bundle if imported mode ──────────────────────────────
            let importedUfdxPath = ufdxPath;
            if (sourceMode === 'imported') {
                sendProgress(event, importId, { stage: 'copying', current: 0, total: bundleSize, label: 'Copying bundle into case folder...' });
                const copyRes = await copyBundleDir(
                    ufdxPath,
                    sourceDir,
                    () => isCancelled(importId),
                    null,
                    ({ copiedBytes, totalBytes, file }) => {
                        sendProgress(event, importId, { stage: 'copying', current: copiedBytes, total: totalBytes, label: file });
                    }
                );
                if (copyRes.cancelled) {
                    log('Cancelled during copy stage');
                    writeManifest({ status: 'cancelled', lastCompletedStage: 'copying', importId, ufdxPath, sourceMode, caseNumber, evidenceTag, deviceLabel, counts, errors, bundleSize, copyProgress: copyRes });
                    return { success: false, cancelled: true, importId, stage: 'copying' };
                }
                // Compute new path of .ufdx inside sourceDir
                importedUfdxPath = path.join(sourceDir, path.basename(ufdxPath));
                if (!fs.existsSync(importedUfdxPath)) {
                    // The .ufdx was inside its parent — recursive copy preserves layout.
                    // Just walk sourceDir to find it.
                    const found = findFirstByExt(sourceDir, '.ufdx');
                    if (found) importedUfdxPath = found;
                }
                log(`Bundle copied: ${copyRes.copiedBytes} bytes across ${copyRes.totalFiles} files`);
            }

            // ── scan bundle (cheap; gives us zip list + target index) ─────
            sendProgress(event, importId, { stage: 'scanning', current: 0, total: 1, label: 'Scanning bundle...' });
            const scan = await runScan(importedUfdxPath);
            if (!scan.success) {
                errors.push({ stage: 'scanning', error: scan.error });
                log(`Scan failed: ${scan.error}`);
                writeManifest({ status: 'failed', lastCompletedStage: 'scanning', importId, ufdxPath: importedUfdxPath, sourceMode, caseNumber, evidenceTag, deviceLabel, counts, errors, bundleSize, scan });
                return { success: false, error: scan.error, importId };
            }
            log(`Scan OK: ${scan.zips.length} inner zip(s), ${scan.ufds.length} .ufd file(s), ${Object.keys(scan.targetIndex).length} target kind(s)`);

            // ── extract target files from each inner zip ──────────────────
            const extractedFiles = [];
            for (let zi = 0; zi < scan.zips.length; zi++) {
                if (isCancelled(importId)) {
                    log('Cancelled during extract stage');
                    writeManifest({ status: 'cancelled', lastCompletedStage: 'extracting', importId, ufdxPath: importedUfdxPath, sourceMode, caseNumber, evidenceTag, deviceLabel, counts, errors, bundleSize, scan, extractedFiles });
                    return { success: false, cancelled: true, importId, stage: 'extracting' };
                }
                const z = scan.zips[zi];
                if (!z.targets || z.targets.length === 0) continue;
                sendProgress(event, importId, { stage: 'extracting', current: zi, total: scan.zips.length, label: `Extracting from ${z.name}...` });
                const er = await Extractor.extractTargets({
                    zipPath: z.path,
                    outDir: extractedDir,
                    includeMmsParts: false,
                    onProgress: (p) => {
                        sendProgress(event, importId, { stage: 'extracting', current: p.current, total: p.total, label: p.label || z.name });
                    },
                    isCancelled: () => isCancelled(importId),
                });
                if (er.cancelled) {
                    log('Cancelled during extract (in-zip)');
                    writeManifest({ status: 'cancelled', lastCompletedStage: 'extracting', importId, ufdxPath: importedUfdxPath, sourceMode, caseNumber, evidenceTag, deviceLabel, counts, errors, bundleSize, scan, extractedFiles });
                    return { success: false, cancelled: true, importId, stage: 'extracting' };
                }
                for (const f of er.extracted) extractedFiles.push(f);
                for (const e of er.errors) {
                    errors.push({ stage: 'extracting', zip: z.name, ...e });
                    log(`Extract error: ${z.name} :: ${e.path} :: ${e.error}`);
                }
            }
            log(`Extracted ${extractedFiles.length} target file(s) into ${extractedDir}`);

            // ── fingerprint (before anything opens the databases) ─────────
            // A failed fingerprint never fails the import.
            sendProgress(event, importId, { stage: 'fingerprinting', current: 0, total: 1, label: 'Recording SHA-256 fingerprint...' });
            const sourceIntegrity = await _cellebriteFingerprint(
                extractedDir, extractedFiles,
                [importedUfdxPath].concat((scan.ufds || []).map(u => u && u.path)));
            log(sourceIntegrity ? `Fingerprint recorded: ${sourceIntegrity.fileCount} file(s), sha256=${sourceIntegrity.sha256}` : 'Fingerprint not recorded');

            // ── parse: device ─────────────────────────────────────────────
            sendProgress(event, importId, { stage: 'parsing-device', current: 0, total: 1, label: 'Parsing device overview...' });
            const deviceData = buildDeviceOverview(scan, extractedFiles);
            await writeParsed(parsedDir, 'device', deviceData);
            log(`Parsed device: ${deviceData.device?.model || '(unknown)'}`);

            // ── parse: apps ───────────────────────────────────────────────
            sendProgress(event, importId, { stage: 'parsing-apps', current: 0, total: 1, label: 'Parsing installed apps...' });
            const appsData = parseAppsForBundle(scan);
            await writeParsed(parsedDir, 'apps', { apps: appsData.apps, extras: appsData.extras, errors: appsData.errors });
            counts.apps = (appsData.apps?.length || 0) + (appsData.extras?.length || 0);
            log(`Parsed apps: ${appsData.apps?.length || 0} listed + ${appsData.extras?.length || 0} extra-on-disk`);

            // ── parse: contacts ───────────────────────────────────────────
            sendProgress(event, importId, { stage: 'parsing-contacts', current: 0, total: 1, label: 'Parsing contacts...' });
            const contactsFile = extractedFiles.find(f => f.kind === 'contacts2');
            let contactsData = { contacts: [], errors: ['no contacts2.db found'] };
            if (contactsFile) {
                const r = Parser.parseContactsDb(contactsFile.destPath);
                if (r.success) {
                    contactsData = { contacts: r.data, errors: [] };
                } else {
                    contactsData = { contacts: [], errors: r.errors || ['unknown parse error'] };
                    if (r.skipped) contactsData.skipped = r.skipped;
                }
            }
            await writeParsed(parsedDir, 'contacts', contactsData);
            counts.contacts = contactsData.contacts?.length || 0;
            log(`Parsed contacts: ${counts.contacts}`);

            // ── parse: calls ──────────────────────────────────────────────
            // Modern Android (12+) splits the call log into a standalone
            // calllog.db (same com.android.providers.contacts package).
            // Legacy AOSP kept the `calls` table inside contacts2.db, so we
            // fall back to it when calllog.db isn't present.
            sendProgress(event, importId, { stage: 'parsing-calls', current: 0, total: 1, label: 'Parsing call log...' });
            const callLogFile = extractedFiles.find(f => f.kind === 'calllog');
            const callsSource = callLogFile || contactsFile;
            let callsData = { calls: [], errors: ['no calllog.db or contacts2.db found'] };
            if (callsSource) {
                const r = Parser.parseCallLogDb(callsSource.destPath);
                if (r.success) {
                    callsData = { calls: r.data, errors: [] };
                } else {
                    callsData = { calls: [], errors: r.errors || ['unknown parse error'] };
                    if (r.skipped) callsData.skipped = r.skipped;
                }
                callsData.source = callLogFile ? 'calllog.db' : 'contacts2.db';
            }
            await writeParsed(parsedDir, 'calls', callsData);
            counts.calls = callsData.calls?.length || 0;
            log(`Parsed calls: ${counts.calls} (source=${callsData.source || 'none'})`);

            // ── parse: sms / mms / rcs ────────────────────────────────────
            // Merges classic AOSP (mmssms.db) + Google Messages (bugle_db).
            // Pixel/stock Android: bugle only. Carrier devices: often both — the
            // legacy mmssms.db carries pre-Messages history while bugle_db has
            // recent traffic incl. RCS. We surface BOTH and dedupe identical
            // (timestamp, address, body) triplets within ±1s.
            sendProgress(event, importId, { stage: 'parsing-sms', current: 0, total: 1, label: 'Parsing SMS / MMS / RCS...' });
            const smsFile   = extractedFiles.find(f => f.kind === 'mmssms');
            const bugleFile = extractedFiles.find(f => f.kind === 'bugle');
            const allMessages = [];
            const allThreads  = [];
            const smsErrors   = [];
            const smsSkipped  = [];
            const smsSources  = [];

            if (smsFile) {
                const r = Parser.parseMmsSmsDb(smsFile.destPath);
                if (r.success) {
                    for (const m of (r.data || [])) {
                        if (!m.source) m.source = 'mmssms.db';
                        allMessages.push(m);
                    }
                    for (const t of (r.threads || [])) allThreads.push({ ...t, source: 'mmssms.db' });
                    smsSources.push('mmssms.db');
                } else {
                    for (const e of (r.errors || [])) smsErrors.push(`mmssms.db: ${e}`);
                    if (r.skipped) for (const s of r.skipped) smsSkipped.push({ ...s, source: 'mmssms.db' });
                }
            }
            if (bugleFile) {
                const r = Parser.parseBugleDb(bugleFile.destPath);
                if (r.success) {
                    for (const m of (r.data || [])) allMessages.push(m);
                    for (const t of (r.threads || [])) allThreads.push({ ...t, source: 'bugle_db' });
                    smsSources.push('bugle_db');
                } else {
                    for (const e of (r.errors || [])) smsErrors.push(`bugle_db: ${e}`);
                    if (r.skipped) for (const s of r.skipped) smsSkipped.push({ ...s, source: 'bugle_db' });
                }
            }
            if (!smsFile && !bugleFile) {
                smsErrors.push('no mmssms.db or bugle_db found');
            }

            // Dedupe across sources: collapse identical (normalized address,
            // body, timestamp ±1s) when present in BOTH stores.
            const dedupedMessages = _cbDedupeMessages(allMessages);

            // Re-sort newest first
            dedupedMessages.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
            allThreads.sort((a, b) => (b.latestTimestamp || 0) - (a.latestTimestamp || 0));

            const smsData = {
                messages: dedupedMessages,
                threads: allThreads,
                sources: smsSources,
                errors: smsErrors,
            };
            if (smsSkipped.length) smsData.skipped = smsSkipped;
            await writeParsed(parsedDir, 'sms', smsData);
            counts.sms = smsData.messages.length;
            const rcsCount = smsData.messages.filter(m => m.kind === 'rcs').length;
            log(`Parsed sms: ${counts.sms} (${smsData.threads.length} threads, sources: ${smsSources.join('+') || 'none'}, rcs: ${rcsCount})`);

            // ── parse: accounts ───────────────────────────────────────────
            // Prefer accounts-ce, fall back to accounts-de.
            sendProgress(event, importId, { stage: 'parsing-accounts', current: 0, total: 1, label: 'Parsing accounts...' });
            const accountsFile =
                extractedFiles.find(f => f.kind === 'accounts-ce') ||
                extractedFiles.find(f => f.kind === 'accounts-de');
            let accountsData = { accounts: [], errors: ['no accounts db found'] };
            if (accountsFile) {
                const r = Parser.parseAccountsDb(accountsFile.destPath);
                if (r.success) {
                    accountsData = { accounts: r.data, errors: [], sourcePath: accountsFile.srcPath };
                } else {
                    accountsData = { accounts: [], errors: r.errors || ['unknown parse error'] };
                    if (r.skipped) accountsData.skipped = r.skipped;
                }
            }
            await writeParsed(parsedDir, 'accounts', accountsData);
            counts.accounts = accountsData.accounts?.length || 0;
            log(`Parsed accounts: ${counts.accounts}`);

            // ── parse: wifi ───────────────────────────────────────────────
            sendProgress(event, importId, { stage: 'parsing-wifi', current: 0, total: 1, label: 'Parsing Wi-Fi configurations...' });
            const wifiFile = extractedFiles.find(f => f.kind === 'wifi-store');
            let wifiData = { networks: [], errors: ['no WifiConfigStore.xml found'] };
            if (wifiFile) {
                try {
                    const text = fs.readFileSync(wifiFile.destPath, 'utf-8');
                    const r = Parser.parseWifiConfigStore(text);
                    if (r.success) {
                        wifiData = { networks: r.data, errors: [], sourcePath: wifiFile.srcPath };
                    } else {
                        wifiData = { networks: [], errors: r.errors || ['unknown parse error'] };
                    }
                } catch (e) {
                    wifiData = { networks: [], errors: ['read failed: ' + e.message] };
                }
            }
            await writeParsed(parsedDir, 'wifi', wifiData);
            counts.wifi = wifiData.networks?.length || 0;
            log(`Parsed wifi: ${counts.wifi}`);

            // ── index: media (Phase 1.4 — additive, NO extraction) ────────
            sendProgress(event, importId, { stage: 'indexing-media', current: 0, total: 1, label: 'Indexing media...' });
            let mediaResult = { totalCount: 0, totalBytes: 0, byCategory: {}, byType: {}, items: [], errors: [] };
            try {
                const perZipHits = [];
                for (let zi = 0; zi < scan.zips.length; zi++) {
                    if (isCancelled(importId)) break;
                    const z = scan.zips[zi];
                    sendProgress(event, importId, { stage: 'indexing-media', current: zi, total: scan.zips.length, label: `Scanning media in ${z.name}...` });
                    const r = await Extractor.indexMediaInZip(z.path, { security: null });
                    if (r.success) {
                        perZipHits.push({ zipPath: z.path, items: r.items });
                    } else {
                        for (const e of (r.errors || [])) errors.push({ stage: 'indexing-media', zip: z.name, error: e });
                    }
                }
                mediaResult = await MediaIndexer.buildMediaIndex(perZipHits, {
                    parseExif: true,
                    isCancelled: () => isCancelled(importId),
                    onProgress: (p) => {
                        sendProgress(event, importId, { stage: 'indexing-media', current: p.current, total: p.total, label: `EXIF ${p.current}/${p.total}: ${p.label}` });
                    },
                });
                for (const e of (mediaResult.errors || [])) errors.push({ stage: 'indexing-media', ...e });
            } catch (e) {
                errors.push({ stage: 'indexing-media', error: e.message || String(e) });
                log(`Media index error: ${e.message}`);
            }
            await writeParsed(parsedDir, 'media', mediaResult);
            counts.media = mediaResult.totalCount || 0;
            log(`Indexed media: ${counts.media} (${(mediaResult.totalBytes / (1024 * 1024)).toFixed(1)} MB across categories: ${Object.entries(mediaResult.byCategory || {}).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'})`);

            // ── manifest + done ───────────────────────────────────────────
            const manifest = writeManifest({
                status: 'completed',
                lastCompletedStage: 'done',
                importId,
                ufdxPath: importedUfdxPath,
                originalUfdxPath: ufdxPath,
                sourceMode,
                caseNumber,
                evidenceTag,
                deviceLabel: deviceLabel || deviceData.device?.model || null,
                counts,
                errors,
                bundleSize,
                createdAt: new Date().toISOString(),
                scanSummary: {
                    zipCount: scan.zips.length,
                    ufdCount: scan.ufds.length,
                    targetSizeTotal: scan.targetSizeTotal,
                },
                extractedFiles: extractedFiles.map(f => ({ kind: f.kind, srcPath: f.srcPath, destPath: f.destPath, size: f.size })),
                extractedDir: path.resolve(extractedDir),
                sourceIntegrity,
            });

            sendProgress(event, importId, { stage: 'done', current: 1, total: 1, label: 'Import complete' });
            log(`Import completed: ${JSON.stringify(counts)}`);

            return {
                success: true,
                importId,
                caseNumber,
                caseId,
                caseRoot,
                extractedDir: path.resolve(extractedDir),
                sourceIntegrity,
                manifest,
                counts,
                errors,
                phase: '1.2',
            };
        } catch (e) {
            errors.push({ stage: 'fatal', error: e.message, stack: e.stack });
            log(`FATAL: ${e.message}\n${e.stack}`);
            try {
                writeManifest({ status: 'failed', lastCompletedStage: 'unknown', importId, ufdxPath, sourceMode, caseNumber, evidenceTag, deviceLabel, counts, errors });
            } catch (_) {}
            return { success: false, error: e.message, importId };
        } finally {
            clearCancelled(importId);
        }

        // ── inner helpers ─────────────────────────────────────────────────
        function writeManifest(m) {
            try {
                _secureWriteJson(manifestPath, m);
            } catch (_) {}
            return m;
        }
    });

    // ── read-parsed: load parsed/{surface}.json ──────────────────────────
    ipcMain.handle('cellebrite-read-parsed', async (event, { caseNumber, importId, surface } = {}) => {
        try {
            const file = path.join(
                'cases', String(caseNumber), 'Cellebrite', String(importId),
                'parsed', `${surface}.json`
            );
            // Source Validation: where the databases this import read live.
            // Lets imports made before fingerprints existed still be opened.
            const ex = path.resolve('cases', String(caseNumber), 'Cellebrite', String(importId), 'extracted');
            const extractedDir = fs.existsSync(ex) ? ex : null;
            if (!fs.existsSync(file)) {
                return { success: true, data: null, exists: false, extractedDir };
            }
            const r = _secureReadJson(file);
            if (!r.ok) {
                return { success: false, error: r.error, locked: !!r.locked };
            }
            return { success: true, data: r.data, exists: true, extractedDir };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // ── delete-import: rm -r the importId folder ─────────────────────────
    ipcMain.handle('cellebrite-delete-import', async (event, { caseNumber, importId } = {}) => {
        try {
            if (!caseNumber || !importId) {
                return { success: false, error: 'caseNumber + importId required' };
            }
            const target = path.join('cases', String(caseNumber), 'Cellebrite', String(importId));
            if (!fs.existsSync(target)) {
                return { success: true, alreadyMissing: true };
            }
            rmrfSafe(target);
            return { success: true };
        } catch (e) {
            console.error('[Cellebrite] delete-import error:', e);
            return { success: false, error: e.message };
        }
    });

    // ── cancel-import ────────────────────────────────────────────────────
    ipcMain.handle('cellebrite-cancel-import', async (event, { importId } = {}) => {
        setCancelled(importId, true);
        return { success: true };
    });

    // ── media-read: lazy fetch a single media entry's bytes ──────────────
    // Renderer passes {caseNumber, importId, mediaId}; we look up the item
    // in parsed/media.json, open its sourceZip, stream the entry bytes,
    // and return {buffer (base64), mime, size, filename}.
    //
    // NEVER add this to a public handler — caller must already have a valid
    // case path. ID lookup prevents arbitrary-entry reads.
    ipcMain.handle('cellebrite-media-read', async (event, { caseNumber, importId, mediaId } = {}) => {
        try {
            if (!caseNumber || !importId || !mediaId) {
                return { success: false, error: 'caseNumber + importId + mediaId required' };
            }
            const mediaJsonPath = path.join(
                'cases', String(caseNumber), 'Cellebrite', String(importId),
                'parsed', 'media.json'
            );
            if (!fs.existsSync(mediaJsonPath)) {
                return { success: false, error: 'media.json not found for this import' };
            }
            const r = _secureReadJson(mediaJsonPath);
            if (!r.ok) {
                return { success: false, error: r.error, locked: !!r.locked };
            }
            const idx = r.data;
            const item = (idx.items || []).find(x => x && x.id === mediaId);
            if (!item) {
                return { success: false, error: `media id not found: ${mediaId}` };
            }
            if (!item.sourceZip || !fs.existsSync(item.sourceZip)) {
                return { success: false, error: 'sourceZip missing on disk', sourceZip: item.sourceZip };
            }

            // Shared reader — see _withDumpReader. Never close it here.
            return await _withDumpReader(item.sourceZip, (reader) => {
                const buf = reader._zip
                    ? reader._zip.entryDataSync(item.rawEntryName)
                    : (function () {
                        const entries = reader.getEntries();
                        const found = entries.find(e => (e.entryName || e._name) === item.rawEntryName);
                        return found ? found.getData() : null;
                    })();
                if (!Buffer.isBuffer(buf)) {
                    return { success: false, error: 'entry read returned no buffer' };
                }
                return {
                    success: true,
                    mediaId,
                    filename: item.filename,
                    mime: item.mime,
                    size: buf.length,
                    buffer: buf.toString('base64'),
                };
            });
        } catch (e) {
            console.error('[Cellebrite] media-read error:', e);
            return { success: false, error: e.message || String(e) };
        }
    });

    // ── media-verify: check one picture/video against the phone dump ─────
    ipcMain.handle('cellebrite-media-verify', async (event, { caseNumber, importId, mediaId } = {}) => {
        try {
            const got = _loadMediaItem(caseNumber, importId, mediaId);
            if (!got.ok) return { success: false, error: got.error, locked: !!got.locked };
            const out = await _checkMediaItem(got.item);
            if (out.zipSize != null) {
                const key = _dumpKey(got.item.sourceZip, { size: out.zipSize, mtimeMs: out.zipMtimeMs });
                out.dumpCheck = _publicJob(_dumpJobs.get(key) || _savedDumpCheck(caseNumber, importId, key));
            }
            return Object.assign({ success: true, mediaId }, out);
        } catch (e) {
            console.error('[Cellebrite] media-verify error:', e);
            return { success: false, error: e.message || String(e) };
        }
    });

    // ── dump-verify: whole-dump SHA-256 vs the one Cellebrite recorded ───
    // Polled by the renderer; {start:true} begins a check if none is running
    // or saved. The dump is found through the media item, never a raw path.
    ipcMain.handle('cellebrite-dump-verify', async (event, { caseNumber, importId, mediaId, start } = {}) => {
        try {
            const got = _loadMediaItem(caseNumber, importId, mediaId);
            if (!got.ok) return { success: false, error: got.error, locked: !!got.locked };
            const zip = got.item.sourceZip;
            if (!zip || !fs.existsSync(zip)) return { success: false, error: 'The phone dump is not on disk at its recorded location.' };
            const st = fs.statSync(zip);
            const key = _dumpKey(zip, st);
            let job = _dumpJobs.get(key);
            if (!job || job.state === 'error') {
                const saved = _savedDumpCheck(caseNumber, importId, key);
                if (saved) return { success: true, check: _publicJob(saved) };
                if (start) {
                    const ufd = _ufdRecordFor(zip);
                    job = _startDumpJob(caseNumber, importId, zip, key, st.size, ufd && ufd.sha256);
                }
            }
            return { success: true, check: _publicJob(job) };
        } catch (e) {
            return { success: false, error: e.message || String(e) };
        }
    });

    // ── media-save: save an exact copy of one file out of the dump ───────
    ipcMain.handle('cellebrite-media-save', async (event, { caseNumber, importId, mediaId } = {}) => {
        try {
            const got = _loadMediaItem(caseNumber, importId, mediaId);
            if (!got.ok) return { success: false, error: got.error, locked: !!got.locked };
            const item = got.item;
            if (!item.sourceZip || !fs.existsSync(item.sourceZip)) return { success: false, error: 'The phone dump is not on disk at its recorded location.' };
            const safeName = String(item.filename || 'media').replace(/[<>:"|?*\x00-\x1F\\/]/g, '_');
            const res = await dialog.showSaveDialog({ title: 'Save an exact copy of this file', defaultPath: safeName });
            if (res.canceled || !res.filePath) return { success: false, canceled: true };
            const { openZip } = require('../_shared/zip-reader');
            const reader = await openZip(item.sourceZip, {});
            try { await reader.extractEntryToFile(item.rawEntryName, res.filePath); }
            finally { try { reader.close(); } catch (_) {} }
            return { success: true, path: res.filePath, sha256: await _sha256File(res.filePath) };
        } catch (e) {
            return { success: false, error: e.message || String(e) };
        }
    });
}

// ─── Internal helpers (used by import handler) ──────────────────────────

async function runScan(ufdxPath) {
    // Re-runs the scan logic the IPC handler does — extracted so the
    // import flow can call it without round-tripping through ipcMain.
    if (!ufdxPath || !fs.existsSync(ufdxPath)) {
        return { success: false, error: 'ufdx path does not exist' };
    }
    const parentDir = path.dirname(ufdxPath);
    const ufdxText = fs.readFileSync(ufdxPath, 'utf-8');
    const ufdx = Parser.parseUfdx(ufdxText);

    const fileSystems = [];
    const ufdFiles = [];
    const otherSiblings = [];
    for (const ent of readDirSafe(parentDir)) {
        const full = path.join(parentDir, ent.name);
        if (ent.isDirectory() && /^FileSystem\s+\d+$/i.test(ent.name)) {
            fileSystems.push({ name: ent.name, path: full });
        } else if (ent.isFile()) {
            const s = statSafe(full);
            if (ent.name.toLowerCase().endsWith('.ufd')) ufdFiles.push({ name: ent.name, path: full, size: s?.size || 0 });
            else otherSiblings.push({ name: ent.name, path: full, size: s?.size || 0 });
        }
    }
    for (const fsDir of fileSystems) {
        for (const ent of readDirSafe(fsDir.path)) {
            const full = path.join(fsDir.path, ent.name);
            if (!ent.isFile()) continue;
            const s = statSafe(full);
            if (ent.name.toLowerCase().endsWith('.ufd')) {
                ufdFiles.push({ name: ent.name, path: full, size: s?.size || 0, fileSystemName: fsDir.name });
            }
        }
    }
    const ufds = [];
    for (const u of ufdFiles) {
        try {
            const text = fs.readFileSync(u.path, 'utf-8');
            ufds.push({ name: u.name, path: u.path, size: u.size, fileSystemName: u.fileSystemName || null, parsed: Parser.parseUfd(text) });
        } catch (e) {
            ufds.push({ name: u.name, path: u.path, size: u.size, fileSystemName: u.fileSystemName || null, parsed: { success: false, errors: [e.message] } });
        }
    }
    const zips = [];
    for (const fsDir of fileSystems) {
        for (const ent of readDirSafe(fsDir.path)) {
            if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.zip')) continue;
            const full = path.join(fsDir.path, ent.name);
            const s = statSafe(full);
            const scan = await Extractor.scanZipTargets(full);
            zips.push({
                name: ent.name,
                path: full,
                size: s?.size || 0,
                fileSystemName: fsDir.name,
                entryCount: scan.entryCount,
                targets: scan.targets,
                dataDataPackages: scan.dataDataPackages,
                anyDataData: scan.anyDataData,
                errors: scan.errors,
            });
        }
    }
    const targetIndex = {};
    for (const z of zips) for (const t of z.targets) {
        if (!targetIndex[t.kind]) targetIndex[t.kind] = [];
        targetIndex[t.kind].push({ zip: z.name, path: t.path, size: t.size });
    }
    const bundleSize = sumBundleSize(ufdxPath);
    const targetSizeTotal = Object.values(targetIndex).flat().reduce((a, t) => a + (t.size || 0), 0);
    return { success: true, ufdxPath, parentDir, bundleSize, ufdx: ufdx.data || null, ufds, fileSystems, otherSiblings, zips, targetIndex, targetSizeTotal };
}

function buildDeviceOverview(scan, extractedFiles) {
    // Precedence for device-identity fields (highest wins):
    //   1. build.prop    (ground truth from the device itself)
    //   2. .ufd record   (Cellebrite's per-extraction device manifest)
    //   3. .ufdx record  (top-level evidence collection; often generic class)
    //
    // We layer in reverse order (ufdx → ufd → build.prop) and let each
    // layer overwrite the previous when it has a non-empty value.
    let device = {
        make: null, model: null, serial: null, imei: [], iccid: [],
        androidVersion: null, buildFingerprint: null, fbeStatus: 'unknown',
        securityPatch: null, chipset: null,
    };
    let extraction = {
        tool: null, version: null, date: null, examiner: null,
        caseNumber: null, evidenceNumber: null, type: null,
    };
    const _take = (cur, val) => {
        if (val === null || val === undefined) return cur;
        const s = (typeof val === 'string') ? val.trim() : val;
        if (s === '' || s === null || s === undefined) return cur;
        return s;
    };

    // Layer 1: ufdx
    if (scan.ufdx) {
        extraction.tool           = _take(extraction.tool,           scan.ufdx.toolName);
        extraction.version        = _take(extraction.version,        scan.ufdx.toolVersion);
        extraction.date           = _take(extraction.date,           scan.ufdx.extractionDate);
        extraction.examiner       = _take(extraction.examiner,       scan.ufdx.examinerName);
        extraction.caseNumber     = _take(extraction.caseNumber,     scan.ufdx.caseNumber);
        extraction.evidenceNumber = _take(extraction.evidenceNumber, scan.ufdx.evidenceNumber);
        if (scan.ufdx.deviceInfo) {
            const di = scan.ufdx.deviceInfo;
            device.make  = _take(device.make,  di.Vendor || di.Manufacturer);
            device.model = _take(device.model, di.Model);
        }
        if (Array.isArray(scan.ufdx.extractions) && scan.ufdx.extractions.length) {
            extraction.type = _take(extraction.type, scan.ufdx.extractions[0].transferType);
        }
    }
    // Layer 2: .ufd (overrides ufdx)
    for (const u of (scan.ufds || [])) {
        if (!u.parsed || !u.parsed.success) continue;
        const d = u.parsed.data || {};
        device.make             = _take(device.make,             d.make);
        device.model            = _take(device.model,            d.model);
        device.serial           = _take(device.serial,           d.serial);
        device.androidVersion   = _take(device.androidVersion,   d.androidVersion);
        device.buildFingerprint = _take(device.buildFingerprint, d.buildFingerprint);
        device.securityPatch    = _take(device.securityPatch,    d.securityPatch);
        device.chipset          = _take(device.chipset,          d.chipset);
        if (Array.isArray(d.imei))  for (const x of d.imei)  if (x && !device.imei.includes(x))  device.imei.push(x);
        if (Array.isArray(d.iccid)) for (const x of d.iccid) if (x && !device.iccid.includes(x)) device.iccid.push(x);
        extraction.type = _take(extraction.type, d.extractionType);
        extraction.date = _take(extraction.date, d.extractionDate);
        extraction.tool = _take(extraction.tool, d.acquisitionTool);
    }

    // Layer 3: build.prop (ground truth — highest precedence)
    const bpFile = (extractedFiles || []).find(f => f.kind === 'buildProp');
    let buildProp = null;
    if (bpFile) {
        try {
            const text = fs.readFileSync(bpFile.destPath, 'utf-8');
            const r = Parser.parseBuildProp(text);
            if (r.success) {
                buildProp = r.data;
                const k = r.data.keys || {};
                device.model            = _take(device.model,            k['ro.product.model']);
                device.make             = _take(device.make,             k['ro.product.brand'] || k['ro.product.manufacturer']);
                device.serial           = _take(device.serial,           k['ro.serialno'] || k['ro.boot.serialno']);
                device.androidVersion   = _take(device.androidVersion,   k['ro.build.version.release']);
                device.buildFingerprint = _take(device.buildFingerprint, k['ro.build.fingerprint']);
                device.fbeStatus = r.data.fbe;
            }
        } catch (_) {}
    }

    return {
        device,
        extraction,
        buildProp,
        source: {
            ufdxPath: scan.ufdxPath || null,
            bundleSize: scan.bundleSize || 0,
            zipPaths: (scan.zips || []).map(z => ({ name: z.name, path: z.path, size: z.size })),
        },
    };
}

function parseAppsForBundle(scan) {
    // Find InstalledAppsList.txt in any FileSystem NN/ — there's usually one.
    let appsText = '';
    for (const fsDir of (scan.fileSystems || [])) {
        const candidate = path.join(fsDir.path, 'InstalledAppsList.txt');
        if (fs.existsSync(candidate)) {
            try { appsText = fs.readFileSync(candidate, 'utf-8'); break; } catch (_) {}
        }
    }
    let result = { apps: [], extras: [], errors: [] };
    if (appsText) {
        const r = Parser.parseInstalledAppsList(appsText);
        if (r.success) result.apps = r.data;
        else result.errors.push(...r.errors);
    } else {
        result.errors.push('no InstalledAppsList.txt found');
    }
    // Aggregate /data/data/* packages across all zips
    const pkgSet = new Set();
    for (const z of (scan.zips || [])) for (const p of (z.dataDataPackages || [])) pkgSet.add(p);
    const cross = Parser.crossCheckAppsWithDataDir(result.apps, [...pkgSet]);
    return { apps: cross.apps, extras: cross.extras, errors: result.errors };
}

async function writeParsed(parsedDir, surface, data) {
    const file = path.join(parsedDir, `${surface}.json`);
    _secureWriteJson(file, data);
    return file;
}

function findFirstByExt(dir, ext) {
    const stack = [dir];
    while (stack.length) {
        const cur = stack.pop();
        for (const ent of readDirSafe(cur)) {
            const full = path.join(cur, ent.name);
            if (ent.isDirectory()) stack.push(full);
            else if (ent.isFile() && full.toLowerCase().endsWith(ext.toLowerCase())) return full;
        }
    }
    return null;
}

module.exports = {
    registerIpc,
    setSecurityManager,
    setSourceFingerprint,
    _internals: { _cellebriteFingerprint, _crc32, _checkMediaItem, _rawEntryStream, _withDumpReader, _closeDumpReaders, _dumpReaders, DUMP_READER_IDLE_MS, _ufdRecordFor, _loadMediaItem, genImportId, sumBundleSize, isCancelled, setCancelled, clearCancelled, runScan, buildDeviceOverview, parseAppsForBundle, freeSpaceFor, rmrfSafe, _cbDedupeMessages, _cbNormAddr, _secureWriteJson, _secureReadJson, setSecurityManager },
};

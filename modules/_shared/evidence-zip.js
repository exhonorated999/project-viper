/**
 * Evidence ZIP — read inside a ZIP that is filed as evidence, without
 * unpacking it.            MAIN PROCESS ONLY (uses fs / zip-reader).
 * ─────────────────────────────────────────────────────────────────────────
 * The ICAC Data System sends every CyberTip as one ZIP: the CyberTipline
 * report PDF plus a separate file (usually another ZIP) holding the reported
 * media. VIPER keeps that ZIP exactly as received, and this module lets the
 * Cyber Tips tab parse the report out of it and the Evidence viewer show
 * what is inside it.
 *
 * Why it does not just call zip-reader's openZip(path, { security }):
 * for a Field-Security-encrypted ZIP that helper decrypts to a PLAIN temp
 * file in the OS temp folder. For a CyberTip that would leave reported child
 * abuse material sitting unencrypted on disk. Here an encrypted ZIP is
 * decrypted into MEMORY only, and nothing is ever written to disk — entries
 * are read into a Buffer and handed back to the caller.
 *
 * One level of nesting is followed (the media ZIP inside the CyberTip ZIP).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { openZip } = require('./zip-reader');

const LIMITS = Object.freeze({
    // An encrypted ZIP is decrypted whole into memory. VIPER refuses to
    // encrypt anything over 1.9 GB when it is copied in, so an encrypted ZIP
    // above this cannot have been written by VIPER anyway.
    encryptedMaxBytes: 1900 * 1024 * 1024,
    // A ZIP inside the ZIP is read into memory to list it.
    nestedMaxBytes: 1024 * 1024 * 1024,
    // A single entry handed to the viewer / PDF reader. Matches the inline
    // preview ceiling of read-evidence-file.
    readMaxBytes: 500 * 1024 * 1024,
    // A hostile or broken archive must not produce an unbounded listing.
    maxEntries: 20000,
    idleCloseMs: 60000,
});

const MIME = Object.freeze({
    pdf: 'application/pdf',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    bmp: 'image/bmp', webp: 'image/webp', tif: 'image/tiff', tiff: 'image/tiff',
    heic: 'image/heic', heif: 'image/heif',
    mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', webm: 'video/webm',
    avi: 'video/x-msvideo', mkv: 'video/x-matroska', wmv: 'video/x-ms-wmv', '3gp': 'video/3gpp',
    mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg',
    flac: 'audio/flac', opus: 'audio/ogg',
    txt: 'text/plain', csv: 'text/csv', json: 'application/json', xml: 'application/xml',
    html: 'text/html', htm: 'text/html',
});

function extOf(name) {
    const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : '';
}

function mimeFor(name) {
    return MIME[extOf(name)] || 'application/octet-stream';
}

function kindOf(name) {
    const ext = extOf(name);
    if (ext === 'pdf') return 'pdf';
    if (ext === 'zip') return 'zip';
    const mime = MIME[ext] || '';
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') return 'text';
    return 'other';
}

// Operating-system clutter that is never evidence.
function isJunk(name) {
    const n = String(name || '').replace(/\\/g, '/');
    if (/(^|\/)__MACOSX\//.test(n)) return true;
    const base = n.split('/').pop();
    return base === '.DS_Store' || base === 'Thumbs.db' || base === 'desktop.ini';
}

function entrySize(e) {
    if (!e) return 0;
    if (typeof e.size === 'number') return e.size;
    if (e.header && typeof e.header.size === 'number') return e.header.size;
    return 0;
}

function lockedError() {
    const e = new Error('This file is protected by Field Security. Unlock VIPER and try again.');
    e.code = 'VIPER_LOCKED';
    return e;
}

function peek(filePath, n) {
    const fd = fs.openSync(filePath, 'r');
    try {
        const buf = Buffer.alloc(n);
        const got = fs.readSync(fd, buf, 0, n, 0);
        return buf.subarray(0, got);
    } finally { fs.closeSync(fd); }
}

function validateZipPath(zipPath) {
    if (typeof zipPath !== 'string' || !zipPath) return 'No file was given.';
    if (!/\.zip$/i.test(zipPath)) return 'That file is not a ZIP.';
    if (!fs.existsSync(zipPath)) return 'That ZIP is no longer on disk.';
    return null;
}

/**
 * Open a ZIP from disk. Encrypted (VIPENC) files are decrypted into memory
 * and opened from the buffer — never via a temp file.
 */
async function openEvidenceZip(zipPath, security) {
    const head = peek(zipPath, 8);
    const encrypted = !!(security && security.isEncryptedBuffer && security.isEncryptedBuffer(head));
    if (!encrypted) return openZip(zipPath);           // no options → never decrypts to temp
    if (!security.isUnlocked || !security.isUnlocked()) throw lockedError();
    const size = fs.statSync(zipPath).size;
    if (size > LIMITS.encryptedMaxBytes) {
        throw new Error('This encrypted ZIP is too large to open inside VIPER.');
    }
    const plain = security.decryptBuffer(fs.readFileSync(zipPath));
    return openZip(plain);                              // buffer mode, memory only
}

// ── Cache: one open reader per ZIP, closed after a minute idle ────────────
const _cache = new Map();   // zipPath -> { reader, inner: Map, mtimeMs, timer }

function _touch(zipPath, rec) {
    if (rec.timer) clearTimeout(rec.timer);
    rec.timer = setTimeout(() => _drop(zipPath), LIMITS.idleCloseMs);
    if (rec.timer && rec.timer.unref) rec.timer.unref();
}

function _drop(zipPath) {
    const rec = _cache.get(zipPath);
    if (!rec) return;
    _cache.delete(zipPath);
    if (rec.timer) clearTimeout(rec.timer);
    for (const r of rec.inner.values()) { try { r.close(); } catch (_) {} }
    try { rec.reader.close(); } catch (_) {}
}

async function _get(zipPath, security) {
    const mtimeMs = fs.statSync(zipPath).mtimeMs;
    const hit = _cache.get(zipPath);
    // A decrypted ZIP held open in memory must not outlive Field Security
    // being locked: the cached copy is dropped and the read refused.
    if (hit && hit.encrypted && !(security && security.isUnlocked && security.isUnlocked())) {
        _drop(zipPath);
        throw lockedError();
    }
    if (hit && hit.mtimeMs === mtimeMs) { _touch(zipPath, hit); return hit; }
    if (hit) _drop(zipPath);
    const encrypted = !!(security && security.isEncryptedBuffer && security.isEncryptedBuffer(peek(zipPath, 8)));
    const reader = await openEvidenceZip(zipPath, security);
    const rec = { reader, inner: new Map(), mtimeMs, timer: null, encrypted };
    _cache.set(zipPath, rec);
    _touch(zipPath, rec);
    return rec;
}

function _findEntry(reader, name) {
    return reader.getEntries().find(e => !e.isDirectory && e.entryName === name) || null;
}

async function _getInner(rec, innerZipName) {
    if (rec.inner.has(innerZipName)) return rec.inner.get(innerZipName);
    const ent = _findEntry(rec.reader, innerZipName);
    if (!ent) throw new Error('That file is not in the ZIP.');
    if (entrySize(ent) > LIMITS.nestedMaxBytes) throw new Error('The ZIP inside this ZIP is too large to open here.');
    const r = await openZip(ent.getData());
    rec.inner.set(innerZipName, r);
    return r;
}

function _listReader(reader, inZip) {
    const out = [];
    for (const e of reader.getEntries()) {
        if (out.length >= LIMITS.maxEntries) break;
        if (!e || e.isDirectory || isJunk(e.entryName)) continue;
        const item = { name: e.entryName, size: entrySize(e), kind: kindOf(e.entryName) };
        if (inZip) item.inZip = inZip;
        out.push(item);
    }
    return out;
}

/**
 * List every file in the ZIP, and in any ZIP inside it.
 * Returns { ok, zipName, entries:[{name, size, kind, inZip?}], nestedErrors:[{name, error}] }.
 * Never throws; a failure comes back as { ok:false, error, locked? }.
 */
async function listEvidenceZip(zipPath, security) {
    const bad = validateZipPath(zipPath);
    if (bad) return { ok: false, error: bad };
    try {
        const rec = await _get(zipPath, security);
        const top = _listReader(rec.reader, null);
        const entries = [];
        const nestedErrors = [];
        for (const it of top) {
            entries.push(it);
            if (it.kind !== 'zip') continue;
            try {
                const inner = await _getInner(rec, it.name);
                for (const child of _listReader(inner, it.name)) {
                    if (entries.length >= LIMITS.maxEntries) break;
                    entries.push(child);
                }
            } catch (e) {
                nestedErrors.push({ name: it.name, error: (e && e.message) || String(e) });
            }
        }
        return { ok: true, zipName: path.basename(zipPath), entries, nestedErrors };
    } catch (e) {
        return { ok: false, error: (e && e.message) || String(e), locked: !!(e && e.code === 'VIPER_LOCKED') };
    }
}

/**
 * Read one file out of the ZIP (or out of a ZIP inside it) into memory.
 * `inZip` is the name of the inner ZIP, or empty for a top-level entry.
 * Throws on failure — callers wrap it.
 */
async function readEvidenceZipEntry(zipPath, entryName, inZip, security) {
    const bad = validateZipPath(zipPath);
    if (bad) throw new Error(bad);
    if (typeof entryName !== 'string' || !entryName) throw new Error('No file inside the ZIP was named.');
    const rec = await _get(zipPath, security);
    const reader = inZip ? await _getInner(rec, inZip) : rec.reader;
    const ent = _findEntry(reader, entryName);
    if (!ent) throw new Error('That file is not in the ZIP.');
    const size = entrySize(ent);
    if (size > LIMITS.readMaxBytes) {
        const e = new Error('This file is too large to show inside VIPER (' + (size / 1024 / 1024).toFixed(0) + ' MB).');
        e.code = 'TOO_LARGE';
        throw e;
    }
    const bytes = ent.getData();
    return { bytes, name: path.basename(entryName.replace(/\\/g, '/')), mime: mimeFor(entryName), size: bytes.length };
}

function closeAll() {
    for (const k of Array.from(_cache.keys())) _drop(k);
}

module.exports = {
    LIMITS, kindOf, mimeFor, isJunk,
    openEvidenceZip, listEvidenceZip, readEvidenceZipEntry, closeAll,
};

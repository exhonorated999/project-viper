/**
 * Google Warrant store — main process only (better-sqlite3).
 *
 * Large Google returns carry hundreds of thousands of e-mails and millions of
 * location points.  Holding those in one JS object, cloning it over IPC and
 * saving it to localStorage is what used to take VIPER down.  Instead the
 * parser streams each e-mail / location point into a per-import SQLite file:
 *
 *   cases/<n>/Evidence/google-warrant/_store/<storeKey>.sqlite
 *
 * and the renderer keeps only a small preview plus { store: { keys } }.
 * A re-import of the same source replaces its file; deleting the import
 * deletes the file.  An import that fails part-way deletes its file, so a
 * half-written store is never read.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let _Database = null;
function Database() {
    if (!_Database) _Database = require('better-sqlite3');
    return _Database;
}

const PREVIEW_EMAILS = 200;
const PREVIEW_LOCATIONS = 500;
const PREVIEW_TEXT_CHARS = 500;
const BATCH = 1000;
const KEY_RE = /^[\w.-]{1,120}$/;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS emails (
    seq INTEGER PRIMARY KEY,
    msg_id TEXT,
    date TEXT,
    from_ TEXT, to_ TEXT, cc TEXT,
    subject TEXT, labels TEXT, thread_id TEXT,
    attachments TEXT,
    text_body TEXT, html_body TEXT,
    raw_size INTEGER, truncated INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS emails_msg_id ON emails(msg_id);
CREATE TABLE IF NOT EXISTS locations (
    seq INTEGER PRIMARY KEY,
    ts TEXT, lat REAL, lng REAL,
    accuracy REAL, altitude REAL, velocity REAL, heading REAL,
    source TEXT, device_tag TEXT, activity TEXT
);
`;

function storeKeyFor(inputPath) {
    const resolved = path.resolve(String(inputPath || 'warrant'));
    const base = path.basename(resolved).replace(/\.zip$/i, '').replace(/[^\w.-]/g, '_').replace(/^\.+/, '_').toLowerCase().slice(0, 60) || 'warrant';
    const h = crypto.createHash('sha1').update(resolved.toLowerCase()).digest('hex').slice(0, 10);
    return `${base}-${h}`;
}

function isValidKey(key) {
    return typeof key === 'string' && KEY_RE.test(key) && !key.startsWith('.');
}

function dbFileFor(storeDir, key) {
    if (!isValidKey(key)) throw new Error('Invalid Google Warrant store key');
    return path.join(storeDir, `${key}.sqlite`);
}

function _unlinkDb(file) {
    for (const ext of ['', '-wal', '-shm']) {
        try { if (fs.existsSync(file + ext)) fs.unlinkSync(file + ext); } catch (_) {}
    }
}

/** <key>.overflow/ holds only *.ndjson written by the parser; remove those, then the folder. */
function _removeOverflow(storeDir, key) {
    const dir = path.join(storeDir, `${key}.overflow`);
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const x of names) {
        if (x.isFile() && /\.ndjson$/i.test(x.name)) { try { fs.unlinkSync(path.join(dir, x.name)); } catch (_) {} }
    }
    try { fs.rmdirSync(dir); } catch (_) {}
}

function _str(v) { return v == null ? null : String(v); }
function _num(v) { const n = Number(v); return (v == null || v === '' || !Number.isFinite(n)) ? null : n; }

/**
 * Writer for one import.  Usage:
 *   const w = openWriter(storeDir, key);
 *   parser.parseOuterZip(input, { sink: w.sink });
 *   w.finish()  — or w.abort() on failure
 */
class GoogleStoreWriter {
    constructor(storeDir, key) {
        this.key = key;
        this.storeDir = storeDir;
        this.dbFile = dbFileFor(storeDir, key);
        // Written beside the final name and renamed in finish(), so a failed
        // re-import leaves the previous store in place.
        this.workFile = this.dbFile + '.importing';
        // The parser writes overflow NDJSON under <overflowKey>.overflow/ (a
        // staging folder); finish() swaps it in, abort() drops it, so a failed
        // re-import keeps the previous import's overflow too.
        this.overflowKey = key + '.importing';
        fs.mkdirSync(storeDir, { recursive: true });
        _unlinkDb(this.workFile);
        _removeOverflow(storeDir, this.overflowKey);   // the parser appends; staging must start empty
        const DB = Database();
        this.db = new DB(this.workFile);
        this.db.exec(SCHEMA_SQL);
        this.db.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = OFF;
            PRAGMA temp_store = MEMORY;
            PRAGMA cache_size = -32768;
        `);
        this.db.prepare('INSERT OR REPLACE INTO meta(k, v) VALUES (?, ?)').run('complete', '0');
        this._insEmail = this.db.prepare(`INSERT OR IGNORE INTO emails
            (msg_id, date, from_, to_, cc, subject, labels, thread_id, attachments, text_body, html_body, raw_size, truncated)
            VALUES (@msg_id, @date, @from_, @to_, @cc, @subject, @labels, @thread_id, @attachments, @text_body, @html_body, @raw_size, @truncated)`);
        this._insLoc = this.db.prepare(`INSERT INTO locations
            (ts, lat, lng, accuracy, altitude, velocity, heading, source, device_tag, activity)
            VALUES (@ts, @lat, @lng, @accuracy, @altitude, @velocity, @heading, @source, @device_tag, @activity)`);
        this._emailBatch = [];
        this._locBatch = [];
        this.emailCount = 0;
        this.emailDuplicates = 0;
        this.locationCount = 0;
        this.previewEmails = [];
        this.previewLocations = [];
        this._closed = false;
        this._flushEmails = this.db.transaction((rows) => {
            for (const r of rows) {
                const info = this._insEmail.run(r);
                if (info.changes) this.emailCount++; else this.emailDuplicates++;
            }
        });
        this._flushLocs = this.db.transaction((rows) => {
            for (const r of rows) this._insLoc.run(r);
            this.locationCount += rows.length;
        });
        this.sink = {
            email: (em) => this.addEmail(em),
            location: (loc) => this.addLocation(loc),
        };
    }

    addEmail(em) {
        if (this._closed || !em) return;
        this._emailBatch.push({
            msg_id: _str(em.id),
            date: _str(em.date),
            from_: _str(em.from), to_: _str(em.to), cc: _str(em.cc),
            subject: _str(em.subject), labels: _str(em.labels), thread_id: _str(em.threadId),
            attachments: JSON.stringify(Array.isArray(em.attachments) ? em.attachments : []),
            text_body: _str(em.textBody), html_body: _str(em.htmlBody),
            raw_size: _num(em.rawSize), truncated: em.truncated ? 1 : 0,
        });
        if (this.previewEmails.length < PREVIEW_EMAILS) this.previewEmails.push(previewOf(em));
        if (this._emailBatch.length >= BATCH) this._flushE();
    }

    addLocation(loc) {
        if (this._closed || !loc) return;
        this._locBatch.push({
            ts: _str(loc.timestamp), lat: _num(loc.lat), lng: _num(loc.lng),
            accuracy: _num(loc.accuracy), altitude: _num(loc.altitude),
            velocity: _num(loc.velocity), heading: _num(loc.heading),
            source: _str(loc.source), device_tag: _str(loc.deviceTag),
            activity: loc.activity == null ? null : (typeof loc.activity === 'string' ? loc.activity : JSON.stringify(loc.activity)),
        });
        if (this.previewLocations.length < PREVIEW_LOCATIONS) this.previewLocations.push(loc);
        if (this._locBatch.length >= BATCH) this._flushL();
    }

    _flushE() { if (this._emailBatch.length) { const b = this._emailBatch; this._emailBatch = []; this._flushEmails(b); } }
    _flushL() { if (this._locBatch.length) { const b = this._locBatch; this._locBatch = []; this._flushLocs(b); } }

    finish() {
        if (this._closed) return this.summary();
        this._flushE();
        this._flushL();
        this.db.exec('CREATE INDEX IF NOT EXISTS emails_date ON emails(date)');
        const setMeta = this.db.prepare('INSERT OR REPLACE INTO meta(k, v) VALUES (?, ?)');
        setMeta.run('emailCount', String(this.emailCount));
        setMeta.run('locationCount', String(this.locationCount));
        setMeta.run('complete', '1');
        try { this.db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}
        this.db.close();
        this._closed = true;
        _unlinkDb(this.dbFile);
        for (const ext of ['-wal', '-shm']) { try { if (fs.existsSync(this.workFile + ext)) fs.unlinkSync(this.workFile + ext); } catch (_) {} }
        fs.renameSync(this.workFile, this.dbFile);
        _removeOverflow(this.storeDir, this.key);
        const staged = path.join(this.storeDir, `${this.overflowKey}.overflow`);
        if (fs.existsSync(staged)) {
            try { fs.renameSync(staged, path.join(this.storeDir, `${this.key}.overflow`)); }
            catch (e) { console.error(`[google-warrant] could not move overflow into place: ${e.message}`); }
        }
        return this.summary();
    }

    abort() {
        if (!this._closed) {
            try { this.db.close(); } catch (_) {}
            this._closed = true;
        }
        _unlinkDb(this.workFile);
        _removeOverflow(this.storeDir, this.overflowKey);
    }

    summary() {
        return {
            keys: [this.key],
            emailCount: this.emailCount,
            emailDuplicates: this.emailDuplicates,
            locationCount: this.locationCount,
        };
    }
}

function previewOf(em) {
    const text = String(em.textBody || '');
    return {
        id: em.id, from: em.from || '', to: em.to || '', cc: em.cc || '',
        subject: em.subject || '', date: em.date || '', labels: em.labels || '',
        threadId: em.threadId || '',
        textBody: text.length > PREVIEW_TEXT_CHARS ? text.slice(0, PREVIEW_TEXT_CHARS) + '…' : text,
        htmlBody: '',
        attachments: Array.isArray(em.attachments) ? em.attachments : [],
        _preview: true,
    };
}

function openWriter(storeDir, key) { return new GoogleStoreWriter(storeDir, key); }

/** Replace the parser's inline arrays with the store preview + reference. */
function attachToResult(result, writer) {
    if (!result || !writer) return result;
    const s = writer.summary();
    result.emails = writer.previewEmails.slice();
    result.locationRecords = writer.previewLocations.slice();
    result.store = s;
    return result;
}

// ─── Readers ───────────────────────────────────────────────────────────

function _openRead(file) {
    if (!fs.existsSync(file)) return null;
    const DB = Database();
    const db = new DB(file, { readonly: true, fileMustExist: true });
    try {
        const row = db.prepare("SELECT v FROM meta WHERE k = 'complete'").get();
        if (!row || row.v !== '1') { db.close(); return null; }
    } catch (_) { db.close(); return null; }
    return db;
}

function _withDbs(storeDir, keys, fn) {
    const list = [];
    try {
        for (const key of (Array.isArray(keys) ? keys : [])) {
            if (!isValidKey(key)) continue;
            const db = _openRead(dbFileFor(storeDir, key));
            if (db) list.push({ key, db });
        }
        return fn(list);
    } finally {
        for (const x of list) { try { x.db.close(); } catch (_) {} }
    }
}

function _likeArg(q) {
    return '%' + String(q).replace(/[\\%_]/g, (m) => '\\' + m) + '%';
}

function _emailHeader(key, r) {
    let attachments = [];
    try { attachments = JSON.parse(r.attachments || '[]'); } catch (_) {}
    const text = r.snippet || '';
    return {
        key, seq: r.seq, id: r.msg_id,
        from: r.from_ || '', to: r.to_ || '', cc: r.cc || '',
        subject: r.subject || '', date: r.date || '', labels: r.labels || '', threadId: r.thread_id || '',
        attachments,
        snippet: text,
        hasHtml: !!r.has_html,
        truncated: !!r.truncated,
    };
}

/**
 * One page of e-mail headers across one or more stores (store order, then
 * newest first).  q matches subject / from / to / cc / body text.
 */
function readEmailPage(storeDir, { keys, offset = 0, limit = 50, q = '' } = {}) {
    offset = Math.max(0, Number(offset) || 0);
    limit = Math.min(500, Math.max(1, Number(limit) || 50));
    const query = String(q || '').trim();
    return _withDbs(storeDir, keys, (dbs) => {
        const where = query ? `WHERE subject LIKE @q ESCAPE '\\' OR from_ LIKE @q ESCAPE '\\' OR to_ LIKE @q ESCAPE '\\' OR cc LIKE @q ESCAPE '\\' OR text_body LIKE @q ESCAPE '\\'` : '';
        const args = query ? { q: _likeArg(query) } : {};
        let total = 0;
        const counts = dbs.map(({ db }) => {
            const n = db.prepare(`SELECT COUNT(*) AS n FROM emails ${where}`).get(args).n;
            total += n;
            return n;
        });
        const rows = [];
        let skip = offset;
        let want = limit;
        for (let i = 0; i < dbs.length && want > 0; i++) {
            if (skip >= counts[i]) { skip -= counts[i]; continue; }
            const page = dbs[i].db.prepare(`SELECT seq, msg_id, date, from_, to_, cc, subject, labels, thread_id, attachments, truncated,
                    substr(text_body, 1, 300) AS snippet, (html_body IS NOT NULL AND html_body <> '') AS has_html
                FROM emails ${where} ORDER BY date DESC, seq ASC LIMIT @limit OFFSET @offset`)
                .all(Object.assign({ limit: want, offset: skip }, args));
            for (const r of page) rows.push(_emailHeader(dbs[i].key, r));
            want -= page.length;
            skip = 0;
        }
        return { total, offset, limit, rows };
    });
}

/** Full e-mail (bodies included) by store key + seq, or by message id. */
function getEmail(storeDir, { key, seq, id } = {}) {
    return _withDbs(storeDir, [key], (dbs) => {
        if (!dbs.length) return null;
        const db = dbs[0].db;
        const r = (seq != null)
            ? db.prepare('SELECT * FROM emails WHERE seq = ?').get(Number(seq))
            : db.prepare('SELECT * FROM emails WHERE msg_id = ?').get(String(id));
        if (!r) return null;
        let attachments = [];
        try { attachments = JSON.parse(r.attachments || '[]'); } catch (_) {}
        return {
            key, seq: r.seq, id: r.msg_id,
            from: r.from_ || '', to: r.to_ || '', cc: r.cc || '',
            subject: r.subject || '', date: r.date || '', labels: r.labels || '', threadId: r.thread_id || '',
            attachments, textBody: r.text_body || '', htmlBody: r.html_body || '',
            rawSize: r.raw_size, truncated: !!r.truncated,
        };
    });
}

function _locRow(r) {
    let activity = r.activity;
    if (activity && /^[[{]/.test(activity)) { try { activity = JSON.parse(activity); } catch (_) {} }
    return {
        timestamp: r.ts, lat: r.lat, lng: r.lng, accuracy: r.accuracy, altitude: r.altitude,
        velocity: r.velocity, heading: r.heading, source: r.source, deviceTag: r.device_tag, activity,
    };
}

/**
 * Location points.  { offset, limit } pages in file order; { sample: N }
 * returns about N evenly spaced points for the map (with lat/lng only).
 */
function readLocations(storeDir, { keys, offset = 0, limit = 500, sample = 0 } = {}) {
    return _withDbs(storeDir, keys, (dbs) => {
        const counts = dbs.map(({ db }) => db.prepare('SELECT COUNT(*) AS n FROM locations').get().n);
        const total = counts.reduce((a, b) => a + b, 0);
        const rows = [];
        sample = Math.max(0, Math.min(200000, Number(sample) || 0));
        if (sample) {
            const step = Math.max(1, Math.ceil(total / sample));
            for (const { db } of dbs) {
                const page = db.prepare(`SELECT * FROM locations WHERE lat IS NOT NULL AND lng IS NOT NULL AND (seq - 1) % ? = 0 ORDER BY seq`).all(step);
                for (const r of page) rows.push(_locRow(r));
            }
            return { total, sampled: true, step, rows };
        }
        offset = Math.max(0, Number(offset) || 0);
        limit = Math.min(5000, Math.max(1, Number(limit) || 500));
        let skip = offset;
        let want = limit;
        for (let i = 0; i < dbs.length && want > 0; i++) {
            if (skip >= counts[i]) { skip -= counts[i]; continue; }
            const page = dbs[i].db.prepare('SELECT * FROM locations ORDER BY seq LIMIT ? OFFSET ?').all(want, skip);
            for (const r of page) rows.push(_locRow(r));
            want -= page.length;
            skip = 0;
        }
        return { total, offset, limit, rows };
    });
}

function storeStats(storeDir, keys) {
    return _withDbs(storeDir, keys, (dbs) => {
        let emailCount = 0, locationCount = 0;
        for (const { db } of dbs) {
            emailCount += db.prepare('SELECT COUNT(*) AS n FROM emails').get().n;
            locationCount += db.prepare('SELECT COUNT(*) AS n FROM locations').get().n;
        }
        return { stores: dbs.length, emailCount, locationCount };
    });
}

function deleteStores(storeDir, keys) {
    let deleted = 0;
    for (const key of (Array.isArray(keys) ? keys : [])) {
        if (!isValidKey(key)) continue;
        const f = dbFileFor(storeDir, key);
        if (fs.existsSync(f)) deleted++;
        _unlinkDb(f);
        _unlinkDb(f + '.importing');
        _removeOverflow(storeDir, key);
        _removeOverflow(storeDir, key + '.importing');
    }
    return deleted;
}

/**
 * Drive files come from the suspect's account. "Open" hands a file to its
 * Windows default program, so only document / media types are allowed —
 * never .exe, .bat, .lnk, .js, .html, macro-enabled Office files, etc.
 * (Mirrored as OPENABLE_RE in google-warrant-ui.js; a test keeps them equal.)
 */
const OPENABLE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'heic', 'tif', 'tiff',
    'mp4', 'mov', 'avi', 'mkv', 'webm', '3gp', 'm4v', 'wmv',
    'mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'wma',
    'pdf', 'txt', 'csv', 'rtf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'json', 'xml', 'log'];
function canOpenDirectly(fileName) {
    const m = /\.([a-z0-9]+)$/i.exec(String(fileName || ''));
    return !!m && OPENABLE_EXT.includes(m[1].toLowerCase());
}

module.exports = {
    PREVIEW_EMAILS, PREVIEW_LOCATIONS, OPENABLE_EXT,
    storeKeyFor, isValidKey, dbFileFor,
    openWriter, attachToResult, previewOf,
    readEmailPage, getEmail, readLocations, storeStats, deleteStores,
    canOpenDirectly,
};

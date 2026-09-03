/**
 * SQLite-backed on-disk store for parsed Discord warrant returns.
 * Main-process only (requires `better-sqlite3`, `fs`, `path`).
 *
 * ── Why this replaces JSON shards ─────────────────────────────────────
 * Measured on the reference law-enforcement return (155 files / 384 MB /
 * 541,831 messages across 101 channels):
 *
 *     parse                -> ~500 MB of V8 heap in the MAIN process
 *     structuredClone (IPC)  -> a second ~500 MB heap in the RENDERER
 *     JSON.stringify         -> a 134 MB string
 *     localStorage.setItem   -> QuotaExceededError (cap ~5 MB)
 *
 * 5.1.7 fixed that by writing one JSON file per channel.  A new real
 * return arrived: 2.36 GB, ~5.85 million messages, and a single channel
 * with ~2.4 million messages (~355 MB of CSV).  One channel no longer fits
 * in a JS string (V8 caps strings near 512 MB), let alone in the renderer.
 *
 * This module replaces per-channel JSON shards with an incrementally-written
 * SQLite database.  Messages are inserted while the CSVs are streamed, and
 * the renderer reads small pages over the same IPC channel.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { storeKeyFor } = require('./discord-warrant-store');

const DB_SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS messages (
  seq        INTEGER PRIMARY KEY,
  channel_id TEXT NOT NULL,
  ord        INTEGER NOT NULL,
  mid        TEXT,
  ts         TEXT,
  raw_ts     TEXT,
  contents   TEXT,
  attachments TEXT,
  author_id  TEXT,
  username   TEXT,
  direction  TEXT,
  media      TEXT
);
CREATE TABLE IF NOT EXISTS channels (
  channel_id TEXT PRIMARY KEY,
  seq_start  INTEGER NOT NULL,
  count      INTEGER NOT NULL,
  sorted_asc INTEGER NOT NULL,
  first_ts   TEXT,
  last_ts    TEXT
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
`;

function dbPath(baseDir, storeKey) {
    const safeKey = String(storeKey).replace(/[^A-Za-z0-9]/g, '');
    return path.join(baseDir, 'store', safeKey, 'messages.db');
}

function dbDir(baseDir, storeKey) {
    const safeKey = String(storeKey).replace(/[^A-Za-z0-9]/g, '');
    return path.join(baseDir, 'store', safeKey);
}

function ensureDir(p) {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

// ── Module-level read cache (at most ONE handle) ───────────────────────
let _cachedDbPath = null;
let _cachedDb = null;

function _closeCache() {
    if (_cachedDb) {
        try { _cachedDb.close(); } catch (_) {}
        _cachedDb = null;
        _cachedDbPath = null;
    }
}

function _openReadonly(dbFile) {
    if (_cachedDbPath === dbFile && _cachedDb) {
        return _cachedDb;
    }
    _closeCache();
    if (!fs.existsSync(dbFile)) return null;
    const db = new Database(dbFile, { readonly: true, fileMustExist: true });
    // Readers serve 100-row pages.  Cap the page cache so a long-lived
    // reader on a 400 MB store does not quietly hold tens of MB.
    try { db.pragma('cache_size = -8192'); } catch (_) {}
    _cachedDb = db;
    _cachedDbPath = dbFile;
    return db;
}

function _isComplete(db) {
    try {
        const row = db.prepare("SELECT v FROM meta WHERE k = 'complete'").get();
        return row && row.v === '1';
    } catch (_) {
        return false;
    }
}

// ── MessageWriter ────────────────────────────────────────────────────

const BATCH_SIZE = 20000;
const MAX_ERRORS = 50;

class MessageWriter {
    constructor(baseDir, storeKey) {
        this.baseDir = baseDir;
        this.storeKey = storeKey;
        this.dir = dbDir(baseDir, storeKey);
        this.dbFile = dbPath(baseDir, storeKey);
        this.errors = [];

        // Delete any pre-existing DB files so a re-import fully replaces.
        for (const ext of ['', '-wal', '-shm']) {
            const f = this.dbFile + ext;
            if (fs.existsSync(f)) {
                try { fs.unlinkSync(f); } catch (_) {}
            }
        }

        ensureDir(this.dir);
        this.db = new Database(this.dbFile);
        this.db.exec(SCHEMA_SQL);

        // Speed pragmas for bulk import.  An aborted import is discarded
        // wholesale (the completion flag guards readers), so durability
        // during the write phase is unnecessary.
        //
        // cache_size is deliberately modest.  Inserts are append-only and
        // strictly sequential, so a large page cache buys nothing — but it
        // DOES get charged to RSS, and this import runs inside the same
        // process as the rest of the app.  A 1 GB cache measured 477 MB of
        // peak RSS on a 2.4M-row channel; 64 MB measures far less for the
        // same throughput.
        this.db.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = OFF;
            PRAGMA temp_store = MEMORY;
            PRAGMA cache_size = -65536;
        `);

        this._inChannel = false;
        this._channelId = null;
        this._seqStart = null;
        this._ord = 0;
        this._count = 0;
        this._firstTs = null;
        this._lastTs = null;
        this._sortedAsc = 1;
        this._prevTs = null;
        this._insertStmt = this.db.prepare(`
            INSERT INTO messages (channel_id, ord, mid, ts, raw_ts, contents,
                attachments, author_id, username, direction, media)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        this._insertChannelStmt = this.db.prepare(`
            INSERT INTO channels (channel_id, seq_start, count, sorted_asc, first_ts, last_ts)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(channel_id) DO UPDATE SET
                seq_start=excluded.seq_start,
                count=excluded.count,
                sorted_asc=excluded.sorted_asc,
                first_ts=excluded.first_ts,
                last_ts=excluded.last_ts
        `);
        this._insertMetaStmt = this.db.prepare(`
            INSERT INTO meta (k, v) VALUES (?, ?)
            ON CONFLICT(k) DO UPDATE SET v=excluded.v
        `);
    }

    beginChannel(channelId) {
        if (this._inChannel) throw new Error('MessageWriter: already in a channel');
        this._inChannel = true;
        this._channelId = String(channelId == null ? 'unknown' : channelId);
        this._seqStart = this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 FROM messages").pluck().get();
        this._ord = 0;
        this._count = 0;
        this._firstTs = null;
        this._lastTs = null;
        this._sortedAsc = 1;
        this._prevTs = null;
        this.db.exec('BEGIN');
    }

    write(msg) {
        if (!this._inChannel) throw new Error('MessageWriter: no channel open');
        let mediaJson = null;
        try {
            if (Array.isArray(msg.media) && msg.media.length) {
                mediaJson = JSON.stringify(msg.media);
            }
            this._insertStmt.run(
                this._channelId,
                this._ord,
                msg.id == null ? null : String(msg.id),
                msg.timestamp == null ? null : String(msg.timestamp),
                msg.rawTimestamp == null ? null : String(msg.rawTimestamp),
                msg.contents == null ? null : String(msg.contents),
                msg.attachments == null ? null : String(msg.attachments),
                msg.authorId == null ? null : String(msg.authorId),
                msg.username == null ? null : String(msg.username),
                msg.direction === 'outgoing' || msg.direction === 'incoming'
                    ? msg.direction
                    : null,
                mediaJson
            );
        } catch (err) {
            if (this.errors.length < MAX_ERRORS) {
                this.errors.push({ channelId: this._channelId, ord: this._ord, error: err.message });
            }
            this._ord++;
            return;
        }

        // Track timestamp ordering for the channel.
        const ts = msg.timestamp == null ? null : String(msg.timestamp);
        if (ts != null) {
            if (this._firstTs == null) this._firstTs = ts;
            this._lastTs = ts;
            if (this._sortedAsc && this._prevTs != null && ts < this._prevTs) {
                this._sortedAsc = 0;
            }
            this._prevTs = ts;
        }

        this._ord++;
        this._count++;

        if (this._count % BATCH_SIZE === 0) {
            this.db.exec('COMMIT');
            this.db.exec('BEGIN');
        }
    }

    endChannel() {
        if (!this._inChannel) throw new Error('MessageWriter: no channel open');
        this.db.exec('COMMIT');

        const lastSeq = this.db.prepare("SELECT COALESCE(MAX(seq), 0) FROM messages").pluck().get();
        const expectedCount = lastSeq - this._seqStart + 1;
        if (this._count !== expectedCount) {
            throw new Error(
                `MessageWriter: channel ${this._channelId} count mismatch: ` +
                `count=${this._count}, expected=${expectedCount} (seq ${this._seqStart}..${lastSeq})`
            );
        }

        this._insertChannelStmt.run(
            this._channelId,
            this._seqStart,
            this._count,
            this._sortedAsc,
            this._firstTs,
            this._lastTs
        );

        const result = {
            channelId: this._channelId,
            count: this._count,
            firstTs: this._firstTs,
            lastTs: this._lastTs,
            sortedAsc: this._sortedAsc === 1,
            seqStart: this._seqStart
        };

        this._inChannel = false;
        this._channelId = null;
        this._seqStart = null;
        this._ord = 0;
        this._count = 0;
        this._firstTs = null;
        this._lastTs = null;
        this._sortedAsc = 1;
        this._prevTs = null;

        return result;
    }

    finish(meta) {
        if (this._inChannel) throw new Error('MessageWriter: channel still open');

        const needsTsIndex = this.db.prepare(
            "SELECT 1 FROM channels WHERE sorted_asc = 0 LIMIT 1"
        ).get();
        if (needsTsIndex) {
            this.db.exec("CREATE INDEX IF NOT EXISTS idx_msg_channel_ts ON messages(channel_id, ts)");
        }

        const now = new Date().toISOString();
        this._insertMetaStmt.run('schema_version', String(DB_SCHEMA_VERSION));
        this._insertMetaStmt.run('created_at', now);
        this._insertMetaStmt.run('complete', '1');
        for (const [k, v] of Object.entries(meta || {})) {
            this._insertMetaStmt.run(k, v == null ? null : String(v));
        }

        this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        this.db.exec("PRAGMA synchronous = FULL");

        const stats = this.db.prepare(
            "SELECT COUNT(*) AS messageCount, COUNT(DISTINCT channel_id) AS channelCount FROM messages"
        ).get();
        const dbBytes = fs.existsSync(this.dbFile) ? fs.statSync(this.dbFile).size : 0;

        this.db.close();
        this.db = null;

        return {
            messageCount: stats.messageCount,
            channelCount: stats.channelCount,
            dbBytes
        };
    }

    abort() {
        try {
            if (this.db) {
                if (this._inChannel) {
                    try { this.db.exec('ROLLBACK'); } catch (_) {}
                }
                this.db.close();
                this.db = null;
            }
        } catch (_) {}
        for (const ext of ['', '-wal', '-shm']) {
            const f = this.dbFile + ext;
            if (fs.existsSync(f)) {
                try { fs.unlinkSync(f); } catch (_) {}
            }
        }
    }
}

// ── Read helpers ─────────────────────────────────────────────────────

function storeInfo(baseDir, storeKey) {
    const dbFile = dbPath(baseDir, storeKey);
    if (!fs.existsSync(dbFile)) {
        return { exists: false, complete: false, version: null, channelCount: 0, messageCount: 0 };
    }
    let db;
    try {
        db = new Database(dbFile, { readonly: true, fileMustExist: true });
    } catch (_) {
        return { exists: true, complete: false, version: null, channelCount: 0, messageCount: 0 };
    }
    try {
        const complete = _isComplete(db);
        const version = db.prepare("SELECT v FROM meta WHERE k = 'schema_version'").pluck().get() || null;
        const stats = db.prepare(
            "SELECT COUNT(*) AS messageCount, COUNT(DISTINCT channel_id) AS channelCount FROM messages"
        ).get();
        return {
            exists: true,
            complete,
            version,
            channelCount: stats.channelCount,
            messageCount: stats.messageCount
        };
    } catch (_) {
        return { exists: true, complete: false, version: null, channelCount: 0, messageCount: 0 };
    } finally {
        try { db.close(); } catch (_) {}
    }
}

function channelInfo(baseDir, storeKey, channelId) {
    const dbFile = dbPath(baseDir, storeKey);
    const db = _openReadonly(dbFile);
    if (!db || !_isComplete(db)) return null;
    try {
        const row = db.prepare("SELECT * FROM channels WHERE channel_id = ?").get(String(channelId));
        if (!row) return null;
        return {
            channelId: row.channel_id,
            seqStart: row.seq_start,
            count: row.count,
            sortedAsc: row.sorted_asc === 1,
            firstTs: row.first_ts,
            lastTs: row.last_ts
        };
    } catch (_) {
        return null;
    }
}

function _hydrate(row) {
    const msg = {
        id: row.mid,
        timestamp: row.ts,
        rawTimestamp: row.raw_ts,
        contents: row.contents,
        attachments: row.attachments,
        authorId: row.author_id,
        username: row.username,
        direction: row.direction
    };
    if (row.media != null) {
        try {
            msg.media = JSON.parse(row.media);
        } catch (_) {
            msg.media = [];
        }
    }
    // Omit media key entirely when absent, matching today's behaviour.
    return msg;
}

/**
 * Read a page of messages for a channel.
 *
 * When the channel's `sorted_asc` is true (file order is already chronological),
 * rows are served in `ord` order via the primary-key range scan.
 * When `sorted_asc` is false, rows are served in `ts` order (nulls last,
 * tie-broken by `ord`) using the conditional index.
 */
function readPage(baseDir, storeKey, channelId, offset, limit) {
    const dbFile = dbPath(baseDir, storeKey);
    const db = _openReadonly(dbFile);
    if (!db || !_isComplete(db)) return { messages: [], total: 0, offset, limit };

    const ch = db.prepare("SELECT * FROM channels WHERE channel_id = ?").get(String(channelId));
    if (!ch) return { messages: [], total: 0, offset, limit };

    const total = ch.count;
    if (offset < 0 || offset >= total || limit <= 0) return { messages: [], total, offset, limit };

    let rows;
    if (ch.sorted_asc) {
        // Primary-key range scan: O(log n) seek, O(limit) read.
        rows = db.prepare(
            `SELECT * FROM messages
             WHERE seq >= ? AND seq < ?
             ORDER BY seq
             LIMIT ?`
        ).all(ch.seq_start + offset, ch.seq_start + total, limit);
    } else {
        // Chronological order via the conditional index.
        rows = db.prepare(
            `SELECT * FROM messages
             WHERE channel_id = ?
             ORDER BY ts IS NULL, ts, ord
             LIMIT ? OFFSET ?`
        ).all(String(channelId), limit, offset);
    }

    const messages = rows.map(_hydrate);
    return { messages, total, offset, limit };
}

/**
 * Convenience for small channels.  Refuses over `cap` (default 50,000)
 * by throwing, so callers do not accidentally materialise millions of rows.
 */
function readAll(baseDir, storeKey, channelId, cap = 50000) {
    const dbFile = dbPath(baseDir, storeKey);
    const db = _openReadonly(dbFile);
    if (!db || !_isComplete(db)) return [];

    const ch = db.prepare("SELECT count FROM channels WHERE channel_id = ?").pluck().get(String(channelId));
    if (ch == null) return [];
    if (ch > cap) {
        throw new Error(
            `readAll: channel ${channelId} has ${ch} messages, exceeds cap ${cap}. Use readPage.`
        );
    }

    const rows = db.prepare(
        `SELECT * FROM messages
         WHERE channel_id = ?
         ORDER BY seq`
    ).all(String(channelId));
    return rows.map(_hydrate);
}

/**
 * Case-insensitive substring search within a single channel.
 * Returns at most `cap` matches (default 500), each carrying its `ord`
 * so the UI can jump to the containing page.
 */
function searchChannel(baseDir, storeKey, channelId, query, cap = 500) {
    const dbFile = dbPath(baseDir, storeKey);
    const db = _openReadonly(dbFile);
    if (!db || !_isComplete(db)) return { matches: [], truncated: false, scanned: 0 };

    const ch = db.prepare("SELECT * FROM channels WHERE channel_id = ?").get(String(channelId));
    if (!ch) return { matches: [], truncated: false, scanned: 0 };

    // LIKE wildcards in evidence text are literal, not operators.
    const q = '%' + String(query).replace(/[\\%_]/g, '\\$&') + '%';
    const rows = db.prepare(
        `SELECT ord, mid, ts, raw_ts, contents, attachments, author_id, username, direction, media
         FROM messages
         WHERE channel_id = ? AND (contents LIKE ? ESCAPE '\\' OR username LIKE ? ESCAPE '\\')
         ORDER BY seq
         LIMIT ?`
    ).all(String(channelId), q, q, cap + 1);

    const truncated = rows.length > cap;
    const sliced = truncated ? rows.slice(0, cap) : rows;
    const matches = sliced.map(r => ({ ord: r.ord, ..._hydrate(r) }));
    return { matches, truncated, scanned: ch.count };
}

function findMessage(baseDir, storeKey, channelId, messageId) {
    const dbFile = dbPath(baseDir, storeKey);
    const db = _openReadonly(dbFile);
    if (!db || !_isComplete(db)) return null;

    const row = db.prepare(
        `SELECT ord, mid, ts, raw_ts, contents, attachments, author_id, username, direction, media
         FROM messages
         WHERE channel_id = ? AND mid = ?`
    ).get(String(channelId), String(messageId));
    if (!row) return null;
    return { ord: row.ord, ..._hydrate(row) };
}

function deleteStore(baseDir, storeKey) {
    _closeCache();
    const dir = dbDir(baseDir, storeKey);
    if (fs.existsSync(dir)) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch (_) {
            // Windows may hold locks briefly; retry once.
            try {
                fs.rmSync(dir, { recursive: true, force: true });
            } catch (_) {}
        }
    }
    return true;
}

// ── Legacy shard migration ───────────────────────────────────────────

function migrateLegacyShards(baseDir, storeKey) {
    const dbFile = dbPath(baseDir, storeKey);
    if (fs.existsSync(dbFile)) {
        return { migrated: false, channels: 0, messages: 0 };
    }

    const dir = dbDir(baseDir, storeKey);
    if (!fs.existsSync(dir)) {
        return { migrated: false, channels: 0, messages: 0 };
    }

    const files = fs.readdirSync(dir).filter(f => f.startsWith('ch-') && f.endsWith('.json'));
    if (!files.length) {
        return { migrated: false, channels: 0, messages: 0 };
    }

    const writer = new MessageWriter(baseDir, storeKey);
    let channels = 0;
    let messages = 0;

    try {
        for (const file of files) {
            const raw = fs.readFileSync(path.join(dir, file), 'utf8');
            const arr = JSON.parse(raw);
            if (!Array.isArray(arr) || !arr.length) continue;

            // Derive channel id from filename: ch-<id>.json
            const channelId = file.slice(3, -5);
            writer.beginChannel(channelId);
            for (const msg of arr) {
                writer.write(msg);
            }
            const info = writer.endChannel();
            channels++;
            messages += info.count;
        }

        writer.finish({ migrated_from: 'json_shards', migrated_at: new Date().toISOString() });

        // Only delete legacy files once the DB is safely committed.
        for (const file of files) {
            try { fs.unlinkSync(path.join(dir, file)); } catch (_) {}
        }

        return { migrated: true, channels, messages };
    } catch (err) {
        writer.abort();
        return { migrated: false, channels: 0, messages: 0 };
    }
}

module.exports = {
    DB_SCHEMA_VERSION,
    dbPath,
    MessageWriter,
    storeInfo,
    channelInfo,
    readPage,
    readAll,
    searchChannel,
    findMessage,
    deleteStore,
    migrateLegacyShards
};

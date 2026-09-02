/**
 * On-disk store for parsed Discord warrant returns.  Main-process only
 * (requires `fs`), but deliberately free of any Electron import so it can be
 * exercised headlessly.
 *
 * ── Why this exists ────────────────────────────────────────────────────
 * Measured on the reference law-enforcement return (155 files / 384 MB /
 * 541,831 messages across 101 channels):
 *
 *     parse                -> ~500 MB of V8 heap in the MAIN process
 *     structuredClone      -> a second ~500 MB heap in the RENDERER (IPC)
 *     JSON.stringify       -> a 134 MB string
 *     localStorage.setItem -> QuotaExceededError (the cap is ~5 MB)
 *
 * Doing all of that while the case-detail page and its maps are already
 * resident is what produced "App crashes when uploading Discord warrant".
 *
 * So past LAZY_MESSAGE_THRESHOLD messages the bodies never cross the IPC
 * boundary: main writes one shard per channel, blanks the in-memory arrays,
 * and the renderer receives an index it can hold comfortably.  It then pulls
 * a single channel on demand and caches exactly one at a time.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Below this, everything stays inline — small imports keep the old, simpler
// behaviour and there is no second code path to get wrong.
const LAZY_MESSAGE_THRESHOLD = 25000;

function storeKeyFor(filePath) {
    return crypto.createHash('sha1').update(String(filePath || '')).digest('hex').slice(0, 16);
}

/** Never trust an identifier that came out of evidence as a path segment. */
function shardFileName(channelId) {
    const safe = String(channelId == null || channelId === '' ? 'unknown' : channelId)
        .replace(/[^A-Za-z0-9_.-]/g, '_')
        .slice(0, 64);
    return 'ch-' + safe + '.json';
}

function shardDir(baseDir, key) {
    if (!baseDir || !key) return null;
    return path.join(baseDir, 'store', String(key).replace(/[^A-Za-z0-9]/g, ''));
}

/**
 * Move each channel's messages out of `data` and onto disk.
 *
 * Mutates `data`: every channel keeps its metadata and `messageCount` but gets
 * `messages: []` and `_sharded: true`.  A channel whose shard fails to write
 * keeps its messages inline rather than losing them.
 *
 * @returns {{dir:string, written:number, failed:string[]}}
 */
function shardChannels(data, baseDir, key) {
    const dir = shardDir(baseDir, key);
    if (!dir) throw new Error('shardChannels: no base directory or store key');

    // A re-import of the same file must not leave stale shards behind.
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    fs.mkdirSync(dir, { recursive: true });

    const failed = [];
    let written = 0;
    for (const ch of (data.channels || [])) {
        const msgs = Array.isArray(ch.messages) ? ch.messages : [];
        try {
            const file = path.join(dir, shardFileName(ch.channelId));
            const tmp = file + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(msgs), 'utf8');
            fs.renameSync(tmp, file);
        } catch (err) {
            failed.push(String(ch.channelId));
            continue;   // leave ch.messages intact
        }
        // Only drop the bodies once the shard is safely on disk.
        ch.messages = [];
        ch._sharded = true;
        written++;
    }

    data._lazy = true;
    data._storeKey = key;
    if (failed.length) data._shardFailures = failed;
    return { dir, written, failed };
}

/** @returns {Array} the messages for one channel, or [] if the shard is gone. */
function readChannel(baseDir, key, channelId) {
    const dir = shardDir(baseDir, key);
    if (!dir) return null;
    const file = path.join(dir, shardFileName(channelId));
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
}

function deleteStore(baseDir, key) {
    const dir = shardDir(baseDir, key);
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    return true;
}

/** Atomic write of the light index. A truncated index would cost the return. */
function saveIndex(baseDir, payload) {
    if (!baseDir) throw new Error('saveIndex: no base directory');
    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
    const file = path.join(baseDir, 'imports.json');
    const json = JSON.stringify(payload || { imports: [] });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, json, 'utf8');
    fs.renameSync(tmp, file);
    return { file, bytes: Buffer.byteLength(json) };
}

function loadIndex(baseDir) {
    if (!baseDir) return null;
    const file = path.join(baseDir, 'imports.json');
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

module.exports = {
    LAZY_MESSAGE_THRESHOLD,
    storeKeyFor,
    shardFileName,
    shardDir,
    shardChannels,
    readChannel,
    deleteStore,
    saveIndex,
    loadIndex
};

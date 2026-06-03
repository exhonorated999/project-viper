/**
 * Cellebrite — Selective ZIP extraction
 * ─────────────────────────────────────────────────────────────────────────
 * Phase 1.2 — REAL implementation.
 *
 * Backed by modules/_shared/zip-reader.js which handles ZIP64 + streaming
 * from disk so the 48GB Pixel Fold dump never gets read into memory.
 *
 * Public surface:
 *   TARGET_FILES                  — declarative list of paths we care about
 *   matchTarget(entryPath)        — returns {kind, path} or null
 *   scanZipTargets(zipPath)       — walk central directory, NO extraction
 *   extractTargets(opts)          — selectively pull matched entries to disk
 *
 *   normalizeZipPath(p)           — internal helper exported for tests
 */

const fs = require('fs');
const path = require('path');
const { openZip } = require('../_shared/zip-reader');

// ─── Target list ────────────────────────────────────────────────────────
// Phase 1.2 ships: Device + Apps + Contacts → buildProp, contacts2 (+wal/shm).
// Other surfaces are still listed so Phase 1.3 picks them up automatically
// once the parsers land.
//
// IMPORTANT — wrapper prefixes:
//   Real Cellebrite zips wrap everything under a "Dump/" top-level segment
//   (per .ufd `ZIPLogicalPath=Dump`). We strip that wrapper in
//   normalizeZipPath() so the paths below remain AOSP-canonical.
//
// Each entry may declare `paths` (array of alternates) instead of a single
// `path` to handle Android-version drift (e.g. Wi-Fi store moved under
// apexdata/ in Android 13+; SMS DB lives in both data/data and data/user_de
// on modern Pixels).
const TARGET_FILES = [
    { kind: 'buildProp',     match: 'exact',  paths: ['system/build.prop'] },

    { kind: 'contacts2',     match: 'exact',  paths: ['data/data/com.android.providers.contacts/databases/contacts2.db'] },
    { kind: 'contacts2-wal', match: 'exact',  paths: ['data/data/com.android.providers.contacts/databases/contacts2.db-wal'] },
    { kind: 'contacts2-shm', match: 'exact',  paths: ['data/data/com.android.providers.contacts/databases/contacts2.db-shm'] },

    // Call log: lives in a separate calllog.db on Android 12+ (com.android.providers.contacts
    // owns BOTH contacts2.db and calllog.db). Legacy AOSP also had a `calls` table inside
    // contacts2.db itself, so parser falls back to contacts2.db when calllog.db is absent.
    { kind: 'calllog',       match: 'exact',  paths: ['data/data/com.android.providers.contacts/databases/calllog.db'] },
    { kind: 'calllog-wal',   match: 'exact',  paths: ['data/data/com.android.providers.contacts/databases/calllog.db-wal'] },
    { kind: 'calllog-shm',   match: 'exact',  paths: ['data/data/com.android.providers.contacts/databases/calllog.db-shm'] },

    // mmssms.db appears at BOTH data/data and data/user_de on modern Pixels.
    // Prefer data/user_de (newer, written more recently) — listed first.
    { kind: 'mmssms',        match: 'exact',  paths: [
        'data/user_de/0/com.android.providers.telephony/databases/mmssms.db',
        'data/data/com.android.providers.telephony/databases/mmssms.db',
    ] },
    { kind: 'mmssms-wal',    match: 'exact',  paths: [
        'data/user_de/0/com.android.providers.telephony/databases/mmssms.db-wal',
        'data/data/com.android.providers.telephony/databases/mmssms.db-wal',
    ] },
    { kind: 'mmssms-shm',    match: 'exact',  paths: [
        'data/user_de/0/com.android.providers.telephony/databases/mmssms.db-shm',
        'data/data/com.android.providers.telephony/databases/mmssms.db-shm',
    ] },

    // Google Messages — bugle_db (Pixel & stock Android). Holds SMS, MMS, AND RCS.
    // On modern Android the package lives in BOTH data/user_de and data/data; prefer user_de.
    { kind: 'bugle',         match: 'exact',  paths: [
        'data/user_de/0/com.google.android.apps.messaging/databases/bugle_db',
        'data/data/com.google.android.apps.messaging/databases/bugle_db',
    ] },
    { kind: 'bugle-wal',     match: 'exact',  paths: [
        'data/user_de/0/com.google.android.apps.messaging/databases/bugle_db-wal',
        'data/data/com.google.android.apps.messaging/databases/bugle_db-wal',
    ] },
    { kind: 'bugle-shm',     match: 'exact',  paths: [
        'data/user_de/0/com.google.android.apps.messaging/databases/bugle_db-shm',
        'data/data/com.google.android.apps.messaging/databases/bugle_db-shm',
    ] },

    { kind: 'accounts-ce',   match: 'exact',  paths: ['data/system_ce/0/accounts_ce.db'] },
    { kind: 'accounts-de',   match: 'exact',  paths: [
        'data/system_de/0/accounts_de.db',     // Android 13+
        'data/system/users/0/accounts.db',     // legacy
    ] },

    // Wi-Fi config store: under apexdata/ on Android 13+, under wifi/ on older.
    { kind: 'wifi-store',    match: 'exact',  paths: [
        'data/misc/apexdata/com.android.wifi/WifiConfigStore.xml',
        'data/misc_ce/0/apexdata/com.android.wifi/WifiConfigStore.xml',
        'data/misc/wifi/WifiConfigStore.xml',
    ] },
    { kind: 'wifi-soft',     match: 'exact',  paths: [
        'data/misc/apexdata/com.android.wifi/WifiConfigStoreSoftAp.xml',
        'data/misc/wifi/softap.conf',
    ] },

    { kind: 'mms-parts',     match: 'prefix', paths: [
        'data/user_de/0/com.android.providers.telephony/app_parts/',
        'data/data/com.android.providers.telephony/app_parts/',
    ] },
];

// Filename used inside extracted/ for each kind. For 'mms-parts' prefix
// matches we preserve the relative path under 'mms_parts/'.
const KIND_TO_DEST = {
    'buildProp':     'build.prop',
    'contacts2':     'contacts2.db',
    'contacts2-wal': 'contacts2.db-wal',
    'contacts2-shm': 'contacts2.db-shm',
    'calllog':       'calllog.db',
    'calllog-wal':   'calllog.db-wal',
    'calllog-shm':   'calllog.db-shm',
    'mmssms':        'mmssms.db',
    'mmssms-wal':    'mmssms.db-wal',
    'mmssms-shm':    'mmssms.db-shm',
    'bugle':         'bugle_db',
    'bugle-wal':     'bugle_db-wal',
    'bugle-shm':     'bugle_db-shm',
    'accounts-ce':   'accounts_ce.db',
    'accounts-de':   'accounts.db',
    'wifi-store':    'WifiConfigStore.xml',
    'wifi-soft':     'softap.conf',
    // 'mms-parts' → handled specially in destForEntry()
};

// Kinds that we always extract in Phase 1.2 (rest deferred to 1.3+).
const PHASE_1_2_KINDS = new Set([
    'buildProp',
    'contacts2', 'contacts2-wal', 'contacts2-shm',
    'calllog', 'calllog-wal', 'calllog-shm',
    // Phase 1.3 surfaces — we extract DBs eagerly so 1.3 only adds parsers,
    // no re-extraction needed. (Selective extract is cheap; SQLite reads
    // are the expensive part.)
    'mmssms', 'mmssms-wal', 'mmssms-shm',
    'bugle', 'bugle-wal', 'bugle-shm',
    'accounts-ce', 'accounts-de',
    'wifi-store', 'wifi-soft',
    // MMS parts deferred — those are binary blobs and Phase 1.2 doesn't
    // render SMS yet. Toggleable via opts.includeMmsParts.
]);

function normalizeZipPath(p) {
    let s = String(p || '').replace(/\\/g, '/').replace(/^\/+/, '');
    // Strip a single leading wrapper segment if it's a known Cellebrite root.
    // Real UFED bundles wrap everything under "Dump/" per .ufd ZIPLogicalPath.
    // Also tolerate uppercase variants and "ROOT/" seen in some older formats.
    const m = s.match(/^([^/]+)\/(.*)$/);
    if (m) {
        const seg = m[1].toLowerCase();
        if (seg === 'dump' || seg === 'root' || seg === 'physical' || seg === 'logical') {
            s = m[2];
        }
    }
    return s;
}

/**
 * Decide if a zip entry matches one of our targets. Returns {kind, path,
 * destSubpath, pathIndex} or null. destSubpath is relative to the extracted/
 * root. pathIndex is the position of the matched alternate in the kind's
 * `paths` array — lower = more preferred (used for dedup).
 */
function matchTarget(entryPath) {
    const norm = normalizeZipPath(entryPath);
    for (const t of TARGET_FILES) {
        const paths = t.paths || (t.path ? [t.path] : []);
        for (let i = 0; i < paths.length; i++) {
            const p = paths[i];
            if (t.match === 'exact' && norm === p) {
                return { kind: t.kind, path: norm, destSubpath: KIND_TO_DEST[t.kind], pathIndex: i };
            }
            if (t.match === 'prefix' && norm.startsWith(p) && !norm.endsWith('/')) {
                const rel = norm.slice(p.length);
                return { kind: t.kind, path: norm, destSubpath: path.join('mms_parts', rel), pathIndex: i };
            }
        }
    }
    return null;
}

/**
 * Walk a zip's central directory and report which targets are present.
 * Does NOT extract anything. Used by scan-bundle.
 *
 * Returns:
 *   {
 *     success: true,
 *     entryCount: 12345,
 *     targets: [{kind, path, size}],
 *     anyDataData: true,            // saw at least one /data/data/* entry
 *     dataDataPackages: ['com.android.chrome', ...],
 *     errors: []
 *   }
 */
async function scanZipTargets(zipPath, opts = {}) {
    const security = opts.security || null;
    let reader = null;
    try {
        reader = await openZip(zipPath, { security });
        const entries = reader.getEntries();
        // Per-kind best match (lowest pathIndex). Other matches recorded as alternates.
        const bestByKind = new Map(); // kind → {kind, path, destSubpath, size, pathIndex}
        const altsByKind = new Map(); // kind → [{path, size}, ...]
        const prefixHits = [];        // mms-parts entries (kept as-is)
        const pkgSet = new Set();
        let anyDataData = false;

        for (const e of entries) {
            const norm = normalizeZipPath(e.entryName || e._name);
            const m = matchTarget(norm);
            if (m) {
                const rec = { kind: m.kind, path: m.path, destSubpath: m.destSubpath, size: e.size || 0, pathIndex: m.pathIndex };
                if (m.kind === 'mms-parts') {
                    prefixHits.push(rec);
                } else {
                    const cur = bestByKind.get(m.kind);
                    if (!cur || m.pathIndex < cur.pathIndex) {
                        if (cur) {
                            const arr = altsByKind.get(m.kind) || [];
                            arr.push({ path: cur.path, size: cur.size });
                            altsByKind.set(m.kind, arr);
                        }
                        bestByKind.set(m.kind, rec);
                    } else {
                        const arr = altsByKind.get(m.kind) || [];
                        arr.push({ path: m.path, size: e.size || 0 });
                        altsByKind.set(m.kind, arr);
                    }
                }
            }
            // Detect /data/data/<pkg>/ packages for app cross-check.
            // Note: prefix is post-Dump/-strip (normalizeZipPath).
            if (norm.startsWith('data/data/')) {
                anyDataData = true;
                const rest = norm.slice('data/data/'.length);
                const slash = rest.indexOf('/');
                if (slash > 0) {
                    const pkg = rest.slice(0, slash);
                    if (pkg && !pkg.includes(' ')) pkgSet.add(pkg);
                }
            }
        }

        const targets = [...bestByKind.values()].map(t => {
            const alts = altsByKind.get(t.kind);
            return alts && alts.length ? { ...t, alternates: alts } : t;
        }).concat(prefixHits);

        return {
            success: true,
            entryCount: entries.length,
            targets,
            anyDataData,
            dataDataPackages: [...pkgSet].sort(),
            errors: [],
        };
    } catch (e) {
        return {
            success: false,
            entryCount: 0,
            targets: [],
            anyDataData: false,
            dataDataPackages: [],
            errors: [e.message || String(e)],
        };
    } finally {
        if (reader) { try { reader.close(); } catch (_) {} }
    }
}

/**
 * Selectively extract matched targets from `zipPath` into `outDir`.
 *
 * opts:
 *   zipPath:        absolute path to FileSystem NN/*.zip
 *   outDir:         absolute path where files land (typically extracted/)
 *   security:       optional VIPER security helper (for VIPENC'd zips)
 *   includeMmsParts: boolean (default false)
 *   onProgress:     fn({stage, current, total, label, entry}) → void
 *   isCancelled:    fn() → boolean — polled between entries
 *
 * Returns:
 *   {
 *     success: true,
 *     extracted: [{kind, srcPath, destPath, size}],
 *     skipped:   [{kind, path, reason}],
 *     errors:    [{kind, path, error}],
 *     cancelled: false
 *   }
 */
async function extractTargets(opts) {
    const {
        zipPath,
        outDir,
        security = null,
        includeMmsParts = false,
        onProgress = null,
        isCancelled = null,
    } = opts;

    if (!zipPath || !fs.existsSync(zipPath)) {
        return { success: false, extracted: [], skipped: [], errors: [{ kind: 'init', path: zipPath, error: 'zipPath does not exist' }], cancelled: false };
    }
    fs.mkdirSync(outDir, { recursive: true });

    let reader = null;
    const extracted = [];
    const skipped = [];
    const errors = [];
    let cancelled = false;

    try {
        reader = await openZip(zipPath, { security });
        const entries = reader.getEntries();

        // First pass: find matched targets we actually want.
        // For 'exact' targets, dedupe by kind — keep the entry with the
        // lowest pathIndex (most-preferred alternate) so the canonical
        // destSubpath isn't overwritten by a less-preferred copy.
        const bestByKind = new Map(); // kind → {entry, match, size}
        const queue = [];               // prefix-match (mms-parts) entries
        for (const e of entries) {
            const norm = normalizeZipPath(e.entryName || e._name);
            const m = matchTarget(norm);
            if (!m) continue;
            if (!PHASE_1_2_KINDS.has(m.kind) && !(includeMmsParts && m.kind === 'mms-parts')) {
                skipped.push({ kind: m.kind, path: norm, reason: 'phase-deferred' });
                continue;
            }
            if (m.kind === 'mms-parts') {
                queue.push({ entry: e, match: m, size: e.size || 0 });
                continue;
            }
            const cur = bestByKind.get(m.kind);
            if (!cur || m.pathIndex < cur.match.pathIndex) {
                if (cur) {
                    skipped.push({ kind: cur.match.kind, path: cur.match.path, reason: 'superseded-by-preferred-alternate' });
                }
                bestByKind.set(m.kind, { entry: e, match: m, size: e.size || 0 });
            } else {
                skipped.push({ kind: m.kind, path: norm, reason: 'superseded-by-preferred-alternate' });
            }
        }
        // Order: deduped exact-match targets first (deterministic by kind),
        // then prefix-match queue (mms-parts).
        const dedupedQueue = [...bestByKind.values(), ...queue];
        const total = dedupedQueue.length;
        if (onProgress) onProgress({ stage: 'extracting', current: 0, total, label: `${total} target file(s) found` });

        for (let i = 0; i < dedupedQueue.length; i++) {
            if (isCancelled && isCancelled()) { cancelled = true; break; }
            const { entry, match, size } = dedupedQueue[i];
            const destPath = path.join(outDir, match.destSubpath);
            try {
                fs.mkdirSync(path.dirname(destPath), { recursive: true });
                await reader.extractEntryToFile(entry, destPath);
                extracted.push({
                    kind: match.kind,
                    srcPath: match.path,
                    destPath,
                    size,
                });
                if (onProgress) {
                    onProgress({
                        stage: 'extracting',
                        current: i + 1,
                        total,
                        label: match.destSubpath,
                        entry: match.path,
                    });
                }
            } catch (e) {
                errors.push({ kind: match.kind, path: match.path, error: e.message || String(e) });
            }
        }

        return {
            success: !cancelled && errors.length === 0,
            extracted,
            skipped,
            errors,
            cancelled,
        };
    } catch (e) {
        return {
            success: false,
            extracted,
            skipped,
            errors: [{ kind: 'open', path: zipPath, error: e.message || String(e) }],
            cancelled,
        };
    } finally {
        if (reader) { try { reader.close(); } catch (_) {} }
    }
}

// ─── MEDIA INDEX (Phase 1.4 — additive, NEVER extracts to disk) ─────────
//
// We do NOT add media to TARGET_FILES because that would double disk usage
// for a 44 GB UFDR. Instead we walk the zip's central directory and record
// (zipPath, entryPath, size, mtime, crc32) for every media-shaped entry.
// Renderer reads bytes on demand via cellebrite-media-read IPC.
//
// Categorization is path-driven (cheap) — see categorizeByPath().

const MEDIA_PREFIXES = [
    // Primary user storage on modern Android (single-user UFDR)
    { category: 'camera',     prefix: 'data/media/0/DCIM/' },
    { category: 'screenshot', prefix: 'data/media/0/Pictures/Screenshots/' },
    { category: 'screenshot', prefix: 'data/media/0/DCIM/Screenshots/' },
    { category: 'picture',    prefix: 'data/media/0/Pictures/' },
    { category: 'movie',      prefix: 'data/media/0/Movies/' },
    { category: 'download',   prefix: 'data/media/0/Download/' },
    { category: 'recording',  prefix: 'data/media/0/Recordings/' },
    { category: 'recording',  prefix: 'data/media/0/Music/Recordings/' },
    { category: 'voice',      prefix: 'data/media/0/Audio/' },
    // Legacy paths (pre-scoped-storage)
    { category: 'camera',     prefix: 'storage/emulated/0/DCIM/' },
    { category: 'picture',    prefix: 'storage/emulated/0/Pictures/' },
    { category: 'movie',      prefix: 'storage/emulated/0/Movies/' },
    { category: 'download',   prefix: 'storage/emulated/0/Download/' },
];

// Extension → MIME and high-level type for routing in the UI.
const MEDIA_EXTS = {
    // images
    jpg:  { mime: 'image/jpeg',  type: 'image' },
    jpeg: { mime: 'image/jpeg',  type: 'image' },
    png:  { mime: 'image/png',   type: 'image' },
    webp: { mime: 'image/webp',  type: 'image' },
    gif:  { mime: 'image/gif',   type: 'image' },
    heic: { mime: 'image/heic',  type: 'image' },
    heif: { mime: 'image/heif',  type: 'image' },
    bmp:  { mime: 'image/bmp',   type: 'image' },
    // videos
    mp4:  { mime: 'video/mp4',          type: 'video' },
    m4v:  { mime: 'video/x-m4v',        type: 'video' },
    mov:  { mime: 'video/quicktime',    type: 'video' },
    '3gp':{ mime: 'video/3gpp',         type: 'video' },
    mkv:  { mime: 'video/x-matroska',   type: 'video' },
    webm: { mime: 'video/webm',         type: 'video' },
    avi:  { mime: 'video/x-msvideo',    type: 'video' },
    // audio
    mp3:  { mime: 'audio/mpeg',         type: 'audio' },
    m4a:  { mime: 'audio/mp4',          type: 'audio' },
    aac:  { mime: 'audio/aac',          type: 'audio' },
    wav:  { mime: 'audio/wav',          type: 'audio' },
    ogg:  { mime: 'audio/ogg',          type: 'audio' },
    amr:  { mime: 'audio/amr',          type: 'audio' },
    flac: { mime: 'audio/flac',         type: 'audio' },
    opus: { mime: 'audio/opus',         type: 'audio' },
};

function extOf(p) {
    const m = String(p || '').match(/\.([A-Za-z0-9]+)$/);
    return m ? m[1].toLowerCase() : '';
}

/**
 * Decide if an entry path is a media file we want to surface. Returns
 * {category, mime, type, ext, normPath} or null.
 *
 * Categorization is the longest-prefix match against MEDIA_PREFIXES so
 * "Pictures/Screenshots/" wins over plain "Pictures/".
 */
function matchMedia(entryPath) {
    const norm = normalizeZipPath(entryPath);
    if (!norm || norm.endsWith('/')) return null;
    const ext = extOf(norm);
    const mt = MEDIA_EXTS[ext];
    if (!mt) return null;

    let bestPrefixLen = -1;
    let bestCategory = null;
    for (const mp of MEDIA_PREFIXES) {
        if (norm.startsWith(mp.prefix) && mp.prefix.length > bestPrefixLen) {
            bestPrefixLen = mp.prefix.length;
            bestCategory = mp.category;
        }
    }
    if (!bestCategory) return null;
    return { category: bestCategory, mime: mt.mime, type: mt.type, ext, normPath: norm };
}

/**
 * Walk a zip's central directory and collect media entries WITHOUT
 * extracting. Cheap — read-only metadata. Returns:
 *   {
 *     success: true,
 *     count: 1234,
 *     totalBytes: 12345678,
 *     items: [{
 *       category, mime, type, ext,
 *       entryPath,    // canonical normalized path inside the inner zip
 *       rawEntryName, // EXACT zip entry name (preserves wrapper) — needed for re-open
 *       size,
 *       mtime,        // ms epoch (from zip mtime)
 *       crc32,
 *     }, ...],
 *     errors: []
 *   }
 *
 * Items are returned in central-directory order. Caller is responsible for
 * stable ordering / id assignment.
 */
async function indexMediaInZip(zipPath, opts = {}) {
    const security = opts.security || null;
    let reader = null;
    try {
        if (!zipPath || !fs.existsSync(zipPath)) {
            return { success: false, count: 0, totalBytes: 0, items: [], errors: [`zipPath does not exist: ${zipPath}`] };
        }
        reader = await openZip(zipPath, { security });
        const entries = reader.getEntries();
        const items = [];
        let totalBytes = 0;
        for (const e of entries) {
            const raw = e.entryName || e._name || '';
            const m = matchMedia(raw);
            if (!m) continue;
            const sz = e.size || 0;
            items.push({
                category: m.category,
                mime: m.mime,
                type: m.type,
                ext: m.ext,
                entryPath: m.normPath,
                rawEntryName: raw,
                size: sz,
                mtime: e.time ? new Date(e.time).getTime() : null,
                crc32: e.crc != null ? (e.crc >>> 0) : null,
            });
            totalBytes += sz;
        }
        return { success: true, count: items.length, totalBytes, items, errors: [] };
    } catch (e) {
        return { success: false, count: 0, totalBytes: 0, items: [], errors: [e.message || String(e)] };
    } finally {
        if (reader) { try { reader.close(); } catch (_) {} }
    }
}

module.exports = {
    TARGET_FILES,
    KIND_TO_DEST,
    PHASE_1_2_KINDS,
    matchTarget,
    scanZipTargets,
    extractTargets,
    normalizeZipPath,
    // Phase 1.4 — media
    MEDIA_PREFIXES,
    MEDIA_EXTS,
    matchMedia,
    indexMediaInZip,
};

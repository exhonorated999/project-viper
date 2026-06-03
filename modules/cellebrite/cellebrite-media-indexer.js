/**
 * Cellebrite — Media Indexer (Phase 1.4)
 * ─────────────────────────────────────────────────────────────────────────
 * Walks raw media hits produced by cellebrite-extractor.indexMediaInZip()
 * and produces the canonical media.json for the import.
 *
 * Design choices:
 *   - We DO NOT extract media to disk. Indexing only.
 *   - Renderer reads bytes on demand via cellebrite-media-read IPC.
 *   - EXIF is parsed for images ≤ EXIF_MAX_BYTES, best-effort.
 *   - Videos & audio: no metadata extraction in v1 (no native ffprobe dep).
 *
 * Output schema (parsed/media.json):
 *   {
 *     totalCount: int,
 *     totalBytes: int,
 *     byCategory: { camera: N, screenshot: N, ... },
 *     byType:     { image: N, video: N, audio: N },
 *     items: [{
 *       id:           string  — stable per import (sha1 of zip+entry)
 *       category:     string  — camera/screenshot/picture/movie/download/recording/voice
 *       type:         string  — image/video/audio
 *       mime:         string
 *       ext:          string
 *       filename:     string  — basename(entryPath)
 *       entryPath:    string  — normalized path inside zip
 *       rawEntryName: string  — exact zip entry name (needed for re-open)
 *       sourceZip:    string  — absolute path to the inner zip
 *       size:         int
 *       mtime:        int|null
 *       crc32:        int|null
 *       capturedAt:   string|null  — ISO from EXIF DateTimeOriginal (images only)
 *       gps:          {lat, lon}|null
 *       width:        int|null
 *       height:       int|null
 *     }, ...],
 *     errors: []
 *   }
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Optional: only loaded for EXIF on images
let exifr = null;
try { exifr = require('exifr'); } catch (_) { exifr = null; }

const { openZip } = require('../_shared/zip-reader');

const EXIF_MAX_BYTES = 25 * 1024 * 1024; // skip EXIF parse on images > 25 MB
const EXIF_PARSE_TIMEOUT_MS = 1500;

// Stable per-import id: short and collision-free across the items we surface.
function makeId(zipPath, entryPath) {
    const h = crypto.createHash('sha1').update(String(zipPath || '') + '\0' + String(entryPath || '')).digest('hex');
    return 'm_' + h.slice(0, 16);
}

function basename(p) {
    const s = String(p || '');
    const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * Parse EXIF from a small buffer, with a hard timeout.
 * Returns {capturedAt, gps, width, height} or {} on failure.
 */
async function readExifSafe(buf) {
    if (!exifr || !Buffer.isBuffer(buf) || buf.length === 0) return {};
    const promise = (async () => {
        // exifr.parse signature: parse(input, options?). Pass minimal options
        // to avoid pulling MakerNote / IFD1 / interop blocks.
        const opts = {
            tiff: true, ifd0: true, exif: true, gps: true,
            interop: false, ifd1: false, makerNote: false, userComment: false,
            translateKeys: true, translateValues: true,
            reviveValues: true, mergeOutput: true,
        };
        return await exifr.parse(buf, opts);
    })();
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), EXIF_PARSE_TIMEOUT_MS));
    let raw = null;
    try { raw = await Promise.race([promise, timeout]); } catch (_) { raw = null; }
    if (!raw) return {};

    const out = {};
    const dt = raw.DateTimeOriginal || raw.CreateDate || raw.DateTime || null;
    if (dt instanceof Date && !isNaN(dt.getTime())) {
        out.capturedAt = dt.toISOString();
    } else if (typeof dt === 'string' && dt.trim()) {
        const parsed = Date.parse(dt);
        if (!isNaN(parsed)) out.capturedAt = new Date(parsed).toISOString();
    }
    if (typeof raw.latitude === 'number' && typeof raw.longitude === 'number') {
        out.gps = { lat: raw.latitude, lon: raw.longitude };
    }
    if (typeof raw.ImageWidth  === 'number') out.width  = raw.ImageWidth;
    if (typeof raw.ExifImageWidth === 'number') out.width = raw.ExifImageWidth;
    if (typeof raw.ImageHeight === 'number') out.height = raw.ImageHeight;
    if (typeof raw.ExifImageHeight === 'number') out.height = raw.ExifImageHeight;
    return out;
}

/**
 * Build the canonical media.json from per-zip raw media hits.
 *
 * @param {Array<{zipPath: string, items: Array<RawHit>}>} perZipHits
 * @param {object} opts
 * @param {function|null} opts.onProgress — ({current, total, label}) => void
 * @param {function|null} opts.isCancelled — () => bool
 * @param {boolean} opts.parseExif — default true
 * @param {object|null} opts.security — VIPER security helper
 * @returns {Promise<MediaIndexResult>}
 */
async function buildMediaIndex(perZipHits, opts = {}) {
    const {
        onProgress = null,
        isCancelled = null,
        parseExif = true,
        security = null,
    } = opts;

    const items = [];
    const errors = [];
    const byCategory = Object.create(null);
    const byType = Object.create(null);
    let totalBytes = 0;
    let totalCount = 0;
    for (const z of perZipHits || []) totalCount += (z.items?.length || 0);

    let processed = 0;
    let cancelled = false;

    for (const zipBucket of (perZipHits || [])) {
        if (cancelled) break;
        const { zipPath, items: hits } = zipBucket;
        if (!Array.isArray(hits) || hits.length === 0) continue;

        // Open the zip ONCE per bucket so we can stream EXIF buffers cheaply.
        let reader = null;
        try {
            if (parseExif && exifr) {
                reader = await openZip(zipPath, { security });
            }
        } catch (e) {
            errors.push({ stage: 'open-zip', zipPath, error: e.message || String(e) });
            reader = null;
        }

        for (const hit of hits) {
            if (isCancelled && isCancelled()) { cancelled = true; break; }

            const item = {
                id: makeId(zipPath, hit.entryPath),
                category: hit.category,
                type: hit.type,
                mime: hit.mime,
                ext: hit.ext,
                filename: basename(hit.entryPath),
                entryPath: hit.entryPath,
                rawEntryName: hit.rawEntryName,
                sourceZip: zipPath,
                size: hit.size || 0,
                mtime: hit.mtime || null,
                crc32: hit.crc32 || null,
                capturedAt: null,
                gps: null,
                width: null,
                height: null,
            };

            // EXIF for images only, bounded by size + presence of exifr.
            if (parseExif && reader && hit.type === 'image' && hit.size > 0 && hit.size <= EXIF_MAX_BYTES) {
                try {
                    const buf = reader._zip
                        ? reader._zip.entryDataSync(hit.rawEntryName)
                        : null;
                    if (Buffer.isBuffer(buf)) {
                        const meta = await readExifSafe(buf);
                        if (meta.capturedAt) item.capturedAt = meta.capturedAt;
                        if (meta.gps)        item.gps        = meta.gps;
                        if (meta.width)      item.width      = meta.width;
                        if (meta.height)     item.height     = meta.height;
                    }
                } catch (e) {
                    // single-item EXIF failure is non-fatal
                    errors.push({ stage: 'exif', entryPath: hit.entryPath, error: e.message || String(e) });
                }
            }

            items.push(item);
            byCategory[item.category] = (byCategory[item.category] || 0) + 1;
            byType[item.type]         = (byType[item.type]         || 0) + 1;
            totalBytes += item.size;
            processed += 1;

            if (onProgress && (processed % 25 === 0 || processed === totalCount)) {
                onProgress({ current: processed, total: totalCount, label: item.filename });
            }
        }

        if (reader) { try { reader.close(); } catch (_) {} }
    }

    return {
        totalCount: items.length,
        totalBytes,
        byCategory,
        byType,
        items,
        errors,
        cancelled,
    };
}

/**
 * Convenience: write the index to parsed/media.json.
 * Caller is responsible for Field Security wrapping; we just stringify.
 */
function writeMediaJson(parsedDir, indexResult) {
    fs.mkdirSync(parsedDir, { recursive: true });
    const outPath = path.join(parsedDir, 'media.json');
    fs.writeFileSync(outPath, JSON.stringify(indexResult, null, 2), 'utf-8');
    return outPath;
}

module.exports = {
    buildMediaIndex,
    writeMediaJson,
    // exposed for tests
    _internals: { makeId, basename, readExifSafe, EXIF_MAX_BYTES, EXIF_PARSE_TIMEOUT_MS },
};

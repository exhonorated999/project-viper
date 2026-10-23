/**
 * Evidence tab file viewer — main process only.
 *
 * The Evidence tab used to read EVERY viewable file of an evidence item into
 * the renderer (as a number[] over IPC, then a Blob) before showing anything.
 * A 6,000-photo folder meant tens of GB in the window and a crash. Now the
 * renderer asks for one file at a time, only when its card is on screen:
 *
 *   mediaUrl()  plain file  → a streaming viper-media:// URL (no bytes copied)
 *               encrypted   → decrypted bytes (one file, as a Buffer)
 *               pdf / html  → bytes (they preview from a Blob, as before)
 *   thumb()     image       → a small JPEG data URL made here, so the grid
 *                             never decodes thousands of full-size photos.
 *               video       → one frame, via o.videoThumb (video-playback.js).
 *
 * Thumbnails are made in memory with nativeImage — NOT the Windows shell
 * thumbnailer, which would write evidence thumbnails into Explorer's cache.
 */
'use strict';

const path = require('path');

const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'heic', 'heif', 'tiff', 'tif', 'svg'];
// Old formats (FLV, AVI, WMV, MPG, 3GP …) play through a converted copy —
// see video-playback.js.
const VIDEO_EXT = ['ogg'].concat(require('./video-playback').ALL_VIDEO_EXT);
const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'wma'];
const BYTES_EXT = ['pdf', 'html', 'htm'];
const VIEW_EXT = new Set([].concat(IMAGE_EXT, VIDEO_EXT, AUDIO_EXT, BYTES_EXT));

const BYTES_MAX = 500 * 1024 * 1024;       // same cap the old preview used
const THUMB_SOURCE_MAX = 64 * 1024 * 1024; // bigger "photos" get no thumbnail
const THUMB_MIN = 64, THUMB_MAX = 512, THUMB_DEFAULT = 320;

function extOf(p) {
    const m = /\.([^.\\/]+)$/.exec(String(p || ''));
    return m ? m[1].toLowerCase() : '';
}

/** Absolute path to an existing regular file with a previewable extension, else null. */
function checkPath(fs, filePath) {
    if (!filePath || typeof filePath !== 'string' || filePath.indexOf('\0') !== -1) return null;
    if (!path.isAbsolute(filePath)) return null;
    const full = path.resolve(filePath);
    const ext = extOf(full);
    if (!VIEW_EXT.has(ext)) return null;
    let st;
    try { st = fs.statSync(full); } catch (_) { return null; }
    if (!st.isFile()) return null;
    return { full, ext, size: st.size };
}

function headEncrypted(fs, security, full) {
    if (!security || typeof security.isEncryptedBuffer !== 'function') return false;
    const head = Buffer.alloc(64);
    const fd = fs.openSync(full, 'r');
    let n = 0;
    try { n = fs.readSync(fd, head, 0, 64, 0); } finally { fs.closeSync(fd); }
    return !!security.isEncryptedBuffer(head.subarray(0, n));
}

/** What the bytes really are — explains a ".jpg" that will not display. */
function sniff(buf) {
    if (!buf || !buf.length) return 'empty';
    const b = buf;
    const n = Math.min(b.length, 4096);
    let zero = true;
    for (let i = 0; i < n; i++) { if (b[i] !== 0) { zero = false; break; } }
    if (zero) return 'zeros';
    const asc = (o, s) => b.length >= o + s.length && b.toString('latin1', o, o + s.length) === s;
    if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) {
        // A JPEG ends FF D9; a partial download (BitTorrent, interrupted copy) does not.
        let end = b.length - 1;
        while (end > 0 && b[end] === 0) end--;
        return (b[end - 1] === 0xFF && b[end] === 0xD9) ? 'jpeg' : 'jpeg-truncated';
    }
    if (b[0] === 0x89 && asc(1, 'PNG')) return 'png';
    if (asc(0, 'GIF8')) return 'gif';
    if (asc(0, 'RIFF') && asc(8, 'WEBP')) return 'webp';
    if (asc(4, 'ftyp')) {
        const brand = b.toString('latin1', 8, 12).toLowerCase();
        if (/^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(brand)) return 'heic';
        if (brand === 'avif') return 'avif';
        return 'mp4';
    }
    if (asc(0, 'BM')) return 'bmp';
    if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2A) || (b[0] === 0x4D && b[1] === 0x4D && b[3] === 0x2A)) return 'tiff';
    if (asc(0, '%PDF')) return 'pdf';
    if (asc(0, 'PK')) return 'zip';
    if (/^\s*<(svg|\?xml)/i.test(b.toString('latin1', 0, Math.min(b.length, 64)))) return 'svg';
    return 'unknown';
}

/**
 * An image whose last 4 KB are all zeros is an unfinished download:
 * BitTorrent clients pre-allocate the file and leave missing pieces blank.
 * Deliberately narrow — a JPEG with extra data after FF D9 is NOT flagged.
 */
const TAIL_BYTES = 4096;
function fileTail(fs, chk) {
    const n = Math.min(TAIL_BYTES, chk.size);
    if (n <= 0) return null;
    const buf = Buffer.alloc(n);
    const fd = fs.openSync(chk.full, 'r');
    try { fs.readSync(fd, buf, 0, n, chk.size - n); } finally { fs.closeSync(fd); }
    return buf;
}
function blankTail(buf) {
    if (!buf || buf.length < 64) return false;
    for (let i = 0; i < buf.length; i++) if (buf[i] !== 0) return false;
    return true;
}

function createEvidenceView(o) {
    const fs = o.fs;
    // Getter: electron-main makes this view before Field Security exists.
    const getSecurity = typeof o.getSecurity === 'function' ? o.getSecurity : () => o.security || null;
    const issueToken = o.issueToken;         // absPath → token (viper-media://m/<token>)
    const nativeImage = o.nativeImage;

    function lockedResult() {
        return { success: false, locked: true, error: 'This file is protected by Field Security. Unlock Field Security to view it.' };
    }
    function unlocked() {
        const s = getSecurity();
        return !!(s && s.isUnlocked && s.isUnlocked());
    }

    async function readPlain(chk, enc) {
        let buf = await fs.promises.readFile(chk.full);
        if (enc) buf = getSecurity().decryptBuffer(buf);
        return buf;
    }

    /** { filePath, bytes } → { success, url } | { success, bytes } | { success:false, error, locked?, tooLarge? } */
    async function mediaUrl(args) {
        const a = args || {};
        try {
            const chk = checkPath(fs, a.filePath);
            if (!chk) return { success: false, error: 'This file cannot be previewed here.' };
            const enc = headEncrypted(fs, getSecurity(), chk.full);
            if (enc && !unlocked()) return lockedResult();
            const wantBytes = !!a.bytes || BYTES_EXT.indexOf(chk.ext) !== -1;
            const isImg = IMAGE_EXT.indexOf(chk.ext) !== -1;
            if (!enc && !wantBytes) {
                const r = { success: true, url: 'viper-media://m/' + issueToken(chk.full) };
                if (isImg && blankTail(fileTail(fs, chk))) r.note = 'blank-tail';
                return r;
            }
            if (chk.size > BYTES_MAX) {
                return { success: false, tooLarge: true, error: 'Too large to preview inside VIPER (' + (Math.round(chk.size / 1024 / 1024 / 1024 * 10) / 10) + ' GB).' };
            }
            const bytes = await readPlain(chk, enc);
            const r = { success: true, bytes };
            if (isImg && blankTail(bytes.subarray(Math.max(0, bytes.length - TAIL_BYTES)))) r.note = 'blank-tail';
            return r;
        } catch (e) {
            return { success: false, error: (e && e.message) || String(e) };
        }
    }

    /** { filePath, size } → { success, dataUrl, width, height } | { success:false, reason, sniff? } */
    async function thumb(args) {
        const a = args || {};
        try {
            const chk = checkPath(fs, a.filePath);
            // Videos: one frame grabbed by ffmpeg (video-playback.js).
            if (chk && chk.ext !== 'ogg' && VIDEO_EXT.indexOf(chk.ext) !== -1 && typeof o.videoThumb === 'function') {
                return await o.videoThumb({ filePath: chk.full, size: a.size });
            }
            if (!chk || IMAGE_EXT.indexOf(chk.ext) === -1) return { success: false, reason: 'not-image' };
            if (chk.size === 0) return { success: false, reason: 'undecodable', sniff: 'empty' };
            if (chk.size > THUMB_SOURCE_MAX) return { success: false, reason: 'too-large' };
            const enc = headEncrypted(fs, getSecurity(), chk.full);
            if (enc && !unlocked()) return Object.assign(lockedResult(), { reason: 'locked' });
            const buf = await readPlain(chk, enc);
            const img = nativeImage.createFromBuffer(buf);
            if (!img || img.isEmpty()) return { success: false, reason: 'undecodable', sniff: sniff(buf) };
            const sz = img.getSize();
            const max = Math.max(THUMB_MIN, Math.min(THUMB_MAX, parseInt(a.size, 10) || THUMB_DEFAULT));
            let t = img;
            if (sz.width > max || sz.height > max) {
                t = img.resize(sz.width >= sz.height ? { width: max, quality: 'good' } : { height: max, quality: 'good' });
            }
            const jpg = t.toJPEG(72);
            if (!jpg || !jpg.length) return { success: false, reason: 'undecodable', sniff: sniff(buf) };
            const out = { success: true, dataUrl: 'data:image/jpeg;base64,' + jpg.toString('base64'), width: sz.width, height: sz.height };
            if (blankTail(buf.subarray(Math.max(0, buf.length - TAIL_BYTES)))) out.note = 'blank-tail';
            return out;
        } catch (e) {
            return { success: false, reason: 'error', error: (e && e.message) || String(e) };
        }
    }

    return { mediaUrl, thumb };
}

module.exports = {
    createEvidenceView, checkPath, sniff, extOf, blankTail,
    IMAGE_EXT, VIDEO_EXT, AUDIO_EXT, BYTES_EXT, BYTES_MAX, THUMB_SOURCE_MAX,
};

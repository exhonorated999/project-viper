/**
 * Meta return importer: ZIP or extracted folder -> on-disk store.
 * Main-process only, no Electron import (the vault is passed in).
 *
 *   1. find the pages (records.html, preservation-N.html, any Meta page)
 *   2. parse + merge them ONE AT A TIME (each page is dropped before the next)
 *   3. write the store into a staging folder
 *   4. copy media ONE FILE AT A TIME (streamed when the vault is off,
 *      encrypted when it is on), sniffing the real type from the bytes —
 *      Instagram ships voice notes as `.txt` files that are really Ogg/Opus
 *   5. swap the staging folder in (a failed re-import keeps the old copy)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parsePage, looksLikeMetaPage } = require('./meta-html-tree');
const { MetaMerger, sortPageNames } = require('./meta-merge');
const Store = require('./meta-warrant-store');

const EXT_MIME = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
    '.webp': 'image/webp', '.heic': 'image/heic', '.bmp': 'image/bmp',
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav',
    '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.oga': 'audio/ogg',
    '.pdf': 'application/pdf', '.txt': 'text/plain', '.html': 'text/html', '.json': 'application/json',
    '.zip': 'application/zip'
};
const MIME_EXT = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/heic': '.heic',
    'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm', 'video/ogg': '.ogv',
    'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/aac': '.aac', 'audio/wav': '.wav', 'audio/ogg': '.ogg',
    'application/pdf': '.pdf', 'application/zip': '.zip'
};
// Extensions that already name each sniffed type correctly (no rename needed).
const OK_EXTS = {
    'image/jpeg': ['.jpg', '.jpeg'], 'video/mp4': ['.mp4', '.m4v'], 'audio/mp4': ['.m4a', '.mp4'],
    'audio/ogg': ['.ogg', '.opus', '.oga'], 'video/quicktime': ['.mov', '.qt']
};

/** Real type from the first bytes.  null when it is not a known binary format. */
function sniff(buf) {
    if (!buf || buf.length < 4) return null;
    const b = buf;
    const ascii = (s, e) => b.slice(s, e).toString('latin1');
    const kindOf = (mime) => mime.split('/')[0] === 'application' ? 'file' : mime.split('/')[0];
    const r = (mime) => ({ mime, ext: MIME_EXT[mime] || '', kind: kindOf(mime) });
    if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return r('image/jpeg');
    if (b[0] === 0x89 && ascii(1, 4) === 'PNG') return r('image/png');
    if (ascii(0, 4) === 'GIF8') return r('image/gif');
    if (ascii(0, 4) === 'RIFF' && b.length >= 12) {
        if (ascii(8, 12) === 'WEBP') return r('image/webp');
        if (ascii(8, 12) === 'WAVE') return r('audio/wav');
    }
    if (ascii(0, 4) === 'OggS') {
        const head = ascii(0, Math.min(b.length, 128));
        return r(/theora/i.test(head) ? 'video/ogg' : 'audio/ogg');
    }
    if (b.length >= 12 && ascii(4, 8) === 'ftyp') {
        const brand = ascii(8, 12);
        if (/^M4[AB] $/.test(brand)) return r('audio/mp4');
        if (brand === 'qt  ') return r('video/quicktime');
        if (/^(heic|heix|hevc|mif1|msf1)$/.test(brand)) return r('image/heic');
        return r('video/mp4');
    }
    if (b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) return r('video/webm');
    if (ascii(0, 4) === '%PDF') return r('application/pdf');
    if (ascii(0, 4) === 'PK\u0003\u0004') return r('application/zip');
    if (ascii(0, 3) === 'ID3') return r('audio/mpeg');
    if (b[0] === 0xFF && (b[1] === 0xF1 || b[1] === 0xF9)) return r('audio/aac');
    if (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0) return r('audio/mpeg');
    return null;
}

function safeName(name) {
    const base = String(name || 'file').split(/[\\/]/).pop();
    const s = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 120);
    return s || 'file';
}

/**
 * Decide the stored name and type of one media file.
 * `.txt` that sniffs as Ogg becomes `<name>.txt.ogg` so every viewer
 * (and Windows Explorer) plays it; the original name stays in `orig`.
 */
function classifyMedia(origName, head, htmlKind) {
    const ext = path.extname(origName).toLowerCase();
    const sn = sniff(head);
    let mime = EXT_MIME[ext] || 'application/octet-stream';
    let addExt = '';
    let sniffed = false;
    if (sn) {
        const okExts = OK_EXTS[sn.mime] || [sn.ext];
        if (okExts.indexOf(ext) < 0) { addExt = sn.ext; sniffed = true; }
        mime = sn.mime;
    }
    let kind = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'file';
    // An mp4 container placed in an <audio> tag is a voice note, not a video.
    if (htmlKind === 'audio' && kind === 'video') { kind = 'audio'; mime = 'audio/mp4'; }
    return { mime, kind, addExt, sniffed };
}

// ── Sources ────────────────────────────────────────────────────────────

async function openSource(sourcePath, security) {
    const st = fs.statSync(sourcePath);
    if (st.isDirectory()) {
        const entries = [];
        const walk = (dir, rel, depth) => {
            if (depth > 6) return;
            for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
                const abs = path.join(dir, d.name);
                const r = rel ? rel + '/' + d.name : d.name;
                if (d.isDirectory()) walk(abs, r, depth + 1);
                else if (d.isFile()) entries.push({ name: r, size: fs.statSync(abs).size, abs });
            }
        };
        walk(sourcePath, '', 0);
        return {
            kind: 'folder',
            entries,
            readText: (e) => fs.readFileSync(e.abs, 'utf8'),
            readBuf: (e) => fs.readFileSync(e.abs),
            copyTo: async (e, dest) => { fs.copyFileSync(e.abs, dest); },
            close: () => {}
        };
    }
    const { openZip } = require('../_shared/zip-reader');
    const zip = await openZip(sourcePath, { security });
    const entries = zip.getEntries().filter(e => !e.isDirectory).map(e => ({ name: e.entryName.replace(/\\/g, '/'), size: e.size, _e: e }));
    return {
        kind: 'zip',
        entries,
        readText: (e) => e._e.getData().toString('utf8'),
        readBuf: (e) => e._e.getData(),
        copyTo: (e, dest) => zip.extractEntryToFile(e._e, dest),
        close: () => { try { zip.close(); } catch (_) {} }
    };
}

function readHead(file, n) {
    const fd = fs.openSync(file, 'r');
    try {
        const buf = Buffer.alloc(n);
        const got = fs.readSync(fd, buf, 0, n, 0);
        return buf.slice(0, got);
    } finally { fs.closeSync(fd); }
}

const tick = () => new Promise(r => setImmediate(r));

/**
 * @param {object} o
 * @param {string} o.sourcePath   ZIP file or extracted folder
 * @param {string} o.caseDir      <cases>/<caseNumber>
 * @param {string} o.storeKey
 * @param {object} [o.security]   VIPER vault (isUnlocked/encryptBuffer)
 * @param {object} [o.meta]       light record fields to persist in meta.json
 * @param {function} [o.onProgress] ({phase, done, total, label})
 */
async function importReturn(o) {
    const progress = (p) => { try { if (o.onProgress) o.onProgress(p); } catch (_) {} };
    const security = o.security || null;
    const encrypt = !!(security && security.isUnlocked && security.isUnlocked());
    const root = Store.returnsRoot(o.caseDir);
    fs.mkdirSync(root, { recursive: true });
    Store.sweepLeftovers(o.caseDir);
    const key = Store.safeKey(o.storeKey);
    const staging = path.join(root, key + '.staging-' + crypto.randomBytes(4).toString('hex'));
    fs.mkdirSync(path.join(staging, 'linked_media'), { recursive: true });

    const src = await openSource(o.sourcePath, security);
    try {
        // 1. pages
        const htmls = src.entries.filter(e => /\.html?$/i.test(e.name) && !/(^|\/)linked_media\//i.test(e.name));
        const byName = new Map(htmls.map(e => [e.name, e]));
        const ordered = sortPageNames(htmls.map(e => e.name));
        progress({ phase: 'pages', done: 0, total: ordered.length, label: 'Reading pages' });

        // 2. parse + merge one page at a time
        const merger = new MetaMerger();
        const skipped = [];
        let n = 0;
        for (const name of ordered) {
            const e = byName.get(name);
            let html = src.readText(e);
            if (!looksLikeMetaPage(html.slice(0, 300000))) { skipped.push(name); html = null; n++; continue; }
            const page = parsePage(html);
            html = null;
            const slash = name.lastIndexOf('/');
            merger.addPage(name, page, { pageDir: slash >= 0 ? name.slice(0, slash) : '' });
            n++;
            progress({ phase: 'pages', done: n, total: ordered.length, label: name.split('/').pop() });
            await tick();
        }
        if (!merger.pages.length) {
            throw new Error('No Meta pages found (expected records.html and/or preservation-N.html).');
        }
        progress({ phase: 'merge', done: 0, total: 1, label: 'Combining pages' });
        await tick();
        const merged = merger.finish();

        // 3. media: every file under a linked_media folder + anything the pages reference
        const refKind = new Map(merged.mediaRefs.map(m => [m.ref, m.kind]));
        const kindLower = new Map(merged.mediaRefs.map(m => [m.ref.toLowerCase(), m.kind]));
        const lower = new Map(src.entries.map(e => [e.name.toLowerCase(), e]));
        const mediaEntries = [];
        const seenNames = new Set();
        for (const e of src.entries) {
            if (/(^|\/)linked_media\//i.test(e.name)) { mediaEntries.push(e); seenNames.add(e.name.toLowerCase()); }
        }
        const missing = [];
        for (const ref of refKind.keys()) {
            if (seenNames.has(ref.toLowerCase())) continue;
            const e = lower.get(ref.toLowerCase());
            if (e) { mediaEntries.push(e); seenNames.add(ref.toLowerCase()); }
            else missing.push(ref);
        }
        const media = {};
        const used = new Set();
        let bytes = 0;
        progress({ phase: 'media', done: 0, total: mediaEntries.length, label: 'Copying media' });
        for (let i = 0; i < mediaEntries.length; i++) {
            const e = mediaEntries[i];
            const htmlKind = kindLower.get(e.name.toLowerCase());
            let stored = safeName(e.name);
            let base = stored, c = 1;
            while (used.has(stored.toLowerCase())) stored = (c++) + '_' + base;
            let entry;
            if (encrypt) {
                const buf = src.readBuf(e);
                const cls = classifyMedia(e.name, buf.slice(0, 64), htmlKind);
                const fileName = stored + cls.addExt;
                fs.writeFileSync(path.join(staging, 'linked_media', fileName), security.encryptBuffer(buf));
                entry = { file: fileName, size: buf.length, mime: cls.mime, kind: cls.kind, enc: true, orig: e.name, sniffed: cls.sniffed };
            } else {
                const tmp = path.join(staging, 'linked_media', stored);
                await src.copyTo(e, tmp);
                const cls = classifyMedia(e.name, readHead(tmp, 64), htmlKind);
                const fileName = stored + cls.addExt;
                if (cls.addExt) fs.renameSync(tmp, path.join(staging, 'linked_media', fileName));
                entry = { file: fileName, size: fs.statSync(path.join(staging, 'linked_media', fileName)).size, mime: cls.mime, kind: cls.kind, enc: false, orig: e.name, sniffed: cls.sniffed };
            }
            used.add(entry.file.toLowerCase());
            used.add(stored.toLowerCase());
            media[e.name] = entry;
            bytes += entry.size;
            if ((i + 1) % 10 === 0 || i + 1 === mediaEntries.length) {
                progress({ phase: 'media', done: i + 1, total: mediaEntries.length, label: e.name.split('/').pop() });
                await tick();
            }
        }
        // A page may spell a ref with different case than the archive entry
        // (Windows-built returns): alias it so the viewer finds the file.
        for (const ref of refKind.keys()) {
            if (media[ref]) continue;
            const e = lower.get(ref.toLowerCase());
            if (e && media[e.name]) media[ref] = media[e.name];
        }

        // 4. store
        progress({ phase: 'store', done: 0, total: 1, label: 'Saving' });
        const index = Store.writeStore(staging, merged, {
            media: { files: mediaEntries.length, bytes, missing: missing.length, missingRefs: missing.slice(0, 50), encrypted: encrypt },
            skippedPages: skipped
        });
        Store.writeJson(path.join(staging, 'store', 'media.json'), media);
        const meta = Object.assign({}, o.meta || {}, {
            storeVersion: Store.STORE_VERSION,
            service: index.service || '',
            targetId: (index.params && index.params.target) || '',
            accountId: (index.params && index.params.accountId) || '',
            accountType: (index.params && index.params.accountType) || '',
            dateRange: (index.params && index.params.dateRange) || '',
            generated: (index.params && index.params.generated) || '',
            totals: Object.assign({}, index.totals, { media: mediaEntries.length, mediaBytes: bytes, missingMedia: missing.length })
        });
        Store.writeJson(path.join(staging, 'meta.json'), meta);

        // 5. swap
        const finalDir = Store.storeDir(o.caseDir, key);
        Store.swapIn(staging, finalDir);
        progress({ phase: 'done', done: 1, total: 1, label: 'Done' });
        return { storeKey: key, dir: finalDir, meta, index };
    } catch (err) {
        try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_) {}
        throw err;
    } finally {
        src.close();
    }
}

/** Is this ZIP / folder a Meta return?  Cheap: names first, one page head second. */
async function isMetaReturn(sourcePath, security) {
    let src;
    try {
        src = await openSource(sourcePath, security);
        const htmls = src.entries.filter(e => /\.html?$/i.test(e.name) && !/(^|\/)linked_media\//i.test(e.name));
        if (!htmls.length) return false;
        const named = htmls.filter(e => /(^|\/)(records|preservation[-_ ]?\d+)\.html?$/i.test(e.name));
        if (named.length && (htmls.length > 1 || src.entries.some(e => /(^|\/)linked_media\//i.test(e.name)))) return true;
        const probe = named[0] || htmls.sort((a, b) => a.size - b.size)[0];
        if (probe.size > 64 * 1024 * 1024) return false;
        return looksLikeMetaPage(src.readText(probe).slice(0, 300000));
    } catch (_) {
        return false;
    } finally {
        if (src) src.close();
    }
}

module.exports = { importReturn, isMetaReturn, sniff, classifyMedia, safeName, openSource, EXT_MIME };

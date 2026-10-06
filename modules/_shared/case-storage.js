/*
 * case-storage.js — renderer-side storage safety net.
 *
 * WHY THIS EXISTS
 * ---------------
 * localStorage is a ~5MB quota for the WHOLE application, shared by every
 * case. Several modules were base64-ing binary into it: pasted screenshots
 * inlined into a note body, consent forms attached as data URLs, and every
 * suspect/victim/vehicle photo stored at full camera resolution. One phone
 * photo is 4-7MB once base64'd, so a single upload could exhaust the quota
 * for the entire app.
 *
 * When the quota is gone, `localStorage.setItem` throws. Two modules called
 * it with no try/catch from inside an `async` submit handler, so the throw
 * became an unhandled promise rejection that the browser silently discards:
 * the modal closed, a success toast appeared, and the tab re-rendered from
 * the in-memory array. It looked saved. Nothing had been written. The
 * officer only found out after leaving the tab and coming back.
 *
 * This module is the fix, in three parts:
 *   1. setItemSafe()  — a save either succeeds or says so. Never silent.
 *   2. shrinkImage()  — photos are downscaled before they are ever stored.
 *   3. de/hydrate()   — note-body images live on disk; the HTML keeps a name.
 *
 * The de/hydrate pair is deliberately asymmetric in WHERE it runs: hydrate
 * once when a case loads, dehydrate once on every commit. Every render site
 * (notes list, popout window, DA export, assist package) therefore keeps
 * seeing ordinary `<img src="data:...">` exactly as it does today and needed
 * no changes at all. The narrow waist is the commit, not the paint.
 *
 * Pure string/DOM-free logic so it can be exercised headlessly in Node; the
 * canvas-dependent parts degrade to a no-op off-browser.
 */
(function (root, factory) {
    var api = factory();
    // BOTH assignments, always. `module` IS defined in VIPER's renderer, so a
    // UMD wrapper that picks one branch leaves window.VpCaseStorage undefined
    // and every `if (window.VpCaseStorage)` host guard silently never fires.
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root) root.VpCaseStorage = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // Attribute that marks an <img> whose bytes live on disk. The value is
    // the file name inside cases/<caseNumber>/<subdir>/ — never a path.
    var IMG_ATTR = 'data-vp-img';
    var IMG_KIND_ATTR = 'data-vp-img-kind';

    // A 1x1 transparent GIF. Used as the placeholder `src` on a dehydrated
    // image so that HTML which is rendered before hydration finishes shows a
    // blank box rather than a browser "broken image" glyph.
    var BLANK_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

    var MIME_EXT = {
        'image/png': '.png',
        'image/jpeg': '.jpg',
        'image/jpg': '.jpg',
        'image/gif': '.gif',
        'image/webp': '.webp',
        'image/bmp': '.bmp',
        'image/svg+xml': '.svg'
    };

    var EXT_MIME = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml'
    };

    // ── Quota ────────────────────────────────────────────────────────────

    function isQuotaError(err) {
        if (!err) return false;
        // Chromium throws DOMException QuotaExceededError (code 22); Firefox
        // uses NS_ERROR_DOM_QUOTA_REACHED (1014). Check the message too
        // because some wrappers re-throw a plain Error.
        if (err.name === 'QuotaExceededError') return true;
        if (err.name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
        if (err.code === 22 || err.code === 1014) return true;
        return /quota|storage is full|exceeded the quota/i.test(String(err.message || ''));
    }

    /*
     * Total bytes currently held in localStorage, counting the keys as well
     * as the values — both are charged against the quota. UTF-16 means two
     * bytes per code unit, which is what makes a base64 photo cost roughly
     * 2.7x the size of the original file.
     */
    function usageBytes(store) {
        var ls = store || (typeof localStorage !== 'undefined' ? localStorage : null);
        if (!ls) return 0;
        var total = 0;
        for (var i = 0; i < ls.length; i++) {
            var k = ls.key(i);
            if (k === null) continue;
            var v = ls.getItem(k);
            total += (k.length + (v === null ? 0 : v.length)) * 2;
        }
        return total;
    }

    function formatBytes(n) {
        if (!isFinite(n) || n < 0) return '?';
        if (n < 1024) return n + ' B';
        if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
        return (n / 1048576).toFixed(1) + ' MB';
    }

    /*
     * The one rule this module exists to enforce: a write either lands or it
     * reports. Returns {ok, quota, error, message} and NEVER throws, so the
     * caller is forced to look at the result instead of assuming.
     *
     * `opts.label` is officer-facing ("the consent search", "this note") and
     * is dropped straight into the message, so write it as a noun phrase.
     */
    function setItemSafe(key, value, opts) {
        var o = opts || {};
        var ls = o.store || (typeof localStorage !== 'undefined' ? localStorage : null);
        if (!ls) return { ok: false, quota: false, error: 'no-storage', message: 'Storage is unavailable.' };
        var str = typeof value === 'string' ? value : JSON.stringify(value);
        try {
            ls.setItem(key, str);
            return { ok: true, quota: false, bytes: str.length * 2 };
        } catch (err) {
            if (!isQuotaError(err)) {
                return {
                    ok: false, quota: false, error: err,
                    message: 'Could not save ' + (o.label || 'this item') + ': ' + (err && err.message ? err.message : String(err))
                };
            }
            var used = formatBytes(usageBytes(ls));
            var needed = formatBytes(str.length * 2);
            return {
                ok: false, quota: true, error: err,
                message: 'Not enough storage to save ' + (o.label || 'this item') + ' \u2014 nothing was saved. '
                    + 'This case needs ' + needed + ' and the app is already holding ' + used + '. '
                    + 'Close and reopen the case: VIPER will move older photos out to disk and free space automatically.'
            };
        }
    }

    // ── Data URLs ────────────────────────────────────────────────────────

    function splitDataUrl(url) {
        if (typeof url !== 'string') return null;
        var m = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]*)$/i.exec(url.trim());
        if (!m) return null;
        return { mime: m[1].toLowerCase(), base64: m[2].replace(/\s+/g, '') };
    }

    function isImageDataUrl(url) {
        var p = splitDataUrl(url);
        return !!(p && p.mime.indexOf('image/') === 0);
    }

    // Decoded byte count of a base64 string, without decoding it.
    function base64Bytes(b64) {
        if (typeof b64 !== 'string' || !b64.length) return 0;
        var clean = b64.replace(/\s+/g, '');
        var pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
        return Math.max(0, Math.floor(clean.length * 3 / 4) - pad);
    }

    function extForMime(mime) {
        return MIME_EXT[String(mime || '').toLowerCase()] || '.bin';
    }

    function mimeForFileName(name) {
        var ext = String(name || '').split('.').pop().toLowerCase();
        return EXT_MIME[ext] || '';
    }

    /*
     * Base64 a binary buffer without blowing the call stack.
     *
     * The old consent-search handler did `btoa(String.fromCharCode(...new
     * Uint8Array(buf)))`, which spreads every byte of the file as a separate
     * function argument. Past roughly 100KB that is a RangeError, so large
     * consent PDFs failed outright before the quota was even reached.
     */
    function bufferToBase64(buf) {
        var bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
        var CHUNK = 0x8000;
        var parts = [];
        for (var i = 0; i < bytes.length; i += CHUNK) {
            parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
        }
        return btoa(parts.join(''));
    }

    // ── Image downscaling ────────────────────────────────────────────────

    // A case photo is documentation, not a print master. 1600px on the long
    // edge is far more than a report or a PDF export ever renders, and takes
    // a 5MB phone JPEG down to roughly 200-400KB.
    var DEFAULT_MAX_EDGE = 1600;
    var DEFAULT_QUALITY = 0.82;

    /*
     * Downscale/recompress an image data URL. Resolves with the ORIGINAL
     * string if anything at all goes wrong or if shrinking would not help —
     * a slightly oversized photo is always better than a lost one.
     *
     * PNGs with transparency are kept as PNG; everything else becomes JPEG,
     * which is where almost all of the saving comes from.
     */
    function shrinkImageDataUrl(dataUrl, opts) {
        var o = opts || {};
        var maxEdge = o.maxEdge || DEFAULT_MAX_EDGE;
        var quality = typeof o.quality === 'number' ? o.quality : DEFAULT_QUALITY;
        return new Promise(function (resolve) {
            var parts = splitDataUrl(dataUrl);
            if (!parts || parts.mime.indexOf('image/') !== 0 || parts.mime === 'image/gif'
                || parts.mime === 'image/svg+xml') {
                // GIFs may be animated and SVG is already tiny text — both
                // would be destroyed by a canvas round-trip.
                return resolve(dataUrl);
            }
            if (typeof document === 'undefined' || typeof Image === 'undefined') return resolve(dataUrl);

            var img = new Image();
            img.onload = function () {
                try {
                    var w = img.naturalWidth || img.width;
                    var h = img.naturalHeight || img.height;
                    if (!w || !h) return resolve(dataUrl);
                    var scale = Math.min(1, maxEdge / Math.max(w, h));
                    var tw = Math.max(1, Math.round(w * scale));
                    var th = Math.max(1, Math.round(h * scale));

                    var canvas = document.createElement('canvas');
                    canvas.width = tw; canvas.height = th;
                    var ctx = canvas.getContext('2d');
                    if (!ctx) return resolve(dataUrl);
                    ctx.imageSmoothingEnabled = true;
                    ctx.imageSmoothingQuality = 'high';

                    var keepPng = parts.mime === 'image/png' && o.forceJpeg !== true;
                    if (!keepPng) {
                        // JPEG has no alpha; without this a transparent
                        // background renders black.
                        ctx.fillStyle = '#ffffff';
                        ctx.fillRect(0, 0, tw, th);
                    }
                    ctx.drawImage(img, 0, 0, tw, th);

                    var out = keepPng
                        ? canvas.toDataURL('image/png')
                        : canvas.toDataURL('image/jpeg', quality);

                    // A PNG screenshot re-encoded as PNG at the same size can
                    // come out larger. Only accept a genuine win.
                    if (keepPng && out.length >= dataUrl.length) {
                        out = canvas.toDataURL('image/jpeg', quality);
                    }
                    resolve(out.length < dataUrl.length ? out : dataUrl);
                } catch (e) {
                    resolve(dataUrl);
                }
            };
            img.onerror = function () { resolve(dataUrl); };
            img.src = dataUrl;
        });
    }

    // ── <img> tag rewriting ──────────────────────────────────────────────
    //
    // Regex rather than DOMParser on purpose: this same code has to run in
    // Node for the test suite, and an <img> is a void element whose
    // attribute values are quoted base64 (alphabet A-Za-z0-9+/=) or CSS —
    // neither of which can contain a '>' or an unescaped quote.

    var IMG_TAG_RE = /<img\b[^>]*>/gi;

    function readAttr(tag, name) {
        var re = new RegExp('\\b' + name.replace(/[-]/g, '\\-') + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')', 'i');
        var m = re.exec(tag);
        if (!m) return null;
        return m[2] !== undefined ? m[2] : m[3];
    }

    function writeAttr(tag, name, value) {
        var re = new RegExp('\\b' + name.replace(/[-]/g, '\\-') + '\\s*=\\s*("[^"]*"|\'[^\']*\')', 'i');
        var attr = name + '="' + String(value).replace(/"/g, '&quot;') + '"';
        if (re.test(tag)) return tag.replace(re, attr);
        return tag.replace(/^<img\b/i, '<img ' + attr);
    }

    function forEachImgTag(html, fn) {
        if (typeof html !== 'string' || html.indexOf('<img') === -1) return html;
        return html.replace(IMG_TAG_RE, function (tag) {
            var out = fn(tag);
            return typeof out === 'string' ? out : tag;
        });
    }

    /*
     * Every image in a block of HTML whose BYTES are carried inline, i.e.
     * everything that would cost localStorage quota if the HTML were stored
     * as-is.
     *
     * The blank placeholder pixel is itself a data: URL, so it has to be
     * excluded explicitly — otherwise dehydrated HTML reports as still
     * carrying images and `hasInlineImages` becomes permanently true.
     * A hydrated tag IS counted even though a disk copy exists, because at
     * that moment the bytes really are in the string.
     */
    function inlineImages(html) {
        var found = [];
        forEachImgTag(html, function (tag) {
            var src = readAttr(tag, 'src');
            if (src && src !== BLANK_PIXEL && isImageDataUrl(src)) found.push({ tag: tag, src: src });
            return tag;
        });
        return found;
    }

    /* Every already-dehydrated image reference in a block of HTML. */
    function diskImages(html) {
        var found = [];
        forEachImgTag(html, function (tag) {
            var name = readAttr(tag, IMG_ATTR);
            if (name) found.push({ tag: tag, fileName: name, kind: readAttr(tag, IMG_KIND_ATTR) || 'notes' });
            return tag;
        });
        return found;
    }

    /*
     * Move every inline image in `html` out to disk and leave a reference.
     *
     * `saveFn({ base64, mime, fileName })` must resolve to a final file name
     * (the main process may have de-duplicated it) or null on failure.
     *
     * An image that fails to save is LEFT INLINE. The note still renders and
     * the officer loses nothing; the only cost is that it keeps occupying
     * quota, which the next successful pass will clear.
     */
    function dehydrateHtml(html, saveFn, opts) {
        var o = opts || {};
        var kind = o.kind || 'notes';
        var stem = o.stem || 'note-image';
        if (typeof html !== 'string' || html.indexOf('<img') === -1) {
            return Promise.resolve({ html: html, moved: 0, failed: 0, bytesFreed: 0 });
        }

        var tags = [];
        forEachImgTag(html, function (tag) { tags.push(tag); return tag; });

        var jobs = tags.map(function (tag) {
            if (readAttr(tag, IMG_ATTR)) {
                // Already on disk. Blank the hydrated src so the fat bytes
                // do not go back into storage.
                return Promise.resolve({ tag: tag, out: writeAttr(tag, 'src', BLANK_PIXEL), moved: 0, failed: 0, freed: 0 });
            }
            var src = readAttr(tag, 'src');
            var parts = src && isImageDataUrl(src) ? splitDataUrl(src) : null;
            if (!parts) return Promise.resolve({ tag: tag, out: tag, moved: 0, failed: 0, freed: 0 });

            var name = stem + '-' + Date.now().toString(36) + '-'
                + Math.random().toString(36).slice(2, 8) + extForMime(parts.mime);
            // `new Promise` rather than Promise.resolve(saveFn(...)): a saveFn
            // that throws SYNCHRONOUSLY would escape before .catch() is
            // attached and reject the whole commit, losing the note instead of
            // just that one image.
            return new Promise(function (resolve) { resolve(saveFn({ base64: parts.base64, mime: parts.mime, fileName: name })); })
                .then(function (finalName) {
                    if (!finalName) return { tag: tag, out: tag, moved: 0, failed: 1, freed: 0 };
                    var next = writeAttr(tag, IMG_ATTR, finalName);
                    next = writeAttr(next, IMG_KIND_ATTR, kind);
                    next = writeAttr(next, 'src', BLANK_PIXEL);
                    return { tag: tag, out: next, moved: 1, failed: 0, freed: src.length * 2 };
                })
                .catch(function () { return { tag: tag, out: tag, moved: 0, failed: 1, freed: 0 }; });
        });

        return Promise.all(jobs).then(function (results) {
            var i = 0, moved = 0, failed = 0, freed = 0;
            var out = forEachImgTag(html, function () {
                var r = results[i++];
                if (!r) return null;
                moved += r.moved; failed += r.failed; freed += r.freed;
                return r.out;
            });
            return { html: out, moved: moved, failed: failed, bytesFreed: freed };
        });
    }

    /*
     * Put the bytes back, for display. `readFn({ fileName, kind })` resolves
     * to a data URL or null. A reference that cannot be read keeps its
     * placeholder pixel and its attribute, so a later load can try again —
     * the file on disk is the record of truth, not this HTML.
     */
    function hydrateHtml(html, readFn) {
        if (typeof html !== 'string' || html.indexOf(IMG_ATTR) === -1) {
            return Promise.resolve(html);
        }
        var tags = [];
        forEachImgTag(html, function (tag) { tags.push(tag); return tag; });

        var jobs = tags.map(function (tag) {
            var name = readAttr(tag, IMG_ATTR);
            if (!name) return Promise.resolve(tag);
            // Sync-throw safe, same reasoning as dehydrateHtml: one
            // unreadable image must not take the whole note down with it.
            return new Promise(function (resolve) { resolve(readFn({ fileName: name, kind: readAttr(tag, IMG_KIND_ATTR) || 'notes' })); })
                .then(function (dataUrl) { return dataUrl ? writeAttr(tag, 'src', dataUrl) : tag; })
                .catch(function () { return tag; });
        });

        return Promise.all(jobs).then(function (resolved) {
            var i = 0;
            return forEachImgTag(html, function () { return resolved[i++]; });
        });
    }

    /*
     * The synchronous half of dehydration: for images already on disk, drop
     * the hydrated bytes and leave the reference. No disk access, so this is
     * safe on the close/quit flush path, which cannot await anything.
     *
     * Without it, an officer who opens a case (hydrating every note image for
     * display), edits a note and then closes the window would have the full
     * bytes written straight back into storage by the flush — undoing the
     * whole point of moving them out.
     */
    function blankHydrated(html) {
        if (typeof html !== 'string' || html.indexOf(IMG_ATTR) === -1) return html;
        return forEachImgTag(html, function (tag) {
            if (!readAttr(tag, IMG_ATTR)) return tag;
            return writeAttr(tag, 'src', BLANK_PIXEL);
        });
    }

    /*
     * True when `html` still carries inline image bytes, i.e. it would cost
     * quota if written as-is. Cheap enough to call on every commit.
     */
    function hasInlineImages(html) {
        return inlineImages(html).length > 0;
    }

    return {
        IMG_ATTR: IMG_ATTR,
        IMG_KIND_ATTR: IMG_KIND_ATTR,
        BLANK_PIXEL: BLANK_PIXEL,
        DEFAULT_MAX_EDGE: DEFAULT_MAX_EDGE,

        isQuotaError: isQuotaError,
        usageBytes: usageBytes,
        formatBytes: formatBytes,
        setItemSafe: setItemSafe,

        splitDataUrl: splitDataUrl,
        isImageDataUrl: isImageDataUrl,
        base64Bytes: base64Bytes,
        extForMime: extForMime,
        mimeForFileName: mimeForFileName,
        bufferToBase64: bufferToBase64,

        shrinkImageDataUrl: shrinkImageDataUrl,

        readAttr: readAttr,
        writeAttr: writeAttr,
        inlineImages: inlineImages,
        diskImages: diskImages,
        hasInlineImages: hasInlineImages,
        blankHydrated: blankHydrated,
        dehydrateHtml: dehydrateHtml,
        hydrateHtml: hydrateHtml
    };
}));

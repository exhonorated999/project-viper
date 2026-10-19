/*
 * case-blobs.js — keeps the photos and documents attached to case records
 * (suspects, victims, witnesses, vehicles, property …) in the CASE FOLDER
 * instead of VIPER's built-in browser storage.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every person/property record stored its photo, DMV printout, rap sheet
 * and firearms paperwork inline as a base64 data URL inside localStorage.
 * localStorage is one fixed-size area for the whole app (Electron 28 caps
 * it at roughly 52 million characters per origin) and it has nothing to do
 * with free disk or OneDrive space. An officer who imports enough DMV PDFs
 * fills it, and from then on EVERY save in every tab fails with
 * "exceeded the quota" — field report, 5.4.4.
 *
 * HOW IT WORKS — transparently, so ~170 readers needed no change
 * ---------------------------------------------------------------
 * This script wraps localStorage.getItem / setItem on the page's own
 * Storage instance, for the record keys listed in SCOPE_PREFIXES only:
 *
 *   setItem  every data URL string value of 4 KB or more is written to
 *            cases/<caseNumber>/Attachments/<sha256>.<ext> (through a
 *            synchronous IPC call — Storage is synchronous, so the bridge
 *            has to be too) and replaced in the stored JSON by a short
 *            reference:  viper-file:v1:<sha256>:<mime id>
 *   getItem  every reference is swapped back for the exact original data
 *            URL, so the caller receives byte-for-byte what it wrote.
 *
 * Tabs, the DA report/ZIP, Assist Package, Ops Plan, Connection Board, the
 * .vcase exporter, the case snapshot and Settings backup all read through
 * getItem, so all of them keep receiving full bytes.
 *
 * Existing inline data is moved out by a background sweep a few seconds
 * after each page loads, and by an immediate sweep whenever a write hits
 * the quota (then the write is retried once).
 *
 * Rules this module keeps:
 *   - Never lose data. Anything that cannot be moved (no case number yet,
 *     Field Security locked, unknown MIME type, oversize) stays inline,
 *     exactly as before. A reference that cannot be read is returned
 *     unchanged, so a later save writes it back as-is instead of dropping it.
 *   - The stored JSON is re-serialised only when something was actually
 *     swapped; otherwise the original string passes through untouched.
 *   - Refs are content addressed (SHA-256 of the plain bytes) and the main
 *     process verifies the hash on every write and every uncached read.
 *   - It must load BEFORE case-snapshot.js (which captures setItem at load)
 *     in every page that touches these keys: index.html,
 *     case-detail-with-analytics.html and settings.html.
 *
 * Pure logic (parse/dehydrate/hydrate) is exported for Node tests; the
 * install step needs a Storage object and the preload bridge.
 */
(function (root, factory) {
    // Loaded twice (or re-evaluated)? Keep the first instance: a second
    // install would wrap the wrappers.
    var existing = root && root.VpCaseBlobs;
    var api = (existing && existing.__vpCaseBlobs === 1) ? existing : factory();
    // BOTH assignments, always — `module` IS defined in VIPER's renderer.
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root) root.VpCaseBlobs = api;
    try {
        if (root && root.document && root.localStorage && root.electronAPI
            && typeof root.electronAPI.caseBlobPutSync === 'function'
            && typeof root.electronAPI.caseBlobReadSync === 'function') {
            api.install({ storage: root.localStorage, bridge: root.electronAPI, window: root, autoSweepMs: 4000 });
        }
    } catch (e) {
        try { console.error('[case-blobs] install failed:', e); } catch (_) { /* ignore */ }
    }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    var REF_PREFIX = 'viper-file:v1:';
    var REF_RE = /^viper-file:v1:([0-9a-f]{64}):([a-z0-9]{1,12})$/;
    var DATA_URL_RE = /^data:([a-z0-9][a-z0-9.+\-]*\/[a-z0-9][a-z0-9.+\-]*);base64,([A-Za-z0-9+\/]*={0,2})$/;

    // Folder inside cases/<caseNumber>/. Fixed — main derives every path.
    var FOLDER_NAME = 'Attachments';

    // Below this a data URL stays inline: icons and thumbnails cost almost
    // nothing and are not worth a file each.
    var MIN_CHARS = 4096;
    // Largest base64 string moved through the synchronous bridge (~48 MB of
    // file). Bigger values stay inline (they never fitted before either).
    var MAX_CHARS = 64 * 1024 * 1024;

    // id -> exact MIME string and on-disk extension. The id goes into the
    // ref so getItem can rebuild the IDENTICAL data URL (image/jpg and
    // image/jpeg are different strings and must round-trip as such). A MIME
    // type not listed here is simply left inline.
    var MIME_IDS = Object.freeze({
        jpeg: Object.freeze({ mime: 'image/jpeg', ext: 'jpg' }),
        jpg:  Object.freeze({ mime: 'image/jpg', ext: 'jpg' }),
        pjpeg: Object.freeze({ mime: 'image/pjpeg', ext: 'jpg' }),
        png:  Object.freeze({ mime: 'image/png', ext: 'png' }),
        gif:  Object.freeze({ mime: 'image/gif', ext: 'gif' }),
        webp: Object.freeze({ mime: 'image/webp', ext: 'webp' }),
        bmp:  Object.freeze({ mime: 'image/bmp', ext: 'bmp' }),
        svg:  Object.freeze({ mime: 'image/svg+xml', ext: 'svg' }),
        tiff: Object.freeze({ mime: 'image/tiff', ext: 'tif' }),
        heic: Object.freeze({ mime: 'image/heic', ext: 'heic' }),
        avif: Object.freeze({ mime: 'image/avif', ext: 'avif' }),
        pdf:  Object.freeze({ mime: 'application/pdf', ext: 'pdf' }),
        bin:  Object.freeze({ mime: 'application/octet-stream', ext: 'bin' }),
        txt:  Object.freeze({ mime: 'text/plain', ext: 'txt' }),
        csv:  Object.freeze({ mime: 'text/csv', ext: 'csv' }),
        rtf:  Object.freeze({ mime: 'application/rtf', ext: 'rtf' }),
        doc:  Object.freeze({ mime: 'application/msword', ext: 'doc' }),
        docx: Object.freeze({ mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' }),
        xls:  Object.freeze({ mime: 'application/vnd.ms-excel', ext: 'xls' }),
        xlsx: Object.freeze({ mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' })
    });
    var ID_BY_MIME = (function () {
        var m = Object.create(null);
        Object.keys(MIME_IDS).forEach(function (id) { m[MIME_IDS[id].mime] = id; });
        return m;
    }());

    // The record stores that carry photos and documents. Keys are
    // `<prefix><case.id>`. Everything else in localStorage is untouched.
    var SCOPE_PREFIXES = Object.freeze([
        'suspects_', 'victims_', 'witnesses_', 'involvedPersons_',
        'missingpersons_', 'victimBusinesses_', 'recoveredVehicles_',
        'firearms_', 'narcotics_', 'money_', 'cargo_'
    ]);

    // ── Pure helpers ─────────────────────────────────────────────────────

    function scopeOf(key) {
        if (typeof key !== 'string') return null;
        for (var i = 0; i < SCOPE_PREFIXES.length; i++) {
            var p = SCOPE_PREFIXES[i];
            if (key.length > p.length && key.lastIndexOf(p, 0) === 0) {
                return { prefix: p, caseId: key.slice(p.length) };
            }
        }
        return null;
    }

    function idForMime(mime) {
        return (typeof mime === 'string' && ID_BY_MIME[mime]) || null;
    }

    /** {mime, id, b64} for a data URL we are willing to move, else null. */
    function parseDataUrl(s) {
        if (typeof s !== 'string' || s.length < MIN_CHARS || s.length > MAX_CHARS + 200) return null;
        if (s.lastIndexOf('data:', 0) !== 0) return null;
        var comma = s.indexOf(';base64,');
        if (comma < 0 || comma > 200) return null;
        var id = idForMime(s.slice(5, comma));
        if (!id) return null;
        if (!DATA_URL_RE.test(s)) return null;
        var b64 = s.slice(comma + 8);
        if (b64.length % 4 !== 0 || b64.length > MAX_CHARS) return null;
        return { mime: MIME_IDS[id].mime, id: id, b64: b64 };
    }

    /** {sha, id, mime, ext} for a well-formed ref, else null. */
    function parseRef(s) {
        if (typeof s !== 'string' || s.length > 100 || s.lastIndexOf(REF_PREFIX, 0) !== 0) return null;
        var m = REF_RE.exec(s);
        if (!m || !Object.prototype.hasOwnProperty.call(MIME_IDS, m[2])) return null;
        return { sha: m[1], id: m[2], mime: MIME_IDS[m[2]].mime, ext: MIME_IDS[m[2]].ext };
    }

    function makeRef(sha, id) { return REF_PREFIX + sha + ':' + id; }

    // Replace string leaves in place. fn(str) returns the replacement (or
    // the same string). Returns the number of leaves replaced.
    function walk(node, fn, depth) {
        if (depth > 100 || !node || typeof node !== 'object') return 0;
        var n = 0, i, v, r;
        if (Array.isArray(node)) {
            for (i = 0; i < node.length; i++) {
                v = node[i];
                if (typeof v === 'string') { r = fn(v); if (r !== v) { node[i] = r; n++; } }
                else if (v && typeof v === 'object') n += walk(v, fn, depth + 1);
            }
            return n;
        }
        var keys = Object.keys(node);
        for (i = 0; i < keys.length; i++) {
            v = node[keys[i]];
            if (typeof v === 'string') {
                r = fn(v);
                if (r !== v) {
                    // defineProperty, not assignment: a JSON key named
                    // "__proto__" is an own data property after JSON.parse
                    // and plain assignment would hit the setter instead.
                    Object.defineProperty(node, keys[i], { value: r, writable: true, enumerable: true, configurable: true });
                    n++;
                }
            } else if (v && typeof v === 'object') n += walk(v, fn, depth + 1);
        }
        return n;
    }

    /**
     * Swap large data URLs for refs. put(parsed, dataUrl) returns a ref or
     * null (null = leave it inline). Returns {text, changed, moved, kept}.
     */
    function dehydrateText(raw, put) {
        var out = { text: raw, changed: false, moved: 0, kept: 0 };
        if (typeof raw !== 'string' || raw.length < MIN_CHARS || raw.indexOf('"data:') === -1) return out;
        var doc;
        try { doc = JSON.parse(raw); } catch (_) { return out; }
        if (!doc || typeof doc !== 'object') return out;
        var moved = walk(doc, function (s) {
            var p = parseDataUrl(s);
            if (!p) return s;
            var ref = null;
            try { ref = put(p, s); } catch (_) { ref = null; }
            if (ref && parseRef(ref)) return ref;
            out.kept++;
            return s;
        }, 0);
        if (moved > 0) {
            out.text = JSON.stringify(doc);
            out.changed = out.text !== raw;
            out.moved = moved;
        }
        return out;
    }

    /**
     * Swap refs back for data URLs. read(parsedRef, ref) returns the data
     * URL or null (null = leave the ref, never drop it).
     * Returns {text, changed, restored, failed}.
     */
    function hydrateText(raw, read) {
        var out = { text: raw, changed: false, restored: 0, failed: 0 };
        if (typeof raw !== 'string' || raw.indexOf(REF_PREFIX) === -1) return out;
        var doc;
        try { doc = JSON.parse(raw); } catch (_) { return out; }
        if (!doc || typeof doc !== 'object') return out;
        var restored = walk(doc, function (s) {
            var p = parseRef(s);
            if (!p) return s;
            var d = null;
            try { d = read(p, s); } catch (_) { d = null; }
            if (typeof d === 'string' && d.lastIndexOf('data:', 0) === 0) return d;
            out.failed++;
            return s;
        }, 0);
        if (restored > 0) {
            out.text = JSON.stringify(doc);
            out.changed = true;
            out.restored = restored;
        }
        return out;
    }

    function isQuotaError(err) {
        if (!err) return false;
        if (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
        if (err.code === 22 || err.code === 1014) return true;
        return /quota|storage is full|exceeded the quota/i.test(String(err.message || ''));
    }

    // ── Install ──────────────────────────────────────────────────────────

    var _controllers = [];

    /**
     * Wrap storage.getItem / setItem. opts:
     *   storage     the Storage object (window.localStorage)
     *   bridge      { caseBlobPutSync(p), caseBlobReadSync(p) } — preload
     *   window      for toasts / timers (optional)
     *   autoSweepMs schedule the background move-out sweep (optional)
     *   cacheChars  memory budget for restored files (default 96M chars)
     */
    function install(opts) {
        var storage = opts && opts.storage;
        if (!storage) throw new Error('case-blobs: no storage');
        for (var c = 0; c < _controllers.length; c++) {
            if (_controllers[c].storage === storage) return _controllers[c].api;
        }
        var bridge = opts.bridge || {};
        var win = opts.window || null;
        var timers = win && typeof win.setTimeout === 'function' ? win : (typeof setTimeout === 'function' ? { setTimeout: setTimeout } : null);
        var BUDGET = opts.cacheChars || 96 * 1024 * 1024;
        var now = opts.now || function () { return Date.now(); };

        var nativeGet = storage.getItem.bind(storage);
        var nativeSet = storage.setItem.bind(storage);

        // case.id -> caseNumber, rebuilt whenever viperCases changes.
        var casesRaw = {}; // sentinel that never equals a string or null
        var caseMap = Object.create(null);
        function caseNumberFor(caseId) {
            var raw;
            try { raw = nativeGet('viperCases'); } catch (_) { return null; }
            if (raw !== casesRaw) {
                casesRaw = raw;
                caseMap = Object.create(null);
                try {
                    var arr = JSON.parse(raw || '[]');
                    if (Array.isArray(arr)) {
                        for (var i = 0; i < arr.length; i++) {
                            var k = arr[i];
                            if (!k || k.id === undefined || k.id === null) continue;
                            if (typeof k.caseNumber !== 'string' || !k.caseNumber.trim()) continue;
                            caseMap[String(k.id)] = k.caseNumber;
                        }
                    }
                } catch (_) { /* unreadable list: nothing resolves, everything stays inline */ }
            }
            return caseMap[caseId] || null;
        }

        // Restored files, LRU by insertion order: ref -> dataUrl, and the
        // reverse dataUrl -> ref so re-saving an unchanged photo costs no IPC.
        var blobs = new Map();
        var refsByData = new Map();
        var blobChars = 0;
        function remember(ref, dataUrl) {
            if (blobs.has(ref)) {
                var old = blobs.get(ref);
                blobs.delete(ref);
                blobs.set(ref, old);
                return;
            }
            blobs.set(ref, dataUrl);
            refsByData.set(dataUrl, ref);
            blobChars += dataUrl.length;
            while (blobChars > BUDGET && blobs.size > 1) {
                var oldest = blobs.keys().next().value;
                var d = blobs.get(oldest);
                blobs.delete(oldest);
                if (refsByData.get(d) === oldest) refsByData.delete(d);
                blobChars -= d.length;
            }
        }
        // "<caseNumber>\0<ref>" pairs known to exist in that case's folder
        // this session. A cached ref from ANOTHER case does not count — the
        // same photo in two cases is two files, one per case folder.
        var confirmed = new Set();
        function pair(cn, ref) { return cn + '\u0000' + ref; }

        var stats = { moved: 0, reused: 0, keptInline: 0, restored: 0, readFailures: 0, putFailures: 0, sweeps: 0, sweptChars: 0 };
        var lastErrors = [];
        function noteError(kind, cn, key, res) {
            var e = { kind: kind, caseNumber: cn, key: key, code: (res && res.code) || 'ERROR', error: (res && res.error) || '' };
            lastErrors.push(e);
            if (lastErrors.length > 50) lastErrors.shift();
            try { console.warn('[case-blobs] ' + kind + ' failed for ' + key + ' (case ' + cn + '): ' + e.code + ' ' + e.error); } catch (_) { /* ignore */ }
            return e;
        }

        function callBridge(name, payload) {
            var fn = bridge[name];
            if (typeof fn !== 'function') return { ok: false, code: 'NO_BRIDGE' };
            try { return fn(payload) || { ok: false, code: 'EMPTY' }; }
            catch (e) { return { ok: false, code: 'IPC', error: String(e && e.message || e) }; }
        }

        // A file that failed to save is not retried on every keystroke-level
        // save for a minute — each retry ships the whole file over IPC.
        var putFailedAt = new Map();
        function put(p, dataUrl, cn, key) {
            var known = refsByData.get(dataUrl);
            if (known && confirmed.has(pair(cn, known))) {
                remember(known, dataUrl);
                stats.reused++;
                return known;
            }
            var failed = putFailedAt.get(dataUrl);
            if (failed && failed.cn === cn && now() - failed.at < 60000) { stats.putFailures++; return null; }
            var res = callBridge('caseBlobPutSync', { caseNumber: cn, mime: p.mime, base64: p.b64 });
            var pr = res && res.ok ? parseRef(res.ref) : null;
            if (pr && pr.id === p.id) {
                confirmed.add(pair(cn, res.ref));
                remember(res.ref, dataUrl);
                stats.moved++;
                return res.ref;
            }
            stats.putFailures++;
            putFailedAt.set(dataUrl, { cn: cn, at: now() });
            if (putFailedAt.size > 64) putFailedAt.delete(putFailedAt.keys().next().value);
            if (!res || res.code !== 'LOCKED') noteError('save', cn, key, res);
            return null;
        }

        var toasted = new Set();
        function announceReadFailure(e) {
            if (!win || e.code === 'LOCKED') return;
            var tag = e.caseNumber + '|' + e.code;
            if (toasted.has(tag)) return;
            toasted.add(tag);
            // viperToast renders HTML; a case number is typed by a person.
            var safeCn = String(e.caseNumber).replace(/[&<>"']/g, function (ch) {
                return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
            });
            var msg = 'Some photos or documents for case ' + safeCn
                + ' could not be loaded from its case folder (Attachments). '
                + 'If your case folders are on OneDrive or a network drive, make sure the folder is available and finished syncing, then reopen the case. Nothing has been deleted.';
            var tries = 0;
            var show = function () {
                try {
                    if (typeof win.viperToast === 'function') { win.viperToast(msg, 'warning', 15000); return; }
                    if (typeof win.showToast === 'function') { win.showToast(msg, 'warning'); return; }
                } catch (_) { /* fall through */ }
                if (++tries < 4 && timers) timers.setTimeout(show, 1500);
            };
            if (timers) timers.setTimeout(show, 0); else show();
        }

        function read(p, ref, cn, key) {
            var hit = blobs.get(ref);
            if (hit !== undefined && confirmed.has(pair(cn, ref))) {
                remember(ref, hit);
                return hit;
            }
            var res = callBridge('caseBlobReadSync', { caseNumber: cn, ref: ref });
            if (res && res.ok && typeof res.base64 === 'string') {
                var d = 'data:' + p.mime + ';base64,' + res.base64;
                confirmed.add(pair(cn, ref));
                remember(ref, d);
                stats.restored++;
                return d;
            }
            stats.readFailures++;
            announceReadFailure(noteError('load', cn, key, res));
            return null;
        }

        // Last restored text per key. Valid only while the stored string is
        // the one it was built from, so another window's write can never
        // be shadowed. Entries with failures expire quickly so a folder that
        // comes back (OneDrive finished syncing) is picked up.
        var hyd = new Map();
        var HYD_KEYS = 32;
        function cacheSet(key, raw, text, ok) {
            hyd.delete(key);
            if (text.length > 80 * 1024 * 1024) return;
            hyd.set(key, { raw: raw, text: text, ok: ok, at: now() });
            while (hyd.size > HYD_KEYS) hyd.delete(hyd.keys().next().value);
        }

        function getItem(key) {
            var raw = nativeGet.apply(null, arguments);
            if (raw === null || typeof raw !== 'string') return raw;
            var k = String(key);
            var sc = scopeOf(k);
            if (!sc || raw.indexOf(REF_PREFIX) === -1) return raw;
            var c = hyd.get(k);
            if (c && c.raw === raw && (c.ok || now() - c.at < 10000)) return c.text;
            var cn = caseNumberFor(sc.caseId);
            if (!cn) return raw;
            var r = hydrateText(raw, function (p, s) { return read(p, s, cn, k); });
            cacheSet(k, raw, r.text, r.failed === 0);
            return r.text;
        }

        function dehydrateFor(k, value) {
            var sc = scopeOf(k);
            if (!sc) return value;
            var cn = caseNumberFor(sc.caseId);
            if (!cn) return value;
            var d = dehydrateText(value, function (p, s) { return put(p, s, cn, k); });
            stats.keptInline += d.kept;
            return d.text;
        }

        // Move inline data out of every in-scope key, synchronously.
        // Compare-and-set: if the key changed while files were being
        // written (another window saved), leave it for the next sweep
        // rather than overwrite newer data with older.
        function sweepKey(k) {
            var raw = nativeGet(k);
            if (typeof raw !== 'string' || raw.indexOf('"data:') === -1) return 0;
            var text = dehydrateFor(k, raw);
            if (text === raw || text.length >= raw.length) return 0;
            if (nativeGet(k) !== raw) return 0;
            nativeSet(k, text);
            hyd.delete(k);
            return raw.length - text.length;
        }
        function scopedKeys() {
            var out = [];
            var n = 0;
            try { n = storage.length; } catch (_) { n = 0; }
            for (var i = 0; i < n; i++) {
                var k = null;
                try { k = storage.key(i); } catch (_) { k = null; }
                if (k !== null && scopeOf(k)) out.push(k);
            }
            return out;
        }
        function sweepAll(except) {
            var freed = 0;
            var keys = scopedKeys();
            for (var i = 0; i < keys.length; i++) {
                if (keys[i] === except) continue;
                try { freed += sweepKey(keys[i]); } catch (e) { noteError('sweep', '', keys[i], { code: 'SWEEP', error: String(e && e.message || e) }); }
            }
            stats.sweeps++;
            stats.sweptChars += freed;
            return freed;
        }

        function setItem(key, value) {
            if (arguments.length < 2) return nativeSet.apply(null, arguments); // native TypeError
            var k = String(key);
            var v = String(value);
            var stored = dehydrateFor(k, v);
            try {
                nativeSet(k, stored);
            } catch (err) {
                if (!isQuotaError(err)) throw err;
                // Out of room: move everything else out, then try once more.
                // If it still does not fit, the caller sees the real error.
                if (sweepAll(k) <= 0) throw err;
                nativeSet(k, stored);
            }
            if (stored !== v) cacheSet(k, stored, v, true);
            else hyd.delete(k);
        }

        // Background sweep, one key per tick so a big store does not freeze
        // the page for long.
        var sweepScheduled = false;
        function scheduleSweep(delayMs) {
            if (sweepScheduled || !timers) return false;
            sweepScheduled = true;
            timers.setTimeout(function () {
                var keys = scopedKeys();
                var freed = 0;
                var i = 0;
                var step = function () {
                    if (i >= keys.length) {
                        sweepScheduled = false;
                        stats.sweeps++;
                        stats.sweptChars += freed;
                        if (freed > 0) {
                            try { console.log('[case-blobs] moved ' + (freed / 1048576).toFixed(1) + 'M characters of photos/documents out to case folders'); } catch (_) { /* ignore */ }
                        }
                        return;
                    }
                    var k = keys[i++];
                    try { freed += sweepKey(k); } catch (e) { noteError('sweep', '', k, { code: 'SWEEP', error: String(e && e.message || e) }); }
                    timers.setTimeout(step, 25);
                };
                step();
            }, Math.max(0, delayMs || 0));
            return true;
        }

        storage.getItem = getItem;
        storage.setItem = setItem;

        var ctl = {
            getRaw: function (key) { return nativeGet(key); },
            sweepAll: function () { return sweepAll(null); },
            scheduleSweep: scheduleSweep,
            stats: function () {
                var s = {};
                Object.keys(stats).forEach(function (k) { s[k] = stats[k]; });
                s.cachedFiles = blobs.size;
                s.cachedChars = blobChars;
                return s;
            },
            errors: function () { return lastErrors.slice(); },
            caseNumberFor: caseNumberFor
        };
        _controllers.push({ storage: storage, api: ctl });
        if (opts.autoSweepMs) scheduleSweep(opts.autoSweepMs);
        return ctl;
    }

    var api = {
        __vpCaseBlobs: 1,
        REF_PREFIX: REF_PREFIX,
        FOLDER_NAME: FOLDER_NAME,
        MIN_CHARS: MIN_CHARS,
        MAX_CHARS: MAX_CHARS,
        MIME_IDS: MIME_IDS,
        SCOPE_PREFIXES: SCOPE_PREFIXES,
        scopeOf: scopeOf,
        idForMime: idForMime,
        parseDataUrl: parseDataUrl,
        parseRef: parseRef,
        makeRef: makeRef,
        dehydrateText: dehydrateText,
        hydrateText: hydrateText,
        isQuotaError: isQuotaError,
        install: function (opts) {
            var ctl = install(opts);
            // The page-level instance exposes its controller on the API so
            // callers can use VpCaseBlobs.getRaw(key) without a handle.
            if (opts && opts.window && opts.storage === opts.window.localStorage) {
                api.getRaw = ctl.getRaw;
                api.sweepAll = ctl.sweepAll;
                api.stats = ctl.stats;
                api.errors = ctl.errors;
            }
            return ctl;
        }
    };
    return api;
}));

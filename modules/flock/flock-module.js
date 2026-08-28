/* ============================================================
   FLOCK — module core  (VIPER)
   State, persistence, ingest and Connection Board hand-off.
   No rendering lives here; flock-ui.js owns the DOM.

   Storage
   -------
   Per-case, pattern-2 key: `flock_<caseId>`
       {
         version: 1,
         imports: [ ImportRecord ],
         selected: { <hitId>: true }     // queued for the Connection Board
       }

   ImportRecord
       { id, name, importedAt, source:'evidence'|'file', sourcePath,
         evidenceTag, rowCount, geoCount, plates[], plateCounts{},
         span:{startMs,endMs}|null, warnings[], hits:[ Hit ] }

   Hit shape is produced by FlockParser.parseFlockCsv — see that file.

   Why hits are stored inline rather than re-parsed on demand: an LPR
   return is the evidentiary record of where a vehicle was. If the
   detective later deletes the source CSV out of Evidence, the analysis
   in the case must not silently empty itself.
   ============================================================ */
(function () {
    'use strict';

    if (typeof window === 'undefined') return;
    if (window.FlockModule) return; // double-load guard

    var STORE_VERSION = 1;
    var MAX_HITS_PER_IMPORT = 25000; // sanity ceiling; a real return is 100s–1000s

    // ---- host-page helpers (all defined in case-detail-with-analytics.html) ----
    //
    // IMPORTANT: the case-detail page declares `currentCase` and `caseEvidence`
    // with `let` at the top level of a classic <script>. Top-level let/const go
    // into the global LEXICAL environment, NOT onto the global object — so
    // `window.currentCase` is permanently `undefined` here even though the bare
    // identifier `currentCase` resolves fine across classic scripts.
    //
    // Reading them through `window.` is what made the module report
    // "No case is open." on every direct load and find nothing in Evidence.
    // connection-board.js already uses the bare form (`typeof currentCase ===
    // 'undefined'`); this now matches it. Function declarations such as
    // _lsParse / ensureCaseModule DO land on window, so those stay as-is.
    function theCase() {
        try { if (typeof currentCase !== 'undefined' && currentCase) return currentCase; } catch (_) {}
        try { if (window.currentCase) return window.currentCase; } catch (_) {}
        return null;
    }

    function evidenceItems() {
        // Prefer the live in-memory array the Evidence tab maintains.
        try { if (typeof caseEvidence !== 'undefined' && Array.isArray(caseEvidence)) return caseEvidence; } catch (_) {}
        try { if (Array.isArray(window.caseEvidence)) return window.caseEvidence; } catch (_) {}
        // Fall back to the shared store, which is keyed by caseNumber.
        var c = theCase();
        if (!c) return [];
        var all = lsParse('viperCaseEvidence', {}) || {};
        var list = all[c.caseNumber];
        return Array.isArray(list) ? list : [];
    }

    function lsParse(key, fallback) {
        try { if (typeof _lsParse === 'function') return _lsParse(key, fallback); } catch (_) {}
        try { if (typeof window._lsParse === 'function') return window._lsParse(key, fallback); } catch (_) {}
        try { var v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; }
        catch (_) { return fallback; }
    }
    function toast(msg, kind) {
        try { (window.viperToast || window.showToast || function () {})(msg, kind || 'info'); } catch (_) {}
    }

    // Host helpers are reached bare-first, then via window. A bare identifier
    // walks the scope chain and therefore finds BOTH a top-level `function`
    // (which lands on the global object) and a top-level `let`/`const` (which
    // lands only in the global lexical environment). Going through `window.`
    // alone silently misses the latter — that is what broke this module.
    function callHost(name, args) {
        var fn = null;
        try { if (typeof window[name] === 'function') fn = window[name]; } catch (_) {}
        if (!fn) return false;
        try { fn.apply(null, args || []); return true; } catch (e) {
            console.warn('[FLOCK] host call failed:', name, (e && e.message) || e);
            return false;
        }
    }

    function activateModuleTab() {
        // Never hand-roll currentCase.modules — see the 5.1.1 data-loss bug.
        try { if (typeof ensureCaseModule === 'function') { ensureCaseModule('flock'); return true; } } catch (_) {}
        return callHost('ensureCaseModule', ['flock']);
    }

    function storeKey() {
        var c = theCase();
        return c ? ('flock_' + c.id) : null;
    }

    function uid(p) {
        return (p || 'flk') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
    }

    // ---- persistence ----------------------------------------------------
    function load() {
        var k = storeKey();
        if (!k) return { version: STORE_VERSION, imports: [], selected: {}, imagePacks: [] };
        var d = lsParse(k, null);
        if (!d || typeof d !== 'object') d = {};
        if (!Array.isArray(d.imports)) d.imports = [];
        if (!d.selected || typeof d.selected !== 'object') d.selected = {};
        if (!Array.isArray(d.imagePacks)) d.imagePacks = [];
        d.version = STORE_VERSION;
        return d;
    }

    function save(data) {
        var k = storeKey();
        if (!k) return false;
        try {
            localStorage.setItem(k, JSON.stringify(data));
            return true;
        } catch (e) {
            // QuotaExceededError is the realistic failure here — a multi-import
            // case with thousands of hits. Say so plainly instead of silently
            // dropping the import.
            console.error('[FLOCK] save failed', e);
            toast('Could not save FLOCK data — browser storage is full. Delete an old import and retry.', 'error');
            return false;
        }
    }

    // ---- import management ----------------------------------------------

    function getImports() { return load().imports; }

    function getImport(importId) {
        var d = load();
        for (var i = 0; i < d.imports.length; i++) if (d.imports[i].id === importId) return d.imports[i];
        return null;
    }

    /** Every hit across every import, each tagged with its importId. */
    function allHits() {
        var out = [];
        load().imports.forEach(function (imp) {
            (imp.hits || []).forEach(function (h) {
                out.push(Object.assign({}, h, { importId: imp.id, importName: imp.name }));
            });
        });
        out.sort(function (a, b) {
            if (a.tUtcMs == null && b.tUtcMs == null) return 0;
            if (a.tUtcMs == null) return 1;
            if (b.tUtcMs == null) return -1;
            return a.tUtcMs - b.tUtcMs;
        });
        return out;
    }

    /**
     * Parse CSV text and append it as a new import.
     * @returns {{ok:boolean, error?:string, record?:object, duplicate?:boolean}}
     */
    function addImport(text, meta) {
        if (!window.FlockParser) return { ok: false, error: 'FLOCK parser not loaded.' };
        var rows;
        try {
            rows = window.FlockParser.parseCsv(text);
        } catch (e) {
            return { ok: false, error: 'Could not read the CSV: ' + ((e && e.message) || e) };
        }
        return addImportRows(rows, meta);
    }

    /**
     * Append an import from already-tabulated rows (row 0 = header).
     * Both the CSV and the .xlsx paths land here, so the two formats
     * share one set of validation, dedupe and storage rules.
     */
    function addImportRows(rows, meta) {
        meta = meta || {};
        if (!window.FlockParser) return { ok: false, error: 'FLOCK parser not loaded.' };
        if (!theCase()) return { ok: false, error: 'No case is open.' };

        var importId = uid('flk');
        var res;
        try {
            res = window.FlockParser.parseFlockRows(rows, { idPrefix: importId });
        } catch (e) {
            return { ok: false, error: 'Parse failed: ' + ((e && e.message) || e) };
        }
        if (!res.ok) return { ok: false, error: res.error };

        if (res.hits.length > MAX_HITS_PER_IMPORT) {
            return { ok: false, error: 'That file holds ' + res.hits.length.toLocaleString() +
                ' reads, above the ' + MAX_HITS_PER_IMPORT.toLocaleString() + ' ceiling. Narrow the Flock search and re-export.' };
        }

        var d = load();

        // Re-importing the same file is a common accident (locate-in-evidence
        // after an earlier direct load). Detect it on name + row count + span
        // so we can warn instead of silently duplicating 162 pins.
        var dup = d.imports.find(function (imp) {
            return imp.name === (meta.name || '') &&
                   imp.rowCount === res.rowCount &&
                   JSON.stringify(imp.span || null) === JSON.stringify(res.span || null);
        });

        var record = {
            id: importId,
            name: meta.name || 'Flock export',
            importedAt: new Date().toISOString(),
            source: meta.source || 'file',
            format: meta.format || 'csv',
            sheetName: meta.sheetName || '',
            sourcePath: meta.sourcePath || '',
            evidenceTag: meta.evidenceTag || '',
            rowCount: res.rowCount,
            geoCount: res.geoCount,
            plates: res.plates,
            plateCounts: res.plateCounts || {},
            span: res.span,
            warnings: (res.warnings || []).concat(meta.extraWarnings || []),
            hits: res.hits
        };

        d.imports.push(record);
        if (!save(d)) return { ok: false, error: 'Storage write failed.' };

        // Light the tab up on the case the moment real data lands, using the
        // shared helper (never hand-roll currentCase.modules — see 5.1.1).
        activateModuleTab();
        try { refreshTimeline(); } catch (_) {}

        return { ok: true, record: record, duplicate: !!dup };
    }

    /**
     * Read an .xlsx/.xlsm ArrayBuffer and import the first sheet that
     * actually contains a Flock table.
     *
     * A workbook can hold several tabs (detectives often keep notes or a
     * pivot alongside the data), so we probe each in workbook order rather
     * than assuming sheet 1, and report every sheet name if none match.
     */
    function addImportWorkbook(arrayBuffer, meta) {
        meta = meta || {};
        if (!window.FlockXlsx) return Promise.resolve({ ok: false, error: 'FLOCK .xlsx reader not loaded.' });
        if (!window.FlockParser) return Promise.resolve({ ok: false, error: 'FLOCK parser not loaded.' });

        return window.FlockXlsx.readWorkbook(arrayBuffer).then(function (wb) {
            var sheets = (wb && wb.sheets) || [];
            if (!sheets.length) return { ok: false, error: 'That workbook has no sheets.' };

            var probeErr = null;
            for (var i = 0; i < sheets.length; i++) {
                var s = sheets[i];
                if (!s.rows || !s.rows.length) continue;
                var probe = window.FlockParser.parseFlockRows(s.rows, { idPrefix: 'probe' });
                if (probe.ok) {
                    var extra = [];
                    if (sheets.length > 1) extra.push('Workbook had ' + sheets.length + ' sheets; read "' + s.name + '".');
                    return addImportRows(s.rows, Object.assign({}, meta, {
                        format: 'xlsx',
                        sheetName: s.name,
                        extraWarnings: extra
                    }));
                }
                if (!probeErr) probeErr = probe.error;
            }
            return {
                ok: false,
                error: 'No sheet in that workbook looks like a Flock export. Sheets checked: ' +
                       sheets.map(function (s) { return '"' + s.name + '"'; }).join(', ') +
                       (probeErr ? ('. ' + probeErr) : '')
            };
        }, function (err) {
            return { ok: false, error: (err && err.message) || String(err) };
        });
    }

    function deleteImport(importId) {
        var d = load();
        var before = d.imports.length;
        var gone = d.imports.filter(function (i) { return i.id === importId; })[0];
        d.imports = d.imports.filter(function (i) { return i.id !== importId; });
        if (d.imports.length === before) return false;
        // Drop any queued selections that belonged to it.
        if (gone) {
            (gone.hits || []).forEach(function (h) { delete d.selected[h.id]; });
        }
        save(d);
        try { refreshTimeline(); } catch (_) {}
        return true;
    }

    // ---- selection (queue for the Connection Board) ----------------------

    function getSelected() { return load().selected || {}; }

    function isSelected(hitId) { return !!load().selected[hitId]; }

    function toggleSelect(hitId, on) {
        var d = load();
        var next = (on == null) ? !d.selected[hitId] : !!on;
        if (next) d.selected[hitId] = true; else delete d.selected[hitId];
        save(d);
        return next;
    }

    function setSelection(hitIds, on) {
        var d = load();
        (hitIds || []).forEach(function (id) {
            if (on) d.selected[id] = true; else delete d.selected[id];
        });
        save(d);
        return Object.keys(d.selected).length;
    }

    function clearSelection() {
        var d = load();
        d.selected = {};
        save(d);
    }

    function selectedHits() {
        var sel = getSelected();
        return allHits().filter(function (h) { return sel[h.id]; });
    }

    function selectedCount() { return Object.keys(getSelected()).length; }

    // ---- ingest: locate Flock exports already filed in Evidence ----------

    // Heuristic file matcher. Flock's own filename is
    // "Flock_Safety_Search_Results_<date>_<time>.csv", but agencies rename
    // exports constantly and frequently re-save them through Excel, so both
    // CSV and modern workbook formats are offered — Flock-named ones first.
    function looksLikeFlockName(name) {
        return /flock/i.test(name || '');
    }
    function isCsvName(name) {
        return /\.csv$/i.test(name || '');
    }
    function isWorkbookName(name) {
        return /\.xls[xm]$/i.test(name || '');
    }
    function isLegacyXlsName(name) {
        return /\.xls$/i.test(name || '');
    }
    function isSupportedName(name) {
        return isCsvName(name) || isWorkbookName(name);
    }
    function isImagePackName(name) {
        return /\.zip$/i.test(name || '');
    }

    // ── Image packs ──────────────────────────────────────────────────────
    // Flock delivers plate-read photos as a SEPARATE zip download from the
    // search-results spreadsheet. The two use different filename conventions
    // and must be cross-referenced:
    //
    //   spreadsheet : #100_-_N_Haven_Ave_@_HWY-10_-_SB_(Lanes_3&4)_2026-08-19T05:44:26.773Z.jpg
    //   image zip   : 14-_EB_Lake_Park_@_Ramona_Expy_2026-08-25T13-10-27.000+00-00.jpg
    //
    // A zip entry cannot contain ':', so Flock rewrites the time separators as
    // '-' and the zone as '+00-00'. Some reads also ship 2-3 photos (context
    // shot + plate crop), suffixed _1, _2 AFTER the timestamp.
    //
    // Matching on the raw filename therefore fails. The reliable key is
    // (normalized camera name + UTC second), which on the reference data
    // matched 142/162 reads with zero ambiguity — the other 20 fall outside
    // the image pack's date range, i.e. the officer pulled a narrower image
    // search than spreadsheet search. Never silently "best-guess" those.
    var NAME_TS = /(\d{4}-\d{2}-\d{2})[T_](\d{2})[:\-](\d{2})[:\-](\d{2})(?:[.,](\d{1,3}))?\s*(Z|[+-]\d{2}[:\-]?\d{2})?/;

    /** Split a Flock image filename into { ms, camera, dup }. */
    function parseImageName(name) {
        var base = String(name || '').replace(/\.[a-z0-9]+$/i, '');
        var m = base.match(NAME_TS);
        if (!m) return null;
        var ms = Date.UTC(
            +m[1].slice(0, 4), +m[1].slice(5, 7) - 1, +m[1].slice(8, 10),
            +m[2], +m[3], +m[4]
        );
        var off = m[6];
        if (off && off !== 'Z') {
            var sign = off[0] === '-' ? -1 : 1;
            var digits = off.slice(1).replace(/[:\-]/g, '');
            ms -= sign * ((+digits.slice(0, 2)) * 60 + (+digits.slice(2, 4))) * 60000;
        }
        var tail = base.slice(m.index + m[0].length);
        return {
            ms: ms,
            // Trim the separator that sits between the camera name and the
            // timestamp so the value is presentable as-is. Only '_' and
            // whitespace are stripped — a trailing '-' can be part of a real
            // camera label (e.g. "14-").
            camera: base.slice(0, m.index).replace(/[\s_]+$/, ''),
            dup: (tail.match(/_(\d+)$/) || [])[1] || '0'
        };
    }

    function camSlug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

    /** Grouping key shared by both sides: UTC second + camera slug. */
    function imageKey(ms, camera) {
        return Math.floor(ms / 1000) + '|' + camSlug(camera);
    }

    /** Key for a parsed hit (uses its own image filename, else camera+time). */
    function hitImageKey(hit) {
        if (!hit) return null;
        var p = hit.image ? parseImageName(hit.image) : null;
        if (p) return imageKey(p.ms, p.camera);
        if (hit.tUtcMs != null) return imageKey(hit.tUtcMs, hit.camera);
        return null;
    }

    /** Build { key -> [entryName, ...] } from a pack's entry list. */
    function buildPackIndex(entries) {
        var idx = {};
        (entries || []).forEach(function (name) {
            var p = parseImageName(name);
            if (!p) return;
            var k = imageKey(p.ms, p.camera);
            (idx[k] = idx[k] || []).push(name);
        });
        // Keep the numbered variants in a stable order (base shot first).
        Object.keys(idx).forEach(function (k) {
            idx[k].sort(function (a, b) {
                var pa = parseImageName(a), pb = parseImageName(b);
                return (+(pa && pa.dup || 0)) - (+(pb && pb.dup || 0)) || String(a).localeCompare(String(b));
            });
        });
        return idx;
    }

    function getImagePacks() { return load().imagePacks || []; }

    /** Every image entry available for a hit, across all attached packs. */
    function imagesForHit(hit) {
        var key = hitImageKey(hit);
        if (!key) return [];
        var out = [];
        getImagePacks().forEach(function (pack) {
            var names = (pack.index || {})[key];
            if (!names) return;
            names.forEach(function (n) { out.push({ packId: pack.id, path: pack.path, entry: n }); });
        });
        return out;
    }

    /**
     * Attach an image zip that is already filed in Evidence.
     * Listing happens in the MAIN process: the pack is ~15 MB and
     * readEvidenceFile() marshals bytes as a plain number[], which would mean
     * a 15-million-element array over IPC. Main also owns the shared
     * zip-reader (ZIP64 + Field-Security decryption).
     */
    function attachImagePack(candidate) {
        if (!(window.electronAPI && window.electronAPI.flockZipList)) {
            return Promise.resolve({ ok: false, error: 'Image-pack bridge unavailable — restart VIPER to pick up the update.' });
        }
        return window.electronAPI.flockZipList(candidate.filePath).then(function (r) {
            if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'Could not read that zip.' };
            var images = (r.entries || []).filter(function (n) { return /\.(jpe?g|png|webp)$/i.test(n); });
            if (!images.length) return { ok: false, error: 'That zip holds no images.' };

            var index = buildPackIndex(images);
            var d = load();
            d.imagePacks = d.imagePacks || [];
            // Re-attaching the same file refreshes it rather than duplicating.
            d.imagePacks = d.imagePacks.filter(function (p) { return p.path !== candidate.filePath; });
            var pack = {
                id: uid('pack'),
                name: candidate.fileName,
                path: candidate.filePath,
                evidenceTag: candidate.tag || '',
                count: images.length,
                attachedAt: new Date().toISOString(),
                index: index
            };
            d.imagePacks.push(pack);
            if (!save(d)) return { ok: false, error: 'Storage write failed.' };

            // Report coverage honestly — a partial pack is normal and the user
            // must not assume a missing photo means the read did not happen.
            var hits = allHits();
            var withImg = hits.filter(function (h) { return imagesForHit(h).length; }).length;
            return { ok: true, pack: pack, images: images.length, matched: withImg, totalHits: hits.length };
        }, function (err) {
            return { ok: false, error: (err && err.message) || String(err) };
        });
    }

    function detachImagePack(packId) {
        var d = load();
        var before = (d.imagePacks || []).length;
        d.imagePacks = (d.imagePacks || []).filter(function (p) { return p.id !== packId; });
        if (d.imagePacks.length === before) return false;
        save(d);
        return true;
    }

    /** Fetch one image as a data URL (main process reads a single entry). */
    var _imgCache = new Map();
    var IMG_CACHE_MAX = 80;
    function readImage(ref) {
        if (!ref) return Promise.resolve(null);
        var ck = ref.path + '::' + ref.entry;
        if (_imgCache.has(ck)) return Promise.resolve(_imgCache.get(ck));
        if (!(window.electronAPI && window.electronAPI.flockZipReadImage)) return Promise.resolve(null);
        return window.electronAPI.flockZipReadImage(ref.path, ref.entry).then(function (r) {
            if (!r || !r.ok || !r.dataUrl) return null;
            if (_imgCache.size >= IMG_CACHE_MAX) {
                // Cheap FIFO eviction — plenty for a scrolling card list.
                _imgCache.delete(_imgCache.keys().next().value);
            }
            _imgCache.set(ck, r.dataUrl);
            return r.dataUrl;
        }, function () { return null; });
    }

    /**
     * Scan the case's evidence items for candidate spreadsheet files.
     * @returns [{ evidenceId, tag, description, fileName, filePath, size, likely, kind }]
     */
    function findCandidatesInEvidence() {
        var out = [];
        evidenceItems().forEach(function (item) {
            (item.files || []).forEach(function (f) {
                if (!f) return;
                var isSheet = isSupportedName(f.name);
                var isPack = isImagePackName(f.name);
                if (!isSheet && !isPack) return;
                out.push({
                    evidenceId: item.id,
                    tag: item.tag || '',
                    description: item.description || item.type || '',
                    fileName: f.name,
                    filePath: f.path,
                    size: f.size || 0,
                    likely: looksLikeFlockName(f.name),
                    kind: isPack ? 'images' : (isWorkbookName(f.name) ? 'xlsx' : 'csv')
                });
            });
        });
        // Most-likely first, spreadsheets before image packs, then by name.
        out.sort(function (a, b) {
            if (a.likely !== b.likely) return a.likely ? -1 : 1;
            if ((a.kind === 'images') !== (b.kind === 'images')) return a.kind === 'images' ? 1 : -1;
            return String(b.fileName).localeCompare(String(a.fileName));
        });
        return out;
    }

    /** Read raw bytes for a file stored in the case Evidence folder. */
    function readEvidenceBytes(filePath) {
        if (!(window.electronAPI && window.electronAPI.readEvidenceFile)) {
            return Promise.reject(new Error('Evidence bridge unavailable.'));
        }
        return window.electronAPI.readEvidenceFile(filePath).then(function (bytes) {
            // IPC hands back a plain byte array (already decrypted when Field
            // Security is on).
            return (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes || []);
        });
    }

    /** Read a file already stored in the case Evidence folder, as text. */
    function readEvidenceCsv(filePath) {
        return readEvidenceBytes(filePath).then(function (u8) {
            try { return new TextDecoder('utf-8').decode(u8); }
            catch (_) {
                var s = '';
                for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
                return s;
            }
        });
    }

    function importFromEvidence(candidate) {
        var meta = {
            name: candidate.fileName,
            source: 'evidence',
            sourcePath: candidate.filePath,
            evidenceTag: candidate.tag
        };
        if (isWorkbookName(candidate.fileName)) {
            return readEvidenceBytes(candidate.filePath).then(function (u8) {
                // Hand the reader a standalone ArrayBuffer — the IPC array may
                // be a view into a larger pooled buffer.
                var ab = u8.buffer.byteLength === u8.byteLength
                    ? u8.buffer
                    : u8.slice().buffer;
                return addImportWorkbook(ab, meta);
            });
        }
        return readEvidenceCsv(candidate.filePath).then(function (text) {
            return addImport(text, meta);
        });
    }

    /** Read a File/Blob chosen through an <input type="file"> or drag-drop. */
    function importFromFile(file) {
        if (!file) return Promise.resolve({ ok: false, error: 'No file supplied.' });

        if (isWorkbookName(file.name)) {
            return file.arrayBuffer().then(function (ab) {
                return addImportWorkbook(ab, { name: file.name, source: 'file' });
            }, function () {
                return { ok: false, error: 'Could not read that workbook.' };
            });
        }

        if (isLegacyXlsName(file.name)) {
            return Promise.resolve({ ok: false, error:
                'That is a legacy .xls workbook, which VIPER cannot read. Open it in Excel and use File \u2192 Save As to produce a .xlsx or .csv.' });
        }

        if (!isCsvName(file.name)) {
            return Promise.resolve({ ok: false, error: 'Choose the .csv or .xlsx Flock produced. ' +
                (/\.zip$/i.test(file.name) ? 'This looks like a ZIP — extract it first.' : '') });
        }

        return new Promise(function (resolve) {
            var fr = new FileReader();
            fr.onerror = function () { resolve({ ok: false, error: 'Could not read that file.' }); };
            fr.onload = function () {
                resolve(addImport(String(fr.result || ''), { name: file.name, source: 'file' }));
            };
            fr.readAsText(file, 'utf-8');
        });
    }

    // ---- Connection Board hand-off --------------------------------------

    /**
     * Push chosen hits onto the case Connection Board as LPR pins.
     * Uses ConnectionBoard.addPins() when available (handles the board being
     * open); otherwise writes the board store directly so the pins are there
     * the next time it opens.
     */
    function pushToConnectionBoard(hits) {
        hits = (hits || []).filter(Boolean);
        if (!hits.length) return { ok: false, error: 'Nothing selected.' };
        var c = theCase();
        if (!c) return { ok: false, error: 'No case is open.' };

        var specs = hits.map(function (h) { return pinSpecForHit(h); });

        if (window.ConnectionBoard && typeof window.ConnectionBoard.addPins === 'function') {
            var r = window.ConnectionBoard.addPins(specs);
            return { ok: true, added: r.added, updated: r.updated };
        }

        // Fallback: direct store write, mirroring connection-board.js schema.
        var key = 'connectionBoard_' + c.id;
        var board = lsParse(key, null);
        if (!board || typeof board !== 'object') board = { pins: [], strings: [], notes: [], view: { mode: 'map' } };
        board.pins = board.pins || []; board.strings = board.strings || []; board.notes = board.notes || [];
        var added = 0, updated = 0;
        specs.forEach(function (spec) {
            var found = null;
            for (var i = 0; i < board.pins.length; i++) {
                if (board.pins[i].sourceType === spec.sourceType && String(board.pins[i].sourceId) === String(spec.sourceId)) { found = board.pins[i]; break; }
            }
            if (found) {
                if (!found._labelOverride) found.label = spec.label;
                found.data = spec.data;
                if (!found._posManual) { found.lat = spec.lat; found.lng = spec.lng; }
                updated++;
            } else {
                board.pins.push({
                    id: 'pin_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7),
                    type: spec.type, label: spec.label,
                    lat: spec.lat, lng: spec.lng, x: null, y: null,
                    color: spec.color, photo: '', manual: false,
                    sourceType: spec.sourceType, sourceId: spec.sourceId,
                    address: spec.address || '', data: spec.data || {}
                });
                added++;
            }
        });
        try { localStorage.setItem(key, JSON.stringify(board)); }
        catch (e) { return { ok: false, error: 'Could not write to the Connection Board store.' }; }
        return { ok: true, added: added, updated: updated };
    }

    /** Translate one Flock hit into a Connection Board pin spec. */
    function pinSpecForHit(h) {
        var when = formatHitTime(h);
        var dirLabel = h.dir ? ((window.FlockParser && window.FlockParser.DIR_LABEL[h.dir]) || h.dir) : '';
        var descr = [h.color, h.make, h.body].filter(Boolean).join(' ');
        return {
            type: 'lpr',
            // Board labels are tight — plate + short time reads best on a pin.
            label: h.plate + ' · ' + shortHitTime(h),
            lat: h.lat, lng: h.lng,
            color: '#06b6d4',
            // A downscaled plate-read photo when the image pack supplied one.
            // The UI layer attaches this as _photo; full-size shots stay in
            // the zip so the board store cannot blow the localStorage quota.
            photo: h._photo || '',
            sourceType: 'flock',
            sourceId: h.id,
            address: h.camera || '',
            data: {
                plate: h.plate,
                state: h.state,
                datetime: when,
                camera: h.camera,
                network: h.network,
                direction: dirLabel,
                vehicle: descr,
                notes: [
                    'Flock LPR read',
                    h.camera ? 'Camera: ' + h.camera : '',
                    h.network ? 'Network: ' + h.network : '',
                    dirLabel ? 'Direction: ' + dirLabel : '',
                    descr ? 'Vehicle (classifier): ' + descr : '',
                    h.identifiers ? 'Identifiers: ' + h.identifiers : ''
                ].filter(Boolean).join('\n'),
                source: 'flock',
                sourceTab: 'flock',
                importId: h.importId || '',
                tUtcMs: h.tUtcMs
            }
        };
    }

    // ---- time formatting (shared with the UI) ---------------------------

    /**
     * Full display stamp. Flock reports LOCAL time at the camera; we show
     * that verbatim (with its zone) because that is what appears in the
     * report and the subpoena, and add the viewer-local rendering only when
     * we had to derive it ourselves.
     */
    function formatHitTime(h) {
        if (!h) return '';
        if (h.localDate && h.localTime) return h.localDate + ' ' + h.localTime;
        if (h.tUtcMs != null) {
            try { return new Date(h.tUtcMs).toLocaleString(); } catch (_) {}
        }
        return h.localDate || '(no timestamp)';
    }

    function shortHitTime(h) {
        if (!h || h.tUtcMs == null) return h && h.localDate ? h.localDate : '?';
        try {
            return new Date(h.tUtcMs).toLocaleString(undefined, {
                month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit'
            });
        } catch (_) { return String(h.localDate || ''); }
    }

    // ---- case timeline ---------------------------------------------------
    // 162 reads would bury every other event, so the timeline gets ONE span
    // per plate per import (first read -> last read) rather than one per hit.
    function refreshTimeline() {
        var gen = null;
        try { if (typeof generateAutoTimelineEvents === 'function') gen = generateAutoTimelineEvents; } catch (_) {}
        if (!gen) { try { if (typeof window.generateAutoTimelineEvents === 'function') gen = window.generateAutoTimelineEvents; } catch (_) {} }
        if (!gen) return;
        try { gen(); } catch (_) { return; }
        try {
            var render = null;
            try { if (typeof renderTimelineSection === 'function') render = renderTimelineSection; } catch (_) {}
            if (!render) { try { if (typeof window.renderTimelineSection === 'function') render = window.renderTimelineSection; } catch (_) {} }
            if (!render) return;
            var host = document.getElementById('timelineSectionHost');
            if (!host) return;
            host.innerHTML = render();
            try { if (typeof syncTimelineScroll === 'function') { syncTimelineScroll(); return; } } catch (_) {}
            try { if (typeof window.syncTimelineScroll === 'function') window.syncTimelineScroll(); } catch (_) {}
        } catch (e) {
            console.warn('[FLOCK] timeline refresh failed:', (e && e.message) || e);
        }
    }

    /**
     * Timeline event specs for this case, consumed by
     * generateAutoTimelineEvents() in case-detail-with-analytics.html.
     */
    function timelineEvents() {
        var out = [];
        load().imports.forEach(function (imp) {
            (imp.plates || []).forEach(function (plate) {
                var hs = (imp.hits || []).filter(function (h) { return h.plate === plate && h.tUtcMs != null; });
                if (!hs.length) return;
                var startMs = hs[0].tUtcMs, endMs = hs[hs.length - 1].tUtcMs;
                var cams = {};
                hs.forEach(function (h) { if (h.camera) cams[h.camera] = 1; });
                out.push({
                    id: 'tl_auto_flock_' + imp.id + '_' + plate,
                    startMs: startMs,
                    endMs: (endMs > startMs) ? endMs : null,
                    title: 'LPR: ' + plate + ' — ' + hs.length + ' read' + (hs.length === 1 ? '' : 's'),
                    description: [
                        'Flock ALPR return (' + imp.name + ')',
                        Object.keys(cams).length + ' camera(s)',
                        hs[0].network ? 'e.g. ' + hs[0].network : ''
                    ].filter(Boolean).join(' · '),
                    plate: plate,
                    importId: imp.id,
                    count: hs.length
                });
            });
        });
        return out;
    }

    // ---- summary for the tab badge / overview ---------------------------
    function itemCount() {
        var n = 0;
        load().imports.forEach(function (i) { n += (i.hits || []).length; });
        return n;
    }

    window.FlockModule = {
        // storage
        load: load, save: save, storeKey: storeKey,
        // imports
        getImports: getImports, getImport: getImport, allHits: allHits,
        addImport: addImport, addImportRows: addImportRows, addImportWorkbook: addImportWorkbook,
        deleteImport: deleteImport,
        // ingest
        findCandidatesInEvidence: findCandidatesInEvidence,
        importFromEvidence: importFromEvidence,
        importFromFile: importFromFile,
        readEvidenceCsv: readEvidenceCsv,
        readEvidenceBytes: readEvidenceBytes,
        isCsvName: isCsvName, isWorkbookName: isWorkbookName, isSupportedName: isSupportedName,
        isImagePackName: isImagePackName,
        // image packs
        getImagePacks: getImagePacks, attachImagePack: attachImagePack,
        detachImagePack: detachImagePack, imagesForHit: imagesForHit, readImage: readImage,
        parseImageName: parseImageName, buildPackIndex: buildPackIndex,
        imageKey: imageKey, hitImageKey: hitImageKey,
        // selection
        getSelected: getSelected, isSelected: isSelected, toggleSelect: toggleSelect,
        setSelection: setSelection, clearSelection: clearSelection,
        selectedHits: selectedHits, selectedCount: selectedCount,
        // board
        pushToConnectionBoard: pushToConnectionBoard, pinSpecForHit: pinSpecForHit,
        // misc
        formatHitTime: formatHitTime, shortHitTime: shortHitTime,
        timelineEvents: timelineEvents, itemCount: itemCount,
        refreshTimeline: refreshTimeline
    };
})();

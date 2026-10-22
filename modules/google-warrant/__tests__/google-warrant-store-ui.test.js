/**
 * Google Warrant — large-return renderer side + store safety (Phase B).
 *
 *   node modules/google-warrant/__tests__/google-warrant-store-ui.test.js
 *
 * Covers: the store's temp-name write / rename, failed re-import safety,
 * stale .importing + overflow cleanup, which files "Open" may launch, the
 * module's store-aware totals / merge / delete / quota / flag cache, the
 * Google Warrant tab's paged Location table + sampled map, Files from the
 * case folder, the Overview "large return" notice, and Settings → Crash Log.
 *
 * better-sqlite3 is built for Electron's ABI, so under plain node this file
 * re-runs itself with ELECTRON_RUN_AS_NODE=1.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');

try {
    const D = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    new D(':memory:').close();
} catch (e) {
    if (!process.versions.electron) {
        const exe = path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
        const r = cp.spawnSync(exe, [__filename], { env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }), stdio: 'inherit' });
        process.exit(r.status == null ? 2 : r.status);
    }
    throw e;
}

const gwStore = require(path.join(ROOT, 'modules', 'google-warrant', 'google-warrant-store.js'));

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.log('FAIL', m); } }
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-storeui-'));
const tick = () => new Promise(r => setImmediate(r));

function email(i) {
    return { id: `<m${i}@x>`, from: `a${i}@x.com`, to: 'b@x.com', subject: 'S' + i, date: '2024-01-01T00:00:00Z', textBody: 'body ' + i };
}

(async () => {
    // ═══ 1. Store: temp name, rename, failed re-import, cleanup ═══
    {
        const dir = path.join(TMP, 'store');
        const key = 'ret-abc';
        const final = path.join(dir, key + '.sqlite');
        const work = final + '.importing';

        const w = gwStore.openWriter(dir, key);
        for (let i = 0; i < 5; i++) w.addEmail(email(i));
        ok(fs.existsSync(work), 'writer writes to <key>.sqlite.importing');
        ok(!fs.existsSync(final), 'final .sqlite does not exist until finish()');
        w.finish();
        ok(fs.existsSync(final) && !fs.existsSync(work), 'finish() renames .importing → .sqlite');
        ok(!fs.existsSync(work + '-wal') && !fs.existsSync(work + '-shm'), 'no -wal/-shm left beside the work file');
        ok(gwStore.readEmailPage(dir, { keys: [key] }).total === 5, 'finished store readable (5 e-mails)');

        // A failed re-import must leave the previous store alone.
        const w2 = gwStore.openWriter(dir, key);
        for (let i = 0; i < 9; i++) w2.addEmail(email(100 + i));
        w2.abort();
        ok(fs.existsSync(final) && !fs.existsSync(work), 'abort() removes .importing, keeps previous .sqlite');
        ok(gwStore.readEmailPage(dir, { keys: [key] }).total === 5, 'previous store still has its 5 e-mails after failed re-import');

        // A crash mid-import leaves a junk .importing — the next writer must start clean.
        fs.writeFileSync(work, 'not a database');
        let threw = null;
        try { const w3 = gwStore.openWriter(dir, key); w3.addEmail(email(7)); w3.finish(); } catch (e) { threw = e; }
        ok(!threw, 'stale .importing from a crash does not break the next import' + (threw ? ': ' + threw.message : ''));
        ok(gwStore.readEmailPage(dir, { keys: [key] }).total === 1, 'successful re-import replaces the store (1 e-mail)');

        // Overflow: the parser writes to a staging folder; finish() swaps it in,
        // abort() drops it and keeps the previous import's overflow.
        const ov = path.join(dir, key + '.overflow');
        fs.mkdirSync(ov, { recursive: true });
        fs.writeFileSync(path.join(ov, 'myActivity.ndjson'), '{"old":1}\n');
        const w4 = gwStore.openWriter(dir, key);
        ok(w4.overflowKey === key + '.importing', 'writer exposes a staging overflowKey');
        const stage = path.join(dir, w4.overflowKey + '.overflow');
        ok(fs.existsSync(path.join(ov, 'myActivity.ndjson')), 'starting a re-import keeps the previous overflow');
        fs.mkdirSync(stage, { recursive: true });
        fs.writeFileSync(path.join(stage, 'myActivity.ndjson'), '{"bad":1}\n');
        w4.abort();
        ok(fs.readFileSync(path.join(ov, 'myActivity.ndjson'), 'utf8').includes('old'), 'failed re-import keeps the previous overflow NDJSON');
        ok(!fs.existsSync(stage), 'abort() removes the staging overflow folder');
        fs.mkdirSync(stage, { recursive: true });
        fs.writeFileSync(path.join(stage, 'stale.ndjson'), '{}\n');
        const w5 = gwStore.openWriter(dir, key);
        ok(!fs.existsSync(path.join(stage, 'stale.ndjson')), 'stale staging overflow from a crash is cleared at start');
        fs.mkdirSync(stage, { recursive: true });
        fs.writeFileSync(path.join(stage, 'locations.ndjson'), '{"new":1}\n');
        w5.finish();
        ok(!fs.existsSync(path.join(ov, 'myActivity.ndjson')) && fs.readFileSync(path.join(ov, 'locations.ndjson'), 'utf8').includes('new'), 'successful re-import replaces overflow with the new one');
        ok(!fs.existsSync(stage), 'no staging folder left after finish()');
        const w6 = gwStore.openWriter(dir, key); w6.finish();
        ok(!fs.existsSync(ov), 're-import with no overflow removes the old overflow');
        fs.mkdirSync(ov, { recursive: true });
        fs.writeFileSync(path.join(ov, 'a.ndjson'), '{}\n');
        fs.mkdirSync(stage, { recursive: true });
        fs.writeFileSync(path.join(stage, 'a.ndjson'), '{}\n');
        fs.writeFileSync(work, 'x');
        ok(gwStore.deleteStores(dir, [key]) === 1, 'deleteStores reports 1 store deleted');
        ok(!fs.existsSync(final) && !fs.existsSync(work) && !fs.existsSync(ov) && !fs.existsSync(stage), 'deleteStores removes .sqlite, .importing, overflow and staging overflow');

        // Overflow cleanup only touches *.ndjson — anything else keeps the folder.
        fs.mkdirSync(ov, { recursive: true });
        fs.writeFileSync(path.join(ov, 'b.ndjson'), '{}\n');
        fs.writeFileSync(path.join(ov, 'keep.txt'), 'not ours');
        gwStore.deleteStores(dir, [key]);
        ok(fs.existsSync(path.join(ov, 'keep.txt')) && !fs.existsSync(path.join(ov, 'b.ndjson')), 'overflow cleanup leaves non-NDJSON files alone');
        ok(gwStore.deleteStores(dir, ['../evil', '.hidden']) === 0, 'deleteStores ignores invalid keys');
    }

    // ═══ 2. What "Open" may launch ═══
    {
        for (const n of ['a.pdf', 'B.JPG', 'c.docx', 'd.mp4', 'e.txt', 'f.xlsx'])
            ok(gwStore.canOpenDirectly(n), 'canOpenDirectly allows ' + n);
        for (const n of ['a.exe', 'b.bat', 'c.lnk', 'd.js', 'e.html', 'f.docm', 'g.ps1', 'h.vbs', 'i.scr', 'noext', 'x.pdf.exe', ''])
            ok(!gwStore.canOpenDirectly(n), 'canOpenDirectly refuses ' + (n || '(empty)'));
    }

    // ═══ 3. Renderer sandbox: module + UI ═══
    const modSrc = fs.readFileSync(path.join(ROOT, 'modules', 'google-warrant', 'google-warrant-module.js'), 'utf8');
    const uiSrc = fs.readFileSync(path.join(ROOT, 'modules', 'google-warrant', 'google-warrant-ui.js'), 'utf8');
    const flagsSrc = fs.readFileSync(path.join(ROOT, 'modules', '_shared', 'warrant-flags.js'), 'utf8');

    function makeEl(id) {
        const cls = new Set(['hidden']);
        return { id, innerHTML: '', textContent: '', style: {}, value: '', _leaflet_id: undefined,
            classList: { add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c), toggle: (c, on) => { if (on === undefined ? !cls.has(c) : on) cls.add(c); else cls.delete(c); } },
            querySelector: () => makeEl('q'), querySelectorAll: () => [], appendChild() {}, remove() {}, addEventListener() {}, setAttribute() {} };
    }
    function makeSandbox() {
        const els = {};
        const calls = [];
        const timers = [];
        const store = new Map();
        const toasts = [];
        const sb = {
            console, JSON, Math, Date, Object, Array, String, Number, Set, Map, Promise, Error, RegExp, isNaN, isFinite, parseInt, parseFloat,
            setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout() {},
            localStorage: {
                getItem: k => store.has(k) ? store.get(k) : null,
                setItem: (k, v) => { if (sb.__quota) { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; } store.set(k, String(v)); },
                removeItem: k => store.delete(k),
            },
            document: {
                readyState: 'complete',
                getElementById: id => els[id] || null,
                querySelectorAll: () => [],
                createElement: () => makeEl('x'),
                addEventListener() {}, removeEventListener() {},
                body: { appendChild() {} },
            },
            viperToast: (m, t) => toasts.push([m, t]),
        };
        sb.window = sb; sb.globalThis = sb;
        sb.electronAPI = {
            googleWarrantStoreDelete: async (a) => { calls.push(['delete', a]); return { success: true }; },
            googleWarrantOpenMedia: async (a) => { calls.push(['open', a]); return { success: true }; },
            googleWarrantEmail: async (a) => { calls.push(['email', a]); return { success: true, email: Object.assign(email(1), { id: 'm1', textBody: 'F'.repeat(5000) }) }; },
            googleWarrantGetMediaUrl: async (a) => { calls.push(['url', a]); return { success: true, fileUrl: 'viper-media://t/1' }; },
            googleWarrantReadMedia: async (a) => { calls.push(['read', a]); return { success: true, mimeType: 'image/png', data: 'QQ==' }; },
            googleWarrantLocations: async (a) => {
                calls.push(['loc', a]);
                if (a.sample) return { success: true, total: 90000, sampled: true, step: 5, rows: [{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }, { lat: 5, lng: 6 }] };
                return { success: true, total: 1234, offset: a.offset, limit: a.limit, rows: [{ timestamp: 'T' + a.offset, lat: 10.5, lng: -20.25, accuracy: 7, source: '<GPS>' }, { timestamp: 'T2', lat: 1, lng: 2 }] };
            },
        };
        vm.createContext(sb);
        vm.runInContext(flagsSrc, sb, { filename: 'warrant-flags.js' });
        vm.runInContext(modSrc, sb, { filename: 'google-warrant-module.js' });
        vm.runInContext(uiSrc, sb, { filename: 'google-warrant-ui.js' });
        const runTimers = async () => { for (let n = 0; n < 5; n++) { const t = timers.splice(0); for (const f of t) f(); await tick(); await tick(); } };
        return { sb, els, calls, toasts, runTimers };
    }
    const storeImp = (over) => Object.assign({
        id: 'i1', fileName: 'r.zip', accountEmail: 'sus@x.com',
        store: { keys: ['k1'], perKey: { k1: { emailCount: 50000, emailDuplicates: 3, locationCount: 90000 } }, emailCount: 50000, emailDuplicates: 3, locationCount: 90000 },
        emails: [{ id: 'p1', subject: 'preview', date: '2024-01-01' }],
        locationRecords: [{ lat: 9, lng: 9, timestamp: 'PREVIEW' }],
        legacyEmails: [], legacyLocationRecords: [],
        semanticLocations: [{ type: 'placeVisit', name: '<img src=x onerror=alert(1)>', address: 'A & B', lat: 1, lng: 1, startTime: '2024' }],
        driveFiles: [], flagged: {},
    }, over || {});

    // ── module ──
    {
        const { sb, calls, toasts } = makeSandbox();
        const M = sb.window.GoogleWarrantModule;
        ok(typeof M === 'function' && typeof sb.window.GoogleWarrantUI === 'function', 'renderer classes load in a sandbox');
        const m = new M('c1', 'CASE-1', 'Case');
        const s = storeImp({ legacyEmails: [{ id: 'L1' }], legacyLocationRecords: [{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }] });
        ok(m.hasStore(s) && !m.hasStore({ store: { keys: [] } }) && !m.hasStore(null), 'hasStore needs a non-empty key list');
        ok(m.emailTotal(s) === 50001 && m.locationTotal(s) === 90002, 'store totals = store count + legacy inline rows');
        ok(m.emailTotal({ emails: [1, 2] }) === 2 && m.locationTotal({ locationRecords: [1] }) === 1, 'inline totals = array length');

        // merge: store base + inline (older VIPER) incoming
        const inline = { id: 'i2', sourceFiles: ['b.zip'], emails: [{ id: 'x1' }, { id: 'x2' }], locationRecords: [{ lat: 5, lng: 5 }], truncated: { myActivity: 10 }, oversizeFiles: [{ name: 'o.html' }] };
        const mg = m._mergeImports(Object.assign({ sourceFiles: ['a.zip'], truncated: { myActivity: 5 } }, storeImp()), inline);
        ok(mg.store.emailCount === 50000 && mg.store.locationCount === 90000, 'merge keeps store counts');
        ok(mg.legacyEmails.length === 2 && mg.legacyLocationRecords.length === 1, 'inline part kept as legacy rows');
        ok(mg.emails.length === 1 && mg.emails[0].id === 'p1', 'emails stay the store preview only');
        ok(mg.truncated.myActivity === 15 && mg.oversizeFiles.length === 1, 'truncated counts summed, oversize files concatenated');
        ok(m.emailTotal(mg) === 50002, 'merged total = store + legacy');
        // re-importing the same part replaces its numbers (no double counting)
        const again = m._mergeImports(mg, Object.assign(storeImp(), { store: { keys: ['k1'], perKey: { k1: { emailCount: 50010, emailDuplicates: 0, locationCount: 1 } } } }));
        ok(again.store.emailCount === 50010 && again.store.locationCount === 1, 're-imported part replaces its counts, not adds');
        const two = m._mergeImports(storeImp(), Object.assign(storeImp(), { store: { keys: ['k2'], perKey: { k2: { emailCount: 7, emailDuplicates: 0, locationCount: 3 } } } }));
        ok(two.store.keys.join() === 'k1,k2' && two.store.emailCount === 50007 && two.store.locationCount === 90003, 'two store parts: keys united, counts summed');

        // delete: keep a store another import still uses
        m.imports = [storeImp({ id: 'a' }), storeImp({ id: 'b' })];
        m.deleteImport('a');
        await tick();
        ok(!calls.some(c => c[0] === 'delete'), 'store kept while another import uses the key');
        m.deleteImport('b');
        await tick();
        const del = calls.find(c => c[0] === 'delete');
        ok(del && del[1].caseNumber === 'CASE-1' && del[1].keys.join() === 'k1', 'last import removed → store delete for its key');
        m.imports = [{ id: 'z', emails: [] }];
        const before = calls.length;
        m.deleteImport('z');
        await tick();
        ok(calls.length === before, 'inline import delete makes no store call');

        // quota
        m.ui = { _toast: (msg, t) => toasts.push([msg, t]) };
        sb.__quota = true;
        ok(m.saveData() === false, 'saveData returns false when storage is full');
        ok(/storage for case data is full/.test(m.lastSaveError || '') && toasts.some(t => /full/.test(t[0]) && t[1] === 'error'), 'quota → clear message + error toast');
        sb.__quota = false;
        ok(m.saveData() === true && m.lastSaveError === null, 'saveData recovers and clears the error');

        // flagged store e-mail: full body cached, used by _resolveFlagged
        const fi = storeImp({ flagged: { emails: ['m1'] }, emails: [{ id: 'm1', subject: 'preview', snippet: 'short' }] });
        m.imports = [fi];
        await m.cacheFlaggedEmail(fi, { id: 'm1', key: 'k1', seq: 4, snippet: 'short' });
        const ec = calls.find(c => c[0] === 'email');
        ok(ec && ec[1].key === 'k1' && ec[1].seq === 4 && ec[1].caseNumber === 'CASE-1', 'cacheFlaggedEmail fetches the full e-mail by key/seq');
        ok(fi.flaggedEmailCache.m1.textBody.length === 2000, 'cached body capped at 2,000 characters');
        const out = m._resolveFlagged(fi);
        ok(out.emails.length === 1 && out.emails[0].textBody === 'F'.repeat(2000), 'Push to Evidence uses the cached full body, not the preview');

        await m.openMedia('Drive/a.pdf', 1);
        const oc = calls.filter(c => c[0] === 'open').pop();
        ok(oc && oc[1].relPath === 'Drive/a.pdf' && oc[1].reveal === true && oc[1].caseNumber === 'CASE-1', 'openMedia passes caseNumber, relPath, reveal:boolean');
    }

    // ── UI: nav, Location, map ──
    {
        const { sb, els, calls, runTimers } = makeSandbox();
        const m = new sb.window.GoogleWarrantModule('c1', 'CASE-1', 'Case');
        const ui = new sb.window.GoogleWarrantUI('cont', m);
        m.ui = ui; sb.googleWarrantUI = ui;
        const imp = storeImp({ legacyLocationRecords: [{ lat: 7, lng: 8, timestamp: 'LEGACY' }] });
        m.imports = [imp];

        const nav = ui._renderNav(imp);
        ok(/50,000/.test(nav) && /90,00[0-9]/.test(nav), 'nav badges use store totals (50,000 e-mails / 90,000+ points)');

        ui.activeSection = 'location';
        let html = ui._renderLocation(imp);
        ok(/id="gwp-loc-table"/.test(html) && /Loading location records/.test(html), 'store Location renders a paged table container');
        ok(!/PREVIEW/.test(html), 'preview points are not shown as if they were the whole table');
        ok(/LEGACY/.test(html) && /from an earlier import/.test(html), 'earlier inline points shown in their own card');
        ok(/90,001 raw points/.test(html), 'header counts every point (store + legacy)');
        ok(/&lt;img src=x onerror=alert\(1\)&gt;/.test(html) && !/<img src=x/.test(html) && /A &amp; B/.test(html), 'place visit name/address escaped');

        els['gwp-loc-table'] = makeEl('gwp-loc-table');
        await runTimers();
        const lc = calls.filter(c => c[0] === 'loc' && !c[1].sample);
        ok(lc.length === 1 && lc[0][1].offset === 0 && lc[0][1].limit === 500 && lc[0][1].keys.join() === 'k1', 'table loads page 1 (offset 0, limit 500) from the store');
        const t = els['gwp-loc-table'].innerHTML;
        ok(/1–2 of 1,234/.test(t) && /10\.500000/.test(t) && /-20\.250000/.test(t), 'table shows range, total and coordinates');
        ok(/&lt;GPS&gt;/.test(t), 'table cells escaped');
        ui.locPage(1);
        await runTimers();
        const lc2 = calls.filter(c => c[0] === 'loc' && !c[1].sample).pop();
        ok(lc2[1].offset === 500, 'Next loads offset 500');
        ui.locPage(-1); ui.locPage(-1);
        await runTimers();
        ok(ui._loc.offset === 0, 'Prev stops at the first page');

        // map: sampled points + legacy, with a note
        const markers = [];
        sb.L = {
            map: () => ({ setView() { return this; }, fitBounds() {}, remove() {}, addLayer() {} }),
            tileLayer: () => ({ addTo() {} }),
            layerGroup: () => ({ addTo() {} }),
            circleMarker: (ll) => { markers.push(ll); return { addTo() {} }; },
            marker: (ll) => ({ addTo() { return { bindPopup: (h) => { markers.popup = h; } }; } }),
        };
        els['gwp-location-map'] = makeEl('gwp-location-map');
        els['gwp-map-note'] = makeEl('gwp-map-note');
        ui.initLocationMap(imp);
        ok(/Loading map points/.test(els['gwp-map-note'].textContent), 'map waits for the sample');
        await runTimers();
        const sc = calls.find(c => c[0] === 'loc' && c[1].sample);
        ok(sc && sc[1].sample === 20000, 'map asks the store for a 20,000-point sample');
        ok(markers.length === 4, 'map draws sampled points + legacy points (3 + 1)');
        ok(/3 evenly spaced points out of 90,000/.test(els['gwp-map-note'].textContent), 'map note says it is a sample');
        ok(/&lt;img/.test(markers.popup || '') && !/<img src=x/.test(markers.popup || ''), 'map popup escaped');
        const sampleCalls = calls.filter(c => c[0] === 'loc' && c[1].sample).length;
        ui.initLocationMap(imp);
        ok(calls.filter(c => c[0] === 'loc' && c[1].sample).length === sampleCalls, 'sample cached — redrawing the map does not re-query');

        // inline (older) import still renders its own rows
        const inl = { id: 'n1', locationRecords: [{ lat: 1.5, lng: 2.5, timestamp: 'INLINE' }], semanticLocations: [] };
        m.imports = [inl];
        html = ui._renderLocation(inl);
        ok(/INLINE/.test(html) && /1\.500000/.test(html) && !/gwp-loc-table/.test(html), 'inline import renders its rows directly');

        // render() wires the map
        sb.document.getElementById = (id) => id === 'cont' ? makeEl('cont') : (els[id] || null);
        const timersBefore = calls.length;
        ui.activeSection = 'location';
        ui.render();
        ok(typeof ui._afterSectionRender === 'function' && /this\._afterSectionRender\(\);\s*\}\s*\n\s*renderEvidenceBar/.test(uiSrc), 'render() calls _afterSectionRender (map is drawn on first open)');
        void timersBefore;
    }

    // ── UI: Files, Overview notice, Timeline, globals ──
    {
        const { sb, els, calls, runTimers } = makeSandbox();
        const m = new sb.window.GoogleWarrantModule('c1', 'CASE-1', 'Case');
        const ui = new sb.window.GoogleWarrantUI('cont', m);
        m.ui = ui; sb.googleWarrantUI = ui; sb.googleWarrantModule = m;
        const drive = [
            { _isFile: true, name: 'p<b>.jpg', mimeType: 'image/jpeg', size: 1000, relPath: 'Drive/p.jpg' },
            { _isFile: true, name: 'big.jpg', mimeType: 'image/jpeg', size: 40 * 1048576, relPath: 'Drive/big.jpg' },
            { _isFile: true, name: 'v.mp4', mimeType: 'video/mp4', size: 5, relPath: 'Drive/v.mp4' },
            { _isFile: true, name: 'doc.pdf', mimeType: 'application/pdf', size: 5, relPath: 'Drive/doc.pdf' },
            { _isFile: true, name: 'song.mp3', mimeType: 'audio/mpeg', size: 5, relPath: 'Drive/song.mp3' },
            { _isFile: true, name: 'tool.exe', mimeType: 'application/octet-stream', size: 5, relPath: 'Drive/tool.exe' },
            { _isFile: true, name: 'lost.docx', mimeType: 'application/msword', size: 5, relPath: null, stub: true },
        ];
        const imp = storeImp({ driveFiles: drive, truncated: { myActivity: 1200, 'googlePay.transactions': 4 }, oversizeFiles: [{ category: 'MyActivity.MyActivity', name: 'MyActivity.html', size: 900 * 1048576, relPath: '_oversize/MyActivity.MyActivity/MyActivity.html' }, { category: 'X', name: 'nosave.html', size: 1, relPath: null }] });
        m.imports = [imp];

        const f = ui._renderFiles(imp);
        ok(!/base64,undefined/.test(f) && !/f\.data/.test(f), 'Files never builds data: URLs from missing base64');
        ok(/data-rel="Drive\/p\.jpg"/.test(f), 'photo thumb loads from the case folder');
        ok(/data-rel=""[^>]*><div class="gwp-photo-loading">🖼️/.test(f), 'photos over 25 MB get no thumbnail read');
        ok(/p&lt;b&gt;\.jpg/.test(f) && !/p<b>\.jpg/.test(f), 'file names escaped');
        ok(/openDriveFile\('pdf', 0, false\)/.test(f) && /openDriveFile\('pdf', 0, true\)/.test(f), 'PDF gets Open + Show in folder');
        ok(/openDriveFile\('other', 0, true\)/.test(f) && !/openDriveFile\('other', 0, false\)/.test(f), '.exe gets Show in folder only — no Open');
        ok(/openDriveVideo\(0\)/.test(f) && /playDriveAudio\(0\)/.test(f), 'video/audio played on demand');
        ok(/not saved/.test(f), 'file that could not be saved is labelled');

        await ui.openDriveFile('pdf', 0, false);
        let oc = calls.filter(c => c[0] === 'open').pop();
        ok(oc && oc[1].relPath === 'Drive/doc.pdf' && oc[1].reveal === false, 'Open → open-media with the PDF relPath');
        await ui.openDriveFile('other', 0, true);
        oc = calls.filter(c => c[0] === 'open').pop();
        ok(oc[1].relPath === 'Drive/tool.exe' && oc[1].reveal === true, 'Show in folder → reveal:true');
        const nOpen = calls.length;
        await ui.openDriveFile('other', 1, false);
        ok(calls.length === nOpen, 'stub (unsaved) file: no IPC call');

        ui.openDriveImage(0);
        ok(ui._currentPhotos.length === 2 && ui._currentPhotos[0].relPath === 'Drive/p.jpg' && ui._currentPhotos[0].filename === 'p<b>.jpg', 'photo click → lightbox list from Drive images');
        await runTimers();
        ok(calls.some(c => c[0] === 'url' && c[1].relPath === 'Drive/p.jpg'), 'lightbox streams the photo via media URL');
        els['gwp-drive-audio-0'] = makeEl('gwp-drive-audio-0');
        await ui.playDriveAudio(0);
        ok(/<audio controls autoplay src="viper-media:\/\/t\/1">/.test(els['gwp-drive-audio-0'].innerHTML), 'audio Play inserts a player with the media URL');

        // legacy base64 records still work
        const legacy = { id: 'old', driveFiles: [{ _isFile: true, name: 'o.png', mimeType: 'image/png', size: 3, data: 'AAAA' }, { _isFile: true, name: 'o.pdf', mimeType: 'application/pdf', size: 3, data: 'BBBB' }] };
        const lf = ui._renderFiles(legacy);
        ok(/data:image\/png;base64,AAAA/.test(lf) && /gwpViewPdf\(0\)/.test(lf), 'older imports with inline data still render');

        // globals follow the selected import, not imports[0]
        m.imports = [imp, legacy];
        ui.activeImportIdx = 1;
        els['gwp-pdf-viewer'] = makeEl('gwp-pdf-viewer');
        sb.gwpViewPdf(0);
        ok(/base64,BBBB/.test(els['gwp-pdf-viewer'].innerHTML), 'gwpViewPdf uses the selected import');
        ui.activeImportIdx = 0;
        els['gwp-pdf-viewer'].innerHTML = '';
        sb.gwpViewPdf(0);
        ok(els['gwp-pdf-viewer'].innerHTML === '', 'gwpViewPdf does nothing for a record without inline data');

        // Overview notice
        const ov = ui._renderOverview(imp);
        ok(/Large return/.test(ov) && /My Activity: 1,200 not shown/.test(ov) && /Google Pay transactions: 4 not shown/.test(ov), 'Overview lists what is not shown in full');
        ok(/MyActivity\.html/.test(ov) && /900 MB/.test(ov) && /openOversizeFile\(0\)/.test(ov), 'Overview lists oversize files with Show in folder');
        ok(/not saved \(no case folder\)/.test(ov) && !/openOversizeFile\(1\)/.test(ov), 'unsaved oversize file has no button');
        await ui.openOversizeFile(0);
        oc = calls.filter(c => c[0] === 'open').pop();
        ok(oc[1].relPath === '_oversize/MyActivity.MyActivity/MyActivity.html' && oc[1].reveal === true, 'oversize Show in folder → reveal');
        ok(ui._renderLargeReturnNotice({}) === '', 'no notice for a normal return');

        // Timeline note
        const tl = ui._renderTimeline(Object.assign({}, imp, { ipActivity: [{ timestamp: '2024-01-01', ip: '1.2.3.4' }] }));
        ok(/includes only 1 of 50,000 e-mails/.test(tl), 'Timeline says it only includes the preview e-mails');
        ok(!/includes only/.test(ui._renderTimeline({ ipActivity: [{ timestamp: '2024-01-01', ip: '1.2.3.4' }], emails: [] })), 'no Timeline note for a normal return');

        // OPENABLE_RE mirrors OPENABLE_EXT
        const re = sb.window.GoogleWarrantUI.OPENABLE_RE;
        const reExt = /\(([^)]+)\)\$/.exec(re.source)[1].split('|').sort().join();
        ok(reExt === gwStore.OPENABLE_EXT.slice().sort().join(), 'UI OPENABLE_RE matches main OPENABLE_EXT');
    }

    // ═══ 4. Static wiring ═══
    {
        const main = fs.readFileSync(path.join(ROOT, 'electron-main.js'), 'utf8');
        const pre = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
        const a = main.indexOf("ipcMain.handle('google-warrant-open-media'");
        const h = a >= 0 ? main.slice(a, main.indexOf('\n});', a)) : '';
        ok(!!h, 'open-media handler exists');
        ok(/startsWith\(root \+ path\.sep\)/.test(h) && /\[\\\\\/\]\|\\\.\\\./.test(h), 'open-media blocks traversal and odd case numbers');
        ok(h.indexOf('showItemInFolder') < h.indexOf('canOpenDirectly') && h.indexOf('canOpenDirectly') < h.indexOf('shell.openPath'), 'open-media checks the type before shell.openPath (reveal is always allowed)');
        ok(/googleWarrantOpenMedia: \(data\) => ipcRenderer\.invoke\('google-warrant-open-media', data\)/.test(pre), 'preload exposes googleWarrantOpenMedia');
        ok(/storeKey: writer \? writer\.overflowKey : null/.test(main), 'import passes the staging overflowKey to the parser');
    }

    // ═══ 5. Settings → Crash Log card ═══
    {
        const html = fs.readFileSync(path.join(ROOT, 'settings.html'), 'utf8');
        for (const id of ['crashLogCardBody', 'crashLogCardChevron', 'crashLogStatus', 'crashLogUnclean', 'crashLogBadge', 'crashLogTail', 'crashLogMsg'])
            ok(html.includes(`id="${id}"`), 'settings.html has #' + id);
        const s = html.indexOf('function toggleCrashLogCard()');
        const e = html.indexOf('// Show the "did not close normally" badge', s);
        ok(s > 0 && e > s, 'crash log script block found');
        const src = html.slice(s, e);
        const els = {};
        ['crashLogStatus', 'crashLogUnclean', 'crashLogBadge', 'crashLogTail', 'crashLogMsg'].forEach(id => { els[id] = makeEl(id); });
        const calls = [];
        let confirmAnswer = false;
        const sb = {
            console, Date, Math, isNaN,
            document: { getElementById: id => els[id] || null },
            toggleSettingsCard: () => calls.push('toggle'),
            viperConfirm: async () => confirmAnswer,
        };
        sb.window = sb;
        sb.electronAPI = {
            crashLogInfo: async () => { calls.push('info'); return { success: true, size: 20480, dumps: 2, previousUnclean: true, previous: { version: '5.4.7', lastMark: { label: 'google-warrant-import', detail: '{"file":"a.zip"}', at: '2026-10-20T10:00:00Z' } }, tail: 'TAIL <b>' }; },
            crashLogExport: async () => { calls.push('export'); return { success: true, filePath: 'C:\\x.txt' }; },
            crashLogOpenFolder: async () => { calls.push('open'); return { success: false, error: 'nope' }; },
            crashLogClear: async () => { calls.push('clear'); return { success: true }; },
        };
        vm.createContext(sb);
        vm.runInContext(src + '\nwindow.__api = { toggleCrashLogCard, refreshCrashLog, crashLogSaveCopy, crashLogOpenFolder, crashLogClearLog };', sb);
        const api = sb.__api;
        await api.refreshCrashLog();
        ok(/20 KB/.test(els.crashLogStatus.textContent) && /2 crash report files/.test(els.crashLogStatus.textContent), 'status shows size and crash report count');
        ok(!els.crashLogBadge.classList.contains('hidden') && !els.crashLogUnclean.classList.contains('hidden'), 'unclean exit → badge + amber box shown');
        ok(/did not close normally/.test(els.crashLogUnclean.textContent) && /google-warrant-import/.test(els.crashLogUnclean.textContent) && /5\.4\.7/.test(els.crashLogUnclean.textContent), 'amber box names version and last activity');
        ok(els.crashLogTail.textContent === 'TAIL <b>' && els.crashLogTail.innerHTML === '', 'tail shown as text, not HTML');
        await api.crashLogSaveCopy();
        ok(calls.includes('export') && /Saved to C:\\x\.txt/.test(els.crashLogMsg.textContent), 'Save a copy… exports and reports the path');
        await api.crashLogOpenFolder();
        ok(/Could not open the folder: nope/.test(els.crashLogMsg.textContent), 'Open folder failure reported');
        await api.crashLogClearLog();
        ok(!calls.includes('clear'), 'Clear log asks first — cancel does nothing');
        confirmAnswer = true;
        await api.crashLogClearLog();
        ok(calls.includes('clear') && /cleared/.test(els.crashLogMsg.textContent), 'Clear log after confirm');
        sb.electronAPI.crashLogInfo = async () => ({ success: true, size: 0, dumps: 0, previousUnclean: false, previous: null, tail: '' });
        await api.refreshCrashLog();
        ok(els.crashLogBadge.classList.contains('hidden') && els.crashLogUnclean.classList.contains('hidden') && els.crashLogTail.textContent === '(empty)', 'clean state hides the warning');
        delete sb.electronAPI.crashLogInfo;
        await api.refreshCrashLog();
        ok(/restart VIPER/.test(els.crashLogStatus.textContent), 'missing IPC (stale preload) handled');
    }

    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
    console.log(`\ngoogle-warrant-store-ui: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

/**
 * source-viewer.js — the "see it in the original" window (renderer half).
 *
 * Run: node modules\_shared\__tests__\source-viewer.test.js
 *
 * WHY THIS EXISTS
 * source-locator.test.js proves the main process finds the right spot. This
 * suite proves the WINDOW tells the officer the truth about what was found:
 *
 *   - a button that can only fail must not be drawn at all
 *   - text from the return is shown, never executed (it is attacker-
 *     controlled: a subject chose those message bodies)
 *   - "not found", "file missing" and "vault locked" each say so plainly,
 *     and never look like a confirmation
 *   - when only a corroborating detail was found, that is stated up front
 *   - the integrity line says "unchanged" only on a real match, and the
 *     copied citation carries the same verdict
 *   - "Locate original…" persists through the host's callback and re-runs
 *     the search against the new file
 *
 * A small hand-rolled DOM stub, deliberately not jsdom: it parses the
 * elements the window renders so the tests can click its real buttons.
 */
'use strict';

const path = require('path');
const SV = require(path.join(__dirname, '..', 'source-viewer.js'));

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; } else { fail++; console.log('  FAIL ' + label); }
}
const tick = () => new Promise(r => setImmediate(r));
async function settle(n) { for (let i = 0; i < (n || 6); i++) await tick(); }

// ── DOM stub ───────────────────────────────────────────────────────────────
function parseAttrs(tag) {
    const out = {};
    const re = /([\w-]+)="([^"]*)"/g;
    let m;
    while ((m = re.exec(tag))) out[m[1]] = m[2];
    return out;
}
function makeEl(tagName, attrs) {
    const el = {
        tagName, attrs: attrs || {}, _html: '', _kids: [], _handlers: {}, removed: false,
        className: (attrs && attrs.class) || '',
        setAttribute(k, v) { this.attrs[k] = String(v); },
        getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; },
        addEventListener(t, fn) { (this._handlers[t] = this._handlers[t] || []).push(fn); },
        remove() { this.removed = true; },
        click() { (this._handlers.click || []).forEach(fn => fn({ preventDefault() {}, target: el })); },
        get innerHTML() { return this._html; },
        set innerHTML(h) {
            this._html = String(h);
            this._kids = [];
            const re = /<([a-z]+)\b([^>]*)>/gi;
            let m;
            while ((m = re.exec(this._html))) this._kids.push(makeEl(m[1].toLowerCase(), parseAttrs(m[2])));
        },
        _all() {
            const out = [];
            for (const k of this._kids) { out.push(k); out.push(...k._all()); }
            return out;
        },
        querySelectorAll(sel) { return this._all().filter(e => matches(e, sel)); },
        querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    };
    return el;
}
function matches(e, sel) {
    let m;
    if ((m = /^\.([\w-]+)$/.exec(sel))) return (' ' + (e.attrs.class || '') + ' ').includes(' ' + m[1] + ' ');
    if ((m = /^\[([\w-]+)="([^"]*)"\]$/.exec(sel))) return e.attrs[m[1]] === m[2];
    if ((m = /^\[([\w-]+)\]$/.exec(sel))) return e.attrs[m[1]] != null;
    return false;
}
function makeDoc() {
    const listeners = {};
    const body = { kids: [], appendChild(el) { this.kids.push(el); } };
    return {
        body, listeners,
        createElement(t) { return makeEl(t, {}); },
        addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
        removeEventListener(t, fn) { listeners[t] = (listeners[t] || []).filter(f => f !== fn); },
        key(k) { (listeners.keydown || []).slice().forEach(fn => fn({ key: k, preventDefault() {} })); },
    };
}

// ── fake main process ────────────────────────────────────────────────────
const HIT = {
    member: 'conversations.csv', memberKey: 'conversations.csv', line: 12, page: null,
    matched: '10.1.2.3', matchKind: 'exact', preview: '2024-01-01,10.1.2.3,jdoe', corroboratedBy: [1],
};
const CSV_VIEW = {
    ok: true, format: 'csv',
    header: { n: 1, text: 'timestamp,ip,user' },
    lines: [
        { n: 11, text: '2024-01-01,10.9.9.9,other' },
        { n: 12, text: '2024-01-01,10.1.2.3,jdoe', target: true, hlStart: 11, hlEnd: 19 },
    ],
    cells: [{ name: 'timestamp', value: '2024-01-01' }, { name: 'ip', value: '10.1.2.3', hit: true }],
};
const HASH_MATCH = { ok: true, scope: 'file', contentSha256: 'a'.repeat(64), container: { sha256: 'a'.repeat(64), encryptedAtRest: false }, status: 'match' };

function makeApi(over) {
    const calls = { locate: [], view: [], hash: [], pick: [] };
    const api = Object.assign({
        sourceLocate: async (req) => { calls.locate.push(req); return { ok: true, found: true, hits: [HIT], totalHits: 1, primaryFound: true, usedValueIndex: 0, values: [] }; },
        sourceView: async (req) => { calls.view.push(req); return CSV_VIEW; },
        sourceHash: async (req) => { calls.hash.push(req); return HASH_MATCH; },
        sourceReveal: async () => ({ ok: true }),
        sourcePickOriginal: async (req) => { calls.pick.push(req); return null; },
    }, over || {});
    api.calls = calls;
    return api;
}

const EXPECTED = { algorithm: 'SHA-256', scope: 'file', sha256: 'a'.repeat(64), recordedAt: '2026-10-01T12:00:00.000Z' };

function payload(extra) {
    return Object.assign({
        title: 'IP address',
        values: ['10.1.2.3', '2024-01-01'],
        valueLabels: ['IP address', 'Timestamp'],
        source: { path: 'C:\\cases\\X\\Evidence\\return\\conversations.csv' },
        memberHints: ['conversations.csv'],
        expected: EXPECTED,
    }, extra || {});
}

function rootHtml() { const st = SV._state(); return st ? st.root.innerHTML : ''; }
function slotHtml() { const st = SV._state(); const s = st && st.root.querySelector('.sv-int-slot'); return s ? s.innerHTML : ''; }

(async () => {
    // ── buttonHtml ───────────────────────────────────────────────────────
    console.log('[buttonHtml]');
    ok(SV.buttonHtml(null) === '', 'no payload → no button');
    ok(SV.buttonHtml({ values: [], source: { path: 'x' } }) === '', 'no values → no button');
    ok(SV.buttonHtml({ values: ['   '], source: { path: 'x' } }) === '', 'blank primary value → no button');
    ok(SV.buttonHtml({ values: [null, 'b'], source: { path: 'x' } }) === '', 'null primary value → no button (a corroborator alone is not enough)');
    ok(SV.buttonHtml({ values: ['v'] }) === '', 'nowhere to look (no source, no resolveSource) → no button');
    const b1 = SV.buttonHtml({ values: ['v'], resolveSource: async () => null });
    ok(/class="sv-src-btn"/.test(b1) && / Source<\/button>$/.test(b1), 'resolveSource alone is enough; default label "Source"');
    const tok = (/openToken\('(s\d+)'\)/.exec(b1) || [])[1];
    ok(!!tok, 'button carries a token');
    const b2 = SV.buttonHtml({ values: ['v'], source: { path: 'x' } }, { label: '', compact: true });
    ok(/sv-src-btn sv-compact/.test(b2) && /<\/span><\/button>$/.test(b2), 'label "" → icon-only compact button');
    const b3 = SV.buttonHtml({ values: ['v'], source: { path: 'x' } }, { label: '<b>x</b>', title: '"><img src=x onerror=alert(1)>' });
    ok(!/<b>x<\/b>/.test(b3) && b3.includes('&lt;b&gt;x&lt;/b&gt;'), 'label is escaped');
    ok(!b3.includes('"><img') && b3.includes('&quot;&gt;&lt;img'), 'title attribute is escaped');
    ok(SV.openToken('s999999') === null, 'unknown token → null, no window');

    // ── found, CSV ───────────────────────────────────────────────────────
    console.log('[found]');
    let doc = makeDoc();
    SV._setDocument(doc);
    let api = makeApi();
    SV._setApi(api);
    await SV.open(payload());
    await settle();
    let html = rootHtml();
    ok(doc.body.kids.length === 1 && doc.body.kids[0].attrs.role === 'dialog', 'window is appended as a dialog');
    ok(api.calls.locate.length === 1 && api.calls.locate[0].source.path.endsWith('conversations.csv'), 'searches the given source');
    ok(JSON.stringify(api.calls.locate[0].values) === JSON.stringify(['10.1.2.3', '2024-01-01']) &&
       api.calls.locate[0].memberHints[0] === 'conversations.csv', 'passes values + member hints through unchanged');
    ok(api.calls.hash.length === 1 && api.calls.hash[0].expected === EXPECTED, 'hash request carries the import fingerprint');
    ok(html.includes('Exact match'), 'exact match badge');
    ok(html.includes('VIPER shows') && html.includes('The original reads'), 'side-by-side comparison');
    ok(html.includes('conversations.csv \u00B7 line 12'), 'hit list names file and line');
    ok(html.includes('<mark class="sv-mark">10.1.2.3</mark>'), 'value highlighted in the line');
    ok(html.includes('column headings') && html.includes('timestamp,ip,user'), 'CSV header line shown above the hit');
    ok(/<tr class="sv-cell-hit"><th>ip<\/th><td>10\.1\.2\.3<\/td><\/tr>/.test(html), 'row read under its column headings, matching cell marked');
    ok(html.includes('conversations.csv \u203A line 12'), 'footer states the location');
    ok(/\u2713 Unchanged since import/.test(slotHtml()), 'integrity: unchanged on a real match');
    ok(slotHtml().includes('2026-10-01'), 'integrity: names the date the fingerprint was taken');

    const cite = SV._citation();
    ok(cite.includes('IP address: 10.1.2.3'), 'citation: value');
    ok(cite.includes('Original reads: 10.1.2.3 (exact match)'), 'citation: what the original reads + kind');
    ok(cite.includes('Location: conversations.csv \u203A line 12'), 'citation: location');
    ok(cite.includes('SHA-256: ' + 'a'.repeat(64)), 'citation: full SHA-256');
    ok(cite.includes('Unchanged since import'), 'citation: integrity verdict');
    ok(cite.includes('Original file: C:\\cases\\X\\Evidence\\return\\conversations.csv'), 'citation: original path');

    doc.key('Escape');
    ok(SV._state() === null && doc.body.kids[0].removed, 'Escape closes and removes the window');

    // ── escaping text from the return ───────────────────────────────────
    console.log('[escaping]');
    const evil = '<img src=x onerror=alert(1)>';
    api = makeApi({
        sourceLocate: async () => ({ ok: true, found: true, totalHits: 1, primaryFound: true, usedValueIndex: 0, values: [],
            hits: [Object.assign({}, HIT, { matched: evil, preview: evil, member: '<b>m</b>.csv' })] }),
        sourceView: async () => ({ ok: true, format: 'text', lines: [{ n: 1, text: 'a ' + evil + ' b', target: true, hlStart: 2, hlEnd: 2 + evil.length }] }),
    });
    SV._setApi(api);
    await SV.open(payload({ values: [evil], shown: evil, context: [['Author', evil]] }));
    await settle();
    html = rootHtml();
    ok(!html.includes('<img src=x'), 'no raw markup from the return reaches the window');
    ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'it is shown as text');
    ok(!html.includes('<b>m</b>'), 'member names are escaped too');
    SV.close();

    // ── hit near the top: header is IN the window ───────────────────────
    console.log('[inline header]');
    api = makeApi({
        sourceView: async () => ({ ok: true, format: 'text', header: { n: 1, text: 'timestamp,ip,user' },
            lines: [{ n: 1, text: 'timestamp,ip,user' }, { n: 2, text: '2024-01-01,10.1.2.3,jdoe', target: true, hlStart: 11, hlEnd: 19 }] }),
    });
    SV._setApi(api);
    await SV.open(payload());
    await settle();
    html = rootHtml();
    ok((html.match(/column headings/g) || []).length === 1, 'column headings labelled once, not repeated above the window');
    ok(!html.includes('sv-gap') && html.includes('sv-line-header'), 'no gap row; the header line itself is tagged in place');
    SV.close();

    // ── corroborator only ────────────────────────────────────────────────
    console.log('[primary not found]');
    api = makeApi({
        sourceLocate: async () => ({ ok: true, found: true, totalHits: 1, primaryFound: false, usedValueIndex: 1,
            values: [{ index: 0, text: '10.1.2.3' }, { index: 1, text: '2024-01-01' }],
            hits: [Object.assign({}, HIT, { matched: '2024-01-01' })] }),
    });
    SV._setApi(api);
    await SV.open(payload());
    await settle();
    html = rootHtml();
    ok(html.includes('VIPER could not find <b>10.1.2.3</b> itself'), 'banner: the value itself was not found');
    ok(html.includes('It found the Timestamp <b>2024-01-01</b> instead'), 'banner: names the detail that WAS found, with its label');
    ok(SV._citation().includes('NOTE: this value itself was not found; the Timestamp was found instead.'), 'citation carries the same caveat');
    ok(html.includes('Related record only') && !html.includes('Exact match') && !html.includes('sv-cmp-badge sv-ok'),
        'badge says "Related record only" \u2014 never a green tick for a value that was not itself found');
    SV.close();

    // ── related details found, but never together ───────────────────────
    console.log('[related only]');
    api = makeApi({
        sourceLocate: async () => ({ ok: true, found: false, relatedOnly: true, hits: [], totalHits: 0, searchedMembers: ['conversations.csv'], skippedMembers: [] }),
    });
    SV._setApi(api);
    await SV.open(payload({ values: ['10.1.2.3', '2024-01-01', 'jdoe'] }));
    await settle();
    html = rootHtml();
    ok(html.includes('<b>Not found.</b>') && html.includes('never together on one record') && !html.includes('did not find any of them'),
        'explains that related details exist but do not form one record');
    ok(SV._citation() === '', 'no citation');
    SV.close();

    // ── not found ───────────────────────────────────────────────────────
    console.log('[not found]');
    api = makeApi({
        sourceLocate: async () => ({ ok: true, found: false, hits: [], totalHits: 0,
            searchedMembers: ['conversations.csv', 'friends.csv'], skippedMembers: [{ member: 'bad.pdf', error: 'damaged' }], incomplete: true }),
    });
    SV._setApi(api);
    await SV.open(payload());
    await settle();
    html = rootHtml();
    ok(html.includes('<b>Not found.</b>'), 'says Not found');
    ok(html.includes('\u201C10.1.2.3\u201D and 1 related detail') && html.includes('did not find any of them'), 'states what was searched for');
    ok(html.includes('<li>conversations.csv</li>') && html.includes('<li>friends.csv</li>'), 'lists every file searched');
    ok(html.includes('bad.pdf \u2014 damaged'), 'lists files that could not be read');
    ok(html.includes('stopped early'), 'admits an incomplete search');
    ok(!html.includes('Exact match') && !html.includes('Copy citation'), 'nothing that looks like a confirmation');
    ok(SV._citation() === '', 'no citation without a hit');
    SV.close();

    // ── missing source ───────────────────────────────────────────────────
    console.log('[missing]');
    api = makeApi();
    SV._setApi(api);
    await SV.open(payload({ source: null, resolveSource: async () => null }));
    await settle();
    html = rootHtml();
    ok(api.calls.locate.length === 0, 'no search without a source');
    ok(html.includes('no record of where the original file is'), 'says VIPER does not know where the original is');
    ok(html.includes('Locate original\u2026'), 'offers Locate original');
    SV.close();

    api = makeApi({ sourceLocate: async () => ({ ok: false, missing: true, error: 'The original file is not on disk.' }) });
    SV._setApi(api);
    await SV.open(payload());
    await settle();
    html = rootHtml();
    ok(html.includes('The original file is not on disk.') && html.includes('If the return was moved or renamed'), 'moved original → explains and points at Locate');
    SV.close();

    // resolveSource is consulted at click time
    let resolved = 0;
    api = makeApi();
    SV._setApi(api);
    await SV.open(payload({ source: null, resolveSource: async () => { resolved++; return { path: 'D:\\moved\\conversations.csv' }; } }));
    await settle();
    ok(resolved === 1 && api.calls.locate[0].source.path === 'D:\\moved\\conversations.csv', 'resolveSource runs at click time and its answer is searched');
    SV.close();

    // ── locked ──────────────────────────────────────────────────────────
    console.log('[locked]');
    api = makeApi({ sourceLocate: async () => ({ ok: false, locked: true, error: 'Unlock VIPER to read this encrypted original.' }) });
    SV._setApi(api);
    await SV.open(payload());
    await settle();
    html = rootHtml();
    ok(html.includes('\uD83D\uDD12 Unlock VIPER to read this encrypted original.'), 'locked vault says so');
    ok(!html.includes('Not found'), 'locked is never reported as not found');
    SV.close();

    // ── integrity labels ─────────────────────────────────────────────────
    console.log('[integrity]');
    async function integrityFor(hash, expected) {
        SV._setApi(makeApi({ sourceHash: async () => hash }));
        await SV.open(payload({ expected }));
        await settle();
        const out = { slot: slotHtml(), cite: SV._citation() };
        SV.close();
        return out;
    }
    let r = await integrityFor(Object.assign({}, HASH_MATCH, { status: 'mismatch' }), EXPECTED);
    ok(r.slot.includes('Does NOT match the fingerprint taken at import') && r.slot.includes('sv-int-bad'), 'mismatch: red, explicit');
    ok(!r.slot.includes('Unchanged'), 'mismatch never says unchanged');
    ok(r.cite.includes('WARNING: does NOT match the fingerprint recorded at import.'), 'mismatch: citation warns');

    r = await integrityFor(Object.assign({}, HASH_MATCH, { status: 'none' }), null);
    ok(r.slot.includes('No fingerprint was taken when this was imported'), 'no fingerprint: says it was imported before this existed');
    ok(r.cite.includes('No fingerprint was recorded at import.') && !r.cite.includes('Unchanged'), 'no fingerprint: citation says so, claims nothing');

    r = await integrityFor({ ok: true, scope: 'file', contentSha256: null, container: { sha256: 'b'.repeat(64), encryptedAtRest: true, contentNote: 'locked' }, status: 'unknown' }, EXPECTED);
    ok(r.slot.includes('Unlock VIPER to check this encrypted original'), 'locked hash: asks to unlock');
    ok(!r.slot.includes('Does NOT match') && !r.slot.includes('Unchanged'), 'locked hash: neither match nor mismatch');
    ok(r.slot.includes('Stored encrypted by Field Security'), 'encrypted at rest is explained');

    r = await integrityFor({ ok: true, scope: 'folder', folder: { fileCount: 9, manifestSha256: 'c'.repeat(64) }, contentSha256: 'c'.repeat(64), status: 'match' }, EXPECTED);
    ok(r.slot.includes('SHA-256 (all 9 files in the folder)'), 'folder source: hash is described as covering every file');
    ok(r.cite.includes('SHA-256 (folder manifest): ' + 'c'.repeat(64)), 'folder source: citation labels the manifest hash');

    r = await integrityFor({ ok: true, scope: 'file', contentSha256: 'd'.repeat(64), container: { sha256: 'd'.repeat(64) }, member: { name: 'reports/CT-1.pdf', sha256: 'e'.repeat(64) }, status: 'match' }, EXPECTED);
    ok(r.slot.includes('CT-1.pdf inside the ZIP'), 'ZIP member hash shown');
    ok(r.cite.includes('SHA-256 of CT-1.pdf: ' + 'e'.repeat(64)), 'ZIP member hash in the citation');

    r = await integrityFor({ ok: false, error: 'boom' }, EXPECTED);
    ok(r.slot.includes('SHA-256: boom') && !r.slot.includes('Unchanged'), 'hash failure: reported, no verdict');

    // ── relocate ────────────────────────────────────────────────────────
    console.log('[relocate]');
    let relocArgs = null;
    api = makeApi({
        sourceLocate: async (req) => { api.calls.locate.push(req); return req.source.path.startsWith('E:') ? { ok: true, found: true, hits: [HIT], totalHits: 1, primaryFound: true, usedValueIndex: 0, values: [] } : { ok: false, missing: true, error: 'The original file is not on disk.' }; },
        sourcePickOriginal: async (req) => { api.calls.pick.push(req); return 'E:\\returns\\snap'; },
    });
    SV._setApi(api);
    await SV.open(payload({
        relocateFolder: true,
        onRelocate: async (picked, next) => { relocArgs = { picked, next: Object.assign({}, next) }; next.extraPaths = ['E:\\returns\\snap-2']; return next; },
    }));
    await settle();
    const btn = SV._state().root.querySelector('[data-sv="relocate"]');
    ok(!!btn, 'Locate original button is rendered and wired');
    btn.click();
    await settle(10);
    ok(api.calls.pick.length === 1 && api.calls.pick[0].folder === true, 'folder returns pick a folder');
    ok(relocArgs && relocArgs.picked === 'E:\\returns\\snap' && relocArgs.next.path === 'E:\\returns\\snap', 'host callback receives the new path to persist');
    const last = api.calls.locate[api.calls.locate.length - 1];
    ok(last.source.path === 'E:\\returns\\snap' && last.source.extraPaths && last.source.extraPaths[0] === 'E:\\returns\\snap-2', 're-searches the new location, with what the host returned');
    ok(rootHtml().includes('Exact match'), 'and shows the result');
    SV.close();

    // ZIP entry carried across a relocate to another ZIP, not to a bare file
    api = makeApi({ sourcePickOriginal: async () => 'F:\\tips\\batch.zip' });
    SV._setApi(api);
    await SV.open(payload({ source: { path: 'C:\\old\\batch.zip', entry: 'CT-1.pdf' } }));
    await settle();
    SV._state().root.querySelector('[data-sv="relocate"]').click();
    await settle(10);
    let lastLoc = api.calls.locate[api.calls.locate.length - 1];
    ok(lastLoc.source.path === 'F:\\tips\\batch.zip' && lastLoc.source.entry === 'CT-1.pdf', 'relocating a ZIP keeps the report entry inside it');
    SV.close();
    api = makeApi({ sourcePickOriginal: async () => 'F:\\tips\\CT-1.pdf' });
    SV._setApi(api);
    await SV.open(payload({ source: { path: 'C:\\old\\batch.zip', entry: 'CT-1.pdf' } }));
    await settle();
    SV._state().root.querySelector('[data-sv="relocate"]').click();
    await settle(10);
    lastLoc = api.calls.locate[api.calls.locate.length - 1];
    ok(lastLoc.source.path === 'F:\\tips\\CT-1.pdf' && !lastLoc.source.entry, 'relocating to the extracted PDF drops the ZIP entry');
    SV.close();

    // cancelled picker changes nothing
    api = makeApi();
    SV._setApi(api);
    let called = false;
    await SV.open(payload({ onRelocate: async () => { called = true; } }));
    await settle();
    SV._state().root.querySelector('[data-sv="relocate"]').click();
    await settle(10);
    ok(!called && api.calls.locate.length === 1, 'cancelled picker: no callback, no re-search');
    SV.close();

    // ── HTML view: sandboxed frame ──────────────────────────────────────
    console.log('[html view]');
    api = makeApi({ sourceView: async () => ({ ok: true, format: 'html', marked: true, line: 40, html: '<html><body><mark id="viper-src-hit">x</mark></body></html>', raw: [{ n: 40, text: 'x', target: true }] }) });
    SV._setApi(api);
    await SV.open(payload());
    await settle();
    html = rootHtml();
    ok(/<iframe class="sv-frame" sandbox="allow-same-origin"/.test(html), 'provider page shown in a sandboxed frame with no scripts');
    const fr = SV._state().root.querySelector('.sv-frame');
    ok(fr && /viper-src-hit/.test(fr.srcdoc || ''), 'frame content is the sanitised page from the main process');
    ok(html.includes('Raw text (line 40)'), 'raw-text tab names the line');
    SV.close();

    api = makeApi({ sourceView: async () => ({ ok: true, format: 'html', marked: false, line: 7, html: '<p>x</p>', raw: [{ n: 7, text: 'x', target: true }] }) });
    SV._setApi(api);
    await SV.open(payload());
    await settle();
    ok(rootHtml().includes('sv-tab-on">Raw text (line 7)'), 'value not in visible text → opens on Raw text');
    SV.close();

    // ── database record (Cellebrite) ────────────────────────────────────
    console.log('[record view]');
    const REC_HIT = { member: 'mmssms.db', memberKey: 'mmssms.db', line: 1234, page: null, table: 'sms', rowid: 1234, column: 'address',
        matched: '+15551234567', matchKind: 'exact', preview: 'sms \u203A address: +15551234567', corroboratedBy: [1] };
    api = makeApi({
        sourceLocate: async (req) => { api.calls.locate.push(req); return { ok: true, found: true, hits: [REC_HIT], totalHits: 1, primaryFound: true, usedValueIndex: 0, values: [] }; },
        sourceView: async (req) => { api.calls.view.push(req); return { ok: true, format: 'record', table: 'sms', rowid: 1234, columns: [
            { name: '_id', type: 'INTEGER', value: '1234' },
            { name: 'address', type: 'TEXT', value: '+15551234567', target: true, hlStart: 0, hlEnd: 12 },
            { name: 'date', type: 'INTEGER', value: '1700000000000', corroborate: true, valueIndex: 1 },
            { name: 'body', type: 'TEXT', value: null },
            { name: 'thumb', type: 'BLOB', value: '<binary data, 8 bytes>', binary: true },
        ] }; },
    });
    SV._setApi(api);
    await SV.open(payload({ values: ['+15551234567', '1700000000000'], valueLabels: ['Number', 'Date (raw)'],
        source: { path: 'C:\\cases\\X\\Cellebrite\\imp1\\extracted' }, memberHints: ['mmssms.db'],
        record: { member: 'mmssms.db', table: 'sms', rowid: 1234 } }));
    await settle();
    html = rootHtml();
    ok(api.calls.locate[0] && api.calls.locate[0].record && api.calls.locate[0].record.table === 'sms' && api.calls.locate[0].record.rowid === 1234,
        'record pointer is passed through to the search');
    ok(html.includes('mmssms.db \u203A table <b>sms</b> \u203A row <b>1234</b>'), 'heading names database, table and row');
    ok(html.includes('mmssms.db \u00B7 table sms \u00B7 row 1234'), 'hit list names table and row, not a line');
    ok(/<tr class="sv-rec-target" data-sv-target="1"><th>address<\/th><td><mark class="sv-mark">\+15551234567<\/mark><\/td>/.test(html), 'matching column highlighted and scrolled to');
    ok(/<tr class="sv-rec-cor"><th>date<\/th>/.test(html) && html.includes('agrees'), 'corroborating column tagged');
    ok(html.includes('(empty)'), 'an empty column says so');
    ok(html.includes('&lt;binary data, 8 bytes&gt;'), 'binary column described, never dumped');
    ok(html.includes('mmssms.db \u203A table sms \u203A row 1234'), 'footer location names table and row');
    ok(!/line 1234/.test(html), 'a database row is never called a line');
    ok(SV._citation().includes('Location: mmssms.db \u203A table sms \u203A row 1234'), 'copied citation names table and row');
    SV.close();

    // ── no desktop API ──────────────────────────────────────────────────
    SV._setApi({});
    await SV.open(payload());
    await settle();
    ok(rootHtml().includes('Source checking is not available in this window.'), 'no desktop API → says so');
    SV.close();

    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

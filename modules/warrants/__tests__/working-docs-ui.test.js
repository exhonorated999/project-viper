/*
 * Working Documents — Warrants-tab UI tests.
 *
 * Run: node modules\warrants\__tests__\working-docs-ui.test.js
 *
 * Drives the real renderer module against a fake electronAPI and a tiny DOM
 * stub (deliberately not jsdom). What it pins:
 *   - a warrant's link to its draft (warrant.workingDocName) follows a
 *     rename and is cleared by a remove — a stale link is a dead button;
 *   - "New from…" on a warrant copies the chosen draft, links it, opens it;
 *   - file names are escaped everywhere they are drawn (they come from disk
 *     and from whatever the officer typed);
 *   - a "saved" event from Word shows on screen without a re-render, and a
 *     failure is always heard — even for a case not on screen;
 *   - switching case while the list loads never shows case A's drafts in B.
 */
const path = require('path');
const MOD = path.join(__dirname, '..', 'working-docs-ui.js');

let pass = 0, fail = 0;
const ok = (n, c, x) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? ' -> ' + JSON.stringify(x) : '')); }
};
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 6; i++) await tick(); }

// ── tiny DOM ──
function el(attrs) {
    return {
        innerHTML: '', _a: attrs || {},
        getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._a, k) ? this._a[k] : null; },
    };
}
const dom = { panel: null, rows: [] };
global.document = {
    getElementById: (id) => (id === 'wdPanel' ? dom.panel : null),
    querySelectorAll: (sel) => (sel === '[data-wd-warrant]' ? dom.rows : []),
};
function mount(UI, warrants) {
    dom.panel = el({ id: 'wdPanel' });
    dom.panel.innerHTML = UI.renderPanel();
    dom.rows = warrants.map((w) => { const r = el({ 'data-wd-warrant': String(w.id) }); r.innerHTML = UI.renderWarrantRow(w); return r; });
}
const btnFor = (attrs) => el(attrs);

// ── fake main process ──
function fakeApi() {
    const disk = {};        // caseNumber → [{fileName,…}]
    const calls = [];
    const api = {
        calls, disk,
        listGate: null,     // when set, list() waits on it
        openResult: null,
        listener: null,
        async workingDocsList(cn) {
            calls.push(['list', cn]);
            if (api.listGate) await api.listGate;
            return { success: true, docs: (disk[cn] || []).map((d) => Object.assign({}, d)) };
        },
        async workingDocOpen(cn, name) { calls.push(['open', cn, name]); return api.openResult || { success: true, mode: 'direct', alreadyOpen: false }; },
        async workingDocNewFrom(cn, src, name) {
            calls.push(['newFrom', cn, src, name]);
            const fileName = name.replace(/\.(docx|doc|rtf)$/i, '') + '.docx';
            (disk[cn] = disk[cn] || []).unshift({ fileName, bytes: 1, modifiedAt: new Date().toISOString(), open: false });
            return { success: true, fileName, bytes: 1 };
        },
        async workingDocNewBlank(cn, name) {
            calls.push(['blank', cn, name]);
            const fileName = name + '.docx';
            (disk[cn] = disk[cn] || []).unshift({ fileName, bytes: 1, modifiedAt: new Date().toISOString(), open: false });
            return { success: true, fileName };
        },
        async workingDocRename(cn, name, newName) {
            calls.push(['rename', cn, name, newName]);
            const d = (disk[cn] || []).find((x) => x.fileName === name);
            d.fileName = newName + '.docx';
            return { success: true, fileName: d.fileName };
        },
        async workingDocRemove(cn, name) {
            calls.push(['remove', cn, name]);
            disk[cn] = (disk[cn] || []).filter((x) => x.fileName !== name);
            return { success: true, removed: true };
        },
        async workingDocImport(cn) {
            calls.push(['import', cn]);
            (disk[cn] = disk[cn] || []).unshift({ fileName: 'From Desktop.docx', bytes: 1, modifiedAt: new Date().toISOString(), open: false });
            return { success: true, added: ['From Desktop.docx'], failed: [] };
        },
        onWorkingDocEvent(cb) { api.listener = cb; return () => { api.listener = null; }; },
    };
    return api;
}

(async function main() {
    const UI = require(MOD);
    ok('UMD: module.exports AND the global are both set', !!UI && globalThis.WorkingDocsUI === UI);

    const api = fakeApi();
    const toasts = [], saves = [];
    let caseNo = '26-0100';
    const warrants = [
        { id: 1, type: 'search', issuedTo: 'Google LLC' },
        { id: 2, type: 'preservation', issuedTo: 'Meta' },
        { id: 3, type: 'arrest', issuedTo: '' },
    ];
    let confirmAnswer = true, askAnswer = null;
    const asked = [];
    const host = {
        api,
        getCaseNumber: () => caseNo,
        getWarrants: () => warrants,
        saveWarrants: () => saves.push(JSON.stringify(warrants.map((w) => w.workingDocName || null))),
        toast: (m, t) => toasts.push({ m, t }),
        confirm: async () => confirmAnswer,
        ask: async (spec) => { asked.push(spec); return typeof askAnswer === 'function' ? askAnswer(spec) : askAnswer; },
        isPreservation: (w) => w.type === 'preservation',
    };

    /* ---------- loading and the empty state ---------- */
    console.log('\n[loading]');
    UI.configure(host);
    mount(UI, warrants);
    ok('first paint says Loading', /Loading/.test(dom.panel.innerHTML));
    await settle();
    ok('the list is fetched for the case on screen', api.calls.some((c) => c[0] === 'list' && c[1] === '26-0100'));
    ok('empty case explains what the panel is for', /No working documents yet/.test(dom.panel.innerHTML) && /every time you save in Word/.test(dom.panel.innerHTML));
    ok('panel says drafts stay out of exports', /left out of DA and assist exports/.test(dom.panel.innerHTML));
    ok('with no drafts, a warrant offers to attach one', /Attach Word document/.test(dom.rows[0].innerHTML) && !/New from/.test(dom.rows[0].innerHTML));

    /* ---------- rows, escaping ---------- */
    console.log('\n[rows and escaping]');
    api.disk['26-0100'] = [
        { fileName: 'Running Affidavit.docx', bytes: 10, modifiedAt: '2026-10-12T15:00:00Z', open: false, lastSavedAt: null, error: null },
        { fileName: 'O\'Brien <img src=x onerror=alert(1)> "draft".docx', bytes: 5, modifiedAt: '2026-10-11T15:00:00Z', open: false, lastSavedAt: null, error: null },
    ];
    await UI.refresh();
    ok('rows are drawn', /Running Affidavit\.docx/.test(dom.panel.innerHTML));
    ok('a hostile file name is escaped', !/<img/.test(dom.panel.innerHTML) && /&lt;img/.test(dom.panel.innerHTML) && /&quot;draft&quot;/.test(dom.panel.innerHTML));
    ok('…including inside attributes', !/data-wd-name="O'Brien <img/.test(dom.panel.innerHTML) && /data-wd-name="O&#39;Brien &lt;img/.test(dom.panel.innerHTML));
    ok('with drafts, a warrant offers New from… and Link', /New from…/.test(dom.rows[0].innerHTML) && /Link a document…/.test(dom.rows[0].innerHTML));

    /* ---------- New from… on a warrant ---------- */
    console.log('\n[new from — per warrant]');
    askAnswer = (spec) => ({ source: spec.source, name: spec.name });
    await UI.act('newfor', btnFor({ 'data-wd-warrant-id': '1' }), { stopPropagation() {} });
    await settle();
    const spec = asked[asked.length - 1];
    ok('suggests a name from the warrant', spec.name === 'Search Warrant – Google LLC', spec.name);
    ok('offers every draft as the source, running affidavit first', spec.sources[0] === 'Running Affidavit.docx' && spec.sources.length === 2);
    ok('copies the chosen source', api.calls.some((c) => c[0] === 'newFrom' && c[2] === 'Running Affidavit.docx' && c[3] === 'Search Warrant – Google LLC'));
    ok('links the new draft to the warrant', warrants[0].workingDocName === 'Search Warrant – Google LLC.docx');
    ok('…and saves the warrants', saves.length === 1);
    ok('…and opens it in Word', api.calls.some((c) => c[0] === 'open' && c[2] === 'Search Warrant – Google LLC.docx'));
    ok('the warrant row now shows the linked draft', /Search Warrant – Google LLC\.docx/.test(dom.rows[0].innerHTML) && /Open in Word/.test(dom.rows[0].innerHTML));
    ok('the panel tags the draft with its warrant', /rounded-full[^>]*>Search Warrant – Google LLC</.test(dom.panel.innerHTML));
    ok('a preservation request is labelled as one', UI._warrantLabel(warrants[1]) === 'Preservation Request – Meta');
    ok('a warrant with no recipient gets a plain label', UI._warrantLabel(warrants[2]) === 'Arrest Warrant');

    askAnswer = null;
    const nBefore = api.calls.length;
    await UI.act('newfor', btnFor({ 'data-wd-warrant-id': '2' }));
    ok('cancelling New from… does nothing', api.calls.length === nBefore && !warrants[1].workingDocName);

    /* ---------- link / import ---------- */
    console.log('\n[link]');
    askAnswer = { source: 'Running Affidavit.docx' };
    await UI.act('link', btnFor({ 'data-wd-warrant-id': '3' }));
    ok('link an existing draft', warrants[2].workingDocName === 'Running Affidavit.docx');
    askAnswer = { import: true };
    await UI.act('link', btnFor({ 'data-wd-warrant-id': '2' }));
    await settle();
    ok('"From my computer…" imports and links', warrants[1].workingDocName === 'From Desktop.docx' && api.calls.some((c) => c[0] === 'import'));

    /* ---------- rename follows links ---------- */
    console.log('\n[rename]');
    askAnswer = { name: 'Master Affidavit' };
    const savesBefore = saves.length;
    await UI.act('rename', btnFor({ 'data-wd-name': 'Running Affidavit.docx' }));
    await settle();
    ok('rename asks with the name minus extension', asked[asked.length - 1].name === 'Running Affidavit');
    ok('rename updates every warrant linked to it', warrants[2].workingDocName === 'Master Affidavit.docx');
    ok('…and saves', saves.length === savesBefore + 1);
    ok('…and the panel shows the new name', /Master Affidavit\.docx/.test(dom.panel.innerHTML) && !/Running Affidavit\.docx/.test(dom.panel.innerHTML));

    /* ---------- remove clears links ---------- */
    console.log('\n[remove]');
    confirmAnswer = false;
    const c0 = api.calls.length;
    await UI.act('remove', btnFor({ 'data-wd-name': 'Master Affidavit.docx' }));
    ok('declining the confirm removes nothing', api.calls.length === c0 && warrants[2].workingDocName === 'Master Affidavit.docx');
    confirmAnswer = true;
    await UI.act('remove', btnFor({ 'data-wd-name': 'Master Affidavit.docx' }));
    await settle();
    ok('remove calls through', api.calls.some((c) => c[0] === 'remove' && c[2] === 'Master Affidavit.docx'));
    ok('remove clears the warrant link', !warrants[2].workingDocName);
    ok('the warrant row goes back to "none linked"', /none linked/.test(dom.rows[2].innerHTML));

    // A link to a file that vanished outside VIPER.
    warrants[2].workingDocName = 'Deleted In Explorer.docx';
    mount(UI, warrants);
    ok('a dead link says so and offers Unlink', /no longer in this case/.test(dom.rows[2].innerHTML) && /Unlink/.test(dom.rows[2].innerHTML)
        && !/Open in Word/.test(dom.rows[2].innerHTML));
    await UI.act('unlink', btnFor({ 'data-wd-warrant-id': '3' }));
    ok('Unlink clears it', !warrants[2].workingDocName && /none linked/.test(dom.rows[2].innerHTML));

    /* ---------- events from Word ---------- */
    console.log('\n[events]');
    const target = 'Search Warrant – Google LLC.docx';
    api.listener({ type: 'saved', caseNumber: '26-0100', fileName: target, savedAt: new Date().toISOString(), bytes: 99 });
    ok('a save shows on the panel without a re-render', /saved into the case/.test(dom.panel.innerHTML));
    ok('…and on the warrant card', /saved into the case/.test(dom.rows[0].innerHTML));
    const t0 = toasts.length;
    api.listener({ type: 'error', caseNumber: '26-0100', fileName: target, message: 'VIPER is locked, so this save could not go into the case yet.' });
    ok('a failed save is shown in red on the row', /text-red-400">VIPER is locked/.test(dom.panel.innerHTML));
    ok('…and toasted', toasts.length === t0 + 1 && toasts[t0].t === 'error');
    api.listener({ type: 'error', caseNumber: '99-9999', fileName: 'Other.docx', message: 'disk full' });
    ok('a failure in ANOTHER case is still heard', toasts.length === t0 + 2 && /99-9999/.test(toasts[t0 + 1].m));
    const listsBefore = api.calls.filter((c) => c[0] === 'list').length;
    api.listener({ type: 'closed', caseNumber: '26-0100', fileName: target });
    await settle();
    ok('closed → the list is re-read', api.calls.filter((c) => c[0] === 'list').length === listsBefore + 1);
    api.listener({ type: 'recovered', caseNumber: '26-0100', fileName: 'Aff (recovered).docx', action: 'recover-beside' });
    ok('a recovered-beside save is explained', /beside the case copy/.test(toasts[toasts.length - 1].m));

    /* ---------- open ---------- */
    console.log('\n[open]');
    api.openResult = { success: false, error: 'Windows could not find a program to open this document.', code: 'NO_APP' };
    const t1 = toasts.length;
    await UI.act('open', btnFor({ 'data-wd-name': target }));
    ok('an open failure is reported in plain words', toasts.length === t1 + 1 && /could not find a program/.test(toasts[t1].m));
    api.openResult = null;
    const opens0 = api.calls.filter((c) => c[0] === 'open').length;
    const p1 = UI.act('open', btnFor({ 'data-wd-name': target }));
    const p2 = UI.act('open', btnFor({ 'data-wd-name': target }));
    await Promise.all([p1, p2]);
    ok('a double click opens once', api.calls.filter((c) => c[0] === 'open').length === opens0 + 1);
    let stopped = false;
    await UI.act('open', btnFor({ 'data-wd-name': target }), { stopPropagation() { stopped = true; } });
    ok('clicks do not fold the warrant card', stopped);

    /* ---------- case switch mid-load ---------- */
    console.log('\n[case switch]');
    api.disk['26-0200'] = [{ fileName: 'Case B Draft.docx', bytes: 1, modifiedAt: '2026-10-10T00:00:00Z', open: false }];
    let release; api.listGate = new Promise((r) => { release = r; });
    const pending = UI.refresh();         // still loading case A
    caseNo = '26-0200';
    UI.configure(host);
    mount(UI, []);
    release(); api.listGate = null;
    await pending; await settle();
    ok('case A\'s list is never shown in case B', !/Search Warrant – Google LLC/.test(dom.panel.innerHTML));
    ok('case B\'s list is loaded instead', /Case B Draft\.docx/.test(dom.panel.innerHTML), dom.panel.innerHTML.slice(0, 200));

    /* ---------- configure keeps the cache ---------- */
    const callsNow = api.calls.filter((c) => c[0] === 'list').length;
    UI.configure(host); UI.configure(host);
    mount(UI, []);
    await settle();
    ok('re-configuring the same case keeps the list (no reload per render)', api.calls.filter((c) => c[0] === 'list').length === callsNow
        && /Case B Draft\.docx/.test(dom.panel.innerHTML));

    console.log('\n' + pass + ' passed · ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

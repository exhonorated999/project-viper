'use strict';
// Drag and drop onto the import modules (case detail):
//   - Cyber Tips tab takes CyberTip PDFs and ICAC ZIPs (every file dropped)
//   - RMS Import tab takes RMS report PDFs (every file dropped)
//   - Suspects / Victims / Witnesses / Involved Persons take the first DMV PDF
//   - a file dropped on the RMS Import / Cyber Tips TAB BUTTON goes to that
//     module from any tab; another tab's button never takes the current
//     tab's file
//
// wireDmvDropZone and importCyberTipPdf are LIFTED from
// case-detail-with-analytics.html (never copied) and driven with fake events.
// File names and paths are synthetic.
//
// Run: node modules\__tests__\import-drop-routing.test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..', '..');
const DETAIL = fs.readFileSync(path.join(REPO, 'case-detail-with-analytics.html'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; } else { fail++; console.log('  FAIL: ' + label); }
}
function eq(a, b, label) {
    const A = JSON.stringify(a), B = JSON.stringify(b);
    ok(A === B, label + (A === B ? '' : '  (got ' + A + ', want ' + B + ')'));
}
function liftFunction(src, header) {
    const s = src.indexOf(header);
    if (s === -1) throw new Error('not found: ' + header);
    const open = src.indexOf('{', s + header.length - 1);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return src.slice(s, i + 1); }
    }
    throw new Error('unbalanced: ' + header);
}

const WIRE = liftFunction(DETAIL, '(function wireDmvDropZone() {') + ')();';
const IMPORT_CT = liftFunction(DETAIL, 'async function importCyberTipPdf(droppedPaths) {');

// ── fake page ────────────────────────────────────────────────────────────
function makePage(tab) {
    const calls = [];
    const handlers = {};
    const overlayText = { textContent: '' };
    const ctx = {
        calls,
        currentTab: tab,
        console,
        showToast: (m, t) => calls.push(['toast', t, m]),
        renderTabContent: (id) => { calls.push(['render', id]); ctx.currentTab = id; },
        importDmvPrintout: (_a, p) => calls.push(['dmv-suspect', p]),
        importDmvVictim: (_a, p) => calls.push(['dmv-victim', p]),
        importDmvWitness: (_a, p) => calls.push(['dmv-witness', p]),
        importDmvInvolvedPerson: (_a, p) => calls.push(['dmv-involved', p]),
        handleRmsImport: (paths) => calls.push(['rms', paths]),
        importCyberTipPdf: (paths) => calls.push(['cybertip', paths]),
    };
    let overlay = null;
    ctx.document = {
        createElement: () => { overlay = { style: {}, innerHTML: '' }; return overlay; },
        body: { appendChild: () => {} },
        getElementById: (id) => (id === 'dmvDropOverlayText' ? overlayText : null),
    };
    ctx.window = {
        addEventListener: (type, fn) => { (handlers[type] = handlers[type] || []).push(fn); },
        electronAPI: { getPathForFile: (f) => 'C:\\synthetic\\' + f.name },
    };
    vm.createContext(ctx);
    vm.runInContext(WIRE, ctx);
    const el = (tabBtn) => ({
        closest: (sel) => (tabBtn && /tab-button/.test(sel) ? { getAttribute: (a) => (a === 'data-tab' ? tabBtn : null) } : null),
    });
    const fire = (type, names, opts) => {
        opts = opts || {};
        const files = names.map(n => ({ name: n, type: /\.pdf$/i.test(n) ? 'application/pdf' : /\.zip$/i.test(n) ? 'application/zip' : /\.png$/i.test(n) ? 'image/png' : 'text/plain' }));
        const e = {
            target: el(opts.tabBtn),
            dataTransfer: { items: files.map(f => ({ kind: 'file', type: f.type })), files, dropEffect: 'none' },
            defaultPrevented: false,
            preventDefault() { this.defaultPrevented = true; },
        };
        (handlers[type] || []).forEach(fn => fn(e));
        return e;
    };
    return {
        ctx, calls, fire,
        overlayShown: () => !!overlay && overlay.style.display === 'block',
        overlayText: () => overlayText.textContent,
        drop: (names, opts) => { fire('dragenter', names, opts); const o = fire('dragover', names, opts); const d = fire('drop', names, opts); return { over: o, drop: d }; },
    };
}

// ── 1. Cyber Tips tab ───────────────────────────────────────────────────
console.log('1. Cyber Tips tab');
{
    const p = makePage('cyberTips');
    const o = p.fire('dragover', ['tip.synthetic.zip']);
    ok(o.defaultPrevented && o.dataTransfer.dropEffect === 'copy', 'a ZIP drag over the Cyber Tips tab is accepted');
    ok(p.overlayShown() && /CyberTip PDF or ZIP/.test(p.overlayText()), 'overlay says CyberTip PDF or ZIP');
    const r = p.drop(['tip.synthetic.pdf', 'tip.synthetic.zip', 'notes.synthetic.txt']);
    ok(r.drop.defaultPrevented, 'drop is claimed (no navigation)');
    eq(p.calls.filter(c => c[0] === 'cybertip'), [['cybertip', ['C:\\synthetic\\tip.synthetic.pdf', 'C:\\synthetic\\tip.synthetic.zip']]], 'every PDF and ZIP goes to the CyberTip import');
    ok(p.calls.some(c => c[0] === 'toast' && /1 file was skipped/.test(c[2]) && /CyberTip PDFs or ZIPs/.test(c[2])), 'the text file is reported as skipped');
    ok(!p.calls.some(c => c[0] === 'render'), 'no tab switch when already on Cyber Tips');
    ok(!p.overlayShown(), 'overlay hidden after drop');
}
{
    const p = makePage('cyberTips');
    p.drop(['notes.synthetic.txt']);
    ok(!p.calls.some(c => c[0] === 'cybertip'), 'a text file alone imports nothing');
    ok(p.calls.some(c => c[0] === 'toast' && /Drop CyberTip PDFs or ZIPs/.test(c[2])), 'and says what the tab takes');
}
{
    const p = makePage('cyberTips');
    const o = p.fire('dragover', ['photo.synthetic.png']);
    ok(!o.defaultPrevented && !p.overlayShown(), 'an image-only drag is left for ViperDrop (no overlay)');
}

// ── 2. RMS Import tab ───────────────────────────────────────────────────
console.log('2. RMS Import tab');
{
    const p = makePage('rmsImport');
    p.drop(['a.synthetic.pdf', 'b.synthetic.pdf', 'c.synthetic.zip']);
    eq(p.calls.filter(c => c[0] === 'rms'), [['rms', ['C:\\synthetic\\a.synthetic.pdf', 'C:\\synthetic\\b.synthetic.pdf']]], 'every PDF goes to the RMS import; the ZIP does not');
    ok(p.calls.some(c => c[0] === 'toast' && /only PDF reports/.test(c[2])), 'the ZIP is reported as skipped');
    ok(/RMS report PDFs/.test(p.overlayText()), 'overlay says RMS report PDFs');
}

// ── 3. DMV tabs keep taking the first PDF ──────────────────────────────
console.log('3. DMV tabs');
[['suspects', 'dmv-suspect'], ['victims', 'dmv-victim'], ['witnesses', 'dmv-witness'], ['involvedPersons', 'dmv-involved']].forEach(([tab, fn]) => {
    const p = makePage(tab);
    p.drop(['dl1.synthetic.pdf', 'dl2.synthetic.pdf']);
    eq(p.calls.filter(c => c[0] === fn), [[fn, 'C:\\synthetic\\dl1.synthetic.pdf']], tab + ': first PDF to the DMV import');
    ok(!p.calls.some(c => c[0] === 'cybertip' || c[0] === 'rms'), tab + ': nothing else imported');
});
{
    const p = makePage('suspects');
    p.drop(['tip.synthetic.zip']);
    ok(!p.calls.some(c => /^dmv/.test(c[0])), 'a ZIP on Suspects is not a DMV printout');
}

// ── 4. Dropping on a module tab button ─────────────────────────────────
console.log('4. Tab buttons');
{
    const p = makePage('overview');
    const o = p.fire('dragover', ['r.synthetic.pdf'], { tabBtn: 'rmsImport' });
    ok(o.defaultPrevented && p.overlayShown() && /RMS report PDFs/.test(p.overlayText()), 'over the RMS Import button from Overview: accepted, overlay names RMS');
    p.fire('drop', ['r.synthetic.pdf'], { tabBtn: 'rmsImport' });
    eq(p.calls.filter(c => c[0] === 'render' || c[0] === 'rms'), [['render', 'rmsImport'], ['rms', ['C:\\synthetic\\r.synthetic.pdf']]], 'opens RMS Import, then imports');
}
{
    const p = makePage('rmsImport');
    p.fire('dragover', ['t.synthetic.zip'], { tabBtn: 'cyberTips' });
    ok(/CyberTip/.test(p.overlayText()), 'over the Cyber Tips button from RMS: overlay switches to CyberTip');
    p.fire('drop', ['t.synthetic.zip'], { tabBtn: 'cyberTips' });
    eq(p.calls.filter(c => c[0] === 'render' || c[0] === 'cybertip' || c[0] === 'rms'), [['render', 'cyberTips'], ['cybertip', ['C:\\synthetic\\t.synthetic.zip']]], 'ZIP on the Cyber Tips button goes to CyberTip, not RMS');
}
{
    const p = makePage('cyberTips');
    const o = p.fire('dragover', ['x.synthetic.pdf'], { tabBtn: 'suspects' });
    ok(!o.defaultPrevented, 'another module\'s button (Suspects) does not accept the drag');
    p.fire('drop', ['x.synthetic.pdf'], { tabBtn: 'suspects' });
    ok(!p.calls.some(c => c[0] === 'cybertip' || /^dmv/.test(c[0])), 'and the drop imports nothing');
}
{
    const p = makePage('cyberTips');
    p.drop(['y.synthetic.pdf'], { tabBtn: 'cyberTips' });
    eq(p.calls.filter(c => c[0] === 'render' || c[0] === 'cybertip'), [['cybertip', ['C:\\synthetic\\y.synthetic.pdf']]], 'own tab button: imports without re-render');
}

// ── 5. Tabs without an importer ─────────────────────────────────────────
console.log('5. Other tabs');
['overview', 'evidence', 'warrantAuthor'].forEach(tab => {
    const p = makePage(tab);
    const r = p.drop(['z.synthetic.pdf']);
    ok(!r.over.defaultPrevented && !r.drop.defaultPrevented && !p.overlayShown() && p.calls.length === 0, tab + ': untouched (left to ViperDrop / window guard)');
});

// ── 6. importCyberTipPdf: dropped paths skip the picker ─────────────────
console.log('6. importCyberTipPdf');
(async () => {
    const mk = () => {
        const calls = [];
        const ctx = {
            calls, console,
            window: { electronAPI: { selectCybertipFiles: async () => { calls.push(['picker']); return ['C:\\synthetic\\picked.pdf']; } } },
            _importCyberTipFiles: async (items) => { calls.push(['import', items]); },
            hideLoadingIndicator: () => {}, viperToast: () => {},
        };
        vm.createContext(ctx);
        vm.runInContext(IMPORT_CT + '\nthis.importCyberTipPdf = importCyberTipPdf;', ctx);
        return ctx;
    };
    let c = mk();
    await c.importCyberTipPdf(['C:\\synthetic\\a.pdf', 'C:\\synthetic\\b.zip']);
    eq(c.calls, [['import', [{ path: 'C:\\synthetic\\a.pdf' }, { path: 'C:\\synthetic\\b.zip' }]]], 'dropped paths go straight to the import loop');
    c = mk();
    await c.importCyberTipPdf();
    eq(c.calls, [['picker'], ['import', [{ path: 'C:\\synthetic\\picked.pdf' }]]], 'no paths: the picker is shown');
    c = mk();
    await c.importCyberTipPdf({ type: 'click' });
    ok(c.calls[0] && c.calls[0][0] === 'picker', 'a non-array argument still shows the picker');
    c = mk();
    await c.importCyberTipPdf([]);
    ok(c.calls[0] && c.calls[0][0] === 'picker', 'an empty list shows the picker');

    // ── 7. page wiring ──
    console.log('7. Page wiring');
    ok(/onclick="importCyberTipPdf\(\)"/.test(DETAIL), 'Import buttons still call importCyberTipPdf() with no paths');
    ok(/drag and drop the PDF or ZIP anywhere on this tab/.test(DETAIL), 'Cyber Tips empty state mentions drag and drop');
    ok(/async function handleRmsImport\(droppedPaths\)/.test(DETAIL), 'handleRmsImport takes dropped paths');

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

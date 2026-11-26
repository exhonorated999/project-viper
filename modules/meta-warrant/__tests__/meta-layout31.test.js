/**
 * Meta return pages whose markup the importer did not recognise
 * (Scout submission #31: a ZIP with records.html + preservation-1.html,
 * linked_media/ and a "How to use these files" readme was rejected with
 * "No Meta pages found").  Scout only records tag names, so the exact
 * change is unknown; these tests pin the hardening:
 *
 *   A. table layout moved from inline styles into CSS classes, no
 *      div_table class, no "Legal Request" title  -> must import exactly
 *      like the inline layout (same counts, threads, IPs, media)
 *   B. same, plus sections renamed away from "property-"  -> TOC layout
 *   C. key cell + value cell rows (display:table-row)
 *   D. no key/value rows at all, Meta-named + Meta-branded  -> kept as
 *      plain text and flagged, never rejected
 *   E. failures say what was found and why it was not used
 *
 * Synthetic data only (ig-fixture.js).
 * Run: set ELECTRON_RUN_AS_NODE=1&& node_modules\electron\dist\electron.exe modules\meta-warrant\__tests__\meta-layout31.test.js
 */
'use strict';
process.noAsar = true;
const fs = require('fs');
const os = require('os');
const path = require('path');
const IG = require('./fixtures/ig-fixture');
const T = require('../meta-html-tree');
const MI = require('../meta-interpret');
const { importReturn, isMetaReturn } = require('../meta-warrant-importer');
const Store = require('../meta-warrant-store');

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) pass++; else { fail++; console.log('  FAIL: ' + name); } }
function eq(a, b, name) { ok(a === b, name + ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-meta-l31-'));

const CSS = '<style type="text/css">/* print */ @media print { .noprint { display:none } }\n' +
    '.kvw { font-weight: bold; }\n.kv{font-weight:bold;display: table}\n' +
    'div.rec > .kvc, .kvc { font-weight: normal; display: table-cell !important; padding: 2px }\n' +
    '.kv:hover { display: table-cell }\n</style>';

/** Inline-styled fixture page -> class-styled page (same content). */
function toClassLayout(html, opts) {
    opts = opts || {};
    let h = html
        .replace(/class="div_table" style="font-weight: bold; display:table;"/g, 'class="kv"')
        .replace(/class="div_table" style="font-weight: bold;"/g, 'class="kvw"')
        .replace(/style="font-weight: normal; display:table-cell;[^"]*"/g, 'class="kvc"')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/, CSS)
        .replace(/Legal Request/g, 'Records');
    if (opts.renameSections) {
        h = h.replace(/id="property-/g, 'id="sec-').replace(/href="#property-/g, 'href="#sec-').replace(/ property="[^"]*"/g, '');
    }
    return h;
}

function convertReturn(srcDir, dstDir, opts) {
    const walk = (d, rel) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const a = path.join(d, e.name), r = path.join(dstDir, rel, e.name);
            if (e.isDirectory()) { fs.mkdirSync(r, { recursive: true }); walk(a, path.join(rel, e.name)); }
            else if (/\.html$/i.test(e.name)) fs.writeFileSync(r, toClassLayout(fs.readFileSync(a, 'utf8'), opts));
            else fs.copyFileSync(a, r);
        }
    };
    fs.mkdirSync(dstDir, { recursive: true });
    walk(srcDir, '');
    fs.writeFileSync(path.join(dstDir, 'How to use these files.txt'), 'Contents of this file\n----------------------\nHow to use these files\n');
}

async function zipFolder(dir, zipPath) {
    const JSZip = require('jszip');
    const z = new JSZip();
    const walk = (d, rel) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const abs = path.join(d, e.name);
            const r = rel ? rel + '/' + e.name : e.name;
            if (e.isDirectory()) walk(abs, r); else z.file(r, fs.readFileSync(abs));
        }
    };
    walk(dir, '');
    fs.writeFileSync(zipPath, await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

const summary = (r) => {
    const idx = Store.readIndex(r.dir);
    return {
        service: idx.service, target: r.meta.targetId,
        totals: idx.totals,
        cats: idx.categories.map(c => (c.id + ':' + c.count + ':' + c.onlyPres)).sort().join('|'),
        threads: idx.threads.map(t => t.threadId + ':' + t.count + ':' + t.onlyPres).sort().join('|'),
        media: Object.keys(Store.readMediaMap(r.dir)).length,
        missing: r.meta.totals.missingMedia
    };
};

(async () => {
    // ── unit: CSS class extraction ──────────────────────────────────────
    {
        const c = T._internal.cssTableClasses(CSS.replace(/<\/?style[^>]*>/g, ''));
        ok(c.row.has('kv') && !c.row.has('kvw'), 'css: .kv is a row, .kvw is not');
        ok(c.cell.has('kvc'), 'css: .kvc is a cell (descendant + grouped selector, !important)');
        ok(!c.cell.has('kv') && c.row.has('kv'), 'css: :hover rule ignored');
        ok(!c.row.has('noprint') && !c.cell.has('noprint'), 'css: display:none ignored');
        const r2 = T._internal.cssTableClasses('.tr{display:table-row}.td{display:table-cell}');
        ok(r2.row.has('tr') && r2.cell.has('td'), 'css: table-row counts as a row');
    }

    // ── detection ───────────────────────────────────────────────────────
    const src = path.join(tmp, 'inline');
    IG.writeReturn(src, { preservations: 1 });
    const recInline = fs.readFileSync(path.join(src, 'records.html'), 'utf8');
    const recA = toClassLayout(recInline);
    const recB = toClassLayout(recInline, { renameSections: true });
    ok(!/div_table|Legal Request|display:table-cell;/.test(recA.replace(/<style[\s\S]*?<\/style>/, '')), 'fixture A: no inline markers left');
    ok(T.looksLikeMetaPage(recA.slice(0, 300000)), 'detect A: class layout with property ids');
    ok(T.looksLikeMetaPage(recB.slice(0, 300000)), 'detect B: class layout, renamed sections (template markers)');
    ok(!T.looksLikeMetaPage('<div class="content-pane">generic report</div>'), 'detect: template marker without brand is not Meta');
    ok(!T.looksLikeMetaPage('<html><title>Google Takeout</title><a href="#x">x</a></html>'), 'detect: other provider still rejected');

    // ── parse: class layout == inline layout ───────────────────────────
    {
        const pi = T.parsePage(recInline), pa = T.parsePage(recA);
        eq(pa.layout, 'property', 'parse A: property layout');
        eq(pa.categories.length, pi.categories.length, 'parse A: same category count');
        eq(JSON.stringify(pa.categories.map(c => c.v)), JSON.stringify(pi.categories.map(c => c.v)), 'parse A: identical values');
        const pb = T.parsePage(recB);
        eq(pb.layout, 'toc', 'parse B: TOC layout');
        eq(pb.categories.length, pi.categories.length, 'parse B: same category count');
        const ips = pb.categories.find(c => /ip_addresses$/.test(c.id));
        ok(ips && MI.items(ips).length > 1, 'parse B: IP records still split');
        // CSS state does not leak into the next parse
        const plain = T.parsePage('<html><head><title>Instagram</title></head><body><div id="property-x"><div class="kv">K<div class="kvc">v</div></div></div></body></html>');
        eq(plain.categories[0] && (plain.categories[0].v.r || []).length, 0, 'parse: classes without a stylesheet are not rows');
    }

    // ── C: key cell + value cell ────────────────────────────────────────
    {
        const html = '<html><head><title>Facebook Business Record</title><style>.r{display:table-row}.c{display:table-cell}</style></head><body>' +
            '<ul><li><a href="#s-logins">Logins</a></li></ul>' +
            '<div id="s-logins"><div class="rec"><div class="r"><div class="c">IP Address</div><div class="c">198.51.100.7</div></div>' +
            '<div class="r"><div class="c">Time</div><div class="c">2026-03-01 10:00:00 UTC</div></div></div>' +
            '<div class="rec"><div class="r"><div class="c">IP Address</div><div class="c">198.51.100.8</div></div>' +
            '<div class="r"><div class="c">Time</div><div class="c">2026-03-02 10:00:00 UTC</div></div></div></div></body></html>';
        const p = T.parsePage(html);
        eq(p.categories.length, 1, 'C: one section');
        const items = p.categories[0] ? MI.items(p.categories[0]) : [];
        eq(items.length, 2, 'C: two records');
        eq(items[0] && items[0].f.map(f => f.k).join(), 'IP Address,Time', 'C: key from the first cell');
        eq(items[1] && MI.fieldText(items[1].f[0]), '198.51.100.8', 'C: value from the second cell');
    }

    // ── import A (folder + zip) and B, compared with the inline import ──
    const base = await importReturn({ sourcePath: src, caseDir: path.join(tmp, 'c0'), storeKey: 'k', meta: {} });
    const want = summary(base);
    ok(want.totals.items > 10 && want.totals.messages > 5, 'baseline import has data');

    const dirA = path.join(tmp, 'classA');
    convertReturn(src, dirA);
    eq(await isMetaReturn(dirA, null), true, 'isMetaReturn(A folder)');
    const rA = await importReturn({ sourcePath: dirA, caseDir: path.join(tmp, 'c1'), storeKey: 'k', meta: {} });
    const gotA = summary(rA);
    eq(JSON.stringify(gotA), JSON.stringify(want), 'import A (folder) == inline import');
    eq(rA.index.skippedPages.length, 0, 'import A: no page skipped (readme is not a page)');

    const zipA = path.join(tmp, 'classA.zip');
    await zipFolder(dirA, zipA);
    eq(await isMetaReturn(zipA, null), true, 'isMetaReturn(A zip)');
    const rAz = await importReturn({ sourcePath: zipA, caseDir: path.join(tmp, 'c2'), storeKey: 'k', meta: {} });
    eq(JSON.stringify(summary(rAz)), JSON.stringify(want), 'import A (zip) == inline import');

    const dirB = path.join(tmp, 'classB');
    convertReturn(src, dirB, { renameSections: true });
    const rB = await importReturn({ sourcePath: dirB, caseDir: path.join(tmp, 'c3'), storeKey: 'k', meta: {} });
    const gotB = summary(rB);
    eq(gotB.totals.categories, want.totals.categories, 'import B: every category');
    eq(gotB.totals.ips, want.totals.ips, 'import B: same IP sightings');
    eq(gotB.media, want.media, 'import B: same media');
    eq(gotB.service, 'Instagram', 'import B: service from title');

    // ── D: unknown markup, Meta-named + branded -> plain text, flagged ──
    {
        const dirD = path.join(tmp, 'textD');
        fs.mkdirSync(path.join(dirD, 'linked_media'), { recursive: true });
        const pg = (n) => '<html><head><title>Instagram</title></head><body><ul><li><a href="#a">Account</a></li></ul>' +
            '<section id="a"><p>Account details page ' + n + '</p><p>Username: synthetic_user</p></section>' +
            '<img src="linked_media/p1.jpg"></body></html>';
        fs.writeFileSync(path.join(dirD, 'records.html'), pg(0));
        fs.writeFileSync(path.join(dirD, 'preservation-1.html'), pg(1));
        fs.writeFileSync(path.join(dirD, 'linked_media', 'p1.jpg'), Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3]));
        const rD = await importReturn({ sourcePath: dirD, caseDir: path.join(tmp, 'c4'), storeKey: 'k', meta: {} });
        const idx = Store.readIndex(rD.dir);
        eq(idx.pages.length, 2, 'D: both pages imported');
        eq(idx.pages[0].layout, 'toc-text', 'D: layout flagged as plain text');
        const hit = Store.query(rD.dir, { kind: 'search', q: 'synthetic_user' });
        ok(hit.rows.length >= 1, 'D: page text searchable');
        eq(Object.keys(Store.readMediaMap(rD.dir)).length, 1, 'D: media still copied');
    }

    // ── E: failures explain themselves ──────────────────────────────────
    {
        const dirE = path.join(tmp, 'errE');
        fs.mkdirSync(dirE);
        fs.writeFileSync(path.join(dirE, 'records.html'), '<html><body><p>some unrelated report</p></body></html>');
        fs.writeFileSync(path.join(dirE, 'other.html'), '<html><body>x</body></html>');
        let err = null;
        try { await importReturn({ sourcePath: dirE, caseDir: path.join(tmp, 'c5'), storeKey: 'k', meta: {} }); } catch (e) { err = e; }
        ok(err && /^No Meta pages found/.test(err.message), 'E: keeps the familiar first sentence');
        ok(err && /records\.html — no Meta sections recognised \(\d+ bytes\)/.test(err.message), 'E: names the Meta page and why');
        ok(err && /other\.html — not a Meta page/.test(err.message), 'E: names the other page');
        ok(err && /Submit unsupported format/.test(err.message), 'E: points to the format submission');

        const dirN = path.join(tmp, 'nested');
        fs.mkdirSync(dirN);
        fs.copyFileSync(zipA, path.join(dirN, 'inner-return.zip'));
        err = null;
        try { await importReturn({ sourcePath: dirN, caseDir: path.join(tmp, 'c6'), storeKey: 'k', meta: {} }); } catch (e) { err = e; }
        ok(err && /no HTML pages/.test(err.message) && /inner-return\.zip/.test(err.message), 'E: ZIP inside the ZIP is pointed out');
    }

    console.log(`meta-layout31: ${pass} passed, ${fail} failed.`);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  FAIL: threw ' + (e && e.stack || e)); console.log(`meta-layout31: ${pass} passed, ${fail + 1} failed.`); process.exit(1); });

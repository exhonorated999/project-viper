/*
 * Chromium half of rich-editor.test.js — run by that test with Electron:
 *   electron modules/reports/__tests__/rich-editor.chromium.js   (VRE_OUT=<json file>)
 * Loads rich-editor.js into a hidden window and runs the in-page checks
 * below; writes { results: [[name, ok, extra], ...] } (or { error }) to VRE_OUT.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const OUT = process.env.VRE_OUT;
const done = (obj) => { try { if (OUT) fs.writeFileSync(OUT, JSON.stringify(obj)); } catch (_) {} app.exit(0); };

// Runs inside the page. Must be self-contained.
async function pageTests() {
    const R = [];
    const ok = (n, c, x) => R.push([n, !!c, c ? undefined : x]);
    const RE = window.ViperRichEditor;
    const S = (h) => RE.sanitize(h, document);
    const tick = () => new Promise((r) => setTimeout(r, 30));

    // ── sanitize ──
    window.__pwned = 0;
    let r = S('<p onclick="__pwned=1">a<script>__pwned=2</script><style>p{}</style><iframe src="x"></iframe></p><img src="x" onerror="__pwned=3">');
    await tick();
    ok('sanitize: scripts, styles, frames and handlers are gone', !/script|style>|iframe|onclick|onerror/i.test(r.html), r.html);
    ok('sanitize: nothing ran while cleaning (inert template)', window.__pwned === 0, window.__pwned);
    ok('sanitize: a remote picture is dropped and counted', r.droppedImages === 1 && !/<img/i.test(r.html), r);
    r = S('<p><a href="javascript:alert(1)">link text</a></p>');
    ok('sanitize: links become plain text', r.html === '<p>link text</p>', r.html);
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    r = S('<img src="' + png + '" data-wrap="left" style="width:40%;float:left;position:fixed" alt="scene" title="t" class="foo vre-x">');
    ok('sanitize: a data: picture keeps its wrap, width and float', /data-wrap="left"/.test(r.html) && /width:40%/.test(r.html) && /float:left/.test(r.html) && r.droppedImages === 0, r.html);
    ok('sanitize: …but not positioning, title or foreign classes', !/position|title=|foo/.test(r.html) && /class="vre-x"/.test(r.html) && /alt="scene"/.test(r.html), r.html);
    r = S('<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">');
    ok('sanitize: SVG pictures are refused (they can carry script)', !/<img/.test(r.html) && r.droppedImages === 1, r.html);
    r = S('<p style="color:red;font-weight:bold;background:url(x)">x</p>');
    ok('sanitize: colours/backgrounds dropped, bold kept', r.html === '<p style="font-weight:bold">x</p>', r.html);
    r = S('<font size="5" face="Arial">big</font><font>plain</font>');
    ok('sanitize: <font size> becomes a px span; a bare <font> just text', r.html === '<span style="font-size:24px">big</span>plain', r.html);
    r = S('<!--[if gte vml 1]><v:shape><v:imagedata src="file:///C:/x.png"></v:imagedata></v:shape><![endif]--><p class="MsoNormal">Word<o:p></o:p></p>');
    ok('sanitize: Word comments, VML and o:p are cleaned', r.html === '<p>Word</p>', r.html);
    r = S('<table><tr><td colspan="2" rowspan="999" onclick="x">a</td></tr></table>');
    ok('sanitize: sane colspan kept, absurd rowspan and handlers dropped', /colspan="2"/.test(r.html) && !/rowspan|onclick/.test(r.html), r.html);
    r = S('<span>a</span><span style="font-style:italic">b</span><div class="vre-pagebreak x" style="page-break-after:always"></div>');
    ok('sanitize: empty spans unwrapped; page break kept', /^a<span style="font-style:italic">b<\/span><div [^>]*><\/div>$/.test(r.html) && /class="vre-pagebreak"/.test(r.html) && /style="page-break-after:always"/.test(r.html), r.html);
    r = S('<form><input value="x"><button>b</button><select><option>o</option></select></form><p>keep</p>');
    ok('sanitize: form controls dropped', r.html === '<p>keep</p>', r.html);
    r = S('<svg><script>__pwned=4</script></svg><math></math><p>m</p>');
    await tick();
    ok('sanitize: svg/math dropped', r.html === '<p>m</p>' && window.__pwned === 0, r.html);

    // ── attach ──
    const mk = (html) => {
        const host = document.getElementById('host');
        host.innerHTML = '<div id="bar"></div><div id="ed" contenteditable="true" style="width:600px;padding:10px">' + (html || '') + '</div>';
        return { ed: document.getElementById('ed'), bar: document.getElementById('bar') };
    };
    let changes = 0;
    let { ed, bar } = mk('<p>Start typing your report here...</p>');
    let c = RE.attach({ editor: ed, toolbar: bar, onChange: () => changes++, toast: () => {} });
    ok('attach: toolbar inserted, editor marked, CSS injected once', !!bar.querySelector('[data-vre-bar]') && ed.classList.contains('vre-editor') && document.querySelectorAll('#vre-style').length === 1);
    ok('attach: a second attach returns the same controller', RE.attach({ editor: ed, toolbar: bar }) === c);
    ed.focus();
    c.insertTable(2, 3, true);
    let t = ed.querySelector('table');
    ok('table: inserted, replacing the placeholder text', !!t && !/Start typing/.test(ed.textContent), ed.innerHTML.slice(0, 200));
    ok('table: 2 rows × 3, header row of th', t && t.rows.length === 2 && t.rows[0].cells.length === 3 && t.rows[0].cells[0].tagName === 'TH' && t.rows[1].cells[0].tagName === 'TD');
    ok('table: no "new" marker left; caret in the first cell', t && !t.hasAttribute('data-vre-new') && window.getSelection().anchorNode && (window.getSelection().anchorNode === t.rows[0].cells[0] || t.rows[0].cells[0].contains(window.getSelection().anchorNode)));
    ok('table: onChange told', changes > 0);
    const caret = (cell) => { const rg = document.createRange(); rg.selectNodeContents(cell); rg.collapse(true); const s = window.getSelection(); s.removeAllRanges(); s.addRange(rg); };
    caret(t.rows[1].cells[1]);
    c.tableOp('row:below');
    ok('table: row below', t.rows.length === 3 && t.rows[2].cells.length === 3 && t.rows[2].cells[0].tagName === 'TD');
    caret(t.rows[0].cells[0]);
    c.tableOp('row:above');
    ok('table: row above the header row is a normal row', t.rows.length === 4 && t.rows[0].cells[0].tagName === 'TD' && t.rows[1].cells[0].tagName === 'TH');
    caret(t.rows[1].cells[2]);
    c.tableOp('col:right');
    ok('table: column right (every row)', Array.from(t.rows).every((tr) => tr.cells.length === 4) && t.rows[1].cells[3].tagName === 'TH');
    caret(t.rows[2].cells[0]);
    c.tableOp('col:left');
    ok('table: column left', Array.from(t.rows).every((tr) => tr.cells.length === 5));
    caret(t.rows[2].cells[0]);
    c.tableOp('col:delete');
    caret(t.rows[0].cells[0]);
    c.tableOp('row:delete');
    ok('table: delete column and row', t.rows.length === 3 && Array.from(t.rows).every((tr) => tr.cells.length === 4), [t.rows.length, t.rows[0] && t.rows[0].cells.length]);
    caret(t.rows[1].cells[0]);
    ok('table: the header row is the first row now', t.rows[0].cells[0].tagName === 'TH');
    c.tableOp('table:header');
    ok('table: Header row turns it back into a normal row', t.rows[0].cells[0].tagName === 'TD');
    c.tableOp('table:header');
    ok('table: …and into a header row again', t.rows[0].cells[0].tagName === 'TH');
    // colspan-aware column insert
    t.rows[0].cells[0].setAttribute('colspan', '2'); t.rows[0].cells[1].remove();
    caret(t.rows[1].cells[2]);
    c.tableOp('col:right');
    ok('table: merged cells keep columns lined up', t.rows[0].cells.length === 4 && t.rows[1].cells.length === 5, [t.rows[0].cells.length, t.rows[1].cells.length]);
    caret(t.rows[1].cells[0]);
    c.tableOp('table:delete');
    ok('table: delete table', !ed.querySelector('table'));
    ed.focus();
    ed.innerHTML = '<p>alpha</p><table><tr><td>a</td><td>b</td></tr></table>';
    t = ed.querySelector('table');
    caret(t.rows[0].cells[1]);
    ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    ok('table: Tab in the last cell adds a row', t.rows.length === 2);

    // pictures
    ed.innerHTML = '<p>Text that wraps around the picture.</p>';
    const cv = document.createElement('canvas'); cv.width = 300; cv.height = 200;
    const g = cv.getContext('2d'); g.fillStyle = '#c00'; g.fillRect(0, 0, 300, 200);
    const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
    const file = new File([blob], 'scene.png', { type: 'image/png' });
    const rg = document.createRange(); rg.selectNodeContents(ed.firstChild); rg.collapse(false);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(rg);
    const n = await c.insertFiles([file, new File(['x'], 'notes.txt', { type: 'text/plain' })]);
    let img = ed.querySelector('img');
    ok('picture: inserted (a non-picture file is ignored)', n === 1 && !!img, ed.innerHTML.slice(0, 200));
    ok('picture: a data: PNG, top & bottom, sized to its natural width', img && /^data:image\/png;base64,/.test(img.getAttribute('src')) && img.getAttribute('data-wrap') === 'center' && /width:50%/.test(img.getAttribute('style')), img && img.getAttribute('style'));
    c.select(img);
    await tick();
    ok('picture: selecting shows the picture bar and hides the table bar', !bar.querySelector('[data-vre-ctx="image"]').hidden && bar.querySelector('[data-vre-ctx="table"]').hidden);
    ok('picture: selection frame + 4 corner handles', !document.querySelector('.vre-frame').hidden && document.querySelectorAll('.vre-h:not([hidden])').length === 4);
    c.setWrap(img, 'left');
    ok('picture: wrap left', img.getAttribute('data-wrap') === 'left' && img.style.cssFloat === 'left' && /width:50%/.test(img.getAttribute('style')));
    c.setWrap(img, 'right');
    ok('picture: wrap right', img.style.cssFloat === 'right');
    c.setWrap(img, 'inline');
    ok('picture: in line', img.style.cssFloat === 'none' && img.style.display === 'inline-block');
    c.setSize(img, 25);
    ok('picture: size 25 % keeps the wrap', /width:25%/.test(img.getAttribute('style')) && img.style.display === 'inline-block');
    // drag the SE handle: 600px column → +150px ≈ +25 %
    const h = document.querySelector('.vre-h[data-c="se"]');
    const b0 = img.getBoundingClientRect();
    h.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: b0.right, clientY: b0.bottom }));
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: b0.right + 150, clientY: b0.bottom }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    const pct = parseFloat(img.style.width);
    ok('picture: dragging a corner resizes in % of the column', pct > 45 && pct < 55, img.getAttribute('style'));
    ok('picture: saved HTML has no selection marks', !/vre-img-selected|viper-img-selected|data-vre-new/.test(RE.cleanHtml(ed)));
    ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
    ok('picture: Delete removes the selected picture', !ed.querySelector('img') && document.querySelector('.vre-frame').hidden);

    // font size
    ed.innerHTML = '<p>one two three</p>';
    const tn = ed.firstChild.firstChild;
    const sr = document.createRange(); sr.setStart(tn, 4); sr.setEnd(tn, 7);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(sr);
    c.applySize(18);
    ok('font size: a px span, no <font> left', /<span style="font-size: ?18px;?">two<\/span>/.test(ed.innerHTML) && !/<font/i.test(ed.innerHTML), ed.innerHTML);

    // paste
    ed.innerHTML = '<p>x</p>';
    const pr = document.createRange(); pr.selectNodeContents(ed.firstChild); pr.collapse(false);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(pr);
    let toasts = [];
    c.destroy();
    c = RE.attach({ editor: ed, toolbar: bar, toast: (m) => toasts.push(m) });
    const dt = new DataTransfer();
    dt.setData('text/html', '<html><body><p style="color:red" onclick="__pwned=5">pasted <b>bold</b></p><img src="https://example.invalid/a.png"><script>__pwned=6</script></body></html>');
    dt.setData('text/plain', 'pasted bold');
    ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await tick();
    ok('paste: formatting kept, handlers / scripts / colours dropped', /pasted <b>bold<\/b>/.test(ed.innerHTML) && !/onclick|script|color/i.test(ed.innerHTML) && window.__pwned === 0, ed.innerHTML);
    ok('paste: a remote picture is dropped and the officer told', !/<img/i.test(ed.innerHTML) && toasts.some((m) => /could not come across/.test(m)), toasts);

    // re-render: the old editor is gone → its controller retires
    mk('<p>new</p>');
    const c2 = RE.attach({ editor: document.getElementById('ed'), toolbar: document.getElementById('bar') });
    ok('re-render: one set of overlays, the old controller retired', document.querySelectorAll('.vre-frame').length === 1 && document.querySelectorAll('.vre-h').length === 4 && !ed._vre, document.querySelectorAll('.vre-frame').length);
    // A retired controller no longer handles its editor (listeners aborted).
    ed.innerHTML = '<p>z</p>';
    let lateToasts = 0;
    const dt2 = new DataTransfer();
    dt2.setData('text/html', '<p>late <img src="https://example.invalid/b.png"></p>');
    const zr = document.createRange(); zr.selectNodeContents(ed.firstChild); zr.collapse(false);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(zr);
    toasts = [];
    ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt2, bubbles: true, cancelable: true }));
    await tick();
    lateToasts = toasts.length;
    ok('destroyed: a retired controller ignores paste on its old editor', lateToasts === 0 && !/late/.test(ed.innerHTML), [lateToasts, ed.innerHTML]);
    c2.destroy();
    ok('destroy: overlays removed', document.querySelectorAll('.vre-frame,.vre-h,.vre-badge').length === 0);
    return R;
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
    const timer = setTimeout(() => done({ error: 'timed out' }), 90000);
    try {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vre-page-'));
        const page = path.join(dir, 'page.html');
        const lib = pathToFileURL(path.join(__dirname, '..', 'rich-editor.js')).href;
        fs.writeFileSync(page, '<!DOCTYPE html><html><head><meta charset="utf-8"><script src="' + lib + '"></script></head><body><div id="host"></div></body></html>');
        const win = new BrowserWindow({ show: false, width: 900, height: 900, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
        await win.loadFile(page);
        const results = await win.webContents.executeJavaScript('(' + pageTests.toString() + ')()', true);
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
        clearTimeout(timer);
        done({ results });
    } catch (e) {
        clearTimeout(timer);
        done({ error: (e && e.stack) || String(e) });
    }
});

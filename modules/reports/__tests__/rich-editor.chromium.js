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
    // Case-folder picture references (report-store.js)
    const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    r = S('<img src="' + png + '" data-vp-img="report-image-k1-ab12cd.png" data-vp-img-kind="reports" data-x="1">');
    ok('sanitize: a report picture keeps its case-folder reference', /data-vp-img="report-image-k1-ab12cd\.png"/.test(r.html) && /data-vp-img-kind="reports"/.test(r.html) && !/data-x/.test(r.html), r.html);
    r = S('<img src="' + BLANK + '" data-vp-img="report-image-k1-ab12cd.png" data-vp-img-kind="reports">');
    ok('sanitize: …also while its picture is not loaded yet (nothing lost on save)', /data-vp-img=/.test(r.html) && r.droppedImages === 0, r.html);
    r = S('<img src="' + png + '" data-vp-img="../../x.png" data-vp-img-kind="reports"><img src="' + png + '" data-vp-img="n.png" data-vp-img-kind="notes">');
    ok('sanitize: a path or another kind is not a reference', !/data-vp-img/.test(r.html) && (r.html.match(/<img/g) || []).length === 2, r.html);
    r = RE.sanitize('<img src="' + png + '" data-vp-img="report-image-k1-ab12cd.png" data-vp-img-kind="reports"><img src="' + BLANK + '" data-vp-img="report-image-k2.png" data-vp-img-kind="reports">', document, { pasted: true });
    ok('sanitize (pasted): the reference is dropped so the picture is saved again for this case', !/data-vp-img/.test(r.html) && (r.html.match(/<img/g) || []).length === 1, r.html);
    ok('sanitize (pasted): …an unloaded one cannot come across and is counted', r.droppedImages === 1, r);

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

    // ── find & replace ──
    ({ ed, bar } = mk('<p>The cat sat. the CAT ran.</p><p>Concatenate cat<br>and dog</p><table><tr><td>cat</td><td>a&nbsp;b</td></tr></table>'));
    toasts = [];
    let fc = 0;
    c = RE.attach({ editor: ed, toolbar: bar, onChange: () => fc++, toast: (m) => toasts.push(m) });
    const fq = bar.querySelector('[data-vre-q]'), fr = bar.querySelector('[data-vre-r]');
    const fcnt = bar.querySelector('[data-vre-count]'), fcase = bar.querySelector('[data-vre-case]'), fword = bar.querySelector('[data-vre-word]');
    const setQ = (v) => { fq.value = v; fq.dispatchEvent(new Event('input', { bubbles: true })); };
    const setChk = (el, v) => { el.checked = v; el.dispatchEvent(new Event('change', { bubbles: true })); };
    const caretAt = (node, off) => { const rr = document.createRange(); rr.setStart(node, off); rr.collapse(true); const s = window.getSelection(); s.removeAllRanges(); s.addRange(rr); };
    ok('find: toolbar has a Find button and a hidden find bar', !!bar.querySelector('[data-re="find"]') && bar.querySelector('[data-vre-find]').hidden);
    ed.focus(); caretAt(ed.firstChild.firstChild, 0);
    ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }));
    ok('find: Ctrl+F opens the bar and focuses Find', c.findState.open && document.activeElement === fq, c.findState);
    setQ('cat');
    ok('find: case-insensitive count (Concatenate counts as text)', c.findState.count === 5 && fcnt.textContent === '1 of 5', [c.findState, fcnt.textContent]);
    const hl = window.CSS && CSS.highlights;
    ok('find: matches painted with the highlight API', !!hl && hl.has('vre-find') && hl.has('vre-find-cur') && hl.get('vre-find').size === 4, hl && [...hl.keys()]);
    setChk(fword, true);
    ok('find: whole words skips Concatenate', c.findState.count === 4, c.findState);
    setChk(fcase, true);
    ok('find: match case + whole words', c.findState.count === 3, c.findState);
    setChk(fcase, false); setChk(fword, false);
    c.findPrev();
    ok('find: previous wraps to the last match', c.findState.index === 4 && fcnt.textContent === '5 of 5', [c.findState, fcnt.textContent]);
    c.findNext();
    ok('find: next wraps to the first match', c.findState.index === 0, c.findState);
    fq.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    ok('find: Enter in Find goes to the next match', c.findState.index === 1, c.findState);
    fq.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
    ok('find: Shift+Enter goes back', c.findState.index === 0, c.findState);
    setQ('a b');
    ok('find: a space also finds a non-breaking space', c.findState.count === 1, c.findState);
    setQ('sat. the');
    ok('find: matches inside a paragraph', c.findState.count === 1, c.findState);
    setQ('cat and');
    ok('find: no match across a line break', c.findState.count === 0 && fcnt.textContent === 'No matches' && fq.classList.contains('vre-miss'), [c.findState, fcnt.textContent]);
    setQ('ran. Concatenate');
    ok('find: no match across paragraphs', c.findState.count === 0, c.findState);
    setQ('cat\tran');
    ok('find: regex characters are literal', c.findState.count === 0, c.findState);
    setQ('x(');
    ok('find: an unbalanced bracket does not throw', c.findState.count === 0);

    // replace one
    setQ('cat'); setChk(fword, true);
    fr.value = 'dog';
    fc = 0;
    ok('replace: one at a time', c.replaceOne() === true && /The dog sat\. the CAT ran\./.test(ed.innerHTML), ed.innerHTML);
    ok('replace: moves on to the next match and saves', c.findState.count === 3 && c.findState.index === 0 && fc > 0, [c.findState, fc]);
    ed.focus();
    ok('replace: undoable like typing', document.execCommand('undo') && /The cat sat\./.test(ed.innerHTML), ed.innerHTML);
    c.closeFind(); c.openFind(false); setQ('cat');
    // replace all — a replacement that contains the query is not replaced again
    fr.value = 'cats cat';
    toasts = [];
    let nRep = c.replaceAll();
    ok('replace all: every whole-word match once', nRep === 4 && (ed.textContent.match(/cats cat/g) || []).length === 4 && /Concatenate/.test(ed.textContent), [nRep, ed.textContent]);
    ok('replace all: count shown and the officer told', /^Replaced 4$/.test(fcnt.textContent) && toasts.some((m) => /4 matches replaced/.test(m)), [fcnt.textContent, toasts]);
    ok('replace all: table and <br> structure kept', !!ed.querySelector('td') && !!ed.querySelector('br'), ed.innerHTML);
    setQ('cats cat'); fr.value = '';
    nRep = c.replaceAll();
    ok('replace all: an empty replacement deletes', nRep === 4 && !/cats/.test(ed.textContent), [nRep, ed.textContent]);
    setQ('zzz');
    ok('replace all: nothing to replace → 0', c.replaceAll() === 0 && c.replaceOne() === false);

    // Ctrl+H prefill + Esc close selects the match
    c.closeFind();
    ok('find close: highlights cleared', !hl.has('vre-find') && !hl.has('vre-find-cur'));
    ed.innerHTML = '<p>alpha beta gamma beta</p>';
    ed.focus();
    { const tn2 = ed.firstChild.firstChild, rr = document.createRange(); rr.setStart(tn2, 6); rr.setEnd(tn2, 10); const s = window.getSelection(); s.removeAllRanges(); s.addRange(rr); }
    ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', ctrlKey: true, bubbles: true, cancelable: true }));
    ok('Ctrl+H: the selection becomes the query, Replace gets focus', fq.value === 'beta' && document.activeElement === fr && c.findState.count === 2 && c.findState.index === 0, [fq.value, document.activeElement && document.activeElement.outerHTML.slice(0, 60), c.findState]);
    c.findNext();
    fq.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    const selNow = window.getSelection();
    ok('Esc: bar closes, the current match is selected in the editor', !c.findState.open && document.activeElement === ed && selNow.toString() === 'beta' && selNow.getRangeAt(0).startOffset === 17, [c.findState, selNow.toString(), selNow.rangeCount && selNow.getRangeAt(0).startOffset]);
    // typing while open keeps the count current
    c.openFind(false); setQ('beta');
    ed.focus(); caretAt(ed.firstChild.firstChild, 0);
    document.execCommand('insertText', false, 'beta ');
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    ok('find: edits re-count while the bar is open', c.findState.count === 3, c.findState);
    ok('no inserts: no From case button', !bar.querySelector('[data-re="caseMenu"]') && !bar.querySelector('[data-vre-menu]'));
    c.destroy();
    ok('destroy: find highlights removed', !hl.has('vre-find') && !hl.has('vre-find-cur'));

    // ── From case menu ──
    ({ ed, bar } = mk('<p>Before after</p>'));
    toasts = [];
    let seen = null;
    c = RE.attach({
        editor: ed, toolbar: bar, toast: (m, ty) => toasts.push([m, ty]),
        inserts: [
            { id: 'a', label: 'Table A', run: () => '<p>[A]</p>' },
            { id: 'b', label: 'Later <B>', sep: true, run: (ctx) => { seen = ctx.html(); return new Promise((r) => setTimeout(() => r('<p>[B]</p>'), 20)); } },
            { id: 'c', label: 'Broken', run: () => { throw new Error('No luck'); } },
            { id: 'd', label: 'Nothing', run: () => '' },
            { id: 'e', label: 'No run' },
        ],
    });
    const items = [...bar.querySelectorAll('[data-vre-ins]')];
    ok('menu: From case button and items (escaped, ones without run left out)', !!bar.querySelector('[data-re="caseMenu"]') && items.length === 4 && /Later &lt;B&gt;/.test(items[1].innerHTML) && bar.querySelectorAll('.vre-mi-sep').length === 1, items.map((b) => b.outerHTML));
    ok('menu: hidden until opened', bar.querySelector('[data-vre-menu]').hidden);
    bar.querySelector('[data-re="caseMenu"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    ok('menu: the button opens it', !bar.querySelector('[data-vre-menu]').hidden);
    ed.focus(); caretAt(ed.firstChild.firstChild, 6);
    items[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();
    { const tx = ed.textContent, ps = [...ed.querySelectorAll('p')].map((p) => p.textContent);
      ok('menu: an item inserts its HTML at the caret and closes the menu', /^Before\[A\] ?after$/.test(tx) && tx.indexOf('Before') < tx.indexOf('[A]') && tx.indexOf('[A]') < tx.indexOf('after') && bar.querySelector('[data-vre-menu]').hidden, ed.innerHTML); }
    ed.innerHTML = '<p>One</p><p>Two</p>';
    ed.focus(); caretAt(ed.lastChild.firstChild, 3);
    await tick();
    window.getSelection().removeAllRanges();     // e.g. focus went to a dialog
    const pB = c.runInsert(1);
    await pB;
    ok('menu: a Promise result goes where the caret was', /^One\s*Two\[B\]$/.test(ed.textContent.trim()) && /One/.test(seen || ''), [ed.innerHTML, seen]);
    const nBefore = ed.innerHTML;
    ok('menu: an error is toasted, nothing inserted', (await c.runInsert(2)) === false && ed.innerHTML === nBefore && toasts.some((x) => x[0] === 'No luck' && x[1] === 'error'), toasts);
    ok('menu: an empty result inserts nothing', (await c.runInsert(3)) === false && ed.innerHTML === nBefore);
    // retired editor: a late answer is dropped
    const late = RE.attach({ editor: ed, toolbar: bar }) === c;
    const pLate = c.runInsert(1);
    c.destroy();
    ok('menu: a late answer after destroy is dropped', late && (await pLate) === false && !/\[B\][\s\S]*\[B\]/.test(ed.innerHTML), ed.innerHTML);

    // ── case-inserts.js output through the editor (insertHTML keeps it) ──
    const CI = window.ViperCaseInserts;
    if (CI) {
        ({ ed, bar } = mk('<p>Start typing your report here...</p>'));
        c = RE.attach({ editor: ed, toolbar: bar, toast: () => {}, inserts: [
            { id: 'p', label: 'People', run: () => CI.people([{ firstName: 'Alex', lastName: 'Example', dob: '1990-02-03', height: '510' }], 'suspects', {}) },
            { id: 'ph', label: 'Photo', run: () => CI.photoBlock({ src: png, n: 3, caption: 'rear door, pry marks', widthPct: 60 }) },
        ] });
        ed.focus();
        await c.runInsert(0);
        const tb = ed.querySelector('table.vre-table');
        ok('case table: inserted with header row and styles kept', !!tb && tb.querySelectorAll('th').length >= 2 && /border/.test(tb.querySelector('th').getAttribute('style') || '') && /Alex Example|Example, Alex/.test(tb.textContent) && /5'10"/.test(tb.textContent) && !/Start typing/.test(ed.textContent), ed.innerHTML.slice(0, 400));
        const clean = RE.cleanHtml(ed);
        ok('case table: survives cleanHtml (save)', /<table[^>]*class="vre-table"/.test(clean) && /<th/.test(clean), clean.slice(0, 300));
        await c.runInsert(1);
        const im = ed.querySelector('img[data-wrap="center"]');
        ok('exhibit photo: picture + caption inserted', !!im && /Exhibit 3 \u2014 rear door, pry marks/.test(ed.textContent) && /width:\s*60%/.test(im.getAttribute('style') || ''), ed.innerHTML.slice(-400));
        ok('exhibit photo: next number counts it', CI.nextExhibitNumber(RE.cleanHtml(ed)) === 4);
        c.destroy();
    } else ok('case-inserts.js loaded in the page', false);

    // ── case notes options: links, onDropFiles, noun, an already-handled paste ──
    const lk = RE.sanitize('<p><a href="https://x.test/a?b=1" onclick="__pwned=7" class="evil" target="_top">site</a> <a href="javascript:__pwned=8">js</a> <a href="file:///c:/x">f</a></p>', document, { links: true }).html;
    ok('sanitize links: an http(s) link keeps only its href', /<a href="https:\/\/x\.test\/a\?b=1">site<\/a>/.test(lk) && !/onclick|evil|target/.test(lk), lk);
    ok('sanitize links: javascript: / file: links become text', !/javascript|file:/.test(lk) && /js/.test(lk) && /\bf\b/.test(lk), lk);
    const nolk = RE.sanitize('<a href="https://x.test/">site</a>').html;
    ok('sanitize: links still dropped without the option (reports)', nolk === 'site', nolk);
    ({ ed, bar } = mk('<p>n</p>'));
    toasts = [];
    const dropped = [];
    c = RE.attach({ editor: ed, toolbar: bar, noun: 'note', links: true, toast: (m) => toasts.push(m), onDropFiles: (f) => dropped.push(...f.map((x) => x.name)) });
    const atEnd = () => { const r0 = document.createRange(); r0.selectNodeContents(ed.lastChild); r0.collapse(false); const s0 = window.getSelection(); s0.removeAllRanges(); s0.addRange(r0); };
    atEnd();
    const dtl = new DataTransfer();
    dtl.setData('text/html', '<p>see <a href="https://drive.example.test/f/1">the folder</a></p>');
    ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dtl, bubbles: true, cancelable: true }));
    await tick();
    ok('notes paste: a pasted link stays a link', /<a href="https:\/\/drive\.example\.test\/f\/1">the folder<\/a>/.test(ed.innerHTML), ed.innerHTML);
    const dd = new DataTransfer();
    dd.items.add(new File(['%PDF-1.4'], 'warrant.pdf', { type: 'application/pdf' }));
    ed.dispatchEvent(new DragEvent('drop', { dataTransfer: dd, bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    await tick();
    ok('notes drop: a non-picture file goes to onDropFiles, no refusal toast', dropped.join() === 'warrant.pdf' && !toasts.some((m) => /Only pictures/.test(m)), [dropped, toasts]);
    c.destroy();
    ({ ed, bar } = mk('<p>n</p>'));
    toasts = [];
    let firstSaw = 0;
    ed.addEventListener('paste', (e) => { firstSaw++; e.preventDefault(); }, true);   // like NoteLinks.pasteAsLink
    c = RE.attach({ editor: ed, toolbar: bar, noun: 'note', toast: (m) => toasts.push(m) });
    atEnd();
    const dtp = new DataTransfer();
    dtp.setData('text/html', '<p>SHOULD-NOT-LAND</p>');
    ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dtp, bubbles: true, cancelable: true }));
    await tick();
    ok('paste: one an earlier capture listener handled is left alone', firstSaw === 1 && !/SHOULD-NOT-LAND/.test(ed.innerHTML), ed.innerHTML);
    const dd2 = new DataTransfer();
    dd2.items.add(new File(['x'], 'notes.txt', { type: 'text/plain' }));
    ed.dispatchEvent(new DragEvent('drop', { dataTransfer: dd2, bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    await tick();
    ok('noun: the refusal names the note', toasts.some((m) => m === 'Only pictures can be dropped into the note.'), toasts);
    c.destroy();
    // .vre-doc: saved notes shown read-only get the editor's content styles.
    RE.ensureCss(document);
    const docBox = document.createElement('div');
    docBox.className = 'vre-doc';
    docBox.style.fontSize = '16px';
    docBox.innerHTML = '<h1>T</h1><ul><li>a</li></ul><div class="vre-pagebreak"></div>';
    document.body.appendChild(docBox);
    const h1px = parseFloat(getComputedStyle(docBox.querySelector('h1')).fontSize);
    ok('vre-doc: headings, lists and page breaks styled outside the editor', h1px === 28 && getComputedStyle(docBox.querySelector('ul')).listStyleType === 'disc' && getComputedStyle(docBox.querySelector('.vre-pagebreak')).borderTopStyle === 'dashed', h1px);
    docBox.remove();
    ok('ensureCss: one style element', document.querySelectorAll('#vre-style').length === 1);
    return R;
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
    const timer = setTimeout(() => done({ error: 'timed out' }), 90000);
    try {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vre-page-'));
        const page = path.join(dir, 'page.html');
        const lib = pathToFileURL(path.join(__dirname, '..', 'rich-editor.js')).href;
        const ins = pathToFileURL(path.join(__dirname, '..', 'case-inserts.js')).href;
        fs.writeFileSync(page, '<!DOCTYPE html><html><head><meta charset="utf-8"><script src="' + lib + '"></script><script src="' + ins + '"></script></head><body><div id="host"></div></body></html>');
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

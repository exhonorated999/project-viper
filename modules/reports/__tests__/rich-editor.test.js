/*
 * Report editor toolbar (modules/reports/rich-editor.js).
 *
 * Run: node modules\reports\__tests__\rich-editor.test.js
 *
 * Part 1 runs the pure helpers in Node. Part 2 starts Electron's Chromium
 * (rich-editor.chromium.js, hidden window) because the sanitizer and the
 * editor wiring need a real HTML parser, Selection and execCommand.
 * What it pins:
 *   - pasted / stored HTML keeps report formatting only: no scripts, event
 *     handlers, links, remote pictures, positioning or colours;
 *   - Word's paste junk (comments, o:p, VML) is cleaned; Word font sizes
 *     become real sizes;
 *   - tables: insert, add/remove rows and columns, header row, delete;
 *   - pictures: wrap left/right/inline/top-and-bottom and width in % of the
 *     column; what is saved carries no selection marks;
 *   - font size on a selection becomes a px span (no <font size=7> left);
 *   - re-rendering the tab never leaks overlays or listeners.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..', '..');
const RE = require(path.join(ROOT, 'modules', 'reports', 'rich-editor.js'));

let pass = 0, fail = 0;
const ok = (n, c, x) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? ' -> ' + JSON.stringify(x) : '')); }
};

console.log('\n[cleanStyle]');
ok('keeps report formatting', RE.cleanStyle('font-weight:bold; text-align:center; font-size:18px', 'P') === 'font-weight:bold;text-align:center;font-size:18px');
ok('drops colour, background, positioning, fonts', RE.cleanStyle('color:red;background:#000;position:absolute;top:0;font-family:Comic Sans;z-index:9', 'P') === '');
ok('drops url() / expression / javascript: values', RE.cleanStyle('width:url(x);margin:expression(1);font-size:javascript:1', 'IMG') === '');
ok('float only on pictures and tables', RE.cleanStyle('float:left', 'P') === '' && RE.cleanStyle('float:left', 'IMG') === 'float:left');
ok('width only on pictures / tables / cells', RE.cleanStyle('width:50%', 'P') === '' && RE.cleanStyle('width:50%', 'IMG') === 'width:50%');
ok('height only auto, only on pictures (no stretching)', RE.cleanStyle('height:200px', 'IMG') === '' && RE.cleanStyle('height:auto', 'IMG') === 'height:auto');
ok('!important is stripped, the value kept', RE.cleanStyle('font-weight:bold !important', 'SPAN') === 'font-weight:bold');
ok('mso-* properties dropped', RE.cleanStyle('mso-bidi-font-weight:normal;font-style:italic', 'SPAN') === 'font-style:italic');
ok('a page break style survives', RE.cleanStyle('page-break-after:always;break-after:page', 'DIV') === 'page-break-after:always;break-after:page');
ok('an over-long value is dropped', RE.cleanStyle('margin:' + '1px '.repeat(40), 'P') === '');

console.log('\n[isRichReport — which reports need the laid-out pages]');
ok('plain paragraphs: no', !RE.isRichReport('<p>Text</p><p><b>bold</b> <i>it</i> <u>u</u></p>'));
ok('table: yes', RE.isRichReport('<table><tr><td>a</td></tr></table>'));
ok('picture: yes', RE.isRichReport('<p><img src="data:image/png;base64,AA=="></p>'));
ok('heading / list / rule: yes', RE.isRichReport('<h2>x</h2>') && RE.isRichReport('<ul><li>a</li></ul>') && RE.isRichReport('<ol><li>a</li></ol>') && RE.isRichReport('<hr>'));
ok('centred / right / justified text: yes', RE.isRichReport('<p style="text-align:center">x</p>') && RE.isRichReport('<p style="text-align: justify">x</p>'));
ok('left-aligned text alone: no', !RE.isRichReport('<p style="text-align:left">x</p>'));
ok('font sizes: yes', RE.isRichReport('<span style="font-size:20px">x</span>') && RE.isRichReport('<font size="5">x</font>'));
ok('page break: yes', RE.isRichReport('<div class="vre-pagebreak"></div>'));
ok('indent: yes; zero margin: no', RE.isRichReport('<p style="margin-left:40px">x</p>') && !RE.isRichReport('<p style="margin-left:0px">x</p>'));
ok('empty / null: no', !RE.isRichReport('') && !RE.isRichReport(null));

console.log('\n[tableHtml]');
{
    const h = RE.tableHtml(2, 3, true);
    ok('header row of th, then td rows', (h.match(/<th /g) || []).length === 3 && (h.match(/<td /g) || []).length === 3 && (h.match(/<tr>/g) || []).length === 2);
    ok('full width, collapsed borders, bordered cells', /width:100%;border-collapse:collapse/.test(h) && /border:1px solid #888/.test(h));
    ok('marked new (so the caret can be put in it) and followed by a paragraph', /data-vre-new="1"/.test(h) && /<\/table><p><br><\/p>$/.test(h));
    const n = RE.tableHtml(999, 999, false);
    ok('clamped to 50 rows × 20 columns', (n.match(/<tr>/g) || []).length === 50 && (n.match(/<td /g) || []).length === 1000);
    ok('at least 1 × 1', (RE.tableHtml(0, 0).match(/<td /g) || []).length === 1);
}

console.log('\n[imgStyle / wrapOf]');
ok('wrap left: floats left, text on its right', /float:left;display:block;margin:4px 14px 8px 0/.test(RE.imgStyle('left', 40)) && /^width:40%;height:auto;max-width:100%;/.test(RE.imgStyle('left', 40)));
ok('wrap right: floats right', /float:right;display:block;margin:4px 0 8px 14px/.test(RE.imgStyle('right', 40)));
ok('in line with text', /float:none;display:inline-block;vertical-align:bottom/.test(RE.imgStyle('inline', 40)));
ok('top & bottom (default): centred block', /float:none;display:block;margin:8px auto/.test(RE.imgStyle('center', 40)) && RE.imgStyle('???', 40) === RE.imgStyle('center', 40));
ok('width clamped to 5–100 %', /^width:5%/.test(RE.imgStyle('left', 1)) && /^width:100%/.test(RE.imgStyle('left', 500)) && /^width:100%/.test(RE.imgStyle('left', 'x')));
const fakeImg = (wrap, float) => ({ getAttribute: (a) => (a === 'data-wrap' ? wrap : null), style: { cssFloat: float || '' } });
ok('wrapOf reads data-wrap, else the float, else centre', RE.wrapOf(fakeImg('inline')) === 'inline' && RE.wrapOf(fakeImg(null, 'right')) === 'right' && RE.wrapOf(fakeImg('bogus')) === 'center');

console.log('\n[toolbar markup]');
{
    const t = RE.toolbarHtml();
    const cmds = ['undo', 'redo', 'bold', 'italic', 'underline', 'strikeThrough', 'justifyLeft', 'justifyCenter', 'justifyRight', 'justifyFull',
        'insertUnorderedList', 'insertOrderedList', 'outdent', 'indent', 'tablePicker', 'image', 'pageBreak', 'removeFormat',
        'wrap:inline', 'wrap:left', 'wrap:right', 'wrap:center', 'size:25', 'size:50', 'size:75', 'size:100', 'imgDelete',
        'row:above', 'row:below', 'col:left', 'col:right', 'row:delete', 'col:delete', 'table:header', 'table:delete'];
    const missing = cmds.filter((c) => t.indexOf('data-re="' + c + '"') < 0);
    ok('every command has a button', missing.length === 0, missing);
    ok('paragraph style and font size pickers', /data-re-select="block"/.test(t) && /data-re-select="size"/.test(t) && RE.FONT_SIZES.every((s) => t.indexOf('<option value="' + s + '">') >= 0));
    ok('picture and table bars start hidden', /data-vre-ctx="image" hidden/.test(t) && /data-vre-ctx="table" hidden/.test(t));
    ok('no inline event handlers', !/\son[a-z]+=/i.test(t));
    ok('the picture input takes pictures only', /<input type="file" data-vre-file accept="image\/png,image\/jpeg,image\/gif,image\/webp,image\/bmp" multiple hidden>/.test(t));
    ok('buttons are type=button (never submit a form)', (t.match(/<button /g) || []).length === (t.match(/<button type="button"/g) || []).length);
}

ok('sanitize without a DOM says so', (() => { try { RE.sanitize('<p>x</p>'); return false; } catch (e) { return /needs a DOM/.test(e.message); } })());
ok('cleanHtml(null) is empty', RE.cleanHtml(null) === '');

// ── Part 2: in Chromium ────────────────────────────────────────────────────
console.log('\n[in Chromium (hidden Electron window)]');
const exe = path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
if (!fs.existsSync(exe)) {
    console.log('  SKIP  Electron is not installed (node_modules/electron)');
} else {
    const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vre-test-')), 'out.json');
    const env = Object.assign({}, process.env, { VRE_OUT: outFile });
    delete env.ELECTRON_RUN_AS_NODE;
    const r = spawnSync(exe, [path.join(__dirname, 'rich-editor.chromium.js')], { cwd: ROOT, env, encoding: 'utf8', timeout: 120000 });
    let res = null;
    try { res = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch (_) {}
    try { fs.rmSync(path.dirname(outFile), { recursive: true, force: true }); } catch (_) {}
    if (!res) ok('the Chromium harness ran', false, ((r.stdout || '') + (r.stderr || '') + (r.error ? r.error.message : '')).slice(-800));
    else if (res.error) ok('the Chromium harness ran', false, res.error);
    else res.results.forEach(([n, c, x]) => ok(n, c, x));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);

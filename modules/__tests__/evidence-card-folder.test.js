/**
 * Evidence tab: the sidebar card shows the item's title (tag, else file
 * name) and description plus the file extensions, and the case's Evidence
 * folder / an item's folder open in Explorer (the Forensic Integrity link
 * and the viewer's "Open folder" bar).
 *
 * Runs the shipping helpers (lifted from case-detail-with-analytics.html)
 * and the main-process 'open-case-folder' handler against a stand-in
 * shell / fs.
 *
 * Run: node modules/__tests__/evidence-card-folder.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'case-detail-with-analytics.html'), 'utf8').replace(/\r\n/g, '\n');
const MAIN = fs.readFileSync(path.join(ROOT, 'electron-main.js'), 'utf8').replace(/\r\n/g, '\n');
const PRELOAD = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
function ok(label, cond, detail) {
    if (cond) { pass++; console.log('  PASS  ' + label); }
    else { fail++; console.log('  FAIL  ' + label + (detail !== undefined ? '  -> ' + JSON.stringify(detail).slice(0, 400) : '')); }
}
// The source of `function name(...) { ... }` (brace-matched; the helpers
// lifted here have no braces inside strings that would unbalance it).
function lift(src, name) {
    const re = new RegExp('(?:async )?function ' + name + '\\(');
    const m = re.exec(src);
    if (!m) throw new Error('not found: ' + name);
    let i = src.indexOf('{', m.index), depth = 0;
    for (let j = i; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}' && --depth === 0) return src.slice(m.index, j + 1);
    }
    throw new Error('unbalanced: ' + name);
}

(async () => {
    const names = ['_evEsc', '_evidenceParentDir', '_evFolderOf', '_evFolderPathOf', 'openEvidenceFolder', 'openCaseEvidenceFolder', '_evCardTitle', '_evExtBadges'];
    const ctx = { console, String, Array, Map, RegExp, toasts: [] };
    vm.createContext(ctx);
    vm.runInContext(names.map(n => lift(PAGE, n)).join('\n') + `
        var currentCase = { caseNumber: '2026-00001' };
        var caseEvidence = [];
        var window = { electronAPI: {} };
        function viperToast(m, t) { toasts.push([m, t]); }
        this.api = { _evCardTitle, _evExtBadges, _evFolderPathOf, openEvidenceFolder, openCaseEvidenceFolder,
            setEvidence: (l) => { caseEvidence = l; }, setApi: (a) => { window.electronAPI = a; } };
    `, ctx);
    const A = ctx.api;

    console.log('\n[card title + description]');
    let t = A._evCardTitle({ tag: 'EVID-001', description: 'Signed warrant', files: [{ name: 'a.pdf' }] });
    ok('a tag is the heading', t.text === 'EVID-001' && t.from === 'tag');
    t = A._evCardTitle({ tag: '', description: 'Signed warrant', files: [{ name: 'warrant_signed.pdf' }, { name: 'b.jpg' }] });
    ok('no tag: the first file name is the heading', t.text === 'warrant_signed.pdf' && t.from === 'file' && t.more === 1);
    t = A._evCardTitle({ tag: '  ', description: 'Line one\nline two', files: [] });
    ok('no tag, no files: the description\'s first line', t.text === 'Line one' && t.from === 'description');
    ok('nothing at all: "Evidence Item"', A._evCardTitle({}).text === 'Evidence Item');
    t = A._evCardTitle({ csamSensitive: true, description: 'Reported upload', files: [{ name: 'IMG_0001.jpg' }] });
    ok('a CSAM-flagged item never shows a file name', t.text === 'Reported upload' && t.from === 'description');

    console.log('\n[extension badges]');
    const b = A._evExtBadges({ files: [{ name: 'a.PDF' }, { name: 'b.pdf' }, { name: 'c.jpeg' }, { name: 'd.zip' }, { name: 'noext' }, { name: '.hidden' }] });
    ok('one badge per extension, lower-cased (shown upper by CSS)', /tracking-wide uppercase/.test(b) && />pdf ×2</.test(b) && />jpeg</.test(b) && />zip</.test(b));
    ok('files without an extension add no badge', !/noext|hidden/.test(b));
    const many = A._evExtBadges({ files: ['a.pdf', 'b.jpg', 'c.zip', 'd.docx', 'e.mp4', 'f.txt'].map(name => ({ name })) });
    ok('more than four types: "+N more"', (many.match(/uppercase/g) || []).length === 4 && /\+2 more/.test(many));
    ok('no files: nothing', A._evExtBadges({ files: [] }) === '' && A._evExtBadges({}) === '');
    ok('odd extensions are escaped / dropped', !/<script/.test(A._evExtBadges({ files: [{ name: 'x.<script>' }] })));

    console.log('\n[card markup]');
    const card = PAGE.slice(PAGE.indexOf('function renderEvidenceItems()'), PAGE.indexOf('${_evidenceCardChips(item)}'));
    ok('the card uses the title helper and escapes it', /const cardTitle = _evCardTitle\(item\);/.test(card) && /\$\{_evEsc\(cardTitle\.text\)\}/.test(card));
    ok('the description shows under the heading (two lines max)', /ev-card-desc[^\n]*-webkit-line-clamp:2[^\n]*\$\{_evEsc\(cardDesc\)\}/.test(card));
    ok('…unless the description already is the heading', /cardTitle\.from === 'description' \? '' :/.test(card));
    ok('the extension badges sit beside the type', /typeLabels\[item\.type\] \|\| item\.type\}<\/span>\s*\$\{_evExtBadges\(item\)\}/.test(card));
    ok('CSAM / NOT DISCOVERABLE chips cannot be truncated away by a long title', /<span class="truncate"[^>]*>\$\{_evEsc\(cardTitle\.text\)\}<\/span>/.test(card) && /shrink-0 text-\[10px\][^']*">CSAM/.test(card));
    ok('the old raw tag heading is gone', !/item\.tag \|\| 'Evidence Item'/.test(PAGE));

    console.log('\n[folder links in the page]');
    ok('Forensic Integrity: the case folder path is a link', /Case folder: <a href="#" onclick="event\.preventDefault\(\); openCaseEvidenceFolder\(\)"[^>]*>Cases\/\$\{_evEsc\(currentCase\.caseNumber\)\}\/Evidence\/<\/a>/.test(PAGE));
    const viewer = PAGE.slice(PAGE.indexOf('function renderEvidenceFiles(evidence)'), PAGE.indexOf('${_evidenceReleaseControls(evidence)}'));
    ok('the viewer path bar is an "Open folder" button', /<button type="button" onclick="openEvidenceFolder\(\$\{_evIdLit\(evidence\.id\)\}\)"/.test(viewer) && /Open folder<\/span>/.test(viewer));
    ok('…showing the real folder (Windows paths too), escaped', /\$\{_evEsc\(_evFolderPathOf\(evidence\)\)\}/.test(viewer) && !/split\('\/'\)\.slice\(0, -1\)/.test(viewer));
    ok('_evFolderPathOf handles backslashes', A._evFolderPathOf({ files: [{ path: 'C:\\V\\cases\\2026-00001\\Evidence\\W - x\\a.pdf' }] }) === 'C:\\V\\cases\\2026-00001\\Evidence\\W - x');
    ok('…and forward slashes', A._evFolderPathOf({ files: [{ path: '/v/cases/1/Evidence/W/a.pdf' }] }) === '/v/cases/1/Evidence/W');

    console.log('\n[opening folders from the page]');
    const calls = [];
    A.setApi({ openCaseFolder: async (o) => { calls.push(o); return { ok: true }; } });
    A.setEvidence([{ id: 7, folder: 'W - signed', files: [{ name: 'a.pdf', path: 'C:\\c\\Evidence\\W - signed\\a.pdf' }] }]);
    await A.openEvidenceFolder('7');
    ok('item: asks main for the item folder with its first file', calls.length === 1 && calls[0].item === true && calls[0].caseNumber === '2026-00001'
        && calls[0].folder === 'W - signed' && calls[0].filePath === 'C:\\c\\Evidence\\W - signed\\a.pdf', calls);
    await A.openCaseEvidenceFolder();
    ok('case: asks for the Evidence folder only', calls.length === 2 && !calls[1].item && calls[1].caseNumber === '2026-00001' && !('folder' in calls[1]));
    A.setApi({ openCaseFolder: async () => ({ ok: false, error: 'nope' }) });
    await A.openEvidenceFolder(7);
    ok('a failure is told to the officer', ctx.toasts.length === 1 && /Could not open the folder: nope/.test(ctx.toasts[0][0]) && ctx.toasts[0][1] === 'error');
    const shown = [];
    A.setApi({ showItemInFolder: async (p) => { shown.push(p); return { ok: true }; } });
    await A.openEvidenceFolder(7);
    ok('older main process: falls back to showing the file', shown[0] === 'C:\\c\\Evidence\\W - signed\\a.pdf');
    await A.openCaseEvidenceFolder();
    ok('…and reveals an item folder inside Evidence for the case link', shown[1] === 'C:\\c\\Evidence\\W - signed', shown);

    console.log('\n[main process: open-case-folder]');
    ok('preload exposes openCaseFolder', /openCaseFolder: \(opts\) => ipcRenderer\.invoke\('open-case-folder', opts\)/.test(PRELOAD));
    const hStart = MAIN.indexOf("ipcMain.handle('open-case-folder'");
    const hEnd = MAIN.indexOf('\n});', hStart);
    ok('the handler exists', hStart > 0 && hEnd > hStart);
    const body = MAIN.slice(hStart, hEnd + 4);
    ok('it never calls openPath on a file — only directories', !/openPath\(o\.filePath|openPath\(path\.resolve\(o\.filePath\)\)/.test(body) && /path\.dirname\(path\.resolve\(o\.filePath\)\)/.test(body));

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-evfolder-'));
    const casesDir = path.join(tmp, 'cases');
    const itemDir = path.join(casesDir, '2026-00001', 'Evidence', 'W - signed');
    fs.mkdirSync(itemDir, { recursive: true });
    fs.writeFileSync(path.join(itemDir, 'a.pdf'), 'x');
    const opened = [];
    let handler = null;
    const mctx = {
        path, fs, casesDir,
        shell: { openPath: async (p) => { opened.push(p); return ''; } },
        ipcMain: { handle: (n, fn) => { handler = fn; } },
    };
    vm.createContext(mctx);
    vm.runInContext(body, mctx);
    const call = (o) => handler({}, o);

    let r = await call({ caseNumber: '2026-00001' });
    ok('case: opens cases/<n>/Evidence', r.ok && r.opened === 'evidence' && opened.pop() === path.join(casesDir, '2026-00001', 'Evidence'), r);
    r = await call({ caseNumber: '2026-00001', item: true, folder: 'W - signed', filePath: path.join(itemDir, 'a.pdf') });
    ok('item: opens the folder its file is in', r.ok && r.opened === 'file-folder' && opened.pop() === itemDir, r);
    const outside = path.join(tmp, 'source');
    fs.mkdirSync(outside);
    r = await call({ caseNumber: '2026-00001', item: true, folder: 'W - signed', filePath: path.join(outside, 'gone.bin') });
    ok('item kept elsewhere (pointed-to): opens that folder even if the file is gone', r.ok && opened.pop() === outside, r);
    r = await call({ caseNumber: '2026-00001', item: true, folder: 'W - signed', filePath: path.join(tmp, 'nope', 'a.pdf') });
    ok('item whose file folder is gone: its Evidence/<folder>', r.ok && r.opened === 'item' && opened.pop() === itemDir, r);
    r = await call({ caseNumber: '2026-00001', item: true, folder: '..', filePath: '' });
    ok('a ".." folder is refused (falls back to Evidence)', r.ok && r.opened === 'evidence' && opened.pop() === path.join(casesDir, '2026-00001', 'Evidence'), r);
    r = await call({ caseNumber: '2026-00001', item: true, folder: '..\\..\\x', filePath: 'relative\\a.pdf' });
    ok('separators in the folder and relative file paths are refused', r.ok && r.opened === 'evidence' && opened.pop() === path.join(casesDir, '2026-00001', 'Evidence'), r);
    for (const bad of ['..', '../x', 'a\\b', '', null, 'C:']) {
        r = await call({ caseNumber: bad });
        ok('bad case number refused: ' + JSON.stringify(bad), r.ok === false && /invalid case number/.test(r.error), r);
    }
    ok('nothing was opened for bad case numbers', opened.length === 0, opened);
    r = await call({ caseNumber: '2026-00002' });
    ok('a case with no Evidence folder yet gets one (Explorer needs a real folder)', r.ok && fs.existsSync(path.join(casesDir, '2026-00002', 'Evidence')));
    mctx.shell.openPath = async () => 'Access denied';
    r = await call({ caseNumber: '2026-00001' });
    ok('an Explorer error is passed back', r.ok === false && r.error === 'Access denied', r);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

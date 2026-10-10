/**
 * evidence-release.test.js — plain node (run under ELECTRON_RUN_AS_NODE=1).
 *
 *   node modules/_shared/__tests__/evidence-release.test.js
 *
 * Removing heavy evidence from a case after Export to DA.
 *
 * A 1 TB phone extraction or a week of surveillance video cannot live in the
 * case folder forever. Once it has gone to the DA and the export is stored
 * somewhere safe, the officer can remove the original files from the case
 * folder. VIPER keeps the listing, description, file names, counts and sizes,
 * and shows plainly that the files were exported and when they were removed.
 *
 * Three things must hold, or the feature destroys evidence:
 *
 *   1. ONLY A COMPLETE EXPORT COUNTS. Every Export to DA reports, per Evidence
 *      folder, how many files went into the ZIP. An item is "backed up" only
 *      when every one of its files made it in — not withheld as Not
 *      Discoverable, not skipped because Field Security was locked, not
 *      unreadable. Anything less needs a typed reason, which is audited.
 *
 *   2. THE REMOVAL CANNOT REACH OUTSIDE THE CASE'S EVIDENCE FOLDER, and never
 *      removes a file another evidence item still points at.
 *
 *   3. THE RECORD SURVIVES. The listing stays, the stats stay, and a partial
 *      failure is recorded and can be retried.
 *
 * Every section LIFTS the shipping code out of electron-main.js /
 * case-detail-with-analytics.html / connection-board.js and runs it. The
 * renderer flow is driven end to end through the REAL main-process handlers
 * against a real temp case folder.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; }
    else { fail++; console.error('  FAIL: ' + label); }
}
function eq(actual, expected, label) {
    ok(actual === expected, label + ' — got ' + JSON.stringify(actual) +
       ', expected ' + JSON.stringify(expected));
}

const REPO = path.join(__dirname, '..', '..', '..');
// The big HTML pages are CRLF on disk; normalise before matching anchors.
const DETAIL = fs.readFileSync(path.join(REPO, 'case-detail-with-analytics.html'), 'utf8').replace(/\r\n/g, '\n');
const MAIN = fs.readFileSync(path.join(REPO, 'electron-main.js'), 'utf8').replace(/\r\n/g, '\n');
const BOARD = fs.readFileSync(path.join(REPO, 'modules', 'connection-board', 'connection-board.js'), 'utf8').replace(/\r\n/g, '\n');

// Slice from `startAnchor` up to (not including) `endAnchor`.
function slice(src, startAnchor, endAnchor, label, from) {
    const a = src.indexOf(startAnchor, from || 0);
    ok(a !== -1, 'anchor present: ' + label + ' start');
    const b = src.indexOf(endAnchor, a);
    ok(b !== -1, 'anchor present: ' + label + ' end');
    return src.slice(a, b);
}
// An IPC handler: from its ipcMain.handle line to the closing `});`.
function handler(name) {
    const start = "ipcMain.handle('" + name + "'";
    const a = MAIN.indexOf(start);
    ok(a !== -1, 'the ' + name + ' handler is still in electron-main.js');
    const b = MAIN.indexOf('\n});', a);
    return MAIN.slice(a, b + 4);
}

// ═════════════════════════════════════════════════════════════════════════
//  Real temp case folders
// ═════════════════════════════════════════════════════════════════════════
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-evrel-'));
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-evrel-ud-'));
const CANVAS_MEDIA_DIR = 'Canvas Media';
const FIELD_WORK_MEDIA_DIR = 'Field Work Media';
const at = (...p) => path.join(TMP, ...p);
const mk = (full, body) => {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
    return full;
};
const exists = (p) => fs.existsSync(p);

const HDR = Buffer.from('VIPENC');
const securityStub = {
    unlocked: true,
    isEnabled() { return true; },
    isUnlocked() { return this.unlocked; },
    decryptBuffer(b) { return b.slice(6); }
};

// A fake archiver that records what would have gone into the ZIP. A file
// whose name is listed in WARN_ON is "unreadable after all": archiver queues
// it and later raises a warning naming its path, exactly as the real one does.
let ENTRIES = [];
let WARN_ON = new Set();
let WARN_UNPLACED = 0;
function fakeArchiver() {
    const handlers = {};
    return {
        on: (ev, fn) => { handlers[ev] = fn; },
        pipe: () => {},
        append: (data, opts) => { ENTRIES.push({ name: opts.name, body: Buffer.isBuffer(data) ? data : Buffer.from(String(data)) }); },
        file: (full, opts) => {
            if (WARN_ON.has(path.basename(full))) {
                const err = new Error('ENOENT: lstat failed'); err.path = full;
                setImmediate(() => handlers.warning && handlers.warning(err));
                return;
            }
            ENTRIES.push({ name: opts.name, body: fs.readFileSync(full) });
        },
        pointer: () => 1234,
        finalize: () => {
            for (let i = 0; i < WARN_UNPLACED; i++) handlers.warning && handlers.warning(new Error('something odd'));
            return Promise.resolve();
        }
    };
}
let HAVE_ARCHIVER = true;
let HANDLERS = {};
let SAVE_PATH = path.join(TMP, 'out.zip');
let SAVE_CANCEL = false;
const fsStub = Object.assign({}, fs, {
    createWriteStream: () => {
        const cbs = {};
        setTimeout(() => { if (cbs.close) cbs.close(); }, 30);
        return { on: (ev, fn) => { cbs[ev] = fn; }, destroy: () => {} };
    }
});
const quietConsole = { log() {}, warn() {}, error: console.error };
const mainEnv = {
    ipcMain: { handle: (name, fn) => { HANDLERS[name] = fn; } },
    dialog: { showSaveDialog: async () => (SAVE_CANCEL ? { canceled: true } : { canceled: false, filePath: SAVE_PATH }) },
    mainWindow: {},
    restoreFocus: () => {},
    require: (m) => (m === 'archiver' ? (HAVE_ARCHIVER ? fakeArchiver : (() => { throw new Error('nope'); })()) : require(m)),
    path, fs: fsStub, console: quietConsole, process,
    casesDir: TMP,
    CANVAS_MEDIA_DIR,
    FIELD_WORK_MEDIA_DIR,
    security: securityStub,
    app: { getVersion: () => '9.9.9', getPath: (k) => (k === 'userData' ? UD : TMP) },
    Buffer, String, Array, Object, Error, Promise, Set, Map, JSON, Date, Number, Math,
    setTimeout, setImmediate
};
mainEnv.globalThis = mainEnv;
vm.createContext(mainEnv);
vm.runInContext(handler('save-da-export') + '\n' + handler('evidence-release-files'), mainEnv);
const exportZip = HANDLERS['save-da-export'];
const releaseFiles = HANDLERS['evidence-release-files'];
ok(typeof exportZip === 'function', 'the lifted save-da-export handler registered');
ok(typeof releaseFiles === 'function', 'the lifted evidence-release-files handler registered');

// ═════════════════════════════════════════════════════════════════════════
//  Renderer sandbox: the helper block lifted from the case page
// ═════════════════════════════════════════════════════════════════════════
const RBLOCK = slice(DETAIL,
    '// ── Removing heavy files from case files after Export to DA',
    '\n        function _evWaitFor(', 'renderer release block');
const CYBERTIP = slice(DETAIL,
    'function _cyberTipEvidenceCandidates()',
    '\n        async function findCyberTipsInEvidence', 'cybertip candidates');

const STORE = {};
let SAVE_OK = true;
let AUDITS = [], TOASTS = [], RENDERS = [], VIEWS = [], DIALOGS = [];
let DIALOG_ANSWER = { reason: '' };
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const R = {
    caseEvidence: [],
    currentCase: null,
    currentTab: 'evidence',
    currentEvidenceView: null,
    _provStampEdits: () => {},
    _lsParse: (k, d) => { try { return k in STORE ? JSON.parse(STORE[k]) : d; } catch (_) { return d; } },
    _lsSetSafe: (k, v) => { if (!SAVE_OK) return false; STORE[k] = v; return true; },
    audit: (evt, payload) => { AUDITS.push({ evt, payload }); },
    viperToast: (msg, type, ms) => { TOASTS.push({ msg, type, ms }); },
    renderTabContent: (t) => { RENDERS.push(t); },
    viewEvidenceInline: (id) => { VIEWS.push(id); },
    formatFileSize: (n) => n + ' B',
    formatDate: (s) => 'D(' + s + ')',
    _evEsc: esc,
    window: { electronAPI: {} },
    // The 700 ms "now backed up" toast fires immediately here.
    setTimeout: (fn) => { fn(); return 0; },
    console: quietConsole,
    String, Array, Object, Error, Promise, Set, Map, JSON, Date, Number, Math, isNaN
};
R.globalThis = R;
vm.createContext(R);
vm.runInContext(RBLOCK + '\n' + CYBERTIP + '\n;Object.assign(globalThis, { EVIDENCE_EXPORT_HISTORY_MAX });', R);
const REAL_DIALOG = R._evidenceReleaseDialog;
ok(typeof REAL_DIALOG === 'function', 'the confirm dialog is defined');
// The dialog is a DOM modal; it is exercised in Chromium. Here it auto-answers.
R._evidenceReleaseDialog = async (ev, files, clean, lastExport) => {
    DIALOGS.push({ id: ev.id, files: files.map(f => f.path), clean, lastExport });
    return DIALOG_ANSWER;
};
// Wire the renderer to the REAL main-process handlers.
R.window.electronAPI.saveDAExport = (args) => exportZip(null, args);
R.window.electronAPI.evidenceReleaseFiles = (args) => releaseFiles(null, args);
const resetLogs = () => { AUDITS = []; TOASTS = []; RENDERS = []; VIEWS = []; DIALOGS = []; };

(async () => {
    // ═════════════════════════════════════════════════════════════════════
    //  1. THE REMOVAL HANDLER (main process) — confined to Evidence/
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n1. evidence-release-files stays inside the case Evidence folder');
    {
        const CN = '26-100';
        const cam1 = mk(at(CN, 'Evidence', 'Lobby Video', 'cam1.mp4'), 'x'.repeat(100));
        const cam2 = mk(at(CN, 'Evidence', 'Lobby Video', 'cam2.mp4'), 'x'.repeat(50));
        const deep = mk(at(CN, 'Evidence', 'Lobby Video', 'day 2', 'deep.mp4'), 'x'.repeat(7));
        const shared = mk(at(CN, 'Evidence', 'Shared', 'a.bin'), 'shared');
        const note = mk(at(CN, 'Notes', 'n.txt'), 'note');
        const other = mk(at('26-999', 'Evidence', 'Other', 'x.bin'), 'other case');
        const top = mk(at(CN, 'Evidence', 'loose.txt'), 'loose');

        let r = await releaseFiles(null, { caseNumber: CN, paths: [cam1, cam2, deep] });
        eq(r.success, true, 'removing three files inside Evidence succeeds');
        eq(r.removed, 3, 'all three are removed');
        eq(r.freedBytes, 157, 'and the freed bytes are the real file sizes');
        ok(!exists(cam1) && !exists(cam2) && !exists(deep), 'the files are gone from disk');
        ok(!exists(at(CN, 'Evidence', 'Lobby Video')), 'the emptied folder (and its emptied subfolder) is pruned');
        ok(exists(at(CN, 'Evidence')), 'the Evidence folder itself is never pruned');
        ok(exists(shared) && exists(top), 'files that were not asked for are untouched');

        r = await releaseFiles(null, { caseNumber: CN, paths: [note] });
        eq(r.success, false, 'a file outside Evidence is refused');
        eq(r.refused.length, 1, 'and reported as refused');
        ok(exists(note), 'and is still on disk');

        r = await releaseFiles(null, { caseNumber: CN, paths: [at(CN, 'Evidence', '..', 'Notes', 'n.txt')] });
        eq(r.refused.length, 1, 'a ".." path that climbs out of Evidence is refused');
        ok(exists(note), 'and the note survives');

        r = await releaseFiles(null, { caseNumber: CN, paths: [other] });
        eq(r.refused.length, 1, "another case's evidence is refused");
        ok(exists(other), "and the other case's file survives");

        r = await releaseFiles(null, { caseNumber: CN, paths: [at(CN, 'Evidence')] });
        eq(r.refused.length, 1, 'the Evidence folder itself is refused');
        r = await releaseFiles(null, { caseNumber: CN, paths: [at(CN, 'Evidence', 'Shared')] });
        eq(r.refused.length, 1, 'a folder is refused — only regular files are removed');
        ok(exists(shared), 'and its contents survive');

        r = await releaseFiles(null, { caseNumber: CN, paths: [shared], keep: [shared.toUpperCase()] });
        eq(r.kept, 1, 'a file on the keep list is kept (compared case-insensitively on Windows)');
        eq(r.removed, 0, 'and not removed');
        eq(r.success, true, 'keeping a file is not a failure');
        ok(exists(shared), 'the kept file is still on disk');

        r = await releaseFiles(null, { caseNumber: CN, paths: [at(CN, 'Evidence', 'Gone', 'never.mp4')] });
        eq(r.missing, 1, 'a file that is already gone counts as missing');
        eq(r.success, true, 'which is not a failure (a retry after a partial run)');

        r = await releaseFiles(null, { caseNumber: CN, paths: [top] });
        eq(r.removed, 1, 'a file directly in Evidence can be removed');
        ok(exists(at(CN, 'Evidence')), 'and Evidence is still not pruned');

        r = await releaseFiles(null, { caseNumber: CN, paths: [null, 42, ''] });
        eq(r.refused.length, 3, 'non-string paths are refused');

        for (const bad of ['', '..', '.', 'a/b', 'a\\b']) {
            r = await releaseFiles(null, { caseNumber: bad, paths: [shared] });
            ok(r.success === false && r.error && r.removed === 0, 'a bad case number refuses everything: ' + JSON.stringify(bad));
        }
        ok(exists(shared), 'and nothing was removed by any of them');

        // A second case root (userData/cases) is also this case's Evidence.
        const udFile = mk(path.join(UD, 'cases', CN, 'Evidence', 'Old', 'u.bin'), 'ud');
        r = await releaseFiles(null, { caseNumber: CN, paths: [udFile] });
        eq(r.removed, 1, "the case's Evidence under userData/cases is also in bounds");

        // Only Evidence: one emptied subfolder of a case with nothing else.
        const only = mk(at('26-101', 'Evidence', 'Only', 'x.bin'), 'x');
        r = await releaseFiles(null, { caseNumber: '26-101', paths: [only] });
        ok(!exists(at('26-101', 'Evidence', 'Only')) && exists(at('26-101', 'Evidence')),
           'emptying the last folder prunes it but keeps an empty Evidence folder');
    }

    // ═════════════════════════════════════════════════════════════════════
    //  2. THE EXPORT REPORT (main process) — what actually went in the ZIP
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n2. save-da-export reports per evidence folder');
    const CN2 = '26-200';
    mk(at(CN2, 'Evidence', 'Lobby Video', 'v1.mp4'), 'x'.repeat(30));
    mk(at(CN2, 'Evidence', 'Lobby Video', 'v2.mp4'), 'x'.repeat(20));
    mk(at(CN2, 'Evidence', 'TLO', 'tlo.pdf'), 'tlo');
    mk(at(CN2, 'Evidence', 'Sealed', 's.bin'), Buffer.concat([HDR, Buffer.from('PLAIN-9')]));
    mk(at(CN2, 'Evidence', 'loose.txt'), 'loose');
    mk(at(CN2, 'Warrants', 'w.pdf'), 'w');
    mk(at(CN2, 'Forensics', '17', 'exam report.pdf'), 'exam');
    mk(at(CN2, 'Warrants', 'Drafts', 'wa-1', 'warrant.pdf'), 'wapdf');
    mk(at(CN2, 'Warrants', 'Drafts', 'wa-1', 'warrant.docx'), 'wadocx');
    mk(at(CN2, 'Warrants', 'Drafts', 'wa-1', 'manifest.json'), '{}');
    const PDF = Array.from(Buffer.from('%PDF-FAKE'));
    const BASE = { fileName: 'x.zip', pdfBytes: PDF, caseNumber: CN2, excludeCsam: false, csamTags: [],
                   nonDiscoverableTags: [], nonDiscoverableCanvasFiles: [] };
    {
        securityStub.unlocked = false;
        ENTRIES = [];
        let res = await exportZip(null, Object.assign({}, BASE, { folders: ['evidence'], nonDiscoverableTags: ['TLO'], report: true }));
        ok(res && typeof res === 'object', 'report:true resolves an object');
        eq(res.filePath, SAVE_PATH, 'carrying the saved path');
        ok(!isNaN(new Date(res.completedAt).getTime()), 'and the completion time');
        eq(JSON.stringify(res.foldersIncluded), '["evidence"]', 'and the folders included');
        eq(res.unattributedWarnings, 0, 'and no unplaced warnings');
        const F = res.evidenceFolders;
        eq(JSON.stringify(F['Lobby Video']), JSON.stringify({ added: 2, skipped: 0, errors: 0, bytes: 50 }),
           'a plain folder: both files added, real bytes');
        eq(F['TLO'] && F['TLO'].withheld, true, 'a Not Discoverable folder is reported as withheld');
        eq(F['TLO'] && F['TLO'].added, 0, 'with nothing added');
        eq(F['Sealed'] && F['Sealed'].skipped, 1, 'an encrypted file with Field Security locked is reported as skipped');
        eq(F['Sealed'] && F['Sealed'].added, 0, 'and not as added');
        eq(F[''] && F[''].added, 1, "a file sitting directly in Evidence is reported under ''");
        ok(ENTRIES.every(e => e.name.indexOf('Evidence/TLO/') !== 0), 'the withheld folder really is not in the ZIP');

        securityStub.unlocked = true;
        res = await exportZip(null, Object.assign({}, BASE, { folders: ['evidence'], report: true }));
        eq(res.evidenceFolders['Sealed'].added, 1, 'unlocked: the encrypted file is added');
        eq(res.evidenceFolders['Sealed'].bytes, 7, 'and its PLAINTEXT size is reported');
        eq(res.evidenceFolders['TLO'].withheld, undefined, 'and an un-withheld folder carries no withheld flag');

        // A queued file that turns out to be unreadable moves from added to errors.
        WARN_ON = new Set(['v2.mp4']);
        res = await exportZip(null, Object.assign({}, BASE, { folders: ['evidence'], report: true }));
        eq(res.evidenceFolders['Lobby Video'].added, 1, 'an unreadable queued file is taken off "added"');
        eq(res.evidenceFolders['Lobby Video'].errors, 1, 'and counted as an error for its own folder');
        eq(res.unattributedWarnings, 0, 'a warning that names its file is not "unplaced"');
        WARN_ON = new Set();

        WARN_UNPLACED = 1;
        res = await exportZip(null, Object.assign({}, BASE, { folders: ['evidence'], report: true }));
        eq(res.unattributedWarnings, 1, 'a warning that names no file is counted against the whole export');
        res = await exportZip(null, Object.assign({}, BASE, { folders: ['notes'], report: true }));
        eq(res.unattributedWarnings, 0, 'but only when Evidence was in the export at all');
        WARN_UNPLACED = 0;

        res = await exportZip(null, Object.assign({}, BASE, { folders: ['warrants'], report: true }));
        eq(res.evidenceFolders, null, 'Evidence not ticked -> no evidence report (nothing is marked backed up)');

        res = await exportZip(null, Object.assign({}, BASE, { folders: ['evidence'] }));
        eq(typeof res, 'string', 'an older caller (no report flag) still gets the plain path');
        eq(res, SAVE_PATH, 'the same path');

        SAVE_CANCEL = true;
        res = await exportZip(null, Object.assign({}, BASE, { report: true }));
        eq(res, null, 'a cancelled save dialog resolves null');
        SAVE_CANCEL = false;

        HAVE_ARCHIVER = false;
        res = await exportZip(null, Object.assign({}, BASE, { folders: ['evidence'], report: true, fileName: 'side.zip' }));
        eq(res && res.evidenceFolders, null, 'no archiver: the PDF-only sidecar marks nothing as backed up');
        HAVE_ARCHIVER = true;

        // Device Exams and Warrant Author ride in the ZIP when ticked.
        ENTRIES = [];
        res = await exportZip(null, Object.assign({}, BASE, { folders: ['forensics', 'warrantDrafts'], report: true }));
        let names = ENTRIES.map(e => e.name);
        ok(names.indexOf('Device Exams/17/exam report.pdf') !== -1, 'Device Exams ticked -> the exam report ships');
        ok(names.indexOf('Warrant Author/wa-1/warrant.pdf') !== -1, 'Warrant Author ticked -> the warrant PDF ships');
        ok(names.indexOf('Warrant Author/wa-1/warrant.docx') !== -1, 'and the Word file');
        ok(names.every(n => !/manifest\.json$/.test(n)), 'but not its working manifest');
        ok(names.every(n => n.indexOf('Evidence/') !== 0 && n.indexOf('Warrants/') !== 0), 'and nothing else');
        eq(JSON.stringify(res.foldersIncluded), '["forensics","warrantDrafts"]', 'the report names both');

        ENTRIES = [];
        await exportZip(null, Object.assign({}, BASE, { folders: ['warrants', 'warrantDrafts'] }));
        names = ENTRIES.map(e => e.name);
        ok(names.indexOf('Warrants/Drafts/wa-1/warrant.pdf') !== -1, 'Warrants + Warrant Author: the draft ships inside Warrants');
        ok(names.every(n => n.indexOf('Warrant Author/') !== 0), 'and is never shipped twice');

        ENTRIES = [];
        await exportZip(null, Object.assign({}, BASE));
        names = ENTRIES.map(e => e.name);
        ok(names.every(n => n.indexOf('Device Exams/') !== 0 && n.indexOf('Warrant Author/') !== 0),
           'an older caller with no folder list gets exactly the five folders it always got');
    }

    // ═════════════════════════════════════════════════════════════════════
    //  3. SMALL HELPERS (renderer)
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n3. Renderer helpers');
    {
        const fo = R._evidenceFolderOfPath;
        eq(fo('C:\\V\\cases\\26-200\\Evidence\\Lobby Video\\v1.mp4', '26-200'), 'Lobby Video', 'Windows path -> its tag folder');
        eq(fo('/v/cases/26-200/evidence/Lobby Video/day 2/v.mp4', '26-200'), 'Lobby Video', 'deep file -> its TOP folder, case-insensitive');
        eq(fo('C:/v/CASES/26-ab/EVIDENCE/X/f', '26-AB'), 'X', 'the case number matches regardless of letter case');
        eq(fo('C:\\V\\cases\\26-200\\Evidence\\loose.txt', '26-200'), '', 'a file directly in Evidence -> ""');
        eq(fo('D:\\Extractions\\phone.ufdx', '26-200'), null, 'a file outside the case -> null');
        eq(fo('C:\\V\\cases\\26-999\\Evidence\\X\\f', '26-200'), null, "another case's Evidence -> null");
        eq(fo('C:\\26-200\\cases\\26-200\\Evidence\\A\\f', '26-200'), 'A', 'the case number appearing twice in the path still resolves');
        eq(fo('C:\\V\\cases\\26-200\\Evidence\\A\\f', ''), null, 'no case number -> null');

        const cf = R._evidenceCaseFiles;
        const P = (...p) => at(CN2, 'Evidence', ...p);
        eq(cf({ referenceOnly: true, files: [{ path: P('A', 'f') }] }, CN2).length, 0, 'a Point-to item has no case files');
        eq(cf({ files: [{ path: 'https://x/y' }, { path: 'data:abc' }, { path: 'D:\\ext\\f' }, null, { name: 'nopath' }] }, CN2).length, 0,
           'URLs, outside paths and junk rows are not case files');
        const cfs = cf({ files: [{ path: P('A', 'f'), size: '12', name: 'f' }] }, CN2);
        eq(JSON.stringify(cfs[0]), JSON.stringify({ path: P('A', 'f'), folder: 'A', size: 12, name: 'f' }), 'a case file carries folder and numeric size');

        eq(R._evWhen(''), '', 'no date -> blank');
        eq(R._evWhen('not a date'), 'not a date', 'an unreadable date is shown as written');
        ok(!/[\u202F\u00A0]/.test(R._evWhen('2026-10-10T15:04:00Z')), 'no narrow no-break space (the PDF font cannot draw it)');
        eq(R._evIdLit(1700000000000), '1700000000000', 'a numeric id is a bare literal');
        eq(R._evIdLit("ab'c\\d"), "'ab\\'c\\\\d'", 'a string id is quoted and escaped');

        const sf = R._evidenceExportShortfall;
        ok(/not been included/.test(sf(null)), 'never exported');
        ok(/Assist Package/.test(sf({ kind: 'assist', reason: '' })), 'assist package is not a DA export');
        ok(/Not Discoverable/.test(sf({ kind: 'da', reason: 'withheld' })), 'withheld');
        ok(/not found/.test(sf({ kind: 'da', reason: 'missing' })), 'missing');
        ok(/could not be read/.test(sf({ kind: 'da', reason: 'errors' })), 'errors');
        ok(/Field Security was locked/.test(sf({ kind: 'da', reason: 'skipped' })), 'skipped');
        ok(/Not every file/.test(sf({ kind: 'da', reason: 'short' })), 'short');
        ok(/could not tie/.test(sf({ kind: 'da', reason: 'warnings' })), 'warnings');
    }

    // ═════════════════════════════════════════════════════════════════════
    //  4. STAMPING THE EXPORT ONTO EACH ITEM
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n4. Each evidence item is stamped with what the export carried');
    const P2 = (...p) => at(CN2, 'Evidence', ...p);
    const item = (id, tag, files, extra) => Object.assign({
        id, type: 'video', tag, description: tag + ' desc', discoverable: true,
        files: files.map(f => ({ name: path.basename(f), path: f, size: 10 })),
        fileCount: files.length, totalSize: files.length * 10, createdAt: '2026-10-01T10:00:00Z'
    }, extra || {});
    const setCase = (cn, evs) => {
        R.currentCase = { id: 'case-' + cn, caseNumber: cn };
        R.caseEvidence = evs;
    };
    const stats = (o) => Object.assign({ filePath: 'E:\\DA\\out.zip', completedAt: '2026-10-10T12:00:00.000Z', unattributedWarnings: 0 }, o);
    {
        const A = item(1, 'Lobby Video', [P2('Lobby Video', 'v1.mp4'), P2('Lobby Video', 'v2.mp4')]);
        const B = item(2, 'TLO', [P2('TLO', 'tlo.pdf')]);
        const C = item(3, 'Gone', [P2('Gone', 'g.mp4')]);
        const D = item(4, 'Shared', [P2('Shared', 'd.mp4')]);
        const E = item(5, 'Shared', [P2('Shared', 'e.mp4')]);
        const Fi = item(6, 'Dup', [P2('Dup', 'same.mp4')]);
        const G = item(7, 'Dup', [P2('Dup', 'same.mp4')]);
        const Ref = item(8, 'Phone', ['D:\\Extractions\\phone.ufdx'], { referenceOnly: true, storageMode: 'reference', sourcePath: 'D:\\Extractions' });
        const Rel = item(9, 'Old', [P2('Old', 'o.mp4')], { released: { at: '2026-09-01T00:00:00Z' } });
        const Loose = item(10, '', [P2('loose.txt')]);
        setCase(CN2, [A, B, C, D, E, Fi, G, Ref, Rel, Loose, null]);

        let st = R._stampEvidenceExports(stats({ evidenceFolders: {
            'Lobby Video': { added: 2, skipped: 0, errors: 0 },
            'TLO': { added: 0, skipped: 0, errors: 0, withheld: true },
            'Shared': { added: 2, skipped: 0, errors: 0 },
            'Dup': { added: 1, skipped: 0, errors: 0 },
            '': { added: 1, skipped: 0, errors: 0 },
        } }), 'da', false);
        const last = (x) => x.exports[x.exports.length - 1];
        eq(last(A).clean, true, 'every file of the item went in -> clean');
        eq(last(A).reason, '', 'with no reason');
        eq(last(A).added, 2, 'the record carries the count');
        eq(last(A).file, 'E:\\DA\\out.zip', 'and the export file');
        eq(last(A).at, '2026-10-10T12:00:00.000Z', 'and the export time from main, not the renderer clock');
        eq(JSON.stringify(last(A).folders), '["Lobby Video"]', 'and the folder');
        eq(last(B).reason, 'withheld', 'a Not Discoverable folder -> withheld');
        eq(last(B).clean, false, 'withheld is never clean');
        eq(last(C).reason, 'missing', 'a folder the export never saw -> missing');
        eq(last(D).clean && last(E).clean, true, 'two items sharing one folder, both files in -> both clean');
        eq(last(Fi).clean && last(G).clean, true, 'two items pointing at the SAME file count it once');
        eq(last(Loose).clean, true, 'a file directly in Evidence is matched by its "" folder');
        eq(Ref.exports, undefined, 'a Point-to item is not stamped (nothing of it is in the export)');
        eq(Rel.exports, undefined, 'an already-removed item is not stamped');
        eq(st.stamped, 8, 'eight items stamped');
        eq(st.clean, 6, 'six clean: Lobby Video, Shared x2, Dup x2, loose');
        eq(st.cleanBytes, 60, 'and their case-file bytes, the file Dup items share counted once (20+10+10+10+10)');
        const saved = JSON.parse(STORE['viperCaseEvidence'])[CN2];
        ok(Array.isArray(saved) && saved[0].exports && saved[0].exports.length === 1, 'the stamps are persisted');

        // Shortfalls.
        st = R._stampEvidenceExports(stats({ evidenceFolders: { 'Shared': { added: 1, skipped: 0, errors: 0 } } }), 'da', false);
        eq(last(D).reason, 'short', 'one of two shared-folder files missing from the ZIP -> short');
        eq(last(E).reason, 'short', '— for BOTH items, because we cannot tell whose file was dropped');
        eq(R._evidenceCleanExport(D) && R._evidenceCleanExport(D).at, '2026-10-10T12:00:00.000Z',
           'the earlier complete export still stands');
        st = R._stampEvidenceExports(stats({ evidenceFolders: { 'Lobby Video': { added: 2, skipped: 1, errors: 0 } } }), 'da', false);
        eq(last(A).reason, 'skipped', 'an encrypted file skipped while locked -> skipped');
        st = R._stampEvidenceExports(stats({ evidenceFolders: { 'Lobby Video': { added: 1, skipped: 0, errors: 1 } } }), 'da', false);
        eq(last(A).reason, 'errors', 'an unreadable file -> errors');
        st = R._stampEvidenceExports(stats({ unattributedWarnings: 1, evidenceFolders: { 'Lobby Video': { added: 2, skipped: 0, errors: 0 } } }), 'da', false);
        eq(last(A).reason, 'warnings', 'an unplaced archive warning taints an otherwise complete item');
        eq(st.clean, 0, 'and nothing counts as clean');
        st = R._stampEvidenceExports(stats({ evidenceFolders: { 'lobby video': { added: 2, skipped: 0, errors: 0 } } }), 'da', false);
        eq(last(A).clean, true, 'folder names match case-insensitively (Windows folders)');

        st = R._stampEvidenceExports(stats({ evidenceFolders: { 'TLO': { added: 1, skipped: 0, errors: 0 } } }), 'assist', true);
        eq(last(B).kind, 'assist', 'an Assist Package is recorded as such');
        eq(last(B).filesOnly, true, 'with the files-only flag');
        eq(st.clean, 0, 'but an Assist Package never makes an item eligible for removal');
        eq(R._evidenceCleanExport(B), null, 'B still has no complete Export to DA');

        st = R._stampEvidenceExports({ filePath: 'x', evidenceFolders: null }, 'da', false);
        eq(st.stamped, 0, 'an export without Evidence stamps nothing');
        st = R._stampEvidenceExports('E:\\x.zip', 'da', false);
        eq(st.stamped, 0, 'a plain path (older main) stamps nothing');

        for (let i = 0; i < 15; i++) R._stampEvidenceExports(stats({ evidenceFolders: { 'Lobby Video': { added: 2, skipped: 0, errors: 0 } } }), 'da', false);
        eq(A.exports.length, R.EVIDENCE_EXPORT_HISTORY_MAX, 'export history is capped');
        eq(R.EVIDENCE_EXPORT_HISTORY_MAX, 10, 'at ten');
    }

    // ═════════════════════════════════════════════════════════════════════
    //  5. END TO END: Export to DA -> stamp -> remove, through the REAL main
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n5. Export to DA, then remove the originals (real handlers, real files)');
    {
        const CN = '26-300';
        const E = (...p) => at(CN, 'Evidence', ...p);
        const v1 = mk(E('Surveillance', 'cam1.mp4'), 'x'.repeat(400));
        const v2 = mk(E('Surveillance', 'cam2.mp4'), 'x'.repeat(600));
        const ext = mk(E('Phone', 'extraction.ufdr'), 'x'.repeat(900));
        const tlo = mk(E('TLO', 'tlo.pdf'), 'tlo');
        const shared = mk(E('Returns', 'return.zip'), 'x'.repeat(50));
        const SV = item(101, 'Surveillance', [v1, v2]);
        SV.files[0].size = 400; SV.files[1].size = 600; SV.totalSize = 1000;
        const PH = item(102, 'Phone', [ext]);
        const TL = item(103, 'TLO', [tlo], { discoverable: false });
        const R1 = item(104, 'Returns', [shared]);
        const R2 = item(105, 'Returns', [shared]);
        PH.files[0].size = 900; R1.files[0].size = 50; R2.files[0].size = 50;
        setCase(CN, [SV, PH, TL, R1, R2]);
        resetLogs();

        // Older main process: a string comes back, nothing is stamped.
        const realSave = R.window.electronAPI.saveDAExport;
        R.window.electronAPI.saveDAExport = async () => 'E:\\old.zip';
        eq(await R._daExportSave({ caseNumber: CN }, false), 'E:\\old.zip', 'an older main process: the path passes straight through');
        eq(SV.exports, undefined, 'and nothing is stamped');
        R.window.electronAPI.saveDAExport = async () => null;
        eq(await R._daExportSave({ caseNumber: CN }, false), null, 'a cancelled save -> null');
        let sentArgs = null;
        R.window.electronAPI.saveDAExport = (args) => { sentArgs = args; return realSave(args); };

        ENTRIES = [];
        const saved = await R._daExportSave(Object.assign({}, BASE, { caseNumber: CN, folders: ['evidence'], nonDiscoverableTags: ['TLO'] }), false);
        eq(sentArgs && sentArgs.report, true, 'the renderer always asks main for the report');
        eq(sentArgs && sentArgs.caseNumber, CN, 'without disturbing the other arguments');
        eq(saved, SAVE_PATH, 'the caller still receives just the saved path');
        eq(R._evidenceCleanExport(SV) && R._evidenceCleanExport(SV).file, SAVE_PATH, 'the video is recorded as fully exported');
        ok(R._evidenceCleanExport(PH), 'and the extraction');
        eq(R._evidenceCleanExport(TL), null, 'the Not Discoverable item is NOT (it was withheld)');
        eq(TL.exports[0].reason, 'withheld', 'and the record says why');
        ok(R._evidenceCleanExport(R1) && R._evidenceCleanExport(R2), 'both items sharing one file are covered');
        ok(RENDERS.indexOf('evidence') !== -1, 'the Evidence tab is repainted to show the new status');
        const info = TOASTS.find(t => /now fully backed up/.test(t.msg));
        ok(!!info, 'the officer is told items are now backed up');
        ok(info && /^📦 4 evidence items are/.test(info.msg), 'with the right count');
        ok(info && /\(1950 B\)/.test(info.msg), 'and the space that can be freed — a shared file counted once (1000 + 900 + 50)');

        // Strict path: complete export, no reason needed.
        resetLogs();
        DIALOG_ANSWER = { reason: '' };
        await R.openReleaseEvidenceModal(101);
        eq(DIALOGS.length, 1, 'the officer is asked to confirm');
        ok(DIALOGS[0].clean && DIALOGS[0].clean.file === SAVE_PATH, 'and shown the export that covers the item');
        eq(DIALOGS[0].files.length, 2, 'and the files that will go');
        ok(!exists(v1) && !exists(v2), 'the video files are removed from disk');
        ok(!exists(E('Surveillance')), 'and their emptied folder');
        ok(SV.released, 'the item is marked as removed');
        eq(SV.released.filesRemoved, 2, 'with the count');
        eq(SV.released.bytesFreed, 1000, 'and the space freed');
        eq(SV.released.exportFile, SAVE_PATH, 'and which export holds the files');
        eq(SV.released.exportKind, 'da', 'an Export to DA');
        eq(SV.released.overrideReason, null, 'and no override reason');
        ok(!isNaN(new Date(SV.released.at).getTime()), 'and when');
        eq(SV.files.length, 2, 'THE LISTING STAYS: both file rows');
        eq(SV.fileCount, 2, 'the file count');
        eq(SV.totalSize, 1000, 'the total size');
        eq(SV.description, 'Surveillance desc', 'and the description');
        const a1 = AUDITS.find(a => a.evt === 'evidence_files_released');
        ok(!!a1, 'the removal is audited');
        eq(a1 && a1.payload.strict, true, 'as a strict (fully exported) removal');
        eq(a1 && a1.payload.files_removed, 2, 'with the file count');
        eq(a1 && a1.payload.export_file, SAVE_PATH, 'and the export file');
        eq(a1 && a1.payload.override_reason, null, 'and no reason');
        ok(TOASTS.some(t => t.type === 'success' && /2 files removed/.test(t.msg)), 'and the officer sees it worked');
        const persisted = JSON.parse(STORE['viperCaseEvidence'])[CN].find(x => x.id === 101);
        ok(persisted && persisted.released && persisted.files.length === 2, 'the removal record and listing are saved');

        // Already removed.
        resetLogs();
        await R.openReleaseEvidenceModal(101);
        eq(DIALOGS.length, 0, 'an already-removed item does not ask again');
        ok(TOASTS.some(t => /already removed/.test(t.msg)), 'it says so');

        // Cancel.
        resetLogs();
        DIALOG_ANSWER = null;
        await R.openReleaseEvidenceModal(102);
        ok(exists(ext), 'cancelling removes nothing');
        eq(PH.released, undefined, 'and marks nothing');
        eq(AUDITS.length, 0, 'and audits nothing');

        // Shared file: the other item still holds it.
        resetLogs();
        DIALOG_ANSWER = { reason: '' };
        await R.openReleaseEvidenceModal(104);
        ok(exists(shared), 'a file another item still uses is KEPT on disk');
        ok(R1.released && R1.released.filesKept === 1, 'and the record says it was kept');
        eq(R1.released.filesRemoved, 0, 'nothing was removed');
        resetLogs();
        await R.openReleaseEvidenceModal(105);
        ok(!exists(shared), 'once no other item holds it, the shared file is removed');

        // Override: Not Discoverable item, never in a DA export.
        resetLogs();
        DIALOG_ANSWER = { reason: 'Retained on the agency evidence server, case 24-1187' };
        await R.openReleaseEvidenceModal(103);
        eq(DIALOGS[0].clean, null, 'the dialog is told there is no complete export');
        eq(DIALOGS[0].lastExport && DIALOGS[0].lastExport.reason, 'withheld', 'and why');
        ok(!exists(tlo), 'with a reason, the files are removed anyway');
        eq(TL.released.overrideReason, 'Retained on the agency evidence server, case 24-1187', 'and the reason is kept on the record');
        const a2 = AUDITS.find(a => a.evt === 'evidence_files_released');
        eq(a2 && a2.payload.strict, false, 'the audit marks it as an override');
        eq(a2 && a2.payload.override_reason, 'Retained on the agency evidence server, case 24-1187', 'with the reason');

        // Point-to and missing-API guards.
        resetLogs();
        const REF = item(106, 'Phone2', ['D:\\Extractions\\big.ufdx'], { referenceOnly: true });
        R.caseEvidence.push(REF);
        await R.openReleaseEvidenceModal(106);
        eq(DIALOGS.length, 0, 'a Point-to item has nothing to remove — no dialog');
        ok(TOASTS.some(t => /never copied into the case folder/.test(t.msg)), 'and the officer is told why');
        const api = R.window.electronAPI;
        R.window.electronAPI = {};
        resetLogs();
        await R.openReleaseEvidenceModal(102);
        eq(DIALOGS.length, 0, 'without the desktop API, no dialog');
        R.window.electronAPI = api;

        // Partial failure, then a successful retry.
        resetLogs();
        DIALOG_ANSWER = { reason: '' };
        const realRelease = api.evidenceReleaseFiles;
        api.evidenceReleaseFiles = async () => ({ success: false, removed: 1, freedBytes: 300, missing: 0, kept: 0,
            failed: [{ path: ext, error: 'EBUSY: resource busy or locked' }], refused: [] });
        await R.openReleaseEvidenceModal(102);
        eq(PH.released, undefined, 'a partial failure does NOT mark the item removed');
        ok(PH.releaseAttempt && PH.releaseAttempt.filesRemoved === 1 && PH.releaseAttempt.failed === 1,
           'it records what was removed and what failed');
        ok(AUDITS.some(a => a.evt === 'evidence_files_release_failed'), 'the failure is audited');
        ok(TOASTS.some(t => t.type === 'error' && /could not be removed/.test(t.msg)), 'and the officer is told to close the program and retry');
        api.evidenceReleaseFiles = realRelease;
        resetLogs();
        await R.openReleaseEvidenceModal(102);
        ok(PH.released && !exists(ext), 'the retry finishes the job');
        eq(PH.released.filesRemoved, 2, 'and the counts add up across both attempts');
        eq(PH.released.bytesFreed, 1200, 'and so do the bytes');
        eq(PH.releaseAttempt, undefined, 'the partial-attempt marker is cleared');

        // The IPC itself throws.
        const t1 = mk(E('Throws', 't.bin'), 't');
        const TH = item(107, 'Throws', [t1]);
        R.caseEvidence.push(TH);
        api.evidenceReleaseFiles = async () => { throw new Error("Error invoking remote method 'evidence-release-files': Error: disk on fire"); };
        resetLogs();
        DIALOG_ANSWER = { reason: 'reason long enough' };
        await R.openReleaseEvidenceModal(107);
        ok(TOASTS.some(t => t.type === 'error' && /disk on fire/.test(t.msg) && /Nothing was changed/.test(t.msg)), 'an IPC error is reported in plain words');
        ok(!TOASTS.some(t => /Error invoking remote method/.test(t.msg)), 'without the Electron plumbing prefix');
        eq(TH.released, undefined, 'and the item is untouched');
        api.evidenceReleaseFiles = realRelease;

        // The note cannot be saved after the files are gone: say so loudly.
        SAVE_OK = false;
        resetLogs();
        await R.openReleaseEvidenceModal(107);
        ok(!exists(t1), 'the files were removed');
        ok(TOASTS.some(t => t.type === 'error' && /could not save the note/.test(t.msg)), 'and the officer is warned the record did not save');
        ok(!TOASTS.some(t => t.type === 'success'), 'with no false success message');
        SAVE_OK = true;
    }

    // ═════════════════════════════════════════════════════════════════════
    //  6. WHAT THE OFFICER SEES
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n6. Cards, controls and the removed-item viewer');
    {
        const CN = '26-400';
        const E = (...p) => at(CN, 'Evidence', ...p);
        const clean = { at: '2026-10-10T12:00:00Z', kind: 'da', clean: true, reason: '', file: 'E:\\DA\\x.zip' };
        const X = item(201, 'Cam', [E('Cam', 'a.mp4')], { exports: [clean] });
        const Y = item("it's-202", 'Cam2', [E('Cam2', 'b.mp4')], { exports: [{ at: '2026-10-10T12:00:00Z', kind: 'da', clean: false, reason: 'skipped' }] });
        const Z = item(203, 'Gone <b>', [E('Gone', 'c.mp4')], {
            files: [{ name: 'night <cam>.mp4', path: E('Gone', 'night.mp4'), size: 5 }],
            released: { at: '2026-10-11T09:00:00Z', exportedAt: '2026-10-10T12:00:00Z', exportKind: 'da',
                        exportFile: 'E:\\DA\\x.zip', overrideReason: '<script>x</script>', bytesFreed: 5, filesKept: 1 } });
        setCase(CN, [X, Y, Z]);

        let h = R._evidenceCardChips(X);
        ok(/✓ In DA export/.test(h), 'a fully exported item shows the green chip');
        h = R._evidenceCardChips(Z);
        ok(/📦 Exported — removed from case files/.test(h), 'a removed item shows the amber chip');
        ok(!/In DA export/.test(h), 'and not the green one');
        h = R._evidenceCardChips(Object.assign({}, Y, { releaseAttempt: { at: 'x', failed: 1 } }));
        ok(/Removal incomplete/.test(h), 'an unfinished removal is flagged');
        ok(/Point-to — files not in VIPER/.test(R._evidenceCardChips({ referenceOnly: true, type: 'cellebrite' })), 'a Point-to item says its files are not in VIPER');
        eq(R._evidenceCardChips({ referenceOnly: true, type: 'datapilot' }), '', 'Datapilot already has its own reference chip');
        eq(R._evidenceCardChips({ files: [] }), '', 'an ordinary item shows nothing extra');

        h = R._evidenceReleaseControls(X);
        ok(/Fully included in the Export to DA/.test(h), 'controls: a covered item says so');
        ok(/openReleaseEvidenceModal\(201\)/.test(h), 'and its button carries the numeric id');
        h = R._evidenceReleaseControls(Y);
        ok(/Field Security was locked/.test(h), 'controls: an uncovered item says why');
        ok(h.indexOf("openReleaseEvidenceModal('it\\'s-202')") !== -1, 'a string id is quoted safely in the onclick');
        eq(R._evidenceReleaseControls(Z), '', 'no Remove button on an already-removed item');
        eq(R._evidenceReleaseControls({ referenceOnly: true, files: [{ path: 'D:\\x' }] }), '', 'or on a Point-to item');

        h = R._renderReleasedEvidence(Z);
        ok(/original files no longer in case files/.test(h), 'the viewer states the files are gone');
        ok(/Exported to DA on/.test(h), 'when it was exported');
        ok(/removed from this case's folder on/.test(h), 'and when the files were removed');
        ok(/freeing 5 B/.test(h), 'and how much space it freed');
        ok(h.indexOf('E:\\DA\\x.zip') !== -1, 'and which export file holds them');
        ok(/1 file\(s\) were kept/.test(h), 'and that a shared file was kept');
        ok(/Reason given/.test(h) && h.indexOf('<script>') === -1 && h.indexOf('&lt;script&gt;') !== -1, 'the override reason is shown, escaped');
        ok(h.indexOf('night &lt;cam&gt;.mp4') !== -1, 'the file listing is kept, escaped');
        ok(/listing only/.test(h), 'and labelled as a listing only');
        ok(/Included in an Assist Package/.test(R._renderReleasedEvidence(Object.assign({}, Z, { released: Object.assign({}, Z.released, { exportKind: 'assist' }) }))),
           'an item removed after an Assist Package says so');
    }

    // ═════════════════════════════════════════════════════════════════════
    //  7. NOTHING ELSE TRIES TO READ A REMOVED FILE
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n7. Removed files are not offered elsewhere');
    {
        const CN = '26-500';
        const E = (...p) => at(CN, 'Evidence', ...p);
        setCase(CN, [
            item(301, 'Tip', [E('Tip', 'CyberTip 123456789.pdf')]),
            item(302, 'Old Tip', [E('Old Tip', 'CyberTip 987654321.pdf')], { released: { at: 'x' } }),
        ]);
        const c = R._cyberTipEvidenceCandidates();
        eq(c.length, 1, 'Find CyberTips in Evidence skips removed items');
        eq(c[0] && c[0].evidenceTag, 'Tip', 'and still finds the live one');

        const B = {};
        vm.createContext(B);
        vm.runInContext(
            slice(BOARD, 'function _mimeFromExt(', '\n  // Collect viewable (image/video/audio)', 'board mime helpers') + '\n' +
            slice(BOARD, 'function evidenceMedia(', '\n  // Collect viewable files off an area-canvass entry.', 'board evidenceMedia'), B);
        const files = [{ name: 'a.mp4', path: E('X', 'a.mp4') }, { name: 'b.jpg', path: E('X', 'b.jpg') }];
        eq(B.evidenceMedia({ files }).length, 2, 'Connection Board: a live item offers its media');
        eq(B.evidenceMedia({ files, released: { at: 'x' } }).length, 0, 'a removed item offers none (nothing to load)');
    }

    // ═════════════════════════════════════════════════════════════════════
    //  8. DEVICE EXAMS AND WARRANT AUTHOR IN THE DA REPORT
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n8. Device Exams and Warrant Author report sections');
    {
        const rStart = DETAIL.indexOf('function _renderTabPDF(');
        ok(rStart !== -1, '_renderTabPDF is still in the case page');
        const CASES = slice(DETAIL, "case 'forensics': {", "\n                default:\n                    emptyMsg(`Content for", 'pdf sections', rStart);
        let OUT = [];
        const P = {
            OUT: null,
            fieldBold: (k, v) => OUT.push(['field', k, v]),
            itemHeading: (t) => OUT.push(['h', t]),
            bodyText: (t) => OUT.push(['body', t]),
            emptyMsg: (t) => OUT.push(['empty', t]),
            gap: () => {},
            formatDate: (s) => 'D(' + s + ')',
            _lsParse: (k, d) => (k in STORE ? JSON.parse(STORE[k]) : d),
            caseForensicDevices: [],
            String, Array, Object, JSON
        };
        vm.createContext(P);
        vm.runInContext('function _sec(tabId, caseId) { switch (tabId) {\n' + CASES + '\n} }', P);
        const field = (k) => { const f = OUT.find(o => o[0] === 'field' && o[1].trim() === k); return f ? f[2] : undefined; };

        OUT = []; P._sec('forensics', 'c1');
        ok(OUT.length === 1 && OUT[0][0] === 'empty', 'no devices -> a plain "none recorded" line');
        P.caseForensicDevices = [null, {
            deviceCategory: 'Cell Phone', makeModel: 'Apple iPhone 14', imei: '356789012345678', serialNumber: 'F2LXQ',
            subjectName: 'J. Doe', subjectRole: 'Suspect', acquisitionDate: '2026-09-02', tool: 'Cellebrite UFED',
            extractionType: 'Full File System', examinerName: 'Det. Ruiz', examinerRole: 'CFCE',
            reviewed: true, reviewedAt: '2026-09-05T10:00:00Z', reviewedBy: 'Sgt. Lee',
            hasReportFile: true, reportFileName: 'exam report.pdf', notes: 'Locked; brute-forced.'
        }];
        OUT = []; P._sec('forensics', 'c1');
        eq(OUT[0][1], '1. Cell Phone — Apple iPhone 14', 'a device heading names its type and model (null rows skipped)');
        eq(field('IMEI'), '356789012345678', 'IMEI');
        eq(field('Subject'), 'J. Doe (Suspect)', 'subject with role');
        eq(field('Examiner'), 'Det. Ruiz (CFCE)', 'examiner with role');
        eq(field('Acquisition Date'), 'D(2026-09-02)', 'acquisition date');
        eq(field('Reviewed'), 'Yes — D(2026-09-05) by Sgt. Lee', 'review status, date and reviewer');
        eq(field('Exam Report'), 'exam report.pdf', 'the attached exam report is named');
        ok(OUT.some(o => o[0] === 'body' && o[1] === 'Locked; brute-forced.'), 'and the notes are printed');
        P.caseForensicDevices = [{ makeModel: 'Laptop' }];
        OUT = []; P._sec('forensics', 'c1');
        eq(field('Reviewed'), 'No', 'an unreviewed device says No');
        eq(field('IMEI'), undefined, 'and blank fields are left out');

        OUT = []; P._sec('warrantAuthor', 'c1');
        ok(OUT.length === 1 && OUT[0][0] === 'empty', 'no warrants -> a plain "none written" line');
        STORE['warrantAuthor_c1'] = JSON.stringify({ drafts: [{
            type: 'multi-business-esp', jurisdiction: 'CO', status: 'signed', swNumber: 'SW-26-41',
            courtName: 'District Court', county: 'Adams', judgeName: 'Hon. A. Park',
            offenses: [{ code: '18-3-405.4', label: 'Internet sexual exploitation' }, 'Stalking'],
            addendums: [{ businessNameSnapshot: 'Google LLC', targetAccounts: ['a@gmail.com', { value: 'b@gmail.com' }],
                          dateRangeFrom: '2026-01-01', dateRangeTo: '2026-03-01', servedAt: '2026-04-01T09:00:00Z' },
                        { providerKey: 'snap', pageLabel: 'B' }],
            pdfPath: 'x.pdf', docxPath: 'x.docx', updatedAt: '2026-04-02T10:00:00Z'
        }, { type: 'residential', premises: { address: '12 Elm St' } }] });
        OUT = []; P._sec('warrantAuthor', 'c1');
        eq(OUT[0][1], '1. Electronic service provider warrant (CO)', 'an ESP warrant heading with its jurisdiction');
        eq(field('Status'), 'Signed', 'status, capitalised');
        eq(field('Warrant Number'), 'SW-26-41', 'warrant number');
        eq(field('Judge'), 'Hon. A. Park', 'judge');
        eq(field('Offenses'), '18-3-405.4 Internet sexual exploitation; Stalking', 'offenses, object or plain');
        eq(field('Addendum 1'), 'Google LLC', 'each provider addendum');
        eq(field('Target Accounts'), 'a@gmail.com, b@gmail.com', 'with its target accounts');
        eq(field('Date Range'), 'D(2026-01-01) to D(2026-03-01)', 'the date range');
        eq(field('Served'), 'D(2026-04-01)', 'when it was served');
        eq(field('Addendum B'), 'snap', 'a page label and provider key fallback');
        eq(field('Documents'), 'PDF and Word generated', 'which documents were generated');
        ok(OUT.some(o => o[0] === 'h' && o[1] === '2. Residential search warrant'), 'a residential warrant');
        ok(OUT.some(o => o[0] === 'field' && o[1] === 'Premises' && o[2] === '12 Elm St'), 'with its premises');
    }

    // ═════════════════════════════════════════════════════════════════════
    //  9. WIRING IN THE CASE PAGE (source invariants)
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n9. Wiring in the case page');
    {
        ok(DETAIL.indexOf("dataTabs = selectedTabs.filter(tab => tab.type === 'data' || tab.type === 'mixed');") !== -1,
           'tabs that hold both records and files get a report section');
        ok(/forensics:\s+'forensics',/.test(DETAIL) && /warrantAuthor: 'warrantDrafts'/.test(DETAIL),
           'and their files ride in the ZIP');
        eq((DETAIL.match(/electronAPI\.saveDAExport\(/g) || []).length, 1, 'saveDAExport is called in exactly one place');
        ok(/async function _daExportSave\(args, filesOnly\) \{\n\s+const res = await window\.electronAPI\.saveDAExport\(/.test(DETAIL),
           'and that place is the wrapper that stamps the evidence');
        eq((DETAIL.match(/await _daExportSave\(/g) || []).length, 2, 'both export paths go through the wrapper');
        ok(/function viewEvidenceInline\(evidenceId\) \{[\s\S]{0,400}if \(evidence\.released\) \{[\s\S]{0,500}_renderReleasedEvidence\(evidence\)[\s\S]{0,150}return;/.test(DETAIL),
           'the viewer shows the record, and never tries to read, a removed item');
        ok(/function openCellebriteReader\(evidenceId\) \{[\s\S]{0,200}if \(evidence && evidence\.released\)/.test(DETAIL),
           'the Cellebrite Reader is not launched on a removed extraction');
        ok(DETAIL.indexOf('${_evidenceCardChips(item)}') !== -1, 'evidence cards show the status chips');
        ok(DETAIL.indexOf('${_evidenceReleaseControls(evidence)}') !== -1, 'the viewer shows the Remove control');
    }

    // ═════════════════════════════════════════════════════════════════════
    // 10. ADDING LARGE EVIDENCE: folder listing and the copy itself
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n10. Adding large evidence (folder listing, copy, encryption ceiling)');
    {
        const CAP_LINE = 'const EVIDENCE_ENCRYPT_MAX_BYTES = 1900 * 1024 * 1024;';
        ok(MAIN.indexOf(CAP_LINE) !== -1, 'the encryption ceiling is still 1.9 GB (under the 2 GB Buffer limit)');
        const fnA = MAIN.indexOf('function _listEvidenceFolder(');
        const LIST_FN = MAIN.slice(fnA, MAIN.indexOf('\n}\n', fnA) + 3);
        // Test-only: a 10-byte ceiling instead of writing a 1.9 GB file.
        vm.runInContext('const EVIDENCE_ENCRYPT_MAX_BYTES = 10;\n' + LIST_FN + '\n' +
            handler('evidence-list-folder') + '\n' + handler('copy-evidence-file'), mainEnv);
        const listFolder = HANDLERS['evidence-list-folder'];
        const copyFile = HANDLERS['copy-evidence-file'];
        securityStub.encryptBuffer = (b) => Buffer.concat([HDR, b]);

        const SRC = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-evsrc-'));
        mk(path.join(SRC, 'Extraction', 'report.html'), 'r'.repeat(5));
        mk(path.join(SRC, 'Extraction', 'files', 'Image', 'a.jpg'), 'j'.repeat(25));
        let r = await listFolder(null, path.join(SRC, 'Extraction'));
        eq(r.success, true, 'a folder is listed');
        eq(r.folderName, 'Extraction', 'with its name');
        eq(r.folderPath, path.join(SRC, 'Extraction'), 'and where it is (for Point-to)');
        eq(r.files.length, 2, 'every file, recursively');
        const jpg = r.files.find(f => f.name === 'a.jpg');
        eq(jpg && jpg.relativePath, 'files/Image/a.jpg', 'with its path inside the folder');
        eq(jpg && jpg.size, 25, 'and its size');
        eq(JSON.stringify(r.unreadable), '[]', 'nothing unreadable');
        eq((await listFolder(null, path.join(SRC, 'nope'))).success, false, 'a missing folder is refused');
        eq((await listFolder(null, path.join(SRC, 'Extraction', 'report.html'))).success, false, 'a file is not a folder');

        securityStub.unlocked = false;
        let dest = await copyFile(null, { caseNumber: '26-600', evidenceTag: 'Phone', sourcePath: jpg.path, relativePath: 'files/Image/a.jpg' });
        eq(dest, at('26-600', 'Evidence', 'Phone', 'files', 'Image', 'a.jpg'), 'Copy keeps the subfolder layout under the case Evidence folder');
        eq(fs.readFileSync(dest).toString(), 'j'.repeat(25), 'a plain copy is byte-identical');
        ok(fs.statSync(dest).size > 10, 'and has no size ceiling (25 bytes > the test ceiling of 10)');

        securityStub.unlocked = true;
        dest = await copyFile(null, { caseNumber: '26-600', evidenceTag: 'Small', sourcePath: path.join(SRC, 'Extraction', 'report.html') });
        ok(fs.readFileSync(dest).slice(0, 6).equals(HDR), 'with Field Security on, a small file is stored encrypted');
        let err = null;
        try { await copyFile(null, { caseNumber: '26-600', evidenceTag: 'Big', sourcePath: jpg.path }); }
        catch (e) { err = e; }
        ok(err && /^TOO_LARGE_TO_ENCRYPT:/.test(err.message), 'a file over the ceiling is refused when it would have to be encrypted');
        ok(err && /Point to where it's stored/.test(err.message), 'and the message tells the officer what to do instead');
        ok(!exists(at('26-600', 'Evidence', 'Big', 'a.jpg')), 'and no partial file is left behind');
        try { fs.rmSync(SRC, { recursive: true, force: true }); } catch (_) {}
    }

    // ── done ──
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(UD, { recursive: true, force: true }); } catch (_) {}
    console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + ' — ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
    console.error('UNCAUGHT', e);
    process.exit(1);
});

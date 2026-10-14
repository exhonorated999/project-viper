/*
 * Word report — the main-process half.
 *
 * Run: set ELECTRON_RUN_AS_NODE=1 && node_modules\.bin\electron.cmd modules\reports\__tests__\word-report-main.test.js
 *      (plain `node` works too — no native deps)
 *
 * WHY THIS EXISTS
 *
 * An officer can now write the case report in Microsoft Word instead of
 * VIPER's editor. The file lives in cases/<cn>/Reports/Word/ and runs on the
 * Working Documents engine — a SECOND manager over a different folder. What
 * can go wrong, and is pinned here:
 *
 *   - the second manager writing into Warrants/Working (or the first one
 *     into Reports/Word) — the folder is a dependency now, not a constant;
 *   - the two managers sharing a crash-recovery folder: recover() adopts
 *     every session folder it finds, so a shared folder would bring a
 *     warrant draft's leftover save into the REPORT folder;
 *   - lock / quit bringing in only the warrant drafts' saves;
 *   - "Save a copy" handing the DA the encrypted bytes, or a copy one save
 *     behind what the officer just saved in Word;
 *   - Replace throwing the old report away before the new one is in;
 *   - somebody later teaching Export to DA to walk Reports/ — the Word
 *     report is promised to be left out.
 *
 * The IPC handlers are LIFTED from electron-main.js, not copied.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..', '..');
const WD = require(path.join(ROOT, 'modules', 'warrants', 'working-docs.js'));
const MAIN_SRC = fs.readFileSync(path.join(ROOT, 'electron-main.js'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const ok = (n, c, x) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? ' -> ' + JSON.stringify(x) : '')); }
};

function fakeSecurity({ enabled = true, unlocked = true } = {}) {
    const MAGIC = Buffer.from('FAKEENC1');
    const xor = (b) => Buffer.from(b.map((x) => x ^ 0x5a));
    return {
        enabled, unlocked,
        isEnabled() { return this.enabled; },
        isUnlocked() { return this.unlocked; },
        isEncryptedBuffer(b) { return Buffer.isBuffer(b) && b.length >= 8 && b.subarray(0, 8).equals(MAGIC); },
        encryptBuffer(b) { if (!this.unlocked) throw new Error('locked'); return Buffer.concat([MAGIC, xor(b)]); },
        decryptBuffer(b) { if (!this.isEncryptedBuffer(b)) return b; if (!this.unlocked) throw new Error('locked'); return xor(b.subarray(8)); },
    };
}

let fakeClock = Date.UTC(2026, 9, 14, 12, 0, 0) / 1000;
function wordSave(p, text) {
    fs.writeFileSync(p, text);
    fakeClock += 7;
    fs.utimesSync(p, fakeClock, fakeClock);
}

function makeMgr(root, security, opts = {}) {
    const locked = new Set();
    const events = [];
    const mgr = WD.createWorkingDocs({
        fs, path, crypto,
        subDir: opts.subDir,
        casesDir: () => path.join(root, 'cases'),
        sessionsRoot: () => path.join(root, 'userData', opts.sessions || 'working-docs'),
        getSecurity: () => security,
        openPath: async () => '',
        trashItem: async (p) => fs.unlinkSync(p),
        notify: (e) => events.push(e),
        probeLocked: (p) => locked.has(p),
        setInterval: () => ({ unref() {} }),
        clearInterval: () => {},
    });
    return { mgr, locked, events };
}

/** The source between two anchors, both of which must exist. */
function slice(src, from, to) {
    const a = src.indexOf(from);
    if (a < 0) throw new Error('anchor not found: ' + from);
    const b = src.indexOf(to, a + from.length);
    if (b < 0) throw new Error('end anchor not found: ' + to);
    return src.slice(a, b);
}

(async function main() {

/* ==================================================
 * 1. The folder is a dependency
 * ================================================== */
console.log('\n[the folder is a dependency]');
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-wr-'));
    const warrants = makeMgr(root, null);
    const reports = makeMgr(root, null, { subDir: ['Reports', 'Word'], sessions: 'report-docs' });
    ok('the default folder is still Warrants/Working',
        warrants.mgr.workingDir('C-1') === path.join(root, 'cases', 'C-1', 'Warrants', 'Working'));
    ok('the report manager uses Reports/Word',
        reports.mgr.workingDir('C-1') === path.join(root, 'cases', 'C-1', 'Reports', 'Word'));
    reports.mgr.addBuffer('C-1', 'Case Report.docx', Buffer.from('report body'));
    ok('a report lands in Reports/Word', fs.existsSync(path.join(root, 'cases', 'C-1', 'Reports', 'Word', 'Case Report.docx')));
    ok('and never in Warrants/Working', !fs.existsSync(path.join(root, 'cases', 'C-1', 'Warrants')));
    ok('the warrant manager does not list it', warrants.mgr.list('C-1').length === 0);
    ok('the report manager does', reports.mgr.list('C-1').length === 1);

    for (const bad of [['..'], ['Reports', '..'], ['a/b'], ['a\\b'], ['']]) {
        let threw = false;
        try { makeMgr(root, null, { subDir: bad }); } catch (_) { threw = true; }
        ok('a folder that could climb out of the case is refused: ' + JSON.stringify(bad), threw);
    }
}

/* ==================================================
 * 2. Field Security on: Word's saves come back encrypted
 * ================================================== */
console.log('\n[encrypted round trip]');
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-wr-'));
    const sec = fakeSecurity();
    const { mgr, locked } = makeMgr(root, sec, { subDir: ['Reports', 'Word'], sessions: 'report-docs' });
    const made = mgr.addBuffer('C-2', 'Case Report.docx', Buffer.from('v1'));
    const full = path.join(root, 'cases', 'C-2', 'Reports', 'Word', made.fileName);
    ok('the case copy is encrypted at rest', sec.isEncryptedBuffer(fs.readFileSync(full)));
    const r = await mgr.open('C-2', made.fileName);
    ok('it opens through a private decrypted copy', r.mode === 'session');
    const s = Array.from(mgr._sessions.values())[0];
    ok('the copy is in the REPORT session folder', s.dir.startsWith(path.join(root, 'userData', 'report-docs')));
    locked.add(s.plainPath);
    wordSave(s.plainPath, 'v2 typed in Word');

    // Save a copy straight after Word saves, before any poll has run.
    const plain = mgr.readPlain('C-2', made.fileName);
    ok('readPlain gives the save Word just made, not the one before', plain.toString() === 'v2 typed in Word', plain.toString());
    ok('and that save is now in the case, encrypted',
        sec.decryptBuffer(fs.readFileSync(full)).toString() === 'v2 typed in Word' && sec.isEncryptedBuffer(fs.readFileSync(full)));

    // A poll has to SEE Word holding the file before letting go means
    // "closed" -- an editor that never locks is kept until lock/quit.
    mgr.tick();
    locked.delete(s.plainPath);
    mgr.tick(); mgr.tick();
    ok('when Word lets go the plaintext copy is gone', !fs.existsSync(s.plainPath));

    let code = null;
    try { mgr.readPlain('C-2', 'Missing.docx'); } catch (e) { code = e.code; }
    ok('readPlain on a missing report says NOT_FOUND', code === 'NOT_FOUND');
    code = null;
    try { mgr.readPlain('C-2', '..\\evil.docx'); } catch (e) { code = e.code; }
    ok('readPlain refuses a name that is not a plain file name', code === 'BAD_NAME');
    sec.unlocked = false;
    code = null;
    try { mgr.readPlain('C-2', made.fileName); } catch (e) { code = e.code; }
    ok('readPlain while locked says LOCKED rather than returning ciphertext', code === 'LOCKED');
}

/* ==================================================
 * 3. Separate recovery folders
 * ================================================== */
console.log('\n[recovery stays in its own lane]');
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-wr-'));
    const sec = fakeSecurity();
    const w1 = makeMgr(root, sec);
    const r1 = makeMgr(root, sec, { subDir: ['Reports', 'Word'], sessions: 'report-docs' });
    w1.mgr.addBuffer('C-3', 'Affidavit.docx', Buffer.from('aff v1'));
    r1.mgr.addBuffer('C-3', 'Case Report.docx', Buffer.from('rep v1'));
    await w1.mgr.open('C-3', 'Affidavit.docx');
    await r1.mgr.open('C-3', 'Case Report.docx');
    const ws = Array.from(w1.mgr._sessions.values())[0];
    const rs = Array.from(r1.mgr._sessions.values())[0];
    wordSave(ws.plainPath, 'aff v2 (crash)');
    wordSave(rs.plainPath, 'rep v2 (crash)');
    // VIPER crashes: brand-new managers, the session folders left behind.
    const w2 = makeMgr(root, sec);
    const r2 = makeMgr(root, sec, { subDir: ['Reports', 'Word'], sessions: 'report-docs' });
    const outR = r2.mgr.recover();
    const outW = w2.mgr.recover();
    ok('the report manager recovers only the report', outR.length === 1 && outR[0].fileName === 'Case Report.docx' && outR[0].action === 'ingest', outR);
    ok('the warrant manager recovers only the draft', outW.length === 1 && outW[0].fileName === 'Affidavit.docx' && outW[0].action === 'ingest', outW);
    ok('the report save is in Reports/Word', r2.mgr.readPlain('C-3', 'Case Report.docx').toString() === 'rep v2 (crash)');
    ok('the draft save is in Warrants/Working', w2.mgr.readPlain('C-3', 'Affidavit.docx').toString() === 'aff v2 (crash)');
    ok('no draft leaked into the report folder', r2.mgr.list('C-3').map((d) => d.fileName).join() === 'Case Report.docx');
}

/* ==================================================
 * 4. electron-main: lock / quit / recover cover BOTH managers
 * ================================================== */
console.log('\n[electron-main: both managers on lock, quit and recovery]');
{
    const block = slice(MAIN_SRC, 'function _workingDocsCheckIn(reason) {', "app.on('before-quit', () => {\n  _workingDocsCheckIn('quit');");
    const calls = [];
    const fakeMgr = (label, result, recovered) => ({
        checkInAll(o) { calls.push(label + ':checkIn:' + (o && o.final)); return result; },
        recover() { calls.push(label + ':recover'); return recovered; },
    });
    const env = {
        console: { log() {}, error() {} },
        _workingDocsMgr: fakeMgr('wd', { saved: ['A.docx'], stillOpen: [], failed: [] }, [{ fileName: 'A.docx', action: 'clean' }]),
        _reportDocsMgr: fakeMgr('rep', { saved: [], stillOpen: ['Case Report.docx'], failed: [{ fileName: 'X.docx', error: 'disk' }] }, [{ fileName: 'Case Report.docx', action: 'ingest' }]),
    };
    env._workingDocs = () => env._workingDocsMgr;
    env._reportDocs = () => env._reportDocsMgr;
    vm.createContext(env);
    vm.runInContext(block, env);
    const r = env._workingDocsCheckIn('lock');
    ok('check-in asks both managers, with final:true', calls.includes('wd:checkIn:true') && calls.includes('rep:checkIn:true'), calls);
    ok('a Word report still open is named in the lock notice', r.stillOpen.includes('Case Report.docx'));
    ok('saves and failures from both are reported', r.saved.includes('A.docx') && r.failed.length === 1);
    const out = env._workingDocsRecover('unlock');
    ok('recovery runs both managers', calls.includes('wd:recover') && calls.includes('rep:recover') && out.length === 2);

    env._reportDocsMgr = null;
    const r2 = env._workingDocsCheckIn('quit');
    ok('a report manager never started is simply skipped', r2.saved.length === 1);

    const quit = slice(MAIN_SRC, "app.on('before-quit', () => {\n  _workingDocsCheckIn('quit');", '\n});');
    ok('quit stops the report manager\'s poll too', /_reportDocsMgr\.stop\(\)/.test(quit));
    ok('the report manager has its OWN session folder',
        /sessionsRoot: \(\) => path\.join\(app\.getPath\('userData'\), 'report-docs'\)/.test(MAIN_SRC));
}

/* ==================================================
 * 5. electron-main: the report IPC handlers, lifted
 * ================================================== */
console.log('\n[electron-main: report IPC]');
{
    const block = slice(MAIN_SRC, 'const REPORT_WORD_SUBDIR', '// --- Save warrant file to disk ---');
    const wdFail = slice(MAIN_SRC, 'function _wdFail(e) {', '\n}\n') + '\n}\n';
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-wr-'));
    const sec = fakeSecurity();
    const handlers = {};
    const dialogQ = { open: [], save: [] };
    const trashed = [];
    const sent = [];
    const env = {
        require, console, Buffer,
        fs, path, crypto,
        WorkingDocsLib: WD,
        casesDir: path.join(root, 'cases'),
        security: sec,
        mainWindow: {},
        restoreFocus() {},
        app: { getPath: (k) => path.join(root, k === 'userData' ? 'userData' : 'Documents') },
        shell: { openPath: async () => '', trashItem: async (p) => { trashed.push(p); fs.unlinkSync(p); } },
        BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (ch, e) => sent.push([ch, e]) } }] },
        dialog: {
            showOpenDialog: async (w, opts) => { dialogQ.lastOpts = opts; return dialogQ.open.shift(); },
            showSaveDialog: async () => dialogQ.save.shift(),
        },
        ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
    };
    vm.createContext(env);
    vm.runInContext('let _reportDocsMgr = null;\n' + wdFail + block, env);
    const call = (ch, args) => handlers[ch]({}, args);
    ok('all seven handlers are registered',
        ['report-docs-list', 'report-doc-import', 'report-doc-new-blank', 'report-doc-open', 'report-doc-remove', 'report-doc-save-copy', 'report-doc-rename']
            .every((c) => typeof handlers[c] === 'function'), Object.keys(handlers));

    // New, seeded from the VIPER editor's text.
    const seed = 'On 10/01/2026 I responded to 100 Main St.\n\nThe complainant stated…';
    let r = await call('report-doc-new-blank', { caseNumber: 'C-5', newName: 'Case Report C-5', seedText: seed });
    ok('a new report is created as .docx', r.success && r.fileName === 'Case Report C-5.docx', r);
    const JSZip = require('jszip');
    const plain = env._reportDocs().readPlain('C-5', r.fileName);
    const xml = await (await JSZip.loadAsync(plain)).file('word/document.xml').async('string');
    ok('the VIPER report text is in the Word document', xml.includes('I responded to 100 Main St.') && xml.includes('The complainant stated'));
    ok('one Word paragraph per line (blank line kept)', (xml.match(/<w:p>|<w:p /g) || []).length >= 3);
    ok('it is encrypted in the case folder',
        sec.isEncryptedBuffer(fs.readFileSync(path.join(root, 'cases', 'C-5', 'Reports', 'Word', r.fileName))));
    r = await call('report-doc-new-blank', { caseNumber: 'C-5b', newName: '' });
    ok('no name falls back to "Case Report.docx"', r.success && r.fileName === 'Case Report.docx', r);

    // Save a copy: a READABLE file for the DA.
    const dest = path.join(root, 'out', 'For DA.docx');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    dialogQ.save.push({ canceled: false, filePath: dest });
    r = await call('report-doc-save-copy', { caseNumber: 'C-5', fileName: 'Case Report C-5.docx' });
    ok('save a copy succeeds', r.success && r.filePath === dest, r);
    ok('the copy is plaintext the DA can open (not the encrypted bytes)',
        !sec.isEncryptedBuffer(fs.readFileSync(dest)) && fs.readFileSync(dest).equals(plain));
    dialogQ.save.push({ canceled: true });
    r = await call('report-doc-save-copy', { caseNumber: 'C-5', fileName: 'Case Report C-5.docx' });
    ok('cancelling the save dialog is not an error', r.success && r.canceled);
    sec.unlocked = false;
    dialogQ.save.push({ canceled: false, filePath: path.join(root, 'out', 'never.docx') });
    r = await call('report-doc-save-copy', { caseNumber: 'C-5', fileName: 'Case Report C-5.docx' });
    ok('while locked, save a copy fails plainly and writes nothing',
        !r.success && r.code === 'LOCKED' && !fs.existsSync(path.join(root, 'out', 'never.docx')), r);
    sec.unlocked = true;

    // Replace: the new one goes in BEFORE the old one goes.
    const newSrc = path.join(root, 'incoming', 'Final Report.docx');
    fs.mkdirSync(path.dirname(newSrc), { recursive: true });
    fs.writeFileSync(newSrc, 'final');
    dialogQ.open.push({ canceled: false, filePaths: [newSrc] });
    r = await call('report-doc-import', { caseNumber: 'C-5', replace: 'Case Report C-5.docx' });
    ok('replace brings the new document in', r.success && r.fileName === 'Final Report.docx' && !r.replaceError, r);
    ok('and sends the old one to the Recycle Bin', trashed.length === 1 && /Case Report C-5\.docx$/.test(trashed[0]));
    ok('leaving exactly one report', env._reportDocs().list('C-5').map((d) => d.fileName).join() === 'Final Report.docx');

    dialogQ.open.push({ canceled: true });
    r = await call('report-doc-import', { caseNumber: 'C-5', replace: 'Final Report.docx' });
    ok('cancelling a replace keeps the current report', r.canceled && env._reportDocs().list('C-5').length === 1);

    // Replace while the old one is open in Word: keep BOTH, say so.
    await call('report-doc-open', { caseNumber: 'C-5', fileName: 'Final Report.docx' });
    const other = path.join(root, 'incoming', 'Another.docx');
    fs.writeFileSync(other, 'another');
    dialogQ.open.push({ canceled: false, filePaths: [other] });
    r = await call('report-doc-import', { caseNumber: 'C-5', replace: 'Final Report.docx' });
    ok('an old report still open in Word is NOT thrown away', r.success && r.replaceError && env._reportDocs().list('C-5').length === 2, r);

    dialogQ.open.push({ canceled: false, filePaths: [path.join(root, 'incoming', 'notes.txt')] });
    fs.writeFileSync(path.join(root, 'incoming', 'notes.txt'), 'x');
    r = await call('report-doc-import', { caseNumber: 'C-6' });
    ok('a file that is not a Word document is refused', !r.success && r.code === 'BAD_NAME', r);
    ok('adding allows picking several documents', Array.isArray(dialogQ.lastOpts.properties) && dialogQ.lastOpts.properties.includes('multiSelections'));

    // Several documents at once — the good ones go in, the bad one is named.
    const s1 = path.join(root, 'incoming', 'Supplement 1.docx');
    const s2 = path.join(root, 'incoming', 'Supplement 2.docx');
    fs.writeFileSync(s1, 's1'); fs.writeFileSync(s2, 's2');
    dialogQ.open.push({ canceled: false, filePaths: [s1, s2, path.join(root, 'incoming', 'notes.txt')] });
    r = await call('report-doc-import', { caseNumber: 'C-7' });
    ok('several documents come in together', r.success && JSON.stringify(r.added) === JSON.stringify(['Supplement 1.docx', 'Supplement 2.docx']), r);
    ok('…the one that is not Word is reported by name, not fatal', r.failed.length === 1 && r.failed[0].fileName === 'notes.txt' && !!r.failed[0].error, r.failed);
    ok('…and both are in the case', env._reportDocs().list('C-7').length === 2);
    dialogQ.open.push({ canceled: false, filePaths: [s1] });
    r = await call('report-doc-import', { caseNumber: 'C-7' });
    ok('bringing the same file in again never overwrites — it gets its own name',
        r.success && r.added.length === 1 && r.added[0] !== 'Supplement 1.docx' && env._reportDocs().list('C-7').length === 3, r);
    dialogQ.open.push({ canceled: false, filePaths: [s1, s2] });
    r = await call('report-doc-import', { caseNumber: 'C-7', replace: 'Supplement 2.docx' });
    ok('a replace offers only a single pick', !dialogQ.lastOpts.properties.includes('multiSelections'));
    ok('…and uses only one file even if handed two', r.success && r.added.length === 1, r);

    // Rename.
    r = await call('report-doc-rename', { caseNumber: 'C-5', fileName: 'Final Report.docx', newName: 'Original' });
    ok('a report open in Word cannot be renamed', !r.success && r.code === 'OPEN', r);
    r = await call('report-doc-rename', { caseNumber: 'C-5', fileName: 'Another.docx', newName: 'Supplement - Search Warrant' });
    ok('rename keeps the .docx and returns the new name', r.success && r.fileName === 'Supplement - Search Warrant.docx', r);
    ok('…and the file really moved', env._reportDocs().list('C-5').some((d) => d.fileName === 'Supplement - Search Warrant.docx') &&
        !env._reportDocs().list('C-5').some((d) => d.fileName === 'Another.docx'));
    r = await call('report-doc-rename', { caseNumber: 'C-5', fileName: 'Supplement - Search Warrant.docx', newName: 'final report' });
    ok('renaming onto a name already in use is refused (any capitalisation)', !r.success && r.code === 'EXISTS', r);
    r = await call('report-doc-rename', { caseNumber: 'C-5', fileName: 'Supplement - Search Warrant.docx', newName: '   ' });
    ok('a blank name is refused', !r.success && r.code === 'BAD_NAME', r);
    r = await call('report-doc-rename', { caseNumber: 'C-5', fileName: '..\\x.docx', newName: 'y' });
    ok('a path is never accepted as a file name', !r.success, r);

    r = await call('report-docs-list', { caseNumber: '../x' });
    ok('a case number that could climb out of the cases folder is refused', !r.success && r.code === 'BAD_CASE', r);

    env.shell.openPath = async () => 'No application is associated';
    r = await call('report-doc-open', { caseNumber: 'C-5b', fileName: 'Case Report.docx' });
    ok('no Word installed: the officer is told in plain words', !r.success && /Microsoft Word/.test(r.error), r);

    ok('events go out on their own channel, not the Working Documents one',
        sent.length > 0 && sent.every(([ch]) => ch === 'report-doc-event'));
}

/* ==================================================
 * 6. Export to DA never walks Reports/
 * ================================================== */
console.log('\n[the Word report stays out of Export to DA]');
{
    const handler = slice(MAIN_SRC, "ipcMain.handle('save-da-export'", '\nipcMain.handle(');
    ok('save-da-export reads no Reports folder', !/['"]Reports['"]/.test(handler));
    ok('…and does not walk the whole case folder either',
        !/addTreeToArchive\(\s*path\.join\(\s*casesDir\s*,\s*caseNumber\s*\)\s*,/.test(handler));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

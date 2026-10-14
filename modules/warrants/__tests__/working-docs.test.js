/*
 * Working Documents — live Word drafts kept inside the case.
 *
 * Run: node modules\warrants\__tests__\working-docs.test.js
 * (pure fs module, no native deps; also runs under ELECTRON_RUN_AS_NODE)
 *
 * WHY THIS EXISTS
 *
 * An officer types an affidavit in Word for an hour, presses Save, and
 * trusts it is in the case. Every way that can quietly fail is pinned here:
 *
 *   - with Field Security on, Word edits a decrypted COPY. If the copy's
 *     saves never come back into the case, the hour is gone the moment the
 *     copy is cleaned up. (The old generic `open-file` path does exactly
 *     that — it was never meant for live documents.)
 *   - a save read half-way through Word writing it would put a corrupt
 *     document into the case.
 *   - locking the vault, quitting, or a crash with Word still open must not
 *     lose a save, and must not overwrite a case copy that ALSO changed.
 *   - the decrypted copy must not be left on disk once Word lets go.
 *   - nothing ever overwrites an existing document by name.
 *
 * Word itself is simulated: a "save" is a write to the working copy, and
 * "Word has it open" is the owner file (~$name) or the injected lock probe.
 * The poll is driven by calling tick() directly — no timers.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const WD = require(path.join(__dirname, '..', 'working-docs.js'));

let pass = 0, fail = 0;
const ok = (n, c, x) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? ' -> ' + JSON.stringify(x) : '')); }
};
const throwsCode = (fn, code) => {
    try { fn(); return false; } catch (e) { return !!e && e.code === code; }
};
async function rejectsCode(p, code) {
    try { await p; return false; } catch (e) { return !!e && e.code === code; }
}

/* ---------------- fixtures ---------------- */

// A reversible stand-in for the SecurityManager. "Encrypted" bytes carry a
// magic header and are XOR-ed so plaintext is never visible in them.
function fakeSecurity({ enabled = true, unlocked = true } = {}) {
    const MAGIC = Buffer.from('FAKEENC1');
    const xor = (b) => Buffer.from(b.map((x) => x ^ 0x5a));
    return {
        enabled, unlocked,
        isEnabled() { return this.enabled; },
        isUnlocked() { return this.unlocked; },
        isEncryptedBuffer(b) { return Buffer.isBuffer(b) && b.length >= 8 && b.subarray(0, 8).equals(MAGIC); },
        encryptBuffer(b) { if (!this.unlocked) throw new Error('locked'); return Buffer.concat([MAGIC, xor(b)]); },
        decryptBuffer(b) {
            if (!this.isEncryptedBuffer(b)) return b;
            if (!this.unlocked) throw new Error('locked');
            return xor(b.subarray(8));
        },
        lock() { this.unlocked = false; },
        unlock() { this.unlocked = true; },
    };
}

function makeEnv(opts = {}) {
    const root = opts.root || fs.mkdtempSync(path.join(os.tmpdir(), 'viper-wd-'));
    const casesDir = path.join(root, 'cases');
    const sessionsRoot = path.join(root, 'userData', 'working-docs');
    fs.mkdirSync(casesDir, { recursive: true });
    const env = {
        root, casesDir, sessionsRoot,
        security: opts.security === undefined ? null : opts.security,
        events: [], opened: [], trashed: [],
        openResult: '',
        locked: new Set(),          // paths the fake "Word" holds open
    };
    env.mgr = WD.createWorkingDocs({
        fs, path, crypto,
        casesDir: () => casesDir,
        sessionsRoot: () => sessionsRoot,
        getSecurity: () => env.security,
        openPath: async (p) => { env.opened.push(p); return env.openResult; },
        trashItem: async (p) => { env.trashed.push(p); fs.unlinkSync(p); },
        notify: (e) => env.events.push(e),
        probeLocked: (p) => env.locked.has(p),
        setInterval: () => ({ unref() {} }),   // tests drive tick() themselves
        clearInterval: () => {},
    });
    env.dir = (cn) => path.join(casesDir, cn, 'Warrants', 'Working');
    env.caseFile = (cn, name) => path.join(env.dir(cn), name);
    env.readCase = (cn, name) => {
        const raw = fs.readFileSync(env.caseFile(cn, name));
        return env.security ? env.security.decryptBuffer(raw) : raw;
    };
    env.eventsOf = (type) => env.events.filter((e) => e.type === type);
    return env;
}

// Word saving: new bytes and a distinct mtime so the size+time signature moves.
let fakeClock = Date.UTC(2026, 9, 13, 12, 0, 0) / 1000;
function wordSave(p, text) {
    fs.writeFileSync(p, text);
    fakeClock += 7;
    fs.utimesSync(p, fakeClock, fakeClock);
}
function sessionOf(env, cn, name) {
    for (const s of env.mgr._sessions.values()) if (s.caseNumber === cn && s.fileName === name) return s;
    return null;
}
const sessionDirs = (env) => { try { return fs.readdirSync(env.sessionsRoot); } catch (_) { return []; } };

(async function main() {

/* ==================================================
 * 1. Pure helpers
 * ================================================== */
console.log('\n[pure helpers]');
ok('extOf lower-cases', WD.extOf('Affidavit.DOCX') === '.docx');
ok('extOf: no extension', WD.extOf('README') === '');
ok('extOf: leading dot is not an extension', WD.extOf('.docx') === '');
ok('hasAllowedExt: docx/doc/rtf', WD.hasAllowedExt('a.docx') && WD.hasAllowedExt('a.doc') && WD.hasAllowedExt('a.RTF'));
ok('hasAllowedExt: refuses pdf and docm', !WD.hasAllowedExt('a.pdf') && !WD.hasAllowedExt('a.docm'));
ok('stripExt removes a Word extension', WD.stripExt('Running Affidavit.docx') === 'Running Affidavit');
ok('stripExt leaves other dots alone', WD.stripExt('v1.2 notes') === 'v1.2 notes');
ok('withExt replaces the extension', WD.withExt('Draft.doc', '.docx') === 'Draft.docx');
ok('withExt adds one', WD.withExt('Search Warrant', '.docx') === 'Search Warrant.docx');
ok('withExt of nothing is empty', WD.withExt('', '.docx') === '');

ok('cleanName drops a folder part', WD.cleanName('C:\\Users\\x\\Desktop\\Aff.docx') === 'Aff.docx');
ok('cleanName drops a POSIX folder part', WD.cleanName('../../etc/Aff.docx') === 'Aff.docx');
ok('cleanName replaces illegal chars', WD.cleanName('SW: Google "acct"?.docx') === 'SW Google acct .docx'.replace(/\s+/g, ' '),
    WD.cleanName('SW: Google "acct"?.docx'));
ok('cleanName trims trailing dots and spaces', WD.cleanName('Aff.docx. . ') === 'Aff.docx');
ok('cleanName of only junk is empty', WD.cleanName(' ..  ') === '' && WD.cleanName(null) === '');
ok('cleanName guards reserved device names', WD.cleanName('CON.docx') === '_CON.docx' && WD.cleanName('lpt1') === '_lpt1');
const long = WD.cleanName('x'.repeat(300) + '.docx');
ok('cleanName caps length and keeps the extension', long.length === 120 && long.endsWith('.docx'), long.length);

ok('isHiddenEntry: Word owner file', WD.isHiddenEntry('~$nning Affidavit.docx'));
ok('isHiddenEntry: Word save temp', WD.isHiddenEntry('~WRL0001.tmp'));
ok('isHiddenEntry: LibreOffice lock', WD.isHiddenEntry('.~lock.Aff.docx#'));
ok('isHiddenEntry: our own temp', WD.isHiddenEntry('.Aff.docx.ab12cd34.viper-tmp'));
ok('isHiddenEntry: Explorer clutter', WD.isHiddenEntry('Thumbs.db') && WD.isHiddenEntry('desktop.ini'));
ok('isHiddenEntry: a real document is not hidden', !WD.isHiddenEntry('Running Affidavit.docx'));

const taken = new Set(['aff.docx', 'aff (2).docx']);
ok('nextFreeName: free name is unchanged', WD.nextFreeName('New.docx', (c) => taken.has(c.toLowerCase())) === 'New.docx');
ok('nextFreeName: skips taken names, case-insensitively',
    WD.nextFreeName('AFF.docx', (c) => taken.has(c.toLowerCase())) === 'AFF (3).docx');

const owners = WD.ownerFileCandidates('Running Affidavit.docx');
ok('ownerFileCandidates: whole-name owner file', owners.includes('~$Running Affidavit.docx'));
ok('ownerFileCandidates: Word long-name forms', owners.includes('~$unning Affidavit.docx') && owners.includes('~$nning Affidavit.docx'));
ok('ownerFileCandidates: LibreOffice lock', owners.includes('.~lock.Running Affidavit.docx#'));

ok('sessionDecision: copy gone → nothing', WD.sessionDecision({ lastHash: 'a', plainHash: null, caseHash: 'a' }) === 'nothing');
ok('sessionDecision: unchanged copy → clean', WD.sessionDecision({ lastHash: 'a', plainHash: 'a', caseHash: 'a' }) === 'clean');
ok('sessionDecision: copy equals case → clean', WD.sessionDecision({ lastHash: 'a', plainHash: 'b', caseHash: 'b' }) === 'clean');
ok('sessionDecision: only the copy changed → ingest', WD.sessionDecision({ lastHash: 'a', plainHash: 'b', caseHash: 'a' }) === 'ingest');
ok('sessionDecision: case copy missing → ingest', WD.sessionDecision({ lastHash: 'a', plainHash: 'b', caseHash: null }) === 'ingest');
ok('sessionDecision: BOTH changed → recover-beside (never overwrite)',
    WD.sessionDecision({ lastHash: 'a', plainHash: 'b', caseHash: 'c' }) === 'recover-beside');

/* ==================================================
 * 2. Adding, listing, naming — Field Security off
 * ================================================== */
console.log('\n[add / list / names — Field Security off]');
{
    const env = makeEnv();
    const m = env.mgr;
    ok('list of a case with no folder is empty', Array.isArray(m.list('26-0001')) && m.list('26-0001').length === 0);

    const a = m.addBuffer('26-0001', 'Running Affidavit.docx', Buffer.from('AFFIDAVIT v1'));
    ok('addBuffer writes into Warrants/Working', a.fileName === 'Running Affidavit.docx'
        && fs.readFileSync(env.caseFile('26-0001', a.fileName), 'utf8') === 'AFFIDAVIT v1');
    const b = m.addBuffer('26-0001', 'running affidavit.DOCX', Buffer.from('OTHER'));
    ok('addBuffer never overwrites — a second copy gets "(2)"', b.fileName === 'running affidavit (2).DOCX', b);
    ok('…and the first is untouched', fs.readFileSync(env.caseFile('26-0001', 'Running Affidavit.docx'), 'utf8') === 'AFFIDAVIT v1');
    ok('addBuffer refuses a non-Word file', throwsCode(() => m.addBuffer('26-0001', 'notes.pdf', Buffer.from('x')), 'BAD_NAME'));
    ok('addBuffer refuses a bad case number', throwsCode(() => m.addBuffer('..', 'a.docx', Buffer.from('x')), 'BAD_CASE')
        && throwsCode(() => m.addBuffer('a/b', 'a.docx', Buffer.from('x')), 'BAD_CASE')
        && throwsCode(() => m.addBuffer('  ', 'a.docx', Buffer.from('x')), 'BAD_CASE'));
    ok('addBuffer cleans a path out of the name', m.addBuffer('26-0001', '..\\..\\evil.docx', Buffer.from('x')).fileName === 'evil.docx'
        && fs.existsSync(env.caseFile('26-0001', 'evil.docx')));

    // Clutter Word and Windows leave beside documents.
    for (const junk of ['~$nning Affidavit.docx', '~WRL0001.tmp', 'Thumbs.db', 'scan.pdf', '.Aff.docx.1234.viper-tmp']) {
        fs.writeFileSync(path.join(env.dir('26-0001'), junk), 'junk');
    }
    fs.mkdirSync(path.join(env.dir('26-0001'), 'Sub.docx'));
    const names = m.list('26-0001').map((x) => x.fileName).sort();
    ok('list shows only Word documents', JSON.stringify(names) === JSON.stringify(['Running Affidavit.docx', 'evil.docx', 'running affidavit (2).DOCX'].sort()), names);
    const row = m.list('26-0001')[0];
    ok('list rows carry size, time and open state', typeof row.bytes === 'number' && /T/.test(row.modifiedAt) && row.open === false && row.error === null);

    const src = path.join(env.root, 'Desktop Draft.docx');
    fs.writeFileSync(src, 'FROM DESKTOP');
    const imp = m.importFile('26-0001', src);
    ok('importFile copies (the original stays where it was)', imp.fileName === 'Desktop Draft.docx' && fs.existsSync(src)
        && fs.readFileSync(env.caseFile('26-0001', 'Desktop Draft.docx'), 'utf8') === 'FROM DESKTOP');
    const pdf = path.join(env.root, 'x.pdf'); fs.writeFileSync(pdf, 'x');
    ok('importFile refuses a non-Word file', throwsCode(() => m.importFile('26-0001', pdf), 'BAD_NAME'));

    const nf = m.newFrom('26-0001', 'Running Affidavit.docx', 'SW Google – jdoe');
    ok('newFrom copies the running affidavit under the new name', nf.fileName === 'SW Google – jdoe.docx'
        && fs.readFileSync(env.caseFile('26-0001', nf.fileName), 'utf8') === 'AFFIDAVIT v1', nf);
    const nf2 = m.newFrom('26-0001', 'Running Affidavit.docx', 'SW Google – jdoe.rtf');
    ok('newFrom keeps the SOURCE format, and never overwrites', nf2.fileName === 'SW Google – jdoe (2).docx', nf2);
    ok('newFrom with no name gives "Copy of …"', m.newFrom('26-0001', 'Running Affidavit.docx', '').fileName === 'Copy of Running Affidavit.docx');
    ok('newFrom of a missing source → NOT_FOUND', throwsCode(() => m.newFrom('26-0001', 'Gone.docx', 'x'), 'NOT_FOUND'));

    ok('rename keeps the extension', m.rename('26-0001', 'evil.docx', 'Arrest Warrant.doc').fileName === 'Arrest Warrant.docx'
        && fs.existsSync(env.caseFile('26-0001', 'Arrest Warrant.docx')) && !fs.existsSync(env.caseFile('26-0001', 'evil.docx')));
    ok('rename onto an existing name → EXISTS', throwsCode(() => m.rename('26-0001', 'Arrest Warrant.docx', 'RUNNING AFFIDAVIT'), 'EXISTS'));
    ok('…and nothing was overwritten', fs.readFileSync(env.caseFile('26-0001', 'Running Affidavit.docx'), 'utf8') === 'AFFIDAVIT v1');
    ok('rename case-only change is allowed', m.rename('26-0001', 'Arrest Warrant.docx', 'ARREST warrant').fileName === 'ARREST warrant.docx');
    ok('rename to nothing → BAD_NAME', throwsCode(() => m.rename('26-0001', 'ARREST warrant.docx', ' ?? '), 'BAD_NAME'));
    ok('rename refuses a traversal name', throwsCode(() => m.rename('26-0001', '..\\Running Affidavit.docx', 'x'), 'BAD_NAME'));
    ok('rename refuses a hidden owner file', throwsCode(() => m.rename('26-0001', '~$nning Affidavit.docx', 'x'), 'BAD_NAME'));

    const rm = await m.remove('26-0001', 'ARREST warrant.docx');
    ok('remove sends to the Recycle Bin', rm.removed === true && env.trashed.length === 1
        && /ARREST warrant\.docx$/.test(env.trashed[0]));
    ok('remove of a missing file is a no-op', (await m.remove('26-0001', 'ARREST warrant.docx')).removed === false);
}

/* ==================================================
 * 3. Opening — Field Security off (Word edits the case file itself)
 * ================================================== */
console.log('\n[open — Field Security off]');
{
    const env = makeEnv();
    const m = env.mgr;
    m.addBuffer('26-0002', 'Aff.docx', Buffer.from('v1'));
    const full = env.caseFile('26-0002', 'Aff.docx');
    const r = await m.open('26-0002', 'Aff.docx');
    ok('opens the case file itself (direct mode)', r.mode === 'direct' && r.alreadyOpen === false && env.opened[0] === full, r);
    ok('no decrypted copy is made', sessionDirs(env).length === 0);
    ok('"opened" event', env.eventsOf('opened').length === 1 && env.eventsOf('opened')[0].mode === 'direct');
    ok('list shows it open', m.list('26-0002')[0].open === true);

    const r2 = await m.open('26-0002', 'Aff.docx');
    ok('opening again re-opens the same file', r2.alreadyOpen === true && env.opened[1] === full);

    // Word opens it: owner file appears.
    const owner = path.join(env.dir('26-0002'), '~$Aff.docx');
    fs.writeFileSync(owner, 'owner');
    m.tick();
    wordSave(full, 'v2 typed in Word');
    m.tick();
    ok('a save is not reported until it has held still for a poll', env.eventsOf('saved').length === 0);
    m.tick();
    const sv = env.eventsOf('saved');
    ok('then "saved" is reported with the time', sv.length === 1 && /T/.test(sv[0].savedAt) && sv[0].bytes === 16, sv);
    ok('list shows the saved time', !!m.list('26-0002')[0].lastSavedAt);

    ok('rename refused while open', throwsCode(() => m.rename('26-0002', 'Aff.docx', 'B'), 'OPEN'));
    ok('remove refused while open', await rejectsCode(m.remove('26-0002', 'Aff.docx'), 'OPEN'));

    fs.unlinkSync(owner);          // Word closed
    m.tick();
    ok('Word closing ends the watch', env.mgr._sessions.size === 0 && env.eventsOf('closed').length === 1);
    ok('…and the case file is NOT deleted (it is the document)', fs.readFileSync(full, 'utf8') === 'v2 typed in Word');

    // An editor that never shows it is holding the file is not guessed at.
    await m.open('26-0002', 'Aff.docx');
    m.tick(); m.tick(); m.tick();
    ok('a session never seen held stays watched', env.mgr._sessions.size === 1);
    const ci = m.checkInAll({ final: true });
    ok('quit ends a direct session', env.mgr._sessions.size === 0 && ci.failed.length === 0);

    // An encrypted file left from when Field Security was on.
    const env2 = makeEnv({ security: fakeSecurity({ enabled: true }) });
    env2.mgr.addBuffer('26-0003', 'Enc.docx', Buffer.from('secret'));
    env2.security.enabled = false;
    ok('direct-opening an encrypted file is refused, not shown as garbage',
        await rejectsCode(env2.mgr.open('26-0003', 'Enc.docx'), 'LOCKED'));
    ok('…and nothing was handed to Word', env2.opened.length === 0);

    // No Word installed.
    const env3 = makeEnv();
    env3.mgr.addBuffer('26-0004', 'A.docx', Buffer.from('x'));
    env3.openResult = 'No application is associated with the specified file';
    ok('no program to open it → NO_APP', await rejectsCode(env3.mgr.open('26-0004', 'A.docx'), 'NO_APP'));
    ok('…and no session is left behind', env3.mgr._sessions.size === 0);
    ok('open refuses a traversal name', await rejectsCode(env3.mgr.open('26-0004', '..\\..\\x.docx'), 'BAD_NAME'));
    ok('open of a missing file → NOT_FOUND', await rejectsCode(env3.mgr.open('26-0004', 'Nope.docx'), 'NOT_FOUND'));
}

/* ==================================================
 * 4. Opening — Field Security on (Word edits a decrypted copy)
 * ================================================== */
console.log('\n[open — Field Security on]');
{
    const env = makeEnv({ security: fakeSecurity() });
    const m = env.mgr;
    m.addBuffer('26-0010', 'Aff.docx', Buffer.from('ORIGINAL TEXT'));
    const full = env.caseFile('26-0010', 'Aff.docx');
    ok('the case copy is encrypted on disk', env.security.isEncryptedBuffer(fs.readFileSync(full))
        && !fs.readFileSync(full).includes(Buffer.from('ORIGINAL')));

    const r = await m.open('26-0010', 'Aff.docx');
    const s = sessionOf(env, '26-0010', 'Aff.docx');
    ok('opens a decrypted working copy (session mode)', r.mode === 'session' && !!s);
    ok('the copy lives in a private 16-hex folder outside the case',
        /^[0-9a-f]{16}$/.test(path.basename(path.dirname(env.opened[0])))
        && path.dirname(path.dirname(env.opened[0])) === env.sessionsRoot
        && !env.opened[0].startsWith(env.casesDir));
    ok('Word gets plaintext', fs.readFileSync(env.opened[0], 'utf8') === 'ORIGINAL TEXT');
    const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(env.opened[0]), 'session.json'), 'utf8'));
    ok('a session record is written for crash recovery', meta.caseNumber === '26-0010' && meta.fileName === 'Aff.docx'
        && meta.lastHash === crypto.createHash('sha256').update('ORIGINAL TEXT').digest('hex'));
    ok('list in session mode shows it open', m.list('26-0010')[0].open === true);

    const plainPath = s.plainPath;
    env.locked.add(plainPath);      // Word has it
    m.tick();
    ok('seen held', s.seenHeld === true);

    // A save written in two bursts must not be caught half-way.
    wordSave(plainPath, 'HALF');
    m.tick();
    wordSave(plainPath, 'HALF WRITTEN THEN FINISHED');
    m.tick();
    ok('a file still changing is not taken in', env.readCase('26-0010', 'Aff.docx').toString() === 'ORIGINAL TEXT');
    m.tick();
    ok('once it holds still, the save goes into the case', env.readCase('26-0010', 'Aff.docx').toString() === 'HALF WRITTEN THEN FINISHED');
    ok('…still encrypted', env.security.isEncryptedBuffer(fs.readFileSync(full)));
    ok('…and "saved" is reported once', env.eventsOf('saved').length === 1);
    ok('no temp files are left in the case folder', fs.readdirSync(env.dir('26-0010')).length === 1, fs.readdirSync(env.dir('26-0010')));
    const meta2 = JSON.parse(fs.readFileSync(path.join(s.dir, 'session.json'), 'utf8'));
    ok('the session record tracks what is in the case', meta2.lastHash === crypto.createHash('sha256').update('HALF WRITTEN THEN FINISHED').digest('hex'));

    m.tick(); m.tick();
    ok('an unchanged file is not re-saved', env.eventsOf('saved').length === 1);

    // newFrom on an OPEN source takes its latest save first.
    wordSave(plainPath, 'NEWEST PARAGRAPH');
    const nf = m.newFrom('26-0010', 'Aff.docx', 'SW Meta');
    ok('newFrom on an open document copies its latest save', env.readCase('26-0010', nf.fileName).toString() === 'NEWEST PARAGRAPH');
    ok('…and that save went into the source too', env.readCase('26-0010', 'Aff.docx').toString() === 'NEWEST PARAGRAPH');

    // Word closes.
    env.locked.delete(plainPath);
    m.tick();
    ok('Word closing deletes the decrypted copy', !fs.existsSync(plainPath));
    ok('…and its private folder', sessionDirs(env).length === 0);
    ok('…and the case keeps the work', env.readCase('26-0010', 'Aff.docx').toString() === 'NEWEST PARAGRAPH');
    ok('"closed" is reported', env.eventsOf('closed').length === 1);

    // A save made in the same instant Word closes is still taken.
    await m.open('26-0010', 'Aff.docx');
    const s2 = sessionOf(env, '26-0010', 'Aff.docx');
    env.locked.add(s2.plainPath); m.tick();
    wordSave(s2.plainPath, 'LAST WORDS');
    env.locked.delete(s2.plainPath);
    m.tick(); m.tick(); m.tick();
    ok('a final save at close is not lost', env.readCase('26-0010', 'Aff.docx').toString() === 'LAST WORDS');
    ok('…and the copy is cleaned up', env.mgr._sessions.size === 0 && sessionDirs(env).length === 0);

    // No Word: the decrypted copy must not linger.
    env.openResult = 'No application is associated with the specified file';
    ok('session-mode NO_APP is reported', await rejectsCode(m.open('26-0010', 'Aff.docx'), 'NO_APP'));
    ok('…and the decrypted copy is deleted at once', sessionDirs(env).length === 0 && env.mgr._sessions.size === 0);
    env.openResult = '';

    // Locked vault: cannot open.
    env.security.lock();
    ok('opening while locked → LOCKED', await rejectsCode(m.open('26-0010', 'Aff.docx'), 'LOCKED'));
    ok('…and no plaintext was written', sessionDirs(env).length === 0);
    env.security.unlock();
}

/* ==================================================
 * 5. Lock / quit with Word still open
 * ================================================== */
console.log('\n[lock and quit]');
{
    const env = makeEnv({ security: fakeSecurity() });
    const m = env.mgr;
    m.addBuffer('26-0020', 'Aff.docx', Buffer.from('v1'));
    await m.open('26-0020', 'Aff.docx');
    const s = sessionOf(env, '26-0020', 'Aff.docx');
    env.locked.add(s.plainPath); m.tick();

    wordSave(s.plainPath, 'saved seconds before the lock');
    // No tick yet — the poll has not seen it. Locking must still take it in.
    const ci = m.checkInAll({ final: true });
    ok('check-in before lock takes an un-polled save', ci.saved.includes('Aff.docx')
        && env.readCase('26-0020', 'Aff.docx').toString() === 'saved seconds before the lock', ci);
    ok('a document Word still holds is reported as still open', ci.stillOpen.includes('Aff.docx'));
    ok('…and its session is kept (not deleted out from under Word)', fs.existsSync(s.plainPath) && env.mgr._sessions.size === 1);
    env.security.lock();

    const before = fs.readFileSync(env.caseFile('26-0020', 'Aff.docx'));
    wordSave(s.plainPath, 'typed after the lock');
    m.tick(); m.tick();
    const errs = env.eventsOf('error');
    ok('a save while locked is reported plainly, not as saved', errs.length === 1 && errs[0].code === 'LOCKED'
        && /unlock/i.test(errs[0].message), errs);
    ok('…and the case copy is untouched', fs.readFileSync(env.caseFile('26-0020', 'Aff.docx')).equals(before));
    m.tick(); m.tick();
    ok('the same error is not repeated every poll', env.eventsOf('error').length === 1);
    ok('list carries the error', /unlock/i.test(m.list('26-0020')[0].error || ''));

    env.locked.delete(s.plainPath);    // Word closed while locked
    m.tick();
    ok('Word closing while locked does NOT delete the unsaved copy', fs.existsSync(s.plainPath) && env.mgr._sessions.size === 1);

    env.security.unlock();
    m.tick(); m.tick();
    ok('after unlock the waiting save goes into the case', env.readCase('26-0020', 'Aff.docx').toString() === 'typed after the lock');
    ok('…and then the copy is cleaned up', !fs.existsSync(s.plainPath) && env.mgr._sessions.size === 0);
    ok('…and the error is cleared', m.list('26-0020')[0].error === null);

    // Non-final check-in leaves sessions alone.
    await m.open('26-0020', 'Aff.docx');
    const ci2 = m.checkInAll({ final: false });
    ok('a non-final check-in keeps the session', env.mgr._sessions.size === 1 && ci2.stillOpen.length === 0);
    const ci3 = m.checkInAll({ final: true });
    ok('a final check-in of a released copy cleans it up', env.mgr._sessions.size === 0 && sessionDirs(env).length === 0 && ci3.failed.length === 0);

    // Final check-in while locked keeps the copy for the next unlock.
    await m.open('26-0020', 'Aff.docx');
    const s3 = sessionOf(env, '26-0020', 'Aff.docx');
    wordSave(s3.plainPath, 'unsaved at quit');
    env.security.lock();
    const ci4 = m.checkInAll({ final: true });
    ok('a final check-in that cannot encrypt reports a failure', ci4.failed.length === 1 && ci4.failed[0].fileName === 'Aff.docx');
    ok('…and keeps the copy for recovery', fs.existsSync(s3.plainPath));
    env.security.unlock();
}

/* ==================================================
 * 6. Recovery after a crash / quit / restart
 * ================================================== */
console.log('\n[recovery]');
{
    // (a) a save the case never got
    const envA = makeEnv({ security: fakeSecurity() });
    envA.mgr.addBuffer('26-0030', 'Aff.docx', Buffer.from('before crash'));
    await envA.mgr.open('26-0030', 'Aff.docx');
    const sA = sessionOf(envA, '26-0030', 'Aff.docx');
    wordSave(sA.plainPath, 'typed, saved, then VIPER crashed');
    // VIPER restarts: a fresh manager over the same folders.
    const envA2 = makeEnv({ root: envA.root, security: envA.security });
    const recA = envA2.mgr.recover();
    ok('recover: a missed save is brought in', recA.length === 1 && recA[0].action === 'ingest'
        && envA2.readCase('26-0030', 'Aff.docx').toString() === 'typed, saved, then VIPER crashed', recA);
    ok('recover: the copy is then deleted', sessionDirs(envA2).length === 0);
    ok('recover: "recovered" event', envA2.eventsOf('recovered').length === 1);

    // (b) both changed — never overwrite either
    const envB = makeEnv({ security: fakeSecurity() });
    envB.mgr.addBuffer('26-0031', 'Aff.docx', Buffer.from('base'));
    await envB.mgr.open('26-0031', 'Aff.docx');
    const sB = sessionOf(envB, '26-0031', 'Aff.docx');
    wordSave(sB.plainPath, 'edits in the stranded copy');
    fs.writeFileSync(envB.caseFile('26-0031', 'Aff.docx'), envB.security.encryptBuffer(Buffer.from('edits made another way')));
    const envB2 = makeEnv({ root: envB.root, security: envB.security });
    const recB = envB2.mgr.recover();
    ok('recover: both changed → kept beside as "(recovered)"', recB.length === 1 && recB[0].action === 'recover-beside'
        && recB[0].recoveredAs === 'Aff (recovered).docx', recB);
    ok('…the case copy is untouched', envB2.readCase('26-0031', 'Aff.docx').toString() === 'edits made another way');
    ok('…the recovered copy holds the stranded edits', envB2.readCase('26-0031', 'Aff (recovered).docx').toString() === 'edits in the stranded copy');

    // (c) nothing to bring in
    const envC = makeEnv({ security: fakeSecurity() });
    envC.mgr.addBuffer('26-0032', 'Aff.docx', Buffer.from('same'));
    await envC.mgr.open('26-0032', 'Aff.docx');
    const envC2 = makeEnv({ root: envC.root, security: envC.security });
    const recC = envC2.mgr.recover();
    ok('recover: an untouched copy is just cleaned up', recC.length === 1 && recC[0].action === 'clean' && sessionDirs(envC2).length === 0);
    ok('…and the case copy is unchanged', envC2.readCase('26-0032', 'Aff.docx').toString() === 'same');

    // (d) still locked at startup — wait for the key
    const envD = makeEnv({ security: fakeSecurity() });
    envD.mgr.addBuffer('26-0033', 'Aff.docx', Buffer.from('x'));
    await envD.mgr.open('26-0033', 'Aff.docx');
    const sD = sessionOf(envD, '26-0033', 'Aff.docx');
    wordSave(sD.plainPath, 'needs the key');
    envD.security.lock();
    const envD2 = makeEnv({ root: envD.root, security: envD.security });
    const recD = envD2.mgr.recover();
    ok('recover while locked waits — the copy is kept', recD[0].action === 'waiting-for-unlock' && fs.existsSync(sD.plainPath), recD);
    envD.security.unlock();
    const recD2 = envD2.mgr.recover();
    ok('…and is brought in after unlock', recD2[0].action === 'ingest' && envD2.readCase('26-0033', 'Aff.docx').toString() === 'needs the key');

    // (e) Word still has it open when VIPER restarts
    const envE = makeEnv({ security: fakeSecurity() });
    envE.mgr.addBuffer('26-0034', 'Aff.docx', Buffer.from('x'));
    await envE.mgr.open('26-0034', 'Aff.docx');
    const sE = sessionOf(envE, '26-0034', 'Aff.docx');
    wordSave(sE.plainPath, 'saved before restart');
    const envE2 = makeEnv({ root: envE.root, security: envE.security });
    envE2.locked.add(sE.plainPath);
    const recE = envE2.mgr.recover();
    ok('recover with Word still open: save taken AND watching resumes', recE[0].action === 'ingest'
        && envE2.mgr._sessions.size === 1 && fs.existsSync(sE.plainPath));
    wordSave(sE.plainPath, 'saved after restart');
    envE2.mgr.tick(); envE2.mgr.tick();
    ok('…later saves still reach the case', envE2.readCase('26-0034', 'Aff.docx').toString() === 'saved after restart');
    envE2.locked.delete(sE.plainPath);
    envE2.mgr.tick();
    ok('…and it cleans up when Word lets go', sessionDirs(envE2).length === 0);

    // (f) folders that are not ours, or cannot be read, are never deleted
    const envF = makeEnv({ security: fakeSecurity() });
    fs.mkdirSync(path.join(envF.sessionsRoot, 'not-a-session'), { recursive: true });
    fs.writeFileSync(path.join(envF.sessionsRoot, 'not-a-session', 'keep.docx'), 'keep');
    fs.mkdirSync(path.join(envF.sessionsRoot, '0123456789abcdef'), { recursive: true });
    fs.writeFileSync(path.join(envF.sessionsRoot, '0123456789abcdef', 'session.json'), '{ not json');
    fs.mkdirSync(path.join(envF.sessionsRoot, 'fedcba9876543210'), { recursive: true });
    fs.writeFileSync(path.join(envF.sessionsRoot, 'fedcba9876543210', 'session.json'),
        JSON.stringify({ v: 1, caseNumber: '..', fileName: 'x.docx', plainName: 'x.docx', lastHash: null }));
    const recF = envF.mgr.recover();
    ok('a folder that is not ours is ignored', fs.existsSync(path.join(envF.sessionsRoot, 'not-a-session', 'keep.docx')));
    ok('an unreadable session is kept, not deleted', recF.some((x) => x.id === '0123456789abcdef' && x.action === 'unreadable')
        && fs.existsSync(path.join(envF.sessionsRoot, '0123456789abcdef')));
    ok('a session naming an unsafe case is kept, not acted on', recF.some((x) => x.id === 'fedcba9876543210' && x.action === 'unreadable')
        && !fs.existsSync(path.join(envF.casesDir, '..', 'Warrants')));

    // (g) a copy whose plaintext is already gone
    const envG = makeEnv({ security: fakeSecurity() });
    envG.mgr.addBuffer('26-0035', 'Aff.docx', Buffer.from('x'));
    await envG.mgr.open('26-0035', 'Aff.docx');
    fs.unlinkSync(sessionOf(envG, '26-0035', 'Aff.docx').plainPath);
    const envG2 = makeEnv({ root: envG.root, security: envG.security });
    const recG = envG2.mgr.recover();
    ok('recover: an emptied session folder is tidied away', recG[0].action === 'nothing' && sessionDirs(envG2).length === 0);

    // (h) recover() does not touch sessions this run is already watching
    const envH = makeEnv({ security: fakeSecurity() });
    envH.mgr.addBuffer('26-0036', 'Aff.docx', Buffer.from('x'));
    await envH.mgr.open('26-0036', 'Aff.docx');
    const recH = envH.mgr.recover();
    ok('recover skips a live session', recH.length === 0 && envH.mgr._sessions.size === 1 && sessionDirs(envH).length === 1);
}

/* ==================================================
 * 7. Field Security turned on with documents already in the case
 * ================================================== */
console.log('\n[mixed plaintext / encrypted]');
{
    const env = makeEnv({ security: fakeSecurity({ enabled: false }) });
    env.mgr.addBuffer('26-0040', 'Old.docx', Buffer.from('written before Field Security'));
    ok('written plain while Field Security was off', fs.readFileSync(env.caseFile('26-0040', 'Old.docx'), 'utf8') === 'written before Field Security');
    env.security.enabled = true;
    await env.mgr.open('26-0040', 'Old.docx');
    const s = sessionOf(env, '26-0040', 'Old.docx');
    ok('a plain file opens fine once Field Security is on', fs.readFileSync(s.plainPath, 'utf8') === 'written before Field Security');
    env.locked.add(s.plainPath); env.mgr.tick();
    wordSave(s.plainPath, 'edited after');
    env.mgr.tick(); env.mgr.tick();
    ok('…and its next save goes in encrypted', env.security.isEncryptedBuffer(fs.readFileSync(env.caseFile('26-0040', 'Old.docx')))
        && env.readCase('26-0040', 'Old.docx').toString() === 'edited after');
    env.locked.delete(s.plainPath); env.mgr.tick();
}

console.log('\n' + pass + ' passed · ' + fail + ' failed');
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

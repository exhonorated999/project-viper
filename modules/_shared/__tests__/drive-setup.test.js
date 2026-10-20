/*
 * drive-setup.test.js
 *
 * The installer-driven update of a VIPER folder on an external drive
 * (modules/_shared/drive-setup.js + build/installer.nsh preInit).
 *
 * Why: drive copies on 5.4.1 and older hand their update to Setup.exe, which
 * installs on C: (or fails for want of admin rights) and leaves the drive
 * copy old. From 5.4.3 Setup.exe recognises a drive copy, unpacks the new
 * program to %TEMP%\viper-drive-setup\app and starts it with
 * --viper-drive-setup; this module then swaps the drive copy in place.
 * The user's constraint: desktop users must not be affected.
 *
 * What is pinned here:
 *   - only a real drive copy (program + archive + userdata/cases/.portable)
 *     is ever a target; never a drive root, a link, or the setup folder;
 *   - nothing in userdata\, cases\, .portable or any file the update does not
 *     carry is touched — byte-for-byte — on success AND on every refusal;
 *   - a damaged copy or a failed swap leaves the drive exactly as it was;
 *   - the result is the same one the 5.4.2 in-app updater writes, so the new
 *     version recognises it as 'applied' and tidies up;
 *   - the temp setup folder is only removed when it is provably ours;
 *   - the wiring in electron-main.js and the installer script.
 *
 * Run: set ELECTRON_RUN_AS_NODE=1&& node_modules\.bin\electron.cmd modules\_shared\__tests__\drive-setup.test.js
 */
'use strict';

process.noAsar = true;

const path = require('path');
const os = require('os');
const crypto = require('crypto');
let FS;
try { FS = require('original-fs'); } catch (_) { FS = require('fs'); }

const REPO = path.join(__dirname, '..', '..', '..');
const PU = require(path.join(REPO, 'modules', '_shared', 'portable-update.js'));
const DS = require(path.join(REPO, 'modules', '_shared', 'drive-setup.js'));
const asar = require(path.join(REPO, 'node_modules', '@electron', 'asar'));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
    if (cond) { passed++; return; }
    failed++;
    console.log('  FAIL ' + label + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''));
}
function section(name) { console.log('\n== ' + name + ' =='); }

const EXE = 'V.I.P.E.R.exe';
const TMP = FS.mkdtempSync(path.join(os.tmpdir(), 'vds-test-'));
let tmpN = 0;
const tmpDir = (tag) => { const d = path.join(TMP, (tag || 'd') + '-' + (++tmpN)); FS.mkdirSync(d, { recursive: true }); return d; };
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
function write(p, data) { FS.mkdirSync(path.dirname(p), { recursive: true }); FS.writeFileSync(p, data); }

function hashTree(dir, skip) {
    const out = {};
    (function walk(d, rel) {
        for (const n of FS.readdirSync(d)) {
            if (!rel && skip && skip.indexOf(n) !== -1) continue;
            const p = path.join(d, n), r = rel ? rel + '/' + n : n;
            const st = FS.lstatSync(p);
            if (st.isDirectory()) { out[r + '/'] = 'dir'; walk(p, r); }
            else out[r] = sha256(FS.readFileSync(p));
        }
    })(dir, '');
    return out;
}
const sameTree = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function pick(tree, prefixes) {
    const o = {};
    for (const k of Object.keys(tree)) if (prefixes.some(p => k === p || k === p + '/' || k.indexOf(p + '/') === 0)) o[k] = tree[k];
    return o;
}

// A real asar archive written synchronously. (@electron/asar's createPackage
// resolves while its write stream is still open; under Electron that open
// handle makes later deletes of the fixture fail with EPERM/ENOTEMPTY.)
// Format: [4][headerPickleSize][payloadSize][jsonLen][json, 4-aligned][file data].
async function makeAsar(dest, version, extra) {
    const files = [
        ['package.json', Buffer.from(JSON.stringify({ name: 'viper', version, main: 'electron-main.js' }))],
        ['electron-main.js', Buffer.from('// ' + (extra || 'main') + '\n' + 'x'.repeat(2048))],
    ];
    const header = { files: {} };
    let off = 0;
    for (const [name, buf] of files) { header.files[name] = { size: buf.length, offset: String(off) }; off += buf.length; }
    const json = Buffer.from(JSON.stringify(header), 'utf8');
    const padded = (json.length + 3) & ~3;
    const head = Buffer.alloc(16 + padded);
    head.writeUInt32LE(4, 0);
    head.writeUInt32LE(8 + padded, 4);
    head.writeUInt32LE(4 + padded, 8);
    head.writeUInt32LE(json.length, 12);
    json.copy(head, 16);
    FS.mkdirSync(path.dirname(dest), { recursive: true });
    FS.writeFileSync(dest, Buffer.concat([head].concat(files.map(f => f[1]))));
}

async function makeUnpacked(dir, version, tag) {
    write(path.join(dir, EXE), 'EXE ' + version + ' ' + (tag || '') + crypto.randomBytes(64).toString('hex'));
    write(path.join(dir, 'ffmpeg.dll'), 'ffmpeg ' + version);
    write(path.join(dir, 'resources.pak'), crypto.randomBytes(4096));
    write(path.join(dir, 'locales', 'en-US.pak'), 'en ' + version);
    write(path.join(dir, 'locales', 'de.pak'), 'de ' + version);
    write(path.join(dir, 'resources', 'app-update.yml'), 'owner: exhonorated999\n');
    write(path.join(dir, 'resources', 'app.asar.unpacked', 'build', 'icon.ico'), 'ico ' + version);
    await makeAsar(path.join(dir, 'resources', 'app.asar'), version, tag);
    return dir;
}

/** An officer's drive folder: the old program plus everything that must survive. */
async function makeOfficerFolder(version, opts) {
    const dir = tmpDir('officer');
    await makeUnpacked(dir, version, 'old');
    write(path.join(dir, 'Uninstall V.I.P.E.R.exe'), 'uninstaller');
    write(path.join(dir, 'old-only.dll'), 'a file the new version no longer ships');
    if (!opts || opts.portable !== false) write(path.join(dir, '.portable'), '');
    if (!opts || opts.userdata !== false) {
        write(path.join(dir, 'userdata', 'Local Storage', 'leveldb', 'CURRENT'), 'MANIFEST-000001');
        write(path.join(dir, 'userdata', 'install.json'), '{"installedAt":"2026-01-01"}');
    }
    if (!opts || opts.cases !== false) {
        write(path.join(dir, 'cases', '26-0001', 'Evidence', 'photo.jpg'), crypto.randomBytes(8192));
        write(path.join(dir, 'cases', '26-0001', '.case-snapshot.json'), '{"x":1}');
    }
    write(path.join(dir, 'My notes.txt'), 'the officer put this here');
    return dir;
}

/** What the installer leaves in %TEMP%: <root>\viper-drive-setup\{app\, viper-setup.json}. */
async function makeSetup(version, opts) {
    const root = tmpDir('temp');
    const setupDir = path.join(root, DS.SETUP_DIR_NAME);
    const appDir = path.join(setupDir, DS.APP_DIR_NAME);
    await makeUnpacked(appDir, version, 'new');
    if (!opts || opts.marker !== false) write(path.join(setupDir, DS.SETUP_MARKER), JSON.stringify({ kind: (opts && opts.kind) || DS.SETUP_KIND, version }));
    return { root, setupDir, appDir };
}

const KEEP = ['userdata', 'cases', '.portable', 'My notes.txt', 'Uninstall V.I.P.E.R.exe', 'old-only.dll'];
const fast = { sleep: () => new Promise(r => setTimeout(r, 1)), renameTries: 2, renameDelayMs: 5, waitPidMs: 200, waitFreeMs: 200 };

function opts(setup, target, extra) {
    return Object.assign({ fs: FS, appDir: setup.appDir, setupDir: setup.setupDir, exeName: EXE, target, selfVersion: '5.4.3' }, fast, extra || {});
}

(async () => {
    // ─────────────────────────────────────────────────────────────────
    section('fixture sanity');
    {
        const a = path.join(tmpDir('fx'), 'app.asar');
        await makeAsar(a, '5.3.6', 'probe');
        let pkg = null, list = [];
        try { list = asar.listPackage(a).map(s => s.replace(/^[\\/]/, '')); pkg = JSON.parse(asar.extractFile(a, 'package.json').toString('utf8')); } catch (_) {}
        ok('the fixture archive is read by the official asar library', pkg && pkg.version === '5.3.6' && list.indexOf('electron-main.js') !== -1, list);
        ok('… and by the updater', PU.readAsarVersion(FS, a) === '5.3.6');
    }

    // ─────────────────────────────────────────────────────────────────
    section('arguments and layout');
    const pa = DS.parseArgs(['x.exe', DS.FLAG, '--target=F:\\VIPER\\V.I.P.E.R', '--wait-pid=4321']);
    ok('target and pid are read', pa.target === 'F:\\VIPER\\V.I.P.E.R' && pa.waitPid === 4321, pa);
    ok('a target with spaces survives', DS.parseArgs(['--target=F:\\My Drive\\V.I.P.E.R']).target === 'F:\\My Drive\\V.I.P.E.R');
    ok('stray quotes are stripped', DS.parseArgs(['--target="F:\\V"']).target === 'F:\\V');
    ok('a missing or zero pid means "do not wait"', DS.parseArgs([]).waitPid === 0 && DS.parseArgs(['--wait-pid=0']).waitPid === 0 && DS.parseArgs(['--wait-pid=x']).waitPid === 0);
    ok('the flag is the installer contract', DS.FLAG === '--viper-drive-setup' && DS.SETUP_DIR_NAME === 'viper-drive-setup'
        && DS.SETUP_MARKER === 'viper-setup.json' && DS.SETUP_KIND === 'viper-drive-setup' && DS.APP_DIR_NAME === 'app');
    ok('drive roots are recognised', DS.isDriveRoot('F:\\') && DS.isDriveRoot('C:\\') && !DS.isDriveRoot('F:\\VIPER'));

    const S0 = await makeSetup('5.4.3');
    ok('the unpacked installer copy is a valid layout', DS.setupLayout(FS, path.join(S0.appDir, EXE)).ok === true);
    ok('… not when the exe is elsewhere', DS.setupLayout(FS, path.join(S0.setupDir, EXE)).ok === false
        && DS.setupLayout(FS, path.join(tmpDir('x'), 'app', EXE)).ok === false);
    const Snm = await makeSetup('5.4.3', { marker: false });
    ok('… not without the installer marker', DS.setupLayout(FS, path.join(Snm.appDir, EXE)).error === 'no-marker');
    const Sbk = await makeSetup('5.4.3', { kind: 'something-else' });
    ok('… not with a foreign marker', DS.setupLayout(FS, path.join(Sbk.appDir, EXE)).ok === false);
    ok('… nor from a normal install folder', DS.setupLayout(FS, 'C:\\Users\\x\\AppData\\Local\\Programs\\V.I.P.E.R\\' + EXE).ok === false);

    // ─────────────────────────────────────────────────────────────────
    section('what counts as a drive copy');
    const good = await makeOfficerFolder('5.3.6');
    ok('an officer folder is a valid target', DS.targetIsValid(FS, good, EXE, S0.setupDir).ok === true);
    for (const [label, o] of [['only userdata', { portable: false, cases: false }], ['only cases', { portable: false, userdata: false }], ['only .portable', { userdata: false, cases: false }]]) {
        const d = await makeOfficerFolder('5.3.6', o);
        ok('… with ' + label, DS.targetIsValid(FS, d, EXE).ok === true);
    }
    const bare = await makeOfficerFolder('5.3.6', { portable: false, userdata: false, cases: false });
    ok('a program folder with no data of its own is NOT (desktop-like)', DS.targetIsValid(FS, bare, EXE).ok === false);
    const noExe = await makeOfficerFolder('5.3.6'); FS.unlinkSync(path.join(noExe, EXE));
    ok('no exe → not a target', DS.targetIsValid(FS, noExe, EXE).ok === false);
    const noAsar = await makeOfficerFolder('5.3.6'); FS.unlinkSync(path.join(noAsar, 'resources', 'app.asar'));
    ok('no program archive → not a target', DS.targetIsValid(FS, noAsar, EXE).ok === false);
    {   // refused by the root guard itself, not by a later "no exe" check
        const r = DS.targetIsValid(FS, path.parse(good).root, EXE);
        ok('a drive root is never a target', r.ok === false && /whole drive/.test(r.error || ''));
    }
    ok('a relative path is never a target', DS.targetIsValid(FS, 'VIPER', EXE).ok === false);
    ok('a missing folder is not a target', DS.targetIsValid(FS, path.join(TMP, 'nope'), EXE).ok === false);
    ok('the setup folder itself is never a target', DS.targetIsValid(FS, S0.setupDir, EXE, S0.setupDir).ok === false
        && DS.targetIsValid(FS, S0.appDir, EXE, S0.setupDir).ok === false);
    const jn = path.join(tmpDir('jn'), 'link');
    let jnMade = false;
    try { FS.symlinkSync(good, jn, 'junction'); jnMade = true; } catch (_) {}
    if (jnMade) ok('a junction is never followed', DS.targetIsValid(FS, jn, EXE).ok === false);

    // ─────────────────────────────────────────────────────────────────
    section('the update itself');
    {
        const setup = await makeSetup('5.4.3');
        const target = await makeOfficerFolder('5.3.6');
        const before = hashTree(target);
        const newTree = hashTree(setup.appDir);
        const phases = [];
        const logs = [];
        const r = await DS.runDriveSetup(opts(setup, target, { onProgress: (p) => phases.push(p.phase), log: (s) => logs.push(s), freeBytes: () => 50 * 1024 * 1024 * 1024 }));
        ok('status applied', r.status === 'applied' && r.safe === true && r.from === '5.3.6' && r.to === '5.4.3', r);
        const after = hashTree(target, [PU.WORK_DIR_NAME]);
        ok('every program file is now the new version', sameTree(pick(after, Object.keys(newTree).map(k => k.replace(/\/$/, '')).filter(k => k.indexOf('/') === -1)),
            newTree), Object.keys(after).length);
        ok('the drive copy reports 5.4.3', PU.readAsarVersion(FS, path.join(target, 'resources', 'app.asar')) === '5.4.3');
        ok('userdata, cases, .portable, the officer\u2019s own files and the uninstaller are byte-identical',
            sameTree(pick(after, KEEP), pick(before, KEEP)) && Object.keys(pick(before, KEEP)).length >= 12, Object.keys(pick(before, KEEP)).length);
        const wd = path.join(target, PU.WORK_DIR_NAME);
        const res = PU.readJson(FS, path.join(wd, PU.RESULT_FILE));
        ok('result.json says ok, to 5.4.3, in the in-app updater\u2019s format', res && res.kind === PU.MARKER_KIND && res.ok === true && res.to === '5.4.3' && /^[a-z0-9]+$/.test(res.txId), res);
        const prev = FS.readdirSync(wd).filter(n => /^previous-/.test(n));
        ok('the old program is kept in previous-<tx>', prev.length === 1
            && /^EXE 5\.3\.6 old/.test(FS.readFileSync(path.join(wd, prev[0], EXE), 'utf8')));
        ok('… and the old asar with it', PU.readAsarVersion(FS, path.join(wd, prev[0], 'resources', 'app.asar')) === '5.3.6');
        const ins = PU.inspectWorkDir(FS, target, '5.4.3');
        ok('the new version on the drive sees the update as applied', ins.status === 'applied' && ins.to === '5.4.3', ins);
        const c = PU.cleanupWorkDir(FS, target);
        ok('… and its normal cleanup removes the work folder', c.removed === true && !FS.existsSync(wd), c);
        ok('after cleanup the data is still byte-identical', sameTree(pick(hashTree(target), KEEP), pick(before, KEEP)));
        ok('progress went wait → copy → verify → swap', ['waiting', 'copy', 'verify', 'swap'].every(p => phases.indexOf(p) !== -1)
            && phases.indexOf('waiting') < phases.indexOf('copy') && phases.lastIndexOf('copy') < phases.indexOf('verify') && phases.indexOf('verify') < phases.indexOf('swap'));
        ok('the installer\u2019s copy is left intact (it is still running)', sameTree(hashTree(setup.appDir), newTree));
        ok('a log was written', logs.some(s => /drive copy version 5\.3\.6/.test(s)));
    }

    section('nothing to do');
    for (const v of ['5.4.3', '5.5.0']) {
        const setup = await makeSetup('5.4.3');
        const target = await makeOfficerFolder(v);
        const before = hashTree(target);
        const r = await DS.runDriveSetup(opts(setup, target));
        ok('drive copy ' + v + ' → "current", untouched, no work folder', r.status === 'current' && r.safe && sameTree(hashTree(target), before) && !FS.existsSync(path.join(target, PU.WORK_DIR_NAME)), r);
    }

    section('an earlier update that did not finish cleanly is set aside, not a dead end (5.4.7)');
    {
        const stuckCases = [
            ['a foreign .viper-update folder', (t) => write(path.join(t, PU.WORK_DIR_NAME, 'mine.txt'), 'not ours'), 'mine.txt'],
            ['an interrupted earlier swap', (t) => {
                const wd = PU.ensureWorkDir(FS, t);
                write(path.join(wd, 'previous-abc', 'locales', 'x.pak'), 'old pak');
                PU.writeJsonDurable(FS, path.join(wd, PU.JOURNAL_FILE), { kind: PU.MARKER_KIND, txId: 'abc', state: 'swapping', steps: [] });
            }, 'previous-abc/locales/x.pak'],
            ['an unsafe earlier failure', (t) => {
                const wd = PU.ensureWorkDir(FS, t);
                PU.writeJsonDurable(FS, path.join(wd, PU.RESULT_FILE), { kind: PU.MARKER_KIND, txId: 'abc', to: '5.4.2', ok: false, rolledBack: false });
            }, PU.RESULT_FILE],
            // Winnemucca USB (2026-10-20): an old successful self-update record
            // for an OLDER version than the one on the drive.
            ['a stale "applied" record from an older version', (t) => {
                const wd = PU.ensureWorkDir(FS, t);
                write(path.join(wd, 'previous-old1', EXE), 'older exe');
                PU.writeJsonDurable(FS, path.join(wd, PU.RESULT_FILE), { kind: PU.MARKER_KIND, txId: 'old1', to: '5.3.0', ok: true });
            }, 'previous-old1/' + EXE],
        ];
        for (const [label, prep, keepRel] of stuckCases) {
            const setup = await makeSetup('5.4.3');
            const target = await makeOfficerFolder('5.3.6');
            prep(target);
            const before = hashTree(target);
            const logs = [];
            const r = await DS.runDriveSetup(opts(setup, target, { log: (s) => logs.push(s) }));
            ok(label + ': the drive copy is updated', r.status === 'applied' && r.safe === true && PU.readAsarVersion(FS, path.join(target, 'resources', 'app.asar')) === '5.4.3', r);
            const ret = FS.readdirSync(target).filter(n => /^\.viper-update-old-[a-z0-9]+$/.test(n));
            ok(label + ': the old folder was renamed aside with its contents intact', ret.length === 1
                && FS.existsSync(path.join(target, ret[0], ...keepRel.split('/'))), ret);
            ok(label + ': and logged', logs.some(s => /earlier update set aside/.test(s)));
            ok(label + ': userdata, cases, .portable, the officer\u2019s own files are byte-identical', sameTree(pick(hashTree(target), KEEP), pick(before, KEEP)));
            ok(label + ': the new version sees its own update as applied', PU.inspectWorkDir(FS, target, '5.4.3').status === 'applied');
        }
        // A refusal for another reason (no space) must not have moved anything.
        const setup = await makeSetup('5.4.3');
        const target = await makeOfficerFolder('5.3.6');
        stuckCases[1][1](target);
        const before = hashTree(target);
        const r = await DS.runDriveSetup(opts(setup, target, { freeBytes: () => 10 * 1024 * 1024 }));
        ok('a refusal before copying leaves the stuck folder exactly where it was', r.status === 'refused' && sameTree(hashTree(target), before)
            && !FS.readdirSync(target).some(n => /^\.viper-update-old-/.test(n)), r);
        // The work folder cannot be renamed → clear refusal, nothing changed.
        const t2 = await makeOfficerFolder('5.3.6');
        stuckCases[2][1](t2);
        const b2 = hashTree(t2);
        const lockFs = Object.create(FS);
        lockFs.renameSync = (a, b) => { if (/\.viper-update$/.test(a)) { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; } return FS.renameSync(a, b); };
        const r2 = await DS.runDriveSetup(opts(await makeSetup('5.4.3'), t2, { fs: lockFs, retireOpts: { tries: 2, delayMs: 5 } }));
        ok('a work folder that cannot be moved → refused with a plain reason, nothing changed', r2.status === 'refused' && /could not be moved out of the way \(EPERM\)/.test(r2.message)
            && sameTree(hashTree(t2), b2), r2);
    }

    section('refusals change nothing');
    async function refusal(label, mkTarget, extra, re, setupOpts) {
        const setup = await makeSetup('5.4.3', setupOpts);
        const target = await mkTarget();
        if (extra && extra.prep) extra.prep(target, setup);
        const before = hashTree(target);
        const o = opts(setup, target, extra);
        let r;
        try { r = await DS.runDriveSetup(o); } catch (e) { r = { status: 'threw', message: e.message }; }
        ok(label + ': refused safely', r.status === 'refused' && r.safe === true && (!re || re.test(r.message)), r);
        ok(label + ': drive copy byte-identical', sameTree(hashTree(target), before));
        return { r, target, setup };
    }
    await refusal('not a drive copy', () => makeOfficerFolder('5.3.6', { portable: false, userdata: false, cases: false }), null, /not a VIPER drive copy/);
    await refusal('VIPER never closes', () => makeOfficerFolder('5.3.6'), { waitPid: process.pid }, /did not close/);
    await refusal('the exe stays locked', () => makeOfficerFolder('5.3.6'), { isFileFree: () => false }, /still open/);
    await refusal('not enough space', () => makeOfficerFolder('5.3.6'), { freeBytes: () => 10 * 1024 * 1024 }, /not enough free space/);
    await refusal('unreadable drive program', () => makeOfficerFolder('5.3.6'), { prep: (t) => FS.writeFileSync(path.join(t, 'resources', 'app.asar'), 'garbage') }, /could not be read/);
    await refusal('the installer copy has no program archive', () => makeOfficerFolder('5.3.6'), { prep: (t, s) => FS.unlinkSync(path.join(s.appDir, 'resources', 'app.asar')) }, /not usable/);
    await refusal('the installer copy is the wrong version', () => makeOfficerFolder('5.3.6'), { selfVersion: '5.4.4' }, /not usable/);
    await refusal('the installer copy carries a protected folder', () => makeOfficerFolder('5.3.6'), { prep: (t, s) => write(path.join(s.appDir, 'userdata', 'x'), 'x') }, /not usable/);
    const ro = Object.create(FS);
    ro.mkdirSync = (p, o) => { if (String(p).indexOf(PU.WORK_DIR_NAME) !== -1) { const e = new Error('EROFS'); e.code = 'EROFS'; throw e; } return FS.mkdirSync(p, o); };
    await refusal('a write-protected drive', () => makeOfficerFolder('5.3.6'), { fs: ro }, /cannot be written/);

    {
        // A byte flipped in the copy on the drive (same size) is caught by the hash.
        const R = await refusal('a damaged copy (hash)', () => makeOfficerFolder('5.3.6'), {
            onProgress: function (p) {
                if (p.phase === 'verify' && !this.done) {
                    this.done = true;
                    const f = path.join(this.target, PU.WORK_DIR_NAME, 'incoming', 'resources', 'app.asar');
                    const b = FS.readFileSync(f); b[b.length - 1] ^= 0xff; FS.writeFileSync(f, b);
                }
            },
            prep: function (t) { this.target = t; },
        }, /damaged/);
        ok('… and its partial copy was removed', !FS.existsSync(path.join(R.target, PU.WORK_DIR_NAME)));
    }
    {
        const R = await refusal('a short copy (size)', () => makeOfficerFolder('5.3.6'), {
            onProgress: function (p) {
                if (p.phase === 'verify' && !this.done) {
                    this.done = true;
                    FS.appendFileSync(path.join(this.target, PU.WORK_DIR_NAME, 'incoming', 'ffmpeg.dll'), 'x');
                }
            },
            prep: function (t) { this.target = t; },
        }, /does not match/);
        ok('… and its partial copy was removed', !FS.existsSync(path.join(R.target, PU.WORK_DIR_NAME)));
    }

    section('earlier leftovers that are safe to clear');
    for (const [label, prep] of [
        ['a stale prepared 5.4.2 update', (t) => {
            const wd = PU.ensureWorkDir(FS, t);
            FS.mkdirSync(path.join(wd, 'incoming')); write(path.join(wd, 'incoming', EXE), 'x');
            PU.writeJsonDurable(FS, path.join(wd, PU.PREPARED_FILE), { kind: PU.MARKER_KIND, version: '5.4.2' });
        }],
        ['an empty work folder', (t) => { PU.ensureWorkDir(FS, t); }],
        ['a safely rolled-back failure', (t) => {
            const wd = PU.ensureWorkDir(FS, t);
            PU.writeJsonDurable(FS, path.join(wd, PU.RESULT_FILE), { kind: PU.MARKER_KIND, txId: 'abc', to: '5.4.2', ok: false, rolledBack: true });
        }],
    ]) {
        const setup = await makeSetup('5.4.3');
        const target = await makeOfficerFolder('5.3.6');
        const before = hashTree(target, [PU.WORK_DIR_NAME]);
        prep(target);
        const r = await DS.runDriveSetup(opts(setup, target));
        ok(label + ' → cleared and updated', r.status === 'applied', r);
        ok(label + ' → data untouched', sameTree(pick(hashTree(target, [PU.WORK_DIR_NAME]), KEEP), pick(before, KEEP)));
    }

    section('a failed swap');
    {
        const setup = await makeSetup('5.4.3');
        const target = await makeOfficerFolder('5.3.6');
        const before = hashTree(target);
        const failingFs = Object.create(FS);
        failingFs.renameSync = (from, to) => {
            if (path.basename(from) === 'locales' && path.basename(path.dirname(from)) === 'incoming') { const e = new Error('EIO'); e.code = 'EIO'; throw e; }
            return FS.renameSync(from, to);
        };
        const r = await DS.runDriveSetup(opts(setup, target, { fs: failingFs }));
        ok('reported as failed but safe', r.status === 'failed' && r.safe === true, r);
        ok('the drive copy is exactly as it was (work folder removed)', sameTree(hashTree(target), before));
    }
    {
        const setup = await makeSetup('5.4.3');
        const target = await makeOfficerFolder('5.3.6');
        const before = hashTree(target, [PU.WORK_DIR_NAME]);
        let placedLocales = false;
        const stuckFs = Object.create(FS);
        stuckFs.renameSync = (from, to) => {
            if (path.basename(from) === 'resources.pak' && path.basename(path.dirname(to)) === path.basename(target)) { const e = new Error('EIO'); e.code = 'EIO'; throw e; }
            if (placedLocales && path.basename(path.dirname(to)) === 'incoming') { const e = new Error('EIO'); e.code = 'EIO'; throw e; }
            if (path.basename(from) === 'locales' && path.basename(path.dirname(to)) === path.basename(target)) placedLocales = true;
            return FS.renameSync(from, to);
        };
        const r = await DS.runDriveSetup(opts(setup, target, { fs: stuckFs }));
        ok('a rollback that cannot finish is reported as NOT safe, with the work folder', r.status === 'failed' && r.safe === false && r.workDir === path.join(target, PU.WORK_DIR_NAME), r);
        ok('… the work folder is kept for support', FS.existsSync(path.join(target, PU.WORK_DIR_NAME, PU.JOURNAL_FILE)));
        ok('… and the data is still byte-identical', sameTree(pick(hashTree(target, [PU.WORK_DIR_NAME]), KEEP), pick(before, KEEP)));
        const ins = PU.inspectWorkDir(FS, target, '5.3.6');
        ok('… and the in-app updater will refuse to start over it', ins.status === 'failed' && ins.safe === false, ins);
    }

    // ─────────────────────────────────────────────────────────────────
    section('temp setup folder cleanup');
    {
        const s = await makeSetup('5.4.3');
        ok('kept while a newer version made it', DS.cleanupSetupDir(FS, s.root, '5.4.2').removed === false && FS.existsSync(s.setupDir));
        const c = DS.cleanupSetupDir(FS, s.root, '5.4.3');
        ok('removed once this version runs', c.removed === true && !FS.existsSync(s.setupDir), c);
        ok('absent is fine', DS.cleanupSetupDir(FS, s.root, '5.4.3').reason === 'absent');
        const s2 = await makeSetup('5.4.3', { marker: false });
        ok('never without the marker', DS.cleanupSetupDir(FS, s2.root, '9.9.9').removed === false && FS.existsSync(s2.appDir));
        const s3 = await makeSetup('5.4.3');
        write(path.join(s3.setupDir, 'someone-elses.txt'), 'x');
        ok('never with foreign items', DS.cleanupSetupDir(FS, s3.root, '5.4.3').removed === false && FS.existsSync(path.join(s3.setupDir, 'someone-elses.txt')) && FS.existsSync(s3.appDir));
        const s4 = await makeSetup('5.4.3');
        write(path.join(s4.setupDir, 'viper-setup.json.tmp'), 'x');
        ok('leftover .tmp files are ours', DS.cleanupSetupDir(FS, s4.root, '5.4.3').removed === true);
        const s5 = await makeSetup('5.4.3');
        const busy = Object.create(FS);
        busy.rmSync = () => { const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e; };
        const c5 = DS.cleanupSetupDir(busy, s5.root, '5.4.3');
        ok('a busy program folder keeps the marker for next time', c5.removed === false && FS.existsSync(path.join(s5.setupDir, DS.SETUP_MARKER)), c5);
        if (jnMade) {
            const root = tmpDir('jroot');
            try { FS.symlinkSync(s5.setupDir, path.join(root, DS.SETUP_DIR_NAME), 'junction'); ok('a junction is never followed', DS.cleanupSetupDir(FS, root, '5.4.3').removed === false && FS.existsSync(s5.appDir)); } catch (_) {}
        }
    }

    // ─────────────────────────────────────────────────────────────────
    section('tree helpers');
    {
        const a = tmpDir('ta'); await makeUnpacked(a, '5.4.3');
        const L = DS.listTree(FS, a);
        ok('listTree finds files and folders', L.entries.some(e => e.rel === 'locales' && e.isDir) && L.entries.some(e => e.rel === 'locales/de.pak' && !e.isDir) && L.totalBytes > 0);
        const b = path.join(tmpDir('tb'), 'copy');
        const prog = [];
        const n = await DS.copyTree(FS, a, b, L, (d, t) => prog.push([d, t]));
        ok('copyTree copies every byte', n === L.totalBytes && sameTree(hashTree(a), hashTree(b)));
        ok('… with monotone progress ending at the total', prog.length > 0 && prog[prog.length - 1][0] === L.totalBytes && prog.every((p, i) => !i || p[0] >= prog[i - 1][0]));
        ok('compareTrees: identical', DS.compareTrees(L.entries, DS.listTree(FS, b).entries).same === true);
        FS.appendFileSync(path.join(b, 'ffmpeg.dll'), 'x');
        ok('compareTrees: a size change differs', DS.compareTrees(L.entries, DS.listTree(FS, b).entries).same === false);
        let threw = false;
        try { await DS.copyTree(FS, a, b, L); } catch (_) { threw = true; }
        ok('copyTree never writes into an existing folder', threw);
        ok('hashFile is SHA-512', await DS.hashFile(FS, path.join(a, EXE)) === crypto.createHash('sha512').update(FS.readFileSync(path.join(a, EXE))).digest('base64'));
        ok('a free file is free', DS.fileIsFree(FS, path.join(a, EXE)) === true);
        ok('a missing file is not "busy"', DS.fileIsFree(FS, path.join(a, 'nope.exe')) === true);
    }

    // ─────────────────────────────────────────────────────────────────
    section('electron-main.js wiring');
    const MAIN = FS.readFileSync(path.join(REPO, 'electron-main.js'), 'utf8').replace(/\r\n/g, '\n');
    const flagAt = MAIN.indexOf("process.argv.includes('--viper-drive-setup')");
    ok('the drive-setup branch exists', flagAt !== -1);
    ok('… after the portable helper branch', flagAt > MAIN.indexOf("process.argv.includes('--viper-apply-portable-update')"));
    ok('… and before ANY other startup code',
        ['uc-chat-main.js', 'requestSingleInstanceLock', "app.setPath('userData'", "require('electron-updater')", 'mkdirSync', 'const { app,']
            .every(s => { const i = MAIN.indexOf(s); return i === -1 || i > flagAt; }));
    ok('… returning straight after handing off', /drive-setup\.js'\)\.run\(electron, process\.argv\);\n\s*return;\n\}/.test(MAIN.slice(flagAt, flagAt + 300)));
    const alAt = MAIN.indexOf('function _portableUpdateAfterLoad()');
    const alBody = MAIN.slice(alAt, MAIN.indexOf('\n}\n', alAt));
    ok('the temp setup folder is cleaned only by portable copies, after 30 s',
        alBody.indexOf('cleanupSetupDir(ofs, app.getPath(\'temp\'), app.getVersion())') > alBody.indexOf('if (!app.isPackaged || !isPortable) return;')
        && /cleanupSetupDir[\s\S]{0,300}\}, 30000\);/.test(alBody));

    // ─────────────────────────────────────────────────────────────────
    section('installer script');
    const NSH = FS.readFileSync(path.join(REPO, 'build', 'installer.nsh'), 'utf8').replace(/\r\n/g, '\n');
    const piAt = NSH.indexOf('!macro preInit');
    const piBody = NSH.slice(piAt, NSH.indexOf('!macroend', piAt));
    ok('a preInit macro exists', piAt !== -1);
    ok('… which does nothing in the uninstaller build', /!ifndef BUILD_UNINSTALLER/.test(piBody) || /!ifndef BUILD_UNINSTALLER[\s\S]*!macro preInit/.test(NSH.slice(0, piAt + 20)));
    ok('… nor in the elevated inner instance', /UAC_IsInnerInstance/.test(piBody));
    ok('it launches the unpacked app with the contract flags', /--viper-drive-setup/.test(NSH) && /--target=\$vdTarget/.test(NSH) && /--wait-pid=\$vdWaitPid/.test(NSH));
    ok('… from %TEMP%\\viper-drive-setup\\app with the marker', /\$TEMP\\viper-drive-setup\\app/.test(NSH) && /viper-drive-setup\\viper-setup\.json/.test(NSH)
        && NSH.indexOf('{"kind":"viper-drive-setup"') !== -1);
    ok('the folder the per-user install registers is never a drive copy', /ReadRegStr \$vdRegLoc HKCU "Software\\\$\{APP_GUID\}" InstallLocation/.test(NSH));
    ok('silent manual installs (IT deployments) never look for drives', /\$\{Silent\}/.test(NSH));
    ok('a drive copy must hold userdata, cases or .portable', /\\userdata\\\*\.\*/.test(NSH) && /\\cases\\\*\.\*/.test(NSH) && /\\\.portable/.test(NSH));
    ok('it must be writable without admin rights', /viper-write-probe\.tmp/.test(NSH));
    ok('only older copies are offered', /\$\{VersionCompare\}/.test(NSH) && /\$\{GetFileVersion\}/.test(NSH));

    try { FS.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch (_) {}
    console.log('\n' + (failed ? 'FAILED' : 'OK') + ' \u2014 ' + passed + ' passed, ' + failed + ' failed');
    process.exit(failed ? 1 : 0);
})().catch((e) => {
    console.log('CRASH ' + (e && e.stack || e));
    try { FS.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
    process.exit(1);
});

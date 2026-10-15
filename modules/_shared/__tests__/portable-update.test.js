/*
 * portable-update.test.js
 *
 * The self-update path for VIPER folders run from an external drive
 * (modules/_shared/portable-update.js + scripts/build-portable-update.js).
 *
 * Field report: an officer running VIPER from F:\VIPER\V.I.P.E.R clicked
 * Install & Restart; the per-user NSIS installer put the new version under
 * C:\Users\…\AppData\Local\Programs, he relaunched the drive copy, and it
 * was still 5.3.6. The constraint for the fix: "make sure it doesnt cause
 * future issues for desktop users".
 *
 * What is pinned here:
 *   - the mode decision: every desktop shape stays on the NSIS path, and a
 *     desktop install never even queries the registry;
 *   - nothing in userdata\, cases\, .portable or any file the update does
 *     not carry is touched — byte-for-byte;
 *   - a failed swap is rolled back to the exact previous tree;
 *   - downloads are size- and SHA-512-checked before anything is unpacked;
 *   - a hostile archive cannot write outside the work folder or into the
 *     officer's data;
 *   - the build script and the client agree end to end.
 *
 * Run: set ELECTRON_RUN_AS_NODE=1&& node_modules\.bin\electron.cmd modules\_shared\__tests__\portable-update.test.js
 * (plain `node` works too).
 */
'use strict';

// Under Electron-as-Node the patched fs expands app.asar into a directory,
// so archiver would zip its CONTENTS. Treat archives as plain files.
process.noAsar = true;

const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const childProcess = require('child_process');
let FS;
try { FS = require('original-fs'); } catch (_) { FS = require('fs'); }

const REPO = path.join(__dirname, '..', '..', '..');
const PU = require(path.join(REPO, 'modules', '_shared', 'portable-update.js'));
const archiver = require(path.join(REPO, 'node_modules', 'archiver'));
const AdmZip = require(path.join(REPO, 'node_modules', 'adm-zip'));
const StreamZip = require(path.join(REPO, 'node_modules', 'node-stream-zip'));
const asar = require(path.join(REPO, 'node_modules', '@electron', 'asar'));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
    if (cond) { passed++; return; }
    failed++;
    console.log('  FAIL ' + label + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''));
}
function section(name) { console.log('\n== ' + name + ' =='); }
async function rejects(label, p, re) {
    try { await p; ok(label + ' (should have thrown)', false); }
    catch (e) { ok(label, !re || re.test(e.message), e.message); }
}
function throwsSync(label, fn, re) {
    try { fn(); ok(label + ' (should have thrown)', false); }
    catch (e) { ok(label, !re || re.test(e.message), e.message); }
}

const EXE = 'V.I.P.E.R.exe';
const TMP = FS.mkdtempSync(path.join(os.tmpdir(), 'vpu-test-'));
let tmpN = 0;
const tmpDir = (tag) => { const d = path.join(TMP, (tag || 'd') + '-' + (++tmpN)); FS.mkdirSync(d, { recursive: true }); return d; };
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sha512b64 = (b) => crypto.createHash('sha512').update(b).digest('base64');

function write(p, data) { FS.mkdirSync(path.dirname(p), { recursive: true }); FS.writeFileSync(p, data); }

/** rel path → sha256 for every file under dir, skipping the work folder. */
function hashTree(dir, skipWork) {
    const out = {};
    (function walk(d, rel) {
        for (const n of FS.readdirSync(d)) {
            if (skipWork && !rel && n === PU.WORK_DIR_NAME) continue;
            const p = path.join(d, n), r = rel ? rel + '/' + n : n;
            const st = FS.lstatSync(p);
            if (st.isDirectory()) { out[r + '/'] = 'dir'; walk(p, r); }
            else out[r] = sha256(FS.readFileSync(p));
        }
    })(dir, '');
    return out;
}
function sameTree(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function subTree(tree, prefix) {
    const o = {};
    for (const k of Object.keys(tree)) if (k === prefix + '/' || k.indexOf(prefix + '/') === 0 || k === prefix) o[k] = tree[k];
    return o;
}

async function makeAsar(dest, version, extra) {
    const src = tmpDir('asarsrc');
    write(path.join(src, 'package.json'), JSON.stringify({ name: 'viper', version, main: 'electron-main.js' }));
    write(path.join(src, 'electron-main.js'), '// ' + (extra || 'main') + '\n' + 'x'.repeat(2048));
    FS.mkdirSync(path.dirname(dest), { recursive: true });
    await asar.createPackage(src, dest);
    // createPackage resolves before its final write is flushed (measured:
    // 2580 bytes on return, 2599 half a second later). Wait for the length
    // the archive's own header declares.
    const deadline = Date.now() + 10000;
    for (;;) {
        const b = FS.readFileSync(dest);
        if (b.length >= 16) {
            const hs = b.readUInt32LE(4), jl = b.readUInt32LE(12);
            if (b.length >= 16 + jl) {
                let end = 0;
                (function walk(node) {
                    for (const k of Object.keys(node.files || {})) {
                        const e = node.files[k];
                        if (e.files) walk(e); else if (!e.unpacked) end = Math.max(end, Number(e.offset) + e.size);
                    }
                })(JSON.parse(b.subarray(16, 16 + jl).toString('utf8')));
                if (b.length >= 8 + hs + end) return;
            }
        }
        if (Date.now() > deadline) throw new Error('fixture asar never finished writing: ' + dest);
        await new Promise(r => setTimeout(r, 25));
    }
}

/** A fake win-unpacked tree for `version`. */
async function makeUnpacked(dir, version, tag) {
    write(path.join(dir, EXE), 'EXE ' + version + ' ' + (tag || '') + crypto.randomBytes(64).toString('hex'));
    write(path.join(dir, 'ffmpeg.dll'), 'ffmpeg ' + version);
    write(path.join(dir, 'resources.pak'), crypto.randomBytes(4096));
    write(path.join(dir, 'locales', 'en-US.pak'), 'en ' + version);
    write(path.join(dir, 'locales', 'de.pak'), 'de ' + version);
    write(path.join(dir, 'resources', 'app-update.yml'), 'owner: exhonorated999\n');
    write(path.join(dir, 'resources', 'app.asar.unpacked', 'build', 'icon.ico'), 'ico');
    await makeAsar(path.join(dir, 'resources', 'app.asar'), version, tag);
    return dir;
}

/** An officer's folder: the program plus everything that must survive. */
async function makeOfficerFolder(version) {
    const dir = tmpDir('officer');
    await makeUnpacked(dir, version, 'old');
    write(path.join(dir, 'Uninstall V.I.P.E.R.exe'), 'uninstaller');
    write(path.join(dir, 'uninstallerIcon.ico'), 'icon');
    write(path.join(dir, '.portable'), '');
    write(path.join(dir, 'userdata', 'Local Storage', 'leveldb', 'CURRENT'), 'MANIFEST-000001');
    write(path.join(dir, 'userdata', 'install.json'), '{"installedAt":"2026-01-01"}');
    write(path.join(dir, 'cases', '26-0001', 'Evidence', 'photo.jpg'), crypto.randomBytes(8192));
    write(path.join(dir, 'cases', '26-0001', '.case-snapshot.json'), '{"x":1}');
    write(path.join(dir, 'My notes.txt'), 'the officer put this here');
    return dir;
}

function zipDir(srcDir, zipPath) {
    return new Promise((resolve, reject) => {
        const out = FS.createWriteStream(zipPath);
        const z = archiver('zip', { zlib: { level: 6 } });
        out.on('close', resolve); out.on('error', reject); z.on('error', reject);
        z.pipe(out); z.directory(srcDir, false); z.finalize();
    });
}

function sumFiles(dir) {
    let t = 0;
    (function walk(d) { for (const n of FS.readdirSync(d)) { const p = path.join(d, n); const s = FS.statSync(p); if (s.isDirectory()) walk(p); else t += s.size; } })(dir);
    return t;
}

// ── a local stand-in for GitHub's release download URLs ──────────────
function startServer(routes) {
    const hits = [];
    const srv = http.createServer((req, res) => {
        hits.push(req.url);
        const r = routes[req.url];
        if (!r) { res.writeHead(404); res.end('nope'); return; }
        if (typeof r === 'function') { r(req, res); return; }
        res.writeHead(r.status || 200, { 'Content-Length': r.body.length });
        res.end(r.body);
    });
    return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => {
        const base = 'http://127.0.0.1:' + srv.address().port;
        const get = (u) => new Promise((ok2, fail) => {
            const local = u.replace(PU.RELEASE_BASE, base + '/dl');
            const req = http.get(local, (res) => { res.abort = () => req.destroy(); ok2(res); });
            req.on('error', fail);
        });
        resolve({ srv, base, get, hits, close: () => new Promise(r => srv.close(r)) });
    }));
}
const dlPath = (version, file) => '/dl/v' + version + '/' + file;

(async () => {
    // ─────────────────────────────────────────────────────────────────
    section('constants that other versions and the installer depend on');
    ok('the helper flag is frozen', PU.HELPER_FLAG === '--viper-apply-portable-update');
    ok('the work folder name is frozen', PU.WORK_DIR_NAME === '.viper-update');
    ok('the manifest asset name is frozen', PU.MANIFEST_NAME === 'portable-update.json');
    ok('the release base points at the VIPER repo', PU.RELEASE_BASE === 'https://github.com/exhonorated999/project-viper/releases/download');
    const BUR = require(path.join(REPO, 'node_modules', 'builder-util-runtime'));
    const ebYml = FS.readFileSync(path.join(REPO, 'electron-builder.yml'), 'utf8');
    const appId = /^appId:\s*(\S+)/m.exec(ebYml)[1];
    const guid = BUR.UUID.v5(appId, BUR.UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3'));
    ok('NSIS_APP_GUID is the GUID electron-builder derives from appId ' + appId, PU.NSIS_APP_GUID === guid, guid);
    ok('userdata, cases, .viper-update and .portable are protected',
        ['userdata', 'cases', '.viper-update', '.portable', 'USERDATA', 'Cases'].every(PU.isProtectedName));
    ok('ordinary program entries are not protected', !['resources', 'locales', EXE, 'Uninstall V.I.P.E.R.exe'].some(PU.isProtectedName));

    // ─────────────────────────────────────────────────────────────────
    section('mode decision — desktop installs keep the NSIS path');
    const F = 'F:\\VIPER\\V.I.P.E.R';
    const LAD = 'C:\\Users\\Officer\\AppData\\Local';
    function decide(over, regResult) {
        let regCalls = 0;
        const o = Object.assign({
            isPackaged: true, platform: 'win32', isPortable: true, portableExecutableFile: '',
            exeDir: F, localAppData: LAD, fs: null,
            readRegisteredLocation: () => { regCalls++; if (regResult instanceof Error) throw regResult; return regResult || { ok: true, value: null }; },
        }, over);
        const d = PU.decideUpdateMode(o);
        d.regCalls = regCalls;
        return d;
    }
    let d;
    d = decide({ isPackaged: false });
    ok('dev build → nsis', d.mode === 'nsis' && d.reason === 'dev');
    d = decide({ platform: 'darwin' });
    ok('not Windows → nsis', d.mode === 'nsis' && d.regCalls === 0);
    d = decide({ portableExecutableFile: 'C:\\Downloads\\V.I.P.E.R.-5.4.2-Portable.exe' });
    ok('single-file Portable.exe → nsis (unchanged)', d.mode === 'nsis' && d.reason === 'single-file-portable');
    ok('… without reading the registry', d.regCalls === 0);
    d = decide({ isPortable: false, exeDir: LAD + '\\Programs\\V.I.P.E.R' });
    ok('normal desktop install → nsis', d.mode === 'nsis' && d.reason === 'desktop-install');
    ok('… without reading the registry', d.regCalls === 0);
    d = decide({ isPortable: false, exeDir: 'C:\\Program Files\\V.I.P.E.R' });
    ok('per-machine / MSI desktop install → nsis, no registry read', d.mode === 'nsis' && d.regCalls === 0);
    d = decide({}, { ok: false, error: 'access denied' });
    ok('portable folder but the registry cannot be read → nsis (never guess)', d.mode === 'nsis' && d.reason === 'registry-unreadable');
    d = decide({}, new Error('boom'));
    ok('registry reader throws → nsis', d.mode === 'nsis' && d.reason === 'registry-unreadable');
    d = decide({ exeDir: 'D:\\Apps\\VIPER' }, { ok: true, value: 'd:\\apps\\viper\\' });
    ok('portable-mode folder that IS the registered install (D: desktop install) → nsis',
        d.mode === 'nsis' && d.reason === 'nsis-updates-this-folder', d);
    d = decide({ exeDir: LAD + '\\Programs\\V.I.P.E.R', isPortable: true }, { ok: true, value: null });
    ok('unregistered, but this IS the default per-user folder → nsis', d.mode === 'nsis' && d.reason === 'nsis-updates-this-folder', d);
    d = decide({ localAppData: '' }, { ok: true, value: null });
    ok('unregistered and no LOCALAPPDATA → nsis', d.mode === 'nsis' && d.reason === 'no-localappdata');
    d = decide({}, { ok: true, value: null });
    ok('THE FIELD CASE: drive folder, nothing registered → folder', d.mode === 'folder' && d.reason === 'not-registered', d);
    ok('… and it says where NSIS would have gone', d.predicted === path.join(LAD, 'Programs', 'V.I.P.E.R'));
    d = decide({}, { ok: true, value: LAD + '\\Programs\\V.I.P.E.R' });
    ok('drive folder while a desktop copy is registered → folder', d.mode === 'folder' && d.reason === 'registered-elsewhere');
    ok('the registry is read exactly once for a portable folder', d.regCalls === 1);

    section('registry reading');
    const regOut = '\r\nHKEY_CURRENT_USER\\Software\\' + PU.NSIS_APP_GUID + '\r\n    InstallLocation    REG_SZ    F:\\My Drive\\V.I.P.E.R\r\n\r\n';
    ok('parses a REG_SZ value with spaces in the path', PU.parseRegQueryOutput(regOut) === 'F:\\My Drive\\V.I.P.E.R');
    ok('parses REG_EXPAND_SZ', PU.parseRegQueryOutput('    InstallLocation    REG_EXPAND_SZ    C:\\x\r\n') === 'C:\\x');
    ok('no value → null', PU.parseRegQueryOutput('\r\nHKEY_CURRENT_USER\\Software\\x\r\n') === null);
    let regArgs = null;
    let r = PU.readHkcuInstallLocation((cmd, args) => { regArgs = [cmd].concat(args); return Buffer.from(regOut); });
    ok('reads HKCU\\Software\\<GUID> /v InstallLocation — the key the per-user installer uses',
        JSON.stringify(regArgs) === JSON.stringify(['reg', 'query', 'HKCU\\Software\\' + PU.NSIS_APP_GUID, '/v', 'InstallLocation']), regArgs);
    ok('… and returns the value', r.ok && r.value === 'F:\\My Drive\\V.I.P.E.R');
    r = PU.readHkcuInstallLocation(() => { const e = new Error('not found'); e.status = 1; throw e; });
    ok('reg.exe exit 1 (key absent) → ok, null', r.ok === true && r.value === null);
    r = PU.readHkcuInstallLocation(() => { const e = new Error('spawn reg ENOENT'); e.code = 'ENOENT'; throw e; });
    ok('reg.exe missing → not ok (caller falls back to nsis)', r.ok === false);
    if (process.platform === 'win32') {
        r = PU.readHkcuInstallLocation(childProcess.execFileSync);
        ok('the real reg.exe query on this machine answers cleanly', r.ok === true, r);
    }

    // ─────────────────────────────────────────────────────────────────
    section('manifest');
    const goodSha = sha512b64(Buffer.from('x'));
    const goodM = { kind: 'viper-portable-update', version: '5.4.3', file: 'V.I.P.E.R.-5.4.3-Portable-Update.zip', size: 1000, unpackedSize: 3000, sha512: goodSha, exe: EXE };
    const m = PU.parseManifest(goodM, '5.4.3', EXE);
    ok('a good manifest parses', m.file === goodM.file && m.size === 1000 && m.sha512 === goodSha);
    ok('exe name compared case-insensitively', !!PU.parseManifest(goodM, '5.4.3', 'v.i.p.e.r.EXE'));
    const bad = (label, patch, re) => throwsSync(label, () => PU.parseManifest(Object.assign({}, goodM, patch), '5.4.3', EXE), re);
    bad('wrong kind refused', { kind: 'something' }, /not a VIPER/);
    bad('wrong version refused', { version: '5.4.2' }, /expected 5\.4\.3/);
    bad('path in file name refused', { file: '../evil.zip' }, /file name/);
    bad('non-zip refused', { file: 'V.I.P.E.R.exe' }, /file name/);
    bad('zero size refused', { size: 0 }, /size/);
    bad('fractional size refused', { size: 1.5 }, /size/);
    bad('bad checksum refused', { sha512: 'abc' }, /checksum/);
    bad('hex checksum refused (must be base64)', { sha512: crypto.createHash('sha512').update('x').digest('hex') }, /checksum/);
    bad('different exe refused', { exe: 'Other.exe' }, /this copy runs/);
    throwsSync('null refused', () => PU.parseManifest(null, '5.4.3', EXE), /unreadable/);
    ok('free space needed = zip + two unpacked copies + spare', PU.requiredFreeBytes(m) === 1000 + 6000 + PU.LIMITS.spareBytes);
    ok('manifest URL', PU.manifestUrl('5.4.3') === PU.RELEASE_BASE + '/v5.4.3/portable-update.json');
    ok('asset URL', PU.assetUrl('5.4.3', goodM.file) === PU.RELEASE_BASE + '/v5.4.3/V.I.P.E.R.-5.4.3-Portable-Update.zip');

    // ─────────────────────────────────────────────────────────────────
    section('archive entry validation (zip-slip, Windows names, the officer\'s data)');
    const E = (name, extra) => Object.assign({ name, size: 10, isDirectory: /\/$/.test(name), attr: 0 }, extra);
    const v0 = PU.validateEntries([E('V.I.P.E.R.exe'), E('resources/'), E('resources/app.asar'), E('locales/en-US.pak')]);
    ok('a normal tree passes', v0.ok && v0.files.length === 3 && v0.dirs.length === 1 && v0.totalBytes === 30, v0);
    const rej = (label, entries, re) => { const v = PU.validateEntries(entries); ok(label, v.ok === false && (!re || re.test(v.error)), v); };
    rej('empty archive', [], /empty/);
    rej('parent traversal', [E('../evil.dll')], /unsafe/);
    rej('traversal mid-path', [E('resources/../../evil')], /unsafe/);
    rej('absolute path', [E('/etc/x')], /absolute/);
    rej('drive letter', [E('C:/Windows/x.dll')], /colon/);
    rej('alternate data stream', [E('V.I.P.E.R.exe:Zone.Identifier')], /colon/);
    rej('backslash path', [E('resources\\app.asar')], /backslash/);
    rej('"." segment', [E('./x')], /unsafe/);
    rej('empty segment', [E('a//b')], /unsafe/);
    rej('trailing dot (Windows strips it)', [E('evil.')], /dot or space/);
    rej('trailing space', [E('evil ')], /dot or space/);
    rej('reserved device name', [E('locales/CON.pak')], /reserved/);
    rej('reserved COM name', [E('com1')], /reserved/);
    rej('invalid character', [E('a?b')], /invalid character/);
    rej('control character', [E('a\x01b')], /invalid character/);
    rej('carries userdata\\', [E('userdata/Local Storage/x')], /protected/);
    rej('carries cases\\', [E('cases/26-0001/x')], /protected/);
    rej('carries cases\\ in other case', [E('CASES/')], /protected/);
    rej('carries .portable', [E('.portable')], /protected/);
    rej('carries .viper-update', [E('.viper-update/stage/x')], /protected/);
    rej('symlink entry', [E('link', { attr: (0o120777 << 16) >>> 0 })], /link/);
    rej('case-folded duplicate', [E('Locales/a'), E('locales/A')], /duplicate/);
    rej('file nested under a file', [E('resources'), E('resources/app.asar')], /nests under a file/);
    rej('oversized entry', [E('big', { size: PU.LIMITS.maxEntryBytes + 1 })], /size/);
    rej('negative size', [E('neg', { size: -1 })], /size/);
    rej('total too large', [E('a', { size: PU.LIMITS.maxEntryBytes }), E('b', { size: PU.LIMITS.maxEntryBytes }), E('c', { size: PU.LIMITS.maxEntryBytes })], /too large/);
    ok('safeJoin keeps a validated path inside', PU.safeJoin('C:\\w\\stage', 'resources/app.asar') === path.resolve('C:\\w\\stage\\resources\\app.asar'));
    throwsSync('safeJoin refuses an escape', () => PU.safeJoin('C:\\w\\stage', '../x'), /escapes/);
    throwsSync('safeJoin refuses a sibling with the same prefix', () => PU.safeJoin('C:\\w\\stage', '../stage2/x'), /escapes/);

    // ─────────────────────────────────────────────────────────────────
    section('reading the version out of app.asar (no Electron asar handle)');
    const asarDir = tmpDir('asar');
    await makeAsar(path.join(asarDir, 'app.asar'), '7.8.9');
    ok('reads the version from a real asar', PU.readAsarVersion(FS, path.join(asarDir, 'app.asar')) === '7.8.9');
    write(path.join(asarDir, 'junk.asar'), crypto.randomBytes(256));
    throwsSync('a junk archive is refused', () => PU.readAsarVersion(FS, path.join(asarDir, 'junk.asar')));
    const realAsar = path.join(REPO, 'dist', 'win-unpacked', 'resources', 'app.asar');
    if (FS.existsSync(realAsar)) {
        const listed = JSON.parse(asar.extractFile(realAsar, 'package.json').toString('utf8')).version;
        ok('agrees with @electron/asar on the real packaged app.asar', PU.readAsarVersion(FS, realAsar) === listed, listed);
    }

    // ─────────────────────────────────────────────────────────────────
    section('download: size and SHA-512 are checked before anything is kept');
    const payload = crypto.randomBytes(300 * 1024);
    const srvA = await startServer({
        '/dl/v1.0.0/good.zip': { body: payload },
        '/dl/v1.0.0/short.zip': (req, res) => { res.writeHead(200); res.end(payload.subarray(0, 1000)); },
        '/dl/v1.0.0/stall.zip': (req, res) => { res.writeHead(200); res.write(payload.subarray(0, 1000)); /* then nothing */ },
        '/dl/v1.0.0/portable-update.json': { body: Buffer.from(JSON.stringify(Object.assign({}, goodM, { version: '1.0.0' }))) },
        '/dl/v1.0.1/portable-update.json': { body: Buffer.from('{not json') },
        '/dl/v1.0.2/portable-update.json': { body: Buffer.alloc(PU.LIMITS.maxManifestBytes + 10, 32) },
        '/dl/v1.0.3/portable-update.json': { status: 500, body: Buffer.from('oops') },
    });
    const dd = tmpDir('dl');
    let progressCalls = 0;
    await PU.downloadToFile({ get: srvA.get, url: PU.assetUrl('1.0.0', 'good.zip'), dest: path.join(dd, 'good.zip'), sha512: sha512b64(payload), size: payload.length, fs: FS, onProgress: () => progressCalls++ });
    ok('a good download lands under its final name', sha256(FS.readFileSync(path.join(dd, 'good.zip'))) === sha256(payload));
    ok('… with no .partial left behind', !FS.existsSync(path.join(dd, 'good.zip.partial')));
    ok('… and progress was reported', progressCalls > 0);
    await rejects('a checksum mismatch is refused', PU.downloadToFile({ get: srvA.get, url: PU.assetUrl('1.0.0', 'good.zip'), dest: path.join(dd, 'bad.zip'), sha512: sha512b64(Buffer.from('other')), size: payload.length, fs: FS }), /integrity/);
    ok('… and nothing is kept', !FS.existsSync(path.join(dd, 'bad.zip')) && !FS.existsSync(path.join(dd, 'bad.zip.partial')));
    await rejects('a short download is refused', PU.downloadToFile({ get: srvA.get, url: PU.assetUrl('1.0.0', 'short.zip'), dest: path.join(dd, 'short.zip'), sha512: sha512b64(payload), size: payload.length, fs: FS }), /incomplete/);
    ok('… and nothing is kept', !FS.existsSync(path.join(dd, 'short.zip')) && !FS.existsSync(path.join(dd, 'short.zip.partial')));
    await rejects('a download larger than declared is refused', PU.downloadToFile({ get: srvA.get, url: PU.assetUrl('1.0.0', 'good.zip'), dest: path.join(dd, 'big.zip'), sha512: sha512b64(payload), size: 1000, fs: FS }), /larger/);
    ok('… and nothing is kept', !FS.existsSync(path.join(dd, 'big.zip.partial')));
    await rejects('a 404 is refused', PU.downloadToFile({ get: srvA.get, url: PU.assetUrl('1.0.0', 'missing.zip'), dest: path.join(dd, 'm.zip'), sha512: goodSha, size: 10, fs: FS }), /HTTP 404/);
    const t0 = Date.now();
    await rejects('a stalled download gives up', PU.downloadToFile({ get: srvA.get, url: PU.assetUrl('1.0.0', 'stall.zip'), dest: path.join(dd, 's.zip'), sha512: sha512b64(payload), size: payload.length, fs: FS, stallMs: 300 }), /stalled/);
    ok('… promptly', Date.now() - t0 < 5000);
    ok('… and nothing is kept', !FS.existsSync(path.join(dd, 's.zip.partial')));
    await rejects('a release with no portable package says where to go instead', PU.fetchManifest(srvA.get, '9.9.9', EXE), /project-viper\.com/);
    ok('fetchManifest parses a good description', (await PU.fetchManifest(srvA.get, '1.0.0', EXE)).version === '1.0.0');
    await rejects('unreadable JSON is refused', PU.fetchManifest(srvA.get, '1.0.1', EXE), /unreadable/);
    await rejects('an oversized description is refused', PU.fetchManifest(srvA.get, '1.0.2', EXE), /too large/);
    await rejects('a server error is reported', PU.fetchManifest(srvA.get, '1.0.3', EXE), /HTTP 500/);
    await srvA.close();

    // ─────────────────────────────────────────────────────────────────
    section('extraction');
    const uA = await makeUnpacked(tmpDir('unpackedA'), '2.0.0', 'new');
    const zA = path.join(tmpDir('zips'), 'a.zip');
    await zipDir(uA, zA);
    const wdA = tmpDir('wdA');
    const x = await PU.extractTwice({ StreamZip, zipPath: zA, stageDir: path.join(wdA, 'stage'), incomingDir: path.join(wdA, 'incoming'), fs: FS });
    const srcTree = hashTree(uA);
    ok('stage\\ is an exact copy of the build', sameTree(hashTree(path.join(wdA, 'stage')), srcTree));
    ok('incoming\\ is an exact copy of the build', sameTree(hashTree(path.join(wdA, 'incoming')), srcTree));
    ok('app.asar came out as a FILE', FS.statSync(path.join(wdA, 'incoming', 'resources', 'app.asar')).isFile());
    ok('reported bytes = the sum of the files', x.bytes === sumFiles(uA), [x.bytes, sumFiles(uA)]);
    await rejects('an existing stage folder is never overwritten', PU.extractTwice({ StreamZip, zipPath: zA, stageDir: path.join(wdA, 'stage'), incomingDir: path.join(wdA, 'incoming2'), fs: FS }), /already exists/);
    ok('verifyStagedTree accepts a good tree', PU.verifyStagedTree({ fs: FS, dir: path.join(wdA, 'stage'), exeName: EXE, expectedVersion: '2.0.0', readVersion: (dd2) => PU.readAsarVersion(FS, path.join(dd2, 'resources', 'app.asar')) }));
    throwsSync('verifyStagedTree refuses the wrong version', () => PU.verifyStagedTree({ fs: FS, dir: path.join(wdA, 'stage'), exeName: EXE, expectedVersion: '2.0.1', readVersion: (dd2) => PU.readAsarVersion(FS, path.join(dd2, 'resources', 'app.asar')) }), /reports version 2\.0\.0/);
    throwsSync('verifyStagedTree refuses a tree with no exe', () => PU.verifyStagedTree({ fs: FS, dir: path.join(wdA, 'stage', 'locales'), exeName: EXE, expectedVersion: '2.0.0', readVersion: () => '2.0.0' }), /does not contain/);

    const hostile = new AdmZip();
    hostile.addFile('V.I.P.E.R.exe', Buffer.from('exe'));
    hostile.addFile('cases/26-0001/planted.txt', Buffer.from('x'));
    const zH = path.join(tmpDir('zips'), 'hostile.zip');
    hostile.writeZip(zH);
    const wdH = tmpDir('wdH');
    await rejects('an archive carrying cases\\ is refused', PU.extractTwice({ StreamZip, zipPath: zH, stageDir: path.join(wdH, 'stage'), incomingDir: path.join(wdH, 'incoming'), fs: FS }), /protected/);
    ok('… before a single file is written', FS.readdirSync(wdH).length === 0);

    // ─────────────────────────────────────────────────────────────────
    section('the swap — officer data untouched, byte for byte');
    async function stagedOfficer(oldV, newV) {
        const dir = await makeOfficerFolder(oldV);
        const wd = PU.ensureWorkDir(FS, dir);
        const u = await makeUnpacked(tmpDir('unpacked'), newV, 'new');
        const z = path.join(tmpDir('zips'), 'u.zip');
        await zipDir(u, z);
        await PU.extractTwice({ StreamZip, zipPath: z, stageDir: path.join(wd, 'stage'), incomingDir: path.join(wd, 'incoming'), fs: FS });
        return { dir, wd, unpacked: u };
    }
    const S = await stagedOfficer('5.4.2', '5.4.3');
    const before = hashTree(S.dir, true);
    const newTree = hashTree(S.unpacked);
    const tx1 = PU.newTxId();
    const sw = PU.applySwap({ fs: FS, targetDir: S.dir, txId: tx1, exeName: EXE, renameDelayMs: 5 });
    const after = hashTree(S.dir, true);
    ok('the swap succeeds', sw.ok === true, sw);
    ok('the program is now the new build, exactly', Object.keys(newTree).every(k => after[k] === newTree[k]),
        Object.keys(newTree).filter(k => after[k] !== newTree[k]));
    ok('the new app.asar reads 5.4.3', PU.readAsarVersion(FS, path.join(S.dir, 'resources', 'app.asar')) === '5.4.3');
    ok('userdata\\ is byte-identical', sameTree(subTree(after, 'userdata'), subTree(before, 'userdata')) && Object.keys(subTree(before, 'userdata')).length > 2);
    ok('cases\\ is byte-identical', sameTree(subTree(after, 'cases'), subTree(before, 'cases')) && Object.keys(subTree(before, 'cases')).length > 2);
    ok('.portable is untouched', after['.portable'] === before['.portable']);
    ok('the uninstaller the update does not carry is untouched', after['Uninstall V.I.P.E.R.exe'] === before['Uninstall V.I.P.E.R.exe']);
    ok('a file the officer added is untouched', after['My notes.txt'] === before['My notes.txt']);
    ok('the old version is kept in previous-<tx> until the new one has run',
        sha256(FS.readFileSync(path.join(S.wd, 'previous-' + tx1, EXE))) === before[EXE]);
    ok('the previous resources are intact too', PU.readAsarVersion(FS, path.join(S.wd, 'previous-' + tx1, 'resources', 'app.asar')) === '5.4.2');
    const j1 = PU.readJson(FS, path.join(S.wd, PU.JOURNAL_FILE));
    ok('the journal records completion', j1 && j1.state === 'done' && j1.txId === tx1);
    ok('the exe is swapped LAST', j1.order[j1.order.length - 1] === EXE, j1.order);
    ok('stage\\ (where the helper runs from) is left alone', FS.existsSync(path.join(S.wd, 'stage', EXE)));

    section('after the restart: the new version reads the result and cleans up');
    PU.writeJsonDurable(FS, path.join(S.wd, PU.PREPARED_FILE), { kind: PU.MARKER_KIND, version: '5.4.3' });
    PU.writeJsonDurable(FS, path.join(S.wd, PU.RESULT_FILE), { kind: PU.MARKER_KIND, txId: tx1, to: '5.4.3', ok: true });
    ok('the new version sees "applied"', PU.inspectWorkDir(FS, S.dir, '5.4.3').status === 'applied');
    ok('a stray old copy running would NOT call it applied', PU.inspectWorkDir(FS, S.dir, '5.4.2').status === 'unknown');
    const keep = PU.cleanupWorkDir(FS, S.dir, { keepPrevious: true });
    ok('cleanup can keep the previous version', keep.removed === false && FS.existsSync(path.join(S.wd, 'previous-' + tx1)));
    const cl = PU.cleanupWorkDir(FS, S.dir);
    ok('cleanup removes the whole work folder', cl.removed === true && !FS.existsSync(S.wd), cl);
    const final = hashTree(S.dir);
    ok('… and nothing outside it', sameTree(subTree(final, 'userdata'), subTree(before, 'userdata'))
        && sameTree(subTree(final, 'cases'), subTree(before, 'cases'))
        && final['Uninstall V.I.P.E.R.exe'] === before['Uninstall V.I.P.E.R.exe']
        && final['My notes.txt'] === before['My notes.txt'] && final['.portable'] === before['.portable']);

    section('a failed swap is rolled back to the exact previous tree');
    const R = await stagedOfficer('5.4.2', '5.4.3');
    const rBefore = hashTree(R.dir, true);
    const rIncoming = hashTree(path.join(R.wd, 'incoming'));
    const failingFs = Object.create(FS);
    failingFs.renameSync = (from, to) => {
        // Fail placing locales\ AFTER other entries were already swapped.
        if (/incoming[\\/]locales$/i.test(from)) { const e = new Error('simulated I/O error'); e.code = 'EIO'; throw e; }
        return FS.renameSync(from, to);
    };
    const tx2 = PU.newTxId();
    const rs = PU.applySwap({ fs: failingFs, targetDir: R.dir, txId: tx2, exeName: EXE, renameDelayMs: 5 });
    ok('the swap reports failure', rs.ok === false && /simulated/.test(rs.error), rs);
    ok('… and a clean rollback', rs.rolledBack === true);
    ok('the folder is byte-identical to before', sameTree(hashTree(R.dir, true), rBefore));
    ok('incoming\\ is whole again (a retry is possible)', sameTree(hashTree(path.join(R.wd, 'incoming')), rIncoming));
    ok('no previous-<tx> folder is left', !FS.existsSync(path.join(R.wd, 'previous-' + tx2)));
    const j2 = PU.readJson(FS, path.join(R.wd, PU.JOURNAL_FILE));
    ok('the journal says rolled-back', j2.state === 'rolled-back' && /simulated/.test(j2.error));
    PU.writeJsonDurable(FS, path.join(R.wd, PU.RESULT_FILE), { kind: PU.MARKER_KIND, txId: tx2, to: '5.4.3', ok: false, error: rs.error, rolledBack: true });
    const iR = PU.inspectWorkDir(FS, R.dir, '5.4.2');
    ok('the old version sees a SAFE failure', iR.status === 'failed' && iR.safe === true, iR);

    section('a rollback that cannot complete is reported, never hidden');
    const RI = await stagedOfficer('5.4.2', '5.4.3');
    let placedLocales = false;
    const stuckFs = Object.create(FS);
    stuckFs.renameSync = (from, to) => {
        if (/incoming[\\/]resources$/i.test(from)) { const e = new Error('simulated failure'); e.code = 'EIO'; throw e; }
        if (/previous-[a-z0-9]+[\\/]locales$/i.test(from)) { const e = new Error('cannot restore'); e.code = 'EIO'; throw e; }
        if (/incoming[\\/]locales$/i.test(from)) placedLocales = true;
        return FS.renameSync(from, to);
    };
    const tx3 = PU.newTxId();
    const ri = PU.applySwap({ fs: stuckFs, targetDir: RI.dir, txId: tx3, exeName: EXE, renameTries: 2, renameDelayMs: 5 });
    ok('reported as NOT rolled back', ri.ok === false && ri.rolledBack === false && placedLocales, ri);
    ok('the journal says rollback-incomplete', PU.readJson(FS, path.join(RI.wd, PU.JOURNAL_FILE)).state === 'rollback-incomplete');
    ok('the old copy that could not be restored is still on disk', FS.existsSync(path.join(RI.wd, 'previous-' + tx3, 'locales', 'en-US.pak')));
    PU.writeJsonDurable(FS, path.join(RI.wd, PU.RESULT_FILE), { kind: PU.MARKER_KIND, txId: tx3, to: '5.4.3', ok: false, error: ri.error, rolledBack: false });
    ok('startup sees an UNSAFE failure', PU.inspectWorkDir(FS, RI.dir, '5.4.2').safe === false);
    await rejects('a new update is refused while that is unresolved', PU.prepareUpdate({ fs: FS, exeDir: RI.dir, exeName: EXE, version: '5.4.3', currentVersion: '5.4.2', get: () => { throw new Error('must not download'); }, StreamZip }), /did not finish cleanly/);
    ok('… and the evidence of it is not cleaned away', FS.existsSync(path.join(RI.wd, 'previous-' + tx3)));
    throwsSync('launchHelper also refuses while previous-* exists', () => PU.launchHelper({ fs: FS, spawn: () => { throw new Error('must not spawn'); }, exeDir: RI.dir, exeName: EXE, version: '5.4.3', pid: 1 }));

    section('transient locks are retried');
    const B = await stagedOfficer('5.4.2', '5.4.3');
    let busy = 2;
    const busyFs = Object.create(FS);
    busyFs.renameSync = (from, to) => {
        if (/resources$/i.test(from) && !/incoming/i.test(from) && busy > 0) { busy--; const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e; }
        return FS.renameSync(from, to);
    };
    const bs = PU.applySwap({ fs: busyFs, targetDir: B.dir, txId: PU.newTxId(), exeName: EXE, renameDelayMs: 5 });
    ok('an EBUSY that clears succeeds', bs.ok === true && busy === 0, bs);

    section('pre-flight refusals move nothing');
    const J = await stagedOfficer('5.4.2', '5.4.3');
    const jBefore = hashTree(J.dir, true);
    const jIncoming = hashTree(path.join(J.wd, 'incoming'));
    const realLocales = path.join(J.dir, 'locales');
    const movedLocales = path.join(tmpDir('elsewhere'), 'locales');
    FS.renameSync(realLocales, movedLocales);
    FS.symlinkSync(movedLocales, realLocales, 'junction');
    const jr = PU.applySwap({ fs: FS, targetDir: J.dir, txId: PU.newTxId(), exeName: EXE, renameDelayMs: 5 });
    ok('a junction in the target is refused', jr.ok === false && /link or junction/.test(jr.error), jr);
    FS.unlinkSync(realLocales); FS.renameSync(movedLocales, realLocales);
    ok('… with the folder unchanged', sameTree(hashTree(J.dir, true), jBefore));
    ok('… and incoming\\ unchanged', sameTree(hashTree(path.join(J.wd, 'incoming')), jIncoming));
    ok('… and no previous-* created', !FS.readdirSync(J.wd).some(n => /^previous-/.test(n)));
    FS.mkdirSync(path.join(J.wd, 'incoming', 'userdata'));
    const pr = PU.applySwap({ fs: FS, targetDir: J.dir, txId: PU.newTxId(), exeName: EXE });
    ok('an incoming userdata\\ is refused', pr.ok === false && /protected/.test(pr.error), pr);
    ok('… with the folder unchanged', sameTree(hashTree(J.dir, true), jBefore));
    FS.rmdirSync(path.join(J.wd, 'incoming', 'userdata'));
    FS.unlinkSync(path.join(J.wd, 'incoming', EXE));
    const ne = PU.applySwap({ fs: FS, targetDir: J.dir, txId: PU.newTxId(), exeName: EXE });
    ok('an update with no exe is refused', ne.ok === false && /does not contain/.test(ne.error), ne);
    ok('… with the folder unchanged', sameTree(hashTree(J.dir, true), jBefore));
    const emptyT = tmpDir('noexe');
    PU.ensureWorkDir(FS, emptyT); FS.mkdirSync(path.join(PU.workDirFor(emptyT), 'incoming'));
    const nt = PU.applySwap({ fs: FS, targetDir: emptyT, txId: PU.newTxId(), exeName: EXE });
    ok('a target that is not a VIPER folder is refused', nt.ok === false && /does not contain/.test(nt.error));

    // ─────────────────────────────────────────────────────────────────
    section('work-folder cleanup only ever removes what it created');
    const C1 = tmpDir('clean');
    FS.mkdirSync(path.join(C1, PU.WORK_DIR_NAME));
    write(path.join(C1, PU.WORK_DIR_NAME, 'stage', 'x'), 'x');
    ok('no marker → not removed', PU.cleanupWorkDir(FS, C1).reason === 'no-marker' && FS.existsSync(path.join(C1, PU.WORK_DIR_NAME, 'stage', 'x')));
    ok('no marker → startup calls it unknown', PU.inspectWorkDir(FS, C1, '1.0.0').status === 'unknown');
    await rejects('… and prepare refuses to touch it', PU.prepareUpdate({ fs: FS, exeDir: C1, exeName: EXE, version: '1.0.1', currentVersion: '1.0.0', get: () => { throw new Error('no'); }, StreamZip }), /did not finish cleanly/);
    ok('… leaving it intact', FS.existsSync(path.join(C1, PU.WORK_DIR_NAME, 'stage', 'x')));
    const C2 = tmpDir('clean');
    PU.ensureWorkDir(FS, C2);
    write(path.join(C2, PU.WORK_DIR_NAME, 'stage', 'x'), 'x');
    write(path.join(C2, PU.WORK_DIR_NAME, 'Report.docx'), 'officer file');
    const c2 = PU.cleanupWorkDir(FS, C2);
    ok('a foreign item → nothing removed', c2.removed === false && /foreign/.test(c2.reason) && FS.existsSync(path.join(C2, PU.WORK_DIR_NAME, 'stage', 'x')) && FS.existsSync(path.join(C2, PU.WORK_DIR_NAME, 'Report.docx')), c2);
    const C3 = tmpDir('clean');
    const realWd = tmpDir('realwd');
    write(path.join(realWd, PU.MARKER_FILE), JSON.stringify({ kind: PU.MARKER_KIND }));
    write(path.join(realWd, 'stage', 'keep.txt'), 'keep');
    FS.symlinkSync(realWd, path.join(C3, PU.WORK_DIR_NAME), 'junction');
    const c3 = PU.cleanupWorkDir(FS, C3);
    ok('a junctioned work folder is never followed', c3.removed === false && FS.existsSync(path.join(realWd, 'stage', 'keep.txt')), c3);
    FS.unlinkSync(path.join(C3, PU.WORK_DIR_NAME));
    throwsSync('removeWorkChild refuses names it did not create', () => PU.removeWorkChild(FS, realWd, 'Evidence'), /Not an update work item/);
    ok('absent work folder → nothing to do', PU.cleanupWorkDir(FS, tmpDir('clean')).reason === 'absent');

    section('startup states');
    const st = (setup, cur) => { const dir = tmpDir('st'); const wd = PU.ensureWorkDir(FS, dir); setup(wd); return PU.inspectWorkDir(FS, dir, cur); };
    ok('no work folder → none', PU.inspectWorkDir(FS, tmpDir('st'), '1.0.0').status === 'none');
    ok('marker only → empty', st(() => {}, '1.0.0').status === 'empty');
    ok('prepared newer → prepared, not stale', (() => { const s = st(wd => PU.writeJsonDurable(FS, path.join(wd, PU.PREPARED_FILE), { kind: PU.MARKER_KIND, version: '1.0.1' }), '1.0.0'); return s.status === 'prepared' && !s.stale; })());
    ok('prepared same/older → stale', st(wd => PU.writeJsonDurable(FS, path.join(wd, PU.PREPARED_FILE), { kind: PU.MARKER_KIND, version: '1.0.0' }), '1.0.0').stale === true);
    ok('journal mid-swap, no result → interrupted', st(wd => PU.writeJsonDurable(FS, path.join(wd, PU.JOURNAL_FILE), { kind: PU.MARKER_KIND, txId: 'a1', state: 'swapping' }), '1.0.0').status === 'interrupted');
    ok('journal done, helper died before writing a result, new version running → applied',
        st(wd => { PU.writeJsonDurable(FS, path.join(wd, PU.JOURNAL_FILE), { kind: PU.MARKER_KIND, txId: 'a1', state: 'done' }); PU.writeJsonDurable(FS, path.join(wd, PU.PREPARED_FILE), { kind: PU.MARKER_KIND, version: '1.0.1' }); }, '1.0.1').status === 'applied');
    ok('helper timed out waiting (nothing changed) → safe failure',
        (() => { const s = st(wd => PU.writeJsonDurable(FS, path.join(wd, PU.RESULT_FILE), { kind: PU.MARKER_KIND, txId: 'a1', to: '1.0.1', ok: false, error: 'did not close' }), '1.0.0'); return s.status === 'failed' && s.safe === true && /did not close/.test(s.error); })());
    ok('version compare', PU.compareVersions('5.4.10', '5.4.9') === 1 && PU.compareVersions('5.4.2', '5.4.2') === 0 && PU.compareVersions('5.3.6', '5.4.2') === -1);

    // ─────────────────────────────────────────────────────────────────
    section('end to end: the build script\'s output, through the client, into an officer folder');
    const pkgVersion = require(path.join(REPO, 'package.json')).version;
    const outParent = tmpDir('dist');
    const fakeUnpacked = path.join(outParent, 'win-unpacked');
    await makeUnpacked(fakeUnpacked, pkgVersion, 'built');
    const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE;
    let buildOut = '';
    let buildOk = true;
    try {
        buildOut = childProcess.execFileSync('node', [path.join(REPO, 'scripts', 'build-portable-update.js'), fakeUnpacked], { env, cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    } catch (e) { buildOk = false; buildOut = String(e.stdout || '') + String(e.stderr || ''); }
    ok('the build script runs', buildOk, buildOut);
    const zipName = 'V.I.P.E.R.-' + pkgVersion + '-Portable-Update.zip';
    const manifestPath = path.join(outParent, 'portable-update.json');
    const builtManifest = PU.readJson(FS, manifestPath);
    ok('it writes portable-update.json', !!builtManifest && builtManifest.file === zipName && builtManifest.exe === EXE);
    ok('the manifest checksum is the zip\'s', builtManifest && builtManifest.sha512 === sha512b64(FS.readFileSync(path.join(outParent, zipName))));
    ok('the unpacked size is the build\'s', builtManifest && builtManifest.unpackedSize === sumFiles(fakeUnpacked));
    const listed = new StreamZip.async({ file: path.join(outParent, zipName) });
    const ents = Object.keys(await listed.entries()); await listed.close();
    ok('the program sits at the archive ROOT', ents.indexOf(EXE) !== -1 && ents.indexOf('resources/app.asar') !== -1, ents.slice(0, 6));
    write(path.join(fakeUnpacked, 'cases', 'x.txt'), 'x');
    let refused = false;
    try { childProcess.execFileSync('node', [path.join(REPO, 'scripts', 'build-portable-update.js'), fakeUnpacked], { env, cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { refused = /protected/.test(String(e.stderr) + String(e.stdout)); }
    ok('the build script refuses a tree that carries cases\\', refused);
    FS.rmSync(path.join(fakeUnpacked, 'cases'), { recursive: true });

    const srvB = await startServer({
        [dlPath(pkgVersion, 'portable-update.json')]: { body: FS.readFileSync(manifestPath) },
        [dlPath(pkgVersion, zipName)]: { body: FS.readFileSync(path.join(outParent, zipName)) },
    });
    const officer = await makeOfficerFolder('5.3.9');
    const oBefore = hashTree(officer, true);
    const phases = new Set();
    const prep = await PU.prepareUpdate({
        fs: FS, exeDir: officer, exeName: EXE, version: pkgVersion, currentVersion: '5.3.9',
        get: srvB.get, StreamZip, freeBytes: () => 50 * 1024 * 1024 * 1024,
        onProgress: (p) => phases.add(p.phase),
    });
    ok('prepare succeeds', prep && prep.version === pkgVersion && prep.reused === false);
    ok('it reports download AND extract progress', phases.has('download') && phases.has('extract'), [...phases]);
    const owd = PU.workDirFor(officer);
    ok('the zip is deleted once unpacked (drive space)', !FS.existsSync(path.join(owd, 'download')));
    ok('stage\\ and incoming\\ are the build', sameTree(hashTree(path.join(owd, 'stage')), hashTree(fakeUnpacked)) && sameTree(hashTree(path.join(owd, 'incoming')), hashTree(fakeUnpacked)));
    ok('preparing changed nothing outside the work folder', sameTree(hashTree(officer, true), oBefore));
    const hitsBefore = srvB.hits.length;
    const prep2 = await PU.prepareUpdate({ fs: FS, exeDir: officer, exeName: EXE, version: pkgVersion, currentVersion: '5.3.9', get: srvB.get, StreamZip });
    ok('a second Download reuses the staged copy without downloading', prep2.reused === true && srvB.hits.length === hitsBefore);

    let spawned = null;
    const lh = PU.launchHelper({ fs: FS, spawn: (cmd, args, opts) => { spawned = { cmd, args, opts }; return { unref() {} }; }, exeDir: officer, exeName: EXE, version: pkgVersion, pid: 4242 });
    ok('the helper started is the STAGED new exe', spawned && spawned.cmd === path.join(owd, 'stage', EXE));
    ok('with the frozen command line', JSON.stringify(spawned.args) === JSON.stringify([
        '--viper-apply-portable-update', '--target=' + path.resolve(officer), '--wait-pid=4242', '--tx=' + lh.txId, '--to=' + pkgVersion]), spawned.args);
    ok('detached so it outlives this process', spawned.opts.detached === true);
    ok('the helper would accept that target', PU.helperTargetIsValid(spawned.cmd, path.resolve(officer)));
    const parsed = PU.parseHelperArgs(['x.exe'].concat(spawned.args));
    ok('the helper parses it back', parsed.target === path.resolve(officer) && parsed.waitPid === 4242 && parsed.txId === lh.txId && parsed.to === pkgVersion);
    throwsSync('launchHelper refuses a version that was not prepared', () => PU.launchHelper({ fs: FS, spawn: () => ({}), exeDir: officer, exeName: EXE, version: '0.0.1', pid: 1 }), /not ready/);

    const es = PU.applySwap({ fs: FS, targetDir: officer, txId: lh.txId, exeName: EXE, renameDelayMs: 5 });
    ok('the swap succeeds', es.ok === true, es);
    PU.writeJsonDurable(FS, path.join(owd, PU.RESULT_FILE), { kind: PU.MARKER_KIND, txId: lh.txId, to: pkgVersion, ok: true });
    ok('the new version reports applied', PU.inspectWorkDir(FS, officer, pkgVersion).status === 'applied');
    ok('cleanup succeeds', PU.cleanupWorkDir(FS, officer).removed === true);
    const oAfter = hashTree(officer, true);
    ok('the folder now runs ' + pkgVersion, PU.readAsarVersion(FS, path.join(officer, 'resources', 'app.asar')) === pkgVersion);
    ok('userdata\\ and cases\\ are byte-identical end to end',
        sameTree(subTree(oAfter, 'userdata'), subTree(oBefore, 'userdata')) && sameTree(subTree(oAfter, 'cases'), subTree(oBefore, 'cases')));
    ok('the uninstaller, .portable and the officer\'s own file are untouched',
        ['Uninstall V.I.P.E.R.exe', 'uninstallerIcon.ico', '.portable', 'My notes.txt'].every(k => oAfter[k] === oBefore[k]));

    section('prepare failures leave nothing behind');
    const badManifest = Object.assign({}, builtManifest, { sha512: sha512b64(Buffer.from('wrong')) });
    const srvC = await startServer({
        [dlPath(pkgVersion, 'portable-update.json')]: { body: Buffer.from(JSON.stringify(badManifest)) },
        [dlPath(pkgVersion, zipName)]: { body: FS.readFileSync(path.join(outParent, zipName)) },
    });
    const off2 = await makeOfficerFolder('5.3.9');
    const off2Before = hashTree(off2);
    await rejects('a tampered download is refused', PU.prepareUpdate({ fs: FS, exeDir: off2, exeName: EXE, version: pkgVersion, currentVersion: '5.3.9', get: srvC.get, StreamZip }), /integrity/);
    ok('… and the folder is exactly as it was', sameTree(hashTree(off2), off2Before));
    await rejects('a full drive is refused before downloading', PU.prepareUpdate({ fs: FS, exeDir: off2, exeName: EXE, version: pkgVersion, currentVersion: '5.3.9', get: srvB.get, StreamZip, freeBytes: () => 1024 }), /not enough free space/);
    ok('… and the folder is exactly as it was', sameTree(hashTree(off2), off2Before));
    const roFs = Object.create(FS);
    roFs.mkdirSync = () => { const e = new Error('EPERM: operation not permitted'); e.code = 'EPERM'; throw e; };
    await rejects('a folder VIPER cannot write to gets a plain explanation', PU.prepareUpdate({ fs: roFs, exeDir: off2, exeName: EXE, version: pkgVersion, currentVersion: '5.3.9', get: srvB.get, StreamZip }), /cannot write to its own folder.*project-viper\.com/);
    await srvB.close(); await srvC.close();

    // ─────────────────────────────────────────────────────────────────
    section('the helper\'s own guards');
    const stageExe = 'F:\\VIPER\\V.I.P.E.R\\.viper-update\\stage\\V.I.P.E.R.exe';
    ok('valid: running from <target>\\.viper-update\\stage', PU.helperTargetIsValid(stageExe, 'F:\\VIPER\\V.I.P.E.R'));
    ok('valid regardless of case / trailing slash', PU.helperTargetIsValid(stageExe, 'f:\\viper\\v.i.p.e.r\\'));
    ok('refused: a different target', !PU.helperTargetIsValid(stageExe, 'C:\\Windows'));
    ok('refused: a parent of the folder', !PU.helperTargetIsValid(stageExe, 'F:\\VIPER'));
    ok('refused: not running from stage\\', !PU.helperTargetIsValid('F:\\VIPER\\V.I.P.E.R\\V.I.P.E.R.exe', 'F:\\'));
    ok('refused: a look-alike work folder', !PU.helperTargetIsValid('F:\\X\\.viper-updatex\\stage\\V.I.P.E.R.exe', 'F:\\X'));
    ok('refused: empty target', !PU.helperTargetIsValid(stageExe, ''));
    ok('args with spaces round-trip', PU.parseHelperArgs(PU.helperArgs({ target: 'F:\\My Drive\\V.I.P.E.R', waitPid: 7, txId: 'abc1', to: '5.4.3' })).target === 'F:\\My Drive\\V.I.P.E.R');
    ok('a missing pid parses as 0 (the helper then has nothing to wait for)', PU.parseHelperArgs([PU.HELPER_FLAG]).waitPid === 0);
    ok('this process is alive', PU.pidAlive(process.pid) === true);
    ok('pid 0 is not', PU.pidAlive(0) === false);
    const child = childProcess.spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    const deadPid = child.pid;
    await new Promise(res => child.on('exit', res));
    await new Promise(res => setTimeout(res, 200));
    ok('an exited process is not', PU.pidAlive(deadPid) === false);
    ok('transaction ids are path-safe and unique', /^[a-z0-9]+$/.test(PU.newTxId()) && PU.newTxId() !== PU.newTxId());

    // ─────────────────────────────────────────────────────────────────
    section('electron-main.js wiring');
    const MAIN = FS.readFileSync(path.join(REPO, 'electron-main.js'), 'utf8').replace(/\r\n/g, '\n');
    const flagAt = MAIN.indexOf("process.argv.includes('--viper-apply-portable-update')");
    ok('the helper branch exists', flagAt !== -1);
    ok('… before ANY other startup code (data folders, single-instance lock, updater)',
        ['uc-chat-main.js', 'requestSingleInstanceLock', "app.setPath('userData'", "require('electron-updater')", 'mkdirSync']
            .every(s => { const i = MAIN.indexOf(s); return i === -1 || i > flagAt; }));
    ok('… and it returns straight after handing off', /runHelper\(electron, process\.argv\);\n\s*return;\n\}/.test(MAIN.slice(flagAt, flagAt + 300)));
    const dlAt = MAIN.indexOf("ipcMain.handle('update-download'");
    const dlBody = MAIN.slice(dlAt, MAIN.indexOf('});', MAIN.indexOf('autoUpdater.downloadUpdate()', dlAt)));
    ok('update-download routes ONLY folder mode away, before the NSIS download',
        /if \(_portableUpdateMode\(\)\.mode === 'folder'\) return _portableDownload\(\);/.test(dlBody)
        && dlBody.indexOf('_portableDownload') < dlBody.indexOf('autoUpdater.downloadUpdate()'));
    const inAt = MAIN.indexOf("ipcMain.handle('update-install'");
    const inBody = MAIN.slice(inAt, MAIN.indexOf('quitAndInstall(false, true)', inAt));
    ok('update-install routes ONLY folder mode away, before quitAndInstall',
        /if \(_portableUpdateMode\(\)\.mode === 'folder'\) return _portableInstall\(\);/.test(inBody));
    ok('the NSIS install path is still there, unchanged', MAIN.indexOf('autoUpdater.quitAndInstall(false, true);') !== -1
        && MAIN.indexOf("cacheDirs.push(path.join(process.env.LOCALAPPDATA, 'viper-electron-updater', 'pending'));") !== -1);
    ok('the mode is decided from the same isPortable the app uses for its data', /decideUpdateMode\(\{[\s\S]{0,200}isPortable,[\s\S]{0,200}exeDir,/.test(MAIN));
    ok('the swap and extraction use original-fs', /require\('original-fs'\)/.test(MAIN));
    ok('package.json chains the portable build after verification',
        /verify-package\.js && node scripts\/build-portable-update\.js/.test(FS.readFileSync(path.join(REPO, 'package.json'), 'utf8')));

    try { FS.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch (_) {}
    console.log('\n' + (failed ? 'FAILED' : 'OK') + ' \u2014 ' + passed + ' passed, ' + failed + ' failed');
    process.exit(failed ? 1 : 0);
})().catch((e) => {
    console.log('CRASH ' + (e && e.stack || e));
    try { FS.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
    process.exit(1);
});

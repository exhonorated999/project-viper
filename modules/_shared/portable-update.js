'use strict';
/**
 * Portable-folder self-update — MAIN PROCESS ONLY.
 *
 * WHY THIS EXISTS
 *   Officers run VIPER from a folder on an external drive (e.g.
 *   F:\VIPER\V.I.P.E.R\ with userdata\ and cases\ beside the exe). The normal
 *   updater hands the update to the NSIS Setup.exe, and a per-user NSIS
 *   install goes wherever HKCU\Software\<APP_GUID>\InstallLocation says — or
 *   to %LOCALAPPDATA%\Programs\V.I.P.E.R when nothing is registered. For a
 *   folder that is not the registered install, the update lands on C:, the
 *   officer relaunches the drive copy, and it is still the old version.
 *   Passing /D= to NSIS is NOT a fix: during an update NSIS first runs the
 *   uninstaller of whatever HKCU registers, which can be a real desktop copy.
 *
 * DESKTOP USERS ARE NOT AFFECTED
 *   decideUpdateMode() returns 'nsis' (the unchanged, pre-existing path) for
 *   every desktop install: anything not in portable mode, the single-file
 *   Portable.exe, dev builds, and a portable-mode folder that IS the folder
 *   NSIS would update anyway. It also returns 'nsis' whenever the registry
 *   cannot be read. Only a portable folder that NSIS would provably miss
 *   takes the folder path.
 *
 * THE FOLDER PATH
 *   1. prepare (while the officer keeps working): fetch portable-update.json
 *      from the release, stream the zip to <exeDir>\.viper-update\, verify its
 *      SHA-512, extract it twice — stage\ (the helper that will run) and
 *      incoming\ (the payload that will be swapped in) — and check that the
 *      payload really is the expected version.
 *   2. install: launch stage\V.I.P.E.R.exe with HELPER_FLAG and quit.
 *   3. helper: wait for the old process to exit, then swap top-level entries
 *      by RENAME ONLY — old entry → previous-<tx>\, incoming entry → target.
 *      Nothing is deleted during the swap, so every byte of the old version
 *      survives any failure, and a failure is rolled back by renaming back.
 *      The exe is swapped LAST so the folder keeps a runnable exe as long as
 *      possible. userdata\, cases\, .portable and .viper-update are never
 *      touched, and neither is anything in the folder that the update does
 *      not contain (e.g. "Uninstall V.I.P.E.R.exe").
 *   4. the new version, once it has been up for a while, removes the work
 *      folder (including previous-<tx>\). Until then the old version is kept.
 *
 * THE HELPER COMMAND LINE IS A FROZEN CONTRACT between version N (which
 * spawns it) and version N+1 (which runs it). Never rename these flags:
 *   --viper-apply-portable-update --target=<dir> --wait-pid=<n> --tx=<id> --to=<ver>
 */

const path = require('path');
const crypto = require('crypto');

const WORK_DIR_NAME = '.viper-update';
const MARKER_FILE = 'viper-update.json';
const MARKER_KIND = 'viper-portable-update';
const PREPARED_FILE = 'prepared.json';
const JOURNAL_FILE = 'journal.json';
const RESULT_FILE = 'result.json';
const HELPER_FLAG = '--viper-apply-portable-update';
const MANIFEST_NAME = 'portable-update.json';
const RELEASE_BASE = 'https://github.com/exhonorated999/project-viper/releases/download';
// electron-builder: UUID.v5(appId 'com.intellect.viper', its fixed namespace
// 50e065bc-3134-11e6-9bab-38c9862bdaf3). Pinned by a test that recomputes it.
const NSIS_APP_GUID = '4c8c3f0c-9d85-5ae4-a90c-3b6740649473';
const NSIS_APP_FILENAME = 'V.I.P.E.R';
// Top-level names the update may never carry and the swap may never touch.
const PROTECTED_NAMES = ['userdata', 'cases', WORK_DIR_NAME, '.portable'];
const RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const LIMITS = {
    maxEntries: 20000,
    maxTotalBytes: 3 * 1024 * 1024 * 1024,
    maxEntryBytes: 1536 * 1024 * 1024,
    maxManifestBytes: 64 * 1024,
    spareBytes: 200 * 1024 * 1024,
};
const WORK_CHILDREN = /^(download|stage|incoming|previous-[a-z0-9]+|viper-update\.json|prepared\.json|journal\.json|result\.json)$/i;
// A work folder an earlier attempt left in a state that cannot be resumed is
// RENAMED to <exeDir>\.viper-update-old-<id> (5.4.7) so a new update can run.
const RETIRED_PREFIX = WORK_DIR_NAME + '-old-';
const RETIRED_RE = /^\.viper-update-old-[a-z0-9]+$/i;

function isProtectedName(name) {
    const n = String(name || '').toLowerCase();
    return PROTECTED_NAMES.indexOf(n) !== -1;
}

function sleepSync(ms) {
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
    catch (_) { const end = Date.now() + ms; while (Date.now() < end) { /* spin */ } }
}

function newTxId() {
    return Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

// ── Mode decision ────────────────────────────────────────────────────────

/** Canonical, case-folded directory key for comparison on Windows. */
function dirKey(p, fs) {
    if (!p) return '';
    let r = path.resolve(String(p));
    try { if (fs && fs.realpathSync && fs.realpathSync.native) r = fs.realpathSync.native(r); } catch (_) {}
    r = r.replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '');
    return r.toLowerCase();
}

/** Parse `reg query … /v InstallLocation` stdout. Returns the value or null. */
function parseRegQueryOutput(stdout) {
    const m = /^\s*InstallLocation\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/im.exec(String(stdout || ''));
    return m ? m[1] : null;
}

/**
 * Read HKCU\Software\<GUID>\InstallLocation — the exact value the per-user
 * NSIS installer reads (multiUser.nsh setInstallModePerUser).
 * → {ok:true, value:string|null} | {ok:false, error}
 */
function readHkcuInstallLocation(execFileSync) {
    try {
        const out = execFileSync('reg', ['query', 'HKCU\\Software\\' + NSIS_APP_GUID, '/v', 'InstallLocation'],
            { windowsHide: true, timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] });
        return { ok: true, value: parseRegQueryOutput(out.toString()) };
    } catch (e) {
        // reg.exe exits 1 when the key or value does not exist.
        if (e && e.status === 1) return { ok: true, value: null };
        return { ok: false, error: (e && e.message) || String(e) };
    }
}

/**
 * Decide which updater a running copy uses.
 *   o = { isPackaged, platform, isPortable, portableExecutableFile, exeDir,
 *         localAppData, readRegisteredLocation(), fs }
 * readRegisteredLocation is ONLY called for a portable-mode folder, so
 * desktop installs never even query the registry.
 */
function decideUpdateMode(o) {
    if (!o.isPackaged) return { mode: 'nsis', reason: 'dev' };
    if (o.platform !== 'win32') return { mode: 'nsis', reason: 'not-windows' };
    if (o.portableExecutableFile) return { mode: 'nsis', reason: 'single-file-portable' };
    if (!o.isPortable) return { mode: 'nsis', reason: 'desktop-install' };
    let reg;
    try { reg = o.readRegisteredLocation(); } catch (e) { reg = { ok: false, error: e.message }; }
    if (!reg || !reg.ok) return { mode: 'nsis', reason: 'registry-unreadable' };
    let predicted = reg.value;
    if (!predicted) {
        if (!o.localAppData) return { mode: 'nsis', reason: 'no-localappdata' };
        predicted = path.join(o.localAppData, 'Programs', NSIS_APP_FILENAME);
    }
    if (dirKey(predicted, o.fs) === dirKey(o.exeDir, o.fs)) {
        return { mode: 'nsis', reason: 'nsis-updates-this-folder', predicted };
    }
    return { mode: 'folder', reason: reg.value ? 'registered-elsewhere' : 'not-registered', predicted };
}

// ── Manifest ─────────────────────────────────────────────────────────────

function manifestUrl(version) {
    return RELEASE_BASE + '/v' + encodeURIComponent(version) + '/' + MANIFEST_NAME;
}
function assetUrl(version, file) {
    return RELEASE_BASE + '/v' + encodeURIComponent(version) + '/' + encodeURIComponent(file);
}

function parseManifest(obj, expectedVersion, exeName) {
    if (!obj || typeof obj !== 'object') throw new Error('Update description is unreadable.');
    if (obj.kind !== MARKER_KIND) throw new Error('Update description is not a VIPER portable update.');
    if (String(obj.version) !== String(expectedVersion)) {
        throw new Error('Update description is for version ' + obj.version + ', expected ' + expectedVersion + '.');
    }
    if (typeof obj.file !== 'string' || !/^[A-Za-z0-9._-]+\.zip$/.test(obj.file)) throw new Error('Update file name is invalid.');
    if (!Number.isSafeInteger(obj.size) || obj.size <= 0 || obj.size > LIMITS.maxTotalBytes) throw new Error('Update size is invalid.');
    if (!Number.isSafeInteger(obj.unpackedSize) || obj.unpackedSize <= 0 || obj.unpackedSize > LIMITS.maxTotalBytes) throw new Error('Update unpacked size is invalid.');
    if (typeof obj.sha512 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(obj.sha512)) throw new Error('Update checksum is invalid.');
    if (exeName && String(obj.exe).toLowerCase() !== String(exeName).toLowerCase()) {
        throw new Error('Update is for "' + obj.exe + '", this copy runs "' + exeName + '".');
    }
    return { version: String(obj.version), file: obj.file, size: obj.size, unpackedSize: obj.unpackedSize, sha512: obj.sha512, exe: obj.exe };
}

/** Bytes that must be free on the drive: zip + stage + incoming + spare. */
function requiredFreeBytes(m) {
    return m.size + 2 * m.unpackedSize + LIMITS.spareBytes;
}

// ── Zip entry validation (Windows-aware zip-slip defence) ───────────────

/**
 * entries: [{name, size, isDirectory, attr}] (node-stream-zip shape).
 * → {ok:true, files:[{name,size}], dirs:[name], totalBytes} | {ok:false, error}
 */
function validateEntries(entries) {
    const fail = (error) => ({ ok: false, error });
    if (!Array.isArray(entries) || entries.length === 0) return fail('The update archive is empty.');
    if (entries.length > LIMITS.maxEntries) return fail('The update archive has too many files.');
    const seen = new Set();
    const files = [];
    const dirs = [];
    let total = 0;
    for (const e of entries) {
        const raw = String(e && e.name || '');
        if (!raw) return fail('An archive entry has no name.');
        if (raw.indexOf('\\') !== -1) return fail('Archive entry uses a backslash: ' + raw);
        if (raw.indexOf(':') !== -1) return fail('Archive entry contains a colon: ' + raw);
        if (raw.indexOf('\0') !== -1) return fail('Archive entry contains a null byte.');
        if (raw[0] === '/') return fail('Archive entry is absolute: ' + raw);
        const name = raw.replace(/\/+$/, '');
        const segs = name.split('/');
        for (const s of segs) {
            if (!s || s === '.' || s === '..') return fail('Archive entry has an unsafe path: ' + raw);
            if (/[. ]$/.test(s)) return fail('Archive entry ends in a dot or space: ' + raw);
            if (RESERVED_RE.test(s)) return fail('Archive entry uses a reserved Windows name: ' + raw);
            if (/[<>"|?*\x00-\x1f]/.test(s)) return fail('Archive entry has an invalid character: ' + raw);
        }
        if (isProtectedName(segs[0])) return fail('The update archive contains a protected folder: ' + segs[0]);
        const mode = ((Number(e.attr) >>> 16) & 0o170000);
        if (mode === 0o120000) return fail('The update archive contains a link: ' + raw);
        const key = name.toLowerCase();
        if (seen.has(key)) return fail('The update archive has a duplicate entry: ' + raw);
        seen.add(key);
        if (e.isDirectory) { dirs.push(name); continue; }
        const size = Number(e.size);
        if (!Number.isSafeInteger(size) || size < 0 || size > LIMITS.maxEntryBytes) return fail('Archive entry size is invalid: ' + raw);
        total += size;
        if (total > LIMITS.maxTotalBytes) return fail('The update archive is too large.');
        files.push({ name, size });
    }
    // A file and a directory may not share a path prefix ("a" file + "a/b").
    const fileKeys = new Set(files.map(f => f.name.toLowerCase()));
    for (const f of files) {
        const segs = f.name.split('/');
        for (let i = 1; i < segs.length; i++) {
            if (fileKeys.has(segs.slice(0, i).join('/').toLowerCase())) return fail('Archive entry nests under a file: ' + f.name);
        }
    }
    return { ok: true, files, dirs, totalBytes: total };
}

/** Join a validated posix relative path under root and prove it stays there. */
function safeJoin(root, rel) {
    const base = path.resolve(root);
    const out = path.resolve(base, ...String(rel).split('/'));
    if (out.toLowerCase().indexOf(base.toLowerCase() + path.sep) !== 0) {
        throw new Error('Path escapes the update folder: ' + rel);
    }
    return out;
}

// ── Work folder ──────────────────────────────────────────────────────────

function workDirFor(exeDir) { return path.join(path.resolve(exeDir), WORK_DIR_NAME); }

/** lstat that returns null for missing; throws on a link/junction. */
function lstatNoLink(fs, p) {
    let st;
    try { st = fs.lstatSync(p); } catch (e) { if (e && e.code === 'ENOENT') return null; throw e; }
    if (st.isSymbolicLink()) throw new Error('Refusing to follow a link or junction: ' + p);
    return st;
}

function readJson(fs, p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function writeJsonDurable(fs, p, obj) {
    const tmp = p + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, JSON.stringify(obj, null, 2)); try { fs.fsyncSync(fd); } catch (_) {} }
    finally { fs.closeSync(fd); }
    fs.renameSync(tmp, p);
}

/** Create (or adopt) the work folder and stamp it as ours. */
function ensureWorkDir(fs, exeDir) {
    const wd = workDirFor(exeDir);
    const st = lstatNoLink(fs, wd);
    if (st && !st.isDirectory()) throw new Error(WORK_DIR_NAME + ' exists and is not a folder.');
    if (!st) fs.mkdirSync(wd);
    const mk = path.join(wd, MARKER_FILE);
    const cur = readJson(fs, mk);
    if (!cur || cur.kind !== MARKER_KIND) writeJsonDurable(fs, mk, { kind: MARKER_KIND, createdAt: new Date().toISOString() });
    return wd;
}

/** Remove a child of the work folder (only names we create). */
function removeWorkChild(fs, wd, name) {
    if (!WORK_CHILDREN.test(name)) throw new Error('Not an update work item: ' + name);
    const p = path.join(wd, name);
    const st = lstatNoLink(fs, p);
    if (!st) return;
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
}

/**
 * Remove the whole work folder — only if it is the direct child of exeDir,
 * is not a link, carries our marker, and holds nothing we did not create.
 * → {removed:boolean, reason}
 */
function cleanupWorkDir(fs, exeDir, opts) {
    return cleanupDirAt(fs, workDirFor(exeDir), opts);
}

function cleanupDirAt(fs, wd, opts) {
    const keepPrevious = !!(opts && opts.keepPrevious);
    let st;
    try { st = lstatNoLink(fs, wd); } catch (e) { return { removed: false, reason: e.message }; }
    if (!st) return { removed: false, reason: 'absent' };
    if (!st.isDirectory()) return { removed: false, reason: 'not-a-folder' };
    const mk = readJson(fs, path.join(wd, MARKER_FILE));
    if (!mk || mk.kind !== MARKER_KIND) return { removed: false, reason: 'no-marker' };
    const names = fs.readdirSync(wd);
    const foreign = names.filter(n => !WORK_CHILDREN.test(n) && !/\.tmp$/i.test(n));
    if (foreign.length) return { removed: false, reason: 'foreign-items:' + foreign.join(',') };
    try {
        for (const n of names) {
            if (/\.tmp$/i.test(n)) { try { fs.unlinkSync(path.join(wd, n)); } catch (_) {} continue; }
            if (n.toLowerCase() === MARKER_FILE) continue;
            if (keepPrevious && /^previous-/i.test(n)) continue;
            removeWorkChild(fs, wd, n);
        }
        if (keepPrevious && fs.readdirSync(wd).some(n => /^previous-/i.test(n))) return { removed: false, reason: 'kept-previous' };
        fs.unlinkSync(path.join(wd, MARKER_FILE));
        fs.rmdirSync(wd);
    } catch (e) {
        // Something is still in use (e.g. the helper has not exited yet).
        // Whatever was removed is gone; the rest is retried next start.
        return { removed: false, reason: 'busy:' + ((e && e.code) || e.message) };
    }
    return { removed: true, reason: 'ok' };
}

/**
 * Set a stuck work folder aside by RENAME ONLY (nothing inside is deleted):
 * <exeDir>\.viper-update → <exeDir>\.viper-update-old-<id>. A link/junction is
 * renamed as the link itself, never followed.
 * → {retired:boolean, to?, reason}
 */
function retireWorkDir(fs, exeDir, opts) {
    const wd = workDirFor(exeDir);
    try { fs.lstatSync(wd); }
    catch (e) { return { retired: false, reason: (e && e.code === 'ENOENT') ? 'absent' : ((e && e.code) || e.message) }; }
    const to = path.join(path.dirname(wd), RETIRED_PREFIX + newTxId());
    try { renameRetry(fs, wd, to, (opts && opts.tries) || 6, (opts && opts.delayMs) || 500); }
    catch (e) { return { retired: false, reason: (e && e.code) || (e && e.message) || String(e) }; }
    return { retired: true, to, reason: 'ok' };
}

/**
 * Make room for a new update, whatever an earlier attempt left behind.
 * A tidy leftover is removed; one that is interrupted, failed part-way, not
 * understood, or cannot be removed is retired (renamed aside). Used by the
 * in-app updater and by the drive installer — both then lay down a COMPLETE
 * new program, so nothing in the old folder is needed to finish.
 * → {ok:true, retired?:path} | {ok:false, reason}
 */
function clearWorkDirForUpdate(fs, exeDir, prior, opts) {
    if (!prior || prior.status === 'none') return { ok: true };
    const stuck = prior.status === 'unknown' || prior.status === 'interrupted' || (prior.status === 'failed' && !prior.safe);
    if (!stuck) {
        let c = null;
        try { c = cleanupWorkDir(fs, exeDir); } catch (_) {}
        if (c && c.removed) return { ok: true };
    }
    const r = retireWorkDir(fs, exeDir, opts);
    return r.retired ? { ok: true, retired: r.to } : { ok: false, reason: r.reason };
}

/**
 * Remove retired work folders, with the same checks as cleanupWorkDir (real
 * folder, our marker, only names we create). Called only once a NEW version
 * has been applied and has run, so the old program copies are obsolete.
 * Anything not provably ours is left alone.
 * → [{name, removed, reason}]
 */
function cleanupRetiredWorkDirs(fs, exeDir) {
    const dir = path.resolve(exeDir);
    let names;
    try { names = fs.readdirSync(dir); } catch (_) { return []; }
    return names.filter(n => RETIRED_RE.test(n)).map(n => {
        let r;
        try { r = cleanupDirAt(fs, path.join(dir, n)); } catch (e) { r = { removed: false, reason: e.message }; }
        return { name: n, removed: r.removed, reason: r.reason };
    });
}

// ── Download ─────────────────────────────────────────────────────────────

function readBody(res, limit) {
    return new Promise((resolve, reject) => {
        const chunks = []; let n = 0;
        res.on('data', (c) => { n += c.length; if (n > limit) { try { res.abort && res.abort(); } catch (_) {} reject(new Error('Response too large.')); return; } chunks.push(Buffer.from(c)); });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
        res.on('aborted', () => reject(new Error('Download interrupted.')));
    });
}

async function fetchManifest(get, version, exeName) {
    const res = await get(manifestUrl(version));
    if (res.statusCode === 404) throw new Error('This release has no portable update package. Download the new version from project-viper.com.');
    if (res.statusCode !== 200) throw new Error('Could not read the update description (HTTP ' + res.statusCode + ').');
    const body = await readBody(res, LIMITS.maxManifestBytes);
    let obj;
    try { obj = JSON.parse(body.toString('utf8')); } catch (_) { throw new Error('Update description is unreadable.'); }
    return parseManifest(obj, version, exeName);
}

/**
 * Stream url → dest, verifying size and SHA-512 (base64) before the file is
 * given its final name. A failed or mismatched download is deleted.
 */
function downloadToFile({ get, url, dest, sha512, size, fs, onProgress, stallMs }) {
    const partial = dest + '.partial';
    return new Promise((resolve, reject) => {
        let settled = false;
        let out = null;
        let stallTimer = null;
        const done = (err) => {
            if (settled) return; settled = true;
            if (stallTimer) clearTimeout(stallTimer);
            const finish = () => {
                if (err) { try { fs.unlinkSync(partial); } catch (_) {} reject(err); }
                else resolve(dest);
            };
            if (out) { try { out.end(finish); } catch (_) { finish(); } } else finish();
        };
        Promise.resolve(get(url)).then((res) => {
            if (res.statusCode !== 200) { done(new Error('Update download failed (HTTP ' + res.statusCode + ').')); return; }
            try { fs.unlinkSync(partial); } catch (_) {}
            out = fs.createWriteStream(partial, { flags: 'wx' });
            const hash = crypto.createHash('sha512');
            let got = 0;
            const arm = () => {
                if (stallTimer) clearTimeout(stallTimer);
                stallTimer = setTimeout(() => { try { res.abort && res.abort(); } catch (_) {} done(new Error('The download stalled. Check the connection and try again.')); }, stallMs || 60000);
            };
            arm();
            out.on('error', (e) => done(e));
            res.on('data', (c) => {
                if (settled) return;
                got += c.length;
                if (got > size) { try { res.abort && res.abort(); } catch (_) {} done(new Error('The download is larger than expected.')); return; }
                hash.update(c);
                arm();
                if (!out.write(c) && res.pause) { res.pause(); out.once('drain', () => res.resume && res.resume()); }
                if (onProgress) { try { onProgress(got, size); } catch (_) {} }
            });
            res.on('error', (e) => done(e));
            res.on('aborted', () => done(new Error('Download interrupted.')));
            res.on('end', () => {
                if (settled) return;
                if (got !== size) { done(new Error('The download is incomplete (' + got + ' of ' + size + ' bytes).')); return; }
                const digest = hash.digest('base64');
                if (digest !== sha512) { done(new Error('The downloaded update failed its integrity check and was discarded.')); return; }
                settled = true;
                if (stallTimer) clearTimeout(stallTimer);
                out.end(() => {
                    try {
                        try { fs.unlinkSync(dest); } catch (_) {}
                        fs.renameSync(partial, dest);
                        resolve(dest);
                    } catch (e) { try { fs.unlinkSync(partial); } catch (_) {} reject(e); }
                });
            });
        }).catch((e) => done(e));
    });
}

// ── Extraction ───────────────────────────────────────────────────────────

/**
 * Extract a verified zip into stageDir, then mirror every file into
 * incomingDir. Writes go through the supplied fs (pass original-fs in
 * Electron so a file named app.asar is treated as a plain file).
 */
async function extractTwice({ StreamZip, zipPath, stageDir, incomingDir, fs, onProgress }) {
    const zip = new StreamZip.async({ file: zipPath, storeEntries: true });
    try {
        const map = await zip.entries();
        const list = Object.keys(map).map(k => map[k]);
        const v = validateEntries(list);
        if (!v.ok) throw new Error(v.error);
        for (const root of [stageDir, incomingDir]) {
            if (lstatNoLink(fs, root)) throw new Error('Update folder already exists: ' + root);
            fs.mkdirSync(root, { recursive: true });
            for (const d of v.dirs) fs.mkdirSync(safeJoin(root, d), { recursive: true });
        }
        let doneBytes = 0;
        for (const f of v.files) {
            const sp = safeJoin(stageDir, f.name);
            const ip = safeJoin(incomingDir, f.name);
            fs.mkdirSync(path.dirname(sp), { recursive: true });
            fs.mkdirSync(path.dirname(ip), { recursive: true });
            const rs = await zip.stream(f.name);
            await new Promise((resolve, reject) => {
                const ws = fs.createWriteStream(sp, { flags: 'wx' });
                rs.on('error', reject); ws.on('error', reject);
                ws.on('close', resolve);
                rs.pipe(ws);
            });
            if (fs.statSync(sp).size !== f.size) throw new Error('Extracted size mismatch: ' + f.name);
            fs.copyFileSync(sp, ip, fs.constants ? fs.constants.COPYFILE_EXCL : 1);
            if (fs.statSync(ip).size !== f.size) throw new Error('Copied size mismatch: ' + f.name);
            doneBytes += f.size;
            if (onProgress) { try { onProgress(doneBytes, v.totalBytes); } catch (_) {} }
        }
        return { files: v.files.length, bytes: v.totalBytes };
    } finally {
        try { await zip.close(); } catch (_) {}
    }
}

/**
 * Read "version" from package.json inside an app.asar WITHOUT Electron's
 * asar support (which would cache an open handle on the archive and stop
 * the folder from being renamed or removed later). Asar layout: a 16-byte
 * pickle prefix [4][headerPickleSize][payloadSize][jsonLen], the JSON
 * header, then file contents starting at 8 + headerPickleSize.
 */
function readAsarVersion(fs, asarPath) {
    const fd = fs.openSync(asarPath, 'r');
    try {
        const head = Buffer.alloc(16);
        if (fs.readSync(fd, head, 0, 16, 0) !== 16) throw new Error('The update program archive is truncated.');
        const headerSize = head.readUInt32LE(4);
        const jsonLen = head.readUInt32LE(12);
        if (!jsonLen || jsonLen > 64 * 1024 * 1024 || jsonLen + 8 > headerSize) throw new Error('The update program archive is unreadable.');
        const jbuf = Buffer.alloc(jsonLen);
        if (fs.readSync(fd, jbuf, 0, jsonLen, 16) !== jsonLen) throw new Error('The update program archive is truncated.');
        const header = JSON.parse(jbuf.toString('utf8'));
        const ent = header && header.files && header.files['package.json'];
        if (!ent || ent.unpacked || !Number.isSafeInteger(ent.size) || ent.size <= 0 || ent.size > 1024 * 1024) {
            throw new Error('The update program archive has no readable package.json.');
        }
        const off = 8 + headerSize + Number(ent.offset);
        if (!Number.isSafeInteger(off)) throw new Error('The update program archive is unreadable.');
        const pbuf = Buffer.alloc(ent.size);
        if (fs.readSync(fd, pbuf, 0, ent.size, off) !== ent.size) throw new Error('The update program archive is truncated.');
        const pkg = JSON.parse(pbuf.toString('utf8'));
        if (!pkg || typeof pkg.version !== 'string') throw new Error('The update has no version number.');
        return pkg.version;
    } finally {
        fs.closeSync(fd);
    }
}

/** Check a staged tree is a runnable VIPER of the expected version. */
function verifyStagedTree({ fs, dir, exeName, expectedVersion, readVersion }) {
    const names = fs.readdirSync(dir);
    const lower = names.map(n => n.toLowerCase());
    if (lower.indexOf(String(exeName).toLowerCase()) === -1) throw new Error('The update does not contain ' + exeName + '.');
    if (lower.indexOf('resources') === -1) throw new Error('The update does not contain its resources folder.');
    const asar = path.join(dir, 'resources', 'app.asar');
    const st = fs.statSync(asar);
    if (!st.isFile() || st.size < 1024) throw new Error('The update program archive is missing or empty.');
    for (const n of names) if (isProtectedName(n)) throw new Error('The update contains a protected folder: ' + n);
    const v = readVersion(dir);
    if (String(v) !== String(expectedVersion)) throw new Error('The update reports version ' + v + ', expected ' + expectedVersion + '.');
    return true;
}

// ── The swap (helper side) ───────────────────────────────────────────────

const RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EEXIST']);

function renameRetry(fs, from, to, tries, delayMs) {
    let last;
    for (let i = 0; i < (tries || 20); i++) {
        try { fs.renameSync(from, to); return; }
        catch (e) { last = e; if (!RETRY_CODES.has(e && e.code)) throw e; sleepSync(delayMs || 500); }
    }
    throw last;
}

/**
 * Swap incoming\ into targetDir by rename only.
 *   → {ok:true, swapped:[names]} | {ok:false, error, rolledBack:boolean}
 * Journal is written before every step so an interruption leaves an exact
 * record of where every entry is.
 */
function applySwap({ fs, targetDir, txId, exeName, renameTries, renameDelayMs }) {
    const wd = workDirFor(targetDir);
    const incoming = path.join(wd, 'incoming');
    const previous = path.join(wd, 'previous-' + txId);
    const journalPath = path.join(wd, JOURNAL_FILE);
    const tries = renameTries || 20, delay = renameDelayMs || 500;

    // Pre-flight: nothing is moved unless every check passes.
    lstatNoLink(fs, wd);
    if (!lstatNoLink(fs, incoming)) return { ok: false, error: 'The prepared update is missing.', rolledBack: true };
    if (!lstatNoLink(fs, path.join(targetDir, exeName))) return { ok: false, error: 'The target folder does not contain ' + exeName + '.', rolledBack: true };
    if (lstatNoLink(fs, previous)) return { ok: false, error: 'A previous update backup already exists.', rolledBack: true };
    let names;
    try {
        names = fs.readdirSync(incoming);
        const seen = new Set();
        for (const n of names) {
            if (isProtectedName(n)) throw new Error('The update contains a protected folder: ' + n);
            if (seen.has(n.toLowerCase())) throw new Error('Duplicate entry: ' + n);
            seen.add(n.toLowerCase());
            lstatNoLink(fs, path.join(incoming, n));
            lstatNoLink(fs, path.join(targetDir, n));
        }
        if (!seen.has(String(exeName).toLowerCase())) throw new Error('The update does not contain ' + exeName + '.');
    } catch (e) {
        return { ok: false, error: e.message, rolledBack: true };
    }
    // Exe last: the folder keeps a runnable exe for as long as possible.
    names.sort((a, b) => {
        const ax = a.toLowerCase() === exeName.toLowerCase(), bx = b.toLowerCase() === exeName.toLowerCase();
        return ax === bx ? a.localeCompare(b) : (ax ? 1 : -1);
    });

    fs.mkdirSync(previous);
    const journal = { kind: MARKER_KIND, txId, state: 'swapping', startedAt: new Date().toISOString(), order: names, steps: [] };
    const save = () => { try { writeJsonDurable(fs, journalPath, journal); } catch (_) {} };
    save();

    const moved = [];   // names whose old copy is in previous\
    const placed = [];  // names whose new copy is in target
    try {
        for (const n of names) {
            const t = path.join(targetDir, n);
            if (fs.existsSync(t)) {
                journal.steps.push({ op: 'backup', name: n }); save();
                renameRetry(fs, t, path.join(previous, n), tries, delay);
                moved.push(n);
            }
            journal.steps.push({ op: 'place', name: n }); save();
            renameRetry(fs, path.join(incoming, n), t, tries, delay);
            placed.push(n);
        }
        journal.state = 'done'; journal.finishedAt = new Date().toISOString(); save();
        return { ok: true, swapped: names.slice() };
    } catch (err) {
        let clean = true;
        for (const n of placed.slice().reverse()) {
            try { renameRetry(fs, path.join(targetDir, n), path.join(incoming, n), tries, delay); }
            catch (_) { clean = false; }
        }
        for (const n of moved.slice().reverse()) {
            try { renameRetry(fs, path.join(previous, n), path.join(targetDir, n), tries, delay); }
            catch (_) { clean = false; }
        }
        if (clean) { try { fs.rmdirSync(previous); } catch (_) { /* leave it; harmless */ } }
        journal.state = clean ? 'rolled-back' : 'rollback-incomplete';
        journal.error = (err && err.message) || String(err);
        save();
        return { ok: false, error: journal.error, rolledBack: clean };
    }
}

// ── Orchestration (the running copy's side) ─────────────────────────────

function compareVersions(a, b) {
    const pa = String(a || '').split(/[.+-]/).slice(0, 3).map(n => parseInt(n, 10) || 0);
    const pb = String(b || '').split(/[.+-]/).slice(0, 3).map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1;
    return 0;
}

/**
 * What an earlier update attempt left in this folder.
 *   none        — no work folder
 *   applied     — the swap succeeded and this IS the new version
 *   failed      — the helper did not apply it; `safe` = nothing was left half-moved
 *   interrupted — a swap started and never finished (power loss, drive pulled)
 *   prepared    — downloaded and staged, not yet installed; `stale` if not newer
 *   empty       — only our marker / partial download
 *   unknown     — not ours, or not understood: never touch it
 */
function inspectWorkDir(fs, exeDir, currentVersion) {
    const wd = workDirFor(exeDir);
    let st;
    try { st = lstatNoLink(fs, wd); } catch (e) { return { status: 'unknown', reason: e.message, workDir: wd }; }
    if (!st) return { status: 'none', workDir: wd };
    if (!st.isDirectory()) return { status: 'unknown', reason: 'not-a-folder', workDir: wd };
    const mk = readJson(fs, path.join(wd, MARKER_FILE));
    if (!mk || mk.kind !== MARKER_KIND) return { status: 'unknown', reason: 'no-marker', workDir: wd };
    const result = readJson(fs, path.join(wd, RESULT_FILE));
    let journal = readJson(fs, path.join(wd, JOURNAL_FILE));
    if (journal && journal.kind !== MARKER_KIND) journal = null;
    const prepared = readJson(fs, path.join(wd, PREPARED_FILE));
    if (result && result.kind === MARKER_KIND) {
        if (journal && result.txId && journal.txId !== result.txId) journal = null;
        if (result.ok) {
            if (compareVersions(result.to, currentVersion) === 0) return { status: 'applied', to: result.to, txId: result.txId, workDir: wd };
            return { status: 'unknown', reason: 'applied-version-mismatch', to: result.to, workDir: wd };
        }
        const safe = result.rolledBack !== false && (!journal || journal.state === 'rolled-back');
        return { status: 'failed', safe, to: result.to, error: result.error || '', txId: result.txId, workDir: wd };
    }
    if (journal) {
        if (journal.state === 'done' && prepared && compareVersions(prepared.version, currentVersion) === 0) {
            return { status: 'applied', to: prepared.version, txId: journal.txId, workDir: wd };
        }
        return { status: 'interrupted', txId: journal.txId, state: journal.state, workDir: wd };
    }
    if (prepared && prepared.kind === MARKER_KIND) {
        return { status: 'prepared', version: String(prepared.version), stale: compareVersions(prepared.version, currentVersion) <= 0, workDir: wd };
    }
    return { status: 'empty', workDir: wd };
}

/**
 * Download, verify and stage version `o.version` into <exeDir>\.viper-update.
 *   o = { fs, exeDir, exeName, version, currentVersion, get, StreamZip,
 *         readVersion(dir), freeBytes(dir)?, onProgress({phase,transferred,total})?, stallMs? }
 * → { version, reused, stageExe }
 */
async function prepareUpdate(o) {
    const fs = o.fs;
    const prior = inspectWorkDir(fs, o.exeDir, o.currentVersion);
    const wdPath = workDirFor(o.exeDir);
    const stageDir = path.join(wdPath, 'stage');
    const incomingDir = path.join(wdPath, 'incoming');
    const readVersion = o.readVersion || ((dir) => readAsarVersion(fs, path.join(dir, 'resources', 'app.asar')));
    const verifyBoth = () => {
        verifyStagedTree({ fs, dir: stageDir, exeName: o.exeName, expectedVersion: o.version, readVersion });
        verifyStagedTree({ fs, dir: incomingDir, exeName: o.exeName, expectedVersion: o.version, readVersion });
    };
    if (prior.status === 'prepared' && !prior.stale && prior.version === String(o.version)) {
        try { verifyBoth(); return { version: String(o.version), reused: true, stageExe: path.join(stageDir, o.exeName) }; }
        catch (_) { /* fall through: start fresh */ }
    }
    // Anything an earlier attempt left (even one that did not finish cleanly)
    // is removed or set aside — never a dead end for the officer.
    const clr = clearWorkDirForUpdate(fs, o.exeDir, prior, o.retireOpts);
    if (!clr.ok) throw new Error('Files from an earlier update could not be moved out of the way (' + clr.reason + '). Restart the computer and try again.');
    let wd;
    try { wd = ensureWorkDir(fs, o.exeDir); }
    catch (e) {
        throw new Error('VIPER cannot write to its own folder (' + path.resolve(o.exeDir) + '), so it cannot update itself there. '
            + 'Download the new version from project-viper.com. (' + ((e && e.code) || (e && e.message) || e) + ')');
    }
    const progress = (phase) => (done, total) => { if (o.onProgress) { try { o.onProgress({ phase, transferred: done, total }); } catch (_) {} } };
    try {
        const m = await fetchManifest(o.get, o.version, o.exeName);
        if (o.freeBytes) {
            let free = NaN;
            try { free = o.freeBytes(wd); } catch (_) {}
            const need = requiredFreeBytes(m);
            if (Number.isFinite(free) && free < need) {
                throw new Error('There is not enough free space on this drive for the update (about ' + Math.ceil(need / 1048576) + ' MB is needed).');
            }
        }
        const dl = path.join(wd, 'download');
        fs.mkdirSync(dl);
        const zipPath = path.join(dl, m.file);
        await downloadToFile({ get: o.get, url: assetUrl(o.version, m.file), dest: zipPath, sha512: m.sha512, size: m.size, fs, onProgress: progress('download'), stallMs: o.stallMs });
        const x = await extractTwice({ StreamZip: o.StreamZip, zipPath, stageDir, incomingDir, fs, onProgress: progress('extract') });
        if (x.bytes !== m.unpackedSize) throw new Error('The update unpacked to an unexpected size.');
        verifyBoth();
        removeWorkChild(fs, wd, 'download');
        writeJsonDurable(fs, path.join(wd, PREPARED_FILE), { kind: MARKER_KIND, version: String(o.version), exe: o.exeName, sha512: m.sha512, preparedAt: new Date().toISOString() });
        return { version: String(o.version), reused: false, stageExe: path.join(stageDir, o.exeName) };
    } catch (e) {
        try { cleanupWorkDir(fs, o.exeDir); } catch (_) {}
        throw e;
    }
}

/**
 * Start the staged helper. The caller must quit immediately afterwards
 * (the helper waits for `pid` to exit before touching anything).
 */
function launchHelper({ fs, spawn, exeDir, exeName, version, pid }) {
    const wd = workDirFor(exeDir);
    const prepared = readJson(fs, path.join(wd, PREPARED_FILE));
    if (!prepared || prepared.kind !== MARKER_KIND || String(prepared.version) !== String(version)) {
        throw new Error('The update is not ready. Download it again.');
    }
    const stageExe = path.join(wd, 'stage', exeName);
    if (!lstatNoLink(fs, stageExe)) throw new Error('The update is incomplete. Download it again.');
    if (!lstatNoLink(fs, path.join(wd, 'incoming', exeName))) throw new Error('The update is incomplete. Download it again.');
    if (fs.readdirSync(wd).some(n => /^previous-/i.test(n))) {
        throw new Error('An earlier update in this folder did not finish cleanly. Please contact support.');
    }
    for (const n of [RESULT_FILE, JOURNAL_FILE]) { try { fs.unlinkSync(path.join(wd, n)); } catch (_) {} }
    const txId = newTxId();
    const child = spawn(stageExe, helperArgs({ target: path.resolve(exeDir), waitPid: pid, txId, to: String(version) }),
        { detached: true, stdio: 'ignore', cwd: path.join(wd, 'stage'), windowsHide: true });
    if (child && child.unref) child.unref();
    return { txId, stageExe };
}

// ── Helper process ───────────────────────────────────────────────────────

function parseHelperArgs(argv) {
    const get = (k) => {
        const p = '--' + k + '=';
        const a = (argv || []).find(x => typeof x === 'string' && x.indexOf(p) === 0);
        return a ? a.slice(p.length) : '';
    };
    const pid = parseInt(get('wait-pid'), 10);
    return { target: get('target'), waitPid: Number.isFinite(pid) ? pid : 0, txId: get('tx'), to: get('to') };
}

function helperArgs({ target, waitPid, txId, to }) {
    return [HELPER_FLAG, '--target=' + target, '--wait-pid=' + waitPid, '--tx=' + txId, '--to=' + to];
}

/** The helper may only act on the folder whose work dir it is running from. */
function helperTargetIsValid(execPath, target) {
    if (!target || !execPath) return false;
    const expected = path.resolve(path.dirname(execPath), '..', '..');
    const stageDir = path.dirname(path.resolve(execPath));
    return dirKey(expected) === dirKey(target)
        && path.basename(stageDir).toLowerCase() === 'stage'
        && path.basename(path.dirname(stageDir)).toLowerCase() === WORK_DIR_NAME;
}

function pidAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; }
    catch (e) { return !!(e && e.code === 'EPERM'); }
}

/**
 * Entry point when the exe is started with HELPER_FLAG. Must be called
 * before ANY other startup code. Never touches the officer's data.
 */
function runHelper(electron, argv) {
    const { app } = electron;
    const os = require('os');
    const { spawn } = require('child_process');
    // Keep Chromium's profile out of the officer's folder AND out of the
    // desktop install's %APPDATA% profile.
    try { app.setPath('userData', path.join(os.tmpdir(), 'viper-portable-update-helper')); } catch (_) {}
    try { app.disableHardwareAcceleration(); } catch (_) {}
    let fs;
    try { fs = require('original-fs'); } catch (_) { fs = require('fs'); }

    const a = parseHelperArgs(argv);
    const exeName = path.basename(process.execPath);
    const finish = (relaunch) => {
        if (relaunch) {
            try {
                const exe = path.join(a.target, exeName);
                if (fs.existsSync(exe)) spawn(exe, [], { detached: true, stdio: 'ignore', cwd: a.target }).unref();
            } catch (_) {}
        }
        try { app.exit(0); } catch (_) { process.exit(0); }
    };
    const writeResult = (obj) => {
        try { writeJsonDurable(fs, path.join(workDirFor(a.target), RESULT_FILE), Object.assign({ kind: MARKER_KIND, txId: a.txId, to: a.to, at: new Date().toISOString() }, obj)); } catch (_) {}
    };

    app.whenReady().then(() => {
        if (!helperTargetIsValid(process.execPath, a.target) || !a.txId || !/^[a-z0-9]+$/i.test(a.txId)) {
            finish(false); return;
        }
        // Wait for the old copy to exit. If it never does, change nothing.
        const deadline = Date.now() + 90000;
        const tick = () => {
            if (pidAlive(a.waitPid) && Date.now() < deadline) { setTimeout(tick, 300); return; }
            if (pidAlive(a.waitPid)) {
                writeResult({ ok: false, error: 'VIPER did not close, so the update was not applied. Nothing was changed.' });
                finish(false); return;
            }
            setTimeout(() => {
                let r;
                try { r = applySwap({ fs, targetDir: a.target, txId: a.txId, exeName }); }
                catch (e) { r = { ok: false, error: e.message, rolledBack: false }; }
                writeResult(r.ok ? { ok: true } : { ok: false, error: r.error, rolledBack: !!r.rolledBack });
                finish(true);
            }, 1500);
        };
        tick();
    });
}

module.exports = {
    WORK_DIR_NAME, MARKER_FILE, MARKER_KIND, PREPARED_FILE, JOURNAL_FILE, RESULT_FILE,
    HELPER_FLAG, MANIFEST_NAME, RELEASE_BASE, NSIS_APP_GUID, NSIS_APP_FILENAME, PROTECTED_NAMES, LIMITS,
    isProtectedName, dirKey, parseRegQueryOutput, readHkcuInstallLocation, decideUpdateMode,
    manifestUrl, assetUrl, parseManifest, requiredFreeBytes,
    validateEntries, safeJoin,
    workDirFor, lstatNoLink, readJson, writeJsonDurable, ensureWorkDir, removeWorkChild, cleanupWorkDir,
    RETIRED_PREFIX, retireWorkDir, clearWorkDirForUpdate, cleanupRetiredWorkDirs,
    readBody, fetchManifest, downloadToFile,
    extractTwice, readAsarVersion, verifyStagedTree,
    renameRetry, applySwap,
    compareVersions, inspectWorkDir, prepareUpdate, launchHelper,
    parseHelperArgs, helperArgs, helperTargetIsValid, pidAlive, runHelper, newTxId,
};

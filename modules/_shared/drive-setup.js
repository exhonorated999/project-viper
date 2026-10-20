'use strict';
/**
 * Drive-copy update run by the INSTALLER — MAIN PROCESS ONLY.
 *
 * WHY THIS EXISTS
 *   VIPER folders on external drives that run 5.4.1 or older cannot update
 *   themselves: their updater hands the update to Setup.exe, and the per-user
 *   NSIS install lands on C: (or, where the drive folder is registered
 *   per-machine, fails for want of admin rights). 5.4.2 added an in-app folder
 *   updater, but an old copy has to reach 5.4.2+ once before it can use it.
 *
 *   From 5.4.3 Setup.exe itself recognises a drive copy (build/installer.nsh,
 *   preInit): either because the old drive copy launched it (its in-app
 *   "Install & Restart") or because the officer ran the installer from the
 *   website and said Yes to "update the copy on the drive". The installer
 *   then unpacks the new program into %TEMP%\viper-drive-setup\app and starts
 *   it with:
 *       V.I.P.E.R.exe --viper-drive-setup --target=<drive folder> --wait-pid=<n>
 *   and quits without installing anything on the computer.
 *
 * WHAT THIS DOES (in that unpacked copy)
 *   1. wait for the old drive copy to close;
 *   2. copy the new program into <target>\.viper-update\incoming and verify it
 *      (file list, sizes, SHA-512 of the exe and the program archive, version);
 *   3. swap it in with portable-update.applySwap — the same rename-only,
 *      exe-last, journalled, fully rolled-back swap the 5.4.2 in-app updater
 *      uses. userdata\, cases\, .portable and anything the update does not
 *      carry are never touched;
 *   4. write the same result.json the in-app updater writes, so the new
 *      version on the drive tidies .viper-update (including the kept
 *      previous-<tx>\ copy of the old program) once it has run for 30 s;
 *   5. start the drive copy again.
 *
 * DESKTOP INSTALLS ARE NOT AFFECTED: nothing here runs unless the installer
 * chose a drive copy, and the installer never chooses the folder its own
 * per-user install registers. A normal launch never passes FLAG.
 *
 * THE COMMAND LINE IS A CONTRACT with build/installer.nsh. Never rename:
 *   --viper-drive-setup --target=<dir> --wait-pid=<n>
 *   %TEMP%\viper-drive-setup\{app\, viper-setup.json {kind:'viper-drive-setup'}}
 */

const path = require('path');
const crypto = require('crypto');
const PU = require('./portable-update.js');

const FLAG = '--viper-drive-setup';
const SETUP_DIR_NAME = 'viper-drive-setup';
const SETUP_MARKER = 'viper-setup.json';
const SETUP_KIND = 'viper-drive-setup';
const APP_DIR_NAME = 'app';
const LOG_NAME = 'viper-drive-setup-log.txt';
// Markers in a folder that say "this is a drive copy with its own data".
const DATA_MARKERS = ['userdata', 'cases', '.portable'];
const LIMITS = {
    maxEntries: 20000,
    maxTotalBytes: 3 * 1024 * 1024 * 1024,
    waitPidMs: 90000,
    waitFreeMs: 30000,
    chunkBytes: 4 * 1024 * 1024,
};
const SETUP_CHILDREN = /^(app|viper-setup\.json|[^\\/]+\.tmp)$/i;

function parseArgs(argv) {
    const get = (k) => {
        const p = '--' + k + '=';
        const a = (argv || []).find(x => typeof x === 'string' && x.indexOf(p) === 0);
        return a ? a.slice(p.length) : '';
    };
    const pid = parseInt(get('wait-pid'), 10);
    return { target: get('target').replace(/^"+|"+$/g, ''), waitPid: Number.isFinite(pid) && pid > 0 ? pid : 0 };
}

function isDriveRoot(p) {
    const r = path.resolve(String(p || ''));
    return path.dirname(r) === r;
}

/**
 * The running exe must be <something>\viper-drive-setup\app\<exe>, and the
 * setup folder must carry the installer's marker.
 * → {ok:true, appDir, setupDir} | {ok:false, error}
 */
function setupLayout(fs, execPath) {
    const appDir = path.dirname(path.resolve(String(execPath || '')));
    const setupDir = path.dirname(appDir);
    if (path.basename(appDir).toLowerCase() !== APP_DIR_NAME) return { ok: false, error: 'not-in-app-folder' };
    if (path.basename(setupDir).toLowerCase() !== SETUP_DIR_NAME) return { ok: false, error: 'not-in-setup-folder' };
    try { PU.lstatNoLink(fs, setupDir); PU.lstatNoLink(fs, appDir); } catch (e) { return { ok: false, error: e.message }; }
    const mk = PU.readJson(fs, path.join(setupDir, SETUP_MARKER));
    if (!mk || mk.kind !== SETUP_KIND) return { ok: false, error: 'no-marker' };
    return { ok: true, appDir, setupDir };
}

/**
 * The folder to update must look like a VIPER drive copy: the program, its
 * archive, and at least one of userdata\ / cases\ / .portable. Never a drive
 * root, never a link, never the setup folder itself.
 * → {ok:true} | {ok:false, error}
 */
function targetIsValid(fs, target, exeName, setupDir) {
    if (!target || !path.isAbsolute(target)) return { ok: false, error: 'The folder to update was not given.' };
    if (isDriveRoot(target)) return { ok: false, error: 'Refusing to update a whole drive.' };
    try {
        const st = PU.lstatNoLink(fs, target);
        if (!st || !st.isDirectory()) return { ok: false, error: 'The folder ' + target + ' was not found.' };
        const exe = PU.lstatNoLink(fs, path.join(target, exeName));
        if (!exe || !exe.isFile()) return { ok: false, error: 'The folder ' + target + ' does not contain ' + exeName + '.' };
        const asar = PU.lstatNoLink(fs, path.join(target, 'resources', 'app.asar'));
        if (!asar || !asar.isFile()) return { ok: false, error: 'The folder ' + target + ' does not contain a VIPER program archive.' };
        if (!DATA_MARKERS.some(n => { try { return !!PU.lstatNoLink(fs, path.join(target, n)); } catch (_) { return false; } })) {
            return { ok: false, error: 'The folder ' + target + ' is not a VIPER drive copy.' };
        }
    } catch (e) { return { ok: false, error: e.message }; }
    if (setupDir) {
        const t = PU.dirKey(target, fs), s = PU.dirKey(setupDir, fs);
        if (t === s || t.indexOf(s + path.sep) === 0) {
            return { ok: false, error: 'Refusing to update the setup folder itself.' };
        }
    }
    return { ok: true };
}

/** Every entry under dir: [{rel, size, isDir}], links refused, capped. */
function listTree(fs, dir) {
    const out = [];
    let total = 0;
    (function walk(d, rel) {
        for (const n of fs.readdirSync(d)) {
            const p = path.join(d, n), r = rel ? rel + '/' + n : n;
            const st = PU.lstatNoLink(fs, p);
            if (!st) continue;
            if (out.length >= LIMITS.maxEntries) throw new Error('The new program has too many files.');
            if (st.isDirectory()) { out.push({ rel: r, size: 0, isDir: true }); walk(p, r); }
            else if (st.isFile()) {
                total += st.size;
                if (total > LIMITS.maxTotalBytes) throw new Error('The new program is too large.');
                out.push({ rel: r, size: st.size, isDir: false });
            } else throw new Error('Unexpected item in the new program: ' + r);
        }
    })(dir, '');
    return { entries: out, totalBytes: total };
}

/** Same relative paths, kinds and sizes (case-insensitive paths). */
function compareTrees(a, b) {
    const key = (e) => e.rel.toLowerCase() + '|' + (e.isDir ? 'd' : e.size);
    const sa = a.map(key).sort(), sb = b.map(key).sort();
    if (sa.length !== sb.length) return { same: false, error: 'file count ' + sa.length + ' vs ' + sb.length };
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return { same: false, error: 'differs at ' + sa[i] + ' / ' + sb[i] };
    return { same: true };
}

async function hashFile(fs, p) {
    const h = crypto.createHash('sha512');
    const fh = await fs.promises.open(p, 'r');
    try {
        const buf = Buffer.alloc(LIMITS.chunkBytes);
        for (;;) {
            const { bytesRead } = await fh.read(buf, 0, buf.length, null);
            if (!bytesRead) break;
            h.update(buf.subarray(0, bytesRead));
        }
    } finally { await fh.close(); }
    return h.digest('base64');
}

/**
 * Copy the listed tree src → dest (dest must not exist). Files are written
 * with 'wx', flushed to disk, and size-checked. onProgress(doneBytes, total).
 */
async function copyTree(fs, src, dest, listing, onProgress) {
    if (PU.lstatNoLink(fs, dest)) throw new Error('The copy destination already exists: ' + dest);
    fs.mkdirSync(dest, { recursive: true });
    const buf = Buffer.alloc(LIMITS.chunkBytes);
    let done = 0;
    for (const e of listing.entries) {
        const to = PU.safeJoin(dest, e.rel);
        if (e.isDir) { fs.mkdirSync(to, { recursive: true }); continue; }
        fs.mkdirSync(path.dirname(to), { recursive: true });
        const from = PU.safeJoin(src, e.rel);
        const rh = await fs.promises.open(from, 'r');
        try {
            const wh = await fs.promises.open(to, 'wx');
            try {
                let n = 0;
                for (;;) {
                    const { bytesRead } = await rh.read(buf, 0, buf.length, null);
                    if (!bytesRead) break;
                    let off = 0;
                    while (off < bytesRead) {
                        const { bytesWritten } = await wh.write(buf, off, bytesRead - off, null);
                        off += bytesWritten;
                    }
                    n += bytesRead; done += bytesRead;
                    if (onProgress) { try { onProgress(done, listing.totalBytes); } catch (_) {} }
                }
                try { await wh.sync(); } catch (_) {}
                if (n !== e.size) throw new Error('Copied size mismatch: ' + e.rel);
            } finally { await wh.close(); }
        } finally { await rh.close(); }
    }
    return done;
}

/** True if the file can be opened for writing (i.e. the program is not running). */
function fileIsFree(fs, p) {
    let fd;
    try { fd = fs.openSync(p, 'r+'); return true; }
    catch (e) { return !(e && (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES')); }
    finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} } }
}

const defaultSleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Update the drive copy at o.target from the program in o.appDir.
 *   o = { fs, appDir, setupDir?, exeName, target, selfVersion, waitPid?,
 *         pidAlive?, isFileFree?, freeBytes?(dir), sleep?, onProgress?({phase,done,total}),
 *         txId?, renameTries?, renameDelayMs?, waitPidMs?, waitFreeMs?, log? }
 * → { status: 'applied'|'current'|'refused'|'failed', safe, message, from?, to?, workDir? }
 *   safe = the drive copy is exactly as it was (or fully updated).
 */
async function runDriveSetup(o) {
    const fs = o.fs;
    const log = o.log || (() => {});
    const sleep = o.sleep || defaultSleep;
    const pidAlive = o.pidAlive || PU.pidAlive;
    const isFree = o.isFileFree || ((p) => fileIsFree(fs, p));
    const progress = (phase, done, total) => { if (o.onProgress) { try { o.onProgress({ phase, done, total }); } catch (_) {} } };
    const refuse = (message, extra) => Object.assign({ status: 'refused', safe: true, message }, extra || {});
    const target = path.resolve(String(o.target || ''));
    const exeName = o.exeName;
    log('target=' + target + ' self=' + o.selfVersion + ' waitPid=' + (o.waitPid || 0));

    const tv = targetIsValid(fs, target, exeName, o.setupDir);
    if (!tv.ok) return refuse(tv.error);

    // 1. The old copy must be closed.
    progress('waiting', 0, 0);
    if (o.waitPid) {
        const deadline = Date.now() + (o.waitPidMs || LIMITS.waitPidMs);
        while (pidAlive(o.waitPid) && Date.now() < deadline) await sleep(300);
        if (pidAlive(o.waitPid)) return refuse('VIPER on the drive did not close, so it was not updated. Nothing was changed.');
    }
    const targetExe = path.join(target, exeName);
    {
        const deadline = Date.now() + (o.waitFreeMs || LIMITS.waitFreeMs);
        while (!isFree(targetExe) && Date.now() < deadline) await sleep(500);
        if (!isFree(targetExe)) return refuse('VIPER on the drive is still open. Close it and run the installer again. Nothing was changed.');
    }

    // 2. Is there anything to do?
    let fromVersion;
    try { fromVersion = PU.readAsarVersion(fs, path.join(target, 'resources', 'app.asar')); }
    catch (e) { return refuse('The VIPER program on the drive could not be read (' + e.message + '). Nothing was changed.'); }
    log('drive copy version ' + fromVersion);
    if (PU.compareVersions(fromVersion, o.selfVersion) >= 0) {
        return { status: 'current', safe: true, message: 'The copy on the drive is already version ' + fromVersion + '.', from: fromVersion, to: o.selfVersion };
    }

    // 3. Anything an earlier update left behind. Even one that did not finish
    //    cleanly is no dead end: it is renamed aside (.viper-update-old-<id>,
    //    nothing deleted) and this install lays down a COMPLETE new program.
    const prior = PU.inspectWorkDir(fs, target, fromVersion);
    log('work folder: ' + prior.status + (prior.reason ? ' ' + prior.reason : ''));
    const priorStuck = prior.status === 'unknown' || prior.status === 'interrupted' || (prior.status === 'failed' && !prior.safe);
    if (prior.status !== 'none' && !priorStuck) { try { PU.cleanupWorkDir(fs, target); } catch (_) {} }

    // 4. The new program, and room for it.
    let listing;
    try { listing = listTree(fs, o.appDir); } catch (e) { return refuse(e.message + ' Nothing was changed.'); }
    try {
        PU.verifyStagedTree({ fs, dir: o.appDir, exeName, expectedVersion: o.selfVersion,
            readVersion: (d) => PU.readAsarVersion(fs, path.join(d, 'resources', 'app.asar')) });
    } catch (e) { return refuse('The installer\u2019s copy of the new program is not usable (' + e.message + '). Nothing was changed.'); }
    if (o.freeBytes) {
        let free = NaN;
        try { free = o.freeBytes(target); } catch (_) {}
        const need = listing.totalBytes + PU.LIMITS.spareBytes;
        if (Number.isFinite(free) && free < need) {
            return refuse('There is not enough free space on the drive (about ' + Math.ceil(need / 1048576) + ' MB is needed). Nothing was changed.');
        }
    }

    // 5. Copy and verify.
    {
        const clr = PU.clearWorkDirForUpdate(fs, target, PU.inspectWorkDir(fs, target, fromVersion), o.retireOpts);
        if (clr.retired) log('earlier update set aside: ' + clr.retired);
        if (!clr.ok) return refuse('Files from an earlier update on the drive could not be moved out of the way (' + clr.reason + '). Nothing was changed.');
    }
    let wd;
    try { wd = PU.ensureWorkDir(fs, target); }
    catch (e) {
        return refuse('The drive cannot be written to (' + ((e && e.code) || e.message) + '). '
            + 'If it is write-protected or full, fix that and run the installer again. Nothing was changed.');
    }
    const incoming = path.join(wd, 'incoming');
    try {
        await copyTree(fs, o.appDir, incoming, listing, (d, t) => progress('copy', d, t));
        progress('verify', 0, 0);
        const cmp = compareTrees(listing.entries, listTree(fs, incoming).entries);
        if (!cmp.same) throw new Error('The copy on the drive does not match (' + cmp.error + ').');
        for (const rel of [exeName, 'resources/app.asar']) {
            const a = await hashFile(fs, PU.safeJoin(o.appDir, rel));
            const b = await hashFile(fs, PU.safeJoin(incoming, rel));
            if (a !== b) throw new Error('The copy of ' + rel + ' on the drive is damaged.');
        }
        PU.verifyStagedTree({ fs, dir: incoming, exeName, expectedVersion: o.selfVersion,
            readVersion: (d) => PU.readAsarVersion(fs, path.join(d, 'resources', 'app.asar')) });
        PU.writeJsonDurable(fs, path.join(wd, PU.PREPARED_FILE), {
            kind: PU.MARKER_KIND, version: String(o.selfVersion), exe: exeName,
            preparedAt: new Date().toISOString(), source: 'installer',
        });
    } catch (e) {
        log('copy failed: ' + e.message);
        try { PU.cleanupWorkDir(fs, target); } catch (_) {}
        return refuse('The new version could not be copied to the drive (' + e.message + '). Nothing was changed.');
    }

    // 6. Swap.
    progress('swap', 0, 0);
    const txId = o.txId || PU.newTxId();
    let r;
    try { r = PU.applySwap({ fs, targetDir: target, txId, exeName, renameTries: o.renameTries, renameDelayMs: o.renameDelayMs }); }
    catch (e) { r = { ok: false, error: e.message, rolledBack: false }; }
    log('swap: ' + JSON.stringify(r));
    const result = { kind: PU.MARKER_KIND, txId, to: String(o.selfVersion), at: new Date().toISOString(), source: 'installer' };
    if (r.ok) {
        try { PU.writeJsonDurable(fs, path.join(wd, PU.RESULT_FILE), Object.assign(result, { ok: true })); } catch (_) {}
        return { status: 'applied', safe: true, message: 'Updated from ' + fromVersion + ' to ' + o.selfVersion + '.', from: fromVersion, to: o.selfVersion, workDir: wd };
    }
    try { PU.writeJsonDurable(fs, path.join(wd, PU.RESULT_FILE), Object.assign(result, { ok: false, error: r.error, rolledBack: !!r.rolledBack })); } catch (_) {}
    if (r.rolledBack) {
        try { PU.cleanupWorkDir(fs, target); } catch (_) {}
        return { status: 'failed', safe: true, message: 'The update could not be applied (' + r.error + '). The drive copy is unchanged.', from: fromVersion, to: o.selfVersion };
    }
    return { status: 'failed', safe: false, message: 'The update stopped part-way (' + r.error + ').', from: fromVersion, to: o.selfVersion, workDir: wd };
}

/**
 * Remove <tmpRoot>\viper-drive-setup once the drive copy runs the version it
 * delivered. Only our marker, only our children, never through a link; the
 * program folder goes first so a busy file leaves the marker for next time.
 * → {removed:boolean, reason}
 */
function cleanupSetupDir(fs, tmpRoot, currentVersion) {
    const dir = path.join(path.resolve(String(tmpRoot || '')), SETUP_DIR_NAME);
    let st;
    try { st = PU.lstatNoLink(fs, dir); } catch (e) { return { removed: false, reason: e.message }; }
    if (!st) return { removed: false, reason: 'absent' };
    if (!st.isDirectory()) return { removed: false, reason: 'not-a-folder' };
    const mk = PU.readJson(fs, path.join(dir, SETUP_MARKER));
    if (!mk || mk.kind !== SETUP_KIND) return { removed: false, reason: 'no-marker' };
    if (PU.compareVersions(mk.version, currentVersion) > 0) return { removed: false, reason: 'newer:' + mk.version };
    let names;
    try { names = fs.readdirSync(dir); } catch (e) { return { removed: false, reason: e.message }; }
    const foreign = names.filter(n => !SETUP_CHILDREN.test(n));
    if (foreign.length) return { removed: false, reason: 'foreign-items:' + foreign.join(',') };
    let step = 'app';
    try {
        if (names.some(n => n.toLowerCase() === APP_DIR_NAME)) {
            PU.lstatNoLink(fs, path.join(dir, APP_DIR_NAME));
            fs.rmSync(path.join(dir, APP_DIR_NAME), { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
        }
        step = 'tmp';
        for (const n of names) if (/\.tmp$/i.test(n)) { try { fs.unlinkSync(path.join(dir, n)); } catch (_) {} }
        step = 'marker';
        fs.unlinkSync(path.join(dir, SETUP_MARKER));
        step = 'folder';
        fs.rmdirSync(dir);
    } catch (e) {
        return { removed: false, reason: 'busy:' + step + ':' + ((e && e.code) || e.message) };
    }
    return { removed: true, reason: 'ok' };
}

// ── The window (Electron) ───────────────────────────────────────────────

const PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>V.I.P.E.R. update</title><style>'
    + 'body{margin:0;font:14px "Segoe UI",Arial,sans-serif;background:#14161b;color:#e8eaf0;padding:22px 26px;user-select:none}'
    + 'h1{font-size:17px;margin:0 0 6px}#t{color:#aab2c0;margin:0 0 4px;word-break:break-all}#m{margin:14px 0 10px;min-height:20px}'
    + '.bar{height:8px;background:#2a2e38;border-radius:4px;overflow:hidden}.fill{height:100%;width:0;background:#3fb6ff;transition:width .2s}'
    + '.n{color:#8a93a3;font-size:12px;margin-top:14px}</style></head><body>'
    + '<h1 id="h">Updating V.I.P.E.R. on your drive</h1><div id="t"></div><div id="m">Starting\u2026</div>'
    + '<div class="bar"><div class="fill" id="f"></div></div>'
    + '<div class="n" id="n">Please leave the drive plugged in until this finishes. Your cases and settings on the drive are not touched.</div>'
    + '<script>window.__set=function(o){if(o.h!=null)document.getElementById("h").textContent=o.h;'
    + 'if(o.t!=null)document.getElementById("t").textContent=o.t;if(o.m!=null)document.getElementById("m").textContent=o.m;'
    + 'if(o.p!=null)document.getElementById("f").style.width=Math.max(0,Math.min(100,o.p))+"%";'
    + 'if(o.n!=null)document.getElementById("n").textContent=o.n;};</script></body></html>';

/**
 * Entry point when the exe is started with FLAG (electron-main.js, before
 * any other startup code). Never touches the officer's data.
 */
function run(electron, argv) {
    const { app, BrowserWindow, dialog } = electron;
    const os = require('os');
    const { spawn } = require('child_process');
    try { app.setPath('userData', path.join(os.tmpdir(), 'viper-drive-setup-profile')); } catch (_) {}
    try { app.disableHardwareAcceleration(); } catch (_) {}
    let fs;
    try { fs = require('original-fs'); } catch (_) { fs = require('fs'); }

    const logPath = path.join(os.tmpdir(), LOG_NAME);
    try { fs.writeFileSync(logPath, ''); } catch (_) {}
    const log = (s) => { try { fs.appendFileSync(logPath, new Date().toISOString() + ' ' + s + '\r\n'); } catch (_) {} };

    const a = parseArgs(argv);
    const exeName = path.basename(process.execPath);
    const layout = setupLayout(fs, process.execPath);
    log('start ' + JSON.stringify({ argv: (argv || []).slice(1), exe: process.execPath, layout }));
    if (!layout.ok || !a.target) { log('refusing: bad layout or no target'); try { app.exit(0); } catch (_) { process.exit(0); } return; }
    if (!app.requestSingleInstanceLock()) { log('another drive update is running'); app.exit(0); return; }

    const relaunch = () => {
        try {
            const exe = path.join(a.target, exeName);
            if (targetIsValid(fs, a.target, exeName, layout.setupDir).ok) {
                spawn(exe, [], { detached: true, stdio: 'ignore', cwd: a.target }).unref();
                log('relaunched ' + exe);
            }
        } catch (e) { log('relaunch failed: ' + e.message); }
    };
    const freeBytes = (dir) => {
        if (typeof fs.statfsSync !== 'function') return NaN;
        const s = fs.statfsSync(dir);
        return Number(s.bavail) * Number(s.bsize);
    };

    app.on('window-all-closed', () => { /* we exit explicitly */ });
    app.whenReady().then(async () => {
        let busy = true;
        const win = new BrowserWindow({
            width: 560, height: 250, resizable: false, minimizable: true, maximizable: false, fullscreenable: false,
            title: 'V.I.P.E.R. update', backgroundColor: '#14161b', autoHideMenuBar: true, show: false,
            webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        });
        win.on('close', (e) => { if (busy) e.preventDefault(); });
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        win.webContents.on('will-navigate', (e) => e.preventDefault());
        const set = (o) => { try { if (!win.isDestroyed()) win.webContents.executeJavaScript('window.__set(' + JSON.stringify(o) + ')').catch(() => {}); } catch (_) {} };
        try { await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE)); } catch (_) {}
        win.show();
        set({ t: a.target });

        const phases = { waiting: 'Waiting for VIPER to close\u2026', copy: 'Copying the new version to the drive\u2026', verify: 'Checking the copy\u2026', swap: 'Switching to the new version\u2026' };
        let r;
        try {
            r = await runDriveSetup({
                fs, appDir: layout.appDir, setupDir: layout.setupDir, exeName, target: a.target,
                selfVersion: app.getVersion(), waitPid: a.waitPid, freeBytes, log,
                onProgress: (p) => {
                    const pct = p.phase === 'copy' && p.total ? Math.round(5 + 85 * p.done / p.total)
                        : ({ waiting: 2, verify: 92, swap: 97 })[p.phase];
                    set({ m: phases[p.phase] || '', p: pct });
                },
            });
        } catch (e) {
            r = { status: 'refused', safe: true, message: 'The update could not run (' + e.message + '). Nothing was changed.' };
        }
        log('result ' + JSON.stringify(r));
        busy = false;
        const finish = () => { try { app.exit(0); } catch (_) { process.exit(0); } };

        if (r.status === 'applied' || r.status === 'current') {
            set({ h: r.status === 'applied' ? 'V.I.P.E.R. on your drive is up to date' : 'Already up to date',
                m: r.message + ' Starting VIPER\u2026', p: 100,
                n: 'Future updates can be installed from inside VIPER (Settings \u2192 Check for Updates).' });
            relaunch();
            setTimeout(finish, 3000);
            return;
        }
        if (r.safe) {
            await dialog.showMessageBox(win, { type: 'warning', title: 'V.I.P.E.R. update', buttons: ['OK'],
                message: 'V.I.P.E.R. on your drive was not updated.',
                detail: r.message + '\n\nYour cases and settings on the drive were not touched.\n\nDetails were saved to:\n' + logPath }).catch(() => {});
            relaunch();
            finish();
            return;
        }
        await dialog.showMessageBox(win, { type: 'error', title: 'V.I.P.E.R. update', buttons: ['OK'],
            message: 'The update of V.I.P.E.R. on your drive did not finish cleanly.',
            detail: r.message + '\n\nYour cases and saved data (the "cases" and "userdata" folders) were not touched. '
                + 'The previous program files are kept in:\n' + (r.workDir || '') + '\n\n'
                + 'Please contact Intellect LE support before deleting anything in that folder.\n\nDetails were saved to:\n' + logPath }).catch(() => {});
        finish();
    });
}

module.exports = {
    FLAG, SETUP_DIR_NAME, SETUP_MARKER, SETUP_KIND, APP_DIR_NAME, LOG_NAME, DATA_MARKERS, LIMITS,
    parseArgs, isDriveRoot, setupLayout, targetIsValid, listTree, compareTrees, hashFile, copyTree, fileIsFree,
    runDriveSetup, cleanupSetupDir, run,
};

'use strict';
/**
 * Automatic weekly backup + "find my last backup" (main process).
 *
 * The renderer owns localStorage, so it collects that part and hands it over
 * (runAuto({data})). Everything else lives here:
 *
 *   • Config + state are kept in <userData>/auto-backup.json, NOT in
 *     localStorage. The moment someone needs a restore is usually the moment
 *     localStorage has been lost, so the backup folder and the last backup
 *     file must survive that.
 *   • The ZIP is streamed with archiver, one file at a time, so a big
 *     Evidence folder neither freezes the window nor loads into memory.
 *     It is written to "<name>.partial" and renamed when complete, so a
 *     half-written file is never offered as "the latest backup".
 *   • Inner files go in DECRYPTED, exactly like the manual backup
 *     (create-backup-zip): a backup must stay restorable after a Field
 *     Security reset. encrypt:true only seals the outer file.
 *   • Only automatic backups (VIPER_AutoBackup_*.vbak) are ever pruned.
 *     Manual backups are never deleted.
 *   • A backup whose data holds no cases while the previous one did is
 *     refused, so a wiped profile can't rotate the good backups away.
 */

const DEFAULTS = Object.freeze({
    enabled: false,
    folder: '',
    keep: 4,
    encrypt: false,
    intervalDays: 7,
    lastAutoAt: null,
    lastAutoFile: null,
    lastBackupAt: null,
    lastBackupFile: null,
    lastAttemptAt: null,
    lastError: null,
    lastCaseCount: null,
});

const DAY = 24 * 60 * 60 * 1000;
const RETRY_MS = 6 * 60 * 60 * 1000;          // after a failed attempt
const KEEP_MIN = 1, KEEP_MAX = 52;
const AUTO_RE = /^VIPER_AutoBackup_.+\.vbak$/i;
const ANY_RE = /^VIPER_(Auto)?Backup_.+\.vbak$/i;
const TS_RE = /_(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.vbak$/i;
// Already-compressed formats: stored, not deflated (saves a lot of CPU).
const STORE_EXT = /\.(jpe?g|png|gif|webp|heic|mp4|mov|m4v|avi|mkv|webm|mp3|m4a|aac|ogg|zip|7z|rar|gz|vbak|vcase|docx|xlsx|pptx)$/i;

function fileStamp(d) {
    return d.toISOString().replace(/[:.]/g, '-');
}

/** Creation time from "VIPER_…Backup_2026-11-06T17-48-58-123Z.vbak", else null. */
function stampOf(name) {
    const m = TS_RE.exec(String(name || ''));
    if (!m) return null;
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]);
    return isNaN(t) ? null : t;
}

function clampKeep(n) {
    n = Math.round(Number(n));
    if (!isFinite(n)) return DEFAULTS.keep;
    return Math.min(KEEP_MAX, Math.max(KEEP_MIN, n));
}

/** Number of case records in the collected localStorage payload. */
function caseCountOf(data) {
    try {
        const obj = typeof data === 'string' ? JSON.parse(data) : data;
        const raw = obj && obj.viperCases;
        if (raw == null) return 0;
        const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return Array.isArray(list) ? list.length : 0;
    } catch (_) { return 0; }
}

/**
 * Pure due check.
 * Due when enabled, a folder is set, and the last automatic backup is at
 * least intervalDays old (or there is none). After a failed attempt it waits
 * RETRY_MS before trying again, so an unplugged drive doesn't retry on
 * every page load.
 */
function isDue(cfg, now) {
    if (!cfg || !cfg.enabled || !cfg.folder) return false;
    const interval = Math.max(1, Number(cfg.intervalDays) || 7) * DAY;
    const last = cfg.lastAutoAt ? Date.parse(cfg.lastAutoAt) : NaN;
    if (!isNaN(last) && now - last < interval) return false;
    const tried = cfg.lastAttemptAt ? Date.parse(cfg.lastAttemptAt) : NaN;
    const failedSince = !isNaN(tried) && (isNaN(last) || tried > last) && cfg.lastError;
    if (failedSince && now - tried < RETRY_MS) return false;
    return true;
}

function nextDueAt(cfg) {
    if (!cfg || !cfg.enabled) return null;
    const interval = Math.max(1, Number(cfg.intervalDays) || 7) * DAY;
    const last = cfg.lastAutoAt ? Date.parse(cfg.lastAutoAt) : NaN;
    if (isNaN(last)) return null;            // due as soon as possible
    return new Date(last + interval).toISOString();
}

function createAutoBackup(deps) {
    const fs = deps.fs || require('fs');
    const path = deps.path || require('path');
    const now = deps.now || (() => Date.now());
    const log = deps.log || ((...a) => console.log('[auto-backup]', ...a));
    const getCasesDir = deps.getCasesDir;
    const getSecurity = deps.getSecurity || (() => null);
    const makeArchiver = deps.archiver || (() => require('archiver'));
    const configPath = path.join(deps.userDataDir, 'auto-backup.json');

    let running = null;               // promise of the backup in progress

    function load() {
        try {
            const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            return Object.assign({}, DEFAULTS, raw && typeof raw === 'object' ? raw : {});
        } catch (_) {
            return Object.assign({}, DEFAULTS);
        }
    }

    function save(patch) {
        const next = Object.assign(load(), patch || {});
        const tmp = configPath + '.tmp';
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
        fs.renameSync(tmp, configPath);
        return next;
    }

    function folderOk(folder) {
        try { return !!folder && fs.statSync(folder).isDirectory(); } catch (_) { return false; }
    }

    function getState() {
        const cfg = load();
        const t = now();
        return Object.assign({}, cfg, {
            due: isDue(cfg, t),
            nextDueAt: nextDueAt(cfg),
            folderExists: cfg.folder ? folderOk(cfg.folder) : false,
            running: !!running,
        });
    }

    /** Accepts enabled, folder, keep, encrypt. Anything else is ignored. */
    function setConfig(patch) {
        patch = patch || {};
        const out = {};
        if ('folder' in patch) out.folder = String(patch.folder || '').trim();
        if ('keep' in patch) out.keep = clampKeep(patch.keep);
        if ('encrypt' in patch) out.encrypt = patch.encrypt === true;
        if ('enabled' in patch) {
            const folder = 'folder' in out ? out.folder : load().folder;
            if (patch.enabled === true && !folder) throw new Error('Choose a backup folder first.');
            out.enabled = patch.enabled === true;
            // Turning it on clears an old error so it is tried right away.
            if (out.enabled) { out.lastError = null; out.lastAttemptAt = null; }
        }
        if ('folder' in out && !out.folder && !('enabled' in out)) out.enabled = false;
        if ('folder' in out && out.folder && out.folder !== load().folder) { out.lastError = null; out.lastAttemptAt = null; }
        save(out);
        return getState();
    }

    /** Remember a finished backup (manual or automatic). */
    function record(filePath, kind) {
        const at = new Date(now()).toISOString();
        const patch = { lastBackupAt: at, lastBackupFile: filePath };
        if (kind === 'auto') Object.assign(patch, { lastAutoAt: at, lastAutoFile: filePath });
        return save(patch);
    }

    async function _walk(dir, prefix, out) {
        let entries;
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
        catch (_) { return; }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) await _walk(full, prefix + '/' + e.name, out);
            else if (e.isFile()) out.push({ full, name: prefix + '/' + e.name });
        }
    }

    async function _head(file, n) {
        const fh = await fs.promises.open(file, 'r');
        try {
            const buf = Buffer.alloc(n);
            const { bytesRead } = await fh.read(buf, 0, n, 0);
            return buf.subarray(0, bytesRead);
        } finally { await fh.close(); }
    }

    /**
     * Stream a .vbak: viper_data.json + every file under the cases folder
     * (decrypted). Returns { filePath, encrypted, files, skipped }.
     */
    async function writeBackup({ folder, data, encrypt, kind }) {
        const security = getSecurity();
        if (security && security.isEnabled() && !security.isUnlocked()) {
            throw new Error('Field Security is locked — unlock VIPER to back up.');
        }
        const canDecrypt = !!(security && security.isUnlocked());
        const seal = encrypt === true && canDecrypt && security.isEnabled();
        const base = (kind === 'auto' ? 'VIPER_AutoBackup_' : 'VIPER_Backup_') + fileStamp(new Date(now())) + '.vbak';
        const filePath = path.join(folder, base);
        const partial = filePath + '.partial';

        const files = [];
        const casesDir = getCasesDir();
        let caseFolders = [];
        try {
            caseFolders = (await fs.promises.readdir(casesDir, { withFileTypes: true })).filter(d => d.isDirectory());
        } catch (_) { caseFolders = []; }
        for (const d of caseFolders) await _walk(path.join(casesDir, d.name), 'cases/' + d.name, files);

        const archiver = makeArchiver();
        const archive = archiver('zip', { zlib: { level: 6 } });
        const out = fs.createWriteStream(partial);
        const closed = new Promise((res, rej) => { out.on('close', res); out.on('error', rej); });
        let failure = null;
        archive.on('error', e => { failure = failure || e; });
        archive.on('warning', e => log('warning', e && e.message));
        archive.pipe(out);

        // One entry at a time: wait for archiver to finish it before the next.
        const add = (src, opts) => new Promise((res, rej) => {
            if (failure) return rej(failure);
            const onEntry = () => { archive.removeListener('error', onErr); res(); };
            const onErr = (e) => { archive.removeListener('entry', onEntry); rej(e); };
            archive.once('entry', onEntry);
            archive.once('error', onErr);
            if (typeof src === 'string') archive.file(src, opts); else archive.append(src, opts);
        });

        let skipped = 0;
        try {
            await add(Buffer.from(typeof data === 'string' ? data : JSON.stringify(data || {}), 'utf-8'), { name: 'viper_data.json' });
            for (const f of files) {
                try {
                    const head = await _head(f.full, 8);
                    const store = STORE_EXT.test(f.name);
                    if (canDecrypt && security.isEncryptedBuffer(head)) {
                        const buf = security.decryptBuffer(await fs.promises.readFile(f.full));
                        await add(buf, { name: f.name, store });
                    } else {
                        await add(f.full, { name: f.name, store });
                    }
                } catch (e) {
                    if (failure) throw failure;
                    skipped++;
                    log('skip', f.name, e && e.message);
                }
            }
            await archive.finalize();
            await closed;
            if (failure) throw failure;

            if (seal) {
                const zipBuf = await fs.promises.readFile(partial);
                await fs.promises.writeFile(partial, security.encryptBuffer(zipBuf));
            }
            await fs.promises.rename(partial, filePath);
        } catch (e) {
            try { archive.abort(); } catch (_) {}
            try { out.destroy(); } catch (_) {}
            try { await fs.promises.unlink(partial); } catch (_) {}
            throw e;
        }
        return { filePath, encrypted: seal, files: files.length - skipped, skipped };
    }

    /** Delete the oldest automatic backups in `folder`, keeping `keep`. */
    async function prune(folder, keep) {
        keep = clampKeep(keep);
        let names = [];
        try { names = await fs.promises.readdir(folder); } catch (_) { return []; }
        const autos = names.filter(n => AUTO_RE.test(n))
            .map(n => ({ n, t: stampOf(n) }))
            .filter(x => x.t != null)
            .sort((a, b) => b.t - a.t);
        const removed = [];
        for (const x of autos.slice(keep)) {
            try { await fs.promises.unlink(path.join(folder, x.n)); removed.push(x.n); }
            catch (e) { log('prune failed', x.n, e && e.message); }
        }
        // Leftovers from a crash mid-backup (only our own, only if a day old).
        for (const n of names) {
            if (!/^VIPER_AutoBackup_.+\.vbak\.partial$/i.test(n)) continue;
            try {
                const st = await fs.promises.stat(path.join(folder, n));
                if (now() - st.mtimeMs > DAY) await fs.promises.unlink(path.join(folder, n));
            } catch (_) {}
        }
        return removed;
    }

    /**
     * The weekly run. Returns { ok, filePath, … } or { skipped: reason }
     * or { ok:false, error }.
     */
    function runAuto({ data, force } = {}) {
        if (running) return Promise.resolve({ skipped: 'running' });
        const cfg = load();
        if (!cfg.enabled) return Promise.resolve({ skipped: 'off' });
        if (!force && !isDue(cfg, now())) return Promise.resolve({ skipped: 'not-due' });

        running = (async () => {
            const attemptAt = new Date(now()).toISOString();
            save({ lastAttemptAt: attemptAt });
            try {
                if (!folderOk(cfg.folder)) {
                    throw new Error('The backup folder can’t be reached: ' + cfg.folder + ' (is the drive connected?)');
                }
                const count = caseCountOf(data);
                if (count === 0 && Number(cfg.lastCaseCount) > 0) {
                    throw new Error('No cases were found in VIPER, so the automatic backup was skipped to keep your earlier backups safe.');
                }
                const r = await writeBackup({ folder: cfg.folder, data, encrypt: cfg.encrypt, kind: 'auto' });
                record(r.filePath, 'auto');
                save({ lastError: null, lastCaseCount: count });
                const removed = await prune(cfg.folder, cfg.keep);
                log('done', r.filePath, r.files + ' files', removed.length ? 'pruned ' + removed.length : '');
                return Object.assign({ ok: true, cases: count, pruned: removed.length }, r);
            } catch (e) {
                const msg = (e && e.message) || String(e);
                save({ lastError: msg });
                log('failed', msg);
                return { ok: false, error: msg };
            }
        })();
        return running.finally(() => { running = null; });
    }

    async function _describe(full) {
        const st = await fs.promises.stat(full);
        if (!st.isFile()) return null;
        const name = path.basename(full);
        let encrypted = false, valid = false;
        try {
            const head = await _head(full, 8);
            encrypted = head.length >= 6 && head.subarray(0, 6).toString('latin1') === 'VIPENC';
            valid = encrypted || (head[0] === 0x50 && head[1] === 0x4b);
        } catch (_) {}
        const t = stampOf(name);
        return {
            path: full,
            name,
            folder: path.dirname(full),
            size: st.size,
            createdAt: new Date(t != null ? t : st.mtimeMs).toISOString(),
            auto: AUTO_RE.test(name),
            encrypted,
            valid,
        };
    }

    /**
     * Every VIPER backup in the remembered places, newest first:
     * the auto-backup folder, the folder of the last backup, any extra
     * folders the caller passes, and the last backup file itself.
     */
    async function listBackups(extraFolders) {
        const cfg = load();
        const folders = [];
        const addF = f => {
            if (!f || typeof f !== 'string') return;
            const k = path.resolve(f).toLowerCase();
            if (!folders.some(x => x.k === k)) folders.push({ f: path.resolve(f), k });
        };
        addF(cfg.folder);
        if (cfg.lastBackupFile) addF(path.dirname(cfg.lastBackupFile));
        if (cfg.lastAutoFile) addF(path.dirname(cfg.lastAutoFile));
        (Array.isArray(extraFolders) ? extraFolders : []).forEach(addF);

        const seen = new Set();
        const out = [];
        for (const { f } of folders) {
            let names = [];
            try { names = await fs.promises.readdir(f); } catch (_) { continue; }
            for (const n of names) {
                if (!ANY_RE.test(n)) continue;
                const full = path.join(f, n);
                const k = full.toLowerCase();
                if (seen.has(k)) continue;
                seen.add(k);
                try { const d = await _describe(full); if (d) out.push(d); } catch (_) {}
            }
        }
        for (const lf of [cfg.lastBackupFile, cfg.lastAutoFile]) {
            if (!lf || seen.has(String(lf).toLowerCase())) continue;
            seen.add(String(lf).toLowerCase());
            try { const d = await _describe(lf); if (d) out.push(d); } catch (_) {}
        }
        out.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
        return { backups: out, searched: folders.map(x => x.f) };
    }

    /** Wire the IPC channels. */
    function register(ipcMain) {
        ipcMain.handle('auto-backup-get', () => getState());
        ipcMain.handle('auto-backup-set', (e, patch) => setConfig(patch));
        ipcMain.handle('auto-backup-run', (e, args) => runAuto(args || {}));
        ipcMain.handle('backup-list', (e, args) => listBackups(args && args.folders));
    }

    return { load, save, getState, setConfig, record, writeBackup, prune, runAuto, listBackups, register };
}

module.exports = { createAutoBackup, isDue, nextDueAt, stampOf, caseCountOf, clampKeep, DEFAULTS, AUTO_RE, ANY_RE };

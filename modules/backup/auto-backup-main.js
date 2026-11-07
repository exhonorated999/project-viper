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
 *   • Secondary location (optional): every backup — manual or automatic —
 *     is written once, then copied to the second folder and checked by
 *     SHA-256. If one folder can't be reached the backup still goes to the
 *     other one; the failure is recorded and shown, never silent.
 *   • Besides the cases folder, a backup carries the case data VIPER keeps
 *     in userData (USERDATA_ITEMS: Snapchat / DataPilot import stores, the
 *     UC Chat database + photos, the Warrant Author library, the badge
 *     used on reports, the audit log). Restore puts them back; the audit
 *     log goes to a side folder so the live hash chain is never replaced.
 */

const DEFAULTS = Object.freeze({
    enabled: false,
    folder: '',
    keep: 4,
    encrypt: false,
    intervalDays: 7,
    secondaryEnabled: false,
    secondaryFolder: '',
    lastAutoAt: null,
    lastAutoFile: null,
    lastBackupAt: null,
    lastBackupFile: null,
    lastAttemptAt: null,
    lastError: null,
    lastCaseCount: null,
    lastSecondaryAt: null,
    lastSecondaryFile: null,
    lastSecondaryError: null,
});

/**
 * Case data kept in userData (outside the cases folder), stored in the
 * backup under "userdata/<name>". type:
 *   dir    — every file below it (".tmp"/".partial" leftovers skipped)
 *   sqlite — a consistent snapshot of a live database (deps.sqlite[name])
 *   audit  — audit.log + rotated audit.log.1..5 (restored to a side folder)
 */
const USERDATA_ITEMS = Object.freeze([
    { name: 'snapchat-warrant-store', type: 'dir' },   // full Snapchat warrant imports
    { name: 'datapilot-store', type: 'dir' },          // full DataPilot imports
    { name: 'viper-uc.db', type: 'sqlite' },           // UC Chat operations
    { name: 'uc_avatars', type: 'dir' },
    { name: 'uc_photos', type: 'dir' },
    { name: 'warrant-author', type: 'dir' },           // boilerplate library
    { name: 'branding', type: 'dir' },                 // department badge on reports
    { name: 'agency-packs', type: 'dir' },             // installed agency warrant packs
    { name: 'audit', type: 'audit' },
    { name: 'restored-audit', type: 'dir' },           // audit logs from earlier restores
]);
const AUDIT_RE = /^audit\.log(\.\d{1,2})?$/;
const SKIP_RE = /\.(tmp|partial)$|-backup-tmp-/i;

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
    if (!cfg || !cfg.enabled || !(cfg.folder || (cfg.secondaryEnabled && cfg.secondaryFolder))) return false;
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
    const crypto = deps.crypto || require('crypto');
    const userDataDir = deps.userDataDir;
    const userDataItems = Array.isArray(deps.userDataItems) ? deps.userDataItems : USERDATA_ITEMS;
    // { 'viper-uc.db': { snapshot: async (dest) => bool, close: () => void } }
    const sqlite = deps.sqlite || {};
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

    function samePlace(a, b) {
        if (!a || !b) return false;
        return path.resolve(a).replace(/[\\/]+$/, '').toLowerCase() === path.resolve(b).replace(/[\\/]+$/, '').toLowerCase();
    }

    function getState() {
        const cfg = load();
        const t = now();
        return Object.assign({}, cfg, {
            due: isDue(cfg, t),
            nextDueAt: nextDueAt(cfg),
            folderExists: cfg.folder ? folderOk(cfg.folder) : false,
            secondaryFolderExists: cfg.secondaryFolder ? folderOk(cfg.secondaryFolder) : false,
            running: !!running,
        });
    }

    /**
     * Accepts enabled, folder, keep, encrypt, secondaryEnabled,
     * secondaryFolder. Anything else is ignored.
     */
    function setConfig(patch) {
        patch = patch || {};
        const cur = load();
        const out = {};
        if ('folder' in patch) out.folder = String(patch.folder || '').trim();
        if ('keep' in patch) out.keep = clampKeep(patch.keep);
        if ('encrypt' in patch) out.encrypt = patch.encrypt === true;
        if ('enabled' in patch) {
            const folder = 'folder' in out ? out.folder : cur.folder;
            if (patch.enabled === true && !folder) throw new Error('Choose a backup folder first.');
            out.enabled = patch.enabled === true;
            // Turning it on clears an old error so it is tried right away.
            if (out.enabled) { out.lastError = null; out.lastAttemptAt = null; }
        }
        if ('folder' in out && !out.folder && !('enabled' in out)) out.enabled = false;
        if ('folder' in out && out.folder && out.folder !== cur.folder) { out.lastError = null; out.lastAttemptAt = null; }

        if ('secondaryFolder' in patch) out.secondaryFolder = String(patch.secondaryFolder || '').trim();
        if ('secondaryEnabled' in patch) {
            const sf = 'secondaryFolder' in out ? out.secondaryFolder : cur.secondaryFolder;
            if (patch.secondaryEnabled === true && !sf) throw new Error('Choose a secondary backup folder first.');
            out.secondaryEnabled = patch.secondaryEnabled === true;
        }
        if ('secondaryFolder' in out && !out.secondaryFolder && !('secondaryEnabled' in out)) out.secondaryEnabled = false;
        const primary = 'folder' in out ? out.folder : cur.folder;
        const second = 'secondaryFolder' in out ? out.secondaryFolder : cur.secondaryFolder;
        const secOn = 'secondaryEnabled' in out ? out.secondaryEnabled : cur.secondaryEnabled;
        if (secOn && samePlace(primary, second)) {
            throw new Error('The secondary backup folder must be different from the Backup Destination.');
        }
        if ('secondaryFolder' in out && out.secondaryFolder !== cur.secondaryFolder) out.lastSecondaryError = null;
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

        // Case data kept in userData. Added raw (never decrypted or
        // re-encrypted): these files are read back exactly as they were.
        const userFiles = [];
        const tmpFiles = [];
        let userSkipped = 0;
        if (userDataDir) {
            for (const it of userDataItems) {
                const full = path.join(userDataDir, it.name);
                try {
                    if (it.type === 'dir') {
                        const got = [];
                        await _walk(full, 'userdata/' + it.name, got);
                        for (const g of got) if (!SKIP_RE.test(g.name)) userFiles.push(g);
                    } else if (it.type === 'audit') {
                        let names = [];
                        try { names = await fs.promises.readdir(userDataDir); } catch (_) {}
                        for (const n of names.filter(n => AUDIT_RE.test(n)).sort()) {
                            userFiles.push({ full: path.join(userDataDir, n), name: 'userdata/audit/' + n });
                        }
                    } else if (it.type === 'sqlite') {
                        if (!fs.existsSync(full)) continue;
                        const snap = sqlite[it.name] && sqlite[it.name].snapshot;
                        if (typeof snap === 'function') {
                            // Consistent copy of a live (WAL) database.
                            const tmp = full + '-backup-tmp-' + now() + '-' + crypto.randomBytes(3).toString('hex');
                            tmpFiles.push(tmp);
                            if (await snap(tmp)) userFiles.push({ full: tmp, name: 'userdata/' + it.name });
                        } else {
                            userFiles.push({ full, name: 'userdata/' + it.name });
                            if (fs.existsSync(full + '-wal')) userFiles.push({ full: full + '-wal', name: 'userdata/' + it.name + '-wal' });
                        }
                    }
                } catch (e) {
                    userSkipped++;
                    log('userdata skip', it.name, e && e.message);
                }
            }
        }

        let archiver;
        try { archiver = makeArchiver(); }
        catch (e) {
            for (const t of tmpFiles) { try { await fs.promises.unlink(t); } catch (_) {} }
            throw e;
        }
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
        let userCount = 0;
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
            let userAdded = 0;
            for (const f of userFiles) {
                try {
                    await add(f.full, { name: f.name, store: STORE_EXT.test(f.name) });
                    userAdded++;
                } catch (e) {
                    if (failure) throw failure;
                    userSkipped++;
                    log('skip', f.name, e && e.message);
                }
            }
            userCount = userAdded;
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
        } finally {
            for (const t of tmpFiles) { try { await fs.promises.unlink(t); } catch (_) {} }
        }
        return { filePath, encrypted: seal, files: files.length - skipped, skipped, userFiles: userCount, userSkipped };
    }

    /** SHA-256 of a file, streamed. */
    function _sha256(file) {
        return new Promise((res, rej) => {
            const h = crypto.createHash('sha256');
            const s = fs.createReadStream(file);
            s.on('error', rej);
            s.on('data', c => h.update(c));
            s.on('end', () => res(h.digest('hex')));
        });
    }

    /**
     * Copy a finished backup into `folder` (same file name), via ".partial",
     * then check it byte-for-byte by SHA-256 before the rename.
     */
    async function copyToSecondary(filePath, folder) {
        if (!folderOk(folder)) {
            throw new Error('The secondary backup folder can’t be reached: ' + folder + ' (is the drive connected / cloud folder synced?)');
        }
        const dest = path.join(folder, path.basename(filePath));
        const partial = dest + '.partial';
        try {
            const want = await _sha256(filePath);
            await new Promise((res, rej) => {
                const r = fs.createReadStream(filePath);
                const w = fs.createWriteStream(partial);
                r.on('error', rej); w.on('error', rej);
                w.on('close', res);
                r.pipe(w);
            });
            const got = await _sha256(partial);
            if (got !== want) throw new Error('The copy in the secondary folder did not match the backup (checksum differs).');
            await fs.promises.rename(partial, dest);
            return { filePath: dest, sha256: want };
        } catch (e) {
            try { await fs.promises.unlink(partial); } catch (_) {}
            throw e;
        }
    }

    /**
     * One backup, every location. Writes to the Backup Destination and copies
     * to the secondary folder (when on). If the primary can't be reached the
     * backup is written straight into the secondary folder instead. Throws
     * only when no copy could be made.
     * Returns { ok, filePath, encrypted, files, skipped, userFiles,
     *   userSkipped, primaryError, secondary: null | { filePath, error } }.
     */
    async function backupNow({ folder, data, encrypt, kind }) {
        const cfg = load();
        kind = kind === 'auto' ? 'auto' : 'manual';
        const secFolder = cfg.secondaryEnabled && cfg.secondaryFolder && !samePlace(cfg.secondaryFolder, folder)
            ? cfg.secondaryFolder : null;

        let r = null, primaryError = null;
        if (folder && folderOk(folder)) {
            try { r = await writeBackup({ folder, data, encrypt, kind }); }
            catch (e) {
                // Locked Field Security fails everywhere — don't retry it.
                if (/locked/i.test((e && e.message) || '')) throw e;
                primaryError = (e && e.message) || String(e);
            }
        } else {
            primaryError = folder
                ? 'The backup folder can’t be reached: ' + folder + ' (is the drive connected?)'
                : 'No Backup Destination is set.';
        }

        let secondary = null;
        if (secFolder) {
            try {
                if (r) {
                    const c = await copyToSecondary(r.filePath, secFolder);
                    secondary = { filePath: c.filePath, error: null };
                } else {
                    if (!folderOk(secFolder)) {
                        throw new Error('The secondary backup folder can’t be reached: ' + secFolder + ' (is the drive connected / cloud folder synced?)');
                    }
                    r = await writeBackup({ folder: secFolder, data, encrypt, kind });
                    secondary = { filePath: r.filePath, error: null };
                }
            } catch (e) {
                secondary = { filePath: null, error: (e && e.message) || String(e) };
            }
        }

        if (!r) throw new Error(primaryError + (secondary && secondary.error ? ' — ' + secondary.error : ''));

        // "Last backup" points at the primary copy when there is one.
        const mainFile = primaryError ? null : r.filePath;
        record(mainFile || r.filePath, kind);
        if (secFolder) {
            save(secondary && !secondary.error
                ? { lastSecondaryAt: new Date(now()).toISOString(), lastSecondaryFile: secondary.filePath, lastSecondaryError: null }
                : { lastSecondaryError: secondary.error });
        }
        return Object.assign({ ok: true }, r, { primaryError, secondary });
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
                const secOn = !!(cfg.secondaryEnabled && cfg.secondaryFolder);
                if (!folderOk(cfg.folder) && !(secOn && folderOk(cfg.secondaryFolder))) {
                    throw new Error('The backup folder can’t be reached: ' + (cfg.folder || '(none)')
                        + (secOn ? ' — nor the secondary folder: ' + cfg.secondaryFolder : '')
                        + ' (is the drive connected?)');
                }
                const count = caseCountOf(data);
                if (count === 0 && Number(cfg.lastCaseCount) > 0) {
                    throw new Error('No cases were found in VIPER, so the automatic backup was skipped to keep your earlier backups safe.');
                }
                const r = await backupNow({ folder: cfg.folder, data, encrypt: cfg.encrypt, kind: 'auto' });
                // A copy was made; a location that failed is still reported.
                const warn = [r.primaryError, r.secondary && r.secondary.error].filter(Boolean).join(' — ');
                save({ lastError: warn || null, lastCaseCount: count });
                let removed = [];
                if (!r.primaryError) removed = removed.concat(await prune(cfg.folder, cfg.keep));
                if (r.secondary && !r.secondary.error) removed = removed.concat(await prune(cfg.secondaryFolder, cfg.keep));
                log('done', r.filePath, r.files + ' files', removed.length ? 'pruned ' + removed.length : '', warn);
                return Object.assign({ ok: true, cases: count, pruned: removed.length, warning: warn || null }, r);
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
        if (cfg.secondaryFolder) addF(cfg.secondaryFolder);
        if (cfg.lastBackupFile) addF(path.dirname(cfg.lastBackupFile));
        if (cfg.lastAutoFile) addF(path.dirname(cfg.lastAutoFile));
        if (cfg.lastSecondaryFile) addF(path.dirname(cfg.lastSecondaryFile));
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
        for (const lf of [cfg.lastBackupFile, cfg.lastAutoFile, cfg.lastSecondaryFile]) {
            if (!lf || seen.has(String(lf).toLowerCase())) continue;
            seen.add(String(lf).toLowerCase());
            try { const d = await _describe(lf); if (d) out.push(d); } catch (_) {}
        }
        out.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
        return { backups: out, searched: folders.map(x => x.f) };
    }

    /** base + rel, or null when rel would land outside base (zip-slip). */
    function _inside(base, rel) {
        rel = String(rel || '').replace(/\\/g, '/');
        if (!rel || rel.startsWith('/') || /^[a-z]:/i.test(rel) || rel.split('/').some(p => p === '..')) return null;
        const root = path.resolve(base);
        const dest = path.resolve(root, rel);
        return dest.toLowerCase().startsWith(root.toLowerCase() + path.sep) ? dest : null;
    }

    async function _writeAtomic(dest, buf) {
        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
        const tmp = dest + '.restore-tmp';
        await fs.promises.writeFile(tmp, buf);
        try { await fs.promises.rename(tmp, dest); }
        catch (e) { try { await fs.promises.unlink(tmp); } catch (_) {} throw e; }
    }

    /**
     * Restore a .vbak (manual or automatic). Case files go back under the
     * cases folder (re-encrypted when Field Security is on); userdata/…
     * entries go back into userData, except the audit log, which lands in
     * userData/restored-audit/<time>/ so the live hash chain is untouched.
     * Returns { jsonData, filesRestored, filesReEncrypted, filesPlaintext,
     *   outerEncrypted, userDataRestored, auditRestoredTo, blocked }.
     */
    async function restoreBackup(backupPath) {
        const AdmZip = deps.AdmZip || require('adm-zip');
        const security = getSecurity();
        let raw = await fs.promises.readFile(backupPath);

        const outerEncrypted = !!(security && security.isEncryptedBuffer(raw));
        if (outerEncrypted) {
            if (!security.isUnlocked()) {
                throw new Error(
                    'This backup file is encrypted (sealed under Field Security). ' +
                    'Unlock Field Security with the password or recovery key that ' +
                    'was active when this backup was created, then try again.');
            }
            try { raw = security.decryptBuffer(raw); }
            catch (_) {
                throw new Error(
                    'Could not unwrap the encrypted backup envelope — the current ' +
                    'Field Security key does not match the one used to create this ' +
                    'backup.  Use the Recovery panel with the original security.json.');
            }
        }

        const zip = new AdmZip(raw);
        const entries = zip.getEntries();
        const jsonEntry = entries.find(e => e.entryName === 'viper_data.json');
        if (!jsonEntry) throw new Error('Invalid backup: missing viper_data.json');
        const jsonData = jsonEntry.getData().toString('utf-8');

        const casesDir = getCasesDir();
        const reEncrypt = !!(security && security.isEnabled() && security.isUnlocked());
        let filesRestored = 0, filesReEncrypted = 0, filesPlaintext = 0;
        let userDataRestored = 0, blocked = 0;
        let auditDir = null;
        const sqliteEntries = new Map();      // item name → { main, wal }

        for (const entry of entries) {
            if (entry.isDirectory) continue;
            const name = String(entry.entryName).replace(/\\/g, '/');

            if (name.startsWith('cases/')) {
                const dest = _inside(casesDir, name.slice('cases/'.length));
                if (!dest) { blocked++; log('restore blocked', name); continue; }
                let buf = entry.getData();
                const already = !!(security && security.isEncryptedBuffer(buf));
                if (reEncrypt && !already) {
                    try { buf = security.encryptBuffer(buf); filesReEncrypted++; }
                    catch (e) { log('re-encrypt failed', dest, e && e.message); }
                } else if (!already) {
                    filesPlaintext++;
                }
                await fs.promises.mkdir(path.dirname(dest), { recursive: true });
                await fs.promises.writeFile(dest, buf);
                filesRestored++;
                continue;
            }

            if (!name.startsWith('userdata/') || !userDataDir) continue;
            const rel = name.slice('userdata/'.length);
            const top = rel.split('/')[0];
            const item = userDataItems.find(i => i.name === top || (i.type === 'sqlite' && top === i.name + '-wal'));
            if (!item) { blocked++; log('restore unknown userdata', name); continue; }

            if (item.type === 'audit') {
                const base = rel.slice(top.length + 1);
                if (!AUDIT_RE.test(base)) { blocked++; continue; }
                if (!auditDir) auditDir = path.join(userDataDir, 'restored-audit', fileStamp(new Date(now())));
                const dest = _inside(auditDir, base);
                if (!dest) { blocked++; continue; }
                await _writeAtomic(dest, entry.getData());
                userDataRestored++;
            } else if (item.type === 'sqlite') {
                if (rel !== item.name && rel !== item.name + '-wal') { blocked++; continue; }
                const s = sqliteEntries.get(item.name) || {};
                s[rel === item.name ? 'main' : 'wal'] = entry.getData();
                sqliteEntries.set(item.name, s);
            } else {
                const dest = _inside(userDataDir, rel);
                if (!dest || !dest.toLowerCase().startsWith(path.resolve(userDataDir, top).toLowerCase() + path.sep)) {
                    blocked++; continue;
                }
                await _writeAtomic(dest, entry.getData());
                userDataRestored++;
            }
        }

        // Databases: close the live handle, swap the file, drop stale WAL/SHM.
        for (const [n, s] of sqliteEntries) {
            if (!s.main) continue;
            const dest = path.join(userDataDir, n);
            try { if (sqlite[n] && typeof sqlite[n].close === 'function') sqlite[n].close(); }
            catch (e) { log('close failed', n, e && e.message); }
            for (const ext of ['-wal', '-shm']) { try { await fs.promises.unlink(dest + ext); } catch (_) {} }
            await _writeAtomic(dest, s.main);
            userDataRestored++;
            if (s.wal) { await _writeAtomic(dest + '-wal', s.wal); userDataRestored++; }
        }

        return {
            jsonData, filesRestored, filesReEncrypted, filesPlaintext, outerEncrypted,
            userDataRestored, auditRestoredTo: auditDir, blocked,
        };
    }

    /** Wire the IPC channels. */
    function register(ipcMain) {
        ipcMain.handle('auto-backup-get', () => getState());
        ipcMain.handle('auto-backup-set', (e, patch) => setConfig(patch));
        ipcMain.handle('auto-backup-run', (e, args) => runAuto(args || {}));
        ipcMain.handle('backup-list', (e, args) => listBackups(args && args.folders));
    }

    return { load, save, getState, setConfig, record, writeBackup, copyToSecondary, backupNow, prune, runAuto, listBackups, restoreBackup, register };
}

module.exports = { createAutoBackup, isDue, nextDueAt, stampOf, caseCountOf, clampKeep, DEFAULTS, AUTO_RE, ANY_RE, USERDATA_ITEMS };

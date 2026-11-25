'use strict';
/*
 * modules/case-forms/form-store.js — main process (node).
 *
 * Installed agency form sets, the dashboard library client, the case's
 * Forms folder, and the IPC the Settings page and the Forms case tab use.
 *
 *   userData/case-forms/<set id>/
 *     manifest.json
 *     forms/<form id>.pdf       byte-identical to the agency's original
 *     install-info.json         { installedAt, source: 'library'|'file', sourceName, sha256 }
 *
 * A set is checked in full before anything is written (readFormSetBuffer),
 * written into a staging folder, re-hashed from disk and swapped in with a
 * rename, so a failed install never leaves half a set. Every PDF is
 * re-hashed against the manifest each time it is used.
 *
 * Library downloads must match the SHA-256 the catalogue advertised (and
 * the one the server sends in X-Form-Set-Sha256) before they are opened.
 *
 * Filled forms go to cases/<n>/Forms/ — encrypted when Field Security is on.
 * While Field Security is on but locked nothing is written (the shared case
 * writer would otherwise store a plaintext copy).
 */

const nodePath = require('path');
const FS = require('./form-set.js');

const { FormSetError, readFormSetBuffer, validateManifest, summarize, compareVersions, ID_RE, FORM_ID_RE, LIMITS } = FS;

const INSTALL_INFO = 'install-info.json';
const DEFAULT_LIBRARY_URL = 'https://intellect-unified-dashboard-production.up.railway.app';
const MAX_SET_FILE_BYTES = 100 * 1024 * 1024;      // same cap as the dashboard upload
const MAX_CATALOGUE_BYTES = 8 * 1024 * 1024;
const FORMS_SUBDIR = 'Forms';
const SHA_RE = /^[0-9a-f]{64}$/;
const MAX_VALUE_KEYS = 2000;
const MAX_VALUE_CHARS = 20000;

const fail = (msg) => { throw new FormSetError(msg); };
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/* ------------------------------------------------------------------------ */
/* Installed sets                                                           */
/* ------------------------------------------------------------------------ */

function createFormStore(deps) {
    const { fs, path, crypto } = deps;
    const rootDir = deps.rootDir;
    const stagingRoot = deps.stagingRoot || (rootDir + '-staging');
    const now = deps.now || (() => Date.now());
    const maxFileBytes = deps.maxFileBytes || MAX_SET_FILE_BYTES;
    if (!rootDir) throw new Error('case forms: rootDir is required');

    const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
    const setDir = (id) => {
        if (typeof id !== 'string' || !ID_RE.test(id)) fail('Invalid form set id');
        return path.join(rootDir, id);
    };
    const readJson = (file, label, max) => {
        let st;
        try { st = fs.statSync(file); } catch (_) { fail(`${label} is missing`); }
        if (st.size > (max || LIMITS.maxManifestBytes)) fail(`${label} is too large`);
        try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { fail(`${label} is not valid JSON`); }
    };
    const rmrf = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ } };

    function readInfo(id) {
        try {
            const info = readJson(path.join(setDir(id), INSTALL_INFO), INSTALL_INFO, 64 * 1024);
            return isPlainObject(info) ? info : {};
        } catch (_) { return {}; }
    }

    function installedVersion(id) {
        try { return readJson(path.join(setDir(id), 'manifest.json'), 'manifest.json').version || null; } catch (_) { return null; }
    }

    function readFile(filePath) {
        if (typeof filePath !== 'string' || !filePath) fail('No form set file chosen');
        let st;
        try { st = fs.statSync(filePath); } catch (_) { fail('The form set file could not be read'); }
        if (!st.isFile()) fail('The form set file could not be read');
        if (st.size > maxFileBytes) fail('The form set file is too large');
        return fs.readFileSync(filePath);
    }

    /**
     * Install a .viperforms held in memory.
     * opts: { source: 'library'|'file', sourceName, expectedSha256, expectedId }
     */
    function installBuffer(buf, opts) {
        opts = opts || {};
        if (!Buffer.isBuffer(buf) || !buf.length) fail('Nothing to install');
        if (buf.length > maxFileBytes) fail('The form set file is too large');
        const fileSha = sha256(buf);
        if (opts.expectedSha256 != null && fileSha !== opts.expectedSha256) fail('The form set download is damaged (checksum mismatch). Try again.');
        const { manifest, pdfs } = readFormSetBuffer(buf);
        const id = manifest.id;
        if (opts.expectedId != null && id !== opts.expectedId) fail('The library sent a different form set than the one requested');
        const stamp = now();
        fs.mkdirSync(rootDir, { recursive: true });
        fs.mkdirSync(stagingRoot, { recursive: true });
        const stage = path.join(stagingRoot, `${id}-${stamp}`);
        rmrf(stage);
        const info = {
            installedAt: new Date(stamp).toISOString(),
            source: opts.source === 'library' ? 'library' : 'file',
            sourceName: str(opts.sourceName, 200),
            sha256: fileSha,
        };
        try {
            const write = (rel, data) => {
                const dest = path.join(stage, ...rel.split('/'));
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.writeFileSync(dest, data);
            };
            write('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
            for (const f of manifest.forms) write(f.file, pdfs.get(f.id));
            write(INSTALL_INFO, Buffer.from(JSON.stringify(info, null, 2), 'utf8'));
            for (const f of manifest.forms) {
                if (sha256(fs.readFileSync(path.join(stage, ...f.file.split('/')))) !== f.sha256) fail(`Write check failed: ${f.file}`);
            }
            const dest = setDir(id);
            const previousVersion = installedVersion(id);
            const old = path.join(stagingRoot, `${id}-${stamp}-previous`);
            const hadOld = fs.existsSync(dest);
            if (hadOld) fs.renameSync(dest, old);
            try {
                fs.renameSync(stage, dest);
            } catch (e) {
                if (hadOld) { try { fs.renameSync(old, dest); } catch (_) { /* old stays in staging */ } }
                throw e;
            }
            if (hadOld) rmrf(old);
            return summarize(manifest, { installedAt: info.installedAt, source: info.source, sha256: fileSha, previousVersion });
        } finally {
            rmrf(stage);
        }
    }

    function installFile(filePath) {
        const buf = readFile(filePath);
        return installBuffer(buf, { source: 'file', sourceName: path.basename(filePath) });
    }

    // Describe a .viperforms without installing it.
    function inspectFile(filePath) {
        const buf = readFile(filePath);
        const { manifest } = readFormSetBuffer(buf);
        const iv = installedVersion(manifest.id);
        const vs = iv ? compareVersions(manifest.version, iv) : null;
        return summarize(manifest, { sizeBytes: buf.length, installedVersion: iv, versionVsInstalled: vs, olderThanInstalled: vs === -1 });
    }

    function load(id) {
        const dir = setDir(id);
        if (!fs.existsSync(dir)) fail('That form set is not installed');
        const manifest = validateManifest(readJson(path.join(dir, 'manifest.json'), 'manifest.json'));
        if (manifest.id !== id) fail('Form set folder does not match its id');
        return manifest;
    }

    function list() {
        let names = [];
        try { names = fs.readdirSync(rootDir); } catch (_) { return []; }
        const out = [];
        for (const name of names.sort()) {
            if (!ID_RE.test(name)) continue;
            try { if (!fs.statSync(path.join(rootDir, name)).isDirectory()) continue; } catch (_) { continue; }
            try {
                const manifest = load(name);
                const info = readInfo(name);
                out.push(summarize(manifest, {
                    installedAt: info.installedAt || null,
                    source: info.source === 'library' ? 'library' : 'file',
                    sha256: typeof info.sha256 === 'string' && SHA_RE.test(info.sha256) ? info.sha256 : null,
                }));
            } catch (e) {
                out.push({ id: name, error: e.message || String(e) });
            }
        }
        return out;
    }

    const hasAny = () => list().some(s => !s.error);

    function getForm(setId, formId, manifest) {
        const m = manifest || load(setId);
        if (typeof formId !== 'string' || !FORM_ID_RE.test(formId)) fail('Unknown form');
        const form = m.forms.find(f => f.id === formId);
        if (!form) fail('That form is not in this set');
        return { manifest: m, form };
    }

    // The original PDF, hash-checked.
    function readPdf(setId, formId, manifest) {
        const { form } = getForm(setId, formId, manifest);
        const file = path.join(setDir(setId), ...form.file.split('/'));
        let st;
        try { st = fs.statSync(file); } catch (_) { fail(`Form missing on disk: ${form.title}. Reinstall the set.`); }
        if (st.size > LIMITS.maxPdfBytes) fail('The form file is too large');
        const buf = fs.readFileSync(file);
        if (sha256(buf) !== form.sha256) fail(`The form has been changed on disk (${form.title}). Reinstall the set.`);
        return buf;
    }

    function verify(id) {
        let m;
        try { m = load(id); } catch (e) { return { ok: false, problems: [e.message] }; }
        const problems = [];
        for (const f of m.forms) {
            try {
                if (sha256(fs.readFileSync(path.join(setDir(id), ...f.file.split('/')))) !== f.sha256) problems.push(`Changed: ${f.file}`);
            } catch (_) { problems.push(`Missing: ${f.file}`); }
        }
        return { ok: !problems.length, problems, formCount: m.forms.length };
    }

    function remove(id) {
        const dir = setDir(id);
        if (!fs.existsSync(dir)) return { removed: false };
        const version = installedVersion(id);
        fs.mkdirSync(stagingRoot, { recursive: true });
        const trash = path.join(stagingRoot, `${id}-${now()}-removed`);
        fs.renameSync(dir, trash);
        rmrf(trash);
        return { removed: true, version };
    }

    return { rootDir, stagingRoot, installBuffer, installFile, inspectFile, load, list, hasAny, getForm, readPdf, verify, remove, readInfo };
}

/* ------------------------------------------------------------------------ */
/* Dashboard library                                                        */
/* ------------------------------------------------------------------------ */

class LibraryError extends FormSetError {
    constructor(message, status) { super(message); this.name = 'LibraryError'; this.status = status || 0; }
}

function cleanEntry(e) {
    if (!isPlainObject(e)) return null;
    if (typeof e.id !== 'string' || !ID_RE.test(e.id)) return null;
    if (typeof e.name !== 'string' || !e.name.trim() || typeof e.version !== 'string' || !e.version.trim()) return null;
    if (typeof e.sha256 !== 'string' || !SHA_RE.test(e.sha256)) return null;
    const size = Number(e.size);
    if (!Number.isFinite(size) || size <= 0 || size > MAX_SET_FILE_BYTES) return null;
    const forms = (Array.isArray(e.forms) ? e.forms : []).slice(0, LIMITS.maxForms)
        .filter(f => isPlainObject(f) && typeof f.id === 'string' && FORM_ID_RE.test(f.id))
        .map(f => ({ id: f.id, title: str(f.title, 160) || f.id, category: str(f.category, 60), language: str(f.language, 8), group: str(f.group, 60) }));
    return {
        id: e.id,
        name: str(e.name, 120),
        agency: str(e.agency, 160),
        description: str(e.description, 2000),
        version: str(e.version, 40),
        sha256: e.sha256,
        size,
        formCount: Number.isInteger(e.formCount) ? e.formCount : forms.length,
        forms,
        updatedAt: str(e.updatedAt, 40) || null,
    };
}

/**
 * deps: { fetch, baseUrl?, maxBytes?, timeoutMs?, downloadTimeoutMs? }
 */
function createLibraryClient(deps) {
    deps = deps || {};
    const doFetch = deps.fetch || (typeof fetch === 'function' ? fetch : null);
    const base = String(deps.baseUrl || DEFAULT_LIBRARY_URL).replace(/\/+$/, '');
    const maxBytes = deps.maxBytes || MAX_SET_FILE_BYTES;
    const timeoutMs = deps.timeoutMs || 30000;
    const downloadTimeoutMs = deps.downloadTimeoutMs || 15 * 60 * 1000;
    const crypto = deps.crypto || require('crypto');

    async function request(url, apiKey, ms, notFoundMsg) {
        if (!doFetch) throw new LibraryError('The form library is not available in this build');
        if (typeof apiKey !== 'string' || !apiKey) throw new LibraryError('Missing API key — register VIPER first', 401);
        const ctl = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = ctl ? setTimeout(() => ctl.abort(), ms) : null;
        let resp;
        try {
            resp = await doFetch(url, { method: 'GET', headers: { 'X-API-Key': apiKey }, signal: ctl ? ctl.signal : undefined });
        } catch (e) {
            if (timer) clearTimeout(timer);
            throw new LibraryError(e && e.name === 'AbortError'
                ? 'The form library did not answer in time'
                : 'Could not reach the form library (check the internet connection)');
        }
        if (!resp.ok) {
            if (timer) clearTimeout(timer);
            let detail = '';
            try {
                const t = await resp.text();
                try { const j = JSON.parse(t); detail = j && (j.detail || j.error) || ''; } catch (_) { detail = t; }
            } catch (_) { /* ignore */ }
            if (typeof detail !== 'string') detail = '';
            detail = detail.slice(0, 300);
            if (resp.status === 404) throw new LibraryError(detail && !/^not found$/i.test(detail) ? detail : (notFoundMsg || 'That form set is no longer in the library'), 404);
            throw new LibraryError(detail || `The form library answered HTTP ${resp.status}`, resp.status);
        }
        return { resp, done: () => { if (timer) clearTimeout(timer); } };
    }

    // Reads the body, refusing to buffer more than cap bytes.
    async function readCapped(resp, cap, tooBig) {
        const len = Number(resp.headers && resp.headers.get && resp.headers.get('content-length'));
        if (Number.isFinite(len) && len > cap) throw new LibraryError(tooBig);
        const body = resp.body;
        if (body && typeof body.getReader === 'function') {
            const reader = body.getReader();
            const chunks = [];
            let total = 0;
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                total += value.length;
                if (total > cap) { try { await reader.cancel(); } catch (_) { /* ignore */ } throw new LibraryError(tooBig); }
                chunks.push(Buffer.from(value));
            }
            return Buffer.concat(chunks, total);
        }
        const buf = Buffer.from(await resp.arrayBuffer());
        if (buf.length > cap) throw new LibraryError(tooBig);
        return buf;
    }

    async function catalogue(apiKey) {
        const { resp, done } = await request(base + '/api/form-sets', apiKey, timeoutMs,
            'The VIPER form library is not online yet.');
        let json;
        try {
            const buf = await readCapped(resp, MAX_CATALOGUE_BYTES, 'The form library list is too large');
            json = JSON.parse(buf.toString('utf8'));
        } catch (e) {
            if (e instanceof LibraryError) throw e;
            throw new LibraryError('The form library sent an unreadable list');
        } finally { done(); }
        if (!isPlainObject(json) || !Array.isArray(json.sets)) throw new LibraryError('The form library sent an unreadable list');
        const seen = new Set();
        const sets = [];
        for (const raw of json.sets.slice(0, 500)) {
            const e = cleanEntry(raw);
            if (!e || seen.has(e.id)) continue;
            seen.add(e.id);
            sets.push(e);
        }
        return sets;
    }

    // entry: a catalogue entry (id + sha256 + size). Returns the verified bytes.
    async function download(apiKey, entry) {
        const e = cleanEntry(entry);
        if (!e) throw new LibraryError('Unknown form set');
        const { resp, done } = await request(`${base}/api/form-sets/${encodeURIComponent(e.id)}/download`, apiKey, downloadTimeoutMs);
        let buf;
        try {
            const headerSha = String((resp.headers && resp.headers.get && resp.headers.get('x-form-set-sha256')) || '').toLowerCase();
            if (headerSha && headerSha !== e.sha256) throw new LibraryError('The form set changed in the library while downloading. Refresh and try again.');
            buf = await readCapped(resp, Math.min(maxBytes, MAX_SET_FILE_BYTES), 'The form set is too large to download');
        } finally { done(); }
        const got = crypto.createHash('sha256').update(buf).digest('hex');
        if (got !== e.sha256) throw new LibraryError('The form set download is damaged (checksum mismatch). Try again.');
        return buf;
    }

    return { baseUrl: base, catalogue, download };
}

/* ------------------------------------------------------------------------ */
/* The case's Forms folder                                                  */
/* ------------------------------------------------------------------------ */

function safeCaseNumber(s) {
    if (typeof s !== 'string') return null;
    const v = s.trim();
    if (!v || v.length > 200 || v.includes('..') || /[\\/\x00-\x1f]/.test(v)) return null;
    return v;
}

// "<Title> - <hint> - 2026-11-25.pdf" with nothing a filesystem or a path could object to.
function outputFileName(title, hint, date) {
    const clean = (s) => String(s || '').replace(/[\\/\x00-\x1f<>:"|?*]/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
    const d = date instanceof Date ? date : new Date();
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    let stem = clean(title).slice(0, 120) || 'Form';
    const h = clean(hint).slice(0, 60);
    if (h) stem += ' - ' + h;
    return `${stem} - ${ymd}.pdf`;
}

/**
 * deps: { fs, path, casesDir | getCasesDir(), security | getSecurity(),
 *         writeCaseFile(caseNumber, subdir, name, bytes) → { fileName }, tempDir, shell, now }
 */
function createCaseForms(deps) {
    const { fs, path } = deps;
    const now = deps.now || (() => Date.now());
    const sec = () => (typeof deps.getSecurity === 'function' ? deps.getSecurity() : deps.security) || null;
    const casesDir = () => (typeof deps.getCasesDir === 'function' ? deps.getCasesDir() : deps.casesDir);
    const locked = () => { const s = sec(); return !!(s && s.isEnabled() && !s.isUnlocked()); };

    const needCase = (cn) => {
        const v = safeCaseNumber(cn);
        if (!v) fail('Open a case first');
        return v;
    };
    const formsDir = (cn) => {
        const root = casesDir();
        if (!root) fail('The cases folder is not available');
        return path.join(root, needCase(cn), FORMS_SUBDIR);
    };

    function save(caseNumber, fileName, bytes) {
        const cn = needCase(caseNumber);
        if (locked()) fail('Unlock Field Security first — filled forms are saved encrypted with the case');
        return deps.writeCaseFile(cn, FORMS_SUBDIR, fileName, bytes);
    }

    function listFiles(caseNumber) {
        const dir = formsDir(caseNumber);
        let names = [];
        try { names = fs.readdirSync(dir); } catch (_) { return []; }
        const out = [];
        for (const n of names) {
            if (!/\.pdf$/i.test(n)) continue;
            try {
                const st = fs.statSync(path.join(dir, n));
                if (!st.isFile()) continue;
                out.push({ fileName: n, size: st.size, modifiedAt: new Date(st.mtimeMs).toISOString() });
            } catch (_) { /* vanished */ }
        }
        return out.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : a.modifiedAt > b.modifiedAt ? -1 : a.fileName.localeCompare(b.fileName)));
    }

    function filePath(caseNumber, fileName) {
        if (typeof fileName !== 'string' || !fileName || fileName.length > 255 || fileName !== nodePath.basename(fileName)
            || /[\\/\x00-\x1f]/.test(fileName) || fileName === '.' || fileName === '..' || !/\.pdf$/i.test(fileName)) fail('Unknown form file');
        const p = path.join(formsDir(caseNumber), fileName);
        if (!fs.existsSync(p)) fail('That form is no longer in the case folder');
        return p;
    }

    async function open(caseNumber, fileName, action) {
        const p = filePath(caseNumber, fileName);
        if (!deps.shell) fail('Opening files is not available');
        if (action === 'show') { deps.shell.showItemInFolder(p); return { shown: true }; }
        let target = p;
        const s = sec();
        const head = Buffer.alloc(64);
        const fd = fs.openSync(p, 'r');
        try { fs.readSync(fd, head, 0, 64, 0); } finally { fs.closeSync(fd); }
        if (s && s.isEncryptedBuffer && s.isEncryptedBuffer(head)) {
            if (!s.isUnlocked()) fail('This form is encrypted; unlock Field Security to open it');
            fs.mkdirSync(deps.tempDir, { recursive: true });
            target = path.join(deps.tempDir, `${now()}_${fileName}`);
            fs.writeFileSync(target, s.decryptBuffer(fs.readFileSync(p)));
        }
        const err = await deps.shell.openPath(target);
        if (err) fail('Could not open the form: ' + err);
        return { opened: true };
    }

    // A filled form that is not saved anywhere yet: a temp copy for the PDF viewer
    // (same temp folder decrypted case copies use).
    async function openTemp(fileName, bytes) {
        if (!deps.shell || !deps.tempDir) fail('Opening files is not available');
        const name = typeof fileName === 'string' && fileName === nodePath.basename(fileName) && /\.pdf$/i.test(fileName) ? fileName : 'Form.pdf';
        fs.mkdirSync(deps.tempDir, { recursive: true });
        const target = path.join(deps.tempDir, `${now()}_${name}`);
        fs.writeFileSync(target, bytes);
        const err = await deps.shell.openPath(target);
        if (err) fail('Could not open the form: ' + err);
        return { opened: true };
    }

    return { save, listFiles, open, openTemp, locked };
}

/* ------------------------------------------------------------------------ */
/* IPC                                                                      */
/* ------------------------------------------------------------------------ */

function checkValues(values) {
    if (values == null) return {};
    if (!isPlainObject(values)) fail('The form values could not be read');
    const keys = Object.keys(values);
    if (keys.length > MAX_VALUE_KEYS) fail('The form has too many values');
    const out = {};
    for (const k of keys) {
        if (!k || k.length > LIMITS.maxFieldName) fail('The form has a bad field name');
        const v = values[k];
        if (typeof v === 'boolean') out[k] = v;
        else if (typeof v === 'string') {
            if (v.length > MAX_VALUE_CHARS) fail(`The value for "${k.slice(0, 60)}" is too long`);
            out[k] = v;
        } else if (v == null) continue;
        else fail(`The value for "${k.slice(0, 60)}" must be text or a checkbox state`);
    }
    return out;
}

// Catalogue + installed, one row per set.
function mergeLibrary(catalogue, installed) {
    const byId = new Map(installed.map(s => [s.id, s]));
    const rows = [];
    for (const e of catalogue) {
        const inst = byId.get(e.id);
        byId.delete(e.id);
        const ok = inst && !inst.error;
        let updateAvailable = false;
        if (ok) {
            updateAvailable = inst.source === 'library'
                ? (inst.sha256 ? inst.sha256 !== e.sha256 : compareVersions(e.version, inst.version) === 1)
                : compareVersions(e.version, inst.version) === 1;
        }
        rows.push(Object.assign({}, e, {
            inLibrary: true,
            installed: !!inst,
            installedVersion: ok ? inst.version : null,
            installedSource: ok ? inst.source : null,
            installedAt: ok ? (inst.installedAt || null) : null,
            installError: inst && inst.error ? inst.error : null,
            updateAvailable,
        }));
    }
    for (const inst of byId.values()) {
        rows.push(Object.assign({}, inst, {
            inLibrary: false,
            installed: true,
            installedVersion: inst.error ? null : inst.version,
            installedSource: inst.error ? null : inst.source,
            installError: inst.error || null,
            updateAvailable: false,
        }));
    }
    return rows;
}

/**
 * deps: { library, caseForms, pdfForm?, dialog, getWindow, restoreFocus, defaultDir,
 *         audit, AUDIT_EVENTS, writeFile }
 */
function registerFormIpc(ipcMain, store, deps) {
    deps = deps || {};
    const pdfForm = deps.pdfForm || require('./pdf-form.js');
    const audit = (ev, data) => { try { if (deps.audit && deps.AUDIT_EVENTS && deps.AUDIT_EVENTS[ev]) deps.audit().write(deps.AUDIT_EVENTS[ev], data); } catch (_) { /* never block */ } };
    const wrap = (fn) => async (...args) => {
        try { return Object.assign({ success: true }, await fn(...args)); } catch (e) {
            const out = { success: false, error: e instanceof FormSetError ? e.message : ('Agency forms error: ' + (e && e.message || e)) };
            if (e && e.status) out.status = e.status;
            return out;
        }
    };
    const req = (r) => (isPlainObject(r) ? r : {});
    const lib = () => { if (!deps.library) fail('The form library is not available'); return deps.library; };
    const cases = () => { if (!deps.caseForms) fail('Saving to the case is not available'); return deps.caseForms; };

    ipcMain.handle('case-forms-installed', wrap(async () => ({ sets: store.list() })));

    // Library list merged with what is installed. Offline → installed sets only, plus the reason.
    ipcMain.handle('case-forms-library', wrap(async (_e, r) => {
        const installed = store.list();
        try {
            const cat = await lib().catalogue(req(r).apiKey);
            return { sets: mergeLibrary(cat, installed), online: true };
        } catch (e) {
            return {
                sets: mergeLibrary([], installed),
                online: false,
                libraryError: e instanceof FormSetError ? e.message : String(e && e.message || e),
                libraryStatus: (e && e.status) || 0,
            };
        }
    }));

    // Switch a library set on (or update it): download, verify, install.
    ipcMain.handle('case-forms-enable', wrap(async (_e, r) => {
        r = req(r);
        const id = typeof r.id === 'string' ? r.id : '';
        if (!ID_RE.test(id)) fail('Unknown form set');
        const cat = await lib().catalogue(r.apiKey);
        const entry = cat.find(e => e.id === id);
        if (!entry) fail('That form set is no longer in the library');
        const buf = await lib().download(r.apiKey, entry);
        const set = store.installBuffer(buf, { source: 'library', sourceName: entry.name, expectedSha256: entry.sha256, expectedId: id });
        audit('CASE_FORM_SET_INSTALLED', { set_id: set.id, version: set.version, forms: set.formCount, source: 'library', previous_version: set.previousVersion || null });
        return { set };
    }));

    ipcMain.handle('case-forms-remove', wrap(async (_e, id) => {
        const res = store.remove(id);
        if (res.removed) audit('CASE_FORM_SET_REMOVED', { set_id: id, version: res.version });
        return res;
    }));

    ipcMain.handle('case-forms-verify', wrap(async (_e, id) => store.verify(id)));

    // Offline install from a .viperforms file.
    ipcMain.handle('case-forms-choose-file', wrap(async () => {
        const win = deps.getWindow && deps.getWindow();
        let res;
        try {
            res = await deps.dialog.showOpenDialog(win || undefined, {
                title: 'Import agency form set',
                filters: [{ name: 'VIPER form set', extensions: ['viperforms'] }],
                properties: ['openFile'],
            });
        } finally { try { if (deps.restoreFocus) deps.restoreFocus(); } catch (_) { /* ignore */ } }
        if (!res || res.canceled || !res.filePaths || !res.filePaths.length) return { canceled: true };
        const filePath = res.filePaths[0];
        return { filePath, summary: store.inspectFile(filePath) };
    }));
    ipcMain.handle('case-forms-install-file', wrap(async (_e, filePath) => {
        if (typeof filePath !== 'string' || !/\.viperforms$/i.test(filePath)) fail('Choose a .viperforms file');
        const set = store.installFile(filePath);
        audit('CASE_FORM_SET_INSTALLED', { set_id: set.id, version: set.version, forms: set.formCount, source: 'file', previous_version: set.previousVersion || null });
        return { set };
    }));

    // Everything the fill screen needs about one form.
    ipcMain.handle('case-forms-get-form', wrap(async (_e, r) => {
        r = req(r);
        const manifest = store.load(String(r.setId || ''));
        const { form } = store.getForm(manifest.id, r.formId, manifest);
        const info = await pdfForm.inspect(store.readPdf(manifest.id, form.id, manifest));
        return {
            set: { id: manifest.id, name: manifest.name, agency: manifest.agency || '', version: manifest.version },
            form: {
                id: form.id, title: form.title, category: form.category || '', language: form.language || '', group: form.group || '',
                flatten: !!form.flatten, slots: form.slots || [], vehicleSlots: form.vehicleSlots || [], bindings: form.bindings || {},
            },
            pdf: { pageCount: info.pageCount, pages: info.pages, fields: info.fields, repaired: info.repaired || 0 },
        };
    }));

    /*
     * Fill a form. r: { setId, formId, values, mode, caseNumber, nameHint, flatten }
     *   mode 'case'    → cases/<n>/Forms/ (encrypted under Field Security)
     *   mode 'saveAs'  → wherever the officer picks
     *   mode 'preview' → the filled bytes back to the renderer, nothing written
     *   mode 'open'    → an unsaved temp copy opened in the PDF viewer (to check / print)
     */
    ipcMain.handle('case-forms-fill', wrap(async (_e, r) => {
        r = req(r);
        const mode = r.mode;
        if (!['case', 'saveAs', 'preview', 'open'].includes(mode)) fail('Unknown save option');
        const values = checkValues(r.values);
        const caseNumber = mode === 'case' ? safeCaseNumber(r.caseNumber) : (safeCaseNumber(r.caseNumber) || null);
        if (mode === 'case' && !caseNumber) fail('Open a case first');
        if (mode === 'case' && cases().locked()) fail('Unlock Field Security first — filled forms are saved encrypted with the case');
        const manifest = store.load(String(r.setId || ''));
        const { form } = store.getForm(manifest.id, r.formId, manifest);
        const flatten = typeof r.flatten === 'boolean' ? r.flatten : !!form.flatten;
        const out = await pdfForm.fill(store.readPdf(manifest.id, form.id, manifest), values, { flatten });
        const warnings = out.warnings.slice(0, 200);
        if (mode === 'preview') {
            return { dataBase64: out.bytes.toString('base64'), filled: out.filled.length, warnings };
        }
        const fileName = outputFileName(form.title, r.nameHint, new Date());
        if (mode === 'open') {
            if (cases().locked()) fail('Unlock Field Security first');
            await cases().openTemp(fileName, out.bytes);
            return { opened: true, filled: out.filled.length, warnings };
        }
        const auditBase = { case_number: caseNumber, set_id: manifest.id, version: manifest.version, form_id: form.id, filled: out.filled.length, warnings: warnings.length };
        if (mode === 'case') {
            const saved = cases().save(caseNumber, fileName, out.bytes);
            audit('CASE_FORM_FILLED', Object.assign(auditBase, { destination: 'case', file: saved.fileName }));
            return { fileName: saved.fileName, filled: out.filled.length, warnings };
        }
        const win = deps.getWindow && deps.getWindow();
        const dir = (typeof deps.defaultDir === 'function' && deps.defaultDir()) || '';
        let res;
        try {
            res = await deps.dialog.showSaveDialog(win || undefined, {
                title: 'Save filled form',
                defaultPath: dir ? nodePath.join(dir, fileName) : fileName,
                filters: [{ name: 'PDF', extensions: ['pdf'] }],
            });
        } finally { try { if (deps.restoreFocus) deps.restoreFocus(); } catch (_) { /* ignore */ } }
        if (!res || res.canceled || !res.filePath) return { canceled: true };
        (deps.writeFile || require('fs').writeFileSync)(res.filePath, out.bytes);
        audit('CASE_FORM_FILLED', Object.assign(auditBase, { destination: 'export', file: nodePath.basename(res.filePath) }));
        return { filePath: res.filePath, filled: out.filled.length, warnings };
    }));

    ipcMain.handle('case-forms-case-files', wrap(async (_e, r) => ({ files: cases().listFiles(req(r).caseNumber) })));
    ipcMain.handle('case-forms-open', wrap(async (_e, r) => {
        r = req(r);
        return cases().open(r.caseNumber, r.fileName, r.action === 'show' ? 'show' : 'open');
    }));
}

module.exports = {
    createFormStore, createLibraryClient, createCaseForms, registerFormIpc,
    mergeLibrary, checkValues, outputFileName, safeCaseNumber, cleanEntry,
    LibraryError, DEFAULT_LIBRARY_URL, MAX_SET_FILE_BYTES, FORMS_SUBDIR, INSTALL_INFO,
};

'use strict';
/**
 * Agency packs — private bundles of an agency's own warrant templates, installed into userData.
 *
 * A pack is a .viperpack file (a ZIP) built by scripts/build-agency-pack.js from the agency's
 * template library. It never ships with VIPER and is never committed: the templates are the
 * agency's documents (provider contacts, court wording), and the rules that tailor the Builder
 * to them (counties, court districts, filename words) live in the pack's manifest, not in code.
 *
 *   manifest.json   { format, formatVersion, id, name, agency, packVersion, kind, createdAt,
 *                     description?, builder: {...rules}, files: { "<path>": "<sha256>" } }
 *   config.json     { globalFields, templatesConfig, unbracketedFields, filenameSuffixFields }
 *   templates/<rel> one .docx per templatesConfig key
 *
 * Installing checks everything before a single byte lands in userData: only those three kinds
 * of entry, safe relative paths, size limits read from the ZIP headers before inflating, every
 * file listed in the manifest with a matching SHA-256 and nothing unlisted, the config parses
 * and every template it names is present and is a ZIP (docx). The pack is written to a staging
 * folder, re-hashed from disk, then swapped in. Templates are hash-checked again on every read.
 *
 * Installed at userData/agency-packs/<id>/ (included in backups). The Builder only appears when
 * at least one warrant-builder pack is installed.
 */

const FORMAT = 'viper-agency-pack';
const FORMAT_VERSION = 1;
const KINDS = ['warrant-builder'];
const ID_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const LIMITS = Object.freeze({
    maxEntries: 2000,
    maxEntryBytes: 50 * 1024 * 1024,
    maxTotalBytes: 500 * 1024 * 1024,
    maxPackFileBytes: 600 * 1024 * 1024,
    maxJsonBytes: 20 * 1024 * 1024,
});
const INSTALL_INFO = 'install-info.json';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

class PackError extends Error {
    constructor(message) { super(message); this.name = 'PackError'; }
}
const fail = (msg) => { throw new PackError(msg); };

// A relative path that means the same thing on every OS and can't leave its folder.
function isSafeRelPath(p) {
    if (typeof p !== 'string' || !p || p.length > 400) return false;
    if (p.includes('\\') || p.startsWith('/') || /[\u0000-\u001f\u007f<>:"|?*]/.test(p)) return false;
    return p.split('/').every(seg => seg && seg !== '.' && seg !== '..' && !/[. ]$/.test(seg) && !/^\s/.test(seg)
        && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(seg));
}

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

// Light shape check of the manifest's `builder` rules (consumed by builder-model.js).
function validateRules(rules) {
    if (rules == null) return {};
    if (!isPlainObject(rules)) fail('manifest.builder must be an object');
    const strList = (k) => {
        if (rules[k] == null) return;
        if (!Array.isArray(rules[k]) || !rules[k].every(s => typeof s === 'string')) fail(`manifest.builder.${k} must be a list of text`);
    };
    ['countyFieldNames', 'judicialDistrictFieldNames', 'hiddenFields', 'hideCountyFieldsFor', 'venueCategories',
        'dateFields', 'dateRangeFields', 'dateTimeFields', 'richTextPatterns'].forEach(strList);
    if (rules.counties != null) {
        if (!Array.isArray(rules.counties)) fail('manifest.builder.counties must be a list');
        rules.counties.forEach((c, i) => {
            if (!isPlainObject(c) || typeof c.label !== 'string' || !c.label.trim()) fail(`manifest.builder.counties[${i}] needs a label`);
        });
    }
    if (rules.typeTokens != null && (!isPlainObject(rules.typeTokens) || !Object.values(rules.typeTokens).every(s => typeof s === 'string'))) {
        fail('manifest.builder.typeTokens must map categories to text');
    }
    if (rules.municipalPattern != null) {
        if (typeof rules.municipalPattern !== 'string' || rules.municipalPattern.length > 200) fail('manifest.builder.municipalPattern is invalid');
        try { new RegExp(rules.municipalPattern, 'i'); } catch (_) { fail('manifest.builder.municipalPattern is not a valid pattern'); }
    }
    return rules;
}

function validateManifest(m) {
    if (!isPlainObject(m)) fail('manifest.json is not an object');
    if (m.format !== FORMAT) fail('Not a VIPER agency pack');
    if (m.formatVersion !== FORMAT_VERSION) fail(`Pack format ${m.formatVersion} is not supported by this version of VIPER`);
    if (typeof m.id !== 'string' || !ID_RE.test(m.id)) fail('Pack id is missing or invalid');
    if (typeof m.name !== 'string' || !m.name.trim()) fail('Pack name is missing');
    if (typeof m.packVersion !== 'string' || !m.packVersion.trim()) fail('Pack version is missing');
    if (!KINDS.includes(m.kind)) fail(`Unknown pack kind "${m.kind}"`);
    if (!isPlainObject(m.files)) fail('manifest.files is missing');
    for (const [p, h] of Object.entries(m.files)) {
        if (!isSafeRelPath(p)) fail(`Unsafe path in manifest: ${p}`);
        if (typeof h !== 'string' || !SHA_RE.test(h)) fail(`Bad checksum for ${p}`);
    }
    validateRules(m.builder);
    return m;
}

function validateConfig(cfg, has) {
    if (!isPlainObject(cfg)) fail('config.json is not an object');
    if (!isPlainObject(cfg.templatesConfig)) fail('config.json has no templatesConfig');
    if (cfg.globalFields != null && !Array.isArray(cfg.globalFields)) fail('config.json globalFields must be a list');
    if (cfg.unbracketedFields != null && !Array.isArray(cfg.unbracketedFields)) fail('config.json unbracketedFields must be a list');
    const rels = Object.keys(cfg.templatesConfig);
    if (!rels.length) fail('The pack has no templates');
    for (const rel of rels) {
        if (!isSafeRelPath(rel) || !/\.docx$/i.test(rel)) fail(`Bad template path in config: ${rel}`);
        const t = cfg.templatesConfig[rel];
        if (!isPlainObject(t) || (t.placeholders != null && !Array.isArray(t.placeholders))) fail(`Bad template entry: ${rel}`);
        if (!has('templates/' + rel)) fail(`Template missing from pack: ${rel}`);
    }
    return cfg;
}

function summarize(manifest, config, extra) {
    const categories = {};
    Object.values(config.templatesConfig || {}).forEach(t => {
        const c = (t && t.category) || 'Other';
        categories[c] = (categories[c] || 0) + 1;
    });
    const rules = manifest.builder || {};
    return Object.assign({
        id: manifest.id,
        name: manifest.name,
        agency: manifest.agency || '',
        description: manifest.description || '',
        packVersion: manifest.packVersion,
        kind: manifest.kind,
        createdAt: manifest.createdAt || null,
        templateCount: Object.keys(config.templatesConfig || {}).length,
        categories,
        counties: Array.isArray(rules.counties) ? rules.counties.map(c => c.label) : [],
    }, extra || {});
}

function createPackStore(deps) {
    const { fs, path, crypto } = deps;
    const AdmZip = deps.AdmZip || require('adm-zip');
    const engine = deps.engine || require('./docx-form-engine.js');
    const builderModel = deps.builderModel || require('./builder-model.js');
    const rootDir = deps.rootDir;
    const stagingRoot = deps.stagingRoot || (rootDir + '-staging');
    const now = deps.now || (() => Date.now());
    const limits = Object.assign({}, LIMITS, deps.limits || {});
    if (!rootDir) throw new Error('agency packs: rootDir is required');

    const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
    const packDir = (id) => {
        if (typeof id !== 'string' || !ID_RE.test(id)) fail('Invalid pack id');
        return path.join(rootDir, id);
    };
    const fileOf = (id, rel) => path.join(packDir(id), ...rel.split('/'));
    const readJson = (file, label) => {
        let st;
        try { st = fs.statSync(file); } catch (_) { fail(`${label} is missing`); }
        if (st.size > limits.maxJsonBytes) fail(`${label} is too large`);
        try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { fail(`${label} is not valid JSON`); }
    };

    // ---- Reading a .viperpack file (nothing written) ------------------------------------
    function readPackFile(filePath) {
        if (typeof filePath !== 'string' || !filePath) fail('No pack file chosen');
        let st;
        try { st = fs.statSync(filePath); } catch (_) { fail('The pack file could not be read'); }
        if (!st.isFile()) fail('The pack file could not be read');
        if (st.size > limits.maxPackFileBytes) fail('The pack file is too large');
        let zip;
        try { zip = new AdmZip(filePath); } catch (_) { fail('The pack file is damaged or not a pack'); }
        const entries = zip.getEntries().filter(e => !e.isDirectory);
        if (entries.length > limits.maxEntries) fail('The pack has too many files');
        const seen = new Set();
        let total = 0;
        for (const e of entries) {
            const name = e.entryName;
            if (!isSafeRelPath(name)) fail(`Unsafe file name in pack: ${name}`);
            if (!(name === 'manifest.json' || name === 'config.json' || /^templates\/.+\.docx$/i.test(name))) fail(`Unexpected file in pack: ${name}`);
            const key = name.toLowerCase();
            if (seen.has(key)) fail(`Duplicate file in pack: ${name}`);
            seen.add(key);
            const size = e.header.size;
            if (size > limits.maxEntryBytes) fail(`File too large in pack: ${name}`);
            total += size;
            if (total > limits.maxTotalBytes) fail('The pack is too large when unpacked');
        }
        const byName = new Map(entries.map(e => [e.entryName, e]));
        const data = (name) => {
            const e = byName.get(name);
            const buf = e.getData();
            if (buf.length !== e.header.size) fail(`File damaged in pack: ${name}`);
            return buf;
        };
        if (!byName.has('manifest.json')) fail('Not a VIPER agency pack (no manifest)');
        let manifest;
        try { manifest = JSON.parse(data('manifest.json').toString('utf8')); } catch (e) {
            if (e instanceof PackError) throw e;
            fail('manifest.json is not valid JSON');
        }
        validateManifest(manifest);
        const listed = Object.keys(manifest.files);
        for (const name of byName.keys()) {
            if (name !== 'manifest.json' && !Object.prototype.hasOwnProperty.call(manifest.files, name)) fail(`File not listed in manifest: ${name}`);
        }
        const files = new Map();
        for (const name of listed) {
            if (!byName.has(name)) fail(`File listed in manifest is missing: ${name}`);
            const buf = data(name);
            if (sha256(buf) !== manifest.files[name]) fail(`Checksum mismatch: ${name}`);
            if (/\.docx$/i.test(name) && !(buf[0] === 0x50 && buf[1] === 0x4b)) fail(`Not a Word document: ${name}`);
            files.set(name, buf);
        }
        if (!files.has('config.json')) fail('The pack has no config.json');
        let config;
        try { config = JSON.parse(files.get('config.json').toString('utf8')); } catch (_) { fail('config.json is not valid JSON'); }
        validateConfig(config, (p) => files.has(p));
        return { manifest, config, files, sizeBytes: st.size };
    }

    function installedSummary(id) {
        try {
            const m = readJson(path.join(packDir(id), 'manifest.json'), 'manifest.json');
            return m && m.packVersion ? m.packVersion : null;
        } catch (_) { return null; }
    }

    function inspect(filePath) {
        const p = readPackFile(filePath);
        return summarize(p.manifest, p.config, {
            sizeBytes: p.sizeBytes,
            installedVersion: installedSummary(p.manifest.id),
        });
    }

    function rmrf(dir) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    }

    function install(filePath) {
        const p = readPackFile(filePath);
        const id = p.manifest.id;
        const stamp = now();
        fs.mkdirSync(rootDir, { recursive: true });
        fs.mkdirSync(stagingRoot, { recursive: true });
        const stage = path.join(stagingRoot, `${id}-${stamp}`);
        rmrf(stage);
        try {
            const write = (rel, buf) => {
                const dest = path.join(stage, ...rel.split('/'));
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.writeFileSync(dest, buf);
            };
            write('manifest.json', Buffer.from(JSON.stringify(p.manifest, null, 2), 'utf8'));
            for (const [rel, buf] of p.files) write(rel, buf);
            write(INSTALL_INFO, Buffer.from(JSON.stringify({
                installedAt: new Date(stamp).toISOString(),
                sourceName: path.basename(filePath),
            }, null, 2), 'utf8'));
            // Re-hash from disk before swapping in.
            for (const [rel, h] of Object.entries(p.manifest.files)) {
                if (sha256(fs.readFileSync(path.join(stage, ...rel.split('/')))) !== h) fail(`Write check failed: ${rel}`);
            }
            const dest = packDir(id);
            const previousVersion = installedSummary(id);
            const old = path.join(stagingRoot, `${id}-${stamp}-previous`);
            const hadOld = fs.existsSync(dest);
            if (hadOld) fs.renameSync(dest, old);
            try {
                fs.renameSync(stage, dest);
            } catch (e) {
                if (hadOld) { try { fs.renameSync(old, dest); } catch (_) { /* leave old in staging */ } }
                throw e;
            }
            if (hadOld) rmrf(old);
            return summarize(p.manifest, p.config, { installedAt: new Date(stamp).toISOString(), previousVersion });
        } finally {
            rmrf(stage);
        }
    }

    function list() {
        let names = [];
        try { names = fs.readdirSync(rootDir); } catch (_) { return []; }
        const out = [];
        for (const name of names.sort()) {
            if (!ID_RE.test(name)) continue;
            const dir = path.join(rootDir, name);
            try { if (!fs.statSync(dir).isDirectory()) continue; } catch (_) { continue; }
            try {
                const manifest = validateManifest(readJson(path.join(dir, 'manifest.json'), 'manifest.json'));
                if (manifest.id !== name) fail('Pack folder does not match its id');
                const config = readJson(path.join(dir, 'config.json'), 'config.json');
                let info = {};
                try { info = readJson(path.join(dir, INSTALL_INFO), INSTALL_INFO); } catch (_) { /* optional */ }
                out.push(summarize(manifest, config, { installedAt: info.installedAt || null }));
            } catch (e) {
                out.push({ id: name, error: e.message || String(e) });
            }
        }
        return out;
    }

    // Manifest + config of an installed pack, config hash-checked.
    function load(id) {
        const dir = packDir(id);
        if (!fs.existsSync(dir)) fail('That agency pack is not installed');
        const manifest = validateManifest(readJson(path.join(dir, 'manifest.json'), 'manifest.json'));
        if (manifest.id !== id) fail('Pack folder does not match its id');
        const cfgPath = path.join(dir, 'config.json');
        if (fs.statSync(cfgPath).size > limits.maxJsonBytes) fail('config.json is too large');
        const raw = fs.readFileSync(cfgPath);
        if (sha256(raw) !== manifest.files['config.json']) fail('The pack has been changed on disk (config.json). Reinstall it.');
        let config;
        try { config = JSON.parse(raw.toString('utf8')); } catch (_) { fail('config.json is not valid JSON'); }
        validateConfig(config, (p) => Object.prototype.hasOwnProperty.call(manifest.files, p));
        return { manifest, config, rules: manifest.builder || {} };
    }

    function readTemplate(id, rel, loaded) {
        const L = loaded || load(id);
        if (!Object.prototype.hasOwnProperty.call(L.config.templatesConfig, rel)) fail('Unknown template');
        const key = 'templates/' + rel;
        let buf;
        try { buf = fs.readFileSync(fileOf(id, key)); } catch (_) { fail(`Template missing on disk: ${rel}`); }
        if (sha256(buf) !== L.manifest.files[key]) fail(`The pack has been changed on disk (${rel}). Reinstall it.`);
        return buf;
    }

    // Every file re-hashed; reports problems rather than throwing.
    function verify(id) {
        const problems = [];
        let L;
        try { L = load(id); } catch (e) { return { ok: false, problems: [e.message] }; }
        for (const [rel, h] of Object.entries(L.manifest.files)) {
            try {
                if (sha256(fs.readFileSync(fileOf(id, rel))) !== h) problems.push(`Changed: ${rel}`);
            } catch (_) { problems.push(`Missing: ${rel}`); }
        }
        return { ok: !problems.length, problems, fileCount: Object.keys(L.manifest.files).length };
    }

    function remove(id) {
        const dir = packDir(id);
        if (!fs.existsSync(dir)) return { removed: false };
        let version = null;
        try { version = readJson(path.join(dir, 'manifest.json'), 'manifest.json').packVersion || null; } catch (_) { /* damaged */ }
        fs.mkdirSync(stagingRoot, { recursive: true });
        const trash = path.join(stagingRoot, `${id}-${now()}-removed`);
        fs.renameSync(dir, trash);
        rmrf(trash);
        return { removed: true, packVersion: version };
    }

    /**
     * Fill the chosen templates. req: { templateIds, values, county, overrides }.
     * Field definitions, values, filenames and the DA-section rule are all derived here from the
     * installed pack (builder-model), so the renderer only supplies what the officer entered.
     * opts.blank: produce the unfilled, protected forms instead.
     */
    function build(id, req, opts) {
        req = req || {};
        opts = opts || {};
        const L = load(id);
        const builder = builderModel.createBuilder(L.config, L.rules);
        const ids = Array.isArray(req.templateIds) ? req.templateIds.filter(t => typeof t === 'string') : [];
        if (!ids.length) fail('Choose at least one template');
        for (const t of ids) if (!builder.getTemplate(t)) fail(`Unknown template: ${t}`);
        const values = isPlainObject(req.values) ? req.values : {};
        const pr = builder.packetRequest(ids, values, { county: req.county, overrides: isPlainObject(req.overrides) ? req.overrides : {} });
        const used = new Set();
        const documents = pr.templates.map(t => {
            const bytes = readTemplate(id, t.templateId, L);
            const data = opts.blank
                ? engine.convertDocx(bytes, t.placeholders, { unbracketedFields: pr.unbracketedFields, protect: true })
                : engine.convertDocx(bytes, t.placeholders, {
                    unbracketedFields: pr.unbracketedFields, values: t.values, richtextBlocks: t.richtextBlocks,
                    removeDaApprovalSection: pr.removeDaApprovalSection, protect: false,
                });
            const fallback = path.basename(t.templateId).replace(/\.docx$/i, '') + (opts.blank ? '.docx' : '_packet.docx');
            const name = opts.blank ? fallback : t.outFilename;
            const filename = engine.uniquifyFilename(engine.sanitizeOutputFilename(name, fallback), used);
            return { templateId: t.templateId, filename, data, mimetype: DOCX_MIME };
        });
        return { documents, packetFilename: pr.packetFilename, removeDaApprovalSection: pr.removeDaApprovalSection };
    }

    function zipDocuments(documents) {
        const zip = new AdmZip();
        (documents || []).forEach(d => zip.addFile(d.filename, d.data));
        return zip.toBuffer();
    }

    const hasBuilderPack = () => list().some(p => !p.error && p.kind === 'warrant-builder');

    return { rootDir, stagingRoot, inspect, install, list, load, readTemplate, verify, remove, build, zipDocuments, hasBuilderPack, readPackFile };
}

/**
 * IPC for settings (install / list / remove) and the Builder (get). Build + save are wired by
 * the Builder UI step. deps: { dialog, getWindow, audit, AUDIT_EVENTS }
 */
function registerPackIpc(ipcMain, store, deps) {
    deps = deps || {};
    const audit = (ev, data) => { try { if (deps.audit && deps.AUDIT_EVENTS && deps.AUDIT_EVENTS[ev]) deps.audit().write(deps.AUDIT_EVENTS[ev], data); } catch (_) { /* never block */ } };
    const wrap = (fn) => async (...args) => {
        try { return Object.assign({ success: true }, await fn(...args)); } catch (e) {
            return { success: false, error: e instanceof PackError ? e.message : ('Agency pack error: ' + (e && e.message || e)) };
        }
    };
    const pathOk = (p) => typeof p === 'string' && /\.viperpack$/i.test(p);

    ipcMain.handle('agency-pack-list', wrap(async () => ({ packs: store.list() })));
    ipcMain.handle('agency-pack-get', wrap(async (_e, id) => {
        const L = store.load(id);
        const m = Object.assign({}, L.manifest);
        delete m.files;
        return { manifest: m, config: L.config };
    }));
    // Pick a .viperpack and describe it (nothing installed yet).
    ipcMain.handle('agency-pack-choose', wrap(async () => {
        const win = deps.getWindow && deps.getWindow();
        const r = await deps.dialog.showOpenDialog(win || undefined, {
            title: 'Install agency pack',
            filters: [{ name: 'VIPER agency pack', extensions: ['viperpack'] }],
            properties: ['openFile'],
        });
        if (r.canceled || !r.filePaths || !r.filePaths.length) return { canceled: true };
        const filePath = r.filePaths[0];
        return { filePath, summary: store.inspect(filePath) };
    }));
    ipcMain.handle('agency-pack-install', wrap(async (_e, filePath) => {
        if (!pathOk(filePath)) throw new PackError('Choose a .viperpack file');
        const pack = store.install(filePath);
        audit('AGENCY_PACK_INSTALLED', { pack_id: pack.id, pack_version: pack.packVersion, templates: pack.templateCount });
        return { pack };
    }));
    ipcMain.handle('agency-pack-remove', wrap(async (_e, id) => {
        const r = store.remove(id);
        if (r.removed) audit('AGENCY_PACK_REMOVED', { pack_id: id, pack_version: r.packVersion });
        return r;
    }));
    ipcMain.handle('agency-pack-verify', wrap(async (_e, id) => store.verify(id)));
}

module.exports = { createPackStore, registerPackIpc, PackError, isSafeRelPath, validateManifest, validateConfig, validateRules, FORMAT, FORMAT_VERSION, LIMITS, ID_RE };

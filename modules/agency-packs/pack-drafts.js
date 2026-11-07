'use strict';
/**
 * Agency pack editor — drafts of a pack an officer is creating or editing inside VIPER.
 *
 * A draft lives at userData/agency-pack-drafts/<pack id>/:
 *   draft.json   { draftFormat, meta, rules, config, notes, dirty, updatedAt, savedAt }
 *   templates/   the Word templates, one per config.templatesConfig key
 *
 * Every change is made here in the main process with pack-author.js and written straight away,
 * so a draft survives closing VIPER. Word files are read and scanned here (scanTemplate), never
 * in the renderer. Saving builds the pack in memory (buildPackBuffer) and installs it through the
 * same checks as a .viperpack file, under the same id, with the version bumped. Packs made with
 * the command-line builder keep their manifest rules untouched.
 *
 * Drafts hold the agency's templates, so they stay in userData and are never part of the app.
 */

const nodePath = require('path');
const { PackError, buildPackBuffer, ID_RE, LIMITS } = require('./pack-store.js');

const DRAFT_FILE = 'draft.json';
const DRAFT_FORMAT = 1;
const PREVIEW_DIR = '_preview';
const MAX_TEMPLATES = 1000;
const OPS = ['setMeta', 'setCategory', 'removeTemplate', 'updateField', 'mergeFields', 'splitField'];

const fail = (msg) => { throw new PackError(msg); };
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function createDraftStore(deps) {
    const { fs, path, crypto, store } = deps;
    const engine = deps.engine || require('./docx-form-engine.js');
    const author = deps.author || require('./pack-author.js');
    const BM = deps.builderModel || require('./builder-model.js');
    const rootDir = deps.rootDir;
    const now = deps.now || (() => Date.now());
    const limits = Object.assign({}, LIMITS, deps.limits || {});
    if (!rootDir) throw new Error('agency pack drafts: rootDir is required');
    if (!store) throw new Error('agency pack drafts: store is required');

    // pack-author throws its own error type; the officer sees the message either way.
    const authored = (fn) => {
        try { return fn(); } catch (e) {
            if (e && e.name === 'AuthorError') throw new PackError(e.message);
            throw e;
        }
    };
    const draftDir = (id) => {
        if (typeof id !== 'string' || !ID_RE.test(id)) fail('Invalid pack id');
        return path.join(rootDir, id);
    };
    const tplFile = (id, rel) => path.join(draftDir(id), 'templates', ...rel.split('/'));
    const rmrf = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* best effort */ } };
    const iso = () => new Date(now()).toISOString();
    const installedIds = () => new Set(store.list().map(p => p.id));
    const installedPack = (id) => store.list().find(x => x.id === id && !x.error) || null;
    /**
     * Unsaved edits made to an installed pack that has since been replaced (a newer file from the
     * agency, or a save from another editor window). Saving them would quietly undo that install.
     * meta.packVersion is the version the edits started from; meta.baseInstalledAt when it was installed.
     */
    function staleOf(d, inst) {
        if (!d.meta.packVersion || !inst) return null;
        const moved = inst.packVersion !== d.meta.packVersion
            || (!!d.meta.baseInstalledAt && !!inst.installedAt && inst.installedAt !== d.meta.baseInstalledAt);
        return moved ? { baseVersion: d.meta.packVersion, installedVersion: inst.packVersion, installedAt: inst.installedAt || null } : null;
    }
    // Same template, ignoring folders, "_Template", case and a copy number: "Phone Warrant (2).docx".
    const matchKey = (rel) => BM.displayName(rel).toLowerCase().replace(/\s*\(\d+\)$/, '').replace(/\s+/g, ' ').trim();
    function sameTemplate(c, file) {
        const k = matchKey(author.templateRelFor(author.newConfig(), file));
        return Object.keys(c.templatesConfig).sort((a, z) => a.localeCompare(z)).find(rel => matchKey(rel) === k) || null;
    }

    // ---- draft.json ------------------------------------------------------------------------
    function read(id) {
        const file = path.join(draftDir(id), DRAFT_FILE);
        let st;
        try { st = fs.statSync(file); } catch (_) { fail('That pack draft no longer exists'); }
        if (st.size > limits.maxJsonBytes) fail('The pack draft is too large');
        let d;
        try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { fail('The pack draft is damaged'); }
        if (!isPlainObject(d) || d.draftFormat !== DRAFT_FORMAT || !isPlainObject(d.meta) || d.meta.id !== id) fail('The pack draft is damaged');
        d.config = author.normalizeConfig(isPlainObject(d.config) ? d.config : {});
        d.rules = isPlainObject(d.rules) ? d.rules : {};
        d.notes = isPlainObject(d.notes) ? d.notes : {};
        return d;
    }
    function write(d, opts) {
        opts = opts || {};
        if (opts.dirty !== false) { d.dirty = true; d.updatedAt = iso(); }
        const json = JSON.stringify(d);
        if (Buffer.byteLength(json) > limits.maxJsonBytes) fail('The pack is too large');
        const dir = draftDir(d.meta.id);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, DRAFT_FILE);
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, json, 'utf8');
        fs.renameSync(tmp, file);
        return d;
    }

    // What the editor screen shows.
    function view(d) {
        const c = d.config;
        const rels = Object.keys(c.templatesConfig).sort((a, z) => a.localeCompare(z));
        const ip = installedPack(d.meta.id);
        const inst = ip ? ip.packVersion : null;
        const base = inst || d.meta.packVersion;
        return {
            id: d.meta.id,
            meta: {
                name: d.meta.name || '', agency: d.meta.agency || '', description: d.meta.description || '',
                packVersion: d.meta.packVersion || null, installedVersion: inst,
                nextVersion: base ? author.bumpVersion(base) : '1.0.0',
                hasRules: Object.keys(d.rules).length > 0,
            },
            stale: staleOf(d, ip),
            dirty: !!d.dirty,
            updatedAt: d.updatedAt || null,
            savedAt: d.savedAt || null,
            templates: rels.map(rel => {
                const t = c.templatesConfig[rel];
                const n = d.notes[rel] || {};
                return {
                    rel, title: BM.displayName(rel), category: t.category || author.DEFAULT_CATEGORY,
                    fieldCount: t.placeholders.length,
                    unhighlighted: Array.isArray(n.unhighlighted) ? n.unhighlighted : [],
                    unclosed: Array.isArray(n.unclosed) ? n.unclosed : [],
                };
            }),
            categories: author.categories(c),
            suggestedCategories: author.SUGGESTED_CATEGORIES.slice(),
            fields: author.listFields(c, d.rules),
            check: author.checkDraft({ meta: d.meta, config: c }),
            kindLabels: author.KIND_LABELS,
            autofillLabels: author.AUTOFILL_LABELS,
        };
    }

    // ---- Word files -----------------------------------------------------------------------
    function readDocx(filePath) {
        if (typeof filePath !== 'string' || !filePath || filePath.length > 1024) fail('No Word file chosen');
        if (!/\.docx$/i.test(filePath)) fail(`${path.basename(filePath)} is not a Word (.docx) file. Save it as .docx in Word first.`);
        let st;
        try { st = fs.statSync(filePath); } catch (_) { fail(`${path.basename(filePath)} could not be read`); }
        if (!st.isFile()) fail(`${path.basename(filePath)} could not be read`);
        if (st.size > limits.maxEntryBytes) fail(`${path.basename(filePath)} is too large`);
        return fs.readFileSync(filePath);
    }
    function scan(buf, c, label) {
        try { return engine.scanTemplate(buf, c.unbracketedFields || []); } catch (e) {
            fail(`${label}: ${e && e.message ? e.message : 'could not be read'}`);
        }
    }
    const noteOf = (s) => ({
        unhighlighted: (s.unhighlighted || []).slice(0, 50).map(t => text(t, 200)),
        unclosed: (s.unclosed || []).slice(0, 50).map(t => text(t, 200)),
    });
    function templateBytes(d) {
        let total = 0;
        for (const rel of Object.keys(d.config.templatesConfig)) {
            try { total += fs.statSync(tplFile(d.meta.id, rel)).size; } catch (_) { /* counted as missing on save */ }
        }
        return total;
    }

    // ---- Drafts ---------------------------------------------------------------------------
    function list() {
        let names = [];
        try { names = fs.readdirSync(rootDir); } catch (_) { return []; }
        const all = store.list();
        const installedSet = new Set(all.map(p => p.id));
        const inst = new Map(all.filter(p => !p.error).map(p => [p.id, p]));
        const out = [];
        for (const name of names.sort()) {
            if (!ID_RE.test(name)) continue;
            try {
                const d = read(name);
                out.push({
                    id: name, name: d.meta.name || '', agency: d.meta.agency || '', dirty: !!d.dirty,
                    updatedAt: d.updatedAt || null, templateCount: Object.keys(d.config.templatesConfig).length,
                    packVersion: d.meta.packVersion || null, installed: installedSet.has(name),
                    stale: staleOf(d, inst.get(name) || null),
                });
            } catch (e) {
                out.push({ id: name, error: e.message || String(e) });
            }
        }
        return out;
    }

    function create(req) {
        req = isPlainObject(req) ? req : {};
        const name = text(req.name, 120);
        if (!name) fail('Give the pack a name.');
        let taken = installedIds();
        try { fs.readdirSync(rootDir).forEach(n => taken.add(n)); } catch (_) { /* none yet */ }
        const id = author.makePackId(name, taken);
        const d = {
            draftFormat: DRAFT_FORMAT,
            meta: { id, name, agency: text(req.agency, 120), description: text(req.description, 1000), packVersion: null, createdAt: iso() },
            rules: {}, config: author.newConfig(), notes: {},
        };
        fs.mkdirSync(path.join(draftDir(id), 'templates'), { recursive: true });
        write(d);
        return view(d);
    }

    /**
     * Edit an installed pack. Unsaved changes from last time are picked up again unless
     * `fresh` is set; otherwise the draft is a fresh copy of what is installed now.
     */
    function openInstalled(id, opts) {
        opts = opts || {};
        draftDir(id);
        if (!opts.fresh) {
            try {
                const d = read(id);
                if (d.dirty) return view(d);
            } catch (_) { /* no usable draft: start fresh */ }
        }
        const P = store.readInstalled(id);
        const m = P.manifest;
        const ip = installedPack(id);
        const dir = draftDir(id);
        rmrf(dir);
        fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
        const config = author.normalizeConfig(JSON.parse(JSON.stringify(P.config)));
        const notes = {};
        for (const [rel, buf] of P.templates) {
            const dest = tplFile(id, rel);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, buf);
            // Show where each field sits in the document (packs from the command-line builder
            // have no context yet) and which [brackets] Word won't fill. Nothing else changes.
            try {
                const s = engine.scanTemplate(buf, config.unbracketedFields || []);
                const ctx = new Map(s.placeholders.map(p => [p.name, p.context]));
                config.templatesConfig[rel].placeholders.forEach(p => {
                    if (!p.context && ctx.get(p.name)) p.context = String(ctx.get(p.name)).slice(0, 400);
                });
                notes[rel] = noteOf(s);
            } catch (_) { /* a template that can't be scanned still edits */ }
        }
        const d = {
            draftFormat: DRAFT_FORMAT,
            meta: {
                id, name: m.name, agency: m.agency || '', description: m.description || '',
                packVersion: m.packVersion, createdAt: m.createdAt || iso(),
                baseInstalledAt: (ip && ip.installedAt) || null,
            },
            rules: P.rules || {}, config, notes, dirty: false, updatedAt: iso(), savedAt: null,
        };
        write(d, { dirty: false });
        return view(d);
    }

    const get = (id) => view(read(id));

    /** Small edits: op is one of OPS, args as pack-author takes them. */
    function op(id, name, args) {
        if (!OPS.includes(name)) fail('Unknown change');
        args = isPlainObject(args) ? args : {};
        const d = read(id);
        const c = d.config;
        const ref = (k) => {
            const r = author.parseRef(args[k]);
            if (!r) fail('Field not found.');
            return r;
        };
        authored(() => {
            switch (name) {
                case 'setMeta': {
                    if ('name' in args) {
                        const n = text(args.name, 120);
                        if (!n) fail('Give the pack a name.');
                        d.meta.name = n;
                    }
                    if ('agency' in args) d.meta.agency = text(args.agency, 120);
                    if ('description' in args) d.meta.description = text(args.description, 1000);
                    break;
                }
                case 'setCategory': author.setCategory(c, String(args.rel || ''), args.category); break;
                case 'removeTemplate': {
                    const rel = String(args.rel || '');
                    author.removeTemplate(c, rel);
                    delete d.notes[rel];
                    try { fs.unlinkSync(tplFile(id, rel)); } catch (_) { /* already gone */ }
                    break;
                }
                case 'updateField': author.updateField(c, ref('ref'), isPlainObject(args.patch) ? args.patch : {}, d.rules); break;
                case 'mergeFields': author.mergeFields(c, ref('into'), ref('from')); break;
                case 'splitField': {
                    const r = ref('ref');
                    if (!r.g) fail('That field is not shared.');
                    author.splitField(c, r.g, String(args.rel || ''), String(args.name == null ? '' : args.name));
                    break;
                }
            }
        });
        write(d);
        return view(d);
    }

    /**
     * Add Word templates (paths from a drop or the file picker). One bad file doesn't stop the rest.
     * A file that looks like a template already in the pack is not added but returned in
     * `conflicts` so the officer can choose to replace it, unless opts.duplicates === 'add'.
     */
    function addTemplates(id, paths, opts) {
        opts = opts || {};
        if (!Array.isArray(paths) || !paths.length) fail('No Word files chosen');
        const d = read(id);
        const results = [];
        const conflicts = [];
        let bytes = templateBytes(d);
        for (const p of paths.slice(0, 200)) {
            const file = typeof p === 'string' ? path.basename(p) : '';
            try {
                if (Object.keys(d.config.templatesConfig).length >= MAX_TEMPLATES) fail('The pack has too many templates');
                const buf = readDocx(p);
                if (bytes + buf.length > limits.maxTotalBytes) fail('The pack is too large');
                const s = scan(buf, d.config, file);
                const same = opts.duplicates === 'add' ? null : sameTemplate(d.config, file);
                if (same) {
                    conflicts.push({ file, path: p, rel: same, title: BM.displayName(same) });
                    continue;
                }
                const rel = author.templateRelFor(d.config, file);
                const dest = tplFile(id, rel);
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.writeFileSync(dest, buf);
                let r;
                try { r = authored(() => author.addTemplate(d.config, rel, s, { category: opts.category })); } catch (e) {
                    try { fs.unlinkSync(dest); } catch (_) { /* ignore */ }
                    throw e;
                }
                bytes += buf.length;
                d.notes[rel] = noteOf(s);
                results.push({ file, rel, title: BM.displayName(rel), fields: r.fields, linked: r.linked, unhighlighted: d.notes[rel].unhighlighted.length, unclosed: d.notes[rel].unclosed.length });
            } catch (e) {
                if (!(e instanceof PackError)) throw e;
                results.push({ file, error: e.message });
            }
        }
        if (results.some(r => !r.error)) write(d);
        return { draft: view(d), results, conflicts };
    }

    /** A newer Word file for a template: settings of fields still in it are kept. */
    function replaceTemplate(id, rel, filePath) {
        const d = read(id);
        if (!d.config.templatesConfig[rel]) fail('Template not found.');
        const buf = readDocx(filePath);
        const s = scan(buf, d.config, path.basename(filePath));
        const r = authored(() => author.replaceTemplate(d.config, rel, s));
        fs.writeFileSync(tplFile(id, rel), buf);
        d.notes[rel] = noteOf(s);
        write(d);
        return {
            draft: view(d),
            result: { rel, title: BM.displayName(rel), added: r.added, removed: r.removed, kept: r.kept.length, unhighlighted: d.notes[rel].unhighlighted.length, unclosed: d.notes[rel].unclosed.length },
        };
    }

    function draftTemplates(d) {
        const out = new Map();
        for (const rel of Object.keys(d.config.templatesConfig)) {
            let buf;
            try { buf = fs.readFileSync(tplFile(d.meta.id, rel)); } catch (_) { fail(`The Word file for ${BM.displayName(rel)} is missing. Replace it or remove the template.`); }
            out.set(rel, buf);
        }
        return out;
    }

    /** One template as the officer will see it: every field as an empty, labelled Word box. */
    function preview(id, rel) {
        const d = read(id);
        if (!d.config.templatesConfig[rel]) fail('Template not found.');
        let buf;
        try { buf = fs.readFileSync(tplFile(id, rel)); } catch (_) { fail('The Word file for this template is missing.'); }
        const builder = BM.createBuilder(d.config, d.rules);
        const pr = builder.packetRequest([rel], {}, {});
        const t = pr.templates[0];
        const data = engine.convertDocx(buf, t.placeholders, { unbracketedFields: pr.unbracketedFields, protect: false });
        const base = nodePath.basename(rel).replace(/\.docx$/i, '');
        return { filename: `Preview - ${base}.docx`, data };
    }

    /**
     * Check, bump the version, install over the same id. Edits that started from an older install
     * than the one there now are refused unless opts.force (the officer chose to keep them anyway).
     */
    function save(id, opts) {
        opts = opts || {};
        const d = read(id);
        const chk = author.checkDraft({ meta: d.meta, config: d.config });
        if (!chk.ok) fail(chk.errors.join(' '));
        const ip = installedPack(id);
        const inst = ip ? ip.packVersion : null;
        if (!d.meta.packVersion && inst) fail('A different pack with this id is already installed. Create the pack again under another name.');
        const stale = staleOf(d, ip);
        if (stale && !opts.force) {
            fail(`These changes were made to version ${stale.baseVersion}, but version ${stale.installedVersion} has been installed since. Saving them would undo that version. Start again from the installed pack, or confirm that you want to keep these changes.`);
        }
        const base = inst || d.meta.packVersion;
        const packVersion = base ? author.bumpVersion(base) : '1.0.0';
        const { buffer } = buildPackBuffer({
            id, name: d.meta.name, agency: d.meta.agency, description: d.meta.description, packVersion,
            createdAt: d.meta.createdAt, rules: d.rules, config: d.config, templates: draftTemplates(d),
        }, { AdmZip: deps.AdmZip, crypto });
        const pack = store.installBuffer(buffer, 'VIPER pack editor');
        d.meta.packVersion = packVersion;
        d.meta.baseInstalledAt = pack.installedAt || null;
        d.dirty = false;
        d.savedAt = iso();
        write(d, { dirty: false });
        return { pack, draft: view(d), warnings: chk.warnings, replacedNewer: stale ? stale.installedVersion : null };
    }

    function discard(id) {
        const dir = draftDir(id);
        if (!fs.existsSync(dir)) return { discarded: false };
        rmrf(dir);
        return { discarded: true };
    }

    return { rootDir, list, create, openInstalled, get, op, addTemplates, replaceTemplate, preview, save, discard, OPS };
}

/**
 * IPC for the pack editor. deps: { dialog, getWindow, shell, audit, AUDIT_EVENTS, restoreFocus,
 *   defaultDir(), forbiddenDirs: [] (never export into these, e.g. the app's own folder), fs }
 */
function registerDraftIpc(ipcMain, drafts, store, deps) {
    deps = deps || {};
    const fsx = deps.fs || require('fs');
    const audit = (ev, data) => { try { if (deps.audit && deps.AUDIT_EVENTS && deps.AUDIT_EVENTS[ev]) deps.audit().write(deps.AUDIT_EVENTS[ev], data); } catch (_) { /* never block */ } };
    const wrap = (fn) => async (...args) => {
        try { return Object.assign({ success: true }, await fn(...args)); } catch (e) {
            return { success: false, error: e instanceof PackError ? e.message : ('Agency pack error: ' + (e && e.message || e)) };
        }
    };
    const win = () => (deps.getWindow && deps.getWindow()) || undefined;
    const focusBack = () => { try { if (deps.restoreFocus) deps.restoreFocus(); } catch (_) { /* ignore */ } };
    const req = (r) => (isPlainObject(r) ? r : {});
    const paths = (v) => (Array.isArray(v) ? v.filter(p => typeof p === 'string' && p) : []);
    async function pickDocx(multi, title) {
        let r;
        try {
            r = await deps.dialog.showOpenDialog(win(), {
                title, filters: [{ name: 'Word document', extensions: ['docx'] }],
                properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
            });
        } finally { focusBack(); }
        return r && !r.canceled && r.filePaths ? r.filePaths : [];
    }
    const inside = (child, parent) => {
        const rel = nodePath.relative(parent, child);
        return !rel || (!rel.startsWith('..') && !nodePath.isAbsolute(rel));
    };

    ipcMain.handle('agency-pack-drafts', wrap(async () => ({ drafts: drafts.list() })));
    ipcMain.handle('agency-pack-draft-create', wrap(async (_e, r) => ({ draft: drafts.create(req(r)) })));
    ipcMain.handle('agency-pack-draft-open', wrap(async (_e, r) => {
        r = req(r);
        return { draft: drafts.openInstalled(String(r.id || ''), { fresh: !!r.fresh }) };
    }));
    ipcMain.handle('agency-pack-draft-get', wrap(async (_e, id) => ({ draft: drafts.get(String(id || '')) })));
    ipcMain.handle('agency-pack-draft-op', wrap(async (_e, r) => {
        r = req(r);
        return { draft: drafts.op(String(r.id || ''), String(r.op || ''), r.args) };
    }));
    // r: { id, paths?, category, duplicates? } — no paths opens the file picker; duplicates: 'add'
    // adds files that match a template already in the pack as separate templates.
    ipcMain.handle('agency-pack-draft-add-templates', wrap(async (_e, r) => {
        r = req(r);
        let list = paths(r.paths);
        if (!list.length) list = await pickDocx(true, 'Add Word templates');
        if (!list.length) return { canceled: true };
        return drafts.addTemplates(String(r.id || ''), list, { category: r.category, duplicates: r.duplicates === 'add' ? 'add' : 'ask' });
    }));
    // r: { id, rel, path? }
    ipcMain.handle('agency-pack-draft-replace-template', wrap(async (_e, r) => {
        r = req(r);
        let p = typeof r.path === 'string' && r.path ? r.path : '';
        if (!p) p = (await pickDocx(false, 'Choose the newer Word file'))[0] || '';
        if (!p) return { canceled: true };
        return drafts.replaceTemplate(String(r.id || ''), String(r.rel || ''), p);
    }));
    // Writes the preview next to the drafts (a new name each time: Word may still have the last one open).
    ipcMain.handle('agency-pack-draft-preview', wrap(async (_e, r) => {
        r = req(r);
        const pv = drafts.preview(String(r.id || ''), String(r.rel || ''));
        const dir = nodePath.join(drafts.rootDir, PREVIEW_DIR);
        fsx.mkdirSync(dir, { recursive: true });
        try {
            for (const f of fsx.readdirSync(dir)) { try { fsx.unlinkSync(nodePath.join(dir, f)); } catch (_) { /* open in Word */ } }
        } catch (_) { /* ignore */ }
        let file = nodePath.join(dir, pv.filename);
        for (let n = 2; fsx.existsSync(file); n++) file = nodePath.join(dir, pv.filename.replace(/\.docx$/i, ` (${n}).docx`));
        fsx.writeFileSync(file, pv.data);
        if (!deps.shell) throw new PackError('Opening documents is not available');
        const err = await deps.shell.openPath(file);
        if (err) throw new PackError('Could not open the preview: ' + err);
        return { opened: true };
    }));
    // r: pack id, or { id, force } — force keeps edits made to an older install (the officer confirmed).
    ipcMain.handle('agency-pack-draft-save', wrap(async (_e, r) => {
        const o = isPlainObject(r) ? r : { id: r };
        const out = drafts.save(String(o.id || ''), { force: o.force === true });
        audit('AGENCY_PACK_INSTALLED', { pack_id: out.pack.id, pack_version: out.pack.packVersion, templates: out.pack.templateCount, source: 'editor', replaced_newer: out.replacedNewer || undefined });
        return out;
    }));
    ipcMain.handle('agency-pack-draft-discard', wrap(async (_e, id) => drafts.discard(String(id || ''))));

    // An installed pack as a .viperpack file the officer can share.
    ipcMain.handle('agency-pack-export', wrap(async (_e, id) => {
        id = String(id || '');
        const { buffer, manifest } = store.exportBuffer(id);
        const safe = String(manifest.name || id).replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '') || id;
        const defaultName = `${safe} ${manifest.packVersion}.viperpack`;
        const defaultDir = (typeof deps.defaultDir === 'function' && deps.defaultDir()) || '';
        let r;
        try {
            r = await deps.dialog.showSaveDialog(win(), {
                title: 'Export agency pack',
                defaultPath: defaultDir ? nodePath.join(defaultDir, defaultName) : defaultName,
                filters: [{ name: 'VIPER agency pack', extensions: ['viperpack'] }],
            });
        } finally { focusBack(); }
        if (!r || r.canceled || !r.filePath) return { canceled: true };
        let out = nodePath.resolve(r.filePath);
        if (!/\.viperpack$/i.test(out)) out += '.viperpack';
        const forbidden = (deps.forbiddenDirs || []).filter(Boolean).map(d => nodePath.resolve(d));
        const lower = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
        if (forbidden.some(d => inside(lower(out), lower(d)))) throw new PackError('Choose a folder outside VIPER\'s own program folder');
        fsx.writeFileSync(out, buffer);
        audit('AGENCY_PACK_EXPORTED', { pack_id: id, pack_version: manifest.packVersion, file: nodePath.basename(out) });
        return { filePath: out, packVersion: manifest.packVersion, bytes: buffer.length };
    }));
}

module.exports = { createDraftStore, registerDraftIpc, DRAFT_FORMAT, OPS };

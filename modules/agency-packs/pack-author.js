/**
 * Pack author — pure edits of an agency pack's config.json for the in-app pack editor.
 *
 * A pack keeps the agency's Word files untouched; config.json lists the fill-in fields found in
 * them (templatesConfig[rel].placeholders) and the fields shared between templates
 * (globalFields[].mappings). Everything here edits that config in place:
 *   - add / replace / remove a template (from a docx-form-engine scanTemplate() result)
 *   - auto-link: the same field name in 2+ templates becomes one shared field
 *   - field settings: label, kind, choices, hint, hidden, autofill
 *   - merge two fields into one shared field, or split a template's field back out
 *
 * Saved warrants are keyed 'global:<id>' / 'tpl:<rel>:<placeholder name>', so ids, template
 * paths and placeholder names never change here. Merges and splits leave `aliases` (old keys)
 * that builder-model migrateValues() reads, so answers already typed carry over.
 *
 * Renderer: window.ViperPackAuthor (load builder-model.js first). Node: require().
 */
(function (root, factory) {
    const BM = (root && root.ViperAgencyBuilder) || (typeof require === 'function' ? require('./builder-model.js') : null);
    const api = factory(BM);
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root) root.ViperPackAuthor = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function (BM) {
    'use strict';

    const norm = (s) => String(s == null ? '' : s).trim().replace(/\s+/g, ' ').toLowerCase();
    const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 500);
    const uniq = (arr) => Array.from(new Set(arr));
    const SETTING_KEYS = ['kind', 'autofill', 'hidden', 'hint'];

    const KIND_LABELS = {
        text: 'Short text',
        long: 'Long text (several lines)',
        richtext: 'Formatted text (bold, lists, tables, pictures)',
        date: 'Date',
        daterange: 'Date range',
        datetime: 'Date and time',
        dropdown: 'Dropdown list',
        photo: 'Text and photos',
    };
    const AUTOFILL_LABELS = {
        'case:caseNumber': 'Case number',
        'case:suspectName': "Suspect's name",
        'case:suspectDob': "Suspect's date of birth",
        'case:suspectHeight': "Suspect's height",
        'case:suspectWeight': "Suspect's weight",
        'case:suspectHair': "Suspect's hair color",
        'case:suspectEye': "Suspect's eye color",
        'case:suspectSex': "Suspect's sex",
        'case:suspectRace': "Suspect's race",
        'case:suspectPronoun': "Suspect's pronoun (his / her)",
        'case:suspectAddress': "Suspect's address",
        'case:suspectPhone': "Suspect's phone number",
        'case:suspectEmail': "Suspect's email",
        'case:offenses': 'Offenses',
        'case:offenseDate': 'Date of offense',
        'case:pcText': 'Probable cause narrative',
        'profile:nameBadge': 'Your name and badge #',
        'profile:bareName': 'Your name',
        'profile:title': 'Your title / rank',
        'profile:agency': 'Your agency',
        'profile:email': 'Your email',
        'profile:phone': 'Your phone',
        'profile:address': 'Your agency address',
        'profile:signatureText': 'Your signature line',
        'profile:backgroundOfAffiant': 'Your background (training & experience)',
    };
    const DEFAULT_CATEGORY = 'Search Warrant';
    const SUGGESTED_CATEGORIES = ['Search Warrant', 'Arrest Warrant', 'Court Order', 'Subpoena', 'Preservation Request', 'Affidavit', 'Other'];

    class AuthorError extends Error {
        constructor(message) { super(message); this.name = 'AuthorError'; }
    }
    const fail = (m) => { throw new AuthorError(m); };

    // ---- Basics ---------------------------------------------------------------------------
    function newConfig() {
        return { globalFields: [], templatesConfig: {}, unbracketedFields: [], filenameSuffixFields: {} };
    }
    function normalizeConfig(cfg) {
        const c = cfg && typeof cfg === 'object' ? cfg : {};
        if (!Array.isArray(c.globalFields)) c.globalFields = [];
        if (!c.templatesConfig || typeof c.templatesConfig !== 'object') c.templatesConfig = {};
        if (!Array.isArray(c.unbracketedFields)) c.unbracketedFields = [];
        if (!c.filenameSuffixFields || typeof c.filenameSuffixFields !== 'object') c.filenameSuffixFields = {};
        c.globalFields.forEach(g => { if (!Array.isArray(g.mappings)) g.mappings = []; });
        Object.values(c.templatesConfig).forEach(t => { if (!Array.isArray(t.placeholders)) t.placeholders = []; });
        return c;
    }
    const clone = (v) => JSON.parse(JSON.stringify(v));

    const templateRels = (c) => Object.keys(c.templatesConfig);
    const getTemplate = (c, rel) => c.templatesConfig[rel] || null;
    const getPlaceholder = (c, rel, name) => {
        const t = getTemplate(c, rel);
        return t ? t.placeholders.find(p => p.name === name) || null : null;
    };
    const getGlobal = (c, id) => c.globalFields.find(g => g.id === id) || null;
    const globalFor = (c, rel, name) =>
        c.globalFields.find(g => g.mappings.some(m => m.templateId === rel && m.placeholderName === name)) || null;

    function newGlobalId(c, opts) {
        const taken = new Set(c.globalFields.map(g => g.id));
        const gen = (opts && opts.newId) || (() => 'g_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7));
        for (let i = 0; i < 1000; i++) { const id = gen(); if (id && !taken.has(id)) return id; }
        fail('Could not make a field id');
    }
    function uniqueTag(base, taken) {
        const b = BM.sanitizeTag(base) || 'field';
        let t = b, i = 2;
        while (taken.has(t)) t = b + '_' + (i++);
        return t;
    }
    // Content-control tags already used in one template (shared + its own fields), minus `skip`.
    function tagsInTemplate(c, rel, skip) {
        const out = new Set();
        const t = getTemplate(c, rel); if (!t) return out;
        t.placeholders.forEach(p => {
            if (p === skip) return;
            const g = globalFor(c, rel, p.name);
            out.add(g ? g.tag : (p.customTag || BM.sanitizeTag(p.name)));
        });
        return out;
    }

    // ---- Templates ------------------------------------------------------------------------
    /** A safe, unique templates/ path for an uploaded file name (flat; the category is separate). */
    function templateRelFor(c, filename) {
        let base = String(filename || '').split(/[\\/]/).pop().replace(/\.docx$/i, '');
        base = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 120).trim();
        if (!base) base = 'Template';
        if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) base = 'Template ' + base;
        const taken = new Set(templateRels(c).map(r => r.toLowerCase()));
        let rel = base + '.docx', i = 2;
        while (taken.has(rel.toLowerCase())) rel = `${base} (${i++}).docx`;
        return rel;
    }

    function placeholderFromScan(p) {
        const detected = BM.detectDropdownChoices(p.name);
        const out = {
            name: p.name, type: detected ? 'dropdown' : 'text', choices: detected || [], hint: '',
            customTitle: p.name, customTag: BM.sanitizeTag(p.name),
        };
        if (p.context) out.context = String(p.context).slice(0, 400);
        return out;
    }

    function addTemplate(cfg, rel, scan, opts) {
        const c = normalizeConfig(cfg);
        opts = opts || {};
        if (c.templatesConfig[rel]) fail('That template is already in the pack.');
        const list = (scan && scan.placeholders) || [];
        c.templatesConfig[rel] = { category: str(opts.category, 80) || DEFAULT_CATEGORY, placeholders: list.map(placeholderFromScan) };
        const link = autoLink(c, opts);
        return { rel, fields: list.length, linked: link.linked, created: link.created };
    }

    /** New Word file for an existing template: keeps settings of fields still there. */
    function replaceTemplate(cfg, rel, scan, opts) {
        const c = normalizeConfig(cfg);
        const t = getTemplate(c, rel); if (!t) fail('Template not found.');
        const old = new Map(t.placeholders.map(p => [p.name, p]));
        const seen = new Set(), added = [], kept = [];
        const next = [];
        ((scan && scan.placeholders) || []).forEach(sp => {
            if (seen.has(sp.name)) return; seen.add(sp.name);
            const prev = old.get(sp.name);
            if (prev) { if (sp.context) prev.context = String(sp.context).slice(0, 400); next.push(prev); kept.push(sp.name); }
            else { next.push(placeholderFromScan(sp)); added.push(sp.name); }
        });
        const removed = t.placeholders.map(p => p.name).filter(n => !seen.has(n));
        t.placeholders = next;
        const touched = new Set();
        c.globalFields.forEach(g => {
            const before = g.mappings.length;
            g.mappings = g.mappings.filter(m => !(m.templateId === rel && removed.includes(m.placeholderName)));
            if (g.mappings.length !== before) touched.add(g.id);
        });
        pruneGlobals(c, touched);
        const link = autoLink(c, opts);
        return { added, removed, kept, linked: link.linked, created: link.created };
    }

    function removeTemplate(cfg, rel) {
        const c = normalizeConfig(cfg);
        if (!c.templatesConfig[rel]) fail('Template not found.');
        delete c.templatesConfig[rel];
        delete c.filenameSuffixFields[rel];
        const touched = new Set();
        c.globalFields.forEach(g => {
            const before = g.mappings.length;
            g.mappings = g.mappings.filter(m => m.templateId !== rel);
            if (g.mappings.length !== before) touched.add(g.id);
        });
        pruneGlobals(c, touched);
        return c;
    }

    function setCategory(cfg, rel, category) {
        const c = normalizeConfig(cfg);
        const t = getTemplate(c, rel); if (!t) fail('Template not found.');
        t.category = str(category, 80) || DEFAULT_CATEGORY;
        return c;
    }
    const categories = (cfg) => uniq(templateRels(normalizeConfig(cfg)).map(r => cfg.templatesConfig[r].category || DEFAULT_CATEGORY));

    // Shared fields left with no template after an edit are dropped (only the ones we touched).
    function pruneGlobals(c, ids) {
        if (!ids || !ids.size) return;
        c.globalFields = c.globalFields.filter(g => !(ids.has(g.id) && !g.mappings.length));
    }

    // ---- Auto-link --------------------------------------------------------------------------
    /**
     * Fields with the same name become one shared field: joins an existing shared field that
     * already holds that placeholder name, else creates one when the name is in 2+ templates.
     * Placeholders split out by the officer (`unlinked`) are left alone.
     */
    function autoLink(cfg, opts) {
        const c = normalizeConfig(cfg);
        const byName = new Map();
        c.globalFields.forEach(g => g.mappings.forEach(m => { const k = norm(m.placeholderName); if (!byName.has(k)) byName.set(k, g); }));
        const groups = new Map();
        templateRels(c).forEach(rel => c.templatesConfig[rel].placeholders.forEach(p => {
            if (p.unlinked || globalFor(c, rel, p.name)) return;
            const k = norm(p.name); if (!k) return;
            if (!groups.has(k)) groups.set(k, []);
            groups.get(k).push({ rel, p });
        }));
        let linked = 0, created = 0;
        groups.forEach((items, k) => {
            let g = byName.get(k);
            if (!g) {
                if (new Set(items.map(i => i.rel)).size < 2) return;
                const first = items[0].p;
                g = {
                    id: newGlobalId(c, opts), name: first.customTitle || first.name,
                    tag: uniqueTag(first.name, new Set(c.globalFields.map(x => x.tag))),
                    type: first.type || 'text', choices: (first.choices || []).slice(), defaultValue: '', category: '', mappings: [],
                };
                SETTING_KEYS.forEach(s => { const src = items.find(i => i.p[s] !== undefined && i.p[s] !== ''); if (src) g[s] = src.p[s]; });
                c.globalFields.push(g);
                byName.set(k, g);
                created++;
            }
            items.forEach(({ rel, p }) => {
                g.mappings.push({ templateId: rel, placeholderName: p.name });
                if (Array.isArray(p.aliases) && p.aliases.length) g.aliases = uniq((g.aliases || []).concat(p.aliases));
                linked++;
            });
        });
        return { linked, created };
    }

    // ---- Field references ------------------------------------------------------------------
    // { g: id } = shared field; { t: rel, p: placeholder name } = one template's own field.
    const refKey = (ref) => JSON.stringify(ref.g ? { g: ref.g } : { t: ref.t, p: ref.p });
    function parseRef(key) {
        try { const r = typeof key === 'string' ? JSON.parse(key) : key; return r && (r.g || (r.t && r.p != null)) ? r : null; } catch (e) { return null; }
    }
    function specFor(c, ref) {
        if (!ref) return null;
        if (ref.g) return getGlobal(c, ref.g);
        if (globalFor(c, ref.t, ref.p)) return null; // that placeholder is part of a shared field
        return getPlaceholder(c, ref.t, ref.p);
    }
    const labelOf = (spec, isGlobal) => (isGlobal ? spec.name : (spec.customTitle || spec.name));

    /** Every field for the editor: shared fields first, then each template's own fields. */
    function listFields(cfg, rules) {
        const c = normalizeConfig(cfg);
        const b = BM.createBuilder(c, rules);
        const ctxOf = (rel, name) => { const p = getPlaceholder(c, rel, name); return p ? (p.context || '') : ''; };
        const catOf = (rel) => (getTemplate(c, rel) || {}).category || DEFAULT_CATEGORY;
        const describe = (spec, isGlobal, uses, category) => {
            const label = labelOf(spec, isGlobal);
            return {
                label,
                kind: spec.kind || '',
                effectiveKind: b.fieldKind(label, spec.type, spec.kind),
                autofill: spec.autofill || '',
                effectiveAutofill: b.autofillSource(label, spec),
                hidden: typeof spec.hidden === 'boolean' ? spec.hidden : null,
                effectiveHidden: b.isHidden(label, category, spec),
                hint: spec.hint || '',
                choices: Array.isArray(spec.choices) ? spec.choices.slice() : [],
                uses,
            };
        };
        const shared = c.globalFields.map(g => {
            const uses = g.mappings.filter(m => getPlaceholder(c, m.templateId, m.placeholderName))
                .map(m => ({ rel: m.templateId, name: m.placeholderName, context: ctxOf(m.templateId, m.placeholderName) }));
            return Object.assign({ ref: { g: g.id }, key: refKey({ g: g.id }), shared: true },
                describe(g, true, uses, uses.length ? catOf(uses[0].rel) : ''));
        }).filter(f => f.uses.length).sort((a, z) => a.label.localeCompare(z.label));
        const own = [];
        templateRels(c).forEach(rel => c.templatesConfig[rel].placeholders.forEach(p => {
            if (globalFor(c, rel, p.name)) return;
            const ref = { t: rel, p: p.name };
            own.push(Object.assign({ ref, key: refKey(ref), shared: false, unlinked: !!p.unlinked },
                describe(p, false, [{ rel, name: p.name, context: p.context || '' }], catOf(rel))));
        }));
        return { shared, own };
    }

    // ---- Field settings --------------------------------------------------------------------
    function cleanChoices(list) {
        if (!Array.isArray(list)) return [];
        return uniq(list.map(v => str(v, 200)).filter(Boolean)).slice(0, 200);
    }
    function effective(c, ref, rules) {
        const spec = specFor(c, ref); if (!spec) return null;
        const b = BM.createBuilder(c, rules);
        const label = labelOf(spec, !!ref.g);
        const rel = ref.g ? ((spec.mappings[0] || {}).templateId) : ref.t;
        const cat = ((rel && getTemplate(c, rel)) || {}).category;
        return {
            kind: b.fieldKind(label, spec.type, spec.kind),
            autofill: b.autofillSource(label, spec),
            hidden: b.isHidden(label, cat, spec),
        };
    }

    /**
     * patch: { label, kind ('' = automatic), choices, hint, hidden (true/false/null = automatic),
     *          autofill ('' = automatic, 'none', 'case:<fact>', 'profile:<key>') }.
     * Renaming never silently changes how a field behaves: what the old name gave it is pinned.
     */
    function updateField(cfg, ref, patch, rules) {
        const c = normalizeConfig(cfg);
        const spec = specFor(c, ref); if (!spec) fail('Field not found.');
        patch = patch || {};
        const before = effective(c, ref, rules);
        if ('label' in patch) {
            const label = str(patch.label, 200); if (!label) fail('A field needs a label.');
            if (ref.g) spec.name = label; else spec.customTitle = label;
        }
        if ('choices' in patch) spec.choices = cleanChoices(patch.choices);
        if ('hint' in patch) { const h = str(patch.hint, 500); if (h) spec.hint = h; else spec.hint = ''; }
        if ('kind' in patch) {
            const k = patch.kind;
            if (!k || k === 'auto') { delete spec.kind; spec.type = (spec.choices && spec.choices.length) ? 'dropdown' : 'text'; }
            else if (BM.FIELD_KINDS.includes(k)) { spec.kind = k; spec.type = k === 'dropdown' ? 'dropdown' : 'text'; }
            else fail('Unknown field type.');
            if (k === 'dropdown' && !(spec.choices && spec.choices.length) && !('choices' in patch)) {
                spec.choices = BM.detectDropdownChoices(spec.name) || [];
            }
        }
        if ('hidden' in patch) {
            if (patch.hidden === true || patch.hidden === false) spec.hidden = patch.hidden; else delete spec.hidden;
        }
        if ('autofill' in patch) {
            const a = patch.autofill;
            if (!a || a === 'auto') delete spec.autofill;
            else if (a === 'none' || AUTOFILL_LABELS[a]) spec.autofill = a;
            else fail('Unknown autofill choice.');
        }
        if ('label' in patch) {
            const after = effective(c, ref, rules);
            if (!('kind' in patch) && !spec.kind && after.kind !== before.kind) { spec.kind = before.kind; spec.type = before.kind === 'dropdown' ? 'dropdown' : 'text'; }
            if (!('autofill' in patch) && !spec.autofill && after.autofill !== before.autofill) spec.autofill = before.autofill || 'none';
            if (!('hidden' in patch) && typeof spec.hidden !== 'boolean' && after.hidden !== before.hidden) spec.hidden = before.hidden;
        }
        return spec;
    }

    // ---- Merge / split ---------------------------------------------------------------------
    function promote(c, rel, name, opts) {
        const p = getPlaceholder(c, rel, name); if (!p) fail('Field not found.');
        const g = {
            id: newGlobalId(c, opts), name: p.customTitle || p.name,
            tag: uniqueTag(p.customTag || p.name, new Set(c.globalFields.map(x => x.tag))),
            type: p.type || 'text', choices: (p.choices || []).slice(), defaultValue: '', category: '',
            mappings: [{ templateId: rel, placeholderName: name }],
        };
        SETTING_KEYS.forEach(s => { if (p[s] !== undefined && p[s] !== '') g[s] = p[s]; });
        if (Array.isArray(p.aliases) && p.aliases.length) g.aliases = p.aliases.slice();
        delete p.unlinked;
        c.globalFields.push(g);
        return g;
    }

    /** Fold `fromRef` into `intoRef`; the result is one shared field with `intoRef`'s settings. */
    function mergeFields(cfg, intoRef, fromRef, opts) {
        const c = normalizeConfig(cfg);
        if (!specFor(c, intoRef) || !specFor(c, fromRef)) fail('Field not found.');
        if (refKey(intoRef) === refKey(fromRef)) fail('Pick two different fields.');
        const g = intoRef.g ? getGlobal(c, intoRef.g) : promote(c, intoRef.t, intoRef.p, opts);
        const has = (rel, name) => g.mappings.some(m => m.templateId === rel && m.placeholderName === name);
        if (fromRef.g) {
            const src = getGlobal(c, fromRef.g);
            src.mappings.forEach(m => { if (!has(m.templateId, m.placeholderName)) g.mappings.push(m); });
            g.aliases = uniq((g.aliases || []).concat(['global:' + src.id], src.aliases || []));
            c.globalFields = c.globalFields.filter(x => x !== src);
        } else {
            const p = getPlaceholder(c, fromRef.t, fromRef.p);
            if (!has(fromRef.t, fromRef.p)) g.mappings.push({ templateId: fromRef.t, placeholderName: fromRef.p });
            if (Array.isArray(p.aliases) && p.aliases.length) g.aliases = uniq((g.aliases || []).concat(p.aliases));
            delete p.unlinked;
        }
        return { g: g.id };
    }

    /**
     * Take one template's field out of a shared field; it keeps the shared field's settings.
     * When that leaves the shared field with a single template, it stops being shared too.
     */
    function splitField(cfg, globalId, rel, name) {
        const c = normalizeConfig(cfg);
        const g = getGlobal(c, globalId); if (!g) fail('Field not found.');
        if (!g.mappings.some(m => m.templateId === rel && m.placeholderName === name)) fail('That template is not part of this field.');
        const p = getPlaceholder(c, rel, name); if (!p) fail('Field not found.');
        // A shared label that is just another template's field name goes back to this field's own name.
        const memberNames = new Set(g.mappings.map(m => norm(m.placeholderName)));
        const labelFor = (q) => {
            if (norm(g.name) === norm(q.name) || !memberNames.has(norm(g.name))) return g.name;
            return (q.customTitle && norm(q.customTitle) !== norm(g.name)) ? q.customTitle : q.name;
        };
        const takeOut = (q, qRel, unlinked) => {
            g.mappings = g.mappings.filter(m => !(m.templateId === qRel && m.placeholderName === q.name));
            q.customTitle = labelFor(q);
            q.type = g.type || 'text';
            q.choices = (g.choices || []).slice();
            SETTING_KEYS.forEach(s => { if (g[s] !== undefined) q[s] = g[s]; else delete q[s]; });
            q.aliases = uniq((q.aliases || []).concat(['global:' + g.id]));
            if (unlinked) q.unlinked = true;
            q.customTag = uniqueTag(q.name, tagsInTemplate(c, qRel, q));
        };
        takeOut(p, rel, true);
        const live = g.mappings.filter(m => getPlaceholder(c, m.templateId, m.placeholderName));
        if (live.length === 1) {
            const m = live[0];
            takeOut(getPlaceholder(c, m.templateId, m.placeholderName), m.templateId, false);
            g.mappings = [];
        }
        pruneGlobals(c, new Set([g.id]));
        return { t: rel, p: name };
    }

    // ---- Pack details ----------------------------------------------------------------------
    function bumpVersion(v) {
        const s = String(v == null ? '' : v).trim();
        let m;
        if ((m = /^(\d+)\.(\d+)\.(\d+)$/.exec(s))) return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
        if ((m = /^(\d+)\.(\d+)$/.exec(s))) return `${m[1]}.${m[2]}.1`;
        if ((m = /^(\d+)$/.exec(s))) return `${m[1]}.0.1`;
        return s ? s + '.1' : '1.0.0';
    }
    function makePackId(name, taken) {
        const t = taken instanceof Set ? taken : new Set(taken || []);
        let base = norm(name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
        if (base.length < 2) base = 'agency-pack';
        let id = base, i = 2;
        while (t.has(id)) id = `${base}-${i++}`;
        return id;
    }

    /** Problems that block saving (errors) and things worth a look (warnings). */
    function checkDraft(draft) {
        const errors = [], warnings = [];
        const d = draft || {};
        const meta = d.meta || {};
        const c = normalizeConfig(d.config);
        if (!str(meta.name, 120)) errors.push('Give the pack a name.');
        const rels = templateRels(c);
        if (!rels.length) errors.push('Add at least one Word template.');
        rels.forEach(rel => {
            if (!c.templatesConfig[rel].placeholders.length) warnings.push(`${BM.displayName(rel)} has no fill-in fields yet. Highlight the [Field name] text in Word, then replace the file.`);
        });
        return { errors, warnings, ok: !errors.length };
    }

    return {
        AuthorError, KIND_LABELS, AUTOFILL_LABELS, DEFAULT_CATEGORY, SUGGESTED_CATEGORIES,
        newConfig, normalizeConfig, clone,
        templateRelFor, placeholderFromScan, addTemplate, replaceTemplate, removeTemplate, setCategory, categories,
        autoLink, refKey, parseRef, listFields, updateField, mergeFields, splitField,
        bumpVersion, makePackId, checkDraft,
    };
});

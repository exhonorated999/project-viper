'use strict';
/*
 * modules/case-forms/form-set.js — main process (node). The form-set file format.
 *
 * A form set is one agency's fillable PDFs plus the instructions that say
 * which case fact goes in which box. VIPER ships none: sets are published on
 * the dashboard and downloaded when an officer switches one on in Settings
 * (or imported from a .viperforms file).
 *
 *   <set>.viperforms (ZIP)
 *     manifest.json
 *       { format: 'viper-form-set', formatVersion: 1,
 *         id, name, agency?, description?, version, createdAt?,
 *         forms: [{ id, title, category?, language?, group?,
 *                   file: 'forms/<id>.pdf', sha256,
 *                   flatten?, slots: [{id, label, roles?}], vehicleSlots: [{id, label}],
 *                   bindings: { "<pdf field name>": binding } }] }
 *     forms/<id>.pdf  one per form, byte-identical to the agency's original
 *
 *   binding  { src: '<form-sources id>', slot?, fmt?, timeFmt?, upper? }
 *          | { src: 'const', value }        fixed text / checkbox state
 *          | { src: 'ask' }                 officer types it (same as no binding)
 *
 * Reading checks everything before anything is used: only those entries,
 * safe names, sizes from the ZIP headers before inflating, every listed PDF
 * present with a matching SHA-256, nothing unlisted, every binding pointing
 * at a known source and a slot the form declares.
 */

const crypto = require('crypto');
const Sources = require('./form-sources.js');
const { isSafeRelPath, compareVersions } = require('../agency-packs/pack-store.js');

const FORMAT = 'viper-form-set';
const FORMAT_VERSION = 1;
const FILE_EXT = '.viperforms';
const ID_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const FORM_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SLOT_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const LANG_RE = /^[a-z]{2}(-[A-Z]{2})?$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const LIMITS = Object.freeze({
    maxForms: 200,
    maxPdfBytes: 40 * 1024 * 1024,
    maxTotalBytes: 400 * 1024 * 1024,
    maxManifestBytes: 8 * 1024 * 1024,
    maxBindings: 2000,
    maxSlots: 12,
    maxFieldName: 300,
    maxConst: 4000,
});
const BINDING_KEYS = new Set(['src', 'slot', 'fmt', 'timeFmt', 'upper', 'value']);

class FormSetError extends Error {
    constructor(message) { super(message); this.name = 'FormSetError'; }
}
const fail = (msg) => { throw new FormSetError(msg); };
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const optText = (v, max) => v == null || (typeof v === 'string' && v.length <= max);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const isPdf = (buf) => Buffer.isBuffer(buf) && buf.length > 8 && buf.slice(0, 1024).includes('%PDF-');

/** Returns an error message for one binding, or '' when it is fine. */
function bindingProblem(b, slotIds, vehicleSlotIds) {
    if (!isPlainObject(b)) return 'is not an object';
    for (const k of Object.keys(b)) if (!BINDING_KEYS.has(k)) return 'has an unknown setting "' + k + '"';
    if (b.upper != null && typeof b.upper !== 'boolean') return 'upper must be true or false';
    if (b.src === 'ask') return '';
    if (b.src === 'const') {
        const v = b.value;
        if (typeof v === 'boolean') return '';
        if (typeof v !== 'string' || v.length > LIMITS.maxConst) return 'fixed value must be text';
        return '';
    }
    if (b.value != null) return 'only fixed values carry a value';
    const src = Sources.SOURCE_BY_ID[b.src];
    if (!src) return 'uses an unknown source "' + String(b.src).slice(0, 60) + '"';
    if (src.needs === 'person') {
        if (!slotIds.has(b.slot)) return 'needs a person slot the form declares';
    } else if (src.needs === 'vehicle') {
        if (!vehicleSlotIds.has(b.slot)) return 'needs a vehicle slot the form declares';
    } else if (b.slot != null) {
        return 'source "' + b.src + '" does not take a slot';
    }
    const dateish = src.type === 'date' || src.type === 'datetime';
    const timeish = src.type === 'time' || src.type === 'datetime';
    if (b.fmt != null) {
        if (src.type === 'time') { if (!Sources.TIME_FORMATS.includes(b.fmt)) return 'unknown time format'; }
        else if (!dateish || !Sources.DATE_FORMATS.includes(b.fmt)) return 'unknown date format';
    }
    if (b.timeFmt != null && (!timeish || !Sources.TIME_FORMATS.includes(b.timeFmt))) return 'unknown time format';
    return '';
}

function validateSlots(list, label, withRoles) {
    if (list == null) return [];
    if (!Array.isArray(list) || list.length > LIMITS.maxSlots) fail(label + ' must be a short list');
    const ids = new Set();
    list.forEach((s, i) => {
        if (!isPlainObject(s) || typeof s.id !== 'string' || !SLOT_ID_RE.test(s.id)) fail(`${label}[${i}] needs an id`);
        if (ids.has(s.id)) fail(`${label}: "${s.id}" is listed twice`);
        ids.add(s.id);
        if (!text(s.label, 80)) fail(`${label}[${i}] needs a label`);
        if (withRoles && s.roles != null) {
            if (!Array.isArray(s.roles) || !s.roles.every(r => Sources.PERSON_ROLES.includes(r))) fail(`${label}[${i}] has unknown roles`);
        }
    });
    return list;
}

function validateForm(f, i) {
    const at = `forms[${i}]`;
    if (!isPlainObject(f)) fail(at + ' is not an object');
    if (typeof f.id !== 'string' || !FORM_ID_RE.test(f.id)) fail(at + ' id must be lowercase letters, digits and dashes');
    if (!text(f.title, 160)) fail(`Form "${f.id}" needs a title`);
    if (!optText(f.category, 60) || !optText(f.group, 60)) fail(`Form "${f.id}": category/group too long`);
    if (f.language != null && (typeof f.language !== 'string' || !LANG_RE.test(f.language))) fail(`Form "${f.id}": language must look like "en" or "es"`);
    if (f.file !== 'forms/' + f.id + '.pdf') fail(`Form "${f.id}": file must be forms/${f.id}.pdf`);
    if (typeof f.sha256 !== 'string' || !SHA_RE.test(f.sha256)) fail(`Form "${f.id}": bad checksum`);
    if (f.flatten != null && typeof f.flatten !== 'boolean') fail(`Form "${f.id}": flatten must be true or false`);
    const slots = validateSlots(f.slots, `Form "${f.id}" slots`, true);
    const vslots = validateSlots(f.vehicleSlots, `Form "${f.id}" vehicleSlots`, false);
    const slotIds = new Set(slots.map(s => s.id));
    const vehicleSlotIds = new Set(vslots.map(s => s.id));
    for (const id of vehicleSlotIds) if (slotIds.has(id)) fail(`Form "${f.id}": slot "${id}" is both a person and a vehicle`);
    const bindings = f.bindings == null ? {} : f.bindings;
    if (!isPlainObject(bindings)) fail(`Form "${f.id}": bindings must be an object`);
    const names = Object.keys(bindings);
    if (names.length > LIMITS.maxBindings) fail(`Form "${f.id}" has too many bindings`);
    for (const name of names) {
        if (!name || name.length > LIMITS.maxFieldName) fail(`Form "${f.id}": bad field name`);
        const p = bindingProblem(bindings[name], slotIds, vehicleSlotIds);
        if (p) fail(`Form "${f.id}", field "${name.slice(0, 80)}": ${p}`);
    }
    return f;
}

function validateManifest(m) {
    if (!isPlainObject(m)) fail('manifest.json is not an object');
    if (m.format !== FORMAT) fail('Not a VIPER form set');
    if (m.formatVersion !== FORMAT_VERSION) fail(`Form set format ${m.formatVersion} is not supported by this version of VIPER`);
    if (typeof m.id !== 'string' || !ID_RE.test(m.id)) fail('Form set id is missing or invalid');
    if (!text(m.name, 120)) fail('Form set name is missing');
    if (!text(m.version, 40)) fail('Form set version is missing');
    if (!optText(m.agency, 160) || !optText(m.description, 2000)) fail('Form set agency/description too long');
    if (!Array.isArray(m.forms) || !m.forms.length) fail('The form set has no forms');
    if (m.forms.length > LIMITS.maxForms) fail('The form set has too many forms');
    const ids = new Set();
    m.forms.forEach((f, i) => {
        validateForm(f, i);
        if (ids.has(f.id)) fail(`Form id "${f.id}" is used twice`);
        ids.add(f.id);
    });
    return m;
}

/**
 * input: { id, name, agency?, description?, version, createdAt?,
 *          forms: [{ id, title, category?, language?, group?, flatten?, slots?, vehicleSlots?, bindings?, pdf: Buffer }] }
 * Returns { buffer, manifest }. Throws FormSetError when the result would not load.
 */
function buildFormSetBuffer(input, deps) {
    const AdmZip = (deps && deps.AdmZip) || require('adm-zip');
    const o = input || {};
    if (!Array.isArray(o.forms) || !o.forms.length) fail('The form set has no forms');
    const zip = new AdmZip();
    let total = 0;
    const forms = o.forms.map(f => {
        const pdf = f && f.pdf;
        if (!isPdf(pdf)) fail(`Form "${f && f.id}" is not a PDF`);
        if (pdf.length > LIMITS.maxPdfBytes) fail(`Form "${f.id}" is too large`);
        total += pdf.length;
        const meta = {
            id: f.id,
            title: typeof f.title === 'string' ? f.title.trim() : f.title,
            file: 'forms/' + f.id + '.pdf',
            sha256: sha256(pdf),
            slots: f.slots || [],
            vehicleSlots: f.vehicleSlots || [],
            bindings: f.bindings || {},
        };
        ['category', 'language', 'group', 'flatten'].forEach(k => { if (f[k] != null && f[k] !== '') meta[k] = f[k]; });
        return { meta, pdf };
    });
    if (total > LIMITS.maxTotalBytes) fail('The form set is too large');
    const manifest = {
        format: FORMAT,
        formatVersion: FORMAT_VERSION,
        id: o.id,
        name: String(o.name || '').trim(),
        agency: String(o.agency || '').trim(),
        description: String(o.description || '').trim(),
        version: String(o.version || '').trim(),
        createdAt: o.createdAt || new Date().toISOString(),
        forms: forms.map(x => x.meta),
    };
    validateManifest(manifest);
    for (const x of forms) {
        if (!isSafeRelPath(x.meta.file)) fail('Form file name cannot be packed safely: ' + x.meta.file);
        zip.addFile(x.meta.file, x.pdf);
    }
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
    return { buffer: zip.toBuffer(), manifest };
}

/**
 * Parse and fully check a .viperforms file held in memory.
 * Returns { manifest, pdfs: Map<formId, Buffer> }.
 */
function readFormSetBuffer(buf, deps) {
    const AdmZip = (deps && deps.AdmZip) || require('adm-zip');
    if (!Buffer.isBuffer(buf) || buf.length < 22) fail('The form set file is empty or damaged');
    let zip;
    try { zip = new AdmZip(buf); } catch (_) { fail('The form set file is damaged or not a form set'); }
    let entries;
    try { entries = zip.getEntries().filter(e => !e.isDirectory); } catch (_) { fail('The form set file is damaged'); }
    if (entries.length > LIMITS.maxForms + 1) fail('The form set has too many files');
    const byName = new Map();
    let total = 0;
    for (const e of entries) {
        const name = e.entryName;
        if (!isSafeRelPath(name)) fail(`Unsafe file name in form set: ${name}`);
        if (!(name === 'manifest.json' || /^forms\/[a-z0-9][a-z0-9-]{0,62}\.pdf$/.test(name))) fail(`Unexpected file in form set: ${name}`);
        if (byName.has(name.toLowerCase())) fail(`Duplicate file in form set: ${name}`);
        const size = e.header.size;
        const cap = name === 'manifest.json' ? LIMITS.maxManifestBytes : LIMITS.maxPdfBytes;
        if (size > cap) fail(`File too large in form set: ${name}`);
        total += size;
        if (total > LIMITS.maxTotalBytes) fail('The form set is too large when unpacked');
        byName.set(name.toLowerCase(), e);
    }
    const data = (name) => {
        const e = byName.get(name);
        let out;
        try { out = e.getData(); } catch (_) { fail(`File damaged in form set: ${name}`); }
        if (out.length !== e.header.size) fail(`File damaged in form set: ${name}`);
        return out;
    };
    if (!byName.has('manifest.json')) fail('Not a VIPER form set (no manifest)');
    let manifest;
    try { manifest = JSON.parse(data('manifest.json').toString('utf8')); } catch (e) {
        if (e instanceof FormSetError) throw e;
        fail('manifest.json is not valid JSON');
    }
    validateManifest(manifest);
    const listed = new Set(manifest.forms.map(f => f.file));
    for (const name of byName.keys()) {
        if (name !== 'manifest.json' && !listed.has(name)) fail(`File not listed in manifest: ${name}`);
    }
    const pdfs = new Map();
    for (const f of manifest.forms) {
        if (!byName.has(f.file)) fail(`Form file missing: ${f.file}`);
        const pdf = data(f.file);
        if (sha256(pdf) !== f.sha256) fail(`Checksum mismatch: ${f.file}`);
        if (!isPdf(pdf)) fail(`Not a PDF: ${f.file}`);
        pdfs.set(f.id, pdf);
    }
    return { manifest, pdfs };
}

/** What Settings shows for a set. */
function summarize(manifest, extra) {
    const languages = new Set(), categories = {};
    manifest.forms.forEach(f => {
        if (f.language) languages.add(f.language);
        const c = f.category || 'Other';
        categories[c] = (categories[c] || 0) + 1;
    });
    return Object.assign({
        id: manifest.id,
        name: manifest.name,
        agency: manifest.agency || '',
        description: manifest.description || '',
        version: manifest.version,
        createdAt: manifest.createdAt || null,
        formCount: manifest.forms.length,
        forms: manifest.forms.map(f => ({
            id: f.id, title: f.title, category: f.category || '', language: f.language || '', group: f.group || '',
            // Who goes on the form — the person page's Forms button ranks forms by these.
            slots: (f.slots || []).map(s => ({ id: s.id, label: s.label, roles: Array.isArray(s.roles) ? s.roles.slice() : [] })),
            vehicleSlots: (f.vehicleSlots || []).map(s => ({ id: s.id, label: s.label })),
        })),
        languages: [...languages].sort(),
        categories,
    }, extra || {});
}

module.exports = {
    FORMAT, FORMAT_VERSION, FILE_EXT, LIMITS, ID_RE, FORM_ID_RE,
    FormSetError, bindingProblem, validateForm, validateManifest,
    buildFormSetBuffer, readFormSetBuffer, summarize, compareVersions, sha256,
};

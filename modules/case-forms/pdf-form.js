'use strict';
/*
 * modules/case-forms/pdf-form.js — main process only (pdf-lib).
 *
 * The two things VIPER does to an agency's fillable PDF:
 *
 *   inspect(bytes) → { pageCount, pages: [{width, height}], fields: [...] }
 *     Every AcroForm field with its type, page, rectangle (PDF points,
 *     origin bottom-left) and options, in READING ORDER (page, then top to
 *     bottom, then left to right). The auto-mapper depends on that order and
 *     the mapper screen draws the rectangles over a rendered page.
 *
 *   fill(bytes, values, { flatten }) → { bytes, filled, warnings }
 *     Writes values into the agency's OWN form. Nothing is redrawn or
 *     re-laid-out: the official form stays the official form, and with
 *     flatten off it stays editable in Acrobat so an officer can still fix a
 *     box by hand.
 *
 * Text goes through Helvetica (WinAnsi). That covers English and Spanish
 * (á é í ó ú ñ ü ¿ ¡). Anything it cannot draw is replaced and reported
 * rather than allowed to throw half way through a form.
 */
const {
    PDFDocument, StandardFonts, PDFName, PDFRef, PDFDict, PDFArray,
    PDFTextField, PDFCheckBox, PDFDropdown, PDFOptionList, PDFRadioGroup, PDFButton, PDFSignature,
    layoutSinglelineText, layoutMultilineText,
} = require('pdf-lib');

const MAX_PDF_BYTES = 40 * 1024 * 1024;
// "Auto" font size boxes: pdf-lib grows the text to fill the box (a 26pt
// date in a tall cell). Viewers cap auto text near 12pt; so do we.
const AUTO_FONT_MAX = 11;

function typeOf(field) {
    if (field instanceof PDFTextField) return 'text';
    if (field instanceof PDFCheckBox) return 'checkbox';
    if (field instanceof PDFDropdown) return 'dropdown';
    if (field instanceof PDFOptionList) return 'list';
    if (field instanceof PDFRadioGroup) return 'radio';
    if (field instanceof PDFSignature) return 'signature';
    if (field instanceof PDFButton) return 'button';
    return 'unknown';
}

async function load(bytes) {
    if (!bytes || !bytes.length) throw new Error('Empty PDF');
    if (bytes.length > MAX_PDF_BYTES) throw new Error('PDF is larger than ' + (MAX_PDF_BYTES >> 20) + ' MB');
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    doc.__viperRepaired = repairFieldTree(doc);
    return doc;
}

const MAX_TREE_DEPTH = 32;

// Some forms (re-saved by certain editors) list stale copies of their fields
// in /AcroForm /Fields while the pages' /Annots hold DIFFERENT widget objects
// with the same names. Viewers draw the page annotations, so filling the
// stale copies prints nothing. When that happens, rebuild /Fields from what
// is actually on the pages: drop top-level fields with no widget on any
// page, add the roots of on-page widgets that /Fields does not reach.
// Returns how many entries were dropped + added + re-pointed (0 = consistent).
function repairFieldTree(doc) {
    const ctx = doc.context;
    let acro;
    try { acro = doc.catalog.lookup(PDFName.of('AcroForm')); } catch (_) { acro = null; }
    if (!(acro instanceof PDFDict)) return 0;

    const onPage = new Set();
    const pageWidgets = [];
    doc.getPages().forEach(page => {
        const annots = page.node.lookup(PDFName.of('Annots'));
        if (!(annots instanceof PDFArray)) return;
        for (let k = 0; k < annots.size(); k++) {
            const ref = annots.get(k);
            if (!(ref instanceof PDFRef)) continue;
            const d = ctx.lookup(ref);
            if (!(d instanceof PDFDict)) continue;
            const st = d.get(PDFName.of('Subtype'));
            if (!st || st.toString() !== '/Widget') continue;
            onPage.add(ref.toString());
            pageWidgets.push(ref);
        }
    });
    if (!pageWidgets.length) return 0;

    const rootOf = ref => {
        let cur = ref;
        for (let i = 0; i < MAX_TREE_DEPTH; i++) {
            const d = ctx.lookup(cur);
            const p = d instanceof PDFDict ? d.get(PDFName.of('Parent')) : null;
            if (!(p instanceof PDFRef)) return cur;
            cur = p;
        }
        return cur;
    };
    const reachesPage = (ref, depth) => {
        if (onPage.has(ref.toString())) return true;
        if (depth > MAX_TREE_DEPTH) return false;
        const d = ctx.lookup(ref);
        const kids = d instanceof PDFDict ? d.lookup(PDFName.of('Kids')) : null;
        if (!(kids instanceof PDFArray)) return false;
        for (let k = 0; k < kids.size(); k++) {
            const kr = kids.get(k);
            if (kr instanceof PDFRef && reachesPage(kr, depth + 1)) return true;
        }
        return false;
    };

    // A field whose /Kids still lists stale widget copies while the page
    // draws OTHER widgets that point back at it via /Parent: re-point /Kids
    // at what the page shows (otherwise checking the box changes nothing
    // visible and the field is reported on the wrong page).
    let kidsFixed = 0;
    const byParent = new Map();
    for (const w of pageWidgets) {
        const p = ctx.lookup(w).get(PDFName.of('Parent'));
        if (!(p instanceof PDFRef)) continue;
        if (!byParent.has(p.toString())) byParent.set(p.toString(), { ref: p, drawn: [] });
        byParent.get(p.toString()).drawn.push(w);
    }
    for (const { ref, drawn } of byParent.values()) {
        const pd = ctx.lookup(ref);
        if (!(pd instanceof PDFDict)) continue;
        const cur = pd.lookup(PDFName.of('Kids'));
        const curRefs = cur instanceof PDFArray ? cur.asArray().filter(r => r instanceof PDFRef) : [];
        const curSet = new Set(curRefs.map(String));
        const missing = drawn.filter(r => !curSet.has(r.toString()));
        if (!missing.length) continue;
        const keep = curRefs.filter(r => reachesPage(r, 0));
        pd.set(PDFName.of('Kids'), ctx.obj(keep.concat(missing)));
        kidsFixed += (curRefs.length - keep.length) + missing.length;
    }

    const fieldsArr = acro.lookup(PDFName.of('Fields'));
    const current = [];
    if (fieldsArr instanceof PDFArray) {
        for (let k = 0; k < fieldsArr.size(); k++) {
            const r = fieldsArr.get(k);
            if (r instanceof PDFRef) current.push(r);
        }
    }
    const kept = current.filter(r => reachesPage(r, 0));
    const have = new Set(kept.map(String));
    const added = [];
    for (const w of pageWidgets) {
        const root = rootOf(w);
        const key = root.toString();
        if (have.has(key)) continue;
        const d = ctx.lookup(root);
        if (!(d instanceof PDFDict) || !d.get(PDFName.of('T'))) continue;   // not a form field
        have.add(key);
        added.push(root);
    }
    const dropped = current.length - kept.length;
    if (!dropped && !added.length) return kidsFixed;
    acro.set(PDFName.of('Fields'), ctx.obj(kept.concat(added)));
    return dropped + added.length + kidsFixed;
}

// Page index for a widget: its /P entry when present, else whichever page
// lists it in /Annots (many generators omit /P).
function pageIndexMap(doc) {
    const map = new Map();
    doc.getPages().forEach((page, i) => {
        const annots = page.node.lookup(PDFName.of('Annots'));
        if (!annots || typeof annots.size !== 'function') return;
        for (let k = 0; k < annots.size(); k++) {
            const ref = annots.get(k);
            if (ref instanceof PDFRef) map.set(ref.toString(), i);
        }
    });
    return map;
}

function widgetPage(doc, widget, refMap, pageRefs) {
    try {
        const p = widget.P();
        if (p) {
            const i = pageRefs.indexOf(p.toString());
            if (i >= 0) return i;
        }
    } catch (_) { /* fall through */ }
    const ref = doc.context.getObjectRef(widget.dict);
    if (ref && refMap.has(ref.toString())) return refMap.get(ref.toString());
    return 0;
}

async function inspect(bytes) {
    const doc = await load(bytes);
    const pages = doc.getPages().map(p => {
        const out = { width: p.getWidth(), height: p.getHeight(), rotation: p.getRotation().angle || 0 };
        // The visible area (what a viewer or renderer shows) — Field Work
        // places boxes as fractions of it.
        try { const c = p.getCropBox(); out.crop = { x: c.x, y: c.y, width: c.width, height: c.height }; } catch (_) { /* media box */ }
        return out;
    });
    const pageRefs = doc.getPages().map(p => p.ref.toString());
    const refMap = pageIndexMap(doc);
    let raw = [];
    try { raw = doc.getForm().getFields(); } catch (_) { raw = []; }

    const all = raw.map((field, order) => {
        const type = typeOf(field);
        const widgets = field.acroField.getWidgets();
        // A radio button's choice: its /Opt export value when the form has
        // them (on-states are then just "0", "1"), else its on-state name.
        let exportValues = null;
        if (type === 'radio') { try { exportValues = field.acroField.getExportValues() || null; } catch (_) { exportValues = null; } }
        const boxes = widgets.map((w, wi) => {
            const r = w.getRectangle();
            const box = { page: widgetPage(doc, w, refMap, pageRefs), x: r.x, y: r.y, width: r.width, height: r.height };
            if (type === 'radio') {
                try {
                    if (exportValues && exportValues[wi]) box.option = exportValues[wi].decodeText();
                    else { const on = w.getOnValue(); if (on) box.option = on.decodeText(); }
                } catch (_) { /* no appearance */ }
            }
            return box;
        });
        const first = boxes[0] || { page: 0, x: 0, y: 0, width: 0, height: 0 };
        const out = {
            name: field.getName(),
            type,
            page: first.page,
            rect: [first.x, first.y, first.width, first.height],
            widgets: boxes,
            readOnly: field.isReadOnly(),
            required: field.isRequired(),
            order,
        };
        // The form author's own description of the box (/TU), when there is one.
        try {
            const tu = field.acroField.dict.lookup(PDFName.of('TU'));
            const t = tu && typeof tu.decodeText === 'function' ? tu.decodeText().replace(/\s+/g, ' ').trim() : '';
            if (t) out.tooltip = t.slice(0, 200);
        } catch (_) { /* none */ }
        if (type === 'text') {
            out.multiline = field.isMultiline();
            const max = field.getMaxLength();
            if (max) out.maxLength = max;
        }
        if (type === 'dropdown' || type === 'list' || type === 'radio') {
            try { out.options = field.getOptions(); } catch (_) { out.options = []; }
        }
        if (type === 'dropdown') { try { out.editable = field.isEditable(); } catch (_) { out.editable = false; } }
        // What the blank form already holds (a dropdown preset to "N/A", a
        // box printed checked) — the Forms tab starts from it.
        try {
            if (type === 'text') { const t = field.getText(); if (t) out.value = t; }
            else if (type === 'checkbox') { if (field.isChecked()) out.value = true; }
            else if (type === 'dropdown' || type === 'list') { const s = field.getSelected(); if (s && s.length && s[0]) out.value = s[0]; }
            else if (type === 'radio') { const s = field.getSelected(); if (s) out.value = s; }
        } catch (_) { /* unreadable value: treat as blank */ }
        return out;
    });

    // Two separate fields with one name behave as one value in every viewer:
    // list the name once, with all of its boxes.
    const byName = new Map();
    const fields = [];
    for (const f of all) {
        const prev = byName.get(f.name);
        if (prev) { prev.widgets = prev.widgets.concat(f.widgets); continue; }
        byName.set(f.name, f);
        fields.push(f);
    }

    return { pageCount: pages.length, pages, fields: readingOrder(fields), repaired: doc.__viperRepaired || 0 };
}

// Reading order: page, then rows top-down, then left to right. A box joins
// the row started by the box above it when their tops are within 4pt, or
// when they overlap vertically by half the smaller height and are of similar
// size (a checkbox beside a text box). A tall box never swallows the rows
// beside it.
function readingOrder(list) {
    const byPage = new Map();
    list.forEach(f => {
        if (!byPage.has(f.page)) byPage.set(f.page, []);
        byPage.get(f.page).push(f);
    });
    const out = [];
    [...byPage.keys()].sort((a, b) => a - b).forEach(p => {
        const items = byPage.get(p).slice().sort((a, b) =>
            ((b.rect[1] + b.rect[3]) - (a.rect[1] + a.rect[3])) || (a.rect[0] - b.rect[0]));
        const rows = [];
        let row = null;
        for (const f of items) {
            const top = f.rect[1] + f.rect[3], bottom = f.rect[1], h = Math.max(f.rect[3], 1);
            if (row) {
                const overlap = Math.min(top, row.top) - Math.max(bottom, row.bottom);
                const lo = Math.min(h, row.h), hi = Math.max(h, row.h);
                if (Math.abs(top - row.top) <= 4 || (overlap >= 0.5 * lo && hi <= 3 * lo)) {
                    row.items.push(f);
                    continue;
                }
            }
            row = { top, bottom, h, items: [f] };
            rows.push(row);
        }
        rows.forEach(r => {
            r.items.sort((a, b) => (a.rect[0] - b.rect[0]) || ((b.rect[1] + b.rect[3]) - (a.rect[1] + a.rect[3])));
            out.push(...r.items);
        });
    });
    return out;
}

// Keep only what Helvetica/WinAnsi can draw; report the rest.
function makeSanitizer(font) {
    const cache = new Map();
    return function sanitize(s) {
        let out = '', dropped = '';
        for (const ch of String(s)) {
            if (ch === '\n') { out += ch; continue; }
            if (ch === '\t') { out += ' '; continue; }
            if (ch === '\r') continue;
            let okCh = cache.get(ch);
            if (okCh === undefined) {
                try { font.encodeText(ch); okCh = true; } catch (_) { okCh = false; }
                cache.set(ch, okCh);
            }
            if (okCh) out += ch; else { out += '?'; dropped += ch; }
        }
        return { text: out, dropped };
    };
}

function truthy(v) {
    if (typeof v === 'boolean') return v;
    const s = String(v == null ? '' : v).trim().toLowerCase();
    return !!s && !['0', 'false', 'no', 'off', 'n'].includes(s);
}

const TF_RE = /\/([^\0\t\n\f\r ]+)[\0\t\n\f\r ]+(\d*\.\d+|\d+)[\0\t\n\f\r ]+Tf/g;
function daSize(da) {
    if (typeof da !== 'string') return undefined;
    let m, last = null;
    TF_RE.lastIndex = 0;
    while ((m = TF_RE.exec(da))) last = m;
    return last ? Number(last[2]) : undefined;
}

// For each box of an auto-size text field, work out the size pdf-lib would
// pick (same layout code) and, when it is above AUTO_FONT_MAX, pin the box to
// AUTO_FONT_MAX. Text that only fits smaller keeps its smaller size.
function capAutoSize(field, font) {
    if (field.isCombed()) return;
    const text = field.getText() || '';
    if (!text) return;
    let fieldDa;
    try { fieldDa = field.acroField.getDefaultAppearance(); } catch (_) { fieldDa = undefined; }
    for (const w of field.acroField.getWidgets()) {
        let widgetDa;
        try { widgetDa = w.getDefaultAppearance(); } catch (_) { widgetDa = undefined; }
        const ws = daSize(widgetDa), fs = daSize(fieldDa);
        const size = ws !== undefined ? ws : fs;
        if (size !== undefined && size !== 0) continue;           // fixed size: leave it
        const r = w.getRectangle();
        let rot = 0;
        try { const ap = w.getAppearanceCharacteristics(); rot = ap ? (((ap.getRotation() || 0) % 360) + 360) % 360 : 0; } catch (_) { rot = 0; }
        const sideways = rot === 90 || rot === 270;
        let bw = 0;
        try { const bs = w.getBorderStyle(); bw = bs ? bs.getWidth() || 0 : 0; } catch (_) { bw = 0; }
        const inset = bw + 1;
        const bounds = {
            x: inset, y: inset,
            width: (sideways ? r.height : r.width) - inset * 2,
            height: (sideways ? r.width : r.height) - inset * 2,
        };
        let fit;
        try {
            const opts = { alignment: field.getAlignment(), fontSize: undefined, font, bounds };
            fit = (field.isMultiline() ? layoutMultilineText(text, opts) : layoutSinglelineText(text, opts)).fontSize;
        } catch (_) { continue; }
        if (!(fit > AUTO_FONT_MAX)) continue;
        const base = widgetDa || fieldDa || '/Helv 0 Tf 0 g';
        const pinned = daSize(base) === undefined
            ? base + ' /Helv ' + AUTO_FONT_MAX + ' Tf'
            : base.replace(/(\d*\.\d+|\d+)([\0\t\n\f\r ]+Tf)(?![\s\S]*Tf)/, AUTO_FONT_MAX + '$2');
        w.setDefaultAppearance(pinned);
    }
}

// Write one value into one field. Returns true when the field took a value.
function setOne(field, v, sanitize, warn) {
    const type = typeOf(field);
    try {
        if (type === 'text') {
            let s = String(v == null ? '' : v);
            if (!field.isMultiline()) s = s.replace(/\s*\r?\n\s*/g, ' ');
            const { text, dropped } = sanitize(s);
            s = text;
            if (dropped) warn('chars', 'Characters the form font cannot print were replaced: ' + dropped);
            const max = field.getMaxLength();
            if (max && s.length > max) {
                warn('truncated', 'Cut to ' + max + ' characters');
                s = s.slice(0, max);
            }
            field.setText(s);
        } else if (type === 'checkbox') {
            if (truthy(v)) field.check(); else field.uncheck();
        } else if (type === 'dropdown' || type === 'list' || type === 'radio') {
            const s = String(v == null ? '' : v);
            const opts2 = field.getOptions();
            const hit = opts2.find(x => x === s) || opts2.find(x => x.toLowerCase() === s.toLowerCase());
            if (hit) field.select(hit);
            else if (type === 'dropdown' && field.isEditable() && s) field.select(sanitize(s).text);
            else if (s) { warn('option', '"' + s + '" is not one of the choices'); return false; }
            else if (type !== 'radio') field.clear();
        } else {
            warn('type', 'A ' + type + ' field cannot be filled');
            return false;
        }
        return true;
    } catch (err) {
        warn('error', String(err && err.message || err));
        return false;
    }
}

/**
 * values: { [fieldName]: string | boolean }
 * opts:   { flatten?: boolean }
 */
async function fill(bytes, values, opts) {
    const o = opts || {};
    const doc = await load(bytes);
    const form = doc.getForm();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const sanitize = makeSanitizer(font);
    const warnings = [];
    const filled = [];

    const byName = new Map();
    for (const f of form.getFields()) {
        const n = f.getName();
        if (!byName.has(n)) byName.set(n, []);
        byName.get(n).push(f);
    }

    Object.keys(values || {}).forEach(name => {
        const v = values[name];
        const targets = byName.get(name);
        if (!targets) { warnings.push({ field: name, code: 'missing', message: 'Field not on this form' }); return; }
        const seen = new Set();
        const warn = (code, message) => {
            if (seen.has(code)) return;
            seen.add(code);
            warnings.push({ field: name, code, message });
        };
        let any = false;
        for (const field of targets) if (setOne(field, v, sanitize, warn)) {
            any = true;
            if (field instanceof PDFTextField) {
                try { capAutoSize(field, font); } catch (_) { /* keep pdf-lib's own sizing */ }
            }
        }
        if (any) filled.push(name);
    });

    try { form.updateFieldAppearances(font); } catch (err) {
        warnings.push({ field: '', code: 'appearance', message: String(err && err.message || err) });
    }
    if (o.flatten) {
        // pdf-lib's flatten() throws ("Unexpected N type") on the first widget
        // without a normal appearance — typically an empty signature box — and
        // leaves every later field live. Such widgets draw nothing, so drop
        // those fields first; the rest flatten normally.
        for (const field of form.getFields()) {
            let blank = false;
            try {
                blank = field.acroField.getWidgets().some(w => {
                    try { w.getNormalAppearance(); return false; } catch (_) { return true; }
                });
            } catch (_) { blank = false; }
            if (!blank) continue;
            // form.removeField() trips over the same missing appearance, so unhook by hand:
            // widget refs off every page's /Annots, field out of /Fields (or its parent's /Kids).
            try {
                const af = field.acroField;
                for (const w of af.getWidgets()) {
                    const ref = doc.context.getObjectRef(w.dict);
                    if (!ref) continue;
                    for (const page of doc.getPages()) {
                        const annots = page.node.lookup(PDFName.of('Annots'));
                        if (!(annots instanceof PDFArray)) continue;
                        const i = annots.indexOf(ref);
                        if (i !== undefined && i >= 0) annots.remove(i);
                    }
                }
                form.acroForm.removeField(af);
            } catch (err) {
                warnings.push({ field: field.getName(), code: 'flatten', message: String(err && err.message || err) });
            }
        }
        try { form.flatten(); } catch (err) {
            warnings.push({ field: '', code: 'flatten', message: String(err && err.message || err) });
        }
    }
    const out = await doc.save();
    return { bytes: Buffer.from(out), filled, warnings, repaired: doc.__viperRepaired || 0 };
}

module.exports = { inspect, fill, typeOf, MAX_PDF_BYTES };

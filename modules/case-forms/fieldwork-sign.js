'use strict';
/**
 * modules/case-forms/fieldwork-sign.js — agency forms completed and signed on
 * a phone through Field Work (main process).
 *
 *   send:    fill the agency form from the case → render each page to a JPEG
 *            WITHOUT its form boxes → describe every box as fractions of the
 *            page → encrypt (the Field Work form's own AES-256-GCM key) →
 *            POST to the relay → keep the exact pre-filled PDF in the case
 *            (Forms/.fieldwork/, under Field Security) with its SHA-256.
 *   phone:   draws the page, the boxes and their values; the person fills the
 *            blanks and signs with a finger; the result goes back encrypted.
 *   collect: fetch + decrypt the result → check every value and signature
 *            against the form it was sent → fill those values into the kept
 *            PDF, flatten, stamp each signature in its box, append a signing
 *            record page → save "<Title> - <who> - signed - <date>.pdf" in
 *            the case's Forms folder.
 *
 * The relay only ever holds ciphertext; the key lives in this case and in the
 * fragment of the link on the phone. Wire contract: blob = 12-byte IV ‖
 * AES-256-GCM ciphertext ‖ 16-byte tag, plaintext UTF-8 JSON.
 *
 * Everything with side effects is injected so the module runs under plain node
 * for tests.
 */
const crypto = require('crypto');
const nodePath = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const LIMITS = Object.freeze({
    maxDocs: 8,
    docMaxBytes: 12 * 1024 * 1024,
    resultMaxBytes: 8 * 1024 * 1024,
    maxSignatures: 24,
    maxPngBytes: 600 * 1024,
    maxPngWidth: 2000,          // the phone sends <= 1000; leave room for a different phone build
    maxPngHeight: 2000,
    maxString: 4000,
    maxSigner: 40,
    maxUserAgent: 300,
});
const DEFAULT_SIGNERS = Object.freeze(['Subject', 'Officer', 'Witness', 'Parent / Guardian', 'Interpreter']);
const DOC_ID_RE = /^[A-Za-z0-9_-]{16,40}$/;
const RELAY_FORM_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const KEPT_SUBDIR = nodePath.join('Forms', '.fieldwork');
const FORMS_SUBDIR = 'Forms';
const PHONE_TYPES = new Set(['text', 'checkbox', 'radio', 'dropdown', 'list', 'signature']);

class SignError extends Error {}
const fail = (msg, status) => { const e = new SignError(msg); if (status) e.statusCode = status; throw e; };
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const round = (n) => Math.round(n * 100000) / 100000;
const clamp01 = (n) => Math.min(1, Math.max(0, n));

/* ── Crypto ─────────────────────────────────────────────────────────── */

function keyFrom(mediaKey) {
    let k = null;
    try { k = Buffer.from(String(mediaKey || ''), 'base64url'); } catch (_) { k = null; }
    if (!k || k.length !== 32) fail('This Field Work form has no usable key — create a new form to send agency forms.');
    return k;
}

function seal(key, plain) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([iv, body, c.getAuthTag()]);
}

function open(key, blob) {
    if (!Buffer.isBuffer(blob) || blob.length < 12 + 16 + 1) fail('The signed form came back empty or truncated.');
    try {
        const d = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
        d.setAuthTag(blob.subarray(blob.length - 16));
        return Buffer.concat([d.update(blob.subarray(12, blob.length - 16)), d.final()]);
    } catch (_) {
        // GCM authenticates: altered in transit, or not this form's key.
        fail('The signed form failed its integrity check and was not saved.');
    }
}

/* ── Geometry ───────────────────────────────────────────────────────── */

const cropOf = (page) => page.crop || { x: 0, y: 0, width: page.width, height: page.height };

/** PDF rectangle (bottom-left origin, points) → fractions of the visible page, top-left origin. */
function toFrac(rect, crop) {
    const x0 = clamp01((rect.x - crop.x) / crop.width);
    const x1 = clamp01((rect.x + rect.width - crop.x) / crop.width);
    const top = clamp01((crop.y + crop.height - (rect.y + rect.height)) / crop.height);
    const bottom = clamp01((crop.y + crop.height - rect.y) / crop.height);
    return { x: round(x0), y: round(top), w: round(x1 - x0), h: round(bottom - top) };
}

/** Fractions (top-left origin) → PDF rectangle in points (bottom-left origin). */
function fromFrac(box, crop) {
    const width = box.w * crop.width, height = box.h * crop.height;
    return { x: crop.x + box.x * crop.width, y: crop.y + crop.height - (box.y * crop.height) - height, width, height };
}

/* ── Describing a form for the phone ───────────────────────────────── */

/** "Suspect.LastName[0]" → "Last Name". The form author's tooltip wins when there is one. */
function labelFor(f) {
    if (f.tooltip) return f.tooltip.slice(0, 120);
    let s = String(f.name || '');
    s = s.split('.').filter(Boolean).pop() || s;
    s = s.replace(/\[\d+\]$/, '').replace(/[_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
    return (s || String(f.name || 'Field')).slice(0, 120);
}

/**
 * pdf-form inspect() output → the packet's field list. Rotated pages are
 * refused: boxes would land in the wrong place on the phone.
 */
function describeFields(info) {
    const pages = info.pages || [];
    pages.forEach((p, i) => {
        if (p.rotation && p.rotation % 360 !== 0) fail(`Page ${i + 1} of this form is rotated, so it cannot be completed on a phone yet. Fill and print it instead.`);
    });
    const out = [];
    for (const f of info.fields || []) {
        if (!PHONE_TYPES.has(f.type)) continue;
        const boxes = (f.widgets || []).filter(w => Number.isInteger(w.page) && w.page >= 0 && w.page < pages.length && w.width > 0 && w.height > 0)
            .map(w => {
                const b = Object.assign({ page: w.page }, toFrac(w, cropOf(pages[w.page])));
                if (f.type === 'radio' && w.option != null) b.option = String(w.option);
                return b;
            })
            .filter(b => b.w > 0 && b.h > 0);
        if (!boxes.length) continue;
        const d = { name: f.name, type: f.type, label: labelFor(f), boxes };
        if (f.type !== 'signature') {
            d.value = f.type === 'checkbox' ? f.value === true : (f.value == null ? '' : String(f.value));
            d.readOnly = !!f.readOnly;
        }
        if (f.type === 'text') { d.multiline = !!f.multiline; d.maxLength = f.maxLength || 0; }
        if (f.type === 'radio' || f.type === 'dropdown' || f.type === 'list') d.options = Array.isArray(f.options) ? f.options.map(String) : [];
        if (f.type === 'dropdown') d.editable = !!f.editable;
        out.push(d);
    }
    return out;
}

const RENDER_STEPS = [
    { scale: 2, maxPx: 1400, quality: 72 },
    { scale: 1.6, maxPx: 1100, quality: 60 },
    { scale: 1.25, maxPx: 900, quality: 50 },
];

/**
 * opts: { pdfBytes, pdfForm, render(bytes, step) → [{ jpeg, w, h }], title, who, lang, signers, maxBytes }
 * → { packet, json (Buffer), fields, pageCount }
 */
async function buildPacket(opts) {
    const info = await opts.pdfForm.inspect(opts.pdfBytes);
    const fields = describeFields(info);
    const maxBytes = (opts.maxBytes || LIMITS.docMaxBytes) - 28;
    for (const step of RENDER_STEPS) {
        const pages = await opts.render(opts.pdfBytes, step);
        if (!Array.isArray(pages) || pages.length !== info.pageCount) fail('The form could not be drawn for the phone.');
        const packet = {
            v: 1, kind: 'viper-form',
            title: String(opts.title || 'Form').slice(0, 200),
            who: String(opts.who || '').slice(0, 120),
            lang: String(opts.lang || 'en').slice(0, 10),
            pages: pages.map(p => ({ img: 'data:image/jpeg;base64,' + Buffer.from(p.jpeg).toString('base64'), w: p.w, h: p.h })),
            fields,
            signers: (Array.isArray(opts.signers) && opts.signers.length ? opts.signers : DEFAULT_SIGNERS).slice(0, 12).map(s => String(s).slice(0, LIMITS.maxSigner)),
        };
        const json = Buffer.from(JSON.stringify(packet), 'utf8');
        if (json.length <= maxBytes) return { packet, json, fields, pageCount: info.pageCount };
    }
    fail('This form is too large to send to a phone.');
}

/** mupdf page renderer: the page as it prints, minus every annotation and form box. */
function makeMupdfRenderer(getMupdf) {
    return async (bytes, step) => {
        const mupdf = await getMupdf();
        const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
        const out = [];
        try {
            const n = doc.countPages();
            for (let i = 0; i < n; i++) {
                const page = doc.loadPage(i);
                try {
                    const b = page.getBounds();
                    const w = Math.max(1, b[2] - b[0]);
                    const s = Math.min(step.scale, step.maxPx / w);
                    const pix = page.toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceRGB, false, false);
                    try { out.push({ jpeg: Buffer.from(pix.asJPEG(step.quality)), w: pix.getWidth(), h: pix.getHeight() }); }
                    finally { try { pix.destroy(); } catch (_) { /* ignore */ } }
                } finally { try { page.destroy(); } catch (_) { /* ignore */ } }
            }
        } finally { try { doc.destroy(); } catch (_) { /* ignore */ } }
        return out;
    };
}

/* ── Checking what the phone sent back ─────────────────────────────── */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngFrom(dataUrl, i) {
    const m = typeof dataUrl === 'string' && /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
    if (!m) fail(`Signature ${i + 1} is not a PNG image.`);
    const buf = Buffer.from(m[1], 'base64');
    if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_MAGIC) || buf.toString('latin1', 12, 16) !== 'IHDR') fail(`Signature ${i + 1} is not a PNG image.`);
    if (buf.length > LIMITS.maxPngBytes) fail(`Signature ${i + 1} is too large.`);
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    if (!w || !h || w > LIMITS.maxPngWidth || h > LIMITS.maxPngHeight) fail(`Signature ${i + 1} has an impossible size.`);
    return buf;
}

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const isoOr = (v) => (typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : '');

/**
 * Accept only what the sent form allows: its own field names, the right type
 * of value, a listed choice, a signature in a box that is on a real page.
 * → { values, signatures: [{ field, page, x, y, w, h, png (Buffer), signer, initials, signedAt }],
 *     startedAt, completedAt, userAgent, ignored }
 */
function validateResult(result, fields, pageCount) {
    if (!isPlainObject(result) || result.v !== 1 || result.kind !== 'viper-form-result') fail('The phone sent something that is not a completed form.');
    const byName = new Map(fields.map(f => [f.name, f]));
    const values = {};
    let ignored = 0;
    const rv = result.values == null ? {} : result.values;
    if (!isPlainObject(rv)) fail('The completed form values could not be read.');
    for (const name of Object.keys(rv)) {
        const f = byName.get(name);
        if (!f || f.type === 'signature' || f.readOnly) { ignored++; continue; }
        const v = rv[name];
        if (v == null) continue;
        const what = `"${f.label}"`;
        if (f.type === 'checkbox') {
            if (typeof v !== 'boolean') fail(`The value for ${what} must be checked or unchecked.`);
            values[name] = v;
            continue;
        }
        if (typeof v !== 'string') fail(`The value for ${what} must be text.`);
        if (v.length > LIMITS.maxString) fail(`The value for ${what} is too long.`);
        if (f.type === 'text') { values[name] = f.maxLength ? v.slice(0, f.maxLength) : v; continue; }
        if (v !== '' && !(f.options || []).includes(v) && !(f.type === 'dropdown' && f.editable)) fail(`${what} has a choice that is not on the form.`);
        values[name] = v;
    }

    const sigsIn = result.signatures == null ? [] : result.signatures;
    if (!Array.isArray(sigsIn)) fail('The signatures could not be read.');
    if (sigsIn.length > LIMITS.maxSignatures) fail(`Too many signatures (limit ${LIMITS.maxSignatures}).`);
    const signatures = sigsIn.map((s, i) => {
        if (!isPlainObject(s)) fail(`Signature ${i + 1} could not be read.`);
        let field = null;
        if (s.field != null) {
            const f = byName.get(s.field);
            if (!f || f.type !== 'signature') fail(`Signature ${i + 1} names a signature box that is not on the form.`);
            field = f.name;
        }
        if (!Number.isInteger(s.page) || s.page < 0 || s.page >= pageCount) fail(`Signature ${i + 1} is on a page the form does not have.`);
        if (![s.x, s.y, s.w, s.h].every(num) || s.x < 0 || s.y < 0 || s.w <= 0 || s.h <= 0
            || s.x + s.w > 1.001 || s.y + s.h > 1.001) fail(`Signature ${i + 1} is outside the page.`);
        const signer = typeof s.signer === 'string' ? s.signer.replace(/\s+/g, ' ').trim() : '';
        if (!signer || signer.length > LIMITS.maxSigner) fail(`Signature ${i + 1} does not say who signed.`);
        return {
            field, page: s.page,
            x: s.x, y: s.y, w: Math.min(s.w, 1 - s.x), h: Math.min(s.h, 1 - s.y),
            png: pngFrom(s.png, i), signer, initials: s.initials === true, signedAt: isoOr(s.signedAt),
        };
    });

    return {
        values, signatures, ignored,
        startedAt: isoOr(result.startedAt), completedAt: isoOr(result.completedAt),
        userAgent: typeof result.userAgent === 'string' ? result.userAgent.slice(0, LIMITS.maxUserAgent) : '',
    };
}

/* ── Building the signed PDF ───────────────────────────────────────── */

// Helvetica speaks WinAnsi; anything else becomes '?' instead of throwing.
const ansi = (s) => String(s == null ? '' : s)
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[\u2013\u2014]/g, '-').replace(/\u2026/g, '...')
    .replace(/[\r\n\t]+/g, ' ').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');

function wrapText(text, font, size, maxWidth) {
    const words = ansi(text).split(' ');
    const lines = [];
    let line = '';
    for (const w of words) {
        const next = line ? line + ' ' + w : w;
        if (font.widthOfTextAtSize(next, size) <= maxWidth) { line = next; continue; }
        if (line) lines.push(line);
        // A single word wider than the line (a hash, a user agent): hard break.
        let rest = w;
        while (font.widthOfTextAtSize(rest, size) > maxWidth && rest.length > 1) {
            let n = rest.length;
            while (n > 1 && font.widthOfTextAtSize(rest.slice(0, n), size) > maxWidth) n--;
            lines.push(rest.slice(0, n));
            rest = rest.slice(n);
        }
        line = rest;
    }
    if (line) lines.push(line);
    return lines.length ? lines : [''];
}

const fmtTime = (iso) => (iso ? iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z').replace(/Z$/, ' UTC') : 'not recorded');
const sameValue = (a, b) => (typeof a === 'boolean' || typeof b === 'boolean') ? !!a === !!b : String(a == null ? '' : a) === String(b == null ? '' : b);

/** Which boxes the phone filled in or changed, as their labels. */
function changedFields(fields, values) {
    return fields.filter(f => f.type !== 'signature' && !f.readOnly && Object.prototype.hasOwnProperty.call(values, f.name) && !sameValue(values[f.name], f.value))
        .map(f => f.label);
}

/**
 * opts: { pdfBytes (the kept pre-filled PDF), pdfForm, fields, pageCount, result (validated),
 *         meta: { title, who, setName, setVersion, caseNumber, relayFormId, docId, sentAt, sentSha256, resultSha256 },
 *         now: Date }
 * → { bytes, changed: [labels], signatures: n, warnings }
 */
async function applyResult(opts) {
    const r = opts.result, meta = opts.meta || {};
    const changed = changedFields(opts.fields, r.values);
    const filled = await opts.pdfForm.fill(opts.pdfBytes, r.values, { flatten: true });
    const doc = await PDFDocument.load(filled.bytes, { updateMetadata: false });
    const pages = doc.getPages();
    if (pages.length !== opts.pageCount) fail('The kept copy of the form no longer matches what was sent.');

    for (const s of r.signatures) {
        const page = pages[s.page];
        const c = page.getCropBox();
        const box = fromFrac(s, { x: c.x, y: c.y, width: c.width, height: c.height });
        const img = await doc.embedPng(s.png);
        const k = Math.min(box.width / img.width, box.height / img.height);
        const w = img.width * k, h = img.height * k;
        // Centred across the box, sitting on its bottom edge (the signature line).
        page.drawImage(img, { x: box.x + (box.width - w) / 2, y: box.y, width: w, height: h });
    }

    // The signing record.
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const W = 612, H = 792, M = 54, size = 10, lead = 14;
    let page = doc.addPage([W, H]);
    let y = H - M;
    const need = (n) => { if (y - n * lead < M) { page = doc.addPage([W, H]); y = H - M; } };
    const line = (text, f, sz) => {
        for (const l of wrapText(text, f || font, sz || size, W - 2 * M)) {
            need(1);
            page.drawText(l, { x: M, y, size: sz || size, font: f || font, color: rgb(0.1, 0.1, 0.1) });
            y -= sz && sz > size ? lead + 6 : lead;
        }
    };
    const gap = () => { y -= lead / 2; };

    line('Field Work signing record', bold, 16);
    line('This page was added by VIPER. It records how the form above was completed and signed on a phone.');
    gap();
    line('Form: ' + (meta.title || 'Form'));
    if (meta.setName) line('Agency form set: ' + meta.setName + (meta.setVersion ? ' (version ' + meta.setVersion + ')' : ''));
    if (meta.caseNumber) line('Case: ' + meta.caseNumber);
    if (meta.who) line('Person: ' + meta.who);
    gap();
    line('Sent to the phone: ' + fmtTime(meta.sentAt));
    line('Opened on the phone: ' + fmtTime(r.startedAt));
    line('Completed on the phone: ' + fmtTime(r.completedAt));
    line('Received in VIPER: ' + fmtTime((opts.now || new Date()).toISOString()));
    if (r.userAgent) line('Phone browser: ' + r.userAgent);
    gap();
    line('Signatures (' + r.signatures.length + ')', bold);
    if (!r.signatures.length) line('None.');
    const byName = new Map(opts.fields.map(f => [f.name, f]));
    r.signatures.forEach((s, i) => {
        const where = s.field ? 'in "' + ((byName.get(s.field) || {}).label || s.field) + '"' : 'placed on the page';
        line(`${i + 1}. ${s.signer} - ${s.initials ? 'initials' : 'signature'} ${where}, page ${s.page + 1} - signed ${fmtTime(s.signedAt)}`);
    });
    gap();
    line('Filled in or changed on the phone (' + changed.length + ')', bold);
    line(changed.length ? changed.join('; ') : 'Nothing - every value is as VIPER filled it from the case.');
    gap();
    line('Integrity', bold);
    if (meta.relayFormId) line('Field Work form: ' + meta.relayFormId + (meta.docId ? '  document: ' + meta.docId : ''));
    if (meta.sentSha256) line('SHA-256 of the pre-filled form sent to the phone: ' + meta.sentSha256);
    if (meta.resultSha256) line('SHA-256 of the completed form returned by the phone: ' + meta.resultSha256);
    line('The form and the completed result were encrypted end-to-end (AES-256-GCM) with a key held only by this case and the phone link. The relay server stored data it could not read.');

    const out = Buffer.from(await doc.save());
    return { bytes: out, changed, signatures: r.signatures.length, warnings: filled.warnings || [] };
}

/* ── Relay client ──────────────────────────────────────────────────── */

/** deps: { fetch, base: string | () => string, timeoutMs } */
function createRelayClient(deps) {
    const base = () => (typeof deps.base === 'function' ? deps.base() : deps.base);
    async function call(apiKey, method, path, body, timeoutMs) {
        if (!apiKey) fail('Not registered — activate your VIPER license first');
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs || deps.timeoutMs || 120000);
        let resp;
        try {
            const headers = { 'X-API-Key': apiKey };
            if (body) headers['Content-Type'] = 'application/octet-stream';
            resp = await deps.fetch(new URL(path, base()).toString(), { method, headers, body, signal: ctrl.signal });
        } catch (e) {
            fail(e && e.name === 'AbortError' ? 'The relay did not answer in time.' : 'Could not reach the relay: ' + (e && e.message || e));
        } finally { clearTimeout(t); }
        if (!resp.ok) {
            let detail = '';
            try { const j = await resp.json(); detail = j && typeof j.detail === 'string' ? j.detail : ''; } catch (_) { /* not JSON */ }
            fail(detail || `Server error ${resp.status}`, resp.status);
        }
        return resp;
    }
    const enc = encodeURIComponent;
    return {
        async postDoc(apiKey, formId, blob) {
            const resp = await call(apiKey, 'POST', `/api/fieldwork/${enc(formId)}/docs`, blob);
            return resp.json();
        },
        /** The result ciphertext, or null while the phone has not sent one. */
        async getResult(apiKey, formId, docId) {
            try {
                const resp = await call(apiKey, 'GET', `/api/fieldwork/${enc(formId)}/docs/${enc(docId)}/result`);
                const buf = Buffer.from(await resp.arrayBuffer());
                if (buf.length > LIMITS.resultMaxBytes + 64) fail('The signed form is larger than the relay allows.');
                return buf;
            } catch (e) {
                if (e && e.statusCode === 404 && /no result/i.test(e.message)) return null;
                throw e;
            }
        },
        async deleteDoc(apiKey, formId, docId) {
            const resp = await call(apiKey, 'DELETE', `/api/fieldwork/${enc(formId)}/docs/${enc(docId)}`, undefined, 30000);
            return resp.json();
        },
    };
}

/* ── IPC ───────────────────────────────────────────────────────────── */

function safeCaseNumber(s) {
    if (typeof s !== 'string') return null;
    const v = s.trim();
    if (!v || v.length > 200 || v.includes('..') || /[\\/\x00-\x1f]/.test(v)) return null;
    return v;
}

const keptName = (relayFormId, docId) => `${relayFormId}_${docId}.pdf`;

/**
 * deps: {
 *   store (form-store), pdfForm, checkValues, outputFileName,
 *   relay: { postDoc, getResult, deleteDoc },
 *   render(bytes, step),
 *   writeCaseFile(caseNumber, subdir, name, bytes) → { fileName },
 *   readCaseFile(caseNumber, subdir, name) → Buffer (decrypted),
 *   locked() → bool, audit(event, data), now()
 * }
 */
function registerFieldWorkSignIpc(ipcMain, deps) {
    const wrap = (fn) => async (...args) => {
        try { return Object.assign({ success: true }, await fn(...args)); } catch (e) {
            const out = { success: false, error: e instanceof SignError ? e.message : ('Field Work forms error: ' + (e && e.message || e)) };
            if (e && e.statusCode) out.status = e.statusCode;
            return out;
        }
    };
    const audit = (ev, data) => { try { if (deps.audit) deps.audit(ev, data); } catch (_) { /* never block */ } };
    const now = () => new Date(deps.now ? deps.now() : Date.now());
    const req = (r) => (isPlainObject(r) ? r : {});
    const common = (r) => {
        const caseNumber = safeCaseNumber(r.caseNumber);
        if (!caseNumber) fail('Open a case first');
        if (deps.locked && deps.locked()) fail('Unlock Field Security first — forms sent to the phone are kept encrypted with the case');
        if (typeof r.relayFormId !== 'string' || !RELAY_FORM_ID_RE.test(r.relayFormId)) fail('Unknown Field Work form');
        return { caseNumber, key: keyFrom(r.mediaKey) };
    };

    /*
     * r: { apiKey, relayFormId, mediaKey, caseNumber, setId, formId, values, who, lang, title }
     */
    ipcMain.handle('fieldwork-sign-send', wrap(async (_e, r) => {
        r = req(r);
        const { caseNumber, key } = common(r);
        const values = deps.checkValues(r.values);
        const manifest = deps.store.load(String(r.setId || ''));
        const { form } = deps.store.getForm(manifest.id, r.formId, manifest);
        const filled = await deps.pdfForm.fill(deps.store.readPdf(manifest.id, form.id, manifest), values, { flatten: false });
        const title = (typeof r.title === 'string' && r.title.trim()) || form.title;
        const who = typeof r.who === 'string' ? r.who.trim().slice(0, 120) : '';
        const built = await buildPacket({
            pdfBytes: filled.bytes, pdfForm: deps.pdfForm, render: deps.render,
            title, who, lang: r.lang || form.language || 'en',
        });
        const blob = seal(key, built.json);
        const posted = await deps.relay.postDoc(r.apiKey, r.relayFormId, blob);
        const docId = posted && typeof posted.doc_id === 'string' ? posted.doc_id : '';
        if (!DOC_ID_RE.test(docId)) fail('The relay did not accept the form.');
        let kept;
        try {
            kept = deps.writeCaseFile(caseNumber, KEPT_SUBDIR, keptName(r.relayFormId, docId), filled.bytes);
        } catch (e) {
            // Without the kept copy the signatures could never be put on the form.
            try { await deps.relay.deleteDoc(r.apiKey, r.relayFormId, docId); } catch (_) { /* expires anyway */ }
            throw e;
        }
        const sentAt = now().toISOString();
        const sha = sha256(filled.bytes);
        audit('CASE_FORM_SENT_TO_PHONE', {
            case_number: caseNumber, set_id: manifest.id, version: manifest.version, form_id: form.id,
            relay_form_id: r.relayFormId, doc_id: docId, sha256: sha, pages: built.pageCount, fields: built.fields.length,
        });
        return {
            docId, position: posted.position, keptFile: kept.fileName, sha256: sha, sentAt,
            title, who, setId: manifest.id, setName: manifest.name, setVersion: manifest.version, formId: form.id,
            pageCount: built.pageCount, fieldCount: built.fields.length, bytes: blob.length,
        };
    }));

    /*
     * r: { apiKey, relayFormId, mediaKey, caseNumber, docId, keptFile, sha256, title, who, setName, setVersion, sentAt, keepOnRelay }
     * → { pending: true } | { fileName, signatures, changed, purged }
     */
    ipcMain.handle('fieldwork-sign-collect', wrap(async (_e, r) => {
        r = req(r);
        const { caseNumber, key } = common(r);
        if (typeof r.docId !== 'string' || !DOC_ID_RE.test(r.docId)) fail('Unknown form on the phone');
        const keptFile = typeof r.keptFile === 'string' && r.keptFile ? r.keptFile : keptName(r.relayFormId, r.docId);
        if (keptFile !== nodePath.basename(keptFile) || !/\.pdf$/i.test(keptFile)) fail('Unknown form on the phone');

        const blob = await deps.relay.getResult(r.apiKey, r.relayFormId, r.docId);
        if (!blob) return { pending: true };
        const plain = open(key, blob);
        let result;
        try { result = JSON.parse(plain.toString('utf8')); } catch (_) { fail('The signed form could not be read.'); }

        let pdfBytes;
        try { pdfBytes = deps.readCaseFile(caseNumber, KEPT_SUBDIR, keptFile); } catch (e) {
            fail('The copy of this form kept in the case is missing, so the signatures cannot be placed on it.');
        }
        const sentSha = sha256(pdfBytes);
        if (r.sha256 && r.sha256 !== sentSha) fail('The copy of this form kept in the case has changed since it was sent; the signatures were not placed on it.');
        const info = await deps.pdfForm.inspect(pdfBytes);
        const fields = describeFields(info);
        const checked = validateResult(result, fields, info.pageCount);
        const stamp = now();
        const title = String(r.title || 'Form').slice(0, 200);
        const who = String(r.who || '').slice(0, 120);
        const out = await applyResult({
            pdfBytes, pdfForm: deps.pdfForm, fields, pageCount: info.pageCount, result: checked, now: stamp,
            meta: {
                title, who, setName: r.setName || '', setVersion: r.setVersion || '', caseNumber,
                relayFormId: r.relayFormId, docId: r.docId, sentAt: isoOr(r.sentAt), sentSha256: sentSha, resultSha256: sha256(plain),
            },
        });
        const name = deps.outputFileName(title, (who ? who + ' - ' : '') + 'signed', stamp);
        const saved = deps.writeCaseFile(caseNumber, FORMS_SUBDIR, name, out.bytes);
        audit('CASE_FORM_SIGNED_ON_PHONE', {
            case_number: caseNumber, relay_form_id: r.relayFormId, doc_id: r.docId, file: saved.fileName,
            signatures: out.signatures, changed: out.changed.length, sha256: sha256(out.bytes),
        });
        let purged = false;
        if (!r.keepOnRelay) {
            try { await deps.relay.deleteDoc(r.apiKey, r.relayFormId, r.docId); purged = true; } catch (_) { /* expires with the form */ }
        }
        return { fileName: saved.fileName, signatures: out.signatures, changed: out.changed, purged };
    }));
}

module.exports = {
    LIMITS, DEFAULT_SIGNERS, DOC_ID_RE, KEPT_SUBDIR, SignError,
    keyFrom, seal, open, toFrac, fromFrac, labelFor, describeFields, buildPacket, makeMupdfRenderer,
    validateResult, changedFields, applyResult, createRelayClient, registerFieldWorkSignIpc, wrapText, ansi,
};

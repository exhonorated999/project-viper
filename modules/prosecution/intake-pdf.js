/**
 * modules/prosecution/intake-pdf.js — prints the Intake / Discovery Checklist
 * (main process; pdf-lib) and the IPC that saves it.
 *
 *   buildIntakePdf(checklist, { now }) → Promise<Buffer>
 *   registerIntakeIpc(ipcMain, deps)
 *     deps: { caseForms (form-store createCaseForms), outputFileName, safeCaseNumber,
 *             dialog, getWindow, restoreFocus, defaultDir, writeFile, audit(ev, data) }
 *
 * The PDF is drawn from scratch (Letter, Helvetica): nothing from any agency's
 * own paper form is used.
 */
'use strict';

const nodePath = require('path');
const IC = require('./intake-checklist.js');

const PAGE_W = 612, PAGE_H = 792, M = 40, FOOT = 34;
const CONTENT_W = PAGE_W - 2 * M;
const GUTTER = 16;
const COL_W = (CONTENT_W - GUTTER) / 2;
const STATUS_W = 64;

// Helvetica (WinAnsi) cannot draw everything; keep Latin-1 and swap the usual
// typographic characters for plain ones.
const SWAP = { '\u2018': "'", '\u2019': "'", '\u201a': "'", '\u201c': '"', '\u201d': '"', '\u201e': '"',
    '\u2013': '-', '\u2014': '-', '\u2212': '-', '\u2026': '...', '\u2022': '-', '\u2192': '->', '\u00a0': ' ', '\t': ' ' };
function pdfText(s) {
    let out = '';
    for (const ch of String(s == null ? '' : s)) {
        if (SWAP[ch] !== undefined) { out += SWAP[ch]; continue; }
        const c = ch.codePointAt(0);
        if (ch === '\n' || (c >= 0x20 && c <= 0x7e) || (c >= 0xa1 && c <= 0xff)) { out += ch; continue; }
        const base = ch.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
        out += /^[\x20-\x7e]+$/.test(base) ? base : '?';
    }
    return out;
}

function wrap(text, font, size, width) {
    const lines = [];
    for (const para of pdfText(text).split('\n')) {
        const words = para.split(/ +/).filter(Boolean);
        if (!words.length) { lines.push(''); continue; }
        let line = '';
        for (let w of words) {
            // A single word wider than the line gets cut into pieces.
            while (font.widthOfTextAtSize(w, size) > width) {
                let n = w.length - 1;
                while (n > 1 && font.widthOfTextAtSize(w.slice(0, n), size) > width) n--;
                if (line) { lines.push(line); line = ''; }
                lines.push(w.slice(0, n));
                w = w.slice(n);
            }
            const cand = line ? line + ' ' + w : w;
            if (font.widthOfTextAtSize(cand, size) <= width) line = cand;
            else { lines.push(line); line = w; }
        }
        lines.push(line);
    }
    return lines;
}

function ymd(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function buildIntakePdf(checklist, opts) {
    const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
    const now = (opts && opts.now instanceof Date) ? opts.now : new Date();
    const cl = IC.normalize(checklist, now);
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const ital = await doc.embedFont(StandardFonts.HelveticaOblique);
    const BLACK = rgb(0, 0, 0), GRAY = rgb(0.4, 0.4, 0.4), LIGHT = rgb(0.88, 0.88, 0.88), RULE = rgb(0.6, 0.6, 0.6);
    const RED = rgb(0.6, 0.1, 0.1);

    doc.setTitle(IC.TITLE);
    doc.setSubject('Intake / discovery checklist');
    doc.setCreator('V.I.P.E.R.');
    doc.setProducer('V.I.P.E.R.');
    doc.setCreationDate(now);
    doc.setModificationDate(now);

    let page = null, y = 0;
    const newPage = () => { page = doc.addPage([PAGE_W, PAGE_H]); y = PAGE_H - M; };
    const text = (s, x, yy, size, f, color) => page.drawText(pdfText(s), { x, y: yy, size, font: f || font, color: color || BLACK });
    const room = () => y - (M + FOOT);
    const ensure = (h) => { if (room() < h) newPage(); };

    newPage();

    // ── Title ──
    const title = 'INTAKE / DISCOVERY CHECKLIST';
    text(title, (PAGE_W - bold.widthOfTextAtSize(title, 16)) / 2, y - 14, 16, bold);
    y -= 22;
    if (cl.header.agency) {
        const a = pdfText(cl.header.agency).slice(0, 90);
        text(a, (PAGE_W - font.widthOfTextAtSize(a, 10)) / 2, y - 10, 10, font, GRAY);
        y -= 14;
    }
    y -= 10;

    // ── Header lines ──
    const field = (label, value, x, w) => {
        text(label.toUpperCase(), x, y - 7, 6.5, bold, GRAY);
        const lines = wrap(value || '', font, 10, w).slice(0, 3);
        let yy = y - 19;
        for (const ln of lines) { text(ln, x, yy, 10); yy -= 12; }
        const bottom = yy + 8;
        page.drawLine({ start: { x, y: bottom }, end: { x: x + w, y: bottom }, thickness: 0.5, color: RULE });
        return y - bottom + 6;
    };
    const H = cl.header;
    y -= field('Defendant(s)', H.defendants, M, CONTENT_W);
    const halfW = (CONTENT_W - GUTTER) / 2;
    let h1 = field('Agency', H.agency, M, halfW);
    let h2 = field('Agency case number', H.agencyCaseNumber, M + halfW + GUTTER, halfW);
    y -= Math.max(h1, h2);
    h1 = field('Assisting agency', H.assistingAgencies, M, halfW);
    h2 = field('Court case number(s)', H.caseNumbers, M + halfW + GUTTER, halfW);
    y -= Math.max(h1, h2);

    // ── Legend + summary ──
    const p = IC.progress(cl);
    y -= 4;
    text('Tick what has been provided. Status: N/A, In File, Requested, Other (see details / notes).', M, y - 8, 7.5, ital, GRAY);
    const sum = `${p.done} of ${p.total} complete  |  ${p.requested} requested  |  ${p.open} open`;
    text(sum, M + CONTENT_W - bold.widthOfTextAtSize(sum, 7.5), y - 8, 7.5, bold, p.requested ? RED : GRAY);
    y -= 18;

    // ── Sections ──
    // Each section is measured first so the two columns can be balanced.
    const SZ = 8.5, LH = 10.5;
    function sectionBlock(sec, width) {
        const rows = sec.items.map(item => {
            if (sec.kind === 'check') {
                const lines = wrap(item.label, font, SZ, width - 14);
                return { item, lines, detail: [], h: lines.length * LH + 3 };
            }
            const v = cl.statuses[item.id] || null;
            const lines = wrap(item.label, font, SZ, width - STATUS_W - 6);
            const detail = v && v.detail ? wrap(v.detail, ital, 7.5, width - 10) : [];
            return { item, v, lines, detail, h: lines.length * LH + detail.length * 9 + 3 };
        });
        const h = 16 + rows.reduce((a, r) => a + r.h, 0) + 8;
        const draw = (x, top) => {
            page.drawRectangle({ x, y: top - 13, width, height: 13, color: LIGHT });
            text(sec.title.toUpperCase(), x + 4, top - 9.5, 8, bold);
            let yy = top - 16;
            for (const r of rows) {
                const base = yy - 8;
                if (sec.kind === 'check') {
                    page.drawRectangle({ x, y: base - 1, width: 8, height: 8, borderColor: BLACK, borderWidth: 0.7 });
                    if (cl.checks[r.item.id]) {
                        page.drawLine({ start: { x: x + 1.5, y: base + 0.5 }, end: { x: x + 6.5, y: base + 5.5 }, thickness: 1.1, color: BLACK });
                        page.drawLine({ start: { x: x + 1.5, y: base + 5.5 }, end: { x: x + 6.5, y: base + 0.5 }, thickness: 1.1, color: BLACK });
                    }
                    r.lines.forEach((ln, k) => text(ln, x + 14, base - k * LH, SZ));
                } else {
                    r.lines.forEach((ln, k) => text(ln, x, base - k * LH, SZ));
                    const sx = x + width - STATUS_W;
                    if (r.v) {
                        const lab = IC.statusLabel(r.v.status);
                        text(lab, sx, base, SZ, bold, r.v.status === 'requested' ? RED : BLACK);
                    } else {
                        page.drawLine({ start: { x: sx, y: base - 1 }, end: { x: x + width, y: base - 1 }, thickness: 0.5, color: RULE });
                    }
                    let dy = base - r.lines.length * LH + 1;
                    for (const ln of r.detail) { text(ln, x + 10, dy, 7.5, ital, GRAY); dy -= 9; }
                }
                yy -= r.h;
            }
        };
        return { h, draw };
    }

    const colBlocks = IC.SECTIONS.map(s => sectionBlock(s, COL_W));
    const total = colBlocks.reduce((a, b) => a + b.h, 0);
    let split = 0, best = Infinity, acc = 0;
    for (let i = 0; i <= colBlocks.length; i++) {
        const m = Math.max(acc, total - acc);
        if (m < best) { best = m; split = i; }
        if (i < colBlocks.length) acc += colBlocks[i].h;
    }
    if (best <= room()) {
        let yl = y, yr = y;
        colBlocks.forEach((b, i) => {
            if (i < split) { b.draw(M, yl); yl -= b.h; } else { b.draw(M + COL_W + GUTTER, yr); yr -= b.h; }
        });
        y -= best;
    } else {
        // Long details: one full-width column, a new page when a section will not fit.
        for (const s of IC.SECTIONS) {
            const b = sectionBlock(s, CONTENT_W);
            ensure(b.h);
            b.draw(M, y);
            y -= b.h;
        }
    }

    // ── Discovery reminder ──
    const disc = wrap(IC.DISCOVERY_NOTE, font, 8, CONTENT_W - 12);
    const dh = 14 + disc.length * 10 + 8;
    y -= 4;
    ensure(dh);
    page.drawRectangle({ x: M, y: y - dh, width: CONTENT_W, height: dh, borderColor: RULE, borderWidth: 0.7 });
    text('DISCOVERY', M + 6, y - 11, 8, bold);
    disc.forEach((ln, k) => text(ln, M + 6, y - 23 - k * 10, 8));
    y -= dh + 12;

    // ── Notes (runs onto more pages when long) ──
    const notes = cl.notes.trim() ? wrap(cl.notes.trim(), font, 9, CONTENT_W - 12) : [];
    ensure(14 + Math.min(Math.max(notes.length, 4), 6) * 11 + 8);
    let first = true, i = 0;
    do {
        const fit = Math.max(1, Math.floor((room() - 14 - 8) / 11));
        const chunk = notes.slice(i, i + fit);
        const bh = 14 + Math.max(chunk.length, notes.length ? chunk.length : 5) * 11 + 8;
        page.drawRectangle({ x: M, y: y - bh, width: CONTENT_W, height: bh, borderColor: RULE, borderWidth: 0.7 });
        text(first ? 'NOTES' : 'NOTES (continued)', M + 6, y - 11, 8, bold);
        chunk.forEach((ln, k) => text(ln, M + 6, y - 24 - k * 11, 9));
        y -= bh + 8;
        i += chunk.length;
        first = false;
        if (i < notes.length) newPage();
    } while (i < notes.length);

    // ── Footers ──
    const pages = doc.getPages();
    pages.forEach((pg, k) => {
        const foot = (s, x, f, c) => pg.drawText(pdfText(s), { x, y: M - 6, size: 7, font: f || font, color: c || GRAY });
        const left = cl.header.agencyCaseNumber ? `Agency case ${cl.header.agencyCaseNumber}`.slice(0, 70) : '';
        if (left) foot(left, M);
        const mid = `Prepared ${ymd(now)} with V.I.P.E.R.`;
        foot(mid, (PAGE_W - font.widthOfTextAtSize(mid, 7)) / 2);
        const right = `Page ${k + 1} of ${pages.length}`;
        foot(right, PAGE_W - M - font.widthOfTextAtSize(right, 7));
        pg.drawLine({ start: { x: M, y: M + 4 }, end: { x: PAGE_W - M, y: M + 4 }, thickness: 0.4, color: RULE });
    });

    return Buffer.from(await doc.save());
}

/* ------------------------------------------------------------------------ */
/* IPC                                                                      */
/* ------------------------------------------------------------------------ */

const FILE_TITLE = 'Intake Checklist';

/*
 * 'prosecution-intake-pdf'  r: { caseNumber, checklist, mode }
 *   mode 'case'    → cases/<n>/Forms/ (encrypted under Field Security; refused while locked)
 *   mode 'saveAs'  → wherever the officer picks
 *   mode 'open'    → an unsaved temp copy in the PDF viewer (to check / print)
 *   mode 'preview' → the bytes back to the caller, nothing written
 */
function registerIntakeIpc(ipcMain, deps) {
    deps = deps || {};
    const audit = (ev, data) => { try { if (deps.audit) deps.audit(ev, data); } catch (_) { /* never block */ } };
    const fail = (msg) => { const e = new Error(msg); e.userMessage = true; throw e; };
    const cases = () => { if (!deps.caseForms) fail('Saving to the case is not available'); return deps.caseForms; };

    ipcMain.handle('prosecution-intake-pdf', async (_e, r) => {
        try {
            r = (r && typeof r === 'object' && !Array.isArray(r)) ? r : {};
            const mode = r.mode;
            if (!['case', 'saveAs', 'open', 'preview'].includes(mode)) fail('Unknown save option');
            if (!r.checklist || typeof r.checklist !== 'object') fail('There is no checklist to print');
            const caseNumber = deps.safeCaseNumber(r.caseNumber);
            if (mode === 'case' && !caseNumber) fail('Open a case first');
            if ((mode === 'case' || mode === 'open') && cases().locked()) fail('Unlock Field Security first — the checklist is saved encrypted with the case');
            const now = new Date();
            const cl = IC.normalize(r.checklist, now);
            const bytes = await buildIntakePdf(cl, { now });
            if (mode === 'preview') return { success: true, dataBase64: bytes.toString('base64') };
            const fileName = deps.outputFileName(FILE_TITLE, IC.nameHint(cl), now);
            if (mode === 'open') {
                await cases().openTemp(fileName, bytes);
                return { success: true, opened: true };
            }
            const p = IC.progress(cl);
            const auditBase = { case_number: caseNumber || null, items: p.total, complete: p.done, requested: p.requested };
            if (mode === 'case') {
                const saved = cases().save(caseNumber, fileName, bytes);
                audit('PROSECUTION_INTAKE_EXPORTED', Object.assign(auditBase, { destination: 'case', file: saved.fileName }));
                return { success: true, fileName: saved.fileName, destination: 'case' };
            }
            const win = deps.getWindow && deps.getWindow();
            const dir = (typeof deps.defaultDir === 'function' && deps.defaultDir()) || '';
            let res;
            try {
                res = await deps.dialog.showSaveDialog(win || undefined, {
                    title: 'Save intake checklist',
                    defaultPath: dir ? nodePath.join(dir, fileName) : fileName,
                    filters: [{ name: 'PDF', extensions: ['pdf'] }],
                });
            } finally { try { if (deps.restoreFocus) deps.restoreFocus(); } catch (_) { /* ignore */ } }
            if (!res || res.canceled || !res.filePath) return { success: true, canceled: true };
            (deps.writeFile || require('fs').writeFileSync)(res.filePath, bytes);
            const base = nodePath.basename(res.filePath);
            audit('PROSECUTION_INTAKE_EXPORTED', Object.assign(auditBase, { destination: 'export', file: base }));
            return { success: true, fileName: base, filePath: res.filePath, destination: 'export' };
        } catch (e) {
            const msg = (e && (e.userMessage || e.name === 'FormSetError')) ? e.message : ('Intake checklist error: ' + ((e && e.message) || e));
            return { success: false, error: msg };
        }
    });
}

module.exports = { buildIntakePdf, registerIntakeIpc, pdfText, wrap, FILE_TITLE };

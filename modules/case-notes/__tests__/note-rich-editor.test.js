/**
 * Case notes use the case report's editor (modules/reports/rich-editor.js):
 * the toolbar, From case inserts, find & replace, and layout-faithful PDF
 * (Notes export + Export to DA). This checks the host wiring in
 * case-detail-with-analytics.html and note-popout.html, and runs the shipping
 * exportNotesToPDF (lifted) against a stand-in jsPDF and main process.
 *
 * Run: node modules/case-notes/__tests__/note-rich-editor.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..', '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'case-detail-with-analytics.html'), 'utf8').replace(/\r\n/g, '\n');
const POP = fs.readFileSync(path.join(ROOT, 'note-popout.html'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
function ok(label, cond, detail) {
    if (cond) { pass++; console.log('  PASS  ' + label); }
    else { fail++; console.log('  FAIL  ' + label + (detail !== undefined ? '  -> ' + JSON.stringify(detail).slice(0, 400) : '')); }
}
function between(src, a, b) {
    const i = src.indexOf(a);
    const j = i < 0 ? -1 : src.indexOf(b, i + a.length);
    if (i < 0 || j < 0) throw new Error('anchor not found: ' + (i < 0 ? a : b));
    return src.slice(i, j);
}

(async () => {
    console.log('\n[note form]');
    const form = between(PAGE, '<!-- Toolbar: ViperRichEditor (modules/reports/rich-editor.js)\n                                             fills #noteRichToolbar', '<!-- Editor Area -->');
    ok('the note form gets #noteRichToolbar when the editor module is loaded', /\$\{window\.ViperRichEditor \? `<div id="noteRichToolbar"/.test(form));
    ok('…and keeps the old B/I/U bar as the fallback', /formatNoteText\('bold'\)/.test(form) && /noteFontSizeSelect/.test(form) && /`\}\s*<\/div>\s*$/.test(form));
    ok('rich-editor.js and case-inserts.js load before the page script', PAGE.indexOf('<script src="modules/reports/rich-editor.js"></script>') > 0
        && PAGE.indexOf('<script src="modules/reports/case-inserts.js"></script>') > 0
        && PAGE.indexOf('<script src="modules/reports/case-inserts.js"></script>') < PAGE.indexOf('function initializeNoteEditor('));

    const init = between(PAGE, '        function initializeNoteEditor(initialHtml) {', '        function _attachEditorImageHandlers(editor) {');
    ok('the editor is wired once (the form element survives between notes)', /if \(editor\._noteWired\) \{[^\n]*return; \}\n\s*editor\._noteWired = true;/.test(init));
    const iLink = init.indexOf("NoteLinks.pasteAsLink(e, document)");
    const iAttach = init.indexOf('ViperRichEditor.attach({');
    ok('a bare web address still becomes a link: NoteLinks paste runs first, in the capture phase', iLink > 0 && iAttach > iLink && /\}, true\);/.test(init.slice(iLink, iAttach)));
    const att = init.slice(iAttach, init.indexOf('});', iAttach));
    ok('attach: note wording, links kept, From case menu, other dropped files become attachments',
        /noun: 'note'/.test(att) && /links: true/.test(att) && /inserts: _reportCaseInserts\(\)/.test(att) && /onDropFiles: \(files\) => _stageNoteFiles\(files\)/.test(att));
    const iRet = init.indexOf('if (rich) return;');
    ok('the old paste / drop / picture handlers only run without the rich editor',
        iRet > iAttach && init.indexOf("editor.addEventListener('drop'") > iRet && init.indexOf('_attachEditorImageHandlers(editor);') > iRet && init.indexOf('_CS.shrinkImageDataUrl') > iRet);
    ok('…and the old paste handler leaves a NoteLinks paste alone', /if \(e\.defaultPrevented\) return;/.test(init.slice(iRet)));
    ok('formatNoteText (Ctrl+B/I/U) refreshes the toolbar state', /function formatNoteText\(command\) \{[\s\S]{0,200}ed\._vre\.refresh\(\)/.test(PAGE));
    ok('cancelling the form drops the picture frame and the find bar', /if \(ed && ed\._vre\) \{ ed\._vre\.deselect\(\); ed\._vre\.closeFind\(\); \}/.test(between(PAGE, '        function cancelNoteForm() {', '        // ── Note editor wiring')));

    console.log('\n[saving: no editor-only marks]');
    const auto = between(PAGE, '// \u2500\u2500\u2500 Autosave', 'async function openNotePopout');
    ok('dirty check, clean mark and commit read the editor through _noteEditorHtml',
        /return _noteEditorHtml\(ed\) !== \(_noteLastCommittedHtml \|\| ''\);/.test(auto)
        && /_noteLastCommittedHtml = _noteEditorHtml\(ed\);/.test(auto)
        && /const contentHtml = _noteEditorHtml\(editor\);/.test(auto)
        && !/ed\.innerHTML\.trim\(\)|editor\.innerHTML\.trim\(\)/.test(auto));
    ok('a note that is only a table counts as content', /<\(\?:img\|table\)\\b\/i\.test\(contentHtml\)/.test(auto));
    const fnSrc = between(PAGE, '        function _noteEditorHtml(ed) {', '        function _noteEditorIsDirty() {');
    {
        const sb = {};
        vm.createContext(sb);
        vm.runInContext(fnSrc + ';globalThis.f = _noteEditorHtml;', sb);
        const ed = { innerHTML: '  <p>x <img class="vre-img-selected"></p> ', cloneNode() { return this; } };
        ok('without the editor module: innerHTML, trimmed', sb.f(ed) === '<p>x <img class="vre-img-selected"></p>' && sb.f(null) === '');
        sb.ViperRichEditor = { cleanHtml: (e) => ' ' + e.innerHTML.replace(/ class="vre-img-selected"/, '') + ' ' };
        ok('with it: cleanHtml (selection marks gone), trimmed', sb.f(ed) === '<p>x <img></p>');
    }

    console.log('\n[showing saved notes]');
    ok('note cards are .vre-doc (headings, lists, tables, page breaks styled)', (PAGE.match(/class="note-rendered vre-doc /g) || []).length === 2);
    ok('…with the editor CSS injected before they render', /function _noteRenderHtml\(note\) \{[\s\S]{0,300}ViperRichEditor\.ensureCss\(document\)/.test(PAGE));

    console.log('\n[note pop-out]');
    ok('loads rich-editor.js after note-links.js', POP.indexOf('modules/case-notes/note-links.js') < POP.indexOf('<script src="modules/reports/rich-editor.js"></script>'));
    ok('rich bar + plain fallback bar', /<div class="rich-toolbar" id="richBar" hidden><\/div>/.test(POP) && /<div class="toolbar" id="plainBar">/.test(POP));
    const pLink = POP.indexOf("NoteLinks.pasteAsLink(e, document)"), pAttach = POP.indexOf('RE.attach({');
    ok('NoteLinks paste (capture) is registered before the rich editor', pLink > 0 && pAttach > pLink && /\}, true\);/.test(POP.slice(pLink, pAttach)));
    const pAtt = POP.slice(pAttach, POP.indexOf('});', pAttach));
    ok('attach: note wording, links kept, no From case menu', /noun: 'note'/.test(pAtt) && /links: true/.test(pAtt) && !/inserts/.test(pAtt));
    ok('load, dirty check and save use cleanHtml', /lastCommitted = editorHtml\(\);/.test(POP) && /loaded && \(editorHtml\(\) !== /.test(POP) && /const html = editorHtml\(\);/.test(POP) && !/editor\.innerHTML\.trim\(\)/.test(POP));
    ok('the old picture paste only without the rich editor', /if \(!RE\) editor\.addEventListener\('paste'/.test(POP));

    console.log('\n[Notes PDF export: laid-out notes]');
    const EXPORT = between(PAGE, '        // opts.plain: no Chromium page layout', '        // The case report can be written in Microsoft Word');

    function makeEnv(api, o) {
        o = o || {};
        const saved = [], toasts = [], downloads = [], printCalls = [], stampCalls = [], mergeCalls = [];
        const docs = [];
        class FakePdf {
            constructor() {
                this.pages = 1; this.cur = 1; this.texts = [];
                this.internal = { pageSize: { width: 210, height: 297 }, getNumberOfPages: () => this.pages };
                docs.push(this);
            }
            addPage() { this.pages++; this.cur = this.pages; }
            setPage(n) { this.cur = n; }
            text(t, x, y) { this.texts.push({ page: this.cur, t: String(t), y }); }
            splitTextToSize(t) { return [String(t)]; }
            output(kind) {
                const raw = '%PDF-base';
                if (kind === 'arraybuffer') return new Uint8Array(Buffer.from(raw)).buffer;
                if (kind === 'datauristring') return 'data:application/pdf;base64,' + Buffer.from(raw).toString('base64');
                return raw;
            }
            save(name) { saved.push(name); }
        }
        ['setFillColor', 'rect', 'setTextColor', 'setFontSize', 'setFont', 'addImage', 'setDrawColor', 'line'].forEach((m) => { FakePdf.prototype[m] = function () {}; });
        const blobs = new Map();
        const fakeEl = (tag) => {
            const el = { tag, childNodes: [], click() { if (tag === 'a') downloads.push({ name: el.download, blob: blobs.get(el.href) }); }, remove() {} };
            Object.defineProperty(el, 'innerHTML', { set(h) { el.childNodes = [{ nodeType: 3, nodeValue: String(h).replace(/<[^>]*>/g, ' ') }]; } });
            return el;
        };
        const env = {
            console, Promise, Math, Date, JSON, String, Array, Object, Error, RegExp, Uint8Array, Buffer,
            setTimeout: () => 0,
            atob: (b) => Buffer.from(b, 'base64').toString('binary'),
            btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
            Blob: class { constructor(parts) { this.parts = parts; } },
            URL: { createObjectURL: (b) => { const u = 'blob:' + blobs.size; blobs.set(u, b); return u; }, revokeObjectURL() {} },
            Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
            document: { createElement: fakeEl, body: { appendChild() {} } },
            currentCase: { caseNumber: '24-0001' },
            caseNotes: o.notes,
            viperToast: (m, t) => toasts.push({ m, t }),
            _noteTitleOf: (n) => n.title || '',
            _CS: { IMG_ATTR: 'data-vp-img' },
            _noteImagesFromDisk: async (h) => h.replace(/data-vp-img="[^"]*"/g, 'src="data:image/png;base64,AAAA"'),
        };
        env.window = {
            jspdf: { jsPDF: FakePdf },
            ViperRichEditor: { isRichReport: (h) => /<table|<img/i.test(h), sanitize: (h) => ({ html: '[clean]' + h }) },
            ViperReportPrint: { buildPrintHtml: (x) => { printCalls.push(x); return '<html>' + x.bodyHtml + '</html>'; } },
            electronAPI: Object.assign({
                reportHtmlPdfPages: async (h, w, hh) => { printCalls.push({ h, w, hh }); return { success: true, id: 'n'.repeat(64), pages: 2 }; },
                reportDocsStampPdf: async (b64, pl) => { stampCalls.push({ b64, pl }); return { success: true, base64: Buffer.from('%PDF-stamped').toString('base64') }; },
                notesExportMergeAttachments: async (x) => { mergeCalls.push(x); return { success: true, mergedCount: 1, requested: 1 }; },
            }, api || {}),
        };
        vm.createContext(env);
        vm.runInContext(EXPORT + ';globalThis.exportNotesToPDF = exportNotesToPDF;', env);
        return { env, saved, toasts, downloads, printCalls, stampCalls, mergeCalls, docs };
    }
    const t0 = '2026-11-01T10:00:00Z', t1 = '2026-11-02T10:00:00Z';
    const RICHNOTE = { id: 'a', title: 'Canvass', createdAt: t1, contentHtml: '<p>Doors</p><table><tr><td>12 Elm</td></tr></table><img data-vp-img="note-image-1.png">' };
    const PLAIN = { id: 'b', title: 'Call', createdAt: t0, content: 'Called the complainant back.' };
    {
        const E = makeEnv(null, { notes: [PLAIN, RICHNOTE] });
        await E.env.exportNotesToPDF();
        const pages = E.printCalls.filter((c) => c.h);
        const built = E.printCalls.filter((c) => c.bodyHtml);
        ok('a rich note is printed by Chromium once, pictures read from disk first', pages.length === 1 && built.length === 1 && /src="data:image\/png/.test(built[0].bodyHtml) && /^\[clean\]/.test(built[0].bodyHtml), built.map((b) => b.bodyHtml));
        ok('…at the size of the A4 text box (15 mm sides, 20 top, 25 bottom for the footer)', Math.abs(pages[0].w - 180 / 25.4) < 1e-9 && Math.abs(pages[0].hh - 252 / 25.4) < 1e-9, pages[0]);
        ok('…starting under the note heading on the same page', built[0].firstPageTopMm > 30 && built[0].firstPageTopMm < 60, built[0].firstPageTopMm);
        const pl = E.stampCalls[0] && E.stampCalls[0].pl;
        ok('its pages are stamped onto consecutive reserved pages, frameless', E.stampCalls.length === 1 && pl.length === 2 && pl[0].page === 1 && pl[1].page === 2
            && pl.every((p, i) => p.frame === false && p.index === i && p.id === 'n'.repeat(64) && p.box.top === 20 && p.box.bottom === 25 && p.box.left === 15 && p.box.right === 15), pl);
        const plainNote = E.docs[0].texts.find((x) => /Called the complainant/.test(x.t));
        ok('the next note starts on a fresh page after the laid-out one', plainNote && plainNote.page === 3, plainNote);
        ok('page footers are drawn on every page, the stamped ones too', E.docs[0].texts.filter((x) => /^Page \d of 3$/.test(x.t)).length === 3);
        ok('the stamped PDF is what gets saved (not the jsPDF bytes)', E.saved.length === 0 && E.downloads.length === 1 && E.downloads[0].name === 'Case_24-0001_Notes_' + new Date().toISOString().split('T')[0] + '.pdf'
            && Buffer.from(E.downloads[0].blob.parts[0]).toString() === '%PDF-stamped', E.downloads);
        ok('success toast, no warnings', E.toasts.length === 1 && E.toasts[0].t === 'success', E.toasts);
    }
    {
        const E = makeEnv(null, { notes: [PLAIN, { id: 'c', createdAt: t1, contentHtml: '<p>only <b>text</b></p>' }] });
        await E.env.exportNotesToPDF();
        ok('plain notes only: no Chromium, no stamping, jsPDF saves as before', E.printCalls.length === 0 && E.stampCalls.length === 0 && E.saved.length === 1 && E.downloads.length === 0);
    }
    {
        const E = makeEnv({ reportHtmlPdfPages: async () => ({ success: false, error: 'timed out' }) }, { notes: [RICHNOTE] });
        await E.env.exportNotesToPDF();
        ok('a note that cannot be laid out is written as text, nothing stamped', E.stampCalls.length === 0 && E.saved.length === 1 && E.docs[0].texts.some((x) => /Doors/.test(x.t)));
        ok('…and the officer is told which note and why', E.toasts.some((t) => t.t === 'warning' && /^Page layout in this export:\n• Note 1 "Canvass" could not be laid out as pages \(timed out\)/.test(t.m)), E.toasts);
    }
    {
        const E = makeEnv({ reportDocsStampPdf: async () => ({ success: false, error: 'gone' }) }, { notes: [RICHNOTE] });
        await E.env.exportNotesToPDF();
        ok('a failed stamp never saves blank pages: the export is redone as plain text', E.docs.length === 2 && E.saved.length === 1 && E.downloads.length === 0
            && E.printCalls.filter((c) => c.h).length === 1 && E.docs[1].texts.some((x) => /Doors/.test(x.t)));
        ok('…with a warning saying so', E.toasts.some((t) => t.t === 'warning' && /could not be placed into the PDF \(gone\)/.test(t.m)), E.toasts);
    }
    {
        const withPdf = Object.assign({}, RICHNOTE, { attachments: [{ fileName: 'return.pdf', type: 'application/pdf', size: 2048 }] });
        const E = makeEnv(null, { notes: [withPdf] });
        await E.env.exportNotesToPDF();
        ok('PDF attachments are merged onto the stamped PDF', E.mergeCalls.length === 1 && Buffer.from(E.mergeCalls[0].basePdfBase64, 'base64').toString() === '%PDF-stamped' && E.saved.length === 0 && E.downloads.length === 0, E.mergeCalls.map((m) => m.attachmentNames));
    }
    {
        const E = makeEnv(null, { notes: [RICHNOTE] });
        await E.env.exportNotesToPDF({ plain: true });
        ok('exportNotesToPDF({ plain: true }) never lays out', E.printCalls.length === 0 && E.stampCalls.length === 0 && E.saved.length === 1);
        ok('the button passes no options (an onclick event is not { plain: true })', /onclick="exportNotesToPDF\(\)"/.test(PAGE));
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) process.exit(1);
})().catch((e) => { console.log('FAIL: threw ' + (e && e.stack || e)); process.exit(1); });

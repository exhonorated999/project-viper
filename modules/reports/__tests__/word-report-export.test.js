/*
 * Word reports in Export to DA — the case page's half (lifted, not copied).
 *
 * Run: node modules\reports\__tests__\word-report-export.test.js
 *
 * Slices wordReportPages() and the stamping step out of
 * generateCaseReportPDF in case-detail-with-analytics.html and runs them
 * against a fake jsPDF and a fake electronAPI. What it pins:
 *   - one reserved page per Word page, each noted with the report's id and
 *     the Word page index, on the page numbers the report really has;
 *   - the list on the Reports page says where each report begins, which
 *     ones could not be reproduced and why, and which were converted
 *     without Word;
 *   - the officer is told about reports open in Word, tracked changes and
 *     comments, failures;
 *   - no Word API (old main) or a failed conversion still says the reports
 *     are provided separately — never a silent gap;
 *   - after the report is built the reserved pages are stamped; if that
 *     fails NOTHING is exported (no DA report with blank pages).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..', '..');
const HTML = fs.readFileSync(path.join(ROOT, 'case-detail-with-analytics.html'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const ok = (n, c, x) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? ' -> ' + JSON.stringify(x) : '')); }
};
function slice(startAnchor, endAnchor) {
    const a = HTML.indexOf(startAnchor);
    const b = HTML.indexOf(endAnchor, a + 1);
    if (a < 0 || b < 0) throw new Error('anchor not found: ' + (a < 0 ? startAnchor : endAnchor));
    return HTML.slice(a, b);
}

const WORD_SRC = slice('            // ========== WORD REPORTS (Reports tab, Word mode) ==========', '            // ========== CONTENT — track page numbers ==========');
const SAVE_SRC = slice("            let pdfBytes = doc.output('arraybuffer');", '            const fileName = _assist');

function fakeDoc() {
    const d = {
        pages: 3, texts: [],
        getNumberOfPages() { return d.pages; },
        setFontSize() {}, setFont() {}, setTextColor() {},
        getTextWidth: (s) => String(s).length * 2,
        splitTextToSize: (t, w) => { const s = String(t); const per = Math.max(10, Math.floor(w / 2)); const out = []; for (let i = 0; i < s.length; i += per) out.push(s.slice(i, i + per)); return out.length ? out : ['']; },
        text: (t, x, y, o) => d.texts.push({ t: [].concat(t).join(''), x, y, o, page: d.pages }),
        output: (kind) => kind === 'arraybuffer' ? new Uint8Array([1, 2, 3]).buffer : 'data:application/pdf;base64,' + Buffer.from('BASE').toString('base64'),
    };
    return d;
}

function makeEnv(api) {
    const doc = fakeDoc();
    const env = {
        console, Promise, Object, String, JSON, Array, Math, Buffer, Uint8Array,
        atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        doc, y: 40, M: 20, CW: 170, PW: 210, PH: 297,
        GRAY: [100, 100, 100], BLACK: [0, 0, 0], LGRAY: [180, 180, 180],
        currentCase: { caseNumber: '24-1', reportFormat: 'word' },
        toasts: [], fields: [], empties: [],
        window: { electronAPI: api },
    };
    env.viperToast = (m, t) => env.toasts.push({ m, t });
    env.need = (h) => { if (env.y + h > env.PH - 25) env.newPage(); };
    env.newPage = () => { doc.pages++; env.y = env.M + 15; };
    env.emptyMsg = (m) => env.empties.push(m);
    env.fieldBold = (label, value) => { env.fields.push({ label, value, page: doc.pages }); env.y += 6; };
    vm.createContext(env);
    vm.runInContext(WORD_SRC + '\nthis.__w = { wordReportPages, _wordPlacements, _wordReportNotes };', env);
    return env;
}

(async () => {
    console.log('\n[reserved pages]');
    {
        const asked = [];
        const env = makeEnv({
            reportDocsStampPdf: async () => ({ success: true }),
            reportDocsToPdf: async (cn) => { asked.push(cn); return { success: true, docs: [
                { fileName: 'Case Report.docx', ok: true, id: 'a'.repeat(64), pages: 2, method: 'word', revisions: 0, comments: 0 },
                { fileName: 'Bad.doc', ok: false, error: 'Word could not convert it: corrupt' },
                { fileName: 'Supplement 1.docx', ok: true, id: 'b'.repeat(64), pages: 3, method: 'html', wordMissing: true },
            ] }; },
        });
        await env.__w.wordReportPages();
        const P = env.__w._wordPlacements;
        ok('asks main for this case', asked.length === 1 && asked[0] === '24-1');
        ok('says it is converting (it takes a few seconds)', env.toasts[0] && /Converting the Word reports/.test(env.toasts[0].m));
        ok('one reserved page per Word page (2 + 3), none for the failed one', P.length === 5, P);
        ok('…on consecutive pages after the Reports page', P.map((p) => p.page).join() === '4,5,6,7,8', P.map((p) => p.page));
        ok('…each naming its report and Word page', P.slice(0, 2).every((p) => p.id === 'a'.repeat(64)) && P[0].index === 0 && P[1].index === 1 &&
            P.slice(2).every((p) => p.id === 'b'.repeat(64)) && P.map((p) => p.index).slice(2).join() === '0,1,2');
        const f = env.fields;
        ok('the list says where each begins', /2 pages, begins page 4$/.test(f[0].value) && /^3 pages, begins page 6/.test(f[2].value), f);
        ok('…numbers them and names them', f[0].label === '1. Case Report.docx' && f[1].label === '2. Bad.doc' && f[2].label === '3. Supplement 1.docx');
        ok('…says a failed one was NOT reproduced, why, and that it is provided separately', /^NOT REPRODUCED — Word could not convert it: corrupt\. Provided separately\.$/.test(f[1].value));
        ok('…and flags one converted without Word', /converted without Microsoft Word; layout may differ/.test(f[2].value));
        ok('the list sits on the Reports page itself', f.every((x) => x.page === 3));
        const caps = env.doc.texts.filter((t) => / — page \d of \d$/.test(t.t));
        ok('each reserved page carries a small caption naming the report and page', caps.length === 5 && caps[0].t === 'Case Report.docx — page 1 of 2' && caps[0].page === 4 && caps[4].page === 8);
        ok('…centred at the foot, clear of the header', caps.every((c) => c.x === 105 && c.y === 293 && c.o && c.o.align === 'center'));
        ok('anything after starts on a fresh page', env.y === env.PH);
        const N = env.__w._wordReportNotes;
        ok('the officer is told about the failure', N.some((n) => /"Bad\.doc" was NOT included: Word could not convert it: corrupt/.test(n)), N);
        ok('…and the one converted without Word (Word not installed)', N.some((n) => /"Supplement 1\.docx" was converted without Microsoft Word \(Word is not installed\)/.test(n)));
    }
    {
        const env = makeEnv({
            reportDocsStampPdf: async () => ({}),
            reportDocsToPdf: async () => ({ success: true, docs: [
                { fileName: 'R.docx', ok: true, id: 'c'.repeat(64), pages: 1, method: 'word', open: true, revisions: 3, comments: 1 },
            ] }),
        });
        await env.__w.wordReportPages();
        const N = env.__w._wordReportNotes;
        ok('a report open in Word: the last SAVED version was used', N.some((n) => /"R\.docx" is open in Word — its last SAVED version was used/.test(n)), N);
        ok('tracked changes and comments: printed without markup', N.some((n) => /3 tracked changes and 1 comment — printed without markup/.test(n)));
        ok('a single page says "1 page"', /^1 page, begins page 4$/.test(env.fields[0].value), env.fields[0]);
    }

    console.log('\n[never a silent gap]');
    {
        const env = makeEnv({});   // an older main: no reportDocsToPdf
        await env.__w.wordReportPages();
        ok('no conversion API → the reports are provided separately', env.doc.texts.some((t) => /written in Microsoft Word and are provided separately/.test(t.t)));
        ok('…and nothing is reserved', env.__w._wordPlacements.length === 0);
    }
    {
        const env = makeEnv({ reportDocsStampPdf: async () => ({}), reportDocsToPdf: async () => ({ success: false, error: 'Field Security is locked.' }) });
        await env.__w.wordReportPages();
        ok('a failed conversion says so in the PDF, with the reason', env.doc.texts.some((t) => /could not be converted for this report \(Field Security is locked\.\)\. They are provided separately\./.test(t.t)), env.doc.texts);
        ok('…and tells the officer', env.__w._wordReportNotes.some((n) => /could not be converted: Field Security is locked/.test(n)));
    }
    {
        const env = makeEnv({ reportDocsStampPdf: async () => ({}), reportDocsToPdf: async () => { throw new Error('IPC gone'); } });
        await env.__w.wordReportPages();
        ok('a thrown IPC error is handled the same way', env.doc.texts.some((t) => /could not be converted for this report \(IPC gone\)/.test(t.t)));
    }
    {
        const env = makeEnv({ reportDocsStampPdf: async () => ({}), reportDocsToPdf: async () => ({ success: true, docs: [] }) });
        await env.__w.wordReportPages();
        ok('no Word reports → "No Word reports in this case."', env.empties[0] === 'No Word reports in this case.');
    }
    {
        // A long list that cannot fit on one page: no page numbers promised.
        const docs = Array.from({ length: 60 }, (_, i) => ({ fileName: 'Supplement ' + i + '.docx', ok: true, id: String(i).padStart(64, '0'), pages: 1, method: 'word' }));
        const env = makeEnv({ reportDocsStampPdf: async () => ({}), reportDocsToPdf: async () => ({ success: true, docs }) });
        await env.__w.wordReportPages();
        ok('a list too long for one page promises no page numbers', env.fields.every((f) => !/begins page/.test(f.value)));
        ok('…but every page is still reserved', env.__w._wordPlacements.length === 60);
    }

    console.log('\n[stamping the finished report]');
    async function runSave(env, returnPdf) {
        env._returnPdf = returnPdf;
        env.currentCase = { caseNumber: '24-1' };
        const fn = vm.runInContext('(async (_wordPlacements, _wordReportNotes) => {\n' + SAVE_SRC + '\nreturn { pdfBytes, _stampedB64, reached: true };\n})', env);
        return fn(env._wordPlacements || env.__w._wordPlacements, env._wordReportNotes || env.__w._wordReportNotes);
    }
    {
        const stamped = Buffer.from('%PDF-stamped').toString('base64');
        const sent = [];
        const env = makeEnv({ reportDocsToPdf: async () => ({ success: true, docs: [{ fileName: 'R.docx', ok: true, id: 'd'.repeat(64), pages: 1, method: 'word' }] }),
            reportDocsStampPdf: async (b64, pl) => { sent.push([b64, pl]); return { success: true, base64: stamped }; } });
        await env.__w.wordReportPages();
        env._wordPlacements = env.__w._wordPlacements; env._wordReportNotes = env.__w._wordReportNotes;
        const r = await runSave(env, false);
        ok('the finished report goes to main with the placements', sent.length === 1 && sent[0][0] === Buffer.from('BASE').toString('base64') && sent[0][1].length === 1 && sent[0][1][0].page === 4);
        ok('the stamped PDF replaces the jsPDF bytes', r.reached && Buffer.from(new Uint8Array(r.pdfBytes)).toString() === '%PDF-stamped');
        ok('…and is what Supervisor Link gets too', r._stampedB64 === stamped);
    }
    {
        const env = makeEnv({ reportDocsStampPdf: async () => ({ success: false, error: 'A converted Word report is no longer available — export again.' }) });
        env._wordPlacements = [{ page: 4, id: 'e'.repeat(64), index: 0 }]; env._wordReportNotes = [];
        const r = await runSave(env, false);
        ok('a failed stamp stops the export (nothing saved)', r === undefined);
        ok('…and says why and what to do', env.toasts.some((t) => t.t === 'error' && /could not be placed into the PDF: A converted Word report is no longer available/.test(t.m) && /Nothing was exported/.test(t.m)));
        const env2 = makeEnv({ reportDocsStampPdf: async () => { throw new Error('boom'); } });
        env2._wordPlacements = [{ page: 4, id: 'e'.repeat(64), index: 0 }]; env2._wordReportNotes = [];
        const r2 = await runSave(env2, true);
        ok('…Supervisor Link gets { success:false } instead', r2 && r2.success === false && /could not be placed into the PDF: boom/.test(r2.error));
    }
    {
        const calls = [];
        const env = makeEnv({ reportDocsStampPdf: async () => { calls.push(1); return {}; } });
        env._wordPlacements = []; env._wordReportNotes = [];
        const r = await runSave(env, false);
        ok('no Word pages → no stamping round trip, bytes unchanged', calls.length === 0 && r.reached && new Uint8Array(r.pdfBytes).length === 3);
    }
    {
        const env = makeEnv({});
        env._wordPlacements = []; env._wordReportNotes = ['"R.docx" is open in Word — its last SAVED version was used.'];
        await runSave(env, false);
        ok('the notes reach the officer as a warning toast', env.toasts.some((t) => t.t === 'warning' && /Word reports in this export:\n• "R\.docx" is open in Word/.test(t.m)));
    }

    console.log('\n[VIPER-editor report with tables / pictures]');
    const RE = require(path.join(ROOT, 'modules', 'reports', 'rich-editor.js'));
    function vEnv(api, opts) {
        const env = makeEnv(api);
        const o = opts || {};
        env.rendered = [];
        env.renderReportHtml = async (h) => { env.rendered.push(h); };
        env.printed = [];
        env.window.ViperRichEditor = o.noRich ? undefined : { isRichReport: RE.isRichReport, sanitize: (h) => ({ html: '[clean]' + h, droppedImages: 0 }) };
        env.window.ViperReportPrint = { buildPrintHtml: (x) => { env.printed.push(x); return '<html>' + x.bodyHtml + '</html>'; } };
        vm.runInContext('this.__v = { viperReportPages, _viperReportNotes };', env);
        return env;
    }
    const RICH = '<p>Narrative</p><table><tr><td>Item</td></tr></table>';
    {
        const calls = [];
        const env = vEnv({ reportHtmlPdfPages: async (h, w, hh) => { calls.push([h, w, hh]); return { success: true, id: 'f'.repeat(64), pages: 3 }; }, reportDocsStampPdf: async () => ({}) });
        env.y = 60;
        await env.__v.viperReportPages(RICH);
        const P = env.__w._wordPlacements;
        ok('a report with a table is printed by Chromium, sanitized', calls.length === 1 && calls[0][0] === '<html>[clean]' + RICH + '</html>' && env.rendered.length === 0);
        ok('…at exactly the report box size (A4 minus 20/20 mm sides, 16 top, 14 bottom)', Math.abs(calls[0][1] - 170 / 25.4) < 1e-9 && Math.abs(calls[0][2] - 267 / 25.4) < 1e-9, calls[0].slice(1));
        ok('…its first page starting under the section title already on the page', env.printed[0].firstPageTopMm === 60 - 4 - 16, env.printed[0]);
        ok('one placement per printed page, on consecutive pages starting with the section page', P.length === 3 && P.map((p) => p.page).join() === '3,4,5', P.map((p) => p.page));
        ok('…frameless, with the report box, naming the printed page', P.every((p, i) => p.frame === false && p.index === i && p.id === 'f'.repeat(64) && p.box.top === 16 && p.box.bottom === 14 && p.box.left === 20 && p.box.right === 20));
        ok('anything after starts on a fresh page', env.y === env.PH);
        ok('no note when it worked', env.__v._viperReportNotes.length === 0);
    }
    {
        const env = vEnv({ reportHtmlPdfPages: async () => ({ success: true, id: 'f'.repeat(64), pages: 1 }), reportDocsStampPdf: async () => ({}) });
        env.y = 250;
        await env.__v.viperReportPages(RICH);
        ok('low on the page → the report starts on a new page', env.__w._wordPlacements[0].page === 4 && env.printed[0].firstPageTopMm === env.M + 15 - 4 - 16, [env.__w._wordPlacements, env.printed[0].firstPageTopMm]);
    }
    {
        const calls = [];
        const env = vEnv({ reportHtmlPdfPages: async () => { calls.push(1); return {}; }, reportDocsStampPdf: async () => ({}) });
        await env.__v.viperReportPages('<p>Plain <b>text</b> only.</p>');
        ok('a plain-text report stays native PDF text (no Chromium round trip)', calls.length === 0 && env.rendered.length === 1 && env.__w._wordPlacements.length === 0);
    }
    {
        const env = vEnv({});
        await env.__v.viperReportPages(RICH);
        ok('an older main (no print call) → native text, no placements', env.rendered.length === 1 && env.__w._wordPlacements.length === 0 && env.__v._viperReportNotes.length === 0);
        const env2 = vEnv({ reportHtmlPdfPages: async () => ({ success: true, id: 'a'.repeat(64), pages: 1 }), reportDocsStampPdf: async () => ({}) }, { noRich: true });
        await env2.__v.viperReportPages(RICH);
        ok('…and so does a page without the editor module', env2.rendered.length === 1 && env2.__w._wordPlacements.length === 0);
    }
    {
        const env = vEnv({ reportHtmlPdfPages: async () => ({ success: false, error: 'PDF render timed out after 60s' }), reportDocsStampPdf: async () => ({}) });
        await env.__v.viperReportPages(RICH);
        ok('a failed print falls back to text, never a gap', env.rendered.length === 1 && env.rendered[0] === RICH && env.__w._wordPlacements.length === 0);
        ok('…and the officer is told why, and what was lost', env.__v._viperReportNotes.some((n) => /could not be laid out as pages \(PDF render timed out after 60s\)/.test(n) && /without its table and picture layout/.test(n)), env.__v._viperReportNotes);
        const env2 = vEnv({ reportHtmlPdfPages: async () => { throw new Error('IPC gone'); }, reportDocsStampPdf: async () => ({}) });
        await env2.__v.viperReportPages(RICH);
        ok('…a thrown IPC error too', env2.rendered.length === 1 && env2.__v._viperReportNotes.some((n) => /\(IPC gone\)/.test(n)));
        const env3 = vEnv({ reportHtmlPdfPages: async () => ({ success: true, id: 'a'.repeat(64), pages: 0 }), reportDocsStampPdf: async () => ({}) });
        await env3.__v.viperReportPages(RICH);
        ok('…and zero pages counts as a failure', env3.rendered.length === 1 && env3.__w._wordPlacements.length === 0);
    }
    {
        const env = vEnv({ reportDocsStampPdf: async () => ({ success: false, error: 'A converted report is no longer available — export again.' }) });
        env._wordPlacements = [{ page: 3, id: 'e'.repeat(64), index: 0, frame: false, box: { top: 16, bottom: 14, left: 20, right: 20 } }]; env._wordReportNotes = [];
        const r = await runSave(env, false);
        const t = env.toasts.find((x) => x.t === 'error');
        ok('a failed stamp of the case report stops the export, naming the case report', r === undefined && t && /^The case report could not be placed into the PDF: A converted report is no longer available/.test(t.m), env.toasts);
        ok('…without the Word "Save a copy" advice', t && !/Save a copy/.test(t.m) && /Nothing was exported\. Try again\.$/.test(t.m));
        const env2 = vEnv({ reportDocsStampPdf: async () => ({}) });
        env2._wordPlacements = [{ page: 3, id: 'e'.repeat(64), index: 0, frame: false }, { page: 4, id: 'd'.repeat(64), index: 0 }]; env2._wordReportNotes = [];
        await runSave(env2, false);
        ok('with Word pages in the mix it still names the Word reports', env2.toasts.some((x) => x.t === 'error' && /^The Word reports could not be placed/.test(x.m) && /Save a copy/.test(x.m)));
    }
    {
        const env = vEnv({ reportHtmlPdfPages: async () => ({ success: false, error: 'boom' }), reportDocsStampPdf: async () => ({}) });
        await env.__v.viperReportPages(RICH);
        env._wordPlacements = []; env._wordReportNotes = [];
        await runSave(env, false);
        ok('the case-report note reaches the officer as a warning toast', env.toasts.some((t) => t.t === 'warning' && /^Case report in this export:\n• The case report could not be laid out as pages \(boom\)/.test(t.m)), env.toasts);
    }

    console.log('\n[wiring]');
    {
        const gen = slice('        async function generateCaseReportPDF(', '            // ========== BACKFILL TOC ==========');
        ok('the Reports section calls wordReportPages in Word mode', /if \(_reportIsWord\(\)\) \{\n\s+await wordReportPages\(\);\n\s+break;/.test(gen));
        const iWord = HTML.indexOf('const _wordPlacements = [];'), iLoop = HTML.indexOf('            for (const tab of dataTabs) {\n                newPage();');
        ok('the placements exist before any section is rendered', iWord > 0 && iLoop > iWord);
        const ret = slice('            if (_returnPdf) {\n                let base64', '                return {\n                    success: true,\n                    base64,');
        ok('Supervisor Link sends the stamped PDF when there is one', /let base64 = _stampedB64 \|\| '';/.test(ret));
        const pre = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
        ok('preload exposes both calls', /reportDocsToPdf: \(caseNumber\) => ipcRenderer\.invoke\('report-docs-to-pdf', \{ caseNumber \}\)/.test(pre) &&
            /reportDocsStampPdf: \(base64, placements\) => ipcRenderer\.invoke\('report-docs-stamp-pdf', \{ base64, placements \}\)/.test(pre));
        const main = fs.readFileSync(path.join(ROOT, 'electron-main.js'), 'utf8');
        ok('main handles both', /ipcMain\.handle\('report-docs-to-pdf'/.test(main) && /ipcMain\.handle\('report-docs-stamp-pdf'/.test(main));
        ok('main reads each report through the Word-report manager (decrypts with Field Security)', /_reportDocs\(\)\.readPlain\(caseNumber, d\.fileName\)/.test(main));
    }

    console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

/*
 * Word reports → PDF pages (modules/reports/docx-pdf.js).
 *
 * Run: node modules\reports\__tests__\docx-pdf.test.js
 *
 * PowerShell/Word is faked (a fake spawn that does what the script does:
 * reads job.json, writes the PDFs and result.json). The .docx → HTML
 * fallback runs the REAL mammoth on a synthetic document; the HTML → PDF
 * printer is faked with pdf-lib. stamp() runs real pdf-lib end to end.
 * What it pins:
 *   - Word converts every report in ONE run; results map back by file;
 *   - the officer's own Word is never touched: only the PID the script
 *     recorded is ever killed (timeout, or a hidden Word that did not quit);
 *   - no plaintext is left behind: the private temp folder is removed after
 *     success, failure and timeout;
 *   - no Word → the .docx goes through mammoth; .doc/.rtf say Word is needed;
 *   - unchanged documents come from the in-memory cache, not a second run;
 *   - stamp() draws each Word page onto the reserved page and refuses bad
 *     placements instead of producing blank pages;
 *   - the PowerShell script: read-only, macros off, no password prompt,
 *     Close/Quit with [ref], Quit only an instance it started and only empty.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const ROOT = path.join(__dirname, '..', '..', '..');
const LIB = require(path.join(ROOT, 'modules', 'reports', 'docx-pdf.js'));
const { PDFDocument, StandardFonts } = require(path.join(ROOT, 'node_modules', 'pdf-lib'));
const docx = require(path.join(ROOT, 'node_modules', 'docx'));

let pass = 0, fail = 0;
const ok = (n, c, x) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? ' -> ' + JSON.stringify(x) : '')); }
};

async function makePdf(pages, size) {
    const d = await PDFDocument.create();
    const f = await d.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < pages; i++) {
        const p = d.addPage(size || [612, 792]);
        p.drawText('Synthetic page ' + (i + 1), { x: 72, y: 700, size: 14, font: f });
    }
    return Buffer.from(await d.save());
}
async function makeDocx() {
    const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType } = docx;
    const cell = (t) => new TableCell({ children: [new Paragraph(t)] });
    const d = new Document({ sections: [{ children: [
        new Paragraph({ children: [new TextRun({ text: 'Synthetic Supplement', bold: true })] }),
        new Paragraph('Narrative line for the fallback test.'),
        new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [new TableRow({ children: [cell('Item'), cell('Blue phone')] })] }),
    ] }] });
    return Buffer.from(await Packer.toBuffer(d));
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'docxpdf-test-'));

/**
 * A fake spawn standing in for PowerShell + Word. `behave(job)` returns
 * { result, pid, pages: {index: n}, hang, code } describing what "Word" does.
 */
function fakeSpawn(behave, calls) {
    return (cmd, args, opts) => {
        const child = new EventEmitter();
        child.stderr = new EventEmitter();
        child.killed = false;
        child.kill = () => { child.killed = true; calls.push(['child-kill']); setImmediate(() => child.emit('exit', null)); };
        const jobPath = args[args.indexOf('-Job') + 1];
        calls.push(['spawn', cmd, args, opts, jobPath]);
        (async () => {
            const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
            calls.push(['job', job, job.items.map((it) => fs.existsSync(it.in) ? fs.readFileSync(it.in) : null)]);
            const b = await behave(job);
            if (b.pid) fs.writeFileSync(job.pidFile, '\uFEFF' + b.pid + '\r\n');
            if (b.hang) return;     // never exits: the timeout has to fire
            if (b.pages) for (const [i, n] of Object.entries(b.pages)) fs.writeFileSync(job.items[i].out, await makePdf(n));
            if (b.result) fs.writeFileSync(job.result, '\uFEFF' + JSON.stringify(typeof b.result === 'function' ? b.result(job) : b.result));
            child.emit('exit', b.code == null ? 0 : b.code);
        })().catch((e) => { calls.push(['fake-error', e.message]); child.emit('exit', 9); });
        return child;
    };
}

function make(over) {
    const calls = [];
    const killed = [];
    const alive = new Set();
    const deps = Object.assign({
        fs, path, crypto,
        platform: 'win32',
        tmpRoot: path.join(TMP, 'work'),
        killPid: (pid) => { killed.push(pid); alive.delete(pid); },
        isAlive: (pid) => alive.has(pid),
        sleep: () => Promise.resolve(),
        log: () => {},
    }, over || {});
    if (over && over.behave) deps.spawn = fakeSpawn(over.behave, calls);
    const svc = LIB.createDocxPdf(deps);
    return { svc, calls, killed, alive };
}
const leftovers = () => { try { return fs.readdirSync(path.join(TMP, 'work')); } catch (_) { return []; } };

(async () => {
    const A = Buffer.from('PK synthetic report A');
    const B = Buffer.from('PK synthetic report B');

    console.log('\n[Word converts every report in one run]');
    {
        const t = make({
            behave: async () => ({
                pid: 4242,
                pages: { 0: 2, 1: 3 },
                result: (job) => ({ items: [
                    { in: job.items[0].in, ok: true, revisions: 2, comments: 1 },
                    { in: job.items[1].in, ok: true, revisions: 0, comments: 0 },
                ] }),
            }),
        });
        const r = await t.svc.convertMany([{ fileName: 'Case Report.docx', plain: A }, { fileName: 'Supplement 1.docx', plain: B }]);
        const spawns = t.calls.filter((c) => c[0] === 'spawn');
        ok('one PowerShell run for both reports', spawns.length === 1, spawns.length);
        ok('…powershell.exe, hidden, no profile, script by -File', spawns[0][1] === 'powershell.exe' && spawns[0][3].windowsHide === true &&
            spawns[0][2].includes('-NoProfile') && spawns[0][2].includes('-NonInteractive') && spawns[0][2][spawns[0][2].indexOf('-File') + 1].endsWith('convert.ps1'));
        const job = t.calls.find((c) => c[0] === 'job');
        ok('the job carries the plaintext of each report, keeping its extension', job[2][0].equals(A) && job[2][1].equals(B) && /in-0\.docx$/.test(job[1].items[0].in));
        ok('both converted by Word', r.every((x) => x.ok && x.method === 'word'), r);
        ok('page counts come from the PDFs', r[0].pages === 2 && r[1].pages === 3);
        ok('tracked changes / comments are reported', r[0].revisions === 2 && r[0].comments === 1 && r[1].revisions === 0);
        ok('each gets a stable id (content hash)', /^[0-9a-f]{64}$/.test(r[0].id) && r[0].id !== r[1].id);
        ok('no bytes are handed back (they stay in main)', !('pdf' in r[0]));
        ok('the temp folder is gone', leftovers().length === 0, leftovers());
        ok('a Word that quit by itself is not killed', t.killed.length === 0);

        const again = await t.svc.convertMany([{ fileName: 'Case Report.docx', plain: A }]);
        ok('an unchanged report comes from the cache, without Word', again[0].ok && again[0].cached === true && t.calls.filter((c) => c[0] === 'spawn').length === 1);
        const changed = await t.svc.convertMany([{ fileName: 'Case Report.docx', plain: Buffer.from('PK edited') }]).catch((e) => [{ error: e.message }]);
        ok('an edited report is converted again', t.calls.filter((c) => c[0] === 'spawn').length === 2, changed);
    }

    console.log('\n[the officer\'s own Word is never touched]');
    {
        const t = make({ behave: async () => ({ pid: 5151, pages: { 0: 1 }, result: (job) => ({ items: [{ in: job.items[0].in, ok: true }] }) }) });
        t.alive.add(5151);   // our hidden Word did not quit
        await t.svc.convertMany([{ fileName: 'R.docx', plain: A }]);
        ok('a hidden Word the script started and that did not quit is ended', t.killed.length === 1 && t.killed[0] === 5151, t.killed);
    }
    {
        const t = make({ behave: async () => ({ pages: { 0: 1 }, result: (job) => ({ items: [{ in: job.items[0].in, ok: true }] }) }) });
        await t.svc.convertMany([{ fileName: 'R.docx', plain: A }]);
        ok('no PID recorded (Word was already running) → nothing is killed', t.killed.length === 0);
    }
    {
        const t = make({ timeoutMs: 30, perDocTimeoutMs: 1, maxTimeoutMs: 60, behave: async () => ({ pid: 6262, hang: true }) });
        const r = await t.svc.convertMany([{ fileName: 'R.docx', plain: A }]);
        ok('a hung Word times out', !r[0].ok && /did not finish within/.test(r[0].error), r[0]);
        ok('…the script is stopped and ONLY the Word it started is killed', t.calls.some((c) => c[0] === 'child-kill') && t.killed.length === 1 && t.killed[0] === 6262, t.killed);
        ok('…and the temp folder is gone', leftovers().length === 0, leftovers());
    }

    console.log('\n[failures]');
    {
        const t = make({
            behave: async () => ({ pid: 7, pages: { 0: 1 }, result: (job) => ({ items: [
                { in: job.items[0].in, ok: true },
                { in: job.items[1].in, ok: false, error: 'Word experienced an error trying to open the file.\nTry these suggestions. (C:\\Users\\x\\AppData\\in-1.doc)' },
            ] }) }),
        });
        const r = await t.svc.convertMany([{ fileName: 'Good.docx', plain: A }, { fileName: 'Old.doc', plain: B }, { fileName: 'Locked.docx', plain: null, error: 'Field Security is locked.' }]);
        ok('one bad document does not sink the others', r[0].ok && !r[1].ok);
        ok('…its error is Word\'s first line, without the temp path', r[1].error === 'Word could not convert it: Word experienced an error trying to open the file.', r[1].error);
        ok('an unreadable document (locked vault) says why and is never sent to Word', !r[2].ok && r[2].error === 'Field Security is locked.' &&
            t.calls.find((c) => c[0] === 'job')[1].items.length === 2);
    }
    {
        const t = make({ behave: async () => ({ code: 1, result: null }) });
        const r = await t.svc.convertMany([{ fileName: 'X.doc', plain: A }]);
        ok('PowerShell failing outright is an error, not a crash', !r[0].ok && /PowerShell exited with code 1/.test(r[0].error), r[0]);
    }

    console.log('\n[no Microsoft Word → .docx through mammoth]');
    {
        const htmls = [];
        const t = make({
            behave: async () => ({ result: { fatal: 'NO_WORD', error: 'Retrieving the COM class factory failed' }, code: 3 }),
            htmlToPdf: async (html) => { htmls.push(html); return makePdf(1); },
        });
        const real = await makeDocx();
        const r = await t.svc.convertMany([{ fileName: 'Supplement.docx', plain: real }, { fileName: 'Old.rtf', plain: B }]);
        ok('the .docx is converted without Word', r[0].ok && r[0].method === 'html' && r[0].wordMissing === true && r[0].pages === 1, r[0]);
        ok('…from mammoth\'s HTML: text and table survive', htmls.length === 1 && /Synthetic Supplement/.test(htmls[0]) && /<table/.test(htmls[0]) && /Blue phone/.test(htmls[0]));
        ok('…on a Letter page in report type', /@page\{size:Letter/.test(htmls[0]) && /Times New Roman/.test(htmls[0]));
        ok('an .rtf without Word says Word is needed', !r[1].ok && /^Microsoft Word is not installed, and only \.docx files can be converted without Microsoft Word\./.test(r[1].error), r[1].error);
    }
    {
        const t = make({ platform: 'linux', htmlToPdf: async () => makePdf(2) });
        const r = await t.svc.convertMany([{ fileName: 'S.docx', plain: await makeDocx() }]);
        ok('off Windows, straight to the fallback', r[0].ok && r[0].method === 'html' && r[0].pages === 2);
    }
    {
        const t = make({ behave: async () => ({ pid: 8, result: (job) => ({ items: [{ in: job.items[0].in, ok: false, error: 'This file is password protected' }] }) }), htmlToPdf: async () => makePdf(1) });
        const r = await t.svc.convertMany([{ fileName: 'P.docx', plain: Buffer.from('not a zip') }]);
        ok('Word failed and the fallback cannot read it either → Word\'s reason is shown', !r[0].ok && /password protected/.test(r[0].error), r[0].error);
    }

    console.log('\n[stamp(): Word pages onto the reserved report pages]');
    {
        const t = make({ behave: async () => ({ pid: 9, pages: { 0: 2 }, result: (job) => ({ items: [{ in: job.items[0].in, ok: true }] }) }) });
        const [r] = await t.svc.convertMany([{ fileName: 'Case Report.docx', plain: A }]);
        const base = await makePdf(5, [595.28, 841.89]);   // jsPDF's A4
        const out = await t.svc.stamp(base, [{ page: 4, id: r.id, index: 0 }, { page: 5, id: r.id, index: 1 }]);
        const d = await PDFDocument.load(out);
        ok('the report keeps its page count', d.getPageCount() === 5);
        const xobjs = (n) => {
            const res = d.getPage(n).node.Resources();
            const xo = res && res.lookup(require(path.join(ROOT, 'node_modules', 'pdf-lib')).PDFName.of('XObject'));
            return xo ? xo.keys().length : 0;
        };
        ok('pages 4 and 5 carry a Word page each', xobjs(3) === 1 && xobjs(4) === 1, [xobjs(3), xobjs(4)]);
        ok('pages 1-3 are untouched', xobjs(0) === 0 && xobjs(1) === 0 && xobjs(2) === 0);
        // Geometry: Letter scaled into the A4 box under the header.
        const MM = 72 / 25.4, bw = 595.28 - 16 * MM, bh = 841.89 - 26 * MM;
        const s = Math.min(bw / 612, bh / 792);
        ok('…scaled to fit the area under the header (no stretching)', s > 0.85 && s < 0.95 && Math.abs(612 * s - bw) < 0.01, s);

        let e1 = null; try { await t.svc.stamp(base, [{ page: 6, id: r.id, index: 0 }]); } catch (e) { e1 = e.message; }
        ok('a page outside the report is refused', /outside the report/.test(e1 || ''), e1);
        let e2 = null; try { await t.svc.stamp(base, [{ page: 2, id: r.id, index: 2 }]); } catch (e) { e2 = e.message; }
        ok('a Word page that does not exist is refused', /does not have/.test(e2 || ''), e2);
        let e3 = null; try { await t.svc.stamp(base, [{ page: 2, id: 'f'.repeat(64), index: 0 }]); } catch (e) { e3 = e.message; }
        ok('an unknown / evicted report is refused (export again)', /no longer available/.test(e3 || ''), e3);
    }

    console.log('\n[addPdf() + frameless placement: a VIPER report printed for the box]');
    {
        const PL = require(path.join(ROOT, 'node_modules', 'pdf-lib'));
        const t = make({ behave: async () => ({}) });
        const MM = 72 / 25.4;
        const box = { top: 16, bottom: 14, left: 20, right: 20 };
        // A page printed at exactly the box size (what report-html-pdf-pages does).
        const bwPt = 595.28 - 40 * MM, bhPt = 841.89 - 30 * MM;
        const printed = await makePdf(2, [bwPt, bhPt]);
        const a = await t.svc.addPdf(printed, 'viper');
        ok('addPdf counts the pages and returns an id', a.pages === 2 && /^[0-9a-f]{64}$/.test(a.id), a);
        const b = await t.svc.addPdf(printed, 'viper');
        ok('…the same PDF gives the same id (cache, not a second copy)', b.id === a.id);
        const c = await t.svc.addPdf(printed, 'other');
        ok('…a different method is a different entry', c.id !== a.id);
        let e0 = null; try { await t.svc.addPdf(Buffer.from('not a pdf'), 'viper'); } catch (e) { e0 = e.message; }
        ok('…a non-PDF is refused', !!e0, e0);

        const base = await makePdf(3, [595.28, 841.89]);
        const out = await t.svc.stamp(base, [{ page: 2, id: a.id, index: 0, frame: false, box }, { page: 3, id: a.id, index: 1, frame: false, box }]);
        const d = await PDFDocument.load(out);
        const ops = (n) => {
            const pg = d.getPage(n).node;
            const cs = pg.Contents();
            const refs = cs instanceof PL.PDFArray ? cs.asArray() : [cs];
            return refs.map((r) => {
                const st = r instanceof PL.PDFRef ? d.context.lookup(r) : r;
                try { return Buffer.from(PL.decodePDFRawStream(st).decode()).toString('latin1'); }
                catch (_) { return Buffer.from(st.getContents ? st.getContents() : []).toString('latin1'); }
            }).join('\n');
        };
        const s2 = ops(1);
        // Compose every `a 0 0 d e f cm` of the q…Do block that draws the page.
        const blk = /q\n((?:[^q]|q(?!\n))*?)\/EmbeddedPdfPage[^\s]* Do/.exec(s2);
        let x = 0, y = 0, sc = 1;
        if (blk) {
            const re = /([-\d.]+) 0 0 ([-\d.]+) ([-\d.]+) ([-\d.]+) cm/g; let mm;
            while ((mm = re.exec(blk[1]))) { x += +mm[3] * sc; y += +mm[4] * sc; sc *= +mm[1]; }
        } else { x = y = sc = NaN; }
        ok('the printed page is drawn on its reserved page', /Do/.test(s2) && /Do/.test(ops(2)) && !/Do/.test(ops(0)));
        ok('…without a frame (no rectangle around it)', !/\bre\b/.test(s2), s2.slice(0, 400));
        ok('…at 1:1 (a page printed for the box is not rescaled)', Math.abs(sc - 1) < 0.001, { sc, snippet: s2.slice(0, 300) });
        ok('…top-left of the box: x = left margin, y = bottom margin', Math.abs(x - 20 * MM) < 0.05 && Math.abs(y - 14 * MM) < 0.05, { x, y, snippet: s2.slice(0, 300) });
        let e4 = null; try { await t.svc.stamp(base, [{ page: 2, id: a.id, index: 0, frame: false, box: { top: -1, bottom: 0, left: 0, right: 0 } }]); } catch (e) { e4 = e.message; }
        ok('a bad box is refused', /Bad placement box/.test(e4 || ''), e4);
        let e5 = null; try { await t.svc.stamp(base, [{ page: 2, id: a.id, index: 0, frame: false, box: { top: 'x', bottom: 0, left: 0, right: 0 } }]); } catch (e) { e5 = e.message; }
        ok('…including a non-number', /Bad placement box/.test(e5 || ''), e5);
    }

    console.log('\n[the PowerShell script]');
    {
        const S = LIB.PS_SCRIPT;
        ok('opens read-only, no add-to-recent', /\$w\.Documents\.Open\(\$it\.in, \$false, \$true, \$false, /.test(S));
        ok('a password-protected document fails instead of prompting', /\$noPw = 'viper-no-password'/.test(S) && /\$noPw, \$noPw, \$true, \$noPw, \$noPw/.test(S));
        ok('macros are forced off', /AutomationSecurity = 3/.test(S));
        ok('no alerts, hidden', /DisplayAlerts = 0/.test(S) && /Visible = \$false/.test(S));
        ok('exports PDF (17) without markup', /ExportAsFixedFormat\(\$it\.out, 17\)/.test(S) && /RevisionsFilter\.Markup = 0/.test(S));
        ok('Close and Quit pass SaveChanges by [ref] (a bare 0 is refused)', /\$d\.Close\(\[ref\]0\)/.test(S) && /\$w\.Quit\(\[ref\]0\)/.test(S) && !/\.(Close|Quit)\(0\)/.test(S));
        ok('Quit only a Word this run started, and only when it holds no documents', /if \(\$mine\.Count -ge 1 -and \$w\.Documents\.Count -eq 0\) \{ \$w\.Quit/.test(S));
        ok('records the PID only when exactly one new Word appeared', /if \(\$mine\.Count -eq 1\) \{ Set-Content -LiteralPath \$j\.pidFile/.test(S));
        ok('no Word → NO_WORD', /fatal = 'NO_WORD'/.test(S));
    }

    console.log('\n[helpers]');
    ok('firstLine trims to one line, drops the temp path', LIB.firstLine('Bad file.\r (C:\\T\\in-0.docx)\nmore') === 'Bad file.');
    ok('fallbackHtml escapes the title', /<title>a&lt;b<\/title>/.test(LIB.fallbackHtml('<p>x</p>', 'a<b')));

    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
    console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

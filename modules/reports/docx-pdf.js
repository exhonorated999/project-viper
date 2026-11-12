'use strict';
/**
 * Word reports → PDF pages for Export to DA / Assist Package. MAIN PROCESS ONLY.
 *
 * An officer who writes the case report in Microsoft Word (Reports tab, Word
 * mode — cases/<caseNumber>/Reports/Word/) needs those reports IN the DA
 * package, laid out exactly as written: tables, pictures, text wrapped
 * around pictures. Two ways to get a PDF:
 *
 *   1. Microsoft Word itself (preferred). A hidden Word is driven over COM
 *      from PowerShell: open read-only → ExportAsFixedFormat(PDF). Same
 *      engine that drew the document, so the PDF is what the officer saw.
 *      Officers who write in Word have Word.
 *   2. No Word (or Word failed on a .docx): mammoth turns the .docx into
 *      HTML and the caller's HTML→PDF renderer prints it. Text, headings,
 *      lists, tables and pictures survive; exact placement (floating
 *      pictures, text boxes, columns) does not. The result says which way
 *      was used so the export can say so.
 *
 * The officer's Word is never disturbed: the script notes which WINWORD
 * processes existed before it asked for Word, and only ever quits/kills one
 * it started — and quits only when that instance holds no documents.
 *
 * Plaintext never outlives the call: with Field Security on, the decrypted
 * .docx and its PDF are written to a private temp folder that is removed
 * before returning. Results are kept IN MEMORY only (small LRU keyed by the
 * document's hash) so a second export of an unchanged report is instant.
 *
 * stamp() places converted pages onto blank pages the jsPDF report reserved
 * for them, scaled into the area under the report's own header — so page
 * numbers, the table of contents and the Assist Package stamp stay correct.
 */

const PS_SCRIPT = [
    'param([string]$Job)',
    "$ErrorActionPreference = 'Stop'",
    '$j = Get-Content -LiteralPath $Job -Raw -Encoding UTF8 | ConvertFrom-Json',
    '$res = @()',
    'function Save-Result($obj) { $obj | ConvertTo-Json -Compress -Depth 5 | Set-Content -LiteralPath $j.result -Encoding UTF8 }',
    '$before = @(Get-Process -Name WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })',
    'try { $w = New-Object -ComObject Word.Application }',
    "catch { Save-Result @{ fatal = 'NO_WORD'; error = $_.Exception.Message }; exit 3 }",
    '$after = @(Get-Process -Name WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })',
    '$mine = @($after | Where-Object { $before -notcontains $_ })',
    'if ($mine.Count -eq 1) { Set-Content -LiteralPath $j.pidFile -Value $mine[0] -Encoding ASCII }',
    'try {',
    '  try { $w.Visible = $false } catch {}',
    '  try { $w.DisplayAlerts = 0 } catch {}',
    '  try { $w.AutomationSecurity = 3 } catch {}',
    "  $noPw = 'viper-no-password'",
    '  foreach ($it in $j.items) {',
    '    $d = $null',
    '    try {',
    '      $d = $w.Documents.Open($it.in, $false, $true, $false, $noPw, $noPw, $true, $noPw, $noPw, 0)',
    '      $rev = 0; $com = 0',
    '      try { $rev = $d.Revisions.Count } catch {}',
    '      try { $com = $d.Comments.Count } catch {}',
    // Print the document as it reads, not the reviewing markup.
    '      try { $d.ActiveWindow.View.RevisionsFilter.Markup = 0; $d.ActiveWindow.View.RevisionsFilter.View = 0 } catch {}',
    '      $d.ExportAsFixedFormat($it.out, 17)',
    '      $res += @{ in = $it.in; ok = $true; revisions = $rev; comments = $com }',
    '    } catch {',
    '      $res += @{ in = $it.in; ok = $false; error = $_.Exception.Message }',
    '    } finally {',
    '      if ($d) { try { $d.Close([ref]0) } catch {}; try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($d) } catch {} }',
    '    }',
    '  }',
    '} finally {',
    '  try { if ($mine.Count -ge 1 -and $w.Documents.Count -eq 0) { $w.Quit([ref]0) } } catch {}',
    // (Close/Quit take their SaveChanges argument by reference: a bare 0 is
    // refused, the call is skipped, and the hidden Word is left running.)
    '  try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($w) } catch {}',
    '}',
    'Save-Result @{ items = $res }',
    'exit 0',
].join('\r\n');

const MM = 72 / 25.4;   // points per millimetre
// Where a Word page goes on a reserved report page: under the header rule
// (y = 12 mm) and above the footer stamp line, small side margins. mm.
const DEFAULT_BOX = { top: 15, bottom: 11, left: 8, right: 8 };
const CACHE_MAX_ENTRIES = 12;
const CACHE_MAX_BYTES = 200 * 1024 * 1024;
const MAX_DOC_BYTES = 150 * 1024 * 1024;

function stripBom(s) { return String(s || '').replace(/^\uFEFF/, ''); }

/** First line of a Word/COM error, without the temp path it names. */
function firstLine(s) {
    return String(s || '').split(/\r?\n|\r/)[0].replace(/\s*\([A-Za-z]:\\[^)]*\)\s*$/, '').trim().slice(0, 300);
}

function extOf(name) {
    const m = /\.[^.\\/]+$/.exec(String(name || ''));
    return m ? m[0].toLowerCase() : '';
}

function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** The page the HTML fallback prints: plain report typography, Letter. */
function fallbackHtml(bodyHtml, title) {
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + escHtml(title || 'Report') + '</title><style>' +
        '@page{size:Letter;margin:0.75in}' +
        'body{font-family:"Times New Roman",Times,serif;font-size:12pt;line-height:1.35;color:#000;margin:0}' +
        'p{margin:0 0 8pt}h1{font-size:16pt}h2{font-size:14pt}h3{font-size:12.5pt}' +
        'table{border-collapse:collapse;margin:6pt 0;max-width:100%}td,th{border:1px solid #444;padding:3pt 5pt;vertical-align:top}' +
        'img{max-width:100%;height:auto}ul,ol{margin:0 0 8pt 22pt;padding:0}' +
        '</style></head><body>' + bodyHtml + '</body></html>';
}

function createDocxPdf(deps) {
    const fs = deps.fs;
    const path = deps.path;
    const crypto = deps.crypto;
    const spawn = deps.spawn;
    const platform = deps.platform || process.platform;
    const tmpRoot = deps.tmpRoot;
    const getPdfLib = deps.pdfLib || (() => require('pdf-lib'));
    const getMammoth = deps.mammoth || (() => require('mammoth'));
    const htmlToPdf = deps.htmlToPdf || null;     // async (html) => Buffer
    const killPid = deps.killPid || ((pid) => { try { process.kill(pid); } catch (_) {} });
    const isAlive = deps.isAlive || ((pid) => { try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); } });
    const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const baseTimeoutMs = deps.timeoutMs || 60000;
    const perDocTimeoutMs = deps.perDocTimeoutMs || 30000;
    const maxTimeoutMs = deps.maxTimeoutMs || 5 * 60000;
    const log = deps.log || (() => {});

    const cache = new Map();   // id → { pdf, pages, method, revisions, comments }
    let chain = Promise.resolve();

    const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

    function cachePut(id, entry) {
        cache.delete(id);
        cache.set(id, entry);
        let bytes = 0;
        for (const v of cache.values()) bytes += v.pdf.length;
        while (cache.size > CACHE_MAX_ENTRIES || (bytes > CACHE_MAX_BYTES && cache.size > 1)) {
            const oldest = cache.keys().next().value;
            bytes -= cache.get(oldest).pdf.length;
            cache.delete(oldest);
        }
    }
    function cacheGet(id) {
        const v = cache.get(id);
        if (v) { cache.delete(id); cache.set(id, v); }
        return v || null;
    }

    async function pageCount(pdf) {
        const { PDFDocument } = getPdfLib();
        const d = await PDFDocument.load(pdf, { ignoreEncryption: true });
        return d.getPageCount();
    }

    function rmDir(dir) {
        for (let i = 0; i < 5; i++) {
            try { fs.rmSync(dir, { recursive: true, force: true }); return true; }
            catch (_) { /* Word may still be letting go */ }
            try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); } catch (_) {}
        }
        return false;
    }

    /**
     * Run Word over a batch. Returns { fatal?, items: Map(index → {ok, pdf?, error?, revisions, comments}) }.
     */
    async function viaWord(items) {
        if (platform !== 'win32' || !spawn) return { fatal: 'NO_WORD', items: new Map() };
        const dir = path.join(tmpRoot, crypto.randomBytes(8).toString('hex'));
        fs.mkdirSync(dir, { recursive: true });
        const out = new Map();
        try {
            const job = { items: [], result: path.join(dir, 'result.json'), pidFile: path.join(dir, 'word.pid') };
            items.forEach((it, i) => {
                const inPath = path.join(dir, 'in-' + i + (extOf(it.fileName) || '.docx'));
                fs.writeFileSync(inPath, it.plain);
                job.items.push({ in: inPath, out: path.join(dir, 'out-' + i + '.pdf') });
            });
            const jobPath = path.join(dir, 'job.json');
            fs.writeFileSync(jobPath, JSON.stringify(job), 'utf8');
            const ps1 = path.join(dir, 'convert.ps1');
            fs.writeFileSync(ps1, PS_SCRIPT, 'utf8');

            const timeoutMs = Math.min(maxTimeoutMs, baseTimeoutMs + perDocTimeoutMs * items.length);
            const exit = await new Promise((resolve) => {
                let done = false, timer = null, stderr = '';
                let child;
                try {
                    child = spawn('powershell.exe',
                        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Job', jobPath],
                        { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
                } catch (e) { resolve({ code: -1, error: (e && e.message) || String(e) }); return; }
                const finish = (r) => { if (done) return; done = true; if (timer) clearTimeout(timer); resolve(r); };
                if (child.stderr) child.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += String(d); });
                child.on('error', (e) => finish({ code: -1, error: (e && e.message) || String(e) }));
                child.on('exit', (code) => finish({ code, stderr }));
                timer = setTimeout(() => {
                    try { child.kill(); } catch (_) {}
                    // Only the Word this run started — never the officer's own.
                    try {
                        const pid = parseInt(stripBom(fs.readFileSync(job.pidFile, 'utf8')).trim(), 10);
                        if (pid > 0) killPid(pid);
                    } catch (_) {}
                    finish({ code: -1, timedOut: true, error: 'Microsoft Word did not finish within ' + Math.round(timeoutMs / 1000) + ' seconds.' });
                }, timeoutMs);
            });

            // The hidden Word this run started should have quit by itself. If
            // it is still there a few seconds later (Quit refused), end it —
            // it is ours, invisible, and would otherwise hold ~200 MB.
            if (!exit.timedOut) {
                let pid = 0;
                try { pid = parseInt(stripBom(fs.readFileSync(job.pidFile, 'utf8')).trim(), 10) || 0; } catch (_) {}
                if (pid > 0) {
                    for (let n = 0; n < 25 && isAlive(pid); n++) await sleep(200);
                    if (isAlive(pid)) { log('[docx-pdf] hidden Word ' + pid + ' did not quit; ending it'); killPid(pid); }
                }
            }

            let result = null;
            try { result = JSON.parse(stripBom(fs.readFileSync(job.result, 'utf8'))); } catch (_) { result = null; }
            if (result && result.fatal) return { fatal: result.fatal, error: result.error, items: out };
            if (!result) {
                return { fatal: exit.timedOut ? 'TIMEOUT' : 'FAILED', error: exit.error || (exit.stderr || '').trim().slice(0, 500) || ('PowerShell exited with code ' + exit.code), items: out };
            }
            const rows = Array.isArray(result.items) ? result.items : (result.items ? [result.items] : []);
            job.items.forEach((ji, i) => {
                const row = rows.find((r) => r && r.in === ji.in) || null;
                if (row && row.ok) {
                    let pdf = null;
                    try { pdf = fs.readFileSync(ji.out); } catch (_) {}
                    if (pdf && pdf.length) out.set(i, { ok: true, pdf, revisions: row.revisions | 0, comments: row.comments | 0 });
                    else out.set(i, { ok: false, error: 'Word reported success but wrote no PDF.' });
                } else {
                    out.set(i, { ok: false, error: row && row.error ? 'Word could not convert it: ' + firstLine(row.error) : 'Word did not convert this document.' });
                }
            });
            return { items: out };
        } finally {
            if (!rmDir(dir)) log('[docx-pdf] could not remove temp folder ' + dir);
        }
    }

    async function viaHtml(it) {
        if (!htmlToPdf) throw new Error('No HTML renderer available.');
        if (extOf(it.fileName) !== '.docx') throw new Error('Only .docx files can be converted without Microsoft Word.');
        const mammoth = getMammoth();
        const r = await mammoth.convertToHtml({ buffer: it.plain });
        const pdf = await htmlToPdf(fallbackHtml(r.value || '<p></p>', it.fileName));
        if (!pdf || !pdf.length) throw new Error('The HTML renderer produced no PDF.');
        return pdf;
    }

    /**
     * items: [{ fileName, plain: Buffer }] → [{ fileName, ok, id, pages, method, error, revisions, comments }]
     * (no bytes — they stay here, fetched by id for stamp()).
     */
    async function convertMany(items) {
        const run = chain.then(() => convertManyNow(items), () => convertManyNow(items));
        chain = run.catch(() => {});
        return run;
    }

    async function convertManyNow(items) {
        const list = Array.isArray(items) ? items : [];
        const results = list.map((it) => ({ fileName: it && it.fileName, ok: false }));
        const todo = [];
        list.forEach((it, i) => {
            if (!it || !Buffer.isBuffer(it.plain) || !it.plain.length) { results[i].error = (it && it.error) || 'The document could not be read.'; return; }
            if (it.plain.length > MAX_DOC_BYTES) { results[i].error = 'The document is too large to convert.'; return; }
            const id = sha(Buffer.concat([it.plain, Buffer.from('|' + extOf(it.fileName))]));
            results[i].id = id;
            const hit = cacheGet(id);
            if (hit) Object.assign(results[i], { ok: true, pages: hit.pages, method: hit.method, revisions: hit.revisions, comments: hit.comments, cached: true });
            else todo.push(i);
        });
        if (!todo.length) return results;

        let word = { fatal: null, items: new Map() };
        try { word = await viaWord(todo.map((i) => list[i])); }
        catch (e) { word = { fatal: 'FAILED', error: (e && e.message) || String(e), items: new Map() }; }
        const wordMissing = word.fatal === 'NO_WORD';

        for (let k = 0; k < todo.length; k++) {
            const i = todo[k];
            const r = results[i];
            const w = word.items.get(k);
            try {
                if (w && w.ok) {
                    const pages = await pageCount(w.pdf);
                    cachePut(r.id, { pdf: w.pdf, pages, method: 'word', revisions: w.revisions, comments: w.comments });
                    Object.assign(r, { ok: true, pages, method: 'word', revisions: w.revisions, comments: w.comments });
                    continue;
                }
                const wordError = w ? w.error : (wordMissing ? null : (word.error || word.fatal));
                try {
                    const pdf = await viaHtml(list[i]);
                    const pages = await pageCount(pdf);
                    cachePut(r.id, { pdf, pages, method: 'html', revisions: 0, comments: 0 });
                    Object.assign(r, { ok: true, pages, method: 'html', wordMissing, wordError: wordError || undefined });
                } catch (e) {
                    r.error = wordMissing
                        ? 'Microsoft Word is not installed, and ' + ((e && e.message) || String(e)).replace(/^./, (c) => c.toLowerCase())
                        : (wordError || (e && e.message) || String(e));
                    r.wordMissing = wordMissing;
                }
            } catch (e) {
                r.error = (e && e.message) || String(e);
            }
        }
        return results;
    }

    /**
     * Register a PDF rendered elsewhere (the VIPER-editor report printed by
     * Chromium) so stamp() can place its pages. → { id, pages }
     */
    async function addPdf(pdf, method) {
        if (!Buffer.isBuffer(pdf) || !pdf.length) throw new Error('No PDF to add.');
        if (pdf.length > MAX_DOC_BYTES) throw new Error('The PDF is too large.');
        const pages = await pageCount(pdf);
        const id = sha(Buffer.concat([pdf, Buffer.from('|' + (method || 'pdf'))]));
        cachePut(id, { pdf, pages, method: method || 'pdf', revisions: 0, comments: 0 });
        return { id, pages };
    }

    const numBox = (b) => {
        if (!b || typeof b !== 'object') return null;
        const out = {};
        for (const k of ['top', 'bottom', 'left', 'right']) {
            const v = +b[k];
            if (!isFinite(v) || v < 0 || v > 150) throw new Error('Bad placement box.');
            out[k] = v;
        }
        return out;
    };

    /**
     * Draw converted pages onto reserved pages of a finished report PDF.
     * placements: [{ page: 1-based page of base, id, index: 0-based page of the source,
     *                frame?: false → no border, top-left aligned (a page laid out for the box),
     *                box?: { top, bottom, left, right } mm — overrides opts.box }]
     */
    async function stamp(basePdf, placements, opts) {
        const { PDFDocument, rgb } = getPdfLib();
        const box0 = Object.assign({}, DEFAULT_BOX, (opts && opts.box) || {});
        const out = await PDFDocument.load(basePdf);
        const pages = out.getPages();
        const byId = new Map();
        for (const p of Array.isArray(placements) ? placements : []) {
            if (!p || typeof p.id !== 'string') throw new Error('Bad placement.');
            const page = p.page | 0, index = p.index | 0;
            if (page < 1 || page > pages.length) throw new Error('Placement page ' + page + ' is outside the report.');
            const src = cacheGet(p.id);
            if (!src) throw new Error('A converted report is no longer available — export again.');
            if (index < 0 || index >= src.pages) throw new Error('Placement refers to a page the converted report does not have.');
            if (!byId.has(p.id)) byId.set(p.id, []);
            byId.get(p.id).push({ page, index, frame: p.frame !== false, box: numBox(p.box) || box0 });
        }
        for (const [id, list] of byId) {
            const src = cacheGet(id);
            const indices = Array.from(new Set(list.map((x) => x.index)));
            const embedded = await out.embedPdf(src.pdf, indices);
            const byIndex = new Map(indices.map((ix, n) => [ix, embedded[n]]));
            for (const pl of list) {
                const target = pages[pl.page - 1];
                const ep = byIndex.get(pl.index);
                const box = pl.box;
                const { width: W, height: H } = target.getSize();
                const bx = box.left * MM, by = box.bottom * MM;
                const bw = W - (box.left + box.right) * MM, bh = H - (box.top + box.bottom) * MM;
                const s = Math.min(bw / ep.width, bh / ep.height);
                const w = ep.width * s, h = ep.height * s;
                if (!pl.frame) {
                    target.drawPage(ep, { x: bx, y: by + bh - h, width: w, height: h });
                    continue;
                }
                const x = bx + (bw - w) / 2, y = by + (bh - h) / 2;
                target.drawPage(ep, { x, y, width: w, height: h });
                target.drawRectangle({ x, y, width: w, height: h, borderColor: rgb(0.72, 0.72, 0.72), borderWidth: 0.5 });
            }
        }
        return Buffer.from(await out.save({ useObjectStreams: true }));
    }

    return { convertMany, stamp, addPdf, _cache: cache, _viaWord: viaWord };
}

module.exports = { createDocxPdf, PS_SCRIPT, fallbackHtml, firstLine, DEFAULT_BOX, extOf };

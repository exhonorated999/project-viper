/* ============================================================================
 * band-ocr.js — ruled-form OCR for scanned RMS reports.  MAIN PROCESS ONLY.
 * ----------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * Some agency RMS forms print the narrative into a ruled grid where a
 * horizontal rule sits directly ON the text baseline of every row.  Tesseract's
 * own line finder merges the rule with the glyphs and the row is destroyed.
 * Measured on a real 9-page Arkansas NIBRS incident report (300 DPI, image-only
 * scan), full-page OCR yielded:
 *
 *     page   1     2     3     4     5     6     7     8     9
 *     chars  6216  2681  3541   476   201  5355  5270  3801   826
 *                              ^^^^  ^^^^  the two narrative pages
 *
 * Pages 4 and 5 are perfectly legible to a human.  No page-segmentation mode
 * fixes them: PSM 6 loses most rows, PSM 3 drops whole paragraphs, PSM 12
 * fragments and reorders.  The sparse label-grid pages are unaffected, which is
 * exactly what you would expect if the rules are the problem.
 *
 * THE FIX
 *
 * Do not ask Tesseract to find the lines.  The rules ARE the lines.  Detect
 * them, slice the page into row bands, crop each band to the text column, and
 * OCR it with PSM 7 (treat as a single text line).  On the reference report
 * this lifts page 4 from 5 usable prose rows to 37 and page 5 from 1 to 23,
 * in document order, at word confidences of 86-95.
 *
 * It also hands the caller something full-page OCR never can: a per-row
 * confidence, and explicit empty rows — which are the paragraph breaks.
 *
 * SCOPE / SAFETY
 *   - This is ADDITIVE.  `extract-pdf-text` in electron-main.js is untouched
 *     and remains the primary path for every RMS format.
 *   - Only runs over a handful of pages, and only when the importer has
 *     already decided the primary read of those pages is degenerate.
 *   - Returns rows verbatim.  It never rewrites, reorders or invents text.
 *     Deciding whether a banded read is good enough to REPLACE a primary read
 *     is the caller's job (see ar-incident-parser.recoverNarrativeBanded).
 *
 * mupdf and tesseract.js are injected rather than required, so this module
 * stays loadable in a plain-node test and electron-main keeps a single
 * dynamic-import site.
 * ==========================================================================*/

'use strict';

const zlib = require('zlib');

/* ---- tunables (px, at DPI below) ------------------------------------- */
const DPI = 300;
const DARK = 128;        // 8-bit gray below this counts as ink
const H_RUN = 900;       // contiguous dark px that make a row a horizontal rule
const V_RUN = 400;       // contiguous dark px that make a column a vertical rule
const MIN_BAND = 26;     // shorter than this is rule noise, not a text row
const MAX_BAND = 1200;   // taller than this is a whole form region, not a row
const MIN_PITCH = 45;    // plausible printed row pitch, low end
const MAX_PITCH = 85;    // ... and high end
const INK_BLANK = 250;   // a band with less ink than this is an empty row
const MAX_PAGES = 6;     // hard cap: each page is ~40 recognize() calls

/* ---- minimal 8-bit grayscale PNG encoder ------------------------------
 * There is no image library in the tree (no sharp/jimp), and mupdf's asPNG()
 * only encodes a whole pixmap.  Encoding is ~30 lines, so we do it here.
 * -------------------------------------------------------------------- */
let CRC_TABLE = null;
function _crcTable() {
    if (CRC_TABLE) return CRC_TABLE;
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        CRC_TABLE[n] = c;
    }
    return CRC_TABLE;
}
function _crc32(buf) {
    const t = _crcTable();
    let crc = -1;
    for (let i = 0; i < buf.length; i++) crc = t[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ -1) >>> 0;
}
function _chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(_crc32(td), 0);
    return Buffer.concat([len, td, crc]);
}
/** gray: Buffer of w*h bytes, row-major. */
function encodeGrayPng(gray, w, h) {
    const stride = w + 1;                       // one filter byte per scanline
    const raw = Buffer.alloc(stride * h);
    for (let y = 0; y < h; y++) {
        raw[y * stride] = 0;                    // filter type 0 (None)
        gray.copy(raw, y * stride + 1, y * w, y * w + w);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;                                // bit depth
    ihdr[9] = 0;                                // colour type 0 = grayscale
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        _chunk('IHDR', ihdr),
        _chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
        _chunk('IEND', Buffer.alloc(0))
    ]);
}

function _median(arr) {
    if (!arr.length) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    return s[s.length >> 1];
}

/* ---- geometry ---------------------------------------------------------- */

/** Rows whose longest contiguous dark run reaches H_RUN, collapsed into rules.
 *  Detection is deliberately STRICT and contiguous: a gap tolerance large
 *  enough to bridge a broken rule also bridges the word gaps of a monospace
 *  text row, and then the band boundary is cut straight through the text. */
function findHorizontalRules(g, w, h) {
    const rules = [];
    const isRule = new Uint8Array(h);
    for (let y = 0; y < h; y++) {
        const off = y * w;
        let run = 0, best = 0;
        for (let x = 0; x < w; x++) {
            if (g[off + x] < DARK) { run++; if (run > best) best = run; }
            else run = 0;
        }
        if (best >= H_RUN) isRule[y] = 1;
    }
    for (let y = 0; y < h; y++) {
        if (!isRule[y]) continue;
        let y2 = y;
        while (y2 + 1 < h && isRule[y2 + 1]) y2++;
        rules.push({ top: y, bot: y2 });
        y = y2;
    }
    return rules;
}

/** Columns with a long contiguous dark run — the table's vertical rules.
 *  No glyph stroke is V_RUN px tall, so there is no need to guard glyphs.
 *  Not used by bandOcrPages (the rules are neutralised per band, which also
 *  catches rules that only span part of the page); kept because it is the
 *  natural probe for "is this page a ruled grid at all". */
function findVerticalRules(g, w, h) {
    const cols = [];
    for (let x = 0; x < w; x++) {
        let run = 0, best = 0;
        for (let y = 0; y < h; y++) {
            if (g[y * w + x] < DARK) { run++; if (run > best) best = run; }
            else run = 0;
        }
        if (best >= V_RUN) cols.push(x);
    }
    return cols;
}

/** Bands between consecutive rules.  Where the scan lost a rule entirely the
 *  gap is a multiple of the printed row pitch, so it is split back into rows
 *  rather than discarded — that is how the charging paragraph on page 5 of the
 *  reference report is recovered.
 *
 *  Splitting at the arithmetic midpoint would cut through glyphs whenever the
 *  merged rows are not evenly distributed (a "NARRATIVE:" header sitting above
 *  its first text row is the common case).  So each nominal boundary is snapped
 *  to the least-inked scanline within SNAP px — the printed gutter between two
 *  rows.  `inkRow` is the per-row ink census of the page; when it is absent the
 *  nominal boundary is used unchanged.
 *
 *  n = floor(span/pitch + 0.6) splits only once the gap reaches ~1.4 rows, so a
 *  single tall row is never cut in half. */
const SNAP = 9;
function bandsFromRules(rules, pitch, inkRow) {
    const bands = [];
    for (let i = 0; i + 1 < rules.length; i++) {
        const top = rules[i].bot + 1;
        const bot = rules[i + 1].top - 1;
        const bh = bot - top + 1;
        if (bh < MIN_BAND || bh > MAX_BAND) continue;
        const span = rules[i + 1].top - rules[i].top;
        const n = pitch > 0 ? Math.max(1, Math.floor(span / pitch + 0.6)) : 1;
        if (n === 1) { bands.push({ top: top, bot: bot, split: false }); continue; }

        const step = bh / n;
        const cuts = [top - 1];
        for (let k = 1; k < n; k++) {
            let at = Math.round(top + k * step);
            if (inkRow) {
                let bestY = at, bestInk = Infinity;
                for (let y = Math.max(top, at - SNAP); y <= Math.min(bot, at + SNAP); y++) {
                    if (inkRow[y] < bestInk) { bestInk = inkRow[y]; bestY = y; }
                }
                at = bestY;
            }
            if (at > cuts[cuts.length - 1] + MIN_BAND / 2) cuts.push(at);
        }
        cuts.push(bot);
        for (let k = 0; k + 1 < cuts.length; k++) {
            bands.push({ top: cuts[k] + 1, bot: cuts[k + 1], split: true });
        }
    }
    return bands;
}

/* ---- main entry -------------------------------------------------------- */

/**
 * @param {object}   opts
 * @param {Buffer}   opts.data       PDF bytes
 * @param {number[]} opts.pages      1-based page numbers
 * @param {object}   opts.mupdf      the mupdf module
 * @param {object}   opts.Tesseract  the tesseract.js default export
 * @returns {Promise<{pages: Object}>} keyed by page number (string):
 *          { width, height, pitch, ruleCount, lines: [{ y, h, conf, text, blank }] }
 */
async function bandOcrPages(opts) {
    const mupdf = opts.mupdf;
    const Tesseract = opts.Tesseract;
    const out = {};

    const wanted = Array.from(new Set((opts.pages || [])
        .map(n => parseInt(n, 10))
        .filter(n => Number.isInteger(n) && n > 0)))
        .sort((a, b) => a - b)
        .slice(0, MAX_PAGES);
    if (!wanted.length) return { pages: out };

    const doc = mupdf.Document.openDocument(opts.data, 'application/pdf');
    const numPages = doc.countPages();

    const worker = await Tesseract.createWorker('eng');
    try {
        // PSM 7 = treat the image as a single text line.  Every band IS one.
        // (In tesseract.js v7 passing this to recognize() is silently ignored.)
        await worker.setParameters({ tessedit_pageseg_mode: '7' });

        for (const pageNo of wanted) {
            if (pageNo > numPages) continue;
            const page = doc.loadPage(pageNo - 1);
            const pm = page.toPixmap(
                mupdf.Matrix.scale(DPI / 72, DPI / 72),
                mupdf.ColorSpace.DeviceGray, false, true);
            const w = pm.getWidth();
            const h = pm.getHeight();
            const px = pm.getPixels();
            const nc = Math.max(1, Math.round(px.length / (w * h)));
            const g = Buffer.alloc(w * h);
            for (let i = 0; i < w * h; i++) g[i] = px[i * nc];

            const rules = findHorizontalRules(g, w, h);
            const gaps = [];
            for (let i = 0; i + 1 < rules.length; i++) gaps.push(rules[i + 1].top - rules[i].top);
            const pitch = _median(gaps.filter(v => v >= MIN_PITCH && v <= MAX_PITCH));

            // per-scanline ink census: used to snap split boundaries into the
            // printed gutter, and to decide which bands are empty rows.
            const inkRow = new Int32Array(h);
            for (let y = 0; y < h; y++) {
                const off = y * w;
                let n = 0;
                for (let x = 0; x < w; x++) if (g[off + x] < DARK) n++;
                inkRow[y] = n;
            }

            // NOTE: do NOT crop to the table border, and do NOT pad with an
            // artificial white margin.  Both were tried and both LOSE TEXT:
            // cropping to the border made "where her sister was present to
            // protect her." OCR to an empty string (confidence 0 vs 95), and a
            // 24px white margin turned "observed Ms Stivers" into "shasrved, MA
            // Stivers" and "made comments" into "made contents".  PSM 7 is
            // sensitive to the band's surrounding context; feed it the row as
            // printed, full width, and only neutralise the rule columns.
            const cw = w;

            const lines = [];
            const bands = bandsFromRules(rules, pitch, inkRow);
            for (const b of bands) {
                if (b.bot < b.top) continue;
                // Ink census decides blank rows without paying for an OCR call.
                let ink = 0;
                for (let y = b.top; y <= b.bot; y++) ink += inkRow[y];
                if (ink < INK_BLANK) {
                    lines.push({ y: b.top, h: b.bot - b.top + 1, conf: 0, text: '', blank: true });
                    continue;
                }

                // A split band has no real rule between it and its neighbour,
                // so padding it would pull in the adjacent row's glyphs.
                const pad = b.split ? 0 : 2;
                const t = Math.max(0, b.top - pad);
                const bt = Math.min(h - 1, b.bot + pad);
                const bh = bt - t + 1;

                const sub = Buffer.alloc(cw * bh);
                g.copy(sub, 0, t * w, (bt + 1) * w);
                // Vertical rules — the table border and the column separators —
                // become white so PSM 7 sees words rather than a run of "|".
                // Without this the leading "[" bleeds into the first word:
                // "Upon arrival" reads as "[open arrival".
                //
                // ONLY the solid core of the rule is erased. Widening this by
                // a 2px halo to also kill the rule's antialiased edge WAS
                // tried: it removed the residual "|" glyphs, and it also made
                // the band carrying "where her sister was present to protect
                // her." read as an empty string at confidence 0 (it reads at
                // 86 with core-only whitening). PSM 7 on a single ruled row is
                // that brittle — every extra erased pixel is a chance to lose
                // a whole line of an officer's narrative. The surviving edge
                // glyphs are stripped textually instead, in
                // ar-incident-parser._stripRuleGlyphs(), where the decision is
                // reversible and auditable.
                for (let x = 0; x < cw; x++) {
                    let dk = 0;
                    for (let y = 0; y < bh; y++) if (sub[y * cw + x] < DARK) dk++;
                    if (dk >= bh - 2) for (let y = 0; y < bh; y++) sub[y * cw + x] = 255;
                }

                let text = '', conf = 0;
                try {
                    const r = await worker.recognize(encodeGrayPng(sub, cw, bh));
                    text = String((r && r.data && r.data.text) || '').replace(/\s+/g, ' ').trim();
                    conf = Math.round((r && r.data && r.data.confidence) || 0);
                } catch (_) { /* a single unreadable band must not kill the page */ }

                lines.push({ y: b.top, h: bh, conf: conf, text: text, blank: !text });
            }

            out[String(pageNo)] = {
                width: w, height: h, pitch: pitch, ruleCount: rules.length,
                lines: lines
            };
        }
    } finally {
        try { await worker.terminate(); } catch (_) { /* ignore */ }
    }

    return { pages: out };
}

module.exports = {
    bandOcrPages,
    // exported for tests
    encodeGrayPng,
    findHorizontalRules,
    findVerticalRules,
    bandsFromRules,
    _consts: { DPI, DARK, H_RUN, V_RUN, MIN_BAND, MAX_BAND, INK_BLANK, MAX_PAGES }
};

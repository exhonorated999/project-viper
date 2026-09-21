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
const INK_RETRY = 2000;  // ... and with more than this it is definitely NOT one
const MAX_PAGES = 6;     // hard cap: each page is ~40 recognize() calls

/* ---- deskew ------------------------------------------------------------
 * A flatbed scan of a stapled report is routinely a fraction of a degree off
 * square, and findHorizontalRules() is STRICTLY contiguous along a scanline,
 * so even a tiny rotation destroys it: on page 4 of the second reference
 * report (Faulkner County, incident 26-0506420) the printed rule drifts 12 px
 * vertically across 1266 px horizontally — 0.54° — and the longest contiguous
 * dark run on ANY scanline of that page falls to 785 px, below H_RUN. The
 * detector found ZERO rules, band OCR returned ZERO rows, and the narrative
 * was lost outright even though the page is perfectly legible to a human.
 *
 * Loosening H_RUN cannot fix that: the rule is not short, it is diagonal.
 * The page has to be squared up first. Skew is estimated by the classic
 * projection-profile method — shear the ink census by a candidate slope and
 * keep the slope whose profile is most peaked (sum of squares) — then the
 * grayscale is resampled once and everything downstream runs unchanged.
 * ---------------------------------------------------------------------- */
const SKEW_STEP = 4;        // subsample factor while searching for the angle
const SKEW_MAX = 0.045;     // widest slope searched, dy/dx (~2.6°)
const SKEW_COARSE = 0.0045; // coarse search step (~0.26°)
const SKEW_FINE = 0.0009;   // fine search step (~0.05°, ≈2px over the page)
const SKEW_MIN = 0.0015;    // below this the page is square enough to leave alone

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

/** Peakedness of the ink profile after shearing by `slope`.  A squared-up
 *  ruled form puts every rule into one profile bin and the score spikes. */
function _skewScore(dk, dw, dh, slope) {
    const pad = Math.ceil(Math.abs(slope) * dw) + 2;
    const prof = new Int32Array(dh + 2 * pad);
    for (let y = 0; y < dh; y++) {
        const row = y * dw;
        for (let x = 0; x < dw; x++) {
            if (!dk[row + x]) continue;
            prof[y - Math.round(slope * x) + pad]++;
        }
    }
    let s = 0;
    for (let i = 0; i < prof.length; i++) s += prof[i] * prof[i];
    return s;
}

/** Estimated skew as a slope dy/dx.  Positive means a printed horizontal rule
 *  descends left-to-right.  Coarse sweep, then a fine sweep around the winner. */
function estimateSkew(g, w, h) {
    const dw = Math.floor(w / SKEW_STEP);
    const dh = Math.floor(h / SKEW_STEP);
    if (dw < 50 || dh < 50) return 0;
    const dk = new Uint8Array(dw * dh);
    for (let y = 0; y < dh; y++) {
        const src = (y * SKEW_STEP) * w;
        const dst = y * dw;
        for (let x = 0; x < dw; x++) dk[dst + x] = g[src + x * SKEW_STEP] < DARK ? 1 : 0;
    }

    let best = 0, bestScore = -1;
    for (let s = -SKEW_MAX; s <= SKEW_MAX + 1e-9; s += SKEW_COARSE) {
        const sc = _skewScore(dk, dw, dh, s);
        if (sc > bestScore) { bestScore = sc; best = s; }
    }
    const lo = best - SKEW_COARSE, hi = best + SKEW_COARSE;
    for (let s = lo; s <= hi + 1e-9; s += SKEW_FINE) {
        const sc = _skewScore(dk, dw, dh, s);
        if (sc > bestScore) { bestScore = sc; best = s; }
    }
    // A page with no ink has no skew. Without this the first candidate angle
    // wins on a score of zero and a blank page is needlessly resampled.
    if (bestScore <= 0) return 0;
    return Math.abs(best) < SKEW_MIN ? 0 : best;
}

/** Resample the grayscale so printed horizontal rules become horizontal.
 *  Output is taller than the input by the drift the shear introduces, so no
 *  row of the page is ever clipped; the extra margin is white.
 *  Nearest-neighbour on purpose: interpolation greys out the 1-2 px rules and
 *  the contiguous-run detector then misses them. */
function deskewGray(g, w, h, slope) {
    const pad = Math.ceil(Math.abs(slope) * w) + 1;
    const ho = h + 2 * pad;
    const out = Buffer.alloc(w * ho, 255);
    for (let x = 0; x < w; x++) {
        const shift = Math.round(slope * x);
        for (let yo = 0; yo < ho; yo++) {
            const sy = yo - pad + shift;
            if (sy < 0 || sy >= h) continue;
            out[yo * w + x] = g[sy * w + x];
        }
    }
    return { gray: out, width: w, height: ho };
}

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
            let h = pm.getHeight();
            const px = pm.getPixels();
            const nc = Math.max(1, Math.round(px.length / (w * h)));
            let g = Buffer.alloc(w * h);
            for (let i = 0; i < w * h; i++) g[i] = px[i * nc];

            // Square the page up first. A 0.5° rotation is invisible to a
            // human and fatal to contiguous-run rule detection.
            const skew = estimateSkew(g, w, h);
            if (skew) {
                const ds = deskewGray(g, w, h, skew);
                g = ds.gray;
                h = ds.height;
            }

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
                const raw = Buffer.from(sub);      // pre-whitening copy, for the retry below
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

                // A well-inked row that comes back as the EMPTY STRING is the
                // whitening misfiring, not a blank row: erasing a column that
                // happens to be dark in almost every scanline of this band can
                // take a glyph stem with it and PSM 7 then refuses the line
                // outright. Measured on page 4 of the Faulkner 26-0506420
                // report, band 22 ("my body-worn camera. Mr. Barber was read
                // his Miranda Rights and he agreed to speak with us. He") came
                // back '' at confidence 0 with whitening and at confidence 95
                // WITHOUT it — a whole line of an officer's narrative.
                //
                // So retry that one band unwhitened. It is only ever reached
                // for a row the first pass already gave up on, so it cannot
                // degrade a row that read. Rows that are genuinely rule noise
                // come back at confidence 0-44 ("Lo]", "- —", "Ee") and are
                // dropped downstream by the caller's confidence gate.
                if (!text && ink >= INK_RETRY) {
                    try {
                        const r2 = await worker.recognize(encodeGrayPng(raw, cw, bh));
                        const t2 = String((r2 && r2.data && r2.data.text) || '').replace(/\s+/g, ' ').trim();
                        if (t2) {
                            text = t2;
                            conf = Math.round((r2 && r2.data && r2.data.confidence) || 0);
                        }
                    } catch (_) { /* ignore */ }
                }

                lines.push({ y: b.top, h: bh, conf: conf, text: text, blank: !text });
            }

            out[String(pageNo)] = {
                width: w, height: h, pitch: pitch, ruleCount: rules.length,
                skew: skew, lines: lines
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
    estimateSkew,
    deskewGray,
    _consts: { DPI, DARK, H_RUN, V_RUN, MIN_BAND, MAX_BAND, INK_BLANK, INK_RETRY, MAX_PAGES, SKEW_MIN, SKEW_MAX }
};

/*
 * band-ocr deskew — unit tests.
 *
 * Run: node modules\rms\__tests__\band-ocr.test.js
 * (no native deps: mupdf and Tesseract are injected by the caller, so the
 * geometry functions are plain-node testable.)
 *
 * WHY THIS EXISTS. Band OCR finds a row boundary by looking for a long
 * CONTIGUOUS run of dark pixels on a SINGLE scanline. A scan rotated by half
 * a degree — invisible to a human — breaks every printed rule across a dozen
 * scanlines, so not one of them clears the run length and the page yields
 * ZERO bands. Measured on a real Arkansas report: the rule on the narrative
 * page drifted 12 px over 1266 px (0.54°), the longest run on any scanline
 * was 785 px against a 900 px threshold, and the officer's entire narrative
 * was lost. Deskew is what makes that page readable.
 */
const path = require('path');
const BO = require(path.join(__dirname, '..', 'band-ocr.js'));

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? ' -> ' + JSON.stringify(x) : '')); } };

const W = 2550, H = 900;
const RULE_X0 = 120, RULE_X1 = 2430;   // 2310 px of rule, well over H_RUN
const ROWS = [120, 200, 280, 360, 440, 520, 600, 680];

/* A synthetic ruled form: full-width horizontal rules, each with a little
 * "text" sitting just above it, optionally rotated by `slope` (dy/dx). */
function makePage(slope) {
    const g = Buffer.alloc(W * H, 255);
    function dark(x, y) {
        if (x < 0 || x >= W || y < 0 || y >= H) return;
        g[y * W + x] = 0;
    }
    ROWS.forEach(function (y0) {
        for (let x = RULE_X0; x <= RULE_X1; x++) {
            const y = y0 + Math.round(slope * x);
            dark(x, y); dark(x, y + 1);
        }
        // glyph-ish ink above the rule so the page is not rules alone
        for (let x = RULE_X0 + 40; x < RULE_X0 + 1400; x += 9) {
            const y = y0 - 18 + Math.round(slope * x);
            for (let dy = 0; dy < 12; dy++) { dark(x, y + dy); dark(x + 1, y + dy); }
        }
    });
    return g;
}

console.log('\n[square page]');
const flat = makePage(0);
ok('a square page reports no skew', BO.estimateSkew(flat, W, H) === 0,
    BO.estimateSkew(flat, W, H));
const flatRules = BO.findHorizontalRules(flat, W, H);
ok('every printed rule is found on a square page', flatRules.length >= ROWS.length,
    flatRules.length);

console.log('\n[skewed page]');
const SLOPE = -0.0095;                 // ~0.54°, the measured real-world case
const skewed = makePage(SLOPE);
const rawRules = BO.findHorizontalRules(skewed, W, H);
ok('a skewed page yields (almost) no rules — this is the bug', rawRules.length <= 1,
    rawRules.length);

const est = BO.estimateSkew(skewed, W, H);
ok('the skew is detected', est !== 0, est);
ok('the skew sign is right', est < 0, est);
ok('the skew magnitude is within 0.002 of the truth',
    Math.abs(est - SLOPE) < 0.002, { est: est, want: SLOPE });

const ds = BO.deskewGray(skewed, W, H, est);
ok('deskew never loses rows', ds.height >= H, { got: ds.height, was: H });
ok('deskew keeps the width', ds.width === W);
ok('deskew returns a buffer of the right size', ds.gray.length === W * ds.height);
const fixedRules = BO.findHorizontalRules(ds.gray, ds.width, ds.height);
ok('the rules come back after deskew', fixedRules.length >= ROWS.length,
    { got: fixedRules.length, want: ROWS.length });

const bands = BO.bandsFromRules(fixedRules, ds.height);
ok('bands are produced from the recovered rules', bands.length >= ROWS.length - 1,
    bands.length);

console.log('\n[opposite rotation]');
const other = makePage(0.008);
const est2 = BO.estimateSkew(other, W, H);
ok('a page rotated the other way is detected too', est2 > 0, est2);
const ds2 = BO.deskewGray(other, W, H, est2);
ok('and its rules come back as well',
    BO.findHorizontalRules(ds2.gray, ds2.width, ds2.height).length >= ROWS.length,
    BO.findHorizontalRules(ds2.gray, ds2.width, ds2.height).length);

console.log('\n[degenerate input]');
ok('a tiny image is left alone', BO.estimateSkew(Buffer.alloc(100, 255), 10, 10) === 0);
ok('a blank page reports no skew', BO.estimateSkew(Buffer.alloc(W * H, 255), W, H) === 0);
ok('deskew with slope 0 is a copy',
    BO.deskewGray(flat, W, H, 0).gray.length >= W * H);

console.log('\n' + (fail ? 'FAILED' : 'OK') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

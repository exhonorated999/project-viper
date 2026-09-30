/*
 * modules/rms/pdf-rows.js — unit tests
 * ------------------------------------
 * Rebuilding a PDF page in reading order from its own positioned text.
 *
 * WHY THIS MATTERS
 * A flattened fillable PDF very often writes every printed form label into the
 * content stream first and the typed-in values afterwards. Extractors that
 * walk the stream in order hand back a page whose labels and values are
 * hundreds of characters apart, with prose in the wrong order. On a real
 * Arkansas incident report (26-0905455) that cost the import the whole victim
 * record and moved the first line of the officer's narrative to the end of it.
 *
 * The arithmetic here is all that stands between those two outcomes, so it is
 * tested on its own, away from any parser. Geometry below is taken from the
 * real report's structured text (values redacted or replaced).
 *
 * Run: node modules\rms\__tests__\pdf-rows.test.js
 */
'use strict';

const path = require('path');
const R = require(path.join(__dirname, '..', 'pdf-rows.js'));

let pass = 0, fail = 0;
const ok = (n, c, x) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? ' -> ' + JSON.stringify(x) : '')); }
};
const eq = (n, a, b) => ok(n, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

/* A structured-text line, the shape MuPDF emits. */
const L = (x, y, w, text) => ({ bbox: { x: x, y: y, w: w, h: 7 }, text: text });
/* A page of them, all in one block. */
const P = (lines) => ({ blocks: [{ type: 'text', lines: lines }] });

/* ================================================================
 * 1. Reading the structured text
 * ================================================================ */
console.log('\n[structured text]');

eq('an empty page yields no items', R.itemsFromStextPage(P([])), []);
eq('a null page yields no items', R.itemsFromStextPage(null), []);
eq('a page with no blocks yields no items', R.itemsFromStextPage({}), []);

ok('a text line becomes a positioned item',
    R.itemsFromStextPage(P([L(45, 54, 53, 'INCIDENT NUMBER')])).length === 1);

eq('position and text come across',
    R.itemsFromStextPage(P([L(45, 54, 53, 'INCIDENT NUMBER')]))[0],
    { x: 45, y: 54, w: 53, h: 7, text: 'INCIDENT NUMBER' });

eq('a blank line is dropped',
    R.itemsFromStextPage(P([L(10, 10, 5, '   '), L(20, 10, 5, 'A')])).map(i => i.text),
    ['A']);

ok('a non-text block is skipped',
    R.itemsFromStextPage({ blocks: [{ type: 'image', bbox: {} }] }).length === 0);

ok('several blocks all contribute',
    R.itemsFromStextPage({
        blocks: [
            { type: 'text', lines: [L(10, 10, 5, 'A')] },
            { type: 'text', lines: [L(30, 10, 5, 'B')] }
        ]
    }).length === 2);

eq('a missing bbox falls back to the line origin',
    R.itemsFromStextPage({ blocks: [{ type: 'text', lines: [{ x: 12, y: 34, text: 'Z' }] }] })[0],
    { x: 12, y: 34, w: 0, h: 0, text: 'Z' });

/* ================================================================
 * 2. Grouping items into printed rows
 * ================================================================ */
console.log('\n[rows]');

eq('items on one baseline are one row',
    R.groupRows([L(100, 50, 10, 'B'), L(10, 50, 10, 'A')].map(o =>
        ({ x: o.bbox.x, y: o.bbox.y, w: o.bbox.w, h: 7, text: o.text })))
        .map(r => r.map(i => i.text)),
    [['A', 'B']]);

eq('a row is read left to right regardless of stream order',
    R.textFromItems(R.itemsFromStextPage(P([
        L(351, 177, 96, 'THIRD'),
        L(45, 177, 51, 'FIRST'),
        L(141, 177, 130, 'SECOND')
    ]))),
    'FIRST  SECOND  THIRD');

eq('a baseline a point or two off is still the same row',
    R.textFromItems(R.itemsFromStextPage(P([
        L(45, 177, 20, 'A'), L(100, 179, 20, 'B')
    ]))),
    'A  B');

eq('a genuinely lower row breaks',
    R.textFromItems(R.itemsFromStextPage(P([
        L(45, 168, 20, 'LABEL'), L(45, 177, 20, 'VALUE')
    ]))),
    'LABEL\nVALUE');

eq('the y tolerance is configurable',
    R.textFromItems(R.itemsFromStextPage(P([
        L(45, 168, 20, 'LABEL'), L(100, 177, 20, 'VALUE')
    ])), { yTol: 20 }),
    'LABEL  VALUE');

eq('no items is an empty page', R.textFromItems([]), '');

/* ================================================================
 * 3. Gaps decide the separator
 * ================================================================
 * The gap is measured from the RIGHT edge of the previous item, so it holds
 * up in a proportional font. Two spaces at a column boundary is what the
 * downstream readers already expect from OCR of the same form.
 */
console.log('\n[gaps]');

eq('touching items are one word',
    R.textFromItems(R.itemsFromStextPage(P([
        L(45, 177, 30, '5-13-'), L(75, 177, 25, '301(2)b1')
    ]))),
    '5-13-301(2)b1');

eq('a normal word gap is one space',
    R.textFromItems(R.itemsFromStextPage(P([
        L(45, 177, 30, 'ALEX'), L(78, 177, 25, 'HILL')
    ]))),
    'ALEX HILL');

eq('a column gap is two spaces',
    R.textFromItems(R.itemsFromStextPage(P([
        L(45, 177, 30, 'ALEX'), L(150, 177, 25, 'HILL')
    ]))),
    'ALEX  HILL');

eq('trailing blank space is trimmed',
    R.textFromItems(R.itemsFromStextPage(P([L(45, 177, 30, 'ALEX   ')]))),
    'ALEX');

/* ================================================================
 * 4. The real failure, reproduced
 * ================================================================
 * Content-stream order on the Arkansas form: the three column LABELS are
 * written first, then the three VALUES. Read in that order the statute, the
 * offence description and the address of offence are unreachable from their
 * labels. Read by position they line up in two rows, which is exactly what
 * the OCR of the scanned version of this form produces.
 */
console.log('\n[the offence row]');

const offenceRow = R.buildPages([P([
    L(45, 168, 30, 'STATUTE'),
    L(141, 168, 76, 'OFFENSE DESCRIPTION'),
    L(351, 168, 80, 'ADDRESS OF OFFENSE'),
    L(45, 177, 51, '5-13-301(2)b1'),
    L(141, 177, 130, 'TERRORISTIC THREATENING - 2ND DEGREE / THRE'),
    L(351, 177, 96, '36 N CORAN DR, CONWAY, AR 72032')
])]);

eq('the page rebuilds as label row then value row',
    offenceRow[0],
    'STATUTE  OFFENSE DESCRIPTION  ADDRESS OF OFFENSE\n' +
    '5-13-301(2)b1  TERRORISTIC THREATENING - 2ND DEGREE / THRE  36 N CORAN DR, CONWAY, AR 72032');

ok('each value sits under its own label',
    offenceRow[0].split('\n')[1].split(/\s{2,}/).length === 3);

/* Prose out of order is the other half of the same defect: the officer's
 * first line was written to the stream last, so it arrived at the end of
 * the narrative. */
console.log('\n[narrative order]');

const narrative = R.buildPages([P([
    L(60, 255, 400, 'Mrs. Juarez called to report a message.'),
    L(60, 265, 400, 'She was given her report number.'),
    L(60, 216, 60, 'NARRATIVE:'),
    L(60, 225, 400, '09/18/26 I took a call for service.')
])]);

eq('the narrative comes back in the order it was printed',
    narrative[0],
    'NARRATIVE:\n' +
    '09/18/26 I took a call for service.\n' +
    'Mrs. Juarez called to report a message.\n' +
    'She was given her report number.');

/* ================================================================
 * 5. When NOT to use the rebuild
 * ================================================================
 * This is the whole safety story. Every Arkansas report validated in the
 * field so far is a pure scan with no text layer at all, and those must keep
 * going to OCR exactly as they do today.
 */
console.log('\n[safety gate]');

const good = ['x'.repeat(500)];

ok('a scan rebuilds to nothing and is refused',
    R.isUsable(R.buildPages([P([])]), 'whatever the extractor read') === false);

ok('an empty list is refused', R.isUsable([], 'abc') === false);

ok('a thin rebuild is refused',
    R.isUsable(['ONLY A HANDFUL OF CHARACTERS'], 'x'.repeat(5000)) === false);

ok('a full rebuild of the same content is accepted',
    R.isUsable(good, 'x'.repeat(500)) === true);

ok('a rebuild that LOST content is refused',
    R.isUsable(['x'.repeat(500)], 'x'.repeat(5000)) === false);

ok('a rebuild that gained content is accepted',
    R.isUsable(['x'.repeat(900)], 'x'.repeat(500)) === true);

ok('a trivial loss is tolerated',
    R.isUsable(['x'.repeat(995)], 'x'.repeat(1000)) === true);

ok('punctuation is not counted as content',
    R.isUsable(['.'.repeat(5000)], 'abc') === false);

ok('no original text to compare against still needs bulk',
    R.isUsable(good, '') === true);

ok('the minimum is configurable',
    R.isUsable(['SHORT BUT REAL'], '', { minChars: 5 }) === true);

/* ================================================================
 * 6. Robustness
 * ================================================================ */
console.log('\n[robustness]');

eq('a null document rebuilds to nothing', R.buildPages(null), []);
eq('a null page inside a document is an empty string', R.buildPages([null]), ['']);
eq('page order is preserved',
    R.buildPages([P([L(0, 0, 5, 'ONE')]), P([L(0, 0, 5, 'TWO')])]),
    ['ONE', 'TWO']);
ok('a non-numeric coordinate does not throw',
    typeof R.textFromItems(R.itemsFromStextPage(
        { blocks: [{ type: 'text', lines: [{ bbox: { x: 'x', y: null }, text: 'A' }] }] })) === 'string');

console.log('\n' + (fail === 0
    ? 'OK — ' + pass + ' passed, 0 failed'
    : 'FAILURES — ' + pass + ' passed, ' + fail + ' failed'));
process.exit(fail === 0 ? 0 : 1);

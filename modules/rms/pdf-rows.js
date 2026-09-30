/*
 * pdf-rows.js — rebuild a PDF page's text in VISUAL order from positioned
 * text items.
 *
 * WHY THIS EXISTS
 * ---------------
 * A fillable PDF that has been flattened (printed to PDF, e-filed, exported
 * from an RMS) very often writes its static form labels into the content
 * stream first and the typed-in values afterwards.  Every text extractor that
 * walks the content stream in order — pdf-parse and MuPDF's own asText()
 * both do — therefore hands back a page that reads:
 *
 *      NAME:   DATE OF BIRTH:   ADDRESS:   ... (every label on the page)
 *      JUAREZ, STACY ANN   09/16/1978   36 N CORAN DR ...
 *
 * The labels and their values are separated by hundreds of characters, so a
 * label->value reader finds nothing, and any prose on the page comes out with
 * its paragraphs in the wrong order.  On a real Arkansas incident report this
 * cost the importer the entire victim record and moved the first line of the
 * officer's narrative to the end of it.
 *
 * Scanned documents never have this problem: they have no text layer at all,
 * so they go to OCR, and OCR reads the page the way a person does — left to
 * right, top to bottom.  This module puts a digital page back into that same
 * shape, so the existing format readers see exactly what they already handle.
 *
 * It is deliberately pure and format-agnostic: give it positioned items, get
 * back rows.  It knows nothing about any particular agency's form.
 */
(function (root, factory) {
    'use strict';
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.PdfRows = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // All measurements are in PDF points (1/72"). Body text on the forms we
    // have measured is 6-9pt, so a line's glyphs share a baseline to within a
    // point or two; 4pt keeps a row together without merging two printed rows.
    var Y_TOL = 4;

    // Two items on the same row that all but touch are one word that the
    // extractor happened to split (a font change mid-word, say).
    var GAP_SAME_WORD = 1.2;

    // A normal inter-word gap. Anything wider is a column boundary, and gets
    // two spaces so a reader downstream can still see the seam if it wants to.
    var GAP_SAME_CELL = 5;

    function _finite(v, dflt) {
        var n = typeof v === 'number' ? v : parseFloat(v);
        return isFinite(n) ? n : dflt;
    }

    /*
     * Flatten one page of MuPDF structured-text JSON into positioned items.
     * Shape: { blocks: [ { type: 'text', lines: [ { bbox:{x,y,w,h}, text } ] } ] }
     * Non-text blocks (images) carry no text and are skipped.
     */
    function itemsFromStextPage(page) {
        var out = [];
        if (!page || !page.blocks || !page.blocks.length) return out;
        for (var b = 0; b < page.blocks.length; b++) {
            var block = page.blocks[b];
            if (!block || !block.lines || !block.lines.length) continue;
            for (var l = 0; l < block.lines.length; l++) {
                var line = block.lines[l];
                if (!line) continue;
                var text = String(line.text == null ? '' : line.text);
                if (!text.trim()) continue;
                var bbox = line.bbox || {};
                out.push({
                    x: _finite(bbox.x, _finite(line.x, 0)),
                    y: _finite(bbox.y, _finite(line.y, 0)),
                    w: _finite(bbox.w, 0),
                    h: _finite(bbox.h, 0),
                    text: text
                });
            }
        }
        return out;
    }

    /*
     * Group positioned items into visual rows: sort top-to-bottom, then break a
     * row whenever an item's top edge drops more than Y_TOL below the row's.
     * Within a row, sort left-to-right.
     */
    function groupRows(items, opts) {
        var tol = (opts && _finite(opts.yTol, Y_TOL)) || Y_TOL;
        var sorted = (items || []).slice().sort(function (a, b) {
            if (a.y !== b.y) return a.y - b.y;
            return a.x - b.x;
        });
        var rows = [];
        var cur = null;
        var curY = 0;
        for (var i = 0; i < sorted.length; i++) {
            var it = sorted[i];
            if (!cur || Math.abs(it.y - curY) > tol) {
                cur = [];
                curY = it.y;
                rows.push(cur);
            }
            cur.push(it);
        }
        for (var r = 0; r < rows.length; r++) {
            rows[r].sort(function (a, b) { return a.x - b.x; });
        }
        return rows;
    }

    /*
     * Join one row's items back into a string, using the horizontal gap between
     * them to decide the separator. The gap is measured from the right edge of
     * the previous item, so it survives proportional fonts.
     */
    function joinRow(row, opts) {
        var sameWord = (opts && _finite(opts.gapSameWord, GAP_SAME_WORD));
        var sameCell = (opts && _finite(opts.gapSameCell, GAP_SAME_CELL));
        if (!isFinite(sameWord)) sameWord = GAP_SAME_WORD;
        if (!isFinite(sameCell)) sameCell = GAP_SAME_CELL;

        var parts = [];
        var prevRight = null;
        for (var i = 0; i < row.length; i++) {
            var it = row[i];
            var text = String(it.text || '');
            if (prevRight !== null) {
                var gap = it.x - prevRight;
                if (gap <= sameWord) {
                    // touching — one word the extractor split
                    if (/\s$/.test(parts[parts.length - 1] || '') || /^\s/.test(text)) {
                        parts.push('');
                    }
                } else if (gap <= sameCell) {
                    parts.push(' ');
                } else {
                    parts.push('  ');   // column boundary
                }
            }
            parts.push(text);
            prevRight = it.x + it.w;
        }
        return parts.join('').replace(/[ \t]+$/, '');
    }

    function textFromItems(items, opts) {
        var rows = groupRows(items, opts);
        var lines = [];
        for (var i = 0; i < rows.length; i++) {
            var s = joinRow(rows[i], opts);
            if (s.trim()) lines.push(s);
        }
        return lines.join('\n');
    }

    /* Rebuild every page of a structured-text document. */
    function buildPages(stextPages, opts) {
        var out = [];
        for (var i = 0; i < (stextPages || []).length; i++) {
            out.push(textFromItems(itemsFromStextPage(stextPages[i]), opts));
        }
        return out;
    }

    function _alnum(s) {
        var m = String(s == null ? '' : s).match(/[A-Za-z0-9]/g);
        return m ? m.length : 0;
    }

    /*
     * Decide whether a rebuild is safe to use in place of the extractor's own
     * text.
     *
     * Two things have to be true. The page must actually HAVE a text layer —
     * a scan rebuilds to nothing, and every Arkansas report validated in the
     * field so far is a pure scan, so those must fall straight through to the
     * existing OCR path untouched. And the rebuild must not have LOST
     * anything: re-ordering rows can only ever move characters around, so if
     * the alphanumeric count drops, something went wrong and the original
     * text is the safer read.
     */
    function isUsable(rebuiltPages, originalText, opts) {
        var minChars = (opts && _finite(opts.minChars, 400)) || 400;
        var joined = (rebuiltPages || []).join('\n');
        var got = _alnum(joined);
        if (got < minChars) return false;
        var had = _alnum(originalText);
        if (had && got < had * 0.98) return false;
        return true;
    }

    return {
        Y_TOL: Y_TOL,
        GAP_SAME_WORD: GAP_SAME_WORD,
        GAP_SAME_CELL: GAP_SAME_CELL,
        itemsFromStextPage: itemsFromStextPage,
        groupRows: groupRows,
        joinRow: joinRow,
        textFromItems: textFromItems,
        buildPages: buildPages,
        isUsable: isUsable
    };
}));

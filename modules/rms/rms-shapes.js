/*
 * V.I.P.E.R. — shared RMS shape primitives
 * ----------------------------------------
 * The format-INDEPENDENT half of RMS parsing: the things that are true about a
 * driver's licence number, a date of birth, a street address or a paragraph of
 * an officer's prose no matter which agency's form they were printed on.
 *
 * WHY THIS FILE EXISTS
 *
 * These functions were written inside the Arkansas NIBRS parser, one OCR defect
 * at a time, against real scans. Its own source note said where it was heading:
 *
 *     "...these are read by TOKEN SHAPE, not by column position. That also
 *      makes the reader indifferent to which agency's form it is looking at,
 *      which is where this is all heading."
 *
 * The generic (format-agnostic) extractor needs exactly the same judgements.
 * Two readers with their own private idea of what a licence number looks like
 * will eventually disagree about the same token on the same page, and in a
 * forensic tool that is a defect you cannot explain to a court. So there is one
 * copy, here, and both readers call it.
 *
 * THE CENTRAL RULE these primitives serve:
 *
 *     The label finds the neighbourhood. The shape finds the value.
 *
 * Label-alone fails because OCR (PSM 6) left-packs a ruled form row: five
 * labels over three values do not line up, so column position is a lie.
 * Shape-alone fails because a ten-digit number is a phone OR a licence, and
 * 01/15/1988 is a date of birth OR an offense date. Every harvest therefore
 * finds a label, opens a small window, and picks the token whose SHAPE fits
 * the type that label promised.
 *
 * STANDING EVIDENTIARY RULES (decided with the examiner — do not relax):
 *   - Checkbox fields are never interpreted. A filled box OCRs as Il/IE/Bl/H/Ml
 *     and an empty one as [J/[]/[1/O/LJ, often indistinguishably. Any value
 *     derived from one would be a guess presented as fact.
 *   - Names are verbatim, alias tokens included.
 *   - Nothing is inferred. A blank field beats a guessed one, always.
 *
 * UMD: window.RmsShapes in the renderer, module.exports in plain Node.
 * Pure — no Electron, no DOM, no filesystem.
 */
(function (root, factory) {
    'use strict';
    var api = factory();
    if (typeof module === 'object' && module && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.RmsShapes = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    /* ================================================================
     * Regex vocabulary
     * ================================================================ */
    var RE_PAGE_BREAK = /^\W{0,3}(INCIDENT\s+REPORT|CONTINUATION\s+PAGE)\W{0,3}$/i;
    var RE_PAGE_HEADER = /\d{1,2}\/\d{1,2}\/\d{4}\s*\|?\s*\d{2}-\d{6,8}/;
    var RE_DATE = /(?<!\d)(\d{1,2}\/\d{1,2}\/\d{4})(?!\d)/;
    var RE_DATE_G = /(?<!\d)(\d{1,2}\/\d{1,2}\/\d{4})(?!\d)/g;
    var RE_TIME_G = /(?<![\d:])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/g;
    var RE_PHONE = /(?<!\d)\(?(\d{3})\)?[\s.\-]{0,3}(\d{3})[\s.\-]{1,3}(\d{4})(?!\d)/;
    var RE_DAY = /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun)\b/i;

    /* Street address ending in a 2-letter state and a 5(+4) ZIP. */
    var RE_ADDR_ZIP = /(\d+[A-Za-z]?\s+[A-Za-z0-9][A-Za-z0-9 .,'#\/\-]*?\b[A-Z]{2}\b\.?\s*,?\s*(?<!\d)\d{5}(?:-\d{4})?(?!\d))/;
    /* Street address with no ZIP (used only under an ADDRESS label). */
    var RE_ADDR_NOZIP = /(\d+[A-Za-z]?\s+[A-Za-z0-9][A-Za-z0-9 .,'#\/\-]*?,\s*[A-Za-z][A-Za-z .'\-]+,\s*[A-Z]{2})\b/;

    /* ---------------- identity band (DL / SSN / employment) ---------------- */
    var RE_SSN = /(?<!\d)(\d{3}-\d{2}-\d{4})(?!\d)/;
    var RE_DL_LABEL = /DRIVER.{0,2}S\s*LICEN[CS]E|\bDLN?\b|\bOLN\b/i;
    var RE_SSN_LABEL = /\bSSN\b|SOC\.?\s*SEC/i;
    var RE_DL_STATE_LABEL = /DR\.?\s*L[IL1]\.?\s*STATE|LICEN[CS]E\s*STATE/i;

    var US_STATE = {};
    ('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE ' +
     'NV NH NJ NM NY NC ND OH OK OR PA PR RI SC SD TN TX UT VT VA WA WV WI WY')
        .split(/\s+/).forEach(function (s) { US_STATE[s] = true; });

    /* Tokens that must never be absorbed into a name. Form labels, checkbox
     * glyphs and NIBRS code words all live on the same OCR line as the value. */
    var NAME_STOP = {};
    ('SEX AGE RACE ETHNIC DOB SSN SOC NO UNK MALE FEMALE WHITE BLACK ASIAN PACIFIC ISLANDER ' +
     'AMERICAN INDIAN UNKNOWN NONHISPANIC HISPANIC NONHISP RESIDENT NONRESIDENT NONRES ' +
     'ADDRESS STREET CITY STATE ZIP PHONE EMPL EMPLOY EMPLOYT EMPLOYMENT SCHOOL NAME LAST ' +
     'FIRST MIDDLE EXACT DATE BIRTH OCCUPATION PLACE AKA STATUS ARRESTEE OFFENDER VICTIM ' +
     'WITNESS WITNESSES COMPLNT COMPLAINANT CODE INCIDENT REPORT PAGE ORI TYPE MULT ARREST ' +
     'INDIC DISPOSITION JUVENILE WEAPONS HEIGHT WEIGHT BUILD HAIR COLOR STYLE LENGTH EYE ' +
     'SKIN TONE UCR ARR OFFENSE TRANSACT RANGE YRS OLD COUNT HANDLED WITHIN DEPARTMENT ' +
     'REFERRED OUTSIDE SUMMONS CITED TAKEN INTO CUST VIEW MULTIPLE DRIVER LICENSE NARRATIVE ' +
     'OTHERS INVOLVED CONTINUATION SUPERVISOR APPROVING APPROVED DISPATCHER RECEIVED ARRIVED ' +
     'REPORTING AREA EXCEPT CLEAR BIAS MOTIVATED CRIME NONE INJURY TOTAL NUMBER VALUE ' +
     'PROPERTY VEHICLES STOLEN RECOVERED SEIZED LOSS DESCRIPTION SERIAL MAKE MODEL PRIMARY ' +
     'ITEM RECOV YEAR STYLE VIN LICENSE SECOND SOLID DISPOSITION IMPOUNDED RELEASED OWNER ' +
     'DRUG QUANTITY MEASUREMENT WEIGHT CAPACITY UNITS GRAM KILOGRAM OUNCE POUND LITER GALLON')
        .split(/\s+/).forEach(function (w) { NAME_STOP[w] = true; });

    /* ---------------- paragraph shaping ---------------- */
    var RE_SENTENCE_END = /[.!?][)"'\u2019\u201d]?$/;
    var RE_ABBREV_END = /(?:^|\s)(?:mr|mrs|ms|dr|prof|det|sgt|lt|cpl|ofc|jr|sr|st|ave|rd|blvd|ln|apt|ste|dept|approx|est|no|vs|etc|inc|co|corp|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|[a-z])\.$/i;
    var RE_SENTENCE_START = /^["'(\u201c\u2018]?[A-Z0-9]/;

    /* ================================================================
     * Line hygiene
     * ================================================================ */
    function _lines(text) {
        return String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    }

    /* Strip the OCR gutter noise that bleeds in from the vertical band labels
     * ("= ABERNATHY (JV1), GRAYSON", "&) 08/13/2026 ..."). Only non-alphanumeric
     * leading characters are removed, so no real value can be lost. */
    function _strip(line) {
        return String(line == null ? '' : line)
            .replace(/^[^A-Za-z0-9(]{0,8}/, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function _clean(s) {
        return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    }

    function _fmtPhone(line) {
        var m = RE_PHONE.exec(String(line == null ? '' : line));
        if (!m) return '';
        return '(' + m[1] + ') ' + m[2] + '-' + m[3];
    }

    function _isPageBreak(line) {
        return RE_PAGE_BREAK.test(_clean(line));
    }

    /* Find the index of the first line matching a predicate within a range. */
    function _findLine(lines, re, from, to) {
        var lo = from == null ? 0 : from;
        var hi = to == null ? lines.length : to;
        for (var i = lo; i < hi; i++) {
            if (re.test(lines[i])) return i;
        }
        return -1;
    }

    /* ================================================================
     * Prose detection
     * ================================================================ */

    /* Prose test — used to keep narrative text and to keep label grids out of it. */
    function _isProse(line) {
        var s = _clean(line);
        if (s.length < 30) return false;
        if (/\[\s*[A-Za-z0-9|]{0,3}\]|\[[JjOo0-9IilMm|]/.test(s)) return false;
        var words = s.split(/\s+/).filter(function (w) { return /[A-Za-z]/.test(w); });
        if (words.length < 5) return false;
        var lower = (s.match(/[a-z]/g) || []).length;
        var alpha = (s.match(/[A-Za-z]/g) || []).length;
        return alpha > 0 && lower / alpha > 0.45;
    }

    /* Looser than _isProse: has to admit a two-word closing line such as
     * "with it." while still rejecting label grids, stray single words left
     * over from a scrambled wrap ("Marchetti", "First,") and form furniture
     * ("PAGE #", "INCIDENT NUMBER", "DEEZ =="). */
    function _isNarrativeFragment(line) {
        var s = _clean(line);
        if (s.length < 5 || s.length > 300) return false;
        if (/\[\s*[A-Za-z0-9|]{0,3}\]|\[[JjOo0-9IilMm|]/.test(s)) return false;
        var words = s.split(/\s+/).filter(function (w) { return /[A-Za-z]{2,}/.test(w); });
        if (words.length < 2) return false;
        if (words.length < 4 && !RE_SENTENCE_END.test(s)) return false;
        var lower = (s.match(/[a-z]/g) || []).length;
        var alpha = (s.match(/[A-Za-z]/g) || []).length;
        return alpha > 0 && lower / alpha > 0.5;
    }

    /* Is a narrative body actually readable, or is it OCR wreckage?
     * A ruled grid that has defeated OCR yields rows like "EE", "-—", "A PTA",
     * "Ce ——" — none of which is a sentence. A genuinely short narrative is
     * short but READABLE, so "one good line among twenty" is the failure
     * signature, not a terse officer. */
    function _bodyIsReadable(body) {
        var good = 0;
        for (var i = 0; i < body.length; i++) {
            if (_isProse(body[i]) || _isNarrativeFragment(body[i])) good++;
        }
        if (!good) return false;
        return good >= 2 || body.length <= 3;
    }

    /* Share of a page's lines that carry no readable word at all. Used only to
     * PRIORITISE pages for a banded re-read when the primary pass produced no
     * narrative whatsoever — the most damaged page is the likeliest narrative
     * page, because the narrative is the only part of these forms printed as
     * continuous prose over a ruled grid. */
    function _junkRatio(lines) {
        var nonEmpty = 0, junk = 0;
        for (var i = 0; i < lines.length; i++) {
            var s = _clean(lines[i]);
            if (!s) continue;
            if (RE_PAGE_HEADER.test(s)) continue;
            nonEmpty++;
            var words = s.match(/[A-Za-z]{3,}/g) || [];
            if (words.length < 2) junk++;
        }
        return nonEmpty ? junk / nonEmpty : 0;
    }

    /* Preserve printed line breaks verbatim; insert a blank line ONLY where a
     * line ends a sentence and the next one starts one. Never re-wraps. */
    function _paragraphize(body) {
        var out = [];
        for (var i = 0; i < body.length; i++) {
            out.push(body[i]);
            if (i === body.length - 1) break;
            var cur = body[i], nxt = body[i + 1];
            if (!RE_SENTENCE_END.test(cur)) continue;
            if (RE_ABBREV_END.test(cur)) continue;
            if (!RE_SENTENCE_START.test(nxt)) continue;
            out.push('');
        }
        return out.join('\n');
    }

    /* ================================================================
     * Name extraction
     * ================================================================ */
    function _isNameToken(tok) {
        if (!tok) return false;
        if (/^\([A-Za-z]{1,4}\d{0,3}\)$/.test(tok)) return true;       // (JV2), (JR)
        if (!/^[A-Z][A-Za-z'\u2019\-.]*$/.test(tok)) return false;      // must start upper
        var bare = tok.replace(/[^A-Za-z]/g, '').toUpperCase();
        if (!bare) return false;
        if (NAME_STOP[bare]) return false;
        if (bare.length === 1) return /\.$/.test(tok);                  // initial needs a dot
        if (bare.length === 2 && tok.indexOf('.') === -1) return false; // rejects IH, Bl, OJ, LJ
        return true;
    }

    /* A middle initial is printed WITHOUT a full stop on these forms
     * ("WINN, WESTON Z"), so _isNameToken rejects it and the initial was
     * being dropped from every imported name. It is worth recovering — the
     * initial is often the only thing separating two relatives on the same
     * report — but a lone capital is also exactly how OCR renders a ticked
     * checkbox, so it is taken only in the one position where it cannot be
     * anything else: directly after a given name, and not followed by the
     * parenthesised option code that always trails a checkbox glyph
     * ("I (0) Male", "J (M) Male", "[J (00) Unknown"). */
    function _isMiddleInitial(tok, next) {
        if (!/^[A-Z]$/.test(String(tok == null ? '' : tok))) return false;
        if (/^\(/.test(String(next == null ? '' : next))) return false;
        return true;
    }

    /*
     * Pull a "Last[ (ALIAS)], First [Middle...]" name out of an OCR line that
     * also carries checkbox junk. Walks outward from each candidate comma and
     * stops at the first token that is not a name token, so
     *   "VANDERLINDE (JV3), EMMETT £5 (F) Female OJ 0) Unknown"  ->  "VANDERLINDE (JV3), EMMETT"
     *   "HOLLOWAY (JV2), MARISOL 08/31/2011"                 ->  "HOLLOWAY (JV2), MARISOL"
     *   "148 RODEN MILL RD, Conway, AR 72032"               ->  null
     */
    function _extractName(line) {
        var s = _strip(line);
        if (!s || s.indexOf(',') === -1) return null;
        var toks = s.split(' ');
        for (var c = 0; c < toks.length; c++) {
            if (toks[c].slice(-1) !== ',') continue;
            var head = toks[c].slice(0, -1);
            if (!_isNameToken(head)) continue;

            // walk left for additional surname tokens
            var left = [head];
            for (var i = c - 1; i >= 0; i--) {
                if (!_isNameToken(toks[i])) break;
                left.unshift(toks[i]);
            }
            // walk right for given / middle names
            var right = [];
            for (var j = c + 1; j < toks.length && right.length < 4; j++) {
                if (_isNameToken(toks[j])) { right.push(toks[j]); continue; }
                if (right.length && _isMiddleInitial(toks[j], toks[j + 1])) {
                    right.push(toks[j]);
                }
                break;
            }
            if (!right.length) continue;

            // Reject "STREET, City, ST" shapes: the surname side must not be a
            // lone 2-letter token and the given side must have real letters.
            var name = left.join(' ') + ', ' + right.join(' ');
            if (!/[A-Za-z]{2}/.test(right[0])) continue;
            return name;
        }
        return null;
    }

    /* Juvenile / AKA alias printed inside the name field, kept as metadata only. */
    function _aliasOf(name) {
        var m = /\(([A-Za-z]{1,4}\d{0,3})\)/.exec(String(name || ''));
        return m ? m[1] : '';
    }

    /* ================================================================
     * Address
     * ================================================================ */

    /* A person band prints the one-digit sequence column immediately to the
     * left of the address, and PSM 6 packs the row so the two run together:
     * "1 164 S COKER RD, Vilonia, AR 72173". Strip that column only when doing
     * so still leaves a street number behind — "1 Main St" is a real address
     * and must survive untouched. */
    function _stripLeadingColumnDigit(addr) {
        var m = /^(\d{1,2})\s+(\d.*)$/.exec(addr);
        return m ? m[2] : addr;
    }

    /* Scan a window for a resident address, skipping the two rows that follow
     * an ARREST LOCATION label (that address is where the arrest happened, not
     * where the person lives). */
    function _scanAddress(lines, from, to, blockEnd) {
        var skipUntil = -1;
        for (var i = Math.max(0, from); i < Math.min(to, lines.length); i++) {
            if (/ARREST\s*LOCATION/i.test(lines[i])) { skipUntil = i + 2; continue; }
            if (i <= skipUntil) continue;
            var m = RE_ADDR_ZIP.exec(lines[i]) || RE_ADDR_NOZIP.exec(lines[i]);
            if (m) return _stripLeadingColumnDigit(_clean(m[1]));
        }
        return '';
    }

    /* ================================================================
     * Identity tokens — the 5.2.4 shape core
     * ================================================================ */

    /* Tokenise a value row, keeping phones and SSNs whole. */
    function _identityTokens(line) {
        var s = _clean(line);
        if (!s) return [];
        // Fold "(501) 472-5938" into one token so the area code is not read as
        // a licence number.
        s = s.replace(/\((\d{3})\)\s*(\d{3})[\s.\-]?(\d{4})/g, '($1)$2-$3');
        return s.split(/\s+/);
    }

    function _looksLikeDlNumber(tok) {
        var t = String(tok || '').replace(/[^A-Za-z0-9]/g, '');
        if (t.length < 5 || t.length > 13) return false;
        if (!/\d/.test(t)) return false;              // must carry digits
        if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(tok)) return false;
        if (RE_SSN.test(tok)) return false;
        if (/^\(\d{3}\)/.test(tok)) return false;
        if (/^\d{5}(-\d{4})?$/.test(t)) return false; // ZIP
        if (/^\d{2}-\d{6,8}$/.test(tok)) return false; // incident number
        return /^[A-Za-z0-9]+$/.test(t);
    }

    /* A standalone 2-letter US state token (never one carrying a digit). */
    function _stateTokenAt(toks) {
        for (var s = 0; s < toks.length; s++) {
            var bare = toks[s].replace(/[^A-Za-z]/g, '').toUpperCase();
            if (bare.length === 2 && US_STATE[bare] && !/\d/.test(toks[s])) return s;
        }
        return -1;
    }

    /*
     * Read the identity values that sit under a DRIVER'S LICENSE / SSN label
     * row. `labelIdx` is the label row; values are on the next non-empty rows
     * (the reference document has a stray "=" row between them).
     *
     * Returns only what it is sure of. A wrong licence number on a person is
     * worse than a blank one.
     */
    function _harvestIdentityRow(lines, labelIdx, to, person) {
        var label = _clean(lines[labelIdx]);
        var wantsDl = RE_DL_LABEL.test(label) || RE_DL_STATE_LABEL.test(label);
        var wantsSsn = RE_SSN_LABEL.test(label);
        // Two phone labels on this row, in printed order, means the first
        // phone is the resident's and the second is the employer's.
        var twoPhones = /RESIDENT\s*PHONE/i.test(label) && /EMPLOY/i.test(label);

        var scanned = 0;
        for (var i = labelIdx + 1; i < to && scanned < 3; i++) {
            var toks = _identityTokens(lines[i]);
            if (!toks.length) continue;
            // A row of one or two punctuation glyphs is the ruled grid, not data
            var meat = toks.filter(function (t) { return /[A-Za-z0-9]/.test(t); });
            if (!meat.length) continue;
            scanned++;
            if (_isPageBreak(lines[i]) || RE_DL_LABEL.test(_clean(lines[i]))) break;

            if (wantsSsn && !person.ssn) {
                var ms = RE_SSN.exec(lines[i]);
                if (ms) person.ssn = ms[1];
            }

            // State code, then the licence number immediately to its left.
            var stateAt = _stateTokenAt(toks);
            if (wantsDl && stateAt > 0 && !person.dl) {
                for (var d = stateAt - 1; d >= 0; d--) {
                    if (!/[A-Za-z0-9]/.test(toks[d])) continue;
                    if (_looksLikeDlNumber(toks[d])) {
                        person.dl = toks[d].replace(/[^A-Za-z0-9]/g, '');
                        /* The 2-letter token sitting immediately right of the
                         * number IS the DR. LI. STATE cell — that is the printed
                         * column order on every one of these forms. Taken even
                         * when the state label itself was shredded by OCR,
                         * because a licence number without its jurisdiction is
                         * half a fact. Never inferred from the address. */
                        person.dlState = toks[stateAt].replace(/[^A-Za-z]/g, '').toUpperCase();
                    }
                    break;      // only the token immediately left of the state
                }
            }

            if (twoPhones) {
                var ph = [];
                for (var p = 0; p < toks.length; p++) {
                    var f = _fmtPhone(toks[p]);
                    if (f && ph.indexOf(f) === -1) ph.push(f);
                }
                if (!person.phone && ph[0]) person.phone = ph[0];
                // Only claim an employment phone when a SECOND number is
                // actually printed. One number under two labels is ambiguous,
                // and a wrong employer phone in a case file is not recoverable.
                if (!person.employmentPhone && ph[1]) person.employmentPhone = ph[1];
            }
        }
    }

    /* ================================================================
     * Page splitting
     * ================================================================ */

    /*
     * Page 1's title is usually embedded in a grid and never survives OCR as a
     * standalone line, so page 1 starts at index 0 and every later page is
     * introduced by a standalone banner. Ordinal index therefore equals the
     * PDF page.
     *
     * ...except when it doesn't. That inference is only as good as the OCR of
     * one printed banner. On a Faulkner scan where the title is a rotated
     * left-margin element it came through as punctuation, so a NINE page PDF
     * yielded four markers and five logical pages: the arrestee block landed on
     * "page 1" together with the victim, sparse name recovery was pointed at
     * page 1 instead of page 2, and the banded narrative re-read was pointed at
     * pages 1-3 instead of 4-5 (narrative length: zero).
     *
     * So when the caller can supply the REAL per-page text — `extract-pdf-text`
     * returns `pages[]` — use it and stop guessing. The banner inference stays
     * as the fallback for callers that only have a flat string.
     *
     * Returns { pages, bounds, warning, authoritative }.
     */
    function _splitPages(lines, pageTexts, isPageBreak) {
        var breakTest = typeof isPageBreak === 'function' ? isPageBreak : _isPageBreak;
        if (pageTexts && pageTexts.length) {
            var auth = _pagesFromTexts(lines, pageTexts);
            if (auth) return auth;
            // Page array did not reconcile with the text we were given. A page
            // array we can't line up is worse than none — fall through to the
            // banner inference and say so.
            var inferred = _pagesFromBanners(lines, breakTest);
            inferred.warning = 'Page boundaries reported by the PDF reader did not ' +
                'match the extracted text, so page numbers were inferred from the ' +
                'printed page banners instead. Page-specific notes below may be off by a page.';
            return inferred;
        }
        return _pagesFromBanners(lines, breakTest);
    }

    /* Build pages directly from the extractor's per-page text.
     *
     * The contract is exact: `extract-pdf-text` builds its flat text as
     * `pages.join('\n') + '\n'`, so concatenating `_lines()` of each page must
     * reproduce the caller's line array element for element. If it doesn't,
     * something re-wrote the text between extraction and here and we must not
     * trust the mapping — return null and let the caller fall back. */
    function _pagesFromTexts(lines, pageTexts) {
        var pages = [];
        var bounds = [];
        var cursor = 0;
        for (var i = 0; i < pageTexts.length; i++) {
            var pl = _lines(pageTexts[i]);
            var from = cursor;
            var to = cursor + pl.length;
            if (to > lines.length) return null;
            for (var k = 0; k < pl.length; k++) {
                if (lines[from + k] !== pl[k]) return null;
            }
            cursor = to;
            var slice = lines.slice(from, to);
            // The printed banner is no longer load-bearing, but downstream
            // readers still ask "is this a continuation page?" — answer it from
            // the first couple of non-empty lines of the real page.
            var isCont = false;
            for (var c = 0, seen = 0; c < slice.length && seen < 3; c++) {
                var cl = _clean(slice[c]);
                if (!cl) continue;
                seen++;
                if (/CONTINUATION/i.test(cl)) { isCont = true; break; }
            }
            pages.push({
                index: i + 1,
                from: from,
                to: to,
                lines: slice,
                text: slice.join('\n'),
                isContinuation: isCont
            });
            bounds.push([from, to]);
        }
        // Trailing remainder is allowed only if it is the single empty element
        // left by the joining newline.
        for (var t = cursor; t < lines.length; t++) {
            if (_clean(lines[t])) return null;
        }
        if (!pages.length) return null;
        return { pages: pages, bounds: bounds, warning: '', authoritative: true };
    }

    function _pagesFromBanners(lines, isPageBreak) {
        var breakTest = typeof isPageBreak === 'function' ? isPageBreak : _isPageBreak;
        var breaks = [];
        for (var i = 0; i < lines.length; i++) {
            if (breakTest(lines[i])) breaks.push(i);
        }
        var bounds = [];
        var start = 0;
        for (var b = 0; b < breaks.length; b++) {
            if (breaks[b] > start) bounds.push([start, breaks[b]]);
            start = breaks[b];
        }
        bounds.push([start, lines.length]);

        var pages = [];
        for (var p = 0; p < bounds.length; p++) {
            var from = bounds[p][0];
            var to = bounds[p][1];
            var slice = lines.slice(from, to);
            var marker = _clean(lines[from]);
            pages.push({
                index: pages.length + 1,
                from: from,
                to: to,
                lines: slice,
                text: slice.join('\n'),
                isContinuation: /CONTINUATION/i.test(marker)
            });
        }

        // If the title DID survive as a standalone line on page 1, the leading
        // segment is a stub — fold it forward so page numbering stays correct.
        if (pages.length > 1) {
            var firstBody = pages[0].lines.filter(function (l) { return _clean(l).length > 2; });
            if (firstBody.length < 5) {
                var merged = pages[0].lines.concat(pages[1].lines);
                pages.splice(0, 2, {
                    index: 1,
                    from: pages[0].from,
                    to: pages[1].to,
                    lines: merged,
                    text: merged.join('\n'),
                    isContinuation: false
                });
                for (var k = 0; k < pages.length; k++) pages[k].index = k + 1;
            }
        }
        var outBounds = [];
        for (var q = 0; q < pages.length; q++) outBounds.push([pages[q].from, pages[q].to]);
        return { pages: pages, bounds: outBounds, warning: '', authoritative: false };
    }

    /* ================================================================ */
    return {
        // regex vocabulary
        RE_PAGE_BREAK: RE_PAGE_BREAK,
        RE_PAGE_HEADER: RE_PAGE_HEADER,
        RE_DATE: RE_DATE,
        RE_DATE_G: RE_DATE_G,
        RE_TIME_G: RE_TIME_G,
        RE_PHONE: RE_PHONE,
        RE_DAY: RE_DAY,
        RE_ADDR_ZIP: RE_ADDR_ZIP,
        RE_ADDR_NOZIP: RE_ADDR_NOZIP,
        RE_SSN: RE_SSN,
        RE_DL_LABEL: RE_DL_LABEL,
        RE_SSN_LABEL: RE_SSN_LABEL,
        RE_DL_STATE_LABEL: RE_DL_STATE_LABEL,
        RE_SENTENCE_END: RE_SENTENCE_END,
        RE_ABBREV_END: RE_ABBREV_END,
        RE_SENTENCE_START: RE_SENTENCE_START,
        US_STATE: US_STATE,
        NAME_STOP: NAME_STOP,

        // line hygiene
        lines: _lines,
        strip: _strip,
        clean: _clean,
        fmtPhone: _fmtPhone,
        isPageBreak: _isPageBreak,
        findLine: _findLine,

        // prose
        isProse: _isProse,
        isNarrativeFragment: _isNarrativeFragment,
        bodyIsReadable: _bodyIsReadable,
        junkRatio: _junkRatio,
        paragraphize: _paragraphize,

        // names
        isNameToken: _isNameToken,
        isMiddleInitial: _isMiddleInitial,
        extractName: _extractName,
        aliasOf: _aliasOf,

        // address
        stripLeadingColumnDigit: _stripLeadingColumnDigit,
        scanAddress: _scanAddress,

        // identity shapes
        identityTokens: _identityTokens,
        looksLikeDlNumber: _looksLikeDlNumber,
        stateTokenAt: _stateTokenAt,
        harvestIdentityRow: _harvestIdentityRow,

        // pages
        splitPages: _splitPages,
        pagesFromTexts: _pagesFromTexts,
        pagesFromBanners: _pagesFromBanners
    };
});

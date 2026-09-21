/*
 * V.I.P.E.R. — Arkansas State NIBRS "INCIDENT REPORT" parser
 * ----------------------------------------------------------
 * ADDITIVE RMS format support. Does not alter any existing RMS parser.
 *
 * This form is a scanned, image-only PDF in the field, so the text this module
 * receives is almost always Tesseract OCR output, not a clean text layer. Every
 * rule below is written against real OCR of a real return.
 *
 * EVIDENTIARY RULES (decided with the examiner, do not relax):
 *   1. CHECKBOX FIELDS ARE NEVER IMPORTED. Filled boxes OCR as Il / IE / Bl /
 *      H / Ml and empty ones as [J / [1 / O / LJ — indistinguishable often
 *      enough that any value we derived would be a guess presented as fact.
 *      Sex, race, ethnicity, residency, injury, weapon, clearance status,
 *      location code, relationship and every other tick box stay BLANK.
 *      Only typed / handwritten text is imported.
 *   2. NAMES ARE VERBATIM. Juvenile alias tokens printed in the name field
 *      ("HOLLOWAY (JV2), MARISOL") are preserved exactly as printed. The alias
 *      is additionally copied to `alias` as metadata; the name itself is not
 *      rewritten.
 *   3. Nothing is inferred. Offense severity has no field on this form, so it
 *      is left blank rather than guessed from the statute.
 *
 * ROUTING CONTRACT (see routeRmsPersonsToTabs in case-detail-with-analytics.html):
 *   The shared router classifies suspects with /SUSPECT|ARRESTED|DEFENDANT/i —
 *   it does NOT match "ARRESTEE" or "OFFENDER". We therefore emit
 *   "SUSPECT (ARRESTEE/OFFENDER)" so the existing router files arrestees
 *   correctly WITHOUT any change to the router itself.
 *
 * UMD: usable in the renderer (window.ArIncidentParser) and in plain Node.
 */
(function (root, factory) {
    'use strict';
    var api = factory();
    if (typeof module === 'object' && module && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.ArIncidentParser = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    /* ================================================================
     * Involvement vocabulary — chosen so the EXISTING router files each
     * person into the right tab with no change to shared code.
     * ================================================================ */
    var ROLE = {
        VICTIM: 'VICTIM',
        ARRESTEE: 'SUSPECT (ARRESTEE/OFFENDER)',
        OFFENDER: 'SUSPECT (OFFENDER)',
        WITNESS: 'WITNESS',
        COMPLAINANT: 'COMPLAINANT',
        OTHER: 'OTHER PERSON'
    };

    /* ================================================================
     * Regex vocabulary
     * ================================================================ */
    /* Stable prefix so a banded re-read can find and drop its own stale
     * warning after it rebuilds a page. Do not localise or reword without
     * updating _dropUnreadableWarnings(). */
    var NARRATIVE_UNREADABLE_PREFIX = 'Narrative text on page(s) ';

    var RE_PAGE_BREAK = /^\W{0,3}(INCIDENT\s+REPORT|CONTINUATION\s+PAGE)\W{0,3}$/i;
    var RE_PAGE_HEADER = /\d{1,2}\/\d{1,2}\/\d{4}\s*\|?\s*\d{2}-\d{6,8}/;
    var RE_INCIDENT_NO = /(?<!\d)(\d{2}-\d{6,8})(?!\d)/;
    var RE_ORI = /\b([A-Z]{2}\d{7})\b/;
    var RE_DATE = /(?<!\d)(\d{1,2}\/\d{1,2}\/\d{4})(?!\d)/;
    var RE_DATE_G = /(?<!\d)(\d{1,2}\/\d{1,2}\/\d{4})(?!\d)/g;
    var RE_TIME_G = /(?<![\d:])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/g;
    var RE_PHONE = /(?<!\d)\(?(\d{3})\)?[\s.\-]{0,3}(\d{3})[\s.\-]{1,3}(\d{4})(?!\d)/;
    var RE_DAY = /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun)\b/i;
    // Arkansas code citation: 5-14-103a(1), 5-36-103(b)(2), 27-50-306 ...
    var RE_STATUTE = /(\d{1,2}-\d{1,3}-\d{1,4}(?:\.\d+)?[A-Za-z]?(?:\s*\([0-9A-Za-z]{1,4}\))*)/;
    // Street address ending in a 2-letter state and a 5(+4) ZIP.
    var RE_ADDR_ZIP = /(\d+[A-Za-z]?\s+[A-Za-z0-9][A-Za-z0-9 .,'#\/\-]*?\b[A-Z]{2}\b\.?\s*,?\s*(?<!\d)\d{5}(?:-\d{4})?(?!\d))/;
    // Street address with no ZIP (used only under a RESIDENT ADDRESS label).
    var RE_ADDR_NOZIP = /(\d+[A-Za-z]?\s+[A-Za-z0-9][A-Za-z0-9 .,'#\/\-]*?,\s*[A-Za-z][A-Za-z .'\-]+,\s*[A-Z]{2})\b/;
    var RE_AGENCY = /([A-Z][A-Za-z.'\-]*(?:\s+[A-Z][A-Za-z.'\-]*){0,4}\s+(?:Sheriff's\s+(?:Office|Department|Dept\.?)|Police\s+(?:Department|Dept\.?)|Marshal's\s+Office|State\s+Police|Constable's\s+Office|Department\s+of\s+[A-Z][A-Za-z]+))/;
    var RE_EXACT_AGE = /\bEXACT\s*AGE[\s_:.]*(?<!\d)(\d{1,3})(?!\d)/i;
    var RE_AGE_LABEL = /\bAGE\s*:?[\s_.]*(?<!\d)(\d{1,3})(?!\d)/i;
    var RE_OFFICER_CODE = /\b([A-Z]{1,2}[O0]?\d{3,5})\b/;

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

    /* "Others Involved" must be matched as the near-standalone section heading.
     * The narrative on the witness page cites "(Others Involved)" in prose, and
     * a substring test there made the witness page look like a continuation
     * page and suppressed the WITNESSES band entirely. */
    var RE_OTHERS_HEADING = /^\W{0,3}Others\s+Involved\W{0,3}$/i;

    /* Standalone form-label lines that are never a role heading. */
    var NOT_A_ROLE = /^(NAME|SEX|RACE|AGE|ETHNIC|SSN|DOB|ZIP|OCCUPATION|NARRATIVE|OTHERS\s+INVOLVED|CONTINUATION\s+PAGE|INCIDENT\s+REPORT|ARKANSAS|UNAPPROVED|APPROVED|DATE\s+OF\s+BIRTH|RESIDENT\s+ADDRESS|RESIDENT\s+PHONE|PLACE\s+OF\s+EMPLOYMENT|EMPLOY.{0,3}\s*PHONE|EMPLOYMENT\s+PHONE|SOC\.?\s*SEC\.?\s*NO\.?|DRIVER.{0,2}S\s+LICENSE|DR\.?\s*LI\.?\s*STATE|LOCATION\s+CODE|WEAPON\s+FORCE|VICTIM\s+WAS|PAGE|ORI(\s+NUMBER)?|CODE\s*#?|DISPATCHER|REPORTING\s+(OFFICER|AREA)|TIME\s+(RECEIVED|ARRIVED)|AGENCY\s+NAME|STATUTE|OFFENSE(\s+(DESCRIPTION|STATUS|NAME))?|ADDRESS\s+OF\s+OFFENSE|SUBJECT\s+DESCRIPTORS|HEIGHT|WEIGHT|BUILD|SKIN\s+TONE)\b[:.]?$/i;

    /* ================================================================
     * Small helpers
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

    /* ---------------- name extraction ---------------- */

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
                if (!_isNameToken(toks[j])) break;
                right.push(toks[j]);
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

    /* ---------------- page splitting ---------------- */

    /*
     * Page 1's "INCIDENT REPORT" title is embedded in the clearance-status grid
     * and never survives OCR as a standalone line, so page 1 starts at index 0
     * and every later page is introduced by a standalone INCIDENT REPORT or
     * CONTINUATION PAGE marker. Ordinal index therefore equals the PDF page.
     */
    function _splitPages(lines) {
        var breaks = [];
        for (var i = 0; i < lines.length; i++) {
            if (_isPageBreak(lines[i])) breaks.push(i);
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
        return pages;
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

    /* First regex hit scanning a window of lines. */
    function _scan(lines, from, to, re, group) {
        var hi = Math.min(to, lines.length);
        for (var i = Math.max(0, from); i < hi; i++) {
            var m = re.exec(lines[i]);
            if (m) return m[group == null ? 1 : group];
        }
        return '';
    }

    /* ================================================================
     * detect()
     * ================================================================ */

    /*
     * Runs LAST in parseRmsReport's detection chain, immediately before the
     * legacy INFORM fallback, so it can never pre-empt an existing format.
     * Requires the form title plus either a strong Arkansas marker and two
     * structural markers, or five structural markers when OCR has eaten both
     * strong markers.
     */
    function detect(text) {
        var t = String(text == null ? '' : text);
        if (!t) return false;
        // Follow-up work comes on a separate one-page form, not on the NIBRS
        // incident report. See the SUPPLEMENT NARRATIVE section below.
        if (_isSupplementForm(t)) return true;
        if (!/INCIDENT\s+REPORT/i.test(t)) return false;

        var strong = /\bARKANSAS\b/i.test(t) || /\bAR\d{7}\b/.test(t);

        var signals = [
            /EXCEPTIONAL/i.test(t) && /CLEARANCE\s*STATUS/i.test(t),
            /ARRESTEE\s*#/i.test(t),
            /\bEXACT\s*AGE\b/i.test(t),
            /Others\s+Involved/i.test(t),
            /DAY\(S\)\s*OF\s*INCIDENT/i.test(t) || /TIME\(S\)\s*OF\s*INCIDENT/i.test(t),
            /SUBJECT\s+DESCRIPTORS/i.test(t),
            /MULT\.?\s*ARREST\s*INDIC/i.test(t),
            /DISPOSITION\s+OF\s+JUVENILE/i.test(t),
            /BIAS\s+MOTIVATED\s+CRIME/i.test(t),
            /VICTIM\s*#/i.test(t) && /RES\.?\s*STATUS/i.test(t)
        ];
        var score = 0;
        for (var i = 0; i < signals.length; i++) if (signals[i]) score++;

        return strong ? score >= 2 : score >= 5;
    }

    /* ================================================================
     * SUPPLEMENT NARRATIVE — a SECOND Arkansas form
     * ----------------------------------------------------------------
     * Follow-up work (evidence collection, later interviews, transports) is
     * NOT written onto the NIBRS incident report. The agency issues a
     * separate one-page form carrying the parent incident number and nothing
     * but a narrative:
     *
     *     SUPPLEMENT NARRATIVE
     *     INCIDENT NUMBER [SUPP# |] INCIDENT DATE | INCIDENT TIME  CASE STATUS
     *     26-0506420      [4     ] 05/22/2026       23:09
     *     SUPPLEMENT TYPE  SUPPLEMENT DATE | SUPPLEMENT TIME | SUPPLEMENTING OFFICER
     *     ADDITIONAL INFORMATION  05/23/2026  9:30  F4484 - DEREK MCCOY
     *     NARRATIVE:
     *     ...
     *
     * Three of the four reference documents for incident 26-0506420 are
     * supplements. Before this branch existed detect() returned false for
     * every one of them, so they fell through to the legacy INFORM fallback
     * and the officer's follow-up narrative — which is where the evidence
     * chain actually lives — was never imported.
     *
     * The label row and the value row are separate OCR lines, so each field
     * is read positionally from the line FOLLOWING its label.
     * ================================================================ */

    var RE_SUPP_TITLE = /SUPPLEMENT\s+NARRATIVE/i;
    var RE_NARRATIVE_LABEL = /^\W{0,3}NARRATIVE\s*[:.]?\s*$/i;
    var RE_TIME_1 = /(?<![\d:])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/;
    var RE_SUPP_OFFICER = /\b([A-Z]{1,2}\d{3,5})\s*[-–—]+\s*([A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*)*)\s*$/;

    function _isSupplementForm(t) {
        return RE_SUPP_TITLE.test(t) &&
            /SUPPLEMENTING\s+OFFICER/i.test(t) &&
            /INCIDENT\s+NUMBER/i.test(t) &&
            RE_INCIDENT_NO.test(t);
    }

    /* The first line after `i` that carries values rather than more labels. */
    function _nextValueLine(lines, i) {
        for (var k = i + 1; k < lines.length && k <= i + 3; k++) {
            var s = _clean(lines[k]);
            if (!s) continue;
            if (RE_NARRATIVE_LABEL.test(s)) return '';
            return s;
        }
        return '';
    }

    function _readSupplementHeader(lines) {
        var h = {
            incidentNumber: '', incidentDate: '', incidentTime: '', supplementNo: '',
            supplementType: '', supplementDate: '', supplementTime: '',
            officer: '', officerCode: ''
        };
        for (var i = 0; i < lines.length; i++) {
            var s = _clean(lines[i]);
            if (!s) continue;

            if (!h.incidentNumber && /INCIDENT\s+NUMBER/i.test(s)) {
                var hasSupp = /SUPP\s*#/i.test(s);
                var v = _nextValueLine(lines, i);
                if (v) {
                    var mi = RE_INCIDENT_NO.exec(v);
                    if (mi) {
                        h.incidentNumber = mi[1];
                        var rest = v.slice(mi.index + mi[1].length);
                        // The SUPP# column is only present on some supplements,
                        // and only then is a bare digit a supplement number
                        // rather than part of a date.
                        if (hasSupp) {
                            var ms = /^\s*(\d{1,3})\b/.exec(rest);
                            if (ms) h.supplementNo = ms[1];
                        }
                        var md = RE_DATE.exec(rest);
                        if (md) {
                            h.incidentDate = md[1];
                            var mt = RE_TIME_1.exec(rest.slice(md.index + md[1].length));
                            if (mt) h.incidentTime = mt[0];
                        }
                    }
                }
            }

            if (!h.officer && /SUPPLEMENTING\s+OFFICER/i.test(s)) {
                var v2 = _nextValueLine(lines, i);
                if (v2) {
                    var mo = RE_SUPP_OFFICER.exec(v2);
                    if (mo) { h.officerCode = mo[1]; h.officer = _clean(mo[2]); }
                    var md2 = RE_DATE.exec(v2);
                    if (md2) {
                        h.supplementDate = md2[1];
                        h.supplementType = _clean(v2.slice(0, md2.index));
                        var mt2 = RE_TIME_1.exec(v2.slice(md2.index + md2[1].length));
                        if (mt2) h.supplementTime = mt2[0];
                    }
                }
            }
        }
        return h;
    }

    /* Everything below the NARRATIVE: label, minus page headers and the
     * form's own footer furniture. */
    function _readSupplementNarrative(lines) {
        var start = -1;
        for (var i = 0; i < lines.length; i++) {
            if (RE_NARRATIVE_LABEL.test(_clean(lines[i]))) { start = i; break; }
        }
        if (start === -1) {
            // OCR sometimes welds the label to the first sentence.
            for (var j = 0; j < lines.length; j++) {
                if (/^\W{0,3}NARRATIVE\s*:/i.test(_clean(lines[j]))) { start = j - 1; break; }
            }
        }
        if (start === -1) return [];

        var body = [];
        for (var k = start + 1; k < lines.length; k++) {
            var s = _stripRuleGlyphs(_clean(lines[k]));
            // Blank rows are NOT carried through: paragraph breaks are decided
            // by _paragraphize(), exactly as on the incident report, so the
            // two forms can never disagree about where a paragraph starts.
            if (!s) continue;
            if (RE_PAGE_HEADER.test(s)) continue;
            if (/^\W{0,3}NARRATIVE\s*[:.]?\s*$/i.test(s)) continue;
            if (/^\W{0,3}PAGE\s*#?\s*\d*\W{0,3}$/i.test(s)) continue;
            if (/^\W{0,3}SUPPLEMENT\s+NARRATIVE\W{0,3}$/i.test(s)) continue;
            var m0 = /^\W{0,3}NARRATIVE\s*:\s*(.+)$/i.exec(s);
            if (m0) s = _clean(m0[1]);
            body.push(s);
        }
        while (body.length && !body[body.length - 1]) body.pop();
        return body;
    }

    function _parseSupplement(raw, lines, fileName) {
        var warnings = [];
        function warn(msg) { if (warnings.indexOf(msg) === -1) warnings.push(msg); }

        var h = _readSupplementHeader(lines);
        if (!h.incidentNumber) warn('Supplement incident number not read from this scan.');
        if (!h.officer) warn('Supplementing officer not read from this scan.');

        var body = _readSupplementNarrative(lines);
        var unreadable = [];
        var text = '';
        if (!body.length) {
            warn('No NARRATIVE section found.');
        } else if (!_bodyIsReadable(body)) {
            // Same rule as the incident report: noise is not evidence.
            unreadable.push(1);
            warn(NARRATIVE_UNREADABLE_PREFIX + '1' +
                ' could not be read from this scan. It was left out rather than imported as OCR noise - read it from the source document.');
        } else {
            text = _paragraphize(body);
        }

        var narratives = text ? [{
            officer: h.officer || '',
            badge: h.officerCode || '',
            text: text
        }] : [];

        var typeLabel = h.supplementType ? ' (' + h.supplementType + ')' : '';
        var report = {
            id: 'rms_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            fileName: fileName || '',
            importedAt: new Date().toISOString(),
            reportNumber: h.incidentNumber || '',
            reportDate: h.supplementDate || h.incidentDate || '',
            reportType: 'Arkansas Supplement Narrative' + typeLabel,
            supplementNo: h.supplementNo || '',
            agencyName: '',
            location: '',
            beat: '',
            fromDateTime: _clean((h.incidentDate || '') + ' ' + (h.incidentTime || '')),
            toDateTime: '',
            offenses: [],
            personsInvolved: [],
            provisionalPersons: [],
            vehicles: [],
            property: [],
            narratives: narratives,
            digital: [],
            confidentialPersons: [],
            pageCount: 1,
            rawText: raw,

            arFormat: 'ar-supplement-narrative',
            arFormatLabel: 'Arkansas Supplement Narrative',
            ar: {
                incidentDate: h.incidentDate || '',
                incidentTime: h.incidentTime || '',
                supplementType: h.supplementType || '',
                supplementDate: h.supplementDate || '',
                supplementTime: h.supplementTime || '',
                reportingOfficer: h.officer || '',
                officerCode: h.officerCode || ''
            },
            diagnostics: {
                pages: 1,
                offenses: 0,
                persons: 0,
                victims: 0,
                arrestees: 0,
                witnesses: 0,
                othersInvolved: 0,
                provisional: 0,
                namesRecovered: 0,
                narrativeChars: text.length,
                narrativeLinesRecovered: 0,
                checkboxFieldsSkipped: true,
                warnings: warnings
            }
        };

        /* The supplement is one page of solid prose in a ruled box, so it is
         * exposed to exactly the OCR failures the incident report is: PSM 6
         * drops the short trailing row of a paragraph, and a skewed ruled
         * grid can defeat the page outright. Offer page 1 to BOTH recovery
         * passes — measured on the three reference supplements, the banded
         * read correctly declined to replace a good primary read. */
        report.narrativeRecovery = {
            pages: [1],
            byPage: text ? { 1: text } : {},
            continuationPages: [],
            bandCandidates: [1],
            unreadablePages: unreadable
        };
        report.nameRecovery = { pages: [], count: 0 };
        return report;
    }

    /* ================================================================
     * Section readers — each returns [] / '' on a miss (degrade, never throw)
     * ================================================================ */

    function _readHeader(pages, warn) {
        var h = {
            incidentNumber: '', ori: '', agencyName: '', approvalStatus: '',
            incidentDate: '', incidentTime: '', incidentDay: '',
            dispatcher: '', timeReceived: '', timeArrived: '', reportingArea: '',
            reportDate: '', reportDay: '', reportTime: '',
            reportingOfficer: '', officerCode: '', victimNameHeader: ''
        };
        var p1 = pages[0] ? pages[0].lines : [];
        var all = [];
        for (var i = 0; i < pages.length; i++) all = all.concat(pages[i].lines);

        // Incident number and ORI can come from any page header row.
        for (var a = 0; a < all.length; a++) {
            if (!h.incidentNumber) {
                var mi = RE_INCIDENT_NO.exec(all[a]);
                if (mi) h.incidentNumber = mi[1];
            }
            if (!h.ori) {
                var mo = RE_ORI.exec(all[a]);
                if (mo) h.ori = mo[1];
            }
            if (h.incidentNumber && h.ori) break;
        }

        var ap = /\b(UNAPPROVED|APPROVED)\b/.exec(pages[0] ? pages[0].text : '');
        if (ap) h.approvalStatus = ap[1];

        // AGENCY NAME sits on the DATE(S) OF INCIDENT value row.
        var agIdx = _findLine(p1, /AGENCY\s*NAME/i, 0, p1.length);
        var dateIdx = _findLine(p1, /DATE\(S\)\s*OF\s*INCIDENT/i, 0, p1.length);
        var agFrom = agIdx >= 0 ? agIdx : (dateIdx >= 0 ? dateIdx : 0);
        for (var g = agFrom; g < Math.min(agFrom + 4, p1.length); g++) {
            var ma = RE_AGENCY.exec(p1[g]);
            if (ma) { h.agencyName = _clean(ma[1]); break; }
        }

        if (dateIdx >= 0) {
            h.incidentDate = _scan(p1, dateIdx, dateIdx + 3, RE_DATE);
        }
        if (!h.incidentDate) h.incidentDate = _scan(p1, 0, p1.length, RE_DATE);

        var timeIdx = _findLine(p1, /TIME\(S\)\s*OF\s*INCIDENT/i, 0, p1.length);
        if (timeIdx >= 0) {
            for (var tl = timeIdx; tl < Math.min(timeIdx + 3, p1.length); tl++) {
                var times = _clean(p1[tl]).match(/(?<![\d:])(?:[01]?\d|2[0-3]):[0-5]\d(?![\d:])/g);
                if (times && times.length) {
                    h.incidentTime = times.length > 1 ? times[0] + ' - ' + times[1] : times[0];
                    break;
                }
            }
            var md = RE_DAY.exec(p1.slice(timeIdx, Math.min(timeIdx + 3, p1.length)).join(' '));
            if (md) h.incidentDay = md[1];
        }

        // DISPATCHER | TIME RECEIVED | TIME ARRIVED | REPORTING AREA value row
        var dispIdx = _findLine(p1, /DISPATCHER/i, 0, p1.length);
        if (dispIdx >= 0 && dispIdx + 1 < p1.length) {
            var row = _strip(p1[dispIdx + 1]);
            var tms = row.match(/(?<![\d:])(?:[01]?\d|2[0-3]):[0-5]\d(?![\d:])/g) || [];
            if (tms.length) {
                h.timeReceived = tms[0];
                if (tms.length > 1) h.timeArrived = tms[1];
                var firstAt = row.indexOf(tms[0]);
                h.dispatcher = _clean(row.slice(0, firstAt));
                var lastTm = tms[tms.length - 1];
                var tail = row.slice(row.lastIndexOf(lastTm) + lastTm.length);
                h.reportingArea = _clean(tail.replace(RE_DATE_G, '')).replace(/[|\[\]]+/g, ' ').trim();
            } else {
                h.dispatcher = row;
            }
        }

        // ADM footer: REPORT DATE | DAY | TIME | REPORTING OFFICER | CODE #
        var admIdx = _findLine(p1, /REPORT\s*DATE/i, 0, p1.length);
        if (admIdx >= 0 && admIdx + 1 < p1.length) {
            var adm = _strip(p1[admIdx + 1]);
            var dm = RE_DATE.exec(adm);
            if (dm) h.reportDate = dm[1];
            var dayM = RE_DAY.exec(adm);
            if (dayM) h.reportDay = dayM[1];
            var tmM = /(?<![\d:])((?:[01]?\d|2[0-3]):[0-5]\d)(?![\d:])/.exec(adm);
            if (tmM) h.reportTime = tmM[1];
            // officer name sits between the time and the code
            var afterTime = tmM ? adm.slice(adm.indexOf(tmM[1]) + tmM[1].length) : adm;
            var codeM = RE_OFFICER_CODE.exec(afterTime);
            if (codeM) {
                h.officerCode = codeM[1];
                h.reportingOfficer = _clean(afterTime.slice(0, afterTime.indexOf(codeM[1])))
                    .replace(/[|\[\]]+/g, ' ').trim();
            } else {
                h.reportingOfficer = _clean(afterTime).replace(/[|\[\]]+/g, ' ').trim();
            }
        }

        // Page-header rows repeat REPORTING OFFICER / CODE # / VICTIM NAME —
        // use them to fill anything the ADM footer lost.
        for (var ph = 0; ph < all.length; ph++) {
            if (!RE_PAGE_HEADER.test(all[ph])) continue;
            var hdr = _strip(all[ph]);
            var vn = _extractName(hdr);
            if (vn && !h.victimNameHeader) h.victimNameHeader = vn;
            if (!h.officerCode) {
                var c2 = RE_OFFICER_CODE.exec(hdr.replace(RE_ORI, ' ').replace(RE_INCIDENT_NO, ' '));
                if (c2) h.officerCode = c2[1];
            }
            if (h.victimNameHeader && h.officerCode) break;
        }

        if (!h.incidentNumber) warn('Incident number not found — the report number will be blank.');
        if (!h.agencyName) warn('Agency name not recognised on page 1.');
        return h;
    }

    function _readOffenses(pages, warn) {
        var out = [];
        for (var p = 0; p < pages.length; p++) {
            var lines = pages[p].lines;
            /*
             * Offense band runs from the label row down to the LOCATION CODE
             * legend (or the VICTIM band if the legend is lost).
             *
             * THREE anchors, earliest wins. The original code keyed only on
             * "OFFENSE #", which does not survive this form: the printed
             * header on the Faulkner exemplar reads "UCR CODE" and OCRs as
             * "UCRCODE" (no space), so `start` came back -1, every page was
             * skipped, and the report imported with zero offenses AND no
             * address of offense. "STATUTE" is the last-resort anchor because
             * it sits on the column-header row directly above the data row.
             */
            var start = -1;
            var anchors = [/OFFENSE\s*#/i, /UCR\s*_?\s*CODE/i, /\bSTATUTE\b/i];
            for (var a = 0; a < anchors.length; a++) {
                var at = _findLine(lines, anchors[a], 0, lines.length);
                if (at >= 0 && (start < 0 || at < start)) start = at;
            }
            if (start < 0) continue;
            var end = _findLine(lines, /LOCATION\s*CODE/i, start, lines.length);
            if (end < 0) end = _findLine(lines, /VICTIM\s*#/i, start, lines.length);
            if (end < 0) end = Math.min(start + 14, lines.length);

            var number = '';
            var ucr = '';
            for (var i = start + 1; i < end; i++) {
                var row = _strip(lines[i]);
                var mn = /^(\d{1,2})\s+(\d{2}[A-Z]|\d{3})\b/.exec(row);
                if (mn) { number = mn[1]; ucr = mn[2]; break; }
                /* The offense-number column is one narrow digit in a tall
                 * ruled cell and OCR routinely drops it, leaving the NIBRS
                 * code alone at the head of the row. Accept the code on its
                 * own, but only on a row that also carries the OFFENSE
                 * STATUS / OFFENDER USED checkbox labels, so a stray number
                 * elsewhere in the band can never be read as a UCR code. */
                var mu = /^(\d{2}[A-Z]|\d{3})\b/.exec(row);
                if (mu && /Attempted|Completed|Alcohol|Cptr|Drugs|Premises/i.test(row)) {
                    ucr = mu[1];
                    break;
                }
            }

            for (var j = start + 1; j < end; j++) {
                var s = _strip(lines[j]);
                var ms = RE_STATUTE.exec(s);
                if (!ms || s.indexOf(ms[1]) !== 0) continue;   // statute must open the row

                var statute = _clean(ms[1]);
                var rest = s.slice(ms[1].length);
                var location = '';
                var ma = RE_ADDR_ZIP.exec(rest);
                if (ma) {
                    location = _clean(ma[1]);
                    rest = rest.slice(0, ma.index) + ' ' + rest.slice(ma.index + ma[1].length);
                }
                // Anything after a checkbox glyph or a column pipe is form furniture.
                var description = _clean(rest.split(/[|\[]/)[0]);

                out.push({
                    number: number || String(out.length + 1),
                    status: '',                 // OFFENSE STATUS is a checkbox — never imported
                    statute: statute,
                    description: description,
                    severity: '',               // no severity field exists on this form
                    ucrCode: ucr,
                    location: location,
                    page: pages[p].index
                });
                number = '';
                ucr = '';
            }
        }
        if (!out.length) warn('No offense row recognised (STATUTE / OFFENSE DESCRIPTION).');
        return out;
    }

    function _personShell(involvement) {
        return {
            involvement: involvement || ROLE.OTHER,
            name: '', alias: '', dob: '', age: '',
            sex: '', race: '', ethnicity: '',        // checkbox fields — stay blank
            address: '', phone: '',
            height: '', weight: '', hair: '', eyes: '',
            comments: '', guardian: '', detail: '',
            sourcePage: 0
        };
    }

    function _hasOthersHeading(lines) {
        for (var i = 0; i < lines.length; i++) {
            if (RE_OTHERS_HEADING.test(_clean(lines[i]))) return i;
        }
        return -1;
    }

    function _harvestBlock(lines, from, to, involvement, pageNo) {
        var person = _personShell(involvement);
        person.sourcePage = pageNo || 0;

        // name — first line in the block that yields one
        for (var i = from; i < to; i++) {
            var n = _extractName(lines[i]);
            if (n) { person.name = n; person.alias = _aliasOf(n); break; }
        }

        /* Address. The RESIDENT ADDRESS label is frequently shredded by OCR
         * ("RESIDENT ODES Ss meee Ci sate"), so a label-anchored window alone
         * loses the value. Try the window first, then fall back to the whole
         * block — but never take a row that belongs to ARREST LOCATION, which
         * is a different fact. */
        var addrIdx = _findLine(lines, /RESIDENT\s*ADDRESS/i, from, to);
        if (addrIdx >= 0) {
            person.address = _scanAddress(lines, addrIdx, Math.min(addrIdx + 6, to), to);
        }
        if (!person.address) {
            person.address = _scanAddress(lines, from, to, to);
        }

        // phone
        for (var ph = from; ph < to; ph++) {
            var f = _fmtPhone(lines[ph]);
            if (f) { person.phone = f; break; }
        }

        // DOB: only from a row at/after a DATE OF BIRTH label, or the name row.
        var dobIdx = _findLine(lines, /DATE\s*OF\s*BIRTH/i, from, to);
        if (dobIdx >= 0) {
            person.dob = _scan(lines, dobIdx, Math.min(dobIdx + 3, to), RE_DATE);
        }
        if (!person.dob && person.name) {
            for (var d = from; d < to; d++) {
                if (String(lines[d]).indexOf(person.name.split(',')[0]) === -1) continue;
                var md = RE_DATE.exec(lines[d]);
                if (md) { person.dob = md[1]; break; }
            }
        }

        // age: EXACT AGE wins; otherwise a typed AGE: value
        var blockText = lines.slice(from, to).join('\n');
        var mae = RE_EXACT_AGE.exec(blockText);
        if (mae) person.age = mae[1];
        else {
            var mal = RE_AGE_LABEL.exec(blockText);
            if (mal) person.age = mal[1];
        }

        return person;
    }

    function _hasData(p) {
        return !!(p.name || p.dob || p.address || p.phone || p.age);
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
            if (m) return _clean(m[1]);
        }
        return '';
    }

    function _readVictims(pages, warn) {
        var out = [];
        for (var p = 0; p < pages.length; p++) {
            var lines = pages[p].lines;
            var start = _findLine(lines, /VICTIM\s*#/i, 0, lines.length);
            if (start < 0) continue;
            var end = _findLine(lines, /AGGRAVATED\s+ASSAULT/i, start, lines.length);
            if (end < 0) end = _findLine(lines, /REPORT\s*DATE/i, start, lines.length);
            if (end < 0) end = lines.length;

            var v = _harvestBlock(lines, start, end, ROLE.VICTIM, pages[p].index);
            if (_hasData(v)) out.push(v);
        }
        if (!out.length) warn('No VICTIM block recognised.');
        return out;
    }

    function _readArrestees(pages, warn) {
        var out = [];
        for (var p = 0; p < pages.length; p++) {
            var lines = pages[p].lines;
            var starts = [];
            for (var i = 0; i < lines.length; i++) {
                if (/ARRESTEE\s*#/i.test(lines[i])) starts.push(i);
            }
            if (!starts.length) continue;
            for (var s = 0; s < starts.length; s++) {
                var from = starts[s];
                var to = s + 1 < starts.length ? starts[s + 1] : lines.length;
                var a = _harvestBlock(lines, from, to, ROLE.ARRESTEE, pages[p].index);
                var mo = /OFFENDER\s*#/i.test(lines.slice(from, to).join('\n'));
                if (mo) {
                    var num = _scan(lines, from, to, /^\s*(\d{1,2})\s*$/);
                    if (num) a.detail = 'Offender #' + num;
                }
                if (_hasData(a)) out.push(a);
            }
        }
        return out;
    }

    /*
     * WITNESSES and COMPLNT share an identical block template and their vertical
     * band labels are shredded by OCR, so the band is identified by page
     * context — which is fixed on this form: WITNESSES always sits directly
     * above the NARRATIVE box; COMPLNT sits at the foot of the vehicle/property
     * page. A block we cannot place is emitted as OTHER PERSON rather than
     * guessed into the Witnesses tab.
     */
    function _readGenericPersonBlocks(pages, warn) {
        var out = [];
        for (var p = 0; p < pages.length; p++) {
            var page = pages[p];
            var lines = page.lines;

            // Pages handled by the dedicated readers are skipped.
            if (_findLine(lines, /VICTIM\s*#/i, 0, lines.length) >= 0) continue;
            if (_findLine(lines, /ARRESTEE\s*#/i, 0, lines.length) >= 0) continue;
            if (_hasOthersHeading(lines) >= 0) continue;

            var narrIdx = _findLine(lines, /^\W{0,3}NARRATIVE\s*:?/i, 0, lines.length);
            var isPropertyPage = /DRUG\s+TYPE/i.test(page.text) ||
                /PROPERTY\s+(LOSS|DESCRIPTION)/i.test(page.text);

            var starts = [];
            for (var i = 0; i < lines.length; i++) {
                if (narrIdx >= 0 && i >= narrIdx) break;
                if (/NAME\s*:\s*Last/i.test(lines[i])) starts.push(i);
            }
            if (!starts.length) continue;

            var role;
            if (/\bWITNESS(ES)?\b/i.test(page.text)) role = ROLE.WITNESS;
            else if (narrIdx >= 0) role = ROLE.WITNESS;
            else if (isPropertyPage) role = ROLE.COMPLAINANT;
            else role = ROLE.OTHER;

            for (var s = 0; s < starts.length; s++) {
                var from = starts[s];
                var to = s + 1 < starts.length ? starts[s + 1]
                    : (narrIdx >= 0 ? narrIdx : lines.length);
                var person = _harvestBlock(lines, from, to, role, page.index);
                if (_hasData(person)) out.push(person);
            }
        }
        return out;
    }

    /*
     * Continuation-page "Others Involved" blocks. Role comes from the standalone
     * ALL-CAPS heading above each block (CASE WORKER, PARENT, GUARDIAN, ...),
     * which is typed on the form and therefore safe to import.
     */
    function _readOthersInvolved(pages, warn) {
        var out = [];
        for (var p = 0; p < pages.length; p++) {
            var page = pages[p];
            var lines = page.lines;
            var oi = _hasOthersHeading(lines);
            if (oi < 0) continue;

            var heads = [];
            for (var i = oi + 1; i < lines.length; i++) {
                var s = _clean(lines[i]);
                if (!s || s.length > 32) continue;
                if (!/^[A-Z][A-Z '\/&.\-]*$/.test(s)) continue;
                if (NOT_A_ROLE.test(s)) continue;
                if (!/[A-Z]{3}/.test(s)) continue;
                heads.push({ idx: i, role: s });
            }
            if (!heads.length) {
                warn('Page ' + page.index + ' has an "Others Involved" section but no readable role heading.');
                continue;
            }

            for (var hh = 0; hh < heads.length; hh++) {
                var from = heads[hh].idx;
                var to = hh + 1 < heads.length ? heads[hh + 1].idx : lines.length;
                var person = _harvestBlock(lines, from + 1, to, heads[hh].role, page.index);
                person.detail = 'Others Involved — ' + heads[hh].role;
                // Emitted even when completely empty: the typed role heading is
                // proof the block exists, and a sparse-OCR pass can still
                // recover the name. parse() keeps nameless blocks out of
                // personsInvolved until a name is actually read.
                out.push(person);
            }
        }
        return out;
    }

    /* ----------------------------------------------------------------
     * Paragraph reconstruction.
     * ----------------------------------------------------------------
     * The printed form separates paragraphs with a blank ruled row, but the
     * OCR emits every text row back-to-back with no blank line, so the
     * imported narrative arrived as one undifferentiated wall of text.
     *
     * The printed LINE BREAKS are preserved verbatim (they are part of the
     * source document); a blank line is inserted between two lines only when
     * the first one ends a sentence and the second starts a new one. Nothing
     * is added, removed or re-worded — the only change is white space.
     * ---------------------------------------------------------------- */
    var RE_SENTENCE_END = /[.!?][)"'\u2019\u201d]?$/;
    /* Titles/abbreviations that end in a period mid-sentence. A wrapped line
     * ending "... Ms." must NOT become a paragraph break. */
    var RE_ABBREV_END = /(?:^|\s)(?:mr|mrs|ms|dr|prof|det|sgt|lt|cpl|ofc|jr|sr|st|ave|rd|blvd|ln|apt|ste|dept|approx|est|no|vs|etc|inc|co|corp|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|[a-z])\.$/i;
    var RE_SENTENCE_START = /^["'(\u201c\u2018]?[A-Z0-9]/;

    /* "INCIDENT REPORT NARRATIVE CONTINUATION" — the printed banner on every
     * page that continues the narrative. It survives OCR far more reliably than
     * the "NARRATIVE:" cell label does, because it is set large and sits clear
     * of the ruled grid. A continuation page proves the narrative STARTED on an
     * earlier page, which is how we find a narrative page whose own header the
     * primary OCR pass lost entirely. */
    function _looksLikeNarrativeContinuation(lines) {
        for (var i = 0; i < lines.length && i < 12; i++) {
            var s = _clean(lines[i]);
            if (!s) continue;
            if (/NARRATIVE\s+CONTINUATION/i.test(s)) return true;
            if (/\bNARRATIVE\b/i.test(s) && /\bCONTINU/i.test(s)) return true;
        }
        return false;
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
     * page, because the narrative is the only part of this form printed as
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

    function _readNarrative(pages, warn) {
        var chunks = [];
        var srcPages = [];
        var byPage = {};
        var contPages = [];
        var unreadable = [];
        var started = false;
        for (var p = 0; p < pages.length; p++) {
            var page = pages[p];
            var lines = page.lines;
            if (_looksLikeNarrativeContinuation(lines)) contPages.push(page.index);
            var idx = _findLine(lines, /^\W{0,3}NARRATIVE\s*:?/i, 0, lines.length);

            if (idx >= 0) {
                started = true;
                var body = [];
                for (var i = idx; i < lines.length; i++) {
                    var s = _clean(lines[i]).replace(/^\W{0,3}NARRATIVE\s*:?\s*/i, '');
                    if (!s) continue;
                    if (_isPageBreak(s)) break;
                    if (RE_PAGE_HEADER.test(s)) continue;
                    body.push(s);
                }
                /*
                 * A labelled page still has to be READABLE.
                 *
                 * This branch used to take every non-empty line under the
                 * NARRATIVE label on trust, and that is exactly how an
                 * officer ended up looking at a narrative card containing
                 *
                 *     A / A / ER / EE / -— / Pa / Ce —— / ... / A PTA / fr / ES
                 *
                 * — 22 rows of pure OCR wreckage from a ruled grid, presented
                 * as their own words. Rendering noise as evidence is worse
                 * than rendering nothing: it is not merely useless, it is
                 * misleading in a case file. So a page whose narrative body
                 * carries no readable sentence at all contributes NOTHING
                 * here; it is recorded as unreadable, offered to the banded
                 * re-read, and — if that fails too — reported as a warning
                 * telling the examiner to read it from the source document.
                 */
                if (body.length && !_bodyIsReadable(body)) {
                    if (unreadable.indexOf(page.index) === -1) unreadable.push(page.index);
                    continue;
                }
                if (body.length) {
                    chunks.push(_paragraphize(body));
                    byPage[page.index] = chunks[chunks.length - 1];
                    if (srcPages.indexOf(page.index) === -1) srcPages.push(page.index);
                }
                continue;
            }

            // Unlabelled narrative spill onto a later page: prose only, and only
            // once the narrative has actually started.
            //
            // PROSE MUST DOMINATE THE PAGE. A bare "2 or more prose lines"
            // test is not a narrative detector on this form — the NIBRS
            // location-code, weapon and relationship legends OCR into long
            // lowercase-heavy lines that _isProse() accepts, so every
            // remaining form page appended its checkbox furniture to the
            // officer's narrative. Measured on the reference report: a form
            // page runs 0.03–0.39 prose, an intact narrative page runs far
            // higher. A page that fails this gate is still offered to the
            // banded re-read below — it just cannot contribute raw text.
            if (!started || _hasOthersHeading(lines) >= 0) continue;
            var prose = [];
            var nonEmpty = 0;
            for (var j = 0; j < lines.length; j++) {
                if (RE_PAGE_HEADER.test(lines[j])) continue;
                if (!_clean(lines[j])) continue;
                nonEmpty++;
                if (_isProse(lines[j])) prose.push(_clean(lines[j]));
            }
            if (prose.length >= 4 && prose.length >= nonEmpty * 0.6) {
                chunks.push(_paragraphize(prose));
                byPage[page.index] = chunks[chunks.length - 1];
                if (srcPages.indexOf(page.index) === -1) srcPages.push(page.index);
            }
        }

        /*
         * Pages a banded re-read should be offered.
         *
         * Once the dominance gate above rejects a page, a narrative that ran
         * onto a continuation page whose "NARRATIVE:" cell label the primary
         * OCR destroyed leaves NO trace in srcPages at all — and on the
         * reference report that is exactly what happens to the page carrying
         * the charging paragraph. Walk forward from the last page that did
         * yield narrative and offer every contiguous continuation page.
         * Offering a page is cheap and reversible: recoverNarrativeBanded()
         * takes nothing from it unless the banded read is a material gain.
         */
        var bandCandidates = srcPages.slice();
        unreadable.forEach(function (n) {
            if (bandCandidates.indexOf(n) === -1) bandCandidates.push(n);
        });
        /* Anchor the forward walk on the last page that carried narrative
         * text AT ALL — including a page whose text was withheld as
         * unreadable. A page rejected by the junk gate still proves where the
         * narrative was, and its spill page must still be offered; leaving it
         * out cost the closing paragraph of the reference report. */
        var anchorPages = srcPages.concat(unreadable).sort(function (a, b) { return a - b; });
        if (anchorPages.length) {
            var lastPage = anchorPages[anchorPages.length - 1];
            var lastIdx = -1;
            for (var k = 0; k < pages.length; k++) {
                if (pages[k].index === lastPage) { lastIdx = k; break; }
            }
            for (var m = lastIdx + 1; lastIdx >= 0 && m < pages.length && m <= lastIdx + 3; m++) {
                if (!pages[m].isContinuation) break;
                if (_hasOthersHeading(pages[m].lines) >= 0) break;
                if (bandCandidates.indexOf(pages[m].index) === -1) {
                    bandCandidates.push(pages[m].index);
                }
            }
        }

        /*
         * LAST-RESORT CANDIDATES — the "we found nothing at all" case.
         *
         * When the scan is skewed as well as ruled, the primary OCR of the
         * narrative page can collapse so completely that the NARRATIVE label
         * is gone, the prose-dominance gate rejects the page, and no
         * continuation banner survives either. srcPages is then empty, so the
         * two rules above nominate NOTHING and the banded re-read — the only
         * thing that can actually read the page — never runs. Measured on the
         * Faulkner 26-0506420 report: five pages, the whole narrative on page
         * 4, zero narratives imported, zero band candidates offered.
         *
         * So when nothing was found, nominate pages on GEOMETRY-FREE grounds:
         * every page except the face page and the Others-Involved pages,
         * ordered most-damaged first so the MAX_PAGES budget is spent where
         * it can help. This is safe because offering a page is not the same
         * as using it — recoverNarrativeBanded() takes text from a page only
         * when the banded read clears the confidence, prose and material-gain
         * gates. Verified on that report: offering ALL FIVE pages caused
         * exactly one (page 4, the real narrative) to be accepted.
         */
        if (!bandCandidates.length) {
            var ranked = [];
            for (var f = 0; f < pages.length; f++) {
                if (pages[f].index <= 1) continue;
                if (_hasOthersHeading(pages[f].lines) >= 0) continue;
                ranked.push({ index: pages[f].index, junk: _junkRatio(pages[f].lines) });
            }
            ranked.sort(function (a, b) { return b.junk - a.junk || a.index - b.index; });
            for (var r2 = 0; r2 < ranked.length; r2++) bandCandidates.push(ranked[r2].index);
        }

        /* Tell the examiner which pages were withheld. A withheld page is a
         * page whose narrative text EXISTS on the paper but could not be read
         * from this scan; silently dropping it would look identical to a page
         * the officer left blank. recoverNarrativeBanded() clears the entry
         * for any page it later rebuilds. */
        if (unreadable.length) {
            warn(NARRATIVE_UNREADABLE_PREFIX + unreadable.join(', ') +
                ' could not be read from this scan. It was left out rather than imported as OCR noise - read it from the source document.');
        }

        if (!chunks.length) {
            warn('No NARRATIVE section found.');
            return {
                items: [], pages: [], byPage: byPage,
                continuationPages: contPages, bandCandidates: bandCandidates,
                unreadablePages: unreadable
            };
        }
        return {
            pages: srcPages,
            byPage: byPage,
            continuationPages: contPages,
            bandCandidates: bandCandidates,
            unreadablePages: unreadable,
            items: [{
                officer: '',            // filled by parse() from the ADM footer
                badge: '',
                text: chunks.join('\n\n')
            }]
        };
    }

    /* ================================================================
     * Narrative line recovery.
     * ----------------------------------------------------------------
     * tesseract.js defaults to PSM 6 (single uniform block), and that pass
     * silently DROPS short trailing narrative rows — on the reference report
     * it lost "with it." and "provided or I could obtain.", i.e. the closing
     * line of two paragraphs. A second pass over the same page image with
     * PSM 3 (full auto page segmentation) reads them, but scrambles the
     * surrounding column order, so PSM 3 cannot simply replace the narrative.
     *
     * So the merge is ADDITIVE and anchored: a PSM 3 line is inserted only if
     * (a) the primary pass does not already have it, and (b) it directly
     * follows a line the primary pass DID read. Everything else is discarded.
     * No line is ever rewritten or removed.
     * ================================================================ */
    function _normLine(s) {
        return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '');
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

    function _findNorm(list, norm) {
        var i;
        for (i = 0; i < list.length; i++) {
            if (list[i] && _normLine(list[i]) === norm) return i;
        }
        if (norm.length >= 30) {
            var head = norm.slice(0, 30);
            for (i = 0; i < list.length; i++) {
                if (!list[i]) continue;
                var n = _normLine(list[i]);
                if (n.length >= 30 && n.slice(0, 30) === head) return i;
            }
        }
        return -1;
    }

    function narrativeRecoveryPages(report) {
        return (report && report.narrativeRecovery && report.narrativeRecovery.pages) || [];
    }

    function recoverNarrative(report, altByPage) {
        if (!report || !report.narratives || !report.narratives.length) return 0;
        if (!altByPage) return 0;
        var narr = report.narratives[0];
        var merged = _lines(narr.text);
        var added = 0;

        var keys = Object.keys(altByPage);
        for (var ki = 0; ki < keys.length; ki++) {
            var alt = altByPage[keys[ki]];
            if (!alt) continue;
            var altLines = _lines(alt);
            var anchor = -1;
            for (var a = 0; a < altLines.length; a++) {
                var cand = _clean(altLines[a]);
                if (!_isNarrativeFragment(cand)) continue;
                var norm = _normLine(cand);
                if (!norm) continue;
                var at = _findNorm(merged, norm);
                if (at >= 0) { anchor = at; continue; }
                // Never insert ahead of the first matched line: an unanchored
                // fragment could have come from anywhere on the page.
                if (anchor < 0) continue;
                if (added >= 25) break;
                merged.splice(anchor + 1, 0, cand);
                anchor += 1;
                added++;
            }
        }

        if (added) {
            var body = [];
            for (var m = 0; m < merged.length; m++) {
                if (_clean(merged[m])) body.push(_clean(merged[m]));
            }
            narr.text = _paragraphize(body);
            report.diagnostics.narrativeChars = narr.text.length;
            report.diagnostics.narrativeLinesRecovered =
                (report.diagnostics.narrativeLinesRecovered || 0) + added;
            var msg = 'Narrative: ' + added + ' line' + (added === 1 ? '' : 's') +
                ' missed by the primary OCR pass were recovered by a second pass — ' +
                'verify the narrative against the source document.';
            if (report.diagnostics.warnings.indexOf(msg) === -1) {
                report.diagnostics.warnings.push(msg);
            }
        }
        return added;
    }

    /* ================================================================
     * Banded narrative rebuild.
     * ----------------------------------------------------------------
     * The recovery above is ADDITIVE and anchored, which is the right shape
     * when the primary pass read MOST of a page and dropped a trailing row.
     * It cannot help when the primary pass read essentially NOTHING: with no
     * matched line there is no anchor, so nothing is ever inserted.
     *
     * That is the failure mode on agency forms that print the narrative into a
     * ruled grid with a horizontal rule on each text baseline. Measured on a
     * real Arkansas report, the two narrative pages OCR'd to 476 and 201
     * characters of "A / ER / EE / ___" while every other page read 2.6k-6.2k.
     * The pages are perfectly legible; Tesseract's line finder is merging the
     * rule with the glyphs.
     *
     * modules/rms/band-ocr.js re-reads such a page row by row, using the rules
     * themselves as the line boundaries (PSM 7 per band). It returns rows in
     * document order, each with a confidence. Empty rows come back blank, and
     * those are the paragraph breaks.
     *
     * Here we decide whether to TRUST that read. Unlike recoverNarrative(),
     * this REPLACES a page's narrative, so the bar is deliberately high:
     *   * a band is narrative only if it clears BAND_MIN_CONF and looks like
     *     prose rather than a label grid or a checkbox row;
     *   * we take the last contiguous run of such bands on the page, which is
     *     where the narrative sits on these forms (the label grid is above it
     *     and the unused ruled rows below it read as low-confidence noise);
     *   * the run must be materially better than what the primary pass got for
     *     that page, or the primary read stands.
     * Any replacement is disclosed in diagnostics.warnings — an examiner must
     * know the narrative came from a re-read.
     * ================================================================ */
    var BAND_MIN_CONF = 55;   // real rows measured 74-95, noise rows 0-35
    var BAND_GAP = 2;         // blank rows tolerated inside one narrative run
    var BAND_MIN_RUN = 3;     // fewer rows than this is not a narrative

    /*
     * The band's own vertical rules survive whitening as a thin antialiased
     * edge that PSM 7 reads as a stray glyph at one or both margins:
     *
     *   "| Upon arrival, I made contact with Ms Stivers. I immediately |"
     *   "...near his mother's |"      "...taken into custody. a"
     *
     * Erasing more pixels in band-ocr.js removes these AND occasionally the
     * whole line (measured — see the comment there), so they are stripped
     * textually instead. STRICTLY at the margins, and ONLY tokens that are
     * pure punctuation and therefore cannot be the officer's own words:
     * a leading pipe/bracket run followed by a space, and a trailing
     * pipe/bracket run. "I " is not in the set — a police narrative is full
     * of lines that genuinely start "I ".
     *
     * A wider rule WAS tried: strip a one-to-two LETTER token sitting after a
     * sentence-terminating period, on the theory that a printed line does not
     * end one letter into a new sentence. It does. On the reference report it
     * deleted the real word "Ms" from "...brought it back to Ms Stivers. Ms"
     * — a wrapped line ending on the first word of the next sentence. Single
     * stray letters (" i", " I", " a", " oo") therefore SURVIVE into the
     * narrative. That is deliberate: the rebuild already carries a warning
     * telling the examiner to verify against the source, and a visible
     * artifact is always better than a silently deleted word of evidence.
     */
    var RE_RULE_LEAD = /^[|\[\]{}!¦]+\s+/;
    var RE_RULE_TAIL_PUNCT = /\s+[|\[\]{}!¦]+\s*$/;

    function _stripRuleGlyphs(s) {
        var t = String(s == null ? '' : s);
        t = t.replace(RE_RULE_LEAD, '');
        t = t.replace(RE_RULE_TAIL_PUNCT, '');
        return t.replace(/\s+$/, '');
    }

    function _bandIsNarrative(band) {
        if (!band) return false;
        var s = _clean(band.text);
        if (!s) return false;
        if ((band.conf || 0) < BAND_MIN_CONF) return false;
        if (RE_PAGE_HEADER.test(s)) return false;
        if (/^\W{0,3}NARRATIVE\b/i.test(s)) return false;
        if (_isPageBreak(s)) return false;
        return _isProse(s) || _isNarrativeFragment(s);
    }

    /* Last contiguous run of narrative bands on the page, blanks kept so they
     * can become paragraph breaks. */
    function _narrativeRunFromBands(bands) {
        var runs = [];
        var cur = null;
        var gap = 0;
        for (var i = 0; i < bands.length; i++) {
            if (_bandIsNarrative(bands[i])) {
                var txt = _stripRuleGlyphs(_clean(bands[i].text));
                if (!txt) { if (cur) gap++; continue; }
                if (!cur) { cur = { items: [], count: 0 }; runs.push(cur); }
                else if (gap) { for (var g = 0; g < Math.min(gap, 1); g++) cur.items.push(''); }
                cur.items.push(txt);
                cur.count++;
                gap = 0;
            } else if (cur) {
                gap++;
                if (gap > BAND_GAP) { cur = null; gap = 0; }
            }
        }
        var best = null;
        for (var r = 0; r < runs.length; r++) {
            if (runs[r].count >= BAND_MIN_RUN) best = runs[r];   // last qualifying run
        }
        if (!best) return null;
        var out = best.items.slice();
        while (out.length && !out[out.length - 1]) out.pop();
        while (out.length && !out[0]) out.shift();
        return out.length ? out : null;
    }

    function _proseCount(text) {
        var ls = _lines(text || '');
        var n = 0;
        for (var i = 0; i < ls.length; i++) if (_isProse(ls[i])) n++;
        return n;
    }

    /* ---- banded / primary row reconciliation ----------------------------
     * Band OCR reads a ruled row in isolation, which is exactly why it works
     * — but the first narrative row shares its band with the form's
     * "NARRATIVE:" cell label, and PSM 7 reading that whole row makes a mess
     * of the words beside the label. Measured on Faulkner 26-0506420 page 4:
     *
     *   banded : "rg SN at ——— 2309, T was dispatched to 48 Brown Rd. ..."
     *   primary: "On 05/22/2026 at approximately 2309, I was dispatched ..."
     *
     * The primary pass collapsed on that PAGE yet still read that ROW
     * correctly — and that row carries the dispatch date, which is evidence.
     *
     * So each rebuilt row is compared against the page's primary rows, and
     * where the two are plainly the same printed row AND the primary read is
     * plainly cleaner, the primary text wins. Deliberately conservative: a
     * strong word overlap, a clear quality margin, and each primary row may
     * be spent at most once. A tie always leaves the banded row alone.
     */
    function _wordSet(s) {
        var out = {};
        var m = String(s == null ? '' : s).toLowerCase().match(/[a-z0-9]{3,}/g) || [];
        for (var i = 0; i < m.length; i++) out[m[i]] = true;
        return out;
    }

    function _wordOverlap(a, b) {
        var ka = Object.keys(a), kb = Object.keys(b);
        if (!ka.length || !kb.length) return 0;
        var hit = 0;
        for (var i = 0; i < ka.length; i++) if (b[ka[i]]) hit++;
        return hit / Math.min(ka.length, kb.length);
    }

    /* Crude but stable: how many tokens on this line are plausibly words or
     * numbers, less how many are OCR debris. */
    function _lineQuality(s) {
        var toks = String(s == null ? '' : s).trim().split(/\s+/);
        var good = 0, junk = 0;
        for (var i = 0; i < toks.length; i++) {
            var t = toks[i].replace(/^[("'[]+/, '').replace(/[.,;:!?)"'\]]+$/, '');
            if (!t) { junk++; continue; }
            if (/^[A-Za-z][A-Za-z'-]+$/.test(t)) good++;
            else if (/^\d[\d\/:.,-]*\d$/.test(t)) good++;
            else if (/^[AaIi]$/.test(t)) good++;
            else junk++;
        }
        return good - junk;
    }

    function _reconcileBandedWithPrimary(bandLines, primaryLines) {
        if (!primaryLines || !primaryLines.length) return bandLines;
        var out = bandLines.slice();
        var used = {};
        for (var i = 0; i < out.length; i++) {
            var b = _clean(out[i]);
            if (!b) continue;
            var bw = _wordSet(b);
            if (Object.keys(bw).length < 5) continue;   // too short to match safely
            var bestIdx = -1, bestOv = 0;
            for (var j = 0; j < primaryLines.length; j++) {
                if (used[j]) continue;
                var p = _clean(primaryLines[j]);
                if (!p || !_isProse(p)) continue;
                var ov = _wordOverlap(bw, _wordSet(p));
                if (ov > bestOv) { bestOv = ov; bestIdx = j; }
            }
            if (bestIdx < 0 || bestOv < 0.6) continue;
            var pl = _clean(primaryLines[bestIdx]);
            if (_lineQuality(pl) - _lineQuality(b) >= 2) {
                out[i] = pl;
                used[bestIdx] = true;
            }
        }
        return out;
    }

    /* The primary OCR lines of one page, straight from the text parse() was
     * given. Used only to reconcile a banded rebuild. */
    function _primaryPageLines(report, pageNo) {
        if (!report || !report.rawText) return null;
        var pages = _splitPages(_lines(report.rawText));
        for (var i = 0; i < pages.length; i++) {
            if (pages[i].index === pageNo) return pages[i].lines;
        }
        return null;
    }

    /* Pages a banded re-read should cover. Union of:
     *   (a) pages the primary pass took narrative from — they may still be
     *       degraded even when a little text came through;
     *   (b) pages carrying the "NARRATIVE CONTINUATION" banner;
     *   (c) the page immediately before the first continuation page. A
     *       continuation page continues something, so the narrative began
     *       earlier; that earlier page is invisible to (a) when its own
     *       "NARRATIVE:" cell label was destroyed — which is exactly what
     *       happened on page 4 of the reference report. */
    function narrativeBandPages(report) {
        var rec = (report && report.narrativeRecovery) || {};
        var seen = {};
        var out = [];
        function add(n) {
            n = parseInt(n, 10);
            if (!Number.isInteger(n) || n < 1 || seen[n]) return;
            seen[n] = true; out.push(n);
        }
        (rec.pages || []).forEach(add);
        (rec.bandCandidates || []).forEach(add);
        var cont = (rec.continuationPages || []).slice().sort(function (a, b) { return a - b; });
        cont.forEach(add);
        if (cont.length && cont[0] > 1) add(cont[0] - 1);
        return out.sort(function (a, b) { return a - b; });
    }

    /**
     * @param {object} report        a parse() result, mutated in place
     * @param {object} bandedByPage  { "<page>": { lines:[{text,conf,blank}] } }
     *                               as returned by band-ocr.bandOcrPages()
     * @returns {number} how many pages were replaced
     */
    function recoverNarrativeBanded(report, bandedByPage) {
        if (!report || !bandedByPage) return 0;
        var rec = report.narrativeRecovery || (report.narrativeRecovery = {});
        var byPage = rec.byPage || (rec.byPage = {});
        var replaced = [];

        Object.keys(bandedByPage).forEach(function (key) {
            var pageNo = parseInt(key, 10);
            if (!Number.isInteger(pageNo)) return;
            var page = bandedByPage[key];
            var bands = (page && page.lines) || (Array.isArray(page) ? page : null);
            if (!bands || !bands.length) return;

            var run = _narrativeRunFromBands(bands);
            if (!run) return;

            var body = [];
            for (var i = 0; i < run.length; i++) {
                if (run[i]) body.push(run[i]);
                else if (body.length && body[body.length - 1] !== '') body.push('');
            }
            while (body.length && !body[body.length - 1]) body.pop();
            if (!body.length) return;

            // Where the primary pass read a row better than the band did,
            // keep the primary row. See _reconcileBandedWithPrimary().
            body = _reconcileBandedWithPrimary(body, _primaryPageLines(report, pageNo));

            // A banded row IS a printed row, so the blank rows already carry the
            // paragraph structure. Join directly rather than re-guessing it.
            var text = body.join('\n').replace(/\n{3,}/g, '\n\n');

            var prior = byPage[pageNo] || '';
            // Replace only on a material gain. A banded read that merely ties
            // the primary read buys nothing and costs provenance.
            if (_proseCount(text) < _proseCount(prior) + 3) return;

            byPage[pageNo] = text;
            replaced.push(pageNo);
        });

        if (!replaced.length) return 0;

        var order = Object.keys(byPage)
            .map(Number)
            .filter(function (n) { return Number.isInteger(n); })
            .sort(function (a, b) { return a - b; });
        var joined = order.map(function (n) { return byPage[n]; })
            .filter(function (t) { return t && t.trim(); })
            .join('\n\n');

        if (!report.narratives) report.narratives = [];
        if (!report.narratives.length) {
            report.narratives.push({ officer: '', badge: '', text: '' });
        }
        report.narratives[0].text = joined;

        rec.pages = order;
        report.diagnostics = report.diagnostics || {};
        report.diagnostics.warnings = report.diagnostics.warnings || [];
        report.diagnostics.narrativeChars = joined.length;
        report.diagnostics.narrativePagesRebuilt =
            (report.diagnostics.narrativePagesRebuilt || 0) + replaced.length;

        replaced.sort(function (a, b) { return a - b; });

        /* A page we just rebuilt is no longer unreadable, and the report is no
         * longer narrative-less. Drop both stale warnings and re-state the
         * unreadable one for whatever is still genuinely missing. */
        var stillBad = (rec.unreadablePages || []).filter(function (n) {
            return replaced.indexOf(n) === -1;
        });
        rec.unreadablePages = stillBad;
        var w = report.diagnostics.warnings;
        for (var wi = w.length - 1; wi >= 0; wi--) {
            if (w[wi].indexOf(NARRATIVE_UNREADABLE_PREFIX) === 0) w.splice(wi, 1);
            else if (w[wi] === 'No NARRATIVE section found.') w.splice(wi, 1);
        }
        if (stillBad.length) {
            w.push(NARRATIVE_UNREADABLE_PREFIX + stillBad.join(', ') +
                ' could not be read from this scan. It was left out rather than imported as OCR noise - read it from the source document.');
        }

        var msg = 'Narrative: the ruled grid defeated the primary OCR pass on page' +
            (replaced.length === 1 ? ' ' : 's ') + replaced.join(', ') +
            '. Those page' + (replaced.length === 1 ? ' was' : 's were') +
            ' re-read row by row — verify the narrative against the source document.';
        if (report.diagnostics.warnings.indexOf(msg) === -1) {
            report.diagnostics.warnings.push(msg);
        }
        return replaced.length;
    }

    /* ================================================================
     * parse()
     * ================================================================ */

    function parse(text, fileName) {
        var raw = String(text == null ? '' : text);
        var lines = _lines(raw);

        // The supplement form shares only the incident number with the NIBRS
        // report — no offense band, no person blocks, no continuation pages.
        if (_isSupplementForm(raw) && !/INCIDENT\s+REPORT/i.test(raw)) {
            return _parseSupplement(raw, lines, fileName);
        }

        var pages = _splitPages(lines);

        var warnings = [];
        function warn(msg) { if (warnings.indexOf(msg) === -1) warnings.push(msg); }

        var header = _readHeader(pages, warn);
        var offenses = _readOffenses(pages, warn);
        var victims = _readVictims(pages, warn);
        var arrestees = _readArrestees(pages, warn);
        var generic = _readGenericPersonBlocks(pages, warn);
        var others = _readOthersInvolved(pages, warn);
        var narrRead = _readNarrative(pages, warn);
        var narratives = narrRead.items;

        var officerLabel = _clean(header.reportingOfficer);
        for (var n = 0; n < narratives.length; n++) {
            narratives[n].officer = officerLabel || '';      // must be a string
            narratives[n].badge = header.officerCode || '';
        }

        /*
         * A person block with no readable name is NOT routed into the case
         * tabs: a nameless row in Suspects/Victims/Involved Persons is noise,
         * and the shared router de-duplicates on name so two nameless rows
         * would collapse into one. They are held in `provisionalPersons`
         * instead, reported in diagnostics, and promoted by recoverNames()
         * once a sparse-OCR pass supplies the typed name.
         */
        var candidates = [].concat(victims, arrestees, generic, others);
        var persons = [];
        var provisional = [];
        for (var i = 0; i < candidates.length; i++) {
            var c = candidates[i];
            if (typeof c.involvement !== 'string' || !c.involvement) c.involvement = ROLE.OTHER;
            if (c.name) persons.push(c);
            else provisional.push(c);
        }

        var reportType = 'Arkansas Incident Report';
        if (header.approvalStatus) reportType += ' (' + header.approvalStatus + ')';

        var locationOfOffense = '';
        for (var o = 0; o < offenses.length; o++) {
            if (offenses[o].location) { locationOfOffense = offenses[o].location; break; }
        }

        var report = {
            id: 'rms_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            fileName: fileName || '',
            importedAt: new Date().toISOString(),
            reportNumber: header.incidentNumber || '',
            reportDate: header.reportDate || header.incidentDate || '',
            reportType: reportType,
            supplementNo: '',
            agencyName: header.agencyName || '',
            location: locationOfOffense,
            beat: header.reportingArea || '',
            fromDateTime: _clean((header.incidentDate || '') + ' ' + (header.incidentTime || '')),
            toDateTime: '',
            offenses: offenses,
            personsInvolved: persons,
            provisionalPersons: provisional,
            vehicles: [],            // VEHICLE band is present but was empty; no typed values to import
            property: [],
            narratives: narratives,
            digital: [],
            confidentialPersons: [],
            pageCount: pages.length,
            rawText: raw,

            // --- Arkansas-specific metadata (additive; ignored by shared UI) ---
            arFormat: 'ar-incident-report',
            arFormatLabel: 'Arkansas State NIBRS Incident Report',
            ar: {
                ori: header.ori || '',
                approvalStatus: header.approvalStatus || '',
                incidentDate: header.incidentDate || '',
                incidentTime: header.incidentTime || '',
                incidentDay: header.incidentDay || '',
                dispatcher: header.dispatcher || '',
                timeReceived: header.timeReceived || '',
                timeArrived: header.timeArrived || '',
                reportingArea: header.reportingArea || '',
                reportDay: header.reportDay || '',
                reportTime: header.reportTime || '',
                reportingOfficer: header.reportingOfficer || '',
                officerCode: header.officerCode || '',
                victimNameHeader: header.victimNameHeader || ''
            },
            diagnostics: {
                pages: pages.length,
                offenses: offenses.length,
                persons: persons.length,
                victims: victims.length,
                arrestees: arrestees.length,
                witnesses: generic.filter(function (x) { return x.involvement === ROLE.WITNESS; }).length,
                othersInvolved: others.length,
                provisional: provisional.length,
                namesRecovered: 0,
                narrativeChars: narratives.length ? narratives[0].text.length : 0,
                narrativeLinesRecovered: 0,
                checkboxFieldsSkipped: true,
                warnings: warnings
            }
        };

        // Pages a second (PSM 3) OCR pass should cover to recover narrative
        // rows the primary pass dropped. See recoverNarrative().
        // `byPage` keeps per-page provenance so a banded re-read can replace a
        // single page without disturbing the others — see
        // recoverNarrativeBanded().
        report.narrativeRecovery = {
            pages: narrRead.pages || [],
            byPage: narrRead.byPage || {},
            continuationPages: narrRead.continuationPages || [],
            bandCandidates: narrRead.bandCandidates || [],
            unreadablePages: narrRead.unreadablePages || []
        };

        _describeProvisional(report, warn);
        return report;
    }

    /* Rebuild the pending-recovery index and the matching warning. */
    function _describeProvisional(report, warn) {
        var pagesSet = {};
        var labels = [];
        for (var i = 0; i < report.provisionalPersons.length; i++) {
            var p = report.provisionalPersons[i];
            if (p.sourcePage) pagesSet[p.sourcePage] = true;
            labels.push(p.involvement + ' (page ' + (p.sourcePage || '?') + ')');
        }
        var pageList = Object.keys(pagesSet).map(Number).sort(function (a, b) { return a - b; });
        report.nameRecovery = { pages: pageList, count: report.provisionalPersons.length };
        report.diagnostics.provisional = report.provisionalPersons.length;

        var w = report.diagnostics.warnings;
        for (var wi = w.length - 1; wi >= 0; wi--) {
            if (/^Name not read for /.test(w[wi])) w.splice(wi, 1);
        }
        if (labels.length) {
            var msg = 'Name not read for ' + labels.length + ' person block' +
                (labels.length === 1 ? '' : 's') + ': ' + labels.join(', ') +
                '. Not imported into the case tabs — verify against the source document.';
            if (typeof warn === 'function') warn(msg);
            else if (w.indexOf(msg) === -1) w.push(msg);
        }
    }

    function needsNameRecovery(report) {
        return !!(report && report.provisionalPersons && report.provisionalPersons.length);
    }

    /* Pages a sparse-OCR pass should cover to fill the missing names. */
    function nameRecoveryPages(report) {
        return (report && report.nameRecovery && report.nameRecovery.pages) || [];
    }

    /* ================================================================
     * recoverNames()
     * ----------------------------------------------------------------
     * Tesseract's layout segmentation reliably drops the typed NAME value in
     * the continuation-page "Others Involved" blocks even though it is clearly
     * legible in the render. A sparse-text OCR pass (PSM 11) over just those
     * pages recovers it. This only ever FILLS a name that is already blank —
     * it never overwrites a value the primary pass read.
     * ================================================================ */
    function recoverNames(report, sparseByPage) {
        if (!report || !report.provisionalPersons || !report.provisionalPersons.length) return 0;
        if (!sparseByPage) return 0;
        var filled = 0;

        // Group the provisional blocks by source page, preserving document order.
        var byPage = {};
        for (var i = 0; i < report.provisionalPersons.length; i++) {
            var it = report.provisionalPersons[i];
            var key = String(it.sourcePage || 0);
            (byPage[key] = byPage[key] || []).push(it);
        }

        Object.keys(byPage).forEach(function (pageKey) {
            var sparse = sparseByPage[pageKey] != null ? sparseByPage[pageKey]
                : sparseByPage[Number(pageKey)];
            if (!sparse) return;
            var sLines = _lines(sparse);

            // Candidate names in sparse reading order. Page-header rows repeat
            // the victim name, so they are skipped — an "Others Involved" block
            // must never inherit it.
            var candidates = [];
            for (var l = 0; l < sLines.length; l++) {
                if (RE_PAGE_HEADER.test(sLines[l])) continue;
                var nm = _extractName(sLines[l]);
                if (nm) candidates.push({ line: l, name: nm, used: false });
            }
            if (!candidates.length) return;

            // A name already read by the primary pass is never a candidate for
            // a different block.
            for (var e = 0; e < report.personsInvolved.length; e++) {
                var taken = report.personsInvolved[e].name;
                if (!taken) continue;
                for (var t = 0; t < candidates.length; t++) {
                    if (candidates[t].name === taken) candidates[t].used = true;
                }
            }

            var items = byPage[pageKey];
            for (var k = 0; k < items.length; k++) {
                var person = items[k];
                if (person.name) continue;

                // Anchor on the typed role heading when there is one, so a
                // multi-block page assigns names to the right block.
                var anchor = -1;
                var role = person.involvement;
                if (role && role !== ROLE.OTHER) {
                    for (var a = 0; a < sLines.length; a++) {
                        if (_clean(sLines[a]).toUpperCase() === role.toUpperCase()) { anchor = a; break; }
                    }
                }
                var pick = null;
                if (anchor >= 0) {
                    for (var c = 0; c < candidates.length; c++) {
                        if (candidates[c].line > anchor && !candidates[c].used) { pick = candidates[c]; break; }
                    }
                }
                if (!pick) {
                    for (var c2 = 0; c2 < candidates.length; c2++) {
                        if (!candidates[c2].used) { pick = candidates[c2]; break; }
                    }
                }
                if (!pick) continue;

                pick.used = true;
                person.name = pick.name;
                person.alias = _aliasOf(pick.name);
                person.comments = _clean((person.comments || '') +
                    ' Name read by sparse-text OCR of page ' + pageKey + '.');
                // Only the NAME is taken from the sparse pass. Sparse mode
                // discards column alignment, so an address or phone read from
                // it could belong to the neighbouring block on the same page —
                // those values stay with whatever the layout pass read.
                filled++;
            }
        });

        if (filled) {
            var keep = [];
            for (var r = 0; r < report.provisionalPersons.length; r++) {
                var pp = report.provisionalPersons[r];
                if (pp.name) report.personsInvolved.push(pp);
                else keep.push(pp);
            }
            report.provisionalPersons = keep;
            report.diagnostics.persons = report.personsInvolved.length;
            report.diagnostics.namesRecovered = (report.diagnostics.namesRecovered || 0) + filled;
            _describeProvisional(report, null);
        }
        return filled;
    }

    /* ================================================================
     * quickScan() — used by the create-case screen (index.html), which needs a
     * case number, a synopsis and the set of modules to tick BEFORE the case
     * exists. Cheap, read-only, and safe to call on any text.
     * ================================================================ */
    function quickScan(text, fileName) {
        var t = String(text == null ? '' : text);
        var result = { caseNum: '', synopsis: '', location: '', primaryOffense: '', offenseList: [], detected: {}, matched: false };
        if (!detect(t)) return result;
        result.matched = true;

        var lines = _lines(t);

        /* A supplement carries the PARENT incident number and a narrative,
         * nothing else — no offense row, no address of offense. Return the
         * case number so the create-case screen can link it, and a synopsis
         * drawn from the narrative itself. */
        if (_isSupplementForm(t) && !/INCIDENT\s+REPORT/i.test(t)) {
            var sh = _readSupplementHeader(lines);
            var sBody = _readSupplementNarrative(lines);
            result.caseNum = sh.incidentNumber || '';
            var sParts = [];
            if (sh.supplementType) sParts.push(sh.supplementType);
            if (sh.supplementDate) {
                sParts.push('Supplement ' + sh.supplementDate +
                    (sh.supplementTime ? ' ' + sh.supplementTime : ''));
            }
            if (sh.officer) sParts.push('Supplementing officer ' + sh.officer);
            result.synopsis = sParts.join('. ');
            if (result.synopsis) result.synopsis += '.';
            if (_bodyIsReadable(sBody)) {
                var sTxt = sBody.filter(Boolean).slice(0, 3).join(' ').slice(0, 400);
                result.synopsis = (result.synopsis ? result.synopsis + ' ' : '') + sTxt;
            }
            result.detected.rmsImports = true;
            return result;
        }

        var pages = _splitPages(lines);
        var noop = function () {};
        var header = _readHeader(pages, noop);
        var offenses = _readOffenses(pages, noop);
        var victims = _readVictims(pages, noop);
        var arrestees = _readArrestees(pages, noop);
        var generic = _readGenericPersonBlocks(pages, noop);
        var others = _readOthersInvolved(pages, noop);
        var narratives = _readNarrative(pages, noop).items;

        result.caseNum = header.incidentNumber || '';

        /*
         * ADDRESS OF OFFENSE is the case's Location of Occurrence — the same
         * fact under two names. Surface it (and the primary offense) so the
         * create-case screen can pre-fill those fields instead of leaving the
         * officer to re-type what is printed on page 1.
         *
         * The offense description is carried VERBATIM, statute citation
         * included, exactly as the Overview tab's primaryOffense is treated
         * everywhere else in VIPER. Never reworded.
         */
        for (var q = 0; q < offenses.length; q++) {
            if (!result.location && offenses[q].location) result.location = offenses[q].location;
            if (!offenses[q].description) continue;
            var lbl = [offenses[q].statute, offenses[q].description].filter(Boolean).join(' ');
            if (result.offenseList.indexOf(lbl) === -1) result.offenseList.push(lbl);
        }
        result.primaryOffense = result.offenseList[0] || '';

        var parts = [];
        if (offenses.length) {
            var descs = [];
            for (var o = 0; o < offenses.length; o++) {
                var d = [offenses[o].statute, offenses[o].description].filter(Boolean).join(' ');
                if (d) descs.push(d);
            }
            if (descs.length) parts.push(descs.join('; '));
        }
        if (header.incidentDate) {
            var occurred = 'Occurred ' + header.incidentDate +
                (header.incidentTime ? ' ' + header.incidentTime : '');
            if (offenses.length && offenses[0].location) occurred += ' at ' + offenses[0].location;
            parts.push(occurred);
        } else if (offenses.length && offenses[0].location) {
            parts.push('Location ' + offenses[0].location);
        }
        if (header.agencyName) parts.push('Reported to ' + header.agencyName);
        if (header.reportingOfficer) parts.push('Reporting officer ' + header.reportingOfficer);
        result.synopsis = parts.join('. ');
        if (result.synopsis) result.synopsis += '.';

        if (!result.synopsis && narratives.length) {
            result.synopsis = narratives[0].text.split('\n').slice(0, 3).join(' ').slice(0, 400);
        }

        var det = result.detected;
        det.rmsImports = true;
        // Only tick a module when the block actually yielded typed values —
        // an empty form block must not create an empty tab.
        if (victims.filter(_hasData).length) det.victims = true;
        if (arrestees.filter(_hasData).length) det.suspects = true;
        for (var g = 0; g < generic.length; g++) {
            if (!_hasData(generic[g])) continue;
            if (generic[g].involvement === ROLE.WITNESS) det.witnesses = true;
            else det.involvedPersons = true;
        }
        if (others.filter(_hasData).length) det.involvedPersons = true;

        return result;
    }

    return {
        ROLE: ROLE,
        detect: detect,
        parse: parse,
        quickScan: quickScan,
        needsNameRecovery: needsNameRecovery,
        nameRecoveryPages: nameRecoveryPages,
        recoverNames: recoverNames,
        narrativeRecoveryPages: narrativeRecoveryPages,
        recoverNarrative: recoverNarrative,
        narrativeBandPages: narrativeBandPages,
        recoverNarrativeBanded: recoverNarrativeBanded,
        // exposed for tests
        _internal: {
            extractName: _extractName,
            splitPages: _splitPages,
            strip: _strip,
            isProse: _isProse,
            isNarrativeFragment: _isNarrativeFragment,
            paragraphize: _paragraphize,
            fmtPhone: _fmtPhone,
            scanAddress: _scanAddress,
            bandIsNarrative: _bandIsNarrative,
            bodyIsReadable: _bodyIsReadable,
            junkRatio: _junkRatio,
            lineQuality: _lineQuality,
            reconcileBandedWithPrimary: _reconcileBandedWithPrimary,
            isSupplementForm: _isSupplementForm,
            readSupplementHeader: _readSupplementHeader,
            readSupplementNarrative: _readSupplementNarrative,
            stripRuleGlyphs: _stripRuleGlyphs,
            narrativeRunFromBands: _narrativeRunFromBands,
            looksLikeNarrativeContinuation: _looksLikeNarrativeContinuation
        }
    };
});

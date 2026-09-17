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
 *      ("PUTNEY (JV2), ISABELLA") are preserved exactly as printed. The alias
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
     * ("= STORKE (JV1), WALKER", "&) 08/13/2026 ..."). Only non-alphanumeric
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
     *   "KITTLER (JV3), JAXON £5 (F) Female OJ 0) Unknown"  ->  "KITTLER (JV3), JAXON"
     *   "PUTNEY (JV2), ISABELLA 08/31/2011"                 ->  "PUTNEY (JV2), ISABELLA"
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
            // Offense band runs from the OFFENSE #/UCR CODE label row to the
            // LOCATION CODE legend (or the VICTIM band if the legend is lost).
            var start = _findLine(lines, /OFFENSE\s*#/i, 0, lines.length);
            if (start < 0) continue;
            var end = _findLine(lines, /LOCATION\s*CODE/i, start, lines.length);
            if (end < 0) end = _findLine(lines, /VICTIM\s*#/i, start, lines.length);
            if (end < 0) end = Math.min(start + 14, lines.length);

            var number = '';
            var ucr = '';
            for (var i = start + 1; i < end; i++) {
                var row = _strip(lines[i]);
                var mn = /^(\d{1,2})\s+(\d{2}[A-Z]?)\b/.exec(row);
                if (mn) { number = mn[1]; ucr = mn[2]; break; }
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

    function _readNarrative(pages, warn) {
        var chunks = [];
        var started = false;
        for (var p = 0; p < pages.length; p++) {
            var page = pages[p];
            var lines = page.lines;
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
                if (body.length) chunks.push(body.join('\n'));
                continue;
            }

            // Unlabelled narrative spill onto a later page: prose only, and only
            // once the narrative has actually started.
            if (!started || _hasOthersHeading(lines) >= 0) continue;
            var prose = [];
            for (var j = 0; j < lines.length; j++) {
                if (RE_PAGE_HEADER.test(lines[j])) continue;
                if (_isProse(lines[j])) prose.push(_clean(lines[j]));
            }
            if (prose.length >= 2) chunks.push(prose.join('\n'));
        }

        if (!chunks.length) {
            warn('No NARRATIVE section found.');
            return [];
        }
        return [{
            officer: '',            // filled by parse() from the ADM footer
            badge: '',
            text: chunks.join('\n\n')
        }];
    }

    /* ================================================================
     * parse()
     * ================================================================ */

    function parse(text, fileName) {
        var raw = String(text == null ? '' : text);
        var lines = _lines(raw);
        var pages = _splitPages(lines);

        var warnings = [];
        function warn(msg) { if (warnings.indexOf(msg) === -1) warnings.push(msg); }

        var header = _readHeader(pages, warn);
        var offenses = _readOffenses(pages, warn);
        var victims = _readVictims(pages, warn);
        var arrestees = _readArrestees(pages, warn);
        var generic = _readGenericPersonBlocks(pages, warn);
        var others = _readOthersInvolved(pages, warn);
        var narratives = _readNarrative(pages, warn);

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
                checkboxFieldsSkipped: true,
                warnings: warnings
            }
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
        var result = { caseNum: '', synopsis: '', detected: {}, matched: false };
        if (!detect(t)) return result;
        result.matched = true;

        var lines = _lines(t);
        var pages = _splitPages(lines);
        var noop = function () {};
        var header = _readHeader(pages, noop);
        var offenses = _readOffenses(pages, noop);
        var victims = _readVictims(pages, noop);
        var arrestees = _readArrestees(pages, noop);
        var generic = _readGenericPersonBlocks(pages, noop);
        var others = _readOthersInvolved(pages, noop);
        var narratives = _readNarrative(pages, noop);

        result.caseNum = header.incidentNumber || '';

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
        // exposed for tests
        _internal: {
            extractName: _extractName,
            splitPages: _splitPages,
            strip: _strip,
            isProse: _isProse,
            fmtPhone: _fmtPhone,
            scanAddress: _scanAddress
        }
    };
});

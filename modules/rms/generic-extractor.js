/*
 * V.I.P.E.R. — generic (format-agnostic) RMS extractor
 * ----------------------------------------------------
 * A reader that looks at the WORDS ON THE PAGE instead of at a format.
 *
 * WHY THIS EXISTS
 *
 * parseRmsReport() is an ordered chain of format sniffers, and its last branch
 * — logged as "fallback" — is a bespoke reader for one vendor's layout. So a
 * report from an agency nobody has written code for is parsed by a reader
 * built for somebody else's form, and comes back close to empty. There was no
 * reader in the tree that simply read the document.
 *
 * THE CENTRAL RULE
 *
 *     The label finds the neighbourhood. The shape finds the value.
 *
 * Neither half works alone, and 5.2.4 already paid for that lesson:
 *   - Label alone fails because OCR (PSM 6) left-packs a ruled form row. Five
 *     labels above three values do not line up; column position is a lie.
 *   - Shape alone fails because ten digits is a phone OR a licence OR an
 *     account number, and 01/15/1988 is a birth date OR an offense date.
 *
 * So every harvest is: find an indicator, open a small window (the rest of
 * that line plus the next few non-empty lines), and inside that window take
 * the token whose SHAPE matches the type the indicator promised. There is no
 * assumption anywhere about page, order, or column.
 *
 * THE SAFETY MODEL — read this before changing anything
 *
 * A heuristic reader that looks authoritative is worse than no reader at all.
 * So NOTHING this module produces is ever filed automatically:
 *
 *   - `personsInvolved` is ALWAYS returned empty. People go in `reviewPersons`.
 *     routeRmsPersonsToTabs() reads only `personsInvolved`, which makes
 *     auto-routing structurally impossible rather than merely switched off.
 *     Do not "helpfully" populate it.
 *   - Every harvested value records where it came from in `fieldSources`
 *     (page, line, and the label that claimed it) so an officer can check it
 *     against the document.
 *   - Nothing is inferred. A blank field beats a guessed one, always.
 *
 * STANDING EVIDENTIARY RULES (examiner's decisions, inherited from 5.2.4):
 *   - Checkbox fields are never interpreted. Sex/race/ethnicity are read ONLY
 *     when a genuine typed word follows the label, because that is text on the
 *     page rather than a reading of a ticked box.
 *   - Offense severity is NEVER derived from a statute.
 *   - Names are verbatim, alias tokens included.
 *   - OCR damage is never auto-corrected.
 *
 * UMD: window.GenericRmsExtractor in the renderer, module.exports in Node.
 * Pure — no Electron, no DOM, no filesystem. Requires rms-shapes.js.
 */
(function (root, factory) {
    'use strict';
    var api = factory();
    if (typeof module === 'object' && module && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.GenericRmsExtractor = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    var S = (typeof globalThis !== 'undefined' && globalThis.RmsShapes)
        ? globalThis.RmsShapes
        : ((typeof require === 'function') ? require('./rms-shapes.js') : null);
    if (!S) {
        throw new Error('generic-extractor.js requires modules/rms/rms-shapes.js to be loaded first');
    }

    var FORMAT = 'generic';
    var FORMAT_LABEL = 'Generic (format-agnostic) read';

    /* The banner the UI shows above anything this module produced. Officers,
     * not developers, read this. */
    var GENERIC_BANNER =
        'This report is not in a format V.I.P.E.R. recognises, so it was read ' +
        'generically by looking for labelled fields anywhere on the page. ' +
        'Nothing below has been filed into the case. Check each entry against ' +
        'the document and use Move to… to keep the ones that are right.';

    /* ================================================================
     * Roles
     * ================================================================
     * routeRmsPersonsToTabs() classifies suspects with
     * /SUSPECT|ARRESTED|DEFENDANT/i — it does NOT match ARRESTEE or OFFENDER.
     * A person labelled only "ARRESTEE" is silently dropped by the router, so
     * the role string carries the router's keyword as well as the printed one.
     */
    var ROLE = {
        SUSPECT: 'SUSPECT',
        ARRESTEE: 'SUSPECT (ARRESTEE/OFFENDER)',
        VICTIM: 'VICTIM',
        WITNESS: 'WITNESS',
        COMPLAINANT: 'COMPLAINANT',
        RP: 'REPORTING PARTY',
        INVOLVED: 'INVOLVED PARTY',
        OTHER: 'OTHER PERSON',
        MISSING: 'MISSING PERSON',
        GUARDIAN: 'PARENT/GUARDIAN',
        DRIVER: 'DRIVER',
        OWNER: 'OWNER',
        INFORMANT: 'INFORMANT'
    };

    /* ================================================================
     * The lexicon
     * ================================================================
     * Three classes:
     *   role    — opens a person block
     *   section — closes the open person block and opens its own
     *   field   — harvests one value by shape
     *
     * Every pattern must tolerate OCR damage. A real scan rendered
     * "RESIDENT ADDRESS" as "RESIDENT ODES Ss meee Ci sate", so exact string
     * matching on a label is not a viable strategy.
     *
     * `not` is a veto: DRIVER is a role, but "DRIVER'S LICENSE" is a field and
     * must not open a person block.
     * `head` limits how far into the line the match may start. Section and
     * role headings sit at the left of a row; requiring that is the main brake
     * on harvesting form furniture as people.
     */
    var LEXICON = [
        /* ---------------- roles ---------------- */
        { key: 'suspect',    cls: 'role', role: ROLE.SUSPECT,
          re: /\bSUSPECTS?\b/i, head: 24 },
        { key: 'arrestee',   cls: 'role', role: ROLE.ARRESTEE,
          re: /\bARRESTEES?\b|\bARRESTED\s*(PERSON|SUBJECT)?\b|\bOFFENDERS?\b/i, head: 24 },
        { key: 'defendant',  cls: 'role', role: ROLE.SUSPECT,
          re: /\bDEFENDANTS?\b/i, head: 24 },
        { key: 'victim',     cls: 'role', role: ROLE.VICTIM,
          re: /\bVICTIMS?\b/i, not: /VICTIM\s*WAS|VICTIM\s*TYPE/i, head: 24 },
        { key: 'complainant', cls: 'role', role: ROLE.COMPLAINANT,
          re: /\bCOMPLAINANTS?\b|\bCOMPLNT\b|\bCOMPL\b/i, head: 24 },
        { key: 'witness',    cls: 'role', role: ROLE.WITNESS,
          re: /\bWITNESS(ES)?\b/i, head: 24 },
        { key: 'rp',         cls: 'role', role: ROLE.RP,
          re: /REPORT(ING|ED)\s*(BY|PARTY|PERSON)|\bR\/?P\b/i, head: 24 },
        { key: 'involved',   cls: 'role', role: ROLE.INVOLVED,
          re: /INVOLVED\s*(PARTY|PARTIES|PERSONS?)|OTHERS?\s*INVOLVED|PERSONS?\s*INVOLVED/i,
          head: 24 },
        { key: 'otherparty', cls: 'role', role: ROLE.OTHER,
          re: /OTHER\s*(PARTY|PARTIES|PERSONS?|SUBJECTS?)/i, head: 24 },
        { key: 'informant',  cls: 'role', role: ROLE.INFORMANT,
          re: /\bINFORMANT\b/i, head: 24 },
        { key: 'missing',    cls: 'role', role: ROLE.MISSING,
          re: /MISSING\s*(PERSON|JUVENILE|ADULT)/i, head: 24 },
        { key: 'guardian',   cls: 'role', role: ROLE.GUARDIAN,
          re: /\bGUARDIAN\b|\bPARENT\b/i, head: 24 },
        { key: 'driver',     cls: 'role', role: ROLE.DRIVER,
          re: /\bDRIVERS?\b/i, not: /LICEN[CS]E|\bDL\b|\bDLN\b|\bOLN\b/i, head: 24 },
        { key: 'owner',      cls: 'role', role: ROLE.OWNER,
          re: /\bOWNERS?\b/i, head: 24 },

        /* ---------------- sections ---------------- */
        { key: 'narrative',  cls: 'section', section: 'narrative',
          re: /\bNARRATIVES?\b|\bSYNOPSIS\b|\bSUMMARY\s*OF\b|REPORT\s*DETAILS|OFFICER.{0,3}S?\s*STATEMENT/i,
          head: 30 },
        { key: 'offense',    cls: 'section', section: 'offense',
          re: /\bOFFENSES?\b|\bCHARGES?\b|\bSTATUTE\b|\bUCR\s*CODE\b|\bUCRCODE\b|\bNIBRS\b/i,
          head: 30 },
        { key: 'vehicle',    cls: 'section', section: 'vehicle',
          re: /\bVEHICLES?\b|\bVEH\s*#/i, head: 30 },
        { key: 'property',   cls: 'section', section: 'property',
          re: /\bPROPERTY\b|\bEVIDENCE\b|\bITEMS?\s*SEIZED\b/i, head: 30 },
        { key: 'digital',    cls: 'section', section: 'digital',
          re: /\bDIGITAL\s*(EVIDENCE|MEDIA)\b/i, head: 30 },

        /* ---------------- person fields ---------------- */
        { key: 'name',   cls: 'field', field: 'name',   type: 'name',
          re: /\bNAMES?\b|LAST\s*,?\s*FIRST|\bSURNAME\b/i,
          not: /AGENCY\s*NAME|OFFENSE\s*NAME|BUSINESS\s*NAME|SCHOOL\s*NAME|FILE\s*NAME/i },
        { key: 'dob',    cls: 'field', field: 'dob',    type: 'date',
          re: /\bD\.?O\.?B\.?\b|DATE\s*OF\s*BIRTH|\bBIRTH\s*DATE\b|\bBIRTHDATE\b/i },
        { key: 'age',    cls: 'field', field: 'age',    type: 'age',
          re: /\bEXACT\s*AGE\b|\bAGE\b/i, not: /AGE\s*RANGE|\bPAGE\b/i },
        { key: 'address', cls: 'field', field: 'address', type: 'address',
          re: /RESIDENT\s*ADDRESS|HOME\s*ADDRESS|MAILING\s*ADDRESS|STREET\s*ADDRESS|\bADDRESS\b/i,
          not: /ADDRESS\s*OF\s*OFFENSE|EMAIL\s*ADDRESS|IP\s*ADDRESS/i },
        { key: 'phone',  cls: 'field', field: 'phone',  type: 'phone',
          re: /\bPHONES?\b|\bTELEPHONE\b|\bCELL(ULAR)?\b|CONTACT\s*(NO|NUMBER|#)/i,
          not: /EMPLOY/i },
        { key: 'emplphone', cls: 'field', field: 'employmentPhone', type: 'phone',
          re: /EMPLOY\w*\s*PHONE|WORK\s*PHONE|BUSINESS\s*PHONE/i },
        { key: 'dl',     cls: 'field', field: 'dl',     type: 'dl',
          re: S.RE_DL_LABEL },
        { key: 'dlstate', cls: 'field', field: 'dlState', type: 'state',
          re: S.RE_DL_STATE_LABEL },
        { key: 'ssn',    cls: 'field', field: 'ssn',    type: 'ssn',
          re: S.RE_SSN_LABEL },
        { key: 'occupation', cls: 'field', field: 'occupation', type: 'text',
          re: /\bOCCUPATION\b/i },
        { key: 'employer', cls: 'field', field: 'placeOfEmployment', type: 'text',
          re: /PLACE\s*OF\s*EMPLOY\w*|\bEMPLOYER\b|EMPLOYED\s*(AT|BY)/i },
        { key: 'height', cls: 'field', field: 'height', type: 'height',
          re: /\bHEIGHT\b|\bHGT\b|\bHT\b/i },
        { key: 'weight', cls: 'field', field: 'weight', type: 'weight',
          re: /\bWEIGHT\b|\bWGT\b|\bWT\b/i },
        { key: 'hair',   cls: 'field', field: 'hair',   type: 'text',
          re: /\bHAIR(\s*COLOR)?\b/i },
        { key: 'eyes',   cls: 'field', field: 'eyes',   type: 'text',
          re: /\bEYES?(\s*COLOR)?\b/i },
        /* Typed-only. A checkbox glyph is never read — see the header. */
        { key: 'sex',    cls: 'field', field: 'sex',    type: 'word',
          re: /\bSEX\b|\bGENDER\b/i, words: ['MALE', 'FEMALE', 'M', 'F', 'UNKNOWN'] },
        { key: 'race',   cls: 'field', field: 'race',   type: 'word',
          re: /\bRACE\b/i,
          words: ['WHITE', 'BLACK', 'ASIAN', 'HISPANIC', 'UNKNOWN', 'AMERICAN INDIAN',
                  'PACIFIC ISLANDER', 'OTHER'] },

        /* ---------------- vehicle fields ---------------- */
        { key: 'plate',  cls: 'field', field: 'plate',  type: 'plate', scope: 'vehicle',
          re: /LICEN[CS]E\s*PLATE|\bPLATE\b|\bTAG\s*(NO|NUMBER|#)|\bLIC\s*#/i },
        { key: 'vin',    cls: 'field', field: 'vin',    type: 'vin', scope: 'vehicle',
          re: /\bVIN\b|VEHICLE\s*ID/i },
        { key: 'make',   cls: 'field', field: 'make',   type: 'text', scope: 'vehicle',
          re: /\bMAKE\b/i },
        { key: 'model',  cls: 'field', field: 'model',  type: 'text', scope: 'vehicle',
          re: /\bMODEL\b/i },
        { key: 'vyear',  cls: 'field', field: 'year',   type: 'year', scope: 'vehicle',
          re: /\bYEAR\b|\bYR\b/i },
        { key: 'vcolor', cls: 'field', field: 'color',  type: 'text', scope: 'vehicle',
          re: /\bCOLOR\b|\bCOLOUR\b/i },
        { key: 'vstyle', cls: 'field', field: 'style',  type: 'text', scope: 'vehicle',
          re: /\bSTYLE\b|\bBODY\s*(TYPE|STYLE)?\b/i },

        /* ---------------- report-level fields ---------------- */
        { key: 'location', cls: 'field', field: 'location', type: 'address', scope: 'report',
          re: /ADDRESS\s*OF\s*OFFENSE|LOCATION\s*OF\s*(OFFENSE|OCCURRENCE|INCIDENT)|INCIDENT\s*LOCATION|\bLOCATION\b/i,
          not: /LOCATION\s*CODE/i },
        { key: 'caseno', cls: 'field', field: 'reportNumber', type: 'caseno', scope: 'report',
          re: /\bCASE\s*(NO|NUMBER|#)|INCIDENT\s*(NO|NUMBER|#)|REPORT\s*(NO|NUMBER|#)|\bOCA\b|\bDR\s*#/i },
        { key: 'agency', cls: 'field', field: 'agencyName', type: 'text', scope: 'report',
          re: /AGENCY\s*NAME|\bAGENCY\b|\bORI\s*(NUMBER|#)?\b/i },
        { key: 'statute', cls: 'field', field: 'statute', type: 'statute', scope: 'offense',
          re: /\bSTATUTE\b|\bCODE\s*SECTION\b|\bCHARGE\b|\bOFFENSE\s*#/i },
        { key: 'reportdate', cls: 'field', field: 'reportDate', type: 'date', scope: 'report',
          re: /REPORT\s*DATE|INCIDENT\s*DATE|DATE\s*(OF\s*)?(REPORT|OCCURRENCE)|OCCURRED\s*ON/i }
    ];

    /* ================================================================
     * Shape matchers
     * ================================================================
     * Each takes the text of a value window and returns the value, or ''.
     * They are deliberately conservative: returning nothing is a correct
     * answer, returning the wrong token is not.
     */

    var RE_DATE_ANY = /(?<![\d\/])(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})(?![\d\/])|(?<!\d)(\d{4}-\d{2}-\d{2})(?!\d)|(?<![A-Za-z0-9])(\d{1,2}[A-Za-z]{3}\d{2,4})(?![A-Za-z0-9])/;
    var RE_YEAR = /(?<!\d)(19\d{2}|20\d{2})(?!\d)/;
    var RE_HEIGHT = /(?<!\d)(\d)\s*['\u2019]\s*(\d{1,2})\s*["\u201d]?|(?<!\d)([4-7]\d{2})(?!\d)/;
    var RE_VIN = /\b([A-HJ-NPR-Z0-9]{17})\b/;
    var RE_CASENO = /(?<![\w-])(\d{2}-\d{4,8}|\d{4}-\d{5,8}|[A-Z]{2,4}-?\d{4,10}|\d{6,12})(?![\w-])/;
    var RE_STATUTE_ANY = /((?:\u00a7\s*)?(?:[A-Z]{2,4}\s*)?\d{1,3}[.\-]\d{1,3}(?:[.\-]\d{1,4})?(?:[A-Za-z])?(?:\s*\([0-9A-Za-z]{1,4}\))*)/;

    function _matchDate(win) {
        var m = RE_DATE_ANY.exec(win);
        if (!m) return '';
        return m[1] || m[2] || m[3] || '';
    }

    function _matchAge(win) {
        var m = /(?<!\d)(\d{1,3})(?!\d)/.exec(win);
        if (!m) return '';
        var n = parseInt(m[1], 10);
        if (!(n >= 1 && n <= 120)) return '';
        return String(n);
    }

    function _matchPhone(win) {
        return S.fmtPhone(win);
    }

    function _matchSsn(win) {
        var m = S.RE_SSN.exec(win);
        return m ? m[1] : '';
    }

    function _matchState(win) {
        var toks = S.identityTokens(win);
        var at = S.stateTokenAt(toks);
        return at >= 0 ? toks[at].replace(/[^A-Za-z]/g, '').toUpperCase() : '';
    }

    /* A licence number is the token immediately LEFT of a state code when one
     * is printed (the column order on every form seen so far); otherwise the
     * first token in the window whose shape fits. */
    function _matchDl(win) {
        var toks = S.identityTokens(win);
        var at = S.stateTokenAt(toks);
        if (at > 0) {
            for (var d = at - 1; d >= 0; d--) {
                if (!/[A-Za-z0-9]/.test(toks[d])) continue;
                if (S.looksLikeDlNumber(toks[d])) return toks[d].replace(/[^A-Za-z0-9]/g, '');
                break;
            }
        }
        for (var i = 0; i < toks.length; i++) {
            if (S.looksLikeDlNumber(toks[i])) return toks[i].replace(/[^A-Za-z0-9]/g, '');
        }
        return '';
    }

    function _matchAddress(winLines) {
        for (var i = 0; i < winLines.length; i++) {
            var m = S.RE_ADDR_ZIP.exec(winLines[i]) || S.RE_ADDR_NOZIP.exec(winLines[i]);
            if (m) return S.stripLeadingColumnDigit(S.clean(m[1]));
        }
        return '';
    }

    function _matchYear(win) {
        var m = RE_YEAR.exec(win);
        return m ? m[1] : '';
    }

    function _matchHeight(win) {
        var m = RE_HEIGHT.exec(win);
        if (!m) return '';
        if (m[1]) return m[1] + "'" + (m[2] || '0') + '"';
        if (m[3]) {
            var f = m[3].charAt(0), inch = m[3].slice(1);
            if (parseInt(inch, 10) > 11) return '';
            return f + "'" + parseInt(inch, 10) + '"';
        }
        return '';
    }

    function _matchWeight(win) {
        var m = /(?<!\d)(\d{2,3})(?!\d)\s*(LBS?\b|\u2116)?/i.exec(win);
        if (!m) return '';
        var n = parseInt(m[1], 10);
        if (!(n >= 40 && n <= 700)) return '';
        return String(n);
    }

    function _matchVin(win) {
        var m = RE_VIN.exec(String(win).toUpperCase());
        return m ? m[1] : '';
    }

    function _matchPlate(win) {
        var toks = S.identityTokens(win);
        for (var i = 0; i < toks.length; i++) {
            var t = toks[i].replace(/[^A-Za-z0-9]/g, '').toUpperCase();
            if (t.length < 5 || t.length > 8) continue;
            if (!/\d/.test(t)) continue;
            if (RE_YEAR.test(t) && t.length === 4) continue;
            if (t.length === 17) continue;
            if (/^\d{5}(\d{4})?$/.test(t)) continue;      // ZIP
            if (S.RE_SSN.test(toks[i])) continue;
            return t;
        }
        return '';
    }

    function _matchStatute(win) {
        var m = RE_STATUTE_ANY.exec(win);
        if (!m) return '';
        var v = S.clean(m[1]);
        // A bare date slipped through as "1-2-2026"? Reject 4-digit tails.
        if (/\b\d{4}$/.test(v) && /^\d{1,2}[.\-]\d{1,2}[.\-]\d{4}$/.test(v)) return '';
        return v;
    }

    function _matchCaseNo(win) {
        var m = RE_CASENO.exec(S.clean(win));
        if (!m) return '';
        var v = m[1];
        if (/^\d{5}(-\d{4})?$/.test(v)) return '';        // ZIP
        if (RE_YEAR.test(v) && v.length === 4) return '';
        return v;
    }

    /* One of a declared vocabulary, printed as a real word. This is how
     * sex/race are allowed in at all — a typed word is text on the page; a
     * checkbox glyph is not, and is never guessed at.
     *
     * The trap this guards: a checkbox LEGEND row prints every option at once
     * ("[J (W)White [] (B)Black [J (I) American Indian"). Matching a word
     * there tells you what the form offers, not what the clerk ticked, so a
     * row carrying two or more of the vocabulary is refused outright. */
    function _matchWord(win, words) {
        var raw = S.clean(win);
        if (_isCheckboxLegend(raw)) return '';
        var up = ' ' + raw.toUpperCase() + ' ';
        var best = '', found = 0;
        for (var i = 0; i < words.length; i++) {
            var w = words[i];
            if (w.length <= 1) continue;                  // "M"/"F" alone are checkbox glyphs
            if (up.indexOf(' ' + w + ' ') >= 0) {
                found++;
                if (w.length > best.length) best = w;
            }
        }
        if (found >= 2) return '';                        // a legend, not a selection
        return best;
    }

    /* Free text to the end of the cell. The window text has already been cut
     * at the next label, so what is left is the value — minus grid debris. */
    function _matchText(win) {
        var raw = S.clean(win);
        /* Label furniture is not a value. Without this, "ARREST TYPE: [J (0)
         * On View Arrest" lands in Place of Employment. */
        if (_isCheckboxLegend(raw) || _isLabelRow(raw)) return '';
        var v = raw
            .replace(/^[^A-Za-z0-9]{0,6}/, '')
            .replace(/[^A-Za-z0-9.)'\u2019]+$/, '');
        if (!v) return '';
        if (v.length > 60) v = v.slice(0, 60).replace(/\s+\S*$/, '');
        // Reject grid debris and stray checkbox glyphs.
        var letters = (v.match(/[A-Za-z]/g) || []).length;
        if (letters < 2) return '';
        if (/^[A-Z]{1,2}$/.test(v)) return '';
        if (S.NAME_STOP[v.replace(/[^A-Za-z]/g, '').toUpperCase()]) return '';
        return v;
    }

    /* ----------------------------------------------------------------
     * Junk gates
     * ----------------------------------------------------------------
     * A blank RMS form is mostly label text, and OCR reads label text just
     * as happily as it reads typed values. Everything below exists to answer
     * one question: is this row something a clerk TYPED, or something the
     * form PRINTED?
     */

    /* How many distinct lexicon labels appear on this line. A value row
     * carries at most the one label whose cell it shares; a row carrying two
     * or more is the form's own label furniture.
     *
     * This deliberately reuses LEXICON rather than a private word list, so
     * every label added for harvesting also sharpens this gate. */
    function _labelRowScore(line) {
        var s = String(line || '');
        if (!s) return 0;
        var seen = {}, n = 0;
        for (var i = 0; i < LEXICON.length; i++) {
            var e = LEXICON[i];
            if (seen[e.key]) continue;
            e.re.lastIndex = 0;
            if (e.re.test(s)) { seen[e.key] = true; n++; }
        }
        return n;
    }

    function _isLabelRow(line) {
        return _labelRowScore(line) >= 2;
    }

    /* OCR renders a row of checkboxes as repeated glyph runs ("HHHHHHHHHE",
     * "[J [] [1"). Any candidate name carrying that signature came from the
     * form, not from a person. */
    function _nameLooksLikeJunk(name) {
        var n = String(name || '');
        if (!n) return true;
        if (/([A-Za-z])\1{3,}/.test(n)) return true;          // HHHHHHHHHE
        if (/\[\s*[J\]1780]/.test(n)) return true;            // stray checkbox glyph
        var letters = n.replace(/[^A-Za-z]/g, '');
        if (letters.length < 4) return true;
        /* "DR. LL." — every token is a 1-2 letter abbreviation. A real name
         * has at least one token of three letters or more. */
        if (!/[A-Za-z]{3,}/.test(n)) return true;
        /* A token that flips between upper and lower case over and over is
         * OCR reading a column of empty checkboxes, not a surname:
         * "OOoOOoOoOgogoQg". Real names flip at most a few times —
         * "McDonald" is three, so the bar sits above it. */
        var toks = n.split(/\s+/);
        for (var t = 0; t < toks.length; t++) {
            var w = toks[t].replace(/[^A-Za-z]/g, '');
            if (w.length < 5) continue;
            var flips = 0;
            for (var c = 1; c < w.length; c++) {
                var a = w[c - 1] === w[c - 1].toUpperCase();
                var b = w[c] === w[c].toUpperCase();
                if (a !== b) flips++;
            }
            if (flips >= 4) return true;
        }
        return false;
    }

    /* A CAD / dispatch log row: a name printed alongside a clock time and a
     * console username ("dbrabham - Brabham, Dixie 19:48 20:07 FCSO-Delta",
     * "estell - Stell, Emily 15:40 FCSO-Beta"). Those are personnel, not
     * parties to the case. */
    function _isLogRow(line) {
        var s = String(line || '');
        var times = s.match(/(?<!\d)\d{1,2}:\d{2}(?!\d)/g) || [];
        if (times.length >= 2) return true;
        // username - Name, plus a timestamp
        return times.length >= 1 && /^\s*[a-z][a-z0-9._]{2,}\s*[-\u2013]\s*\S/.test(s);
    }

    /* An agency, a business or a place — name-shaped, but not a person.
     * "Westminster Police Department" sits directly under an employee-witness
     * heading and is three capitalised tokens, so the loose name matcher will
     * take it unless it is named as an organisation here. */
    var RE_ORG = new RegExp('\\b(?:' + [
        'POLICE', 'SHERIFF', 'DEPARTMENT', 'DEPT', 'OFFICE', 'COUNTY', 'CITY',
        'BUREAU', 'DIVISION', 'DISTRICT', 'COURT', 'HOSPITAL', 'SCHOOL',
        'ACADEMY', 'UNIVERSITY', 'COLLEGE', 'CENTER', 'CENTRE', 'COMPANY',
        'INC', 'LLC', 'CORP', 'FIRE', 'RESCUE', 'MEDICAL', 'SECURITY',
        'SERVICES', 'CORRECTIONS', 'PATROL', 'AGENCY', 'TROOPER', 'MARSHAL',
        'PRECINCT', 'STATION', 'DETENTION', 'JAIL', 'PROSECUTION', 'ATTORNEY',
        'REPORT', 'INCIDENT', 'SUPPLEMENT', 'PAGE', 'CONTINUED'
    ].join('|') + ')\\b', 'i');

    function _isOrgLine(line) {
        return RE_ORG.test(String(line || ''));
    }

    /* Words a form prints to describe a person rather than to name one.
     * Under a role heading the next line is usually the name — but on the
     * Arkansas form it is sometimes the relationship legend ("(SB) Sibling")
     * or a role ("CASE WORKER"), and both are shaped exactly like a name. */
    var GENERIC_PERSON_WORDS = (function () {
        var m = {};
        var w = ('SIBLING PARENT GUARDIAN CASE WORKER SPOUSE CHILD CHILDREN ' +
            'FRIEND NEIGHBOR NEIGHBOUR OTHER UNKNOWN RELATIONSHIP ACQUAINTANCE ' +
            'STEPFATHER STEPMOTHER STEPSON STEPDAUGHTER FATHER MOTHER BROTHER ' +
            'SISTER SON DAUGHTER GRANDPARENT GRANDFATHER GRANDMOTHER ' +
            'EMPLOYER EMPLOYEE OFFICER DEPUTY DETECTIVE SERGEANT CORPORAL ' +
            'LIEUTENANT CAPTAIN CHIEF BADGE NAME LAST FIRST MIDDLE SUFFIX ' +
            'TYPE DATE TIME INVOLVEMENT COMMENTS ADDRESS PHONE HOME WORK CELL ' +
            'MALE FEMALE VICTIM SUSPECT WITNESS ARRESTEE COMPLAINANT SUBJECT ' +
            'PERSON PARTY REPORTING INVOLVED NONE SELF ADULT JUVENILE ' +
            /* Report furniture. Every one of these was harvested as somebody's
             * name off a real document: "Event Information" became a victim,
             * "Justified Homicide Circumstances" became a suspect. */
            'EVENT INFORMATION CIRCUMSTANCES JUSTIFIED HOMICIDE CRIME OFFENSE ' +
            'PROPERTY VEHICLE NARRATIVE EVIDENCE STATEMENT SUMMARY DETAILS ' +
            'STATUS DISPOSITION ENTRY CANCELLATION LINK SERVED RIGHTS ' +
            'JOB TITLE POSITION ROLE ' +
            'DISCOVERED TREATED TRANSPORTED INJURIES INJURY WEAPON FORCE ' +
            'ACTIVITY LOCATION METHOD SEQUENCE SEQ NUMBER TOTAL VALUE ' +
            'DESCRIPTION REMARKS NOTES CONTINUED DRAFT INITIAL FINAL').split(' ');
        for (var i = 0; i < w.length; i++) m[w[i]] = true;
        return m;
    })();

    /* A name needs at least two tokens that are not form vocabulary and not a
     * parenthesised code. "(SB) Sibling" and "CASE WORKER" both fail; "Marie
     * Sanchez" and "Macie Sara Gayle Deleon" both pass. */
    function _looksLikePersonName(name) {
        var toks = String(name || '').trim().split(/\s+/);
        var real = 0;
        for (var i = 0; i < toks.length; i++) {
            var tk = toks[i];
            if (/^\(.*\)$/.test(tk)) continue;                 // (SB), (JV1)
            var w = tk.replace(/[^A-Za-z]/g, '');
            if (w.length < 2) continue;
            if (GENERIC_PERSON_WORDS[w.toUpperCase()]) continue;
            real++;
        }
        return real >= 2;
    }

    /* The single gate every name path goes through. */
    function _safeName(line, name) {
        if (!name) return '';
        if (_nameLooksLikeJunk(name)) return '';
        if (_isLabelRow(line)) return '';
        return name;
    }

    /* A "Last, First Middle" name, or — only when a NAME label vouched for the
     * neighbourhood — a run of capitalised tokens with no comma. The loose form
     * is label-gated on purpose: "RODEN MILL RD" is two name-shaped tokens.
     * It also goes through _looseNameOn, the same gate the heading paths use:
     * a NAME label whose value cell is empty leaves the window pointing at
     * the next form row, and Alleghany County's "State Entry # - Date - ByState
     * Cancellation #..." row was being filed as a suspect called "ByState
     * Cancellation". */
    function _matchName(winLines, labelled) {
        var i;
        for (i = 0; i < winLines.length; i++) {
            var n = _safeName(winLines[i], S.extractName(winLines[i]));
            if (n) return n;
        }
        if (!labelled) return '';
        for (i = 0; i < winLines.length; i++) {
            var loose = _looseNameOn(winLines[i]);
            if (loose) return loose;
        }
        return '';
    }

    function _nameLoose(line) {
        var s = S.clean(line);
        if (!s) return '';
        if (/^\d/.test(s)) return '';                                   // address row
        if (S.RE_ADDR_ZIP.test(s) || S.RE_ADDR_NOZIP.test(s)) return '';
        if (S.RE_SSN.test(s) || S.RE_PHONE.test(s)) return '';
        var toks = s.split(' ');
        var run = [];
        for (var i = 0; i < toks.length; i++) {
            var ok = S.isNameToken(toks[i]) ||
                (run.length > 0 && S.isMiddleInitial(toks[i], toks[i + 1]));
            if (ok) { run.push(toks[i]); continue; }
            if (run.length >= 2) break;
            run = [];
        }
        if (run.length < 2) return '';
        // At least two tokens must be real words, not initials.
        var real = 0;
        for (var j = 0; j < run.length; j++) {
            if (run[j].replace(/[^A-Za-z]/g, '').length >= 2) real++;
        }
        if (real < 2) return '';
        return run.join(' ');
    }

    var MATCHERS = {
        date: function (w) { return _matchDate(w.text); },
        age: function (w) { return _matchAge(w.text); },
        phone: function (w) { return _matchPhone(w.text); },
        ssn: function (w) { return _matchSsn(w.text); },
        state: function (w) { return _matchState(w.text); },
        dl: function (w) { return _matchDl(w.text); },
        address: function (w) { return _matchAddress(w.lines); },
        year: function (w) { return _matchYear(w.text); },
        height: function (w) { return _matchHeight(w.text); },
        weight: function (w) { return _matchWeight(w.text); },
        vin: function (w) { return _matchVin(w.text); },
        plate: function (w) { return _matchPlate(w.text); },
        statute: function (w) { return _matchStatute(w.text); },
        caseno: function (w) { return _matchCaseNo(w.text); },
        text: function (w) { return _matchText(w.first); },
        word: function (w, entry) { return _matchWord(w.first, entry.words || []); },
        name: function (w) { return _matchName(w.lines, true); }
    };

    /* ================================================================
     * Pass 1 — index every indicator in the document
     * ================================================================ */

    function _entryHit(entry, line) {
        var m = entry.re.exec(line);
        if (!m) return null;
        if (entry.not && entry.not.test(line)) return null;
        if (entry.head != null && m.index > entry.head) return null;
        /* A heading has to LOOK like a heading. An officer who writes
         * "Rottman (Others involved). Ms. Barber and JV1 were both given
         * statement forms." is not opening a new section — but the words are
         * there, and taking them as one truncated the narrative at that
         * sentence and threw away everything after it.
         *
         * The test is NOT "is this line prose" — that was the first attempt
         * and it was too blunt. Westminster's reports title their narrative
         * "Original Report Narrative By Officer Cody Clearwater 1607", which
         * reads as prose to that test, so the whole narrative was dropped.
         *
         * What actually separates the two is what FOLLOWS the label. A label
         * swallowed by a sentence has the rest of that sentence after it, or
         * the line closes as a sentence. A heading has a title, a name or
         * nothing after it, and no full stop.
         *
         * Field labels are exempt: those sit in grid cells beside their
         * values and are not expected to be standalone. */
        if (entry.cls === 'role' || entry.cls === 'section') {
            if (S.isProse(line)) {
                var after = line.slice(m.index + m[0].length);
                /* Prose continues after the label — it was swallowed by a
                 * sentence. */
                if (S.isProse(after)) return null;
                /* Or the line simply finishes as a sentence. An officer
                 * closing with "I then placed the rape kit ... in FCSO CID
                 * Evidence without further incident." is not opening an
                 * evidence section; a heading does not end in a full stop. */
                if (/[.!?]["')\]]?\s*$/.test(line)) return null;
            }
        }
        return { index: m.index, end: m.index + m[0].length, text: m[0] };
    }

    /* One sweep of the whole document. No positional assumptions: a hit is
     * recorded wherever it falls, on whatever page. */
    function _index(pages) {
        var hits = [];
        for (var p = 0; p < pages.length; p++) {
            var lines = pages[p].lines;
            for (var i = 0; i < lines.length; i++) {
                var line = S.clean(lines[i]);
                if (!line) continue;
                for (var e = 0; e < LEXICON.length; e++) {
                    var h = _entryHit(LEXICON[e], line);
                    if (!h) continue;
                    hits.push({
                        page: pages[p].index,
                        pageIdx: p,
                        line: i,
                        cls: LEXICON[e].cls,
                        key: LEXICON[e].key,
                        entry: LEXICON[e],
                        at: h.index,
                        end: h.end,
                        label: h.text
                    });
                }
            }
        }
        hits.sort(function (a, b) {
            return a.pageIdx - b.pageIdx || a.line - b.line || a.at - b.at;
        });
        return hits;
    }

    /* ================================================================
     * Value windows
     * ================================================================ */

    /* Cut a value at the next label on the same packed row. On a left-packed
     * OCR row the neighbouring cell's label is the only reliable boundary. */
    function _cutAtNextLabel(rest) {
        var cut = rest.length;
        for (var e = 0; e < LEXICON.length; e++) {
            var m = LEXICON[e].re.exec(rest);
            if (m && m.index > 0 && m.index < cut) cut = m.index;
        }
        return rest.slice(0, cut);
    }

    /* The rest of the label's own line, plus the next few non-empty lines.
     * Ruled forms print a label row above a value row, so the vertical part of
     * the window is not optional. */
    function _window(pageLines, lineIdx, endCol, span) {
        var whole = S.clean(pageLines[lineIdx]);
        var rest = _cutAtNextLabel(whole.slice(Math.min(endCol, whole.length)));
        var out = [rest];
        var taken = 0;
        var n = span == null ? 3 : span;
        for (var i = lineIdx + 1; i < pageLines.length && taken < n; i++) {
            var s = S.clean(pageLines[i]);
            if (!s) continue;
            taken++;
            out.push(s);
        }
        return { first: rest, lines: out, text: out.join(' \n ') };
    }

    /* ================================================================
     * Pass 2 — segment the document into blocks
     * ================================================================
     * A role hit opens a person block; it closes at the next role hit, the
     * next section hit, or the end of the page. One heading may cover several
     * people (the Arkansas "Others Involved" lesson), so a person block is
     * split again on repeated NAME hits.
     */
    function _segment(pages, hits) {
        var segs = [];
        var open = null;

        function close(pageIdx, line) {
            if (!open) return;
            open.to = line;
            if (open.to > open.from) segs.push(open);
            open = null;
        }

        for (var h = 0; h < hits.length; h++) {
            var hit = hits[h];
            if (open && open.pageIdx !== hit.pageIdx) {
                close(open.pageIdx, pages[open.pageIdx].lines.length);
            }
            if (hit.cls === 'role') {
                /* A role word inside a FIELD LABEL is not a new person.
                 * Westminster's prosecution report labels one defendant's
                 * cells "Defendant Information", "Defendant Name" and
                 * "Defendant's Address" — three role hits, one human. Taking
                 * each as a heading split him into three cards, two of them
                 * nameless.
                 *
                 * But "Victim Name" is the ONLY thing marking the victim on
                 * that same report, so label rows cannot simply be ignored.
                 * The rule that satisfies both: a role hit on a label row
                 * EXTENDS an open block of the SAME role, and opens a new one
                 * when the role changes. A role heading that is not a label
                 * row ("Witness #1", "Witness #2") always opens. */
                if (open && open.kind === 'person' && open.role === hit.entry.role &&
                    _isLabelRow(S.clean(pages[hit.pageIdx].lines[hit.line] || ''))) {
                    continue;
                }
                close(hit.pageIdx, hit.line);
                open = {
                    kind: 'person', role: hit.entry.role, label: hit.label,
                    pageIdx: hit.pageIdx, page: hit.page, from: hit.line, to: -1
                };
            } else if (hit.cls === 'section') {
                close(hit.pageIdx, hit.line);
                open = {
                    kind: hit.entry.section, role: '', label: hit.label,
                    pageIdx: hit.pageIdx, page: hit.page, from: hit.line, to: -1
                };
            }
        }
        if (open) close(open.pageIdx, pages[open.pageIdx].lines.length);

        return _splitOnRepeatedNames(
            pages, hits, _alignVerticalRecords(pages, hits, segs));
    }

    /* ----------------------------------------------------------------
     * Vertical label/value forms: the NAME label starts the record
     * ----------------------------------------------------------------
     * Some RMS engines print one field per line — the label on its own row,
     * the value on the row beneath — and put the role INSIDE the record as
     * an "Involvement Type" value, below the name:
     *
     *     Name (Last, First, Middle, Suffix)
     *     Chapman, Summer Rose
     *     Involvement Type
     *     Witness's Parent/Guardian     <- the role hit
     *     Date Of Birth
     *     07/30/1985
     *
     * Opening the block at the role hit starts it BELOW the name, so the
     * block runs on into the next record and picks that person's name up
     * instead. On Westminster's summary report that shifted every name one
     * record out of step and printed Marie Sanchez with Kristen
     * Pfeiffenberger's date of birth. A gap an officer can see is survivable;
     * a wrong date of birth on a correctly-spelled name is not.
     *
     * Where a page is laid out this way, the name label — not the role — is
     * the record boundary, so the records are rebuilt around it.
     */

    /* A label is "vertical" when nothing but its own furniture follows it on
     * its own line — the value lives on the row beneath. The parenthetical in
     * "Name (Last, First, Middle, Suffix)" is part of the label, not a value,
     * so it is stripped before the line is judged. */
    function _isVerticalLabel(lines, hit) {
        var whole = S.clean(lines[hit.line] || '');
        var rest = whole.slice(Math.min(hit.end, whole.length))
            .replace(/\([^)]*\)/g, ' ');
        return !/[A-Za-z0-9]/.test(_cutAtNextLabel(rest));
    }

    /* How far below the name label the record's own role value may sit.
     * Three rows in the layout above; four allows one stray blank. */
    var VERT_ROLE_SPAN = 4;

    function _alignVerticalRecords(pages, hits, segs) {
        var out = [];
        var byPage = {};
        var i;
        for (i = 0; i < segs.length; i++) {
            if (segs[i].kind !== 'person') { out.push(segs[i]); continue; }
            var k = segs[i].pageIdx;
            (byPage[k] || (byPage[k] = [])).push(segs[i]);
        }
        for (var pk in byPage) {
            if (!Object.prototype.hasOwnProperty.call(byPage, pk)) continue;
            var rebuilt = _alignPage(pages[Number(pk)], hits, byPage[pk], Number(pk));
            for (i = 0; i < rebuilt.length; i++) out.push(rebuilt[i]);
        }
        out.sort(function (a, b) {
            return a.pageIdx - b.pageIdx || a.from - b.from;
        });
        return out;
    }

    function _alignPage(page, hits, personSegs, pageIdx) {
        var lines = page.lines;
        var lo = personSegs[0].from, hi = personSegs[0].to;
        var i;
        for (i = 1; i < personSegs.length; i++) {
            if (personSegs[i].from < lo) lo = personSegs[i].from;
            if (personSegs[i].to > hi) hi = personSegs[i].to;
        }

        /* Name labels that start a record, and the role/section hits used to
         * name and bound them. */
        var nameAt = [], roleHits = [], sectionAt = [];
        for (i = 0; i < hits.length; i++) {
            var h = hits[i];
            if (h.pageIdx !== pageIdx) continue;
            if (h.cls === 'role') { roleHits.push(h); continue; }
            if (h.cls === 'section') { sectionAt.push(h.line); continue; }
            if (h.key !== 'name') continue;
            /* The record may open a line or two above the first role hit. */
            if (h.line < lo - VERT_ROLE_SPAN || h.line >= hi) continue;
            if (!_isVerticalLabel(lines, h)) continue;
            if (nameAt.length && nameAt[nameAt.length - 1] === h.line) continue;
            nameAt.push(h.line);
        }

        /* Two names prove nothing; a repeating record does. Anything less and
         * the page keeps the segments it already had. */
        if (nameAt.length < 3) return personSegs;

        var recs = [];
        for (i = 0; i < nameAt.length; i++) {
            var start = nameAt[i];
            var stop = (i + 1 < nameAt.length) ? nameAt[i + 1] : hi;
            for (var s = 0; s < sectionAt.length; s++) {
                if (sectionAt[s] > start && sectionAt[s] < stop) stop = sectionAt[s];
            }
            if (stop <= start) continue;

            /* The record's OWN role sits just under its name label. Failing
             * that, the banner that introduced it — "Victim(s) - 1 Involved"
             * — is the last role hit at or above the name. */
            var pick = null, r;
            for (r = 0; r < roleHits.length; r++) {
                if (roleHits[r].line <= start ||
                    roleHits[r].line > start + VERT_ROLE_SPAN) continue;
                /* Several roles can share the row. "Witness's
                 * Parent/Guardian" is a guardian, not a witness — in an
                 * English compound the head noun comes last, so the
                 * rightmost match on the earliest qualifying row wins. */
                if (pick && roleHits[r].line !== pick.line) break;
                pick = roleHits[r];
            }
            if (!pick) {
                for (r = 0; r < roleHits.length; r++) {
                    if (roleHits[r].line <= start) pick = roleHits[r];
                }
            }
            recs.push({
                kind: 'person',
                role: pick ? pick.entry.role : ROLE.OTHER,
                label: pick ? pick.label : '',
                pageIdx: pageIdx, page: page.index,
                from: start, to: stop
            });
        }
        return recs.length ? recs : personSegs;
    }

    function _splitOnRepeatedNames(pages, hits, segs) {
        var out = [];
        for (var s = 0; s < segs.length; s++) {
            var seg = segs[s];
            if (seg.kind !== 'person') { out.push(seg); continue; }
            var names = [];
            for (var h = 0; h < hits.length; h++) {
                var hit = hits[h];
                if (hit.key !== 'name') continue;
                if (hit.pageIdx !== seg.pageIdx) continue;
                if (hit.line < seg.from || hit.line >= seg.to) continue;
                names.push(hit.line);
            }
            if (names.length < 2) { out.push(seg); continue; }
            for (var n = 0; n < names.length; n++) {
                out.push({
                    kind: 'person', role: seg.role, label: seg.label,
                    pageIdx: seg.pageIdx, page: seg.page,
                    from: n === 0 ? seg.from : names[n],
                    to: n === names.length - 1 ? seg.to : names[n + 1]
                });
            }
        }
        return out;
    }

    /* ================================================================
     * Pass 3 — harvest
     * ================================================================ */

    function _personShell(role) {
        return {
            involvement: role || ROLE.OTHER,
            name: '', alias: '', nameSource: '', dob: '', age: '',
            sex: '', race: '', ethnicity: '',
            address: '', phone: '',
            dl: '', dlState: '', ssn: '',
            employmentPhone: '', occupation: '', placeOfEmployment: '',
            height: '', weight: '', hair: '', eyes: '',
            comments: '', guardian: '', detail: '',
            sourcePage: 0,
            /* Provenance. Every value an officer sees can be traced back to the
             * label and line that produced it. */
            fieldSources: {},
            confidence: 0,
            nameUnverified: false
        };
    }

    function _vehicleShell() {
        return {
            plate: '', plateState: '', vin: '', make: '', model: '',
            year: '', color: '', style: '', sourcePage: 0, fieldSources: {}
        };
    }

    function _hitsIn(hits, seg, cls) {
        var out = [];
        for (var h = 0; h < hits.length; h++) {
            var hit = hits[h];
            if (hit.pageIdx !== seg.pageIdx) continue;
            if (hit.line < seg.from || hit.line >= seg.to) continue;
            if (cls && hit.cls !== cls) continue;
            out.push(hit);
        }
        return out;
    }

    function _harvestInto(target, hits, seg, pageLines, allowedScopes) {
        var fieldHits = _hitsIn(hits, seg, 'field');
        for (var i = 0; i < fieldHits.length; i++) {
            var hit = fieldHits[i];
            var entry = hit.entry;
            var scope = entry.scope || 'person';
            if (allowedScopes.indexOf(scope) === -1) continue;
            if (target[entry.field]) continue;              // first labelled hit wins

            var win = _window(pageLines, hit.line, hit.end, entry.type === 'address' ? 4 : 3);
            var matcher = MATCHERS[entry.type];
            if (!matcher) continue;
            var value = matcher(win, entry);
            if (!value) continue;

            target[entry.field] = value;
            target.fieldSources[entry.field] = {
                page: hit.page, line: hit.line, label: hit.label
            };
        }
    }

    /* A run of capitalised tokens that survives every junk gate. Used only
     * where a role heading or a NAME label has vouched for the position. */
    function _looseNameOn(line) {
        var s = S.clean(line);
        if (!s) return '';
        if (_labelRowScore(s) > 0) return '';
        if (_isOrgLine(s) || _isLogRow(s)) return '';
        /* A parenthesised one- or two-character code is a checkbox legend
         * key — "(M) Apparent Minor Injury", "(SB) Sibling". No loose name
         * ever needs one. (Arkansas's juvenile aliases, "PUTNEY (JV2),
         * ISABELLA", carry one too, but those arrive through the comma form
         * and never touch this path.) */
        if (/\((?:\d{1,2}|[A-Za-z]{1,2})\)/.test(s)) return '';
        /* Extractors that drop the whitespace between column headings glue
         * them into name-shaped tokens: "Discovered CrimeCan ID SuspectVictim
         * Crime Rights Served", "State Entry # - Date - ByState Cancellation
         * # - Date - ByNCIC Entry #". Both were filed as suspects. A single
         * lower-to-upper join inside a token is a real surname (McDonald,
         * DeLeon); two or more in one line is a header row. */
        var joins = s.match(/[a-z][A-Z]/g);
        if (joins && joins.length >= 2) return '';
        var loose = _safeName(s, _nameLoose(s));
        return (loose && _looksLikePersonName(loose)) ? loose : '';
    }

    /* The part of the role heading line that follows the role word. */
    function _nameOnHeadingLine(seg, pageLines) {
        if (!seg.label) return '';
        var head = S.clean(pageLines[seg.from] || '');
        if (!head) return '';
        /* Judge the WHOLE row before slicing it. Arkansas prints the injury
         * and relationship legends across the same row as the VICTIM banner —
         * "VICTIM INJURY: (Max. 5) (M) Apparent Minor Injury THIS VICTIM
         * RELATED ..." — and the slice on its own no longer looks like a
         * legend, so "(M) Apparent Minor Inju THIS" came back as a victim's
         * name. Checkbox fields are never imported; neither are their
         * legends. */
        if (_isCheckboxLegend(head)) return '';
        var at = head.indexOf(seg.label);
        if (at === -1) return '';
        return _looseNameOn(_cutAtNextLabel(head.slice(at + seg.label.length)));
    }

    function _harvestPerson(seg, hits, pageLines) {
        var person = _personShell(seg.role);
        person.sourcePage = seg.page;
        _harvestInto(person, hits, seg, pageLines, ['person']);

        /* NAME PRECEDENCE, strongest first. The order is the whole point:
         * each rung was added because the rung below it produced a wrong
         * answer on a real report.
         *
         *   1. a labelled "Last, First Middle" field
         *   2. an unlabelled "Last, First Middle" anywhere in the block
         *   3. a name printed on the role heading line itself
         *   4. a bare name on one of the first lines under the heading
         *
         * 2 beats 3 because Arkansas packs the given names onto the heading
         * row and the surname into the cell below — taking the heading there
         * turned "BARBER, SEAN OCASEY" into "SEAN OCASEY".
         *
         * 3 beats a labelled NON-comma field because Westminster's
         * page-continuation header reads "Defendant: Zakary Lombardi  DOB:
         * 12/08/01" while the block below it carries the "Employee Name and
         * Badge/ID Number" cell for the filing officer — so the labelled
         * field won and the reader filed OFFICER ROBERT ARON as a suspect. */
        function _hasComma(n) { return !!n && n.indexOf(',') > -1; }

        /* 2 — the name label is frequently destroyed by OCR, so walk the
         * block for the strict comma form. */
        if (!_hasComma(person.name)) {
            for (var i = seg.from; i < seg.to; i++) {
                var n = _safeName(pageLines[i], S.extractName(pageLines[i]));
                if (n) {
                    person.name = n;
                    person.nameSource = 'comma-walk';
                    person.fieldSources.name = { page: seg.page, line: i, label: '(unlabelled)' };
                    break;
                }
            }
        }

        /* 3 — the heading line's own remainder. */
        if (!_hasComma(person.name)) {
            var headName = _nameOnHeadingLine(seg, pageLines);
            if (headName) {
                person.name = headName;
                person.nameSource = 'heading-inline';
                person.fieldSources.name = {
                    page: seg.page, line: seg.from,
                    label: '(named on the "' + seg.label + '" line)'
                };
            }
        }

        /* 4 — Not every agency prints "Last, First". Westminster lists
         * witnesses as a bare heading followed by the name on its own line:
         *
         *     Witness #1
         *     Marie Sanchez
         *     2685 Carnation Way
         *
         * Eight witnesses on that report came back with a date of birth, an
         * age and no name at all, because the only name form the reader knew
         * was the comma form Arkansas happens to print. The role heading is
         * the voucher here — the same job the NAME label does elsewhere — so
         * the loose form is allowed, but only on the first few lines of the
         * block and only on a line carrying no label vocabulary at all. */
        if (!person.name) {
            var looked = 0;
            var cand = [];
            for (var j = seg.from + 1; j < seg.to && looked < 3; j++) {
                var raw = S.clean(pageLines[j]);
                if (!raw) continue;
                looked++;
                cand.push({ line: j, text: raw });
            }
            for (var c = 0; c < cand.length; c++) {
                var loose = _looseNameOn(cand[c].text);
                if (loose) {
                    person.name = loose;
                    person.nameSource = 'under-heading';
                    person.fieldSources.name = {
                        page: seg.page, line: cand[c].line,
                        label: '(under ' + (seg.label || 'heading') + ')'
                    };
                    break;
                }
            }
        }
        if (person.name) person.alias = S.aliasOf(person.name);

        /* The address label is the single most OCR-damaged label on these
         * forms ("RESIDENT ODES Ss meee Ci sate"), so a block-wide shape scan
         * is worth it — but never a row belonging to ARREST LOCATION, which is
         * a different fact. */
        if (!person.address) {
            var a = S.scanAddress(pageLines, seg.from, seg.to, seg.to);
            if (a) {
                person.address = a;
                person.fieldSources.address = { page: seg.page, line: seg.from, label: '(unlabelled)' };
            }
        }

        person.nameUnverified = !person.name;
        person.confidence = _confidence(person);
        return person;
    }

    function _harvestVehicle(seg, hits, pageLines) {
        var v = _vehicleShell();
        v.sourcePage = seg.page;
        _harvestInto(v, hits, seg, pageLines, ['vehicle']);
        return v;
    }

    /* Confidence is the share of this person's populated fields that a LABEL
     * vouched for. It is a statement about provenance, not about truth, and
     * the UI must present it that way. */
    function _confidence(person) {
        var FIELDS = ['name', 'dob', 'age', 'address', 'phone', 'dl', 'dlState',
                      'ssn', 'occupation', 'placeOfEmployment', 'sex', 'race',
                      'height', 'weight'];
        var filled = 0, labelled = 0;
        for (var i = 0; i < FIELDS.length; i++) {
            var f = FIELDS[i];
            if (!person[f]) continue;
            filled++;
            var src = person.fieldSources[f];
            if (src && src.label && src.label !== '(unlabelled)') labelled++;
        }
        if (!filled) return 0;
        return Math.round((labelled / filled) * 100) / 100;
    }

    /* A named block is always worth showing. A NAMELESS block has to be
     * anchored by something that belongs to a person — a date of birth, a
     * licence, an SSN, a phone, an age. An address on its own is a PLACE, and
     * every one of these forms prints addresses that belong to no one
     * (the agency's own address, an arrest location, a business).
     *
     * Age is deliberately NOT an anchor. An age is an attribute of a person,
     * not a way to tell one person from another, and reading it off a form
     * row is easy enough that it would keep empty blocks alive on its own. */
    function _personHasData(p) {
        if (p.name) return true;
        return !!(p.dob || p.dl || p.ssn || p.phone);
    }

    function _vehicleHasData(v) {
        return !!(v.plate || v.vin || v.make || v.model || v.year);
    }

    /* ----------------------------------------------------------------
     * Duplicate bands
     * ----------------------------------------------------------------
     * Many RMS forms print a person's band once per charge, so the same human
     * appears two or three times on one page. Merging them is only safe when
     * the prints AGREE: same page, same role, and at least two identifiers
     * that match with none that conflict.
     *
     * A conflict is treated as proof of two different people and both are
     * kept. Collapsing two people into one on a warrant is far worse than
     * showing the officer one card too many.
     */
    var MERGE_KEYS = ['dob', 'dl', 'ssn', 'phone'];

    function _bandsAgree(a, b) {
        var agree = 0;
        for (var i = 0; i < MERGE_KEYS.length; i++) {
            var k = MERGE_KEYS[i];
            var x = String(a[k] || '').replace(/\D/g, '');
            var y = String(b[k] || '').replace(/\D/g, '');
            if (!x || !y) continue;
            if (x !== y) return false;                  // conflict — different people
            agree++;
        }
        if (a.name && b.name && _nameKey(a.name) !== _nameKey(b.name)) return false;
        return agree >= 2;
    }

    function _fillBlanks(into, from) {
        for (var k in from) {
            if (!Object.prototype.hasOwnProperty.call(from, k)) continue;
            if (k === 'fieldSources' || k === 'confidence' || k === 'nameUnverified') continue;
            if (!into[k] && from[k]) {
                into[k] = from[k];
                if (from.fieldSources && from.fieldSources[k]) {
                    into.fieldSources[k] = from.fieldSources[k];
                }
            }
        }
    }

    function _mergeDuplicateBands(people) {
        var out = [];
        for (var i = 0; i < people.length; i++) {
            var p = people[i];
            var merged = false;
            for (var j = 0; j < out.length; j++) {
                var q = out[j];
                if (q.sourcePage !== p.sourcePage) continue;
                if (q.involvement !== p.involvement) continue;
                if (!_bandsAgree(q, p)) continue;
                _fillBlanks(q, p);
                q.nameUnverified = !q.name;
                q.confidence = _confidence(q);
                merged = true;
                break;
            }
            if (!merged) out.push(p);
        }
        return out;
    }

    /* ================================================================
     * Pass 4 — narrative
     * ================================================================ */

    function _readNarrative(pages, segs, warn) {
        var chunks = [];
        var srcPages = [];
        var unreadable = [];
        var used = {};

        /* Labelled narrative sections first. */
        for (var s = 0; s < segs.length; s++) {
            var seg = segs[s];
            if (seg.kind !== 'narrative') continue;
            var lines = pages[seg.pageIdx].lines;
            var body = _proseIn(lines, seg.from, seg.to);
            if (!body.length) continue;
            if (!S.bodyIsReadable(body)) {
                if (unreadable.indexOf(seg.page) === -1) unreadable.push(seg.page);
                continue;
            }
            chunks.push(body.join('\n'));
            if (srcPages.indexOf(seg.page) === -1) srcPages.push(seg.page);
            used[seg.pageIdx] = true;
        }

        /* Then unlabelled pages where prose DOMINATES. A NIBRS legend or a
         * label grid must never be imported as an officer's narrative, and a
         * field photo once produced 22 rows of dashes that were. */
        for (var p = 0; p < pages.length; p++) {
            if (used[p]) continue;
            var pl = pages[p].lines;
            var prose = 0, nonEmpty = 0;
            for (var i = 0; i < pl.length; i++) {
                var t = S.clean(pl[i]);
                if (!t) continue;
                nonEmpty++;
                if (S.isProse(t)) prose++;
            }
            if (!(prose >= 4 && prose >= nonEmpty * 0.6)) continue;
            var pbody = _proseIn(pl, 0, pl.length);
            if (!pbody.length) continue;
            if (!S.bodyIsReadable(pbody)) {
                if (unreadable.indexOf(pages[p].index) === -1) unreadable.push(pages[p].index);
                continue;
            }
            chunks.push(pbody.join('\n'));
            if (srcPages.indexOf(pages[p].index) === -1) srcPages.push(pages[p].index);
        }

        if (unreadable.length) {
            warn('Narrative text on page(s) ' + unreadable.join(', ') +
                 ' could not be read from the scan and was left out rather than ' +
                 'imported as unreadable characters.');
        }
        if (!chunks.length) return { narratives: [], srcPages: srcPages, unreadable: unreadable };

        var text = S.paragraphize(chunks.join('\n').split('\n'));
        return {
            narratives: [{
                officer: '',
                badge: '',
                date: '',
                type: 'Narrative',
                text: text
            }],
            srcPages: srcPages,
            unreadable: unreadable
        };
    }

    function _proseIn(lines, from, to) {
        var body = [];
        for (var i = Math.max(0, from); i < Math.min(to, lines.length); i++) {
            var t = S.clean(lines[i]);
            if (!t) continue;
            if (S.isPageBreak(t)) continue;
            if (S.RE_PAGE_HEADER.test(t)) continue;
            if (S.isProse(t) || S.isNarrativeFragment(t)) body.push(t);
        }
        return body;
    }

    /* ================================================================
     * Pass 5 — orphans
     * ================================================================
     * A name found outside every segment is still a person on the document.
     * It becomes OTHER PERSON — never a guessed role — and picks up only the
     * identity values printed within a few lines of it.
     */
    function _orphans(pages, segs, hits, taken) {
        var out = [];
        for (var p = 0; p < pages.length; p++) {
            var lines = pages[p].lines;
            var covered = _coverage(segs, p, lines.length);
            for (var i = 0; i < lines.length; i++) {
                if (covered[i]) continue;
                if (_isLogRow(lines[i])) continue;      // CAD/dispatch personnel row
                var name = _safeName(lines[i], S.extractName(lines[i]));
                if (!name) continue;
                if (taken[_nameKey(name)]) continue;

                var person = _personShell(ROLE.OTHER);
                person.sourcePage = pages[p].index;
                person.name = name;
                person.alias = S.aliasOf(name);
                person.fieldSources.name = {
                    page: pages[p].index, line: i, label: '(no section heading)'
                };

                var from = Math.max(0, i - 1);
                var to = Math.min(lines.length, i + 4);
                var pseudo = { pageIdx: p, page: pages[p].index, from: from, to: to };
                _harvestInto(person, hits, pseudo, lines, ['person']);
                if (!person.address) {
                    var a = S.scanAddress(lines, from, to, to);
                    if (a) {
                        person.address = a;
                        person.fieldSources.address = {
                            page: pages[p].index, line: from, label: '(unlabelled)'
                        };
                    }
                }
                person.detail = 'Found with no section heading above it.';
                person.confidence = _confidence(person);
                taken[_nameKey(name)] = true;
                out.push(person);
            }
        }
        return out;
    }

    function _coverage(segs, pageIdx, len) {
        var cov = new Array(len);
        for (var s = 0; s < segs.length; s++) {
            if (segs[s].pageIdx !== pageIdx) continue;
            for (var i = segs[s].from; i < Math.min(segs[s].to, len); i++) cov[i] = true;
        }
        return cov;
    }

    function _nameKey(n) {
        return String(n || '').toUpperCase().replace(/[^A-Z]/g, '');
    }

    /* ================================================================
     * Report-level fields
     * ================================================================ */

    function _reportFields(pages, hits) {
        var out = { reportNumber: '', location: '', agencyName: '', reportDate: '' };
        var sources = {};
        for (var h = 0; h < hits.length; h++) {
            var hit = hits[h];
            if (hit.cls !== 'field') continue;
            if ((hit.entry.scope || 'person') !== 'report') continue;
            if (out[hit.entry.field]) continue;
            var win = _window(pages[hit.pageIdx].lines, hit.line, hit.end,
                              hit.entry.type === 'address' ? 4 : 2);
            var matcher = MATCHERS[hit.entry.type];
            if (!matcher) continue;
            var v = matcher(win, hit.entry);
            if (!v) continue;
            out[hit.entry.field] = v;
            sources[hit.entry.field] = { page: hit.page, line: hit.line, label: hit.label };
        }
        out.fieldSources = sources;
        return out;
    }

    /* The fingerprint of a printed checkbox legend: option codes in brackets
     * ("(17) Liquor Store", "[J (46) Farm Facility") or an instruction to the
     * clerk ("Enter 1", "Max. 3"). These rows are the form talking to the
     * person filling it in — they are never the offense.
     *
     * An offense with a blank description is honest. An offense described as
     * "LOCATION CODE (Enter 1) [J (17) Liquor Store" is evidence the officer
     * has to explain in court. */
    function _isCheckboxLegend(t) {
        var s = String(t || '');
        if (/\[\s*[A-Za-z0-9\]]/.test(s)) return true;       // [J [] [1 [7 [O [T
        if (/\((?:Max\.|Enter|check|Place)\b/i.test(s)) return true;
        var codes = s.match(/\((?:\d{2}|[A-Z]{1,2})\)/g) || [];
        return codes.length >= 2;                            // "(01) ... (16) ..."
    }

    /* An offense description is a short phrase a clerk chose ("Rape",
     * "TERRORISTIC THREATENING - 1ST"). Anything carrying bracket glyphs,
     * option codes or grid debris is the form's own legend.
     *
     * The bar is deliberately high because a blank description is honest and
     * a wrong one is something the officer has to explain in court. */
    function _looksLikeOffenseName(t) {
        var s = String(t || '');
        if (!s || s.length > 60) return false;
        if (/[\[\]|]/.test(s)) return false;
        if (/\((?:\d{1,2}|[A-Z]{1,2})\)/.test(s)) return false;
        if (_isCheckboxLegend(s) || _isLabelRow(s)) return false;
        var letters = (s.match(/[A-Za-z]/g) || []).length;
        if (letters < 4) return false;
        // Mostly letters, spaces and the punctuation an offense title uses.
        var allowed = (s.match(/[A-Za-z0-9 \-'\/&.,]/g) || []).length;
        if (allowed / s.length < 0.95) return false;
        if (letters / s.length < 0.6) return false;
        return true;
    }

    /* A leading statute citation or NIBRS code in an offense cell. */
    var RE_OFFENSE_PREFIX = /^\s*(?:\d{1,2}[A-Z]?[\s.:-]+)?(?:\d+-\d+-\d+[A-Za-z0-9()]*)?\s*/;
    var RE_STATUTE_ON_LINE = /\d+-\d+-\d+[A-Za-z0-9()]*/;
    /* The start of a street address — "148 RODEN MILL RD". */
    var RE_ADDR_START = /\b\d{1,6}\s+[A-Z][A-Za-z]/;

    /* The offense description is read from the STATUTE'S OWN LINE, between
     * the citation and the address:
     *
     *   "5-14-103a(1) Rape 148 RODEN MILL RD, Conway, AR 72032"
     *                 ^^^^
     *
     * Scanning the whole offense block instead pulled in NIBRS legend rows
     * ("16) Lake/Waterway/Beach Dock/Wharf") that OCR had mangled past the
     * point where the bracket glyphs were still recognisable. Reading only
     * the cell that the citation itself sits in is narrow, but every value it
     * produces can be pointed at on the page.
     *
     * When the description is not on that line, it stays BLANK. A blank
     * description is honest; a legend fragment is something the officer would
     * have to explain. */
    function _descriptionOnStatuteLine(line) {
        var t = S.clean(line);
        var m = RE_STATUTE_ON_LINE.exec(t);
        if (!m) return '';
        var rest = t.slice(m.index + m[0].length);
        var bar = rest.indexOf('|');
        if (bar >= 0) rest = rest.slice(0, bar);
        var addr = RE_ADDR_START.exec(rest);
        if (addr) rest = rest.slice(0, addr.index);
        rest = rest.replace(RE_OFFENSE_PREFIX, '').trim()
                   .replace(/[\s,;:.\-\/]+$/, '').trim();
        return _looksLikeOffenseName(rest) ? rest : '';
    }

    /* The address printed on the statute's own line is the address of THAT
     * offense — "5-14-103a(1) Rape 148 RODEN MILL RD, Conway, AR 72032". */
    function _locationOnStatuteLine(line) {
        var t = S.clean(line);
        var m = RE_STATUTE_ON_LINE.exec(t);
        if (!m) return '';
        var rest = t.slice(m.index + m[0].length).replace(/^\s*\|/, '');
        var addr = RE_ADDR_START.exec(rest);
        if (!addr) return '';
        var tail = rest.slice(addr.index).replace(/\s*\|.*$/, '').trim();
        if (!S.RE_ADDR_ZIP.test(tail) && !S.RE_ADDR_NOZIP.test(tail)) return '';
        return tail.replace(/[\s,;:.\-]+$/, '');
    }

    function _readOffenses(pages, segs, hits) {
        var out = [];
        for (var s = 0; s < segs.length; s++) {
            var seg = segs[s];
            if (seg.kind !== 'offense') continue;
            var lines = pages[seg.pageIdx].lines;
            var o = { number: out.length + 1, code: '', statute: '', description: '',
                      severity: '', location: '', sourcePage: seg.page };

            var fh = _hitsIn(hits, seg, 'field');
            for (var i = 0; i < fh.length; i++) {
                if (fh[i].entry.field !== 'statute') continue;
                var v = _matchStatute(_window(lines, fh[i].line, fh[i].end, 2).text);
                if (v) { o.statute = v; break; }
            }
            /* Severity stays blank — deriving it from a statute is a legal
             * conclusion, not a reading. */
            var best = '';
            for (var j = seg.from; j < Math.min(seg.to, lines.length); j++) {
                var cand = _descriptionOnStatuteLine(lines[j]);
                if (cand && cand.length > best.length) best = cand;
                if (!o.location) {
                    var loc = _locationOnStatuteLine(lines[j]);
                    if (loc) o.location = loc;
                }
            }
            if (best) o.description = best;
            if (o.statute || o.description) out.push(o);
        }
        return out;
    }

    /* ================================================================
     * Pages
     * ================================================================ */

    function _pagesOf(text, opts) {
        var lines = S.lines(text);
        var split = S.splitPages(lines, opts && opts.pageTexts, S.isPageBreak);
        return { lines: lines, split: split, pages: split.pages };
    }

    /* ================================================================
     * Public API
     * ================================================================ */

    /* Is this worth reporting on at all? A document with almost no indicator
     * hits should be reported as "this does not look like an RMS report",
     * never as a confident empty shell. */
    function viable(text, opts) {
        var v = _viability(text, opts);
        return v.viable;
    }

    function _viability(text, opts) {
        var ctx = _pagesOf(text, opts);
        var hits = _index(ctx.pages);
        var keys = {}, roles = 0, fields = 0;
        for (var i = 0; i < hits.length; i++) {
            keys[hits[i].key] = true;
            if (hits[i].cls === 'role') roles++;
            if (hits[i].cls === 'field') fields++;
        }
        var distinct = Object.keys(keys).length;
        var names = 0;
        for (var p = 0; p < ctx.pages.length; p++) {
            var lines = ctx.pages[p].lines;
            for (var l = 0; l < lines.length; l++) {
                if (S.extractName(lines[l]) &&
                    _safeName(lines[l], S.extractName(lines[l]))) { names++; break; }
            }
        }

        /* A supplement is a case number, an officer and a page of prose. It
         * carries almost no labels, so the label test alone rejects it — and
         * rejecting a document that plainly contains an officer's narrative
         * is the worst answer available. Substantial prose is on its own
         * enough to say "yes, this is a report". */
        var segs = _segment(ctx.pages, hits);
        var narr = _readNarrative(ctx.pages, segs, function () {});
        var narrChars = narr.narratives.length ? narr.narratives[0].text.length : 0;

        var byLabels = distinct >= 5 && fields >= 4 && (roles >= 1 || names >= 1);
        var byNarrative = narrChars >= 200 && distinct >= 2;

        return {
            viable: byLabels || byNarrative,
            distinct: distinct, roles: roles, fields: fields, names: names,
            narrChars: narrChars,
            ctx: ctx, hits: hits
        };
    }

    /* A cheap read for the create-case form: enough to prefill a case number,
     * a location and a synopsis without doing the full harvest. */
    function quickScan(text, opts) {
        var ctx = _pagesOf(text, opts);
        var hits = _index(ctx.pages);
        var rf = _reportFields(ctx.pages, hits);
        var segs = _segment(ctx.pages, hits);
        var warnings = [];
        var narr = _readNarrative(ctx.pages, segs, function (w) { warnings.push(w); });
        var offenses = _readOffenses(ctx.pages, segs, hits);

        var roles = {};
        for (var i = 0; i < hits.length; i++) {
            if (hits[i].cls !== 'role') continue;
            roles[hits[i].entry.role] = (roles[hits[i].entry.role] || 0) + 1;
        }

        var synopsis = '';
        if (narr.narratives.length) {
            synopsis = narr.narratives[0].text.split(/\n\s*\n/)[0] || '';
            if (synopsis.length > 600) synopsis = synopsis.slice(0, 600).replace(/\s+\S*$/, '') + '…';
        }

        return {
            format: FORMAT,
            formatLabel: FORMAT_LABEL,
            reportNumber: rf.reportNumber || '',
            reportDate: rf.reportDate || '',
            agencyName: rf.agencyName || '',
            location: rf.location || '',
            synopsis: synopsis,
            offenses: offenses,
            offenseList: offenses.map(function (o) { return o.description || o.statute; })
                .filter(function (x) { return !!x; }),
            primaryOffense: offenses.length ? (offenses[0].description || offenses[0].statute) : '',
            roles: roles,
            narrativeFound: !!narr.narratives.length,
            hits: hits.length,
            pageCount: ctx.pages.length
        };
    }

    /*
     * Full read. Returns the standard RMS report object with ONE deliberate
     * difference: personsInvolved is always empty and everyone is in
     * reviewPersons. See the safety model in the file header.
     */
    function parse(text, fileName, opts) {
        var raw = String(text == null ? '' : text);
        var ctx = _pagesOf(raw, opts);
        var pages = ctx.pages;
        var hits = _index(pages);
        var segs = _segment(pages, hits);

        var warnings = [];
        function warn(w) { if (warnings.indexOf(w) === -1) warnings.push(w); }
        if (ctx.split.warning) warn(ctx.split.warning);

        var rf = _reportFields(pages, hits);
        var offenses = _readOffenses(pages, segs, hits);
        var narr = _readNarrative(pages, segs, warn);

        var people = [];
        var vehicles = [];
        var taken = {};
        for (var s = 0; s < segs.length; s++) {
            var seg = segs[s];
            var lines = pages[seg.pageIdx].lines;
            if (seg.kind === 'person') {
                var person = _harvestPerson(seg, hits, lines);
                if (!_personHasData(person)) continue;
                if (person.name) {
                    var k = _nameKey(person.name);
                    if (taken[k]) continue;
                    taken[k] = true;
                }
                people.push(person);
            } else if (seg.kind === 'vehicle') {
                var v = _harvestVehicle(seg, hits, lines);
                if (_vehicleHasData(v)) vehicles.push(v);
            }
        }

        people = people.concat(_orphans(pages, segs, hits, taken));
        people = _mergeDuplicateBands(people);

        var unnamed = people.filter(function (p) { return !p.name; }).length;
        if (unnamed) {
            warn(unnamed + ' person block(s) were found with no readable name. ' +
                 'They are shown with everything that WAS read so you can identify ' +
                 'them against the document.');
        }
        if (!people.length) {
            warn('No person blocks were recognised on this report.');
        }
        if (!narr.narratives.length) {
            warn('No narrative was recognised on this report.');
        }

        var report = {
            id: 'rms_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            fileName: fileName || '',
            importedAt: new Date().toISOString(),
            reportNumber: rf.reportNumber || _caseNoFromFileName(fileName),
            reportDate: rf.reportDate || '',
            reportType: 'Report',
            supplementNo: '',
            agencyName: rf.agencyName || '',
            location: rf.location || '',
            beat: '',
            fromDateTime: '',
            toDateTime: '',
            offenses: offenses,

            /* ALWAYS EMPTY. routeRmsPersonsToTabs() reads only this array, so
             * leaving it empty is what makes auto-filing impossible. */
            personsInvolved: [],
            provisionalPersons: [],

            vehicles: [],
            property: [],
            narratives: narr.narratives,
            digital: [],
            confidentialPersons: [],
            pageCount: pages.length,
            rawText: raw,

            arPageBounds: ctx.split.bounds,
            arPagesAuthoritative: !!ctx.split.authoritative,

            /* --- generic-read payload (additive; ignored by the bespoke UI) --- */
            genericFormat: FORMAT,
            genericFormatLabel: FORMAT_LABEL,
            genericBanner: GENERIC_BANNER,
            reviewPersons: people,
            reviewVehicles: vehicles,
            reviewSources: rf.fieldSources || {},

            diagnostics: {
                pages: pages.length,
                indicatorHits: hits.length,
                segments: segs.length,
                persons: people.length,
                unnamedPersons: unnamed,
                vehicles: vehicles.length,
                offenses: offenses.length,
                narrativeChars: narr.narratives.length ? narr.narratives[0].text.length : 0,
                narrativePages: narr.srcPages,
                unreadablePages: narr.unreadable,
                checkboxFieldsSkipped: true,
                warnings: warnings
            }
        };
        return report;
    }

    function _caseNoFromFileName(fileName) {
        var m = /(\d{2}-\d{4,8}|\d{4}-\d{5,8})/.exec(String(fileName || ''));
        return m ? m[1] : '';
    }

    return {
        FORMAT: FORMAT,
        FORMAT_LABEL: FORMAT_LABEL,
        GENERIC_BANNER: GENERIC_BANNER,
        ROLE: ROLE,
        LEXICON: LEXICON,
        viable: viable,
        quickScan: quickScan,
        parse: parse,

        /* test hooks — private internals, not a supported API */
        _index: _index,
        _segment: _segment,
        _window: _window,
        _cutAtNextLabel: _cutAtNextLabel,
        _viability: _viability,
        _nameLoose: _nameLoose,
        _isLabelRow: _isLabelRow,
        _labelRowScore: _labelRowScore,
        _nameLooksLikeJunk: _nameLooksLikeJunk,
        _isLogRow: _isLogRow,
        _safeName: _safeName,
        _isCheckboxLegend: _isCheckboxLegend,
        _mergeDuplicateBands: _mergeDuplicateBands,
        _matchDate: _matchDate,
        _matchDl: _matchDl,
        _matchPlate: _matchPlate,
        _matchVin: _matchVin,
        _matchHeight: _matchHeight,
        _matchWord: _matchWord,
        _matchCaseNo: _matchCaseNo,
        _matchStatute: _matchStatute,
        _confidence: _confidence
    };
});

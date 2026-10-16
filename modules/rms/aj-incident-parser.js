/*
 * "INCIDENT NUMBER: / ORI #" Reporting Services report family
 * (first seen from Apache Junction (AZ) Police Department).
 * -----------------------------------------------------------------------
 *
 * WHY THIS EXISTS
 *
 * An officer sent three documents out of one RMS — the Incident Report, a
 * Narrative Supplement and a Forensic Supplement Report. None of VIPER's
 * readers recognised them, so every one fell through to the old INFORM
 * fallback and came back with no report number, no people, no offence and
 * — on the incident report — a narrative that started with the page
 * footer. The generic sweep then listed "possible persons" for review
 * that the report actually states plainly.
 *
 * WHAT THE DOCUMENT LOOKS LIKE (as the text layer delivers it)
 *
 * Every page begins with the same block:
 *
 *      INCIDENT NUMBER:
 *      261009013
 *      APACHE JUNCTION POLICE
 *      Department
 *      INCIDENT REPORT                 <- the document's title
 *      ORI #
 *      AZ0111300
 *
 * and the Incident Report (only) ends each page with "1of6Page". Below
 * that, the body is a form: a label on one line and its value on the
 * next. Three things about it drive the code:
 *
 * 1. EMPTY CELLS RUN TOGETHER. A row of cells the officer left blank
 *    arrives as one line of labels glued end to end, and when the LAST
 *    cell of the row has a value it follows on the next line:
 *
 *      SSNOLNOLN State          -> SSN '', OLN '', OLN State 'NC'
 *      NC
 *      To AgeSex                -> To Age '', Sex 'F'
 *      F
 *
 *    So a line is a label line only if it splits EXACTLY into known
 *    labels, and only the last of them can own the next line. Labels are
 *    matched case-sensitively: they are printed in Title Case and every
 *    value on this form is printed in capitals, which is what keeps a
 *    value from being mistaken for a label.
 *
 * 2. ONE TABLE CAN INTERLEAVE WITH ANOTHER AT A PAGE BREAK. On the
 *    sample, "Other Person #1" starts at the foot of page 2, the
 *    ORGANIZATION INFORMATION table is printed under it, and the rest of
 *    Other Person #1 (date of birth, involvement type…) continues at the
 *    top of page 3. A page that opens with a person-only field while an
 *    organisation is open is therefore handed back to the person.
 *
 * 3. THE NARRATIVE CAN BE PRINTED TWICE. The Narrative Supplement printed
 *    its whole narrative, then printed it again. A narrative that is
 *    exactly two copies of itself is kept once.
 *
 * WHAT IS DELIBERATELY NOT DONE
 *
 * "#Error" is what Reporting Services prints when the field's expression
 * failed; it is treated as blank, never as a value.
 *
 * Nothing is guessed. An organisation the report names no one for is not
 * filed under a made-up name — it is listed under "Name Not Read" so the
 * officer can place it. Statutes are carried exactly as printed.
 *
 * Detection is keyed on the page block's structure, not on the words
 * "Apache Junction", so another agency printing from the same system is
 * read too.
 *
 * Pure, no DOM: runs under Node for __tests__/aj-incident-parser.test.js.
 */
/*
 * UMD assigning to BOTH module.exports and the global. `module` is defined
 * in VIPER's renderer, so an if/else would take the CommonJS branch, leave
 * window.AjIncidentParser undefined, and the dispatcher would silently
 * never fire. Same pattern as fw-inform-parser.js.
 */
(function (root, factory) {
    'use strict';
    var api = factory();
    if (typeof module === 'object' && module && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.AjIncidentParser = api;
    }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    /* ------------------------------------------------------------------ *
     * Label vocabulary — every label printed on the three sample forms,
     * plus a few the same system almost certainly prints for property and
     * vehicles. Case-sensitive; see note 1 above.
     * ------------------------------------------------------------------ */
    var LABELS = [
        // administrative
        'Incident Description', 'Report Date', 'Reporting Date', 'Incident Start Date',
        'Day of Week', 'Incident End Date', 'Location of Incident', 'Case Status',
        'Related Case/Incident Number',
        // offence
        'Statute Code', 'Statute Description', 'Counts', 'F/M', 'Type of Weapon Used',
        'Units Entered', 'Forced Entry', 'Method of Entry', 'Point of Entry', 'Completed',
        'Premise', 'Criminal Activity/Gang Info', 'Location Type', 'Bias Motivation',
        'Suspected of Using',
        // block starts
        'Victim #', 'Other Person #', 'Suspect #', 'Witness #', 'Arrestee #',
        'Organization #',
        // a person / organisation
        'Name (Last, First, Middle)', 'Moniker', 'Address', 'Email', 'Home #', 'Cell #',
        'Work #', 'Business #', 'Organization', 'DOB', 'Age', 'To Age', 'Sex', 'Race',
        'Ethnicity', 'Resident Status', 'Height', 'Weight', 'Glasses', 'Eye Color',
        'Hair Color', 'Hair Style', 'Hair Length', 'Facial Hair', 'Dominant Hand', 'Build',
        'Complexion', 'Speech/Voice', 'Teeth', 'Clothing', 'SSN', 'OLN', 'OLN State',
        'Employer', 'Occupation', 'Victim Type', 'Statement', 'Domestic Violence',
        'Aggravated Assault Circumstances', 'Justifiable Homicide Circumstances',
        'Offenses Involved', 'Relationship to Offender', 'Type of Injury',
        'Scars, Marks, and Tattoos', 'Involvement Type',
        // property (Forensic Supplement)
        'Property Description', 'Evidence #', 'Make', 'Model', 'Serial', 'Cell Number',
        'Cell Passcode', 'Cell SIM Card #', 'Cell IMEI/ESN', 'Cell IMSI #',
        'SD Card Storage', 'Location Seizure'
    ];

    // Longest first, so "OLN State" wins over "OLN" and "Cell Number" over "Cell #".
    var LABELS_BY_LEN = LABELS.slice().sort(function (a, b) { return b.length - a.length; });
    var LABEL_SET = {};
    for (var li = 0; li < LABELS.length; li++) LABEL_SET[LABELS[li]] = true;

    var BLOCK_START = {
        'Victim #': 'victim', 'Other Person #': 'other', 'Suspect #': 'suspect',
        'Witness #': 'witness', 'Arrestee #': 'arrestee', 'Organization #': 'org'
    };

    /* Fields only a PERSON block carries. A page that opens with one of
     * these while an organisation block is open is the continuation of the
     * person interrupted by that organisation — see note 2 above. */
    var PERSON_ONLY = {
        'Name (Last, First, Middle)': 1, 'Moniker': 1, 'DOB': 1, 'Age': 1, 'To Age': 1,
        'Sex': 1, 'Race': 1, 'Ethnicity': 1, 'Resident Status': 1, 'Height': 1,
        'Weight': 1, 'Glasses': 1, 'Eye Color': 1, 'Hair Color': 1, 'Hair Style': 1,
        'Hair Length': 1, 'Facial Hair': 1, 'Dominant Hand': 1, 'Build': 1,
        'Complexion': 1, 'Speech/Voice': 1, 'Teeth': 1, 'Clothing': 1, 'SSN': 1,
        'OLN': 1, 'OLN State': 1, 'Employer': 1, 'Occupation': 1, 'Statement': 1,
        'Scars, Marks, and Tattoos': 1, 'Home #': 1, 'Cell #': 1, 'Work #': 1, 'Email': 1
    };

    /* Sections the NARRATIVE may be followed by. Inside a narrative only
     * these end it — a forensic narrative quotes e-mails, and one of them
     * has a line reading "ORDER INFORMATION". */
    var KNOWN_SECTIONS = [
        'ADMINISTRATIVE INFORMATION', 'OFFENSE INFORMATION', 'VICTIM INFORMATION',
        'COMPLAINANT / OTHER INVOLVED PARTIES', 'ORGANIZATION INFORMATION',
        'SUSPECT(S) INFORMATION', 'SUSPECT INFORMATION', 'WITNESS INFORMATION',
        'WITNESS(ES) INFORMATION', 'ARRESTEE INFORMATION', 'ARRESTEE(S) INFORMATION',
        'PROPERTY INFORMATION', 'VEHICLE INFORMATION', 'VEHICLE(S) INFORMATION',
        'OFFICER INFORMATION'
    ];

    var OFFICER_ROLES = /^(REPORTING|APPROVING|ASSISTING|ASSIGNED|SUPERVISING|SUPERVISOR|REVIEWING|INVESTIGATING|ENTERED BY|ENTERING)\s*(.*)$/;

    var RACE_CODES = {
        W: 'WHITE', B: 'BLACK', A: 'ASIAN', I: 'AMERICAN INDIAN',
        P: 'PACIFIC ISLANDER', H: 'HISPANIC', U: 'UNKNOWN', O: 'OTHER'
    };
    var SEX_CODES = { M: 'MALE', F: 'FEMALE', U: 'UNKNOWN', X: 'UNKNOWN' };
    var ETHNICITY_CODES = { N: 'NOT HISPANIC', H: 'HISPANIC', U: 'UNKNOWN' };

    function _s(v) { return v == null ? '' : String(v); }
    function _trim(v) { return _s(v).replace(/\s+/g, ' ').trim(); }

    /* "#Error" is Reporting Services' failed-expression marker, not data. */
    function _val(v) {
        var t = _trim(v);
        if (!t || /^#Error$/i.test(t)) return '';
        return t;
    }

    /* ------------------------------------------------------------------ *
     * Dates
     * ------------------------------------------------------------------ */

    function _iso(y, mo, da) {
        var Y = parseInt(y, 10), M = parseInt(mo, 10), D = parseInt(da, 10);
        if (!Y || !M || !D || M > 12 || D > 31 || Y < 1900 || Y > 2100) return '';
        return Y + '-' + (M < 10 ? '0' + M : M) + '-' + (D < 10 ? '0' + D : D);
    }

    /* <input type="date"> takes YYYY-MM-DD only. A two-digit year is not
     * accepted — blank is better than a confidently wrong birth year. */
    function parseDate(raw) {
        var m = _trim(raw).match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})/);
        return m ? _iso(m[3], m[1], m[2]) : '';
    }

    /* "21:42" off "10/09/2026 21:42". Midnight with seconds ("00:00:00")
     * is how the supplement prints a date that has no time, so it is
     * dropped rather than shown as a time. */
    function parseTime(raw) {
        var m = _trim(raw).match(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/);
        if (!m) return '';
        var h = parseInt(m[1], 10);
        if (h > 23) return '';
        if (m[3] !== undefined && h === 0 && m[2] === '00' && m[3] === '00') return '';
        return (h < 10 ? '0' + h : String(h)) + ':' + m[2];
    }

    function _dateTime(raw) {
        var d = parseDate(raw);
        if (!d) return '';
        var t = parseTime(raw);
        return t ? d + ' ' + t : d;
    }

    function parseHeight(raw) {
        var v = _val(raw);
        if (!v) return '';
        var m = v.match(/^(\d)\s*['\u2019\-]\s*(\d{1,2})"?$/) || v.match(/^(\d)(\d{2})$/);
        if (m) {
            var ft = parseInt(m[1], 10), inch = parseInt(m[2], 10);
            if (ft >= 1 && ft <= 8 && inch <= 11) return String(ft * 12 + inch);
        }
        return /^\d{2,3}$/.test(v) ? v : '';
    }

    /* ------------------------------------------------------------------ *
     * Label lines
     * ------------------------------------------------------------------ */

    /*
     * Split a line into known labels, or return null if it is not made
     * ENTIRELY of labels. Longest-first with backtracking, so
     * "SSNOLNOLN State" comes out as SSN / OLN / OLN State.
     */
    function segmentLabels(line) {
        var t = _trim(line);
        if (!t) return null;
        if (LABEL_SET[t]) return [t];
        var memo = {};
        function from(pos) {
            if (pos === t.length) return [];
            if (pos in memo) return memo[pos];
            memo[pos] = null;
            for (var i = 0; i < LABELS_BY_LEN.length; i++) {
                var lab = LABELS_BY_LEN[i];
                if (t.substr(pos, lab.length) !== lab) continue;
                var rest = from(pos + lab.length);
                if (rest) { memo[pos] = [lab].concat(rest); return memo[pos]; }
            }
            return null;
        }
        // Run-together labels never have a space at the join, but a label
        // itself can contain spaces — so the raw trimmed text is segmented.
        return from(0);
    }

    function _heading(line) {
        var t = _trim(line);
        if (!t || /[a-z]/.test(t)) return '';
        if (t === 'NARRATIVE') return t;
        if (/^[A-Z][A-Z()\/&,.\- ]*\s(INFORMATION|PARTIES)$/.test(t)) return t;
        return '';
    }

    function _knownSection(line) {
        var t = _trim(line);
        return KNOWN_SECTIONS.indexOf(t) >= 0 ? t : '';
    }

    /* ------------------------------------------------------------------ *
     * Pages
     * ------------------------------------------------------------------ */

    var PAGE_FOOTER = /^\s*(\d+)\s*of\s*(\d+)\s*Page\s*$/;

    /*
     * Strip the repeated page block (and the "NofMPage" footer) and return
     * the body lines, each tagged with the page it came from. The first
     * page block also gives the incident number, the agency and the
     * document's title.
     */
    function splitPages(text) {
        var lines = _s(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
        var body = [];
        var header = { incidentNumber: '', agencyLines: [], title: '', ori: '' };
        var page = 0, declared = 0, footers = 0, headers = 0;
        for (var i = 0; i < lines.length; i++) {
            var t = _trim(lines[i]);
            var fm = t.match(PAGE_FOOTER);
            if (fm) { footers++; declared = Math.max(declared, parseInt(fm[2], 10) || 0); continue; }
            if (t === 'INCIDENT NUMBER:') {
                // Read the block up to and including the value under "ORI #".
                var j = i + 1, num = '', mid = [], ori = '', sawOri = false;
                while (j < lines.length && j <= i + 12) {
                    var h = _trim(lines[j]);
                    j++;
                    if (!h) continue;
                    if (!num) { num = h; continue; }
                    if (h === 'ORI #') { sawOri = true; continue; }
                    if (sawOri) { ori = h; break; }
                    mid.push(h);
                }
                if (sawOri) {
                    headers++;
                    page++;
                    // Blank lines just ahead of a page block are page layout,
                    // not a paragraph break: dropping them lets a sentence
                    // that runs across the page break rejoin.
                    while (body.length && !_trim(body[body.length - 1].text)) body.pop();
                    if (headers === 1) {
                        header.incidentNumber = num;
                        header.title = mid.length ? mid[mid.length - 1] : '';
                        header.agencyLines = mid.slice(0, -1);
                        header.ori = ori;
                    }
                    i = j - 1;
                    continue;
                }
            }
            if (!page) {
                // Blank lines ahead of the first page block must not open a
                // phantom page 1, or every page number after it is one high.
                if (!t) continue;
                page = 1;
            }
            body.push({ text: lines[i], page: page });
        }
        return {
            body: body,
            header: header,
            pages: Math.max(page, 1),
            declaredPages: declared,
            footers: footers,
            headers: headers
        };
    }

    /* ------------------------------------------------------------------ *
     * Narrative text
     * ------------------------------------------------------------------ */

    /*
     * The narrative arrives hard-wrapped to the form's column. Lines are
     * rejoined into paragraphs: a short line (well under the column
     * width), or a nearly-full one that ends a sentence, ends a paragraph.
     * A line broken at a hyphen with no trailing space ("one-" / "piece")
     * is joined with no space.
     */
    function reflowNarrative(rawLines) {
        var lines = [];
        for (var i = 0; i < rawLines.length; i++) lines.push(_s(rawLines[i]).replace(/\t/g, ' '));
        var lens = lines.map(function (l) { return l.trim().length; })
            .filter(function (n) { return n > 0; }).sort(function (a, b) { return a - b; });
        if (!lens.length) return '';
        var width = lens[Math.min(lens.length - 1, Math.floor(lens.length * 0.9))];
        var paras = [], cur = '';
        for (var k = 0; k < lines.length; k++) {
            var raw = lines[k];
            var t = raw.trim();
            if (!t) { if (cur) { paras.push(cur); cur = ''; } continue; }
            if (!cur) cur = t;
            else {
                var prev = lines[k - 1] || '';
                var glue = (/-$/.test(prev) && !/\s$/.test(prev) && /[A-Za-z]-$/.test(prev)) ? '' : ' ';
                cur += glue + t;
            }
            var ends = t.length < width * 0.6 ||
                (t.length < width * 0.88 && /[.!?:;"\u201d')\]]$/.test(t));
            if (ends) { paras.push(cur); cur = ''; }
        }
        if (cur) paras.push(cur);
        return paras.join('\n\n');
    }

    /* A narrative printed twice in a row is kept once. Compared with all
     * whitespace removed, because the second copy can wrap differently;
     * the split must still fall on a line boundary. */
    function dedupeRepeated(rawLines) {
        var keys = rawLines.map(function (l) { return _s(l).replace(/\s+/g, ''); });
        var all = keys.join('');
        if (all.length < 40) return { lines: rawLines, repeated: false };
        var acc = 0;
        for (var k = 0; k < keys.length - 1; k++) {
            acc += keys[k].length;
            if (acc * 2 !== all.length) { if (acc * 2 > all.length) break; continue; }
            if (all.slice(0, acc) === all.slice(acc)) {
                return { lines: rawLines.slice(0, k + 1), repeated: true };
            }
        }
        return { lines: rawLines, repeated: false };
    }

    /* "REPORTINGJEANSONNE, STEVEN 16410/13/2026" — role, name, badge and
     * the date it was signed, printed with no separators. The date is read
     * from the right as a real calendar date, which is what decides where
     * the badge stops. */
    function parseOfficerLine(line) {
        var t = _trim(line);
        var m = t.match(OFFICER_ROLES);
        if (!m || !m[2]) return null;
        var rest = m[2];
        var out = { role: m[1], name: rest, badge: '', date: '' };
        var dm = rest.match(/^(.*?\S)\s+(\d+?)((?:0?[1-9]|1[0-2])\/(?:0?[1-9]|[12]\d|3[01])\/\d{4})?$/);
        if (dm) {
            out.name = dm[1];
            out.badge = dm[2];
            out.date = dm[3] ? parseDate(dm[3]) : '';
        }
        out.name = _trim(out.name);
        return out;
    }

    /* ------------------------------------------------------------------ *
     * Body walk: turn the body lines into sections of label/value pairs.
     * ------------------------------------------------------------------ */

    function _readSections(body) {
        var sections = [];
        var cur = { heading: '', pairs: [], lines: [], page: body.length ? body[0].page : 1 };
        sections.push(cur);
        var inNarrative = false;
        var lastPage = body.length ? body[0].page : 1;    // page of the last non-blank line
        for (var i = 0; i < body.length; i++) {
            var raw = body[i].text;
            var t = _trim(raw);
            var pg = body[i].page;
            var pageBreak = false;
            if (t) { pageBreak = pg !== lastPage; lastPage = pg; }

            var head = inNarrative ? _knownSection(t) : _heading(t);
            if (head) {
                cur = { heading: head.replace(/\s+/g, ' '), pairs: [], lines: [], page: pg };
                sections.push(cur);
                inNarrative = head === 'NARRATIVE';
                continue;
            }
            if (inNarrative || /^OFFICER /.test(cur.heading)) {
                cur.lines.push({ text: raw, page: pg });
                continue;
            }
            if (!t) continue;
            var labels = segmentLabels(t);
            if (labels) {
                for (var l = 0; l < labels.length; l++) {
                    cur.pairs.push({ label: labels[l], value: '', page: pg, pageBreak: pageBreak && l === 0 });
                }
                continue;
            }
            // A value: it belongs to the last label in this section.
            var last = cur.pairs[cur.pairs.length - 1];
            if (last) last.value = last.value ? last.value + ' ' + t : t;
            else cur.lines.push({ text: raw, page: pg });
        }
        return sections;
    }

    function _kindOf(heading) {
        var h = heading;
        if (/^ADMINISTRATIVE/.test(h)) return 'admin';
        if (/^OFFENSE/.test(h)) return 'offense';
        if (/^VICTIM/.test(h)) return 'victim';
        if (/^SUSPECT/.test(h)) return 'suspect';
        if (/^ARREST/.test(h)) return 'arrestee';
        if (/^WITNESS/.test(h)) return 'witness';
        if (/COMPLAINANT|OTHER INVOLVED/.test(h)) return 'other';
        if (/^ORGANIZATION/.test(h)) return 'org';
        if (/^PROPERTY/.test(h)) return 'property';
        if (/^VEHICLE/.test(h)) return 'vehicle';
        if (/^OFFICER/.test(h)) return 'officer';
        if (h === 'NARRATIVE') return 'narrative';
        return h ? 'unknown' : 'preamble';
    }

    /* ------------------------------------------------------------------ *
     * People
     * ------------------------------------------------------------------ */

    function _personShell(involvement) {
        return {
            involvement: involvement || 'OTHER PERSON',
            name: '', alias: '', dob: '', age: '',
            sex: '', race: '', ethnicity: '',
            address: '', phone: '', email: '',
            dl: '', dlState: '', ssn: '', sid: '', fbi: '',
            employmentPhone: '', occupation: '', placeOfEmployment: '',
            height: '', weight: '', hair: '', eyes: '',
            build: '', facialHair: '', clothing: '', smt: '',
            placeOfBirth: '', maritalStatus: '', relationship: '',
            arrested: '', juvenile: '', victimType: '',
            meansOfAttack: '', typeOfInjury: '',
            comments: '', guardian: '', detail: '',
            number: '', sourcePage: 0
        };
    }

    var ROLE_OF_KIND = {
        victim: 'VICTIM', suspect: 'SUSPECT', arrestee: 'SUSPECT (ARRESTEE)',
        witness: 'WITNESS', other: 'OTHER PERSON', org: 'ORGANIZATION'
    };

    function _tidyAddress(v) {
        return _val(v).replace(/\s+,/g, ',').replace(/,\s*,/g, ',').replace(/^,\s*|,\s*$/g, '');
    }

    function _tidyName(v) {
        return _val(v).replace(/\s+,/g, ',').replace(/,(\S)/g, ', $1');
    }

    /* Collect each person/organisation block in every person section. */
    function _readBlocks(sections) {
        var blocks = [];
        var lastPerson = null;      // most recent block that is a person
        for (var s = 0; s < sections.length; s++) {
            var kind = _kindOf(sections[s].heading);
            if (!ROLE_OF_KIND[kind]) continue;
            var cur = null;
            var pairs = sections[s].pairs;
            for (var i = 0; i < pairs.length; i++) {
                var pr = pairs[i];
                var start = BLOCK_START[pr.label];
                if (start) {
                    // The block's own label decides what it is, not the
                    // heading above it: after a page break the report
                    // resumes "Other Person #2, #3" INSIDE the
                    // ORGANIZATION INFORMATION section.
                    cur = { kind: start, number: _val(pr.value),
                        fields: [], page: pr.page };
                    blocks.push(cur);
                    if (cur.kind !== 'org') lastPerson = cur;
                    continue;
                }
                // See note 2: a page that opens with a person-only field
                // while an organisation is open continues the person.
                if (cur && cur.kind === 'org' && pr.pageBreak && PERSON_ONLY[pr.label] && lastPerson) {
                    cur = lastPerson;
                }
                if (!cur) continue;
                cur.fields.push(pr);
            }
        }
        return blocks;
    }

    function _blockToPerson(b, warnings) {
        var p = _personShell(ROLE_OF_KIND[b.kind]);
        p.number = b.number;
        p.sourcePage = b.page;
        var phones = [];
        var seenAddress = false, afterEmployer = false;
        var extra = [];
        var involvementType = '';
        for (var i = 0; i < b.fields.length; i++) {
            var lab = b.fields[i].label;
            var v = _val(b.fields[i].value);
            if (lab === 'Employer' || lab === 'Occupation') afterEmployer = true;
            if (!v) continue;
            switch (lab) {
                case 'Name (Last, First, Middle)': p.name = _tidyName(v); break;
                case 'Organization': p.name = _tidyName(v); break;
                case 'Moniker': p.alias = v; break;
                case 'Address':
                    // The second Address in a block, after Employer, is the
                    // employer's.
                    if (!seenAddress && !afterEmployer) { p.address = _tidyAddress(v); seenAddress = true; }
                    else if (afterEmployer) extra.push('Employer address: ' + _tidyAddress(v));
                    break;
                case 'Email': if (/@/.test(v)) p.email = v; break;
                case 'Home #': case 'Cell #': case 'Work #': case 'Business #':
                    if (v.replace(/\D/g, '').length >= 7 && phones.indexOf(v) < 0) phones.push(v);
                    break;
                case 'DOB': p.dob = parseDate(v); break;
                case 'Age': if (/^\d{1,3}$/.test(v)) p.age = v; break;
                case 'Sex': p.sex = SEX_CODES[v.toUpperCase()] || v; break;
                case 'Race': p.race = RACE_CODES[v.toUpperCase()] || v; break;
                case 'Ethnicity': p.ethnicity = ETHNICITY_CODES[v.toUpperCase()] || v; break;
                case 'Height': p.height = parseHeight(v); break;
                case 'Weight': if (/^\d{2,3}$/.test(v)) p.weight = v; break;
                case 'Eye Color': p.eyes = v; break;
                case 'Hair Color': p.hair = v; break;
                case 'Build': p.build = v; break;
                case 'Facial Hair': p.facialHair = v; break;
                case 'Clothing': p.clothing = v; break;
                case 'Scars, Marks, and Tattoos': p.smt = v; break;
                case 'SSN': if (/\d/.test(v)) p.ssn = v; break;
                case 'OLN': if (/\d/.test(v)) p.dl = v; break;
                case 'OLN State': if (/^[A-Z]{2}$/.test(v)) p.dlState = v; break;
                case 'Employer': p.placeOfEmployment = v; break;
                case 'Occupation': p.occupation = v; break;
                case 'Victim Type': p.victimType = v; break;
                case 'Relationship to Offender': p.relationship = v; break;
                case 'Type of Injury': p.typeOfInjury = v; break;
                case 'Involvement Type': involvementType = v; break;
                case 'Resident Status': extra.push('Resident status: ' + v); break;
                case 'Statement': extra.push('Statement: ' + v); break;
                case 'Domestic Violence': extra.push('Domestic violence: ' + v); break;
                case 'Offenses Involved': extra.push('Offenses involved: ' + v); break;
                case 'Type of Weapon Used': extra.push('Weapon: ' + v); break;
                case 'Glasses': case 'Hair Style': case 'Hair Length': case 'Dominant Hand':
                case 'Complexion': case 'Speech/Voice': case 'Teeth':
                    extra.push(lab + ': ' + v); break;
                default: break;
            }
        }
        p.phone = phones.join('; ');
        // Other involved parties carry their role in "Involvement Type"
        // ("PERSON REPORTING EVENT", "MISC. ASSOCIATED NAMES", …); it is
        // shown exactly as printed. In the victim / suspect sections the
        // section itself is the role.
        if (b.kind === 'other' && involvementType) p.involvement = involvementType;
        else if (b.kind === 'org') {
            p.involvement = /VICTIM/i.test(involvementType) ? 'VICTIM (ORGANIZATION)' : 'ORGANIZATION';
            if (involvementType) extra.unshift('Involvement: ' + involvementType);
        } else if (involvementType) extra.unshift('Involvement: ' + involvementType);
        p.detail = extra.join(' · ');
        return p;
    }

    /* ------------------------------------------------------------------ *
     * Offences, property, officers
     * ------------------------------------------------------------------ */

    function _readOffenses(pairs) {
        var out = [], cur = null;
        function push() {
            if (cur && (cur.statute || cur.description)) out.push(cur);
            cur = null;
        }
        for (var i = 0; i < pairs.length; i++) {
            var lab = pairs[i].label, v = _val(pairs[i].value);
            if (lab === 'Statute Code') {
                push();
                cur = { number: '', statute: v, description: '', severity: '', counts: '',
                    attempted: '', weapon: '', premise: '', bias: '', page: pairs[i].page };
                continue;
            }
            if (!cur) continue;
            if (lab === 'Statute Description') cur.description = v;
            else if (lab === 'Counts') cur.counts = v;
            else if (lab === 'F/M') cur.severity = /^F/i.test(v) ? 'FELONY' : /^M/i.test(v) ? 'MISDEMEANOR' : '';
            else if (lab === 'Completed') cur.attempted = v;
            else if (lab === 'Type of Weapon Used') cur.weapon = v;
            else if (lab === 'Location Type') cur.premise = v;
            else if (lab === 'Bias Motivation') cur.bias = v;
        }
        push();
        for (var k = 0; k < out.length; k++) out[k].number = String(k + 1);
        return out;
    }

    function _readProperty(pairs) {
        var out = [], cur = null;
        function push() {
            if (!cur) return;
            var d = [];
            if (cur.evidence) d.push('Evidence # ' + cur.evidence);
            var mms = [cur.make, cur.model].filter(Boolean).join(' ');
            if (mms) d.push(mms);
            if (cur.serial) d.push('Serial ' + cur.serial);
            if (cur.cell.length) d.push(cur.cell.join(' · '));
            if (cur.seized) d.push('Location seized: ' + cur.seized);
            if (cur.articleType || d.length) {
                out.push({
                    articleType: cur.articleType, description: d.join(' · '),
                    holdReason: 'EVIDENCE', value: '', evidenceNumber: cur.evidence,
                    make: cur.make, model: cur.model, serial: cur.serial,
                    locationSeized: cur.seized, page: cur.page
                });
            }
            cur = null;
        }
        for (var i = 0; i < pairs.length; i++) {
            var lab = pairs[i].label, v = _val(pairs[i].value);
            if (lab === 'Property Description') {
                push();
                cur = { articleType: v, evidence: '', make: '', model: '', serial: '',
                    seized: '', cell: [], page: pairs[i].page };
                continue;
            }
            if (!cur) continue;
            if (!v) continue;
            if (lab === 'Evidence #') cur.evidence = v;
            else if (lab === 'Make') cur.make = v;
            else if (lab === 'Model') cur.model = v;
            else if (lab === 'Serial') cur.serial = v;
            else if (lab === 'Location Seizure') cur.seized = v;
            else if (/^Cell |^SD Card/.test(lab)) cur.cell.push(lab + ': ' + v);
        }
        push();
        return out;
    }

    /* ------------------------------------------------------------------ *
     * Detection
     * ------------------------------------------------------------------ */

    /* The page block — "INCIDENT NUMBER:", a number, a few lines, "ORI #"
     * — plus an ADMINISTRATIVE INFORMATION section. Both are required. */
    var DETECT_BLOCK = /^[ \t]*INCIDENT NUMBER:[ \t]*\n[ \t]*[A-Z0-9][\w\-]*[ \t]*\n(?:[^\n]*\n){1,6}?[ \t]*ORI #[ \t]*\n/m;

    function detect(text) {
        var t = _s(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        if (!t) return false;
        if (!DETECT_BLOCK.test(t)) return false;
        return /^[ \t]*ADMINISTRATIVE INFORMATION[ \t]*$/m.test(t);
    }

    function _formatOf(title) {
        var t = _trim(title).toUpperCase();
        if (/^INCIDENT REPORT$/.test(t)) return 'aj-incident-report';
        if (/NARRATIVE SUPPLEMENT/.test(t)) return 'aj-narrative-supplement';
        if (/FORENSIC SUPPLEMENT/.test(t)) return 'aj-forensic-supplement';
        if (/SUPPLEMENT/.test(t)) return 'aj-supplement';
        return 'aj-report';
    }

    function _titleCase(s) {
        return _trim(s).toLowerCase().replace(/\b([a-z])/g, function (c) { return c.toUpperCase(); });
    }

    /* ------------------------------------------------------------------ *
     * Parse
     * ------------------------------------------------------------------ */

    function parse(text, fileName) {
        var raw = _s(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        var split = splitPages(raw);
        var sections = _readSections(split.body);
        var warnings = [];

        var byKind = {};
        for (var s = 0; s < sections.length; s++) {
            var k = _kindOf(sections[s].heading);
            (byKind[k] = byKind[k] || []).push(sections[s]);
        }
        function pairsOf(kind) {
            var out = [];
            (byKind[kind] || []).forEach(function (sec) { out = out.concat(sec.pairs); });
            return out;
        }
        var admin = {};
        pairsOf('admin').forEach(function (p) {
            var v = _val(p.value);
            if (v && !(p.label in admin)) admin[p.label] = v;
        });

        // --- officers ---
        var officers = [];
        (byKind.officer || []).forEach(function (sec) {
            sec.lines.forEach(function (l) {
                var o = parseOfficerLine(l.text);
                if (o) officers.push(o);
            });
        });
        var reporting = officers.filter(function (o) { return o.role === 'REPORTING'; })[0] || officers[0] || null;

        // --- header facts ---
        var title = split.header.title;
        var format = _formatOf(title);
        var isSupplement = /supplement/.test(format);
        var agencyName = _trim(split.header.agencyLines.join(' '));
        if (/^[A-Z0-9 .,'&\-]+ [A-Z][a-z]+$/.test(agencyName)) {
            // "APACHE JUNCTION POLICE" over "Department" — one name, one case.
            agencyName = agencyName.toUpperCase();
        }
        var reportNumber = /\d/.test(split.header.incidentNumber) ? split.header.incidentNumber : '';

        var reportDateRaw = admin['Report Date'] || admin['Reporting Date'] || '';
        var reportDate = parseDate(reportDateRaw) || (reporting && reporting.date) || '';
        var fromDateTime = _dateTime(admin['Incident Start Date'] || '') ||
            (isSupplement ? '' : _dateTime(reportDateRaw));
        var toDateTime = _dateTime(admin['Incident End Date'] || '');
        var location = _tidyAddress(admin['Location of Incident'] || '');

        // --- offences, people, property ---
        var offenses = _readOffenses(pairsOf('offense'));
        var blocks = _readBlocks(sections);
        var persons = [], provisional = [];
        blocks.forEach(function (b) {
            var p = _blockToPerson(b, warnings);
            if (p.name) { persons.push(p); return; }
            if (b.kind === 'org') {
                p.detail = 'Organization — the report prints no name for it' + (p.detail ? ' · ' + p.detail : '');
                warnings.push('Organization #' + (b.number || '?') + ' has no name on the report; listed under Name Not Read.');
            } else {
                warnings.push(ROLE_OF_KIND[b.kind] + ' #' + (b.number || '?') + ' has no name on the report; listed under Name Not Read.');
            }
            provisional.push(p);
        });
        var property = _readProperty(pairsOf('property'));

        // --- narrative ---
        var narrLines = [];
        (byKind.narrative || []).forEach(function (sec) {
            sec.lines.forEach(function (l) { narrLines.push(l.text); });
        });
        while (narrLines.length && !narrLines[0].trim()) narrLines.shift();
        while (narrLines.length && !narrLines[narrLines.length - 1].trim()) narrLines.pop();
        var dd = dedupeRepeated(narrLines);
        if (dd.repeated) warnings.push('The narrative was printed twice on this report; it is shown once.');
        var narrText = reflowNarrative(dd.lines);
        var narratives = [];
        if (narrText) {
            narratives.push({
                officer: reporting ? reporting.name : '',
                badge: reporting ? reporting.badge : '',
                date: (reporting && reporting.date) || reportDate,
                text: narrText,
                page: (byKind.narrative && byKind.narrative[0].page) || 0
            });
        } else {
            warnings.push('No narrative section was found on this report.');
        }

        // The admin "Case Status" is often blank on a supplement while the
        // narrative closes with "Case Status: …".
        var caseStatus = admin['Case Status'] || '';
        if (!caseStatus) {
            var all = narrText.match(/Case Status:[^\n]+/g);
            if (all) caseStatus = _trim(all[all.length - 1].replace(/^Case Status:\s*/, ''));
        }

        if (!isSupplement && !offenses.length) warnings.push('No offence row was recognised on this report.');
        var unknown = (byKind.unknown || []).map(function (sec) { return sec.heading; });
        if (unknown.length) warnings.push('Sections not read: ' + unknown.join(', '));
        if (byKind.vehicle) warnings.push('This report has a vehicle section, which this reader does not import yet.');

        var titleNice = _titleCase(title);
        return {
            id: 'rms_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            fileName: fileName || '',
            importedAt: new Date().toISOString(),
            reportNumber: reportNumber,
            reportDate: reportDate,
            reportType: titleNice || 'Incident Report',
            // A supplement has no number on this form. Its title stands in,
            // which also tells the host it is a supplement (judged on its
            // narrative, not on a person count it was never going to have).
            supplementNo: isSupplement ? titleNice : '',
            agencyName: agencyName,
            location: location,
            beat: '',
            fromDateTime: fromDateTime,
            toDateTime: toDateTime,
            offenses: offenses,
            personsInvolved: persons,
            provisionalPersons: provisional,
            vehicles: [],
            property: property,
            narratives: narratives,
            digital: [],
            confidentialPersons: [],
            pageCount: split.declaredPages || split.pages,
            rawText: raw,

            // --- format metadata (additive; ignored by the shared UI) ---
            rmsFormat: format,
            rmsFormatLabel: (titleNice || 'Report') + ' (INCIDENT NUMBER / ORI layout)',
            aj: {
                ori: split.header.ori,
                incidentDescription: admin['Incident Description'] || '',
                caseStatus: caseStatus,
                dayOfWeek: admin['Day of Week'] || '',
                relatedCase: admin['Related Case/Incident Number'] || '',
                officers: officers
            },
            diagnostics: {
                pages: split.pages,
                declaredPages: split.declaredPages,
                headers: split.headers,
                sections: sections.map(function (x) { return x.heading || '(preamble)'; }),
                offenses: offenses.length,
                persons: persons.length,
                provisional: provisional.length,
                property: property.length,
                narrativeChars: narrText.length,
                narrativeRepeated: dd.repeated,
                warnings: warnings
            }
        };
    }

    return {
        detect: detect,
        parse: parse,
        splitPages: splitPages,
        segmentLabels: segmentLabels,
        reflowNarrative: reflowNarrative,
        dedupeRepeated: dedupeRepeated,
        parseOfficerLine: parseOfficerLine,
        parseDate: parseDate,
        parseTime: parseTime,
        LABELS: LABELS.slice()
    };
}));

/*
 * co-vehicle-parser.js — read a Colorado DMV vehicle query printout (the
 * "RESPONSE FROM DMV" page an officer prints out of the Central Square
 * records window) into a plain vehicle object.
 *
 * WHY THIS EXISTS
 * ---------------
 * VIPER already reads Colorado, California and Texas DRIVER printouts. It
 * reads nothing at all off a VEHICLE printout, so an officer running a
 * plate retypes the VIN, the plate, the year, the make, the model and the
 * colour by hand into whichever vehicle form they are standing in. A VIN
 * is seventeen characters of mixed letters and digits and it is the field
 * most worth not retyping.
 *
 * THE LAYOUT — AND THE ONE THING THAT MATTERS MOST
 * ------------------------------------------------
 * The page prints TWO COLUMNS side by side: REGISTRATION on the left and
 * TITLE on the right. When the text is lifted off the page the two columns
 * land on the SAME LINE, so the same label appears twice:
 *
 *      NAME: EXAMPLEZ RORY DALE        NAME: PLACEHOLDER LENDING LLC
 *      ADDRESS: 190 FICTITIOUS AVE     ADDRESS: PO BOX 400
 *
 * The registered owner and the titled owner are frequently NOT the same
 * person — a financed vehicle is titled to the lender. A reader that took
 * the first match for "NAME" and stopped would be right by luck; one that
 * took the last would quietly hand the officer the finance company. So
 * every line is scanned for ALL of its labels, and where a label occurs
 * twice the first is the registration column and the second is the title.
 *
 * THE SECOND THING THAT MATTERS
 * -----------------------------
 * The vehicle description is six fields — MAKE, MODEL, COLOR, STYLE, YEAR,
 * FUEL — printed as two logical lines. Depending on how long the model
 * name is, OCR brings them back as ONE physical line or TWO. Both were
 * measured on real submissions. Nothing here is indexed by line number for
 * that reason: labels are found wherever they fall.
 *
 * SMALLER FACTS, ALL MEASURED
 * ---------------------------
 *  - OCR puts a space before some colons ("MAKE :", "NAME2 :"), so every
 *    label match allows optional space ahead of the colon.
 *  - The page is printed from a browser, so it carries an "about:blank"
 *    header and footer, and the response carries a block of criminal
 *    justice use-only disclaimer lines beginning with "*%%". All of it is
 *    skipped before any label is read.
 *  - NAME2 and NAME3 are nearly always blank and print as a bare label.
 *  - EXPIRATION prints as YYYY-MM, not as a date.
 *  - TITLE STATUS carries its date in the same value ("Active 06/02/2013").
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * Names are kept exactly as the state printed them. Colorado prints the
 * surname first with no comma, and rearranging that guesses at where the
 * surname ends — "SAMPLEFORD QUINCY ARDEN" could be two names or three.
 *
 * A VIN that does not come back as seventeen characters is still returned,
 * with a warning attached. A plate read off a scanned page is worth more
 * to an officer than a blank field, and the officer can see the page.
 *
 * Nothing here writes anything. The host shows the officer what was read
 * and asks before filling a field, and it only ever fills a blank one.
 */
(function (root, factory) {
    'use strict';
    var api = factory();
    // Assign to BOTH. A single-branch UMD that takes the CommonJS arm in a
    // renderer leaves the global undefined and every host guard silently
    // never fires.
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root) root.CoVehicleParser = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // Every label the printout is known to carry. ORDER IS LOAD-BEARING:
    // the alternation is tried left to right, so a label that is a prefix
    // of another must come after it. "TITLE STATUS" before "TITLE", and
    // "NAME2"/"NAME3" before "NAME", or the longer label is never seen.
    var LABELS = [
        'REGISTRATION STATUS', 'TITLE STATUS',
        'REQUEST DATE/TIME', 'RESPONSE DATE/TIME', 'REQUESTED BY',
        'QUERY FIELDS', 'QUERY ON',
        'NAME2', 'NAME3', 'NAME',
        'ADDRESS', 'CIS',
        'LICENSE', 'STATE', 'TYPE',
        'EXPIRATION', 'TAB',
        'VIN', 'TITLE', 'COUNTY',
        'MAKE', 'MODEL', 'COLOR', 'STYLE', 'YEAR', 'FUEL',
        'OPERATOR', 'PURPOSE', 'ORI', 'REQUEST'
    ];

    // Colorado abbreviates paint colours. The raw code is always kept; this
    // only supplies something readable alongside it.
    var COLOR_CODES = {
        BLK: 'Black', BLU: 'Blue', BRN: 'Brown', BGE: 'Beige', CPR: 'Copper',
        CRM: 'Cream', DBL: 'Dark Blue', DGR: 'Dark Green', GLD: 'Gold',
        GRN: 'Green', GRY: 'Gray', LAV: 'Lavender', LBL: 'Light Blue',
        LGR: 'Light Green', MAR: 'Maroon', ONG: 'Orange', ORN: 'Orange',
        PLE: 'Purple', PNK: 'Pink', RED: 'Red', SIL: 'Silver', TAN: 'Tan',
        TRQ: 'Turquoise', WHI: 'White', WHT: 'White', YEL: 'Yellow'
    };

    function _escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'); }

    var LABEL_RE_SRC = '(' + LABELS.map(_escapeRe).join('|') + ')[ \\t]*:';

    // A line that carries no record data. The browser print furniture and
    // the use-only disclaimer both sit inside the response, not around it,
    // so they have to be dropped line by line rather than trimmed off an
    // end.
    function _isFurniture(line) {
        var l = String(line || '');
        if (!l.trim()) return true;
        if (/about:blank/i.test(l)) return true;
        if (/^\s*\*/.test(l) || l.indexOf('%%') !== -1) return true;
        if (/^\s*\d{1,2}\/\d{1,2}\/\d{2,4}\s*,\s*\d{1,2}:\d{2}/.test(l)) return true;
        return false;
    }

    // Every (label, value) pair on one physical line, in the order they
    // print. A value runs from the end of its own colon to the start of the
    // next label on the same line, which is what makes the two-column rows
    // readable without knowing anything about column positions.
    function scanPairs(line) {
        var re = new RegExp('\\b' + LABEL_RE_SRC, 'gi');
        var marks = [], m;
        while ((m = re.exec(line)) !== null) {
            marks.push({
                label: m[1].toUpperCase().replace(/\s+/g, ' '),
                end: m.index + m[0].length,
                start: m.index
            });
            if (re.lastIndex === m.index) re.lastIndex++;
        }
        var out = [];
        for (var i = 0; i < marks.length; i++) {
            var stop = (i + 1 < marks.length) ? marks[i + 1].start : line.length;
            out.push({ label: marks[i].label, value: line.slice(marks[i].end, stop).trim() });
        }
        return out;
    }

    function detect(text) {
        if (!text || typeof text !== 'string') return false;
        var t = text.toUpperCase();
        if (t.indexOf('COLORADO VEHICLE REGISTRATION') !== -1) return true;
        if (t.indexOf('RESPONSE FROM DMV') !== -1 && /QUERY\s*ON[ \t]*:\s*LIC\//.test(t)) return true;
        return false;
    }

    function _clean(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); }

    function _plate(v) { return _clean(v).toUpperCase().replace(/[^A-Z0-9]/g, ''); }

    function _vin(v) { return _clean(v).toUpperCase().replace(/[^A-Z0-9]/g, ''); }

    // "2027-09" is how the page prints a registration expiry. Officers read
    // dates as month first, so both forms are returned and the host shows
    // the readable one.
    function _expiry(raw) {
        var v = _clean(raw);
        var m = /^(\d{4})\s*-\s*(\d{1,2})$/.exec(v);
        if (m) return { raw: v, display: String(m[2]).padStart(2, '0') + '/' + m[1] };
        m = /^(\d{1,2})\s*-\s*(\d{4})$/.exec(v);
        if (m) return { raw: v, display: String(m[1]).padStart(2, '0') + '/' + m[2] };
        return { raw: v, display: v };
    }

    function parse(text) {
        var out = {
            format: 'co-vehicle', state: 'CO', recognized: false,
            plate: '', plateState: '', plateType: '',
            expiration: '', expirationDisplay: '', tab: '',
            vin: '', title: '', titleStatus: '', titleDate: '',
            registrationStatus: '', county: '',
            make: '', model: '', makeModel: '', color: '', colorLabel: '',
            style: '', year: '', fuel: '',
            registeredOwner: { name: '', name2: '', name3: '', address: '', cis: '' },
            titleOwner: { name: '', name2: '', name3: '', address: '', cis: '' },
            query: { queriedOn: '', queryFields: '', requestedBy: '', operator: '', requestDateTime: '', responseDateTime: '' },
            warnings: []
        };
        if (!text || typeof text !== 'string') {
            out.warnings.push('No text was supplied.');
            return out;
        }
        out.recognized = detect(text);

        var lines = text.replace(/\r\n/g, '\n').split('\n').filter(function (l) { return !_isFurniture(l); });

        // THE HEADER HAS TO BE CUT OFF BEFORE ANY COLUMN IS COUNTED.
        // The query header ends with "Requested By: TESTER, PAT Name:" — a
        // bare, empty NAME label. Left in, it becomes the first entry in
        // the NAME column list and shifts the registered owner into the
        // title slot and the titled owner off the end of the page. That is
        // the worst failure this reader could have, so the record is read
        // only from below the "RESPONSE FROM DMV" marker.
        var startAt = 0;
        for (var li = 0; li < lines.length; li++) {
            if (/RESPONSE\s+FROM\s+DMV/i.test(lines[li]) ||
                /COLORADO\s+VEHICLE\s+REGISTRATION/i.test(lines[li])) { startAt = li + 1; break; }
        }
        var bodyLines = lines.slice(startAt).filter(function (l) {
            // belt and braces for a page whose marker did not survive OCR
            return !/REQUESTED\s*BY[ \t]*:/i.test(l);
        });

        // first occurrence wins, for everything that prints once
        var first = {};
        // the two-column rows, kept as ordered lists
        var columns = {};

        bodyLines.forEach(function (line) {
            var pairs = scanPairs(line);
                pairs.forEach(function (p) {
                    if (!Object.prototype.hasOwnProperty.call(first, p.label)) first[p.label] = p.value;
                    if (!columns[p.label]) columns[p.label] = [];
                    columns[p.label].push(p.value);
                });
        });

        // The query header is metadata, not record data, so it is read
        // separately and from the whole page.
        var meta = {};
        lines.forEach(function (line) {
            scanPairs(line).forEach(function (p) {
                if (!Object.prototype.hasOwnProperty.call(meta, p.label)) meta[p.label] = p.value;
            });
        });

        function f(label) { return _clean(first[label] || ''); }
        function g(label) { return _clean(meta[label] || ''); }
        // The registration column is the first time a two-column label
        // prints on its row; the title column is the second.
        function col(label, which) {
            var list = columns[label] || [];
            return _clean(list[which] || '');
        }

        out.plate = _plate(f('LICENSE'));
        out.plateState = _clean(f('STATE')).toUpperCase().slice(0, 2);
        out.plateType = f('TYPE');

        var exp = _expiry(f('EXPIRATION'));
        out.expiration = exp.raw;
        out.expirationDisplay = exp.display;
        out.tab = _clean(f('TAB'));

        out.vin = _vin(f('VIN'));
        out.title = _clean(f('TITLE'));
        out.county = f('COUNTY');
        out.registrationStatus = f('REGISTRATION STATUS');

        // "Active 06/02/2013" — the status and the date it was issued share
        // one value on the page.
        var ts = f('TITLE STATUS');
        var tsm = /^(.*?)[\s]*(\d{1,2}\/\d{1,2}\/\d{2,4})\s*$/.exec(ts);
        if (tsm) { out.titleStatus = _clean(tsm[1]); out.titleDate = tsm[2]; }
        else { out.titleStatus = ts; }

        out.make = f('MAKE');
        out.model = f('MODEL');
        out.makeModel = [out.make, out.model].filter(Boolean).join(' ');
        out.color = f('COLOR');
        out.colorLabel = COLOR_CODES[out.color.toUpperCase()] || out.color;
        out.style = f('STYLE');
        out.fuel = f('FUEL');

        var ym = /\b(19|20)\d{2}\b/.exec(f('YEAR'));
        out.year = ym ? ym[0] : _clean(f('YEAR'));

        out.registeredOwner.name = col('NAME', 0);
        out.registeredOwner.name2 = col('NAME2', 0);
        out.registeredOwner.name3 = col('NAME3', 0);
        out.registeredOwner.address = col('ADDRESS', 0);
        out.registeredOwner.cis = col('CIS', 0);

        out.titleOwner.name = col('NAME', 1);
        out.titleOwner.name2 = col('NAME2', 1);
        out.titleOwner.name3 = col('NAME3', 1);
        out.titleOwner.address = col('ADDRESS', 1);
        out.titleOwner.cis = col('CIS', 1);

        out.query.queryFields = g('QUERY FIELDS');
        out.query.requestedBy = g('REQUESTED BY');
        out.query.operator = g('OPERATOR');
        out.query.requestDateTime = g('REQUEST DATE/TIME');
        out.query.responseDateTime = g('RESPONSE DATE/TIME');
        out.query.queriedOn = g('QUERY ON').replace(/\.\s*$/, '');

        // A plate that was only ever read out of the query header is still
        // the plate that was run, so it is better than nothing.
        if (!out.plate && out.query.queryFields) out.plate = _plate(out.query.queryFields);
        if (!out.plateState && out.plate) out.plateState = 'CO';

        if (out.vin && out.vin.length !== 17) {
            out.warnings.push('The VIN came back as ' + out.vin.length + ' characters instead of 17 — check it against the printout before relying on it.');
        }
        if (/[IOQ]/.test(out.vin)) {
            out.warnings.push('The VIN contains an I, O or Q, which a real VIN never does — it is probably a misread 1 or 0.');
        }
        if (out.registeredOwner.name && out.titleOwner.name &&
            out.registeredOwner.name !== out.titleOwner.name) {
            out.warnings.push('The vehicle is titled to someone other than the registered owner.');
        }
        if (!out.plate && !out.vin) {
            out.warnings.push('Neither a plate nor a VIN could be read from this page.');
        }

        return out;
    }

    // True when there is enough on the page to be worth offering to the
    // officer at all. A page that yielded only a county name is not.
    function hasVehicle(parsed) {
        if (!parsed) return false;
        return !!(parsed.vin || parsed.plate || parsed.make || parsed.model);
    }

    return {
        detect: detect,
        parse: parse,
        hasVehicle: hasVehicle,
        scanPairs: scanPairs,
        LABELS: LABELS,
        COLOR_CODES: COLOR_CODES
    };
}));

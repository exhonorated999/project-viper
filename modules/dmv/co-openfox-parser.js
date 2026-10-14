/*
 * co-openfox-parser.js — read a Colorado driver record returned through an
 * Open Fox terminal (a "QW" name/date-of-birth query answered by the
 * Colorado Department of Revenue) into the same person shape every other
 * DMV printout produces.
 *
 * WHY THIS EXISTS
 * ---------------
 * VIPER already read one Colorado driver printout — the DOR export with
 * "OLN: 123456789 (CO)" and "CO__LICENSE_CATEGORY". Westminster PD runs
 * Colorado through Open Fox instead, and that page is laid out so
 * differently that the general-purpose reader gets it wrong in the worst
 * way: it matches "Driver License" in the page heading and fills the
 * license number with the rest of that heading and a disclaimer line. The
 * dates are bare runs of eight digits and the height is 5' 09", neither of
 * which it reads at all, and it cannot tell the page is from Colorado.
 *
 * BUILT FROM A REDACTED SAMPLE
 * ----------------------------
 * This reader was written from a VIPER Scout submission (two one-page
 * returns), not from the real pages. Every value on those pages had been
 * replaced with a shape token before it left the officer's machine, and so
 * had a few of the LABELS — the eye and hair labels came through only as
 * "two capitalised words". Those are therefore matched loosely ("Eye…",
 * "Hair…"). Expect a correction pass once an officer imports a real page.
 *
 * THE LAYOUT
 * ----------
 *      Received Time:10:28:03 10-13-26 Source ORI:CODMV0000
 *      Summary:QW: NAM=FENWICK, MARGARET DOB=04171982     <- the QUERY
 *      *** criminal justice use-only disclaimer lines ***
 *      Colorado Driver's License
 *      Name and Mailing Address
 *      (a line holding a single space)
 *      MARGARET OLIVE FENWICK                              <- name
 *      1600 WOODSIDE LN APT 4                              <- street
 *      WESTMINSTER, CO 80031-1234                          <- city line
 *      Number
 *      (a line holding a single space)
 *      99-123-4567
 *      Sex
 *       ...one label, one spacer, one value, for every field...
 *      TypeStatusClass
 *      Regular Driver LicenseVALID                         <- run together
 *      MRI 1234567 IN: DOR 00412 AT 10:28 13OCT26
 *      OUT: W13W 4 AT 10:28 13OCT26
 *
 * THE ONE TRAP
 * ------------
 * The query line also carries "DOB=" — the date the officer TYPED, which
 * is not necessarily the date on the record that came back. Every field is
 * read only from a label that stands alone on its own line, never from the
 * query.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * The name is kept exactly as the state printed it, like every other DMV
 * reader in VIPER. Re-ordering or re-casing it guesses at where a surname
 * ends.
 *
 * Nothing here writes anything. The host shows the officer what was read
 * and asks before filling any field, and only ever fills a blank one.
 */
(function (root, factory) {
    'use strict';
    var api = factory();
    // Assign to BOTH. `module` exists in VIPER's renderer, so a single-branch
    // UMD would take the CommonJS arm and leave the global undefined.
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root) root.CoOpenFoxParser = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // label line (case-insensitive, whole line) -> field key
    var LABELS = [
        [/^(?:Number|DL\s*Number|License\s*Number|OLN)$/i, 'number'],
        [/^Sex$/i, 'sex'],
        [/^(?:DOB|Date\s+of\s+Birth)$/i, 'dob'],
        [/^Height$/i, 'height'],
        [/^Weight$/i, 'weight'],
        [/^(?:Expires|Expiration(?:\s+Date)?|Exp\s*Date)$/i, 'expires'],
        [/^(?:Issued|Issue\s+Date)$/i, 'issued'],
        [/^Eyes?(?:\s+Colou?r)?$/i, 'eyes'],
        [/^Hair(?:\s+Colou?r)?$/i, 'hair'],
        [/^SSN$/i, 'ssn'],
        [/^Disab(?:led|ility)?$/i, 'disab'],
        [/^Donor$/i, 'donor'],
        [/^Restr(?:iction)?s?$/i, 'restrictions'],
        [/^Endorse(?:ment)?s?$/i, 'endorsements']
    ];

    var TYPE_STATUS_RE = /^Type\s*Status\s*Class$/i;

    // Status words seen on Colorado license returns. Matched in CAPITALS only
    // so the "License" in the type name can never be read as part of one.
    // Longer phrases come first so "NOT VALID" is not read as "VALID".
    var STATUS_RE = /^(.*?)\s*(NOT VALID|INVALID|VALID|EXPIRED|SUSPENDED|REVOKED|CANCELLED|CANCELED|DENIED|SURRENDERED|RESTRAINED|DENIAL|CANCEL)\s*([A-Z0-9]{0,4})$/;

    var CITY_LINE_RE = /^(.+?),?\s+([A-Z]{2})\s+(\d{5}(?:-?\d{4})?)$/;

    var COLOR_CODES = {
        BLK: 'Black', BRO: 'Brown', BRN: 'Brown', BLN: 'Blonde', BLD: 'Blonde',
        RED: 'Red', GRY: 'Gray', GRA: 'Gray', WHI: 'White', SDY: 'Sandy',
        BLU: 'Blue', GRN: 'Green', HAZ: 'Hazel', MAR: 'Maroon',
        PNK: 'Pink', MUL: 'Multicolored', ONG: 'Orange', BAL: 'Bald',
        XXX: 'Unknown', UNK: 'Unknown'
    };
    var COLOR_WORDS = [
        'BLACK', 'BROWN', 'BLONDE', 'BLOND', 'RED', 'GRAY', 'GREY', 'WHITE',
        'SANDY', 'BLUE', 'GREEN', 'HAZEL', 'MAROON', 'PINK', 'ORANGE',
        'BALD', 'UNKNOWN'
    ];

    function _s(v) { return v == null ? '' : String(v); }
    function _trim(v) { return _s(v).replace(/\s+/g, ' ').trim(); }

    function _labelKey(line) {
        var t = _trim(line);
        if (!t) return null;
        for (var i = 0; i < LABELS.length; i++) {
            if (LABELS[i][0].test(t)) return LABELS[i][1];
        }
        return null;
    }

    // Labels on this page are written in Title case; values are capitals or
    // digits. So a short line of capitalised words with lower-case letters
    // and no digits is treated as a label even when this reader does not
    // know it — a label added to the page later can then never become the
    // value of the field above it.
    function _looksLikeLabel(line) {
        var t = _trim(line);
        return t.length <= 30 && /[a-z]/.test(t) && !/\d/.test(t)
            && /^[A-Z][A-Za-z']*(?:\s+[A-Za-z][A-Za-z']*){0,3}$/.test(t);
    }

    // The machine lines that close the response. Nothing below them is
    // record data.
    function _isTrailer(line) {
        var t = _trim(line);
        return /\bIN:\s*DOR\b/i.test(t) || /^OUT:\s/i.test(t);
    }

    function _isDisclaimer(line) { return /^\*{3}/.test(_trim(line)); }

    function normalizeColor(raw) {
        var v = _trim(raw).toUpperCase();
        if (!v) return '';
        if (Object.prototype.hasOwnProperty.call(COLOR_CODES, v)) return COLOR_CODES[v];
        if (COLOR_WORDS.indexOf(v) >= 0) return v.charAt(0) + v.slice(1).toLowerCase();
        return _trim(raw);
    }

    function _iso(y, mo, da) {
        var Y = parseInt(y, 10), M = parseInt(mo, 10), D = parseInt(da, 10);
        if (!(Y >= 1900 && Y <= 2100)) return '';
        if (!(M >= 1 && M <= 12)) return '';
        if (!(D >= 1 && D <= 31)) return '';
        return Y + '-' + (M < 10 ? '0' + M : String(M)) + '-' + (D < 10 ? '0' + D : String(D));
    }

    /*
     * Dates print as eight bare digits. Month-first is the Colorado habit,
     * but the order is worked out rather than assumed: a month can never be
     * over 12 and a year is never in the 01xx–12xx range, so the two
     * readings can never both be valid for the same digits. A two-digit year
     * is refused — a birth date guessed into the wrong century is worse
     * than a blank one.
     */
    function parseDate(raw) {
        var v = _trim(raw);
        if (!v) return '';
        var m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (m) return _iso(m[1], m[2], m[3]);
        m = v.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
        if (m) return _iso(m[3], m[1], m[2]);
        m = v.match(/^(\d{8})$/);
        if (m) {
            var d = m[1];
            var tail = parseInt(d.slice(4, 8), 10);
            if (tail >= 1900 && tail <= 2100) {
                var a = _iso(d.slice(4, 8), d.slice(0, 2), d.slice(2, 4));
                if (a) return a;
            }
            var lead = parseInt(d.slice(0, 4), 10);
            if (lead >= 1900 && lead <= 2100) return _iso(d.slice(0, 4), d.slice(4, 6), d.slice(6, 8));
        }
        return '';
    }

    // 5' 09"  ->  "69". Also accepts 5'09, 5-09 and the run-together 509.
    // A value whose inches are not a real number of inches is refused.
    function parseHeight(raw) {
        var v = _trim(raw);
        var m = v.match(/^(\d)\s*['\u2019\u2032\-]\s*(\d{1,2})\s*(?:["\u201D\u2033]|'')?$/);
        if (!m) m = v.match(/^(\d)(\d{2})$/);
        if (!m) return '';
        var ft = parseInt(m[1], 10), inch = parseInt(m[2], 10);
        if (ft >= 1 && ft <= 8 && inch <= 11) return String(ft * 12 + inch);
        return '';
    }

    // "180 lbs" -> "180"
    function parseWeight(raw) {
        var m = _trim(raw).match(/^(\d{2,3})\s*(?:lbs?\.?|#)?$/i);
        return m ? m[1] : '';
    }

    function parseSsn(raw) {
        var v = _trim(raw);
        return /^\d{3}[- ]?\d{2}[- ]?\d{4}$/.test(v) ? v : '';
    }

    /*
     * "Regular Driver LicenseVALID" -> type "Regular Driver License",
     * status "VALID". A class code, when one prints, follows the status.
     */
    function parseTypeStatus(raw) {
        var v = _trim(raw);
        var out = { type: '', status: '', cls: '' };
        if (!v) return out;
        var m = v.match(STATUS_RE);
        if (m) {
            out.type = _trim(m[1]);
            out.status = m[2];
            out.cls = m[3] || '';
        } else {
            out.type = v;
        }
        return out;
    }

    /*
     * Is this a Colorado driver record returned through Open Fox?
     *
     * Two things must both be true: the response came from the Colorado DOR
     * through the message switch, AND it is a DRIVER record. The second
     * check keeps a vehicle or wanted-person response that came through the
     * same terminal from being read as a license.
     */
    function detect(text) {
        var t = _s(text);
        if (!t) return false;
        var fromDor = /Source\s*ORI\s*:\s*CODMV/i.test(t)
            || /\bIN:\s*DOR\b/i.test(t)
            || /ONLY\s+COLORADO\s+\S+\s+FILES/i.test(t);
        if (!fromDor) return false;
        var lines = t.split(/\r?\n/);
        var hasTypeStatus = false, hasNumber = false, hasDob = false;
        for (var i = 0; i < lines.length; i++) {
            var tl = _trim(lines[i]);
            if (TYPE_STATUS_RE.test(tl)) hasTypeStatus = true;
            var k = _labelKey(tl);
            if (k === 'number') hasNumber = true;
            if (k === 'dob') hasDob = true;
        }
        return hasTypeStatus || (hasNumber && hasDob);
    }

    /*
     * Walk the page and collect label -> value. The value is the next line
     * with something on it — the single-space spacer is skipped — unless
     * that line is itself a label, in which case the field was blank.
     */
    function readFields(text) {
        var lines = _s(text).split(/\r?\n/);
        var fields = {};
        for (var i = 0; i < lines.length; i++) {
            if (_isTrailer(lines[i])) break;
            var key = _labelKey(lines[i]);
            if (!key) continue;
            var val = '';
            for (var k = i + 1; k < lines.length; k++) {
                var cand = _trim(lines[k]);
                if (!cand) continue;
                if (_labelKey(cand) || _looksLikeLabel(cand) || TYPE_STATUS_RE.test(cand) || _isTrailer(cand)) break;
                val = cand;
                break;
            }
            if (val && !fields[key]) fields[key] = val;
        }
        // The license type/status line follows the "TypeStatusClass" header.
        for (var j = 0; j < lines.length; j++) {
            if (!TYPE_STATUS_RE.test(_trim(lines[j]))) continue;
            for (var n = j + 1; n < lines.length; n++) {
                var c = _trim(lines[n]);
                if (!c) continue;
                if (!_isTrailer(c)) fields.typeStatus = c;
                break;
            }
            break;
        }
        return fields;
    }

    /*
     * The name-and-address block: the lines between the "Name and …"
     * header and the first field label. The first is the name, the city
     * line is the one ending in a state and ZIP, and anything between them
     * is the street (a second street line is kept, joined with a comma).
     *
     * If the header is missing, the block is taken as the lines directly
     * above the first label, back to the nearest heading or disclaimer.
     */
    function readNameBlock(text) {
        var lines = _s(text).split(/\r?\n/);
        var firstLabel = -1, header = -1;
        for (var i = 0; i < lines.length; i++) {
            if (_isTrailer(lines[i])) break;
            if (header < 0 && /^Name\s+and\b/i.test(_trim(lines[i]))) header = i;
            if (_labelKey(lines[i])) { firstLabel = i; break; }
        }
        if (firstLabel < 0) return { name: '', address: '', addressCityStateZip: '' };

        var block = [];
        if (header >= 0) {
            for (var a = header + 1; a < firstLabel; a++) {
                var t = _trim(lines[a]);
                if (t && !_isDisclaimer(t)) block.push(t);
            }
        } else {
            for (var b = firstLabel - 1; b >= 0; b--) {
                var u = _trim(lines[b]);
                if (!u) continue;
                if (_isDisclaimer(u) || /License$/i.test(u) || /:/.test(u)) break;
                block.unshift(u);
                if (block.length >= 4) break;
            }
        }

        var out = { name: '', address: '', addressCityStateZip: '' };
        if (!block.length) return out;
        var cityIdx = -1;
        for (var c = block.length - 1; c >= 1; c--) {
            if (CITY_LINE_RE.test(block[c])) { cityIdx = c; break; }
        }
        out.name = block[0];
        if (cityIdx >= 0) {
            out.address = block.slice(1, cityIdx).join(', ');
            out.addressCityStateZip = block[cityIdx];
        } else {
            out.address = block.slice(1).join(', ');
        }
        return out;
    }

    /*
     * Parse into the person shape the DMV importers already use. Every key
     * is present; a field that was not on the page comes back as ''.
     *
     * `dlClass` is 'ID' when the record is an identification card, so the
     * host can say on the import preview that the number is an ID number.
     */
    function parse(text) {
        var f = readFields(text);
        var nb = readNameBlock(text);
        var ts = parseTypeStatus(f.typeStatus);
        var sex = _trim(f.sex).toUpperCase();
        var number = _trim(f.number).replace(/\s+/g, '');
        var isId = /identification|\bID\b/i.test(ts.type);

        return {
            format: 'co-openfox',
            name: nb.name,
            dob: parseDate(f.dob),
            dlNumber: number,
            // Open Fox answers this query only from Colorado's own files —
            // the page says so in its disclaimer.
            dlState: number ? 'CO' : '',
            dlClass: isId ? 'ID' : ts.cls,
            dlType: ts.type,
            dlStatus: ts.status,
            dlExpires: parseDate(f.expires),
            dlIssued: parseDate(f.issued),
            sex: /^[MFX]$/.test(sex) ? sex : _trim(f.sex),
            race: '',
            height: parseHeight(f.height),
            weight: parseWeight(f.weight),
            hairColor: normalizeColor(f.hair),
            eyeColor: normalizeColor(f.eyes),
            address: nb.address,
            addressCityStateZip: nb.addressCityStateZip,
            ssn: parseSsn(f.ssn),
            donor: _trim(f.donor).toUpperCase(),
            disability: _trim(f.disab).toUpperCase(),
            restrictions: _trim(f.restrictions),
            endorsements: _trim(f.endorsements)
        };
    }

    return {
        detect: detect,
        parse: parse,
        readFields: readFields,
        readNameBlock: readNameBlock,
        parseDate: parseDate,
        parseHeight: parseHeight,
        parseWeight: parseWeight,
        parseTypeStatus: parseTypeStatus,
        normalizeColor: normalizeColor
    };
}));

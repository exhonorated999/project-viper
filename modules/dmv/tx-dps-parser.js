/*
 * tx-dps-parser.js — read a Texas DPS "Driver License Image Manager"
 * printout (the page an officer prints out of TLETS) into the same person
 * shape every other DMV printout produces.
 *
 * WHY THIS EXISTS
 * ---------------
 * VIPER already imports Colorado DOR and California CAL-PHOTO printouts.
 * Fort Worth PD runs Texas, and the Texas page is laid out differently
 * enough that the general-purpose reader got it wrong in a way that was
 * worse than getting nothing: it read the word "Number" as the license
 * number and swallowed three lines of the page into the name field.
 *
 * THE LAYOUT
 * ----------
 * The page is printed to PDF out of Chrome, so the text comes out clean.
 * Almost every field is VERTICAL — the label sits on its own line and the
 * value is on the line below it:
 *
 *      DL Number:
 *      12345678
 *
 *      Name:
 *      YASMINE MEADOW SALACH
 *
 * but at least one field (Expiration Date) is printed INLINE on a single
 * line, so the reader has to accept both. Several fields are routinely
 * blank (Photo, Restriction, Endorsement), and a blank field is followed
 * immediately by the NEXT label — so "the line after the label" is only
 * the value when that line is not itself a label.
 *
 * Below the record the page carries a block of boilerplate (the state
 * use-only warning, a support link, a version number, the print timestamp
 * and the site URL). That block is cut off before the record is read, so a
 * trailing blank field cannot pick up a sentence of footer text as its
 * value.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * The name is kept exactly as the state printed it. Title-casing it would
 * turn MCDONALD into "Mcdonald" and O'BRIEN into "O'brien", and a name
 * that does not match the state record is worse than a shouty one.
 *
 * Nothing here is written anywhere on its own — the host still shows the
 * officer everything that was read and asks before filling any field, and
 * it only ever fills a field that was blank.
 */
(function (root, factory) {
    'use strict';
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.TxDpsParser = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // Every label the printout is known to carry, in the order it prints.
    // The reader uses this list for two things: to find a label line, and
    // to recognise that the line AFTER a label is another label (which
    // means the first field was left blank).
    var LABELS = [
        'DL Number', 'Name', 'Date of Birth', 'Photo', 'Address',
        'Race', 'Ethnicity', 'Sex', 'Height', 'Weight',
        'Eye Color', 'Hair Color', 'Image Date', 'Class',
        'Expiration Date', 'Restriction', 'CDL Flag', 'Endorsement'
    ];

    // The boilerplate under the record. Reading stops at the first of these
    // so a blank trailing field cannot adopt a sentence as its value.
    var FOOTER_MARKERS = [
        /^OFFICIAL\s+STATE\s+GOVERNMENT\s+USE\s+ONLY/i,
        /^Violations\s+subject\s+to\s+civil/i,
        /^Get\s+technical\s+support/i,
        /^Version\s*:\s*\d/i,
        /^https?:\/\//i,
        /\bTXDPS\b/i,
        /texasonline\.state\.tx\.us/i
    ];

    // Colours on this printout are spelled out in full (HAZEL, BROWN)
    // rather than given as the three-letter codes other states use. Both
    // are accepted; anything unrecognised is passed through untouched
    // rather than guessed at.
    var COLOR_WORDS = [
        'BLACK', 'BROWN', 'BLONDE', 'BLOND', 'RED', 'GRAY', 'GREY', 'WHITE',
        'SANDY', 'BLUE', 'GREEN', 'HAZEL', 'MAROON', 'PINK', 'ORANGE',
        'BALD', 'UNKNOWN'
    ];
    var COLOR_CODES = {
        BLK: 'Black', BRO: 'Brown', BRN: 'Brown', BLN: 'Blonde', BLD: 'Blonde',
        RED: 'Red', GRY: 'Gray', GRA: 'Gray', WHI: 'White', SDY: 'Sandy',
        BLU: 'Blue', GRN: 'Green', HAZ: 'Hazel', MAR: 'Maroon',
        PNK: 'Pink', MUL: 'Multicolored', ONG: 'Orange',
        XXX: 'Unknown', UNK: 'Unknown'
    };

    function _s(v) { return v == null ? '' : String(v); }
    function _trim(v) { return _s(v).replace(/\s+/g, ' ').trim(); }

    // "HAZEL" -> "Hazel". Leaves anything it does not recognise alone, so an
    // unexpected value still reaches the officer verbatim.
    function normalizeColor(raw) {
        var v = _trim(raw).toUpperCase();
        if (!v) return '';
        if (COLOR_WORDS.indexOf(v) >= 0) return v.charAt(0) + v.slice(1).toLowerCase();
        if (Object.prototype.hasOwnProperty.call(COLOR_CODES, v)) return COLOR_CODES[v];
        return _trim(raw);
    }

    /*
     * Dates on this printout are printed as a bare run of digits with no
     * separators, which means the order has to be worked out rather than
     * assumed. A month can never be greater than 12 and a year on a driver
     * record is never in the 01xx-12xx range, so the two readings can never
     * both be valid for the same eight digits:
     *
     *      19900102 -> 1990-01-02   (a 19th month is impossible)
     *      12311999 -> 1999-12-31   (the year 1231 is impossible)
     *
     * Printouts that DO use separators (other TLETS pages, and anything the
     * state changes later) are read as well, so the reader does not break
     * the first time a slash shows up.
     *
     * Returns 'YYYY-MM-DD' or '' — never a half-read date.
     */
    function parseDate(raw) {
        var v = _trim(raw);
        if (!v) return '';

        var m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (m) return _iso(m[1], m[2], m[3]);

        m = v.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
        if (m) return _iso(m[3], m[1], m[2]);

        m = v.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2})$/);
        if (m) {
            var yy = parseInt(m[3], 10);
            return _iso(String(yy > 25 ? 1900 + yy : 2000 + yy), m[1], m[2]);
        }

        m = v.match(/^(\d{8})$/);
        if (m) {
            var d = m[1];
            var lead = parseInt(d.slice(0, 4), 10);
            if (lead >= 1900 && lead <= 2100) return _iso(d.slice(0, 4), d.slice(4, 6), d.slice(6, 8));
            var tail = parseInt(d.slice(4, 8), 10);
            if (tail >= 1900 && tail <= 2100) return _iso(d.slice(4, 8), d.slice(0, 2), d.slice(2, 4));
        }
        return '';
    }

    // Build an ISO date only if the parts actually describe a calendar day.
    function _iso(y, mo, da) {
        var Y = parseInt(y, 10), M = parseInt(mo, 10), D = parseInt(da, 10);
        if (!(Y >= 1900 && Y <= 2100)) return '';
        if (!(M >= 1 && M <= 12)) return '';
        if (!(D >= 1 && D <= 31)) return '';
        return Y + '-' + (M < 10 ? '0' + M : String(M)) + '-' + (D < 10 ? '0' + D : String(D));
    }

    /*
     * Texas prints height as feet-and-inches run together: 500 is 5'00",
     * 511 is 5'11". Returned as total inches, which is what the person
     * record stores and what the form asks for.
     *
     * A value whose last two digits are not a real number of inches is
     * rejected rather than silently turned into a wrong height.
     */
    function parseHeight(raw) {
        var v = _trim(raw);
        var m = v.match(/^(\d)(\d{2})$/);
        if (m) {
            var ft = parseInt(m[1], 10), inch = parseInt(m[2], 10);
            if (ft >= 1 && ft <= 8 && inch <= 11) return String(ft * 12 + inch);
            return '';
        }
        m = v.match(/^(\d)\s*[''\-]\s*(\d{1,2})/);
        if (m) {
            var f2 = parseInt(m[1], 10), i2 = parseInt(m[2], 10);
            if (f2 >= 1 && f2 <= 8 && i2 <= 11) return String(f2 * 12 + i2);
        }
        return '';
    }

    // A line is a label line when it is one of the known labels followed by
    // a colon. Returns { label, inline } or null.
    function _labelOn(line) {
        var m = _s(line).match(/^([A-Za-z][A-Za-z ]{1,24}?)\s*:\s*(.*)$/);
        if (!m) return null;
        var want = _trim(m[1]).toLowerCase();
        for (var i = 0; i < LABELS.length; i++) {
            if (LABELS[i].toLowerCase() === want) return { label: LABELS[i], inline: _trim(m[2]) };
        }
        return null;
    }

    // Anything shaped like "Some Words:" is treated as a label for the
    // purpose of deciding whether the previous field was blank, even when
    // it is not a label this reader knows. That way a label added to the
    // form later cannot become the value of the field above it.
    function _looksLikeLabel(line) {
        return /^[A-Za-z][A-Za-z ]{1,24}\s*:\s*$/.test(_s(line).trim());
    }

    function _isFooter(line) {
        var t = _s(line).trim();
        for (var i = 0; i < FOOTER_MARKERS.length; i++) {
            if (FOOTER_MARKERS[i].test(t)) return true;
        }
        return false;
    }

    /*
     * Is this a Texas DPS Image Manager printout?
     *
     * The strong signal is the site the page came from, which is printed in
     * the footer by the browser. A page whose footer was cropped off is
     * still recognised from its own label set — "DL Number", "CDL Flag" and
     * "Endorsement" together do not appear on the Colorado or California
     * printouts.
     */
    function detect(text) {
        var t = _s(text);
        if (!t) return false;
        var site = /DPSImageManager/i.test(t)
            || /\bTXDPS\b/i.test(t)
            || /texasonline\.state\.tx\.us/i.test(t);
        var hasDl = /\bDL\s+Number\s*:/i.test(t);
        if (site && hasDl) return true;
        return hasDl && /\bCDL\s+Flag\s*:/i.test(t) && /\bEndorsement\s*:/i.test(t);
    }

    /*
     * Walk the page and collect label -> value.
     *
     * Blank lines are kept out of the way but not used as separators: the
     * printout puts a blank line between most fields and none between a few
     * of them, so the only reliable rule is "the value is the next line that
     * is not a label".
     */
    function readFields(text) {
        var raw = _s(text).split(/\r?\n/);

        // Chrome prints its own header and footer around the page, and the
        // extractor does not promise which end of the text they land on.
        // So the boilerplate cut only applies AFTER the record has started
        // — otherwise a title line carrying "TXDPS" at the top of the page
        // would throw the whole record away.
        var start = -1;
        for (var a = 0; a < raw.length; a++) {
            if (_labelOn(raw[a])) { start = a; break; }
        }
        if (start < 0) return {};

        var lines = [];
        for (var i = start; i < raw.length; i++) {
            if (_isFooter(raw[i])) break;            // record ends, boilerplate starts
            lines.push(raw[i].replace(/\s+$/, ''));
        }

        var fields = {};
        for (var j = 0; j < lines.length; j++) {
            var hit = _labelOn(lines[j]);
            if (!hit) continue;
            if (hit.inline) {                         // "Expiration Date: 01022030"
                if (!fields[hit.label]) fields[hit.label] = hit.inline;
                continue;
            }
            // Vertical: the value is the next non-empty line, unless that
            // line is itself a label — in which case this field is blank.
            var val = '';
            for (var k = j + 1; k < lines.length; k++) {
                var cand = lines[k].trim();
                if (!cand) continue;
                if (_labelOn(lines[k]) || _looksLikeLabel(lines[k])) break;
                val = _trim(cand);
                break;
            }
            if (val && !fields[hit.label]) fields[hit.label] = val;
        }
        return fields;
    }

    /*
     * Split "1600 WOODSIDE LN, CLEBURNE, TX 76033" into a street line and a
     * city/state/ZIP line, anchored on the segment that actually looks like
     * a state and ZIP. Anchoring on that rather than counting commas keeps
     * an apartment number ("..., Apt# 173, FORT WORTH, TX 76116") on the
     * street line where it belongs.
     */
    function splitAddress(raw) {
        var full = _trim(raw);
        var out = { address: '', addressCityStateZip: '' };
        if (!full) return out;
        var segs = full.split(',').map(function (x) { return _trim(x); })
            .filter(function (x) { return !!x; });
        var stIdx = -1;
        for (var i = 0; i < segs.length; i++) {
            if (/^[A-Z]{2}\s+\d{5}(?:-\d{4})?$/i.test(segs[i])) { stIdx = i; break; }
        }
        if (stIdx >= 2) {
            out.address = segs.slice(0, stIdx - 1).join(', ');
            out.addressCityStateZip = segs.slice(stIdx - 1).join(', ');
        } else if (stIdx === 1) {
            out.address = segs[0];
            out.addressCityStateZip = segs.slice(1).join(', ');
        } else if (segs.length >= 2) {
            out.address = segs[0];
            out.addressCityStateZip = segs.slice(1).join(', ');
        } else {
            out.address = full;
        }
        return out;
    }

    /*
     * Parse the printout into the person shape the DMV importers already
     * use. Every key is present; a field that was not on the page comes
     * back as '' rather than missing, so a caller can test it the same way
     * every time.
     *
     * `dlClass` is reported because a Texas record with class "ID" is a
     * state identification card, not a driver license — the host says so on
     * the import preview rather than letting the number look like a license
     * it is not.
     */
    function parse(text) {
        var f = readFields(text);
        var addr = splitAddress(f['Address']);
        var sex = _trim(f['Sex']).toUpperCase();

        return {
            name: _trim(f['Name']),
            dob: parseDate(f['Date of Birth']),
            dlNumber: _trim(f['DL Number']).replace(/\s+/g, ''),
            // The printout never names its own state; it does not have to.
            // It is only ever produced by Texas DPS.
            dlState: _trim(f['DL Number']) ? 'TX' : '',
            dlClass: _trim(f['Class']).toUpperCase(),
            dlExpires: parseDate(f['Expiration Date']),
            imageDate: parseDate(f['Image Date']),
            sex: /^[MF]$/.test(sex) ? sex : _trim(f['Sex']),
            race: _trim(f['Race']),
            ethnicity: _trim(f['Ethnicity']),
            height: parseHeight(f['Height']),
            weight: /^\d{2,3}$/.test(_trim(f['Weight'])) ? _trim(f['Weight']) : '',
            hairColor: normalizeColor(f['Hair Color']),
            eyeColor: normalizeColor(f['Eye Color']),
            address: addr.address,
            addressCityStateZip: addr.addressCityStateZip,
            restriction: _trim(f['Restriction']),
            cdlFlag: _trim(f['CDL Flag']),
            endorsement: _trim(f['Endorsement'])
        };
    }

    return {
        LABELS: LABELS,
        detect: detect,
        parse: parse,
        readFields: readFields,
        parseDate: parseDate,
        parseHeight: parseHeight,
        normalizeColor: normalizeColor,
        splitAddress: splitAddress
    };
}));

/* ============================================================
   FLOCK — LPR Search Result Parser  (VIPER)
   Pure parsing layer. NO DOM, NO localStorage, NO globals beyond
   the single export — so it can be unit-tested headlessly in Node.

   Input : the CSV a detective downloads from Flock Safety's
           "Search Results" screen.
   Output: normalized hit records with a single authoritative UTC
           instant per hit.

   Design notes
   ------------
   * Flock's `Capture Time` is LOCAL wall-clock plus a timezone
     ABBREVIATION ("22:44:26 PDT"). Abbreviations are ambiguous
     worldwide, so they are only used as a fallback.
   * The `Image File Name` embeds the true UTC instant with ms
     precision (..._2026-08-19T05:44:26.773Z.jpg). That is the
     authoritative timestamp whenever it is present, and it is what
     makes the movement playback trustworthy in court.
   * Vehicle attributes (Make/Body/Color) are Flock's CLASSIFIER
     output and are frequently inconsistent between hits on the same
     plate. We carry them through verbatim and let the UI flag the
     disagreement — we never "correct" them.
   ============================================================ */
(function (root, factory) {
    'use strict';
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.FlockParser = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // ── Timezone abbreviation → UTC offset in MINUTES ────────────────
    // Only used when Image File Name is absent/unparseable. North
    // American zones cover the Flock install base; UTC/GMT included for
    // agencies that export in Zulu.
    var TZ_OFFSETS = {
        UTC: 0, GMT: 0, Z: 0,
        EST: -300, EDT: -240,
        CST: -360, CDT: -300,
        MST: -420, MDT: -360,
        PST: -480, PDT: -420,
        AKST: -540, AKDT: -480,
        HST: -600, HDT: -540,
        AST: -240, ADT: -180,
        NST: -210, NDT: -150
    };

    // ── Column synonyms ──────────────────────────────────────────────
    // Flock has renamed columns between releases and some agencies
    // re-order or re-title them in Excel before handing the file over.
    // Match on a normalized (lowercase, alphanumeric-only) header.
    var COLUMN_SYNONYMS = {
        plate:      ['plate', 'licenseplate', 'platenumber', 'lp', 'tag'],
        state:      ['state', 'platestate', 'licensestate', 'region'],
        date:       ['capturedate', 'date', 'hitdate', 'observeddate'],
        time:       ['capturetime', 'time', 'hittime', 'observedtime'],
        make:       ['make', 'vehiclemake'],
        body:       ['body', 'bodytype', 'vehicletype', 'vehiclebody'],
        color:      ['color', 'colour', 'vehiclecolor'],
        identifiers:['identifiers', 'identifier', 'features', 'notes'],
        network:    ['capturenetwork', 'network', 'agency', 'owningagency', 'organization'],
        camera:     ['capturecamera', 'camera', 'cameraname', 'device', 'devicename'],
        lat:        ['capturelocationlatitude', 'latitude', 'lat', 'capturelatitude'],
        lng:        ['capturelocationlongitude', 'longitude', 'lon', 'lng', 'capturelongitude'],
        image:      ['imagefilename', 'image', 'imagename', 'filename', 'photo']
    };

    function normHeader(h) {
        return String(h == null ? '' : h).toLowerCase().replace(/[^a-z0-9]/g, '');
    }

    /**
     * RFC4180-ish CSV reader. Handles quoted fields, embedded commas,
     * embedded newlines, doubled quotes ("") and both CRLF and LF.
     * Flock camera names routinely contain commas and ampersands, so a
     * naive split(',') corrupts roughly every fourth row.
     */
    function parseCsv(text) {
        var rows = [];
        var row = [];
        var field = '';
        var inQuotes = false;
        var i = 0;
        var s = String(text == null ? '' : text);

        // Strip UTF-8 BOM — Excel round-trips leave it and it poisons the
        // first header ("\uFEFFPlate" would not match "plate").
        if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);

        while (i < s.length) {
            var c = s[i];
            if (inQuotes) {
                if (c === '"') {
                    if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
                    inQuotes = false; i++; continue;
                }
                field += c; i++; continue;
            }
            if (c === '"') { inQuotes = true; i++; continue; }
            if (c === ',') { row.push(field); field = ''; i++; continue; }
            if (c === '\r') {
                if (s[i + 1] === '\n') i++;
                row.push(field); field = ''; rows.push(row); row = []; i++; continue;
            }
            if (c === '\n') {
                row.push(field); field = ''; rows.push(row); row = []; i++; continue;
            }
            field += c; i++;
        }
        // Flush trailing field/row (file may not end with a newline).
        if (field.length || row.length) { row.push(field); rows.push(row); }

        // Drop rows that are entirely empty (trailing blank lines).
        return rows.filter(function (r) {
            return r.some(function (v) { return String(v).trim() !== ''; });
        });
    }

    /**
     * Map the header row to canonical field names.
     * Returns { plate: 0, state: 1, ... } with missing fields absent.
     */
    function mapColumns(header) {
        var idx = {};
        var normd = (header || []).map(normHeader);
        Object.keys(COLUMN_SYNONYMS).forEach(function (canon) {
            var syns = COLUMN_SYNONYMS[canon];
            for (var s = 0; s < syns.length; s++) {
                var at = normd.indexOf(syns[s]);
                if (at !== -1) { idx[canon] = at; return; }
            }
        });
        return idx;
    }

    // ── Timestamp resolution ─────────────────────────────────────────

    // Pull the ISO-8601 Zulu instant Flock embeds in the image filename.
    var ISO_IN_NAME = /(\d{4}-\d{2}-\d{2})[T_](\d{2})[:\-](\d{2})[:\-](\d{2})(?:\.(\d{1,3}))?Z/;

    function utcFromImageName(name) {
        if (!name) return null;
        var m = String(name).match(ISO_IN_NAME);
        if (!m) return null;
        var iso = m[1] + 'T' + m[2] + ':' + m[3] + ':' + m[4] + '.' + (m[5] ? (m[5] + '00').slice(0, 3) : '000') + 'Z';
        var ms = Date.parse(iso);
        return isFinite(ms) ? ms : null;
    }

    /**
     * Fallback: build a UTC instant from local date + time + TZ abbrev.
     * Returns { ms, tz, offsetMin, assumedLocal } or null.
     * `assumedLocal` flags that no recognizable zone was supplied, so the
     * value was interpreted in the VIEWER's timezone and must be treated
     * as approximate.
     */
    function utcFromDateTime(dateStr, timeStr) {
        var d = String(dateStr || '').trim();
        if (!d) return null;
        var dm = d.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/) ||
                 d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (!dm) return null;
        var Y, M, D;
        if (dm[0].indexOf('/') !== -1) { M = +dm[1]; D = +dm[2]; Y = +dm[3]; }
        else { Y = +dm[1]; M = +dm[2]; D = +dm[3]; }

        var t = String(timeStr || '').trim();
        var tm = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
        var hh = tm ? +tm[1] : 0, mi = tm ? +tm[2] : 0, ss = tm && tm[3] ? +tm[3] : 0;

        // 12-hour clock with AM/PM (some agencies re-save via Excel).
        var ampm = t.match(/\b(AM|PM)\b/i);
        if (ampm) {
            var pm = ampm[1].toUpperCase() === 'PM';
            if (pm && hh < 12) hh += 12;
            if (!pm && hh === 12) hh = 0;
        }

        var zoneTok = t.match(/\b([A-Z]{2,4})\b\s*$/);
        var tz = zoneTok ? zoneTok[1].toUpperCase() : '';
        if (tz === 'AM' || tz === 'PM') tz = '';

        var offsetMin = null;
        // Explicit numeric offset, e.g. "-07:00" / "+0530"
        var numOff = t.match(/([+\-])(\d{2}):?(\d{2})\s*$/);
        if (numOff) {
            offsetMin = (numOff[1] === '-' ? -1 : 1) * (+numOff[2] * 60 + +numOff[3]);
            tz = 'UTC' + numOff[1] + numOff[2] + ':' + numOff[3];
        } else if (tz && Object.prototype.hasOwnProperty.call(TZ_OFFSETS, tz)) {
            offsetMin = TZ_OFFSETS[tz];
        }

        if (offsetMin != null) {
            // Local wall-clock minus the zone offset gives the UTC instant.
            var ms = Date.UTC(Y, M - 1, D, hh, mi, ss) - offsetMin * 60000;
            return { ms: ms, tz: tz, offsetMin: offsetMin, assumedLocal: false };
        }
        // Unknown/absent zone: interpret in the viewer's local timezone and
        // say so, rather than silently pretending it is UTC.
        var local = new Date(Y, M - 1, D, hh, mi, ss);
        return { ms: local.getTime(), tz: tz || '', offsetMin: -local.getTimezoneOffset(), assumedLocal: true };
    }

    // ── Direction of travel ──────────────────────────────────────────
    // Flock camera names encode the lane bearing: "#100 - N Haven Ave @
    // HWY-10 - SB (Lanes 3&4)", "#37 - NB E Terminal Way", "14- EB Lake
    // Park @ Ramona Expy", "LR#122 W Florida Ave @ 4 Seasons Blvd EB".
    // Requiring two letters avoids matching the "N" in "N Haven Ave".
    var DIR_RE = /\b(NB|SB|EB|WB|NEB|NWB|SEB|SWB)\b/i;
    var DIR_LABEL = {
        NB: 'Northbound', SB: 'Southbound', EB: 'Eastbound', WB: 'Westbound',
        NEB: 'Northeastbound', NWB: 'Northwestbound',
        SEB: 'Southeastbound', SWB: 'Southwestbound'
    };
    function directionOf(camera) {
        var m = String(camera || '').match(DIR_RE);
        return m ? m[1].toUpperCase() : '';
    }

    // ── Value tidying ────────────────────────────────────────────────
    function tidy(v) { return String(v == null ? '' : v).trim(); }

    // "silver_grey" -> "silver/grey"; "unknown" -> "" so the UI can hide it.
    function tidyAttr(v) {
        var s = tidy(v).replace(/_/g, '/');
        if (/^unknown$/i.test(s) || s === '-') return '';
        return s;
    }

    function tidyPlate(v) {
        return tidy(v).toUpperCase().replace(/\s+/g, '');
    }

    function titleCaseState(v) {
        var s = tidy(v);
        if (!s || /^unknown$/i.test(s)) return '';
        if (s.length <= 3) return s.toUpperCase();
        return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
    }

    function num(v) {
        var s = tidy(v);
        if (!s) return null;
        var n = parseFloat(s);
        return isFinite(n) ? n : null;
    }

    /**
     * Parse a full Flock CSV export.
     *
     * @param {string} text  raw CSV
     * @param {object} opts  { idPrefix }
     * @returns {{
     *   ok: boolean, error?: string,
     *   columns: object, headers: string[],
     *   rowCount: number, hits: object[], warnings: string[],
     *   plates: string[], span: {startMs, endMs}|null, geoCount: number
     * }}
     */
    function parseFlockCsv(text, opts) {
        opts = opts || {};
        var prefix = opts.idPrefix || 'flk';
        var rows = parseCsv(text);
        var warnings = [];

        if (!rows.length) {
            return { ok: false, error: 'File is empty.', hits: [], warnings: warnings, columns: {}, headers: [], rowCount: 0, plates: [], span: null, geoCount: 0 };
        }

        var headers = rows[0].map(tidy);
        var cols = mapColumns(headers);

        // A Flock export is only meaningful if we can identify the plate.
        // Everything else can degrade gracefully.
        if (cols.plate == null) {
            return {
                ok: false,
                error: 'This does not look like a Flock export — no "Plate" column found. Columns seen: ' + headers.join(', '),
                hits: [], warnings: warnings, columns: cols, headers: headers,
                rowCount: rows.length - 1, plates: [], span: null, geoCount: 0
            };
        }
        if (cols.lat == null || cols.lng == null) {
            warnings.push('No latitude/longitude columns — map and playback will be unavailable.');
        }
        if (cols.date == null && cols.image == null) {
            warnings.push('No capture date or image filename — hits cannot be ordered in time.');
        }

        var hits = [];
        var plateSet = Object.create(null);
        var minMs = null, maxMs = null;
        var geoCount = 0;
        var noTimeCount = 0, assumedLocalCount = 0;

        function cell(r, key) {
            return cols[key] == null ? '' : tidy(r[cols[key]]);
        }

        for (var i = 1; i < rows.length; i++) {
            var r = rows[i];
            var plate = tidyPlate(cell(r, 'plate'));
            if (!plate) continue; // skip spacer / total rows

            var image = cell(r, 'image');
            var dateStr = cell(r, 'date');
            var timeStr = cell(r, 'time');

            // Authoritative UTC from the image filename; fall back to the
            // local date/time + zone abbreviation.
            var tUtcMs = utcFromImageName(image);
            var tzAbbr = '';
            var timeSource = 'image';
            var approxTime = false;

            if (tUtcMs == null) {
                var fb = utcFromDateTime(dateStr, timeStr);
                if (fb) {
                    tUtcMs = fb.ms;
                    tzAbbr = fb.tz;
                    timeSource = 'csv';
                    approxTime = fb.assumedLocal;
                    if (fb.assumedLocal) assumedLocalCount++;
                } else {
                    timeSource = 'none';
                    noTimeCount++;
                }
            } else {
                var zt = String(timeStr).match(/\b([A-Z]{2,4})\b\s*$/);
                if (zt) tzAbbr = zt[1].toUpperCase();
            }

            var lat = num(cell(r, 'lat'));
            var lng = num(cell(r, 'lng'));
            // Reject impossible coordinates and the 0,0 "null island" that
            // some exports emit for cameras with no survey fix.
            var hasGeo = lat != null && lng != null &&
                         Math.abs(lat) <= 90 && Math.abs(lng) <= 180 &&
                         !(lat === 0 && lng === 0);
            if (hasGeo) geoCount++;

            var camera = cell(r, 'camera');

            var hit = {
                id: prefix + '_' + i,
                row: i,
                plate: plate,
                state: titleCaseState(cell(r, 'state')),
                tUtcMs: tUtcMs,
                tzAbbr: tzAbbr,
                timeSource: timeSource,
                approxTime: approxTime,
                localDate: dateStr,
                localTime: timeStr,
                make: tidyAttr(cell(r, 'make')),
                body: tidyAttr(cell(r, 'body')),
                color: tidyAttr(cell(r, 'color')),
                identifiers: tidy(cell(r, 'identifiers')),
                network: tidy(cell(r, 'network')),
                camera: camera,
                dir: directionOf(camera),
                lat: hasGeo ? lat : null,
                lng: hasGeo ? lng : null,
                image: image
            };

            hits.push(hit);
            plateSet[plate] = (plateSet[plate] || 0) + 1;
            if (tUtcMs != null) {
                if (minMs == null || tUtcMs < minMs) minMs = tUtcMs;
                if (maxMs == null || tUtcMs > maxMs) maxMs = tUtcMs;
            }
        }

        if (!hits.length) {
            return {
                ok: false,
                error: 'No plate reads found in this file (' + (rows.length - 1) + ' data rows scanned).',
                hits: [], warnings: warnings, columns: cols, headers: headers,
                rowCount: rows.length - 1, plates: [], span: null, geoCount: 0
            };
        }

        // Chronological order is the module's contract — the card list, the
        // travel trace and the playback all assume it.
        hits.sort(function (a, b) {
            if (a.tUtcMs == null && b.tUtcMs == null) return a.row - b.row;
            if (a.tUtcMs == null) return 1;   // undated hits sink to the bottom
            if (b.tUtcMs == null) return -1;
            return a.tUtcMs - b.tUtcMs || a.row - b.row;
        });

        if (noTimeCount) warnings.push(noTimeCount + ' hit(s) had no readable timestamp and are listed last.');
        if (assumedLocalCount) warnings.push(assumedLocalCount + ' hit(s) had no timezone — interpreted in this machine\'s local time.');
        if (geoCount === 0 && (cols.lat != null)) warnings.push('No hit had usable coordinates — map disabled.');

        var plates = Object.keys(plateSet).sort(function (a, b) { return plateSet[b] - plateSet[a] || a.localeCompare(b); });

        return {
            ok: true,
            columns: cols,
            headers: headers,
            rowCount: rows.length - 1,
            hits: hits,
            warnings: warnings,
            plates: plates,
            plateCounts: plateSet,
            geoCount: geoCount,
            span: (minMs != null) ? { startMs: minMs, endMs: maxMs } : null
        };
    }

    // ── Geo helpers (shared by the trace + card list) ─────────────────

    // Great-circle distance in miles.
    function haversineMi(aLat, aLng, bLat, bLng) {
        if (aLat == null || bLat == null) return null;
        var R = 3958.7613;
        var toRad = Math.PI / 180;
        var dLat = (bLat - aLat) * toRad;
        var dLng = (bLng - aLng) * toRad;
        var s1 = Math.sin(dLat / 2), s2 = Math.sin(dLng / 2);
        var h = s1 * s1 + Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * s2 * s2;
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
    }

    /**
     * Leg statistics between consecutive hits of one plate. Implied speed
     * is the single most useful investigative signal in an LPR run: an
     * impossible mph means the plate was cloned, misread, or the two
     * cameras disagree on time.
     */
    function legStats(prev, hit) {
        if (!prev) return null;
        var out = { miles: null, seconds: null, mph: null, impossible: false };
        if (prev.lat != null && hit.lat != null) {
            out.miles = haversineMi(prev.lat, prev.lng, hit.lat, hit.lng);
        }
        if (prev.tUtcMs != null && hit.tUtcMs != null) {
            out.seconds = (hit.tUtcMs - prev.tUtcMs) / 1000;
        }
        if (out.miles != null && out.seconds != null && out.seconds > 0) {
            out.mph = out.miles / (out.seconds / 3600);
            // >100 mph sustained between two cameras warrants a hard look.
            out.impossible = out.mph > 100 && out.miles > 0.25;
        }
        return out;
    }

    return {
        TZ_OFFSETS: TZ_OFFSETS,
        COLUMN_SYNONYMS: COLUMN_SYNONYMS,
        parseCsv: parseCsv,
        mapColumns: mapColumns,
        normHeader: normHeader,
        utcFromImageName: utcFromImageName,
        utcFromDateTime: utcFromDateTime,
        directionOf: directionOf,
        DIR_LABEL: DIR_LABEL,
        parseFlockCsv: parseFlockCsv,
        haversineMi: haversineMi,
        legStats: legStats
    };
});

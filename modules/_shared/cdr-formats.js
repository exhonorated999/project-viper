/*
 * cdr-formats.js — carrier format support for the case CDR tab.
 *
 * The CDR tab was built on AT&T / Verizon CSVs.  This adds what a T-Mobile
 * return needs (and fixes what was wrong for every US carrier):
 *
 *   - header-row detection: carriers put title rows ("T-Mobile Tracking ID",
 *     target number, date range) above the column header;
 *   - sheet pick for .xlsx returns (subscriber sheet + CDR sheet);
 *   - T-Mobile / legacy-Sprint column pre-mapping (1st Tower LAT/LONG/Azimuth);
 *   - dates read MONTH first (US) unless the first part is > 12, times read as
 *     UTC when the carrier says so (T-Mobile spreadsheets are UTC), and an
 *     unreadable date is reported, never replaced with "now";
 *   - T-Mobile call-type codes (mSOriginating, …SMSinMSC, vONR_, iMS_, RCS…);
 *   - Verizon: the cell-site list that sits in the same sheet as the call
 *     records (above or below) is never taken for the call-record header,
 *     it ends the call table, and it is joined in (Cell Site Latitude /
 *     Longitude / Azimuth) so the records plot; VoLTE columns (Record Open
 *     Dt/Tm(GMT), CPN, Called #, DIR, SOU, ENB #) are pre-mapped.
 *
 * UMD: `module` is defined in the renderer too, so set both.
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CdrFormats = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
    'use strict';

    // Words that appear in CDR column headers (any carrier).  The second line
    // is Verizon's VoLTE CDR shorthand (Dt/Tm(GMT), ENB #, DIR, CPN, SOU…).
    var HEADER_WORDS = /\b(date|time|utc|duration|dur|call|type|number|no|calling|called|dialed|dialled|digits|direction|role|imei|imsi|msisdn|mdn|esn|meid|cell|tower|site|sector|lat|latitude|long|lon|longitude|azimuth|switch|neid|lac|cid|enodeb|source|conn|originating|terminating|destination|seconds|minutes|elapsed|feature|service|code|start|end|first|last|1st|from|to|gmt|dt|tm|enb|dir|cpn|sou|nid|face|seizure)\b/i;

    // Columns only a call-record table has — a cell-site list never does.
    var CALL_COL = /\b(date|time|timestamp|dt|tm|duration|dur|elapsed|seconds|sou|calling|called|dialed|dialled|msisdn|mdn|cpn|direction|dir|imei|imsi|originating|terminating)\b/i;

    function clean(v) { return v == null ? '' : String(v).trim(); }
    function cellsOf(row) { return Array.isArray(row) ? row.map(clean).filter(Boolean) : []; }

    /**
     * A cell-site (tower) list header: latitude + longitude (or azimuth +
     * site/sector/address) and no call-record column.  Verizon puts this list
     * in the same sheet as the call records; its header out-scores the
     * call-record header, so it must never be taken for it.
     */
    function isTowerListHeader(row) {
        var cells = cellsOf(row);
        if (cells.length < 3) return false;
        var lat = false, lon = false, az = false, place = false;
        for (var i = 0; i < cells.length; i++) {
            var l = cells[i].toLowerCase().replace(/time ?zone/g, '');
            if (cells[i].length > 48) return false;
            if (/^[-+\d.,:\/\s()]+$/.test(l)) return false;        // a data row
            if (CALL_COL.test(l)) return false;
            if (/\blat(itude)?\b/.test(l)) lat = true;
            else if (/\b(long(itude)?|lon|lng)\b/.test(l)) lon = true;
            if (/azimuth|\baz\b/.test(l)) az = true;
            if (/address|\bcity\b|\bzip\b|\bsite\b|\bsector\b|enodeb|\bcell\b/.test(l)) place = true;
        }
        return (lat && lon) || (az && place);
    }

    /** How much a row looks like a CDR column header. */
    function headerScore(row) {
        if (!Array.isArray(row)) return 0;
        var filled = 0, hits = 0, numeric = 0;
        for (var i = 0; i < row.length; i++) {
            var c = clean(row[i]);
            if (!c) continue;
            filled++;
            if (c.length > 48) return 0;                       // prose / banner sentence
            if (/^[-+\d.,:\/\s()]+$/.test(c)) numeric++;       // a data value, not a label
            else if (HEADER_WORDS.test(c)) hits++;
        }
        if (filled < 3 || hits < 3) return 0;
        if (numeric > filled / 3) return 0;
        return hits * 10 + filled;
    }

    var DATE_LIKE = /^\d{4}[-\/.]\d{1,2}[-\/.]\d{1,2}\b|^\d{1,2}[-\/.]\d{1,2}[-\/.](\d{4}|\d{2})\b|^[45]\d{4}\.\d+$/;

    /**
     * A header whose words this file does not know: a row of short labels
     * (no numbers) right above a row that starts with dates.  Only used when
     * the sheet's sole scoring header is a cell-site list.
     */
    function guessCallHeader(rows, skipFrom, skipTo) {
        for (var i = 0; i < rows.length - 1; i++) {
            if (i >= skipFrom && i < skipTo) continue;
            var cells = cellsOf(rows[i]);
            if (cells.length < 3 || isTowerListHeader(rows[i])) continue;
            var labels = cells.every(function (c) { return c.length <= 48 && !/^[-+\d.,:\/\s()]+$/.test(c); });
            if (!labels) continue;
            var next = cellsOf(rows[i + 1]);
            if (next.some(function (c) { return DATE_LIKE.test(c); })) return i;
        }
        return -1;
    }

    /**
     * Index of the call-record header row, or -1.  Looks in the first `scan`
     * rows (60).  A cell-site list header is only returned when no
     * call-record header exists; when the list comes first, the rows after
     * it are searched too.
     */
    function findHeaderRow(rows, scan) {
        rows = rows || [];
        var n = Math.min(rows.length, scan || 60);
        var call = -1, callScore = 0, any = -1, anyScore = 0, tower = -1;
        function look(i, callOnly) {
            var s = headerScore(rows[i]);
            var isTower = isTowerListHeader(rows[i]);
            if (isTower && tower < 0) tower = i;
            if (!s) return;
            if (!callOnly && s > anyScore) { any = i; anyScore = s; }
            if (!isTower && s > callScore) { call = i; callScore = s; }
        }
        for (var i = 0; i < n; i++) look(i);
        if (call < 0 && tower >= 0 && !scan) {
            for (var j = n; j < rows.length; j++) look(j, true);
            if (call < 0) {
                var g = guessCallHeader(rows, tower, tableEnd(rows, tower));
                if (g >= 0) call = g;
            }
        }
        return call >= 0 ? call : any;
    }

    /**
     * Index just past the table whose header is rows[headerRow]: a call
     * table ends where a cell-site list header starts and vice versa.  A
     * section title ("Cell Sites") just above the next table is not data.
     */
    function tableEnd(rows, headerRow) {
        var tower = isTowerListHeader(rows[headerRow]);
        for (var r = headerRow + 1; r < rows.length; r++) {
            var row = rows[r];
            if (!row || !row.length) continue;
            var isT = isTowerListHeader(row);
            var other = tower ? (!isT && headerScore(row) > 0) : isT;
            if (other) {
                var end = r;
                while (end > headerRow + 1 && cellsOf(rows[end - 1]).length <= 1) end--;
                return end;
            }
        }
        return rows.length;
    }

    /** Pick the sheet holding the call records: call header first, then most rows. */
    function pickSheet(sheets) {
        var best = null;
        (sheets || []).forEach(function (sh, idx) {
            var rows = sh && sh.rows || [];
            var h = findHeaderRow(rows);
            if (h < 0) return;
            var score = headerScore(rows[h]);
            var towerList = isTowerListHeader(rows[h]);
            var dataRows = tableEnd(rows, h) - h - 1;
            var cand = { index: idx, name: sh.name, rows: rows, headerRow: h, score: score, dataRows: dataRows, towerList: towerList };
            if (!best || (best.towerList && !towerList) ||
                (best.towerList === towerList && (dataRows > best.dataRows || (dataRows === best.dataRows && score > best.score)))) best = cand;
        });
        return best;
    }

    /** Unique, non-empty header names (Papa-style objects need unique keys). */
    function uniqueHeaders(row) {
        var seen = Object.create(null);
        return (row || []).map(function (h, i) {
            var name = clean(h) || ('Column ' + (i + 1));
            var base = name, k = 2;
            while (seen[name]) name = base + ' (' + (k++) + ')';
            seen[name] = true;
            return name;
        });
    }

    /**
     * rows[] (arrays) → { headers, records[] objects } for the table under
     * the header row (up to the next table; repeated header rows skipped).
     */
    function rowsToRecords(rows, headerRow) {
        var headers = uniqueHeaders(rows[headerRow]);
        var headKey = cellsOf(rows[headerRow]).join('\u0001').toLowerCase();
        var end = tableEnd(rows, headerRow);
        var records = [];
        for (var r = headerRow + 1; r < end; r++) {
            var row = rows[r] || [];
            var any = false, o = {};
            for (var c = 0; c < headers.length; c++) {
                var v = row[c] == null ? '' : row[c];
                if (clean(v) !== '') any = true;
                o[headers[c]] = v;
            }
            if (any && cellsOf(row).join('\u0001').toLowerCase() === headKey) continue;   // page-break repeat
            if (any) records.push(o);
        }
        return { headers: headers, records: records };
    }

    /** Carrier from the header row and the banner rows above it. */
    function detectCarrier(rows, headerRow, fileName) {
        var head = (rows[headerRow] || []).map(clean).join('|').toLowerCase();
        var banner = '';
        for (var i = 0; i < Math.max(0, headerRow); i++) banner += (rows[i] || []).map(clean).join(' ') + '\n';
        banner = (banner + ' ' + (fileName || '')).toLowerCase();
        if (/t-mobile|tmobile|t mobile|metropcs|metro by t/.test(banner)) return 'T-Mobile';
        if (/1st tower (lat|long|azimuth)|\(utc\) ?time|dialed digits/.test(head) && /calling (number|no)/.test(head)) return 'T-Mobile';
        if (/mobile role/.test(head) && /neid|first cell/.test(head)) return 'T-Mobile';   // legacy Sprint, now T-Mobile
        if (/source/.test(head) && /conn date/.test(head)) return 'AT&T';
        if (isVerizonHeader(rows[headerRow])) return 'Verizon';
        if (/at&t|att\b|cingular/.test(banner)) return 'AT&T';
        if (/verizon|vzw/.test(banner)) return 'Verizon';
        if (/us ?cellular|uscc/.test(banner)) return 'US Cellular';
        if (/sprint/.test(banner)) return 'T-Mobile';
        return '';
    }

    /**
     * T-Mobile column mapping (T-Mobile network report + legacy Sprint
     * "Key to Understanding" columns).  Returns only what it is sure of;
     * the caller layers this over the generic auto-detect.
     */
    function tmobileMapping(headers) {
        var low = headers.map(function (h) { return { h: h, l: clean(h).toLowerCase().replace(/\s+/g, ' ') }; });
        function find(tests) {
            for (var t = 0; t < tests.length; t++) {
                for (var i = 0; i < low.length; i++) {
                    var l = low[i].l, test = tests[t];
                    if (typeof test === 'string' ? l === test : test.test(l)) return low[i].h;
                }
            }
            return undefined;
        }
        var m = {};
        m.phoneA = find(['calling number', 'calling no', 'calling party', /^calling (number|no|party)\b/, /^calling\b/]);
        m.phoneB = find(['called number', 'called no', 'dialed digits', 'dialed number', 'destination number', /^called (number|no|party)\b/, /^dialed\b/, /^destination\b/]);
        var timeCol = find(['(utc) time', '(utc)time', 'utc time', 'time (utc)', 'time(utc)', 'time', 'call time', /\btime\b.*\butc\b|\butc\b.*\btime\b/]);
        var dateCol = find(['date', 'call date', 'date (utc)', '(utc) date', /^date\b/]);
        var startCol = find(['start date', 'start time', 'start date/time', 'start_datetime', 'start_time', 'start datetime']);
        if (dateCol) { m.date = dateCol; if (timeCol) m.time = timeCol; }
        else if (startCol) m.datetime = startCol;     // legacy Sprint: "Start Date" carries date AND time
        else if (timeCol) m.time = timeCol;
        m.callType = find(['call type', 'type of call', 'calltype', 'usage type', 'event type']);
        m.direction = find(['direction', 'mobile role', 'call direction', /\bdirection\b/]);
        m.duration = find(['duration', 'duration (sec)', 'duration (seconds)', 'duration(sec)', 'call duration', /^duration\b/]);
        m.imei = find(['imei', /\bimei\b/]);
        m.imsi = find(['imsi', /\bimsi\b/]);
        m.towerA = find(['1st cell', 'first cell', '1st cell id', '1st tower cell id', '1st tower cid', '1st tower', 'first tower', 'start_cell', 'start cell', /^1st (cell|tower)( id| cid)?$/, /^first (cell|tower)/]);
        m.towerB = find(['last cell', 'last cell id', 'last tower cell id', 'last tower cid', 'last tower', 'end_cell', 'end cell', /^last (cell|tower)( id| cid)?$/]);
        m.towerLat = find(['1st tower lat', '1st tower latitude', 'first tower lat', 'first tower latitude', 'start_latitude', /^1st tower lat/, /^first tower lat/]);
        m.towerLon = find(['1st tower long', '1st tower lon', '1st tower longitude', 'first tower long', 'first tower longitude', 'start_longitude', /^1st tower lon/, /^first tower lon/]);
        m.azimuth = find(['1st tower azimuth', 'first tower azimuth', '1st tower az', /^1st tower azi/, /^first tower azi/, 'azimuth']);
        m.beamwidth = find(['1st tower beamwidth', '1st tower beam width', /^1st tower beam/, 'beamwidth', 'beam width']);
        Object.keys(m).forEach(function (k) { if (!m[k]) delete m[k]; });
        return m;
    }

    // ── Verizon + cell-site lists ────────────────────────────────────
    /** find(tests, skip) → first header (in test order) that matches. */
    function finder(headers) {
        var low = (headers || []).map(function (h) { return { h: h, l: clean(h).toLowerCase().replace(/\s+/g, ' ') }; });
        return function find(tests, skip) {
            for (var t = 0; t < tests.length; t++) {
                for (var i = 0; i < low.length; i++) {
                    var l = low[i].l, test = tests[t];
                    if (!l || (skip && skip.test(l))) continue;
                    if (typeof test === 'string' ? l === test : test.test(l)) return low[i].h;
                }
            }
            return undefined;
        };
    }

    /** Verizon VoLTE CDR header (Record Open Date/Time, MSISDN, ENB #, CPN, SOU…). */
    function isVerizonHeader(row) {
        var head = cellsOf(row).join('|').toLowerCase();
        if (/record open (date|dt)/.test(head)) return true;
        return /\bmsisdn\b/.test(head) && /\benb\b|\bsou\b|\bcpn\b|cell face/.test(head);
    }

    /** Verizon's cell-site list (E-911 latitude, extended base ID, PN offset). */
    function isVerizonTowerList(headers) {
        var head = (headers || []).map(clean).join('|').toLowerCase();
        return /e-?911 lat/.test(head) || /extended base id/.test(head);
    }

    /**
     * Verizon CDR column mapping.  The GMT start column wins over the local
     * one (exact instant; the UTC box is ticked because a GMT column exists).
     * CPN = calling party, Called # = number dialed, DIR = MO/MT, SOU =
     * seconds of use.  Returns only what it is sure of.
     */
    function verizonMapping(headers) {
        var find = finder(headers);
        var GMT = /\b(gmt|utc)\b/;
        var m = {};
        var gmt = find([/^record open.*\b(gmt|utc)\b/, /^(seizure|start|connect|connection|call) .*\b(gmt|utc)\b/, /(date|dt).*\b(gmt|utc)\b/, /\b(gmt|utc)\b.*\b(date|dt)\b/]);
        var local = find([/^record open (date|dt)/, /^seizure (date|dt)/, /^(start|connect|connection|call) (date|dt) ?\/ ?(time|tm)/, 'date/time', /^date ?\/ ?time$/], GMT);
        m.datetime = gmt || local;
        m.phoneA = find(['cpn', 'calling #', 'calling number', 'calling party', 'calling party number', /^calling\b/, /^originating (number|#|party)/])
            || find(['msisdn', 'mdn', 'target', 'target number']);
        m.phoneB = find(['called #', 'called number', 'called party', 'called party number', 'dialed #', 'dialed digits', 'dialed number', /^called\b/, /^dialed\b/, /^terminating (number|#|party)/, /^destination\b/]);
        m.direction = find(['dir', 'dir.', 'direction', 'call direction', 'mo/mt', /\bdirection\b/]);
        m.duration = find(['sou', 'sou (sec)', 'sou (secs)', 'sou(sec)', /^sou\b/, /seconds of use/, /^duration\b/, /^call duration\b/, /^elapsed\b/]);
        Object.keys(m).forEach(function (k) { if (!m[k]) delete m[k]; });
        return m;
    }

    // Columns that identify a cell / carry its location — CDR and cell-site list alike.
    var SITE_COLS = {
        lat: [/\blat(itude)?\b/],
        lon: [/\b(long(itude)?|lon|lng)\b/],
        azimuth: [/azimuth/, /^az$/],
        beamwidth: [/beam ?width/, /\bh-?bw\b/, /^bw$/],
        ecgi: [/\becgi\b/],
        enodeb: [/enodeb|\benb\b|e-?node ?b/],
        cell: [/^cell ?(id|#|no\.?)?$/, /^lte cell id$/, /^cid$/, /^ci$/],
        site: [/^(cell )?site( number| no\.?| #| id)?$/, /\bsite (number|no|id)\b/],
        sector: [/^sector( id| number| no\.?| #)?$/, /cell face|^face$/, /\bsector\b/],
        address: [/street|address/], city: [/^city$/], state: [/^state$/], zip: [/^zip/]
    };
    function siteColumns(headers) {
        var find = finder(headers), out = {};
        Object.keys(SITE_COLS).forEach(function (k) { var h = find(SITE_COLS[k]); if (h) out[k] = h; });
        return out;
    }
    function normKey(v) {
        var s = clean(v).toLowerCase().replace(/\s+/g, '');
        if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, '');
        if (/^\d+$/.test(s)) s = s.replace(/^0+(?=\d)/, '');
        return s;
    }
    // CDR columns → cell-site list columns, most exact first.  The last two
    // only find the site (location, no sector azimuth).
    var JOIN_KEYS = [
        { cdr: ['ecgi'], list: ['ecgi'], sector: true },
        { cdr: ['enodeb', 'cell'], list: ['enodeb', 'cell'], sector: true },
        { cdr: ['enodeb', 'sector'], list: ['enodeb', 'sector'], sector: true },
        { cdr: ['cell', 'sector'], list: ['site', 'sector'], sector: true },
        { cdr: ['enodeb'], list: ['enodeb'], sector: false },
        { cdr: ['cell'], list: ['site'], sector: false },
    ];

    /**
     * Where is the cell-site list?  Same sheet first (above or below the call
     * records), then the other sheets.  → { rows, headerRow, name } or null.
     */
    function findTowerTable(rows, headerRow, sheets, sheetIndex) {
        function scan(rs, from, to) {
            for (var i = Math.max(0, from); i < to; i++) if (isTowerListHeader(rs[i])) return i;
            return -1;
        }
        if (isTowerListHeader(rows[headerRow])) return null;
        var h = scan(rows, 0, headerRow);
        if (h < 0) h = scan(rows, tableEnd(rows, headerRow), rows.length);
        if (h >= 0) return { rows: rows, headerRow: h, name: '' };
        var list = sheets || [];
        for (var s = 0; s < list.length; s++) {
            var rs = list[s] && list[s].rows;
            if (s === sheetIndex || !rs || rs === rows) continue;
            var t = scan(rs, 0, rs.length);
            if (t >= 0) return { rows: rs, headerRow: t, name: list[s].name || '' };
        }
        return null;
    }

    function uniqueName(headers, name) {
        var n = name, k = 2;
        while (headers.indexOf(n) >= 0) n = name + ' (' + (k++) + ')';
        return n;
    }

    /**
     * Look each call record's cell up in the cell-site list and add
     * "Cell Site Latitude / Longitude / Azimuth / Beam Width / Address"
     * columns (only when at least one record is found).
     */
    function joinTowers(conv, list) {
        var cc = siteColumns(conv.headers), tc = siteColumns(list.headers);
        var out = { sites: list.records.length, matched: 0, total: conv.records.length, columns: {} };
        if (!tc.lat || !tc.lon) return out;
        function keyOf(rec, cols, names) {
            var parts = names.map(function (k) { return normKey(rec[cols[k]]); });
            return parts.some(function (p) { return !p; }) ? '' : parts.join('|');
        }
        var keys = JOIN_KEYS.filter(function (j) {
            return j.cdr.every(function (k) { return cc[k]; }) && j.list.every(function (k) { return tc[k]; });
        }).map(function (j) {
            var idx = Object.create(null);
            list.records.forEach(function (t) {
                var k = keyOf(t, tc, j.list);
                if (k && !idx[k] && clean(t[tc.lat]) && clean(t[tc.lon])) idx[k] = t;
            });
            return { j: j, idx: idx };
        });
        if (!keys.length) return out;
        var hits = conv.records.map(function (rec) {
            for (var i = 0; i < keys.length; i++) {
                var k = keyOf(rec, cc, keys[i].j.cdr);
                if (k && keys[i].idx[k]) return { t: keys[i].idx[k], sector: keys[i].j.sector };
            }
            return null;
        });
        out.matched = hits.filter(Boolean).length;
        if (!out.matched) return out;
        var H = conv.headers, cols = out.columns;
        function add(field, name) { cols[field] = uniqueName(H, name); H.push(cols[field]); }
        add('towerLat', 'Cell Site Latitude');
        add('towerLon', 'Cell Site Longitude');
        if (tc.azimuth) add('azimuth', 'Cell Site Azimuth');
        if (tc.beamwidth) add('beamwidth', 'Cell Site Beam Width');
        var addrCol = (tc.address || tc.city) ? uniqueName(H, 'Cell Site Address') : '';
        if (addrCol) H.push(addrCol);
        conv.records.forEach(function (rec, i) {
            var h = hits[i], t = h && h.t;
            rec[cols.towerLat] = t ? clean(t[tc.lat]) : '';
            rec[cols.towerLon] = t ? clean(t[tc.lon]) : '';
            if (cols.azimuth) rec[cols.azimuth] = t && h.sector ? clean(t[tc.azimuth]) : '';
            if (cols.beamwidth) rec[cols.beamwidth] = t && h.sector ? clean(t[tc.beamwidth]) : '';
            if (addrCol) {
                rec[addrCol] = t ? [clean(t[tc.address]), clean(t[tc.city]), [clean(t[tc.state]), clean(t[tc.zip])].filter(Boolean).join(' ')]
                    .filter(Boolean).join(', ') : '';
            }
        });
        return out;
    }

    /**
     * Everything the CDR tab needs from one table: records (bounded to the
     * call table), carrier, the cell-site list joined in, and the carrier's
     * own column mapping (layered over the generic auto-detect).
     * opts: { fileName, sheetName, sheets (all workbook sheets), sheetIndex }.
     */
    function prepareCdr(rows, headerRow, opts) {
        opts = opts || {};
        var conv = rowsToRecords(rows, headerRow);
        var carrier = detectCarrier(rows, headerRow, [opts.fileName, opts.sheetName].filter(Boolean).join(' '));
        var towers = null;
        var tt = findTowerTable(rows, headerRow, opts.sheets, opts.sheetIndex);
        if (tt) {
            var list = rowsToRecords(tt.rows, tt.headerRow);
            if (!carrier && isVerizonTowerList(list.headers)) carrier = 'Verizon';
            towers = joinTowers(conv, list);
            towers.sheetName = tt.name;
        }
        var mapping = {};
        if (carrier === 'Verizon') {
            mapping = verizonMapping(conv.headers);
            // One ID per cell: a bare Cell ID repeats across eNodeBs.
            var cc = siteColumns(conv.headers);
            if (cc.ecgi) mapping.towerA = cc.ecgi;
            else if (cc.enodeb && (cc.cell || cc.sector)) {
                var second = cc.cell || cc.sector;
                var idCol = uniqueName(conv.headers, 'Cell Site ID');
                conv.headers.push(idCol);
                conv.records.forEach(function (r) {
                    var a = normKey(r[cc.enodeb]), b = normKey(r[second]);
                    r[idCol] = a && b ? a + '-' + b : (a || b);
                });
                mapping.towerA = idCol;
            }
        }
        if (towers && towers.matched) Object.keys(towers.columns).forEach(function (k) { mapping[k] = towers.columns[k]; });
        return { headers: conv.headers, records: conv.records, carrier: carrier, towers: towers, mapping: mapping };
    }

    // ── dates ────────────────────────────────────────────────────────
    function pad(n) { return (n < 10 ? '0' : '') + n; }

    function excelSerialParts(n) {
        var ms = Math.round((n - 25569) * 86400) * 1000;      // 1970-01-01 = serial 25569
        var d = new Date(ms);
        return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
    }

    /** "06/13/2025", "2025-06-13", "13-Jun-2025", Excel serial → {y,mo,d} or null. */
    function parseDatePart(s, opts) {
        s = clean(s);
        if (!s) return null;
        var m;
        if (/^\d+(\.\d+)?$/.test(s)) {
            var n = parseFloat(s);
            if (n > 20000 && n < 80000) return excelSerialParts(n);
            if (/^\d{8}$/.test(s)) return { y: +s.slice(0, 4), mo: +s.slice(4, 6), d: +s.slice(6, 8) };   // 20250613
            return null;
        }
        if ((m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/))) return { y: +m[1], mo: +m[2], d: +m[3] };
        if ((m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2}|\d{4})$/))) {
            var a = +m[1], b = +m[2], y = +m[3];
            if (m[3].length === 2) y += (y < 70 ? 2000 : 1900);
            var dayFirst = opts && opts.dayFirst;
            if (a > 12 && b <= 12) dayFirst = true;           // 13/06/2025 can only be day-first
            else if (b > 12 && a <= 12) dayFirst = false;
            return dayFirst ? { y: y, mo: b, d: a } : { y: y, mo: a, d: b };
        }
        var MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
        if ((m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3,4})[-\s,]*(\d{2}|\d{4})$/)) && MON[m[2].toLowerCase()]) {
            var yy = +m[3]; if (m[3].length === 2) yy += 2000;
            return { y: yy, mo: MON[m[2].toLowerCase()], d: +m[1] };
        }
        if ((m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/)) && MON[m[1].slice(0, 3).toLowerCase()]) {
            return { y: +m[3], mo: MON[m[1].slice(0, 3).toLowerCase()], d: +m[2] };
        }
        return null;
    }

    /** "14:03:22", "2:03:22 PM", "140322", Excel fraction → {h,mi,s} or null. */
    function parseTimePart(s) {
        s = clean(s);
        if (!s) return null;
        var m;
        if (/^0?\.\d+$|^0$/.test(s)) {
            var secs = Math.round(parseFloat(s) * 86400);
            return { h: Math.floor(secs / 3600) % 24, mi: Math.floor(secs / 60) % 60, s: secs % 60 };
        }
        if ((m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[.,]\d+)?\s*([AaPp])\.?[Mm]?\.?$/))) {
            var h = +m[1] % 12; if (/p/i.test(m[4])) h += 12;
            return { h: h, mi: +m[2], s: +(m[3] || 0) };
        }
        if ((m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[.,]\d+)?$/))) return { h: +m[1], mi: +m[2], s: +(m[3] || 0) };
        if ((m = s.match(/^(\d{2})(\d{2})(\d{2})$/))) return { h: +m[1], mi: +m[2], s: +m[3] };
        return null;
    }

    function valid(p, t) {
        return p && p.y >= 1980 && p.y <= 2100 && p.mo >= 1 && p.mo <= 12 && p.d >= 1 && p.d <= 31 &&
            (!t || (t.h >= 0 && t.h < 24 && t.mi >= 0 && t.mi < 60 && t.s >= 0 && t.s < 61));
    }

    function toIso(p, t, utc) {
        t = t || { h: 0, mi: 0, s: 0 };
        var d = utc ? new Date(Date.UTC(p.y, p.mo - 1, p.d, t.h, t.mi, t.s))
                    : new Date(p.y, p.mo - 1, p.d, t.h, t.mi, t.s);
        if (isNaN(d.getTime()) || d.getUTCDate() !== (utc ? p.d : d.getUTCDate())) return null;
        if (!utc && d.getDate() !== p.d) return null;          // 02/31 rolled into March
        return d.toISOString();
    }

    /**
     * Date + time (either may be combined in `dateStr`) → ISO string, or null
     * when it cannot be read.  opts: { utc, dayFirst }.
     */
    function parseDateTime(dateStr, timeStr, opts) {
        opts = opts || {};
        var ds = clean(dateStr), ts = clean(timeStr);
        if (!ds && !ts) return null;
        var p = null, t = null, m;
        // Full ISO with an explicit zone/offset: trust it.
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(ds)) {
            var z = new Date(ds);
            return isNaN(z.getTime()) ? null : z.toISOString();
        }
        // Excel serial carrying date + time.
        if (/^\d{5}\.\d+$/.test(ds) && !ts) {
            var sp = excelSerialParts(parseFloat(ds));
            p = sp; t = { h: sp.h, mi: sp.mi, s: sp.s };
        } else {
            // Split a combined "date time" value.
            var dPart = ds, tPart = ts;
            if ((m = ds.match(/^(.+?)[T\s]+(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?(?:\s*[AaPp]\.?[Mm]?\.?)?)(?:\s*(?:UTC|GMT|Z))?$/))) {
                dPart = m[1]; if (!tPart) tPart = m[2];
            }
            p = parseDatePart(dPart, opts);
            if (!p && !ds && ts) return null;                  // a time with no date is not a timestamp
            if (!p) return null;
            if (p.h != null && !tPart) t = { h: p.h, mi: p.mi, s: p.s };
            if (tPart) {
                t = parseTimePart(tPart);
                if (!t) return null;
            }
        }
        if (!valid(p, t)) return null;
        return toIso(p, t, !!opts.utc);
    }

    // ── call types ───────────────────────────────────────────────────
    function dirOf(raw) {
        var d = clean(raw).toLowerCase();
        if (!d) return '';
        if (/^(o|out|outgoing|mo|orig|originating|outbound|sent|from)$/.test(d) || /outgoing|originat|outbound/.test(d)) return 'outgoing';
        if (/^(i|in|incoming|mt|term|terminating|inbound|received|to)$/.test(d) || /incoming|terminat|inbound/.test(d)) return 'incoming';
        if (/forward|routed/.test(d)) return 'forwarded';
        return '';
    }

    /**
     * T-Mobile / Sprint call-type code (+ optional direction column) →
     * VIPER call type ('voice-outgoing', 'sms-incoming', …) or '' when it is
     * not a code this knows (caller falls back to its own table).
     */
    function callType(rawType, rawDirection) {
        var raw = clean(rawType);
        var t = raw.toLowerCase().replace(/[\s_\-–]+/g, '');
        var dir = dirOf(rawDirection);
        function withDir(kind, fallbackDir) {
            var d = dir || fallbackDir || '';
            return d ? kind + '-' + d : kind;
        }
        if (!t) return dir ? 'voice-' + dir : '';
        // SMS before voice: mSOriginatingSMSinMSC contains "originating".
        if (/smsinmsc$/.test(t)) return withDir('sms', /^msorig/.test(t) ? 'outgoing' : /^msterm/.test(t) ? 'incoming' : '');
        if (t === 'smsc' || t === 'sms' || t === 'text') return withDir('sms');
        if (t === 'mms') return withDir('sms');
        if (/^rcs/.test(t)) return withDir('sms');              // RCS chat / file share — a message, not a call
        if (t === 'callforwarding' || /forwarded$/.test(t)) return withDir('voice', 'forwarded');
        if (t === 'msoriginating' || t === 'moc' || t === 'imsoriginating' || t === 'vonroriginating' || t === 'moepsfb') return withDir('voice', 'outgoing');
        if (t === 'msterminating' || t === 'mtc' || t === 'imsterminating' || t === 'vonrterminating' || t === 'mtepsfb') return withDir('voice', 'incoming');
        if (/^(volte|vowifi|vovoice|vocdma|wifi|cdma|voice|airave|gsm|lte|5g|nr)$/.test(t)) return withDir('voice');
        if (/^(data|gprs|packet)$/.test(t)) return withDir('data');
        return '';
    }

    /** Duration → seconds: "83", "1.5" (minutes when asked), "00:01:23", "1:23". */
    function durationSeconds(v, isMinutes) {
        var s = clean(v);
        if (!s) return 0;
        var m;
        if ((m = s.match(/^(\d+):(\d{1,2}):(\d{1,2})$/))) return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
        if ((m = s.match(/^(\d+):(\d{1,2})$/))) return (+m[1]) * 60 + (+m[2]);
        var n = parseFloat(s.replace(/[^0-9.\-]/g, ''));
        if (!isFinite(n)) return 0;
        return Math.round(isMinutes ? n * 60 : n);
    }

    /** Excel turns long numbers into 1.3035550123E+10 — put the digits back. */
    function cleanNumber(v) {
        var s = clean(v);
        if (/^\d(\.\d+)?e\+?\d{1,2}$/i.test(s)) {
            var n = Number(s);
            if (isFinite(n) && n < 1e21) return n.toFixed(0);
        }
        if (/^\d+\.0+$/.test(s)) return s.replace(/\.0+$/, '');
        return s;
    }

    /** Does this carrier timestamp its spreadsheets in UTC? */
    function carrierTimesUtc(carrier, headers) {
        if (carrier === 'T-Mobile') return true;
        return (headers || []).some(function (h) { return /\butc\b|\bgmt\b/i.test(String(h || '')); });
    }

    return {
        headerScore: headerScore,
        isTowerListHeader: isTowerListHeader,
        findHeaderRow: findHeaderRow,
        tableEnd: tableEnd,
        pickSheet: pickSheet,
        uniqueHeaders: uniqueHeaders,
        rowsToRecords: rowsToRecords,
        detectCarrier: detectCarrier,
        tmobileMapping: tmobileMapping,
        verizonMapping: verizonMapping,
        isVerizonHeader: isVerizonHeader,
        findTowerTable: findTowerTable,
        joinTowers: joinTowers,
        prepareCdr: prepareCdr,
        parseDateTime: parseDateTime,
        callType: callType,
        durationSeconds: durationSeconds,
        cleanNumber: cleanNumber,
        carrierTimesUtc: carrierTimesUtc,
    };
});

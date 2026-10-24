/**
 * Series Analysis: data model (pure; no DOM, no storage).
 *
 * Many incidents worked under one case: parsing, ordering, time pattern,
 * spatial spread/drift, shared-attribute comparison, the "likely next"
 * projection and static-map tile math for the bulletin.
 *
 * "Likely next" is a DESCRIPTIVE projection from the observed hits (spacing,
 * weekday mix, peak hours, recent locations + drift). It is not a predictive
 * model and the UI must always label it that way.
 *
 * Dates are 'YYYY-MM-DD', times 'HH:MM'. All day math is done in UTC so the
 * host timezone never shifts a calendar day. dow: 0 = Sun … 6 = Sat.
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root) root.SeriesAnalysisModel = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    var VERSION = 1;
    var DAY_MS = 86400000;
    var R_EARTH = 6371008.8;
    var RAD = Math.PI / 180;
    var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var MON_FIRST = [1, 2, 3, 4, 5, 6, 0];

    var GROUPS = { vehicle: '#00d9ff', person: '#a855f7', mo: '#c084fc', target: '#22c55e', place: '#ffa726', other: '#94a3b8' };

    function col(key, label, group) { return { key: key, label: label, group: group }; }
    var C = {
        target: col('target', 'Target / property', 'target'),
        victimTarget: col('target', 'Victim / target', 'target'),
        suspectVehicle: col('suspectVehicle', 'Suspect vehicle', 'vehicle'),
        suspects: col('suspects', 'Suspects', 'person'),
        method: col('method', 'Method / MO', 'mo'),
        locationTypeP: col('locationType', 'Location type / parking', 'place'),
        locationType: col('locationType', 'Location type', 'place'),
        footage: col('footage', 'Footage', 'other'),
        causeOfDeath: col('causeOfDeath', 'Cause of death', 'mo'),
        weapon: col('weapon', 'Weapon', 'mo'),
        wounds: col('wounds', 'Wounds / injuries', 'mo'),
        victimProfile: col('victimProfile', 'Victim profile', 'person'),
        bodyDisposition: col('bodyDisposition', 'Body disposition', 'place'),
        lastSeen: col('lastSeen', 'Last seen', 'other')
    };
    var TEMPLATES = {
        property: { label: 'Property crime series', columns: [C.target, C.suspectVehicle, C.suspects, C.method, C.locationTypeP, C.footage] },
        homicide: { label: 'Death / violent crime', columns: [C.causeOfDeath, C.weapon, C.wounds, C.victimProfile, C.locationType, C.bodyDisposition, C.lastSeen, C.suspects, C.suspectVehicle] },
        persons: { label: 'Robbery / persons crime', columns: [C.suspects, C.suspectVehicle, C.weapon, C.method, C.victimTarget, C.locationType, C.footage] },
        general: { label: 'General', columns: [C.suspects, C.suspectVehicle, C.method, C.locationType, C.target] }
    };

    // ── small utils ──────────────────────────────────────────────────
    function s(v) { return v == null ? '' : String(v).trim(); }
    function pad2(n) { return (n < 10 ? '0' : '') + n; }
    function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
    function num(v) {
        if (v == null || v === '') return null;
        var n = typeof v === 'number' ? v : parseFloat(String(v).trim());
        return isFinite(n) ? n : null;
    }
    function copyCols(cols) { return cols.map(function (c) { return { key: c.key, label: c.label, group: c.group }; }); }
    function mean(a) { if (!a.length) return null; var t = 0; for (var i = 0; i < a.length; i++) t += a[i]; return t / a.length; }
    function sd(a) {
        if (a.length < 2) return 0;
        var m = mean(a), t = 0;
        for (var i = 0; i < a.length; i++) t += (a[i] - m) * (a[i] - m);
        return Math.sqrt(t / a.length);
    }
    function median(a) {
        if (!a.length) return null;
        var b = a.slice().sort(function (x, y) { return x - y; });
        var m = Math.floor(b.length / 2);
        return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
    }
    function newId(prefix) {
        return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
    }

    // ── dates & times ────────────────────────────────────────────────
    function validYmd(y, m, d) {
        if (!(y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return '';
        var dt = new Date(Date.UTC(y, m - 1, d));
        if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return '';
        return y + '-' + pad2(m) + '-' + pad2(d);
    }
    var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
    function monthOf(word) {
        var w = String(word || '').toLowerCase().replace(/\.$/, '');
        if (MONTHS[w]) return MONTHS[w];
        var k = w.slice(0, 3);
        return (w.length >= 3 && MONTHS[k] && ('january february march april may june july august september october november december'.indexOf(w) >= 0)) ? MONTHS[k] : 0;
    }
    function parseDate(v) {
        if (v == null || v === '') return '';
        if (v instanceof Date) return isNaN(v.getTime()) ? '' : validYmd(v.getFullYear(), v.getMonth() + 1, v.getDate());
        var t = String(v).trim().replace(/^(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)[a-z]*\.?,?\s+/i, '');
        var m;
        if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:$|[T\s])/.exec(t))) return validYmd(+m[1], +m[2], +m[3]);
        if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(t))) return validYmd(+m[1], +m[2], +m[3]);
        if ((m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})(?:$|[\sT,])/.exec(t))) {
            var y = +m[3]; if (m[3].length === 2) y += 2000;
            return validYmd(y, +m[1], +m[2]);
        }
        if ((m = /^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?:$|[\s,])/i.exec(t))) {
            var mo = monthOf(m[1]); return mo ? validYmd(+m[3], mo, +m[2]) : '';
        }
        if ((m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?,?\s+(\d{4})(?:$|[\s,])/i.exec(t))) {
            var mo2 = monthOf(m[2]); return mo2 ? validYmd(+m[3], mo2, +m[1]) : '';
        }
        return '';
    }
    function parseTime(v) {
        if (v == null || v === '') return '';
        if (v instanceof Date) return isNaN(v.getTime()) ? '' : pad2(v.getHours()) + ':' + pad2(v.getMinutes());
        var t = String(v).trim().toLowerCase().replace(/\s*(hrs?|hours)\.?$/, '').trim();
        var m, h, mi, ap = '';
        var apRe = '\\s*(a\\.?m?\\.?|p\\.?m?\\.?)?$';
        if ((m = new RegExp('^(\\d{1,2}):(\\d{2})(?::\\d{2}(?:\\.\\d+)?)?' + apRe).exec(t))) { h = +m[1]; mi = +m[2]; ap = m[3] || ''; }
        else if ((m = new RegExp('^(\\d{3,4})' + apRe).exec(t))) { var n = +m[1]; h = Math.floor(n / 100); mi = n % 100; ap = m[2] || ''; }
        else if ((m = /^(\d{1,2})\s*(a\.?m?\.?|p\.?m?\.?)$/.exec(t))) { h = +m[1]; mi = 0; ap = m[2]; }
        else return '';
        if (ap) {
            if (h < 1 || h > 12) return '';
            var pm = ap.charAt(0) === 'p';
            if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12;
        }
        if (h > 23 || mi > 59) return '';
        return pad2(h) + ':' + pad2(mi);
    }
    function parseDateTime(v) {
        if (v == null || v === '') return { date: '', time: '' };
        if (v instanceof Date) return { date: parseDate(v), time: parseTime(v) };
        var t = String(v).trim();
        var m = /^(\d{4}-\d{1,2}-\d{1,2})[T\s]+(.+)$/.exec(t);
        if (m) {
            var d0 = parseDate(m[1]);
            var tm = m[2].replace(/(z|[+\-]\d{2}:?\d{2})$/i, '');
            if (d0) return { date: d0, time: parseTime(tm) };
        }
        var toks = t.split(/\s+/);
        for (var k = 1; k <= Math.min(3, toks.length - 1); k++) {
            var tp = toks.slice(toks.length - k).join(' ');
            var dp = toks.slice(0, toks.length - k).join(' ').replace(/[,@]+$/, '').replace(/\s+at$/i, '');
            var tt = parseTime(tp), dd = parseDate(dp);
            if (tt && dd) return { date: dd, time: tt };
        }
        return { date: parseDate(t), time: '' };
    }
    function parseTimeRange(v) {
        var t = s(v).replace(/^(between|btwn|from)\s+/i, '');
        if (!t) return { from: '', to: '' };
        var parts = t.split(/\s*(?:[-–—~]|\bto\b|\band\b|\bthru\b|\bthrough\b|&)\s*/i).filter(function (p) { return p !== ''; });
        if (parts.length >= 2) {
            var a = parseTime(parts[0]), b = parseTime(parts[1]);
            // "1:30-5:45pm": carry the trailing am/pm onto a bare first part,
            // unless that would put the start after the end ("11:30-1:45pm").
            var suf = /[ap]\.?m?\.?$/i.exec(parts[1]);
            if (b && suf && !/[ap]\.?m?\.?$/i.test(parts[0])) {
                var carried = parseTime(parts[0] + suf[0]);
                if (carried && (!a || minutes(carried) <= minutes(b))) a = carried;
            }
            if (a && b) return { from: a, to: b === a ? '' : b };
            if (a) return { from: a, to: '' };
        }
        var one = parseTime(t);
        return { from: one, to: '' };
    }
    function dayNum(date) {
        var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
        return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY_MS) : null;
    }
    function fromDayNum(n) {
        var d = new Date(n * DAY_MS);
        return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
    }
    function dowOf(date) { var n = dayNum(date); return n == null ? null : ((n % 7) + 7 + 4) % 7; } // 1970-01-01 was a Thursday
    function minutes(t) { var m = /^(\d{2}):(\d{2})$/.exec(t || ''); return m ? (+m[1]) * 60 + (+m[2]) : null; }
    function shortDate(date) {
        var n = dayNum(date); if (n == null) return '';
        var d = new Date(n * DAY_MS);
        return DOW[d.getUTCDay()] + ' ' + (d.getUTCMonth() + 1) + '/' + d.getUTCDate();
    }
    function isCross(inc) {
        var a = minutes(inc.timeFrom), b = minutes(inc.timeTo);
        return a != null && b != null && a > b;
    }
    /** Absolute start/end minutes relative to 00:00 of inc.date (start may be negative). */
    function span(inc) {
        var a = minutes(inc.timeFrom), b = minutes(inc.timeTo);
        if (a == null && b == null) return null;
        if (a == null) return { start: b, end: b, exact: true };
        if (b == null || b === a) return { start: a, end: a, exact: true };
        if (a > b) return { start: a - 1440, end: b, exact: false };
        return { start: a, end: b, exact: false };
    }

    // ── store ────────────────────────────────────────────────────────
    function emptyStore() {
        return { version: VERSION, title: '', template: 'property', columns: copyCols(TEMPLATES.property.columns), incidents: [], cameras: [], observations: [], bulletin: {} };
    }
    function normalizeIncident(raw) {
        var r = isObj(raw) ? raw : {};
        var out = Object.assign({}, r);
        out.id = s(r.id) || newId('inc');
        out.reportNo = s(r.reportNo);
        out.date = parseDate(r.date);
        out.timeFrom = parseTime(r.timeFrom);
        out.timeTo = parseTime(r.timeTo);
        out.address = s(r.address);
        out.lat = num(r.lat);
        out.lng = num(r.lng);
        if (out.lat == null || out.lng == null || Math.abs(out.lat) > 90 || Math.abs(out.lng) > 180) { out.lat = null; out.lng = null; }
        out.offense = s(r.offense);
        out.notes = s(r.notes);
        var attrs = {};
        if (isObj(r.attrs)) Object.keys(r.attrs).forEach(function (k) { attrs[k] = s(r.attrs[k]); });
        out.attrs = attrs;
        out.source = isObj(r.source) && r.source.type ? Object.assign({}, r.source) : { type: 'manual' };
        out.createdAt = r.createdAt || '';
        out.updatedAt = r.updatedAt || r.createdAt || '';
        return out;
    }
    function normalizeStore(raw) {
        var r = isObj(raw) ? raw : {};
        var out = Object.assign({}, r);
        out.version = VERSION;
        out.title = s(r.title);
        out.template = TEMPLATES[r.template] ? r.template : 'property';
        var cols = Array.isArray(r.columns) ? r.columns.filter(function (c) { return isObj(c) && s(c.key); }).map(function (c) {
            return { key: s(c.key), label: s(c.label) || s(c.key), group: GROUPS[c.group] ? c.group : 'other' };
        }) : [];
        out.columns = cols.length ? cols : copyCols(TEMPLATES[out.template].columns);
        out.incidents = Array.isArray(r.incidents) ? r.incidents.filter(isObj).map(normalizeIncident) : [];
        out.cameras = Array.isArray(r.cameras) ? r.cameras.filter(isObj) : [];
        out.observations = Array.isArray(r.observations) ? r.observations.filter(isObj) : [];
        out.bulletin = isObj(r.bulletin) ? r.bulletin : {};
        return out;
    }

    // ── CSV ──────────────────────────────────────────────────────────
    function parseCsv(text) {
        var t = String(text == null ? '' : text);
        if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
        var nl = t.indexOf('\n'), first = nl >= 0 ? t.slice(0, nl) : t;
        var cnt = function (ch) { return first.split(ch).length - 1; };
        var commas = cnt(','), tabs = cnt('\t'), semis = cnt(';');
        var delim = ',';
        if (tabs > commas && tabs >= semis) delim = '\t';
        else if (semis > commas) delim = ';';
        var rows = [], row = [], field = '', q = false, i = 0, n = t.length;
        while (i < n) {
            var c = t.charAt(i);
            if (q) {
                if (c === '"') {
                    if (t.charAt(i + 1) === '"') { field += '"'; i += 2; continue; }
                    q = false; i++; continue;
                }
                field += c; i++; continue;
            }
            if (c === '"' && field === '') { q = true; i++; continue; }
            if (c === delim) { row.push(field); field = ''; i++; continue; }
            if (c === '\r' || c === '\n') {
                row.push(field); field = ''; rows.push(row); row = [];
                if (c === '\r' && t.charAt(i + 1) === '\n') i++;
                i++; continue;
            }
            field += c; i++;
        }
        if (field !== '' || row.length) { row.push(field); rows.push(row); }
        return rows.filter(function (r) { return r.some(function (f) { return String(f).trim() !== ''; }); });
    }

    var BASE_SYN = {
        reportNo: ['report', 'report #', 'report no', 'report number', 'case', 'case #', 'case no', 'case number', 'incident #', 'incident no', 'incident number', 'cr', 'ir', 'cad', 'cad #'],
        date: ['date', 'occurred', 'occurred date', 'date occurred', 'from date', 'start date', 'incident date', 'reported', 'date reported', 'occ date'],
        timeFrom: ['time', 'from time', 'start time', 'time from', 'occurred time', 'time occurred', 'occ time'],
        timeTo: ['to time', 'end time', 'time to'],
        timeRange: ['time range', 'between', 'window', 'time window'],
        address: ['address', 'location', 'street', 'block', 'incident address', 'street address'],
        lat: ['lat', 'latitude', 'y'],
        lng: ['lng', 'lon', 'long', 'longitude', 'x'],
        offense: ['offense', 'offence', 'crime', 'type', 'nature', 'call type', 'ucr', 'offense type', 'crime type'],
        notes: ['notes', 'narrative', 'summary', 'description', 'synopsis', 'details']
    };
    var COL_SYN = {
        target: ['target', 'property', 'victim vehicle', 'vehicle targeted', 'target vehicle'],
        suspectVehicle: ['suspect vehicle', 'sv', 'susp veh', 'susp vehicle'],
        suspects: ['suspect', 'suspects', 'suspect description', 'suspect desc'],
        method: ['mo', 'method', 'modus operandi', 'm.o.'],
        locationType: ['parking', 'location type', 'premise', 'premise type'],
        footage: ['video', 'camera', 'footage', 'cctv'],
        causeOfDeath: ['cause of death', 'cod']
    };
    function normHeader(h) {
        return String(h == null ? '' : h).toLowerCase().replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/#/g, ' # ').replace(/[^a-z0-9#]+/g, ' ').replace(/\s+/g, ' ').trim();
    }
    function camelWords(k) { return String(k || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase(); }
    function guessMapping(headers, columns) {
        var H = (headers || []).map(normHeader);
        var fields = [];
        Object.keys(BASE_SYN).forEach(function (k) { fields.push({ key: k, syn: BASE_SYN[k] }); });
        (columns || []).forEach(function (c) {
            if (!c || !c.key || BASE_SYN[c.key]) return;
            var syn = [c.label, c.key, camelWords(c.key)].concat(COL_SYN[c.key] || []);
            // "Target / property" → also "target", "property"
            String(c.label || '').split(/\s*\/\s*/).forEach(function (p) { if (p) syn.push(p); });
            fields.push({ key: c.key, syn: syn });
        });
        fields.forEach(function (f) { f.syn = f.syn.map(normHeader).filter(Boolean); });
        var out = {}, used = {};
        // Pass 1: exact header match, in field order.
        fields.forEach(function (f) {
            for (var i = 0; i < H.length; i++) {
                if (used[i] || !H[i]) continue;
                if (f.syn.indexOf(H[i]) >= 0) { out[f.key] = i; used[i] = 1; return; }
            }
        });
        // Pass 2: header contains a synonym as whole words; the longest synonym wins.
        var cands = [];
        fields.forEach(function (f, fi) {
            if (out[f.key] != null) return;
            f.syn.forEach(function (sy) {
                if (sy.length < 3) return;
                for (var i = 0; i < H.length; i++) {
                    if (used[i] || !H[i]) continue;
                    if ((' ' + H[i] + ' ').indexOf(' ' + sy + ' ') >= 0) cands.push({ key: f.key, i: i, len: sy.length, fi: fi });
                }
            });
        });
        cands.sort(function (a, b) { return (b.len - a.len) || (a.fi - b.fi) || (a.i - b.i); });
        cands.forEach(function (c) {
            if (out[c.key] != null || used[c.i]) return;
            out[c.key] = c.i; used[c.i] = 1;
        });
        return out;
    }
    function rowsToIncidents(rows, mapping, opts) {
        opts = opts || {};
        var hasHeader = opts.hasHeader !== false;
        var src = opts.source || { type: 'csv' };
        var mp = mapping || {};
        var incidents = [], skipped = [];
        var has = function (k) { return mp[k] != null && mp[k] !== '' && !isNaN(+mp[k]); };
        var reserved = { reportNo: 1, date: 1, timeFrom: 1, timeTo: 1, timeRange: 1, address: 1, lat: 1, lng: 1, offense: 1, notes: 1 };
        (rows || []).forEach(function (row, idx) {
            if (hasHeader && idx === 0) return;
            if (!Array.isArray(row)) return;
            var cell = function (k) { return has(k) ? s(row[+mp[k]]) : ''; };
            var date = '', from = '', to = '';
            if (has('date')) {
                var raw = cell('date');
                date = parseDate(raw);
                if (!has('timeFrom')) { var dt = parseDateTime(raw); date = dt.date || date; from = dt.time; }
            }
            if (has('timeFrom')) {
                var tf = cell('timeFrom');
                from = parseTime(tf);
                if (!from || (!has('timeTo') && /[-–—]|\bto\b/i.test(tf))) {
                    var rr = parseTimeRange(tf);
                    if (rr.from) { from = rr.from; if (!has('timeTo')) to = rr.to; }
                }
            }
            if (has('timeTo')) to = parseTime(cell('timeTo'));
            if (has('timeRange') && (!from || (!to && !has('timeTo')))) {
                var r2 = parseTimeRange(cell('timeRange'));
                if (!from) from = r2.from;
                if (!to && !has('timeTo')) to = r2.to;
            }
            var address = cell('address');
            if (!date && !address) { skipped.push({ row: idx + 1, reason: 'no date or address' }); return; }
            var attrs = {};
            Object.keys(mp).forEach(function (k) {
                if (reserved[k] || !has(k)) return;
                var v = cell(k);
                if (v) attrs[k] = v;
            });
            incidents.push(normalizeIncident({
                id: newId('inc'), reportNo: cell('reportNo'), date: date, timeFrom: from, timeTo: to,
                address: address, lat: cell('lat'), lng: cell('lng'), offense: cell('offense'), notes: cell('notes'),
                attrs: attrs, source: Object.assign({}, src)
            }));
        });
        return { incidents: incidents, skipped: skipped };
    }

    // ── ordering & time pattern ──────────────────────────────────────
    function startKey(inc) {
        var d = dayNum(inc.date);
        if (d == null) return Infinity;
        var sp = span(inc);
        return d * 1440 + (sp ? sp.start : 0);
    }
    function chrono(incidents) {
        return (incidents || []).map(function (inc, i) { return { inc: inc, i: i, k: startKey(inc) }; })
            .sort(function (a, b) {
                if (a.k !== b.k) return a.k === Infinity ? 1 : b.k === Infinity ? -1 : a.k - b.k;
                return a.i - b.i;
            }).map(function (x) { return x.inc; });
    }
    function seqMap(incidents) {
        var m = {};
        chrono(incidents).forEach(function (inc, i) { m[inc.id] = i + 1; });
        return m;
    }
    function emptyGrid() { var g = []; for (var d = 0; d < 7; d++) { g.push([]); for (var h = 0; h < 24; h++) g[d].push(0); } return g; }
    function hourWeights(incidents) {
        var g = emptyGrid();
        (incidents || []).forEach(function (inc) {
            var dw = dowOf(inc.date);
            if (dw == null) return;
            var sp = span(inc);
            if (!sp) { for (var h = 0; h < 24; h++) g[dw][h] += 1 / 24; return; }
            var h0 = Math.floor(sp.start / 60);
            var h1 = sp.exact ? h0 : Math.floor(sp.end / 60);
            if (!sp.exact && sp.end % 60 === 0 && h1 > h0) h1--; // ends on the hour: don't touch the next hour
            var count = h1 - h0 + 1, w = 1 / count;
            for (var k = h0; k <= h1; k++) {
                var day = (((dw + Math.floor(k / 24)) % 7) + 7) % 7;
                var hr = ((k % 24) + 24) % 24;
                g[day][hr] += w;
            }
        });
        return g;
    }
    function dayWeights(grid) { return (grid || []).map(function (row) { return row.reduce(function (a, b) { return a + b; }, 0); }); }
    function daysLabel(days) {
        var idx = days.map(function (d) { return MON_FIRST.indexOf(d); }).sort(function (a, b) { return a - b; });
        if (!idx.length) return '';
        if (idx.length === 7) return 'Mon–Sun';
        var contiguous = idx[idx.length - 1] - idx[0] === idx.length - 1;
        if (contiguous && idx.length >= 3) return DOW[MON_FIRST[idx[0]]] + '–' + DOW[MON_FIRST[idx[idx.length - 1]]];
        return idx.map(function (i) { return DOW[MON_FIRST[i]]; }).join(', ');
    }
    function peakWindow(grid, width) {
        width = width || 3;
        if (!grid || !grid.length) return null;
        var colT = [], total = 0;
        for (var h = 0; h < 24; h++) { var t = 0; for (var d = 0; d < 7; d++) t += grid[d][h] || 0; colT.push(t); total += t; }
        if (total <= 0) return null;
        var best = -1, bestS = 0;
        for (var st = 0; st < 24; st++) {
            var w = 0; for (var i = 0; i < width; i++) w += colT[(st + i) % 24];
            if (w > best + 1e-9) { best = w; bestS = st; }
        }
        var inBand = [];
        for (var d2 = 0; d2 < 7; d2++) {
            var x = 0; for (var j = 0; j < width; j++) x += grid[d2][(bestS + j) % 24] || 0;
            inBand.push({ d: d2, w: x });
        }
        inBand.sort(function (a, b) { return (b.w - a.w) || (MON_FIRST.indexOf(a.d) - MON_FIRST.indexOf(b.d)); });
        var acc = 0, days = [];
        for (var k = 0; k < inBand.length; k++) {
            if (inBand[k].w <= 0) break;
            days.push(inBand[k].d); acc += inBand[k].w;
            if (acc >= 0.7 * best - 1e-9) break;
        }
        days.sort(function (a, b) { return MON_FIRST.indexOf(a) - MON_FIRST.indexOf(b); });
        var end = (bestS + width) % 24;
        return { startHour: bestS, endHour: end, share: best / total, days: days, label: pad2(bestS) + '–' + pad2(end), daysLabel: daysLabel(days) };
    }
    function gapStats(incidents) {
        var dated = chrono(incidents).filter(function (i) { return dayNum(i.date) != null; });
        if (dated.length < 2) return null;
        var gaps = [];
        for (var i = 1; i < dated.length; i++) gaps.push(dayNum(dated[i].date) - dayNum(dated[i - 1].date));
        var trend = null;
        if (gaps.length >= 4) {
            var half = Math.floor(gaps.length / 2);
            var a = mean(gaps.slice(0, half)), b = mean(gaps.slice(gaps.length - half));
            trend = a > 0 && b < 0.75 * a ? 'tightening' : (b > 1.33 * a ? 'widening' : 'steady');
            if (a === 0 && b === 0) trend = 'steady';
        }
        var first = dated[0].date, last = dated[dated.length - 1].date;
        return { gaps: gaps, avg: mean(gaps), median: median(gaps), sd: sd(gaps), trend: trend, spanDays: dayNum(last) - dayNum(first), first: first, last: last };
    }

    // ── spatial ──────────────────────────────────────────────────────
    function haversine(a, b) {
        var dLat = (b.lat - a.lat) * RAD, dLng = (b.lng - a.lng) * RAD;
        var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
        return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(x)));
    }
    function hasGeo(i) { return i && typeof i.lat === 'number' && typeof i.lng === 'number' && isFinite(i.lat) && isFinite(i.lng); }
    function toLocal(p, c) { return { x: (p.lng - c.lng) * RAD * R_EARTH * Math.cos(c.lat * RAD), y: (p.lat - c.lat) * RAD * R_EARTH }; }
    function fromLocal(x, y, c) { return { lat: c.lat + (y / R_EARTH) / RAD, lng: c.lng + (x / (R_EARTH * Math.cos(c.lat * RAD))) / RAD }; }
    function centroidOf(pts) {
        var la = 0, ln = 0; pts.forEach(function (p) { la += p.lat; ln += p.lng; });
        return { lat: la / pts.length, lng: ln / pts.length };
    }
    var COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    function driftOf(geoDated, c) {
        if (geoDated.length < 4) return null;
        var ts = geoDated.map(function (i) { return dayNum(i.date); });
        var tm = mean(ts), vt = 0;
        ts.forEach(function (t) { vt += (t - tm) * (t - tm); });
        if (vt <= 0) return null;
        var xs = geoDated.map(function (i) { return toLocal(i, c); });
        var xm = mean(xs.map(function (p) { return p.x; })), ym = mean(xs.map(function (p) { return p.y; }));
        var cx = 0, cy = 0;
        for (var k = 0; k < ts.length; k++) { cx += (ts[k] - tm) * (xs[k].x - xm); cy += (ts[k] - tm) * (xs[k].y - ym); }
        var bx = cx / vt, by = cy / vt; // metres per day east / north
        var mpw = Math.sqrt(bx * bx + by * by) * 7;
        var bearing = (Math.atan2(bx, by) / RAD + 360) % 360;
        return { metersPerWeek: mpw, milesPerWeek: mpw / 1609.344, bearingDeg: bearing, compass: COMPASS[Math.round(bearing / 45) % 8], eastPerDay: bx, northPerDay: by };
    }
    function spatial(incidents) {
        var pts = (incidents || []).filter(hasGeo);
        if (pts.length < 2) return null;
        var c = centroidOf(pts);
        var loc = pts.map(function (p) { return toLocal(p, c); });
        var md = mean(loc.map(function (p) { return Math.sqrt(p.x * p.x + p.y * p.y); }));
        var sxx = 0, syy = 0, sxy = 0;
        loc.forEach(function (p) { sxx += p.x * p.x; syy += p.y * p.y; sxy += p.x * p.y; });
        sxx /= loc.length; syy /= loc.length; sxy /= loc.length;
        var tr = (sxx + syy) / 2, det = Math.sqrt(Math.max(0, ((sxx - syy) / 2) * ((sxx - syy) / 2) + sxy * sxy));
        var l1 = tr + det, l2 = Math.max(0, tr - det);
        var ang = 0.5 * Math.atan2(2 * sxy, sxx - syy) / RAD;
        var geoDated = chrono(pts).filter(function (i) { return dayNum(i.date) != null; });
        return {
            n: pts.length, centroid: c, meanDist_m: md,
            ellipse: { center: c, sx_m: Math.sqrt(l1), sy_m: Math.sqrt(l2), angleDeg: ang },
            drift: driftOf(geoDated, c)
        };
    }
    function ellipsePolygon(e, steps) {
        steps = steps || 48;
        var out = [], a = (e.angleDeg || 0) * RAD, ca = Math.cos(a), sa = Math.sin(a);
        for (var k = 0; k < steps; k++) {
            var t = 2 * Math.PI * k / steps;
            var x0 = e.sx_m * Math.cos(t), y0 = e.sy_m * Math.sin(t);
            var p = fromLocal(x0 * ca - y0 * sa, x0 * sa + y0 * ca, e.center);
            out.push([p.lat, p.lng]);
        }
        return out;
    }
    function circlePolygon(center, r, steps) {
        return ellipsePolygon({ center: center, sx_m: r, sy_m: r, angleDeg: 0 }, steps);
    }

    // ── likely next (descriptive) ────────────────────────────────────
    function likelyNext(incidents, opts) {
        opts = opts || {};
        var list = incidents || [];
        var dated = chrono(list).filter(function (i) { return dayNum(i.date) != null; });
        if (dated.length < 4) return null;
        var gs = gapStats(dated);
        var last = dayNum(gs.last);
        var recent = gs.gaps.slice(-6);
        var mu = mean(recent), sg = Math.max(1, sd(recent));
        var dowCount = [0, 0, 0, 0, 0, 0, 0];
        dated.forEach(function (i) { dowCount[dowOf(i.date)]++; });
        var dowShare = dowCount.map(function (c) { return c / dated.length + 0.02; });
        var nowN = dayNum(parseDate(opts.now));
        var start = Math.max(last + 1, nowN == null ? -Infinity : nowN);
        var cands = [], maxG = 0;
        for (var k = 0; k < 14; k++) {
            var dn = start + k;
            var gz = Math.exp(-0.5 * Math.pow(((dn - last) - mu) / sg, 2));
            if (gz > maxG) maxG = gz;
            cands.push({ dn: dn, g: gz, dw: ((dn % 7) + 7 + 4) % 7 });
        }
        var overdue = maxG < 1e-3;
        cands.forEach(function (c) { c.score = overdue ? dowShare[c.dw] : c.g * dowShare[c.dw]; });
        var bi = 0;
        cands.forEach(function (c, i) { if (c.score > cands[bi].score) bi = i; });
        var best = cands[bi].score, lo = bi, hi = bi;
        while (hi - lo + 1 < 4) {
            var L = lo > 0 && cands[lo - 1].score >= 0.5 * best ? cands[lo - 1].score : -1;
            var Rr = hi < cands.length - 1 && cands[hi + 1].score >= 0.5 * best ? cands[hi + 1].score : -1;
            if (L < 0 && Rr < 0) break;
            if (Rr >= L) hi++; else lo--;
        }
        var wS = fromDayNum(cands[lo].dn), wE = fromDayNum(cands[hi].dn);
        var pk = peakWindow(hourWeights(list));
        var win = {
            start: wS, end: wE,
            fromHour: pk ? pk.startHour : null, toHour: pk ? pk.endHour : null,
            label: wS === wE ? shortDate(wS) : shortDate(wS) + ' – ' + shortDate(wE),
            hoursLabel: pk ? pad2(pk.startHour) + ':00–' + pad2(pk.endHour) + ':00' : ''
        };
        var reasons = [];
        reasons.push('Spacing: the last ' + recent.length + ' gap' + (recent.length === 1 ? '' : 's') + ' average ' + (Math.round(mu * 10) / 10) + ' days (±' + (Math.round(sg * 10) / 10) + ').');
        if (overdue) reasons.push('The series is past its usual spacing, so only the weekday mix was used.');
        var topDays = dowCount.map(function (c, d) { return { c: c, d: d }; }).filter(function (x) { return x.c; })
            .sort(function (a, b) { return b.c - a.c; }).slice(0, 3).map(function (x) { return DOW[x.d] + ' ' + x.c; });
        reasons.push('Weekday mix of dated hits: ' + topDays.join(', ') + '.');
        if (pk) reasons.push('Hours: ' + pk.label + ' holds ' + Math.round(pk.share * 100) + '% of the time weight.');

        var area = null;
        var geo = chrono(list).filter(hasGeo);
        var lastGeo = geo.slice(-4);
        if (lastGeo.length >= 2) {
            var c0 = centroidOf(lastGeo);
            var md = mean(lastGeo.map(function (p) { return haversine(p, c0); }));
            var radius = Math.max(150, 1.5 * md);
            var center = c0;
            var sp = spatial(list);
            if (sp && sp.drift) {
                var ds = lastGeo.map(function (i) { return dayNum(i.date); }).filter(function (x) { return x != null; });
                if (ds.length) {
                    var mid = (cands[lo].dn + cands[hi].dn) / 2;
                    var days = mid - mean(ds);
                    var dx = sp.drift.eastPerDay * days, dy = sp.drift.northPerDay * days;
                    var len = Math.sqrt(dx * dx + dy * dy), cap = 3 * radius;
                    if (len > cap) { dx *= cap / len; dy *= cap / len; }
                    center = fromLocal(dx, dy, c0);
                    if (sp.drift.milesPerWeek >= 0.05) reasons.push('Area: centre of the last ' + lastGeo.length + ' located hits, shifted with the ≈' + (Math.round(sp.drift.milesPerWeek * 10) / 10) + ' mi/week ' + sp.drift.compass + ' drift.');
                    else reasons.push('Area: centre of the last ' + lastGeo.length + ' located hits (no meaningful drift).');
                }
            } else {
                reasons.push('Area: centre of the last ' + lastGeo.length + ' located hits.');
            }
            area = { center: center, radius_m: radius };
        }
        var confidence = (dated.length >= 6 && pk && pk.share >= 0.5) ? 'moderate' : 'low';
        reasons.push('Built from ' + dated.length + ' observed incidents. This is a description of the pattern so far, not a prediction model.');
        return { basis: 'observed', window: win, area: area, confidence: confidence, reasons: reasons };
    }

    // ── compare ──────────────────────────────────────────────────────
    var NA = { '': 1, '—': 1, '–': 1, '-': 1, 'n/a': 1, 'na': 1, 'unk': 1, 'unknown': 1, 'none': 1, '?': 1 };
    function normValue(v) {
        var t = s(v).toLowerCase().replace(/\s+/g, ' ').replace(/(\.\.\.|[.,;:!…])+$/, '').trim();
        return NA[t] ? '' : t;
    }
    function splitValues(v) {
        return s(v).split(/;|·|\||\s+\/\s+|\r?\n/).map(function (p) { return p.trim(); }).filter(Boolean);
    }
    function shared(incidents, columns) {
        var out = {};
        (columns || []).forEach(function (c) {
            var map = {}, order = [];
            (incidents || []).forEach(function (inc) {
                var seen = {};
                splitValues((inc.attrs || {})[c.key]).forEach(function (p) {
                    var n = normValue(p);
                    if (!n || seen[n]) return;
                    seen[n] = 1;
                    if (!map[n]) { map[n] = { value: n, display: p, count: 0, ids: [] }; order.push(n); }
                    map[n].count++; map[n].ids.push(inc.id);
                });
            });
            out[c.key] = order.map(function (n) { return map[n]; }).filter(function (x) { return x.count >= 2; })
                .sort(function (a, b) { return (b.count - a.count) || a.display.localeCompare(b.display); });
        });
        return out;
    }
    function matrix(incidents, columns) {
        var sh = shared(incidents, columns);
        var cnt = {};
        Object.keys(sh).forEach(function (k) { cnt[k] = {}; sh[k].forEach(function (x) { cnt[k][x.value] = x.count; }); });
        return chrono(incidents).map(function (inc, i) {
            var cells = {};
            (columns || []).forEach(function (c) {
                var disp = (inc.attrs || {})[c.key] || '';
                cells[c.key] = {
                    display: disp,
                    parts: splitValues(disp).map(function (p) {
                        var n = normValue(p), k = (cnt[c.key] || {})[n] || (n ? 1 : 0);
                        return { text: p, shared: k >= 2, count: k };
                    })
                };
            });
            return { id: inc.id, n: i + 1, incident: inc, cells: cells };
        });
    }
    function filterByValue(incidents, colKey, value) {
        var want = normValue(value);
        return (incidents || []).filter(function (inc) {
            return splitValues((inc.attrs || {})[colKey]).some(function (p) { return normValue(p) === want; });
        });
    }

    // ── KPIs & summary ───────────────────────────────────────────────
    function topShared(incidents, columns) {
        var sh = shared(incidents, columns);
        var tcols = (columns || []).filter(function (c) { return c.group === 'target'; });
        for (var i = 0; i < tcols.length; i++) {
            var l = sh[tcols[i].key];
            if (l && l.length) return { column: tcols[i].key, display: l[0].display, count: l[0].count };
        }
        var best = null;
        (columns || []).forEach(function (c) {
            var x = (sh[c.key] || [])[0];
            if (x && (!best || x.count > best.count)) best = { column: c.key, display: x.display, count: x.count };
        });
        return best;
    }
    function kpis(incidents, columns, opts) {
        var list = incidents || [];
        var g = gapStats(list);
        return {
            count: list.length,
            spanDays: g ? g.spanDays : null,
            avgGap: g ? g.avg : null,
            trend: g ? g.trend : null,
            peak: peakWindow(hourWeights(list)),
            top: topShared(list, columns),
            next: likelyNext(list, opts)
        };
    }
    function midDow(inc) {
        var d = dayNum(inc.date); if (d == null) return null;
        var sp = span(inc);
        var m = sp ? Math.floor((sp.start + sp.end) / 2) : 0;
        var dn = d + Math.floor(m / 1440);
        return ((dn % 7) + 7 + 4) % 7;
    }
    function fmtMin(m) { m = ((m % 1440) + 1440) % 1440; return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60); }
    function summary(incidents, columns, opts) {
        var list = incidents || [];
        var out = [];
        if (!list.length) return out;
        var pk = peakWindow(hourWeights(list));
        if (pk && pk.days.length && pk.days.length < 7) {
            var dated = list.filter(function (i) { return dayNum(i.date) != null; });
            var onDays = dated.filter(function (i) { return pk.days.indexOf(midDow(i)) >= 0; }).length;
            var line = '**' + onDays + ' of ' + dated.length + '** dated hits fell on **' + pk.daysLabel + '**; the busiest 3-hour band is **' + pk.label + '** (' + Math.round(pk.share * 100) + '% of the time weight)';
            var ex = list.filter(function (i) { var sp = span(i); return sp && sp.exact; }).map(function (i) { return minutes(i.timeFrom || i.timeTo); }).sort(function (a, b) { return a - b; });
            if (ex.length >= 2) {
                var gi = 0, gmax = -1;
                for (var k = 0; k < ex.length; k++) {
                    var nxt = k === ex.length - 1 ? ex[0] + 1440 : ex[k + 1];
                    if (nxt - ex[k] > gmax) { gmax = nxt - ex[k]; gi = k; }
                }
                var from = ex[(gi + 1) % ex.length], to = ex[gi];
                var arc = ((to - from) + 1440) % 1440;
                if (arc <= 8 * 60) line += '. Every exact time is between **' + fmtMin(from) + ' and ' + fmtMin(to) + '**';
            }
            out.push(line + '.');
        }
        var g = gapStats(list);
        if (g) {
            var avg = Math.round(g.avg * 10) / 10;
            var gl = 'A hit every **' + avg + ' day' + (avg === 1 ? '' : 's') + '** on average (median ' + (Math.round(g.median * 10) / 10) + ') over ' + (g.spanDays + 1) + ' days';
            if (g.trend === 'tightening') gl += '; spacing is **tightening**';
            else if (g.trend === 'widening') gl += '; spacing is **widening**';
            else if (g.trend === 'steady') gl += '; spacing is steady';
            out.push(gl + '.');
        }
        var sp = spatial(list);
        if (sp && sp.drift && sp.drift.milesPerWeek >= 0.05) {
            out.push('Located hits are moving ≈**' + (Math.round(sp.drift.milesPerWeek * 10) / 10) + ' mi ' + sp.drift.compass + '** per week.');
        }
        var sq = seqMap(list);
        var sh = shared(list, columns), all = [];
        (columns || []).forEach(function (c) { (sh[c.key] || []).forEach(function (x) { all.push({ c: c, x: x }); }); });
        all.sort(function (a, b) { return b.x.count - a.x.count; });
        all.slice(0, 3).forEach(function (o) {
            var nums = o.x.ids.map(function (id) { return sq[id]; }).sort(function (a, b) { return a - b; }).map(function (n) { return '#' + n; });
            out.push('**' + o.x.display + '** (' + o.c.label.toLowerCase() + ') at ' + o.x.count + ' incidents (' + nums.join(', ') + ').');
        });
        var noGeo = list.filter(function (i) { return !hasGeo(i); }).length;
        var noTime = list.filter(function (i) { return !span(i); }).length;
        var noDate = list.filter(function (i) { return dayNum(i.date) == null; }).length;
        var dq = [];
        if (noGeo) dq.push(noGeo + ' without a map position');
        if (noTime) dq.push(noTime + ' without a time');
        if (noDate) dq.push(noDate + ' without a date');
        if (dq.length) out.push('Data gaps: ' + dq.join(', ') + '. Filling them in sharpens the pattern.');
        return out;
    }

    // ── multi-case import & CSV template ─────────────────────────────
    function personName(p) { return s(p && (p.name || [p.firstName, p.lastName].filter(Boolean).join(' '))); }
    function fromCase(c, extras) {
        c = c || {}; extras = extras || {};
        var sus = (extras.suspects || []).map(personName).filter(Boolean);
        var vic = (extras.victims || []).map(function (v) {
            var n = personName(v), bits = [];
            if (v && v.age) bits.push(s(v.age));
            var sx = v && (v.sex || v.gender); if (sx) bits.push(s(sx));
            return bits.length ? (n ? n + ' ' : '') + '(' + bits.join('/') + ')' : n;
        }).filter(Boolean);
        var attrs = {};
        if (sus.length) attrs.suspects = sus.join('; ');
        if (vic.length) attrs.victimProfile = vic.join('; ');
        return normalizeIncident({
            reportNo: c.caseNumber, date: c.offenseDate, address: c.locationOfOccurrence, offense: c.primaryOffense,
            notes: s(c.caseName || c.title || c.description).slice(0, 300),
            attrs: attrs, source: { type: 'case', caseId: c.id, caseNumber: c.caseNumber }
        });
    }
    function csvCell(v) { var t = String(v); return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; }
    function csvTemplate(columns) {
        var h = ['Report #', 'Date', 'Time From', 'Time To', 'Address', 'Latitude', 'Longitude', 'Offense']
            .concat((columns || []).map(function (c) { return c.label; })).concat(['Notes']);
        return h.map(csvCell).join(',');
    }

    // ── static map (Web Mercator, 256-px tiles) ──────────────────────
    function projectPx(lat, lng, z) {
        var scale = 256 * Math.pow(2, z);
        var la = Math.max(-85.05112878, Math.min(85.05112878, lat)) * RAD;
        return { x: (lng + 180) / 360 * scale, y: (1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2 * scale };
    }
    function ptOf(p) { return Array.isArray(p) ? { lat: +p[0], lng: +p[1] } : { lat: +p.lat, lng: +p.lng }; }
    function tileMosaic(points, width, height, opts) {
        opts = opts || {};
        var pts = (points || []).map(ptOf).filter(function (p) { return isFinite(p.lat) && isFinite(p.lng); });
        if (!pts.length) return null;
        var pad = opts.padPx != null ? opts.padPx : 40, maxZ = opts.maxZoom || 17, minZ = opts.minZoom || 3;
        var z = Math.min(15, maxZ), bb;
        function bbox(zz) {
            var a = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
            pts.forEach(function (p) { var q = projectPx(p.lat, p.lng, zz); a.x0 = Math.min(a.x0, q.x); a.y0 = Math.min(a.y0, q.y); a.x1 = Math.max(a.x1, q.x); a.y1 = Math.max(a.y1, q.y); });
            return a;
        }
        var multi = pts.length > 1 && pts.some(function (p) { return p.lat !== pts[0].lat || p.lng !== pts[0].lng; });
        if (multi) {
            z = minZ;
            for (var zz = maxZ; zz >= minZ; zz--) {
                var b = bbox(zz);
                if (b.x1 - b.x0 + 2 * pad <= width && b.y1 - b.y0 + 2 * pad <= height) { z = zz; break; }
            }
        }
        bb = bbox(z);
        var origin = { x: (bb.x0 + bb.x1) / 2 - width / 2, y: (bb.y0 + bb.y1) / 2 - height / 2 };
        var n = Math.pow(2, z), tiles = [];
        var tx0 = Math.floor(origin.x / 256), tx1 = Math.floor((origin.x + width - 1) / 256);
        var ty0 = Math.max(0, Math.floor(origin.y / 256)), ty1 = Math.min(n - 1, Math.floor((origin.y + height - 1) / 256));
        for (var ty = ty0; ty <= ty1; ty++) {
            for (var tx = tx0; tx <= tx1; tx++) {
                tiles.push({ z: z, x: ((tx % n) + n) % n, y: ty, left: Math.round(tx * 256 - origin.x), top: Math.round(ty * 256 - origin.y) });
            }
        }
        return { zoom: z, origin: origin, width: width, height: height, tiles: tiles };
    }
    function toViewport(mosaic, lat, lng) {
        var p = projectPx(lat, lng, mosaic.zoom);
        return { x: p.x - mosaic.origin.x, y: p.y - mosaic.origin.y };
    }
    function metersPerPixel(lat, z) { return 156543.03392 * Math.cos(lat * RAD) / Math.pow(2, z); }

    return {
        VERSION: VERSION, GROUPS: GROUPS, TEMPLATES: TEMPLATES, DOW: DOW,
        emptyStore: emptyStore, normalizeStore: normalizeStore, normalizeIncident: normalizeIncident, newId: newId,
        parseDate: parseDate, parseTime: parseTime, parseDateTime: parseDateTime, parseTimeRange: parseTimeRange,
        parseCsv: parseCsv, guessMapping: guessMapping, rowsToIncidents: rowsToIncidents,
        chrono: chrono, seqMap: seqMap, hourWeights: hourWeights, dayWeights: dayWeights, peakWindow: peakWindow, gapStats: gapStats,
        haversine: haversine, hasGeo: hasGeo, spatial: spatial, ellipsePolygon: ellipsePolygon, circlePolygon: circlePolygon,
        likelyNext: likelyNext,
        normValue: normValue, splitValues: splitValues, shared: shared, matrix: matrix, filterByValue: filterByValue,
        kpis: kpis, summary: summary, fromCase: fromCase, csvTemplate: csvTemplate,
        projectPx: projectPx, tileMosaic: tileMosaic, toViewport: toViewport, metersPerPixel: metersPerPixel,
        dayNum: dayNum, fromDayNum: fromDayNum, dowOf: dowOf, shortDate: shortDate
    };
}));

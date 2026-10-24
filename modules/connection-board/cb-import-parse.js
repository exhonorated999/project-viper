/* ============================================================
   Connection Board: third-party import parsing (pure, no DOM)
   Spreadsheet rows (CSV/TSV/XLSX), KML and GeoJSON -> board pin specs.
   Spec shape matches ConnectionBoard.addPins():
     {type, label, sourceType, sourceId, lat, lng, address, color, data}
   UMD: window.CBImportParse / module.exports.
   ============================================================ */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CBImportParse = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    // ── column guessing ─────────────────────────────────────────────
    // Fields are claimed in this order, and within a field the patterns are
    // tried in priority order across all columns (so "Name" beats "ID" for the
    // label even when ID is the first column).
    var FIELDS = ['latlng', 'lat', 'lng', 'datetime', 'date', 'time', 'label', 'address', 'type', 'plate', 'phone', 'notes'];
    var PATTERNS = {
        latlng:   [/^(lat\s*[,/&]\s*(lng|lon|long)|lat\s*long|latlng|latlon|coord(inate)?s?|gps(\s*coord(inate)?s?)?|position|location\s*\(\s*lat.*\))$/i],
        lat:      [/^(lat|latitude)$/i, /^(gps\s*lat|lat\s*\(?dd\)?|lat_dd|start\s*lat|y)$/i, /\blat(itude)?\b/i],
        lng:      [/^(lng|lon|long|longitude)$/i, /^(gps\s*(lon|long|lng)|lon(g)?\s*\(?dd\)?|lon_dd|start\s*lon(g)?|x)$/i, /\b(lon|long|lng|longitude)\b/i],
        datetime: [/^(date\s*[/&_-]?\s*time|datetime|timestamp|time\s*stamp)$/i, /^(date\s*time\s*\(?\w+\)?|event\s*time|start\s*time|captured(\s*at)?|read\s*time|occurred(\s*at)?|seen\s*at)$/i],
        date:     [/^(date|event\s*date|start\s*date|incident\s*date|day)$/i],
        time:     [/^(time|time\s*of\s*day|hour)$/i],
        label:    [/^name$/i, /^(title|label)$/i, /^(camera|site|location|place|business|target|subject)\s*name$/i, /\bname\b/i, /^(subject|target)$/i, /^(description|desc)$/i, /^(id|identifier)$/i],
        address:  [/^(full\s*)?address$/i, /^(street\s*address|addr|location|place|site|intersection)$/i, /(address|street|cross\s*street|location)/i],
        type:     [/^(type|category|kind|class|record\s*type|event\s*type)$/i],
        plate:    [/^(plate|plate\s*(no|number|#)|license\s*plate|lpr|vrm|tag\s*(no|number|#))$/i, /plate/i],
        phone:    [/^(phone|phone\s*number|msisdn|imsi|imei|target\s*number|number\s*called)$/i, /(phone|msisdn|imei|imsi)/i],
        notes:    [/^(notes?|comments?|remarks?|details?|narrative|summary|description|desc)$/i, /(notes?|comments?|remarks?|narrative)/i]
    };

    function normHeader(h) { return String(h == null ? '' : h).replace(/[\u00a0\s]+/g, ' ').trim(); }

    /** @returns {Object<field, columnIndex|-1>} */
    function guessColumns(headers) {
        var hs = (headers || []).map(normHeader);
        var taken = {}, out = {};
        FIELDS.forEach(function (f) {
            out[f] = -1;
            var pats = PATTERNS[f];
            for (var p = 0; p < pats.length && out[f] === -1; p++) {
                for (var i = 0; i < hs.length; i++) {
                    if (taken[i] || !hs[i]) continue;
                    if (pats[p].test(hs[i])) { out[f] = i; taken[i] = true; break; }
                }
            }
        });
        // A lat column without a lng column is not usable as a pair.
        if ((out.lat === -1) !== (out.lng === -1)) { out.lat = -1; out.lng = -1; }
        return out;
    }

    // ── coordinates ─────────────────────────────────────────────────
    /**
     * One coordinate from decimal degrees, DMS or DDM, with optional
     * hemisphere letter. Returns null when it cannot be read.
     *   "39.7392", "-104.99", "39°44'21.1\"N", "104 59 03 W", "N39 44.352"
     */
    function parseCoord(v, axis) {
        if (typeof v === 'number') return isFinite(v) ? v : null;
        var s = String(v == null ? '' : v).trim();
        if (!s) return null;
        // Only digits, separators, degree/minute/second marks and one hemisphere letter.
        if (/[^0-9\s.,+\-°º˚'’′"”″:NSEWnsew]/.test(s.replace(/deg|min|sec/gi, ' '))) return null;
        if ((s.match(/[NSEW]/gi) || []).length > 1) return null;
        var hemi = (s.match(/[NSEW]/i) || [''])[0].toUpperCase();
        if ((axis === 'lat' && /[EW]/.test(hemi)) || (axis === 'lng' && /[NS]/.test(hemi))) return null;
        var neg = /^-/.test(s) || hemi === 'S' || hemi === 'W';
        if (s.indexOf('.') < 0) s = s.replace(/(\d),(\d)/, '$1.$2'); // "39,7392" (comma decimal)
        var nums = s.match(/\d+(?:\.\d+)?/g);
        if (!nums || !nums.length || nums.length > 3) return null;
        var d = parseFloat(nums[0]), m = nums[1] != null ? parseFloat(nums[1]) : 0, sec = nums[2] != null ? parseFloat(nums[2]) : 0;
        if (m >= 60 || sec >= 60) return null;
        var val = d + m / 60 + sec / 3600;
        if (neg) val = -val;
        var lim = axis === 'lng' ? 180 : axis === 'lat' ? 90 : 180;
        if (Math.abs(val) > lim) return null;
        return Math.round(val * 1e7) / 1e7;
    }

    /** "39.73, -104.99" / "39.73 -104.99" / "(39.73,-104.99)" / DMS pair. */
    function parseLatLng(v) {
        var s = String(v == null ? '' : v).trim().replace(/^[([{]|[)\]}]$/g, '');
        if (!s) return null;
        var parts;
        if (/[NS].*[EW]/i.test(s)) {
            var cands = [s.match(/^([NS][^EW]*?)\s*[,;/]?\s*([EW].*)$/i), s.match(/^(.*?[NS])\s*[,;/]?\s*(.*?[EW])$/i)];
            for (var ci = 0; ci < cands.length && !parts; ci++) {
                var m = cands[ci];
                if (m && parseCoord(m[1], 'lat') != null && parseCoord(m[2], 'lng') != null) parts = [m[1], m[2]];
            }
        } else if (s.indexOf(',') >= 0) parts = s.split(/\s*,\s*/);
        else parts = s.split(/\s+|;/);
        if (!parts || parts.length !== 2) return null;
        var lat = parseCoord(parts[0], 'lat'), lng = parseCoord(parts[1], 'lng');
        if (lat == null || lng == null) return null;
        if (lat === 0 && lng === 0) return null; // null-island = missing GPS
        return { lat: lat, lng: lng };
    }

    // ── delimited text ──────────────────────────────────────────────
    function detectDelimiter(text) {
        var lines = String(text || '').split(/\r?\n/).filter(function (l) { return l.trim(); }).slice(0, 10);
        var best = ',', bestScore = -1;
        [',', '\t', ';', '|'].forEach(function (d) {
            var counts = lines.map(function (l) { return splitLine(l, d).length; });
            if (!counts.length || counts[0] < 2) return;
            var same = counts.filter(function (c) { return c === counts[0]; }).length;
            var score = same * 100 + counts[0];
            if (score > bestScore) { bestScore = score; best = d; }
        });
        return best;
    }
    function splitLine(line, d) { return parseDelimited(line, d)[0] || []; }

    /** Minimal RFC 4180 reader (quotes, doubled quotes, CRLF inside quotes). */
    function parseDelimited(text, delim) {
        var s = String(text || '').replace(/^\uFEFF/, '');
        var d = delim || detectDelimiter(s);
        var rows = [], row = [], cell = '', q = false;
        for (var i = 0; i < s.length; i++) {
            var c = s[i];
            if (q) {
                if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
                else cell += c;
            } else if (c === '"' && cell === '') q = true;
            else if (c === d) { row.push(cell); cell = ''; }
            else if (c === '\n' || c === '\r') {
                if (c === '\r' && s[i + 1] === '\n') i++;
                row.push(cell); rows.push(row); row = []; cell = '';
            } else cell += c;
        }
        if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
        return rows.filter(function (r) { return r.some(function (x) { return String(x).trim(); }); });
    }

    /** First row that looks like a header (mostly non-numeric text). */
    function headerRowIndex(rows) {
        for (var i = 0; i < Math.min(rows.length, 10); i++) {
            var r = rows[i] || [];
            var filled = r.filter(function (x) { return String(x).trim(); });
            if (filled.length < 2) continue;
            var texty = filled.filter(function (x) { return /[a-z]/i.test(x) && !/^-?\d+([.,]\d+)?$/.test(String(x).trim()); });
            if (texty.length >= Math.ceil(filled.length * 0.6)) return i;
        }
        return 0;
    }

    // ── row -> pin type ─────────────────────────────────────────────
    var TYPE_WORDS = [
        [/lpr|plate|alpr|anpr|reader/i, 'lpr'],
        [/ping|tower|cell|cdr|sector|handset|phone/i, 'cellPing'],
        [/camera|cctv|video|dvr|footage/i, 'video'],
        [/suspect/i, 'suspect'], [/victim/i, 'victim'], [/witness/i, 'witness'],
        [/person|subject|associate/i, 'person'],
        [/vehicle|car|truck/i, 'vehicle'],
        [/scene|incident|crime|offen[cs]e|burglary|theft/i, 'scene'],
        [/evidence/i, 'evidence'], [/note/i, 'note'], [/image|photo/i, 'image']
    ];
    var TYPES = ['scene', 'person', 'suspect', 'victim', 'witness', 'involved', 'missing', 'vehicle', 'location', 'plateHit', 'lpr', 'cellData', 'cellPing', 'associate', 'note', 'image', 'video', 'evidence', 'custom'];
    function normType(v, fallback) {
        var s = String(v == null ? '' : v).trim();
        if (!s) return fallback || 'location';
        if (TYPES.indexOf(s) >= 0) return s;
        for (var i = 0; i < TYPE_WORDS.length; i++) if (TYPE_WORDS[i][0].test(s)) return TYPE_WORDS[i][1];
        return fallback || 'location';
    }

    function cellAt(row, idx) { return idx != null && idx >= 0 && row ? String(row[idx] == null ? '' : row[idx]).trim() : ''; }

    /**
     * Spreadsheet rows -> pin specs.
     * @param {string[][]} rows   header row included at headerIndex
     * @param {Object} mapping    field -> column index (-1 = unused), as guessColumns
     * @param {Object} opts       {batchId, sourceName, importedAt, defaultType, headerIndex, extraCols:true}
     */
    function rowsToSpecs(rows, mapping, opts) {
        opts = opts || {};
        mapping = mapping || {};
        var hi = opts.headerIndex != null ? opts.headerIndex : 0;
        var headers = (rows[hi] || []).map(normHeader);
        var used = {};
        Object.keys(mapping).forEach(function (k) { if (mapping[k] != null && mapping[k] >= 0) used[mapping[k]] = true; });
        var st = 'import:' + (opts.batchId || 'batch');
        var specs = [], skipped = [], located = 0;
        for (var r = hi + 1; r < rows.length; r++) {
            var row = rows[r] || [];
            if (!row.some(function (x) { return String(x == null ? '' : x).trim(); })) continue;
            var label = cellAt(row, mapping.label);
            var address = cellAt(row, mapping.address);
            var ll = null;
            if (mapping.latlng >= 0) ll = parseLatLng(cellAt(row, mapping.latlng));
            if (!ll && mapping.lat >= 0 && mapping.lng >= 0) {
                var la = parseCoord(cellAt(row, mapping.lat), 'lat'), lo = parseCoord(cellAt(row, mapping.lng), 'lng');
                if (la != null && lo != null && !(la === 0 && lo === 0)) ll = { lat: la, lng: lo };
            }
            // An "address" column that actually holds coordinates.
            if (address && /^[\s(\[]*[NS-]?\s*\d/i.test(address)) {
                var al = parseLatLng(address);
                if (al) { if (!ll) ll = al; address = ''; }
            }
            var dt = cellAt(row, mapping.datetime);
            if (!dt) dt = [cellAt(row, mapping.date), cellAt(row, mapping.time)].filter(Boolean).join(' ');
            var plate = cellAt(row, mapping.plate), phone = cellAt(row, mapping.phone);
            var type = mapping.type >= 0 ? normType(cellAt(row, mapping.type), opts.defaultType) : (opts.defaultType || 'location');
            if (!label && !address && !ll && !plate && !phone) { skipped.push({ row: r + 1, reason: 'no name, address or coordinates' }); continue; }
            if (!label) label = plate || phone || address || ('Row ' + (r + 1));
            var notes = [];
            var n0 = cellAt(row, mapping.notes);
            if (n0) notes.push(n0);
            if (opts.extraCols !== false) {
                headers.forEach(function (h, ci) {
                    if (used[ci] || !h) return;
                    var v = cellAt(row, ci);
                    if (v) notes.push(h + ': ' + v);
                });
            }
            if (ll) located++;
            var data = {
                datetime: dt, notes: notes.join(' \u00B7 '),
                importSource: opts.sourceName || '', importedAt: opts.importedAt || '', importRow: r + 1
            };
            if (plate) data.plate = plate;
            if (phone) data.phone = phone;
            specs.push({
                type: type, label: label.slice(0, 120), sourceType: st, sourceId: 'r' + (r + 1),
                lat: ll ? ll.lat : null, lng: ll ? ll.lng : null, address: address, data: data
            });
        }
        return { specs: specs, skipped: skipped, located: located, needGeocode: specs.filter(function (s) { return s.lat == null && s.address; }).length };
    }

    // ── XML-ish helpers for KML (no DOMParser so it runs under node) ──
    function decodeEntities(s) {
        return String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
            .replace(/&#(\d+);/g, function (_m, n) { return String.fromCharCode(+n); })
            .replace(/&#x([0-9a-f]+);/gi, function (_m, n) { return String.fromCharCode(parseInt(n, 16)); })
            .replace(/&amp;/g, '&');
    }
    function stripCdata(s) { return String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'); }
    function htmlToText(s) {
        return decodeEntities(String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li)>/gi, '\n').replace(/<[^>]+>/g, ' '))
            .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
    }
    function tagText(xml, name) {
        var m = new RegExp('<(?:\\w+:)?' + name + '\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?' + name + '>', 'i').exec(xml);
        return m ? stripCdata(m[1]) : '';
    }
    function allTags(xml, name) {
        var re = new RegExp('<(?:\\w+:)?' + name + '\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?' + name + '>', 'gi'), out = [], m;
        while ((m = re.exec(xml))) out.push({ full: m[0], inner: m[1] });
        return out;
    }
    function kmlCoords(s) {
        return String(s || '').trim().split(/\s+/).map(function (t) {
            var p = t.split(',');
            var lng = parseFloat(p[0]), lat = parseFloat(p[1]);
            return (isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) ? { lat: lat, lng: lng } : null;
        }).filter(Boolean);
    }
    function centroid(pts) {
        var la = 0, lo = 0;
        pts.forEach(function (p) { la += p.lat; lo += p.lng; });
        return { lat: Math.round(la / pts.length * 1e7) / 1e7, lng: Math.round(lo / pts.length * 1e7) / 1e7 };
    }

    /** KML text -> pin specs. Points pin exactly; paths/areas pin at their centre. */
    function parseKml(text, opts) {
        opts = opts || {};
        var st = 'import:' + (opts.batchId || 'batch');
        var xml = String(text || '');
        var specs = [], skipped = [];
        var marks = allTags(xml, 'Placemark');
        marks.forEach(function (pm, i) {
            var body = pm.inner;
            var name = htmlToText(tagText(body, 'name'));
            var desc = htmlToText(tagText(body, 'description'));
            var when = tagText(tagText(body, 'TimeStamp'), 'when') || tagText(body, 'when') ||
                [tagText(tagText(body, 'TimeSpan'), 'begin'), tagText(tagText(body, 'TimeSpan'), 'end')].filter(Boolean).join(' \u2013 ');
            var addr = htmlToText(tagText(body, 'address'));
            var extras = allTags(body, 'Data').map(function (d) {
                var nm = /name\s*=\s*"([^"]*)"/i.exec(d.full);
                var val = htmlToText(tagText(d.inner, 'value'));
                return (nm && val) ? decodeEntities(nm[1]) + ': ' + val : '';
            }).concat(allTags(body, 'SimpleData').map(function (d) {
                var nm = /name\s*=\s*"([^"]*)"/i.exec(d.full);
                var val = htmlToText(stripCdata(d.inner));
                return (nm && val) ? decodeEntities(nm[1]) + ': ' + val : '';
            })).filter(Boolean);
            var pt = null, shape = '';
            var point = tagText(body, 'Point');
            if (point) { var pc = kmlCoords(tagText(point, 'coordinates')); if (pc.length) pt = pc[0]; }
            if (!pt) {
                var line = tagText(body, 'LineString') || tagText(body, 'LinearRing') || tagText(body, 'Polygon') || tagText(body, 'gx:Track');
                var pts = line ? kmlCoords(tagText(line, 'coordinates')) : [];
                if (!pts.length) {
                    // gx:Track stores <gx:coord>lng lat alt</gx:coord>
                    pts = allTags(body, 'coord').map(function (c) { var p = c.inner.trim().split(/\s+/); return { lat: +p[1], lng: +p[0] }; })
                        .filter(function (p) { return isFinite(p.lat) && isFinite(p.lng); });
                }
                if (pts.length) { pt = centroid(pts); shape = (tagText(body, 'Polygon') ? 'area' : 'path') + ' of ' + pts.length + ' points, pinned at its centre'; }
            }
            if (!pt && !addr) { skipped.push({ item: i + 1, reason: 'no coordinates' }); return; }
            specs.push({
                type: normType(opts.defaultType || '', 'location'),
                label: (name || ('Placemark ' + (i + 1))).slice(0, 120),
                sourceType: st, sourceId: 'k' + (i + 1),
                lat: pt ? pt.lat : null, lng: pt ? pt.lng : null, address: addr,
                data: {
                    datetime: when, notes: [desc, shape].concat(extras).filter(Boolean).join(' \u00B7 '),
                    importSource: opts.sourceName || '', importedAt: opts.importedAt || ''
                }
            });
        });
        return { specs: specs, skipped: skipped, located: specs.filter(function (s) { return s.lat != null; }).length, total: marks.length };
    }

    /** GeoJSON text/object -> pin specs. */
    function parseGeoJson(input, opts) {
        opts = opts || {};
        var st = 'import:' + (opts.batchId || 'batch');
        var gj = input;
        if (typeof input === 'string') gj = JSON.parse(input);
        var feats = [];
        if (!gj) feats = [];
        else if (gj.type === 'FeatureCollection') feats = gj.features || [];
        else if (gj.type === 'Feature') feats = [gj];
        else if (gj.type) feats = [{ type: 'Feature', geometry: gj, properties: {} }];
        var specs = [], skipped = [];
        function flat(c, out) {
            if (!Array.isArray(c)) return out;
            if (typeof c[0] === 'number') { if (isFinite(c[0]) && isFinite(c[1])) out.push({ lat: c[1], lng: c[0] }); return out; }
            c.forEach(function (x) { flat(x, out); });
            return out;
        }
        function geomPts(g) {
            if (!g) return [];
            if (g.type === 'GeometryCollection') return (g.geometries || []).reduce(function (a, x) { return a.concat(geomPts(x)); }, []);
            return flat(g.coordinates, []);
        }
        var LABEL_KEYS = ['name', 'title', 'label', 'Name', 'NAME', 'id', 'ID'];
        var NOTE_KEYS = ['description', 'desc', 'notes', 'note', 'comment', 'Description'];
        var TIME_KEYS = ['time', 'timestamp', 'datetime', 'date', 'when', 'Time', 'Timestamp', 'DateTime', 'Date'];
        var ADDR_KEYS = ['address', 'Address', 'ADDRESS', 'location', 'Location'];
        function pick(props, keys) { for (var i = 0; i < keys.length; i++) if (props[keys[i]] != null && props[keys[i]] !== '') return { k: keys[i], v: props[keys[i]] }; return null; }
        feats.forEach(function (f, i) {
            var props = (f && f.properties) || {};
            var g = f && f.geometry;
            var pts = geomPts(g);
            if (!pts.length) { skipped.push({ item: i + 1, reason: 'no coordinates' }); return; }
            var single = g && g.type === 'Point';
            var pt = single ? pts[0] : centroid(pts);
            var lb = pick(props, LABEL_KEYS), nt = pick(props, NOTE_KEYS), tm = pick(props, TIME_KEYS), ad = pick(props, ADDR_KEYS);
            var used = {}; [lb, nt, tm, ad].forEach(function (x) { if (x) used[x.k] = true; });
            var extras = Object.keys(props).filter(function (k) {
                var v = props[k];
                return !used[k] && v != null && v !== '' && typeof v !== 'object';
            }).slice(0, 12).map(function (k) { return k + ': ' + props[k]; });
            var shape = single ? '' : (String(g.type).replace(/^Multi/, 'multi-').toLowerCase() + ' of ' + pts.length + ' points, pinned at its centre');
            specs.push({
                type: normType(props.type || props.category || opts.defaultType || '', opts.defaultType || 'location'),
                label: String(lb ? lb.v : ('Feature ' + (i + 1))).slice(0, 120),
                sourceType: st, sourceId: 'g' + (i + 1),
                lat: Math.round(pt.lat * 1e7) / 1e7, lng: Math.round(pt.lng * 1e7) / 1e7,
                address: ad && typeof ad.v === 'string' ? ad.v : '',
                data: {
                    datetime: tm ? String(tm.v) : '', notes: [nt ? String(nt.v) : '', shape].concat(extras).filter(Boolean).join(' \u00B7 '),
                    importSource: opts.sourceName || '', importedAt: opts.importedAt || ''
                }
            });
        });
        return { specs: specs, skipped: skipped, located: specs.length, total: feats.length };
    }

    function fileKind(name) {
        var n = String(name || '').toLowerCase();
        if (/\.(csv|tsv|txt)$/.test(n)) return 'delimited';
        if (/\.xls[xm]$/.test(n)) return 'xlsx';
        if (/\.xls$/.test(n)) return 'xls';
        if (/\.kml$/.test(n)) return 'kml';
        if (/\.kmz$/.test(n)) return 'kmz';
        if (/\.(geo)?json$/.test(n)) return 'geojson';
        return '';
    }

    function newBatchId(now) {
        var t = (now != null ? now : Date.now());
        return t.toString(36) + Math.random().toString(36).slice(2, 6);
    }

    return {
        FIELDS: FIELDS, TYPES: TYPES,
        guessColumns: guessColumns, parseCoord: parseCoord, parseLatLng: parseLatLng,
        detectDelimiter: detectDelimiter, parseDelimited: parseDelimited, headerRowIndex: headerRowIndex,
        normType: normType, rowsToSpecs: rowsToSpecs,
        parseKml: parseKml, parseGeoJson: parseGeoJson, htmlToText: htmlToText,
        fileKind: fileKind, newBatchId: newBatchId
    };
});

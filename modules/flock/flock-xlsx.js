/* ============================================================
   FLOCK — minimal browser XLSX reader  (VIPER)

   Why this exists
   ---------------
   Flock exports arrive as .csv OR .xlsx, and detectives routinely open a
   CSV in Excel and re-save it as a workbook before filing it. VIPER's
   shared zip-reader.js is a MAIN-PROCESS module (require('fs'),
   node-stream-zip) so it cannot be used from the renderer, and vendoring
   SheetJS would add ~900 KB to the installer for one rectangular sheet.

   An .xlsx is a ZIP of XML. Electron 28 ships Chromium 120, which has a
   native DecompressionStream('deflate-raw'), so a compact reader is all
   that is required. Scope is deliberately narrow: read a flat worksheet
   into an array of string rows, exactly matching what FlockParser.parseCsv
   produces, so both formats converge on one code path.

   Deliberately NOT supported: formulas (we read cached values), charts,
   pivot tables, merged-cell expansion, and the legacy binary .xls (BIFF)
   format — .xls callers get a clear "save as .xlsx or .csv" message.

   The one real correctness hazard is dates. Excel stores them as floating
   point serials with no timezone, plus a famous 1900 leap-year bug, plus
   an alternate 1904 epoch used by legacy Mac workbooks. All three are
   handled below and covered by tests.
   ============================================================ */
(function (root, factory) {
    'use strict';
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.FlockXlsx = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // ── ZIP ──────────────────────────────────────────────────────────
    var SIG_EOCD  = 0x06054b50;
    var SIG_CD    = 0x02014b50;
    var SIG_LOCAL = 0x04034b50;
    var SIG_Z64_LOC = 0x07064b50;
    var SIG_Z64_EOCD = 0x06064b50;

    function findEocd(dv) {
        // The EOCD sits at the end, but a trailing comment (max 65535) may
        // follow it, so scan backwards over the largest legal window.
        var len = dv.byteLength;
        var max = Math.min(len, 65535 + 22);
        for (var i = 22; i <= max; i++) {
            var at = len - i;
            if (at < 0) break;
            if (dv.getUint32(at, true) === SIG_EOCD) return at;
        }
        return -1;
    }

    function parseCentralDirectory(buf) {
        var dv = new DataView(buf);
        var eocd = findEocd(dv);
        if (eocd < 0) throw new Error('Not a valid .xlsx file (no ZIP end-of-directory record).');

        var entryCount = dv.getUint16(eocd + 10, true);
        var cdSize     = dv.getUint32(eocd + 12, true);
        var cdOffset   = dv.getUint32(eocd + 16, true);

        // ZIP64 — rare for a spreadsheet, but a 100k-row export can trip it.
        if (cdOffset === 0xFFFFFFFF || entryCount === 0xFFFF || cdSize === 0xFFFFFFFF) {
            var locAt = eocd - 20;
            if (locAt >= 0 && dv.getUint32(locAt, true) === SIG_Z64_LOC) {
                var z64At = Number(dv.getBigUint64(locAt + 8, true));
                if (dv.getUint32(z64At, true) === SIG_Z64_EOCD) {
                    entryCount = Number(dv.getBigUint64(z64At + 32, true));
                    cdSize     = Number(dv.getBigUint64(z64At + 40, true));
                    cdOffset   = Number(dv.getBigUint64(z64At + 48, true));
                }
            }
        }

        var entries = [];
        var p = cdOffset;
        for (var i = 0; i < entryCount; i++) {
            if (p + 46 > buf.byteLength || dv.getUint32(p, true) !== SIG_CD) break;
            var method   = dv.getUint16(p + 10, true);
            var compSize = dv.getUint32(p + 20, true);
            var rawSize  = dv.getUint32(p + 24, true);
            var nameLen  = dv.getUint16(p + 28, true);
            var extraLen = dv.getUint16(p + 30, true);
            var cmtLen   = dv.getUint16(p + 32, true);
            var localAt  = dv.getUint32(p + 42, true);
            var name = new TextDecoder('utf-8').decode(new Uint8Array(buf, p + 46, nameLen));

            // ZIP64 extended information extra field (0x0001) overrides the
            // 0xFFFFFFFF placeholders above.
            if (compSize === 0xFFFFFFFF || rawSize === 0xFFFFFFFF || localAt === 0xFFFFFFFF) {
                var ex = p + 46 + nameLen, exEnd = ex + extraLen;
                while (ex + 4 <= exEnd) {
                    var hid = dv.getUint16(ex, true), hsz = dv.getUint16(ex + 2, true);
                    if (hid === 0x0001) {
                        var q = ex + 4;
                        if (rawSize === 0xFFFFFFFF)  { rawSize  = Number(dv.getBigUint64(q, true)); q += 8; }
                        if (compSize === 0xFFFFFFFF) { compSize = Number(dv.getBigUint64(q, true)); q += 8; }
                        if (localAt === 0xFFFFFFFF)  { localAt  = Number(dv.getBigUint64(q, true)); q += 8; }
                        break;
                    }
                    ex += 4 + hsz;
                }
            }

            entries.push({ name: name, method: method, compSize: compSize, rawSize: rawSize, localAt: localAt });
            p += 46 + nameLen + extraLen + cmtLen;
        }
        return entries;
    }

    function entryDataSlice(buf, entry) {
        var dv = new DataView(buf);
        var at = entry.localAt;
        if (dv.getUint32(at, true) !== SIG_LOCAL) {
            throw new Error('Corrupt .xlsx: bad local header for ' + entry.name);
        }
        // The local header's extra field length can differ from the central
        // directory's, so it must be read here rather than reused.
        var nameLen  = dv.getUint16(at + 26, true);
        var extraLen = dv.getUint16(at + 28, true);
        var start = at + 30 + nameLen + extraLen;
        return buf.slice(start, start + entry.compSize);
    }

    function inflateRaw(ab) {
        if (typeof DecompressionStream === 'undefined') {
            return Promise.reject(new Error(
                'This build cannot expand .xlsx files (DecompressionStream unavailable). Save the export as .csv and load that instead.'));
        }
        var ds = new DecompressionStream('deflate-raw');
        var stream = new Blob([ab]).stream().pipeThrough(ds);
        return new Response(stream).arrayBuffer();
    }

    function readEntryText(buf, entry) {
        if (!entry) return Promise.resolve('');
        var slice = entryDataSlice(buf, entry);
        if (entry.method === 0) return Promise.resolve(new TextDecoder('utf-8').decode(new Uint8Array(slice)));
        if (entry.method !== 8) return Promise.reject(new Error('Unsupported compression in .xlsx (method ' + entry.method + ').'));
        return inflateRaw(slice).then(function (out) {
            return new TextDecoder('utf-8').decode(new Uint8Array(out));
        });
    }

    // ── XML ──────────────────────────────────────────────────────────
    function parseXml(text) {
        var doc = new DOMParser().parseFromString(text, 'application/xml');
        var err = doc.getElementsByTagName('parsererror')[0];
        if (err) throw new Error('Corrupt XML inside the .xlsx: ' + (err.textContent || '').slice(0, 120));
        return doc;
    }
    function tags(node, name) {
        // Namespace-agnostic: OOXML parts declare a default namespace, and
        // some producers prefix elements instead.
        return node.getElementsByTagNameNS('*', name);
    }

    /** Concatenate every <t> under a node, honouring rich-text runs. */
    function textOf(node) {
        if (!node) return '';
        var ts = tags(node, 't');
        if (!ts.length) return node.textContent || '';
        var out = '';
        for (var i = 0; i < ts.length; i++) {
            // Skip <rPh> phonetic hints (Japanese workbooks) — not real content.
            var p = ts[i].parentNode;
            if (p && p.localName === 'rPh') continue;
            out += ts[i].textContent || '';
        }
        return out;
    }

    // ── number formats ───────────────────────────────────────────────
    // Built-in numFmtIds that Excel renders as a date and/or a time.
    var BUILTIN_DATE = { 14: 'd', 15: 'd', 16: 'd', 17: 'd', 18: 't', 19: 't', 20: 't', 21: 't', 22: 'dt',
                         45: 't', 46: 't', 47: 't' };

    /**
     * Classify a format code as containing date and/or time tokens.
     * Quoted literals, escaped chars, colours and conditions are stripped
     * first so a format like [Red]"mar"0.00 is not mistaken for a month.
     */
    function classifyFormat(code) {
        if (!code) return { date: false, time: false };
        var s = String(code)
            .replace(/\[[^\]]*\]/g, '')      // [Red], [$-409], [h]
            .replace(/"[^"]*"/g, '')          // "literal"
            .replace(/\\./g, '')              // escaped char
            .replace(/_./g, '')               // width padding
            .replace(/\*./g, '');             // fill
        // Only look at the first section (positive numbers).
        s = s.split(';')[0].toLowerCase();
        var hasTime = /[hs]/.test(s) || /am\/pm|a\/p/.test(s);
        // 'm' is minutes when adjacent to h/s, month otherwise. 'd' and 'y'
        // are unambiguous, so key the date test on those plus a lone 'm'.
        var hasDate = /[dy]/.test(s) || (/m/.test(s) && !hasTime);
        return { date: hasDate, time: hasTime };
    }

    function buildStyleIndex(stylesXml) {
        var map = {}; // cellXf index -> {date,time}
        if (!stylesXml) return map;
        var doc;
        try { doc = parseXml(stylesXml); } catch (_) { return map; }

        var custom = {};
        var nf = tags(doc, 'numFmt');
        for (var i = 0; i < nf.length; i++) {
            custom[nf[i].getAttribute('numFmtId')] = nf[i].getAttribute('formatCode') || '';
        }

        var cellXfsEl = tags(doc, 'cellXfs')[0];
        if (!cellXfsEl) return map;
        var xfs = tags(cellXfsEl, 'xf');
        for (var x = 0; x < xfs.length; x++) {
            var id = xfs[x].getAttribute('numFmtId');
            if (id == null) { map[x] = { date: false, time: false }; continue; }
            if (Object.prototype.hasOwnProperty.call(custom, id)) {
                map[x] = classifyFormat(custom[id]);
            } else if (Object.prototype.hasOwnProperty.call(BUILTIN_DATE, id)) {
                var kind = BUILTIN_DATE[id];
                map[x] = { date: kind.indexOf('d') !== -1, time: kind.indexOf('t') !== -1 };
            } else {
                map[x] = { date: false, time: false };
            }
        }
        return map;
    }

    // ── date serials ─────────────────────────────────────────────────
    /**
     * Excel serial -> Date (UTC-based; a serial carries no timezone).
     *
     * The 1900 system pretends 1900 was a leap year: serial 60 is the
     * non-existent 1900-02-29, which shifts everything before it by a day.
     * Anchoring at 1899-12-30 is correct for serial 61 onward (i.e. every
     * real-world date), so serials below 60 get an explicit +1 rather than
     * being quietly wrong. Serial 60 itself is the phantom day and lands on
     * 1900-02-28.
     */
    function serialToDate(serial, date1904) {
        var s = Number(serial);
        if (!date1904 && s < 60) s += 1;
        var epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
        // Round to the nearest second: binary floats routinely land on
        // 22:44:25.99997 for what Excel displays as 22:44:26.
        var ms = Math.round(s * 86400) * 1000;
        return new Date(epoch + ms);
    }

    function pad(n, w) { var s = String(n); while (s.length < (w || 2)) s = '0' + s; return s; }

    /** Render a serial the way the parser downstream expects to read it. */
    function formatSerial(serial, fmt, date1904) {
        var d = serialToDate(serial, date1904);
        if (isNaN(d.getTime())) return String(serial);
        var datePart = d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
        var timePart = pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
        if (fmt.date && fmt.time) return datePart + ' ' + timePart;
        if (fmt.time) return timePart;
        return datePart;
    }

    // ── cell refs ────────────────────────────────────────────────────
    /** "BC12" -> 54 (zero-based column index). */
    function colFromRef(ref) {
        var n = 0;
        for (var i = 0; i < ref.length; i++) {
            var c = ref.charCodeAt(i);
            if (c >= 65 && c <= 90) n = n * 26 + (c - 64);
            else if (c >= 97 && c <= 122) n = n * 26 + (c - 96);
            else break;
        }
        return n - 1;
    }

    // ── worksheet ────────────────────────────────────────────────────
    function sheetToRows(xml, shared, styleIdx, date1904) {
        var doc = parseXml(xml);
        var rowEls = tags(doc, 'row');
        var rows = [];
        var maxCols = 0;

        for (var r = 0; r < rowEls.length; r++) {
            var cells = tags(rowEls[r], 'c');
            var row = [];
            for (var i = 0; i < cells.length; i++) {
                var c = cells[i];
                var ref = c.getAttribute('r') || '';
                // Honour the cell reference so gaps (A1, C1 with no B1) keep
                // their column alignment instead of shifting left.
                var col = ref ? colFromRef(ref) : row.length;
                if (col < 0) col = row.length;
                while (row.length < col) row.push('');

                var t = c.getAttribute('t') || 'n';
                var val = '';

                if (t === 'inlineStr') {
                    val = textOf(tags(c, 'is')[0]);
                } else if (t === 's') {
                    var vEl = tags(c, 'v')[0];
                    var idx = vEl ? parseInt(vEl.textContent, 10) : NaN;
                    val = (isFinite(idx) && shared[idx] != null) ? shared[idx] : '';
                } else if (t === 'b') {
                    var bEl = tags(c, 'v')[0];
                    val = (bEl && bEl.textContent === '1') ? 'TRUE' : 'FALSE';
                } else if (t === 'e') {
                    var eEl = tags(c, 'v')[0];
                    val = eEl ? (eEl.textContent || '') : '';
                } else if (t === 'str') {
                    var sEl = tags(c, 'v')[0];
                    val = sEl ? (sEl.textContent || '') : '';
                } else {
                    // numeric — may actually be a formatted date/time
                    var nEl = tags(c, 'v')[0];
                    var raw = nEl ? (nEl.textContent || '') : '';
                    if (raw === '') {
                        val = '';
                    } else {
                        var sAttr = c.getAttribute('s');
                        var fmt = (sAttr != null && styleIdx[parseInt(sAttr, 10)]) || { date: false, time: false };
                        var num = parseFloat(raw);
                        if ((fmt.date || fmt.time) && isFinite(num)) {
                            val = formatSerial(num, fmt, date1904);
                        } else {
                            val = raw;
                        }
                    }
                }
                row[col] = val;
            }
            if (row.length > maxCols) maxCols = row.length;
            rows.push(row);
        }

        // Normalize width and drop fully-blank trailing rows.
        rows.forEach(function (row) { while (row.length < maxCols) row.push(''); });
        while (rows.length && rows[rows.length - 1].every(function (v) { return String(v).trim() === ''; })) rows.pop();
        return rows;
    }

    // ── shared strings ───────────────────────────────────────────────
    function parseSharedStrings(xml) {
        if (!xml) return [];
        var doc = parseXml(xml);
        var sis = tags(doc, 'si');
        var out = new Array(sis.length);
        for (var i = 0; i < sis.length; i++) out[i] = textOf(sis[i]);
        return out;
    }

    // ── workbook ─────────────────────────────────────────────────────
    function findEntry(entries, name) {
        var lower = name.toLowerCase();
        for (var i = 0; i < entries.length; i++) {
            if (entries[i].name.toLowerCase() === lower) return entries[i];
        }
        return null;
    }

    /**
     * Read an .xlsx/.xlsm ArrayBuffer.
     * @returns Promise<{ sheets: [{ name, rows }], date1904: boolean }>
     */
    function readWorkbook(arrayBuffer) {
        var buf = arrayBuffer;
        var entries;
        try {
            entries = parseCentralDirectory(buf);
        } catch (e) {
            return Promise.reject(e);
        }
        if (!entries.length) return Promise.reject(new Error('That file is not a readable .xlsx workbook.'));
        if (!findEntry(entries, 'xl/workbook.xml')) {
            // A .xls renamed to .xlsx, or a ZIP that simply is not a workbook.
            return Promise.reject(new Error(
                'That file is a ZIP but not an Excel workbook (no xl/workbook.xml). If it is a legacy .xls, open it in Excel and "Save As" .xlsx or .csv.'));
        }

        var shared = [], styleIdx = {}, date1904 = false, sheetOrder = [];

        return readEntryText(buf, findEntry(entries, 'xl/sharedStrings.xml'))
            .then(function (xml) { shared = parseSharedStrings(xml); })
            .then(function () { return readEntryText(buf, findEntry(entries, 'xl/styles.xml')); })
            .then(function (xml) { styleIdx = buildStyleIndex(xml); })
            .then(function () { return readEntryText(buf, findEntry(entries, 'xl/workbook.xml')); })
            .then(function (xml) {
                var doc = parseXml(xml);
                var pr = tags(doc, 'workbookPr')[0];
                if (pr) {
                    var d = pr.getAttribute('date1904');
                    date1904 = (d === '1' || d === 'true');
                }
                var sheetEls = tags(doc, 'sheet');
                for (var i = 0; i < sheetEls.length; i++) {
                    sheetOrder.push({
                        name: sheetEls[i].getAttribute('name') || ('Sheet' + (i + 1)),
                        rid: sheetEls[i].getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') ||
                             sheetEls[i].getAttribute('r:id') || ''
                    });
                }
                return readEntryText(buf, findEntry(entries, 'xl/_rels/workbook.xml.rels'));
            })
            .then(function (relsXml) {
                var relMap = {};
                if (relsXml) {
                    try {
                        var rd = parseXml(relsXml);
                        var rs = tags(rd, 'Relationship');
                        for (var i = 0; i < rs.length; i++) {
                            relMap[rs[i].getAttribute('Id')] = rs[i].getAttribute('Target') || '';
                        }
                    } catch (_) {}
                }

                // Resolve each sheet to its part, preserving workbook tab order.
                var jobs = sheetOrder.map(function (s, i) {
                    var target = relMap[s.rid] || ('worksheets/sheet' + (i + 1) + '.xml');
                    target = String(target).replace(/^\/xl\//, '').replace(/^\//, '');
                    var entry = findEntry(entries, 'xl/' + target) ||
                                findEntry(entries, target) ||
                                findEntry(entries, 'xl/worksheets/sheet' + (i + 1) + '.xml');
                    if (!entry) return Promise.resolve({ name: s.name, rows: [] });
                    return readEntryText(buf, entry).then(function (xml) {
                        return { name: s.name, rows: sheetToRows(xml, shared, styleIdx, date1904) };
                    });
                });
                return Promise.all(jobs);
            })
            .then(function (sheets) {
                return { sheets: sheets, date1904: date1904 };
            });
    }

    function isXlsxName(name) { return /\.xls[xm]$/i.test(String(name || '')); }
    function isLegacyXlsName(name) { return /\.xls$/i.test(String(name || '')); }

    return {
        readWorkbook: readWorkbook,
        isXlsxName: isXlsxName,
        isLegacyXlsName: isLegacyXlsName,
        // exported for tests
        _internals: {
            parseCentralDirectory: parseCentralDirectory,
            classifyFormat: classifyFormat,
            serialToDate: serialToDate,
            formatSerial: formatSerial,
            colFromRef: colFromRef,
            sheetToRows: sheetToRows,
            parseSharedStrings: parseSharedStrings,
            buildStyleIndex: buildStyleIndex
        }
    };
});

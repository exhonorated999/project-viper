/* ============================================================
   CyberTip "Uploads by IP" report — pure model + HTML.
   UMD: window.CyberTipIpReport / require('./ct-ip-report.js').

   build(tips) groups every IP in one tip (or every tip in a case):
     uploads  one group per address the files were uploaded from:
              how many uploads, the dates, and every upload's date,
              time, file name and MD5 (oldest first).
     other    one group per login / check-in / other address listed
              for a person, with every time and port.
   panelHtml(report, opts)  dark on-screen panel (Tailwind classes).
   pdfHtml(report, meta)    print document for saveHtmlAsPdf.

   Times are shown exactly as the ESP reported them (normally UTC);
   nothing is converted.
   ============================================================ */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CyberTipIpReport = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // ── helpers ──────────────────────────────────────────────
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    // Sortable YYYYMMDDHHMMSS for "MM-DD-YYYY HH:MM:SS UTC" and "YYYY-MM-DD HH:MM:SS".
    function tsKey(s) {
        s = String(s || '');
        var m = /(\d{2})[-\/](\d{2})[-\/](\d{4})[ T]+(\d{2}):(\d{2}):(\d{2})/.exec(s);
        if (m) return m[3] + m[1] + m[2] + m[4] + m[5] + m[6];
        m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
        if (m) return m.slice(1).join('');
        m = /(\d{2})[-\/](\d{2})[-\/](\d{4})/.exec(s);
        if (m) return m[3] + m[1] + m[2] + '000000';
        m = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
        if (m) return m[1] + m[2] + m[3] + '000000';
        return '';
    }
    function hasClock(s) { return /\d{2}:\d{2}:\d{2}/.test(String(s || '')); }
    function fmtDate(k) { return k ? k.slice(4, 6) + '/' + k.slice(6, 8) + '/' + k.slice(0, 4) : ''; }
    function fmtTime(k) { return k ? k.slice(8, 10) + ':' + k.slice(10, 12) + ':' + k.slice(12, 14) : ''; }
    // Trailing zone the ESP wrote ("UTC", "PDT", "Z", "+00:00").
    function zoneOf(s) {
        var m = /\d{2}:\d{2}:\d{2}(?:\.\d+)?\s*([A-Za-z]{1,5}|[+-]\d{2}:?\d{2})\s*$/.exec(String(s || '').trim());
        if (!m) return '';
        return m[1] === 'Z' ? 'UTC' : m[1].toUpperCase();
    }
    function addrKey(a) { return String(a || '').trim().toLowerCase(); }
    function tipLabel(t, i) { return (t && t.reportNumber) ? String(t.reportNumber) : ('Tip ' + (i + 1)); }
    function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
    function sortEvents(list) {
        list.sort(function (a, b) {
            if (a.key === b.key) return 0;
            if (!a.key) return 1;
            if (!b.key) return -1;
            return a.key < b.key ? -1 : 1;
        });
    }
    function mkEvent(ts) {
        var k = tsKey(ts);
        var z = zoneOf(ts);
        return {
            timestamp: String(ts || ''), key: k,
            date: fmtDate(k), time: hasClock(ts) ? fmtTime(k) : '', zone: z
        };
    }

    // ── model ────────────────────────────────────────────────
    function build(tips, opts) {
        opts = opts || {};
        var list = (Array.isArray(tips) ? tips : [tips]).filter(Boolean);
        var uploads = new Map(), other = new Map();
        var geo = new Map();          // addrKey -> {isp, city, region, country}
        var noIpFiles = [];
        var fileSet = new Set();
        var tipRows = [];

        function group(map, address) {
            var k = addrKey(address);
            var g = map.get(k);
            if (!g) { g = { address: String(address).trim(), events: [], _seen: new Map() }; map.set(k, g); }
            return g;
        }
        function push(g, sig, ev, tip) {
            var prior = g._seen.get(sig);
            if (prior) { if (prior.tips.indexOf(tip) < 0) prior.tips.push(tip); return false; }
            ev.tips = [tip];
            g._seen.set(sig, ev);
            g.events.push(ev);
            return true;
        }

        // Pass 1: geo + file uploads (every tip) so person-listed uploads in
        // pass 2 can be matched against them.
        list.forEach(function (t, ti) {
            var tip = tipLabel(t, ti);
            var files = (t.uploadedFiles || []).filter(Boolean);
            var row = { reportNumber: tip, esp: (t.esp && t.esp.name) || '', receivedDate: t.receivedDate || '', files: files.length, uploads: 0 };
            tipRows.push(row);
            (t.ipGeoLookup || []).forEach(function (gl) {
                if (!gl || !gl.address) return;
                var k = addrKey(gl.address);
                if (!geo.has(k)) geo.set(k, { isp: gl.isp || '', city: gl.city || '', region: gl.region || '', country: gl.country || '', type: gl.type || '' });
            });
            var arin = t.arinResults || {};
            Object.keys(arin).forEach(function (a) {
                var r = arin[a], k = addrKey(a);
                if (!r) return;
                var cur = geo.get(k);
                if (!cur) geo.set(k, { isp: r.provider || r.org || '', city: '', region: '', country: r.country || '', type: '' });
                else if (!cur.isp) cur.isp = r.provider || r.org || '';
            });
            files.forEach(function (f) {
                var md5 = String(f.md5 || '').toLowerCase();
                var name = f.filename || '';
                fileSet.add(md5 || ('n:' + name));
                var ips = (f.sourceIps || []).filter(function (s) { return s && String(s.address || '').trim(); });
                if (!ips.length) { noIpFiles.push({ file: name, md5: md5, tip: tip }); return; }
                ips.forEach(function (s) {
                    var g = group(uploads, s.address);
                    var ev = mkEvent(s.timestamp);
                    ev.file = name; ev.md5 = md5;
                    ev.event = s.event || 'Upload';
                    ev.categorization = f.categorization || f.espCategorization || '';
                    if (push(g, [ev.key || ev.timestamp, md5, name].join('|'), ev, tip)) row.uploads++;
                });
            });
        });

        // Pass 2: person IPs. An "Upload" entry that matches a file upload at
        // the same address and second is the same event; one with no match
        // still counts as an upload, flagged as not tied to a file.
        list.forEach(function (t, ti) {
            var tip = tipLabel(t, ti);
            (t.persons || []).forEach(function (p) {
                (p && p.ipAddresses || []).forEach(function (ip) {
                    if (!ip || !String(ip.address || '').trim()) return;
                    var ev = mkEvent(ip.timestamp);
                    ev.port = ip.port ? String(ip.port) : '';
                    ev.role = (p && p.role) || '';
                    var type = String(ip.type || '').trim();
                    if (/upload/i.test(type)) {
                        var ug = uploads.get(addrKey(ip.address));
                        var dup = ug && ev.key && ug.events.some(function (e) { return e.key === ev.key; });
                        if (dup) return;
                        var g = group(uploads, ip.address);
                        ev.file = ''; ev.md5 = ''; ev.event = type; ev.noFile = true;
                        push(g, [ev.key || ev.timestamp, 'person', ev.port].join('|'), ev, tip);
                        return;
                    }
                    ev.type = type || 'Unspecified';
                    push(group(other, ip.address), [ev.key || ev.timestamp, ev.type.toLowerCase(), ev.port, ev.role].join('|'), ev, tip);
                });
            });
        });

        function finish(map, kind) {
            var out = [];
            map.forEach(function (g, k) {
                delete g._seen;
                sortEvents(g.events);
                var dated = g.events.filter(function (e) { return e.key; });
                g.count = g.events.length;
                g.first = dated.length ? dated[0] : null;
                g.last = dated.length ? dated[dated.length - 1] : null;
                var dates = [], seenD = new Set(), tipsSet = [];
                g.events.forEach(function (e) {
                    if (e.date && !seenD.has(e.date)) { seenD.add(e.date); dates.push(e.date); }
                    e.tips.forEach(function (x) { if (tipsSet.indexOf(x) < 0) tipsSet.push(x); });
                });
                g.dates = dates;
                g.tips = tipsSet;
                g.geo = geo.get(k) || null;
                if (kind === 'upload') {
                    var fs = new Set();
                    g.events.forEach(function (e) { if (e.md5 || e.file) fs.add(e.md5 || ('n:' + e.file)); });
                    g.fileCount = fs.size;
                    g.otherCount = other.has(k) ? other.get(k).events.length : 0;
                } else {
                    var types = new Map();
                    g.events.forEach(function (e) { types.set(e.type, (types.get(e.type) || 0) + 1); });
                    g.types = Array.from(types, function (x) { return { type: x[0], count: x[1] }; })
                        .sort(function (a, b) { return b.count - a.count || (a.type < b.type ? -1 : 1); });
                    g.uploadCount = uploads.has(k) ? uploads.get(k).events.length : 0;
                }
                out.push(g);
            });
            out.sort(function (a, b) {
                if (b.count !== a.count) return b.count - a.count;
                var ak = a.first ? a.first.key : '~', bk = b.first ? b.first.key : '~';
                if (ak !== bk) return ak < bk ? -1 : 1;
                return a.address < b.address ? -1 : (a.address > b.address ? 1 : 0);
            });
            return out;
        }
        // other first: upload groups read other.events.length for cross-refs,
        // which is unaffected by finishing, but keep the order explicit.
        var otherOut = finish(other, 'other');
        var upOut = finish(uploads, 'upload');

        var zones = new Set();
        upOut.concat(otherOut).forEach(function (g) { g.events.forEach(function (e) { if (e.zone) zones.add(e.zone); }); });

        return {
            scope: opts.scope || (list.length > 1 ? 'case' : 'tip'),
            tips: tipRows,
            uploads: upOut,
            other: otherOut,
            noIpFiles: noIpFiles,
            zones: Array.from(zones),
            totals: {
                tips: list.length,
                files: fileSet.size,
                uploadIps: upOut.length,
                uploads: upOut.reduce(function (n, g) { return n + g.count; }, 0),
                otherIps: otherOut.length,
                otherEvents: otherOut.reduce(function (n, g) { return n + g.count; }, 0),
                noIpFiles: noIpFiles.length
            }
        };
    }

    function geoText(g) {
        if (!g) return '';
        var place = [g.city, g.region, g.country].filter(Boolean).join(', ');
        return [g.isp, place].filter(Boolean).join(' · ');
    }
    function timeText(e) { return e.time ? e.time + (e.zone ? ' ' + e.zone : '') : ''; }
    function stampText(e) { return e ? (e.date + (e.time ? ' ' + timeText(e) : '')) : ''; }
    function typesText(g) { return (g.types || []).map(function (t) { return t.type + ' \u00d7' + t.count; }).join(', '); }
    function datesText(g, max) {
        var d = g.dates || [];
        if (!max || d.length <= max) return d.join(', ');
        return d.slice(0, max).join(', ') + ' \u2026 +' + (d.length - max) + ' more';
    }

    function fileName(report, meta) {
        meta = meta || {};
        var which = report.scope === 'case' ? 'AllTips' : ('CT' + ((report.tips[0] && report.tips[0].reportNumber) || ''));
        var day = meta.day || new Date().toISOString().slice(0, 10);
        return ('CyberTip-IP-Report_' + which + '_' + (meta.caseNumber || 'case') + '_' + day + '.pdf').replace(/[^\w.\-]+/g, '_');
    }

    function titleFor(report) {
        if (report.scope === 'case') return 'All CyberTips in this case (' + report.totals.tips + ')';
        var t = report.tips[0] || {};
        return 'CT# ' + (t.reportNumber || 'Unknown') + (t.esp ? ' \u00b7 ' + t.esp : '');
    }

    // ── on-screen panel (dark, Tailwind) ─────────────────────
    var SCREEN_ROW_CAP = 500;

    function panelHtml(report, opts) {
        opts = opts || {};
        var scope = report.scope;
        var multi = report.totals.tips > 1;
        var T = report.totals;
        var btn = 'px-3 py-1.5 text-xs rounded border transition-colors flex items-center gap-1.5';
        var head =
            '<div class="flex items-start justify-between gap-3 mb-4 flex-wrap">' +
                '<div>' +
                    '<h3 class="text-xl font-bold text-white">Uploads by IP</h3>' +
                    '<div class="text-xs text-gray-400 mt-0.5">' +
                        esc(plural(T.uploadIps, 'upload IP')) + ' \u00b7 ' + esc(plural(T.uploads, 'upload')) + ' \u00b7 ' + esc(plural(T.files, 'file')) +
                        (T.otherIps ? ' \u00b7 ' + esc(plural(T.otherIps, 'login/other IP')) : '') +
                        (multi ? ' \u00b7 across ' + esc(plural(T.tips, 'tip')) : '') +
                        '. Times are as the ESP reported them' + (report.zones.length === 1 ? ' (' + esc(report.zones[0]) + ')' : '') + '.' +
                    '</div>' +
                '</div>' +
                '<div class="flex items-center gap-2 flex-wrap">' +
                    '<input type="search" placeholder="Find IP or file name" oninput="CTIpReportUI.filter(this.value)" class="ct-ipr-find px-2.5 py-1.5 text-xs rounded border border-gray-600 bg-gray-900/80 text-gray-200 placeholder-gray-500 focus:outline-none focus:border-viper-cyan/60" style="width:200px;color-scheme:dark">' +
                    '<button type="button" onclick="CTIpReportUI.expand(true)" class="' + btn + ' border-gray-600 text-gray-300 hover:text-white hover:border-gray-400">Expand all</button>' +
                    '<button type="button" onclick="CTIpReportUI.expand(false)" class="' + btn + ' border-gray-600 text-gray-300 hover:text-white hover:border-gray-400">Collapse all</button>' +
                    '<button type="button" data-ct-ipr-save="ev" onclick="CTIpReportUI.save(\'' + scope + '\', true)" class="' + btn + ' bg-viper-orange/20 text-viper-orange border-viper-orange/50 hover:bg-viper-orange/30" title="Build the PDF and file it in this case\'s Evidence">' +
                        '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3M3 17V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>' +
                        'Save PDF to Evidence</button>' +
                    '<button type="button" data-ct-ipr-save="copy" onclick="CTIpReportUI.save(\'' + scope + '\', false)" class="' + btn + ' bg-viper-cyan/10 text-viper-cyan border-viper-cyan/40 hover:bg-viper-cyan/20" title="Save the PDF somewhere else">Save a copy\u2026</button>' +
                '</div>' +
            '</div>';

        if (!T.uploadIps && !T.otherIps) {
            return head + '<div class="text-sm text-gray-400 py-6 text-center">No IP addresses were found in ' + (multi ? 'these tips' : 'this tip') + '.</div>' +
                (T.noIpFiles ? '<div class="text-xs text-gray-500 text-center">' + esc(plural(T.noIpFiles, 'uploaded file')) + ' listed with no upload IP.</div>' : '');
        }

        function rowsTable(g, cols, rowFn) {
            var rows = g.events.slice(0, SCREEN_ROW_CAP).map(rowFn).join('');
            var more = g.events.length > SCREEN_ROW_CAP
                ? '<div class="text-xs text-gray-500 mt-2">Showing the first ' + SCREEN_ROW_CAP + ' of ' + g.events.length.toLocaleString() + '. The PDF lists every one.</div>' : '';
            return '<div class="overflow-x-auto mt-3"><table class="w-full text-xs">' +
                '<thead><tr class="text-left text-gray-400 border-b border-gray-700/60">' +
                cols.map(function (c) { return '<th class="py-1.5 pr-3 font-semibold whitespace-nowrap">' + c + '</th>'; }).join('') +
                '</tr></thead><tbody>' + rows + '</tbody></table></div>' + more;
        }
        var td = 'py-1 pr-3 align-top';

        function searchText(g) {
            var parts = [g.address];
            for (var i = 0; i < g.events.length && i < 2000; i++) if (g.events[i].file) parts.push(g.events[i].file);
            return esc(parts.join(' ').toLowerCase().slice(0, 20000));
        }

        var up = report.uploads.map(function (g) {
            var gt = geoText(g.geo);
            var cols = ['Date', 'Time', 'File name', 'MD5'].concat(multi ? ['CT#'] : []);
            var table = rowsTable(g, cols, function (e) {
                return '<tr class="border-b border-gray-800/60">' +
                    '<td class="' + td + ' text-gray-200 whitespace-nowrap">' + esc(e.date || '\u2014') + '</td>' +
                    '<td class="' + td + ' text-gray-300 whitespace-nowrap">' + esc(timeText(e)) + '</td>' +
                    '<td class="' + td + ' text-white break-all">' + (e.noFile ? '<span class="text-gray-500 italic">Upload listed for the account, not tied to a file</span>' : esc(e.file || '\u2014')) + '</td>' +
                    '<td class="' + td + ' text-gray-400 font-mono break-all">' + esc(e.md5) + '</td>' +
                    (multi ? '<td class="' + td + ' text-viper-orange whitespace-nowrap">' + esc(e.tips.join(', ')) + '</td>' : '') +
                '</tr>';
            });
            return '<details class="ct-ipr-group rounded-lg border border-gray-700/50 bg-black/20 px-4 py-3" data-ct-ipr-text="' + searchText(g) + '">' +
                '<summary class="cursor-pointer list-none">' +
                    '<div class="flex items-center gap-2 flex-wrap">' +
                        '<span class="text-xs font-bold text-gray-400 uppercase">IP</span>' +
                        '<span class="text-white font-semibold font-mono break-all">' + esc(g.address) + '</span>' +
                        '<span class="text-xs px-1.5 py-0.5 rounded border bg-purple-500/20 text-purple-300 border-purple-500/40">used ' + esc(plural(g.count, 'time')) + '</span>' +
                        '<span class="text-xs px-1.5 py-0.5 rounded border bg-yellow-500/15 text-yellow-300 border-yellow-500/40">' + esc(plural(g.fileCount, 'file')) + '</span>' +
                        (g.otherCount ? '<span class="text-xs px-1.5 py-0.5 rounded border bg-cyan-500/15 text-cyan-300 border-cyan-500/40" title="This address also appears in the login / other section">also ' + esc(plural(g.otherCount, 'login/other entry', 'login/other entries')) + '</span>' : '') +
                        (multi && g.tips.length ? '<span class="text-xs px-1.5 py-0.5 rounded border bg-viper-orange/15 text-viper-orange border-viper-orange/40">CT# ' + esc(g.tips.join(', ')) + '</span>' : '') +
                        (gt ? '<span class="text-xs text-gray-400">' + esc(gt) + '</span>' : '') +
                    '</div>' +
                    '<div class="text-xs text-gray-300 mt-1.5"><span class="text-gray-500">Uploads:</span> ' + esc(datesText(g, 40) || 'no dates listed') + '</div>' +
                '</summary>' + table +
            '</details>';
        }).join('');

        var oth = report.other.map(function (g) {
            var gt = geoText(g.geo);
            var cols = ['Date', 'Time', 'Type', 'Port', 'Role'].concat(multi ? ['CT#'] : []);
            var table = rowsTable(g, cols, function (e) {
                return '<tr class="border-b border-gray-800/60">' +
                    '<td class="' + td + ' text-gray-200 whitespace-nowrap">' + esc(e.date || '\u2014') + '</td>' +
                    '<td class="' + td + ' text-gray-300 whitespace-nowrap">' + esc(timeText(e)) + '</td>' +
                    '<td class="' + td + ' text-white">' + esc(e.type) + '</td>' +
                    '<td class="' + td + ' text-gray-400 font-mono">' + esc(e.port) + '</td>' +
                    '<td class="' + td + ' text-gray-400">' + esc(e.role) + '</td>' +
                    (multi ? '<td class="' + td + ' text-viper-orange whitespace-nowrap">' + esc(e.tips.join(', ')) + '</td>' : '') +
                '</tr>';
            });
            return '<details class="ct-ipr-group rounded-lg border border-gray-700/50 bg-black/20 px-4 py-3" data-ct-ipr-text="' + esc(g.address.toLowerCase()) + '">' +
                '<summary class="cursor-pointer list-none">' +
                    '<div class="flex items-center gap-2 flex-wrap">' +
                        '<span class="text-xs font-bold text-gray-400 uppercase">IP</span>' +
                        '<span class="text-white font-semibold font-mono break-all">' + esc(g.address) + '</span>' +
                        '<span class="text-xs px-1.5 py-0.5 rounded border bg-cyan-500/15 text-cyan-300 border-cyan-500/40">seen ' + esc(plural(g.count, 'time')) + '</span>' +
                        (g.uploadCount ? '<span class="text-xs px-1.5 py-0.5 rounded border bg-purple-500/20 text-purple-300 border-purple-500/40">also an upload IP</span>' : '') +
                        (multi && g.tips.length ? '<span class="text-xs px-1.5 py-0.5 rounded border bg-viper-orange/15 text-viper-orange border-viper-orange/40">CT# ' + esc(g.tips.join(', ')) + '</span>' : '') +
                        (gt ? '<span class="text-xs text-gray-400">' + esc(gt) + '</span>' : '') +
                    '</div>' +
                    '<div class="text-xs text-gray-300 mt-1.5"><span class="text-gray-500">' + esc(typesText(g)) + '</span>' +
                        (g.first ? ' \u00b7 <span class="text-gray-500">first</span> ' + esc(stampText(g.first)) + (g.last && g.last !== g.first ? ' \u00b7 <span class="text-gray-500">last</span> ' + esc(stampText(g.last)) : '') : '') +
                    '</div>' +
                '</summary>' + table +
            '</details>';
        }).join('');

        var noIp = report.noIpFiles.length
            ? '<details class="rounded-lg border border-gray-700/50 bg-black/20 px-4 py-3 mt-3"><summary class="cursor-pointer text-xs text-gray-300">' +
                esc(plural(report.noIpFiles.length, 'uploaded file')) + ' listed with no upload IP</summary>' +
                '<div class="mt-2 space-y-1 text-xs">' + report.noIpFiles.slice(0, SCREEN_ROW_CAP).map(function (f) {
                    return '<div class="flex gap-3"><span class="text-white break-all">' + esc(f.file || '\u2014') + '</span><span class="text-gray-500 font-mono break-all">' + esc(f.md5) + '</span>' + (multi ? '<span class="text-viper-orange whitespace-nowrap">CT# ' + esc(f.tip) + '</span>' : '') + '</div>';
                }).join('') + '</div></details>'
            : '';

        return head +
            '<div class="ct-ipr-body">' +
            (report.uploads.length
                ? '<div class="text-sm font-semibold text-gray-200 mb-2">Upload IP addresses <span class="text-gray-500 font-normal">(' + report.uploads.length + ')</span></div><div class="space-y-2">' + up + '</div>'
                : '<div class="text-sm text-gray-400">No upload IPs listed.</div>') +
            noIp +
            (report.other.length
                ? '<div class="text-sm font-semibold text-gray-200 mt-6 mb-2">Login and other IP activity <span class="text-gray-500 font-normal">(' + report.other.length + ')</span></div><div class="space-y-2">' + oth + '</div>'
                : '') +
            '<div class="ct-ipr-none hidden text-sm text-gray-400 py-4 text-center">Nothing matches that search.</div>' +
            '</div>';
    }

    // ── PDF document ─────────────────────────────────────────
    var PDF_CSS =

        '*{box-sizing:border-box}' +
        'body{margin:0;font-family:"Segoe UI",Arial,sans-serif;color:#1d232b;font-size:9pt;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
        '.hdr{display:flex;align-items:center;gap:14px;padding:12px 16px;background:#11151b;color:#fff;border-radius:6px;border-bottom:3px solid #ff6b1a}' +
        '.hdr img{width:46px;height:46px;object-fit:contain}' +
        '.hdr .brand{font-size:8pt;letter-spacing:.18em;color:#22d3ee;font-weight:700}' +
        '.hdr h1{margin:2px 0 0;font-size:16pt;font-weight:700}' +
        '.hdr .sub{font-size:9.5pt;color:#c9d1d9;margin-top:2px}' +
        '.meta{display:grid;grid-template-columns:repeat(4,1fr);gap:6px 14px;margin:10px 2px 0;font-size:8.5pt}' +
        '.meta .k{color:#6b7480;font-size:7.5pt;text-transform:uppercase;letter-spacing:.06em}' +
        '.meta .v{font-weight:600;word-break:break-word}' +
        '.stats{display:flex;gap:8px;margin:12px 0 4px}' +
        '.stat{flex:1;border:1px solid #d7dce2;border-radius:5px;padding:6px 10px;border-top:3px solid #ff6b1a}' +
        '.stat.c{border-top-color:#0ea5c6}' +
        '.stat .n{font-size:15pt;font-weight:700}.stat .l{font-size:7.5pt;color:#59626d;text-transform:uppercase;letter-spacing:.05em}' +
        'h2{font-size:12pt;margin:18px 0 6px;padding-bottom:4px;border-bottom:2px solid #ff6b1a;break-after:avoid}' +
        'h2.c{border-bottom-color:#0ea5c6}' +
        '.note{font-size:8pt;color:#59626d;margin:2px 0 8px}' +
        'table{width:100%;border-collapse:collapse;font-size:8pt}' +
        'thead{display:table-header-group}' +
        'th{text-align:left;background:#eef1f4;color:#3a434d;font-weight:600;padding:4px 6px;border-bottom:1px solid #c9d0d7;white-space:nowrap}' +
        'td{padding:3px 6px;border-bottom:1px solid #e6e9ed;vertical-align:top}' +
        'tr{break-inside:avoid}' +
        '.mono{font-family:Consolas,"Courier New",monospace}' +
        '.wrap{word-break:break-all}' +
        '.nw{white-space:nowrap}' +
        '.ip{margin:12px 0 4px;break-inside:avoid-page}' +
        '.ip .t{font-size:10.5pt;font-weight:700;break-after:avoid}' +
        '.ip .t .addr{font-family:Consolas,"Courier New",monospace}' +
        '.ip .t .cnt{font-weight:600;color:#c2410c}' +
        '.ip .t .cnt.c{color:#0e7490}' +
        '.ip .s{font-size:8.5pt;color:#3a434d;margin:2px 0 4px;break-after:avoid}' +
        '.ip .s b{color:#1d232b}' +
        '.muted{color:#6b7480}.it{font-style:italic}' +
        '.tip{color:#c2410c;white-space:nowrap}' +
        '.foot{margin-top:16px;font-size:7.5pt;color:#6b7480;border-top:1px solid #d7dce2;padding-top:6px}';

    function pdfHtml(report, meta) {
        meta = meta || {};
        var multi = report.totals.tips > 1;
        var T = report.totals;
        var zoneNote = report.zones.length === 1 ? report.zones[0] : (report.zones.length ? 'as marked' : 'as reported');
        var tipNos = report.tips.map(function (t) { return t.reportNumber; }).join(', ');

        function metaCell(k, v) { return v ? '<div><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div></div>' : ''; }
        var head =
            '<div class="hdr">' + (meta.logo ? '<img src="' + esc(meta.logo) + '" alt="">' : '') +
                '<div><div class="brand">V.I.P.E.R.</div><h1>CyberTip Uploads by IP Address</h1><div class="sub">' + esc(titleFor(report)) + '</div></div>' +
            '</div>' +
            '<div class="meta">' +
                metaCell('Case', meta.caseNumber) +
                metaCell('Case title', meta.caseTitle) +
                metaCell(multi ? 'CyberTips' : 'CyberTip', tipNos) +
                metaCell('Generated', meta.generated) +
                metaCell('Prepared by', meta.preparedBy) +
                metaCell('Times', 'As reported by the ESP (' + zoneNote + ')') +
            '</div>' +
            '<div class="stats">' +
                '<div class="stat"><div class="n">' + T.uploadIps + '</div><div class="l">Upload IPs</div></div>' +
                '<div class="stat"><div class="n">' + T.uploads + '</div><div class="l">Uploads</div></div>' +
                '<div class="stat"><div class="n">' + T.files + '</div><div class="l">Files</div></div>' +
                '<div class="stat c"><div class="n">' + T.otherIps + '</div><div class="l">Login / other IPs</div></div>' +
                '<div class="stat c"><div class="n">' + T.otherEvents + '</div><div class="l">Login / other entries</div></div>' +
            '</div>';

        // Index: one line per upload IP.
        var index = report.uploads.length
            ? '<h2>Summary of upload IP addresses</h2><table><thead><tr><th>IP address</th><th>Uploads</th><th>Files</th><th>First upload</th><th>Last upload</th><th>ISP / location</th>' + (multi ? '<th>CT#</th>' : '') + '</tr></thead><tbody>' +
                report.uploads.map(function (g) {
                    return '<tr><td class="mono wrap">' + esc(g.address) + '</td><td>' + g.count + '</td><td>' + g.fileCount + '</td>' +
                        '<td class="nw">' + esc(stampText(g.first)) + '</td><td class="nw">' + esc(stampText(g.last)) + '</td>' +
                        '<td>' + esc(geoText(g.geo)) + '</td>' + (multi ? '<td class="tip">' + esc(g.tips.join(', ')) + '</td>' : '') + '</tr>';
                }).join('') + '</tbody></table>'
            : '';

        var up = report.uploads.map(function (g) {
            var gt = geoText(g.geo);
            return '<div class="ip">' +
                '<div class="t">IP: <span class="addr">' + esc(g.address) + '</span> <span class="cnt">(used ' + esc(plural(g.count, 'time')) + ')</span></div>' +
                '<div class="s"><b>Uploads:</b> ' + esc(datesText(g) || 'no dates listed') + '</div>' +
                '<div class="s">' + esc(plural(g.fileCount, 'file')) +
                    (gt ? ' \u00b7 ' + esc(gt) : '') +
                    (g.otherCount ? ' \u00b7 also ' + esc(plural(g.otherCount, 'login/other entry', 'login/other entries')) + ' (see section 2)' : '') +
                    (multi ? ' \u00b7 CT# ' + esc(g.tips.join(', ')) : '') + '</div>' +
                '<table><thead><tr><th>Date</th><th>Time</th><th>File name</th><th>MD5</th>' + (multi ? '<th>CT#</th>' : '') + '</tr></thead><tbody>' +
                g.events.map(function (e) {
                    return '<tr><td class="nw">' + esc(e.date || '\u2014') + '</td><td class="nw">' + esc(timeText(e)) + '</td>' +
                        '<td class="wrap">' + (e.noFile ? '<span class="muted it">Upload listed for the account, not tied to a file</span>' : esc(e.file || '\u2014')) + '</td>' +
                        '<td class="mono wrap">' + esc(e.md5) + '</td>' + (multi ? '<td class="tip">' + esc(e.tips.join(', ')) + '</td>' : '') + '</tr>';
                }).join('') + '</tbody></table></div>';
        }).join('');

        var noIp = report.noIpFiles.length
            ? '<h2>Uploaded files with no upload IP listed (' + report.noIpFiles.length + ')</h2><table><thead><tr><th>File name</th><th>MD5</th>' + (multi ? '<th>CT#</th>' : '') + '</tr></thead><tbody>' +
                report.noIpFiles.map(function (f) {
                    return '<tr><td class="wrap">' + esc(f.file || '\u2014') + '</td><td class="mono wrap">' + esc(f.md5) + '</td>' + (multi ? '<td class="tip">' + esc(f.tip) + '</td>' : '') + '</tr>';
                }).join('') + '</tbody></table>'
            : '';

        var oth = report.other.map(function (g) {
            var gt = geoText(g.geo);
            return '<div class="ip">' +
                '<div class="t">IP: <span class="addr">' + esc(g.address) + '</span> <span class="cnt c">(seen ' + esc(plural(g.count, 'time')) + ')</span></div>' +
                '<div class="s"><b>' + esc(typesText(g)) + '</b>' +
                    (g.first ? ' \u00b7 first ' + esc(stampText(g.first)) : '') +
                    (g.last && g.last !== g.first ? ' \u00b7 last ' + esc(stampText(g.last)) : '') + '</div>' +
                ((gt || g.uploadCount || multi) ? '<div class="s">' + [gt ? esc(gt) : '', g.uploadCount ? 'Also an upload IP (see section 1)' : '', multi ? 'CT# ' + esc(g.tips.join(', ')) : ''].filter(Boolean).join(' \u00b7 ') + '</div>' : '') +
                '<table><thead><tr><th>Date</th><th>Time</th><th>Type</th><th>Port</th><th>Role</th>' + (multi ? '<th>CT#</th>' : '') + '</tr></thead><tbody>' +
                g.events.map(function (e) {
                    return '<tr><td class="nw">' + esc(e.date || '\u2014') + '</td><td class="nw">' + esc(timeText(e)) + '</td><td>' + esc(e.type) + '</td>' +
                        '<td class="mono">' + esc(e.port) + '</td><td>' + esc(e.role) + '</td>' + (multi ? '<td class="tip">' + esc(e.tips.join(', ')) + '</td>' : '') + '</tr>';
                }).join('') + '</tbody></table></div>';
        }).join('');

        var body = head + index +
            '<h2>1. Upload IP addresses (' + report.uploads.length + ')</h2>' +
            (report.uploads.length ? '<div class="note">Each address the files were uploaded from, with every upload oldest first.</div>' + up : '<div class="note">No upload IPs were listed.</div>') +
            noIp +
            '<h2 class="c">2. Login and other IP activity (' + report.other.length + ')</h2>' +
            (report.other.length ? '<div class="note">Login, check-in and other addresses the ESP listed for the reported people, oldest first.</div>' + oth : '<div class="note">No login or other IPs were listed.</div>') +
            '<div class="foot">Compiled by V.I.P.E.R. from the CyberTipline report' + (multi ? 's' : '') + ' listed above. Dates and times are copied as the ESP reported them and have not been converted. Verify against the original NCMEC report before relying on them for legal process.</div>';

        return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + esc(fileName(report, meta)) + '</title><style>' + PDF_CSS + '</style></head><body>' + body + '</body></html>';
    }

    return {
        build: build, panelHtml: panelHtml, pdfHtml: pdfHtml, fileName: fileName, titleFor: titleFor,
        tsKey: tsKey, fmtDate: fmtDate, zoneOf: zoneOf, esc: esc, SCREEN_ROW_CAP: SCREEN_ROW_CAP
    };
});

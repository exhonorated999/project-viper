/* ============================================================
   CyberTip "Subpoena list" — pure model + outputs.
   UMD: window.CyberTipSubpoena / require('./ct-subpoena.js').

   One list per IP address with every date and time the address was
   used (uploads, logins, other activity) and the port when listed.
   No file names, hashes or person roles: the list is written to be
   attached to legal process served on the internet provider that
   holds the address.

   candidates(tips)        every address with counts + provider (picker)
   build(tips, opts)       the list (see build() for opts)
   text(model, opts)       plain text for pasting into a subpoena
   csv(model)              spreadsheet rows
   pdfHtml(model, meta)    white print document for saveHtmlAsPdf
   fileName(model, meta, ext)

   Times are copied exactly as the ESP reported them (normally UTC);
   nothing is converted.
   ============================================================ */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./ct-ip-report.js'));
    else root.CyberTipSubpoena = factory(root.CyberTipIpReport);
})(typeof self !== 'undefined' ? self : this, function (IPR) {
    'use strict';

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
    function addrKey(a) { return String(a || '').trim().toLowerCase(); }

    var DEFAULT_REQUEST = 'Subscriber name, service address and billing records for the account assigned the IP address below at each date and time listed.';

    // Private, loopback, link-local, CGNAT shared and documentation-free
    // reserved space: no provider can say who used these.
    function privateIp(a) {
        a = String(a || '').trim().toLowerCase();
        var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
        if (m) {
            var o1 = +m[1], o2 = +m[2];
            return o1 === 10 || o1 === 127 || o1 === 0 ||
                (o1 === 172 && o2 >= 16 && o2 <= 31) ||
                (o1 === 192 && o2 === 168) ||
                (o1 === 169 && o2 === 254) ||
                (o1 === 100 && o2 >= 64 && o2 <= 127);
        }
        if (a.indexOf(':') >= 0) return a === '::1' || a === '::' || /^f[cd][0-9a-f]{2}:/.test(a) || /^fe[89ab][0-9a-f]:/.test(a);
        return false;
    }

    // Upload | Login | the ESP's own word for anything else (Checkin, Registration ...).
    function activityOf(kind, type) {
        if (kind === 'upload') return { kind: 'upload', label: 'Upload' };
        var t = String(type || '').trim();
        if (/^(log\s*-?\s*in|login|sign\s*-?\s*in|signin|logon|log\s*on)/i.test(t)) return { kind: 'login', label: 'Login' };
        return { kind: 'other', label: t && t !== 'Unspecified' ? t : 'Activity (type not stated)' };
    }

    // Provider details recorded on the tips (ARIN lookups first, then the
    // NCMEC / ESP geolocation table).
    function providers(list) {
        var out = new Map();
        list.forEach(function (t) {
            var arin = (t && t.arinResults) || {};
            Object.keys(arin).forEach(function (a) {
                var r = arin[a]; if (!r) return;
                var k = addrKey(a);
                var cur = out.get(k) || {};
                out.set(k, {
                    provider: cur.provider || r.provider || r.org || '',
                    network: cur.network || r.network || '',
                    netRange: cur.netRange || r.netRange || '',
                    country: cur.country || r.country || '',
                    source: cur.source || 'ARIN',
                    lookedUpAt: cur.lookedUpAt || r.lookedUpAt || ''
                });
            });
        });
        list.forEach(function (t) {
            ((t && t.ipGeoLookup) || []).forEach(function (g) {
                if (!g || !g.address) return;
                var k = addrKey(g.address);
                var cur = out.get(k);
                if (cur && cur.provider) return;
                out.set(k, {
                    provider: g.isp || '', network: '', netRange: '',
                    country: g.country || (cur && cur.country) || '', source: g.isp ? 'NCMEC IP lookup' : '', lookedUpAt: ''
                });
            });
        });
        return out;
    }

    function tipNumbers(list) {
        return list.map(function (t, i) { return (t && t.reportNumber) ? String(t.reportNumber) : ('Tip ' + (i + 1)); });
    }

    // Every address in the tips, upload and other activity together.
    function collect(list) {
        var rep = IPR.build(list);
        var byAddr = new Map();
        function slot(address) {
            var k = addrKey(address);
            var s = byAddr.get(k);
            if (!s) { s = { address: String(address).trim(), events: [] }; byAddr.set(k, s); }
            return s;
        }
        rep.uploads.forEach(function (g) {
            var s = slot(g.address);
            g.events.forEach(function (e) {
                var a = activityOf('upload', e.event);
                s.events.push({ key: e.key, date: e.date, time: e.time, zone: e.zone, timestamp: e.timestamp, port: e.port || '', kind: a.kind, activity: a.label, tips: e.tips.slice() });
            });
        });
        rep.other.forEach(function (g) {
            var s = slot(g.address);
            g.events.forEach(function (e) {
                var a = activityOf('other', e.type);
                s.events.push({ key: e.key, date: e.date, time: e.time, zone: e.zone, timestamp: e.timestamp, port: e.port || '', kind: a.kind, activity: a.label, tips: e.tips.slice() });
            });
        });
        return byAddr;
    }

    function countKinds(events) {
        var c = { upload: 0, login: 0, other: 0 };
        events.forEach(function (e) { c[e.kind]++; });
        return c;
    }

    function candidates(tips) {
        var list = (Array.isArray(tips) ? tips : [tips]).filter(Boolean);
        var prov = providers(list);
        var out = [];
        collect(list).forEach(function (s, k) {
            var c = countKinds(s.events);
            var p = prov.get(k) || null;
            out.push({
                address: s.address, total: s.events.length,
                uploads: c.upload, logins: c.login, other: c.other,
                provider: p ? p.provider : '', providerSource: p ? p.source : '',
                private: privateIp(s.address)
            });
        });
        out.sort(function (a, b) { return (a.private - b.private) || (b.total - a.total) || (a.address < b.address ? -1 : 1); });
        return out;
    }

    /* opts:
         addresses  list of addresses to include (default: every public one)
         kinds      {upload, login, other} booleans (default all true)
         merge      combine entries at the same second, activity and port
                    into one line with a count (default true)
         showActivity  label each line Upload / Login / ... (default true).
                    Off: dates, times and ports only; entries at the same
                    second and port merge regardless of activity.
    */
    function build(tips, opts) {
        opts = opts || {};
        var list = (Array.isArray(tips) ? tips : [tips]).filter(Boolean);
        var kinds = Object.assign({ upload: true, login: true, other: true }, opts.kinds || {});
        var merge = opts.merge !== false;
        var showAct = opts.showActivity !== false;
        var want = Array.isArray(opts.addresses) ? new Set(opts.addresses.map(addrKey)) : null;
        var prov = providers(list);
        var all = collect(list);
        var ips = [];
        all.forEach(function (s, k) {
            if (want ? !want.has(k) : privateIp(s.address)) return;
            var evs = s.events.filter(function (e) { return kinds[e.kind]; });
            if (!evs.length) return;
            var rows = [], byKey = new Map();
            evs.forEach(function (e) {
                var sig = [e.key || ('?' + e.timestamp), showAct ? e.activity.toLowerCase() : '', e.port].join('|');
                var r = merge ? byKey.get(sig) : null;
                if (r) {
                    r.count++;
                    e.tips.forEach(function (x) { if (r.tips.indexOf(x) < 0) r.tips.push(x); });
                    return;
                }
                r = { key: e.key, date: e.date, time: e.time, zone: e.zone, timestamp: e.timestamp, activity: showAct ? e.activity : '', kind: showAct ? e.kind : '', port: e.port, count: 1, tips: e.tips.slice() };
                byKey.set(sig, r);
                rows.push(r);
            });
            rows.sort(function (a, b) {
                if (a.key === b.key) return a.activity < b.activity ? -1 : (a.activity > b.activity ? 1 : 0);
                if (!a.key) return 1;
                if (!b.key) return -1;
                return a.key < b.key ? -1 : 1;
            });
            rows.forEach(function (r, i) { r.n = i + 1; });
            var dated = rows.filter(function (r) { return r.key; });
            var zones = [], tipsSet = [];
            rows.forEach(function (r) {
                if (r.zone && zones.indexOf(r.zone) < 0) zones.push(r.zone);
                r.tips.forEach(function (x) { if (tipsSet.indexOf(x) < 0) tipsSet.push(x); });
            });
            var p = prov.get(k) || {};
            ips.push({
                address: s.address,
                private: privateIp(s.address),
                provider: p.provider || '', network: p.network || '', netRange: p.netRange || '',
                country: p.country || '', providerSource: p.source || '',
                counts: countKinds(evs),
                entries: evs.length,
                rows: rows,
                first: dated.length ? dated[0] : null,
                last: dated.length ? dated[dated.length - 1] : null,
                undated: rows.length - dated.length,
                noZone: dated.filter(function (r) { return r.time && !r.zone; }).length,
                hasPort: rows.some(function (r) { return r.port; }),
                merged: rows.some(function (r) { return r.count > 1; }),
                zones: zones,
                tips: tipsSet,
                showActivity: showAct
            });
        });
        ips.sort(function (a, b) { return (b.entries - a.entries) || (a.address < b.address ? -1 : 1); });
        var zonesAll = [];
        ips.forEach(function (g) { g.zones.forEach(function (z) { if (zonesAll.indexOf(z) < 0) zonesAll.push(z); }); });
        var esps = [];
        list.forEach(function (t) { var n = t && t.esp && t.esp.name; if (n && esps.indexOf(n) < 0) esps.push(n); });
        return {
            ips: ips,
            tips: tipNumbers(list),
            esps: esps,
            zones: zonesAll,
            kinds: kinds,
            merge: merge,
            showActivity: showAct,
            totals: {
                ips: ips.length,
                lines: ips.reduce(function (n, g) { return n + g.rows.length; }, 0),
                entries: ips.reduce(function (n, g) { return n + g.entries; }, 0),
                noProvider: ips.filter(function (g) { return !g.provider; }).length
            }
        };
    }

    // ── wording ──────────────────────────────────────────────
    function timeText(r) { return r.time ? r.time + (r.zone ? ' ' + r.zone : '') : ''; }
    function stamp(r) { return r ? (r.date + (r.time ? ' ' + timeText(r) : '')) : ''; }
    function zoneWord(g) {
        if (g.zones.length === 1 && !g.noZone) return g.zones[0];
        if (!g.zones.length) return 'time zone not stated in the report';
        return 'zone shown on each line';
    }
    function countsText(g) {
        var c = g.counts, parts = [];
        if (c.upload) parts.push(plural(c.upload, 'upload'));
        if (c.login) parts.push(plural(c.login, 'login'));
        if (c.other) parts.push(plural(c.other, 'other entry', 'other entries'));
        return parts.join(', ');
    }
    function spanText(g) {
        if (!g.first) return '';
        return g.first === g.last || g.first.key === g.last.key ? stamp(g.first) : stamp(g.first) + ' to ' + stamp(g.last);
    }
    function providerText(g) {
        if (!g.provider) return g.private ? 'Private address (not routable on the internet)' : 'Provider not looked up';
        return g.provider + (g.providerSource ? ' (' + g.providerSource + ')' : '');
    }
    function usedLine(g) {
        var ct = g.showActivity === false ? '' : countsText(g);
        return 'Used ' + plural(g.entries, 'time') + (ct ? ': ' + ct : '') +
            (g.rows.length !== g.entries ? ' (' + plural(g.rows.length, 'distinct date/time', 'distinct dates/times') + ')' : '');
    }

    function text(model, opts) {
        opts = opts || {};
        var out = [];
        if (opts.request) out.push(opts.request, '');
        model.ips.forEach(function (g, i) {
            if (i) out.push('', '----------------------------------------', '');
            out.push('IP address: ' + g.address);
            out.push('Provider: ' + providerText(g) + (g.netRange ? ' · range ' + g.netRange : ''));
            out.push(usedLine(g) + (spanText(g) ? ', ' + spanText(g) : '') + '.');
            out.push('Dates and times used (' + zoneWord(g) + '):');
            g.rows.forEach(function (r) {
                var when = r.date ? stamp(r) : 'Date not listed';
                out.push(r.n + '. ' + when + (r.activity ? '  ' + r.activity : '') + (r.port ? '  port ' + r.port : '') + (r.count > 1 ? '  (' + r.count + ' entries)' : ''));
            });
        });
        return out.join('\r\n');
    }

    function csvCell(v) {
        var s = String(v == null ? '' : v);
        // Leading = + - @ would run as a formula in a spreadsheet.
        if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
        return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    function csv(model) {
        var act = model.showActivity !== false;
        var head = ['IP address', 'Line', 'Date', 'Time', 'Time zone'].concat(act ? ['Activity'] : [], ['Port', 'Entries', 'Provider']);
        var lines = [head.join(',')];
        model.ips.forEach(function (g) {
            g.rows.forEach(function (r) {
                var row = [g.address, r.n, r.date, r.time, r.zone].concat(act ? [r.activity] : [], [r.port, r.count, g.provider]);
                lines.push(row.map(csvCell).join(','));
            });
        });
        return lines.join('\r\n') + '\r\n';
    }

    function fileName(model, meta, ext) {
        meta = meta || {};
        var which = model.ips.length === 1 ? model.ips[0].address.replace(/[:.]/g, '-') : (model.ips.length + '-IPs');
        var day = meta.day || new Date().toISOString().slice(0, 10);
        return ('IP-Subpoena-List_' + which + '_' + (meta.caseNumber || 'case') + '_' + day + '.' + (ext || 'pdf')).replace(/[^\w.\-]+/g, '_');
    }

    // ── PDF document ─────────────────────────────────────────
    var PDF_CSS =
        '*{box-sizing:border-box}' +
        'body{margin:0;font-family:"Segoe UI",Arial,sans-serif;color:#1d232b;font-size:9.5pt;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
        '.top{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;border-bottom:2px solid #1d232b;padding-bottom:8px}' +
        '.top h1{margin:0;font-size:15pt}' +
        '.top .ref{font-size:9pt;color:#3a434d;margin-top:3px}' +
        '.top img{width:34px;height:34px;object-fit:contain;opacity:.85}' +
        '.req{margin:10px 0 4px;padding:8px 10px;border:1px solid #c9d0d7;border-radius:4px;background:#f6f8fa;font-size:9.5pt}' +
        '.sec{margin-top:16px}' +
        '.sec.pb{break-before:page;margin-top:0}' +
        '.sec h2{margin:0 0 4px;font-size:13pt}' +
        '.sec h2 .addr{font-family:Consolas,"Courier New",monospace}' +
        '.kv{display:grid;grid-template-columns:120px 1fr;gap:2px 10px;font-size:9pt;margin:4px 0 8px}' +
        '.kv .k{color:#59626d}' +
        '.kv .v{font-weight:600;word-break:break-word}' +
        '.warn{color:#9a3412}' +
        'table{width:100%;border-collapse:collapse;font-size:9pt}' +
        'thead{display:table-header-group}' +
        'th{text-align:left;background:#eef1f4;color:#3a434d;font-weight:600;padding:4px 6px;border-bottom:1px solid #c9d0d7;white-space:nowrap}' +
        'td{padding:3px 6px;border-bottom:1px solid #e6e9ed;vertical-align:top;white-space:nowrap}' +
        'td.n{color:#6b7480;text-align:right;width:36px}' +
        'tr{break-inside:avoid}' +
        '.mono{font-family:Consolas,"Courier New",monospace}' +
        '.foot{margin-top:14px;font-size:7.5pt;color:#6b7480;border-top:1px solid #d7dce2;padding-top:6px}';

    /* meta: caseNumber, showCase, showTips, onePerPage, request, logo, generated */
    function pdfHtml(model, meta) {
        meta = meta || {};
        var refs = [];
        if (meta.showCase && meta.caseNumber) refs.push('Case ' + meta.caseNumber);
        if (meta.showTips && model.tips.length) refs.push('CyberTip' + (model.tips.length > 1 ? 's' : '') + ' ' + model.tips.join(', ') + (model.esps.length ? ' (' + model.esps.join(', ') + ')' : ''));
        var head =
            '<div class="top"><div>' +
                '<h1>IP Address Activity: Dates and Times of Use</h1>' +
                '<div class="ref">' + esc(plural(model.ips.length, 'IP address', 'IP addresses')) + (refs.length ? ' · ' + esc(refs.join(' · ')) : '') + '</div>' +
            '</div>' + (meta.logo ? '<img src="' + esc(meta.logo) + '" alt="">' : '') + '</div>' +
            (meta.request ? '<div class="req">' + esc(meta.request) + '</div>' : '');

        var secs = model.ips.map(function (g, i) {
            var portCol = g.hasPort, cntCol = g.merged, actCol = g.showActivity !== false;
            var kv = function (k, v, cls) { return v ? '<div class="k">' + esc(k) + '</div><div class="v' + (cls ? ' ' + cls : '') + '">' + esc(v) + '</div>' : ''; };
            var zoneNote = !g.zones.length ? 'Not stated in the report' : (g.zones.length === 1 && !g.noZone ? g.zones[0] + ', as reported (not converted)' : 'As shown on each line (not converted)');
            return '<div class="sec' + (meta.onePerPage && i ? ' pb' : '') + '">' +
                '<h2>IP address <span class="addr">' + esc(g.address) + '</span></h2>' +
                '<div class="kv">' +
                    kv('Provider', providerText(g), g.provider ? '' : 'warn') +
                    kv('Network', g.network) +
                    kv('Address range', g.netRange) +
                    kv('Times used', usedLine(g)) +
                    kv('Period', spanText(g)) +
                    kv('Time zone', zoneNote, g.zones.length ? '' : 'warn') +
                    (meta.showTips && model.tips.length > 1 ? kv('CyberTip', g.tips.join(', ')) : '') +
                '</div>' +
                '<table><thead><tr><th>#</th><th>Date</th><th>Time</th>' + (actCol ? '<th>Activity</th>' : '') + (portCol ? '<th>Port</th>' : '') + (cntCol ? '<th>Entries</th>' : '') + '</tr></thead><tbody>' +
                g.rows.map(function (r) {
                    return '<tr><td class="n">' + r.n + '</td><td>' + esc(r.date || 'Not listed') + '</td><td class="mono">' + esc(timeText(r)) + '</td>' + (actCol ? '<td>' + esc(r.activity) + '</td>' : '') +
                        (portCol ? '<td class="mono">' + esc(r.port) + '</td>' : '') + (cntCol ? '<td>' + (r.count > 1 ? r.count : '') + '</td>' : '') + '</tr>';
                }).join('') +
                '</tbody></table>' +
                (cntCol ? '<div class="foot" style="border:0;margin-top:4px;padding:0">' + (actCol
                    ? '"Entries" counts records at the same date, time and activity (for example several files uploaded in the same second).'
                    : '"Entries" counts records at the same date and time.') + '</div>' : '') +
            '</div>';
        }).join('');

        var foot = '<div class="foot">Dates and times are copied as recorded in the source report' + (model.zones.length === 1 ? ' (' + esc(model.zones[0]) + ')' : '') +
            ' and have not been converted.' + (meta.generated ? ' Prepared ' + esc(meta.generated) + '.' : '') + '</div>';

        return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + esc(fileName(model, meta)) + '</title><style>' + PDF_CSS + '</style></head><body>' +
            head + secs + foot + '</body></html>';
    }

    return {
        candidates: candidates, build: build, text: text, csv: csv, pdfHtml: pdfHtml, fileName: fileName,
        privateIp: privateIp, activityOf: activityOf, providerText: providerText, usedLine: usedLine, spanText: spanText,
        countsText: countsText, DEFAULT_REQUEST: DEFAULT_REQUEST, esc: esc
    };
});

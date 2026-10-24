/* ============================================================
   Series Analysis: Bulletin builder (VIPER)

   One-page (it flows to two if needed) crime pattern bulletin
   built from the incidents in view. The audience is either
   Law Enforcement Sensitive (patrol / analysts) or a Community
   alert (no report numbers, block-level addresses, no "likely
   next" by default).

   Output: PDF via electronAPI.saveHtmlAsPdf, saved straight into
   the case Evidence (returnBase64 → saveEvidenceFile), or saved
   as a copy wherever the user chooses.

   The "likely next" box is worded as a description of the
   observed pattern, never as a prediction.

   window.SeriesAnalysisBulletin = { render, init, onAction, onChange }
   module.exports (node tests)   = { buildHtml, blockOf, defaults, tileSrc }
   ============================================================ */
(function (root) {
    'use strict';

    var PAGE_W = 816;          // Letter @ 96 dpi
    var MAP_W = 420, MAP_H = 300;
    var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var MON_FIRST = [1, 2, 3, 4, 5, 6, 0];
    var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    var BANNERS = {
        les: 'LAW ENFORCEMENT SENSITIVE · Do not release to the public or the media',
        public: 'COMMUNITY CRIME ALERT'
    };
    var ASKS = {
        les: 'Extra patrol in the orange area during the window above. Identify the occupants of any vehicle matching the description and check for tools (battery saws, jacks). Send related reports, field contacts and video to the contact below.',
        public: 'If you see someone under a parked vehicle or a vehicle circling slowly at night, call 911 right away. Do not approach. If you have video from a doorbell or security camera, please contact us.'
    };

    function defaults() {
        return {
            audience: 'les', title: '', number: '', agency: '', contact: '', ask: '', banner: '',
            include: { summary: true, next: true, map: true, vehicle: true, suspects: true, when: true, table: true },
            exactAddresses: false, vehicleImage: '', vehicleCaption: ''
        };
    }
    function optsOf(raw) {
        var d = defaults(), r = raw && typeof raw === 'object' ? raw : {};
        var o = Object.assign({}, d, r);
        o.include = Object.assign({}, d.include, r.include || {});
        if (o.audience !== 'public') o.audience = 'les';
        return o;
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function md(s) { return esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>'); }
    function pad2(n) { return (n < 10 ? '0' : '') + n; }

    /** "1420 Oak Hollow Dr" → "1400 block of Oak Hollow Dr" (victim addresses stay off a bulletin by default). */
    function blockOf(addr) {
        var a = String(addr || '').trim();
        var m = /^(\d+)[A-Za-z]?\s+(.+)$/.exec(a);
        if (!m) return a;
        return (Math.floor(+m[1] / 100) * 100) + ' block of ' + m[2];
    }
    function shortDay(d) {
        var p = String(d || '').split('-');
        if (p.length !== 3) return '—';
        var dt = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
        return DOW[dt.getUTCDay()] + ' ' + (+p[1]) + '/' + (+p[2]);
    }
    function longDay(d) {
        var p = String(d || '').split('-');
        return p.length === 3 ? MONTHS[+p[1] - 1] + ' ' + (+p[2]) + ', ' + p[0] : '';
    }
    function rangeText(a, b) {
        if (!a) return '';
        if (!b || a === b) return longDay(a);
        var pa = a.split('-'), pb = b.split('-');
        if (pa[0] === pb[0]) return MONTHS[+pa[1] - 1] + ' ' + (+pa[2]) + ' – ' + MONTHS[+pb[1] - 1] + ' ' + (+pb[2]) + ', ' + pb[0];
        return longDay(a) + ' – ' + longDay(b);
    }
    function timeText(inc) {
        if (!inc.timeFrom) return 'unknown';
        return inc.timeTo ? inc.timeFrom + '–' + inc.timeTo : inc.timeFrom;
    }
    function seqColor(n, N) {
        var t = N > 1 ? Math.min(1, Math.max(0, (n - 1) / (N - 1))) : 0;
        return 'rgb(' + Math.round(14 + t * 220) + ',' + Math.round(150 - t * 20) + ',' + Math.round(200 - t * 180) + ')';
    }
    function tileSrc(t, tpl) {
        var url = tpl || 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';
        return url.replace('{s}', 'abc'.charAt((t.x + t.y) % 3)).replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y).replace('{r}', '@2x');
    }

    function firstOfGroup(columns, group, not) {
        for (var i = 0; i < columns.length; i++) {
            if (columns[i].group === group && !(not && not.test(columns[i].key))) return columns[i];
        }
        return null;
    }
    /** Shared values (≥2 incidents) for these columns; falls back to distinct values. */
    function valuesFor(M, incidents, cols, seq, limit) {
        var out = [];
        if (!cols.length) return out;
        var sh = M.shared(incidents, cols);
        cols.forEach(function (c) { (sh[c.key] || []).forEach(function (x) { out.push({ display: x.display, count: x.count, ids: x.ids, shared: true }); }); });
        out.sort(function (a, b) { return b.count - a.count; });
        if (!out.length) {
            var seen = {};
            incidents.forEach(function (inc) {
                cols.forEach(function (c) {
                    M.splitValues((inc.attrs || {})[c.key]).forEach(function (p) {
                        var n = M.normValue(p);
                        if (!n || seen[n]) return;
                        seen[n] = 1;
                        out.push({ display: p, count: 1, ids: [inc.id], shared: false });
                    });
                });
            });
        }
        return out.slice(0, limit || 4).map(function (v) {
            v.nums = v.ids.map(function (id) { return seq[id]; }).filter(Boolean).sort(function (a, b) { return a - b; });
            return v;
        });
    }

    // ── map ──────────────────────────────────────────────────────────
    function mapHtml(M, incidents, seq, next, tileTpl) {
        var geo = M.chrono(incidents).filter(M.hasGeo);
        var pts = geo.map(function (i) { return [i.lat, i.lng]; });
        var area = next && next.area;
        if (area) M.circlePolygon(area.center, area.radius_m, 8).forEach(function (p) { pts.push(p); });
        if (!pts.length) return '<div class="nomap">No incident has a map position.</div>';
        var mos = M.tileMosaic(pts, MAP_W, MAP_H, { padPx: 26, maxZoom: 17 });
        var tiles = mos.tiles.map(function (t) {
            return '<img src="' + esc(tileSrc(t, tileTpl)) + '" style="left:' + t.left + 'px;top:' + t.top + 'px" alt="">';
        }).join('');
        var svg = '<svg width="' + MAP_W + '" height="' + MAP_H + '" viewBox="0 0 ' + MAP_W + ' ' + MAP_H + '">';
        if (area) {
            var c = M.toViewport(mos, area.center.lat, area.center.lng);
            var r = area.radius_m / M.metersPerPixel(area.center.lat, mos.zoom);
            svg += '<circle cx="' + c.x.toFixed(1) + '" cy="' + c.y.toFixed(1) + '" r="' + r.toFixed(1) + '" fill="rgba(245,124,0,.14)" stroke="#f57c00" stroke-width="2.2" stroke-dasharray="7 5"/>';
        }
        if (geo.length >= 2) {
            svg += '<polyline fill="none" stroke="#475569" stroke-width="1.4" stroke-dasharray="4 4" opacity=".8" points="' +
                geo.map(function (i) { var p = M.toViewport(mos, i.lat, i.lng); return p.x.toFixed(1) + ',' + p.y.toFixed(1); }).join(' ') + '"/>';
        }
        var N = incidents.length;
        geo.forEach(function (i) {
            var p = M.toViewport(mos, i.lat, i.lng), n = seq[i.id] || '';
            svg += '<g><circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="9.5" fill="' + seqColor(n, N) + '" stroke="#fff" stroke-width="1.6"/>' +
                '<text x="' + p.x.toFixed(1) + '" y="' + (p.y + 3.6).toFixed(1) + '" text-anchor="middle" font-size="10" font-weight="700" fill="#fff" font-family="Segoe UI,Arial,sans-serif">' + n + '</text></g>';
        });
        svg += '</svg>';
        return '<div class="map" style="width:' + MAP_W + 'px;height:' + MAP_H + 'px">' + tiles + svg +
            '<div class="attr">© OpenStreetMap © CARTO</div></div>';
    }

    function whenHtml(M, incidents) {
        var g = M.hourWeights(incidents), max = 0;
        g.forEach(function (row) { row.forEach(function (v) { if (v > max) max = v; }); });
        var pk = M.peakWindow(g);
        var s = '<table class="when"><tr><td></td>';
        for (var h = 0; h < 24; h++) s += '<td class="hh">' + (h % 6 === 0 ? pad2(h) : '') + '</td>';
        s += '</tr>';
        MON_FIRST.forEach(function (d) {
            s += '<tr><td class="dd">' + DOW[d] + '</td>';
            for (var hh = 0; hh < 24; hh++) {
                var v = max ? g[d][hh] / max : 0;
                var inBand = pk && pk.days.indexOf(d) >= 0 && ((hh - pk.startHour + 24) % 24) < (((pk.endHour - pk.startHour) + 24) % 24 || 24);
                s += '<td class="c' + (inBand ? ' pk' : '') + '" style="background:' + (v ? 'rgba(3,105,161,' + (0.12 + v * 0.83).toFixed(2) + ')' : '#f1f5f9') + '"></td>';
            }
            s += '</tr>';
        });
        s += '</table>';
        if (pk) s += '<div class="cap">Busiest: <b>' + esc(pk.daysLabel) + ' ' + esc(pk.label) + '</b> (' + Math.round(pk.share * 100) + '% of time weight). Windows are spread across every hour they cover.</div>';
        return s;
    }

    /**
     * Full bulletin HTML document.
     * o = { model, incidents, columns, options, caseObj, now:'YYYY-MM-DD', issued, tileUrl, filterNote }
     */
    function buildHtml(o) {
        var M = o.model, opts = optsOf(o.options), list = o.incidents || [], columns = o.columns || [];
        var inc = opts.include, pub = opts.audience === 'public';
        var seq = M.seqMap(list), ordered = M.chrono(list), N = list.length;
        var gs = M.gapStats(list);
        var next = M.likelyNext(list, { now: o.now });
        var showNext = inc.next && next;
        var c = o.caseObj || {};
        var title = opts.title || (o.seriesTitle || '') || 'Crime Pattern Bulletin';
        var banner = opts.banner || BANNERS[opts.audience];
        var ask = opts.ask || ASKS[opts.audience];
        var exact = opts.exactAddresses && !pub;
        var addr = function (a) { return exact ? a : blockOf(a); };

        var meta = [N + ' incident' + (N === 1 ? '' : 's')];
        if (gs) meta.push(rangeText(gs.first, gs.last));
        meta.push('Issued ' + longDay(o.now));
        if (!pub && c.caseNumber) meta.push('Case ' + c.caseNumber);
        if (opts.number) meta.push('Bulletin ' + opts.number);

        // left column
        var left = '';
        if (inc.summary) {
            var items = M.summary(list, columns, { now: o.now }).filter(function (s) { return !/^Data gaps/.test(s); });
            if (items.length) left += '<h3>Summary</h3><ul class="sum">' + items.map(function (s) { return '<li>' + md(s) + '</li>'; }).join('') + '</ul>';
        }
        if (inc.map) {
            left += '<h3>Where' + (showNext && next.area ? ' <span class="h3s">· numbered in order · orange = likely area</span>' : ' <span class="h3s">· numbered in order of occurrence</span>') + '</h3>' +
                mapHtml(M, list, seq, showNext ? next : null, o.tileUrl);
        }

        // right column
        var right = '';
        if (showNext) {
            var near = '';
            if (next.area) {
                var best = null, bd = Infinity;
                list.filter(M.hasGeo).forEach(function (i) { var d = M.haversine(i, next.area.center); if (d < bd && i.address) { bd = d; best = i; } });
                var mi = next.area.radius_m / 1609.344;
                near = '<div class="nx-l">Area</div><div class="nx-v2">Within ≈' + Math.round(next.area.radius_m / 10) * 10 + ' m (' + (mi < 0.1 ? mi.toFixed(2) : mi.toFixed(1)) + ' mi)' +
                    (best ? ' of the ' + esc(blockOf(best.address)) : '') + ', orange circle on the map</div>';
            }
            right += '<div class="nx"><div class="nx-h">Likely next <span>· based on observed hits</span></div>' +
                '<div class="nx-l">When</div><div class="nx-v">' + esc(next.window.label) + '</div>' +
                (next.window.hoursLabel ? '<div class="nx-v2">' + esc(next.window.hoursLabel) + '</div>' : '') + near +
                '<div class="nx-f">Confidence: <b>' + esc(next.confidence) + '</b>. This describes the pattern so far (spacing between hits, weekday mix, hours, recent locations). It is not a prediction.</div></div>';
        }
        var vcols = columns.filter(function (cl) { return cl.group === 'vehicle'; });
        if (inc.vehicle && (vcols.length || opts.vehicleImage)) {
            var vv = valuesFor(M, list, vcols, seq, 3);
            if (vv.length || opts.vehicleImage) {
                right += '<h3>Suspect vehicle</h3>' +
                    (opts.vehicleImage ? '<div class="veh"><img src="' + esc(opts.vehicleImage) + '" alt="">' + (opts.vehicleCaption ? '<div class="cap">' + esc(opts.vehicleCaption) + '</div>' : '') + '</div>' : '') +
                    vv.map(function (v) { return '<div class="val"><b>' + esc(v.display) + '</b><span>' + (v.shared ? v.count + ' incidents · ' : '') + v.nums.map(function (n) { return '#' + n; }).join(', ') + '</span></div>'; }).join('');
            }
        }
        var pcols = columns.filter(function (cl) { return cl.group === 'person' && !/victim/i.test(cl.key + ' ' + cl.label); });
        if (inc.suspects && pcols.length) {
            var pv = valuesFor(M, list, pcols, seq, 4);
            if (pv.length) right += '<h3>Suspects</h3>' + pv.map(function (v) { return '<div class="val"><b>' + esc(v.display) + '</b><span>' + (v.shared ? v.count + ' incidents · ' : '') + v.nums.map(function (n) { return '#' + n; }).join(', ') + '</span></div>'; }).join('');
        }
        if (inc.when) right += '<h3>When</h3>' + whenHtml(M, list);

        // table
        var table = '';
        if (inc.table && N) {
            var tc = [firstOfGroup(columns, 'target'), firstOfGroup(columns, 'vehicle'), firstOfGroup(columns, 'mo')].filter(Boolean);
            table = '<h3>Incidents</h3><table class="inc"><thead><tr><th>#</th><th>Date</th><th>Time</th><th>Location</th>' +
                tc.map(function (cl) { return '<th>' + esc(cl.label) + '</th>'; }).join('') + (pub ? '' : '<th>Report</th>') + '</tr></thead><tbody>' +
                ordered.map(function (i) {
                    var n = seq[i.id];
                    return '<tr><td><span class="num" style="background:' + seqColor(n, N) + '">' + n + '</span></td><td class="nw">' + esc(shortDay(i.date)) + '</td><td class="nw">' + esc(timeText(i)) + '</td>' +
                        '<td>' + esc(addr(i.address) || '—') + '</td>' +
                        tc.map(function (cl) { return '<td>' + esc((i.attrs || {})[cl.key] || '') + '</td>'; }).join('') +
                        (pub ? '' : '<td class="nw mono">' + esc(i.reportNo || '') + '</td>') + '</tr>';
                }).join('') + '</tbody></table>';
        }

        var css = '' +
            '@page{size:Letter;margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff}' +
            'body{font-family:"Segoe UI",Arial,sans-serif;color:#0f172a;font-size:11px;line-height:1.4;width:' + PAGE_W + 'px;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
            '.ban{background:' + (pub ? '#1d4ed8' : '#b91c1c') + ';color:#fff;text-align:center;font-weight:700;letter-spacing:.08em;font-size:10.5px;padding:6px 10px;text-transform:uppercase}' +
            '.wrap{padding:18px 40px 22px}' +
            '.top{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;border-bottom:3px solid #0891b2;padding-bottom:9px}' +
            '.kick{font-size:10px;font-weight:700;letter-spacing:.14em;color:#0891b2;text-transform:uppercase}' +
            'h1{font-size:23px;line-height:1.15;margin:2px 0 3px;font-weight:800}' +
            '.meta{font-size:10.5px;color:#475569}.agency{text-align:right;font-size:11px;font-weight:700;color:#334155;max-width:240px}' +
            '.cols{display:flex;gap:18px;margin-top:10px}.l{width:' + MAP_W + 'px;flex:none}.r{flex:1;min-width:0}' +
            'h3{font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:#0e7490;margin:10px 0 5px;border-bottom:1px solid #e2e8f0;padding-bottom:2px}h3 .h3s{text-transform:none;letter-spacing:0;color:#94a3b8;font-weight:400}' +
            '.sum{margin:0;padding-left:15px}.sum li{margin:0 0 4px}' +
            '.map{position:relative;overflow:hidden;border:1px solid #cbd5e1;border-radius:4px;background:#e5e7eb}.map img{position:absolute;width:256px;height:256px}.map svg{position:absolute;left:0;top:0}' +
            '.attr{position:absolute;right:0;bottom:0;background:rgba(255,255,255,.8);font-size:8px;color:#475569;padding:1px 4px}.nomap{padding:30px;text-align:center;color:#94a3b8;border:1px dashed #cbd5e1}' +
            '.nx{border:2px solid #f57c00;background:#fff7ed;border-radius:6px;padding:8px 10px;margin-top:10px}.nx-h{font-weight:800;color:#c2410c;text-transform:uppercase;letter-spacing:.08em;font-size:10.5px}.nx-h span{text-transform:none;letter-spacing:0;font-weight:400;color:#9a3412}' +
            '.nx-l{font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:#9a3412;margin-top:5px}.nx-v{font-size:16px;font-weight:800;color:#0f172a}.nx-v2{font-size:11.5px;font-weight:600}.nx-f{font-size:9.5px;color:#7c2d12;margin-top:6px}' +
            '.veh img{width:100%;max-height:170px;object-fit:cover;border-radius:4px;border:1px solid #cbd5e1;display:block}.cap{font-size:9.5px;color:#64748b;margin-top:3px}' +
            '.val{display:flex;justify-content:space-between;gap:8px;border-bottom:1px dotted #e2e8f0;padding:3px 0}.val span{color:#64748b;white-space:nowrap;font-size:10px}' +
            '.when{border-collapse:separate;border-spacing:1px}.when td{padding:0}.when .c{width:9px;height:9px}.when .pk{outline:1.5px solid #f57c00}.when .hh{font-size:8px;color:#64748b}.when .dd{font-size:8.5px;color:#475569;padding-right:3px}' +
            'table.inc{width:100%;border-collapse:collapse;font-size:10px}table.inc th{text-align:left;background:#f1f5f9;color:#334155;font-size:9px;text-transform:uppercase;letter-spacing:.05em;padding:4px 5px}' +
            'table.inc td{padding:3px 5px;border-bottom:1px solid #e2e8f0;vertical-align:top}table.inc tr{page-break-inside:avoid}.nw{white-space:nowrap}.mono{font-family:Consolas,monospace;color:#475569}' +
            '.num{display:inline-block;min-width:17px;height:17px;border-radius:9px;color:#fff;font-weight:700;text-align:center;line-height:17px;font-size:9.5px}' +
            '.ask{margin-top:12px;border-left:4px solid ' + (pub ? '#1d4ed8' : '#b91c1c') + ';background:#f8fafc;padding:7px 10px}.ask b{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#334155}' +
            '.foot{display:flex;justify-content:space-between;margin-top:10px;font-size:9px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:5px}';

        return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + esc(title) + '</title><style>' + css + '</style></head><body>' +
            '<div class="ban">' + esc(banner) + '</div>' +
            '<div class="wrap">' +
                '<div class="top"><div><div class="kick">' + (pub ? 'Community alert' : 'Crime pattern bulletin') + '</div><h1>' + esc(title) + '</h1>' +
                    '<div class="meta">' + meta.map(esc).join(' · ') + (o.filterNote ? ' · <i>' + esc(o.filterNote) + '</i>' : '') + '</div></div>' +
                    (opts.agency ? '<div class="agency">' + esc(opts.agency) + '</div>' : '') + '</div>' +
                '<div class="cols">' + (left ? '<div class="l">' + left + '</div>' : '') + '<div class="r">' + right + '</div></div>' +
                table +
                '<div class="ask"><b>' + (pub ? 'How you can help' : 'Request') + '</b>' + esc(ask) +
                    (opts.contact ? '<div style="margin-top:4px"><b style="display:inline">Contact:</b> ' + esc(opts.contact) + '</div>' : '') + '</div>' +
                '<div class="foot"><span>' + esc(banner) + '</span><span>Generated by V.I.P.E.R.</span></div>' +
            '</div></body></html>';
    }

    // ═══════════════════════ UI (renderer only) ═══════════════════════
    var UI = { timer: null, lastCtx: null };

    function storedOpts(ctx) {
        var raw = ctx.data.bulletin || {};
        var o = optsOf(raw);
        if (!raw.agency) { try { o.agency = localStorage.getItem('viper_agency') || ''; } catch (_) {} }
        if (!raw.contact) { try { o.contact = localStorage.getItem('viper_customer_name') || ''; } catch (_) {} }
        return o;
    }
    function persist(ctx, o) { ctx.data.bulletin = o; ctx.save({ quiet: true }); }

    function htmlFor(ctx) {
        var B = window.VIPER_BASEMAP;
        var f = ctx.filter;
        return buildHtml({
            model: ctx.model, incidents: ctx.visible, columns: ctx.columns, options: storedOpts(ctx), caseObj: ctx.caseObj,
            now: ctx.today(), seriesTitle: ctx.data.title, tileUrl: (B && B.voyager) || null,
            filterNote: f ? ('only incidents where ' + f.label + ' is ' + f.display) : ''
        });
    }

    function render(ctx) {
        var e = ctx.esc, o = storedOpts(ctx);
        var chk = function (k, label) {
            return '<label class="flex items-center gap-2 text-[12.5px] text-gray-300 py-0.5"><input type="checkbox" class="accent-viper-cyan" data-sab-inc="' + k + '"' + (o.include[k] ? ' checked' : '') + '> ' + label + '</label>';
        };
        var frames = (ctx.data.observations || []).filter(function (x) { return x && x.frame; });
        var frameBtns = frames.slice(-8).map(function (x) {
            return '<button class="sa-bul-thumb" data-sa="sab-img-frame" data-id="' + e(x.id) + '" title="' + e(x.text || 'Frame grab') + '"><img src="' + e(x.frame) + '" alt=""></button>';
        }).join('');
        var electron = !!(window.electronAPI && window.electronAPI.saveHtmlAsPdf);
        var note = ctx.filter ? '<div class="text-[11.5px] rounded-md px-2 py-1.5 mb-2" style="background:rgba(0,217,255,.08);border:1px solid rgba(0,217,255,.3);color:#a5f3fc">Filtered: only incidents where ' + e(ctx.filter.label) + ' is <b>' + e(ctx.filter.display) + '</b> (' + ctx.visible.length + ' of ' + ctx.all.length + '). Clear the filter for the whole series.</div>' : '';
        return '' +
        '<div class="grid grid-cols-1 xl:grid-cols-12 gap-3">' +
            '<div class="xl:col-span-4 2xl:col-span-3 sa-card space-y-3" style="align-self:start">' + note +
                '<div><div class="sa-label">Audience</div><div class="flex gap-1">' +
                    '<button class="sa-pill' + (o.audience === 'les' ? ' on' : '') + '" data-sa="sab-audience" data-v="les">Law enforcement</button>' +
                    '<button class="sa-pill' + (o.audience === 'public' ? ' on' : '') + '" data-sa="sab-audience" data-v="public">Community</button></div>' +
                    '<div class="text-[11px] text-gray-500 mt-1">' + (o.audience === 'public' ? 'Block-level addresses, no report numbers, no likely-next box unless you tick it.' : 'For patrol and analysts. Banner marks it Law Enforcement Sensitive.') + '</div></div>' +
                '<div><label class="sa-label">Title</label><input class="sa-input" data-sab-field="title" placeholder="' + e(ctx.data.title || 'Crime Pattern Bulletin') + '" value="' + e(o.title) + '"></div>' +
                '<div class="grid grid-cols-2 gap-2"><div><label class="sa-label">Agency</label><input class="sa-input" data-sab-field="agency" value="' + e(o.agency) + '"></div>' +
                    '<div><label class="sa-label">Bulletin #</label><input class="sa-input" data-sab-field="number" placeholder="optional" value="' + e(o.number) + '"></div></div>' +
                '<div><label class="sa-label">Contact</label><input class="sa-input" data-sab-field="contact" placeholder="Name · phone · email" value="' + e(o.contact) + '"></div>' +
                '<div><label class="sa-label">Banner</label><input class="sa-input" data-sab-field="banner" placeholder="' + e(BANNERS[o.audience]) + '" value="' + e(o.banner) + '"></div>' +
                '<div><label class="sa-label">' + (o.audience === 'public' ? 'How you can help' : 'Request') + '</label><textarea class="sa-textarea" rows="3" data-sab-field="ask" placeholder="' + e(ASKS[o.audience]) + '">' + e(o.ask) + '</textarea></div>' +
                '<div><div class="sa-label">Include</div><div class="grid grid-cols-2">' +
                    chk('summary', 'Summary') + chk('map', 'Map') + chk('next', 'Likely next') + chk('vehicle', 'Suspect vehicle') + chk('suspects', 'Suspects') + chk('when', 'Day × hour') + chk('table', 'Incident table') + '</div>' +
                    (o.audience === 'les' ? '<label class="flex items-center gap-2 text-[12.5px] text-gray-300 pt-1"><input type="checkbox" class="accent-viper-cyan" data-sab-field="exactAddresses"' + (o.exactAddresses ? ' checked' : '') + '> Full street numbers (otherwise block only)</label>' : '') +
                '</div>' +
                '<div><div class="sa-label">Vehicle photo</div>' +
                    (o.vehicleImage ? '<div class="relative mb-1"><img src="' + e(o.vehicleImage) + '" style="width:100%;max-height:120px;object-fit:cover;border-radius:6px"><button class="sa-btn sa-btn-red" style="position:absolute;top:4px;right:4px;padding:1px 7px" data-sa="sab-img-clear">✕</button></div>' : '') +
                    (frameBtns ? '<div class="text-[11px] text-gray-500 mb-1">Use a frame grab from Footage:</div><div class="flex flex-wrap gap-1 mb-1">' + frameBtns + '</div>' : '') +
                    '<button class="sa-btn" data-sa="sab-img-load">Load an image…</button>' +
                    '<input type="file" id="saBulImg" accept="image/*" style="display:none">' +
                    (o.vehicleImage ? '<input class="sa-input mt-1" data-sab-field="vehicleCaption" placeholder="Caption, e.g. Cam 2, 10/20 03:04" value="' + e(o.vehicleCaption) + '">' : '') +
                '</div>' +
                '<div class="flex flex-col gap-2 pt-1">' +
                    '<button class="sa-btn sa-btn-orange" data-sa="sab-save-ev"' + (electron ? '' : ' disabled title="Needs the VIPER desktop app"') + '>🗎 Save PDF to Evidence</button>' +
                    '<button class="sa-btn" data-sa="sab-save-copy"' + (electron ? '' : ' disabled') + '>Save a copy…</button>' +
                '</div>' +
            '</div>' +
            '<div class="xl:col-span-8 2xl:col-span-9"><div class="sa-bul-stage" id="saBulStage"><div id="saBulScale" style="transform-origin:top left"><iframe id="saBulFrame" class="sa-bul-page" style="width:' + PAGE_W + 'px;height:1056px;border:0;display:block" title="Bulletin preview"></iframe></div></div></div>' +
        '</div>';
    }

    function fit() {
        var stage = document.getElementById('saBulStage'), sc = document.getElementById('saBulScale'), fr = document.getElementById('saBulFrame');
        if (!stage || !sc || !fr) return;
        var h = 1056;
        try { h = Math.max(1056, fr.contentDocument.documentElement.scrollHeight); } catch (_) {}
        fr.style.height = h + 'px';
        var s = Math.min(1, (stage.clientWidth - 32) / PAGE_W);
        sc.style.transform = 'scale(' + s + ')';
        sc.style.width = PAGE_W + 'px';
        sc.style.height = (h * s) + 'px';
        sc.style.marginBottom = '0';
        // keep the scaled box from reserving unscaled width
        sc.parentNode.style.height = (h * s + 32) + 'px';
    }
    function preview(ctx) {
        var fr = document.getElementById('saBulFrame');
        if (!fr) return;
        fr.onload = function () { fit(); setTimeout(fit, 400); };
        fr.srcdoc = htmlFor(ctx);
    }
    function onResize() { fit(); }

    function init(ctx) {
        UI.lastCtx = ctx;
        preview(ctx);
        window.removeEventListener('resize', onResize);
        window.addEventListener('resize', onResize);
    }

    function b64ToBytes(b64) {
        var bin = atob(b64), out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }
    function fileName(ctx) {
        var c = ctx.caseObj || {};
        var aud = storedOpts(ctx).audience === 'public' ? 'Community-Alert' : 'Bulletin';
        return (aud + '_' + (c.caseNumber || 'case') + '_' + ctx.today() + '.pdf').replace(/[^\w.\-]+/g, '_');
    }
    function busy(on, label) {
        var a = document.querySelector('[data-sa="sab-save-ev"]'), b = document.querySelector('[data-sa="sab-save-copy"]');
        [a, b].forEach(function (x) { if (x) x.disabled = !!on; });
        if (a) a.textContent = on && label ? label : '🗎 Save PDF to Evidence';
    }

    async function saveToEvidence(ctx) {
        if (!ctx.visible.length) { ctx.toast('No incidents to put on a bulletin.', 'warning'); return; }
        busy(true, 'Building PDF…');
        try {
            var name = fileName(ctx);
            var res = await window.electronAPI.saveHtmlAsPdf({ html: htmlFor(ctx), defaultFileName: name, options: { marginType: 'none', settleMs: 2200 }, returnBase64: true });
            if (!res || !res.success || !res.base64) throw new Error((res && res.error) || 'PDF was not created.');
            busy(true, 'Saving to Evidence…');
            var o = storedOpts(ctx);
            await ctx.saveToEvidence({
                fileName: name, bytes: b64ToBytes(res.base64), mime: 'application/pdf',
                description: (o.audience === 'public' ? 'Community crime alert' : 'Crime pattern bulletin') + ': ' + (o.title || ctx.data.title || 'Series Analysis') + ' (' + ctx.visible.length + ' incidents)',
                tag: 'BULLETIN-' + ctx.today().replace(/-/g, ''), source: 'series_analysis_bulletin'
            });
            o.lastSaved = new Date().toISOString();
            persist(ctx, o);
            ctx.toast('Bulletin saved to Evidence as ' + name + '.', 'success');
        } catch (e) {
            console.error('[SeriesAnalysis] bulletin', e);
            ctx.toast('Bulletin not saved: ' + (e && e.message || e), 'error');
        } finally { busy(false); }
    }
    async function saveCopy(ctx) {
        busy(true);
        try {
            var res = await window.electronAPI.saveHtmlAsPdf({ html: htmlFor(ctx), defaultFileName: fileName(ctx), options: { marginType: 'none', settleMs: 2200 } });
            if (res && res.success) ctx.toast('Bulletin saved: ' + res.path, 'success');
            else if (res && !res.canceled) ctx.toast('Bulletin not saved: ' + (res.error || 'unknown error'), 'error');
        } catch (e) { ctx.toast('Bulletin not saved: ' + (e && e.message || e), 'error'); }
        finally { busy(false); }
    }

    function shrinkImage(file, cb) {
        var fr = new FileReader();
        fr.onload = function () {
            var img = new Image();
            img.onload = function () {
                var w = img.naturalWidth, h = img.naturalHeight, max = 720;
                var s = Math.min(1, max / Math.max(w, h));
                var cv = document.createElement('canvas');
                cv.width = Math.round(w * s); cv.height = Math.round(h * s);
                cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
                cb(cv.toDataURL('image/jpeg', 0.82));
            };
            img.onerror = function () { cb(null); };
            img.src = fr.result;
        };
        fr.onerror = function () { cb(null); };
        fr.readAsDataURL(file);
    }

    function onAction(act, el, e, ctx) {
        if (act.indexOf('sab-') !== 0) return false;
        var o = storedOpts(ctx);
        switch (act) {
            case 'sab-audience': {
                var v = el.getAttribute('data-v') === 'public' ? 'public' : 'les';
                if (v === o.audience) return true;
                o.audience = v;
                if (v === 'public') { o.include.next = false; o.exactAddresses = false; } else { o.include.next = true; }
                persist(ctx, o); ctx.renderBody(); return true;
            }
            case 'sab-img-load': { var fi = document.getElementById('saBulImg'); if (fi) fi.click(); return true; }
            case 'sab-img-clear': o.vehicleImage = ''; o.vehicleCaption = ''; persist(ctx, o); ctx.renderBody(); return true;
            case 'sab-img-frame': {
                var id = el.getAttribute('data-id');
                var ob = (ctx.data.observations || []).filter(function (x) { return String(x.id) === String(id); })[0];
                if (ob && ob.frame) {
                    o.vehicleImage = ob.frame;
                    if (!o.vehicleCaption) o.vehicleCaption = (ob.cameraName ? ob.cameraName + ', ' : '') + (ob.real || '') + (ob.text ? ' · ' + ob.text : '');
                    persist(ctx, o); ctx.renderBody();
                }
                return true;
            }
            case 'sab-save-ev': saveToEvidence(ctx); return true;
            case 'sab-save-copy': saveCopy(ctx); return true;
        }
        return false;
    }

    function onChange(el, e, ctx) {
        if (el.id === 'saBulImg') {
            var f = el.files && el.files[0];
            el.value = '';
            if (!f) return true;
            shrinkImage(f, function (url) {
                if (!url) { ctx.toast('Could not read that image.', 'error'); return; }
                var o = storedOpts(ctx);
                o.vehicleImage = url;
                if (!o.vehicleCaption) o.vehicleCaption = f.name.replace(/\.[^.]+$/, '');
                persist(ctx, o); ctx.renderBody();
            });
            return true;
        }
        var inc = el.getAttribute && el.getAttribute('data-sab-inc');
        var field = el.getAttribute && el.getAttribute('data-sab-field');
        if (!inc && !field) return false;
        var o = storedOpts(ctx);
        if (inc) o.include[inc] = !!el.checked;
        else if (el.type === 'checkbox') o[field] = !!el.checked;
        else o[field] = String(el.value || '').trim();
        persist(ctx, o);
        preview(ctx);
        return true;
    }

    var API = { render: render, init: init, onAction: onAction, onChange: onChange, buildHtml: buildHtml, blockOf: blockOf, defaults: defaults, tileSrc: tileSrc };
    if (typeof module === 'object' && module && module.exports) module.exports = API;
    if (root && root.document) root.SeriesAnalysisBulletin = API;
}(typeof window !== 'undefined' ? window : globalThis));

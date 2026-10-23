/*
 * modules/case-status-report/csr-render.js
 *
 * Case Status Report — the look.
 *
 * render(model, updates, opts) → one self-contained HTML string that
 * electron-main's save-html-as-pdf prints with marginType 'none'. Every
 * page is a fixed 816×1056 px (8.5×11 in) <section> that draws its own
 * background edge to edge, so nothing depends on Chromium's pagination.
 * Anything that could run long is capped ("+3 more") or moved to a
 * continuation page instead of silently spilling.
 *
 *   model   — CaseStatusReportBuild.build(...)
 *   updates — { cases: { [caseNumber]: {update, nextSteps, blockers[], targetDate} }, statement }
 *   opts    — { theme: 'dark'|'light', includeNotes: true, logoUrl, badgeUrl }
 *
 * Fonts are Windows system fonts (Bahnschrift / Segoe UI / Consolas) — the
 * report renders offline. Charts are inline SVG / CSS; no filters (they
 * rasterize in printToPDF).
 *
 * All user text goes through esc().
 */
(function (root, factory) {
    var api = factory(root);
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root) root.CaseStatusReportRender = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    function getBuild() {
        if (root && root.CaseStatusReportBuild) return root.CaseStatusReportBuild;
        if (typeof require === 'function') { try { return require('./csr-build.js'); } catch (_) {} }
        return null;
    }

    // ── text helpers ─────────────────────────────────────────────────────
    function esc(s) {
        return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function escBr(s) { return esc(s).replace(/\r?\n/g, '<br>'); }
    function num(x) { return (Number(x) || 0).toLocaleString('en-US'); }
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    function pd(v) {
        if (!v) return null;
        var s = String(v);
        var d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T00:00:00') : new Date(s);
        return isNaN(d.getTime()) ? null : d;
    }
    function us(v) { var d = pd(v); return d ? pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + '/' + d.getFullYear() : ''; }
    function mdy(v) { var d = pd(v); return d ? (d.getMonth() + 1) + '/' + d.getDate() + '/' + String(d.getFullYear()).slice(2) : ''; }
    function md(v) { var d = pd(v); return d ? (d.getMonth() + 1) + '/' + d.getDate() : ''; }
    function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; }
    function plural(n, one, many) { return num(n) + ' ' + (n === 1 ? one : (many || one + 's')); }
    function sum(a) { return a.reduce(function (x, y) { return x + (Number(y) || 0); }, 0); }

    var BLOCKER_FALLBACK = {
        warrant: 'Awaiting warrant return', lab: 'Awaiting lab / forensics', da: 'Awaiting DA review',
        victim: 'Victim / witness unavailable', suspect: 'Suspect outstanding', agency: 'Awaiting outside agency',
        workload: 'Workload / priority cases'
    };
    var MS_COLORS = { assigned: 'var(--cyan)', warrant: 'var(--purple)', return: 'var(--green)', suspect: 'var(--yellow)',
                      arrest: 'var(--orange)', report: 'var(--cyan)', due: 'var(--orange)', today: 'var(--text)' };

    var _gid = 0;
    function gid(p) { _gid++; return p + _gid; }

    // ── charts ───────────────────────────────────────────────────────────

    /** Ring chart. segs: [{value,color}] */
    function donut(segs, o) {
        o = o || {};
        var size = o.size || 150, th = o.thickness || 18;
        var r = (size - th) / 2 - 6, cx = size / 2, C = 2 * Math.PI * r;
        var total = sum(segs.map(function (s) { return s.value; }));
        var live = segs.filter(function (s) { return s.value > 0; });
        var gap = live.length > 1 ? Math.min(4, C * 0.008) : 0;
        var out = '<svg class="donut" width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">';
        out += '<circle cx="' + cx + '" cy="' + cx + '" r="' + r + '" fill="none" style="stroke:var(--track)" stroke-width="' + th + '"/>';
        var off = 0;
        if (total > 0) {
            live.forEach(function (s) {
                var len = s.value / total * C, dl = Math.max(0.6, len - gap);
                var common = ' cx="' + cx + '" cy="' + cx + '" r="' + r + '" fill="none" stroke="' + s.color + '" stroke-dasharray="' + dl.toFixed(2) + ' ' + (C - dl).toFixed(2) +
                    '" stroke-dashoffset="' + (-off).toFixed(2) + '" transform="rotate(-90 ' + cx + ' ' + cx + ')"';
                out += '<circle class="dn-halo"' + common + ' stroke-width="' + (th + 10) + '" opacity="0.16"/>';
                out += '<circle' + common + ' stroke-width="' + th + '"/>';
                off += len;
            });
        }
        if (o.center !== undefined) {
            out += '<text x="' + cx + '" y="' + (cx + (o.sub ? 2 : 9)) + '" text-anchor="middle" class="dn-v" style="font-size:' + (o.centerSize || Math.round(size * 0.2)) + 'px">' + esc(o.center) + '</text>';
            if (o.sub) out += '<text x="' + cx + '" y="' + (cx + 18 + Math.round(size * 0.03)) + '" text-anchor="middle" class="dn-l">' + esc(o.sub) + '</text>';
        }
        return out + '</svg>';
    }

    function legend(items, o) {
        o = o || {};
        var total = sum(items.map(function (i) { return i.count; })) || 1;
        return '<div class="lg">' + items.map(function (i) {
            return '<div class="lg-row"><span class="lg-dot" style="background:' + i.color + ';box-shadow:0 0 8px ' + i.color + '"></span>' +
                '<span class="lg-l">' + esc(clip(i.label, o.clip || 34)) + '</span>' +
                '<span class="lg-n">' + num(i.count) + '</span>' +
                (o.pct ? '<span class="lg-p">' + Math.round(100 * i.count / total) + '%</span>' : '') + '</div>';
        }).join('') + '</div>';
    }

    /** Horizontal bars (HTML). items: [{label,count,color}] */
    function hbars(items, o) {
        o = o || {};
        var max = Math.max.apply(null, items.map(function (i) { return i.count; }).concat([1]));
        return '<div class="hb">' + items.map(function (i) {
            var w = i.count ? Math.max(2, Math.round(100 * i.count / max)) : 0;
            var col = i.color || 'var(--cyan)';
            return '<div class="hb-row"><div class="hb-l">' + esc(i.label) + '</div><div class="hb-t"><div class="hb-f" style="width:' + w +
                '%;background:linear-gradient(90deg,color-mix(in srgb,' + col + ' 55%,transparent),' + col + ');box-shadow:0 0 10px color-mix(in srgb,' + col + ' 45%,transparent)"></div>' +
                '<span class="hb-n">' + num(i.count) + '</span></div></div>';
        }).join('') + '</div>';
    }

    /** Vertical bars (SVG). items: [{label,value}] */
    function vbars(items, o) {
        o = o || {};
        var W = o.w || 320, H = o.h || 150, padB = 22, padT = 18, padL = 6, padR = 6;
        var max = Math.max.apply(null, items.map(function (i) { return i.value; }).concat([1]));
        var n = items.length, slot = (W - padL - padR) / n, bw = Math.min(o.barMax || 34, slot * 0.62);
        var g = gid('vb'), col = o.color || 'var(--cyan)';
        var out = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">' +
            '<defs><linearGradient id="' + g + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:' + col + '"/><stop offset="1" style="stop-color:' + col + ';stop-opacity:.25"/></linearGradient></defs>';
        for (var k = 1; k <= 3; k++) {
            var gy = padT + (H - padT - padB) * (1 - k / 3);
            out += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + gy.toFixed(1) + '" y2="' + gy.toFixed(1) + '" class="gridln"/>';
        }
        out += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + (H - padB) + '" y2="' + (H - padB) + '" class="axis"/>';
        items.forEach(function (it, i) {
            var h = it.value ? Math.max(2, (H - padT - padB) * it.value / max) : 0;
            var x = padL + slot * i + (slot - bw) / 2, y = H - padB - h;
            var fill = it.color ? it.color : 'url(#' + g + ')';
            if (h) {
                out += '<rect x="' + (x - 2).toFixed(1) + '" y="' + (y - 2).toFixed(1) + '" width="' + (bw + 4).toFixed(1) + '" height="' + (h + 2).toFixed(1) + '" rx="3" fill="' + (it.color || col) + '" opacity=".12" style="' + (it.color ? '' : 'fill:' + col) + '"/>';
                out += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="2.5" fill="' + fill + '"/>';
            }
            if (o.values !== false && (it.value || o.showZero)) out += '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (y - 5).toFixed(1) + '" text-anchor="middle" class="vb-v">' + num(it.value) + '</text>';
            if (it.label && (!o.labelEvery || i % o.labelEvery === (n - 1) % o.labelEvery)) {
                out += '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (H - 7) + '" text-anchor="middle" class="vb-l">' + esc(it.label) + '</text>';
            }
        });
        return out + '</svg>';
    }

    /** Mini bar sparkline. */
    function spark(values, o) {
        o = o || {};
        var W = o.w || 64, H = o.h || 16, n = values.length || 1, gap = o.gap === undefined ? 1.2 : o.gap;
        var bw = (W - gap * (n - 1)) / n, max = Math.max.apply(null, values.concat([1]));
        var out = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">';
        values.forEach(function (v, i) {
            var h = v ? Math.max(1.5, (H - 1) * v / max) : 1;
            out += '<rect x="' + (i * (bw + gap)).toFixed(2) + '" y="' + (H - h).toFixed(2) + '" width="' + bw.toFixed(2) + '" height="' + h.toFixed(2) + '" rx="0.8" style="fill:' +
                (v ? (o.color || 'var(--green)') : 'var(--track)') + '"/>';
        });
        return out + '</svg>';
    }

    /** Two-series line chart for the report-over-report trend. */
    function trendChart(points, o) {
        o = o || {};
        var W = o.w || 320, H = o.h || 150, padL = 26, padR = 14, padT = 16, padB = 22;
        var max = Math.max.apply(null, points.map(function (p) { return Math.max(p.open, p.overdue); }).concat([1]));
        max = Math.ceil(max * 1.15);
        var n = points.length;
        function X(i) { return n === 1 ? (padL + W - padR) / 2 : padL + (W - padL - padR) * i / (n - 1); }
        function Y(v) { return padT + (H - padT - padB) * (1 - v / max); }
        var out = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">';
        for (var k = 0; k <= 3; k++) {
            var v = Math.round(max * k / 3), y = Y(v);
            out += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '" class="gridln"/>' +
                '<text x="' + (padL - 6) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end" class="vb-l">' + v + '</text>';
        }
        [['open', 'var(--cyan)'], ['overdue', 'var(--orange)']].forEach(function (s) {
            var d = points.map(function (p, i) { return (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(p[s[0]]).toFixed(1); }).join(' ');
            out += '<path d="' + d + '" fill="none" style="stroke:' + s[1] + '" stroke-width="7" opacity=".14" stroke-linejoin="round" stroke-linecap="round"/>';
            out += '<path d="' + d + '" fill="none" style="stroke:' + s[1] + '" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>';
            points.forEach(function (p, i) {
                out += '<circle cx="' + X(i).toFixed(1) + '" cy="' + Y(p[s[0]]).toFixed(1) + '" r="' + (p.current ? 4.5 : 3) + '" style="fill:' + (p.current ? s[1] : 'var(--bg)') + ';stroke:' + s[1] + '" stroke-width="2"/>';
                if (p.current || i === 0) out += '<text x="' + X(i).toFixed(1) + '" y="' + (Y(p[s[0]]) - 8).toFixed(1) + '" text-anchor="middle" class="vb-v" style="fill:' + s[1] + '">' + p[s[0]] + '</text>';
            });
        });
        points.forEach(function (p, i) {
            out += '<text x="' + X(i).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle" class="vb-l">' + esc(p.label) + '</text>';
        });
        return out + '</svg>';
    }

    /** Case lifecycle strip: assigned → due → today with milestones in four label lanes. */
    function lifecycle(c, asOf, W) {
        var H = 102, padL = 16, padR = 16, y = 50;
        var start = pd(c.assignedDate), due = pd(c.dueDate), today = pd(asOf);
        if (!start || !due || !today) return '';
        var end = today > due ? today : due;
        var span = Math.max(1, end - start);
        function X(d) { return padL + (W - padL - padR) * Math.min(1, Math.max(0, (d - start) / span)); }
        var tierCol = c.tier && c.tier.color || '#fb923c';
        var g = gid('lc');
        var out = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">' +
            '<defs><linearGradient id="' + g + '" x1="0" x2="1"><stop offset="0" style="stop-color:var(--cyan)"/><stop offset="1" style="stop-color:var(--green)"/></linearGradient></defs>';
        out += '<line x1="' + X(start) + '" x2="' + X(end) + '" y1="' + y + '" y2="' + y + '" style="stroke:var(--track)" stroke-width="8" stroke-linecap="round"/>';
        var okEnd = today < due ? today : due;
        out += '<line x1="' + X(start) + '" x2="' + X(okEnd).toFixed(1) + '" y1="' + y + '" y2="' + y + '" stroke="url(#' + g + ')" stroke-width="8" stroke-linecap="round"/>';
        if (today > due) {
            out += '<line x1="' + X(due).toFixed(1) + '" x2="' + X(today).toFixed(1) + '" y1="' + y + '" y2="' + y + '" stroke="' + tierCol + '" stroke-width="16" opacity=".15" stroke-linecap="round"/>';
            out += '<line x1="' + X(due).toFixed(1) + '" x2="' + X(today).toFixed(1) + '" y1="' + y + '" y2="' + y + '" stroke="' + tierCol + '" stroke-width="8" stroke-linecap="round"/>';
            // Label goes in the widest stretch of the overdue bar that has no milestone dot on it.
            var odText = num(c.daysOverdue) + ' DAYS PAST DUE', tw = odText.length * 6.4 + 18;
            var stops = [X(due) + 9].concat((c.milestones || []).map(function (m) { var d = pd(m.date); return d ? X(d) : null; })
                .filter(function (x) { return x !== null && x > X(due) + 9 && x < X(today) - 9; })).concat([X(today) - 9]).sort(function (a, b) { return a - b; });
            var best = null;
            for (var si = 1; si < stops.length; si++) {
                var gw = stops[si] - stops[si - 1] - 10;
                if (gw >= tw && (!best || gw > best.w)) best = { w: gw, mid: (stops[si] + stops[si - 1]) / 2 };
            }
            if (best) out += '<text x="' + best.mid.toFixed(1) + '" y="' + (y + 3) + '" text-anchor="middle" class="lc-od">' + odText + '</text>';
        } else {
            out += '<line x1="' + X(today).toFixed(1) + '" x2="' + X(due).toFixed(1) + '" y1="' + y + '" y2="' + y + '" style="stroke:var(--muted)" stroke-width="2" stroke-dasharray="3 4"/>';
        }
        // Lanes: [dy, labelDy] above-near, below-near, above-far, below-far
        var lanes = [{ dy: -14, end: -1e9 }, { dy: 24, end: -1e9 }, { dy: -34, end: -1e9 }, { dy: 44, end: -1e9 }];
        var ms = (c.milestones || []).slice();
        ms.forEach(function (m) {
            var d = pd(m.date); if (!d) return;
            var x = X(d);
            var text = m.label + ' · ' + mdy(m.date);
            var w = text.length * 4.7 + 6;
            var anchor = 'middle', lx = x, x0 = x - w / 2;
            if (x - w / 2 < 2) { anchor = 'start'; lx = Math.max(2, x - 6); x0 = lx; }
            else if (x + w / 2 > W - 2) { anchor = 'end'; lx = Math.min(W - 2, x + 6); x0 = lx - w; }
            var lane = null;
            for (var i = 0; i < lanes.length; i++) if (lanes[i].end < x0 - 4) { lane = lanes[i]; break; }
            if (!lane) lane = lanes.slice().sort(function (a, b) { return a.end - b.end; })[0];
            lane.end = x0 + w;
            var col = MS_COLORS[m.kind] || 'var(--cyan)';
            var ly = y + lane.dy;
            if (Math.abs(lane.dy) > 20) out += '<line x1="' + x.toFixed(1) + '" x2="' + x.toFixed(1) + '" y1="' + (y + (lane.dy < 0 ? -6 : 6)) + '" y2="' + (ly + (lane.dy < 0 ? 3 : -9)) + '" style="stroke:' + col + '" stroke-width="0.8" opacity=".6"/>';
            if (m.kind === 'due') {
                out += '<rect x="' + (x - 5.5).toFixed(1) + '" y="' + (y - 5.5) + '" width="11" height="11" transform="rotate(45 ' + x.toFixed(1) + ' ' + y + ')" style="fill:var(--bg);stroke:var(--orange)" stroke-width="2.2"/>';
            } else if (m.kind === 'today') {
                out += '<circle cx="' + x.toFixed(1) + '" cy="' + y + '" r="9" style="fill:none;stroke:var(--text)" stroke-width="1" opacity=".45"/>' +
                    '<circle cx="' + x.toFixed(1) + '" cy="' + y + '" r="4.5" style="fill:var(--text)"/>';
            } else {
                out += '<circle cx="' + x.toFixed(1) + '" cy="' + y + '" r="8" style="fill:' + col + '" opacity=".22"/>' +
                    '<circle cx="' + x.toFixed(1) + '" cy="' + y + '" r="4.2" style="fill:var(--bg);stroke:' + col + '" stroke-width="2.4"/>';
            }
            out += '<text x="' + lx.toFixed(1) + '" y="' + ly + '" text-anchor="' + anchor + '" class="lc-l"><tspan style="fill:' + col + '">' + esc(m.label) + '</tspan><tspan class="lc-d"> · ' + esc(mdy(m.date)) + '</tspan></text>';
        });
        return out + '</svg>';
    }

    // ── CSS ──────────────────────────────────────────────────────────────

    var CSS = [
        '@page{size:8.5in 11in;margin:0}',
        '*{box-sizing:border-box}',
        'html,body{margin:0;padding:0;background:var(--bg);-webkit-print-color-adjust:exact;print-color-adjust:exact}',
        ':root{--bg:#060a11;--bg2:#0a0e14;--card:rgba(17,27,42,.78);--card2:rgba(22,33,50,.92);--line:rgba(0,217,255,.18);--line2:rgba(148,178,214,.12);',
        '--text:#e8f2ff;--muted:#8ea3bc;--dim:#5d6e84;--cyan:#00d9ff;--green:#00ff88;--purple:#b57bff;--orange:#ffa726;--yellow:#fbbf24;--red:#ff4d6d;--pink:#f472b6;',
        '--track:rgba(148,178,214,.12);--gridc:rgba(0,217,255,.045);--glowA:55%;--hd:"Bahnschrift SemiBold","Bahnschrift","Segoe UI",sans-serif;--hdn:"Bahnschrift","Segoe UI",sans-serif;',
        '--bd:"Segoe UI","Inter",Arial,sans-serif;--mono:Consolas,"Cascadia Mono","Courier New",monospace}',
        'body.light{--bg:#ffffff;--bg2:#f4f7fb;--card:#f7f9fc;--card2:#ffffff;--line:#d5dee9;--line2:#e3e9f1;--text:#0f1b2d;--muted:#55657a;--dim:#8592a3;',
        '--cyan:#0284c7;--green:#059669;--purple:#7c3aed;--orange:#ea580c;--yellow:#b7791f;--red:#dc2626;--pink:#db2777;--track:#e6ecf3;--gridc:rgba(15,27,45,.035);--glowA:0%}',
        'body{font-family:var(--bd);color:var(--text);font-size:10px;line-height:1.4}',
        '.page{width:816px;height:1056px;position:relative;overflow:hidden;padding:62px 44px 56px;break-after:page;page-break-after:always;',
        'background-color:var(--bg);background-image:radial-gradient(ellipse 80% 40% at 50% -8%,color-mix(in srgb,var(--cyan) 13%,transparent),transparent 70%),',
        'radial-gradient(ellipse 60% 35% at 100% 108%,color-mix(in srgb,var(--green) 8%,transparent),transparent 70%),',
        'linear-gradient(var(--gridc) 1px,transparent 1px),linear-gradient(90deg,var(--gridc) 1px,transparent 1px);background-size:auto,auto,24px 24px,24px 24px}',
        '.page:last-child{break-after:auto;page-break-after:auto}',
        'body.light .page{background-image:linear-gradient(var(--gridc) 1px,transparent 1px),linear-gradient(90deg,var(--gridc) 1px,transparent 1px);background-size:24px 24px,24px 24px}',
        '.glow{text-shadow:0 0 16px color-mix(in srgb,currentColor var(--glowA),transparent)}',
        // header / footer
        '.ph{position:absolute;top:20px;left:44px;right:44px;height:22px;display:flex;align-items:center;justify-content:space-between;font:9px var(--hd);letter-spacing:.24em;text-transform:uppercase;color:var(--muted)}',
        '.ph-l{display:flex;align-items:center;gap:9px}.ph-l img{width:20px;height:20px;border-radius:5px}.ph-l b{color:var(--text);font-weight:normal}',
        '.ph-r{color:var(--cyan)}',
        '.ph:after{content:"";position:absolute;left:0;right:0;bottom:-8px;height:1px;background:linear-gradient(90deg,var(--cyan),color-mix(in srgb,var(--cyan) 20%,transparent) 60%,transparent)}',
        '.pf{position:absolute;bottom:20px;left:44px;right:44px;display:flex;justify-content:space-between;font:8px var(--hd);letter-spacing:.22em;text-transform:uppercase;color:var(--dim)}',
        '.pf-r{color:var(--cyan)}',
        // type
        '.kick{font:10px var(--hd);letter-spacing:.32em;text-transform:uppercase;color:var(--cyan);margin-bottom:6px}',
        '.h1{font:30px/1.1 var(--hd);color:var(--text);margin:0 0 8px;letter-spacing:.01em}',
        '.h1:after{content:"";display:block;margin-top:9px;height:2px;width:100%;background:linear-gradient(90deg,var(--cyan),color-mix(in srgb,var(--purple) 50%,transparent) 55%,transparent)}',
        '.lead{font-size:11.5px;line-height:1.55;color:var(--muted);margin:0 0 16px}.lead b{color:var(--text);font-weight:600}',
        '.panel{background:var(--card);border:1px solid var(--line2);border-radius:12px;padding:13px 15px;position:relative}',
        'body:not(.light) .panel{box-shadow:inset 0 1px 0 rgba(255,255,255,.03)}',
        '.pt{font:9.5px var(--hd);letter-spacing:.26em;text-transform:uppercase;color:var(--cyan);margin:0 0 10px;display:flex;justify-content:space-between;align-items:baseline}',
        '.pt small{font:8.5px var(--bd);letter-spacing:0;text-transform:none;color:var(--dim)}',
        '.muted{color:var(--muted)}.dim{color:var(--dim)}.mono{font-family:var(--mono)}',
        '.row{display:flex;gap:14px}.col{flex:1;min-width:0}',
        // tiles
        '.tiles{display:grid;gap:11px}',
        '.tile{--ac:var(--cyan);position:relative;border-radius:11px;padding:11px 14px 10px;background:linear-gradient(135deg,color-mix(in srgb,var(--ac) 10%,var(--card)),var(--card) 60%);',
        'border:1px solid color-mix(in srgb,var(--ac) 32%,transparent);overflow:hidden}',
        '.tile:before{content:"";position:absolute;left:0;top:10px;bottom:10px;width:3px;border-radius:0 3px 3px 0;background:var(--ac);box-shadow:0 0 10px var(--ac)}',
        '.tile .v{font:30px/1 var(--hd);color:var(--ac);letter-spacing:.02em}',
        'body:not(.light) .tile .v{text-shadow:0 0 18px color-mix(in srgb,var(--ac) 55%,transparent)}',
        '.tile .v small{font-size:15px;margin-left:2px}',
        '.tile .l{font:9.5px var(--hd);letter-spacing:.14em;text-transform:uppercase;color:var(--text);margin-top:6px}',
        '.tile .s{font-size:8.8px;color:var(--muted);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.c-cyan{--ac:var(--cyan)}.c-green{--ac:var(--green)}.c-purple{--ac:var(--purple)}.c-orange{--ac:var(--orange)}.c-yellow{--ac:var(--yellow)}.c-red{--ac:var(--red)}.c-pink{--ac:var(--pink)}',
        // donut / legend / bars
        '.dn-v{font-family:var(--hd);fill:var(--text)}.dn-l{font:8px var(--hd);letter-spacing:.18em;text-transform:uppercase;fill:var(--muted)}',
        '.lg{display:flex;flex-direction:column;gap:6px;min-width:0;flex:1}.lg-row{display:flex;align-items:center;gap:8px;font-size:9.5px}',
        '.lg-dot{width:9px;height:9px;border-radius:3px;flex:none}body.light .lg-dot{box-shadow:none!important}',
        '.lg-l{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text)}.lg-n{font:11px var(--hdn);color:var(--text);min-width:18px;text-align:right}',
        '.lg-p{font-size:8.5px;color:var(--dim);min-width:26px;text-align:right}',
        '.hb{display:flex;flex-direction:column;gap:8px}.hb-row{display:flex;align-items:center;gap:10px}.hb-l{width:138px;font-size:9.5px;color:var(--muted);text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.hb-t{flex:1;display:flex;align-items:center;gap:7px;height:14px}.hb-f{height:12px;border-radius:3px}.hb-n{font:11px var(--hdn);color:var(--text)}',
        'body.light .hb-f{box-shadow:none!important}',
        '.gridln{stroke:var(--line2);stroke-width:1}.axis{stroke:var(--line);stroke-width:1}',
        '.vb-v{font:9.5px var(--hdn);fill:var(--text)}.vb-l{font:8.5px var(--bd);fill:var(--dim)}',
        '.lc-l{font:8.6px var(--bd);font-weight:600}.lc-d{fill:var(--muted);font-weight:400}.lc-od{font:8px var(--hd);letter-spacing:.16em;fill:#fff}',
        'body.light .dn-halo{display:none}',
        // pills / chips
        '.chip{display:inline-flex;align-items:center;gap:5px;font:8.8px var(--hd);letter-spacing:.12em;text-transform:uppercase;padding:3px 8px 3px;border-radius:999px;',
        'border:1px solid color-mix(in srgb,var(--cc,var(--cyan)) 45%,transparent);color:var(--cc,var(--cyan));background:color-mix(in srgb,var(--cc,var(--cyan)) 10%,transparent);white-space:nowrap}',
        '.chip i{width:6px;height:6px;border-radius:50%;background:var(--cc,var(--cyan));display:inline-block}',
        // highlights
        '.hl{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:9px}',
        '.hl li{position:relative;padding-left:18px;font-size:10.3px;line-height:1.45;color:var(--text)}',
        '.hl li:before{content:"";position:absolute;left:2px;top:4px;width:7px;height:7px;transform:rotate(45deg);background:var(--cyan);box-shadow:0 0 8px var(--cyan)}',
        'body.light .hl li:before{box-shadow:none}',
        // cover
        '.cover{padding:0}',
        '.cv{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;padding:70px 56px 0}',
        '.cv-logos{display:flex;align-items:center;gap:26px;margin-bottom:28px}',
        '.cv-logo img,.cv-badge img{display:block;width:150px;height:150px;object-fit:contain}',
        '.cv-logo img{border-radius:26px;box-shadow:0 0 40px color-mix(in srgb,var(--green) 30%,transparent),0 0 0 1px color-mix(in srgb,var(--green) 30%,transparent)}',
        'body.light .cv-logo img{box-shadow:0 6px 24px rgba(15,27,45,.18)}',
        '.cv-x{font:20px var(--hdn);color:var(--dim)}',
        '.cv-text-logo{font:46px var(--hd);letter-spacing:.2em;color:var(--green)}',
        '.cv-k{font:10.5px var(--hd);letter-spacing:.42em;text-transform:uppercase;color:var(--cyan);margin-bottom:12px;text-align:center}',
        '.cv-t{font:60px/1 var(--hd);letter-spacing:.06em;text-transform:uppercase;color:var(--text);text-align:center}',
        'body:not(.light) .cv-t{text-shadow:0 0 28px color-mix(in srgb,var(--cyan) 55%,transparent),0 0 2px color-mix(in srgb,var(--cyan) 40%,transparent)}',
        '.cv-band{margin-top:16px;padding:7px 22px;border:1px solid color-mix(in srgb,var(--green) 55%,transparent);border-radius:4px;font:19px var(--hd);letter-spacing:.06em;color:var(--green);',
        'background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--green) 9%,transparent),transparent)}',
        'body:not(.light) .cv-band{text-shadow:0 0 14px color-mix(in srgb,var(--green) 55%,transparent)}',
        '.cv-scope{margin-top:12px;font-size:12px;color:var(--muted);text-align:center}',
        '.cv-mid{display:flex;align-items:center;gap:30px;margin-top:30px;padding:18px 26px;border-radius:16px;background:var(--card);border:1px solid var(--line2)}',
        '.cv-mid .lg{min-width:210px}.cv-mid .lg-row{font-size:10.5px}',
        '.cv-stats{position:absolute;left:44px;right:44px;bottom:126px;display:flex;border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:16px 0}',
        '.cv-stat{flex:1;text-align:center;border-left:1px solid var(--line2)}.cv-stat:first-child{border-left:0}',
        '.cv-stat .v{font:28px/1 var(--hd);color:var(--ac,var(--cyan))}',
        'body:not(.light) .cv-stat .v{text-shadow:0 0 16px color-mix(in srgb,var(--ac,var(--cyan)) 55%,transparent)}',
        '.cv-stat .l{font:8.5px var(--hd);letter-spacing:.2em;text-transform:uppercase;color:var(--muted);margin-top:7px}',
        '.cv-meta{position:absolute;left:44px;right:44px;bottom:56px;display:flex;justify-content:space-between}',
        '.cv-meta>div{flex:1}.cv-meta>div:nth-child(2){text-align:center}.cv-meta>div:nth-child(3){text-align:right}',
        '.cv-meta .k{font:8.5px var(--hd);letter-spacing:.26em;text-transform:uppercase;color:var(--dim);margin-bottom:4px}',
        '.cv-meta .v{font:11.5px var(--hd);color:var(--text)}.cv-meta .s{font-size:9.5px;color:var(--muted)}',
        // callout
        '.callout{display:flex;align-items:center;gap:22px;padding:14px 22px;border-radius:14px;border:1px solid color-mix(in srgb,var(--green) 40%,transparent);',
        'background:linear-gradient(90deg,color-mix(in srgb,var(--green) 12%,var(--card)),var(--card))}',
        '.callout .v{font:44px/1 var(--hd);color:var(--green)}body:not(.light) .callout .v{text-shadow:0 0 22px color-mix(in srgb,var(--green) 60%,transparent)}',
        '.callout .t{font:13px var(--hd);color:var(--text);margin-bottom:3px}.callout .s{font-size:10px;color:var(--muted)}',
        // tier stack bar
        '.stack{display:flex;height:22px;border-radius:6px;overflow:hidden;background:var(--track)}',
        '.stack div{height:100%;display:flex;align-items:center;justify-content:center;font:10px var(--hdn);color:#08111c;min-width:0}',
        '.stack-lg{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:9px}.stack-lg span{display:inline-flex;align-items:center;gap:6px;font-size:9.3px;color:var(--muted)}',
        '.stack-lg i{width:9px;height:9px;border-radius:3px;display:inline-block}.stack-lg b{color:var(--text);font:10.5px var(--hdn)}',
        // table
        'table.ov{width:728px;table-layout:fixed;border-collapse:separate;border-spacing:0 4px;font-size:9.2px}',
        '.ov th{font:8px var(--hd);letter-spacing:.12em;text-transform:uppercase;color:var(--dim);text-align:left;padding:0 5px 3px;font-weight:normal;white-space:nowrap;overflow:hidden}',
        '.ov td{background:var(--card);padding:4px 5px;border-top:1px solid var(--line2);border-bottom:1px solid var(--line2);vertical-align:middle;height:34px;overflow:hidden}',
        '.ov td:first-child{border-left:3px solid var(--tc,var(--line2));border-radius:7px 0 0 7px;font:10px var(--hdn);color:var(--dim);text-align:center}',
        '.ov td:last-child{border-right:1px solid var(--line2);border-radius:0 7px 7px 0}',
        '.ov .cn{font:10.5px var(--mono);color:var(--cyan);font-weight:bold;white-space:nowrap}.ov .of{font-size:8.4px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.ov .r{text-align:right}.ov .num{font:11px var(--hdn);color:var(--text)}',
        '.heat{height:4px;border-radius:2px;background:var(--track);margin-top:3px;width:54px}.heat i{display:block;height:100%;border-radius:2px}',
        '.due{display:inline-block;font:9.5px var(--hdn);padding:2px 7px;border-radius:5px;white-space:nowrap}',
        '.st{display:inline-flex;align-items:center;gap:5px;white-space:nowrap;font-size:9px}.st i{width:7px;height:7px;border-radius:50%;display:inline-block}',
        // spotlight
        '.sp-h{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;margin-bottom:10px}',
        '.sp-k{font:9.5px var(--hd);letter-spacing:.3em;text-transform:uppercase;color:var(--dim);margin-bottom:3px}',
        '.sp-cn{font:30px/1 var(--mono);font-weight:bold;color:var(--cyan);letter-spacing:.02em}',
        'body:not(.light) .sp-cn{text-shadow:0 0 18px color-mix(in srgb,var(--cyan) 55%,transparent)}',
        '.sp-of{font:15px var(--hd);color:var(--text);margin-top:5px}',
        '.sp-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}',
        '.sp-of-r{text-align:right;flex:none}.sp-of-r .n{font:34px/1 var(--hd);color:var(--tc)}',
        'body:not(.light) .sp-of-r .n{text-shadow:0 0 18px color-mix(in srgb,var(--tc) 55%,transparent)}',
        '.sp-of-r .l{font:8.5px var(--hd);letter-spacing:.2em;text-transform:uppercase;color:var(--muted);margin-top:4px}',
        '.sp-tiles{grid-template-columns:repeat(4,1fr);margin-bottom:10px}.sp-tiles .tile{padding:9px 12px 8px}.sp-tiles .tile .v{font-size:25px}',
        '.upd{border:1px solid color-mix(in srgb,var(--green) 45%,transparent);background:linear-gradient(135deg,color-mix(in srgb,var(--green) 8%,var(--card)),var(--card) 55%);border-radius:12px;padding:11px 15px 11px;margin-bottom:10px}',
        '.upd .pt{color:var(--green)}.upd-b{font-size:10.4px;line-height:1.5;color:var(--text)}',
        '.upd-sec{display:flex;gap:14px;margin-top:8px}.upd-sec>div{flex:1;min-width:0}',
        '.upd-k{font:8.4px var(--hd);letter-spacing:.2em;text-transform:uppercase;color:var(--dim);margin-bottom:3px}',
        '.upd-prev{margin-top:8px;padding-top:7px;border-top:1px dashed var(--line2);font-size:8.8px;color:var(--muted)}',
        '.none{color:var(--dim);font-style:italic}',
        '.lc{padding:9px 12px 4px;margin-bottom:10px}',
        '.mini{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin-top:7px}',
        '.mini div{border:1px solid var(--line2);border-radius:6px;padding:3px 7px 3px;background:var(--card2)}',
        '.mini b{display:block;font:13px/1.1 var(--hdn);color:var(--text)}.mini span{font-size:7.4px;letter-spacing:.06em;text-transform:uppercase;color:var(--dim)}',
        '.mini .z b{color:var(--dim)}',
        '.li{display:flex;align-items:center;gap:8px;padding:4.5px 0;border-bottom:1px solid var(--line2);font-size:9.4px}.li:last-child{border-bottom:0}',
        '.li .t{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.li .d{color:var(--dim);font-size:8.6px;white-space:nowrap}',
        '.dot{width:7px;height:7px;border-radius:50%;flex:none}',
        '.box{width:9px;height:9px;border:1.4px solid var(--muted);border-radius:2px;flex:none}.box.od{border-color:var(--red)}',
        '.chk{width:9px;height:9px;border-radius:2px;background:var(--green);flex:none;position:relative}',
        '.chk:after{content:"";position:absolute;left:2.6px;top:.6px;width:2.4px;height:5px;border:solid #06240f;border-width:0 1.4px 1.4px 0;transform:rotate(45deg)}',
        '.wpill{font:8.4px var(--hd);letter-spacing:.06em;padding:1.5px 6px;border-radius:4px;white-space:nowrap}',
        '.more{font-size:8.6px;color:var(--dim);margin-top:4px}',
        '.note{padding:6px 0 7px;border-bottom:1px solid var(--line2)}.note:last-child{border-bottom:0}',
        '.note-h{display:flex;justify-content:space-between;gap:8px;font-size:9.6px;font-weight:600;color:var(--text)}.note-h span{font-weight:400;color:var(--dim);font-size:8.6px;white-space:nowrap}',
        '.note-x{font-size:9.1px;color:var(--muted);margin-top:2px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
        '.syn{font-size:9.6px;line-height:1.5;color:var(--muted);display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden}',
        // statement page
        '.sig{display:flex;gap:28px;margin-top:26px}.sig>div{flex:1}.sig .ln{border-bottom:1px solid var(--muted);height:30px}',
        '.sig .k{font:8.5px var(--hd);letter-spacing:.2em;text-transform:uppercase;color:var(--dim);margin-top:5px}',
        '.cb{display:flex;align-items:center;gap:8px;font-size:10px;color:var(--text);margin:6px 0}.cb i{width:11px;height:11px;border:1.4px solid var(--muted);border-radius:2px;display:inline-block}',
        '.lines div{border-bottom:1px solid var(--line2);height:24px}',
        '.meth{font-size:8.9px;line-height:1.5;color:var(--muted);columns:2;column-gap:22px}.meth p{margin:0 0 6px;break-inside:avoid}.meth b{color:var(--text);font-weight:600}',
        '.empty{text-align:center;padding:40px 20px}.empty .v{font:54px var(--hd);color:var(--green)}.empty .t{font:16px var(--hd);color:var(--text);margin-top:6px}'
    ].join('\n');

    // ── pieces ───────────────────────────────────────────────────────────

    function tile(color, value, label, sub, extraCls) {
        return '<div class="tile c-' + color + (extraCls ? ' ' + extraCls : '') + '"><div class="v">' + value + '</div><div class="l">' + esc(label) + '</div>' +
            (sub ? '<div class="s">' + sub + '</div>' : '') + '</div>';
    }
    function chip(label, color, dot) {
        return '<span class="chip" style="--cc:' + color + '">' + (dot ? '<i></i>' : '') + esc(label) + '</span>';
    }
    function blank(s) { return '<span class="none">' + esc(s) + '</span>'; }
    function dueCell(c) {
        if (c.overdue) {
            return '<span class="due" style="background:color-mix(in srgb,' + c.tier.color + ' 18%,transparent);color:' + c.tier.color + ';border:1px solid color-mix(in srgb,' + c.tier.color + ' 45%,transparent)">+' + num(c.daysOverdue) + 'd over</span>';
        }
        return '<span class="due" style="color:' + c.tier.color + ';border:1px solid color-mix(in srgb,' + c.tier.color + ' 35%,transparent)">' + num(c.daysLeft) + 'd left</span>';
    }
    function periodBits(p) {
        var b = [];
        if (p.notes) b.push(plural(p.notes, 'note'));
        if (p.warrantsIssued) b.push(plural(p.warrantsIssued, 'warrant'));
        if (p.warrantReturns) b.push(plural(p.warrantReturns, 'return'));
        if (p.tasksCompleted) b.push(plural(p.tasksCompleted, 'task') + ' done');
        if (p.fieldWork) b.push(plural(p.fieldWork, 'field entry', 'field entries'));
        if (p.evidence) b.push(plural(p.evidence, 'evidence item'));
        if (p.arrests) b.push(plural(p.arrests, 'arrest'));
        return b;
    }

    // ── render ───────────────────────────────────────────────────────────

    function render(model, updates, opts) {
        model = model || {};
        updates = updates || {};
        opts = opts || {};
        _gid = 0;
        var B = getBuild();
        var T = model.totals || {}, CH = model.charts || {}, ID = model.identity || {}, OP = model.options || {};
        var th = OP.thresholdDays || 30;
        var cases = model.cases || [];
        var upd = (updates && updates.cases) || {};
        var light = opts.theme === 'light';
        var includeNotes = opts.includeNotes !== false;
        var logo = opts.logoUrl ? '<img src="' + esc(opts.logoUrl) + '" alt="">' : '';
        var who = ID.name || 'Investigator';
        var agency = ID.agency || '';
        var pages = [];

        function addPage(section, body, cls) { pages.push({ section: section, body: body, cls: cls || '' }); }

        // ── 1. Cover ──
        (function () {
            var tiers = (CH.tiers || []).filter(function (t) { return t.count > 0; });
            var ring = donut((CH.tiers || []).map(function (t) { return { value: t.count, color: t.color }; }),
                { size: 210, thickness: 22, center: num(T.inReport), sub: 'cases in report', centerSize: 54 });
            var scopeLine = OP.scope === 'all'
                ? 'All open cases &nbsp;·&nbsp; ' + th + '-day threshold'
                : 'Cases open longer than ' + th + ' days from assignment';
            var logos = '<div class="cv-logos">' +
                (opts.logoUrl ? '<div class="cv-logo"><img src="' + esc(opts.logoUrl) + '" alt=""></div>' : '<div class="cv-text-logo">V.I.P.E.R.</div>') +
                (opts.badgeUrl ? '<div class="cv-x">×</div><div class="cv-badge"><img src="' + esc(opts.badgeUrl) + '" alt=""></div>' : '') + '</div>';
            var stats = [
                ['cyan', num(T.openCases), 'Open cases'],
                ['orange', num(T.overThreshold), 'Over ' + th + ' days'],
                ['green', (T.workedPct || 0) + '%', 'Worked this period'],
                ['purple', num(T.actionsThisPeriod), 'Actions logged'],
                ['yellow', num(T.warrantsOutstanding), 'Warrants pending']
            ].map(function (s) {
                return '<div class="cv-stat" style="--ac:var(--' + s[0] + ')"><div class="v">' + s[1] + '</div><div class="l">' + esc(s[2]) + '</div></div>';
            }).join('');
            var idLine = [ID.rank, ID.badge ? 'Badge #' + ID.badge : ''].filter(Boolean).join(' · ');
            var body = '<div class="cv">' + logos +
                '<div class="cv-k">' + esc(agency ? agency : 'Investigative caseload') + '</div>' +
                '<div class="cv-t">Case Status Report</div>' +
                '<div class="cv-band">Reporting period ' + esc(model.period ? model.period.label : '') + '</div>' +
                '<div class="cv-scope">' + scopeLine + '</div>' +
                (T.inReport ? '<div class="cv-mid">' + ring + legend(tiers.length ? tiers : CH.tiers || [], { pct: true }) + '</div>'
                    : '<div class="cv-mid"><div class="empty" style="padding:10px 30px"><div class="v">0</div><div class="t">No cases over the ' + th + '-day mark</div></div></div>') +
                '</div>' +
                '<div class="cv-stats">' + stats + '</div>' +
                '<div class="cv-meta">' +
                '<div><div class="k">Prepared by</div><div class="v">' + esc(who) + '</div><div class="s">' + esc(idLine) + '</div></div>' +
                '<div><div class="k">Agency</div><div class="v">' + esc(agency || '—') + '</div><div class="s">Generated with V.I.P.E.R.</div></div>' +
                '<div><div class="k">Data as of</div><div class="v">' + esc(us(model.asOf)) + '</div><div class="s">' + esc(plural(model.period ? model.period.days : 0, 'day')) + ' reporting period</div></div>' +
                '</div>';
            addPage('', body, 'cover');
        }());

        // ── 2. Executive summary ──
        (function () {
            var leadParts = [];
            leadParts.push('<b>' + plural(T.openCases, 'open case') + '</b> as of ' + esc(us(model.asOf)) + '; <b>' + num(T.overThreshold) + '</b> ' +
                (T.overThreshold === 1 ? 'has' : 'have') + ' passed the ' + th + '-day mark' + (T.avgOverdueDays ? ' (average ' + plural(T.avgOverdueDays, 'day') + ' past due)' : '') + '.');
            if (T.inReport) leadParts.push('During the ' + plural(model.period.days, 'day') + ' reporting period, <b>' + num(T.workedThisPeriod) + ' of ' + num(T.inReport) +
                '</b> cases in this report (' + T.workedPct + '%) had recorded activity — <b>' + plural(T.actionsThisPeriod, 'action') + '</b> logged in VIPER.');
            var tiles = '<div class="tiles" style="grid-template-columns:repeat(3,1fr);margin-bottom:14px">' +
                tile('cyan', num(T.openCases), 'Open cases', esc(num(T.inReport) + ' in this report' + (OP.includeAssist ? ' · assists included' : ''))) +
                tile('orange', num(T.overThreshold), 'Over ' + th + ' days', T.avgOverdueDays ? 'avg ' + num(T.avgOverdueDays) + ' days past due' : 'none past due') +
                tile('yellow', num(T.dueSoon), 'Due within 14 days', 'will cross the ' + th + '-day mark') +
                tile('purple', num(T.medianAgeDays) + '<small>d</small>', 'Median case age', 'average ' + num(T.avgAgeDays) + ' days since assignment') +
                tile('green', (T.workedPct || 0) + '<small>%</small>', 'Worked this period', num(T.workedThisPeriod) + ' of ' + num(T.inReport) + ' cases had activity') +
                tile('cyan', num(T.actionsThisPeriod), 'Actions logged', 'notes · warrants · tasks · field work') +
                tile('purple', num(T.warrantsOutstanding), 'Warrants pending', T.warrantsOverdue ? num(T.warrantsOverdue) + ' past due from the provider' : 'none past due') +
                tile('red', num(T.tasksOverdue), 'Overdue tasks', 'open tasks past their date') +
                tile('green', num(T.closedThisPeriod) + '<small style="color:var(--muted)"> / </small>' + num(T.arrestsThisPeriod), 'Closed / Arrests', 'cases closed and arrests this period') +
                '</div>';
            var tiers = CH.tiers || [];
            var tot = sum(tiers.map(function (t) { return t.count; }));
            var stack = '<div class="panel" style="margin-bottom:14px"><div class="pt">Threshold status<small>days since assignment vs. the ' + th + '-day mark</small></div>' +
                '<div class="stack">' + (tot ? tiers.filter(function (t) { return t.count; }).map(function (t) {
                    var w = 100 * t.count / tot;
                    return '<div style="width:' + w.toFixed(2) + '%;background:' + t.color + '">' + (w > 4 ? t.count : '') + '</div>';
                }).join('') : '') + '</div>' +
                '<div class="stack-lg">' + tiers.map(function (t) { return '<span><i style="background:' + t.color + '"></i>' + esc(t.label) + ' <b>' + t.count + '</b></span>'; }).join('') + '</div></div>';
            var hl = (model.highlights || []);
            var hlPanel = '<div class="panel col"><div class="pt">Highlights</div>' +
                (hl.length ? '<ul class="hl">' + hl.map(function (h) { return '<li>' + esc(h) + '</li>'; }).join('') + '</ul>' : blank('Nothing to report.')) + '</div>';
            var agePanel = '<div class="panel col"><div class="pt">Age since assignment<small>days</small></div>' +
                vbars((CH.ageBuckets || []).map(function (b, i) {
                    var cols = ['#10b981', '#facc15', '#fb923c', '#f97316', '#f43f5e', '#e11d74'];
                    return { label: b.label, value: b.count, color: cols[i] };
                }), { w: 318, h: 196, barMax: 36 }) + '</div>';
            var callout = '';
            if (T.inReport) {
                callout = '<div class="callout" style="margin-top:14px"><div class="v">' + (T.workedPct || 0) + '%</div><div><div class="t">of the cases in this report were worked during the period.</div>' +
                    '<div class="s">' + esc(num(T.idleCount) + ' had no recorded activity' + (T.staleCount ? ' · ' + plural(T.staleCount, 'case') + ' idle more than 30 days' : '') +
                        (T.missingAssignDate ? ' · ' + plural(T.missingAssignDate, 'case') + ' used the creation date for assignment' : '')) + '</div></div></div>';
            }
            var body = '<div class="kick">Executive summary</div><div class="h1">Caseload at a Glance</div>' +
                '<p class="lead">' + leadParts.join(' ') + '</p>' + tiles + stack +
                '<div class="row" style="height:268px">' + hlPanel + agePanel + '</div>' + callout;
            addPage('Executive Summary', body);
        }());

        // ── 3. Analytics ──
        if (cases.length) (function () {
            var off = CH.offense || [], st = CH.status || [];
            var offPanel = '<div class="panel col"><div class="pt">Offense mix</div><div style="display:flex;align-items:center;gap:16px">' +
                donut(off.map(function (o) { return { value: o.count, color: o.color }; }), { size: 150, thickness: 20, center: num(T.inReport), sub: 'cases' }) +
                legend(off, { clip: 30 }) + '</div></div>';
            var stPanel = '<div class="panel col"><div class="pt">Case status</div><div style="display:flex;align-items:center;gap:16px">' +
                donut(st.map(function (o) { return { value: o.count, color: o.color }; }), { size: 150, thickness: 20, center: st.length, sub: st.length === 1 ? 'status' : 'statuses' }) +
                legend(st, { pct: true }) + '</div></div>';
            var wk = CH.activityByWeek || [];
            var actPanel = '<div class="panel" style="margin:14px 0"><div class="pt">Investigative activity — last 12 weeks<small>actions recorded in VIPER across the cases in this report, by week</small></div>' +
                vbars(wk.map(function (w) { return { label: md(w.weekStart), value: w.count }; }), { w: 698, h: 170, barMax: 38, color: 'var(--green)' }) + '</div>';
            var bc = B && B.blockerCounts ? B.blockerCounts(model, updates) : Object.keys(BLOCKER_FALLBACK).map(function (k) {
                var n = 0; cases.forEach(function (c) { var u = upd[c.caseNumber]; if (u && u.blockers && u.blockers.indexOf(k) !== -1) n++; });
                return { id: k, label: BLOCKER_FALLBACK[k], count: n };
            });
            var anyBlock = bc.some(function (b) { return b.count > 0; });
            var blkPanel = '<div class="panel col"><div class="pt">What is holding cases<small>blockers reported by the investigator</small></div>' +
                (anyBlock ? hbars(bc.slice().sort(function (a, b) { return b.count - a.count; }).map(function (b) { return { label: b.label, count: b.count, color: 'var(--orange)' }; }))
                    : blank('No blockers were reported for this period.')) + '</div>';
            var tr = CH.trend || [];
            var trPanel = '<div class="panel col"><div class="pt">Report-over-report trend<small><span style="color:var(--cyan)">■</span> open &nbsp;<span style="color:var(--orange)">■</span> over ' + th + ' days</small></div>' +
                (tr.length > 1 ? trendChart(tr, { w: 318, h: 190 })
                    : '<div style="height:150px;display:flex;align-items:center;justify-content:center;text-align:center" class="muted">The trend builds as reports are generated.<br>This is the first one on file.</div>') + '</div>';
            var body = '<div class="kick">Caseload analytics</div><div class="h1">Where the Work Is</div>' +
                '<p class="lead">What the open caseload is made of, how much investigative work went into it over the last twelve weeks, and what is standing in the way of closing it.</p>' +
                '<div class="row" style="height:212px">' + offPanel + stPanel + '</div>' + actPanel +
                '<div class="row" style="height:258px">' + blkPanel + trPanel + '</div>';
            addPage('Caseload Analytics', body);
        }());

        // ── 4. Caseload overview table ──
        if (cases.length) (function () {
            // ≤20 rows a page, spread evenly so the last page isn't a 2-row stub.
            var nPages = Math.ceil(cases.length / 20);
            var PER = Math.ceil(cases.length / nPages);
            var maxAge = Math.max.apply(null, cases.map(function (c) { return c.ageDays; }).concat([1]));
            for (var p = 0; p * PER < cases.length; p++) {
                var slice = cases.slice(p * PER, (p + 1) * PER);
                var rows = slice.map(function (c, i) {
                    var u = upd[c.caseNumber] || {};
                    var la = c.lastActivity ? (c.lastActivity.daysAgo === 0 ? 'Today' : num(c.lastActivity.daysAgo) + 'd ago') : '—';
                    var laCol = !c.lastActivity || c.lastActivity.daysAgo > 30 ? 'var(--red)' : (c.lastActivity.daysAgo > 14 ? 'var(--yellow)' : 'var(--text)');
                    return '<tr style="--tc:' + c.tier.color + '">' +
                        '<td>' + (p * PER + i + 1) + '</td>' +
                        '<td><div class="cn">' + esc(c.caseNumber) + '</div><div class="of">' + esc(c.offense) + '</div></td>' +
                        '<td>' + esc(us(c.assignedDate)) + (c.assignedEstimated ? ' <span class="dim">est.</span>' : '') + '</td>' +
                        '<td><span class="num">' + num(c.ageDays) + '</span><span class="dim">d</span><div class="heat"><i style="width:' + Math.max(3, Math.round(100 * c.ageDays / maxAge)) + '%;background:' + c.tier.color + '"></i></div></td>' +
                        '<td>' + dueCell(c) + '</td>' +
                        '<td><span class="st"><i style="background:' + c.status.color + '"></i>' + esc(clip(c.status.label, 18)) + '</span></td>' +
                        '<td><div style="display:flex;align-items:center;gap:7px"><span class="num" style="min-width:16px;text-align:right">' + num(c.period.total) + '</span>' + spark(c.weekly || [], { w: 56, h: 15 }) + '</div></td>' +
                        '<td style="color:' + laCol + ';white-space:nowrap">' + la + '</td>' +
                        '<td class="r"><span class="num"' + (c.warrantCounts.overdue ? ' style="color:var(--red)"' : '') + '>' + c.warrantCounts.open + '</span>' + (c.warrantCounts.overdue ? '<div style="color:var(--red);font-size:7.6px;white-space:nowrap">' + c.warrantCounts.overdue + ' late</div>' : '') + '</td>' +
                        '<td class="r">' + (u.blockers && u.blockers.length ? '<span style="color:var(--orange)">' + u.blockers.length + '</span>' : '<span class="dim">—</span>') + '</td>' +
                        '</tr>';
                }).join('');
                var body = (p === 0
                    ? '<div class="kick">Caseload overview</div><div class="h1">Every Case in This Report</div>' +
                      '<p class="lead" style="margin-bottom:10px">Sorted by days past due. The bar under each age shows it against the oldest case; the sparkline is twelve weeks of recorded activity.</p>'
                    : '<div class="kick">Caseload overview · continued</div><div class="h1" style="font-size:22px">Every Case in This Report</div>') +
                    '<table class="ov"><colgroup><col style="width:30px"><col style="width:168px"><col style="width:74px"><col style="width:70px"><col style="width:76px"><col style="width:82px"><col style="width:92px"><col style="width:56px"><col style="width:46px"><col style="width:34px"></colgroup>' +
                    '<thead><tr><th>#</th><th>Case</th><th>Assigned</th><th>Age</th><th>' + th + '-day mark</th><th>Status</th><th>Period · 12 wk</th><th>Last act.</th><th class="r">Warr.</th><th class="r">Blk.</th></tr></thead><tbody>' +
                    rows + '</tbody></table>';
                addPage('Caseload Overview', body);
            }
        }());

        // ── 5. Case spotlights ──
        cases.forEach(function (c, idx) {
            var u = (B && B.sanitizeUpdate) ? B.sanitizeUpdate(upd[c.caseNumber]) : (upd[c.caseNumber] || {});
            var tc = c.tier.color;
            var chips = [chip(c.status.label, c.status.color, true), chip(c.tier.label, tc)];
            if (c.priorityLabel) chips.push(chip(c.priorityLabel + ' priority', c.priority === 3 ? 'var(--red)' : (c.priority === 2 ? 'var(--orange)' : 'var(--muted)')));
            if (c.icac) chips.push(chip('ICAC', 'var(--purple)'));
            if (c.assist) chips.push(chip('Assist', 'var(--muted)'));
            if (c.offenseType) chips.push(chip(c.offenseType, 'var(--cyan)'));
            if (c.assignedEstimated) chips.push(chip('Assignment date estimated', 'var(--yellow)'));
            var right = c.overdue
                ? '<div class="sp-of-r" style="--tc:' + tc + '"><div class="n">+' + num(c.daysOverdue) + '</div><div class="l">days past due</div></div>'
                : '<div class="sp-of-r" style="--tc:' + tc + '"><div class="n">' + num(c.daysLeft) + '</div><div class="l">days until due</div></div>';
            var head = '<div class="sp-h"><div style="min-width:0"><div class="sp-k">Case ' + (idx + 1) + ' of ' + cases.length + '</div>' +
                '<div class="sp-cn">' + esc(c.caseNumber) + '</div><div class="sp-of">' + esc(clip(c.offense, 70)) + '</div>' +
                '<div class="sp-chips">' + chips.join('') + '</div></div>' + right + '</div>';

            var bits = periodBits(c.period);
            var la = c.lastActivity;
            var tiles = '<div class="tiles sp-tiles">' +
                tile('cyan', num(c.ageDays) + '<small>d</small>', 'Since assignment', esc((c.assignedEstimated ? 'Opened ' : 'Assigned ') + us(c.assignedDate))) +
                tile(c.overdue ? 'orange' : 'green', esc(us(c.dueDate)), th + '-day mark', c.overdue ? esc(plural(c.daysOverdue, 'day') + ' ago') : esc('in ' + plural(c.daysLeft, 'day'))) +
                tile('green', num(c.period.total), 'Actions this period', esc(bits.length ? bits.slice(0, 3).join(' · ') : 'none recorded')) +
                tile(la && la.daysAgo <= 14 ? 'purple' : (la && la.daysAgo <= 30 ? 'yellow' : 'red'), la ? num(la.daysAgo) + '<small>d</small>' : '—', 'Since last activity',
                    esc(la ? clip(la.label, 44) : 'no activity recorded')) +
                '</div>';

            // Investigator update (clip on page; overflow → continuation page)
            var UPD_MAX = 760, NEXT_MAX = 300;
            var updText = u.update || '', nextText = u.nextSteps || '';
            var overflow = updText.length > UPD_MAX || nextText.length > NEXT_MAX;
            var blk = (u.blockers || []).map(function (b) {
                var lbl = (B && B.BLOCKERS ? (B.BLOCKERS.filter(function (x) { return x.id === b; })[0] || {}).label : BLOCKER_FALLBACK[b]) || b;
                return chip(lbl, 'var(--orange)');
            }).join(' ');
            var prev = c.previous && c.previous.update && c.previous.update !== updText
                ? '<div class="upd-prev"><b style="color:var(--text);font-weight:600">Last report (' + esc(us(c.previous.generatedAt)) + '):</b> ' + esc(clip(c.previous.update, 210)) + '</div>' : '';
            var updBox = '<div class="upd"><div class="pt">Investigator update<small>' + (u.targetDate ? 'Target resolution: <b style="color:var(--text)">' + esc(us(u.targetDate)) + '</b>' : '') + '</small></div>' +
                '<div class="upd-b">' + (updText ? escBr(clip(updText, UPD_MAX)) : blank('No update provided.')) + '</div>' +
                '<div class="upd-sec"><div><div class="upd-k">Next steps</div><div class="upd-b" style="font-size:9.8px">' + (nextText ? escBr(clip(nextText, NEXT_MAX)) : blank('None listed.')) + '</div></div>' +
                '<div style="flex:.9"><div class="upd-k">Blockers</div><div style="display:flex;flex-wrap:wrap;gap:5px">' + (blk || blank('None reported.')) + '</div></div></div>' +
                (overflow ? '<div class="more">Full update continues on the next page.</div>' : '') + prev + '</div>';

            var lc = '<div class="panel lc"><div class="pt" style="margin-bottom:0">Case lifecycle<small>assignment → ' + th + '-day mark → today</small></div>' + lifecycle(c, model.asOf, 702) + '</div>';

            var P = c.period;
            var miniCells = [['Notes', P.notes], ['Evidence', P.evidence], ['Warrants', P.warrantsIssued], ['Returns', P.warrantReturns],
                ['Tasks done', P.tasksCompleted], ['Field work', P.fieldWork], ['Suspects', P.suspectsAdded], ['Arrests', P.arrests]];
            var actPanel = '<div class="panel col"><div class="pt">Activity<small>12 weeks · this period below</small></div>' +
                spark(c.weekly || [], { w: 312, h: 30, gap: 4 }) +
                '<div class="mini">' + miniCells.map(function (m) { return '<div class="' + (m[1] ? '' : 'z') + '"><b>' + num(m[1]) + '</b><span>' + m[0] + '</span></div>'; }).join('') + '</div></div>';
            var susp = c.suspects || { total: 0 };
            var synPanel = '<div class="panel col"><div class="pt">Synopsis<small>' + esc(plural(c.noteCount, 'note') + ' · ' + plural(c.evidenceCount, 'evidence item') +
                (susp.total ? ' · ' + plural(susp.total, 'suspect') + (susp.arrested ? ' (' + susp.arrested + ' arrested)' : '') : '')) + '</small></div>' +
                '<div class="syn">' + (c.synopsis ? esc(c.synopsis) : blank('No synopsis on the case.')) + '</div></div>';

            var WMAX = 5;
            var wl = c.warrants || [];
            var wRows = wl.slice(0, WMAX).map(function (w) {
                var col = !w.open ? 'var(--green)' : (w.overdue ? 'var(--red)' : 'var(--yellow)');
                return '<div class="li"><span class="dot" style="background:' + col + '"></span><span class="t">' + esc(w.label) + (w.ref ? ' <span class="dim mono" style="font-size:8.4px">' + esc(w.ref) + '</span>' : '') + '</span>' +
                    '<span class="d">' + esc(mdy(w.issued)) + '</span><span class="wpill" style="color:' + col + ';background:color-mix(in srgb,' + col + ' 14%,transparent)">' + esc(w.statusLabel) + '</span></div>';
            }).join('');
            var wc = c.warrantCounts;
            var wPanel = '<div class="panel col"><div class="pt">Warrants<small>' + wc.total + ' total · ' + wc.open + ' pending · ' + wc.returned + ' returned</small></div>' +
                (wl.length ? wRows + (wl.length > WMAX ? '<div class="more">+' + (wl.length - WMAX) + ' more</div>' : '') : blank('No warrants logged.')) + '</div>';

            var TO = 4, TD = 2;
            var tk = c.tasks;
            var tRows = tk.open.slice(0, TO).map(function (t) {
                return '<div class="li"><span class="box' + (t.overdue ? ' od' : '') + '"></span><span class="t">' + esc(t.title) + '</span><span class="d" style="' + (t.overdue ? 'color:var(--red)' : '') + '">' +
                    (t.date ? (t.overdue ? 'was due ' : 'due ') + esc(mdy(t.date)) : 'no date') + '</span></div>';
            }).join('') + tk.completed.slice(0, TD).map(function (t) {
                return '<div class="li"><span class="chk"></span><span class="t muted">' + esc(t.title) + '</span><span class="d">done ' + esc(mdy(t.completedAt)) + '</span></div>';
            }).join('');
            var hidden = Math.max(0, tk.open.length - TO) + Math.max(0, tk.completed.length - TD);
            var tPanel = '<div class="panel col"><div class="pt">Tasks<small>' + tk.openCount + ' open' + (tk.overdueCount ? ' · <span style="color:var(--red)">' + tk.overdueCount + ' overdue</span>' : '') + ' · ' + tk.completedCount + ' done</small></div>' +
                (tk.open.length || tk.completed.length ? tRows + (hidden ? '<div class="more">+' + hidden + ' more</div>' : '') : blank('No tasks on this case.')) + '</div>';

            var notesPanel;
            if (includeNotes) {
                var NN = 3;
                notesPanel = '<div class="panel" style="flex:1;min-height:0;overflow:hidden"><div class="pt">Recent case notes<small>' + (c.noteCount > NN ? 'latest ' + NN + ' of ' + c.noteCount : plural(c.noteCount, 'note')) + '</small></div>' +
                    (c.notes.length ? c.notes.slice(0, NN).map(function (n) {
                        return '<div class="note"><div class="note-h">' + esc(clip(n.title, 80)) + '<span>' + esc(us(n.date)) + '</span></div>' + (n.excerpt ? '<div class="note-x">' + esc(n.excerpt) + '</div>' : '') + '</div>';
                    }).join('') : blank('No case notes.')) + '</div>';
            } else {
                notesPanel = '<div class="panel" style="flex:1;min-height:0;overflow:hidden"><div class="pt">Activity this period<small>' + plural(c.period.total, 'action') + '</small></div>' +
                    (c.activityFeed.length ? c.activityFeed.slice(0, 7).map(function (e) {
                        return '<div class="li"><span class="dot" style="background:var(--green)"></span><span class="t">' + esc(e.label) + '</span><span class="d">' + esc(us(e.date)) + '</span></div>';
                    }).join('') : blank('No activity recorded this period.')) + '</div>';
            }

            var body = '<div style="display:flex;flex-direction:column;height:100%">' + head + tiles + updBox + lc +
                '<div class="row" style="margin-bottom:10px;height:162px">' + actPanel + synPanel + '</div>' +
                '<div class="row" style="margin-bottom:10px;min-height:0">' + wPanel + tPanel + '</div>' + notesPanel + '</div>';
            addPage('Case Spotlight · ' + c.caseNumber, body);

            if (overflow) {
                var cont = '<div class="kick">Case ' + (idx + 1) + ' of ' + cases.length + ' · continued</div>' +
                    '<div class="h1"><span class="mono" style="color:var(--cyan)">' + esc(c.caseNumber) + '</span> — Investigator Update</div>' +
                    '<div class="upd" style="max-height:860px;overflow:hidden"><div class="pt">Status update</div><div class="upd-b">' + escBr(updText) + '</div>' +
                    (nextText ? '<div class="upd-k" style="margin-top:12px">Next steps</div><div class="upd-b">' + escBr(nextText) + '</div>' : '') + '</div>';
                addPage('Case Spotlight · ' + c.caseNumber, cont);
            }
        });

        // ── 6. Statement & sign-off ──
        (function () {
            var stmt = String(updates.statement || '').trim();
            var body = '<div class="kick">Statement &amp; review</div><div class="h1">Investigator Statement</div>' +
                '<div class="panel" style="min-height:230px;max-height:330px;overflow:hidden;margin-bottom:14px"><div class="pt">Overall status</div>' +
                '<div class="upd-b">' + (stmt ? escBr(clip(stmt, 2400)) : blank('No overall statement provided.')) + '</div></div>' +
                '<div class="panel" style="margin-bottom:14px"><div class="upd-b">I certify that this report accurately reflects the status of my assigned cases as recorded in V.I.P.E.R. as of ' + esc(us(model.asOf)) + '.</div>' +
                '<div class="sig"><div><div class="ln"></div><div class="k">' + esc(who) + (ID.badge ? ' · #' + esc(ID.badge) : '') + '</div></div><div style="flex:.45"><div class="ln"></div><div class="k">Date</div></div></div></div>' +
                '<div class="panel" style="margin-bottom:14px"><div class="pt">Supervisor review</div>' +
                '<div class="row"><div class="col"><div class="cb"><i></i>Reviewed — no action needed</div><div class="cb"><i></i>Follow-up required (see comments)</div><div class="cb"><i></i>Case reassignment / resource request</div></div>' +
                '<div class="col lines"><div></div><div></div><div></div></div></div>' +
                '<div class="sig" style="margin-top:16px"><div><div class="ln"></div><div class="k">Supervisor name / signature</div></div><div style="flex:.45"><div class="ln"></div><div class="k">Date</div></div></div></div>' +
                '<div class="panel"><div class="pt">How the numbers are calculated</div><div class="meth">' +
                '<p><b>Open cases</b> — every case not marked Closed, Closed with Arrest, Transferred or Inactive (custom statuses follow their category).' + (OP.includeAssist ? ' Assist cases are included.' : ' Assist cases are not counted.') + '</p>' +
                '<p><b>Age</b> — calendar days since the assignment date. When a case has no assignment date, the date it was created in VIPER is used and marked “est.”</p>' +
                '<p><b>' + th + '-day mark</b> — assignment date + ' + th + ' days. A case past that date is overdue; tiers: 1–30, 31–90 and 90+ days past due.</p>' +
                '<p><b>Activity</b> — notes and note edits, evidence, warrants issued and returned, tasks completed, suspects, arrests, field work and case report saves recorded in VIPER between ' +
                esc(us(model.period && model.period.start)) + ' and ' + esc(us(model.period && model.period.end)) + '.</p>' +
                '<p><b>Warrants pending</b> — warrants with no return received and not closed out; past due when the provider due date has passed.</p>' +
                '<p><b>Updates, next steps and blockers</b> are written by the investigator when the report is generated and saved for the next report.</p>' +
                '</div></div>';
            addPage('Statement & Review', body);
        }());

        // ── assemble ──
        var N = pages.length;
        var footL = esc([agency, who].filter(Boolean).join(' · '));
        var html = pages.map(function (p, i) {
            var header = p.cls === 'cover' ? '' :
                '<div class="ph"><div class="ph-l">' + logo + '<span><b>V.I.P.E.R.</b> &nbsp;·&nbsp; Case Status Report</span></div><div class="ph-r">' + esc(p.section) + '</div></div>';
            var footer = '<div class="pf"><span>' + footL + '</span><span>Case Status Report · ' + esc(us(model.asOf)) + '</span><span class="pf-r">Page ' + pad(i + 1) + ' of ' + pad(N) + '</span></div>';
            return '<section class="page ' + p.cls + '">' + header + p.body + footer + '</section>';
        }).join('\n');

        return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Case Status Report</title><style>' + CSS + '</style></head>' +
            '<body class="' + (light ? 'light' : 'dark') + '">' + html + '</body></html>';
    }

    return {
        render: render,
        _esc: esc,
        _donut: donut,
        _lifecycle: lifecycle,
        _spark: spark
    };
}));

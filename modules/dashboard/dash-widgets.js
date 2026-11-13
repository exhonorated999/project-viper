/**
 * Customizable dashboard: widget renderers.
 *
 * Each renderer fills a widget's `.vd-body` element. Renderers read the page
 * through `ctx.host` (see the adapter built in index.html) and never touch
 * localStorage directly, except Personal Notes (NOTES_KEY) and the pinned
 * case list, which belong to this module.
 *
 * Everything user-controlled is escaped before it reaches innerHTML.
 * Metric labels from the page (`metricLabels`) are already HTML: built-in
 * labels are plain text and custom metric labels are escaped when they are
 * created (syncCustomMetricsIntoDashboard).
 *
 * Panel widgets (Quick Stats, Case Analytics, Tasks…) are not rendered here:
 * dash-app.js moves the existing panel element into the cell.
 */
(function (root) {
    'use strict';

    const DD = () => root.ViperDashData;
    const DL = () => root.ViperDashLayout;

    const PINNED_KEY = 'viperPinnedCases';
    const RECENT_KEY = 'viperRecentCases';
    const NOTE_MAX = 20000;

    // ── small helpers ───────────────────────────────────────────────

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /** HTML label → plain text (canvas text, title attributes). */
    function decode(html) {
        const t = document.createElement('textarea');
        t.innerHTML = String(html == null ? '' : html);
        return t.value;
    }

    function readJSON(key, fallback) {
        try {
            const v = JSON.parse(localStorage.getItem(key) || 'null');
            return v == null ? fallback : v;
        } catch (_) { return fallback; }
    }

    const GEAR_SVG = '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>';

    function gearBtn(uid) {
        return '<button type="button" class="vd-gear" data-vd-act="settings" data-uid="' + esc(uid) + '" title="Widget settings" aria-label="Widget settings">' + GEAR_SVG + '</button>';
    }

    // ── colors ──────────────────────────────────────────────────────

    const COLOR_VARS = {
        'viper-cyan': '--vp-cyan', 'viper-green': '--vp-green', 'viper-purple': '--vp-purple',
        'viper-orange': '--vp-orange', 'viper-yellow': '--vp-yellow', 'viper-red': '--vp-red',
    };
    const DARK_FALLBACK = {
        'viper-cyan': [0, 217, 255], 'viper-green': [0, 255, 136], 'viper-purple': [167, 139, 250],
        'viper-orange': [255, 140, 66], 'viper-yellow': [250, 204, 21], 'viper-red': [248, 113, 113],
    };
    const LIGHT = {
        'viper-cyan': '#0891b2', 'viper-green': '#0f9d58', 'viper-orange': '#d97706',
        'viper-purple': '#7c3aed', 'viper-red': '#dc2626', 'viper-yellow': '#ca8a04',
    };
    const PALETTE = ['viper-cyan', 'viper-green', 'viper-orange', 'viper-purple', 'viper-yellow', 'viper-red', '#60a5fa', '#f472b6', '#94a3b8'];
    // Text classes that keep their color in light mode (index.html exempts them).
    const TEXT_SAFE = ['viper-cyan', 'viper-green', 'viper-purple', 'viper-orange'];

    function isLight() { return !!(document.body && document.body.classList.contains('light-mode')); }

    function hexRgb(h) {
        const m = /^#?([0-9a-f]{6})$/i.exec(String(h || ''));
        if (!m) return null;
        const n = parseInt(m[1], 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }

    function rgbOf(name) {
        if (/^#/.test(name)) return hexRgb(name) || [148, 163, 184];
        if (isLight() && LIGHT[name]) return hexRgb(LIGHT[name]);
        const v = COLOR_VARS[name];
        if (v && document.body) {
            const raw = getComputedStyle(document.body).getPropertyValue(v).trim();
            const parts = raw.split(/[\s,/]+/).map(Number).filter(n => isFinite(n));
            if (parts.length >= 3) return parts.slice(0, 3);
        }
        return DARK_FALLBACK[name] || [0, 217, 255];
    }

    function rgba(name, a) {
        const c = rgbOf(name);
        return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (a == null ? 1 : a) + ')';
    }

    function chartTheme() {
        const light = isLight();
        return {
            light,
            text: light ? '#5c6b7a' : '#9ca3af',
            grid: light ? 'rgba(27,39,51,0.08)' : 'rgba(148,163,184,0.12)',
            tipBg: light ? '#ffffff' : 'rgba(17,24,39,0.96)',
            tipText: light ? '#1b1f23' : '#e5e7eb',
            tipBorder: light ? 'rgba(27,39,51,0.15)' : 'rgba(148,163,184,0.3)',
            prev: light ? 'rgba(92,107,122,0.35)' : 'rgba(148,163,184,0.35)',
            track: light ? 'rgba(27,39,51,0.08)' : 'rgba(148,163,184,0.14)',
            sliceBorder: light ? '#ffffff' : 'rgba(17,24,39,0.9)',
        };
    }

    /** Distinct series colors: each metric's own color unless already taken. */
    function seriesColors(names) {
        const used = new Set();
        return names.map(n => {
            let c = n && !used.has(n) ? n : null;
            if (!c) c = PALETTE.find(p => !used.has(p)) || '#94a3b8';
            used.add(c);
            return c;
        });
    }

    function textClass(color) { return TEXT_SAFE.indexOf(color) >= 0 ? 'text-' + color : 'text-viper-cyan'; }

    // ── metrics ─────────────────────────────────────────────────────

    const UNIT_LABEL = { kg: 'kg', lbs: 'lbs', pills: 'pills' };

    /** { key, base, unit, label (HTML), text (plain), color, isStatic, money } or null. */
    function metricInfo(ctx, key) {
        const D = DD();
        const base = D.baseKey(key), unit = D.unitOf(key);
        const metrics = ctx.host.metrics();
        const m = metrics && Object.prototype.hasOwnProperty.call(metrics, base) ? metrics[base] : null;
        if (!m) return null;
        const labels = ctx.host.labels() || {};
        let label = labels[base] || esc(base);
        if (unit) label += ' (' + UNIT_LABEL[unit] + ')';
        return {
            key, base, unit, label, text: decode(label),
            color: COLOR_VARS[m.color] ? m.color : 'viper-cyan',
            isStatic: m.monthly === null || m.monthly === undefined,
            money: typeof m.value === 'string' && m.value.charAt(0) === '$',
            raw: m,
        };
    }

    function fmtNum(n, info) {
        if (n === null || n === undefined || !isFinite(n)) return '—';
        const dec = (info && info.unit && info.unit !== 'pills') ? 2 : 0;
        const s = Number(n).toLocaleString(undefined, { maximumFractionDigits: n % 1 ? Math.max(dec, 1) : 0, minimumFractionDigits: 0 });
        return (info && info.money ? '$' : '') + s;
    }

    /** Display text for a raw metric value ('$1,234', 12, narcotics {kg,lbs,pills}). */
    function fmtVal(raw, info) {
        if (raw === null || raw === undefined) return '—';
        if (typeof raw === 'object') {
            if (info && info.unit) return fmtNum(DD().toNum(raw, info.key), info) + ' ' + UNIT_LABEL[info.unit];
            const parts = [];
            if (raw.kg > 0) parts.push(Number(raw.kg).toFixed(2) + ' kg');
            if (raw.lbs > 0) parts.push(Number(raw.lbs).toFixed(2) + ' lbs');
            if (raw.pills > 0) parts.push(Math.round(raw.pills).toLocaleString() + ' pills');
            return parts.length ? parts.join(' · ') : '0';
        }
        if (typeof raw === 'number') return isFinite(raw) ? raw.toLocaleString() : '0';
        return String(raw);
    }

    function numSizeClass(text, w) {
        const len = String(text).length;
        let step = len <= 5 ? 0 : len <= 9 ? 1 : 2;
        if (w <= 2) step++;
        return ['vd-num-xl', 'vd-num-lg', 'vd-num-md', 'vd-num-md'][Math.min(step, 3)];
    }

    // ── charts ──────────────────────────────────────────────────────

    function destroyCharts(ctx, uid) {
        const list = ctx.charts[uid];
        if (list) list.forEach(c => { try { c.destroy(); } catch (_) { /* already gone */ } });
        delete ctx.charts[uid];
    }

    function makeChart(ctx, uid, holder, config) {
        const C = root.Chart;
        if (!C) { holder.innerHTML = '<div class="vd-empty">Charts are unavailable.</div>'; return null; }
        const canvas = document.createElement('canvas');
        canvas.setAttribute('role', 'img');
        holder.appendChild(canvas);
        const ch = new C(canvas.getContext('2d'), config);
        (ctx.charts[uid] = ctx.charts[uid] || []).push(ch);
        return ch;
    }

    function tooltipOpts(th) {
        return {
            backgroundColor: th.tipBg, titleColor: th.tipText, bodyColor: th.tipText,
            borderColor: th.tipBorder, borderWidth: 1, padding: 8, boxPadding: 4, usePointStyle: true,
        };
    }

    function legendOpts(th, show, position) {
        return {
            display: !!show, position: position || 'top', align: 'start',
            labels: { color: th.text, boxWidth: 8, boxHeight: 8, usePointStyle: true, pointStyle: 'circle', padding: 10, font: { size: 11 } },
        };
    }

    function axesOpts(th, o) {
        const opt = o || {};
        const tick = (v) => (opt.money ? '$' : '') + (Math.abs(v) >= 1000 ? Number(v).toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 1 }) : v);
        return {
            x: {
                stacked: !!opt.stacked,
                ticks: { color: th.text, font: { size: 10 }, maxRotation: 0, autoSkip: true, autoSkipPadding: 8 },
                grid: { display: false }, border: { color: th.grid },
            },
            y: {
                stacked: !!opt.stacked, beginAtZero: true,
                ticks: { color: th.text, font: { size: 10 }, precision: opt.integer ? 0 : undefined, callback: tick, maxTicksLimit: 6 },
                grid: { color: th.grid }, border: { display: false },
            },
        };
    }

    function monthLabels(months) {
        const multiYear = months.length && months[0].y !== months[months.length - 1].y;
        return months.map(mo => multiYear ? mo.label + " '" + String(mo.y).slice(2) : mo.label);
    }

    function allInteger(arrays) {
        return arrays.every(a => a.every(v => v === null || Math.floor(v) === v));
    }

    function holderHtml(extra) {
        return '<div class="vd-grow"><div class="vd-chart-holder" style="position:absolute;inset:0">' + (extra || '') + '</div></div>';
    }

    function loadingHtml() {
        return '<div class="vd-grow"><div class="vd-loading" title="Working out monthly figures…"></div></div>';
    }

    function emptyHtml(icon, text) {
        return '<div class="vd-grow"><div class="vd-empty"><div class="vd-empty-ico">' + icon + '</div><div>' + text + '</div></div></div>';
    }

    // ── which months a widget needs ─────────────────────────────────

    function needMonths(w, ctx) {
        const D = DD();
        const now = ctx.now();
        if (w.type === 'stat' && w.cfg.style === 'spark') return D.monthList('12m', now);
        if (w.type === 'chart' && w.cfg.groupBy === 'month') return D.monthList(w.cfg.range, now, ctx.firstCaseDate());
        if (w.type === 'yoy') return D.yoyMonths(now);
        return null;
    }

    // ── stat card ───────────────────────────────────────────────────

    const STAT_STYLE = 'background: rgba(26, 35, 50, 0.7); backdrop-filter: blur(10px); border: 1px solid rgba(0, 217, 255, 0.2);';

    function renderStat(body, w, ctx) {
        const key = DD().baseKey(w.cfg.metric);
        const info = metricInfo(ctx, key);
        const uid = w.uid;
        if (!info) {
            body.innerHTML = '<div class="stat-card vd-stat" style="' + STAT_STYLE + '"><div class="vd-head"><h3 class="text-gray-400 text-sm font-medium card-title">Metric removed</h3>' + gearBtn(uid) + '</div>' +
                '<div class="vd-empty">This metric no longer exists. Pick another with the gear.</div></div>';
            return;
        }
        const head = '<div class="vd-head"><h3 class="text-gray-400 text-sm font-medium card-title" title="' + esc(info.text) + '">' + info.label + '</h3>' + gearBtn(uid) + '</div>';
        const style = w.cfg.style;

        if (style === 'split') {
            // The original card layout, drawn by the page's own updateCard().
            body.innerHTML = '<div class="stat-card vd-stat" data-card="' + esc(uid) + '" style="' + STAT_STYLE + '">' + head +
                '<div class="vd-stat-split"><div class="text-5xl font-bold card-value ' + textClass(info.color) + '"></div>' +
                '<div class="text-right"><p class="text-xs text-gray-400 card-subtitle"></p></div></div></div>';
            try { ctx.host.updateCard(uid, key); } catch (e) { console.warn('Dashboard stat card:', e); }
            const t = body.querySelector('.card-title');
            if (t) t.innerHTML = info.label; // updateCard sets textContent, which would show &amp; in custom labels
            return;
        }

        if (style === 'spark') {
            const val = info.isStatic ? info.raw.value : info.raw.monthly;
            const valTxt = fmtVal(val, info);
            const cap = info.isStatic ? (info.raw.subtitle || 'Total') : 'This month';
            let side = '';
            let bottom;
            if (info.isStatic) {
                bottom = '<div class="vd-note-line">No monthly history for this metric.</div>';
            } else {
                const months = needMonths(w, ctx);
                if (!ctx.monthsReady(months)) {
                    ctx.requestMonths(months, uid);
                    bottom = '<div class="vd-spark"><div class="vd-loading"></div></div>';
                } else {
                    const series = DD().seriesFor(ctx.monthCache, months, info.key);
                    const cur = series[series.length - 1], prev = series[series.length - 2];
                    if (cur !== null && prev !== null && cur !== undefined && prev !== undefined) {
                        const d = cur - prev;
                        const cls = d > 0 ? 'vd-delta-up' : d < 0 ? 'vd-delta-down' : 'vd-delta-flat';
                        const arrow = d > 0 ? '▲' : d < 0 ? '▼' : '';
                        const dTxt = d === 0 ? 'No change' : arrow + ' ' + fmtNum(Math.abs(d), info);
                        side = '<div class="vd-delta ' + cls + '" title="Change from ' + esc(months[months.length - 2].long) + '">' + esc(dTxt) + '<div class="vd-cap" style="margin-top:0.15rem">vs ' + esc(months[months.length - 2].label) + '</div></div>';
                    }
                    bottom = '<div class="vd-spark"><div class="vd-chart-holder" style="position:absolute;inset:0"></div></div>';
                    body.innerHTML = '<div class="stat-card vd-stat" style="' + STAT_STYLE + '">' + head +
                        '<div class="vd-stat-main" style="flex:0 0 auto"><div><div class="vd-num ' + numSizeClass(valTxt, w.w) + ' ' + textClass(info.color) + '">' + esc(valTxt) + '</div><div class="vd-cap">' + esc(cap) + '</div></div>' + side + '</div>' +
                        bottom + '</div>';
                    const th = chartTheme();
                    const labels = months.map(mo => mo.long);
                    makeChart(ctx, uid, body.querySelector('.vd-chart-holder'), {
                        type: 'line',
                        data: { labels, datasets: [{ data: series, borderColor: rgba(info.color, 1), backgroundColor: rgba(info.color, 0.14), fill: 'origin', borderWidth: 2, tension: 0.35, cubicInterpolationMode: 'monotone', pointRadius: 0, pointHoverRadius: 3, spanGaps: true }] },
                        options: {
                            responsive: true, maintainAspectRatio: false, animation: false,
                            layout: { padding: { top: 2, bottom: 1 } },
                            plugins: { legend: { display: false }, tooltip: Object.assign(tooltipOpts(th), { displayColors: false, callbacks: { label: (it) => info.text + ': ' + fmtNum(it.parsed.y, info) } }) },
                            scales: { x: { display: false }, y: { display: false, beginAtZero: true } },
                        },
                    });
                    return;
                }
            }
            body.innerHTML = '<div class="stat-card vd-stat" style="' + STAT_STYLE + '">' + head +
                '<div class="vd-stat-main" style="flex:0 0 auto"><div><div class="vd-num ' + numSizeClass(valTxt, w.w) + ' ' + textClass(info.color) + '">' + esc(valTxt) + '</div><div class="vd-cap">' + esc(cap) + '</div></div>' + side + '</div>' +
                bottom + '</div>';
            return;
        }

        // style 'big': one figure for the chosen period.
        let raw, cap, title = '';
        if (info.isStatic) {
            raw = info.raw.value; cap = info.raw.subtitle || 'Total';
        } else if (w.cfg.period === 'scope') {
            raw = ctx.host.scopeValue(key); cap = ctx.host.scopeLabel(false); title = ctx.host.scopeTitle();
        } else if (w.cfg.period === 'all') {
            raw = info.raw.value; cap = 'All time';
        } else {
            raw = info.raw.monthly; cap = 'This month';
        }
        const txt = fmtVal(raw, info);
        body.innerHTML = '<div class="stat-card vd-stat" style="' + STAT_STYLE + '">' + head +
            '<div class="vd-stat-main"><div style="min-width:0"' + (title ? ' title="' + esc(title) + '"' : '') + '><div class="vd-num ' + numSizeClass(txt, w.w) + ' ' + textClass(info.color) + '">' + esc(txt) + '</div><div class="vd-cap">' + esc(cap) + '</div></div></div></div>';
    }

    // ── chart ───────────────────────────────────────────────────────

    const DIM_TITLE = { status: 'Cases by status', category: 'Cases by category', offense: 'Cases by offense', priority: 'Cases by priority', role: 'Lead vs. assist cases' };
    const STATUS_COLORS = { active: 'viper-cyan', inactive: 'viper-yellow', closed: '#94a3b8', 'closed-arrest': 'viper-green', transferred: 'viper-orange' };
    const PRIORITY_COLORS = { 1: 'viper-red', 2: 'viper-orange', 3: 'viper-yellow', 4: 'viper-green', none: '#94a3b8' };

    function chartTitle(ctx, cfg) {
        if (cfg.title) return cfg.title;
        if (cfg.groupBy !== 'month') return DIM_TITLE[cfg.groupBy] || 'Cases';
        const names = (cfg.metrics || []).map(k => { const i = metricInfo(ctx, k); return i ? i.text : null; }).filter(Boolean);
        if (cfg.type === 'gauge') {
            const a = metricInfo(ctx, (cfg.metrics || [])[0]), b = metricInfo(ctx, cfg.of);
            return (a ? a.text : '?') + ' vs. ' + (b ? b.text : '?');
        }
        if (names.length === 1) return names[0] + ' by month';
        if (names.length === 2) return names[0] + ' and ' + names[1];
        return 'Monthly activity';
    }

    function chartHead(ctx, w, sub) {
        return '<div class="vd-head"><div class="vd-head-text"><div class="vd-title">' + esc(chartTitle(ctx, w.cfg)) + '</div>' +
            (sub ? '<div class="vd-sub">' + esc(sub) + '</div>' : '') + '</div>' + gearBtn(w.uid) + '</div>';
    }

    function renderChart(body, w, ctx) {
        const D = DD();
        const cfg = w.cfg;
        const uid = w.uid;
        const th = chartTheme();
        const card = (inner) => { body.innerHTML = '<div class="glass-card vd-card">' + inner + '</div>'; };

        if (cfg.groupBy !== 'month') {
            const sub = cfg.range === 'all' ? 'All cases' : 'Assigned: ' + D.rangeLabel(cfg.range).toLowerCase();
            const list = D.distribution(ctx.host.cases(), cfg.groupBy, {
                customStatuses: ctx.host.customStatuses(), window: D.rangeWindow(cfg.range, ctx.now()), top: 8,
            });
            if (!list.length) { card(chartHead(ctx, w, sub) + emptyHtml('📭', 'No cases in this range.')); return; }
            card(chartHead(ctx, w, sub) + holderHtml());
            const holder = body.querySelector('.vd-chart-holder');
            let colorNames;
            if (cfg.groupBy === 'status') {
                const customs = ctx.host.customStatuses();
                const used = new Set();
                colorNames = list.map(it => {
                    let c = STATUS_COLORS[it.key];
                    const cs = !c && customs.find(s => s && s.id === it.key);
                    if (!c && cs && hexRgb(cs.color)) c = '#' + hexRgb(cs.color).map(n => (n < 16 ? '0' : '') + n.toString(16)).join('');
                    if (!c || used.has(c)) c = PALETTE.find(p => !used.has(p)) || '#94a3b8';
                    used.add(c);
                    return c;
                });
            } else if (cfg.groupBy === 'priority') {
                colorNames = list.map(it => PRIORITY_COLORS[it.key] || '#94a3b8');
            } else if (cfg.groupBy === 'role') {
                colorNames = list.map(it => it.key === 'assist' ? 'viper-purple' : 'viper-cyan');
            } else {
                colorNames = list.map((_, i) => PALETTE[i % PALETTE.length]);
            }
            const labels = list.map(it => it.label);
            const data = list.map(it => it.count);
            const total = data.reduce((a, b) => a + b, 0);
            if (cfg.type === 'bar') {
                makeChart(ctx, uid, holder, {
                    type: 'bar',
                    data: { labels, datasets: [{ data, backgroundColor: colorNames.map(c => rgba(c, 0.75)), hoverBackgroundColor: colorNames.map(c => rgba(c, 0.95)), borderRadius: 4, maxBarThickness: 26 }] },
                    options: {
                        responsive: true, maintainAspectRatio: false, indexAxis: 'y',
                        plugins: { legend: { display: false }, tooltip: Object.assign(tooltipOpts(th), { displayColors: false, callbacks: { label: (it) => it.parsed.x + ' case' + (it.parsed.x === 1 ? '' : 's') + ' (' + Math.round(it.parsed.x / total * 100) + '%)' } }) },
                        scales: {
                            x: { beginAtZero: true, ticks: { color: th.text, font: { size: 10 }, precision: 0, maxTicksLimit: 6 }, grid: { color: th.grid }, border: { display: false } },
                            y: { ticks: { color: th.text, font: { size: 11 }, autoSkip: false }, grid: { display: false }, border: { color: th.grid } },
                        },
                    },
                });
            } else {
                const r = holder.getBoundingClientRect();
                const pos = r.width > r.height * 1.35 ? 'right' : 'bottom';
                makeChart(ctx, uid, holder, {
                    type: cfg.type === 'pie' ? 'pie' : 'doughnut',
                    data: { labels, datasets: [{ data, backgroundColor: colorNames.map(c => rgba(c, 0.8)), hoverBackgroundColor: colorNames.map(c => rgba(c, 1)), borderColor: th.sliceBorder, borderWidth: 2, hoverOffset: 4 }] },
                    options: {
                        responsive: true, maintainAspectRatio: false, cutout: cfg.type === 'pie' ? 0 : '62%',
                        plugins: {
                            legend: Object.assign(legendOpts(th, true, pos), { align: 'center' }),
                            tooltip: Object.assign(tooltipOpts(th), { callbacks: { label: (it) => ' ' + it.label + ': ' + it.parsed + ' (' + Math.round(it.parsed / total * 100) + '%)' } }),
                        },
                    },
                });
            }
            return;
        }

        // Metrics by month.
        const months = needMonths(w, ctx);
        const sub = D.rangeLabel(cfg.range) + (cfg.range === 'all' && months.length >= 36 ? ' (last 36 months)' : '');
        if (!ctx.monthsReady(months)) {
            ctx.requestMonths(months, uid);
            card(chartHead(ctx, w, sub) + loadingHtml());
            return;
        }
        const keys = cfg.type === 'gauge' ? [cfg.metrics[0], cfg.of] : cfg.metrics;
        const infos = keys.map(k => metricInfo(ctx, k));
        const missing = infos.filter(i => !i).length;
        const statics = infos.filter(i => i && i.isStatic);
        const usable = infos.filter(i => i && !i.isStatic);
        let foot = '';
        const notes = [];
        if (statics.length) notes.push(statics.map(i => i.text).join(', ') + (statics.length === 1 ? ' has' : ' have') + ' no monthly history.');
        if (missing) notes.push(missing === 1 ? 'One metric no longer exists.' : missing + ' metrics no longer exist.');
        if (notes.length) foot = '<div class="vd-foot"><div class="vd-note-line">' + esc(notes.join(' ')) + '</div></div>';

        if (cfg.type === 'gauge') {
            const a = infos[0], b = infos[1];
            if (!a || !b || a.isStatic || b.isStatic) { card(chartHead(ctx, w, sub) + emptyHtml('⚠️', 'Pick two metrics with monthly history (gear).') + foot); return; }
            const va = D.sum(D.seriesFor(ctx.monthCache, months, a.key));
            const vb = D.sum(D.seriesFor(ctx.monthCache, months, b.key));
            const pct = vb > 0 ? va / vb * 100 : 0;
            const shown = Math.max(0, Math.min(100, pct));
            const pctTxt = vb > 0 ? (pct >= 10 || pct === 0 ? Math.round(pct) : pct.toFixed(1)) + '%' : '—';
            const cap = fmtNum(va, a) + ' of ' + fmtNum(vb, b);
            card(chartHead(ctx, w, sub) + holderHtml('<div class="vd-gauge-txt"><div class="vd-gauge-pct ' + textClass(a.color) + '">' + esc(pctTxt) + '</div><div class="vd-gauge-cap">' + esc(cap) + '</div></div>'));
            makeChart(ctx, uid, body.querySelector('.vd-chart-holder'), {
                type: 'doughnut',
                data: { labels: [a.text, 'Remaining'], datasets: [{ data: [shown, 100 - shown], backgroundColor: [rgba(a.color, 0.9), th.track], borderWidth: 0 }] },
                options: {
                    responsive: true, maintainAspectRatio: false, circumference: 180, rotation: -90, cutout: '74%',
                    layout: { padding: { bottom: 4 } },
                    plugins: { legend: { display: false }, tooltip: { enabled: false } },
                },
            });
            return;
        }

        if (!usable.length) { card(chartHead(ctx, w, sub) + emptyHtml('📉', 'None of these metrics has monthly history. Pick others with the gear.') + foot); return; }
        const colors = seriesColors(usable.map(i => i.color));
        const series = usable.map(i => D.seriesFor(ctx.monthCache, months, i.key));
        const anyMoney = usable.some(i => i.money);

        if (cfg.type === 'donut' || cfg.type === 'pie') {
            const totals = series.map(s => D.sum(s));
            const total = totals.reduce((x, y) => x + y, 0);
            if (!total) { card(chartHead(ctx, w, sub) + emptyHtml('📭', 'Nothing recorded in this range.') + foot); return; }
            card(chartHead(ctx, w, sub) + holderHtml() + foot);
            const holder = body.querySelector('.vd-chart-holder');
            const r = holder.getBoundingClientRect();
            makeChart(ctx, uid, holder, {
                type: cfg.type === 'pie' ? 'pie' : 'doughnut',
                data: { labels: usable.map(i => i.text), datasets: [{ data: totals, backgroundColor: colors.map(c => rgba(c, 0.8)), hoverBackgroundColor: colors.map(c => rgba(c, 1)), borderColor: th.sliceBorder, borderWidth: 2, hoverOffset: 4 }] },
                options: {
                    responsive: true, maintainAspectRatio: false, cutout: cfg.type === 'pie' ? 0 : '62%',
                    plugins: {
                        legend: Object.assign(legendOpts(th, true, r.width > r.height * 1.35 ? 'right' : 'bottom'), { align: 'center' }),
                        tooltip: Object.assign(tooltipOpts(th), { callbacks: { label: (it) => ' ' + it.label + ': ' + fmtNum(it.parsed, usable[it.dataIndex]) + ' (' + Math.round(it.parsed / total * 100) + '%)' } }),
                    },
                },
            });
            return;
        }

        card(chartHead(ctx, w, sub) + holderHtml() + foot);
        const isBar = cfg.type === 'bar' || cfg.type === 'stacked';
        const datasets = usable.map((info, i) => {
            const c = colors[i];
            const base = { label: info.text, data: series[i], borderColor: rgba(c, 1), backgroundColor: rgba(c, isBar ? 0.75 : (cfg.type === 'area' ? 0.18 : 0.12)) };
            if (isBar) return Object.assign(base, { borderWidth: 0, borderRadius: 3, maxBarThickness: 28, hoverBackgroundColor: rgba(c, 0.95) });
            return Object.assign(base, { fill: cfg.type === 'area' ? 'origin' : false, borderWidth: 2, tension: 0.32, cubicInterpolationMode: 'monotone', pointRadius: months.length > 18 ? 0 : 2.5, pointHoverRadius: 4, pointBackgroundColor: rgba(c, 1), spanGaps: true });
        });
        const longLabels = months.map(mo => mo.long);
        makeChart(ctx, uid, body.querySelector('.vd-chart-holder'), {
            type: isBar ? 'bar' : 'line',
            data: { labels: monthLabels(months), datasets },
            options: {
                responsive: true, maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: legendOpts(th, usable.length > 1),
                    tooltip: Object.assign(tooltipOpts(th), { callbacks: { title: (items) => items.length ? longLabels[items[0].dataIndex] : '', label: (it) => ' ' + it.dataset.label + ': ' + fmtNum(it.parsed.y, usable[it.datasetIndex]) } }),
                },
                scales: axesOpts(th, { stacked: cfg.type === 'stacked', integer: allInteger(series), money: anyMoney && usable.every(i => i.money) }),
            },
        });
    }

    // ── year over year ──────────────────────────────────────────────

    function renderYoy(body, w, ctx) {
        const D = DD();
        const uid = w.uid;
        const th = chartTheme();
        const info = metricInfo(ctx, w.cfg.metric);
        const now = ctx.now();
        const y = now.getFullYear();
        const title = (info ? info.text : 'Metric') + ': ' + y + ' vs. ' + (y - 1);
        const head = (sub) => '<div class="vd-head"><div class="vd-head-text"><div class="vd-title">' + esc(title) + '</div>' + (sub ? '<div class="vd-sub">' + sub + '</div>' : '') + '</div>' + gearBtn(uid) + '</div>';
        const card = (inner) => { body.innerHTML = '<div class="glass-card vd-card">' + inner + '</div>'; };
        if (!info) { card(head('') + emptyHtml('⚠️', 'This metric no longer exists. Pick another with the gear.')); return; }
        if (info.isStatic) { card(head('') + emptyHtml('📉', esc(info.text) + ' has no monthly history. Pick another metric with the gear.')); return; }
        const months = needMonths(w, ctx);
        if (!ctx.monthsReady(months)) { ctx.requestMonths(months, uid); card(head('Year to date') + loadingHtml()); return; }
        const s = D.yoySeries(ctx.monthCache, info.key, now);
        let delta = '';
        if (s.prevToDate > 0) {
            const p = (s.curToDate - s.prevToDate) / s.prevToDate * 100;
            const cls = p > 0 ? 'vd-delta-up' : p < 0 ? 'vd-delta-down' : 'vd-delta-flat';
            delta = ' <span class="vd-delta ' + cls + '">' + (p > 0 ? '▲ ' : p < 0 ? '▼ ' : '') + Math.abs(Math.round(p)) + '%</span>';
        }
        const sub = 'Year to date: ' + esc(fmtNum(s.curToDate, info)) + ' vs. ' + esc(fmtNum(s.prevToDate, info)) + delta;
        card(head(sub) + holderHtml());
        const isBar = w.cfg.type === 'bar';
        const c = info.color;
        makeChart(ctx, uid, body.querySelector('.vd-chart-holder'), {
            type: isBar ? 'bar' : 'line',
            data: {
                labels: s.labels,
                datasets: [
                    { label: String(y - 1), data: s.prev, backgroundColor: th.prev, borderColor: th.prev, borderWidth: isBar ? 0 : 2, borderRadius: 3, maxBarThickness: 22, tension: 0.32, cubicInterpolationMode: 'monotone', pointRadius: isBar ? 0 : 2, borderDash: isBar ? undefined : [4, 4], spanGaps: true },
                    { label: String(y), data: s.cur, backgroundColor: rgba(c, isBar ? 0.8 : 0.12), borderColor: rgba(c, 1), borderWidth: isBar ? 0 : 2, borderRadius: 3, maxBarThickness: 22, tension: 0.32, cubicInterpolationMode: 'monotone', pointRadius: isBar ? 0 : 2.5, pointBackgroundColor: rgba(c, 1), spanGaps: false },
                ],
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: legendOpts(th, true),
                    tooltip: Object.assign(tooltipOpts(th), { callbacks: { label: (it) => ' ' + it.dataset.label + ': ' + (it.parsed.y === null ? '—' : fmtNum(it.parsed.y, info)) } }),
                },
                scales: axesOpts(th, { integer: allInteger([s.prev, s.cur]), money: info.money }),
            },
        });
    }

    // ── agenda ──────────────────────────────────────────────────────

    const AG_ICON = { court: '⚖️', warrant: '📜', prtt: '📡', task: '📝' };
    const PRIO_DOT = { high: '#f87171', medium: '#fb923c', low: '#4ade80' };

    function dayHeading(item, now) {
        if (item.overdue) return 'Overdue';
        if (item.days === 0) return 'Today';
        if (item.days === 1) return 'Tomorrow';
        return item.date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    }

    function renderAgenda(body, w, ctx) {
        const D = DD();
        const cfg = w.cfg;
        const items = D.agendaItems({
            tasks: ctx.host.tasks(), warrants: ctx.host.warrants(), cases: ctx.host.cases(),
            days: cfg.days, now: ctx.now(), include: { tasks: cfg.tasks, court: cfg.court, warrants: cfg.warrants },
            WarrantStatus: root.WarrantStatus,
        });
        const overdueN = items.filter(i => i.overdue).length;
        const sub = 'Next ' + cfg.days + ' days · ' + items.length + ' item' + (items.length === 1 ? '' : 's') + (overdueN ? ' · ' + overdueN + ' overdue' : '');
        const head = '<div class="vd-head"><div class="vd-head-text"><div class="vd-title">Agenda</div><div class="vd-sub">' + esc(sub) + '</div></div>' + gearBtn(w.uid) + '</div>';
        if (!cfg.tasks && !cfg.court && !cfg.warrants) {
            body.innerHTML = '<div class="glass-card vd-card">' + head + emptyHtml('⚙️', 'Nothing selected to show. Use the gear to pick tasks, court dates or warrants.') + '</div>';
            return;
        }
        if (!items.length) {
            body.innerHTML = '<div class="glass-card vd-card">' + head + emptyHtml('✓', 'Nothing due in the next ' + cfg.days + ' days.') + '</div>';
            return;
        }
        let html = '', last = null;
        items.forEach(it => {
            const g = dayHeading(it);
            if (g !== last) {
                html += '<div class="vd-ag-group' + (it.overdue ? ' is-overdue' : '') + '">' + esc(g) + '</div>';
                last = g;
            }
            const when = it.overdue ? (Math.abs(it.days) + ' day' + (Math.abs(it.days) === 1 ? '' : 's') + ' overdue')
                : (it.days > 1 && g !== 'Today' && g !== 'Tomorrow' ? 'in ' + it.days + ' days' : '');
            const meta = [
                it.caseNumber ? 'Case ' + it.caseNumber : '',
                it.time ? it.time + (it.timeUTC ? ' UTC' : '') : '',
                it.kind === 'court' ? 'Court' : it.kind === 'warrant' ? 'Warrant return' : it.kind === 'prtt' ? 'PRTT order' : '',
                when,
            ].filter(Boolean).join(' · ');
            const isTask = it.kind === 'task' || it.kind === 'court';
            const dot = it.kind === 'task' && PRIO_DOT[String(it.priority).toLowerCase()]
                ? '<span style="display:inline-block;width:6px;height:6px;border-radius:9999px;margin-right:6px;vertical-align:middle;background:' + PRIO_DOT[String(it.priority).toLowerCase()] + '"></span>' : '';
            html += '<div class="vd-ag-row' + (it.overdue ? ' is-overdue' : '') + '" role="button" tabindex="0" data-vd-act="agenda" data-kind="' + esc(it.kind) + '" data-id="' + esc(it.id == null ? '' : it.id) + '" data-case="' + esc(it.caseId == null ? '' : it.caseId) + '" title="' + (isTask ? 'Open this task' : 'Open the case') + '">' +
                '<div class="vd-ag-ico">' + AG_ICON[it.kind] + '</div>' +
                '<div class="vd-ag-main"><div class="vd-ag-title">' + dot + esc(it.title) + '</div>' + (meta ? '<div class="vd-ag-meta">' + esc(meta) + '</div>' : '') + '</div>' +
                (isTask ? '<button type="button" class="vd-ag-done" data-vd-act="taskdone" data-id="' + esc(it.id) + '" title="Mark complete" aria-label="Mark complete">✓</button>' : '') +
                '</div>';
        });
        body.innerHTML = '<div class="glass-card vd-card">' + head + '<div class="vd-grow vd-scrollbox">' + html + '</div></div>';
    }

    // ── recent & pinned cases ───────────────────────────────────────

    const STATUS_BADGE = {
        active: ['Active', 'rgb(var(--vp-cyan))'], inactive: ['Inactive', '#facc15'], closed: ['Closed', '#9ca3af'],
        'closed-arrest': ['Closed w/ Arrest', '#34d399'], transferred: ['Transferred', 'rgb(var(--vp-orange))'],
    };

    function statusBadge(status, customs) {
        const s = String(status || 'active');
        let label, color;
        if (STATUS_BADGE[s]) { label = STATUS_BADGE[s][0]; color = STATUS_BADGE[s][1]; }
        else {
            const cs = (customs || []).find(x => x && x.id === s);
            label = cs ? cs.label : s;
            color = cs && hexRgb(cs.color) ? cs.color : '#a78bfa';
        }
        return '<span class="vd-badge" style="color:' + esc(color) + '" title="' + esc(label) + '">' + esc(label) + '</span>';
    }

    function pinnedIds() { const v = readJSON(PINNED_KEY, []); return Array.isArray(v) ? v : []; }
    function recentIds() { const v = readJSON(RECENT_KEY, []); return Array.isArray(v) ? v : []; }
    function togglePin(id) {
        const next = DD().togglePinned(pinnedIds(), id);
        try { localStorage.setItem(PINNED_KEY, JSON.stringify(next)); } catch (_) { /* storage full */ }
        return next.some(x => String(x) === String(id));
    }

    function caseRow(c, pinned, customs) {
        const syn = String(c.synopsis || c.category || c.primaryOffense || '').replace(/\s+/g, ' ').trim();
        return '<div class="vd-rc-row" role="button" tabindex="0" data-vd-act="open" data-id="' + esc(c.id) + '" title="Open case ' + esc(c.caseNumber) + '">' +
            '<button type="button" class="vd-rc-star' + (pinned ? ' is-on' : '') + '" data-vd-act="pin" data-id="' + esc(c.id) + '" title="' + (pinned ? 'Unpin' : 'Pin') + '" aria-label="' + (pinned ? 'Unpin' : 'Pin') + ' case">' + (pinned ? '★' : '☆') + '</button>' +
            '<div class="vd-rc-main"><div class="vd-rc-num">' + esc(c.caseNumber || ('Case ' + c.id)) + (c.caseRole === 'assist' ? ' <span class="vd-badge" style="color:#a78bfa">Assist</span>' : '') + '</div>' +
            (syn ? '<div class="vd-rc-syn">' + esc(syn.slice(0, 140)) + '</div>' : '') + '</div>' +
            statusBadge(c.status, customs) + '</div>';
    }

    function renderRecent(body, w, ctx) {
        const D = DD();
        const cfg = w.cfg;
        const cases = ctx.host.cases();
        const customs = ctx.host.customStatuses();
        const pins = pinnedIds();
        const lists = D.recentLists({ recent: recentIds(), pinned: pins, cases, mode: cfg.mode, count: cfg.count });
        const title = cfg.mode === 'recent' ? 'Recent Cases' : cfg.mode === 'pinned' ? 'Pinned Cases' : 'Recent & Pinned Cases';
        const head = '<div class="vd-head"><div class="vd-head-text"><div class="vd-title">' + title + '</div></div>' + gearBtn(w.uid) + '</div>';
        let html = '';
        const both = cfg.mode === 'both';
        if (lists.pinned.length) {
            if (both) html += '<div class="vd-ag-group">Pinned</div>';
            html += lists.pinned.map(c => caseRow(c, true, customs)).join('');
        }
        if (lists.recent.length) {
            if (both) html += '<div class="vd-ag-group">Recently opened</div>';
            const pinSet = new Set(pins.map(String));
            html += lists.recent.map(c => caseRow(c, pinSet.has(String(c.id)), customs)).join('');
        }
        if (!html) {
            const msg = cfg.mode === 'pinned' ? 'No pinned cases yet. Pin one below.'
                : 'Cases you open will show up here.' + (cfg.mode === 'both' ? ' Pin a case to keep it at the top.' : '');
            html = '<div class="vd-empty"><div class="vd-empty-ico">⭐</div><div>' + esc(msg) + '</div></div>';
        }
        let foot = '';
        if (cfg.mode !== 'recent' && cases.length) {
            const pinSet = new Set(pins.map(String));
            const opts = cases.filter(c => c && !pinSet.has(String(c.id)))
                .slice().sort((a, b) => String(a.caseNumber || '').localeCompare(String(b.caseNumber || ''), undefined, { numeric: true }))
                .slice(0, 500)
                .map(c => '<option value="' + esc(c.id) + '">' + esc(String(c.caseNumber || c.id) + (c.synopsis ? ' · ' + String(c.synopsis).replace(/\s+/g, ' ').slice(0, 60) : '')) + '</option>').join('');
            if (opts) foot = '<div class="vd-foot"><select class="vd-pick" data-vd-act="pinpick" aria-label="Pin a case"><option value="">☆ Pin a case…</option>' + opts + '</select></div>';
        }
        body.innerHTML = '<div class="glass-card vd-card">' + head + '<div class="vd-grow vd-scrollbox">' + html + '</div>' + foot + '</div>';
    }

    // ── personal notes ──────────────────────────────────────────────

    const notes = {
        all() { const v = readJSON(DL().NOTES_KEY, {}); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; },
        get(uid) { const v = this.all()[uid]; return typeof v === 'string' ? v : ''; },
        set(uid, text) {
            const all = this.all();
            const t = String(text || '').slice(0, NOTE_MAX);
            if (t) all[uid] = t; else delete all[uid];
            try { localStorage.setItem(DL().NOTES_KEY, JSON.stringify(all)); return true; } catch (_) { return false; }
        },
        /** Drop notes whose widget no longer exists in any layout. */
        prune(liveUids) {
            const all = this.all();
            let changed = false;
            Object.keys(all).forEach(k => { if (!liveUids.has(k)) { delete all[k]; changed = true; } });
            if (changed) { try { localStorage.setItem(DL().NOTES_KEY, JSON.stringify(all)); } catch (_) { /* ignore */ } }
        },
    };

    function renderNotes(body, w) {
        const tint = DL().TINTS.indexOf(w.cfg.tint) >= 0 ? w.cfg.tint : 'yellow';
        body.innerHTML = '<div class="glass-card vd-card vd-note vd-tint-' + tint + '">' +
            '<div class="vd-head"><div class="vd-head-text"><div class="vd-title">' + esc(w.cfg.title || 'Notes') + '</div></div>' + gearBtn(w.uid) + '</div>' +
            '<div class="vd-grow"><textarea class="vd-note-ta" data-vd-note="' + esc(w.uid) + '" maxlength="' + NOTE_MAX + '" spellcheck="true" placeholder="Jot something down. Saved on this computer only." aria-label="' + esc(w.cfg.title || 'Notes') + '"></textarea></div></div>';
        body.querySelector('textarea').value = notes.get(w.uid);
    }

    // ── dispatcher ──────────────────────────────────────────────────

    const RENDER = { stat: renderStat, chart: renderChart, yoy: renderYoy, agenda: renderAgenda, recentCases: renderRecent, notes: renderNotes };

    function render(body, w, ctx) {
        destroyCharts(ctx, w.uid);
        const fn = RENDER[w.type];
        if (!fn) return false;
        try {
            fn(body, w, ctx);
        } catch (e) {
            console.error('Dashboard widget failed:', w.type, e);
            destroyCharts(ctx, w.uid);
            body.innerHTML = '<div class="glass-card vd-card"><div class="vd-head"><div class="vd-title">' + esc((DL().TYPES[w.type] || {}).title || 'Widget') + '</div>' + gearBtn(w.uid) + '</div>' +
                '<div class="vd-empty"><div class="vd-empty-ico">⚠️</div><div>This widget could not be drawn.</div></div></div>';
        }
        return true;
    }

    root.ViperDashWidgets = {
        esc, decode, rgba, isLight, metricInfo, fmtVal, fmtNum, chartTitle, needMonths,
        render, destroyCharts, hasRenderer: (t) => !!RENDER[t], togglePin, notes, GEAR_SVG,
        PINNED_KEY, RECENT_KEY,
    };
})(typeof self !== 'undefined' ? self : this);

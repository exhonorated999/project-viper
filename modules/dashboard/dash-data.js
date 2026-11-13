/**
 * Customizable dashboard: data helpers.
 *
 * Pure functions with no DOM and no localStorage, so they can be unit tested:
 *   - month windows for chart ranges;
 *   - numeric coercion of metric values ('$1,234', narcotics {kg, lbs, pills});
 *   - case distributions (status / category / offense / priority / role);
 *   - year-over-year series;
 *   - agenda items (tasks, court dates, warrant due dates, PRTT expirations);
 *   - recent / pinned case lists.
 *
 * `sweepMonths` drives the page's own metric engine (passed in as an
 * adapter), so a chart's monthly numbers come from exactly the same code
 * as the stat cards and the Supervisor Link push.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.ViperDashData = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const ALL_RANGE_CAP = 36;

    function pad2(n) { return (n < 10 ? '0' : '') + n; }
    function monthKey(y, m) { return y + '-' + pad2(m + 1); }

    function monthInfo(y, m) {
        // Normalize month overflow (m = -1 → December of the year before).
        const d = new Date(y, m, 1);
        const yy = d.getFullYear(), mm = d.getMonth();
        return {
            key: monthKey(yy, mm), y: yy, m: mm,
            start: new Date(yy, mm, 1), end: new Date(yy, mm + 1, 1),
            label: MONTHS[mm], long: MONTHS[mm] + ' ' + yy,
        };
    }

    /** Local-time Date from 'YYYY-MM-DD', ISO text or a Date; null when unparseable. */
    function parseDate(v) {
        if (!v) return null;
        if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
        const s = String(v);
        const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T00:00:00') : new Date(s);
        return isNaN(d.getTime()) ? null : d;
    }

    /**
     * Months covered by a chart range, oldest first, ending with the current
     * month. 'all' starts at `firstDate` (the oldest case), capped at 36 months.
     */
    function monthList(range, now, firstDate) {
        const ref = now ? new Date(now) : new Date();
        const y = ref.getFullYear(), m = ref.getMonth();
        let n;
        switch (range) {
            case '6m': n = 6; break;
            case '24m': n = 24; break;
            case 'ytd': n = m + 1; break;
            case 'quarter': n = (m % 3) + 1; break;
            case 'all': {
                const f = parseDate(firstDate);
                n = f ? ((y - f.getFullYear()) * 12 + (m - f.getMonth()) + 1) : 12;
                n = Math.max(1, Math.min(ALL_RANGE_CAP, n));
                break;
            }
            case '12m':
            default: n = 12;
        }
        const out = [];
        for (let i = n - 1; i >= 0; i--) out.push(monthInfo(y, m - i));
        return out;
    }

    /** Date window for a range (distributions); null = all time. */
    function rangeWindow(range, now) {
        if (range === 'all') return null;
        const months = monthList(range, now);
        return { start: months[0].start, end: months[months.length - 1].end };
    }

    function rangeLabel(range) {
        return ({
            '6m': 'Last 6 months', '12m': 'Last 12 months', '24m': 'Last 24 months',
            ytd: 'This year', quarter: 'This quarter', all: 'All time',
        })[range] || 'Last 12 months';
    }

    function baseKey(key) { return String(key || '').split('.')[0]; }
    function unitOf(key) { const p = String(key || '').split('.'); return p[1] || null; }

    /**
     * A metric value as a plain number. Narcotics are an object
     * {kg, lbs, pills}; with a unit key ('narcotics_seized.kg') only that
     * unit is read. Money metrics arrive as '$1,234'.
     */
    function toNum(raw, key) {
        if (raw === null || raw === undefined) return null;
        if (typeof raw === 'number') return isFinite(raw) ? raw : 0;
        if (typeof raw === 'object') {
            const u = unitOf(key);
            if (u) { const n = parseFloat(raw[u]); return isFinite(n) ? n : 0; }
            let s = 0;
            for (const k in raw) { const n = parseFloat(raw[k]); if (isFinite(n)) s += n; }
            return s;
        }
        const n = parseFloat(String(raw).replace(/[^0-9.\-]/g, ''));
        return isFinite(n) ? n : 0;
    }

    /**
     * Run the page's metric engine once per month and harvest every metric's
     * `monthly` field. The adapter supplies the engine:
     *   install(window) / compute() / harvest() → {key: raw} / restore()
     * restore() always runs, even when a month throws.
     * Months already in `cache` are skipped. Returns the cache.
     */
    function sweepMonths(months, adapter, cache) {
        const out = cache || {};
        const todo = (months || []).filter(mo => !out[mo.key]);
        if (!todo.length) return out;
        try {
            todo.forEach(mo => {
                adapter.install({ start: mo.start, end: mo.end, label: mo.long });
                adapter.compute();
                out[mo.key] = adapter.harvest();
            });
        } finally {
            adapter.restore();
        }
        return out;
    }

    /** One metric across months; null where a month has no figure. */
    function seriesFor(cache, months, key) {
        const b = baseKey(key);
        return months.map(mo => {
            const h = cache && cache[mo.key];
            if (!h || !Object.prototype.hasOwnProperty.call(h, b)) return null;
            return toNum(h[b], key);
        });
    }

    function sum(arr) { return (arr || []).reduce((a, v) => a + (typeof v === 'number' && isFinite(v) ? v : 0), 0); }

    // ── distributions ───────────────────────────────────────────────

    const STATUS_LABELS = {
        active: 'Active', inactive: 'Inactive', closed: 'Closed',
        'closed-arrest': 'Closed w/ Arrest', transferred: 'Transferred',
    };
    const PRIORITY_LABELS = { 1: 'Critical', 2: 'High', 3: 'Medium', 4: 'Low' };

    function clip(s, n) { s = String(s == null ? '' : s).trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

    /**
     * Count cases by a dimension. Assists are left out (they never count in
     * case stats) EXCEPT for the 'role' breakdown, which exists to show them.
     * opts: { customStatuses, window: {start,end}|null, top }
     */
    function distribution(cases, dim, opts) {
        const o = opts || {};
        const top = o.top || 8;
        const customs = Array.isArray(o.customStatuses) ? o.customStatuses : [];
        const counts = new Map();
        (Array.isArray(cases) ? cases : []).forEach(c => {
            if (!c || typeof c !== 'object') return;
            const isAssist = c.caseRole === 'assist';
            if (isAssist && dim !== 'role') return;
            if (o.window) {
                const d = parseDate(c.dateAssigned) || parseDate(c.createdAt);
                if (!d || d < o.window.start || d >= o.window.end) return;
            }
            let key, label;
            switch (dim) {
                case 'status': {
                    key = String(c.status || 'active');
                    const cs = customs.find(s => s && s.id === key);
                    label = STATUS_LABELS[key] || (cs && cs.label) || key;
                    break;
                }
                case 'category':
                    label = clip(c.category, 40) || 'Uncategorized';
                    key = label.toLowerCase();
                    break;
                case 'offense':
                    label = clip(c.primaryOffense || c.offenseType, 40) || 'Unspecified';
                    key = label.toLowerCase();
                    break;
                case 'priority': {
                    const p = parseInt(c.priority, 10);
                    key = PRIORITY_LABELS[p] ? String(p) : 'none';
                    label = PRIORITY_LABELS[p] || 'No priority';
                    break;
                }
                case 'role':
                    key = isAssist ? 'assist' : 'lead';
                    label = isAssist ? 'Assisting' : 'Lead';
                    break;
                default:
                    return;
            }
            const cur = counts.get(key);
            if (cur) cur.count++;
            else counts.set(key, { key, label: clip(label, 40), count: 1 });
        });
        let list = Array.from(counts.values());
        if (dim === 'priority') list.sort((a, b) => (a.key === 'none') - (b.key === 'none') || a.key.localeCompare(b.key));
        else list.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
        if (list.length > top) {
            const head = list.slice(0, top - 1);
            const rest = list.slice(top - 1);
            head.push({ key: '__other', label: 'Other (' + rest.length + ')', count: rest.reduce((a, r) => a + r.count, 0) });
            list = head;
        }
        return list;
    }

    // ── year over year ──────────────────────────────────────────────

    /** Months needed for a YoY chart: Jan of last year through this month. */
    function yoyMonths(now) {
        const ref = now ? new Date(now) : new Date();
        const y = ref.getFullYear(), m = ref.getMonth();
        const out = [];
        for (let i = -12; i <= m; i++) out.push(monthInfo(y, i));
        return out;
    }

    function yoySeries(cache, key, now) {
        const ref = now ? new Date(now) : new Date();
        const y = ref.getFullYear(), m = ref.getMonth();
        const prevMonths = [], curMonths = [];
        for (let i = 0; i < 12; i++) { prevMonths.push(monthInfo(y - 1, i)); curMonths.push(monthInfo(y, i)); }
        const prev = seriesFor(cache, prevMonths, key);
        const cur = seriesFor(cache, curMonths, key).map((v, i) => (i > m ? null : v));
        return {
            labels: MONTHS.slice(), year: y, prev, cur,
            prevToDate: sum(prev.slice(0, m + 1)), curToDate: sum(cur.slice(0, m + 1)),
        };
    }

    // ── agenda ──────────────────────────────────────────────────────

    function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
    function dayDiff(a, b) { return Math.round((startOfDay(a) - startOfDay(b)) / 86400000); }

    /**
     * Upcoming items within `days` days, plus anything already overdue.
     * input: { tasks, warrants: {caseNumber: [w]}, cases, days, now,
     *          include: {tasks, court, warrants}, WarrantStatus }
     * Returns [{ kind, date, days, overdue, title, caseId, caseNumber, priority, id }]
     */
    function agendaItems(input) {
        const o = input || {};
        const now = o.now ? new Date(o.now) : new Date();
        const days = o.days || 7;
        const inc = Object.assign({ tasks: true, court: true, warrants: true }, o.include || {});
        const cases = Array.isArray(o.cases) ? o.cases : [];
        const byNumber = new Map();
        const byId = new Map();
        cases.forEach(c => { if (c) { byNumber.set(String(c.caseNumber), c); byId.set(String(c.id), c); } });
        const out = [];

        (Array.isArray(o.tasks) ? o.tasks : []).forEach(t => {
            if (!t || t.completed) return;
            const isCourt = t.kind === 'court';
            if (isCourt ? !inc.court : !inc.tasks) return;
            const d = parseDate(String(t.date || '').slice(0, 10));
            if (!d) return;
            const dd = dayDiff(d, now);
            if (dd > days) return;
            const c = t.caseId != null ? byId.get(String(t.caseId)) : null;
            out.push({
                kind: isCourt ? 'court' : 'task', id: t.id, date: d, days: dd, overdue: dd < 0,
                time: t.time || '', timeUTC: !!t.timeUTC,
                title: String(t.title || (isCourt ? 'Court' : 'Task')),
                priority: t.priority || '', caseId: c ? c.id : (t.caseId != null ? t.caseId : null),
                caseNumber: c ? c.caseNumber : '',
            });
        });

        const WS = o.WarrantStatus;
        if (inc.warrants && WS && o.warrants && typeof o.warrants === 'object') {
            Object.keys(o.warrants).forEach(cn => {
                const list = o.warrants[cn];
                if (!Array.isArray(list)) return;
                const c = byNumber.get(String(cn));
                list.forEach(w => {
                    if (!w) return;
                    if (WS.isOpen(w) && w.dueDate) {
                        const dd = WS.daysUntilDue(w, now);
                        if (dd !== null && dd <= days) {
                            out.push({
                                kind: 'warrant', id: w.id, date: parseDate(String(w.dueDate).slice(0, 10)) || now,
                                days: dd, overdue: dd < 0,
                                title: (WS.typeLabel ? WS.typeLabel(w) : (w.type || 'Warrant')) + (w.issuedTo ? ' → ' + w.issuedTo : '') + ' due',
                                caseId: c ? c.id : null, caseNumber: cn,
                            });
                        }
                    }
                    if (!w.closedOut && WS.hasExpiration && WS.hasExpiration(w) && !(WS.isExpirationAcknowledged && WS.isExpirationAcknowledged(w))) {
                        const de = WS.daysUntilExpiration(w, now);
                        if (de !== null && de !== undefined && de >= 0 && de <= days) {
                            out.push({
                                kind: 'prtt', id: w.id, date: parseDate(String(w.expirationDate).slice(0, 10)) || now,
                                days: de, overdue: false,
                                title: 'PRTT order expires' + (w.issuedTo ? ' (' + w.issuedTo + ')' : ''),
                                caseId: c ? c.id : null, caseNumber: cn,
                            });
                        }
                    }
                });
            });
        }

        const rank = { court: 0, warrant: 1, prtt: 2, task: 3 };
        out.sort((a, b) => (a.date - b.date) || (rank[a.kind] - rank[b.kind]) || String(a.time).localeCompare(String(b.time)));
        return out;
    }

    // ── recent / pinned cases ───────────────────────────────────────

    function pushRecent(list, id, max) {
        const cap = max || 15;
        const key = String(id);
        const arr = (Array.isArray(list) ? list : []).filter(x => String(x) !== key);
        arr.unshift(id);
        return arr.slice(0, cap);
    }

    function togglePinned(list, id) {
        const key = String(id);
        const arr = Array.isArray(list) ? list.slice() : [];
        const i = arr.findIndex(x => String(x) === key);
        if (i >= 0) arr.splice(i, 1); else arr.unshift(id);
        return arr.slice(0, 50);
    }

    /**
     * { pinned: [case], recent: [case] }. Unknown ids (deleted cases) are
     * dropped. With mode 'both' a pinned case is not repeated under Recent.
     */
    function recentLists(input) {
        const o = input || {};
        const count = o.count || 8;
        const mode = o.mode || 'both';
        const byId = new Map();
        (Array.isArray(o.cases) ? o.cases : []).forEach(c => { if (c) byId.set(String(c.id), c); });
        const resolve = (ids) => (Array.isArray(ids) ? ids : []).map(id => byId.get(String(id))).filter(Boolean);
        const pinned = mode === 'recent' ? [] : resolve(o.pinned).slice(0, count);
        const pinnedIds = new Set(pinned.map(c => String(c.id)));
        const recent = mode === 'pinned' ? [] : resolve(o.recent).filter(c => !pinnedIds.has(String(c.id))).slice(0, count);
        return { pinned, recent };
    }

    return {
        MONTHS, monthKey, monthInfo, parseDate, monthList, rangeWindow, rangeLabel,
        baseKey, unitOf, toNum, sweepMonths, seriesFor, sum,
        distribution, yoyMonths, yoySeries, agendaItems, dayDiff,
        pushRecent, togglePinned, recentLists,
    };
});

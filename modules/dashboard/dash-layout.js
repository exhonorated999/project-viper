/**
 * Customizable dashboard: layout model.
 *
 * Pure data, with no DOM access. Holds:
 *   - the widget catalog (sizes, settings schema);
 *   - the four presets;
 *   - migration from the old fixed dashboard (cardPreferences);
 *   - the validation every stored or imported layout passes through;
 *   - layout file export / import.
 *
 * Stored shape (localStorage 'viperDashboardLayouts'):
 *   { v: 1, active: '<layout id>',
 *     layouts: { <id>: { id, name, preset, widgets: [{ uid, type, x, y, w, h, cfg }] } } }
 *
 * Grid: 12 columns. Each row is ROW_PX px tall (see dash-app.js).
 *
 * Personal Notes text is NOT part of a layout. It lives in
 * 'viperDashNotes' keyed by widget uid, so an exported layout file never
 * carries what an officer typed.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.ViperDashLayout = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const COLS = 12;
    const MAX_WIDGETS = 60;
    const MAX_LAYOUTS = 20;
    const MAX_Y = 1000;
    const STORE_KEY = 'viperDashboardLayouts';
    const NOTES_KEY = 'viperDashNotes';
    const FILE_FORMAT = 'viper-dashboard-layout';
    const UID_RE = /^w_[a-z0-9]{4,16}$/;
    const LAYOUT_ID_RE = /^[a-z0-9_-]{1,40}$/;
    // Metric keys: built-ins (arrests, devices_cat_phone…), custom_<id>, and
    // the narcotics unit views used by charts (narcotics_seized.kg).
    const METRIC_RE = /^[a-z][a-z0-9_]{0,63}(\.(kg|lbs|pills))?$/;

    const CHART_TYPES = ['line', 'area', 'bar', 'stacked', 'donut', 'pie', 'gauge'];
    const DIST_TYPES = ['bar', 'donut', 'pie'];
    const GROUPS = ['month', 'status', 'category', 'offense', 'priority', 'role'];
    const RANGES = ['6m', '12m', '24m', 'ytd', 'quarter', 'all'];
    const TINTS = ['cyan', 'green', 'purple', 'orange', 'yellow'];

    /*
     * Widget catalog. Sizes are in grid units (w: columns of 12, h: rows).
     * `multi` widgets can be placed more than once, each with its own cfg.
     * `panel` widgets re-use an existing dashboard panel (same element IDs),
     * so there can only ever be one of each.
     * `requires` names a feature that must be switched on in Settings.
     */
    const TYPES = {
        stat: {
            title: 'Stat card', group: 'Stats', icon: '🔢', multi: true,
            desc: 'One metric in large type. Show this month next to the year, quarter or all-time total, a single number, or a number with a 12-month trend line.',
            min: { w: 2, h: 4 }, max: { w: 12, h: 16 }, def: { w: 3, h: 7 },
            cfg: {
                metric: { t: 'metric', d: 'arrests' },
                style: { t: 'enum', v: ['split', 'big', 'spark'], d: 'split' },
                period: { t: 'enum', v: ['month', 'scope', 'all'], d: 'month' },
            },
        },
        quickStats: {
            title: 'Quick Stats', group: 'Stats', icon: '📋', panel: true,
            desc: 'Four metrics in a compact list (pick them with the gear on the card).',
            min: { w: 3, h: 8 }, max: { w: 12, h: 30 }, def: { w: 4, h: 14 }, cfg: {},
        },
        caseAnalytics: {
            title: 'Case Analytics', group: 'Cases', icon: '📊', panel: true,
            desc: 'Open, closed and closed-with-arrest counts with progress bars.',
            min: { w: 3, h: 8 }, max: { w: 12, h: 30 }, def: { w: 8, h: 14 }, cfg: {},
        },
        investigations: {
            title: 'Active Investigations', group: 'Cases', icon: '🗂️', panel: true,
            desc: 'Your case list with search, filters and column picker.',
            min: { w: 4, h: 10 }, max: { w: 12, h: 60 }, def: { w: 8, h: 25 }, cfg: {},
        },
        recentCases: {
            title: 'Recent & Pinned Cases', group: 'Cases', icon: '⭐', multi: true,
            desc: 'One-click links to the cases you opened last, and cases you star.',
            min: { w: 2, h: 6 }, max: { w: 12, h: 40 }, def: { w: 4, h: 11 },
            cfg: {
                mode: { t: 'enum', v: ['both', 'recent', 'pinned'], d: 'both' },
                count: { t: 'int', min: 3, max: 20, d: 8 },
            },
        },
        warrantAlerts: {
            title: 'Warrant Alerts', group: 'Deadlines', icon: '⚠️', panel: true,
            desc: 'Overdue warrants, lapsed PRTT orders and stale cases.',
            min: { w: 3, h: 6 }, max: { w: 12, h: 40 }, def: { w: 8, h: 10 }, cfg: {},
        },
        tasks: {
            title: 'Tasks', group: 'Deadlines', icon: '✅', panel: true,
            desc: 'Your task list and calendar.',
            min: { w: 3, h: 12 }, max: { w: 12, h: 60 }, def: { w: 4, h: 25 }, cfg: {},
        },
        agenda: {
            title: 'Agenda', group: 'Deadlines', icon: '📅', multi: true,
            desc: 'What is due soon: tasks, court dates, warrant returns and PRTT expirations.',
            min: { w: 3, h: 6 }, max: { w: 12, h: 40 }, def: { w: 4, h: 12 },
            cfg: {
                days: { t: 'enum', v: [7, 14, 30], d: 7 },
                tasks: { t: 'bool', d: true },
                court: { t: 'bool', d: true },
                warrants: { t: 'bool', d: true },
            },
        },
        chart: {
            title: 'Chart', group: 'Charts', icon: '📈', multi: true,
            desc: 'Line, area, bar, stacked, donut, pie or gauge. Chart metrics by month, or cases by status, category, offense, priority or role.',
            min: { w: 3, h: 8 }, max: { w: 12, h: 30 }, def: { w: 6, h: 13 },
            cfg: {
                title: { t: 'text', max: 60, d: '' },
                type: { t: 'enum', v: CHART_TYPES, d: 'line' },
                groupBy: { t: 'enum', v: GROUPS, d: 'month' },
                metrics: { t: 'metrics', max: 4, d: ['new_cases_assigned', 'cases_closed'] },
                range: { t: 'enum', v: RANGES, d: '12m' },
                of: { t: 'metric', d: 'new_cases_assigned' },
            },
        },
        yoy: {
            title: 'Year over Year', group: 'Charts', icon: '📆', multi: true,
            desc: 'This year against last year, month by month, for any metric.',
            min: { w: 4, h: 8 }, max: { w: 12, h: 30 }, def: { w: 6, h: 12 },
            cfg: {
                metric: { t: 'metric', d: 'arrests' },
                type: { t: 'enum', v: ['bar', 'line'], d: 'bar' },
            },
        },
        reportsTools: {
            title: 'Reports & Tools', group: 'Tools', icon: '🧾', panel: true,
            desc: 'Generate Report, plus the IDS and Case Status Report buttons when switched on.',
            min: { w: 3, h: 5 }, max: { w: 12, h: 30 }, def: { w: 4, h: 10 }, cfg: {},
        },
        notes: {
            title: 'Personal Notes', group: 'Tools', icon: '📝', multi: true,
            desc: 'A sticky scratchpad. Saved on this computer only, and never included in layout exports.',
            min: { w: 2, h: 5 }, max: { w: 12, h: 40 }, def: { w: 4, h: 10 },
            cfg: {
                title: { t: 'text', max: 40, d: 'Notes' },
                tint: { t: 'enum', v: TINTS, d: 'yellow' },
            },
        },
        genlogs: {
            title: 'GenLogs Intelligence', group: 'Tools', icon: '🚚', panel: true, requires: 'genlogs',
            desc: 'GenLogs activity and lookup stats. Available when GenLogs is switched on in Settings.',
            min: { w: 6, h: 9 }, max: { w: 12, h: 30 }, def: { w: 12, h: 11 }, cfg: {},
        },
    };
    const TYPE_ORDER = Object.keys(TYPES);

    const PRESETS = {
        classic: { name: 'Classic', desc: 'The original VIPER dashboard: stats first, then analytics, then cases and tasks.' },
        casesFirst: { name: 'Cases First', desc: 'Your case list and tasks at the top, stats below.' },
        analyst: { name: 'Analyst', desc: 'Trend charts, year-over-year and case breakdowns.' },
        compact: { name: 'Compact', desc: 'A dense single screen: slim stats, case list, agenda, recent cases and notes.' },
    };
    const PRESET_ORDER = Object.keys(PRESETS);

    // ── small utilities ─────────────────────────────────────────────

    function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
    function clampInt(v, lo, hi, d) {
        const n = typeof v === 'number' ? v : parseInt(v, 10);
        if (!isFinite(n)) return d;
        return Math.max(lo, Math.min(hi, Math.round(n)));
    }
    function cleanText(v, max) {
        // Strip control characters; the renderer escapes the rest.
        return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
    }
    function defaultRng() { return Math.random(); }
    function newUid(rng) {
        const r = rng || defaultRng;
        let s = '';
        for (let i = 0; i < 8; i++) s += '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(r() * 36) % 36];
        return 'w_' + s;
    }
    function isMetricKey(k) { return typeof k === 'string' && METRIC_RE.test(k); }

    function defaultCfg(type) {
        const spec = TYPES[type];
        const out = {};
        if (!spec) return out;
        for (const k in spec.cfg) {
            const d = spec.cfg[k].d;
            out[k] = Array.isArray(d) ? d.slice() : d;
        }
        return out;
    }

    /** Keep only known cfg keys, each coerced to its schema. */
    function sanitizeCfg(type, raw) {
        const spec = TYPES[type];
        const out = {};
        if (!spec) return out;
        const src = isObj(raw) ? raw : {};
        for (const k in spec.cfg) {
            const f = spec.cfg[k];
            const v = src[k];
            switch (f.t) {
                case 'enum': {
                    // Enum values may be numbers (agenda days) coming back as strings.
                    const hit = f.v.find(x => x === v || String(x) === String(v));
                    out[k] = hit === undefined ? f.d : hit;
                    break;
                }
                case 'bool': out[k] = typeof v === 'boolean' ? v : f.d; break;
                case 'int': out[k] = clampInt(v, f.min, f.max, f.d); break;
                case 'text': out[k] = typeof v === 'string' ? cleanText(v, f.max) : f.d; break;
                case 'metric': out[k] = isMetricKey(v) ? v : f.d; break;
                case 'metrics': {
                    const list = Array.isArray(v) ? v.filter(isMetricKey) : [];
                    const uniq = Array.from(new Set(list)).slice(0, f.max);
                    out[k] = uniq.length ? uniq : f.d.slice();
                    break;
                }
                default: out[k] = f.d;
            }
        }
        if (type === 'chart') {
            // Only some type / grouping pairs make sense; coerce the rest.
            if (out.type === 'gauge') out.groupBy = 'month';
            else if (out.groupBy !== 'month' && DIST_TYPES.indexOf(out.type) < 0) out.type = 'bar';
        }
        return out;
    }

    function clampBox(type, raw) {
        const spec = TYPES[type];
        const w = clampInt(raw.w, spec.min.w, Math.min(spec.max.w, COLS), spec.def.w);
        const h = clampInt(raw.h, spec.min.h, spec.max.h, spec.def.h);
        const x = clampInt(raw.x, 0, COLS - w, 0);
        const y = clampInt(raw.y, 0, MAX_Y, 0);
        return { x, y, w, h };
    }

    /**
     * Validate a widget list. Drops unknown types and duplicate single-use
     * widgets, re-issues bad or duplicate uids, clamps sizes and sanitizes
     * each cfg. With `freshUids` every widget gets a new uid (imports).
     */
    function sanitizeWidgets(list, opts) {
        const o = opts || {};
        const rng = o.rng;
        const out = [];
        const seenUid = new Set();
        const seenSingle = new Set();
        (Array.isArray(list) ? list : []).forEach(raw => {
            if (out.length >= MAX_WIDGETS) return;
            if (!isObj(raw) || typeof raw.type !== 'string' || !Object.prototype.hasOwnProperty.call(TYPES, raw.type)) return;
            const spec = TYPES[raw.type];
            if (!spec.multi) {
                if (seenSingle.has(raw.type)) return;
                seenSingle.add(raw.type);
            }
            let uid = (!o.freshUids && typeof raw.uid === 'string' && UID_RE.test(raw.uid)) ? raw.uid : null;
            while (!uid || seenUid.has(uid)) uid = newUid(rng);
            seenUid.add(uid);
            const box = clampBox(raw.type, raw);
            out.push({ uid, type: raw.type, x: box.x, y: box.y, w: box.w, h: box.h, cfg: sanitizeCfg(raw.type, raw.cfg) });
        });
        return out;
    }

    function sanitizeLayout(raw, opts) {
        const src = isObj(raw) ? raw : {};
        const id = (typeof src.id === 'string' && LAYOUT_ID_RE.test(src.id)) ? src.id : null;
        const name = cleanText(src.name, 40) || 'My dashboard';
        const preset = PRESETS[src.preset] ? src.preset : null;
        return { id, name, preset, widgets: sanitizeWidgets(src.widgets, opts) };
    }

    function newLayoutId(store, base) {
        const stem = String(base || 'layout').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'layout';
        let id = stem, n = 2;
        while (store && store.layouts && store.layouts[id]) id = stem + '-' + (n++);
        return id;
    }

    // ── presets ─────────────────────────────────────────────────────

    const STAT_FALLBACK = ['new_cases_assigned', 'arrests', 'recovered_guns', 'rescued_individuals'];

    function prefCards(prefs) {
        const cp = prefs && prefs.cardPreferences;
        const pick = (i) => {
            const v = cp && (cp[i + 1] !== undefined ? cp[i + 1] : cp[String(i + 1)]);
            return isMetricKey(v) ? v : STAT_FALLBACK[i];
        };
        return [0, 1, 2, 3].map(pick);
    }

    /**
     * Widgets for a preset. `prefs.cardPreferences` (the old fixed cards'
     * metrics) fills the stat cards, so switching presets keeps the metrics
     * the officer already chose.
     */
    function presetWidgets(name, prefs, rng) {
        const cards = prefCards(prefs);
        const W = (type, x, y, w, h, cfg) => ({ type, x, y, w, h, cfg: cfg || {} });
        const stats = (y, h, style) => cards.map((m, i) => W('stat', i * 3, y, 3, h, { metric: m, style: style || 'split' }));
        let list;
        switch (name) {
            case 'casesFirst':
                list = [
                    W('investigations', 0, 0, 8, 22), W('tasks', 8, 0, 4, 22),
                    ...stats(22, 7),
                    W('caseAnalytics', 0, 29, 4, 14), W('warrantAlerts', 4, 29, 4, 14), W('quickStats', 8, 29, 4, 14),
                    W('genlogs', 0, 43, 8, 11), W('reportsTools', 8, 43, 4, 10),
                ];
                break;
            case 'analyst':
                list = [
                    ...stats(0, 7, 'spark'),
                    W('chart', 0, 7, 8, 13, { title: 'Monthly activity', type: 'line', groupBy: 'month', metrics: ['new_cases_assigned', 'cases_closed', 'arrests'], range: '12m' }),
                    W('chart', 8, 7, 4, 13, { title: 'Cases by status', type: 'donut', groupBy: 'status', range: 'all' }),
                    W('yoy', 0, 20, 6, 12, { metric: 'arrests', type: 'bar' }),
                    W('chart', 6, 20, 6, 12, { title: 'Cases by offense', type: 'bar', groupBy: 'offense', range: '12m' }),
                    W('investigations', 0, 32, 8, 20), W('agenda', 8, 32, 4, 20, { days: 14 }),
                    W('warrantAlerts', 0, 52, 8, 10), W('reportsTools', 8, 52, 4, 10),
                    W('genlogs', 0, 62, 12, 11),
                ];
                break;
            case 'compact':
                list = [
                    ...stats(0, 5, 'big'),
                    W('investigations', 0, 5, 8, 20), W('agenda', 8, 5, 4, 10), W('warrantAlerts', 8, 15, 4, 10),
                    W('recentCases', 0, 25, 4, 10), W('notes', 4, 25, 4, 10), W('reportsTools', 8, 25, 4, 10),
                    W('genlogs', 0, 35, 12, 11),
                ];
                break;
            case 'classic':
            default:
                // Matches the fixed dashboard: four stat cards; analytics
                // (2/3) beside Quick Stats (1/3); warrant alerts beside the
                // report buttons; GenLogs full width; cases beside tasks.
                list = [
                    ...stats(0, 7),
                    W('caseAnalytics', 0, 7, 8, 14), W('quickStats', 8, 7, 4, 14),
                    W('warrantAlerts', 0, 21, 8, 10), W('reportsTools', 8, 21, 4, 10),
                    W('genlogs', 0, 31, 12, 11),
                    W('investigations', 0, 42, 8, 25), W('tasks', 8, 42, 4, 25),
                ];
        }
        return sanitizeWidgets(list, { freshUids: true, rng });
    }

    function presetLayout(name, prefs, store, rng) {
        const key = PRESETS[name] ? name : 'classic';
        return {
            id: newLayoutId(store, key === 'classic' ? 'default' : key),
            name: key === 'classic' ? 'My dashboard' : PRESETS[key].name,
            preset: key,
            widgets: presetWidgets(key, prefs, rng),
        };
    }

    // ── store ───────────────────────────────────────────────────────

    /**
     * Validate a stored value (object or JSON text). Returns null when there
     * is nothing usable, so the caller can build a fresh store.
     */
    function sanitizeStore(raw, opts) {
        let src = raw;
        if (typeof src === 'string') { try { src = JSON.parse(src); } catch (_) { return null; } }
        if (!isObj(src) || !isObj(src.layouts)) return null;
        const layouts = {};
        let n = 0;
        for (const k of Object.keys(src.layouts)) {
            if (n >= MAX_LAYOUTS) break;
            if (!LAYOUT_ID_RE.test(k)) continue;
            const l = sanitizeLayout(src.layouts[k], opts);
            l.id = k;
            layouts[k] = l;
            n++;
        }
        const ids = Object.keys(layouts);
        if (!ids.length) return null;
        const active = (typeof src.active === 'string' && layouts[src.active]) ? src.active : ids[0];
        return { v: 1, active, layouts };
    }

    /**
     * The store to use: the saved one when valid, otherwise a new one holding
     * the Classic layout built from the old card preferences (first run, or
     * a corrupt value).
     */
    function ensureStore(raw, prefs, rng) {
        const s = sanitizeStore(raw, { rng });
        if (s) return { store: s, migrated: false };
        const l = presetLayout('classic', prefs, null, rng);
        return { store: { v: 1, active: l.id, layouts: { [l.id]: l } }, migrated: true };
    }

    // ── layout files ────────────────────────────────────────────────

    function exportLayout(layout) {
        const l = sanitizeLayout(layout);
        return {
            format: FILE_FORMAT,
            version: 1,
            name: l.name,
            preset: l.preset,
            exportedAt: new Date().toISOString(),
            widgets: l.widgets.map(w => ({ type: w.type, x: w.x, y: w.y, w: w.w, h: w.h, cfg: w.cfg })),
        };
    }

    /**
     * Parse a layout file (text or object). Throws Error with a readable
     * message when it is not a VIPER layout. Every widget gets a new uid.
     */
    function importLayout(input, opts) {
        let src = input;
        if (typeof src === 'string') {
            if (src.length > 512 * 1024) throw new Error('That file is too large to be a dashboard layout.');
            try { src = JSON.parse(src); } catch (_) { throw new Error('That file is not valid JSON.'); }
        }
        if (!isObj(src) || src.format !== FILE_FORMAT) throw new Error('That file is not a VIPER dashboard layout.');
        if (typeof src.version !== 'number' || src.version > 1) throw new Error('That layout was made by a newer VIPER. Update VIPER and try again.');
        const l = sanitizeLayout({ name: src.name, preset: src.preset, widgets: src.widgets }, { freshUids: true, rng: opts && opts.rng });
        if (!l.widgets.length) throw new Error('That layout has no widgets VIPER recognizes.');
        return l;
    }

    /** Stat widgets in reading order (top-to-bottom, left-to-right). */
    function statsInOrder(widgets) {
        return (widgets || []).filter(w => w.type === 'stat').slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
    }

    /**
     * cardPreferences mirror. Generate Report reads cardPreferences[1..4],
     * so keep them in step with the first four stat cards on the dashboard.
     */
    function cardPrefsFromLayout(layout, current) {
        const out = Object.assign({}, current || {});
        statsInOrder(layout && layout.widgets).slice(0, 4).forEach((w, i) => {
            const m = String(w.cfg.metric || '').split('.')[0];
            if (isMetricKey(m)) out[i + 1] = m;
        });
        return out;
    }

    return {
        COLS, MAX_WIDGETS, MAX_LAYOUTS, STORE_KEY, NOTES_KEY, FILE_FORMAT,
        TYPES, TYPE_ORDER, PRESETS, PRESET_ORDER, CHART_TYPES, DIST_TYPES, GROUPS, RANGES, TINTS,
        UID_RE, METRIC_RE,
        newUid, isMetricKey, defaultCfg, sanitizeCfg, sanitizeWidgets, sanitizeLayout, newLayoutId,
        presetWidgets, presetLayout, sanitizeStore, ensureStore, exportLayout, importLayout,
        statsInOrder, cardPrefsFromLayout,
    };
});

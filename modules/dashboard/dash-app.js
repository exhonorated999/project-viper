/**
 * Customizable dashboard: grid, edit mode, layouts, gallery and settings.
 *
 *   ViperDashboard.init(host) → true when the grid is up (index.html shows
 *                               the old fixed dashboard when this fails)
 *   ViperDashboard.edit()            toggle Customize mode
 *   ViperDashboard.refreshStats()    stat cards changed (metric / scope)
 *   ViperDashboard.onTasksChanged()  tasks changed (agenda widgets)
 *   ViperDashboard.onMetricsChanged() case data changed (all data widgets)
 *   ViperDashboard.teardown()
 *
 * `host` is the adapter built in index.html (see the boot block there). It
 * hands this module the page's metric engine, case/task lists and actions,
 * so nothing here reaches into index.html globals directly.
 *
 * Existing panels (Tasks, Active Investigations, Quick Stats…) keep their
 * markup and element IDs. They live in #dashLegacy with a data-dash-panel
 * attribute; the grid moves the element into its cell, and panels that are
 * not on the current layout wait in #dashParking.
 */
(function (root) {
    'use strict';

    const DL = () => root.ViperDashLayout;
    const DD = () => root.ViperDashData;
    const DW = () => root.ViperDashWidgets;

    const ROW_PX = 24;          // grid row height
    const MARGIN = 12;          // half the gap between cards
    const NARROW_PX = 760;      // below this the grid becomes one column
    const CACHE_KEY = 'viperDashMonthCache';   // sessionStorage
    const CHUNK_MS = 35;        // month sweep: work per slice before yielding
    const CFG_TYPES = ['stat', 'chart', 'yoy', 'agenda', 'recentCases', 'notes'];
    const AUTO_SETTINGS = ['stat', 'chart', 'yoy'];
    const GROUP_ORDER = ['Stats', 'Cases', 'Deadlines', 'Charts', 'Tools'];

    let S = null;

    // ── small helpers ───────────────────────────────────────────────

    function esc(s) { return DW().esc(s); }
    function clone(o) { return JSON.parse(JSON.stringify(o)); }
    function noop() {}
    function alive() {
        if (!S) return false;
        if (!S.gridEl.isConnected) { teardown(); return false; }
        return true;
    }
    function toast(msg, type) {
        try { if (S && S.host.toast) S.host.toast(esc(msg), type || 'info'); } catch (_) { /* ignore */ }
    }
    function confirmBox(msg, opts) {
        try { if (S && S.host.confirm) return Promise.resolve(S.host.confirm(esc(msg), opts || {})); } catch (_) { /* fall through */ }
        return Promise.resolve(root.confirm(msg));
    }
    function spec(type) { return DL().TYPES[type]; }
    function current() { return S.draft || S.layout; }
    function findWidget(uid) { return current().widgets.find(w => w.uid === uid) || null; }
    function available(w) {
        const sp = spec(w.type);
        if (!sp) return false;
        if (sp.requires === 'genlogs') { try { return !!S.host.genlogsEnabled(); } catch (_) { return false; } }
        return true;
    }
    function hasSettings(type) {
        const sp = spec(type);
        return type === 'quickStats' || (sp && Object.keys(sp.cfg || {}).length > 0);
    }

    // ── storage ─────────────────────────────────────────────────────

    function saveStore() {
        try {
            localStorage.setItem(DL().STORE_KEY, JSON.stringify(S.store));
            return true;
        } catch (e) {
            toast('Could not save the dashboard layout: ' + (e && e.message ? e.message : e), 'error');
            return false;
        }
    }

    /**
     * Hash of every localStorage value that can change a metric. The month
     * cache is only reused while this matches, so any case, task or setting
     * change recomputes. Dashboard-only keys are left out so opening a case
     * (recent list) or typing a note does not throw the cache away.
     */
    function fingerprint() {
        const skip = new Set([DL().STORE_KEY, DL().NOTES_KEY, DW().PINNED_KEY, DW().RECENT_KEY,
            'currentCaseId', 'viperDashStatScope', 'viperTheme', 'viperInvestigationsFilter', 'viperInvestigationsSort']);
        let h = 0x811c9dc5;
        const mix = (s) => {
            for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
        };
        const keys = [];
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && !skip.has(k)) keys.push(k);
            }
            keys.sort();
            keys.forEach(k => { mix(k); mix('\u0001'); mix(localStorage.getItem(k) || ''); mix('\u0002'); });
        } catch (_) { return 'x' + Date.now(); }
        return (h >>> 0).toString(36) + ':' + keys.length;
    }

    function loadMonthCache(fp) {
        try {
            const raw = JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null');
            if (raw && raw.fp === fp && raw.months && typeof raw.months === 'object' && !Array.isArray(raw.months)) return raw.months;
        } catch (_) { /* ignore */ }
        return {};
    }

    function saveMonthCache() {
        try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ fp: S.fp, months: S.ctx.monthCache })); } catch (_) { /* full: fine */ }
    }

    /** The page already computed this month at boot; reuse it. */
    function seedCurrentMonth() {
        try {
            const now = new Date();
            const key = DD().monthKey(now.getFullYear(), now.getMonth());
            S.ctx.monthCache[key] = S.host.sweep.harvest();
        } catch (e) { console.warn('Dashboard: could not read this month\u2019s figures', e); }
    }

    function firstCaseDate() {
        let min = null;
        (S.host.cases() || []).forEach(c => {
            if (!c || c.caseRole === 'assist') return;
            const d = DD().parseDate(c.dateAssigned) || DD().parseDate(c.createdAt);
            if (d && (!min || d < min)) min = d;
        });
        return min;
    }

    // ── month sweep (runs the page's metric engine once per month) ──

    function requestMonths(months, uid) {
        if (!S || !months) return;
        const sw = S.sweep;
        months.forEach(mo => {
            if (!S.ctx.monthCache[mo.key] && !sw.queued.has(mo.key)) { sw.queued.add(mo.key); sw.queue.push(mo); }
        });
        if (uid) sw.waiting.add(uid);
        schedulePump();
    }

    function schedulePump() {
        if (!S || S.sweep.timer || !S.sweep.queue.length) return;
        S.sweep.timer = setTimeout(pump, 16);
    }

    function pump() {
        if (!S) return;
        const sw = S.sweep;
        sw.timer = null;
        if (!alive()) return;
        const host = S.host;
        const adapter = { install: host.sweep.install, compute: host.sweep.compute, harvest: host.sweep.harvest, restore: noop };
        const t0 = (root.performance || Date).now();
        const log = console.log;
        console.log = noop; // the metric engine logs every figure it computes
        try {
            while (sw.queue.length) {
                const mo = sw.queue.shift();
                sw.queued.delete(mo.key);
                if (S.ctx.monthCache[mo.key]) continue;
                try { DD().sweepMonths([mo], adapter, S.ctx.monthCache); } catch (e) {
                    S.ctx.monthCache[mo.key] = {};
                    console.warn('Dashboard: could not compute ' + mo.long, e);
                }
                if ((root.performance || Date).now() - t0 > CHUNK_MS) break;
            }
        } finally {
            try { host.sweep.restore(); } catch (e) { console.warn('Dashboard: metric restore failed', e); }
            console.log = log;
        }
        saveMonthCache();
        const ready = [];
        sw.waiting.forEach(uid => {
            const w = findWidget(uid);
            if (!w) { sw.waiting.delete(uid); return; }
            const need = DW().needMonths(w, S.ctx);
            if (!need || S.ctx.monthsReady(need)) { sw.waiting.delete(uid); ready.push(w); }
        });
        ready.forEach(renderWidget);
        schedulePump();
    }

    // ── panels ──────────────────────────────────────────────────────

    function panelEl(type) { return document.querySelector('[data-dash-panel="' + type + '"]'); }

    function parkPanels() {
        if (!S.parking) return;
        S.gridEl.querySelectorAll('[data-dash-panel]').forEach(p => S.parking.appendChild(p));
    }

    function attachPanel(body, w) {
        const p = panelEl(w.type);
        if (!p) {
            body.innerHTML = '<div class="glass-card vd-card"><div class="vd-empty"><div class="vd-empty-ico">⚠️</div><div>' +
                esc(spec(w.type).title) + ' is not available.</div></div></div>';
            return;
        }
        if (p.parentElement !== body) { body.textContent = ''; body.appendChild(p); }
    }

    /** Put every panel back where index.html had it (used when the grid is torn down). */
    function restorePanels() {
        document.querySelectorAll('[data-vd-home]').forEach(h => {
            const p = panelEl(h.getAttribute('data-vd-home'));
            if (p && h.parentNode) h.parentNode.insertBefore(p, h.nextSibling);
        });
    }

    // ── grid ────────────────────────────────────────────────────────

    function wantCols() {
        const el = S.gridEl.parentElement || S.gridEl;
        const wdt = el.clientWidth;
        return wdt && wdt < NARROW_PX ? 1 : DL().COLS;
    }

    /** Grid boxes for the visible widgets. One column: stacked in reading order. */
    function layoutBoxes(list, cols) {
        if (cols === DL().COLS) return list.map(w => ({ x: w.x, y: w.y, w: w.w, h: w.h }));
        const order = list.map((w, i) => i).sort((a, b) => (list[a].y - list[b].y) || (list[a].x - list[b].x));
        const out = new Array(list.length);
        let y = 0;
        order.forEach(i => { out[i] = { x: 0, y, w: 1, h: list[i].h }; y += list[i].h; });
        return out;
    }

    function itemHtml(w) {
        const uid = esc(w.uid);
        return '<div class="grid-stack-item-content vd-content">' +
            '<div class="vd-body"></div>' +
            '<div class="vd-shield" title="Drag to move. Drag an edge or corner to resize."><span class="vd-shield-label"></span></div>' +
            '<div class="vd-tools">' +
            (hasSettings(w.type) ? '<button type="button" data-vd-act="settings" data-uid="' + uid + '" title="Settings" aria-label="Widget settings">' + DW().GEAR_SVG + '</button>' : '') +
            '<button type="button" data-vd-act="remove" data-uid="' + uid + '" title="Remove from dashboard" aria-label="Remove widget">✕</button>' +
            '</div></div>';
    }

    function addItem(w, box, auto) {
        const sp = spec(w.type);
        const el = document.createElement('div');
        el.className = 'grid-stack-item vd-item';
        el.setAttribute('data-type', w.type);
        el.innerHTML = itemHtml(w);
        S.gridEl.appendChild(el);
        const opts = { id: w.uid, w: box.w, h: box.h };
        if (auto) opts.autoPosition = true;
        else { opts.x = box.x; opts.y = box.y; }
        if (S.cols === DL().COLS) {
            opts.minW = sp.min.w; opts.minH = sp.min.h;
            opts.maxW = Math.min(sp.max.w, DL().COLS); opts.maxH = sp.max.h;
        }
        S.grid.makeWidget(el, opts);
        S.items.set(w.uid, el);
        return el;
    }

    function shieldTitle(w) {
        const sp = spec(w.type);
        let t = sp.title;
        try {
            if (w.type === 'stat') { const i = DW().metricInfo(S.ctx, w.cfg.metric); t = i ? i.text : 'Stat card'; }
            else if (w.type === 'chart') t = DW().chartTitle(S.ctx, w.cfg);
            else if (w.type === 'yoy') { const i = DW().metricInfo(S.ctx, w.cfg.metric); t = 'Year over Year' + (i ? ': ' + i.text : ''); }
            else if (w.type === 'notes') t = w.cfg.title || 'Notes';
        } catch (_) { /* keep the catalog title */ }
        return sp.icon + ' ' + t;
    }

    function paintShield(el, w) {
        if (!el || !w) return;
        const lab = el.querySelector('.vd-shield-label');
        if (!lab) return;
        const n = el.gridstackNode;
        const size = n ? n.w + '×' + n.h : '';
        lab.innerHTML = esc(shieldTitle(w)) + (size ? '<span class="vd-shield-size">' + esc(size) + '</span>' : '');
    }

    function renderWidget(w) {
        if (!S || !w) return;
        const el = S.items.get(w.uid);
        if (!el) return;
        const body = el.querySelector('.vd-body');
        if (spec(w.type).panel) {
            attachPanel(body, w);
        } else {
            // Render with the live cell size; never write it back outside edit mode.
            const n = el.gridstackNode;
            const rw = Object.assign({}, w, { w: S.cols === DL().COLS ? (n ? n.w : w.w) : DL().COLS, h: n ? n.h : w.h });
            DW().render(body, rw, S.ctx);
        }
        paintShield(el, w);
    }

    function flushNotes() {
        if (!S) return;
        Object.keys(S.noteTimers).forEach(uid => {
            clearTimeout(S.noteTimers[uid]);
            delete S.noteTimers[uid];
            const ta = S.gridEl.querySelector('textarea[data-vd-note="' + uid + '"]');
            if (ta) DW().notes.set(uid, ta.value);
        });
    }

    function destroyAllCharts() {
        Object.keys(S.ctx.charts).forEach(uid => DW().destroyCharts(S.ctx, uid));
    }

    /** (Re)build every cell from the current layout (stored, or the draft while editing). */
    function buildGrid() {
        flushNotes();
        const L = current();
        parkPanels();
        destroyAllCharts();
        S.items.clear();
        S.grid.removeAll(true);
        S.cols = S.draft ? DL().COLS : wantCols();
        if (S.grid.getColumn() !== S.cols) S.grid.column(S.cols, 'none');
        const visible = L.widgets.filter(available);
        const boxes = layoutBoxes(visible, S.cols);
        S.grid.setAnimation(false); // no fly-in when (re)building
        S.grid.batchUpdate();
        try {
            visible.forEach((w, i) => addItem(w, boxes[i], false));
        } finally {
            S.grid.batchUpdate(false);
            setTimeout(() => { if (S && S.grid) S.grid.setAnimation(true); }, 50);
        }
        visible.forEach(renderWidget);
        updateEmptyHint();
        paintSwitch();
        paintBar();
    }

    function rerender(filter) {
        if (!alive()) return;
        current().widgets.forEach(w => {
            if (!S.items.has(w.uid)) return;
            if (filter && !filter(w)) return;
            renderWidget(w);
        });
    }

    function updateEmptyHint() {
        if (!S.emptyHint) return;
        S.emptyHint.hidden = S.items.size > 0;
        S.emptyHint.innerHTML = S.draft
            ? 'This layout is empty. Click <b>+ Add widget</b> to put something on it.'
            : 'This dashboard layout is empty. Click <b>Customize</b> to add widgets.';
    }

    // ── layout switcher (outside edit mode) ─────────────────────────

    function paintSwitch() {
        const sel = S.switchEl;
        if (!sel) return;
        const ids = Object.keys(S.store.layouts);
        sel.hidden = !!S.draft || ids.length < 2;
        sel.innerHTML = ids.map(id => '<option value="' + esc(id) + '"' + (id === S.store.active ? ' selected' : '') + '>' +
            esc(S.store.layouts[id].name) + '</option>').join('');
    }

    function switchLayout(id) {
        if (!S.store.layouts[id] || id === S.store.active) return;
        S.store.active = id;
        S.layout = S.store.layouts[id];
        saveStore();
        if (S.draft) S.draft = clone(S.layout);
        buildGrid();
        syncCardPrefs();
    }

    // ── keeping the rest of VIPER in step ───────────────────────────

    /** Generate Report reads cardPreferences[1..4]: mirror the first four stat cards. */
    function syncCardPrefs() {
        try {
            const cur = S.host.cardPreferences() || {};
            const next = DL().cardPrefsFromLayout(S.layout, cur);
            if (JSON.stringify(next) !== JSON.stringify(cur)) S.host.setCardPreferences(next);
        } catch (e) { console.warn('Dashboard: card preference sync failed', e); }
    }

    function pruneNotes() {
        const live = new Set();
        Object.keys(S.store.layouts).forEach(id => S.store.layouts[id].widgets.forEach(w => live.add(w.uid)));
        if (S.draft) S.draft.widgets.forEach(w => live.add(w.uid));
        DW().notes.prune(live);
    }

    // ── edit mode ───────────────────────────────────────────────────

    function enterEdit() {
        if (S.draft) return;
        if (wantCols() !== DL().COLS) {
            toast('Make the VIPER window wider to customize the dashboard.', 'info');
            return;
        }
        closeMenu();
        S.draft = clone(S.layout);
        S.gridEl.classList.add('vd-editing');
        if (S.cols !== DL().COLS) buildGrid();
        S.grid.setStatic(false);
        S.bar.hidden = false;
        paintBar();
        paintSwitch();
        updateEmptyHint();
        if (S.customizeBtn) S.customizeBtn.setAttribute('aria-pressed', 'true');
        S.bar.scrollIntoView({ block: 'nearest' });
    }

    function exitEdit() {
        closeMenu();
        S.draft = null;
        S.grid.setStatic(true);
        S.gridEl.classList.remove('vd-editing');
        S.bar.hidden = true;
        if (S.customizeBtn) S.customizeBtn.setAttribute('aria-pressed', 'false');
        paintSwitch();
        updateEmptyHint();
    }

    /** The draft with positions read off the grid. */
    function draftWithPositions() {
        const L = S.draft;
        const pos = new Map();
        S.grid.engine.nodes.forEach(n => pos.set(n.id, n));
        const list = [];
        L.widgets.forEach(w => {
            const n = pos.get(w.uid);
            if (n) list.push(Object.assign({}, w, { x: n.x, y: n.y, w: n.w, h: n.h }));
            else if (!available(w)) list.push(w); // switched-off feature: keep it for later
        });
        list.sort((a, b) => (a.y - b.y) || (a.x - b.x));
        return { id: L.id, name: L.name, preset: L.preset, widgets: DL().sanitizeWidgets(list) };
    }

    /** Save the draft into the store without leaving edit mode. */
    function commitDraft() {
        const l = draftWithPositions();
        S.store.layouts[l.id] = l;
        S.store.active = l.id;
        S.layout = l;
        S.draft = clone(l);
        saveStore();
        syncCardPrefs();
        pruneNotes();
    }

    function done() {
        if (!S.draft) return;
        commitDraft();
        exitEdit();
        rerender(w => !spec(w.type).panel && w.type !== 'notes'); // sizes may have changed
    }

    function cancelEdit() {
        if (!S.draft) return;
        exitEdit();
        buildGrid();
    }

    function edit() {
        if (!S) return;
        if (S.draft) done(); else enterEdit();
    }

    function uniqueUid() {
        const used = new Set();
        Object.keys(S.store.layouts).forEach(id => S.store.layouts[id].widgets.forEach(w => used.add(w.uid)));
        if (S.draft) S.draft.widgets.forEach(w => used.add(w.uid));
        let uid;
        do { uid = DL().newUid(); } while (used.has(uid));
        return uid;
    }

    function firstUnusedMetric() {
        const used = new Set(current().widgets.filter(w => w.type === 'stat').map(w => DD().baseKey(w.cfg.metric)));
        const keys = Object.keys(S.host.metrics() || {});
        return keys.find(k => !used.has(k)) || keys[0] || 'arrests';
    }

    function addWidget(type) {
        const sp = spec(type);
        if (!sp || !S.draft) return;
        const w = { uid: uniqueUid(), type, x: 0, y: 0, w: sp.def.w, h: sp.def.h, cfg: DL().defaultCfg(type) };
        if (type === 'stat') w.cfg.metric = firstUnusedMetric();
        S.draft.widgets.push(w);
        const el = addItem(w, { w: w.w, h: w.h }, true);
        renderWidget(w);
        updateEmptyHint();
        try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) { el.scrollIntoView(); }
        el.classList.add('vd-flash');
        setTimeout(() => el.classList.remove('vd-flash'), 1300);
        if (AUTO_SETTINGS.indexOf(type) >= 0) setTimeout(() => openSettings(w.uid), 120);
    }

    function removeWidget(uid) {
        if (!S.draft) return;
        const el = S.items.get(uid);
        if (!el) return;
        const p = el.querySelector('[data-dash-panel]');
        if (p && S.parking) S.parking.appendChild(p);
        DW().destroyCharts(S.ctx, uid);
        S.grid.removeWidget(el, true);
        S.items.delete(uid);
        S.sweep.waiting.delete(uid);
        S.draft.widgets = S.draft.widgets.filter(w => w.uid !== uid);
        updateEmptyHint();
    }

    // ── edit bar + layouts menu ─────────────────────────────────────

    function buildBar() {
        S.bar.innerHTML =
            '<span class="vd-bar-title">Customize dashboard</span>' +
            '<span class="vd-bar-hint">Drag a card to move it. Drag an edge or corner to resize it.</span>' +
            '<span class="vd-bar-spacer"></span>' +
            '<button type="button" class="vd-btn vd-btn-primary" data-bar="add">+ Add widget</button>' +
            '<div class="vd-menu-wrap"><button type="button" class="vd-btn" data-bar="menu" aria-haspopup="true" aria-expanded="false">' +
            'Layout: <b class="vd-bar-lname"></b> ▾</button><div class="vd-menu" role="menu" hidden></div></div>' +
            '<button type="button" class="vd-btn" data-bar="cancel" title="Undo every change since you clicked Customize (Esc)">Cancel</button>' +
            '<button type="button" class="vd-btn vd-btn-go" data-bar="done">Done</button>';
        S.bar.addEventListener('click', onBarClick);
    }

    function paintBar() {
        if (!S.bar) return;
        const n = S.bar.querySelector('.vd-bar-lname');
        if (n) n.textContent = current().name;
    }

    function menuEl() { return S.bar.querySelector('.vd-menu'); }

    function openMenu() {
        const m = menuEl();
        const ids = Object.keys(S.store.layouts);
        const full = ids.length >= DL().MAX_LAYOUTS;
        const L = current();
        let html = ids.map(id => {
            const on = id === L.id;
            return '<button type="button" role="menuitem" data-menu="switch" data-id="' + esc(id) + '"' + (on ? ' disabled' : '') + '>' +
                (on ? '✓ ' : '\u2003') + esc(S.store.layouts[id].name) + '</button>';
        }).join('');
        html += '<hr>' +
            '<button type="button" role="menuitem" data-menu="new"' + (full ? ' disabled' : '') + '>New layout from a preset…</button>' +
            '<button type="button" role="menuitem" data-menu="dup"' + (full ? ' disabled' : '') + '>Duplicate this layout…</button>' +
            '<button type="button" role="menuitem" data-menu="rename">Rename…</button>' +
            '<button type="button" role="menuitem" data-menu="reset">Reset to preset…</button>' +
            '<hr>' +
            '<button type="button" role="menuitem" data-menu="export">Export layout file…</button>' +
            '<button type="button" role="menuitem" data-menu="import"' + (full ? ' disabled' : '') + '>Import layout file…</button>' +
            '<hr>' +
            '<button type="button" role="menuitem" class="is-danger" data-menu="delete"' + (ids.length < 2 ? ' disabled title="You need at least one layout"' : '') + '>Delete this layout</button>';
        m.innerHTML = html;
        m.hidden = false;
        S.bar.querySelector('[data-bar="menu"]').setAttribute('aria-expanded', 'true');
    }

    function closeMenu() {
        if (!S || !S.bar) return;
        const m = menuEl();
        if (m && !m.hidden) {
            m.hidden = true;
            const b = S.bar.querySelector('[data-bar="menu"]');
            if (b) b.setAttribute('aria-expanded', 'false');
        }
    }

    function onBarClick(e) {
        const mi = e.target.closest('[data-menu]');
        if (mi) {
            if (mi.disabled) return;
            closeMenu();
            menuAction(mi.getAttribute('data-menu'), mi.getAttribute('data-id'));
            return;
        }
        const b = e.target.closest('[data-bar]');
        if (!b) return;
        switch (b.getAttribute('data-bar')) {
            case 'add': closeMenu(); openGallery(); break;
            case 'menu': if (menuEl().hidden) openMenu(); else closeMenu(); break;
            case 'cancel': cancelEdit(); break;
            case 'done': done(); break;
            default:
        }
    }

    async function menuAction(act, id) {
        const L = current();
        switch (act) {
            case 'switch':
                commitDraft();
                switchLayout(id);
                break;
            case 'new':
                openPresetPicker();
                break;
            case 'dup': {
                const name = await promptText('Duplicate layout', 'Name for the copy', L.name + ' copy', 'Duplicate');
                if (!name || !S) return;
                commitDraft();
                const src = S.layout;
                const widgets = DL().sanitizeWidgets(src.widgets, { freshUids: true });
                // Copy Personal Notes text to the new widgets (same order).
                src.widgets.forEach((w, i) => {
                    if (w.type === 'notes' && widgets[i] && widgets[i].type === 'notes') {
                        const t = DW().notes.get(w.uid);
                        if (t) DW().notes.set(widgets[i].uid, t);
                    }
                });
                const copy = { id: DL().newLayoutId(S.store, name), name, preset: src.preset, widgets };
                if (addLayout(copy)) toast('Made a copy named \u201c' + copy.name + '\u201d.', 'success');
                break;
            }
            case 'rename': {
                const name = await promptText('Rename layout', 'Layout name', L.name, 'Rename');
                if (!name || !S) return;
                const raw = String(name).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 40);
                if (!raw) return;
                const clean = uniqueLayoutName(raw, L.id);
                S.store.layouts[L.id].name = clean;
                if (S.draft) S.draft.name = clean;
                saveStore();
                paintBar();
                paintSwitch();
                break;
            }
            case 'reset': {
                const pk = DL().PRESETS[L.preset] ? L.preset : 'classic';
                const ok = await confirmBox('Put this layout back to the ' + DL().PRESETS[pk].name + ' preset? You can still click Cancel afterwards to keep what you had.', { okText: 'Reset' });
                if (!ok || !S || !S.draft) return;
                S.draft.widgets = DL().presetWidgets(pk, { cardPreferences: S.host.cardPreferences() });
                S.draft.preset = pk;
                buildGrid();
                break;
            }
            case 'export':
                exportCurrent();
                break;
            case 'import':
                pickImport();
                break;
            case 'delete': {
                if (Object.keys(S.store.layouts).length < 2) return;
                const ok = await confirmBox('Delete the layout \u201c' + L.name + '\u201d? This cannot be undone.', { danger: true, okText: 'Delete' });
                if (!ok || !S) return;
                delete S.store.layouts[L.id];
                const next = Object.keys(S.store.layouts)[0];
                S.store.active = next;
                S.layout = S.store.layouts[next];
                if (S.draft) S.draft = clone(S.layout);
                saveStore();
                pruneNotes();
                buildGrid();
                syncCardPrefs();
                break;
            }
            default:
        }
    }

    /** "Analyst" → "Analyst (2)" when another layout already uses the name. */
    function uniqueLayoutName(name, exceptId) {
        const base = String(name || 'Layout').slice(0, 40);
        const taken = new Set(Object.keys(S.store.layouts).filter(k => k !== exceptId)
            .map(k => String(S.store.layouts[k].name || '').trim().toLowerCase()));
        if (!taken.has(base.trim().toLowerCase())) return base;
        for (let i = 2; i < 100; i++) {
            const n = base.slice(0, 35).trim() + ' (' + i + ')';
            if (!taken.has(n.toLowerCase())) return n;
        }
        return base;
    }

    /** Add a layout to the store and switch to it (staying in edit mode). */
    function addLayout(l) {
        if (Object.keys(S.store.layouts).length >= DL().MAX_LAYOUTS) {
            toast('You already have ' + DL().MAX_LAYOUTS + ' layouts. Delete one first.', 'warning');
            return false;
        }
        l.name = uniqueLayoutName(l.name);
        S.store.layouts[l.id] = l;
        S.store.active = l.id;
        S.layout = l;
        if (S.draft) S.draft = clone(l);
        saveStore();
        buildGrid();
        syncCardPrefs();
        return true;
    }

    function openPresetPicker() {
        let chosen = 'classic';
        const m = openModal({
            title: 'New layout', wide: true,
            foot: '<button type="button" class="vd-btn" data-modal="close">Cancel</button><button type="button" class="vd-btn vd-btn-go" data-modal="create">Create layout</button>',
            onAction(a) {
                if (a === 'pick') return;
                if (a !== 'create') return;
                const inp = m.body.querySelector('input[name="lname"]');
                const name = (inp.value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 40) || DL().PRESETS[chosen].name;
                m.close();
                if (S.draft) commitDraft();
                const l = DL().presetLayout(chosen, { cardPreferences: S.host.cardPreferences() }, S.store);
                l.id = DL().newLayoutId(S.store, name);
                l.name = name;
                addLayout(l);
            },
        });
        m.body.innerHTML = '<div class="vd-field"><span class="vd-field-label">Start from</span><div class="vd-preset-grid">' +
            DL().PRESET_ORDER.map(k => '<button type="button" class="vd-gal-tile" data-preset="' + k + '" aria-pressed="' + (k === chosen) + '">' +
                '<div><div class="vd-gal-name">' + esc(DL().PRESETS[k].name) + '</div><div class="vd-gal-desc">' + esc(DL().PRESETS[k].desc) + '</div></div></button>').join('') +
            '</div></div>' +
            '<div class="vd-field"><label for="vdLname">Layout name</label><input id="vdLname" name="lname" class="vd-input" maxlength="40" placeholder="Classic"></div>' +
            '<div class="vd-help">Stat cards start with the metrics you already picked. You can change anything afterwards.</div>';
        const paint = () => m.body.querySelectorAll('[data-preset]').forEach(b => {
            const on = b.getAttribute('data-preset') === chosen;
            b.setAttribute('aria-pressed', String(on));
            b.style.borderColor = on ? 'rgb(var(--vp-cyan))' : '';
        });
        m.body.addEventListener('click', e => {
            const b = e.target.closest('[data-preset]');
            if (!b) return;
            chosen = b.getAttribute('data-preset');
            m.body.querySelector('input[name="lname"]').placeholder = DL().PRESETS[chosen].name;
            paint();
        });
        paint();
    }

    function exportCurrent() {
        const l = S.draft ? draftWithPositions() : S.layout;
        const data = DL().exportLayout(l);
        const text = JSON.stringify(data, null, 2);
        const blob = new Blob([text], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const safe = String(l.name || 'dashboard').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(0, 60) || 'dashboard';
        a.href = url;
        a.download = 'VIPER dashboard - ' + safe + '.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        toast('Layout exported. Personal Notes text is never included.', 'success');
    }

    function pickImport() {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = '.json,application/json';
        inp.addEventListener('change', () => {
            const f = inp.files && inp.files[0];
            if (!f) return;
            if (f.size > 512 * 1024) { toast('That file is too large to be a dashboard layout.', 'error'); return; }
            const rd = new FileReader();
            rd.onload = () => {
                if (!S) return;
                let l;
                try { l = DL().importLayout(String(rd.result || '')); } catch (e) { toast(e.message || 'That file could not be imported.', 'error'); return; }
                if (S.draft) commitDraft();
                l.id = DL().newLayoutId(S.store, l.name);
                if (addLayout(l)) toast('Imported \u201c' + l.name + '\u201d.', 'success');
            };
            rd.onerror = () => toast('That file could not be read.', 'error');
            rd.readAsText(f);
        });
        inp.click();
    }

    // ── modals ──────────────────────────────────────────────────────

    function closeModal() {
        if (S && S.modal) S.modal.close();
    }

    function openModal(o) {
        closeModal();
        const wrap = document.createElement('div');
        wrap.className = 'vd-modal-wrap';
        wrap.innerHTML = '<div class="vd-modal' + (o.wide ? ' is-wide' : '') + '" role="dialog" aria-modal="true" aria-label="' + esc(o.title) + '">' +
            '<div class="vd-modal-head"><h3>' + esc(o.title) + '</h3><button type="button" class="vd-modal-x" data-modal="close" aria-label="Close">×</button></div>' +
            '<div class="vd-modal-body"></div>' +
            (o.foot ? '<div class="vd-modal-foot">' + o.foot + '</div>' : '') + '</div>';
        document.body.appendChild(wrap);
        let closed = false;
        const m = {
            wrap,
            body: wrap.querySelector('.vd-modal-body'),
            close() {
                if (closed) return;
                closed = true;
                wrap.remove();
                if (S && S.modal === m) S.modal = null;
                if (o.onClose) o.onClose();
            },
        };
        wrap.addEventListener('mousedown', e => { if (e.target === wrap) m.close(); });
        wrap.addEventListener('click', e => {
            const b = e.target.closest('[data-modal]');
            if (!b || !wrap.contains(b)) return;
            const a = b.getAttribute('data-modal');
            if (a === 'close') m.close();
            else if (o.onAction) o.onAction(a, b);
        });
        if (S) S.modal = m;
        return m;
    }

    function promptText(title, label, value, okText) {
        return new Promise(resolve => {
            let settled = false;
            const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
            const m = openModal({
                title,
                foot: '<button type="button" class="vd-btn" data-modal="close">Cancel</button><button type="button" class="vd-btn vd-btn-go" data-modal="ok">' + esc(okText || 'OK') + '</button>',
                onAction(a) {
                    if (a !== 'ok') return;
                    const v = inp.value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 40);
                    if (!v) { inp.focus(); return; }
                    finish(v);
                    m.close();
                },
                onClose() { finish(null); },
            });
            m.body.innerHTML = '<div class="vd-field"><label for="vdPrompt">' + esc(label) + '</label><input id="vdPrompt" class="vd-input" maxlength="40"></div>';
            const inp = m.body.querySelector('input');
            inp.value = value || '';
            inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); m.wrap.querySelector('[data-modal="ok"]').click(); } });
            setTimeout(() => { inp.focus(); inp.select(); }, 0);
        });
    }

    // ── widget gallery ──────────────────────────────────────────────

    function openGallery() {
        if (!S.draft) return;
        const L = S.draft;
        const present = new Set(L.widgets.map(w => w.type));
        const full = L.widgets.length >= DL().MAX_WIDGETS;
        let glOn = false;
        try { glOn = !!S.host.genlogsEnabled(); } catch (_) { /* off */ }
        const m = openModal({
            title: 'Add a widget', wide: true,
            onAction(a, b) {
                if (a !== 'add' || b.disabled) return;
                const type = b.getAttribute('data-type');
                m.close();
                addWidget(type);
            },
        });
        let html = full ? '<div class="vd-help" style="margin-bottom:0.6rem;color:#fbbf24">This layout has the most widgets it can hold (' + DL().MAX_WIDGETS + '). Remove one to add another.</div>' : '';
        GROUP_ORDER.forEach(g => {
            const types = DL().TYPE_ORDER.filter(t => spec(t).group === g);
            if (!types.length) return;
            html += '<div class="vd-gal-group">' + esc(g) + '</div><div class="vd-gal-grid">';
            types.forEach(t => {
                const sp = spec(t);
                let note = '';
                let off = full;
                if (!sp.multi && present.has(t)) { off = true; note = 'Already on this layout.'; }
                else if (sp.requires === 'genlogs' && !glOn) { off = true; note = 'Switch on GenLogs in Settings to use this.'; }
                html += '<button type="button" class="vd-gal-tile" data-modal="add" data-type="' + esc(t) + '"' + (off ? ' disabled' : '') + '>' +
                    '<span class="vd-gal-ico" aria-hidden="true">' + sp.icon + '</span>' +
                    '<span style="min-width:0"><span class="vd-gal-name" style="display:block">' + esc(sp.title) + (sp.multi ? '' : '') + '</span>' +
                    '<span class="vd-gal-desc" style="display:block">' + esc(sp.desc) + '</span>' +
                    (note ? '<span class="vd-gal-note" style="display:block">' + esc(note) + '</span>' : '') + '</span></button>';
            });
            html += '</div>';
        });
        m.body.innerHTML = html;
    }

    // ── widget settings ─────────────────────────────────────────────

    const UNITS = ['kg', 'lbs', 'pills'];

    /** Metric choices: [{key, text, custom}] — narcotics split by unit when asked. */
    function metricChoices(opts) {
        const o = opts || {};
        const metrics = S.host.metrics() || {};
        const labels = S.host.labels() || {};
        const out = [];
        Object.keys(metrics).forEach(k => {
            const m = metrics[k];
            const monthly = m && m.monthly !== null && m.monthly !== undefined;
            if (o.monthlyOnly && !monthly) return;
            const text = DW().decode(labels[k] || k);
            const custom = k.indexOf('custom_') === 0;
            if (o.units && monthly && typeof m.monthly === 'object') {
                UNITS.forEach(u => out.push({ key: k + '.' + u, text: text + ' (' + u + ')', custom }));
            } else {
                out.push({ key: k, text, custom });
            }
        });
        return out;
    }

    function metricSelect(name, cur, opts) {
        const list = metricChoices(opts);
        const opt = (c) => '<option value="' + esc(c.key) + '"' + (c.key === cur ? ' selected' : '') + '>' + esc(c.text) + '</option>';
        const builtIn = list.filter(c => !c.custom), custom = list.filter(c => c.custom);
        let html = '<select class="vd-input" name="' + name + '">';
        if (cur && !list.some(c => c.key === cur)) html += '<option value="' + esc(cur) + '" selected>(removed metric)</option>';
        html += builtIn.map(opt).join('');
        if (custom.length) html += '<optgroup label="Custom metrics">' + custom.map(opt).join('') + '</optgroup>';
        return html + '</select>';
    }

    function choice(name, items, cur) {
        return '<div class="vd-choice" role="radiogroup">' + items.map(it => {
            const on = String(it.v) === String(cur);
            return '<label class="' + (on ? 'is-on' : '') + '"><input type="radio" name="' + name + '" value="' + esc(it.v) + '"' + (on ? ' checked' : '') + '>' +
                esc(it.label) + (it.sub ? '<small>' + esc(it.sub) + '</small>' : '') + '</label>';
        }).join('') + '</div>';
    }

    function field(label, inner, help) {
        return '<div class="vd-field"><span class="vd-field-label">' + esc(label) + '</span>' + inner + (help ? '<div class="vd-help">' + help + '</div>' : '') + '</div>';
    }

    const RANGE_LABEL = { '6m': 'Last 6 months', '12m': 'Last 12 months', '24m': 'Last 24 months', ytd: 'This year', quarter: 'This quarter', all: 'All time' };
    const GROUP_LABEL = { month: 'Metrics by month', status: 'Cases by status', category: 'Cases by category', offense: 'Cases by offense', priority: 'Cases by priority', role: 'Lead vs. assist' };
    const CHART_LABEL = { line: 'Line', area: 'Area', bar: 'Bar', stacked: 'Stacked bar', donut: 'Donut', pie: 'Pie', gauge: 'Gauge' };
    const CHART_SUB = { line: 'Trend over time', area: 'Filled trend', bar: 'Side-by-side bars', stacked: 'Bars stacked per month', donut: 'Share of the total', pie: 'Share of the total', gauge: 'One figure as a % of another' };

    function settingsForm(type, c) {
        switch (type) {
            case 'stat': {
                let h = field('Metric', metricSelect('metric', c.metric, {}));
                h += field('Style', choice('style', [
                    { v: 'split', label: 'Month + total', sub: 'This month beside the Totals period' },
                    { v: 'big', label: 'Single number', sub: 'One figure, large' },
                    { v: 'spark', label: 'Trend', sub: 'This month with a 12-month line' },
                ], c.style));
                if (c.style === 'big') {
                    h += field('Number to show', choice('period', [
                        { v: 'month', label: 'This month' },
                        { v: 'scope', label: 'Totals period', sub: 'Follows the Year / Quarter / All time switch' },
                        { v: 'all', label: 'All time' },
                    ], c.period));
                }
                h += '<div class="vd-help">Metrics without monthly history (for example active missing persons) always show their current total.</div>';
                return h;
            }
            case 'chart': {
                let h = field('Title', '<input class="vd-input" name="title" maxlength="60" placeholder="Automatic">');
                h += field('Show', choice('groupBy', DL().GROUPS.map(g => ({ v: g, label: GROUP_LABEL[g] })), c.groupBy));
                const types = c.groupBy === 'month' ? DL().CHART_TYPES : DL().DIST_TYPES;
                h += field('Chart type', choice('type', types.map(t => ({ v: t, label: CHART_LABEL[t], sub: c.groupBy === 'month' ? CHART_SUB[t] : '' })), c.type));
                if (c.groupBy === 'month') {
                    if (c.type === 'gauge') {
                        h += field('Value', metricSelect('metric0', (c.metrics || [])[0], { monthlyOnly: true, units: true }));
                        h += field('Out of', metricSelect('of', c.of, { monthlyOnly: true, units: true }),
                            'Example: Cases closed out of New cases assigned. Both are totalled over the date range.');
                    } else {
                        const sel = new Set(c.metrics || []);
                        const list = metricChoices({ monthlyOnly: true, units: true });
                        const row = (x) => '<label><input type="checkbox" name="metrics" value="' + esc(x.key) + '"' + (sel.has(x.key) ? ' checked' : '') + '> ' + esc(x.text) + '</label>';
                        const bi = list.filter(x => !x.custom), cu = list.filter(x => x.custom);
                        h += field('Metrics (up to 4)', '<div class="vd-metric-list">' + bi.map(row).join('') +
                            (cu.length ? '<div class="vd-ml-head">Custom metrics</div>' + cu.map(row).join('') : '') + '</div>',
                            'Only metrics with monthly history can be charted by month.');
                    }
                }
                h += field(c.groupBy === 'month' ? 'Date range' : 'Cases assigned in',
                    '<select class="vd-input" name="range">' + DL().RANGES.map(r => '<option value="' + r + '"' + (r === c.range ? ' selected' : '') + '>' + esc(RANGE_LABEL[r]) + '</option>').join('') + '</select>',
                    c.groupBy === 'month' && c.range === 'all' ? 'All time shows up to the last 36 months.' : '');
                return h;
            }
            case 'yoy':
                return field('Metric', metricSelect('metric', c.metric, { monthlyOnly: true, units: true })) +
                    field('Chart type', choice('type', [{ v: 'bar', label: 'Bar' }, { v: 'line', label: 'Line' }], c.type));
            case 'agenda':
                return field('Look ahead', choice('days', [{ v: 7, label: '7 days' }, { v: 14, label: '14 days' }, { v: 30, label: '30 days' }], c.days)) +
                    field('Include', '<div class="vd-checks">' +
                        '<label><input type="checkbox" name="tasks"' + (c.tasks ? ' checked' : '') + '> Tasks</label>' +
                        '<label><input type="checkbox" name="court"' + (c.court ? ' checked' : '') + '> Court dates</label>' +
                        '<label><input type="checkbox" name="warrants"' + (c.warrants ? ' checked' : '') + '> Warrant returns &amp; PRTT expirations</label></div>',
                    'Overdue items always show at the top.');
            case 'recentCases':
                return field('Show', choice('mode', [
                    { v: 'both', label: 'Pinned + recent' }, { v: 'recent', label: 'Recently opened' }, { v: 'pinned', label: 'Pinned only' },
                ], c.mode)) +
                    field('How many recent cases', '<input type="number" class="vd-input" name="count" min="3" max="20" style="max-width:7rem">');
            case 'notes':
                return field('Title', '<input class="vd-input" name="title" maxlength="40">') +
                    field('Color', choice('tint', DL().TINTS.map(t => ({ v: t, label: t.charAt(0).toUpperCase() + t.slice(1) })), c.tint),
                        'Notes are saved on this computer only and are never included in exported layouts.');
            default:
                return '';
        }
    }

    /** Read the form back into cfg (unknown fields are ignored by sanitizeCfg). */
    function readForm(type, root2, c) {
        const val = (n) => { const el = root2.querySelector('[name="' + n + '"]'); return el ? el.value : undefined; };
        const radio = (n) => { const el = root2.querySelector('input[name="' + n + '"]:checked'); return el ? el.value : undefined; };
        const chk = (n) => { const el = root2.querySelector('input[name="' + n + '"]'); return el ? el.checked : undefined; };
        const set = (k, v) => { if (v !== undefined) c[k] = v; };
        switch (type) {
            case 'stat': set('metric', val('metric')); set('style', radio('style')); set('period', radio('period')); break;
            case 'chart': {
                set('title', val('title'));
                set('groupBy', radio('groupBy'));
                set('type', radio('type'));
                set('range', val('range'));
                if (root2.querySelector('[name="metric0"]')) {
                    const m0 = val('metric0');
                    c.metrics = [m0].concat((c.metrics || []).filter(k => k !== m0)).slice(0, 4);
                    set('of', val('of'));
                } else if (root2.querySelector('input[name="metrics"]')) {
                    const picked = Array.from(root2.querySelectorAll('input[name="metrics"]:checked')).map(x => x.value);
                    const prev = (c.metrics || []).filter(k => picked.indexOf(k) >= 0);
                    c.metrics = prev.concat(picked.filter(k => prev.indexOf(k) < 0));
                }
                break;
            }
            case 'yoy': set('metric', val('metric')); set('type', radio('type')); break;
            case 'agenda': set('days', radio('days')); set('tasks', chk('tasks')); set('court', chk('court')); set('warrants', chk('warrants')); break;
            case 'recentCases': set('mode', radio('mode')); { const n = parseInt(val('count'), 10); if (isFinite(n)) c.count = n; } break;
            case 'notes': set('title', val('title')); set('tint', radio('tint')); break;
            default:
        }
        return c;
    }

    function openSettings(uid) {
        const w = findWidget(uid);
        if (!w) return;
        if (w.type === 'quickStats') { try { S.host.openQuickStatsConfig(); } catch (_) { /* ignore */ } return; }
        if (CFG_TYPES.indexOf(w.type) < 0) return;
        const sp = spec(w.type);
        let c = clone(w.cfg);
        const m = openModal({
            title: sp.title + ' settings',
            foot: '<button type="button" class="vd-btn" data-modal="close">Cancel</button><button type="button" class="vd-btn vd-btn-go" data-modal="save">Save</button>',
            onAction(a) {
                if (a !== 'save') return;
                c = readForm(w.type, m.body, c);
                if (w.type === 'chart' && c.groupBy === 'month' && c.type !== 'gauge' && !(c.metrics || []).length) {
                    toast('Pick at least one metric to chart.', 'warning');
                    return;
                }
                if (w.type === 'chart' && c.groupBy === 'month' && c.type !== 'gauge' && c.metrics.length > 4) {
                    toast('A chart can show up to 4 metrics.', 'warning');
                    return;
                }
                const live = findWidget(uid);
                m.close();
                if (!live || !S) return;
                live.cfg = DL().sanitizeCfg(live.type, c);
                if (!S.draft) { saveStore(); syncCardPrefs(); }
                renderWidget(live);
            },
        });
        const paint = () => {
            m.body.innerHTML = settingsForm(w.type, c);
            const t = m.body.querySelector('input[name="title"]');
            if (t) t.value = c.title || '';
            const n = m.body.querySelector('input[name="count"]');
            if (n) n.value = c.count;
        };
        paint();
        // Choices that change which fields exist redraw the form.
        m.body.addEventListener('change', e => {
            const t = e.target;
            if (t.type === 'radio') {
                c = readForm(w.type, m.body, c);
                if (w.type === 'chart') {
                    if (t.name === 'groupBy' && c.groupBy !== 'month' && DL().DIST_TYPES.indexOf(c.type) < 0) c.type = 'bar';
                    if (t.name === 'groupBy' && c.groupBy === 'month' && !c.metrics.length) c.metrics = DL().defaultCfg('chart').metrics;
                    if (t.name === 'groupBy') c.range = c.groupBy === 'month' ? (c.range === 'all' ? '12m' : c.range) : c.range;
                }
                paint();
            } else if (t.name === 'metrics') {
                const n = m.body.querySelectorAll('input[name="metrics"]:checked').length;
                if (n > 4) { t.checked = false; toast('A chart can show up to 4 metrics.', 'info'); }
            } else if (t.name === 'range' && w.type === 'chart') {
                c = readForm(w.type, m.body, c);
                paint();
            }
        });
    }

    // ── delegated widget actions ────────────────────────────────────

    function onGridClick(e) {
        const a = e.target.closest('[data-vd-act]');
        if (!a || !S.gridEl.contains(a)) return;
        const act = a.getAttribute('data-vd-act');
        const id = a.getAttribute('data-id');
        const host = S.host;
        switch (act) {
            case 'settings': e.preventDefault(); openSettings(a.getAttribute('data-uid')); break;
            case 'remove': e.preventDefault(); removeWidget(a.getAttribute('data-uid')); break;
            case 'agenda': {
                if (S.draft) return;
                const kind = a.getAttribute('data-kind');
                const caseId = a.getAttribute('data-case');
                if ((kind === 'task' || kind === 'court') && id) host.openTask(id);
                else if (caseId) host.openCase(caseId);
                else toast('That case is no longer in VIPER.', 'warning');
                break;
            }
            case 'taskdone': e.stopPropagation(); if (!S.draft && id) host.completeTask(id); break;
            case 'open': if (!S.draft && id) host.openCase(id); break;
            case 'pin':
                e.stopPropagation();
                if (id) { DW().togglePin(id); rerender(w => w.type === 'recentCases'); }
                break;
            default:
        }
    }

    function onGridChange(e) {
        const t = e.target;
        if (t.matches && t.matches('select[data-vd-act="pinpick"]')) {
            const v = t.value;
            if (v) { DW().togglePin(v); rerender(w => w.type === 'recentCases'); }
        } else if (t.matches && t.matches('textarea[data-vd-note]')) {
            saveNote(t);
        }
    }

    function saveNote(ta) {
        const uid = ta.getAttribute('data-vd-note');
        clearTimeout(S.noteTimers[uid]);
        delete S.noteTimers[uid];
        if (!DW().notes.set(uid, ta.value)) toast('Could not save the note (storage is full).', 'error');
    }

    function onGridInput(e) {
        const t = e.target;
        if (!t.matches || !t.matches('textarea[data-vd-note]')) return;
        const uid = t.getAttribute('data-vd-note');
        clearTimeout(S.noteTimers[uid]);
        S.noteTimers[uid] = setTimeout(() => { if (S) saveNote(t); }, 500);
    }

    function onGridKey(e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const t = e.target;
        if (!t.matches || !t.matches('[role="button"][data-vd-act]')) return;
        e.preventDefault();
        t.click();
    }

    function onDocKey(e) {
        if (!S) return;
        if (e.key !== 'Escape') return;
        if (S.modal) { e.preventDefault(); S.modal.close(); return; }
        const mn = S.bar && menuEl();
        if (mn && !mn.hidden) { e.preventDefault(); closeMenu(); return; }
        // Leave Esc alone while another VIPER dialog is open.
        if (S.draft && !document.querySelector('.modal.show')) { e.preventDefault(); cancelEdit(); }
    }

    function onDocClick(e) {
        if (!S || !S.bar) return;
        const mn = menuEl();
        if (mn && !mn.hidden && !e.target.closest('.vd-menu-wrap')) closeMenu();
    }

    // ── public hooks ────────────────────────────────────────────────

    function refreshStats() {
        if (!alive()) return;
        rerender(w => w.type === 'stat');
    }

    function onTasksChanged() {
        if (!alive()) return;
        clearTimeout(S.taskTimer);
        S.taskTimer = setTimeout(() => { if (alive()) rerender(w => w.type === 'agenda'); }, 150);
    }

    function onMetricsChanged() {
        if (!alive()) return;
        clearTimeout(S.metricTimer);
        S.metricTimer = setTimeout(() => {
            if (!alive()) return;
            const fp = fingerprint();
            if (fp !== S.fp) {
                S.fp = fp;
                S.ctx.monthCache = {};
                S.sweep.queue = [];
                S.sweep.queued.clear();
                seedCurrentMonth();
                saveMonthCache();
            }
            rerender(w => !spec(w.type).panel && w.type !== 'notes');
        }, 250);
    }

    // ── lifecycle ───────────────────────────────────────────────────

    function themeSig() {
        return (document.body.classList.contains('light-mode') ? 'L' : 'D') + '|' +
            (document.documentElement.getAttribute('data-skin') || '') + '|' + (document.body.getAttribute('data-skin') || '');
    }

    function init(host) {
        if (S) teardown();
        const gridEl = document.getElementById('dashGrid');
        if (!gridEl || !root.GridStack || !DL() || !DD() || !DW() || !host) return false;
        try {
            S = {
                host, gridEl,
                parking: document.getElementById('dashParking'),
                bar: document.getElementById('dashEditBar'),
                switchEl: document.getElementById('dashLayoutSwitch'),
                customizeBtn: document.getElementById('dashCustomizeBtn'),
                emptyHint: null, grid: null, cols: DL().COLS,
                store: null, layout: null, draft: null, modal: null,
                items: new Map(), noteTimers: {},
                sweep: { queue: [], queued: new Set(), waiting: new Set(), timer: null },
                listeners: [],
            };

            let raw = null;
            try { raw = localStorage.getItem(DL().STORE_KEY); } catch (_) { /* none */ }
            const r = DL().ensureStore(raw, { cardPreferences: host.cardPreferences() });
            S.store = r.store;
            S.layout = S.store.layouts[S.store.active];
            if (r.migrated) saveStore();

            S.ctx = {
                host, charts: {}, monthCache: {},
                now: () => new Date(),
                monthsReady: (ms) => !ms || ms.every(mo => !!S.ctx.monthCache[mo.key]),
                requestMonths,
                firstCaseDate,
            };
            S.fp = fingerprint();
            S.ctx.monthCache = loadMonthCache(S.fp);
            seedCurrentMonth();
            saveMonthCache();

            // Remember where each panel lives in the fixed dashboard.
            document.querySelectorAll('#dashLegacy [data-dash-panel]').forEach(p => {
                const prev = p.previousElementSibling;
                if (prev && prev.hasAttribute('data-vd-home')) return;
                const h = document.createElement('span');
                h.hidden = true;
                h.setAttribute('data-vd-home', p.getAttribute('data-dash-panel'));
                p.parentNode.insertBefore(h, p);
            });

            S.emptyHint = document.createElement('div');
            S.emptyHint.className = 'vd-empty-grid glass-card rounded-xl';
            S.emptyHint.style.cssText = 'padding:2.5rem 1rem;text-align:center;font-size:0.9rem';
            S.emptyHint.hidden = true;
            gridEl.parentNode.insertBefore(S.emptyHint, gridEl.nextSibling);

            S.grid = root.GridStack.init({
                column: DL().COLS, cellHeight: ROW_PX, margin: MARGIN, float: false, animate: true,
                staticGrid: true, handle: '.vd-shield',
                resizable: { handles: 'e,se,s,sw,w' },
            }, gridEl);
            S.grid.on('resizestop', (e, el) => {
                const n = el && el.gridstackNode;
                const w = n && findWidget(n.id);
                if (w && !spec(w.type).panel) renderWidget(w); else paintShield(el, w);
            });
            S.grid.on('resize', (e, el) => {
                const n = el && el.gridstackNode;
                if (n) paintShield(el, findWidget(n.id));
            });
            S.grid.on('change', (e, nodes) => {
                (nodes || []).forEach(n => { if (n && n.el) paintShield(n.el, findWidget(n.id)); });
            });

            if (S.bar) buildBar();
            buildGrid();

            const on = (target, ev, fn, opt) => { target.addEventListener(ev, fn, opt); S.listeners.push([target, ev, fn, opt]); };
            on(gridEl, 'click', onGridClick);
            on(gridEl, 'change', onGridChange);
            on(gridEl, 'input', onGridInput);
            on(gridEl, 'keydown', onGridKey);
            on(document, 'keydown', onDocKey, true);
            on(document, 'click', onDocClick, true);
            on(window, 'beforeunload', () => flushNotes());
            on(window, 'resize', () => {
                clearTimeout(S.resizeTimer);
                S.resizeTimer = setTimeout(() => {
                    if (!alive() || S.draft) return;
                    if (wantCols() !== S.cols) buildGrid();
                }, 200);
            });
            if (S.switchEl) on(S.switchEl, 'change', () => switchLayout(S.switchEl.value));

            S.themeSig = themeSig();
            S.obs = new MutationObserver(() => {
                const sig = themeSig();
                if (sig === S.themeSig) return;
                S.themeSig = sig;
                clearTimeout(S.themeTimer);
                S.themeTimer = setTimeout(() => { if (alive()) rerender(w => !spec(w.type).panel && w.type !== 'notes'); }, 120);
            });
            S.obs.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-skin'] });
            S.obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-skin'] });

            if (S.customizeBtn) { S.customizeBtn.classList.remove('hidden'); S.customizeBtn.setAttribute('aria-pressed', 'false'); }
            syncCardPrefs();
            return true;
        } catch (e) {
            console.error('Dashboard grid failed to start; showing the fixed dashboard.', e);
            teardown();
            return false;
        }
    }

    function teardown() {
        if (!S) return;
        const s = S;
        try { flushNotes(); } catch (_) { /* ignore */ }
        [s.taskTimer, s.metricTimer, s.themeTimer, s.resizeTimer, s.sweep.timer].forEach(t => clearTimeout(t));
        try { if (s.obs) s.obs.disconnect(); } catch (_) { /* ignore */ }
        s.listeners.forEach(([t, ev, fn, opt]) => t.removeEventListener(ev, fn, opt));
        try { if (s.ctx) Object.keys(s.ctx.charts).forEach(uid => DW().destroyCharts(s.ctx, uid)); } catch (_) { /* ignore */ }
        try { if (s.modal) s.modal.close(); } catch (_) { /* ignore */ }
        if (s.gridEl.isConnected) {
            try { restorePanels(); } catch (_) { /* ignore */ }
            try { if (s.grid) s.grid.destroy(false); } catch (_) { /* ignore */ }
            s.gridEl.textContent = '';
            if (s.emptyHint) s.emptyHint.remove();
            if (s.bar) { s.bar.hidden = true; s.bar.textContent = ''; }
            if (s.switchEl) s.switchEl.hidden = true;
            if (s.customizeBtn) s.customizeBtn.classList.add('hidden');
        }
        S = null;
    }

    root.ViperDashboard = {
        init, edit, refreshStats, onTasksChanged, onMetricsChanged, teardown,
        isEditing: () => !!(S && S.draft),
        _state: () => S, // tests / harness only
    };
})(typeof self !== 'undefined' ? self : this);

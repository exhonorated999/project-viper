/* ============================================================
   Series Analysis — tab UI  (VIPER)

   A crime analyst works MANY incidents under ONE case: a run of
   catalytic-converter thefts, a set of robberies, deaths pulled
   from several VIPER cases. This tab holds those incidents and
   shows them back as a numbered map, a day x hour grid, a matrix
   of shared attributes (vehicle, MO, cause of death …), a footage
   review desk, and a one-page bulletin.

   Contract with the host page (case-detail-with-analytics.html):
     renderSeriesAnalysisTab()   -> HTML string
     initializeSeriesAnalysis()  -> wires the DOM after innerHTML
     teardownSeriesAnalysis()    -> releases Leaflet / <video>

   Storage: localStorage['seriesAnalysis_<caseId>'] (registered in
   modules/_shared/case-stores.js, so it travels in a .vcase export).
   All maths lives in sa-model.js (SeriesAnalysisModel). The
   "likely next" output is a descriptive projection from observed
   hits and is always labelled that way.
   ============================================================ */
(function () {
    'use strict';
    if (typeof window === 'undefined') return;

    function M() { return window.SeriesAnalysisModel; }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function toast(m, k) { try { (window.viperToast || window.showToast || function () {})(m, k || 'info'); } catch (_) {} }
    function confirmBox(msg, opts) {
        if (typeof window.viperConfirm === 'function') return Promise.resolve(window.viperConfirm(msg, opts || {}));
        return Promise.resolve(window.confirm(msg));
    }

    // currentCase is a top-level `let` in the host page: reachable as a bare
    // identifier, NOT as window.currentCase. (See flock-module.js.)
    function theCase() {
        try { if (typeof currentCase !== 'undefined' && currentCase) return currentCase; } catch (_) {}
        try { if (window.currentCase) return window.currentCase; } catch (_) {}
        return null;
    }
    function lsParse(key, fallback) {
        try { if (typeof window._lsParse === 'function') return window._lsParse(key, fallback); } catch (_) {}
        try { var v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; } catch (_) { return fallback; }
    }
    function storeKey() { var c = theCase(); return c ? ('seriesAnalysis_' + c.id) : null; }
    function today() {
        var d = new Date();
        return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
    }

    // ── state ────────────────────────────────────────────────────────
    var SA = {
        view: null,          // incidents | overview | compare | footage | bulletin
        caseId: null,
        data: null,          // normalised store
        filter: null,        // { col, value, display, label }
        map: null, layer: null, markers: {}, fitted: false,
        layers: { points: true, heat: true, seq: true, ellipse: true, likely: true },
        focusId: null,
        showAllRows: false,
        csv: null,           // { rows, headers, mapping }
        geo: { busy: false, cancel: false, failed: {}, done: 0, total: 0 },
        menuOpen: false
    };

    var VIEWS = [
        ['incidents', 'Incidents'],
        ['overview', 'Map & Time'],
        ['compare', 'Compare'],
        ['footage', 'Footage'],
        ['bulletin', 'Bulletin']
    ];
    var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var GROUP_FALLBACK = { vehicle: '#00d9ff', person: '#a855f7', mo: '#c084fc', target: '#22c55e', place: '#ffa726', other: '#94a3b8' };

    // ── persistence ──────────────────────────────────────────────────
    function load() {
        var c = theCase();
        var k = storeKey();
        if (c && SA.caseId !== c.id) {
            // A different case: drop every piece of per-case UI state.
            SA.caseId = c.id; SA.view = null; SA.filter = null; SA.focusId = null;
            SA.showAllRows = false; SA.fitted = false; SA.geo.failed = {};
        }
        SA.data = M().normalizeStore(k ? lsParse(k, null) : null);
        return SA.data;
    }
    function save(opts) {
        var k = storeKey();
        if (!k || !SA.data) return false;
        try {
            localStorage.setItem(k, JSON.stringify(SA.data));
        } catch (e) {
            console.error('[SeriesAnalysis] save failed', e);
            toast('Could not save Series Analysis — browser storage is full. Remove footage frame grabs or old data and retry.', 'error');
            return false;
        }
        // First real data: make sure the tab stays on the case (merge-safe host helper).
        try { if (typeof ensureCaseModule === 'function') ensureCaseModule('seriesAnalysis'); } catch (_) {}
        if (!(opts && opts.quiet)) {
            try { if (typeof window.audit === 'function') window.audit('series_analysis_saved', { case_id: SA.caseId, incidents: SA.data.incidents.length }); } catch (_) {}
        }
        return true;
    }

    // ── data helpers ─────────────────────────────────────────────────
    function all() { return (SA.data && SA.data.incidents) || []; }
    function cols() { return (SA.data && SA.data.columns) || []; }
    function visible() {
        var list = all();
        if (SA.filter) list = M().filterByValue(list, SA.filter.col, SA.filter.value);
        return list;
    }
    function byId(id) {
        var l = all();
        for (var i = 0; i < l.length; i++) if (String(l[i].id) === String(id)) return l[i];
        return null;
    }
    function seq() { return M().seqMap(all()); }
    function seqColor(n) {
        var N = Math.max(1, all().length);
        var t = N > 1 ? Math.min(1, Math.max(0, (n - 1) / (N - 1))) : 0;
        var r = Math.round(t * 255), g = Math.round(217 - t * 50), b = Math.round(255 - t * 217);
        return 'rgb(' + r + ',' + g + ',' + b + ')';
    }
    function groupColor(g) {
        var G = (M() && M().GROUPS) || GROUP_FALLBACK;
        return G[g] || G.other || '#94a3b8';
    }
    function hexA(hex, a) {
        var h = String(hex || '#94a3b8').replace('#', '');
        if (h.length === 3) h = h.replace(/(.)/g, '$1$1');
        var n = parseInt(h, 16);
        return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
    }
    function colByKey(k) {
        var c = cols();
        for (var i = 0; i < c.length; i++) if (c[i].key === k) return c[i];
        return null;
    }
    function fmtDate(d) {
        if (!d) return '—';
        var p = d.split('-');
        var dt = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
        return DOW[dt.getUTCDay()] + ' ' + (+p[1]) + '/' + (+p[2]);
    }
    function fmtDateLong(d) {
        if (!d) return '';
        var p = d.split('-');
        return (+p[1]) + '/' + (+p[2]) + '/' + p[0];
    }
    function timeText(inc) {
        if (!inc.timeFrom) return '';
        return inc.timeTo ? (inc.timeFrom + '–' + inc.timeTo) : inc.timeFrom;
    }
    function timeHtml(inc) {
        if (!inc.timeFrom) return '<span class="text-gray-600">unknown</span>';
        if (!inc.timeTo) return '<span class="text-white font-semibold">' + esc(inc.timeFrom) + '</span>';
        return '<span class="text-gray-400">' + esc(inc.timeFrom) + '–' + esc(inc.timeTo) + '</span> <span class="text-[10px] text-gray-500">window</span>';
    }
    function md(s) {
        return esc(s).replace(/\*\*(.+?)\*\*/g, '<b class="text-white">$1</b>');
    }
    function hasGeo(inc) { return inc && typeof inc.lat === 'number' && typeof inc.lng === 'number'; }
    function missingGeo() { return all().filter(function (i) { return !hasGeo(i) && i.address; }); }

    // ── shell ────────────────────────────────────────────────────────
    function renderSeriesAnalysisTab() {
        if (!M()) return '<div class="p-8 text-center text-gray-400">Series Analysis failed to load (model missing). Restart VIPER.</div>';
        if (!theCase()) return '<div class="p-8 text-center text-gray-400">No case is open.</div>';
        load();
        if (!SA.view) SA.view = all().length ? 'overview' : 'incidents';
        var body = all().length ? (renderHeader() + '<div id="saFilterBar"></div><div id="saBody"></div>') : renderEmpty();
        return '<div id="saRoot" class="sa-root space-y-3">' + body + '</div>' +
            '<input type="file" id="saFileInput" accept=".csv,.tsv,.txt" style="display:none">';
    }

    function renderEmpty() {
        var tpls = M().TEMPLATES, opts = '';
        Object.keys(tpls).forEach(function (k) {
            opts += '<option value="' + esc(k) + '"' + (SA.data.template === k ? ' selected' : '') + '>' + esc(tpls[k].label) + '</option>';
        });
        return '' +
        '<div class="max-w-3xl mx-auto py-8">' +
            '<div class="text-center mb-7">' +
                '<div class="inline-flex items-center justify-center w-14 h-14 rounded-2xl mb-3" style="background:rgba(0,217,255,.12);border:1px solid rgba(0,217,255,.4)">' +
                    '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#00d9ff" stroke-width="2"><circle cx="6" cy="17" r="2"/><circle cx="12" cy="9" r="2"/><circle cx="18" cy="13" r="2"/><path d="M7.5 15.5l3-5M13.6 10.2l2.8 1.8"/></svg>' +
                '</div>' +
                '<h2 class="text-2xl font-bold text-white mb-2">Series Analysis</h2>' +
                '<p class="text-gray-400 text-sm max-w-xl mx-auto">Work a run of incidents under this one case. Add each incident once, then read the pattern back: ' +
                'a numbered map, when they happen, what they share (vehicle, MO, cause of death), footage review and a bulletin for patrol.</p>' +
            '</div>' +
            '<div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">' +
                '<input class="sa-input md:col-span-2" data-sa-field="title" placeholder="Name this series, e.g. Oak Hollow catalytic converter thefts" value="' + esc(SA.data.title) + '">' +
                '<div class="md:col-span-2 flex items-center gap-2"><span class="text-xs text-gray-400 whitespace-nowrap">What are you comparing?</span>' +
                    '<select class="sa-select" data-sa-field="template">' + opts + '</select></div>' +
            '</div>' +
            '<div class="grid grid-cols-1 md:grid-cols-3 gap-3">' +
                '<button class="sa-empty-card" data-sa="add"><div class="text-viper-cyan font-semibold mb-1">＋ Add an incident</div><div class="text-xs text-gray-400">Type one in: date, time or time window, address, and what was seen.</div></button>' +
                '<button class="sa-empty-card" data-sa="csv"><div class="text-viper-cyan font-semibold mb-1">⇣ Paste or load a CSV</div><div class="text-xs text-gray-400">An RMS / CAD export or a spreadsheet. Columns are matched for you.</div></button>' +
                '<button class="sa-empty-card" data-sa="from-cases"><div class="text-viper-cyan font-semibold mb-1">⧉ From other VIPER cases</div><div class="text-xs text-gray-400">Pull several cases in as incidents to look for small connections.</div></button>' +
            '</div>' +
            '<div class="text-center mt-5"><button class="text-xs text-gray-500 hover:text-viper-cyan" data-sa="csv-template">Download a blank CSV template</button></div>' +
        '</div>';
    }

    function renderHeader() {
        var pills = VIEWS.map(function (v) {
            return '<button class="sa-pill' + (SA.view === v[0] ? ' on' : '') + '" data-sa="view" data-v="' + v[0] + '">' + v[1] + '</button>';
        }).join('');
        var miss = missingGeo().length;
        var geoBtn = SA.geo.busy
            ? '<button class="sa-btn sa-btn-red" data-sa="geocode-stop" id="saGeoBtn">Stop locating (' + SA.geo.done + '/' + SA.geo.total + ')</button>'
            : (miss ? '<button class="sa-btn" data-sa="geocode" id="saGeoBtn" title="Look up map positions for addresses that have none">⌖ Locate ' + miss + '</button>' : '');
        return '' +
        '<div class="flex flex-wrap items-center gap-x-4 gap-y-2">' +
            '<input class="sa-title" data-sa-field="title" placeholder="Name this series…" value="' + esc(SA.data.title) + '">' +
            '<div class="flex items-center gap-1">' + pills + '</div>' +
            '<div class="flex-1"></div>' +
            '<div class="flex items-center gap-2 flex-wrap">' +
                '<button class="sa-btn sa-btn-cyan" data-sa="add">＋ Incident</button>' +
                '<div class="relative">' +
                    '<button class="sa-btn" data-sa="import-menu">⇣ Import ▾</button>' +
                    '<div class="sa-menu" id="saImportMenu" style="display:none">' +
                        '<button data-sa="csv">Paste or load CSV<small>RMS / CAD export, spreadsheet</small></button>' +
                        '<button data-sa="from-cases">From other VIPER cases<small>Each case becomes one incident</small></button>' +
                        '<button data-sa="csv-template">Download CSV template<small>Headers for the current columns</small></button>' +
                    '</div>' +
                '</div>' +
                geoBtn +
                '<button class="sa-btn sa-btn-purple" data-sa="board" title="Put the incidents (and the likely-next area) on the Connection Board">⛓ Send to Board</button>' +
                '<button class="sa-btn sa-btn-orange" data-sa="view" data-v="bulletin">🗎 Bulletin</button>' +
            '</div>' +
        '</div>';
    }

    function renderFilterBar() {
        var el = document.getElementById('saFilterBar');
        if (!el) return;
        if (!SA.filter) { el.innerHTML = ''; return; }
        var n = visible().length;
        el.innerHTML = '<div class="flex items-center gap-2 text-xs rounded-lg px-3 py-2" style="background:rgba(0,217,255,.07);border:1px solid rgba(0,217,255,.3)">' +
            '<span class="text-gray-300">Showing <b class="text-white">' + n + ' of ' + all().length + '</b> incidents where <span class="text-gray-400">' + esc(SA.filter.label) + '</span> is <b class="text-viper-cyan">' + esc(SA.filter.display) + '</b></span>' +
            '<button class="sa-btn" style="padding:2px 9px" data-sa="clear-filter">✕ Clear</button></div>';
    }

    function renderBody() {
        var el = document.getElementById('saBody');
        if (!el) return;
        destroyMap();
        try { if (window.SeriesAnalysisFootage) window.SeriesAnalysisFootage.teardown(); } catch (_) {}
        renderFilterBar();
        var html;
        switch (SA.view) {
            case 'incidents': html = renderIncidentsView(); break;
            case 'compare': html = renderCompareView(); break;
            case 'footage': html = renderFootageView(); break;
            case 'bulletin': html = renderBulletinView(); break;
            default: SA.view = 'overview'; html = renderOverviewView();
        }
        el.innerHTML = html;
        if (SA.view === 'overview') {
            setTimeout(function () { if (document.getElementById('saMap')) initMap(); }, 60);
        } else if (SA.view === 'footage') {
            try { if (window.SeriesAnalysisFootage) window.SeriesAnalysisFootage.init(ctx()); } catch (e) { console.error('[SeriesAnalysis] footage init', e); }
        } else if (SA.view === 'bulletin') {
            try { if (window.SeriesAnalysisBulletin) window.SeriesAnalysisBulletin.init(ctx()); } catch (e) { console.error('[SeriesAnalysis] bulletin init', e); }
        }
    }

    /** Full re-render of the tab (header counts, empty <-> data). */
    function rerender() {
        if (typeof window.renderTabContent === 'function') { window.renderTabContent('seriesAnalysis'); return; }
        var host = document.getElementById('saRoot');
        if (host && host.parentNode) { host.parentNode.innerHTML = renderSeriesAnalysisTab(); initializeSeriesAnalysis(); }
    }

    /**
     * Write bytes to the case's evidence folder and add an Evidence record
     * (same shape and save path as the Evidence tab's own upload).
     * opts: { fileName, bytes:Uint8Array, mime, description, tag, source }
     * Resolves to the record, or throws with a readable message.
     */
    async function saveToEvidence(opts) {
        var c = theCase();
        if (!c) throw new Error('No case is open.');
        if (!window.electronAPI || typeof window.electronAPI.saveEvidenceFile !== 'function') throw new Error('Saving to Evidence needs the VIPER desktop app.');
        var tag = opts.tag || ('SA-' + Date.now().toString(36).toUpperCase());
        var savedPath = await window.electronAPI.saveEvidenceFile({
            caseNumber: c.caseNumber, evidenceTag: tag, fileName: opts.fileName, fileData: Array.from(opts.bytes)
        });
        if (!savedPath) throw new Error('The file could not be written to the evidence folder.');
        var ev;
        try { ev = caseEvidence; } catch (_) { ev = null; } // host top-level `let`
        if (!Array.isArray(ev)) throw new Error('Evidence list is not loaded. Open the Evidence tab once and retry.');
        var rec = {
            id: Date.now(), type: opts.type || 'document', tag: tag, discoverable: true,
            description: opts.description || opts.fileName, location: '',
            fileCount: 1, totalSize: opts.bytes.length,
            files: [{ name: opts.fileName, path: savedPath, size: opts.bytes.length, type: opts.mime || 'application/octet-stream', lastModified: Date.now() }],
            source: opts.source || 'series_analysis', createdAt: new Date().toISOString()
        };
        ev.push(rec);
        try {
            var allEv = lsParse('viperCaseEvidence', {}) || {};
            try { if (typeof _provStampEdits === 'function') _provStampEdits('viperCaseEvidence', ev); } catch (_) {}
            allEv[c.caseNumber] = ev;
            localStorage.setItem('viperCaseEvidence', JSON.stringify(allEv));
        } catch (e) {
            ev.pop();
            throw new Error('Saved the file, but the Evidence list could not be updated (storage full?).');
        }
        try { if (typeof window.audit === 'function') window.audit('evidence_added', { case_number: c.caseNumber, case_id: c.id, evidence_id: rec.id, type: rec.type, tag: tag, file_count: 1, source: rec.source }); } catch (_) {}
        return rec;
    }

    /** The open case's Evidence records (host top-level `let caseEvidence`). */
    function evidenceList() {
        try { if (typeof caseEvidence !== 'undefined' && Array.isArray(caseEvidence)) return caseEvidence; } catch (_) {}
        var c = theCase();
        if (!c) return [];
        var allEv = lsParse('viperCaseEvidence', {}) || {};
        return Array.isArray(allEv[c.caseNumber]) ? allEv[c.caseNumber] : [];
    }

    /** Shared context handed to the bulletin and footage sub-modules. */
    function ctx() {
        return {
            model: M(), data: SA.data, caseObj: theCase(),
            all: all(), visible: visible(), columns: cols(), seq: seq(), seqColor: seqColor,
            filter: SA.filter, save: save, rerender: rerender, renderBody: renderBody,
            esc: esc, toast: toast, fmtDate: fmtDate, fmtDateLong: fmtDateLong, timeText: timeText,
            today: today, byId: byId, groupColor: groupColor, openModal: openModal, closeModal: closeModal,
            editIncident: openIncidentModal, saveToEvidence: saveToEvidence, confirm: confirmBox, lsParse: lsParse,
            evidence: evidenceList, modalHead: modalHead
        };
    }

    // ── Map & Time ───────────────────────────────────────────────────
    function renderOverviewView() {
        var toggles = [['points', '● Points'], ['heat', '◉ Heat'], ['seq', '↝ Sequence'], ['ellipse', '⬭ 1σ spread'], ['likely', '⬭ Likely area']]
            .map(function (t) { return '<span class="sa-toggle' + (SA.layers[t[0]] ? ' on' : '') + '" data-sa="layer" data-layer="' + t[0] + '">' + t[1] + '</span>'; }).join(' ');
        return '' +
        '<div id="saKpis">' + renderKpis() + '</div>' +
        '<div class="grid grid-cols-1 xl:grid-cols-12 gap-3 mt-3">' +
            '<div class="xl:col-span-7 sa-card">' +
                '<div class="flex items-center justify-between mb-2 flex-wrap gap-2">' +
                    '<div class="sa-card-h">Map <small>· numbered in order of occurrence</small></div>' +
                    '<div class="flex gap-1 flex-wrap">' + toggles + '</div>' +
                '</div>' +
                '<div id="saMap" class="sa-map"></div>' +
                '<div id="saMapFoot" class="mt-2 text-[11px] text-gray-500"></div>' +
            '</div>' +
            '<div class="xl:col-span-5 flex flex-col gap-3">' +
                '<div class="sa-card"><div class="flex items-center justify-between mb-2"><div class="sa-card-h">Day × hour</div>' +
                    '<div class="text-[10.5px] text-gray-500">Time windows are spread across their hours</div></div>' +
                    '<div id="saGrid">' + renderGrid(visible()) + '</div></div>' +
                '<div class="sa-card"><div class="sa-card-h mb-2">Pattern summary <small>· based on observed hits, not a forecast model</small></div>' +
                    '<ul class="sa-summary">' + renderSummaryItems(visible()) + '</ul></div>' +
            '</div>' +
        '</div>' +
        '<div class="sa-card mt-3" style="padding:6px">' + renderIncidentTable(visible(), { compact: true }) + '</div>';
    }

    function renderKpis() {
        var list = visible();
        var k = M().kpis(list, cols()) || {};
        var gap = (k.avgGap != null && isFinite(k.avgGap)) ? (Math.round(k.avgGap * 10) / 10) : null;
        var nx = k.next;
        var nextHtml = nx && nx.window
            ? '<div class="sa-kpi-v">' + esc(nx.window.label) + '</div><div class="text-[11px] text-gray-400 -mt-0.5">' + esc(nx.window.hoursLabel || '') +
              ' · <span title="' + esc((nx.reasons || []).join('\n')) + '">' + esc(nx.confidence || 'low') + ' confidence</span></div>'
            : '<div class="sa-kpi-v" style="color:#9ca3af;font-size:13px">Needs 4+ dated incidents</div>';
        return '<div class="sa-kpis">' +
            '<div class="sa-kpi"><div class="sa-kpi-l">Incidents</div><div class="sa-kpi-v">' + (k.count || 0) +
                (k.spanDays != null ? ' <small>in ' + (k.spanDays + 1) + ' day' + (k.spanDays ? 's' : '') + '</small>' : '') + '</div></div>' +
            '<div class="sa-kpi"><div class="sa-kpi-l">Avg gap</div><div class="sa-kpi-v">' + (gap != null ? gap + ' <small>days' + (k.trend ? ' · ' + esc(k.trend) : '') + '</small>' : '<small>—</small>') + '</div></div>' +
            '<div class="sa-kpi"><div class="sa-kpi-l">Peak window</div><div class="sa-kpi-v sa-kpi-accent">' + (k.peak ? esc(k.peak.label) + ' <small>' + esc(k.peak.daysLabel || '') + '</small>' : '<small>—</small>') + '</div></div>' +
            '<div class="sa-kpi"><div class="sa-kpi-l">' + esc(k.top ? ((colByKey(k.top.column) || {}).label || 'Top value') : 'Top shared value') + '</div><div class="sa-kpi-v" title="' + esc(k.top ? k.top.display : '') + '">' +
                (k.top ? esc(k.top.display) + ' <small>' + k.top.count + ' of ' + (k.count || 0) + '</small>' : '<small>none shared yet</small>') + '</div></div>' +
            '<div class="sa-kpi sa-kpi-next"><div class="sa-kpi-l">Next likely window <span class="normal-case tracking-normal text-gray-500">(observed)</span></div>' + nextHtml + '</div>' +
        '</div>';
    }

    function inBand(h, start, end) {
        var w = ((end - start) + 24) % 24 || 24;
        return ((h - start) + 24) % 24 < w;
    }

    function renderGrid(list, opts) {
        var g = M().hourWeights(list);
        var max = 0;
        g.forEach(function (row) { row.forEach(function (v) { if (v > max) max = v; }); });
        var pk = M().peakWindow(g);
        var order = [1, 2, 3, 4, 5, 6, 0];
        var s = '<div class="sa-grid"><div></div>';
        for (var h = 0; h < 24; h++) s += '<div class="sa-grid-h">' + (h % 3 === 0 ? ('0' + h).slice(-2) : '') + '</div>';
        order.forEach(function (d) {
            s += '<div class="sa-grid-d">' + DOW[d] + '</div>';
            for (var hh = 0; hh < 24; hh++) {
                var v = max ? g[d][hh] / max : 0;
                // Intensity goes out as --a so skins can recolour the ramp (see sa.css .sa-cell.hot).
                var cellCls = v === 0 ? '' : ' hot';
                var cellStyle = v === 0 ? '' : ' style="--a:' + (0.10 + v * 0.85).toFixed(3) + '"';
                var peak = pk && pk.days && pk.days.indexOf(d) >= 0 && inBand(hh, pk.startHour, pk.endHour);
                var w = Math.round(g[d][hh] * 100) / 100;
                s += '<div class="sa-cell' + cellCls + (peak ? ' peak' : '') + '"' + cellStyle + ' title="' + DOW[d] + ' ' + ('0' + hh).slice(-2) + ':00 · ' + w + ' hit' + (w === 1 ? '' : 's') + '"></div>';
            }
        });
        s += '</div>';
        if (!(opts && opts.bare)) {
            s += '<div class="flex items-center gap-2 mt-2 text-[10.5px] text-gray-500"><span>less</span>' +
                '<span class="inline-block w-16 h-2 rounded sa-ramp"></span><span>more</span>' +
                (pk ? '<span class="ml-3 inline-block w-3 h-3" style="outline:1.5px solid #ffa726"></span><span>peak window · ' + Math.round((pk.share || 0) * 100) + '% of weight</span>' : '') +
                '</div>';
        }
        return s;
    }

    function renderSummaryItems(list) {
        if (!list.length) return '<li class="text-gray-500">No incidents.</li>';
        var items = M().summary(list, cols(), { now: today() }) || [];
        if (!items.length) return '<li class="text-gray-500">Add more incidents to see a pattern.</li>';
        return items.map(function (s) { return '<li>' + md(s) + '</li>'; }).join('');
    }

    function renderIncidentTable(list, opts) {
        var compact = !!(opts && opts.compact);
        var sq = seq();
        var rows = M().chrono(list);
        var showCols = cols();
        if (compact) rows = rows.slice().reverse();
        var total = rows.length;
        var limit = compact && !SA.showAllRows ? 8 : rows.length;
        var head = '<tr><th>#</th><th>Date</th><th>Time</th><th>Location</th>' +
            showCols.map(function (c) { return '<th>' + esc(c.label) + '</th>'; }).join('') +
            '<th>Report</th><th></th></tr>';
        var body = rows.slice(0, limit).map(function (inc) {
            var n = sq[inc.id] || '';
            var geo = hasGeo(inc) ? '' : (inc.address ? ' <span class="text-[10px] text-red-300" title="' + esc(SA.geo.failed[inc.id] || 'No map position yet') + '">⌖?</span>' : '');
            var cells = showCols.map(function (c) {
                var v = (inc.attrs || {})[c.key] || '';
                return '<td class="sa-trunc" title="' + esc(v) + '">' + (v ? esc(v) : '<span class="text-gray-600">—</span>') + '</td>';
            }).join('');
            return '<tr data-sa="focus" data-id="' + esc(inc.id) + '" class="cursor-pointer' + (SA.focusId === inc.id ? ' sa-row-focus' : '') + '">' +
                '<td><span class="sa-num" style="background:' + seqColor(n) + '">' + n + '</span></td>' +
                '<td class="whitespace-nowrap text-gray-200">' + esc(fmtDate(inc.date)) + '</td>' +
                '<td class="whitespace-nowrap">' + timeHtml(inc) + '</td>' +
                '<td class="sa-trunc text-gray-200" title="' + esc(inc.address) + '">' + (esc(inc.address) || '<span class="text-gray-600">—</span>') + geo + '</td>' +
                cells +
                '<td class="whitespace-nowrap font-mono text-[11.5px] text-gray-500">' + esc(inc.reportNo || '') + '</td>' +
                '<td class="whitespace-nowrap text-right">' +
                    '<button class="text-gray-400 hover:text-viper-cyan px-1" data-sa="edit" data-id="' + esc(inc.id) + '" title="Edit">✎</button>' +
                    (compact ? '' : '<button class="text-gray-500 hover:text-red-300 px-1" data-sa="del" data-id="' + esc(inc.id) + '" title="Delete">🗑</button>') +
                '</td></tr>';
        }).join('');
        var more = '';
        if (compact && total > 8) {
            more = '<tr><td colspan="' + (6 + showCols.length) + '" class="text-center"><button class="text-[11.5px] text-viper-cyan/80 hover:text-viper-cyan py-1" data-sa="toggle-rows">' +
                (SA.showAllRows ? 'Show latest 8 ▴' : 'Show all ' + total + ' incidents ▾') + '</button></td></tr>';
        }
        if (!total) body = '<tr><td colspan="' + (6 + showCols.length) + '" class="text-center text-gray-500 py-4">No incidents match.</td></tr>';
        return '<div class="overflow-x-auto"><table class="sa-table"><thead>' + head + '</thead><tbody>' + body + more + '</tbody></table></div>';
    }

    // Leaflet
    function initMap() {
        var el = document.getElementById('saMap');
        if (!el || typeof L === 'undefined') return;
        destroyMap();
        SA.map = L.map(el, { zoomControl: true }).setView([39.8283, -98.5795], 4);
        var B = window.VIPER_BASEMAP;
        L.tileLayer((B && B.dark) || 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            attribution: (B && B.attribution) || '&copy; OpenStreetMap &copy; CARTO', maxZoom: 19, subdomains: 'abcd'
        }).addTo(SA.map);
        SA.layer = L.layerGroup().addTo(SA.map);
        SA.fitted = false;
        drawMap();
    }
    function destroyMap() {
        if (SA.map) { try { SA.map.remove(); } catch (_) {} }
        SA.map = null; SA.layer = null; SA.markers = {};
    }

    function drawMap() {
        if (!SA.map || !SA.layer) return;
        SA.layer.clearLayers();
        SA.markers = {};
        var list = visible();
        var sq = seq();
        var geo = M().chrono(list).filter(hasGeo);
        var bounds = [];
        var foot = document.getElementById('saMapFoot');
        var old = document.getElementById('saMapEmpty');
        if (old) old.parentNode.removeChild(old);

        if (SA.layers.heat) {
            geo.forEach(function (i) {
                L.circle([i.lat, i.lng], { radius: 230, stroke: false, fillColor: '#ef4444', fillOpacity: 0.16, interactive: false }).addTo(SA.layer);
                L.circle([i.lat, i.lng], { radius: 110, stroke: false, fillColor: '#f97316', fillOpacity: 0.16, interactive: false }).addTo(SA.layer);
            });
        }
        var sp = geo.length >= 3 ? M().spatial(list) : null;
        if (SA.layers.ellipse && sp && sp.ellipse) {
            L.polygon(M().ellipsePolygon(sp.ellipse), { color: '#67e8f9', weight: 1.5, opacity: 0.75, dashArray: '3 5', fill: false })
                .bindTooltip('1σ spread: roughly two-thirds of located hits fall inside', { sticky: true }).addTo(SA.layer);
        }
        if (SA.layers.seq && geo.length >= 2) {
            L.polyline(geo.map(function (i) { return [i.lat, i.lng]; }), { color: '#94a3b8', weight: 1.5, opacity: 0.7, dashArray: '5 5', interactive: false }).addTo(SA.layer);
        }
        var nx = M().likelyNext(list, { now: today() });
        if (SA.layers.likely && nx && nx.area && nx.area.center) {
            var c = nx.area.center;
            L.circle([c.lat, c.lng], { radius: nx.area.radius_m, color: '#ffa726', weight: 2, dashArray: '7 5', fillColor: '#ffa726', fillOpacity: 0.1 })
                .bindTooltip('<b>Likely next area</b><br>' + esc(nx.window ? nx.window.label + ' · ' + (nx.window.hoursLabel || '') : '') +
                    '<br><span style="color:#9ca3af">Based on observed hits · ' + esc(nx.confidence) + ' confidence</span>', { sticky: true })
                .addTo(SA.layer);
            bounds.push([c.lat, c.lng]);
        }
        if (SA.layers.points) {
            geo.forEach(function (i) {
                var n = sq[i.id] || '';
                var icon = L.divIcon({
                    className: '', iconSize: [22, 22], iconAnchor: [11, 11],
                    html: '<div class="sa-pin' + (SA.focusId === i.id ? ' sa-pin-focus' : '') + '" style="background:' + seqColor(n) + '">' + n + '</div>'
                });
                var mk = L.marker([i.lat, i.lng], { icon: icon, zIndexOffset: n }).bindPopup(popupHtml(i, n), { maxWidth: 300 }).addTo(SA.layer);
                SA.markers[i.id] = mk;
            });
        }
        geo.forEach(function (i) { bounds.push([i.lat, i.lng]); });

        if (!geo.length) {
            var miss = missingGeo().length;
            var div = document.createElement('div');
            div.id = 'saMapEmpty'; div.className = 'sa-map-empty';
            div.innerHTML = '<div><div class="mb-2">No incident has a map position yet.</div>' +
                (miss ? '<button class="sa-btn sa-btn-cyan" data-sa="geocode">⌖ Locate ' + miss + ' address' + (miss === 1 ? '' : 'es') + '</button>' : '<div class="text-xs text-gray-500">Add an address or latitude/longitude to an incident.</div>') + '</div>';
            document.getElementById('saMap').appendChild(div);
        } else if (!SA.fitted) {
            try { SA.map.fitBounds(L.latLngBounds(bounds).pad(0.15), { maxZoom: 16 }); } catch (_) {}
            SA.fitted = true;
        }

        if (foot) {
            var bits = [];
            var unloc = list.length - geo.length;
            if (unloc) bits.push('<span class="text-red-300/80">' + unloc + ' not on the map (no position)</span>');
            if (sp && sp.drift && sp.drift.milesPerWeek >= 0.05) bits.push('Drift ≈ <span class="text-gray-300">' + (Math.round(sp.drift.milesPerWeek * 10) / 10) + ' mi ' + esc(sp.drift.compass) + ' / week</span>');
            if (sp) bits.push('Typical distance from centre <span class="text-gray-300">' + Math.round(sp.meanDist_m) + ' m</span>');
            if (nx && nx.area) bits.push('<span class="text-viper-orange/80">Likely area: radius ' + Math.round(nx.area.radius_m) + ' m, from the last ' + Math.min(4, geo.length) + ' located hits</span>');
            foot.innerHTML = bits.join(' &nbsp;·&nbsp; ');
        }
    }

    function popupHtml(inc, n) {
        var rows = cols().map(function (c) {
            var v = (inc.attrs || {})[c.key];
            return v ? '<div><span style="color:#6b7280">' + esc(c.label) + ':</span> ' + esc(v) + '</div>' : '';
        }).join('');
        return '<div><b style="color:#00d9ff">#' + n + '</b> ' + esc(fmtDate(inc.date)) + ' ' + esc(timeText(inc)) +
            (inc.reportNo ? ' <span style="color:#6b7280">· ' + esc(inc.reportNo) + '</span>' : '') +
            '<div style="color:#e5e7eb;margin:2px 0 4px">' + esc(inc.address || '') + '</div>' +
            (inc.offense ? '<div><span style="color:#6b7280">Offense:</span> ' + esc(inc.offense) + '</div>' : '') +
            rows +
            '<div style="margin-top:6px"><button class="sa-btn" style="padding:2px 9px" data-sa="edit" data-id="' + esc(inc.id) + '">✎ Edit</button></div></div>';
    }

    function focusIncident(id) {
        SA.focusId = id;
        var rows = document.querySelectorAll('#saRoot tr[data-sa="focus"]');
        for (var i = 0; i < rows.length; i++) rows[i].classList.toggle('sa-row-focus', rows[i].getAttribute('data-id') === String(id));
        var inc = byId(id);
        if (SA.map && inc && hasGeo(inc)) {
            SA.map.setView([inc.lat, inc.lng], Math.max(SA.map.getZoom(), 16));
            drawMap();
            var mk = SA.markers[id];
            if (mk) mk.openPopup();
        } else if (inc && !hasGeo(inc) && SA.view === 'overview') {
            toast('#' + (seq()[id] || '') + ' has no map position yet.', 'info');
        }
    }

    // ── Incidents view ───────────────────────────────────────────────
    function renderIncidentsView() {
        var list = visible();
        var noTime = list.filter(function (i) { return !i.timeFrom; }).length;
        var noDate = list.filter(function (i) { return !i.date; }).length;
        var noGeo = list.filter(function (i) { return !hasGeo(i); }).length;
        var notes = [];
        if (noGeo) notes.push(noGeo + ' without a map position');
        if (noTime) notes.push(noTime + ' without a time');
        if (noDate) notes.push(noDate + ' without a date');
        return '' +
        '<div class="sa-card">' +
            '<div class="flex items-center flex-wrap gap-3 mb-2">' +
                '<div class="sa-card-h">' + list.length + ' incident' + (list.length === 1 ? '' : 's') +
                    (notes.length ? ' <small>· ' + esc(notes.join(' · ')) + '</small>' : '') + '</div>' +
                '<div class="flex-1"></div>' +
                '<label class="text-xs text-gray-400 flex items-center gap-2" title="Added to addresses that have no city when looking them up on the map">Area hint for locating' +
                    '<input class="sa-input" style="width:200px;padding:4px 8px" data-sa-field="geoHint" placeholder="e.g. Westminster, CO" value="' + esc(SA.data.geoHint || '') + '"></label>' +
            '</div>' +
            renderIncidentTable(list, { compact: false }) +
        '</div>' +
        '<div class="text-[11px] text-gray-500 mt-2 px-1">Click a row to open it on the map. A time window whose start is later than its end (23:00 → 06:00) is read as starting the evening before the date.</div>';
    }

    // ── Compare view ─────────────────────────────────────────────────
    function renderCompareView() {
        var list = visible();
        var c = cols();
        var sh = M().shared(all(), c) || {};
        var chips = [];
        c.forEach(function (col) {
            (sh[col.key] || []).forEach(function (v) { chips.push({ col: col, v: v }); });
        });
        chips.sort(function (a, b) { return b.v.count - a.v.count; });
        var chipHtml = chips.slice(0, 14).map(function (x) {
            var gc = groupColor(x.col.group);
            var on = SA.filter && SA.filter.col === x.col.key && SA.filter.value === x.v.value;
            return '<span class="sa-chip" style="background:' + hexA(gc, on ? 0.3 : 0.14) + ';color:#f3f4f6;border-color:' + hexA(gc, 0.55) + '" data-sa="filter" data-col="' + esc(x.col.key) + '" data-val="' + esc(x.v.value) + '" data-display="' + esc(x.v.display) + '" title="' + esc(x.col.label) + '">' +
                esc(x.v.display) + ' <span style="opacity:.7">· ' + x.v.count + '</span></span>';
        }).join(' ');
        var tpls = M().TEMPLATES, opts = '';
        Object.keys(tpls).forEach(function (k) {
            opts += '<option value="' + esc(k) + '"' + (SA.data.template === k ? ' selected' : '') + '>' + esc(tpls[k].label) + '</option>';
        });

        var mx = M().matrix(list, c) || [];
        var head = '<tr><th>#</th><th>Date</th><th>Time</th><th>Location</th>' +
            c.map(function (col) {
                return '<th><span style="border-bottom:2px solid ' + hexA(groupColor(col.group), 0.7) + '">' + esc(col.label) + '</span>' +
                    '<span class="sa-colx" data-sa="del-col" data-col="' + esc(col.key) + '" title="Remove column (values are kept)">✕</span></th>';
            }).join('') + '</tr>';
        var body = mx.map(function (row) {
            var inc = row.incident;
            var cells = c.map(function (col) {
                var cell = (row.cells || {})[col.key] || { parts: [] };
                var gc = groupColor(col.group);
                var inner = (cell.parts || []).map(function (p) {
                    if (!p.shared) return '<span class="sa-plain">' + esc(p.text) + '</span>';
                    return '<span class="sa-shared" style="background:' + hexA(gc, 0.14) + ';border-color:' + hexA(gc, 0.5) + '" data-sa="filter" data-col="' + esc(col.key) +
                        '" data-val="' + esc(M().normValue(p.text)) + '" data-display="' + esc(p.text) + '" title="Shared with ' + (p.count - 1) + ' other incident' + (p.count === 2 ? '' : 's') + '">' + esc(p.text) + '</span>';
                }).join('<span class="text-gray-600"> ; </span>');
                return '<td data-sa-cell="' + esc(inc.id) + '|' + esc(col.key) + '" title="Double-click to edit">' + (inner || '<span class="text-gray-700">—</span>') + '</td>';
            }).join('');
            return '<tr><td><span class="sa-num" style="background:' + seqColor(row.n) + '">' + row.n + '</span></td>' +
                '<td class="whitespace-nowrap text-gray-200">' + esc(fmtDate(inc.date)) + '</td>' +
                '<td class="whitespace-nowrap">' + timeHtml(inc) + '</td>' +
                '<td class="sa-trunc text-gray-300" title="' + esc(inc.address) + '">' + esc(inc.address || '—') + '</td>' + cells + '</tr>';
        }).join('');

        return '' +
        '<div class="sa-card mb-3">' +
            '<div class="flex items-center gap-3 flex-wrap">' +
                '<div class="sa-card-h whitespace-nowrap">Shared across incidents</div>' +
                '<div class="flex flex-wrap gap-1.5 flex-1">' + (chipHtml || '<span class="text-xs text-gray-500">Nothing shared yet. Values that appear at two or more incidents show up here.</span>') + '</div>' +
                '<div class="flex items-center gap-2"><span class="text-xs text-gray-500">Columns</span>' +
                    '<select class="sa-select" style="width:auto;padding:4px 8px;font-size:12px" data-sa-field="template">' + opts + '</select>' +
                    '<button class="sa-btn" data-sa="add-col">＋ Column</button></div>' +
            '</div>' +
        '</div>' +
        '<div class="sa-card" style="padding:6px"><div class="overflow-x-auto"><table class="sa-table"><thead>' + head + '</thead><tbody>' +
            (body || '<tr><td colspan="' + (4 + c.length) + '" class="text-center text-gray-500 py-4">No incidents.</td></tr>') + '</tbody></table></div></div>' +
        '<div class="flex flex-wrap items-center gap-x-5 gap-y-1 mt-2 text-[11px] text-gray-500 px-1">' +
            '<span>Highlighted values appear at more than one incident; colour = kind of attribute.</span>' +
            '<span>Click a value to filter the map, grid and table to those incidents.</span>' +
            '<span>Double-click a cell to edit. Separate several values with “;”.</span>' +
        '</div>';
    }

    function startCellEdit(td) {
        if (!td || td.querySelector('input')) return;
        var parts = String(td.getAttribute('data-sa-cell') || '').split('|');
        var inc = byId(parts[0]);
        var key = parts.slice(1).join('|');
        if (!inc) return;
        var cur = (inc.attrs || {})[key] || '';
        td.innerHTML = '<input class="sa-cell-input" value="' + esc(cur) + '">';
        var inp = td.querySelector('input');
        inp.focus(); inp.select();
        var done = false;
        function finish(commit) {
            if (done) return; done = true;
            if (commit) {
                var v = inp.value.trim();
                if (v !== cur) {
                    inc.attrs = inc.attrs || {};
                    inc.attrs[key] = v;
                    inc.updatedAt = new Date().toISOString();
                    save({ quiet: true });
                }
            }
            renderBody();
        }
        inp.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); finish(true); }
            else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        });
        inp.addEventListener('blur', function () { finish(true); });
    }

    // ── Footage / Bulletin (sub-modules) ─────────────────────────────
    function renderFootageView() {
        if (!window.SeriesAnalysisFootage) return '<div class="p-6 text-gray-400">Footage review failed to load.</div>';
        try { return window.SeriesAnalysisFootage.render(ctx()); } catch (e) { console.error(e); return '<div class="p-6 text-red-300">Footage review error: ' + esc(e.message) + '</div>'; }
    }
    function renderBulletinView() {
        if (!window.SeriesAnalysisBulletin) return '<div class="p-6 text-gray-400">Bulletin builder failed to load.</div>';
        try { return window.SeriesAnalysisBulletin.render(ctx()); } catch (e) { console.error(e); return '<div class="p-6 text-red-300">Bulletin error: ' + esc(e.message) + '</div>'; }
    }

    // ── modal infrastructure ─────────────────────────────────────────
    function openModal(html, opts) {
        closeModal();
        var wrap = document.createElement('div');
        wrap.id = 'saModal';
        wrap.className = 'sa-modal-backdrop';
        wrap.innerHTML = '<div class="sa-modal' + (opts && opts.wide ? ' sa-modal-wide' : '') + '" role="dialog">' + html + '</div>';
        wrap.addEventListener('mousedown', function (e) { if (e.target === wrap) closeModal(); });
        document.body.appendChild(wrap);
        var first = wrap.querySelector('[autofocus]') || wrap.querySelector('input,textarea,select');
        if (first) setTimeout(function () { try { first.focus(); } catch (_) {} }, 30);
        return wrap;
    }
    function closeModal() {
        var m = document.getElementById('saModal');
        if (m && m.parentNode) m.parentNode.removeChild(m);
    }
    function modalHead(title, sub) {
        return '<div class="flex items-start justify-between mb-4"><div><h3>' + esc(title) + '</h3>' +
            (sub ? '<div class="text-xs text-gray-400 mt-0.5">' + sub + '</div>' : '') + '</div>' +
            '<button class="text-gray-400 hover:text-white text-xl leading-none px-1" data-sa="modal-close">×</button></div>';
    }

    // ── incident add / edit ──────────────────────────────────────────
    function suggestions(key) {
        var seen = {}, out = [];
        all().forEach(function (i) {
            M().splitValues((i.attrs || {})[key] || '').forEach(function (p) {
                var n = M().normValue(p);
                if (n && !seen[n]) { seen[n] = 1; out.push(p); }
            });
        });
        return out.slice(0, 60);
    }

    function openIncidentModal(id) {
        var inc = id ? byId(id) : null;
        var isNew = !inc;
        var v = inc || { reportNo: '', date: '', timeFrom: '', timeTo: '', address: '', lat: null, lng: null, offense: '', notes: '', attrs: {} };
        var n = inc ? seq()[inc.id] : null;
        var colInputs = cols().map(function (c) {
            var dl = 'sadl_' + c.key;
            var opts = suggestions(c.key).map(function (s) { return '<option value="' + esc(s) + '">'; }).join('');
            return '<div><label class="sa-label"><span style="color:' + groupColor(c.group) + '">●</span> ' + esc(c.label) + '</label>' +
                '<input class="sa-input" data-attr="' + esc(c.key) + '" list="' + dl + '" value="' + esc((v.attrs || {})[c.key] || '') + '">' +
                '<datalist id="' + dl + '">' + opts + '</datalist></div>';
        }).join('');
        var html = modalHead(isNew ? 'Add incident' : ('Edit incident #' + n),
                'Pick earlier values from the suggestions when they match. Identical wording is what lets the Compare view find links.') +
            '<div class="grid grid-cols-2 md:grid-cols-4 gap-3">' +
                '<div><label class="sa-label">Report #</label><input class="sa-input" id="saf_reportNo" value="' + esc(v.reportNo) + '" autofocus></div>' +
                '<div><label class="sa-label">Date (or morning found)</label><input type="date" class="sa-input" id="saf_date" value="' + esc(v.date) + '"></div>' +
                '<div><label class="sa-label">Time (or window start)</label><input type="time" class="sa-input" id="saf_timeFrom" value="' + esc(v.timeFrom) + '"></div>' +
                '<div><label class="sa-label">Window end <span class="text-gray-600">(blank = exact)</span></label><input type="time" class="sa-input" id="saf_timeTo" value="' + esc(v.timeTo) + '"></div>' +
            '</div>' +
            '<div class="grid grid-cols-1 md:grid-cols-12 gap-3 mt-3">' +
                '<div class="md:col-span-7"><label class="sa-label">Address / location</label>' +
                    '<div class="flex gap-2"><input class="sa-input" id="saf_address" value="' + esc(v.address) + '" placeholder="1412 Alder Ln, Westminster, CO">' +
                    '<button class="sa-btn" data-sa="modal-geocode" title="Look up the map position">⌖ Locate</button></div></div>' +
                '<div class="md:col-span-5 grid grid-cols-2 gap-2">' +
                    '<div><label class="sa-label">Latitude</label><input class="sa-input" id="saf_lat" value="' + (v.lat != null ? esc(v.lat) : '') + '"></div>' +
                    '<div><label class="sa-label">Longitude</label><input class="sa-input" id="saf_lng" value="' + (v.lng != null ? esc(v.lng) : '') + '"></div>' +
                '</div>' +
            '</div>' +
            '<div id="saf_geoMsg" class="text-[11px] text-gray-500 mt-1"></div>' +
            '<div class="mt-3"><label class="sa-label">Offense</label><input class="sa-input" id="saf_offense" value="' + esc(v.offense) + '" placeholder="e.g. Theft from vehicle (catalytic converter)"></div>' +
            '<div class="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">' + colInputs + '</div>' +
            '<div class="mt-3"><label class="sa-label">Notes</label><textarea class="sa-textarea" id="saf_notes" rows="3">' + esc(v.notes) + '</textarea></div>' +
            '<div class="flex items-center gap-2 mt-4">' +
                (isNew ? '' : '<button class="sa-btn sa-btn-red" data-sa="modal-del-inc" data-id="' + esc(inc.id) + '">Delete</button>') +
                '<div class="flex-1"></div>' +
                (isNew ? '<button class="sa-btn" data-sa="modal-save-inc" data-again="1">Save & add another</button>' : '') +
                '<button class="sa-btn" data-sa="modal-close">Cancel</button>' +
                '<button class="sa-btn sa-btn-cyan" data-sa="modal-save-inc" data-id="' + (inc ? esc(inc.id) : '') + '">Save</button>' +
            '</div>';
        openModal(html, { wide: true });
    }

    function readIncidentForm() {
        function val(id) { var e = document.getElementById(id); return e ? e.value.trim() : ''; }
        var lat = parseFloat(val('saf_lat')), lng = parseFloat(val('saf_lng'));
        var attrs = {};
        var ins = document.querySelectorAll('#saModal [data-attr]');
        for (var i = 0; i < ins.length; i++) attrs[ins[i].getAttribute('data-attr')] = ins[i].value.trim();
        return {
            reportNo: val('saf_reportNo'), date: val('saf_date'), timeFrom: val('saf_timeFrom'), timeTo: val('saf_timeTo'),
            address: val('saf_address'), offense: val('saf_offense'), notes: val('saf_notes'),
            lat: isFinite(lat) && Math.abs(lat) <= 90 ? lat : null,
            lng: isFinite(lng) && Math.abs(lng) <= 180 ? lng : null,
            attrs: attrs
        };
    }

    function saveIncidentFromModal(id, again) {
        var f = readIncidentForm();
        if (!f.date && !f.address) { toast('An incident needs at least a date or an address.', 'warning'); return; }
        var now = new Date().toISOString();
        var existing = id ? byId(id) : null;
        if (existing) {
            var keepAttrs = Object.assign({}, existing.attrs || {}, f.attrs);
            var moved = existing.address !== f.address && f.lat === existing.lat && f.lng === existing.lng;
            Object.assign(existing, f, { attrs: keepAttrs, updatedAt: now });
            // Address changed but the position was left alone: the old pin is now wrong.
            if (moved && f.address) { existing.lat = null; existing.lng = null; }
            var norm = M().normalizeIncident(existing);
            var idx = all().indexOf(existing);
            if (idx >= 0) SA.data.incidents[idx] = norm;
        } else {
            SA.data.incidents.push(M().normalizeIncident(Object.assign({}, f, { source: { type: 'manual' }, createdAt: now, updatedAt: now })));
        }
        var wasEmpty = !document.getElementById('saBody');
        save();
        SA.fitted = false;
        if (again) {
            openIncidentModal(null);
            toast('Incident saved.', 'success');
            if (wasEmpty) { /* keep modal; re-render the tab underneath */ var keep = document.getElementById('saModal'); if (keep) keep.parentNode.removeChild(keep); rerender(); document.body.appendChild(keep); }
            else refreshAfterDataChange();
            return;
        }
        closeModal();
        if (wasEmpty) rerender(); else refreshAfterDataChange();
    }

    function refreshAfterDataChange() {
        // Header (counts, Locate button) and body both depend on the data.
        var root = document.getElementById('saRoot');
        if (!root || !all().length || !document.getElementById('saBody')) { rerender(); return; }
        var tmp = document.createElement('div');
        tmp.innerHTML = renderHeader();
        var oldHead = root.firstElementChild;
        if (oldHead && tmp.firstElementChild) root.replaceChild(tmp.firstElementChild, oldHead);
        renderBody();
    }

    function modalGeocode() {
        var addr = (document.getElementById('saf_address') || {}).value || '';
        var msg = document.getElementById('saf_geoMsg');
        if (!addr.trim()) { if (msg) msg.textContent = 'Type an address first.'; return; }
        if (msg) msg.innerHTML = '<span class="text-viper-cyan">Looking up…</span>';
        geocodeOne(addr).then(function (g) {
            if (!g) { if (msg) msg.innerHTML = '<span class="text-red-300">' + esc(window._lastGeocodeError || 'Not found') + '</span> — add the city/state, or type the latitude and longitude.'; return; }
            document.getElementById('saf_lat').value = (Math.round(g.lat * 1e6) / 1e6);
            document.getElementById('saf_lng').value = (Math.round(g.lng * 1e6) / 1e6);
            if (msg) msg.innerHTML = '<span class="text-green-300">Found:</span> ' + esc(g.display || '');
        });
    }

    function deleteIncident(id) {
        var inc = byId(id);
        if (!inc) return;
        var n = seq()[id];
        confirmBox('Delete incident #' + n + (inc.address ? ' (' + inc.address + ')' : '') + ' from this series?', { danger: true, okText: 'Delete' }).then(function (yes) {
            if (!yes) return;
            SA.data.incidents = all().filter(function (i) { return i !== inc; });
            // Footage observations that pointed at it stay, unlinked.
            (SA.data.observations || []).forEach(function (o) { if (o && o.incidentId === id) o.incidentId = ''; });
            (SA.data.cameras || []).forEach(function (c) { if (c && c.incidentId === id) c.incidentId = ''; });
            save();
            closeModal();
            try { if (window.ConnectionBoard && window.ConnectionBoard.removePinsBySource) window.ConnectionBoard.removePinsBySource('series', id); } catch (_) {}
            if (!all().length) { SA.view = 'incidents'; rerender(); } else refreshAfterDataChange();
        });
    }

    // ── geocoding ────────────────────────────────────────────────────
    function withHint(addr) {
        var hint = String(SA.data.geoHint || '').trim();
        if (!hint || addr.indexOf(',') >= 0) return addr;
        return addr + ', ' + hint;
    }
    function geocodeOne(addr) {
        var q = withHint(String(addr || '').trim());
        if (typeof window.geocodeAddress !== 'function') { window._lastGeocodeError = 'Geocoder not available'; return Promise.resolve(null); }
        return Promise.resolve(window.geocodeAddress(q)).then(function (g) {
            if (!g) return null;
            var lng = g.lng != null ? g.lng : g.lon;
            if (!isFinite(g.lat) || !isFinite(lng)) return null;
            return { lat: +g.lat, lng: +lng, display: g.display || g.display_name || '' };
        }, function () { return null; });
    }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    function runGeocode() {
        if (SA.geo.busy) return;
        var todo = missingGeo();
        if (!todo.length) { toast('Every incident with an address already has a map position.', 'info'); return; }
        SA.geo = { busy: true, cancel: false, failed: SA.geo.failed || {}, done: 0, total: todo.length };
        refreshGeoButton();
        var found = 0;
        // Nominatim policy: at most one request a second.
        var chain = Promise.resolve();
        todo.forEach(function (inc, i) {
            chain = chain.then(function () {
                if (SA.geo.cancel) return;
                return geocodeOne(inc.address).then(function (g) {
                    SA.geo.done++;
                    var live = byId(inc.id);
                    if (g && live) { live.lat = g.lat; live.lng = g.lng; delete SA.geo.failed[inc.id]; found++; save({ quiet: true }); }
                    else SA.geo.failed[inc.id] = window._lastGeocodeError || 'Not found';
                    refreshGeoButton();
                    return i < todo.length - 1 ? sleep(1100) : null;
                });
            });
        });
        chain.then(function () {
            var miss = SA.geo.done - found;
            SA.geo.busy = false;
            toast('Located ' + found + ' of ' + SA.geo.done + (miss ? ' — ' + miss + ' not found. Add the city/state (or set the area hint on the Incidents view) and try again.' : '.'), miss ? 'warning' : 'success');
            SA.fitted = false;
            if (document.getElementById('saRoot')) refreshAfterDataChange();
        });
    }
    function refreshGeoButton() {
        var b = document.getElementById('saGeoBtn');
        if (b && SA.geo.busy) { b.textContent = 'Stop locating (' + SA.geo.done + '/' + SA.geo.total + ')'; b.setAttribute('data-sa', 'geocode-stop'); b.className = 'sa-btn sa-btn-red'; }
    }

    // ── CSV import ───────────────────────────────────────────────────
    var BASE_FIELDS = [
        ['reportNo', 'Report #'], ['date', 'Date'], ['timeFrom', 'Time / from'], ['timeTo', 'Time to'], ['timeRange', 'Time range (one cell)'],
        ['address', 'Address'], ['lat', 'Latitude'], ['lng', 'Longitude'], ['offense', 'Offense'], ['notes', 'Notes / narrative']
    ];

    function openCsvModal() {
        SA.csv = null;
        var html = modalHead('Import incidents from CSV', 'Paste rows copied from Excel or an RMS / CAD export, or load a .csv file. The first row must be the column headings.') +
            '<textarea class="sa-textarea font-mono" id="saCsvText" rows="10" placeholder="Report #,Date,Time From,Time To,Address,Suspect Vehicle,MO&#10;26-104871,10/01/2026,0130,0545,1412 Alder Ln,,Saw heard"></textarea>' +
            '<div class="flex items-center gap-2 mt-3">' +
                '<button class="sa-btn" data-sa="csv-file">Choose file…</button>' +
                '<span class="text-[11px] text-gray-500">.csv, .tsv or .txt</span>' +
                '<div class="flex-1"></div>' +
                '<button class="sa-btn" data-sa="modal-close">Cancel</button>' +
                '<button class="sa-btn sa-btn-cyan" data-sa="csv-parse">Next: match columns →</button>' +
            '</div>' +
            '<div id="saCsvStep2"></div>';
        openModal(html, { wide: true });
    }

    function csvParse(text) {
        var rows = M().parseCsv(String(text || ''));
        if (!rows.length || rows.length < 2) { toast('Need a heading row and at least one data row.', 'warning'); return; }
        var headers = rows[0].map(function (h) { return String(h || '').trim(); });
        SA.csv = { rows: rows, headers: headers, mapping: M().guessMapping(headers, cols()) };
        renderCsvStep2();
    }

    function renderCsvStep2() {
        var el = document.getElementById('saCsvStep2');
        if (!el || !SA.csv) return;
        var hs = SA.csv.headers, mp = SA.csv.mapping;
        function sel(field) {
            var cur = mp[field];
            var o = '<option value="">— not in file —</option>' + hs.map(function (h, i) {
                return '<option value="' + i + '"' + (cur === i ? ' selected' : '') + '>' + esc(h || ('Column ' + (i + 1))) + '</option>';
            }).join('');
            return '<select class="sa-select" style="padding:4px 6px;font-size:12px" data-sa-map="' + esc(field) + '">' + o + '</select>';
        }
        var fields = BASE_FIELDS.concat(cols().map(function (c) { return [c.key, c.label]; }));
        var grid = fields.map(function (f) {
            return '<div><label class="sa-label">' + esc(f[1]) + '</label>' + sel(f[0]) + '</div>';
        }).join('');
        var res = M().rowsToIncidents(SA.csv.rows, mp, { hasHeader: true, source: { type: 'csv' } });
        var prev = res.incidents.slice(0, 5).map(function (i) {
            return '<tr><td>' + esc(i.reportNo) + '</td><td>' + esc(i.date) + '</td><td>' + esc(timeText(i)) + '</td><td class="sa-trunc">' + esc(i.address) + '</td>' +
                '<td>' + (i.lat != null ? '✓' : '') + '</td>' +
                cols().slice(0, 3).map(function (c) { return '<td class="sa-trunc">' + esc((i.attrs || {})[c.key] || '') + '</td>'; }).join('') + '</tr>';
        }).join('');
        var noGeo = res.incidents.filter(function (i) { return i.lat == null && i.address; }).length;
        el.innerHTML = '<div class="mt-4 pt-4 border-t border-gray-700/60">' +
            '<div class="text-sm font-semibold text-white mb-2">Match columns <span class="text-gray-500 font-normal text-xs">· ' + (SA.csv.rows.length - 1) + ' data rows, ' + hs.length + ' columns found</span></div>' +
            '<div class="grid grid-cols-2 md:grid-cols-5 gap-2">' + grid + '</div>' +
            '<div class="text-sm font-semibold text-white mt-4 mb-1">Preview <span class="text-gray-500 font-normal text-xs">· ' + res.incidents.length + ' incidents' +
                (res.skipped.length ? ', ' + res.skipped.length + ' rows skipped (no date or address)' : '') + '</span></div>' +
            '<div class="overflow-x-auto"><table class="sa-table"><thead><tr><th>Report</th><th>Date</th><th>Time</th><th>Address</th><th>Pos</th>' +
                cols().slice(0, 3).map(function (c) { return '<th>' + esc(c.label) + '</th>'; }).join('') + '</tr></thead><tbody>' + prev + '</tbody></table></div>' +
            '<div class="flex items-center gap-3 mt-4">' +
                (noGeo ? '<label class="text-xs text-gray-300 flex items-center gap-2"><input type="checkbox" id="saCsvGeo" checked class="accent-viper-cyan"> Look up map positions for ' + noGeo + ' address' + (noGeo === 1 ? '' : 'es') + ' after import (about ' + Math.ceil(noGeo * 1.1) + ' s)</label>' : '') +
                '<div class="flex-1"></div>' +
                '<button class="sa-btn sa-btn-cyan" data-sa="csv-import"' + (res.incidents.length ? '' : ' disabled') + '>Import ' + res.incidents.length + ' incident' + (res.incidents.length === 1 ? '' : 's') + '</button>' +
            '</div></div>';
    }

    function csvImport() {
        if (!SA.csv) return;
        var res = M().rowsToIncidents(SA.csv.rows, SA.csv.mapping, { hasHeader: true, source: { type: 'csv' } });
        if (!res.incidents.length) return;
        var geoAfter = !!(document.getElementById('saCsvGeo') || {}).checked;
        // Same report # + date + start time + address already here: skip, don't duplicate.
        var keyOf = function (i) { return [M().normValue(i.reportNo), i.date, i.timeFrom, M().normValue(i.address)].join('|'); };
        var have = {};
        all().forEach(function (i) { have[keyOf(i)] = 1; });
        var added = 0, dup = 0, now = new Date().toISOString();
        res.incidents.forEach(function (i) {
            var k = keyOf(i);
            if (have[k]) { dup++; return; }
            have[k] = 1;
            i.createdAt = i.createdAt || now; i.updatedAt = now;
            SA.data.incidents.push(i); added++;
        });
        save();
        SA.csv = null; SA.fitted = false;
        closeModal();
        toast('Imported ' + added + ' incident' + (added === 1 ? '' : 's') + (dup ? ' (' + dup + ' already here, skipped)' : '') + '.', 'success');
        if (SA.view === 'incidents' && added) SA.view = 'overview';
        rerender();
        if (geoAfter && missingGeo().length) setTimeout(runGeocode, 300);
    }

    function csvTemplateDownload() {
        var text = M().csvTemplate(cols()) + '\r\n';
        try {
            var blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' });
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'series-analysis-template.csv';
            document.body.appendChild(a); a.click();
            setTimeout(function () { URL.revokeObjectURL(a.href); a.parentNode.removeChild(a); }, 500);
        } catch (e) { toast('Could not create the template file.', 'error'); }
    }

    // ── import from other VIPER cases ────────────────────────────────
    function openCasesModal() {
        var me = theCase();
        var cases = (lsParse('viperCases', []) || []).filter(function (c) { return c && c.id !== (me && me.id); });
        var linked = {};
        all().forEach(function (i) { if (i.source && i.source.caseId) linked[i.source.caseId] = 1; });
        cases.sort(function (a, b) { return String(b.offenseDate || b.createdAt || '').localeCompare(String(a.offenseDate || a.createdAt || '')); });
        SA._cases = cases;
        var rows = cases.map(function (c, idx) {
            var on = !!linked[c.id];
            var hay = [c.caseNumber, c.primaryOffense, c.locationOfOccurrence, c.caseName, c.title].join(' ').toLowerCase();
            return '<label class="flex items-start gap-3 p-2 rounded-lg hover:bg-white/5 cursor-pointer" data-hay="' + esc(hay) + '">' +
                '<input type="checkbox" class="mt-1 accent-viper-cyan" data-case-idx="' + idx + '"' + (on ? ' disabled checked' : '') + '>' +
                '<div class="min-w-0 flex-1"><div class="text-sm text-white font-semibold">' + esc(c.caseNumber || '(no number)') +
                    (on ? ' <span class="text-[10px] text-green-300 font-normal">already in this series</span>' : '') +
                    ' <span class="text-gray-400 font-normal">' + esc(c.primaryOffense || '') + '</span></div>' +
                '<div class="text-xs text-gray-500 truncate">' + esc([c.offenseDate ? String(c.offenseDate).slice(0, 10) : '', c.locationOfOccurrence || '', c.status || ''].filter(Boolean).join(' · ')) + '</div></div></label>';
        }).join('');
        var html = modalHead('Add incidents from other VIPER cases',
                'Each case becomes one incident: case number, offense date, location, offense, suspects and victims. Use the Compare view afterwards to line them up.') +
            '<input class="sa-input mb-3" data-sa-input="case-q" placeholder="Filter by case number, offense or location…">' +
            '<div id="saCaseList" class="max-h-[50vh] overflow-auto space-y-0.5">' + (rows || '<div class="text-gray-500 text-sm p-3">No other cases on this machine.</div>') + '</div>' +
            '<div class="flex items-center gap-2 mt-4"><div class="text-[11px] text-gray-500">Tip: the “Death / violent crime” column set suits homicide comparisons.</div><div class="flex-1"></div>' +
            '<button class="sa-btn" data-sa="modal-close">Cancel</button><button class="sa-btn sa-btn-cyan" data-sa="cases-import">Add selected</button></div>';
        openModal(html, { wide: false });
    }

    function casesImport() {
        var boxes = document.querySelectorAll('#saCaseList input[data-case-idx]:checked:not([disabled])');
        if (!boxes.length) { toast('Tick at least one case.', 'warning'); return; }
        var now = new Date().toISOString(), added = 0;
        for (var i = 0; i < boxes.length; i++) {
            var c = (SA._cases || [])[+boxes[i].getAttribute('data-case-idx')];
            if (!c) continue;
            var inc = M().fromCase(c, {
                victims: lsParse('victims_' + c.id, []) || [],
                suspects: lsParse('suspects_' + c.id, []) || []
            });
            inc.createdAt = now; inc.updatedAt = now;
            SA.data.incidents.push(M().normalizeIncident(inc));
            added++;
        }
        save();
        closeModal();
        SA.fitted = false;
        toast('Added ' + added + ' case' + (added === 1 ? '' : 's') + ' as incidents.', 'success');
        if (SA.view === 'incidents') SA.view = 'compare';
        rerender();
    }

    // ── columns ──────────────────────────────────────────────────────
    function openAddColumnModal() {
        var groups = [['vehicle', 'Vehicle'], ['person', 'Person / description'], ['mo', 'Method / MO'], ['target', 'Target / victim'], ['place', 'Place'], ['other', 'Other']];
        var html = modalHead('Add a compare column', 'Values typed into this column are matched across incidents.') +
            '<div class="grid grid-cols-2 gap-3"><div><label class="sa-label">Column name</label><input class="sa-input" id="saColLabel" placeholder="e.g. Tool used" autofocus></div>' +
            '<div><label class="sa-label">Kind (sets the highlight colour)</label><select class="sa-select" id="saColGroup">' +
                groups.map(function (g) { return '<option value="' + g[0] + '">' + g[1] + '</option>'; }).join('') + '</select></div></div>' +
            '<div class="flex justify-end gap-2 mt-4"><button class="sa-btn" data-sa="modal-close">Cancel</button><button class="sa-btn sa-btn-cyan" data-sa="add-col-save">Add column</button></div>';
        openModal(html);
    }
    function addColumn() {
        var label = ((document.getElementById('saColLabel') || {}).value || '').trim();
        var group = (document.getElementById('saColGroup') || {}).value || 'other';
        if (!label) { toast('Name the column.', 'warning'); return; }
        var base = label.toLowerCase().replace(/[^a-z0-9]+(.)?/g, function (_, ch) { return ch ? ch.toUpperCase() : ''; }).replace(/^[^a-z]+/, '') || 'col';
        var key = base, n = 2;
        while (colByKey(key)) { key = base + n; n++; }
        SA.data.columns.push({ key: key, label: label, group: group });
        save({ quiet: true });
        closeModal();
        renderBody();
    }
    function removeColumn(key) {
        var c = colByKey(key);
        if (!c) return;
        confirmBox('Hide the “' + c.label + '” column? Values already typed are kept and come back if you add a column with the same name or switch templates.', { okText: 'Hide' }).then(function (yes) {
            if (!yes) return;
            SA.data.columns = cols().filter(function (x) { return x.key !== key; });
            if (SA.filter && SA.filter.col === key) SA.filter = null;
            save({ quiet: true });
            renderBody();
        });
    }
    function setTemplate(key) {
        var t = M().TEMPLATES[key];
        if (!t || key === SA.data.template) return;
        var apply = function () {
            SA.data.template = key;
            SA.data.columns = t.columns.map(function (c) { return { key: c.key, label: c.label, group: c.group }; });
            if (SA.filter && !colByKey(SA.filter.col)) SA.filter = null;
            save({ quiet: true });
            if (document.getElementById('saBody')) renderBody(); else rerender();
        };
        if (!all().length) { apply(); return; }
        confirmBox('Switch the compare columns to “' + t.label + '”? Values already typed are kept; columns not in this set are just hidden.', { okText: 'Switch' }).then(function (yes) {
            if (yes) apply();
            else { var s = document.querySelector('#saRoot [data-sa-field="template"]'); if (s) s.value = SA.data.template; }
        });
    }

    // ── Connection Board ─────────────────────────────────────────────
    function sendToBoard() {
        var CB = window.ConnectionBoard;
        if (!CB || typeof CB.addFromCaseData !== 'function') { toast('The Connection Board is not available.', 'error'); return; }
        if (!all().length) { toast('No incidents to send.', 'info'); return; }
        // The board reads the whole series straight from the store (incidents,
        // likely-next area, cameras, footage observations + their links) and
        // keeps it in sync from then on, so save first.
        save({ quiet: true });
        CB.addFromCaseData('series');
    }

    // ── events (delegated, installed once) ───────────────────────────
    function inScope(el) { return !!(el && el.closest && (el.closest('#saRoot') || el.closest('#saModal'))); }

    function onClick(e) {
        var menu = document.getElementById('saImportMenu');
        var t = e.target && e.target.closest ? e.target.closest('[data-sa]') : null;
        if (menu && menu.style.display !== 'none' && (!t || t.getAttribute('data-sa') !== 'import-menu')) menu.style.display = 'none';
        if (!t || !inScope(t) || !M()) return;
        var act = t.getAttribute('data-sa');
        var id = t.getAttribute('data-id');
        switch (act) {
            case 'view': SA.view = t.getAttribute('data-v'); refreshAfterDataChange(); break;
            case 'import-menu': if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none'; break;
            case 'add': openIncidentModal(null); break;
            case 'edit': if (id) openIncidentModal(id); break;
            case 'del': if (id) deleteIncident(id); break;
            case 'focus': if (id && !e.target.closest('button')) focusIncident(id); break;
            case 'toggle-rows': SA.showAllRows = !SA.showAllRows; renderBody(); break;
            case 'csv': openCsvModal(); break;
            case 'csv-file': { var fi = document.getElementById('saFileInput'); if (fi) fi.click(); break; }
            case 'csv-parse': csvParse((document.getElementById('saCsvText') || {}).value); break;
            case 'csv-import': csvImport(); break;
            case 'csv-template': csvTemplateDownload(); break;
            case 'from-cases': openCasesModal(); break;
            case 'cases-import': casesImport(); break;
            case 'geocode': runGeocode(); break;
            case 'geocode-stop': SA.geo.cancel = true; break;
            case 'board': sendToBoard(); break;
            case 'layer': {
                var ly = t.getAttribute('data-layer');
                SA.layers[ly] = !SA.layers[ly];
                t.classList.toggle('on', SA.layers[ly]);
                drawMap();
                break;
            }
            case 'filter': {
                var col = t.getAttribute('data-col'), val = t.getAttribute('data-val');
                if (SA.filter && SA.filter.col === col && SA.filter.value === val) SA.filter = null;
                else SA.filter = { col: col, value: val, display: t.getAttribute('data-display') || val, label: (colByKey(col) || {}).label || col };
                SA.fitted = false;
                renderBody();
                break;
            }
            case 'clear-filter': SA.filter = null; SA.fitted = false; renderBody(); break;
            case 'add-col': openAddColumnModal(); break;
            case 'add-col-save': addColumn(); break;
            case 'del-col': removeColumn(t.getAttribute('data-col')); break;
            case 'modal-close': closeModal(); break;
            case 'modal-geocode': modalGeocode(); break;
            case 'modal-save-inc': saveIncidentFromModal(t.getAttribute('data-id') || null, t.getAttribute('data-again') === '1'); break;
            case 'modal-del-inc': if (id) deleteIncident(id); break;
            default:
                // Sub-modules (footage / bulletin) handle their own actions.
                try { if (window.SeriesAnalysisFootage && window.SeriesAnalysisFootage.onAction && window.SeriesAnalysisFootage.onAction(act, t, e, ctx())) return; } catch (err) { console.error(err); }
                try { if (window.SeriesAnalysisBulletin && window.SeriesAnalysisBulletin.onAction && window.SeriesAnalysisBulletin.onAction(act, t, e, ctx())) return; } catch (err) { console.error(err); }
        }
    }

    function onChange(e) {
        var t = e.target;
        if (t && t.id === 'saFileInput') {
            var f = t.files && t.files[0];
            t.value = '';
            if (!f) return;
            var fr = new FileReader();
            fr.onload = function () {
                var ta = document.getElementById('saCsvText');
                if (ta) ta.value = String(fr.result || '');
                csvParse(String(fr.result || ''));
            };
            fr.onerror = function () { toast('Could not read that file.', 'error'); };
            fr.readAsText(f, 'utf-8');
            return;
        }
        if (!inScope(t)) return;
        var field = t.getAttribute && t.getAttribute('data-sa-field');
        if (field === 'title') { SA.data.title = t.value.trim(); save({ quiet: true }); return; }
        if (field === 'geoHint') { SA.data.geoHint = t.value.trim(); save({ quiet: true }); return; }
        if (field === 'template') { setTemplate(t.value); return; }
        var mapField = t.getAttribute && t.getAttribute('data-sa-map');
        if (mapField && SA.csv) {
            if (t.value === '') delete SA.csv.mapping[mapField];
            else {
                var idx = parseInt(t.value, 10);
                // One heading feeds one field.
                Object.keys(SA.csv.mapping).forEach(function (k) { if (SA.csv.mapping[k] === idx) delete SA.csv.mapping[k]; });
                SA.csv.mapping[mapField] = idx;
            }
            renderCsvStep2();
            return;
        }
        try { if (window.SeriesAnalysisFootage && window.SeriesAnalysisFootage.onChange && window.SeriesAnalysisFootage.onChange(t, e, ctx())) return; } catch (err) { console.error(err); }
        try { if (window.SeriesAnalysisBulletin && window.SeriesAnalysisBulletin.onChange && window.SeriesAnalysisBulletin.onChange(t, e, ctx())) return; } catch (err) { console.error(err); }
    }

    function onInput(e) {
        var t = e.target;
        if (!inScope(t)) return;
        if (t.getAttribute && t.getAttribute('data-sa-input') === 'case-q') {
            var q = t.value.trim().toLowerCase();
            var rows = document.querySelectorAll('#saCaseList [data-hay]');
            for (var i = 0; i < rows.length; i++) rows[i].style.display = !q || rows[i].getAttribute('data-hay').indexOf(q) >= 0 ? '' : 'none';
        }
    }

    function onDblClick(e) {
        var td = e.target && e.target.closest ? e.target.closest('td[data-sa-cell]') : null;
        if (td && inScope(td)) { e.preventDefault(); startCellEdit(td); }
    }

    function onKey(e) {
        if (e.key === 'Escape' && document.getElementById('saModal')) { closeModal(); return; }
        try { if (window.SeriesAnalysisFootage && window.SeriesAnalysisFootage.onKey) window.SeriesAnalysisFootage.onKey(e, ctx()); } catch (_) {}
    }

    function initializeSeriesAnalysis() {
        if (!M()) return;
        if (!window.__saDelegated) {
            window.__saDelegated = true;
            document.addEventListener('click', onClick, false);
            document.addEventListener('change', onChange, false);
            document.addEventListener('input', onInput, false);
            document.addEventListener('dblclick', onDblClick, false);
            document.addEventListener('keydown', onKey, false);
        }
        if (document.getElementById('saBody')) renderBody();
    }

    function teardownSeriesAnalysis() {
        destroyMap();
        closeModal();
        try { if (window.SeriesAnalysisFootage) window.SeriesAnalysisFootage.teardown(); } catch (_) {}
    }

    window.renderSeriesAnalysisTab = renderSeriesAnalysisTab;
    window.initializeSeriesAnalysis = initializeSeriesAnalysis;
    window.teardownSeriesAnalysis = teardownSeriesAnalysis;
    window.SeriesAnalysisUI = {
        refresh: refreshAfterDataChange, rerender: rerender, ctx: ctx, renderGrid: renderGrid,
        sendToBoard: sendToBoard, openIncident: openIncidentModal
    };
})();

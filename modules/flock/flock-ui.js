/* ============================================================
   FLOCK — LPR module UI  (VIPER)
   Owns the tab: ingest controls, filter bar, hit-card list,
   Leaflet map with travel trace, and time-scrubbed playback.

   Contract with the host page:
     renderFlockTab()   -> HTML string (called by renderTabContent)
     initializeFlock()  -> wires the DOM after innerHTML is set
     teardownFlock()    -> releases the Leaflet map + rAF loop

   Everything else is private to this IIFE. DOM events use delegation
   off the tab root, so hit ids never have to survive a trip through an
   inline onclick attribute.
   ============================================================ */
(function () {
    'use strict';
    if (typeof window === 'undefined') return;

    var M = null; // resolved lazily — FlockModule loads in any order
    function mod() { return M || (M = window.FlockModule); }
    function parser() { return window.FlockParser; }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function toast(m, k) { try { (window.viperToast || window.showToast || function () {})(m, k || 'info'); } catch (_) {} }

    // ── module state ─────────────────────────────────────────────────
    var FL = {
        filters: { importId: 'all', plate: 'all', from: '', to: '', q: '' },
        rendered: [],       // hits currently shown (post-filter, chronological)
        listLimit: 300,     // cards painted before "show more"
        map: null,
        cluster: null,
        markers: {},        // hitId -> marker
        trace: null,        // L.polyline of the filtered plate's path
        focusRing: null,
        pb: {               // playback
            raf: null, playing: false, prog: 0, n: 0, track: [],
            marker: null, tail: null, speed: 1, baseSec: 90, chase: true, lastFrame: 0
        }
    };

    var PLATE_COLORS = ['#06b6d4', '#f59e0b', '#a855f7', '#22c55e', '#ec4899',
                        '#3b82f6', '#ef4444', '#eab308', '#14b8a6', '#f97316'];
    function plateColor(plate, plates) {
        var i = plates.indexOf(plate);
        return PLATE_COLORS[(i < 0 ? 0 : i) % PLATE_COLORS.length];
    }

    // ── filtering ────────────────────────────────────────────────────
    function currentHits() {
        var m = mod();
        if (!m) return [];
        var f = FL.filters;
        var hits = (f.importId === 'all')
            ? m.allHits()
            : (m.getImport(f.importId) || { hits: [] }).hits.map(function (h) {
                  return Object.assign({}, h, { importId: f.importId });
              });

        if (f.plate !== 'all') hits = hits.filter(function (h) { return h.plate === f.plate; });

        // Date bounds are entered as local calendar days and compared against
        // the hit's LOCAL capture date, which is what the detective sees on the
        // card — comparing against UTC would shift edge hits across midnight.
        if (f.from) hits = hits.filter(function (h) { return !h.localDate || h.localDate >= f.from; });
        if (f.to)   hits = hits.filter(function (h) { return !h.localDate || h.localDate <= f.to; });

        if (f.q) {
            var q = f.q.toLowerCase();
            hits = hits.filter(function (h) {
                return (h.camera && h.camera.toLowerCase().indexOf(q) !== -1) ||
                       (h.network && h.network.toLowerCase().indexOf(q) !== -1) ||
                       (h.plate && h.plate.toLowerCase().indexOf(q) !== -1) ||
                       (h.make && h.make.toLowerCase().indexOf(q) !== -1) ||
                       (h.color && h.color.toLowerCase().indexOf(q) !== -1) ||
                       (h.body && h.body.toLowerCase().indexOf(q) !== -1);
            });
        }
        return hits;
    }

    function allPlates() {
        var m = mod(); if (!m) return [];
        var seen = {};
        m.getImports().forEach(function (i) { (i.plates || []).forEach(function (p) { seen[p] = 1; }); });
        return Object.keys(seen).sort();
    }

    // ── tab shell ────────────────────────────────────────────────────
    function renderFlockTab() {
        var m = mod();
        if (!m) {
            return '<div class="p-8 text-center text-gray-400">FLOCK module failed to load. Restart VIPER.</div>';
        }
        var imports = m.getImports();
        if (!imports.length) return renderEmptyState();

        return '' +
        '<div id="flockRoot" class="space-y-4">' +
            renderToolbar(imports) +
            '<div id="flockStats"></div>' +
            renderFilterBar(imports) +
            '<div class="grid grid-cols-1 xl:grid-cols-2 gap-4">' +
                '<div class="order-2 xl:order-1">' +
                    '<div class="flex items-center justify-between mb-2">' +
                        '<h3 class="text-sm font-semibold text-viper-cyan uppercase tracking-wider">Plate Reads</h3>' +
                        '<div class="flex items-center gap-2">' +
                            '<button data-flk="select-all" class="px-2 py-1 text-xs bg-viper-card border border-gray-600 rounded hover:border-viper-cyan text-gray-300">Select all shown</button>' +
                            '<button data-flk="select-none" class="px-2 py-1 text-xs bg-viper-card border border-gray-600 rounded hover:border-viper-cyan text-gray-300">Clear</button>' +
                        '</div>' +
                    '</div>' +
                    '<div id="flockList" class="flock-list space-y-2"></div>' +
                '</div>' +
                '<div class="order-1 xl:order-2">' +
                    '<div class="flex items-center justify-between mb-2">' +
                        '<h3 class="text-sm font-semibold text-viper-cyan uppercase tracking-wider">Movement Map</h3>' +
                        '<label class="flex items-center gap-1 text-xs text-gray-400 cursor-pointer">' +
                            '<input type="checkbox" data-flk="toggle-trace" checked class="accent-viper-cyan"> Travel trace' +
                        '</label>' +
                    '</div>' +
                    '<div id="flockMap" class="flock-map"></div>' +
                    '<div id="flockPlayback" class="mt-2"></div>' +
                '</div>' +
            '</div>' +
            renderPushBar() +
        '</div>';
    }

    function renderEmptyState() {
        return '' +
        '<div id="flockRoot" class="max-w-3xl mx-auto py-10">' +
            '<div class="text-center mb-8">' +
                '<div class="text-5xl mb-3">\uD83D\uDCF7</div>' +
                '<h2 class="text-2xl font-bold text-white mb-2">FLOCK \u2014 License Plate Reader</h2>' +
                '<p class="text-gray-400 text-sm max-w-xl mx-auto">Load a Flock Safety search-results export to map every ' +
                'plate read, replay the vehicle\u2019s movement over time, and push the hits that matter onto the Connection Board.</p>' +
            '</div>' +
            '<div id="flockDrop" class="flock-drop">' +
                '<div class="text-3xl mb-2">\u2B07</div>' +
                '<div class="text-white font-medium mb-1">Drop the Flock export here</div>' +
                '<div class="text-gray-500 text-xs mb-4">Flock_Safety_Search_Results_\u2026 \u00B7 .csv or .xlsx</div>' +
                '<div class="flex items-center justify-center gap-3">' +
                    '<button data-flk="pick-file" class="px-4 py-2 bg-viper-purple hover:bg-viper-purple/80 rounded text-white text-sm font-medium">Choose file\u2026</button>' +
                    '<button data-flk="from-evidence" class="px-4 py-2 bg-viper-card border border-viper-cyan/40 hover:border-viper-cyan rounded text-viper-cyan text-sm font-medium">\uD83D\uDCE6 Find in Evidence</button>' +
                '</div>' +
            '</div>' +
            '<input type="file" id="flockFileInput" accept=".csv,.xlsx,.xlsm,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" class="hidden">' +
            '<div class="mt-8 grid grid-cols-3 gap-3 text-center">' +
                tile('\uD83D\uDDFA', 'Map every read', 'Camera-accurate coordinates, clustered and colour-coded per plate.') +
                tile('\u25B6', 'Replay the route', 'Scrub or play the vehicle\u2019s track in chronological order.') +
                tile('\uD83E\uDDF5', 'Build the board', 'Tick the significant hits and push them to the Connection Board.') +
            '</div>' +
        '</div>';
    }

    function tile(icon, title, body) {
        return '<div class="bg-viper-card/40 border border-gray-700 rounded-lg p-4">' +
            '<div class="text-2xl mb-2">' + icon + '</div>' +
            '<div class="text-white text-sm font-medium mb-1">' + esc(title) + '</div>' +
            '<div class="text-gray-500 text-xs leading-relaxed">' + esc(body) + '</div>' +
        '</div>';
    }

    function renderToolbar(imports) {
        var packs = mod().getImagePacks();
        var packNote = packs.length
            ? '<span class="text-[10px] text-viper-cyan">\uD83D\uDDBC ' + packs.reduce(function (n, p) { return n + (p.count || 0); }, 0) + ' photos attached</span>'
            : '<span class="text-[10px] text-gray-600">no photo pack</span>';
        return '' +
        '<div class="flex items-center justify-between gap-3 flex-wrap">' +
            '<div>' +
                '<h2 class="text-lg font-bold text-white flex items-center gap-2"><span>\uD83D\uDCF7</span> FLOCK \u2014 License Plate Reader</h2>' +
                '<p class="text-xs text-gray-500">' + imports.length + ' import' + (imports.length === 1 ? '' : 's') + ' loaded \u00B7 ' + packNote + '</p>' +
            '</div>' +
            '<div class="flex items-center gap-2">' +
                '<button data-flk="pick-file" class="px-3 py-1.5 bg-viper-purple hover:bg-viper-purple/80 rounded text-white text-xs font-medium">+ Load file</button>' +
                '<button data-flk="from-evidence" class="px-3 py-1.5 bg-viper-card border border-viper-cyan/40 hover:border-viper-cyan rounded text-viper-cyan text-xs font-medium">\uD83D\uDCE6 Find in Evidence</button>' +
                '<button data-flk="attach-images" class="px-3 py-1.5 bg-viper-card border border-gray-600 hover:border-viper-cyan rounded text-gray-300 text-xs">\uD83D\uDDBC Photos\u2026</button>' +
                '<button data-flk="manage" class="px-3 py-1.5 bg-viper-card border border-gray-600 hover:border-gray-400 rounded text-gray-300 text-xs">Manage imports</button>' +
            '</div>' +
            '<input type="file" id="flockFileInput" accept=".csv,.xlsx,.xlsm,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" class="hidden">' +
        '</div>';
    }

    function renderFilterBar(imports) {
        var f = FL.filters;
        var impOpts = ['<option value="all">All imports</option>'].concat(imports.map(function (i) {
            return '<option value="' + esc(i.id) + '"' + (f.importId === i.id ? ' selected' : '') + '>' +
                esc(i.name) + ' (' + (i.hits || []).length + ')</option>';
        })).join('');
        var plateOpts = ['<option value="all">All plates</option>'].concat(allPlates().map(function (p) {
            return '<option value="' + esc(p) + '"' + (f.plate === p ? ' selected' : '') + '>' + esc(p) + '</option>';
        })).join('');

        return '' +
        '<div class="bg-viper-card/40 border border-gray-700 rounded-lg p-3 flex items-end gap-3 flex-wrap">' +
            field('Import', '<select data-flk="f-import" class="flock-input">' + impOpts + '</select>') +
            field('Plate', '<select data-flk="f-plate" class="flock-input">' + plateOpts + '</select>') +
            field('From', '<input type="date" data-flk="f-from" value="' + esc(f.from) + '" class="flock-input">') +
            field('To', '<input type="date" data-flk="f-to" value="' + esc(f.to) + '" class="flock-input">') +
            field('Search camera / agency / vehicle',
                  '<input type="text" data-flk="f-q" value="' + esc(f.q) + '" placeholder="e.g. Milliken, Hemet, silver" class="flock-input w-56">') +
            '<button data-flk="f-reset" class="px-3 py-1.5 text-xs bg-viper-card border border-gray-600 rounded hover:border-gray-400 text-gray-300">Reset</button>' +
        '</div>';
    }

    function field(label, control) {
        return '<div class="flex flex-col gap-1">' +
            '<label class="text-[10px] uppercase tracking-wider text-gray-500">' + esc(label) + '</label>' +
            control + '</div>';
    }

    function renderPushBar() {
        return '' +
        '<div id="flockPushBar" class="sticky bottom-0 bg-viper-dark/95 backdrop-blur border border-viper-cyan/30 rounded-lg p-3 flex items-center justify-between gap-3 flex-wrap">' +
            '<div class="text-sm text-gray-300"><span id="flockSelCount" class="text-viper-cyan font-bold">0</span> hit(s) queued for the Connection Board</div>' +
            '<div class="flex items-center gap-2">' +
                '<button data-flk="clear-sel" class="px-3 py-1.5 text-xs bg-viper-card border border-gray-600 rounded hover:border-gray-400 text-gray-300">Clear queue</button>' +
                '<button data-flk="push-board" class="px-4 py-1.5 text-sm bg-viper-cyan/20 border border-viper-cyan rounded text-viper-cyan font-medium hover:bg-viper-cyan/30">\uD83E\uDDF5 Push to Connection Board</button>' +
            '</div>' +
        '</div>';
    }

    // ── stats strip ──────────────────────────────────────────────────
    function renderStats() {
        var host = document.getElementById('flockStats');
        if (!host) return;
        var hits = FL.rendered;
        if (!hits.length) { host.innerHTML = ''; return; }
        var plates = {}, cams = {}, nets = {}, geo = 0;
        hits.forEach(function (h) {
            plates[h.plate] = 1;
            if (h.camera) cams[h.camera] = 1;
            if (h.network) nets[h.network] = 1;
            if (h.lat != null) geo++;
        });
        var dated = hits.filter(function (h) { return h.tUtcMs != null; });
        var span = '';
        if (dated.length > 1) {
            var hrs = (dated[dated.length - 1].tUtcMs - dated[0].tUtcMs) / 3600000;
            span = hrs >= 48 ? (hrs / 24).toFixed(1) + ' days' : hrs.toFixed(1) + ' hrs';
        }
        host.innerHTML =
            '<div class="flex items-center gap-4 flex-wrap text-xs bg-viper-card/30 border border-gray-700 rounded-lg px-3 py-2">' +
                stat(hits.length.toLocaleString(), 'reads shown') +
                stat(Object.keys(plates).length, 'plate(s)') +
                stat(Object.keys(cams).length, 'camera(s)') +
                stat(Object.keys(nets).length, 'network(s)') +
                (span ? stat(span, 'span') : '') +
                stat(geo.toLocaleString(), 'mapped') +
            '</div>';
    }
    function stat(v, l) {
        return '<div><span class="text-viper-cyan font-bold">' + esc(String(v)) + '</span> ' +
               '<span class="text-gray-500">' + esc(l) + '</span></div>';
    }

    // ── hit cards ────────────────────────────────────────────────────
    function renderList() {
        var host = document.getElementById('flockList');
        if (!host) return;
        var m = mod();
        var hits = FL.rendered;
        if (!hits.length) {
            host.innerHTML = '<div class="text-center text-gray-500 text-sm py-10 border border-dashed border-gray-700 rounded-lg">No reads match these filters.</div>';
            return;
        }
        var sel = m.getSelected();
        var plates = allPlates();
        var shown = hits.slice(0, FL.listLimit);
        var html = shown.map(function (h, i) {
            // Leg stats compare against the previous hit OF THE SAME PLATE, so a
            // multi-plate view never reports a bogus 400 mph between two cars.
            var prev = null;
            for (var j = i - 1; j >= 0; j--) { if (shown[j].plate === h.plate) { prev = shown[j]; break; } }
            return card(h, i + 1, prev, !!sel[h.id], plateColor(h.plate, plates));
        }).join('');

        if (hits.length > shown.length) {
            html += '<button data-flk="more" class="w-full py-2 text-xs text-viper-cyan border border-viper-cyan/30 rounded hover:bg-viper-cyan/10">' +
                'Show ' + Math.min(300, hits.length - shown.length) + ' more (' + (hits.length - shown.length).toLocaleString() + ' hidden)</button>';
        }
        host.innerHTML = html;
        observeThumbs();
    }

    function card(h, seq, prev, selected, color) {
        var m = mod(), P = parser();
        var leg = (P && prev) ? P.legStats(prev, h) : null;
        var dirLabel = h.dir ? ((P && P.DIR_LABEL[h.dir]) || h.dir) : '';
        var vehicle = [h.color, h.make, h.body].filter(Boolean).join(' ');
        var shots = m.imagesForHit(h);

        var legHtml = '';
        if (leg && (leg.miles != null || leg.seconds != null)) {
            var bits = [];
            if (leg.miles != null) bits.push(leg.miles.toFixed(1) + ' mi');
            if (leg.seconds != null) bits.push(humanGap(leg.seconds));
            if (leg.mph != null) bits.push(Math.round(leg.mph) + ' mph');
            legHtml = '<div class="flock-leg' + (leg.impossible ? ' flock-leg-warn' : '') + '">' +
                (leg.impossible ? '\u26A0 ' : '\u2193 ') + esc(bits.join(' \u00B7 ')) +
                (leg.impossible ? ' \u2014 implausible, verify read' : '') +
            '</div>';
        }

        // Thumbnail is lazy: the pack is ~200 photos and eagerly turning them
        // all into data URLs would be tens of MB of strings. An
        // IntersectionObserver fills these in as the list scrolls.
        var thumbHtml = shots.length
            ? '<div class="flock-thumb" data-flk="thumb" data-hit-img="' + esc(h.id) + '" title="Click to enlarge">' +
                  '<div class="flock-thumb-spin"></div>' +
                  (shots.length > 1 ? '<span class="flock-thumb-count">' + shots.length + '</span>' : '') +
              '</div>'
            : '';

        return '' +
        legHtml +
        '<div class="flock-card' + (selected ? ' flock-card-sel' : '') + '" data-hit="' + esc(h.id) + '" style="--flk-accent:' + color + '">' +
            '<div class="flock-card-head">' +
                '<input type="checkbox" data-flk="sel" ' + (selected ? 'checked' : '') + ' class="accent-viper-cyan cursor-pointer" title="Queue for Connection Board">' +
                '<span class="flock-seq">#' + seq + '</span>' +
                '<span class="flock-plate">' + esc(h.plate) + '</span>' +
                (h.state ? '<span class="flock-state">' + esc(h.state) + '</span>' : '') +
                '<span class="flock-time">' + esc(m.shortHitTime(h)) + '</span>' +
            '</div>' +
            '<div class="flock-card-main">' +
                thumbHtml +
                '<div class="flock-card-body">' +
                    row('When', esc(h.localDate || '') + ' ' + esc(h.localTime || '') +
                        (h.approxTime ? ' <span class="text-amber-400" title="No timezone in the export; shown in this machine\'s local time">(approx)</span>' : '')) +
                    row('Camera', esc(h.camera || '\u2014') + (dirLabel ? ' <span class="flock-dir">' + esc(dirLabel) + '</span>' : '')) +
                    row('Network', esc(h.network || '\u2014')) +
                    (vehicle ? row('Vehicle', esc(vehicle) + ' <span class="text-gray-600 text-[10px]">(classifier)</span>') : '') +
                    (h.identifiers ? row('Identifiers', esc(h.identifiers)) : '') +
                    (h.lat != null
                        ? row('Coords', esc(h.lat.toFixed(6) + ', ' + h.lng.toFixed(6)))
                        : '<div class="flock-row text-amber-400/80"><span class="flock-k">Coords</span> not provided \u2014 not mapped</div>') +
                '</div>' +
            '</div>' +
            '<div class="flock-card-actions">' +
                (h.lat != null ? '<button data-flk="focus" class="flock-btn">\uD83D\uDCCD Show on map</button>' : '') +
                (shots.length ? '<button data-flk="photos" class="flock-btn">\uD83D\uDDBC ' + shots.length + ' photo' + (shots.length === 1 ? '' : 's') + '</button>' : '') +
                '<button data-flk="push-one" class="flock-btn">\uD83E\uDDF5 Add to board</button>' +
            '</div>' +
        '</div>';
    }

    function row(k, vHtml) {
        return '<div class="flock-row"><span class="flock-k">' + esc(k) + '</span> ' + vHtml + '</div>';
    }

    function humanGap(sec) {
        sec = Math.abs(sec);
        if (sec < 90) return Math.round(sec) + ' sec';
        if (sec < 5400) return Math.round(sec / 60) + ' min';
        if (sec < 172800) return (sec / 3600).toFixed(1) + ' hrs';
        return (sec / 86400).toFixed(1) + ' days';
    }

    // ── lazy thumbnails ──────────────────────────────────────────────
    // A pack holds ~200 JPEGs at ~79 KB each. Turning them all into data
    // URLs up front would be ~17 MB of strings and a stutter on every
    // filter change, so each thumb is fetched only when it scrolls into
    // view and the result is cached in the module layer.
    var _thumbObserver = null;

    function observeThumbs() {
        if (_thumbObserver) { _thumbObserver.disconnect(); _thumbObserver = null; }
        var host = document.getElementById('flockList');
        if (!host || typeof IntersectionObserver === 'undefined') return;

        _thumbObserver = new IntersectionObserver(function (entries) {
            entries.forEach(function (en) {
                if (!en.isIntersecting) return;
                var el = en.target;
                _thumbObserver.unobserve(el);
                fillThumb(el);
            });
        }, { root: host, rootMargin: '200px' });

        host.querySelectorAll('[data-hit-img]').forEach(function (el) { _thumbObserver.observe(el); });
    }

    function fillThumb(el) {
        var hitId = el.getAttribute('data-hit-img');
        var h = FL.rendered.find(function (x) { return x.id === hitId; });
        if (!h) return;
        var shots = mod().imagesForHit(h);
        if (!shots.length) return;
        // The "N photos" badge must survive a failed read — losing it would
        // hide the fact that more shots exist for this plate read.
        var badge = shots.length > 1
            ? '<span class="flock-thumb-count">' + shots.length + '</span>'
            : '';
        mod().readImage(shots[0]).then(function (dataUrl) {
            if (!el.isConnected) return;
            el.innerHTML = dataUrl
                ? '<img src="' + dataUrl + '" alt="Plate read">' + badge
                : '<span class="flock-thumb-fail" title="Image could not be read from the pack">\u26A0</span>' + badge;
        });
    }

    // ── photo lightbox ───────────────────────────────────────────────
    function openPhotos(hitId) {
        var m = mod();
        var h = FL.rendered.find(function (x) { return x.id === hitId; });
        if (!h) return;
        var shots = m.imagesForHit(h);
        if (!shots.length) { toast('No photo in the attached pack for this read', 'warning'); return; }

        var head = h.plate + ' \u00B7 ' + m.formatHitTime(h);
        var body =
            '<div class="text-xs text-gray-400 mb-2">' + esc(h.camera || '') +
                (h.network ? ' \u00B7 ' + esc(h.network) : '') + '</div>' +
            '<div id="flockShots" class="flock-shots">' +
                shots.map(function (s, i) {
                    return '<div class="flock-shot" data-shot="' + i + '"><div class="flock-thumb-spin"></div></div>';
                }).join('') +
            '</div>' +
            '<p class="text-[10px] text-gray-600 mt-3">Photos come from the Flock image pack and are matched to this read by camera and capture second. ' +
            'A read with no photo simply was not included in the image download \u2014 it does not mean the read is invalid.</p>';

        showModal('Plate read \u2014 ' + head, body, 'max-w-3xl');

        shots.forEach(function (s, i) {
            m.readImage(s).then(function (dataUrl) {
                var slot = document.querySelector('#flockShots [data-shot="' + i + '"]');
                if (!slot) return;
                slot.innerHTML = dataUrl
                    ? '<img src="' + dataUrl + '" alt="Plate read ' + (i + 1) + '">'
                    : '<span class="flock-thumb-fail">\u26A0 unreadable</span>';
            });
        });
    }

    // ── map ──────────────────────────────────────────────────────────
    function initMap() {
        var el = document.getElementById('flockMap');
        if (!el || typeof L === 'undefined') return;
        destroyMap();
        FL.map = L.map(el, { zoomControl: true, preferCanvas: true }).setView([39.8283, -98.5795], 4);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '\u00A9 OpenStreetMap', maxZoom: 19
        }).addTo(FL.map);
        drawMap();
    }

    function destroyMap() {
        stopPlayback();
        if (FL.map) { try { FL.map.remove(); } catch (_) {} }
        FL.map = null; FL.cluster = null; FL.markers = {}; FL.trace = null; FL.focusRing = null;
    }

    function drawMap() {
        if (!FL.map) return;
        if (FL.cluster) { try { FL.map.removeLayer(FL.cluster); } catch (_) {} FL.cluster = null; }
        if (FL.trace) { try { FL.map.removeLayer(FL.trace); } catch (_) {} FL.trace = null; }
        FL.markers = {};

        var geo = FL.rendered.filter(function (h) { return h.lat != null; });
        if (!geo.length) return;

        var plates = allPlates();
        var useCluster = typeof L.markerClusterGroup === 'function';
        // Flock parks many reads on the exact same camera coordinate;
        // spiderfy is what makes those individually clickable.
        var layer = useCluster
            ? L.markerClusterGroup({ spiderfyOnMaxZoom: true, showCoverageOnHover: false, maxClusterRadius: 35 })
            : L.layerGroup();

        geo.forEach(function (h, i) {
            var color = plateColor(h.plate, plates);
            var mk = L.circleMarker([h.lat, h.lng], {
                radius: 6, color: '#0b0e14', weight: 1.5, fillColor: color, fillOpacity: 0.9
            });
            mk.bindPopup(popupHtml(h, i + 1));
            mk.on('click', function () { highlightCard(h.id); });
            mk.on('popupopen', function () { fillPopupImage(h); });
            FL.markers[h.id] = mk;
            layer.addLayer(mk);
        });

        FL.cluster = layer;
        FL.map.addLayer(layer);

        var showTrace = true;
        var tb = document.querySelector('[data-flk="toggle-trace"]');
        if (tb) showTrace = tb.checked;
        if (showTrace) drawTrace(geo, plates);

        try {
            var bounds = L.latLngBounds(geo.map(function (h) { return [h.lat, h.lng]; }));
            FL.map.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 });
        } catch (_) {}

        buildPlayback(geo);
    }

    // One polyline per plate, drawn in chronological order.
    function drawTrace(geo, plates) {
        var byPlate = {};
        geo.forEach(function (h) { (byPlate[h.plate] = byPlate[h.plate] || []).push(h); });
        var group = [];
        Object.keys(byPlate).forEach(function (p) {
            var pts = byPlate[p].filter(function (h) { return h.tUtcMs != null; });
            if (pts.length < 2) return;
            group.push(L.polyline(pts.map(function (h) { return [h.lat, h.lng]; }), {
                color: plateColor(p, plates), weight: 2, opacity: 0.45, dashArray: '6,6'
            }));
        });
        if (!group.length) return;
        FL.trace = L.layerGroup(group).addTo(FL.map);
    }

    function popupHtml(h, seq) {
        var m = mod(), P = parser();
        var dirLabel = h.dir ? ((P && P.DIR_LABEL[h.dir]) || h.dir) : '';
        var vehicle = [h.color, h.make, h.body].filter(Boolean).join(' ');
        var shots = m.imagesForHit(h);
        return '<div style="min-width:190px" data-popup-hit="' + esc(h.id) + '">' +
            '<div style="font-weight:700;font-size:13px">#' + seq + ' \u00B7 ' + esc(h.plate) + '</div>' +
            '<div style="font-size:11px;color:#94a3b8;margin-bottom:4px">' + esc(m.formatHitTime(h)) + '</div>' +
            (shots.length ? '<div class="flock-pop-img" data-pop-img="' + esc(h.id) + '">loading photo\u2026</div>' : '') +
            '<div style="font-size:11px">' + esc(h.camera || '') + '</div>' +
            (dirLabel ? '<div style="font-size:11px;color:#06b6d4">' + esc(dirLabel) + '</div>' : '') +
            (vehicle ? '<div style="font-size:11px;color:#94a3b8">' + esc(vehicle) + '</div>' : '') +
            '<div style="font-size:10px;color:#64748b;margin-top:4px">' + esc(h.network || '') + '</div>' +
        '</div>';
    }

    /** Fill a marker popup's photo slot once Leaflet has rendered it. */
    function fillPopupImage(h) {
        var m = mod();
        var shots = m.imagesForHit(h);
        if (!shots.length) return;
        var slot = document.querySelector('[data-pop-img="' + h.id + '"]');
        if (!slot) return;
        m.readImage(shots[0]).then(function (dataUrl) {
            var el = document.querySelector('[data-pop-img="' + h.id + '"]');
            if (!el) return;
            el.innerHTML = dataUrl
                ? '<img src="' + dataUrl + '" alt="Plate read">'
                : '<span style="color:#fbbf24">photo unreadable</span>';
        });
    }

    function highlightCard(hitId) {
        var el = document.querySelector('.flock-card[data-hit="' + hitId + '"]');
        if (!el) return;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('flock-flash');
        setTimeout(function () { el.classList.remove('flock-flash'); }, 900);
    }

    function focusHit(hitId) {
        var h = FL.rendered.find(function (x) { return x.id === hitId; });
        if (!h || h.lat == null || !FL.map) return;
        FL.map.setView([h.lat, h.lng], 17, { animate: true });
        var mk = FL.markers[hitId];
        if (mk && mk.openPopup) { try { mk.openPopup(); } catch (_) {} }
        if (FL.focusRing) { try { FL.map.removeLayer(FL.focusRing); } catch (_) {} }
        FL.focusRing = L.circleMarker([h.lat, h.lng], {
            radius: 16, color: '#fff', weight: 2, fill: false, dashArray: '4,4'
        }).addTo(FL.map);
    }

    // ── playback ─────────────────────────────────────────────────────
    // Even-paced: a fixed number of reads per second regardless of the real
    // time gaps, so an 8-day return does not sit motionless for 90% of the
    // run. The clock label always shows the TRUE capture time.
    function buildPlayback(geo) {
        var host = document.getElementById('flockPlayback');
        if (!host) return;
        stopPlayback();

        var byPlate = {};
        geo.forEach(function (h) {
            if (h.tUtcMs == null) return;
            (byPlate[h.plate] = byPlate[h.plate] || []).push(h);
        });
        var keys = Object.keys(byPlate).filter(function (p) { return byPlate[p].length >= 2; });
        if (!keys.length) {
            host.innerHTML = '<div class="text-xs text-gray-600 text-center py-2 border border-gray-800 rounded">Need at least two timestamped, mapped reads for playback.</div>';
            return;
        }
        keys.sort(function (a, b) { return byPlate[b].length - byPlate[a].length; });
        FL.pb.tracks = byPlate;
        setTrack(keys[0]);

        host.innerHTML = '' +
        '<div class="bg-viper-dark/50 border border-viper-cyan/20 rounded-lg p-3">' +
            '<div class="flex items-center gap-3 flex-wrap">' +
                '<button data-flk="play" class="w-9 h-9 flex items-center justify-center bg-viper-cyan/20 hover:bg-viper-cyan/30 border border-viper-cyan rounded text-viper-cyan text-sm">\u25B6</button>' +
                '<div class="flex items-center gap-1">' +
                    '<span class="text-xs text-gray-400">Trace</span>' +
                    '<select data-flk="pb-track" class="flock-input">' +
                        keys.map(function (k) {
                            return '<option value="' + esc(k) + '">' + esc(k) + ' (' + byPlate[k].length + ')</option>';
                        }).join('') +
                    '</select>' +
                '</div>' +
                '<select data-flk="pb-speed" class="flock-input">' +
                    '<option value="0.5">0.5\u00D7</option><option value="1" selected>1\u00D7</option>' +
                    '<option value="2">2\u00D7</option><option value="4">4\u00D7</option><option value="8">8\u00D7</option>' +
                '</select>' +
                '<label class="flex items-center gap-1 text-xs text-gray-300 cursor-pointer">' +
                    '<input type="checkbox" data-flk="pb-chase" ' + (FL.pb.chase ? 'checked' : '') + ' class="accent-viper-cyan"> Chase' +
                '</label>' +
                '<span data-flk="pb-clock" class="text-xs font-mono text-viper-cyan ml-auto"></span>' +
            '</div>' +
            '<input type="range" data-flk="pb-scrub" min="0" max="1000" value="0" step="1" class="w-full mt-2 accent-viper-cyan">' +
        '</div>';
        renderPlayhead();
    }

    function setTrack(plate) {
        var pts = (FL.pb.tracks || {})[plate] || [];
        FL.pb.trackKey = plate;
        FL.pb.track = pts.slice().sort(function (a, b) { return a.tUtcMs - b.tUtcMs; });
        FL.pb.n = FL.pb.track.length;
        FL.pb.prog = 0;
        FL.pb.color = plateColor(plate, allPlates());
        if (FL.pb.tail && FL.map) { try { FL.map.removeLayer(FL.pb.tail); } catch (_) {} }
        FL.pb.tail = null;
    }

    function stopPlayback() {
        if (FL.pb.raf) { cancelAnimationFrame(FL.pb.raf); FL.pb.raf = null; }
        FL.pb.playing = false;
        if (FL.map) {
            if (FL.pb.marker) { try { FL.map.removeLayer(FL.pb.marker); } catch (_) {} }
            if (FL.pb.tail) { try { FL.map.removeLayer(FL.pb.tail); } catch (_) {} }
        }
        FL.pb.marker = null; FL.pb.tail = null;
        FL.pb.track = []; FL.pb.n = 0; FL.pb.prog = 0;
    }

    function togglePlay() {
        if (!FL.pb.n) return;
        FL.pb.playing = !FL.pb.playing;
        var btn = document.querySelector('[data-flk="play"]');
        if (btn) btn.textContent = FL.pb.playing ? '\u23F8' : '\u25B6';
        if (FL.pb.playing) {
            if (FL.pb.prog >= FL.pb.n - 1) FL.pb.prog = 0;
            FL.pb.lastFrame = performance.now();
            FL.pb.raf = requestAnimationFrame(tick);
        } else if (FL.pb.raf) {
            cancelAnimationFrame(FL.pb.raf); FL.pb.raf = null;
        }
    }

    function tick(now) {
        if (!FL.pb.playing || !FL.map || !document.getElementById('flockMap')) {
            FL.pb.raf = null; FL.pb.playing = false; return;
        }
        var dt = (now - FL.pb.lastFrame) / 1000;
        FL.pb.lastFrame = now;
        var perSec = Math.max(1, FL.pb.n - 1) / FL.pb.baseSec;
        FL.pb.prog += perSec * FL.pb.speed * dt;
        if (FL.pb.prog >= FL.pb.n - 1) {
            FL.pb.prog = FL.pb.n - 1;
            FL.pb.playing = false;
            var btn = document.querySelector('[data-flk="play"]');
            if (btn) btn.textContent = '\u25B6';
            renderPlayhead();
            FL.pb.raf = null;
            return;
        }
        renderPlayhead();
        FL.pb.raf = requestAnimationFrame(tick);
    }

    function renderPlayhead() {
        if (!FL.map || !FL.pb.n) return;
        var tr = FL.pb.track, n = tr.length;
        var prog = Math.max(0, Math.min(FL.pb.prog, n - 1));
        var i = Math.floor(prog), f = prog - i;
        var a = tr[i], b = tr[Math.min(i + 1, n - 1)];
        var lat = a.lat + (b.lat - a.lat) * f;
        var lng = a.lng + (b.lng - a.lng) * f;
        var t = a.tUtcMs + (b.tUtcMs - a.tUtcMs) * f;
        var color = FL.pb.color || '#06b6d4';

        var TAIL = 120;
        var pts = tr.slice(Math.max(0, i - TAIL), i + 1).map(function (p) { return [p.lat, p.lng]; });
        pts.push([lat, lng]);
        if (!FL.pb.tail) {
            FL.pb.tail = L.polyline(pts, { color: color, weight: 3, opacity: 0.9 }).addTo(FL.map);
        } else {
            FL.pb.tail.setLatLngs(pts);
            FL.pb.tail.setStyle({ color: color });
        }
        if (!FL.pb.marker) {
            FL.pb.marker = L.circleMarker([lat, lng], {
                radius: 8, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1
            }).addTo(FL.map);
        } else {
            FL.pb.marker.setLatLng([lat, lng]);
            FL.pb.marker.setStyle({ fillColor: color });
        }
        if (FL.pb.chase) { try { FL.map.panTo([lat, lng], { animate: false }); } catch (_) {} }

        var clock = document.querySelector('[data-flk="pb-clock"]');
        if (clock) {
            var cur = tr[Math.round(prog)] || a;
            clock.textContent = (cur.localDate || '') + ' ' + (cur.localTime || new Date(t).toLocaleString());
        }
        var scrub = document.querySelector('[data-flk="pb-scrub"]');
        if (scrub && document.activeElement !== scrub) {
            scrub.value = Math.round((prog / Math.max(1, n - 1)) * 1000);
        }
    }

    // ── selection + board push ───────────────────────────────────────
    function refreshSelCount() {
        var el = document.getElementById('flockSelCount');
        if (el) el.textContent = String(mod().selectedCount());
    }

    /**
     * Downscale a plate-read photo before it goes onto the Connection Board.
     * Board pins persist to localStorage, and a full 79 KB JPEG per pin would
     * blow the quota on a busy case. ~140px at q0.6 is ~6-8 KB and is plenty
     * for a pin thumbnail; the full-resolution shot stays in the pack.
     */
    function thumbnailFor(hit) {
        var shots = mod().imagesForHit(hit);
        if (!shots.length) return Promise.resolve('');
        return mod().readImage(shots[0]).then(function (dataUrl) {
            if (!dataUrl) return '';
            return new Promise(function (resolve) {
                var img = new Image();
                img.onload = function () {
                    try {
                        var MAX = 140;
                        var scale = Math.min(1, MAX / Math.max(img.width, img.height));
                        var c = document.createElement('canvas');
                        c.width = Math.max(1, Math.round(img.width * scale));
                        c.height = Math.max(1, Math.round(img.height * scale));
                        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
                        resolve(c.toDataURL('image/jpeg', 0.6));
                    } catch (_) { resolve(''); }
                };
                img.onerror = function () { resolve(''); };
                img.src = dataUrl;
            });
        }, function () { return ''; });
    }

    function attachThumbnails(hits) {
        return Promise.all(hits.map(function (h) {
            return thumbnailFor(h).then(function (t) {
                return t ? Object.assign({}, h, { _photo: t }) : h;
            });
        }));
    }

    function pushSelected() {
        var m = mod();
        var hits = m.selectedHits();
        if (!hits.length) { toast('Tick the hits you want on the board first', 'warning'); return; }
        var withGeo = hits.filter(function (h) { return h.lat != null; });
        if (!withGeo.length) { toast('None of the queued hits have coordinates — nothing to plot', 'error'); return; }
        var skipped = hits.length - withGeo.length;
        toast('Preparing ' + withGeo.length + ' pin(s)\u2026', 'info');
        attachThumbnails(withGeo).then(function (prepared) {
            var r = m.pushToConnectionBoard(prepared);
            if (!r.ok) { toast(r.error || 'Push failed', 'error'); return; }
            var photos = prepared.filter(function (h) { return h._photo; }).length;
            toast('Connection Board: ' + r.added + ' pin(s) added' +
                  (r.updated ? ', ' + r.updated + ' updated' : '') +
                  (photos ? ' \u00B7 ' + photos + ' with photo' : '') +
                  (skipped ? ' \u2014 ' + skipped + ' skipped (no coordinates)' : ''), 'success');
        });
    }

    function pushOne(hitId) {
        var m = mod();
        var h = FL.rendered.find(function (x) { return x.id === hitId; });
        if (!h) return;
        if (h.lat == null) { toast('That read has no coordinates — cannot plot it', 'error'); return; }
        attachThumbnails([h]).then(function (prepared) {
            var r = m.pushToConnectionBoard(prepared);
            if (!r.ok) { toast(r.error || 'Push failed', 'error'); return; }
            toast(r.added ? 'Added ' + h.plate + ' to the Connection Board' : 'Already on the board — refreshed', 'success');
        });
    }

    // ── ingest dialogs ───────────────────────────────────────────────
    function openEvidencePicker() {
        var m = mod();
        // Image zips are attached separately (Photos… button), so the
        // spreadsheet picker only offers spreadsheets.
        var list = m.findCandidatesInEvidence().filter(function (c) { return c.kind !== 'images'; });
        var zipCount = m.findCandidatesInEvidence().length - list.length;
        var body;
        if (!list.length) {
            body = '<div class="text-center py-8 text-gray-400 text-sm">' +
                'No spreadsheet files found in this case\u2019s Evidence.<br>' +
                '<span class="text-gray-600 text-xs">Add the Flock export (.csv or .xlsx) under the Evidence tab first, or use \u201CLoad file\u201D to read it straight off disk.</span></div>';
        } else {
            body = '<div class="space-y-2 max-h-80 overflow-y-auto">' + list.map(function (c, i) {
                return '<button data-flk="ev-pick" data-idx="' + i + '" class="w-full text-left p-3 bg-viper-card/60 border ' +
                    (c.likely ? 'border-viper-cyan/50' : 'border-gray-700') +
                    ' rounded hover:border-viper-cyan transition">' +
                    '<div class="flex items-center gap-2">' +
                        (c.likely ? '<span class="text-[9px] uppercase tracking-wider bg-viper-cyan/20 text-viper-cyan px-1.5 py-0.5 rounded">Likely Flock</span>' : '') +
                        '<span class="text-[9px] uppercase tracking-wider bg-gray-700/60 text-gray-300 px-1.5 py-0.5 rounded">' + esc(c.kind === 'xlsx' ? 'XLSX' : 'CSV') + '</span>' +
                        '<span class="text-white text-sm font-medium truncate">' + esc(c.fileName) + '</span>' +
                    '</div>' +
                    '<div class="text-xs text-gray-500 mt-1">Tag ' + esc(c.tag || '\u2014') + ' \u00B7 ' + esc(c.description || '') +
                    (c.size ? ' \u00B7 ' + Math.max(1, Math.round(c.size / 1024)) + ' KB' : '') + '</div>' +
                '</button>';
            }).join('') + '</div>';
        }
        if (zipCount) {
            body += '<p class="text-[10px] text-gray-500 mt-3">' + zipCount + ' .zip file(s) in Evidence are not listed here \u2014 ' +
                    'use <span class="text-viper-cyan">\uD83D\uDDBC Photos\u2026</span> to attach a Flock image pack.</p>';
        }
        FL._evCandidates = list;
        showModal('Find Flock export in Evidence', body);
    }

    function openImagePackModal() {
        var m = mod();
        var all = m.findCandidatesInEvidence();
        var zips = all.filter(function (c) { return c.kind === 'images'; });
        var packs = m.getImagePacks();

        var attached = packs.length
            ? '<div class="mb-4"><div class="text-[10px] uppercase tracking-wider text-gray-500 mb-2">Attached</div>' +
                packs.map(function (p) {
                    return '<div class="p-2 bg-viper-card/60 border border-viper-cyan/30 rounded flex items-center justify-between gap-2 mb-2">' +
                        '<div class="min-w-0"><div class="text-white text-xs truncate">' + esc(p.name) + '</div>' +
                        '<div class="text-[10px] text-gray-500">' + (p.count || 0) + ' photos' +
                        (p.evidenceTag ? ' \u00B7 ' + esc(p.evidenceTag) : '') + '</div></div>' +
                        '<button data-flk="detach-pack" data-id="' + esc(p.id) + '" class="shrink-0 px-2 py-1 text-[10px] border border-red-500/40 text-red-400 rounded hover:bg-red-500/10">Detach</button>' +
                    '</div>';
                }).join('') + '</div>'
            : '';

        var list = zips.length
            ? '<div class="text-[10px] uppercase tracking-wider text-gray-500 mb-2">Zips in Evidence</div>' +
              '<div class="space-y-2 max-h-64 overflow-y-auto">' + zips.map(function (c, i) {
                  return '<button data-flk="pack-pick" data-idx="' + i + '" class="w-full text-left p-3 bg-viper-card/60 border ' +
                      (c.likely ? 'border-viper-cyan/50' : 'border-gray-700') +
                      ' rounded hover:border-viper-cyan transition">' +
                      '<div class="flex items-center gap-2">' +
                          (c.likely ? '<span class="text-[9px] uppercase tracking-wider bg-viper-cyan/20 text-viper-cyan px-1.5 py-0.5 rounded">Likely Flock</span>' : '') +
                          '<span class="text-white text-sm font-medium truncate">' + esc(c.fileName) + '</span>' +
                      '</div>' +
                      '<div class="text-xs text-gray-500 mt-1">Tag ' + esc(c.tag || '\u2014') +
                      (c.size ? ' \u00B7 ' + Math.max(1, Math.round(c.size / 1048576)) + ' MB' : '') + '</div>' +
                  '</button>';
              }).join('') + '</div>'
            : '<div class="text-center py-6 text-gray-400 text-sm">No .zip files in this case\u2019s Evidence.<br>' +
              '<span class="text-gray-600 text-xs">Flock delivers plate photos as a separate zip download. Add it under the Evidence tab, then attach it here.</span></div>';

        FL._packCandidates = zips;
        showModal('Flock photo pack', attached + list);
    }

    function openManageModal() {
        var m = mod();
        var imports = m.getImports();
        var body = '<div class="space-y-2 max-h-80 overflow-y-auto">' + imports.map(function (i) {
            var span = i.span
                ? new Date(i.span.startMs).toLocaleDateString() + ' \u2192 ' + new Date(i.span.endMs).toLocaleDateString()
                : 'no dates';
            return '<div class="p-3 bg-viper-card/60 border border-gray-700 rounded flex items-start justify-between gap-3">' +
                '<div class="min-w-0">' +
                    '<div class="text-white text-sm font-medium truncate">' + esc(i.name) + '</div>' +
                    '<div class="text-xs text-gray-500 mt-1">' + (i.hits || []).length + ' reads \u00B7 ' +
                        (i.plates || []).length + ' plate(s) \u00B7 ' + esc(span) + '</div>' +
                    '<div class="text-[10px] text-gray-600 mt-0.5">' +
                        esc((i.format === 'xlsx' ? 'XLSX' : 'CSV') +
                            (i.sheetName ? ' \u00B7 sheet "' + i.sheetName + '"' : '') + ' \u00B7 ') +
                        esc(i.source === 'evidence' ? 'From Evidence' + (i.evidenceTag ? ' (' + i.evidenceTag + ')' : '') : 'Loaded from disk') +
                        ' \u00B7 ' + esc(new Date(i.importedAt).toLocaleString()) + '</div>' +
                    ((i.warnings || []).length
                        ? '<div class="text-[10px] text-amber-400/80 mt-1">\u26A0 ' + esc(i.warnings.join(' ')) + '</div>' : '') +
                '</div>' +
                '<button data-flk="del-import" data-id="' + esc(i.id) + '" class="shrink-0 px-2 py-1 text-xs border border-red-500/40 text-red-400 rounded hover:bg-red-500/10">Delete</button>' +
            '</div>';
        }).join('') + '</div>';
        showModal('Manage FLOCK imports', body);
    }

    function showModal(title, bodyHtml, widthClass) {
        closeModal();
        var wrap = document.createElement('div');
        wrap.id = 'flockModal';
        wrap.className = 'fixed inset-0 bg-black/70 flex items-center justify-center z-[9999] p-4';
        wrap.innerHTML =
            '<div class="bg-viper-dark border border-viper-cyan/30 rounded-lg w-full ' + (widthClass || 'max-w-lg') + ' shadow-2xl max-h-[90vh] overflow-y-auto">' +
                '<div class="flex items-center justify-between px-4 py-3 border-b border-gray-700 sticky top-0 bg-viper-dark">' +
                    '<h3 class="text-white font-semibold text-sm">' + esc(title) + '</h3>' +
                    '<button data-flk="modal-close" class="text-gray-400 hover:text-white text-lg leading-none">\u2715</button>' +
                '</div>' +
                '<div class="p-4">' + bodyHtml + '</div>' +
            '</div>';
        document.body.appendChild(wrap);
        wrap.addEventListener('click', function (e) { if (e.target === wrap) closeModal(); });
    }
    function closeModal() {
        var el = document.getElementById('flockModal');
        if (el && el.parentNode) el.parentNode.removeChild(el);
    }

    function afterImport(res) {
        if (!res || !res.ok) { toast((res && res.error) || 'Import failed', 'error'); return; }
        closeModal();
        var r = res.record;
        toast('Loaded ' + r.hits.length + ' plate read(s) across ' + r.plates.length + ' plate(s)' +
              (res.duplicate ? ' \u2014 note: this file looks like one already imported' : ''), 'success');
        (r.warnings || []).forEach(function (w) { toast(w, 'warning'); });
        // Full re-render: the toolbar, filters and empty-state all change shape.
        if (typeof window.renderTabContent === 'function') window.renderTabContent('flock');
    }

    // ── refresh pipeline ─────────────────────────────────────────────
    function refreshAll() {
        FL.rendered = currentHits();
        renderStats();
        renderList();
        drawMap();
        refreshSelCount();
    }

    // ── event wiring (delegated) ─────────────────────────────────────
    function initializeFlock() {
        M = window.FlockModule;
        var root = document.getElementById('flockRoot');
        if (!root) return;

        FL.listLimit = 300;
        FL.rendered = currentHits();

        // Delegated clicks for the whole tab AND the modal layer.
        if (!window.__flockDelegated) {
            window.__flockDelegated = true;
            document.addEventListener('click', onClick, false);
            document.addEventListener('change', onChange, false);
            document.addEventListener('input', onInput, false);
        }

        wireDropzone();
        renderStats();
        renderList();
        refreshSelCount();
        // Leaflet needs the container to have a real size before init.
        setTimeout(function () { if (document.getElementById('flockMap')) initMap(); }, 60);
    }

    function wireDropzone() {
        var dz = document.getElementById('flockDrop');
        if (!dz) return;
        ['dragenter', 'dragover'].forEach(function (ev) {
            dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('flock-drop-hot'); });
        });
        ['dragleave', 'drop'].forEach(function (ev) {
            dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('flock-drop-hot'); });
        });
        dz.addEventListener('drop', function (e) {
            var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
            if (f) mod().importFromFile(f).then(afterImport);
        });
    }

    function onClick(e) {
        var t = e.target && e.target.closest ? e.target.closest('[data-flk]') : null;
        if (!t || !mod()) return;
        var act = t.getAttribute('data-flk');
        var cardEl = e.target.closest('.flock-card');
        var hitId = cardEl && cardEl.getAttribute('data-hit');

        switch (act) {
            case 'pick-file': {
                var inp = document.getElementById('flockFileInput');
                if (inp) inp.click();
                break;
            }
            case 'from-evidence': openEvidencePicker(); break;
            case 'attach-images': openImagePackModal(); break;
            case 'manage': openManageModal(); break;
            case 'modal-close': closeModal(); break;
            case 'photos': if (hitId) openPhotos(hitId); break;
            case 'thumb': {
                var tid = t.getAttribute('data-hit-img');
                if (tid) openPhotos(tid);
                break;
            }

            case 'pack-pick': {
                var pidx = parseInt(t.getAttribute('data-idx'), 10);
                var pc = (FL._packCandidates || [])[pidx];
                if (!pc) return;
                t.disabled = true;
                t.innerHTML = '<div class="text-viper-cyan text-sm py-1">Reading pack\u2026</div>';
                mod().attachImagePack(pc).then(function (r) {
                    if (!r.ok) { toast(r.error || 'Could not attach that pack', 'error'); closeModal(); return; }
                    closeModal();
                    var miss = r.totalHits - r.matched;
                    toast('Attached ' + r.images + ' photos \u2014 matched ' + r.matched + ' of ' + r.totalHits + ' reads' +
                          (miss > 0 ? ' (' + miss + ' read(s) have no photo in this pack)' : ''),
                          miss > 0 ? 'warning' : 'success');
                    if (typeof window.renderTabContent === 'function') window.renderTabContent('flock');
                });
                break;
            }
            case 'detach-pack': {
                var packId = t.getAttribute('data-id');
                mod().detachImagePack(packId);
                closeModal();
                if (typeof window.renderTabContent === 'function') window.renderTabContent('flock');
                break;
            }

            case 'ev-pick': {
                var idx = parseInt(t.getAttribute('data-idx'), 10);
                var c = (FL._evCandidates || [])[idx];
                if (!c) return;
                t.disabled = true;
                t.innerHTML = '<div class="text-viper-cyan text-sm py-1">Reading\u2026</div>';
                mod().importFromEvidence(c).then(afterImport, function (err) {
                    toast('Could not read that evidence file: ' + ((err && err.message) || err), 'error');
                    closeModal();
                });
                break;
            }
            case 'del-import': {
                var id = t.getAttribute('data-id');
                Promise.resolve(
                    typeof window.viperConfirm === 'function'
                        ? window.viperConfirm('Delete this FLOCK import? The plate reads it holds will be removed from this case.', { danger: true, okText: 'Delete' })
                        : true
                ).then(function (yes) {
                    if (!yes) return;
                    mod().deleteImport(id);
                    closeModal();
                    if (typeof window.renderTabContent === 'function') window.renderTabContent('flock');
                });
                break;
            }

            case 'focus': if (hitId) focusHit(hitId); break;
            case 'push-one': if (hitId) pushOne(hitId); break;
            case 'push-board': pushSelected(); break;
            case 'clear-sel': mod().clearSelection(); renderList(); refreshSelCount(); break;

            case 'select-all': {
                mod().setSelection(FL.rendered.map(function (h) { return h.id; }), true);
                renderList(); refreshSelCount();
                break;
            }
            case 'select-none': {
                mod().setSelection(FL.rendered.map(function (h) { return h.id; }), false);
                renderList(); refreshSelCount();
                break;
            }
            case 'more': FL.listLimit += 300; renderList(); break;
            case 'f-reset': {
                FL.filters = { importId: 'all', plate: 'all', from: '', to: '', q: '' };
                if (typeof window.renderTabContent === 'function') window.renderTabContent('flock');
                break;
            }
            case 'play': togglePlay(); break;
        }
    }

    function onChange(e) {
        // The file input carries no data-flk attribute, so it MUST be handled
        // before the delegation lookup below (which would early-return on it).
        if (e.target && e.target.id === 'flockFileInput') {
            var picked = e.target.files && e.target.files[0];
            e.target.value = ''; // allow re-picking the same file after a failure
            if (picked && mod()) mod().importFromFile(picked).then(afterImport);
            return;
        }
        var t = e.target && e.target.closest ? e.target.closest('[data-flk]') : null;
        if (!t || !mod()) return;
        var act = t.getAttribute('data-flk');

        if (act === 'sel') {
            var cardEl = e.target.closest('.flock-card');
            if (!cardEl) return;
            var id = cardEl.getAttribute('data-hit');
            mod().toggleSelect(id, t.checked);
            cardEl.classList.toggle('flock-card-sel', t.checked);
            refreshSelCount();
            return;
        }
        if (act === 'f-import') { FL.filters.importId = t.value; FL.listLimit = 300; refreshAll(); return; }
        if (act === 'f-plate')  { FL.filters.plate = t.value; FL.listLimit = 300; refreshAll(); return; }
        if (act === 'f-from')   { FL.filters.from = t.value; FL.listLimit = 300; refreshAll(); return; }
        if (act === 'f-to')     { FL.filters.to = t.value; FL.listLimit = 300; refreshAll(); return; }
        if (act === 'toggle-trace') { drawMap(); return; }
        if (act === 'pb-track') { setTrack(t.value); renderPlayhead(); return; }
        if (act === 'pb-speed') { FL.pb.speed = parseFloat(t.value) || 1; return; }
        if (act === 'pb-chase') { FL.pb.chase = !!t.checked; return; }
    }

    var _qTimer = null;
    function onInput(e) {
        var t = e.target && e.target.closest ? e.target.closest('[data-flk]') : null;
        if (!t) return;
        var act = t.getAttribute('data-flk');
        if (act === 'f-q') {
            clearTimeout(_qTimer);
            var v = t.value;
            _qTimer = setTimeout(function () {
                FL.filters.q = v; FL.listLimit = 300; refreshAll();
            }, 220);
            return;
        }
        if (act === 'pb-scrub') {
            FL.pb.prog = (parseFloat(t.value) / 1000) * Math.max(0, FL.pb.n - 1);
            renderPlayhead();
        }
    }

    function teardownFlock() { destroyMap(); closeModal(); }

    window.renderFlockTab = renderFlockTab;
    window.initializeFlock = initializeFlock;
    window.teardownFlock = teardownFlock;
    window.FlockUI = { refreshAll: refreshAll, focusHit: focusHit, teardown: teardownFlock };
})();

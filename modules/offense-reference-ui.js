/**
 * Offense Reference — page UI (index.html "Offense Reference" nav item).
 *
 * Lifted out of index.html when the library grew from one flat list of state
 * offenses to three tabbed kinds (state / federal / case law). Schema, import
 * and export live in modules/offense-reference.js; this file is presentation
 * only.
 *
 * TWO THINGS THAT CHANGED FROM THE INLINE VERSION, both deliberate:
 *
 * 1. Records are addressed by `id`, never by array index. The old code passed
 *    an array index into viewOffenseDetail/editOffense/deleteOffense and
 *    recovered the "real" index with offenses.indexOf(). That worked only
 *    because the list was never filtered in place. With a kind tab and a
 *    search box both narrowing the list, an index is a loaded gun — delete
 *    row 3 of a filtered view and you remove a different statute. Ids are
 *    assigned on load for any legacy record missing one.
 *
 * 2. Everything user-typed is HTML-escaped on the way out. The inline version
 *    interpolated offense.code and offense.description raw into innerHTML. A
 *    statute description containing an ampersand or a quote corrupted the
 *    table, and a pasted description containing markup executed. These come
 *    from imported files shared between agencies, so they are not trusted
 *    input.
 *
 * Host globals used (all safe — window assignments or function declarations,
 * never top-level let/const): showNotification, viperToast, viperConfirm,
 * ViperTelemetry, window.electronAPI.
 */
(function () {
    'use strict';

    var OR = (typeof window !== 'undefined' && window.OffenseReference) || null;

    // ---- view state --------------------------------------------------------
    var _all = [];          // every record, all kinds
    var _tab = OR ? OR.KIND_STATE : 'state';
    var _viewId = null;     // id of the record open in the detail view
    var _search = '';

    var TAB_PREF_KEY = 'viperOffenseRefTab';

    // ---- small helpers -----------------------------------------------------

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function attr(s) { return esc(s); }

    function toast(msg, type) {
        if (typeof window.viperToast === 'function') { try { window.viperToast(msg, type || 'info'); return; } catch (_) {} }
        if (typeof window.showNotification === 'function') { try { window.showNotification(msg, type || 'info'); } catch (_) {} }
    }

    function main() { return document.querySelector('.flex-1.overflow-y-auto'); }

    function byId(id) {
        for (var i = 0; i < _all.length; i++) if (String(_all[i].id) === String(id)) return _all[i];
        return null;
    }

    function indexOfId(id) {
        for (var i = 0; i < _all.length; i++) if (String(_all[i].id) === String(id)) return i;
        return -1;
    }

    /**
     * Load and guarantee every record has a stable unique id. Legacy libraries
     * predate ids on some rows; without this the id-addressing above silently
     * collapses (every id-less record is `null` and matches the first one).
     */
    function load() {
        _all = OR.loadAll(localStorage);
        var seen = {};
        var seed = Date.now();
        for (var i = 0; i < _all.length; i++) {
            var id = _all[i].id;
            if (id == null || seen[String(id)]) { id = seed + i; _all[i].id = id; }
            seen[String(id)] = true;
        }
    }

    function save() {
        if (!OR.saveAll(_all, localStorage)) {
            toast('Could not save the offense library — storage may be full.', 'error');
        }
    }

    function meta(kind) { return OR.KIND_META[kind] || OR.KIND_META.state; }

    // Static class maps rather than interpolated Tailwind class names. The
    // inline version built `bg-${color}/20` at runtime, which only ever worked
    // because those exact strings happened to already exist elsewhere in the
    // stylesheet.
    var TYPE_CLASS = {
        felony:      'bg-red-500/20 text-red-400 border-red-500/60',
        misdemeanor: 'bg-viper-orange/20 text-viper-orange border-viper-orange/60',
        wobbler:     'bg-viper-purple/20 text-viper-purple border-viper-purple/60',
        infraction:  'bg-viper-cyan/20 text-viper-cyan border-viper-cyan/60',
        other:       'bg-gray-600/20 text-gray-300 border-gray-500/60'
    };

    function typeClass(type) {
        var t = String(type || '').toLowerCase();
        if (t.indexOf('felony') !== -1) return TYPE_CLASS.felony;
        if (t.indexOf('misdemeanor') !== -1) return TYPE_CLASS.misdemeanor;
        if (t.indexOf('wobbler') !== -1) return TYPE_CLASS.wobbler;
        if (t.indexOf('infraction') !== -1) return TYPE_CLASS.infraction;
        return TYPE_CLASS.other;
    }

    /** Records on the active tab after search narrowing. */
    function visible() {
        var list = OR.ofKind(_all, _tab);
        if (_search) list = list.filter(function (r) { return OR.matchesSearch(r, _search); });
        return list.sort(function (a, b) {
            if (_tab === OR.KIND_CASELAW) return String(a.caseName).localeCompare(String(b.caseName));
            return String(a.code).localeCompare(String(b.code), undefined, { numeric: true });
        });
    }

    // ---- page --------------------------------------------------------------

    function show() {
        try { ViperTelemetry.moduleOpen('offense_reference'); } catch (_) {}
        load();

        try {
            var saved = localStorage.getItem(TAB_PREF_KEY);
            if (saved && OR.isKind(saved)) _tab = saved;
        } catch (_) {}

        document.querySelectorAll('.sidebar-item').forEach(function (item) {
            item.classList.remove('active');
            var svg = item.querySelector('svg'), span = item.querySelector('span');
            if (svg) { svg.classList.remove('text-viper-cyan'); svg.classList.add('text-gray-400'); }
            if (span) { span.classList.remove('text-white'); span.classList.add('text-gray-400'); }
        });
        var nav = document.getElementById('offenseRefNav');
        if (nav) {
            nav.classList.add('active');
            var s = nav.querySelector('svg'), p = nav.querySelector('span');
            if (s) { s.classList.add('text-viper-cyan'); s.classList.remove('text-gray-400'); }
            if (p) { p.classList.add('text-white'); p.classList.remove('text-gray-400'); }
        }

        if (_viewId != null && byId(_viewId)) renderDetail();
        else { _viewId = null; renderList(); }
    }

    function switchTab(kind) {
        if (!OR.isKind(kind)) return;
        _tab = kind;
        // Search is scoped to a tab — carrying "burglary" onto the Case Law
        // tab would show a confusing empty table.
        _search = '';
        _viewId = null;
        try { localStorage.setItem(TAB_PREF_KEY, kind); } catch (_) {}
        renderList();
    }

    function tabBarHtml() {
        return '<div class="flex items-center gap-1 px-8 pt-5 border-b border-viper-cyan/20 bg-viper-dark/30">' +
            OR.KINDS.map(function (k) {
                var m = meta(k);
                var n = OR.ofKind(_all, k).length;
                var on = (k === _tab);
                return '<button onclick="offenseRefSwitchTab(\'' + k + '\')" ' +
                    'class="relative px-5 py-3 text-sm font-semibold transition border-b-2 -mb-px ' +
                    (on ? 'text-viper-cyan border-viper-cyan' : 'text-gray-400 border-transparent hover:text-gray-200') + '">' +
                    esc(m.label) +
                    '<span class="ml-2 px-2 py-0.5 rounded-full text-[11px] ' +
                    (on ? 'bg-viper-cyan/20 text-viper-cyan' : 'bg-gray-700/60 text-gray-400') + '">' + n + '</span>' +
                    '</button>';
            }).join('') +
            '</div>';
    }

    function statCard(label, value, colorCls, iconPath) {
        return '<div class="glass-card rounded-xl p-4"><div class="flex items-center justify-between">' +
            '<div><p class="text-sm text-gray-400">' + esc(label) + '</p>' +
            '<p class="text-2xl font-bold text-white mt-1">' + esc(value) + '</p></div>' +
            '<div class="w-12 h-12 ' + colorCls + '/20 rounded-lg flex items-center justify-center">' +
            '<svg class="w-6 h-6 ' + colorCls.replace('bg-', 'text-') + '" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
            '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="' + iconPath + '"/></svg>' +
            '</div></div></div>';
    }

    var ICON_BOOK = 'M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253';
    var ICON_WARN = 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z';
    var ICON_INFO = 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z';
    var ICON_SWAP = 'M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4';
    var ICON_SCALE = 'M12 3v18m0-18l7 4m-7-4L5 7m14 0l-3 7h6l-3-7zM5 7l-3 7h6L5 7z';
    var ICON_TAG = 'M7 7h.01M7 3h5a2 2 0 011.414.586l7 7a2 2 0 010 2.828l-5 5a2 2 0 01-2.828 0l-7-7A2 2 0 015 10V5a2 2 0 012-2z';

    function statsHtml() {
        var list = OR.ofKind(_all, _tab);
        var cards;
        if (_tab === OR.KIND_CASELAW) {
            var courts = {}, newest = '', oldest = '';
            list.forEach(function (r) {
                if (r.court) courts[r.court.toLowerCase()] = 1;
                var y = String(r.year || '');
                if (y) {
                    if (!newest || y > newest) newest = y;
                    if (!oldest || y < oldest) oldest = y;
                }
            });
            cards = [
                statCard('Total Entries', list.length, 'bg-viper-cyan', ICON_SCALE),
                statCard('Distinct Courts', Object.keys(courts).length, 'bg-viper-purple', ICON_BOOK),
                statCard('Newest Decision', newest || '—', 'bg-green-500', ICON_INFO),
                statCard('Oldest Decision', oldest || '—', 'bg-viper-orange', ICON_TAG)
            ];
        } else {
            var fel = 0, mis = 0, third = 0;
            list.forEach(function (r) {
                var t = String(r.type || '').toLowerCase();
                if (t.indexOf('felony') !== -1) fel++;
                else if (t.indexOf('misdemeanor') !== -1) mis++;
            });
            if (_tab === OR.KIND_FEDERAL) {
                third = list.filter(function (r) { return String(r.type || '').toLowerCase().indexOf('infraction') !== -1; }).length;
            } else {
                third = list.filter(function (r) { return r.type === 'Wobbler'; }).length;
            }
            cards = [
                statCard('Total', list.length, 'bg-viper-cyan', ICON_BOOK),
                statCard('Felonies', fel, 'bg-red-500', ICON_WARN),
                statCard('Misdemeanors', mis, 'bg-viper-orange', ICON_INFO),
                statCard(_tab === OR.KIND_FEDERAL ? 'Infractions' : 'Wobblers', third, 'bg-viper-purple', ICON_SWAP)
            ];
        }
        return '<div class="grid grid-cols-1 md:grid-cols-4 gap-4">' + cards.join('') + '</div>';
    }

    function filterBarHtml() {
        // Search only. There is no category dropdown because the tab bar IS
        // the categorization — see the CATEGORIES note in offense-reference.js.
        var ph;
        if (_tab === OR.KIND_CASELAW) ph = 'Search by case name, citation, court, or holding...';
        else if (_tab === OR.KIND_FEDERAL) ph = 'Search by citation, description, class, or sentencing...';
        else ph = 'Search by code, description, type, or sentencing...';
        return '<div class="glass-card rounded-xl p-4">' +
            '<div class="relative">' +
            '<svg class="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
            '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>' +
            '<input type="text" id="offenseSearch" value="' + attr(_search) + '" ' +
            'placeholder="' + attr(ph) + '" ' +
            'oninput="offenseRefOnSearch(this.value)" ' +
            'class="w-full pl-12 pr-4 py-3 bg-viper-dark border border-gray-600 rounded-lg text-white focus:border-viper-cyan focus:outline-none"></div></div>';
    }

    function emptyStateHtml() {
        var m = meta(_tab);
        var blurb = _tab === OR.KIND_CASELAW
            ? 'Build a library of controlling case law your team relies on'
            : (_tab === OR.KIND_FEDERAL
                ? 'Add the federal statutes your unit charges under'
                : 'Build your offense reference library');
        return '<div class="glass-card rounded-xl p-12 text-center">' +
            '<svg class="w-20 h-20 text-gray-600 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
            '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="' +
            (_tab === OR.KIND_CASELAW ? ICON_SCALE : ICON_BOOK) + '"/></svg>' +
            '<h3 class="text-2xl font-bold text-gray-300 mb-2">No ' + esc(m.label) + ' Added</h3>' +
            '<p class="text-gray-400 mb-6">' + esc(blurb) + '</p>' +
            '<button onclick="offenseRefAdd()" class="px-6 py-3 bg-viper-cyan/20 hover:bg-viper-cyan/30 border border-viper-cyan rounded-lg text-viper-cyan transition">' +
            'Add First ' + esc(m.noun) + '</button></div>';
    }

    function headersFor(kind) {
        if (kind === OR.KIND_CASELAW) return ['Case Name', 'Citation', 'Court', 'Year', 'Actions'];
        if (kind === OR.KIND_FEDERAL) return ['Citation', 'Description', 'Class', 'Sentencing', 'Actions'];
        return ['Code', 'Description', 'Type', 'Sentencing', 'Actions'];
    }

    function rowsHtml() {
        var list = visible();
        var cols = headersFor(_tab).length;
        if (!list.length) {
            return '<tr><td colspan="' + cols + '" class="px-6 py-8 text-center text-gray-400">' +
                'No entries match your search</td></tr>';
        }
        return list.map(function (r) {
            var id = attr(r.id);
            var actions = '<td class="px-6 py-4 text-sm"><div class="flex gap-3">' +
                '<button onclick="event.stopPropagation(); offenseRefEdit(\'' + id + '\')" class="text-viper-cyan hover:text-white transition">Edit</button>' +
                '<button onclick="event.stopPropagation(); offenseRefDelete(\'' + id + '\')" class="text-red-500 hover:text-red-400 transition">Delete</button>' +
                '</div></td>';
            var open = '<tr class="hover:bg-viper-dark/30 cursor-pointer" onclick="offenseRefView(\'' + id + '\')">';

            if (_tab === OR.KIND_CASELAW) {
                return open +
                    '<td class="px-6 py-4 text-sm font-semibold text-viper-cyan italic">' + esc(r.caseName) + '</td>' +
                    '<td class="px-6 py-4 text-sm text-white font-mono text-xs">' + esc(r.citation || '—') + '</td>' +
                    '<td class="px-6 py-4 text-sm text-gray-300">' + esc(r.court || '—') + '</td>' +
                    '<td class="px-6 py-4 text-sm text-gray-400">' + esc(r.year || '—') + '</td>' +
                    actions + '</tr>';
            }
            return open +
                '<td class="px-6 py-4 text-sm font-semibold text-viper-cyan whitespace-nowrap">' + esc(r.code) + '</td>' +
                '<td class="px-6 py-4 text-sm text-white">' + esc(r.description) + '</td>' +
                '<td class="px-6 py-4 text-sm"><span class="px-3 py-1 rounded-full text-xs font-semibold border ' +
                typeClass(r.type) + '">' + esc(r.type || '—') + '</span></td>' +
                '<td class="px-6 py-4 text-sm text-gray-400">' + esc(r.sentencing || 'N/A') + '</td>' +
                actions + '</tr>';
        }).join('');
    }

    function renderList() {
        var m = meta(_tab);
        var onTab = OR.ofKind(_all, _tab).length;
        var host = main();
        if (!host) return;

        host.innerHTML =
            '<div class="glass-card border-b border-viper-cyan/20 px-8 pt-6">' +
              '<div class="flex items-center justify-between pb-5">' +
                '<div><h2 class="text-3xl font-bold">Offense Reference</h2>' +
                '<p class="text-gray-400 mt-1">Statutes, federal charges, and controlling case law</p></div>' +
                '<div class="flex items-center gap-3">' +
                  '<button onclick="importOffenseList()" class="px-4 py-2 bg-viper-purple/20 hover:bg-viper-purple/30 border border-viper-purple rounded-lg text-viper-purple transition flex items-center gap-2 text-sm">' +
                    '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/></svg>Import</button>' +
                  '<button onclick="exportOffenseList()" class="px-4 py-2 bg-green-500/20 hover:bg-green-500/30 border border-green-500 rounded-lg text-green-400 transition flex items-center gap-2 text-sm">' +
                    '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>Export</button>' +
                  '<button onclick="offenseRefAdd()" class="px-6 py-2 bg-viper-cyan/20 hover:bg-viper-cyan/30 border border-viper-cyan rounded-lg text-viper-cyan transition flex items-center gap-2">' +
                    '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>Add ' + esc(m.noun) + '</button>' +
                '</div>' +
              '</div>' +
            '</div>' +
            tabBarHtml() +
            '<div class="p-8 space-y-6">' +
            (onTab === 0 ? emptyStateHtml() :
                statsHtml() + filterBarHtml() +
                '<div class="glass-card rounded-xl overflow-hidden"><div class="overflow-x-auto"><table class="w-full">' +
                '<thead class="bg-gradient-to-r from-viper-cyan/20 to-viper-purple/20 border-b border-viper-cyan/30"><tr>' +
                headersFor(_tab).map(function (h) {
                    return '<th class="px-6 py-4 text-left text-xs font-medium text-viper-cyan uppercase tracking-wider">' + esc(h) + '</th>';
                }).join('') +
                '</tr></thead><tbody id="offensesTableBody" class="divide-y divide-gray-700">' + rowsHtml() +
                '</tbody></table></div></div>') +
            '</div>';
    }

    // Re-render only the tbody so the search box keeps focus and caret while
    // the user types.
    function onSearch(v) {
        _search = v || '';
        var tb = document.getElementById('offensesTableBody');
        if (tb) tb.innerHTML = rowsHtml();
    }

    // ---- detail ------------------------------------------------------------

    function field(label, value, cls) {
        return '<div><label class="text-sm text-gray-400">' + esc(label) + '</label>' +
            '<p class="' + (cls || 'text-lg text-white') + ' mt-2">' + esc(value || 'Not specified') + '</p></div>';
    }

    function renderDetail() {
        var r = byId(_viewId);
        if (!r) { _viewId = null; renderList(); return; }
        var host = main();
        if (!host) return;
        var id = attr(r.id);
        var m = meta(r.kind);

        var body;
        if (r.kind === OR.KIND_CASELAW) {
            body =
                '<div><label class="text-sm text-gray-400">Case Name</label>' +
                '<p class="text-3xl font-bold text-viper-cyan mt-2 italic">' + esc(r.caseName) + '</p></div>' +
                '<div><label class="text-sm text-gray-400">Citation</label>' +
                '<p class="text-xl text-white mt-2 font-mono">' + esc(r.citation || '—') + '</p></div>' +
                '<div class="grid grid-cols-2 gap-6">' +
                field('Court', r.court) + field('Year', r.year) +
                '</div>' +
                (r.holding ? '<div><label class="text-sm text-gray-400">Holding</label>' +
                    '<div class="mt-2 p-4 bg-gradient-to-r from-viper-cyan/10 to-viper-purple/10 border border-viper-cyan/20 rounded-lg">' +
                    '<p class="text-white whitespace-pre-wrap">' + esc(r.holding) + '</p></div></div>' : '');
        } else {
            body =
                '<div><label class="text-sm text-gray-400">' + (r.kind === OR.KIND_FEDERAL ? 'Citation' : 'Code') + '</label>' +
                '<p class="text-3xl font-bold text-viper-cyan mt-2">' + esc(r.code) + '</p></div>' +
                '<div><label class="text-sm text-gray-400">Description</label>' +
                '<p class="text-xl text-white mt-2">' + esc(r.description) + '</p></div>' +
                '<div class="grid grid-cols-2 gap-6">' +
                '<div><label class="text-sm text-gray-400">' + (r.kind === OR.KIND_FEDERAL ? 'Offense Class' : 'Offense Type') + '</label>' +
                '<p class="text-lg mt-2"><span class="px-4 py-2 rounded-full font-semibold border ' + typeClass(r.type) + '">' + esc(r.type || '—') + '</span></p></div>' +
                field('Sentencing Exposure', r.sentencing) +
                '</div>';
        }

        host.innerHTML =
            '<div class="glass-card border-b border-viper-cyan/20 px-8 py-6"><div class="flex items-center justify-between">' +
            '<button onclick="backToOffenseList()" class="flex items-center gap-2 text-viper-cyan hover:text-white transition">' +
            '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>' +
            'Back to ' + esc(m.label) + '</button>' +
            '<div class="flex gap-3">' +
            '<button onclick="offenseRefEdit(\'' + id + '\')" class="px-4 py-2 bg-viper-purple/20 hover:bg-viper-purple/30 border border-viper-purple rounded-lg text-viper-purple transition">Edit</button>' +
            '<button onclick="offenseRefDelete(\'' + id + '\')" class="px-4 py-2 bg-red-500/20 hover:bg-red-500/30 border border-red-500 rounded-lg text-red-500 transition">Delete</button>' +
            '</div></div></div>' +
            '<div class="p-8 space-y-6"><div class="glass-card rounded-xl p-8"><div class="space-y-6">' +
            body +
            (r.notes ? '<div><label class="text-sm text-gray-400">Notes / Jury Instructions</label>' +
                '<div class="mt-2 p-4 bg-viper-dark/60 border border-gray-700 rounded-lg">' +
                '<p class="text-white whitespace-pre-wrap">' + esc(r.notes) + '</p></div></div>' : '') +
            '</div></div></div>';
    }

    function view(id) { _viewId = id; renderDetail(); }
    function back() { _viewId = null; renderList(); }

    // ---- add / edit modal --------------------------------------------------

    function selectHtml(id, options, current, placeholder) {
        var h = '<select id="' + id + '" class="w-full px-4 py-2 bg-viper-dark border border-gray-600 rounded-lg text-white focus:border-viper-cyan focus:outline-none">';
        if (placeholder) h += '<option value="">' + esc(placeholder) + '</option>';
        options.forEach(function (o) {
            h += '<option value="' + attr(o) + '"' + (o === current ? ' selected' : '') + '>' + esc(o) + '</option>';
        });
        return h + '</select>';
    }

    function textField(id, label, value, placeholder, required) {
        return '<div><label class="block text-sm text-gray-400 mb-2">' + esc(label) + (required ? ' *' : '') + '</label>' +
            '<input type="text" id="' + id + '" value="' + attr(value || '') + '"' + (required ? ' required' : '') +
            ' class="w-full px-4 py-2 bg-viper-dark border border-gray-600 rounded-lg text-white focus:border-viper-cyan focus:outline-none" ' +
            'placeholder="' + attr(placeholder || '') + '"></div>';
    }

    function formBody(kind, r) {
        r = r || {};
        // No category picker: the record's category is its kind, set by
        // normalize(). One less decision per row.
        if (kind === OR.KIND_CASELAW) {
            return textField('offense_caseName', 'Case Name', r.caseName, 'e.g., Riley v. California', true) +
                textField('offense_citation', 'Citation', r.citation, 'e.g., 573 U.S. 373 (2014)', true) +
                '<div class="grid grid-cols-2 gap-4">' +
                textField('offense_court', 'Court', r.court, 'e.g., U.S. Supreme Court') +
                textField('offense_year', 'Year', r.year, 'e.g., 2014') +
                '</div>' +
                '<div><label class="block text-sm text-gray-400 mb-2">Holding</label>' +
                '<textarea id="offense_holding" rows="3" class="w-full px-4 py-2 bg-viper-dark border border-gray-600 rounded-lg text-white focus:border-viper-cyan focus:outline-none" ' +
                'placeholder="The rule this case establishes, in your own words">' + esc(r.holding || '') + '</textarea></div>' +
                '<div><label class="block text-sm text-gray-400 mb-2">Notes</label>' +
                '<textarea id="offense_notes" rows="3" class="w-full px-4 py-2 bg-viper-dark border border-gray-600 rounded-lg text-white focus:border-viper-cyan focus:outline-none" ' +
                'placeholder="How your agency applies this, distinguishing facts, etc.">' + esc(r.notes || '') + '</textarea></div>';
        }

        var isFed = (kind === OR.KIND_FEDERAL);
        return textField('offense_code', isFed ? 'Citation' : 'Code', r.code,
                isFed ? 'e.g., 18 U.S.C. \u00a7 2252A' : 'e.g., PC 211, VC 10851', true) +
            textField('offense_description', 'Description', r.description,
                isFed ? 'e.g., Certain activities relating to material involving child pornography' : 'e.g., Robbery', true) +
            '<div class="grid grid-cols-2 gap-4">' +
            '<div><label class="block text-sm text-gray-400 mb-2">' + (isFed ? 'Offense Class' : 'Offense Type') + ' *</label>' +
            selectHtml('offense_type', OR.typesFor(kind), r.type, 'Select ' + (isFed ? 'Class' : 'Type')) + '</div>' +
            textField('offense_sentencing', 'Sentencing Exposure', r.sentencing,
                isFed ? 'e.g., 5\u201320 years, mandatory minimum' : 'e.g., 2, 3, or 5 years in state prison') +
            '</div>' +
            '<div><label class="block text-sm text-gray-400 mb-2">Notes / Jury Instructions</label>' +
            '<textarea id="offense_notes" rows="4" class="w-full px-4 py-2 bg-viper-dark border border-gray-600 rounded-lg text-white focus:border-viper-cyan focus:outline-none" ' +
            'placeholder="Additional notes, jury instruction numbers, etc.">' + esc(r.notes || '') + '</textarea></div>';
    }

    function openModal(kind, editId) {
        var r = editId != null ? byId(editId) : null;
        var m = meta(kind);
        var editing = !!r;
        var html =
            '<div id="offenseModal" class="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" ' +
            'onclick="if(event.target.id === \'offenseModal\') closeOffenseModal()">' +
            '<div class="glass-card rounded-xl p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto">' +
            '<h3 class="text-2xl font-bold text-white mb-1">' + (editing ? 'Edit ' : 'Add ') + esc(m.noun) + '</h3>' +
            '<p class="text-sm text-gray-400 mb-6">' + esc(m.label) + '</p>' +
            '<form onsubmit="offenseRefSubmit(event, \'' + kind + '\', ' + (editing ? '\'' + attr(r.id) + '\'' : 'null') + ')" class="space-y-4">' +
            formBody(kind, r) +
            '<div class="flex gap-3 justify-end mt-6">' +
            '<button type="button" onclick="closeOffenseModal()" class="px-6 py-2 bg-gray-600 hover:bg-gray-700 rounded-lg text-white transition">Cancel</button>' +
            '<button type="submit" class="px-6 py-2 bg-viper-cyan hover:bg-viper-cyan/80 rounded-lg text-white font-semibold transition">' +
            (editing ? 'Update' : 'Add') + '</button>' +
            '</div></form></div></div>';
        document.body.insertAdjacentHTML('beforeend', html);
    }

    function closeModal() {
        var el = document.getElementById('offenseModal');
        if (el) el.remove();
    }

    function val(id) {
        var el = document.getElementById(id);
        return el ? String(el.value || '').trim() : '';
    }

    function submit(ev, kind, editId) {
        ev.preventDefault();
        var rec = { kind: kind, notes: val('offense_notes') };
        if (kind === OR.KIND_CASELAW) {
            rec.caseName = val('offense_caseName');
            rec.citation = val('offense_citation');
            rec.court = val('offense_court');
            rec.year = val('offense_year');
            rec.holding = val('offense_holding');
            if (!rec.caseName) { toast('Case name is required.', 'error'); return; }
        } else {
            rec.code = val('offense_code');
            rec.description = val('offense_description');
            rec.type = val('offense_type');
            rec.sentencing = val('offense_sentencing');
            if (!rec.code || !rec.description) { toast('Code and description are required.', 'error'); return; }
        }

        if (editId != null) {
            var at = indexOfId(editId);
            if (at === -1) { closeModal(); renderList(); return; }
            rec.id = _all[at].id;
            rec.createdAt = _all[at].createdAt;
            _all[at] = OR.normalize(rec);
        } else {
            rec.id = Date.now();
            _all.push(OR.normalize(rec));
        }
        save();
        closeModal();
        if (_viewId != null) renderDetail(); else renderList();
    }

    function edit(id) {
        var r = byId(id);
        if (r) openModal(r.kind, id);
    }

    function add() { openModal(_tab, null); }

    function del(id) {
        var r = byId(id);
        if (!r) return;
        var label = OR.displayLabel(r);
        var ask = typeof window.viperConfirm === 'function'
            ? window.viperConfirm('Delete "' + label + '" from the reference library?', { danger: true, okText: 'Delete' })
            : Promise.resolve(window.confirm('Delete "' + label + '"?'));
        Promise.resolve(ask).then(function (ok) {
            if (!ok) return;
            var at = indexOfId(id);
            if (at === -1) return;
            _all.splice(at, 1);
            save();
            if (String(_viewId) === String(id)) { _viewId = null; renderList(); }
            else if (_viewId != null) renderDetail();
            else renderList();
        });
    }

    // ---- export / import ---------------------------------------------------

    function doExport() {
        load();
        if (!_all.length) { toast('Nothing to export yet.', 'info'); return; }
        var payload = OR.buildExport(_all);
        var name = 'VIPER-Offense-Reference-' + new Date().toISOString().slice(0, 10) + '.voffenses';
        Promise.resolve(window.electronAPI.saveOffenseExport({ fileName: name, data: JSON.stringify(payload, null, 2) }))
            .then(function (res) {
                if (!res) return;
                var c = payload.counts;
                toast('Exported ' + payload.count + ' entries (' + c.state + ' state, ' +
                    c.federal + ' federal, ' + c.caselaw + ' case law).', 'success');
            })
            .catch(function (e) { toast('Export failed: ' + (e && e.message ? e.message : e), 'error'); });
    }

    function doImport() {
        Promise.resolve(window.electronAPI.openOffenseImport()).then(function (raw) {
            if (!raw) return;
            var res = OR.parseImport(raw);
            if (!res.ok) { toast(res.error, 'error'); return; }
            if (!res.records.length) { toast('That file contained no usable entries.', 'info'); return; }
            showImportOptions(res);
        });
    }

    function showImportOptions(res) {
        var recs = res.records;
        var c = {
            state: OR.ofKind(recs, OR.KIND_STATE).length,
            federal: OR.ofKind(recs, OR.KIND_FEDERAL).length,
            caselaw: OR.ofKind(recs, OR.KIND_CASELAW).length
        };
        var breakdown = [
            c.state ? c.state + ' state' : null,
            c.federal ? c.federal + ' federal' : null,
            c.caselaw ? c.caselaw + ' case law' : null
        ].filter(Boolean).join(' · ');

        var modal = document.createElement('div');
        modal.id = 'offenseImportModal';
        modal.className = 'fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4';
        modal.onclick = function (e) { if (e.target === modal) modal.remove(); };
        modal.innerHTML =
            '<div class="glass-card rounded-xl p-6 max-w-md w-full">' +
            '<h3 class="text-xl font-bold text-white mb-1">Import Reference Library</h3>' +
            '<p class="text-sm text-gray-400 mb-1">' + recs.length + ' entries found</p>' +
            '<p class="text-xs text-gray-500 mb-5">' + esc(breakdown) +
            (res.version < OR.EXPORT_VERSION
                ? ' · legacy v' + res.version + ' file, all entries treated as state offenses'
                : '') + '</p>' +
            '<div class="space-y-3">' +
            importBtn('all', 'bg-viper-cyan/10 hover:bg-viper-cyan/20 border-viper-cyan/40', 'text-viper-cyan',
                'M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12',
                'Import All', 'Overwrite my entries where they collide') +
            importBtn('skip_dupes', 'bg-viper-green/10 hover:bg-viper-green/20 border-viper-green/40', 'text-viper-green',
                'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',
                'Skip Duplicates', 'Add only entries I do not already have') +
            importBtn('core_only', 'bg-viper-purple/10 hover:bg-viper-purple/20 border-viper-purple/40', 'text-viper-purple',
                'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2',
                'Update, Keep My Notes', 'Take their statute and sentencing text, preserve my own notes') +
            '</div>' +
            '<button onclick="document.getElementById(\'offenseImportModal\').remove()" ' +
            'class="mt-4 w-full px-4 py-2 border border-gray-600 rounded-lg text-gray-400 hover:text-white hover:border-gray-400 transition text-sm">Cancel</button>' +
            '</div>';
        modal._importData = recs;
        document.body.appendChild(modal);
    }

    function importBtn(mode, wrapCls, iconCls, path, title, sub) {
        return '<button onclick="executeOffenseImport(\'' + mode + '\')" ' +
            'class="w-full px-4 py-3 ' + wrapCls + ' border rounded-lg text-left transition">' +
            '<div class="flex items-center gap-3">' +
            '<svg class="w-5 h-5 ' + iconCls + ' flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
            '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="' + path + '"/></svg>' +
            '<div><p class="text-white font-semibold text-sm">' + esc(title) + '</p>' +
            '<p class="text-gray-400 text-xs mt-0.5">' + esc(sub) + '</p></div></div></button>';
    }

    function executeImport(mode) {
        var modal = document.getElementById('offenseImportModal');
        if (!modal) return;
        var incoming = modal._importData || [];
        modal.remove();

        load();
        var out = OR.mergeImport(_all, incoming, mode);
        _all = out.list;
        // Re-run the id guarantee: merged-in records may arrive with ids that
        // collide with local ones from a different agency's clock.
        var seen = {}, seed = Date.now();
        for (var i = 0; i < _all.length; i++) {
            var id = _all[i].id;
            if (id == null || seen[String(id)]) { id = seed + i; _all[i].id = id; }
            seen[String(id)] = true;
        }
        save();
        _viewId = null;
        renderList();

        var parts = [];
        if (out.added) parts.push(out.added + ' added');
        if (out.updated) parts.push(out.updated + ' updated');
        if (out.skipped) parts.push(out.skipped + ' skipped');
        toast('Import complete: ' + (parts.join(', ') || 'no changes') + '.', 'success');
    }

    // ---- globals -----------------------------------------------------------
    // index.html wires these from inline onclick attributes. Names starting
    // with offenseRef* are new; the rest keep their original names because
    // the sidebar and other call sites already reference them.
    window.showOffenseReference = show;
    window.backToOffenseList = back;
    window.closeOffenseModal = closeModal;
    window.exportOffenseList = doExport;
    window.importOffenseList = doImport;
    window.executeOffenseImport = executeImport;
    window.offenseRefSwitchTab = switchTab;
    window.offenseRefOnSearch = onSearch;
    window.offenseRefView = view;
    window.offenseRefEdit = edit;
    window.offenseRefAdd = add;
    window.offenseRefDelete = del;
    window.offenseRefSubmit = submit;

    // Exposed for tests.
    window.OffenseReferenceUI = {
        _rowsHtml: rowsHtml,
        _formBody: formBody,
        _setState: function (all, tab, search) {
            _all = all; _tab = tab; _search = search || '';
        },
        _tabBarHtml: tabBarHtml,
        _headersFor: headersFor,
        _filterBarHtml: filterBarHtml
    };
})();

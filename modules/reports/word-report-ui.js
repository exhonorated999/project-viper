/*
 * Word Report — the Reports-tab "write it in Microsoft Word" option (renderer).
 *
 * Per case, the officer chooses where the case report is written:
 *   - the VIPER editor (the built-in rich-text editor, unchanged), or
 *   - Microsoft Word, with the .docx files living inside the case at
 *     cases/<caseNumber>/Reports/Word/ — opened in Word, and every save the
 *     officer makes there goes straight back into the case (re-encrypted when
 *     Field Security is on). The main process owns the files
 *     (modules/warrants/working-docs.js, second manager, 'report-doc-*' IPC).
 *
 * A case can hold SEVERAL Word reports (5.4.1 — the original report, each
 * supplement, a follow-up…). Every file in the folder is a report in its own
 * right: listed by name, each with its own Open / Save a copy / Rename /
 * Replace / Remove. There is no "main" report any more — the case record's
 * old `reportWordName` is simply no longer read.
 *
 * Switching is never destructive: the VIPER text stays in viperCaseReports
 * and the Word files stay in the case folder, whichever is showing.
 *
 * Word reports are NOT part of Export to DA / Assist Package — VIPER cannot
 * turn a Word document into its report format. This module says so on the
 * tab and on the switch; the host says so in the export dialog and the PDF.
 * "Save a copy…" is how the officer sends each one separately.
 *
 * Host state reaches this module only through configure(): the case page
 * declares currentCase with top-level `let`, which never lands on window.
 * The choice is stored on the case record (currentCase.reportFormat), NOT in
 * viperCaseReports, which two writers overwrite wholesale.
 *
 * UMD, assigned to BOTH module.exports and the global: `module` IS defined
 * in VIPER's renderer, so an either/or wrapper would leave window.X unset.
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root) root.WordReportUI = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    var DISCLAIMER = 'Word reports are not included in Export to DA or the Assist Package. ' +
        'VIPER cannot convert a Word document into its report format, so they cannot be added to the overall report. ' +
        'Use \u201cSave a copy\u2026\u201d on each report and send it with the export separately.';

    var host = {};
    var state = {
        loadedFor: null,     // case number the cached list belongs to
        docs: [],            // [{fileName, bytes, modifiedAt, open, lastSavedAt, error}] sorted by name
        loading: null,
        again: false,
        loadError: null,
        busy: {},            // fileName | '_switch' | '_create' → true while running
        unsubscribe: null,
    };

    // ── small helpers ────────────────────────────────────────────────────
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function api() { return host.api || (typeof window !== 'undefined' && window.electronAPI) || null; }
    function call(name) { try { return host[name] ? host[name]() : null; } catch (_) { return null; } }
    function caseNumber() { return call('getCaseNumber'); }
    function format() { return call('getFormat') === 'word' ? 'word' : 'viper'; }
    function toast(msg, type, ms) {
        if (host.toast) return host.toast(msg, type, ms);
        if (typeof window !== 'undefined' && window.viperToast) return window.viperToast(msg, type, ms);
    }
    function confirmBox(msg, opts) {
        if (host.confirm) return Promise.resolve(host.confirm(msg, opts));
        if (typeof window !== 'undefined' && window.viperConfirm) return window.viperConfirm(msg, opts);
        return Promise.resolve(false);
    }
    function doc$(id) { return (typeof document !== 'undefined' && document.getElementById) ? document.getElementById(id) : null; }
    function setField(fn, v) {
        try { return host[fn] ? host[fn](v) !== false : false; } catch (_) { return false; }
    }
    var WORD_EXT = /\.(docx|doc|rtf)$/i;
    function baseName(n) { return String(n || '').replace(WORD_EXT, ''); }

    function fmtTime(iso) {
        if (!iso) return '';
        var d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        var now = new Date();
        var t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        if (d.toDateString() === now.toDateString()) return t;
        return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' }) + ' ' + t;
    }

    var PLACEHOLDER = 'Start typing your report here...';
    var ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };
    /**
     * The VIPER editor's HTML as plain lines, for seeding a new Word report.
     * Pure string work — no DOM, so nothing (images, links) is fetched.
     * Pictures and formatting do not carry over.
     */
    function htmlToText(html) {
        var s = String(html || '');
        s = s.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '');
        s = s.replace(/<br\s*\/?>/gi, '\n');
        s = s.replace(/<\/(p|div|li|h[1-6]|tr|blockquote|pre)\s*>/gi, '\n');
        s = s.replace(/<li\b[^>]*>/gi, '\u2022 ');
        s = s.replace(/<[^>]*>/g, '');
        s = s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, function (m, e) {
            var low = e.toLowerCase();
            if (ENTITIES[low] != null) return ENTITIES[low];
            if (low.charAt(0) === '#') {
                var n = low.charAt(1) === 'x' ? parseInt(low.slice(2), 16) : parseInt(low.slice(1), 10);
                if (n > 0 && n < 0x110000) { try { return String.fromCodePoint(n); } catch (_) {} }
            }
            return m;
        });
        s = s.replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
        if (s === PLACEHOLDER) return '';
        return s;
    }
    function viperText() { return htmlToText(call('getViperHtml')); }

    function findDoc(name) {
        if (!name) return null;
        var low = String(name).toLowerCase();
        for (var i = 0; i < state.docs.length; i++) if (state.docs[i].fileName.toLowerCase() === low) return state.docs[i];
        return null;
    }
    /** A copy VIPER kept after a crash so a Word save was not lost. */
    function isRecovered(d) { return !!d && /\(recovered/i.test(d.fileName); }
    /**
     * Reports are listed by NAME (numbers in order: "Supplement 2" before
     * "Supplement 10"), not by last change — a list that reshuffles every
     * time Word saves is a list an officer cannot find things in. Compared
     * WITHOUT the extension, so "Case Report (recovered)" lands directly
     * beneath "Case Report" rather than above it (a space sorts before ".").
     */
    function byName(a, b) {
        var x = baseName(a.fileName), y = baseName(b.fileName);
        try { return x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' }) || String(a.fileName).localeCompare(String(b.fileName)); }
        catch (_) { return x.toLowerCase() < y.toLowerCase() ? -1 : x.toLowerCase() > y.toLowerCase() ? 1 : 0; }
    }

    // ── loading ──────────────────────────────────────────────────────────
    function refresh() {
        var cn = caseNumber();
        var a = api();
        if (!cn || !a || !a.reportDocsList) return Promise.resolve(state.docs);
        if (state.loading) { state.again = true; return state.loading; }
        state.loading = Promise.resolve()
            .then(function () { return a.reportDocsList(cn); })
            .then(function (r) {
                if (caseNumber() !== cn) return;
                if (r && r.success) { state.docs = (r.docs || []).slice().sort(byName); state.loadError = null; }
                else { state.loadError = (r && r.error) || 'Could not read the Word report folder.'; }
                state.loadedFor = cn;
            }, function (e) {
                state.loadError = (e && e.message) || String(e);
                state.loadedFor = cn;
            })
            .then(function () {
                state.loading = null;
                repaint();
                if (state.again || (caseNumber() && caseNumber() !== state.loadedFor)) { state.again = false; return refresh(); }
                return state.docs;
            });
        return state.loading;
    }

    function subscribe() {
        var a = api();
        if (state.unsubscribe || !a || !a.onReportDocEvent) return;
        state.unsubscribe = a.onReportDocEvent(onEvent) || function () {};
    }

    function onEvent(evt) {
        if (!evt || evt.caseNumber !== caseNumber()) {
            if (evt && evt.type === 'error') toast('Word report (case ' + esc(evt.caseNumber) + '): ' + esc(evt.message), 'error', 10000);
            return;
        }
        var d = findDoc(evt.fileName);
        if (evt.type === 'saved') {
            if (d) { d.open = true; d.lastSavedAt = evt.savedAt; d.error = null; if (typeof evt.bytes === 'number') d.bytes = evt.bytes; }
            repaint();
        } else if (evt.type === 'error') {
            if (d) d.error = evt.message;
            toast('Word report: ' + esc(evt.message), 'error', 10000);
            repaint();
        } else if (evt.type === 'recovered') {
            toast(evt.action === 'recover-beside'
                ? 'A Word save that had not reached the case was kept as <b>' + esc(evt.recoveredAs || evt.fileName) + '</b>, beside the report it came from (both had changed). It is listed with your reports.'
                : 'A Word save that had not reached the case was brought into the report.', 'info', 10000);
            refresh();
        } else {
            refresh();    // opened / closed
        }
    }

    // ── rendering ────────────────────────────────────────────────────────
    function btn(action, label, cls, attrs) {
        return '<button type="button" onclick="WordReportUI.act(\'' + action + '\', this, event)" ' + (attrs || '') +
            ' class="text-sm px-3 py-1.5 rounded-lg border ' + (cls || 'border-gray-600 bg-viper-card/60 text-gray-300 hover:bg-viper-card') +
            ' transition-colors whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed">' + label + '</button>';
    }
    function nameAttr(name) { return 'data-wr-name="' + esc(name) + '"'; }
    var ORANGE = 'border-viper-orange/30 bg-viper-orange/20 text-viper-orange hover:bg-viper-orange/30';
    var CYAN = 'border-viper-cyan/30 bg-viper-cyan/20 text-viper-cyan hover:bg-viper-cyan/30';
    var RED = 'border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20';

    /** "Write this report in: [VIPER editor] [Microsoft Word]". */
    function renderModeSwitch() {
        var f = format();
        var busy = !!state.busy._switch;
        function seg(mode, label) {
            var on = f === mode;
            return '<button type="button" data-wr-mode="' + mode + '" ' + (on ? 'aria-pressed="true" ' : 'aria-pressed="false" ') +
                (busy ? 'disabled ' : '') +
                'onclick="WordReportUI.act(\'' + (on ? 'noop' : 'mode-' + mode) + '\', this, event)" ' +
                'class="px-3 py-1 text-sm font-medium transition-colors ' +
                (on ? 'bg-viper-cyan/25 text-viper-cyan' : 'text-gray-400 hover:text-gray-200 hover:bg-viper-card/60') + '">' + label + '</button>';
        }
        return '' +
            '<div class="flex items-center gap-2 flex-wrap" id="wrModeSwitch">' +
                '<span class="text-xs text-gray-400">Write this report in:</span>' +
                '<div class="inline-flex rounded-lg border border-gray-600 overflow-hidden">' +
                    seg('viper', 'VIPER editor') + '<span class="w-px bg-gray-600"></span>' + seg('word', 'Microsoft Word') +
                '</div>' +
                (f === 'viper' ? '<span id="wrWordHint" class="text-xs text-viper-orange">' + wordHint() + '</span>' : '') +
            '</div>';
    }

    /**
     * In the VIPER-editor view, Word reports other tabs saved into the case
     * (e.g. the BitTorrent Download Summary) would otherwise be invisible.
     */
    function wordHint() {
        var cn = caseNumber();
        if (cn && state.loadedFor !== cn && !state.loading && api() && api().reportDocsList) { subscribe(); setTimeout(refresh, 0); }
        var n = state.loadedFor === cn ? state.docs.length : 0;
        return n ? '\uD83D\uDCDD ' + n + ' Word report' + (n === 1 ? '' : 's') + ' saved in this case \u2014 choose Microsoft Word to see ' + (n === 1 ? 'it' : 'them') + '.' : '';
    }

    /** Another tab added a Word report: re-read the list next time it is shown. */
    function invalidate() {
        state.loadedFor = null;
        if (doc$('wrPanel') || doc$('wrWordHint')) refresh();
    }

    function disclaimerBox() {
        return '' +
            '<div class="bg-amber-500/10 border border-amber-500/40 rounded-lg p-4 flex items-start gap-3" data-wr-disclaimer>' +
                '<span class="text-amber-400 text-lg leading-none flex-shrink-0">\u26A0\uFE0F</span>' +
                '<div class="text-sm">' +
                    '<p class="text-amber-300 font-semibold mb-1">Not included in Export to DA</p>' +
                    '<p class="text-gray-300">' + esc(DISCLAIMER) + '</p>' +
                '</div>' +
            '</div>';
    }

    function statusLine(d) {
        if (d.error) return '<span class="text-red-400">' + esc(d.error) + '</span>';
        if (d.open) {
            return '<span class="text-green-400">Open in Word' +
                (d.lastSavedAt ? ' \u00b7 saved into the case ' + esc(fmtTime(d.lastSavedAt)) : ' \u00b7 every save you make goes into the case') + '</span>';
        }
        return '<span class="text-gray-400">Last changed ' + esc(fmtTime(d.modifiedAt)) + '</span>';
    }

    function reportCard(d) {
        var busy = !!state.busy[d.fileName];
        var lockedTip = ' disabled title="Close it in Word first"';
        var rec = isRecovered(d);
        return '' +
            '<div class="glass-card rounded-xl p-5 border ' + (rec ? 'border-amber-500/30' : 'border-viper-cyan/20') + '" data-wr-row="' + esc(d.fileName) + '">' +
                '<div class="flex items-start justify-between gap-4 flex-wrap">' +
                    '<div class="min-w-0 flex-1">' +
                        '<div class="text-lg font-semibold break-all">\uD83D\uDCDD ' + esc(baseName(d.fileName)) +
                            '<span class="text-xs font-normal text-gray-500 ml-1">' + esc((d.fileName.match(WORD_EXT) || [''])[0]) + '</span></div>' +
                        '<div class="text-sm mt-1">' + statusLine(d) + '</div>' +
                        (rec ? '<div class="text-xs text-amber-300 mt-1" data-wr-recovered>A copy VIPER kept so a Word save was not lost. Open it to compare, then keep or remove it.</div>' : '') +
                    '</div>' +
                    '<div class="flex gap-2 flex-wrap justify-end">' +
                        btn('open', busy ? 'Opening\u2026' : 'Open in Word', ORANGE, nameAttr(d.fileName) + (busy ? ' disabled' : '')) +
                        btn('copy', 'Save a copy\u2026', CYAN, nameAttr(d.fileName)) +
                        btn('rename', 'Rename', null, nameAttr(d.fileName) + (d.open ? lockedTip : '')) +
                        btn('replace', 'Replace\u2026', null, nameAttr(d.fileName) + (d.open ? lockedTip : '')) +
                        btn('remove', 'Remove', RED, nameAttr(d.fileName) + (d.open ? lockedTip : '')) +
                    '</div>' +
                '</div>' +
            '</div>';
    }

    function seedLabel(id) {
        return '<label class="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">' +
            '<input type="checkbox" id="' + id + '" class="w-4 h-4 rounded border-gray-600"> Start with the text of my VIPER report ' +
            '<span class="text-xs text-gray-500">(text only \u2014 formatting and pictures do not carry over)</span></label>';
    }

    function emptyState() {
        var hasText = !!viperText();
        var creating = !!state.busy._create;
        return '' +
            '<div class="glass-card rounded-xl p-6 border border-viper-cyan/20" data-wr-empty>' +
                '<h4 class="text-lg font-semibold mb-1">No Word reports yet</h4>' +
                '<p class="text-sm text-gray-400 mb-4">Start a new Word document for this case, or bring in ones you have already written. They open in Microsoft Word on this computer and stay inside the case. You can keep as many reports here as the case needs \u2014 the original report, supplements, follow-ups.</p>' +
                (hasText ? '<div class="mb-4">' + seedLabel('wrSeed') + '</div>' : '') +
                '<div class="flex gap-2 flex-wrap">' +
                    btn('create', creating ? 'Creating\u2026' : 'Create a new Word report', ORANGE, creating ? 'disabled' : '') +
                    btn('import', 'Use existing Word documents\u2026', null, creating ? 'disabled' : '') +
                '</div>' +
            '</div>';
    }

    function toolbar() {
        var creating = !!state.busy._create;
        return '' +
            '<div class="flex items-center justify-between gap-3 flex-wrap" data-wr-toolbar>' +
                '<p class="text-sm text-gray-400">' + state.docs.length + ' Word report' + (state.docs.length === 1 ? '' : 's') +
                    ' in this case. Each one is kept inside the case \u2014 every time you press Save in Word, VIPER is updated.</p>' +
                '<div class="flex gap-2 flex-wrap">' +
                    btn('create-another', creating ? 'Creating\u2026' : '+ New Word report', ORANGE, creating ? 'disabled' : '') +
                    btn('import', 'Add existing documents\u2026', null, creating ? 'disabled' : '') +
                '</div>' +
            '</div>';
    }

    function panelInner() {
        var cn = caseNumber();
        var body;
        if (state.loadedFor !== cn) {
            body = '<p class="text-sm text-gray-500">Loading\u2026</p>';
        } else if (state.loadError) {
            body = '<p class="text-sm text-red-400">' + esc(state.loadError) + '</p>';
        } else if (!state.docs.length) {
            body = emptyState();
        } else {
            body = toolbar() + '<div class="space-y-3" data-wr-list>' + state.docs.map(reportCard).join('') + '</div>';
        }
        return '' +
            '<div class="flex items-start justify-between gap-4 flex-wrap">' +
                '<div>' +
                    '<h3 class="text-2xl font-bold">Case Reports</h3>' +
                    '<p class="text-sm text-gray-400 mt-1">Written in Microsoft Word</p>' +
                '</div>' +
                renderModeSwitch() +
            '</div>' +
            disclaimerBox() + body;
    }

    /** The whole Reports tab while the case is in Word mode. */
    function renderPanel() {
        subscribe();
        var cn = caseNumber();
        if (cn && state.loadedFor !== cn && !state.loading) setTimeout(refresh, 0);
        return '<div id="wrPanel" class="space-y-6">' + panelInner() + '</div>';
    }

    function repaint() {
        var p = doc$('wrPanel');
        if (p) p.innerHTML = panelInner();
        var h = doc$('wrWordHint');
        if (h && state.loadedFor === caseNumber()) h.innerHTML = wordHint();
    }

    // ── the small name dialog ────────────────────────────────────────────
    /**
     * ask(spec) → Promise<null | {name, seed}>
     * spec: { title, text?, name, seed?: bool (offer the VIPER-text box), okText }
     * host.ask(spec) overrides it (tests, or a host with its own dialog).
     */
    function ask(spec) {
        if (host.ask) return Promise.resolve(host.ask(spec));
        if (typeof document === 'undefined' || !document.createElement || !document.body) return Promise.resolve(null);
        return new Promise(function (resolve) {
            var wrap = document.createElement('div');
            wrap.className = 'fixed inset-0 z-[9999] flex items-center justify-center bg-black/60';
            wrap.innerHTML = '' +
                '<div class="glass-card rounded-xl p-6 w-full max-w-md border border-viper-orange/30" style="background: rgb(var(--vp-card, 30 31 38));">' +
                    '<h4 class="text-lg font-bold mb-2">' + esc(spec.title) + '</h4>' +
                    (spec.text ? '<p class="text-xs text-gray-400 mb-3">' + esc(spec.text) + '</p>' : '') +
                    '<label class="block text-xs text-gray-400 mb-1">Name</label>' +
                    '<input data-wr-f="name" type="text" maxlength="110" value="' + esc(spec.name) + '" class="w-full px-3 py-2 bg-viper-card/50 border border-gray-600 rounded-lg text-sm">' +
                    (spec.seed ? '<div class="mt-3">' + seedLabel('wrSeedAsk') + '</div>' : '') +
                    '<div class="flex justify-end gap-2 mt-5">' +
                        '<button type="button" data-wr-b="cancel" class="px-4 py-2 rounded-lg text-sm text-gray-300 hover:bg-viper-card/60">Cancel</button>' +
                        '<button type="button" data-wr-b="ok" class="px-4 py-2 rounded-lg text-sm bg-viper-orange/20 text-viper-orange border border-viper-orange/30 hover:bg-viper-orange/30">' + esc(spec.okText || 'OK') + '</button>' +
                    '</div>' +
                '</div>';
            function done(v) { document.removeEventListener('keydown', onKey, true); if (wrap.parentNode) wrap.parentNode.removeChild(wrap); resolve(v); }
            function collect() {
                var n = wrap.querySelector('[data-wr-f="name"]');
                var s = wrap.querySelector('#wrSeedAsk');
                return { name: n ? n.value : '', seed: !!(s && s.checked) };
            }
            function onKey(e) {
                if (e.key === 'Escape') { e.preventDefault(); done(null); }
                else if (e.key === 'Enter' && e.target && e.target.getAttribute && e.target.getAttribute('data-wr-f') === 'name') { e.preventDefault(); done(collect()); }
            }
            wrap.addEventListener('click', function (e) {
                if (e.target === wrap) return done(null);
                var b = e.target && e.target.closest ? e.target.closest('[data-wr-b]') : null;
                if (!b) return;
                done(b.getAttribute('data-wr-b') === 'ok' ? collect() : null);
            });
            document.addEventListener('keydown', onKey, true);
            document.body.appendChild(wrap);
            var first = wrap.querySelector('[data-wr-f="name"]');
            if (first) { first.focus(); if (first.select) first.select(); }
        });
    }

    // ── actions ──────────────────────────────────────────────────────────
    function fail(r, what) {
        toast(esc(what) + ': ' + esc((r && r.error) || 'something went wrong.'), 'error', 9000);
    }
    function rerender() { try { if (host.rerender) host.rerender(); } catch (_) {} }

    function switchTo(mode) {
        if (state.busy._switch || mode === format()) return Promise.resolve(false);
        var msg;
        if (mode === 'word') {
            try { if (host.saveViperReport) host.saveViperReport(); } catch (_) {}
            msg = '<b>Write this case\u2019s reports in Microsoft Word?</b><br><br>' +
                'Your VIPER report is kept \u2014 you can switch back at any time and nothing is deleted.<br><br>' +
                '<span style="color:#fbbf24">' + esc(DISCLAIMER) + '</span>';
        } else {
            var anyOpen = state.docs.some(function (d) { return d.open; });
            msg = '<b>Go back to the VIPER editor?</b><br><br>' +
                'Your Word reports stay in the case and nothing is deleted. You can switch back to Word at any time.<br><br>' +
                'The VIPER report is the one included in Export to DA.' +
                (anyOpen ? '<br><br><span style="color:#fbbf24">A Word report is still open in Word. Saves you make there will still go into the case.</span>' : '');
        }
        state.busy._switch = true;
        return confirmBox(msg, { okText: mode === 'word' ? 'Use Microsoft Word' : 'Use the VIPER editor' }).then(function (yes) {
            delete state.busy._switch;
            if (!yes) return false;
            if (!setField('setFormat', mode)) {
                toast('Could not save the change \u2014 the report is still in the ' + (mode === 'word' ? 'VIPER editor' : 'Word') + ' view.', 'error', 9000);
                return false;
            }
            rerender();
            return true;
        }, function () { delete state.busy._switch; return false; });
    }

    function openDoc(name) {
        var a = api(), cn = caseNumber();
        if (!a || !cn || !name || state.busy[name]) return Promise.resolve(false);
        state.busy[name] = true; repaint();
        return Promise.resolve(a.reportDocOpen(cn, name)).then(function (r) {
            delete state.busy[name];
            if (!r || !r.success) { fail(r, 'Could not open ' + name); repaint(); return false; }
            var d = findDoc(name); if (d) d.open = true;
            repaint();
            if (!r.alreadyOpen) toast('Opening <b>' + esc(name) + '</b> in Word. Every save you make there goes into the case.', 'info', 5000);
            return true;
        }, function (e) { delete state.busy[name]; fail({ error: e && e.message }, 'Could not open ' + name); repaint(); return false; });
    }

    function safeCn() { return String(caseNumber() || '').replace(/[\\/:*?"<>|]/g, '-'); }
    function defaultName() {
        var cn = safeCn();
        return cn ? 'Case Report ' + cn : 'Case Report';
    }
    /** The suggested name for a second, third… report. Main makes it unique. */
    function nextName() {
        var cn = safeCn();
        var n = state.docs.filter(function (d) { return !isRecovered(d); }).length;
        return 'Supplemental Report' + (n > 1 ? ' ' + n : '') + (cn ? ' ' + cn : '');
    }

    function makeDoc(name, seed) {
        var a = api(), cn = caseNumber();
        if (!a || !cn || state.busy._create) return Promise.resolve(null);
        state.busy._create = true; repaint();
        return Promise.resolve(a.reportDocNewBlank(cn, name, seed)).then(function (r) {
            delete state.busy._create;
            if (!r || !r.success) { fail(r, 'Could not create the Word report'); repaint(); return null; }
            return refresh().then(function () { return openDoc(r.fileName); }).then(function () { return r.fileName; });
        }, function (e) { delete state.busy._create; fail({ error: e && e.message }, 'Could not create the Word report'); repaint(); return null; });
    }

    /** The first report, from the empty state: no dialog, default name. */
    function create() {
        var box = doc$('wrSeed');
        return makeDoc(defaultName(), box && box.checked ? viperText() : '');
    }

    /** Another report alongside the ones already here: asks for a name. */
    function createAnother() {
        if (state.busy._create) return Promise.resolve(null);
        var hasText = !!viperText();
        return ask({
            title: 'New Word report',
            text: 'It is added beside the reports already in this case. Nothing else changes.',
            name: nextName(), seed: hasText, okText: 'Create and open',
        }).then(function (v) {
            if (!v || !String(v.name || '').trim()) return null;
            return makeDoc(v.name, v.seed && hasText ? viperText() : '');
        });
    }

    function importDoc(replace) {
        var a = api(), cn = caseNumber();
        if (!a || !cn) return Promise.resolve(null);
        return Promise.resolve(a.reportDocImport(cn, replace || null)).then(function (r) {
            if (!r || r.canceled) return null;
            if (!r.success) { fail(r, 'Could not add the document'); return null; }
            var added = r.added && r.added.length ? r.added : (r.fileName ? [r.fileName] : []);
            (r.failed || []).forEach(function (f) { toast('Not added \u2014 ' + esc(f.fileName) + ': ' + esc(f.error), 'error', 9000); });
            if (r.replaceError) {
                toast('The new report is in. The old one could not be removed (' + esc(r.replaceError) + ') \u2014 both are listed.', 'warning', 10000);
            } else if (replace) {
                toast('Report replaced: <b>' + esc(added[0]) + '</b>', 'success', 5000);
            } else {
                toast('Added to the case: <b>' + added.map(esc).join('</b>, <b>') + '</b>', 'success', 5000);
            }
            return refresh().then(function () { return added; });
        }, function (e) { fail({ error: e && e.message }, 'Could not add the document'); return null; });
    }

    function replaceDoc(name) {
        var d = findDoc(name);
        if (d && d.open) { toast('Close the report in Word first, then replace it.', 'warning', 6000); return Promise.resolve(null); }
        return confirmBox('<b>Replace "' + esc(name) + '"?</b><br><br>Pick the Word document to use instead. "' + esc(name) +
            '" goes to the Windows Recycle Bin once the new one is safely in the case. Your other reports are not affected.', { okText: 'Choose a document\u2026' })
            .then(function (yes) { return yes ? importDoc(name) : null; });
    }

    function renameDoc(name) {
        var a = api(), cn = caseNumber();
        if (!a || !cn || !name) return Promise.resolve(null);
        var d = findDoc(name);
        if (d && d.open) { toast('Close it in Word first, then rename it.', 'warning', 6000); return Promise.resolve(null); }
        if (!a.reportDocRename) { toast('Renaming needs VIPER to be restarted.', 'warning', 6000); return Promise.resolve(null); }
        return ask({ title: 'Rename Word report', name: baseName(name), okText: 'Rename' }).then(function (v) {
            if (!v || !String(v.name || '').trim()) return null;
            return Promise.resolve(a.reportDocRename(cn, name, v.name)).then(function (r) {
                if (!r || !r.success) { fail(r, 'Could not rename'); return null; }
                return refresh().then(function () { return r.fileName; });
            }, function (e) { fail({ error: e && e.message }, 'Could not rename'); return null; });
        });
    }

    function removeDoc(name) {
        var a = api(), cn = caseNumber();
        if (!a || !cn || !name) return Promise.resolve(false);
        var d = findDoc(name);
        if (d && d.open) { toast('Close it in Word first, then remove it.', 'warning', 6000); return Promise.resolve(false); }
        var msg = '<b>Remove "' + esc(name) + '" from this case?</b><br><br>It goes to the Windows Recycle Bin, so it can be restored from there. ' +
            'Your other reports and your VIPER report are not affected.';
        return confirmBox(msg, { danger: true, okText: 'Remove' }).then(function (yes) {
            if (!yes) return false;
            return Promise.resolve(a.reportDocRemove(cn, name)).then(function (r) {
                if (!r || !r.success) { fail(r, 'Could not remove ' + name); return false; }
                toast('Moved to the Recycle Bin: <b>' + esc(name) + '</b>', 'success', 5000);
                return refresh().then(function () { return true; });
            });
        });
    }

    function saveCopy(name) {
        var a = api(), cn = caseNumber();
        if (!a || !cn || !name) return Promise.resolve(null);
        return Promise.resolve(a.reportDocSaveCopy(cn, name)).then(function (r) {
            if (!r || r.canceled) return null;
            if (!r.success) { fail(r, 'Could not save a copy'); return null; }
            var d = findDoc(name);
            toast('Copy saved to <b>' + esc(r.filePath) + '</b>. Send it with your export \u2014 it is not inside the DA package.' +
                (d && d.open ? '<br>It holds your last save in Word.' : ''), 'success', 9000);
            return r.filePath;
        }, function (e) { fail({ error: e && e.message }, 'Could not save a copy'); return null; });
    }

    /** Single click entry point for every button this module draws. */
    function act(action, el, ev) {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        var name = el && el.getAttribute ? el.getAttribute('data-wr-name') : null;
        switch (action) {
            case 'mode-word': return switchTo('word');
            case 'mode-viper': return switchTo('viper');
            case 'open': return openDoc(name);
            case 'copy': return saveCopy(name);
            case 'rename': return renameDoc(name);
            case 'replace': return replaceDoc(name);
            case 'remove': return removeDoc(name);
            case 'create': return create();
            case 'create-another': return createAnother();
            case 'import': return importDoc(null);
        }
        return null;
    }

    /**
     * host: {
     *   getCaseNumber() → string,
     *   getFormat() → 'word' | 'viper', setFormat(fmt) → bool (false = not saved),
     *   getViperHtml() → the VIPER editor's HTML, saveViperReport(),
     *   rerender() → repaint the whole Reports tab,
     *   toast?(), confirm?(), ask?(spec), api?
     * }
     * Safe to call on every render — the cached list is kept unless the case changed.
     */
    function configure(h) {
        host = h || {};
        var cn = caseNumber();
        if (cn !== state.loadedFor && !state.loading) {
            state.docs = []; state.loadError = null; state.busy = {};
            state.loadedFor = null;
        }
        subscribe();
    }

    return {
        DISCLAIMER: DISCLAIMER,
        configure: configure,
        renderPanel: renderPanel,
        renderModeSwitch: renderModeSwitch,
        refresh: refresh,
        invalidate: invalidate,
        act: act,
        htmlToText: htmlToText,
        // exposed for tests
        _state: function () { return state; },
        _setState: function (patch) { for (var k in patch) state[k] = patch[k]; },
        _onEvent: onEvent,
        _nextName: nextName,
    };
}));

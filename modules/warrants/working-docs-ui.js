/*
 * Working Documents — the Warrants-tab half (renderer).
 *
 * An investigator's running affidavit and warrant drafts, kept as live Word
 * documents inside the case. This file draws:
 *   - the case-level "Working Documents" panel above the warrant list, and
 *   - one "Working draft" row inside each warrant card,
 * and turns clicks into calls on window.electronAPI.workingDoc*.
 *
 * The main process (modules/warrants/working-docs.js) owns the files; the
 * folder cases/<caseNumber>/Warrants/Working/ is the only list. A warrant
 * links a draft by FILE NAME (warrant.workingDocName) — nothing else about
 * the document is stored in localStorage.
 *
 * Host state reaches this module only through configure(): the case page
 * declares currentCase / caseWarrants with top-level `let`, which never
 * lands on window.
 *
 * UMD, assigned to BOTH module.exports and the global: `module` IS defined
 * in VIPER's renderer, so an either/or wrapper would leave window.X unset.
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root) root.WorkingDocsUI = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    var host = {};
    var state = {
        loadedFor: null,     // case number the cached list belongs to
        docs: [],            // [{fileName, bytes, modifiedAt, open, lastSavedAt, error}]
        loading: null,       // in-flight refresh promise
        again: false,        // another refresh was asked for while one ran
        loadError: null,
        busy: {},            // fileName → true while an action on it runs
        unsubscribe: null,
    };

    // ── small helpers ────────────────────────────────────────────────────
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function api() { return host.api || (typeof window !== 'undefined' && window.electronAPI) || null; }
    function caseNumber() { try { return host.getCaseNumber ? host.getCaseNumber() : null; } catch (_) { return null; } }
    function warrants() { try { return (host.getWarrants && host.getWarrants()) || []; } catch (_) { return []; } }
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

    var WORD_EXT = /\.(docx|doc|rtf)$/i;
    function baseName(n) { return String(n || '').replace(WORD_EXT, ''); }

    function fmtTime(iso) {
        if (!iso) return '';
        var d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        var now = new Date();
        var sameDay = d.toDateString() === now.toDateString();
        var t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        return sameDay ? t : (d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' }) + ' ' + t);
    }

    function isPreservation(w) {
        if (host.isPreservation) { try { return !!host.isPreservation(w); } catch (_) {} }
        var t = String((w && w.type) || '').toLowerCase();
        return t === 'preservation';
    }
    var TYPE_LABELS = {
        search: 'Search Warrant', arrest: 'Arrest Warrant', preservation: 'Preservation Request',
        subpoena: 'Subpoena', 'court-order': 'Court Order', prtt: 'PRTT Order', other: 'Warrant',
    };
    function warrantLabel(w) {
        var t = isPreservation(w) ? 'Preservation Request' : (TYPE_LABELS[String((w && w.type) || '').toLowerCase()] || 'Warrant');
        return w && w.issuedTo ? t + ' – ' + w.issuedTo : t;
    }
    /** Default name for a draft made from `sourceName` for warrant `w`. */
    function suggestedName(sourceName, w) {
        var label = w ? warrantLabel(w) : '';
        if (label) return label;
        return baseName(sourceName) + ' – new';
    }

    function findDoc(name) {
        var low = String(name || '').toLowerCase();
        for (var i = 0; i < state.docs.length; i++) if (state.docs[i].fileName.toLowerCase() === low) return state.docs[i];
        return null;
    }
    function linkedWarrants(name) {
        var low = String(name || '').toLowerCase();
        return warrants().filter(function (w) { return w && w.workingDocName && String(w.workingDocName).toLowerCase() === low; });
    }
    function findWarrant(id) {
        var ws = warrants();
        for (var i = 0; i < ws.length; i++) if (ws[i] && String(ws[i].id) === String(id)) return ws[i];
        return null;
    }
    function saveWarrants() { try { if (host.saveWarrants) host.saveWarrants(); } catch (e) { toast('Could not save the warrant link: ' + esc(e && e.message), 'error', 8000); } }

    // ── loading ──────────────────────────────────────────────────────────
    function refresh() {
        var cn = caseNumber();
        var a = api();
        if (!cn || !a || !a.workingDocsList) return Promise.resolve(state.docs);
        if (state.loading) { state.again = true; return state.loading; }
        state.loading = Promise.resolve()
            .then(function () { return a.workingDocsList(cn); })
            .then(function (r) {
                if (caseNumber() !== cn) return;      // the officer moved on
                if (r && r.success) { state.docs = r.docs || []; state.loadError = null; }
                else { state.loadError = (r && r.error) || 'Could not read the working documents.'; }
                state.loadedFor = cn;
            }, function (e) {
                state.loadError = (e && e.message) || String(e);
                state.loadedFor = cn;
            })
            .then(function () {
                state.loading = null;
                repaint();
                // Asked again meanwhile, or the officer opened another case
                // while this list was loading: load the one now on screen.
                if (state.again || (caseNumber() && caseNumber() !== state.loadedFor)) { state.again = false; return refresh(); }
                return state.docs;
            });
        return state.loading;
    }

    function subscribe() {
        var a = api();
        if (state.unsubscribe || !a || !a.onWorkingDocEvent) return;
        state.unsubscribe = a.onWorkingDocEvent(onEvent) || function () {};
    }

    function onEvent(evt) {
        if (!evt || evt.caseNumber !== caseNumber()) {
            // Another case's document: nothing on screen to update, but a
            // failure must still be heard.
            if (evt && evt.type === 'error') toast(esc(evt.fileName) + ' (case ' + esc(evt.caseNumber) + '): ' + esc(evt.message), 'error', 10000);
            return;
        }
        var d = findDoc(evt.fileName);
        if (evt.type === 'saved') {
            if (d) { d.open = true; d.lastSavedAt = evt.savedAt; d.error = null; if (typeof evt.bytes === 'number') d.bytes = evt.bytes; }
            repaint();
        } else if (evt.type === 'error') {
            if (d) d.error = evt.message;
            toast(esc(evt.fileName) + ': ' + esc(evt.message), 'error', 10000);
            repaint();
        } else if (evt.type === 'recovered') {
            toast(evt.action === 'recover-beside'
                ? 'A Word save that had not reached the case was kept as <b>' + esc(evt.fileName) + '</b>, beside the case copy (both had changed).'
                : 'A Word save that had not reached the case was brought in: <b>' + esc(evt.fileName) + '</b>.', 'info', 10000);
            refresh();
        } else {
            refresh();    // opened / closed
        }
    }

    // ── rendering ────────────────────────────────────────────────────────
    function btn(action, label, cls, attrs) {
        return '<button type="button" onclick="WorkingDocsUI.act(\'' + action + '\', this, event)" ' + (attrs || '') +
            ' class="text-xs px-3 py-1 rounded ' + (cls || 'bg-viper-card/60 text-gray-300 hover:bg-viper-card') + ' transition-colors whitespace-nowrap">' + label + '</button>';
    }
    function nameAttr(name) { return 'data-wd-name="' + esc(name) + '"'; }

    function statusLine(d) {
        if (d.error) return '<span class="text-red-400">' + esc(d.error) + '</span>';
        if (d.open) {
            return '<span class="text-green-400">Open in Word' + (d.lastSavedAt ? ' · saved into the case ' + esc(fmtTime(d.lastSavedAt)) : ' · your saves go into the case') + '</span>';
        }
        return '<span class="text-gray-500">Last changed ' + esc(fmtTime(d.modifiedAt)) + '</span>';
    }

    function docRow(d) {
        var links = linkedWarrants(d.fileName);
        var busy = !!state.busy[d.fileName];
        return '' +
            '<div class="flex items-center justify-between gap-3 bg-viper-card/30 rounded-lg px-3 py-2" data-wd-row="' + esc(d.fileName) + '">' +
                '<div class="min-w-0 flex-1">' +
                    '<div class="flex items-center gap-2 flex-wrap">' +
                        '<span class="text-sm font-medium truncate" title="' + esc(d.fileName) + '">📝 ' + esc(d.fileName) + '</span>' +
                        links.map(function (w) {
                            return '<span class="text-[11px] px-2 py-0.5 rounded-full bg-viper-orange/15 text-viper-orange border border-viper-orange/30">' + esc(warrantLabel(w)) + '</span>';
                        }).join('') +
                    '</div>' +
                    '<div class="text-xs mt-0.5">' + statusLine(d) + '</div>' +
                '</div>' +
                '<div class="flex gap-1 flex-shrink-0 flex-wrap justify-end">' +
                    btn('open', busy ? 'Opening…' : 'Open in Word', 'bg-viper-orange/20 text-viper-orange hover:bg-viper-orange/30', nameAttr(d.fileName) + (busy ? ' disabled' : '')) +
                    btn('copy', 'New from this…', null, nameAttr(d.fileName)) +
                    btn('rename', 'Rename', null, nameAttr(d.fileName) + (d.open ? ' disabled title="Close it in Word first"' : '')) +
                    btn('remove', 'Remove', 'bg-red-500/10 text-red-400 hover:bg-red-500/20', nameAttr(d.fileName) + (d.open ? ' disabled title="Close it in Word first"' : '')) +
                '</div>' +
            '</div>';
    }

    function panelInner() {
        var cn = caseNumber();
        var body;
        if (state.loadedFor !== cn) {
            body = '<p class="text-xs text-gray-500">Loading…</p>';
        } else if (state.loadError) {
            body = '<p class="text-xs text-red-400">' + esc(state.loadError) + '</p>';
        } else if (!state.docs.length) {
            body = '<p class="text-xs text-gray-500">No working documents yet. Add your running affidavit or warrant drafts here — they open in Word, and every time you save in Word it goes into the case.</p>';
        } else {
            body = '<div class="space-y-2">' + state.docs.map(docRow).join('') + '</div>';
        }
        return '' +
            '<div class="flex items-start justify-between gap-3 flex-wrap mb-3">' +
                '<div class="min-w-0">' +
                    '<h4 class="text-base font-bold">📝 Working Documents</h4>' +
                    '<p class="text-xs text-gray-400 mt-0.5">Your live Word drafts. They open in Microsoft Word, and every save goes into the case automatically. Drafts are left out of DA and assist exports.</p>' +
                '</div>' +
                '<div class="flex gap-2 flex-shrink-0 flex-wrap">' +
                    btn('add', '+ Add Word Document', 'bg-viper-orange/20 text-viper-orange border border-viper-orange/30 hover:bg-viper-orange/30') +
                    btn('blank', 'New blank') +
                '</div>' +
            '</div>' + body;
    }

    function warrantRowInner(w) {
        var name = w && w.workingDocName;
        var d = name ? findDoc(name) : null;
        var label = '<span class="text-sm">📝 Working draft</span>';
        if (name && state.loadedFor === caseNumber() && !d) {
            return '' +
                '<div class="flex items-center justify-between gap-2 flex-wrap">' +
                    '<div class="min-w-0">' + label + ' <span class="text-xs text-amber-400">“' + esc(name) + '” is no longer in this case.</span></div>' +
                    '<div class="flex gap-1">' + btn('unlink', 'Unlink', null, 'data-wd-warrant-id="' + esc(w.id) + '"') + '</div>' +
                '</div>';
        }
        if (name) {
            return '' +
                '<div class="flex items-center justify-between gap-2 flex-wrap">' +
                    '<div class="min-w-0 flex-1">' + label + ' <span class="text-sm text-gray-300 break-all">' + esc(name) + '</span>' +
                        (d ? '<div class="text-xs mt-0.5">' + statusLine(d) + '</div>' : '') +
                    '</div>' +
                    '<div class="flex gap-1 flex-shrink-0">' +
                        btn('open', state.busy[name] ? 'Opening…' : 'Open in Word', 'bg-viper-orange/20 text-viper-orange hover:bg-viper-orange/30', nameAttr(name)) +
                        btn('unlink', 'Unlink', null, 'data-wd-warrant-id="' + esc(w.id) + '"') +
                    '</div>' +
                '</div>';
        }
        var hasDocs = state.docs.length > 0;
        return '' +
            '<div class="flex items-center justify-between gap-2 flex-wrap">' +
                '<div class="min-w-0">' + label + ' <span class="text-xs text-gray-500">none linked</span></div>' +
                '<div class="flex gap-1 flex-shrink-0 flex-wrap">' +
                    (hasDocs ? btn('newfor', 'New from…', 'bg-viper-orange/20 text-viper-orange hover:bg-viper-orange/30', 'data-wd-warrant-id="' + esc(w.id) + '"') : '') +
                    btn('link', hasDocs ? 'Link a document…' : 'Attach Word document…', null, 'data-wd-warrant-id="' + esc(w.id) + '"') +
                '</div>' +
            '</div>';
    }

    /** The case-level panel. Call from the Warrants tab template. */
    function renderPanel() {
        subscribe();
        var cn = caseNumber();
        if (cn && state.loadedFor !== cn && !state.loading) setTimeout(refresh, 0);
        return '<div id="wdPanel" class="glass-card rounded-xl p-5 border border-viper-orange/20">' + panelInner() + '</div>';
    }

    /** One row inside a warrant card. */
    function renderWarrantRow(w) {
        if (!w) return '';
        return '<div class="bg-viper-card/30 rounded p-2" data-wd-warrant="' + esc(w.id) + '">' + warrantRowInner(w) + '</div>';
    }

    /** Repaint what is on screen without re-rendering the whole tab. */
    function repaint() {
        var p = doc$('wdPanel');
        if (p) p.innerHTML = panelInner();
        if (typeof document === 'undefined' || !document.querySelectorAll) return;
        var rows = document.querySelectorAll('[data-wd-warrant]');
        for (var i = 0; i < rows.length; i++) {
            var w = findWarrant(rows[i].getAttribute('data-wd-warrant'));
            if (w) rows[i].innerHTML = warrantRowInner(w);
        }
    }

    // ── the small dialogs ────────────────────────────────────────────────
    /**
     * ask(spec) → Promise<null | {name, source}>
     * spec: { title, text?, name?, sources?: [fileName], source?, okText, allowImport? }
     * Returns { import: true } when the officer picks "from my computer".
     */
    function ask(spec) {
        if (host.ask) return Promise.resolve(host.ask(spec));
        if (typeof document === 'undefined' || !document.createElement) return Promise.resolve(null);
        return new Promise(function (resolve) {
            var wrap = document.createElement('div');
            wrap.className = 'fixed inset-0 z-[9999] flex items-center justify-center bg-black/60';
            var srcSel = '';
            if (spec.sources && spec.sources.length) {
                srcSel = '<label class="block text-xs text-gray-400 mb-1">' + esc(spec.sourceLabel || 'Copy from') + '</label>' +
                    '<select data-wd-f="source" class="w-full mb-3 px-3 py-2 bg-viper-card/50 border border-gray-600 rounded-lg text-sm">' +
                    spec.sources.map(function (s) {
                        return '<option value="' + esc(s) + '"' + (s === spec.source ? ' selected' : '') + '>' + esc(s) + '</option>';
                    }).join('') + '</select>';
            }
            var nameIn = spec.name === undefined ? '' :
                '<label class="block text-xs text-gray-400 mb-1">Name</label>' +
                '<input data-wd-f="name" type="text" maxlength="110" value="' + esc(spec.name) + '" class="w-full px-3 py-2 bg-viper-card/50 border border-gray-600 rounded-lg text-sm">';
            wrap.innerHTML = '' +
                '<div class="glass-card rounded-xl p-6 w-full max-w-md border border-viper-orange/30" style="background: rgb(var(--vp-card, 30 31 38));">' +
                    '<h4 class="text-lg font-bold mb-2">' + esc(spec.title) + '</h4>' +
                    (spec.text ? '<p class="text-xs text-gray-400 mb-3">' + esc(spec.text) + '</p>' : '') +
                    srcSel + nameIn +
                    '<div class="flex justify-between items-center gap-2 mt-5">' +
                        (spec.allowImport ? '<button type="button" data-wd-b="import" class="text-xs px-3 py-2 rounded-lg bg-viper-card/60 text-gray-300 hover:bg-viper-card">From my computer…</button>' : '<span></span>') +
                        '<div class="flex gap-2">' +
                            '<button type="button" data-wd-b="cancel" class="px-4 py-2 rounded-lg text-sm text-gray-300 hover:bg-viper-card/60">Cancel</button>' +
                            '<button type="button" data-wd-b="ok" class="px-4 py-2 rounded-lg text-sm bg-viper-orange/20 text-viper-orange border border-viper-orange/30 hover:bg-viper-orange/30">' + esc(spec.okText || 'OK') + '</button>' +
                        '</div>' +
                    '</div>' +
                '</div>';
            function done(v) { document.removeEventListener('keydown', onKey, true); if (wrap.parentNode) wrap.parentNode.removeChild(wrap); resolve(v); }
            function collect() {
                var n = wrap.querySelector('[data-wd-f="name"]');
                var s = wrap.querySelector('[data-wd-f="source"]');
                return { name: n ? n.value : undefined, source: s ? s.value : undefined };
            }
            function onKey(e) {
                if (e.key === 'Escape') { e.preventDefault(); done(null); }
                else if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT') { e.preventDefault(); done(collect()); }
            }
            wrap.addEventListener('click', function (e) {
                var b = e.target && e.target.closest ? e.target.closest('[data-wd-b]') : null;
                if (e.target === wrap) return done(null);
                if (!b) return;
                var k = b.getAttribute('data-wd-b');
                if (k === 'cancel') done(null);
                else if (k === 'import') done({ import: true });
                else done(collect());
            });
            document.addEventListener('keydown', onKey, true);
            document.body.appendChild(wrap);
            var first = wrap.querySelector('[data-wd-f="name"]') || wrap.querySelector('select');
            if (first) { first.focus(); if (first.select) first.select(); }
        });
    }

    // ── actions ──────────────────────────────────────────────────────────
    function fail(r, what) {
        toast(esc(what) + ': ' + esc((r && r.error) || 'something went wrong.'), 'error', 9000);
    }

    function openDoc(name) {
        var a = api(), cn = caseNumber();
        if (!a || !cn || !name || state.busy[name]) return Promise.resolve(false);
        state.busy[name] = true; repaint();
        return Promise.resolve(a.workingDocOpen(cn, name)).then(function (r) {
            delete state.busy[name];
            if (!r || !r.success) { fail(r, 'Could not open ' + name); repaint(); return false; }
            var d = findDoc(name); if (d) d.open = true;
            repaint();
            if (!r.alreadyOpen) toast('Opening <b>' + esc(name) + '</b> in Word. Every save you make there goes into the case.', 'info', 5000);
            return true;
        }, function (e) { delete state.busy[name]; fail({ error: e && e.message }, 'Could not open ' + name); repaint(); return false; });
    }

    function addFromComputer(linkTo) {
        var a = api(), cn = caseNumber();
        if (!a || !cn) return Promise.resolve(null);
        return Promise.resolve(a.workingDocImport(cn)).then(function (r) {
            if (!r || r.canceled) return null;
            (r.failed || []).forEach(function (f) { toast(esc(f.fileName) + ': ' + esc(f.error), 'error', 9000); });
            if (!r.success && !(r.added && r.added.length)) { if (!(r.failed && r.failed.length)) fail(r, 'Could not add the document'); return null; }
            var added = r.added || [];
            if (linkTo && added.length) { linkTo.workingDocName = added[0]; saveWarrants(); }
            if (added.length) toast('Added to the case: <b>' + added.map(esc).join('</b>, <b>') + '</b>', 'success', 5000);
            return refresh().then(function () { return added; });
        });
    }

    function newBlank() {
        var a = api(), cn = caseNumber();
        if (!a || !cn) return Promise.resolve(null);
        return ask({ title: 'New blank Word document', name: 'New Document', okText: 'Create' }).then(function (v) {
            if (!v || !String(v.name || '').trim()) return null;
            return Promise.resolve(a.workingDocNewBlank(cn, v.name)).then(function (r) {
                if (!r || !r.success) { fail(r, 'Could not create the document'); return null; }
                return refresh().then(function () { return openDoc(r.fileName); }).then(function () { return r.fileName; });
            });
        });
    }

    /** New draft copied from an existing one; optionally linked to warrant w. */
    function newFrom(sourceName, w) {
        var a = api(), cn = caseNumber();
        if (!a || !cn || !state.docs.length) return Promise.resolve(null);
        var src = sourceName || (state.docs[0] && state.docs[0].fileName);
        return ask({
            title: w ? 'New draft for ' + warrantLabel(w) : 'New document from ' + src,
            text: 'Makes a copy you can edit. The original stays as it is.',
            sources: state.docs.map(function (d) { return d.fileName; }),
            source: src, sourceLabel: 'Copy from',
            name: suggestedName(src, w), okText: 'Create and open',
        }).then(function (v) {
            if (!v || !v.source || !String(v.name || '').trim()) return null;
            return Promise.resolve(a.workingDocNewFrom(cn, v.source, v.name)).then(function (r) {
                if (!r || !r.success) { fail(r, 'Could not make the copy'); return null; }
                if (w) { w.workingDocName = r.fileName; saveWarrants(); }
                return refresh().then(function () { return openDoc(r.fileName); }).then(function () { return r.fileName; });
            });
        });
    }

    function renameDoc(name) {
        var a = api(), cn = caseNumber();
        if (!a || !cn) return Promise.resolve(null);
        return ask({ title: 'Rename document', name: baseName(name), okText: 'Rename' }).then(function (v) {
            if (!v || !String(v.name || '').trim()) return null;
            return Promise.resolve(a.workingDocRename(cn, name, v.name)).then(function (r) {
                if (!r || !r.success) { fail(r, 'Could not rename'); return null; }
                var linked = linkedWarrants(name);
                if (linked.length && r.fileName !== name) {
                    linked.forEach(function (w) { w.workingDocName = r.fileName; });
                    saveWarrants();
                }
                return refresh().then(function () { return r.fileName; });
            });
        });
    }

    function removeDoc(name) {
        var a = api(), cn = caseNumber();
        if (!a || !cn) return Promise.resolve(false);
        var linked = linkedWarrants(name);
        var msg = 'Remove "' + name + '" from this case? It goes to the Windows Recycle Bin, so it can be restored from there.' +
            (linked.length ? '\n\nIt is linked to: ' + linked.map(warrantLabel).join(', ') + '. Those links will be cleared.' : '');
        return confirmBox(msg, { danger: true, okText: 'Remove' }).then(function (yes) {
            if (!yes) return false;
            return Promise.resolve(a.workingDocRemove(cn, name)).then(function (r) {
                if (!r || !r.success) { fail(r, 'Could not remove'); return false; }
                if (linked.length) { linked.forEach(function (w) { delete w.workingDocName; }); saveWarrants(); }
                return refresh().then(function () { return true; });
            });
        });
    }

    function linkDoc(w) {
        if (!w) return Promise.resolve(null);
        if (!state.docs.length) return addFromComputer(w);
        return ask({
            title: 'Link a working document to ' + warrantLabel(w),
            sources: state.docs.map(function (d) { return d.fileName; }),
            source: state.docs[0].fileName, sourceLabel: 'Document',
            okText: 'Link', allowImport: true,
        }).then(function (v) {
            if (!v) return null;
            if (v.import) return addFromComputer(w);
            if (!v.source) return null;
            w.workingDocName = v.source; saveWarrants(); repaint();
            return v.source;
        });
    }

    function unlink(w) {
        if (!w || !w.workingDocName) return;
        delete w.workingDocName;
        saveWarrants();
        repaint();
    }

    /** Single click entry point for every button this module draws. */
    function act(action, el, ev) {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        var name = el && el.getAttribute ? el.getAttribute('data-wd-name') : null;
        var wid = el && el.getAttribute ? el.getAttribute('data-wd-warrant-id') : null;
        var w = wid != null ? findWarrant(wid) : null;
        switch (action) {
            case 'open': return openDoc(name);
            case 'copy': return newFrom(name, null);
            case 'rename': return renameDoc(name);
            case 'remove': return removeDoc(name);
            case 'add': return addFromComputer(null);
            case 'blank': return newBlank();
            case 'link': return linkDoc(w);
            case 'newfor': return newFrom(null, w);
            case 'unlink': return unlink(w);
        }
    }

    /**
     * host: {
     *   getCaseNumber() → string, getWarrants() → array (live, mutable),
     *   saveWarrants(), toast?(), confirm?(), ask?(), api?
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
        configure: configure,
        renderPanel: renderPanel,
        renderWarrantRow: renderWarrantRow,
        refresh: refresh,
        act: act,
        // exposed for tests
        _state: function () { return state; },
        _setState: function (patch) { for (var k in patch) state[k] = patch[k]; },
        _onEvent: onEvent,
        _suggestedName: suggestedName,
        _warrantLabel: warrantLabel,
        _esc: esc,
    };
}));

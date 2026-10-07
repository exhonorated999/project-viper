/*
 * Field Work — the desktop tab.
 *
 * Area Canvas is a crew working one neighbourhood off one shared form. Field
 * Work is one investigator, their own case, and a form shaped to the job in
 * front of them: a surveillance sit, an interview, a knock and talk.
 *
 * WHY THIS IS A MODULE AND NOT MORE INLINE HTML
 * ---------------------------------------------
 * Area Canvas lives as ~2,400 lines inside case-detail-with-analytics.html.
 * That file is already 44,000 lines and every function in it shares one
 * lexical scope, so the cost of a mistake there is paid by every other tab.
 * Field Work keeps its state, its markup and its relay calls in here, and
 * reaches the host through exactly one `configure()` object. The host glue
 * is about forty lines.
 *
 * WHAT THE HOST STILL OWNS
 * ------------------------
 * Writing an evidence record, the audit log, and the Connection Board sync.
 * Those touch stores the host declares with top-level `let` — which in a
 * classic <script> are NOT on window and cannot be reached from a module
 * file at all. They are passed in as closures.
 *
 * RELATIONSHIP TO THE RELAY
 * -------------------------
 * Field Work's capture happens on the PHONE, not here. The desktop creates
 * the form, shows the QR, and pulls the results down. So unlike Area Canvas
 * this module has no camera code: its media surface is a gallery, a preview,
 * a preserve-to-evidence path and a delete. A desk-side entry can still
 * attach files it already has, through the same on-disk writer the relay
 * import uses, so a case folder never contains two naming schemes.
 */
(function (root, factory) {
    var api = factory();
    // `module` IS defined in VIPER's renderer. Assigning to only one of
    // these leaves window.FieldWorkUI undefined and every host branch
    // silently does nothing — no error, no log, the tab just never renders.
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root) root.FieldWorkUI = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    var SCHEMA = (typeof require === 'function' && typeof module === 'object' && module.exports)
        ? require('./field-work-schema.js')
        : (typeof globalThis !== 'undefined' ? globalThis.FieldWorkSchema : null);

    /*
     * Resolving the schema at factory time means a <script> tag written in the
     * wrong order leaves SCHEMA permanently null, and the failure is a tab that
     * renders an empty preset list rather than an error anyone would notice.
     * Re-resolve on every entry point instead; by the time a tab is painted the
     * other script has certainly run.
     */
    function resolveSchema() {
        if (!SCHEMA && typeof globalThis !== 'undefined' && globalThis.FieldWorkSchema) {
            SCHEMA = globalThis.FieldWorkSchema;
        }
        return SCHEMA;
    }

    /* ── Host wiring ─────────────────────────────────────────────────── */

    var host = {
        getCaseId: function () { return ''; },
        getCaseNumber: function () { return ''; },
        getCaseRef: function () { return ''; },
        toast: function (m) { try { console.log('[fieldwork]', m); } catch (_) {} },
        confirm: function () { return Promise.resolve(false); },
        apiCall: null,
        rerender: function () {},
        addEvidence: null,
        syncBoard: function () { return false; },
        audit: function () {}
    };

    function configure(h) {
        resolveSchema();
        Object.keys(h || {}).forEach(function (k) {
            if (h[k] != null) host[k] = h[k];
        });
        /*
         * Reset ONLY when the case actually changed.
         *
         * The host calls configure() on every single tab render, so an
         * unconditional reset here threw away viewIndex before renderTab()
         * could read it: clicking an entry set the index, asked for a
         * repaint, and the repaint cleared it again. The detail view was
         * unreachable and the symptom looked like a dead card rather than
         * state being wiped. It also re-read localStorage every paint.
         *
         * loadedFor is null before the first load, when there is nothing to
         * throw away.
         */
        var id = host.getCaseId();
        if (loadedFor !== null && loadedFor !== id) reset();
    }

    /* ── State ───────────────────────────────────────────────────────── */

    var entries = [];
    var forms = [];
    var loadedFor = null;      // case id the arrays above belong to
    var viewIndex = null;      // null = list, otherwise the open entry
    var filter = 'all';
    var draft = null;          // create-form modal working copy
    var preservePicks = null;
    var preserveEntryIndex = null;
    var objectUrls = [];       // revoked on teardown — these are heap, not disk

    function reset() {
        entries = [];
        forms = [];
        loadedFor = null;
        viewIndex = null;
        filter = 'all';
    }

    function entriesKey() { return 'fieldwork_' + host.getCaseId(); }
    function formsKey() { return 'fieldworkForms_' + host.getCaseId(); }

    function _lsParse(key, fallback) {
        try {
            var raw = localStorage.getItem(key);
            if (!raw) return fallback;
            var v = JSON.parse(raw);
            return v == null ? fallback : v;
        } catch (_) { return fallback; }
    }

    function load() {
        var id = host.getCaseId();
        if (!id) return;
        if (loadedFor === id) return;
        entries = _lsParse(entriesKey(), []);
        if (!Array.isArray(entries)) entries = [];
        forms = _lsParse(formsKey(), []);
        if (!Array.isArray(forms)) forms = [];
        loadedFor = id;
    }

    function saveEntries() {
        if (!host.getCaseId()) return;
        localStorage.setItem(entriesKey(), JSON.stringify(entries));
    }

    function saveForms() {
        if (!host.getCaseId()) return;
        localStorage.setItem(formsKey(), JSON.stringify(forms));
    }

    /* ── Small helpers ───────────────────────────────────────────────── */

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // For a value going into a single-quoted inline handler. Backslash first
    // or the escapes we add get escaped in turn.
    function jsq(s) {
        return String(s == null ? '' : s)
            .replace(/\\/g, '\\\\').replace(/'/g, "\\'")
            .replace(/\r?\n/g, ' ').replace(/</g, '\\u003c');
    }

    function prettyBytes(n) {
        var b = Number(n) || 0;
        if (b < 1024) return b + ' B';
        if (b < 1048576) return Math.round(b / 1024) + ' KB';
        return (b / 1048576).toFixed(1) + ' MB';
    }

    function when(iso) {
        if (!iso) return '';
        var d = new Date(iso);
        return isNaN(d.getTime()) ? '' : d.toLocaleString();
    }

    function timeRemaining(expiresAt) {
        if (!expiresAt) return '';
        var diff = new Date(expiresAt) - new Date();
        if (diff <= 0) return 'Expired';
        var hrs = Math.floor(diff / 3600000);
        var mins = Math.floor((diff % 3600000) / 60000);
        return hrs > 0 ? (hrs + 'h ' + mins + 'm remaining') : (mins + 'm remaining');
    }

    function isExpired(form) {
        return !!(form && form.expiresAt && new Date(form.expiresAt) < new Date());
    }

    function api() {
        return (typeof window !== 'undefined' && window.electronAPI) ? window.electronAPI : null;
    }

    function relayAvailable() {
        var a = api();
        return !!(a && a.fieldWorkFormCreate);
    }

    function call(fn) {
        if (typeof host.apiCall === 'function') return host.apiCall(fn);
        return Promise.reject(new Error('Not registered — activate your VIPER license in Settings.'));
    }

    /* ── File naming ─────────────────────────────────────────────────── */

    function slug(s) {
        return String(s || '')
            .replace(/[^A-Za-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 40) || 'entry';
    }

    function extFor(kind, mime, originalName) {
        var m = String(mime || '').toLowerCase();
        if (kind === 'document') {
            // A document's own extension is the only reliable signal — the
            // phone sends application/octet-stream for plenty of real file
            // types, and a .docx renamed .bin will not open for anyone.
            var dot = String(originalName || '').lastIndexOf('.');
            if (dot > 0) {
                var e = originalName.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '');
                if (e && e.length <= 5) return e;
            }
            if (m.indexOf('pdf') !== -1) return 'pdf';
            if (m.indexOf('word') !== -1) return 'docx';
            if (m.indexOf('sheet') !== -1 || m.indexOf('excel') !== -1) return 'xlsx';
            if (m.indexOf('text') !== -1) return 'txt';
            return 'bin';
        }
        if (kind === 'photo') {
            if (m.indexOf('png') !== -1) return 'png';
            if (m.indexOf('webp') !== -1) return 'webp';
            return 'jpg';
        }
        if (kind === 'video') return m.indexOf('webm') !== -1 ? 'webm' : 'mp4';
        if (m.indexOf('webm') !== -1) return 'weba';
        if (m.indexOf('mpeg') !== -1) return 'mp3';
        if (m.indexOf('wav') !== -1) return 'wav';
        return 'm4a';
    }

    /**
     * The on-disk name for one Field Work file.
     *
     * Media reaches the case folder by two routes — relayed off a phone, or
     * attached here at the desk — and a folder where the same photo is named
     * two different ways depending on how it arrived is a bad look in
     * discovery. Both routes call this.
     *
     * Documents keep their original stem. A signed consent form filed as
     * "Field Work 2026-10-07 interview document 1.pdf" loses the one piece of
     * information the investigator actually chose.
     */
    function fileNameFor(opts) {
        var o = opts || {};
        var d = o.date instanceof Date ? o.date : (o.date ? new Date(o.date) : new Date());
        if (isNaN(d.getTime())) d = new Date();
        var datePart = d.toISOString().slice(0, 10);
        var n = Math.max(1, Math.round(Number(o.index) || 1));
        var ext = extFor(o.kind, o.mime, o.originalName);

        if (o.kind === 'document') {
            var raw = String(o.originalName || '');
            var dot = raw.lastIndexOf('.');
            var stem = slug(dot > 0 ? raw.slice(0, dot) : raw);
            if (stem === 'entry') stem = 'document-' + n;
            return 'Field Work ' + datePart + ' ' + slug(o.label) + ' ' + stem + '.' + ext;
        }
        return 'Field Work ' + datePart + ' ' + slug(o.label) + ' ' + o.kind + ' ' + n + '.' + ext;
    }

    /* ── Derived views over the entry list ───────────────────────────── */

    function visibleEntries() {
        if (filter === 'followup') return entries.filter(function (e) { return e && e.followUp; });
        if (filter === 'media') return entries.filter(function (e) { return e && (e.media || []).length; });
        if (filter === 'evidence') {
            return entries.filter(function (e) {
                return e && (e.media || []).some(function (m) { return m && m.evidenceTag; });
            });
        }
        return entries.filter(function (e) { return !!e; });
    }

    function stats() {
        var live = entries.filter(Boolean);
        var media = 0, preserved = 0, pending = 0;
        live.forEach(function (e) {
            (e.media || []).forEach(function (m) {
                media++;
                if (m && m.evidenceTag) preserved++;
            });
            pending += (e.relayPending || []).length;
        });
        return {
            total: live.length,
            followUp: live.filter(function (e) { return e.followUp; }).length,
            media: media,
            preserved: preserved,
            pending: pending
        };
    }

    /* ── Tab markup ──────────────────────────────────────────────────── */

    function renderTab() {
        resolveSchema();
        load();
        if (viewIndex != null && entries[viewIndex]) return renderDetail(viewIndex);
        return renderList();
    }

    function statCard(label, value, tone) {
        return '' +
            '<div class="glass-card rounded-xl p-4">' +
                '<p class="text-2xl font-bold ' + tone + '">' + value + '</p>' +
                '<p class="text-xs text-gray-400 mt-1">' + esc(label) + '</p>' +
            '</div>';
    }

    function renderList() {
        var s = stats();
        var list = visibleEntries();

        var filters = [
            ['all', 'All', s.total],
            ['followup', 'Follow-up', s.followUp],
            ['media', 'With attachments', entries.filter(function (e) { return e && (e.media || []).length; }).length],
            ['evidence', 'In evidence', entries.filter(function (e) {
                return e && (e.media || []).some(function (m) { return m && m.evidenceTag; });
            }).length]
        ];

        return '' +
        '<div class="space-y-6">' +

            // Header
            '<div class="flex flex-wrap items-start justify-between gap-3">' +
                '<div>' +
                    '<h2 class="text-2xl font-bold text-white">Field Work</h2>' +
                    '<p class="text-sm text-gray-400 mt-1">Surveillance, interviews, knock &amp; talks — logged from the field on your own phone.</p>' +
                '</div>' +
                '<div class="flex flex-wrap gap-2">' +
                    '<button onclick="FieldWorkUI.showCreateFormModal()" class="px-4 py-2 bg-viper-cyan hover:bg-viper-cyan/80 rounded-lg text-black font-semibold text-sm transition">📱 New Field Form</button>' +
                    '<button onclick="FieldWorkUI.showEntryModal()" class="px-4 py-2 bg-viper-card hover:bg-gray-700 border border-gray-600 rounded-lg text-white text-sm transition">＋ Log Entry Here</button>' +
                    (s.total ? '<button onclick="FieldWorkUI.pushToBoard()" class="px-4 py-2 bg-viper-card hover:bg-gray-700 border border-gray-600 rounded-lg text-white text-sm transition">🗺 Add to Board</button>' : '') +
                '</div>' +
            '</div>' +

            // Stats
            '<div class="grid grid-cols-2 md:grid-cols-4 gap-3">' +
                statCard('Entries', s.total, 'text-white') +
                statCard('Need follow-up', s.followUp, 'text-purple-400') +
                statCard('Attachments', s.media, 'text-viper-orange') +
                statCard('Preserved as evidence', s.preserved, 'text-green-400') +
            '</div>' +

            (s.pending ? '' +
            '<div class="glass-card rounded-xl p-4 border border-red-500/40 text-sm text-red-200">' +
                '⚠️ ' + s.pending + ' attachment(s) from a phone did not finish downloading. The form that carries them is still open — press <strong>Download &amp; Import</strong> on it again to retry.' +
            '</div>' : '') +

            '<div id="fieldWorkFormsSection"></div>' +

            // Filter row
            (s.total ? '' +
            '<div class="flex flex-wrap gap-2">' +
                filters.map(function (f) {
                    var on = filter === f[0];
                    return '<button onclick="FieldWorkUI.setFilter(\'' + f[0] + '\')" class="px-3 py-1.5 rounded-lg text-xs transition border ' +
                        (on ? 'bg-viper-cyan/20 border-viper-cyan text-viper-cyan' : 'bg-transparent border-gray-700 text-gray-400 hover:text-white') +
                        '">' + esc(f[1]) + ' (' + f[2] + ')</button>';
                }).join('') +
            '</div>' : '') +

            // Entries
            (list.length
                ? '<div class="fw-grid">' + list.map(function (e) { return entryCard(e); }).join('') + '</div>'
                : emptyState(s.total)) +
        '</div>';
    }

    function emptyState(total) {
        if (total) {
            return '<div class="fw-empty"><span class="fw-empty-glyph">🔎</span>No entries match this filter.</div>';
        }
        return '' +
        '<div class="fw-empty">' +
            '<span class="fw-empty-glyph">🧭</span>' +
            '<p class="text-white font-semibold">No field work logged yet</p>' +
            '<p class="text-sm mt-2 max-w-md mx-auto">Create a field form, scan the QR with your phone, and everything you record at the scene — notes, photos, audio, a signed PDF — comes back into this case encrypted.</p>' +
            '<p class="text-xs mt-3 text-gray-500">Forms live on the server for 48 hours and are deleted the moment you import them.</p>' +
        '</div>';
    }

    function entryCard(entry) {
        var i = entries.indexOf(entry);
        var color = SCHEMA ? SCHEMA.markerColor(entry) : '#9ca3af';
        var summary = SCHEMA ? SCHEMA.summaryLine(entry) : (entry.notes || '');
        var mediaCount = (entry.media || []).length;
        var inEvidence = (entry.media || []).filter(function (m) { return m && m.evidenceTag; }).length;

        return '' +
        '<div class="fw-card" style="--fw-accent:' + color + '" onclick="FieldWorkUI.openEntry(' + i + ')">' +
            '<div class="flex items-start justify-between gap-2">' +
                '<div class="min-w-0">' +
                    '<p class="fw-card-title">' + esc(entry.address || 'No location recorded') + '</p>' +
                    '<p class="fw-card-sub">' + esc(when(entry.occurredAt || entry.timestamp)) + '</p>' +
                '</div>' +
                '<span class="fw-chip fw-chip-preset">' + esc(entry.presetLabel || 'Field Work') + '</span>' +
            '</div>' +
            (summary ? '<p class="fw-card-summary">' + esc(summary) + '</p>' : '') +
            '<div class="flex flex-wrap gap-1.5 mt-3">' +
                (entry.followUp ? '<span class="fw-chip fw-chip-follow">FOLLOW-UP</span>' : '') +
                (mediaCount ? '<span class="fw-chip fw-chip-media">' + mediaCount + ' file' + (mediaCount === 1 ? '' : 's') + '</span>' : '') +
                (inEvidence ? '<span class="fw-chip fw-chip-ev">' + inEvidence + ' in evidence</span>' : '') +
                ((entry.relayPending || []).length ? '<span class="fw-chip fw-chip-hold">' + entry.relayPending.length + ' not downloaded</span>' : '') +
                (entry.source === 'desk' ? '<span class="fw-chip fw-chip-desk">LOGGED AT DESK</span>' : '') +
            '</div>' +
        '</div>';
    }

    /* ── Detail view ─────────────────────────────────────────────────── */

    function renderDetail(i) {
        var entry = entries[i];
        var f = entry.fields || {};
        var rows = [];

        rows.push(['Location', entry.address || '—']);
        rows.push(['Occurred', when(entry.occurredAt) || '—']);
        rows.push(['Filed', when(entry.timestamp) || '—']);

        (SCHEMA ? SCHEMA.FIELD_ORDER : Object.keys(f)).forEach(function (k) {
            if (k === 'location' || k === 'occurredAt' || k === 'notes') return;
            if (!(k in f)) return;
            var def = SCHEMA ? SCHEMA.FIELD_BY_KEY[k] : null;
            var v = f[k];
            if (def && def.type === 'toggle') v = v ? 'Yes' : 'No';
            if (v === '' || v == null) return;
            rows.push([SCHEMA ? SCHEMA.labelFor(k) : k, v]);
        });

        return '' +
        '<div class="space-y-6">' +
            '<div class="flex flex-wrap items-start justify-between gap-3">' +
                '<div class="min-w-0">' +
                    '<button onclick="FieldWorkUI.backToList()" class="text-xs text-viper-cyan hover:underline">← All field work</button>' +
                    '<h2 class="text-2xl font-bold text-white mt-1">' + esc(entry.address || 'Field Work Entry') + '</h2>' +
                    '<p class="text-sm text-gray-400 mt-1">' +
                        esc(entry.presetLabel || 'Field Work') + ' · ' + esc(when(entry.occurredAt || entry.timestamp)) +
                        (entry.source === 'desk' ? ' · logged at desk' : ' · relayed from the field') +
                    '</p>' +
                '</div>' +
                '<div class="flex flex-wrap gap-2">' +
                    '<button onclick="FieldWorkUI.toggleFollowUp(' + i + ')" class="px-3 py-2 rounded-lg text-sm transition border ' +
                        (entry.followUp
                            ? 'bg-purple-500/20 border-purple-400 text-purple-200'
                            : 'bg-transparent border-gray-600 text-gray-300 hover:text-white') +
                        '">' + (entry.followUp ? '✓ Follow-up flagged' : 'Flag follow-up') + '</button>' +
                    '<button onclick="FieldWorkUI.deleteEntry(' + i + ')" class="px-3 py-2 rounded-lg text-sm transition border border-red-500/40 text-red-300 hover:bg-red-500/10">Delete</button>' +
                '</div>' +
            '</div>' +

            '<div class="glass-card rounded-xl p-5">' +
                '<h3 class="text-sm font-semibold text-viper-cyan mb-3">Entry</h3>' +
                '<dl class="fw-kv">' +
                    rows.map(function (r) {
                        return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>';
                    }).join('') +
                '</dl>' +
                (entry.notes
                    ? '<div class="mt-4 pt-4 border-t border-gray-700">' +
                        '<p class="text-xs text-gray-400 mb-1">Notes</p>' +
                        '<p class="text-sm text-gray-200 whitespace-pre-wrap">' + esc(entry.notes) + '</p>' +
                      '</div>'
                    : '') +
            '</div>' +

            renderGallery(i) +
        '</div>';
    }

    var GLYPH = { photo: '🖼️', video: '🎞️', audio: '🎙️', document: '📄' };

    function renderGallery(i) {
        var entry = entries[i];
        var media = entry.media || [];
        var pending = entry.relayPending || [];

        var head = '' +
            '<div class="flex flex-wrap items-center justify-between gap-2 mb-4">' +
                '<h3 class="text-sm font-semibold text-viper-cyan">Attachments <span class="text-gray-500 font-normal">(' + media.length + ')</span></h3>' +
                (media.some(function (m) { return m && !m.evidenceTag; })
                    ? '<button onclick="FieldWorkUI.preserveSelected(' + i + ')" class="px-3 py-1.5 bg-green-500/15 hover:bg-green-500/25 border border-green-500/40 rounded-lg text-green-300 text-xs transition">Copy ticked to Evidence</button>'
                    : '') +
            '</div>';

        var body;
        if (!media.length && !pending.length) {
            body = '<p class="text-sm text-gray-500">Nothing attached to this entry.</p>';
        } else {
            body = '<div class="fw-gallery">' + media.map(function (m, j) { return tile(i, j, m); }).join('') + '</div>';
        }

        var warn = pending.length
            ? '<p class="text-xs text-red-300 mt-4">⚠️ ' + pending.length + ' file(s) are still on the server and could not be downloaded. The form stays open until they come down — press Download &amp; Import on it again.</p>'
            : '';

        // Say the number out loud. "Not Discoverable" on a tile is easy to
        // tick and then forget, and the consequence of forgetting is a file
        // the DA never sees.
        var held = media.filter(function (m) { return m && m.discoverable === false; }).length;
        var heldNote = held
            ? '<p class="text-xs text-amber-300 mt-4">⊘ ' + held + ' file' + (held === 1 ? ' is' : 's are') +
              ' marked Not Discoverable — withheld from the DA export package and its report.</p>'
            : '';

        return '<div class="glass-card rounded-xl p-5">' + head + body + heldNote + warn + '</div>';
    }

    function tile(entryIndex, j, m) {
        var kind = (m && m.kind) || 'document';
        var preserved = !!(m && m.evidenceTag);
        var withheld = m && m.discoverable === false;
        var pickId = entryIndex + ':' + j;

        var thumb = (kind === 'photo')
            ? '<img data-fw-thumb="' + esc(m.fileName) + '" alt="' + esc(m.fileName) + '">'
            : '<span class="fw-tile-glyph">' + (GLYPH[kind] || '📎') + '</span>';

        // Discovery Status, per file. The DA export reads this flag, so
        // without a control the officer has a withheld-file mechanism they
        // cannot actually operate — and the default is to hand everything
        // over.
        var discBtn = '<button type="button" class="fw-disc ' + (withheld ? 'is-off' : 'is-on') + '"' +
            ' title="' + (withheld ? 'Withheld from the DA export package' : 'Included in the DA export package') + '"' +
            ' onclick="FieldWorkUI.toggleDiscoverable(' + entryIndex + ',' + j + ')">' +
            (withheld ? '⊘ Not Discoverable' : '✓ Discoverable') + '</button>';

        return '' +
        '<div class="fw-tile' + (withheld ? ' is-withheld' : '') + '">' +
            '<div class="fw-tile-thumb" onclick="FieldWorkUI.preview(' + entryIndex + ',' + j + ')" title="Open">' + thumb + '</div>' +
            '<div class="fw-tile-body">' +
                '<p class="fw-tile-name">' + esc(m.fileName) + '</p>' +
                '<p class="fw-tile-meta">' + esc(kind) + ' · ' + prettyBytes(m.bytes) +
                    (m.durationSec ? ' · ' + Math.round(m.durationSec) + 's' : '') + '</p>' +
                (preserved ? '<p class="fw-tile-meta"><span class="fw-chip fw-chip-ev">IN EVIDENCE</span></p>' : '') +
            '</div>' +
            '<div class="fw-tile-actions">' +
                discBtn +
                (preserved
                    ? '<span class="fw-tile-meta">' + esc(m.evidenceTag) + '</span>'
                    : '<label class="fw-pick-wrap"><input type="checkbox" data-fw-pick="' + pickId + '"><span>Preserve</span></label>') +
                '<button class="fw-mini" onclick="FieldWorkUI.preview(' + entryIndex + ',' + j + ')">Open</button>' +
                '<button class="fw-mini fw-del" onclick="FieldWorkUI.deleteMedia(' + entryIndex + ',' + j + ')" title="Delete this file">🗑</button>' +
            '</div>' +
        '</div>';
    }

    /**
     * Flip one attachment's Discovery Status.
     *
     * Mirrors the Area Canvas control exactly, including the wording, so an
     * officer who learns it on one tab already knows it on the other. The
     * flag only ever affects what leaves the building: the file stays in the
     * case folder either way.
     */
    function toggleDiscoverable(entryIndex, j) {
        load();
        var e = entries[entryIndex];
        var m = e && e.media && e.media[j];
        if (!m) return;
        m.discoverable = (m.discoverable === false);
        saveEntries();
        host.audit('fieldwork_discovery_status_changed', {
            fileName: m.fileName,
            discoverable: m.discoverable
        });
        host.toast(m.discoverable
            ? 'Marked Discoverable — included in the DA export.'
            : 'Marked Not Discoverable — withheld from the DA export.',
            m.discoverable ? 'success' : 'info');
        host.rerender();
    }

    /* ── Post-render hydration ───────────────────────────────────────── */

    /**
     * Swap photo placeholders for real pixels.
     *
     * The gallery renders with empty <img> tags because the bytes are on
     * disk — possibly encrypted — and reading them is async. Rendering the
     * markup first means the tab appears instantly and fills in, rather than
     * the whole tab waiting on a dozen file reads.
     */
    function afterRender(rootEl) {
        var container = rootEl || (typeof document !== 'undefined' ? document : null);
        if (!container || typeof container.querySelectorAll !== 'function') return;
        if (relayAvailable()) loadFormsPanel();

        var a = api();
        if (!a || !a.fieldWorkReadMedia) return;
        var caseNumber = host.getCaseNumber();
        if (!caseNumber) return;

        var imgs = container.querySelectorAll('img[data-fw-thumb]');
        Array.prototype.forEach.call(imgs, function (img) {
            var name = img.getAttribute('data-fw-thumb');
            if (!name) return;
            a.fieldWorkReadMedia({ caseNumber: caseNumber, fileName: name }).then(function (res) {
                if (!res || !res.success) {
                    img.replaceWith(makeGlyph(res && res.error));
                    return;
                }
                img.src = 'data:image/*;base64,' + res.dataBase64;
            }).catch(function () { /* leave the placeholder */ });
        });
    }

    function makeGlyph(msg) {
        var span = document.createElement('span');
        span.className = 'fw-tile-glyph';
        span.textContent = '🔒';
        span.title = msg || 'Unavailable';
        return span;
    }

    function teardown() {
        objectUrls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (_) {} });
        objectUrls = [];
    }

    /* ── Filters / navigation ────────────────────────────────────────── */

    function setFilter(f) { filter = f; host.rerender(); }
    function openEntry(i) { viewIndex = i; host.rerender(); }
    function backToList() { viewIndex = null; host.rerender(); }

    function toggleFollowUp(i) {
        var e = entries[i];
        if (!e) return;
        e.followUp = !e.followUp;
        if (!e.fields) e.fields = {};
        e.fields.followUp = e.followUp;
        saveEntries();
        host.rerender();
    }

    function deleteEntry(i) {
        var e = entries[i];
        if (!e) return;
        var files = (e.media || []).filter(function (m) { return m && !m.evidenceTag; });
        var preserved = (e.media || []).length - files.length;
        var msg = 'Delete this field work entry?';
        if (files.length) msg += '\n\n' + files.length + ' attached file(s) will be deleted from the case folder.';
        if (preserved) msg += '\n\n' + preserved + ' file(s) already copied into Evidence will stay there.';

        Promise.resolve(host.confirm(msg, { danger: true, okText: 'Delete' })).then(function (ok) {
            if (!ok) return;
            var a = api();
            var names = files.map(function (m) { return m.fileName; });
            var done = (names.length && a && a.fieldWorkDeleteMedia)
                ? a.fieldWorkDeleteMedia({ caseNumber: host.getCaseNumber(), fileNames: names })
                : Promise.resolve(null);
            done.catch(function () { return null; }).then(function () {
                entries.splice(i, 1);
                viewIndex = null;
                saveEntries();
                host.audit('fieldwork_entry_deleted', {
                    address: e.address || '',
                    filesDeleted: names.length,
                    filesKeptInEvidence: preserved
                });
                host.toast('Entry deleted', 'success');
                host.rerender();
            });
        });
    }

    function deleteMedia(entryIndex, j) {
        var e = entries[entryIndex];
        var m = e && (e.media || [])[j];
        if (!m) return;
        var note = m.evidenceTag
            ? '\n\nThis file has already been copied into Evidence as "' + m.evidenceTag + '". That copy is not affected.'
            : '';
        Promise.resolve(host.confirm('Delete "' + m.fileName + '" from this entry?' + note, { danger: true, okText: 'Delete' }))
            .then(function (ok) {
                if (!ok) return;
                var a = api();
                var done = (a && a.fieldWorkDeleteMedia)
                    ? a.fieldWorkDeleteMedia({ caseNumber: host.getCaseNumber(), fileNames: [m.fileName] })
                    : Promise.resolve(null);
                done.catch(function () { return null; }).then(function () {
                    e.media.splice(j, 1);
                    saveEntries();
                    host.rerender();
                });
            });
    }

    /* ── Preview ─────────────────────────────────────────────────────── */

    function preview(entryIndex, j) {
        var e = entries[entryIndex];
        var m = e && (e.media || [])[j];
        if (!m) return;
        var a = api();
        if (!a || !a.fieldWorkReadMedia) { host.toast('The desktop app is required to open attachments.', 'error'); return; }

        a.fieldWorkReadMedia({ caseNumber: host.getCaseNumber(), fileName: m.fileName }).then(function (res) {
            if (!res || !res.success) {
                host.toast((res && res.error) || 'Could not read that file.', 'error');
                return;
            }
            var bin = atob(res.dataBase64);
            var buf = new Uint8Array(bin.length);
            for (var k = 0; k < bin.length; k++) buf[k] = bin.charCodeAt(k);
            var blob = new Blob([buf], { type: m.mime || 'application/octet-stream' });
            var url = URL.createObjectURL(blob);
            objectUrls.push(url);
            showPreviewModal(m, url);
        }).catch(function (err) {
            host.toast('Could not open: ' + ((err && err.message) || err), 'error');
        });
    }

    function showPreviewModal(m, url) {
        var kind = m.kind || 'document';
        var body;
        if (kind === 'photo') body = '<img src="' + url + '" class="max-h-[70vh] mx-auto rounded-lg">';
        else if (kind === 'video') body = '<video src="' + url + '" controls class="max-h-[70vh] w-full rounded-lg"></video>';
        else if (kind === 'audio') body = '<audio src="' + url + '" controls class="w-full"></audio>';
        else {
            // A PDF renders inline; anything else gets an honest link rather
            // than an <embed> that shows a grey box with no explanation.
            body = (String(m.mime || '').indexOf('pdf') !== -1 || /\.pdf$/i.test(m.fileName))
                ? '<iframe src="' + url + '" class="w-full h-[70vh] rounded-lg bg-white"></iframe>'
                : '<p class="text-gray-300 text-sm">This file type cannot be shown here. ' +
                  '<a href="' + url + '" download="' + esc(m.fileName) + '" class="text-viper-cyan underline">Save a copy</a> to open it in another program.</p>';
        }

        var html = '' +
        '<div id="fwPreviewModal" class="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4" onclick="if(event.target.id===\'fwPreviewModal\')FieldWorkUI.closePreview()">' +
            '<div class="glass-card rounded-xl p-5 max-w-4xl w-full">' +
                '<div class="flex items-start justify-between gap-3 mb-3">' +
                    '<div class="min-w-0">' +
                        '<p class="text-white font-semibold text-sm break-all">' + esc(m.fileName) + '</p>' +
                        '<p class="text-xs text-gray-500">' + esc(kind) + ' · ' + prettyBytes(m.bytes) + '</p>' +
                    '</div>' +
                    '<button onclick="FieldWorkUI.closePreview()" class="text-gray-400 hover:text-white text-xl leading-none">×</button>' +
                '</div>' +
                body +
            '</div>' +
        '</div>';
        document.body.insertAdjacentHTML('beforeend', html);
    }

    function closePreview() {
        var el = document.getElementById('fwPreviewModal');
        if (el) el.remove();
    }

    /* ── Preserve to evidence ────────────────────────────────────────── */

    function preserveSelected(entryIndex) {
        var e = entries[entryIndex];
        if (!e) return;
        // Scoped by entry index: two galleries are never on screen at once
        // today, but a selector that is not scoped would silently sweep the
        // wrong entry's ticks the first time one is.
        var boxes = document.querySelectorAll('input[data-fw-pick^="' + entryIndex + ':"]:checked');
        var picks = [];
        Array.prototype.forEach.call(boxes, function (b) {
            var j = parseInt(String(b.getAttribute('data-fw-pick')).split(':')[1], 10);
            var m = (e.media || [])[j];
            if (m && !m.evidenceTag) picks.push(m);
        });
        if (!picks.length) { host.toast('Tick the files you want preserved first.', 'info'); return; }
        showPreserveModal(entryIndex, picks);
    }

    function evidenceTagFor(entry) {
        var base = (entry && entry.address)
            ? ('Field Work ' + entry.address)
            : 'Field Work Media';
        return base.replace(/[^a-zA-Z0-9 _.-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    }

    function evidenceTypeFor(items) {
        var kinds = {};
        (items || []).forEach(function (m) { if (m) kinds[m.kind] = true; });
        var keys = Object.keys(kinds);
        if (keys.length === 1) {
            if (keys[0] === 'photo') return 'photo';
            if (keys[0] === 'video') return 'video';
            if (keys[0] === 'audio') return 'audio';
            if (keys[0] === 'document') return 'document';
        }
        return 'digital';
    }

    function showPreserveModal(entryIndex, items) {
        var entry = entries[entryIndex];
        preservePicks = items;
        preserveEntryIndex = entryIndex;

        // Discovery Status is per EVIDENCE ITEM, but a field work file
        // carries its own. If the selection disagrees with itself, say so —
        // one choice is about to be applied to all of them.
        var anyHeld = items.some(function (m) { return m && m.discoverable === false; });
        var anyOpen = items.some(function (m) { return !m || m.discoverable !== false; });

        var html = '' +
        '<div id="fwPreserveModal" class="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">' +
            '<div class="glass-card rounded-xl p-6 max-w-lg w-full">' +
                '<h3 class="text-xl font-bold text-white mb-1">Copy to Evidence</h3>' +
                '<p class="text-sm text-gray-400 mb-4">' + items.length + ' file(s) from ' + esc(entry.address || 'this entry') + '. ' +
                    'The field work entry keeps its own copy — this is a copy, not a move.</p>' +
                '<div class="space-y-3">' +
                    '<div>' +
                        '<label class="block text-xs text-gray-400 mb-1">Evidence Tag *</label>' +
                        '<input id="fwPresTag" value="' + esc(evidenceTagFor(entry)) + '" class="w-full px-3 py-2 bg-viper-dark border border-gray-600 rounded-lg text-white text-sm focus:border-viper-cyan focus:outline-none">' +
                    '</div>' +
                    '<div>' +
                        '<label class="block text-xs text-gray-400 mb-1">Description *</label>' +
                        '<textarea id="fwPresDesc" rows="2" class="w-full px-3 py-2 bg-viper-dark border border-gray-600 rounded-lg text-white text-sm focus:border-viper-cyan focus:outline-none" placeholder="What these files show and where they came from">' +
                            esc((entry.presetLabel || 'Field work') + ' — ' + (entry.address || '')) +
                        '</textarea>' +
                    '</div>' +
                    '<div>' +
                        '<label class="block text-xs text-gray-400 mb-1">Location Found</label>' +
                        '<input id="fwPresLoc" value="' + esc(entry.address || '') + '" class="w-full px-3 py-2 bg-viper-dark border border-gray-600 rounded-lg text-white text-sm focus:border-viper-cyan focus:outline-none">' +
                    '</div>' +
                    '<div>' +
                        '<label class="block text-xs text-gray-400 mb-1">Discovery Status</label>' +
                        '<select id="fwPresDisc" class="w-full px-3 py-2 bg-viper-dark border border-gray-600 rounded-lg text-white text-sm focus:border-viper-cyan focus:outline-none">' +
                            '<option value="yes"' + (anyHeld && !anyOpen ? '' : ' selected') + '>Discoverable</option>' +
                            '<option value="no"' + (anyHeld && !anyOpen ? ' selected' : '') + '>Not discoverable</option>' +
                        '</select>' +
                        (anyHeld && anyOpen
                            ? '<p class="text-xs text-amber-300 mt-1">⚠️ These files do not all share a discovery status. Whichever you pick here applies to the whole evidence item.</p>'
                            : '') +
                    '</div>' +
                '</div>' +
                '<div class="flex gap-3 justify-end mt-6 pt-4 border-t border-gray-700">' +
                    '<button onclick="FieldWorkUI.closePreserve()" class="px-5 py-2 bg-gray-600 hover:bg-gray-700 rounded-lg text-white text-sm transition">Cancel</button>' +
                    '<button id="fwPresGo" onclick="FieldWorkUI.confirmPreserve()" class="px-5 py-2 bg-green-600 hover:bg-green-700 rounded-lg text-white text-sm font-semibold transition">Copy to Evidence</button>' +
                '</div>' +
            '</div>' +
        '</div>';
        document.body.insertAdjacentHTML('beforeend', html);
    }

    function closePreserve() {
        var el = document.getElementById('fwPreserveModal');
        if (el) el.remove();
        preservePicks = null;
        preserveEntryIndex = null;
    }

    function confirmPreserve() {
        var items = preservePicks;
        var entry = preserveEntryIndex != null ? entries[preserveEntryIndex] : null;
        if (!items || !items.length || !entry) { closePreserve(); return; }

        var tag = (document.getElementById('fwPresTag') || {}).value || '';
        var description = (document.getElementById('fwPresDesc') || {}).value || '';
        var location = (document.getElementById('fwPresLoc') || {}).value || '';
        var discoverable = ((document.getElementById('fwPresDisc') || {}).value || 'yes') !== 'no';
        tag = tag.trim(); description = description.trim(); location = location.trim();

        if (!tag) { host.toast('Give the evidence item a tag.', 'error'); return; }
        if (!description) { host.toast('Describe what is being preserved.', 'error'); return; }
        var a = api();
        if (!a || !a.fieldWorkMediaToEvidence) {
            host.toast('The desktop app is required to copy files into Evidence.', 'error');
            return;
        }
        if (typeof host.addEvidence !== 'function') {
            host.toast('Evidence is not available from here.', 'error');
            return;
        }

        var go = document.getElementById('fwPresGo');
        if (go) { go.disabled = true; go.textContent = 'Copying…'; }

        a.fieldWorkMediaToEvidence({
            caseNumber: host.getCaseNumber(),
            evidenceTag: tag,
            fileNames: items.map(function (m) { return m.fileName; })
        }).catch(function (err) {
            return { success: false, error: (err && err.message) || String(err) };
        }).then(function (res) {
            if (!res || !res.success) {
                if (go) { go.disabled = false; go.textContent = 'Copy to Evidence'; }
                host.toast('Could not copy into Evidence: ' + ((res && res.error) || 'unknown error'), 'error');
                return;
            }
            var copied = res.files || [];
            var failed = res.failed || [];
            if (!copied.length) {
                if (go) { go.disabled = false; go.textContent = 'Copy to Evidence'; }
                host.toast('Nothing was copied — ' + ((failed[0] && failed[0].error) || 'the files could not be read.'), 'error');
                return;
            }

            // Built from what actually landed on disk, never from what was
            // asked for. An evidence record listing a file that is not there
            // is worse than no record.
            var files = copied.map(function (f, k) {
                return {
                    name: f.name,
                    path: f.path,
                    size: f.size,
                    type: (items[k] && items[k].mime) || '',
                    lastModified: Date.now()
                };
            });

            var record = {
                id: Date.now(),
                type: evidenceTypeFor(items),
                tag: tag,
                discoverable: discoverable,
                description: description,
                location: location,
                fileCount: files.length,
                totalSize: files.reduce(function (acc, f) { return acc + (Number(f.size) || 0); }, 0),
                files: files,
                source: 'fieldwork',
                fieldWorkEntryId: entry.id != null ? entry.id : null,
                createdAt: new Date().toISOString()
            };

            host.addEvidence(record);

            copied.forEach(function (_f, k) {
                var src = items[k];
                if (!src) return;
                src.evidenceTag = tag;
                src.evidenceId = record.id;
                src.preservedAt = record.createdAt;
            });
            saveEntries();
            closePreserve();

            if (failed.length) {
                host.toast('Preserved ' + copied.length + ' item(s) as evidence "' + tag + '". ' +
                    failed.length + ' could not be copied: ' + failed[0].error, 'error');
            } else {
                host.toast('✓ Preserved ' + copied.length + ' item(s) in Evidence as "' + tag + '"', 'success');
            }

            host.syncBoard(true);
            host.rerender();
        });
    }

    /* ── Create-form modal ───────────────────────────────────────────── */

    function showCreateFormModal() {
        if (!relayAvailable()) {
            host.toast('Field forms require the VIPER desktop app.', 'info');
            return;
        }
        load();
        var preset = SCHEMA.presetById('surveillance') || SCHEMA.PRESETS[0];
        draft = {
            presetId: preset.id,
            fields: SCHEMA.normalizeFieldKeys(preset.fields),
            captures: SCHEMA.normalizeCaptureKinds(preset.captures),
            title: preset.label + ' — ' + (host.getCaseRef() || 'Field Work')
        };

        document.body.insertAdjacentHTML('beforeend',
            '<div id="fwCreateModal" class="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">' +
                '<div class="glass-card rounded-xl p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto" id="fwCreateBody"></div>' +
            '</div>');
        paintCreateModal();
    }

    function paintCreateModal() {
        var body = document.getElementById('fwCreateBody');
        if (!body || !draft) return;

        body.innerHTML = '' +
            '<h3 class="text-2xl font-bold text-white mb-1">New Field Form</h3>' +
            '<p class="text-sm text-gray-400 mb-5">Pick the job, adjust what you need, then scan the code with your phone.</p>' +

            '<div class="mb-5">' +
                '<p class="text-xs font-semibold text-viper-cyan mb-2">WHAT ARE YOU DOING?</p>' +
                '<div class="fw-preset-grid">' +
                    SCHEMA.PRESETS.map(function (p) {
                        return '<button type="button" class="fw-preset' + (p.id === draft.presetId ? ' is-active' : '') + '" onclick="FieldWorkUI.pickPreset(\'' + p.id + '\')">' +
                            '<span class="fw-preset-name">' + p.icon + ' ' + esc(p.label) + '</span>' +
                            '<span class="fw-preset-desc">' + esc(p.description) + '</span>' +
                        '</button>';
                    }).join('') +
                '</div>' +
            '</div>' +

            '<div class="mb-4">' +
                '<label class="block text-xs text-gray-400 mb-1">Form Title *</label>' +
                '<input id="fwTitle" value="' + esc(draft.title) + '" oninput="FieldWorkUI.setTitle(this.value)" class="w-full px-3 py-2 bg-viper-dark border border-gray-600 rounded-lg text-white text-sm focus:border-viper-cyan focus:outline-none">' +
            '</div>' +

            '<div class="bg-viper-card/30 border border-gray-700 rounded-lg p-4 mb-4">' +
                '<p class="text-xs font-semibold text-viper-cyan mb-3">BOXES ON THE FORM</p>' +
                '<div class="fw-picks">' +
                    SCHEMA.FIELD_PALETTE.map(function (f) {
                        var on = draft.fields.indexOf(f.key) !== -1;
                        return '<label class="fw-pick">' +
                            '<input type="checkbox"' + (on ? ' checked' : '') + (f.always ? ' disabled' : '') +
                                ' onchange="FieldWorkUI.toggleField(\'' + f.key + '\', this.checked)">' +
                            '<span>' + esc(f.label) + (f.always ? ' *' : '') + '</span>' +
                        '</label>';
                    }).join('') +
                '</div>' +
                '<p class="text-xs text-gray-500 mt-3">Location is always on the form — without it the entry cannot be placed on the Connection Board.</p>' +
            '</div>' +

            '<div class="bg-viper-card/30 border border-gray-700 rounded-lg p-4 mb-4">' +
                '<p class="text-xs font-semibold text-viper-cyan mb-3">WHAT CAN YOU CAPTURE?</p>' +
                '<div class="fw-picks">' +
                    SCHEMA.CAPTURE_KINDS.map(function (c) {
                        var on = draft.captures.indexOf(c.kind) !== -1;
                        return '<label class="fw-pick">' +
                            '<input type="checkbox"' + (on ? ' checked' : '') +
                                ' onchange="FieldWorkUI.toggleCapture(\'' + c.kind + '\', this.checked)">' +
                            '<span>' + c.icon + ' ' + esc(c.label) +
                                ' <span class="text-gray-500">(up to ' + c.maxCount + ', ' + prettyBytes(c.maxBytes) + ' each)</span></span>' +
                        '</label>';
                    }).join('') +
                '</div>' +
                (draft.captures.length
                    ? ''
                    : '<p class="text-xs text-gray-500 mt-3">No attachments — a text-only form. That is a valid choice and the fastest to fill in.</p>') +
            '</div>' +

            '<div class="bg-viper-cyan/10 border border-viper-cyan/30 rounded-lg p-3 text-xs text-gray-300 leading-relaxed">' +
                '<p>📱 A page is created on the Intellect server and you open it from your phone — no WiFi or VPN needed. ' +
                'Photos, clips, recordings and documents are <strong>encrypted on the phone before they are uploaded</strong>, ' +
                'with a key that only exists in this case and in the link itself. The server stores files it cannot read.</p>' +
                '<p class="mt-2">The form expires after 48 hours. Importing it deletes everything from the server.</p>' +
            '</div>' +

            '<div class="flex gap-3 justify-end mt-6 pt-4 border-t border-gray-700">' +
                '<button onclick="FieldWorkUI.closeCreate()" class="px-5 py-2 bg-gray-600 hover:bg-gray-700 rounded-lg text-white text-sm transition">Cancel</button>' +
                '<button id="fwCreateGo" onclick="FieldWorkUI.createForm()" class="px-5 py-2 bg-viper-cyan hover:bg-viper-cyan/80 rounded-lg text-black text-sm font-semibold transition">Create Form</button>' +
            '</div>';
    }

    function pickPreset(id) {
        var p = SCHEMA.presetById(id);
        if (!p || !draft) return;
        var hadCustomTitle = draft.title && draft.title.indexOf('—') !== -1
            && draft.title.split('—')[0].trim() !== (SCHEMA.presetById(draft.presetId) || {}).label;
        draft.presetId = p.id;
        draft.fields = SCHEMA.normalizeFieldKeys(p.fields);
        draft.captures = SCHEMA.normalizeCaptureKinds(p.captures);
        // Only rewrite a title the officer has not personalised.
        if (!hadCustomTitle) draft.title = p.label + ' — ' + (host.getCaseRef() || 'Field Work');
        paintCreateModal();
    }

    function setTitle(v) { if (draft) draft.title = String(v || ''); }

    function toggleField(key, on) {
        if (!draft) return;
        var next = draft.fields.filter(function (k) { return k !== key; });
        if (on) next.push(key);
        draft.fields = SCHEMA.normalizeFieldKeys(next);
    }

    function toggleCapture(kind, on) {
        if (!draft) return;
        var next = draft.captures.filter(function (k) { return k !== kind; });
        if (on) next.push(kind);
        draft.captures = SCHEMA.normalizeCaptureKinds(next);
    }

    function closeCreate() {
        var el = document.getElementById('fwCreateModal');
        if (el) el.remove();
        draft = null;
    }

    function createForm() {
        if (!draft) return;
        var title = String(draft.title || '').trim();
        if (!title) { host.toast('Form title is required', 'error'); return; }

        var preset = SCHEMA.presetById(draft.presetId);
        var go = document.getElementById('fwCreateGo');
        if (go) { go.disabled = true; go.textContent = 'Creating…'; }

        var payload = {
            title: title,
            caseRef: host.getCaseRef(),
            preset: draft.presetId,
            presetLabel: preset ? preset.label : 'Field Work',
            fields: SCHEMA.descriptorsFor(draft.fields),
            captures: SCHEMA.captureSpecFor(draft.captures)
        };
        var chosenFields = draft.fields.slice();
        var chosenCaptures = draft.captures.slice();

        call(function (key) {
            return api().fieldWorkFormCreate(Object.assign({ apiKey: key }, payload));
        }).then(function (result) {
            forms.push({
                formId: result.formId,
                formUrl: result.formUrl,
                qrDataUrl: result.qrDataUrl,
                // The AES-256 key for this form's attachments. It exists in
                // exactly two places: here, and in the fragment of the URL on
                // the phone. The relay never sees it — which is why losing
                // this record makes the uploads permanently unreadable, and
                // why closing a form asks first.
                mediaKey: result.mediaKey || '',
                expiresAt: result.expiresAt,
                title: title,
                preset: draft.presetId,
                presetLabel: payload.presetLabel,
                fields: chosenFields,
                // What the SERVER accepted, which may be less than was asked
                // for. Showing the request back would promise a slot the
                // upload endpoint will refuse.
                captures: Array.isArray(result.captures) && result.captures.length
                    ? result.captures
                    : payload.captures,
                capturesRequested: chosenCaptures,
                createdAt: new Date().toISOString(),
                entryCount: 0
            });
            saveForms();
            closeCreate();
            showQrModal(result.formId);
            host.rerender();
        }).catch(function (error) {
            if (go) { go.disabled = false; go.textContent = 'Create Form'; }
            reportFormError(error);
        });
    }

    /**
     * Turn a relay failure into something an investigator can act on.
     *
     * "Request failed" at 2am on a surveillance sit is worthless. Every
     * branch here names the screen to go to.
     */
    function reportFormError(error) {
        console.error('[fieldwork] form create failed:', error);
        var msg = String((error && error.message) || error);
        if (/invalid or inactive api key|missing api key/i.test(msg)) {
            host.toast('Field form rejected: your VIPER license could not be validated. ' +
                'Open Settings → Licensing and re-activate, or ask your admin to confirm the agency record is active.', 'error');
        } else if (/no registration email|re-register/i.test(msg)) {
            host.toast('VIPER needs to re-sync its license — Settings → Licensing → Re-activate.', 'error');
        } else if (/not registered/i.test(msg)) {
            host.toast('VIPER is not registered yet — Settings → Licensing → Activate.', 'error');
        } else {
            host.toast('Could not create the form: ' + msg, 'error');
        }
    }

    /* ── Active forms panel ──────────────────────────────────────────── */

    function loadFormsPanel() {
        load();
        var section = document.getElementById('fieldWorkFormsSection');
        if (!section) return;
        if (!relayAvailable()) { section.innerHTML = ''; return; }

        // Paint what is known first, then refresh the counts. A panel that
        // appears only after four network round-trips reads as a broken tab.
        paintFormsPanel(section);

        var pending = forms.filter(function (f) { return !isExpired(f); });
        var chain = Promise.resolve();
        pending.forEach(function (form) {
            chain = chain.then(function () {
                return call(function (key) {
                    return api().fieldWorkFormGetInfo({ apiKey: key, formId: form.formId });
                }).then(function (info) {
                    if (info && info.success) {
                        form.entryCount = info.entry_count;
                        form._gone = false;
                        form._unreachable = false;
                    } else if (info && info.gone) {
                        // The relay itself says this form no longer exists.
                        form._gone = true;
                    } else {
                        // Could not reach the relay, or no key yet. Say so on
                        // the card and leave the record alone.
                        form._unreachable = true;
                    }
                }).catch(function () {
                    form._unreachable = true;
                });
            });
        });

        chain.then(function () {
            // Dropping a form record destroys its mediaKey, and that key is
            // the only thing on this machine that can decrypt what the phone
            // uploaded. So a record is removed ONLY when the relay said the
            // form is gone — never on a network failure — and never while
            // attachments are still parked against it waiting on a retry.
            var holding = {};
            entries.forEach(function (e) {
                if (e && e.relayPending && e.relayFormId) holding[e.relayFormId] = true;
            });
            var keep = forms.filter(function (f) {
                if (holding[f.formId]) return true;
                return !f._gone && !isExpired(f);
            });
            if (keep.length !== forms.length) {
                forms = keep;
                saveForms();
            }
            paintFormsPanel(document.getElementById('fieldWorkFormsSection'));
        });
    }

    function paintFormsPanel(section) {
        if (!section) return;
        if (!forms.length) { section.innerHTML = ''; return; }

        section.innerHTML = '' +
        '<div class="glass-card rounded-xl p-5 border border-viper-cyan/30">' +
            '<h3 class="text-lg font-bold text-white mb-4 flex items-center gap-2">📱 Active Field Forms ' +
                '<span class="text-sm font-normal text-gray-400">(' + forms.length + ')</span></h3>' +
            '<div class="grid grid-cols-1 md:grid-cols-2 gap-4">' +
                forms.map(function (form) { return formCard(form); }).join('') +
            '</div>' +
        '</div>';
    }

    function formCard(form) {
        var kinds = (form.captures || []).map(function (c) {
            var def = SCHEMA.CAPTURE_BY_KIND[c.kind];
            return (def ? def.icon : '') + ' ' + (c.label || c.kind);
        }).join(' · ');

        return '' +
        '<div class="fw-form-card">' +
            '<div class="flex items-start justify-between gap-2 mb-3">' +
                '<div class="min-w-0">' +
                    '<p class="text-white font-semibold text-sm">' + esc(form.title) + '</p>' +
                    '<p class="text-xs text-gray-500 mt-0.5">' + esc(form.presetLabel || '') + ' · created ' + esc(when(form.createdAt)) + '</p>' +
                    '<p class="text-xs text-viper-cyan mt-0.5">⏱ ' + esc(timeRemaining(form.expiresAt)) + '</p>' +
                '</div>' +
                '<div class="text-right flex-shrink-0">' +
                    '<p class="text-xl font-bold text-viper-cyan">' + (form.entryCount || 0) + '</p>' +
                    '<p class="text-xs text-gray-500">entries</p>' +
                '</div>' +
            '</div>' +
            // An out-of-date count is worth saying out loud. The alternative
            // is a confident "0 entries" on a laptop that never reached the
            // relay, which reads as "nobody filed anything".
            (form._unreachable
                ? '<p class="text-xs text-amber-300 mb-3">⚠️ Count not confirmed — the relay could not be reached. The form and its key are still here.</p>'
                : '') +
            '<div class="flex gap-3 mb-3">' +
                '<img src="' + esc(form.qrDataUrl) + '" class="fw-qr" alt="QR code" onclick="FieldWorkUI.showQrModal(\'' + jsq(form.formId) + '\')" title="Click to enlarge">' +
                '<div class="flex-1 min-w-0">' +
                    '<label class="text-xs text-gray-500 block mb-1">Open this on your phone:</label>' +
                    '<input type="text" readonly value="' + esc(form.formUrl) + '" class="fw-url" onclick="this.select()">' +
                    '<button onclick="FieldWorkUI.copyUrl(\'' + jsq(form.formId) + '\')" class="mt-1 px-2 py-0.5 bg-viper-cyan/20 border border-viper-cyan/30 rounded text-viper-cyan text-xs hover:bg-viper-cyan/30 transition">Copy link</button>' +
                    (kinds ? '<p class="text-xs text-gray-600 mt-2">' + esc(kinds) + '</p>' : '<p class="text-xs text-gray-600 mt-2">Text only</p>') +
                '</div>' +
            '</div>' +
            '<div class="flex gap-2">' +
                '<button onclick="FieldWorkUI.downloadResults(\'' + jsq(form.formId) + '\')" class="flex-1 px-3 py-2 bg-green-500/15 hover:bg-green-500/25 border border-green-500/40 rounded-lg text-green-300 text-sm transition">⬇ Download &amp; Import</button>' +
                '<button onclick="FieldWorkUI.refreshCount(\'' + jsq(form.formId) + '\')" class="px-3 py-2 bg-viper-cyan/15 hover:bg-viper-cyan/25 border border-viper-cyan/40 rounded-lg text-viper-cyan text-sm transition" title="Refresh count">↻</button>' +
                '<button onclick="FieldWorkUI.closeForm(\'' + jsq(form.formId) + '\')" class="px-3 py-2 bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 rounded-lg text-red-300 text-sm transition" title="Close form">✕</button>' +
            '</div>' +
        '</div>';
    }

    function formById(formId) {
        for (var i = 0; i < forms.length; i++) if (forms[i].formId === formId) return forms[i];
        return null;
    }

    function copyUrl(formId) {
        var form = formById(formId);
        if (!form) return;
        try {
            navigator.clipboard.writeText(form.formUrl);
            host.toast('Link copied', 'success');
        } catch (_) {
            host.toast('Could not copy — select the box and copy manually.', 'error');
        }
    }

    function showQrModal(formId) {
        var form = formById(formId);
        if (!form) return;
        document.body.insertAdjacentHTML('beforeend', '' +
        '<div id="fwQrModal" class="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4" onclick="if(event.target.id===\'fwQrModal\')FieldWorkUI.closeQr()">' +
            '<div class="glass-card rounded-xl p-8 max-w-md w-full text-center">' +
                '<h3 class="text-xl font-bold text-white mb-1">' + esc(form.title) + '</h3>' +
                '<p class="text-sm text-gray-400 mb-5">Scan with your phone camera</p>' +
                '<img src="' + esc(form.qrDataUrl) + '" class="mx-auto rounded-xl" style="width:260px;height:260px" alt="QR code">' +
                '<input type="text" readonly value="' + esc(form.formUrl) + '" class="fw-url mt-5" onclick="this.select()">' +
                '<p class="text-xs text-gray-500 mt-3">⏱ ' + esc(timeRemaining(form.expiresAt)) + '</p>' +
                '<p class="text-xs text-amber-300/80 mt-3 leading-relaxed">The encryption key for your attachments is part of this link. ' +
                    'Anyone with the link can file an entry on this form, so share it the way you would share the case file.</p>' +
                '<button onclick="FieldWorkUI.closeQr()" class="mt-5 px-6 py-2 bg-viper-cyan hover:bg-viper-cyan/80 rounded-lg text-black text-sm font-semibold transition">Done</button>' +
            '</div>' +
        '</div>');
    }

    function closeQr() {
        var el = document.getElementById('fwQrModal');
        if (el) el.remove();
    }

    function refreshCount(formId) {
        var form = formById(formId);
        if (!form) return;
        call(function (key) {
            return api().fieldWorkFormGetInfo({ apiKey: key, formId: formId });
        }).then(function (info) {
            if (!info || !info.success) {
                host.toast(info && info.gone
                    ? 'That form is no longer on the server.'
                    : 'Could not reach the form: ' + ((info && info.error) || 'no response'), 'error');
                return;
            }
            form.entryCount = info.entry_count;
            form._unreachable = false;
            saveForms();
            paintFormsPanel(document.getElementById('fieldWorkFormsSection'));
            host.toast(info.entry_count + ' entr' + (info.entry_count === 1 ? 'y' : 'ies') + ' waiting', 'info');
        }).catch(function (err) {
            host.toast('Could not reach the form: ' + ((err && err.message) || err), 'error');
        });
    }

    /* ── Importing results ───────────────────────────────────────────── */

    /**
     * Pull one entry's attachments down, decrypt them and write them into
     * the case folder.
     *
     * Returns `{media, pending, noKey}`. A file that fails is PARKED on the
     * entry rather than reported and forgotten: the entry rows are deleted
     * by the server the moment results are downloaded, so the descriptor
     * sitting on the entry becomes the only record that the file exists.
     */
    function fetchRelayMedia(caseNumber, entry, mediaKey, descriptors, startIndex) {
        var out = [];
        var pending = [];
        var list = Array.isArray(descriptors) ? descriptors : [];
        var a = api();

        if (!list.length) return Promise.resolve({ media: out, pending: pending });
        if (!a || !a.fieldWorkFetchMedia) {
            return Promise.resolve({ media: out, pending: list.slice() });
        }
        if (!mediaKey) {
            // No key means no way to read these bytes, ever. Say it once
            // rather than failing each file with a decryption error.
            return Promise.resolve({ media: out, pending: [], noKey: true });
        }

        var label = entry.address || entry.presetLabel || 'field work';
        var n = Math.max(1, Number(startIndex) || 1);
        var chain = Promise.resolve();

        list.forEach(function (d) {
            chain = chain.then(function () {
                var kind = (d && d.kind) || 'document';
                var name = fileNameFor({
                    label: label,
                    kind: kind,
                    mime: d && d.mime,
                    index: n,
                    originalName: d && d.fileName,
                    date: entry.occurredAt || entry.timestamp
                });
                return call(function (key) {
                    return a.fieldWorkFetchMedia({
                        apiKey: key,
                        mediaId: d.mediaId,
                        mediaKey: mediaKey,
                        caseNumber: caseNumber,
                        fileName: name
                    });
                }).catch(function (err) {
                    return { success: false, error: String((err && err.message) || err) };
                }).then(function (res) {
                    if (!res || !res.success) {
                        console.warn('[fieldwork] attachment failed:', d && d.mediaId, res && res.error);
                        pending.push(d);
                        return;
                    }
                    out.push({
                        id: 'fw_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
                        kind: kind,
                        fileName: res.fileName,
                        mime: (d && d.mime) || '',
                        bytes: res.size || (d && d.byteSize) || 0,
                        durationSec: (d && d.durationSeconds) || 0,
                        capturedAt: new Date().toISOString(),
                        source: 'field',
                        discoverable: true
                    });
                    n++;
                });
            });
        });

        return chain.then(function () { return { media: out, pending: pending }; });
    }

    function retryPending(formId) {
        var form = formById(formId);
        var key = form && form.mediaKey;
        var recovered = 0;
        var stillPending = 0;
        var touched = false;
        var caseNumber = host.getCaseNumber();
        var chain = Promise.resolve();

        entries.forEach(function (entry) {
            var pend = entry && entry.relayPending;
            if (!Array.isArray(pend) || !pend.length) return;
            if (entry.relayFormId && entry.relayFormId !== formId) return;
            chain = chain.then(function () {
                var existing = Array.isArray(entry.media) ? entry.media : [];
                return fetchRelayMedia(caseNumber, entry, key, pend, existing.length + 1).then(function (r) {
                    if (r.media.length) {
                        entry.media = existing.concat(r.media);
                        recovered += r.media.length;
                        touched = true;
                    }
                    if (r.pending.length !== pend.length) touched = true;
                    entry.relayPending = r.pending;
                    if (!r.pending.length) delete entry.relayPending;
                    stillPending += r.pending.length;
                });
            });
        });

        return chain.then(function () {
            if (touched) saveEntries();
            return { recovered: recovered, stillPending: stillPending };
        });
    }

    function downloadResults(formId) {
        if (!relayAvailable()) return;
        load();
        var form = formById(formId);
        if (!form) return;
        var caseNumber = host.getCaseNumber();

        // Anything left over from a previous import goes first. It cannot be
        // re-requested from the server, so it must not be stranded behind an
        // early return when there are no new entries to fetch.
        retryPending(formId).then(function (retried) {
            if (retried.recovered) {
                host.toast('Recovered ' + retried.recovered + ' attachment(s) from a previous import', 'success');
            }
            return call(function (key) {
                return api().fieldWorkFormDownload({ apiKey: key, formId: formId });
            }).then(function (result) {
                var rows = (result && result.entries) || [];
                if (!rows.length) {
                    if (retried.recovered) host.rerender();
                    else host.toast('No entries to download yet.', 'info');
                    return;
                }
                return importRows(form, rows, caseNumber);
            });
        }).catch(function (e) {
            console.error('[fieldwork] download failed:', e);
            host.toast('Could not download: ' + ((e && e.message) || e), 'error');
        });
    }

    function importRows(form, rows, caseNumber) {
        var fresh = rows.map(function (row) {
            var entry = SCHEMA.makeEntry({
                id: 'fw_' + (row.id != null ? row.id : Date.now() + Math.random()),
                preset: form.preset,
                presetLabel: form.presetLabel,
                fieldKeys: form.fields,
                fields: row,
                location: {
                    street: row.street, city: row.city, state: row.state, zip: row.zip
                },
                timestamp: row.submittedAt,
                formId: form.formId,
                source: 'relay'
            });
            // Carried, not yet fetched — resolved once the import is confirmed.
            entry._relayMedia = Array.isArray(row.media) ? row.media : [];
            return entry;
        });

        // De-duplicate on the relay's own row id. Address+time collides for
        // real on a surveillance form where every entry is the same address
        // minutes apart, which is exactly the shape Area Canvas never sees.
        var seen = {};
        entries.forEach(function (e) { if (e && e.id != null) seen[e.id] = true; });
        var unique = fresh.filter(function (e) { return !seen[e.id]; });

        if (!unique.length) {
            host.toast('All entries already imported.', 'info');
            return;
        }

        var mediaCount = unique.reduce(function (n, e) { return n + e._relayMedia.length; }, 0);
        var mediaLine = mediaCount
            ? '\n\n' + mediaCount + ' attachment(s) will be downloaded, decrypted and saved into the case folder.'
            : '';

        return Promise.resolve(host.confirm(
            'Import ' + unique.length + ' field work entr' + (unique.length === 1 ? 'y' : 'ies') + '?' + mediaLine +
            '\n\nThe form will be closed and all data removed from the server.'
        )).then(function (ok) {
            if (!ok) return;
            var saved = 0, failed = 0, noKey = false;
            var chain = Promise.resolve();

            unique.forEach(function (entry) {
                var descriptors = entry._relayMedia;
                delete entry._relayMedia;
                if (!descriptors.length) return;
                entry.relayFormId = form.formId;
                chain = chain.then(function () {
                    return fetchRelayMedia(caseNumber, entry, form.mediaKey, descriptors, 1).then(function (r) {
                        if (r.noKey) { noKey = true; return; }
                        if (r.media.length) entry.media = r.media;
                        if (r.pending.length) entry.relayPending = r.pending;
                        saved += r.media.length;
                        failed += r.pending.length;
                    });
                });
            });

            return chain.then(function () {
                unique.forEach(function (e) { entries.push(e); });
                saveEntries();

                // Deleting the form purges every remaining blob on the
                // server, so it must not run while anything is still waiting
                // to be pulled down.
                var closed = Promise.resolve();
                if (!failed) {
                    closed = call(function (key) {
                        return api().fieldWorkFormDelete({ apiKey: key, formId: form.formId });
                    }).catch(function () { /* may already be expired */ }).then(function () {
                        forms = forms.filter(function (f) { return f.formId !== form.formId; });
                        saveForms();
                    });
                }

                return closed.then(function () {
                    if (noKey) {
                        host.toast('Entries imported, but their attachments cannot be decrypted — ' +
                            'this form has no key on record.', 'error');
                    } else if (failed) {
                        host.toast('Imported ' + unique.length + ' entr' + (unique.length === 1 ? 'y' : 'ies') +
                            ' and ' + saved + ' attachment(s). ' + failed + ' did not download — ' +
                            'the form is still open, press Download again to retry.', 'error');
                    } else {
                        host.toast('✓ Imported ' + unique.length + ' entr' + (unique.length === 1 ? 'y' : 'ies') +
                            (saved ? ' and ' + saved + ' attachment(s)' : '') + ' — form closed', 'success');
                    }
                    host.syncBoard(true);
                    host.rerender();
                });
            });
        });
    }

    function closeForm(formId) {
        load();
        // Files already pulled off this form's entries but which failed to
        // download are parked as `relayPending`. The key dies with the form,
        // so closing it makes them permanently unreadable — and leaves
        // entries that still claim those files are coming. Name the number,
        // then clear the claim.
        var stranded = 0;
        entries.forEach(function (e) {
            if (e && e.relayFormId === formId && e.relayPending) stranded += e.relayPending.length;
        });

        var msg = 'Close and delete this field form? Any entries you have not imported — and any photos, ' +
            'video, audio or documents still waiting on the server — will be lost. ' +
            'The encryption key goes with the form, so this cannot be undone from either side.';
        if (stranded) {
            msg += '\n\n⚠️ ' + stranded + ' attachment(s) from entries you already imported have not come down yet. ' +
                'Closing the form abandons them for good.';
        }

        Promise.resolve(host.confirm(msg, { danger: true, okText: 'Close Form' })).then(function (ok) {
            if (!ok) return;
            return call(function (key) {
                return api().fieldWorkFormDelete({ apiKey: key, formId: formId });
            }).catch(function () { /* may already be expired */ }).then(function () {
                forms = forms.filter(function (f) { return f.formId !== formId; });
                saveForms();
                if (stranded) {
                    // Stop offering a retry that can no longer succeed.
                    entries.forEach(function (e) {
                        if (e && e.relayFormId === formId) {
                            delete e.relayPending;
                            delete e.relayFormId;
                        }
                    });
                    saveEntries();
                }
                host.audit('fieldwork_form_closed', {
                    formId: formId,
                    abandonedAttachments: stranded
                });
                host.rerender();
            });
        });
    }

    /* ── Desk-side entry ─────────────────────────────────────────────── */

    function showEntryModal() {
        load();
        var presets = SCHEMA.PRESETS;
        var nowLocal = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
            .toISOString().slice(0, 16);

        document.body.insertAdjacentHTML('beforeend', '' +
        '<div id="fwEntryModal" class="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">' +
            '<div class="glass-card rounded-xl p-6 max-w-xl w-full max-h-[90vh] overflow-y-auto">' +
                '<h3 class="text-2xl font-bold text-white mb-1">Log Field Work</h3>' +
                '<p class="text-sm text-gray-400 mb-5">For work you are writing up at the desk. To capture at the scene, use a field form instead.</p>' +
                '<div class="space-y-3">' +
                    '<div>' +
                        '<label class="block text-xs text-gray-400 mb-1">Type</label>' +
                        '<select id="fwePreset" class="w-full px-3 py-2 bg-viper-dark border border-gray-600 rounded-lg text-white text-sm">' +
                            presets.map(function (p) {
                                return '<option value="' + p.id + '">' + p.icon + ' ' + esc(p.label) + '</option>';
                            }).join('') +
                        '</select>' +
                    '</div>' +
                    '<div class="grid grid-cols-2 gap-3">' +
                        '<div><label class="block text-xs text-gray-400 mb-1">Street</label>' +
                            '<input id="fweStreet" class="w-full px-3 py-2 bg-viper-dark border border-gray-600 rounded-lg text-white text-sm"></div>' +
                        '<div><label class="block text-xs text-gray-400 mb-1">City</label>' +
                            '<input id="fweCity" class="w-full px-3 py-2 bg-viper-dark border border-gray-600 rounded-lg text-white text-sm"></div>' +
                        '<div><label class="block text-xs text-gray-400 mb-1">State</label>' +
                            '<input id="fweState" maxlength="2" class="w-full px-3 py-2 bg-viper-dark border border-gray-600 rounded-lg text-white text-sm"></div>' +
                        '<div><label class="block text-xs text-gray-400 mb-1">ZIP</label>' +
                            '<input id="fweZip" class="w-full px-3 py-2 bg-viper-dark border border-gray-600 rounded-lg text-white text-sm"></div>' +
                    '</div>' +
                    '<div><label class="block text-xs text-gray-400 mb-1">Date &amp; Time</label>' +
                        '<input id="fweWhen" type="datetime-local" value="' + nowLocal + '" class="w-full px-3 py-2 bg-viper-dark border border-gray-600 rounded-lg text-white text-sm"></div>' +
                    '<div><label class="block text-xs text-gray-400 mb-1">Subject / Person</label>' +
                        '<input id="fweSubject" class="w-full px-3 py-2 bg-viper-dark border border-gray-600 rounded-lg text-white text-sm"></div>' +
                    '<div><label class="block text-xs text-gray-400 mb-1">Vehicle</label>' +
                        '<input id="fweVehicle" class="w-full px-3 py-2 bg-viper-dark border border-gray-600 rounded-lg text-white text-sm" placeholder="Plate, make, model, colour"></div>' +
                    '<div><label class="block text-xs text-gray-400 mb-1">Notes</label>' +
                        '<textarea id="fweNotes" rows="3" class="w-full px-3 py-2 bg-viper-dark border border-gray-600 rounded-lg text-white text-sm"></textarea></div>' +
                    '<div><label class="block text-xs text-gray-400 mb-1">Attach files</label>' +
                        '<input id="fweFiles" type="file" multiple class="w-full text-xs text-gray-400">' +
                        '<p class="text-xs text-gray-600 mt-1">Saved into the case folder under Field Work Media, encrypted if Field Security is on.</p></div>' +
                    '<label class="flex items-center gap-2 text-sm text-gray-300">' +
                        '<input id="fweFollow" type="checkbox"> Needs follow-up</label>' +
                '</div>' +
                '<div class="flex gap-3 justify-end mt-6 pt-4 border-t border-gray-700">' +
                    '<button onclick="FieldWorkUI.closeEntryModal()" class="px-5 py-2 bg-gray-600 hover:bg-gray-700 rounded-lg text-white text-sm transition">Cancel</button>' +
                    '<button id="fweGo" onclick="FieldWorkUI.saveEntryFromModal()" class="px-5 py-2 bg-viper-cyan hover:bg-viper-cyan/80 rounded-lg text-black text-sm font-semibold transition">Save Entry</button>' +
                '</div>' +
            '</div>' +
        '</div>');
    }

    function closeEntryModal() {
        var el = document.getElementById('fwEntryModal');
        if (el) el.remove();
    }

    function val(id) {
        var el = document.getElementById(id);
        return el ? String(el.value || '').trim() : '';
    }

    function saveEntryFromModal() {
        var presetId = val('fwePreset') || 'custom';
        var preset = SCHEMA.presetById(presetId);
        var loc = { street: val('fweStreet'), city: val('fweCity'), state: val('fweState'), zip: val('fweZip') };
        var address = SCHEMA.composeAddress(loc);
        if (!address) { host.toast('Give the entry a location — it is what puts it on the board.', 'error'); return; }

        var whenRaw = val('fweWhen');
        var followEl = document.getElementById('fweFollow');

        var entry = SCHEMA.makeEntry({
            id: 'fwd_' + Date.now(),
            preset: presetId,
            presetLabel: preset ? preset.label : 'Field Work',
            fieldKeys: ['location', 'occurredAt', 'subject', 'vehicle', 'followUp', 'notes'],
            fields: {
                occurredAt: whenRaw ? new Date(whenRaw).toISOString() : '',
                subject: val('fweSubject'),
                vehicle: val('fweVehicle'),
                followUp: !!(followEl && followEl.checked),
                notes: val('fweNotes')
            },
            location: loc,
            source: 'desk'
        });

        var go = document.getElementById('fweGo');
        if (go) { go.disabled = true; go.textContent = 'Saving…'; }

        attachLocalFiles(entry).then(function (warning) {
            entries.push(entry);
            saveEntries();
            closeEntryModal();
            host.toast(warning || '✓ Field work entry saved', warning ? 'error' : 'success');
            host.syncBoard(true);
            host.rerender();
        }).catch(function (err) {
            if (go) { go.disabled = false; go.textContent = 'Save Entry'; }
            host.toast('Could not save: ' + ((err && err.message) || err), 'error');
        });
    }

    function kindForFile(file) {
        var t = String(file.type || '').toLowerCase();
        if (t.indexOf('image/') === 0) return 'photo';
        if (t.indexOf('video/') === 0) return 'video';
        if (t.indexOf('audio/') === 0) return 'audio';
        return 'document';
    }

    /**
     * Write files picked at the desk through the same on-disk path the relay
     * import uses, so a case folder never ends up with two naming schemes
     * for the same kind of file.
     */
    function attachLocalFiles(entry) {
        var input = document.getElementById('fweFiles');
        var files = input && input.files ? Array.prototype.slice.call(input.files) : [];
        if (!files.length) return Promise.resolve('');
        var a = api();
        if (!a || !a.fieldWorkSaveMedia) {
            return Promise.resolve('Entry saved, but attachments need the VIPER desktop app.');
        }

        var caseNumber = host.getCaseNumber();
        var media = [];
        var failed = [];
        var chain = Promise.resolve();
        var n = 1;

        files.forEach(function (file) {
            chain = chain.then(function () {
                var kind = kindForFile(file);
                var name = fileNameFor({
                    label: entry.address, kind: kind, mime: file.type,
                    index: n, originalName: file.name, date: entry.occurredAt
                });
                return readAsBase64(file).then(function (b64) {
                    return a.fieldWorkSaveMedia({ caseNumber: caseNumber, fileName: name, dataBase64: b64 });
                }).then(function (res) {
                    if (!res || !res.success) {
                        failed.push(file.name + ': ' + ((res && res.error) || 'write failed'));
                        return;
                    }
                    media.push({
                        id: 'fw_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
                        kind: kind,
                        fileName: res.fileName,
                        mime: file.type || '',
                        bytes: res.size || file.size || 0,
                        durationSec: 0,
                        capturedAt: new Date().toISOString(),
                        source: 'desk',
                        discoverable: true
                    });
                    n++;
                }).catch(function (err) {
                    failed.push(file.name + ': ' + ((err && err.message) || err));
                });
            });
        });

        return chain.then(function () {
            entry.media = media;
            if (!failed.length) return '';
            return 'Entry saved, but ' + failed.length + ' file(s) did not attach: ' + failed[0];
        });
    }

    function readAsBase64(file) {
        return new Promise(function (resolve, reject) {
            var fr = new FileReader();
            fr.onload = function () {
                var s = String(fr.result || '');
                var comma = s.indexOf(',');
                resolve(comma === -1 ? '' : s.slice(comma + 1));
            };
            fr.onerror = function () { reject(fr.error || new Error('read failed')); };
            fr.readAsDataURL(file);
        });
    }

    /* ── Integrations the host reads ─────────────────────────────────── */

    function readEntriesFor(caseId) {
        return _lsParse('fieldwork_' + caseId, []) || [];
    }

    function entryCount(caseId) {
        var list = (caseId && caseId !== loadedFor) ? readEntriesFor(caseId) : (load(), entries);
        return (Array.isArray(list) ? list : []).filter(Boolean).length;
    }

    /**
     * File names the DA export and the discovery package must withhold.
     *
     * Takes either the entry list or a case id, and when given a case id it
     * reads the STORE rather than the in-memory list. An export can be run
     * without ever opening this tab, in which case `entries` is still [] and
     * the files are sitting on disk. Getting this wrong ships a withheld
     * photo to the DA, so the argument-less call is deliberately not a
     * shortcut for "whatever happens to be loaded".
     */
    function nonDiscoverableFileNames(listOrCaseId) {
        var list = typeof listOrCaseId === 'string'
            ? readEntriesFor(listOrCaseId)
            : listOrCaseId;
        var out = [];
        (Array.isArray(list) ? list : []).forEach(function (e) {
            (e && e.media || []).forEach(function (m) {
                if (m && m.discoverable === false && m.fileName) out.push(m.fileName);
            });
        });
        return out;
    }

    /**
     * Rows for the case export and the DA report. Flat, already formatted —
     * the exporter should not have to know this module's shape.
     */
    function exportRows(caseId) {
        var list = caseId ? readEntriesFor(caseId) : (load(), entries);
        return (Array.isArray(list) ? list : []).filter(Boolean).map(function (e) {
            var extra = [];
            Object.keys(e.fields || {}).forEach(function (k) {
                if (k === 'notes' || k === 'followUp') return;
                var v = e.fields[k];
                if (v === '' || v == null || v === false) return;
                extra.push((SCHEMA ? SCHEMA.labelFor(k) : k) + ': ' + (v === true ? 'Yes' : v));
            });
            return {
                type: e.presetLabel || 'Field Work',
                location: e.address || '',
                occurred: when(e.occurredAt || e.timestamp),
                details: extra.join(' | '),
                notes: e.notes || '',
                followUp: e.followUp ? 'Yes' : 'No',
                attachments: (e.media || []).length,
                preserved: (e.media || []).filter(function (m) { return m && m.evidenceTag; }).length
            };
        });
    }

    /**
     * Timeline events for the case timeline. Field work is time-stamped
     * work product and belongs on it alongside warrants and notes.
     */
    function timelineEvents(caseId) {
        var list = caseId ? readEntriesFor(caseId) : (load(), entries);
        return (Array.isArray(list) ? list : []).filter(function (e) {
            return e && (e.occurredAt || e.timestamp);
        }).map(function (e) {
            return {
                id: 'tl_auto_fieldwork_' + e.id,
                date: e.occurredAt || e.timestamp,
                title: (e.presetLabel || 'Field Work') + (e.address ? ' — ' + e.address : ''),
                description: (SCHEMA ? SCHEMA.summaryLine(e) : '') || e.notes || '',
                sourceType: 'auto:fieldwork'
            };
        });
    }

    /**
     * What the supervisor roll-up counts.
     *
     * Field work is the investigator's own work product, so it counts the
     * same way a warrant does. The shape mirrors the other roll-up
     * contributors: a flat object of integers, nothing identifying.
     */
    function supervisorStats(caseId) {
        var list = (caseId ? readEntriesFor(caseId) : (load(), entries)).filter(Boolean);
        var media = 0, preserved = 0;
        list.forEach(function (e) {
            (e.media || []).forEach(function (m) {
                media++;
                if (m && m.evidenceTag) preserved++;
            });
        });
        return {
            entries: list.length,
            followUp: list.filter(function (e) { return e.followUp; }).length,
            attachments: media,
            preservedAsEvidence: preserved
        };
    }

    /**
     * Connection Board pin specs. One pin per entry that has an address.
     *
     * `canvasFile` is deliberately absent — the board's media reader
     * dispatches on it to reach Canvas Media, and a Field Work file lives in
     * a different folder. `fieldWorkFile` is the Field Work arm of the same
     * switch.
     */
    function boardPins(caseId, caseNumber) {
        var list = (caseId ? readEntriesFor(caseId) : (load(), entries)).filter(Boolean);
        return list.filter(function (e) { return e.address; }).map(function (e) {
            return {
                // The board's own pin taxonomy. A field work entry is a
                // place something happened, which is what `location` means
                // there — the preset is carried in the label and the data.
                type: 'location',
                sourceType: 'auto:fieldwork',
                sourceId: String(e.id),
                label: (e.presetLabel || 'Field Work') + ' — ' + e.address,
                address: e.address,
                color: SCHEMA ? SCHEMA.markerColor(e) : '#9ca3af',
                manualLat: typeof e.manualLat === 'number' ? e.manualLat : undefined,
                manualLon: typeof e.manualLon === 'number' ? e.manualLon : undefined,
                data: {
                    when: e.occurredAt || e.timestamp,
                    summary: SCHEMA ? SCHEMA.summaryLine(e) : '',
                    notes: e.notes || '',
                    media: boardMediaFor(e, caseNumber)
                }
            };
        });
    }

    /**
     * Media descriptors for a Connection Board pin.
     *
     * The board speaks image/video/audio and renders each with its own
     * element; Field Work's own vocabulary is photo/video/audio/document.
     * Translating HERE rather than in the board keeps one definition of
     * what a Field Work pin carries — a 'photo' handed over untranslated
     * falls through the board's if/else and renders as an <audio> control,
     * and a document has no inline viewer at all, so it is left off.
     *
     * `fieldWorkFile` (not `path`) is the discriminator the board's
     * _readPinMediaBytes dispatches on: these files live in the case
     * folder's "Field Work Media" directory and are read by NAME through
     * their own IPC, which also handles Field Security decryption.
     */
    function boardMediaFor(entry, caseNumber) {
        var KIND = { photo: 'image', image: 'image', video: 'video', audio: 'audio' };
        var out = [];
        (entry && entry.media || []).forEach(function (m) {
            if (!m || !m.fileName) return;
            var kind = KIND[m.kind];
            if (!kind) return;
            out.push({
                fieldWorkFile: m.fileName,
                caseNumber: String(caseNumber || host.getCaseNumber() || ''),
                name: m.fileName,
                mime: m.mime || '',
                kind: kind,
                preserved: !!m.evidenceTag
            });
        });
        return out;
    }

    function pushToBoard() {
        var mapped = entries.filter(function (e) { return e && e.address; }).length;
        if (!mapped) {
            host.toast('No field work entries have a location to map yet.', 'info');
            return;
        }
        if (host.syncBoard(false)) {
            host.toast('Added ' + mapped + ' entr' + (mapped === 1 ? 'y' : 'ies') + ' to the Connection Board', 'success');
        }
    }

    /* ── Public API ──────────────────────────────────────────────────── */

    return {
        configure: configure,
        reset: reset,

        renderTab: renderTab,
        afterRender: afterRender,
        teardown: teardown,

        setFilter: setFilter,
        openEntry: openEntry,
        backToList: backToList,
        toggleFollowUp: toggleFollowUp,
        deleteEntry: deleteEntry,
        deleteMedia: deleteMedia,
        toggleDiscoverable: toggleDiscoverable,

        preview: preview,
        closePreview: closePreview,

        preserveSelected: preserveSelected,
        closePreserve: closePreserve,
        confirmPreserve: confirmPreserve,

        showCreateFormModal: showCreateFormModal,
        pickPreset: pickPreset,
        setTitle: setTitle,
        toggleField: toggleField,
        toggleCapture: toggleCapture,
        closeCreate: closeCreate,
        createForm: createForm,

        showQrModal: showQrModal,
        closeQr: closeQr,
        copyUrl: copyUrl,
        refreshCount: refreshCount,
        downloadResults: downloadResults,
        closeForm: closeForm,

        showEntryModal: showEntryModal,
        closeEntryModal: closeEntryModal,
        saveEntryFromModal: saveEntryFromModal,

        pushToBoard: pushToBoard,
        entryCount: entryCount,
        exportRows: exportRows,
        timelineEvents: timelineEvents,
        supervisorStats: supervisorStats,
        boardPins: boardPins,
        nonDiscoverableFileNames: nonDiscoverableFileNames,
        fileNameFor: fileNameFor,

        // Exposed for tests — not part of the host contract.
        _state: function () { return { entries: entries, forms: forms, filter: filter, draft: draft, viewIndex: viewIndex }; },
        _setState: function (s) {
            if (s.entries) entries = s.entries;
            if (s.forms) forms = s.forms;
            if (s.loadedFor !== undefined) loadedFor = s.loadedFor;
            if (s.viewIndex !== undefined) viewIndex = s.viewIndex;
            if (s.filter) filter = s.filter;
        }
    };
}));

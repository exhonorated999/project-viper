/**
 * Source Viewer — the "show me where that came from" window.   RENDERER.
 * ─────────────────────────────────────────────────────────────────────────
 * Any module can put a 🔍 Source button beside a value it displays. One
 * click opens this window, which asks the main process (source-locator.js)
 * to find the value in the ORIGINAL return and shows the officer:
 *
 *   - what VIPER shows, next to what the original actually reads, and
 *     whether that is an exact match (or only differs in case / spacing);
 *   - the original itself at that spot — the CSV row with its column
 *     headings, the provider's web page with the value highlighted, or the
 *     PDF page with a highlight box drawn over it;
 *   - the file and line / page, and the original's SHA-256 checked against
 *     the fingerprint VIPER took when it was imported.
 *
 * It never claims more than it found. If the value is not in the original
 * it says so, lists every file it searched, and offers to locate the
 * original if it has moved.
 *
 * Host contract: everything the window needs is in the open() payload.
 * Nothing is read from host globals (the host-scoping trap).
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root) root.SourceViewer = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    var _api = null;          // injectable for tests; defaults to window.electronAPI
    var _doc = null;          // injectable for tests; defaults to document
    var _tokens = new Map();  // token -> payload (buttons rendered into HTML strings)
    var _tokenSeq = 0;
    var TOKEN_MAX = 20000;
    var _state = null;        // the open window

    function api() { return _api || (typeof window !== 'undefined' ? window.electronAPI : null); }
    function doc() { return _doc || (typeof document !== 'undefined' ? document : null); }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function baseName(p) { return String(p || '').replace(/\\/g, '/').split('/').pop(); }

    var KIND_TEXT = {
        'exact': { label: 'Exact match', cls: 'sv-ok', note: 'The original reads exactly what VIPER shows.' },
        'case': { label: 'Matches — capital letters differ', cls: 'sv-warn', note: 'Same characters; only upper/lower case differs.' },
        'spacing': { label: 'Matches — spacing differs', cls: 'sv-warn', note: 'Same characters; only spaces or line breaks differ.' },
        'case+spacing': { label: 'Matches — case and spacing differ', cls: 'sv-warn', note: 'Same characters; case and spacing differ.' },
    };

    // ── buttons ────────────────────────────────────────────────────────────

    /** Remember a payload and return a token a button can carry. */
    function register(payload) {
        var t = 's' + (++_tokenSeq);
        _tokens.set(t, payload);
        if (_tokens.size > TOKEN_MAX) _tokens.delete(_tokens.keys().next().value);
        return t;
    }

    /**
     * HTML for a small "🔍 Source" button. Returns '' when there is nothing
     * to look for or nowhere to look — a button that can only fail is worse
     * than no button.
     */
    function buttonHtml(payload, opts) {
        opts = opts || {};
        if (!payload || !payload.values || !payload.values.length) return '';
        var first = payload.values[0];
        if (first == null || !String(first).trim()) return '';
        if (!payload.source && !payload.resolveSource) return '';
        var t = register(payload);
        var label = opts.label != null ? opts.label : 'Source';
        var title = opts.title || 'See this in the original return';
        return '<button type="button" class="sv-src-btn' + (opts.compact ? ' sv-compact' : '') + '" ' +
            'title="' + esc(title) + '" onclick="event.stopPropagation();window.SourceViewer&&window.SourceViewer.openToken(\'' + t + '\')">' +
            '<span aria-hidden="true">\uD83D\uDD0D</span>' + (label ? ' ' + esc(label) : '') + '</button>';
    }

    function openToken(t) {
        var p = _tokens.get(t);
        if (!p) return null;
        return open(p);
    }

    // ── the window ─────────────────────────────────────────────────────────

    function close() {
        if (!_state) return;
        var st = _state;
        _state = null;
        try { st.root.remove(); } catch (_) {}
        try { doc().removeEventListener('keydown', st.onKey, true); } catch (_) {}
    }

    /**
     * payload = {
     *   title:        what the value is ("IP address")
     *   shown:        what VIPER displays (defaults to values[0])
     *   context:      [[label, value], …] shown under the value
     *   source:       { path, entry?, inZip?, extraPaths?, hashOnly?, label? }
     *   resolveSource: optional async () => source  (looked up at click time)
     *   values:       [primary, …corroborating]
     *   valueLabels:  ['IP address', 'Timestamp', …] (optional)
     *   memberHints:  ['records.html'] — files to search first
     *   expected:     the fingerprint recorded at import (or null)
     *   relocateFolder: true to locate a folder rather than a file
     *   onRelocate:   async (newPath) => newSource|void — persist a moved original
     * }
     */
    async function open(payload) {
        close();
        var d = doc();
        if (!d) return null;
        payload = payload || {};
        var root = d.createElement('div');
        root.className = 'sv-overlay';
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'true');
        var st = {
            root: root, payload: payload, source: payload.source || null,
            located: null, hitIndex: 0, view: null, viewTab: 'provider', hash: null, busy: true,
            onKey: function (e) { if (e.key === 'Escape') { e.preventDefault(); close(); } },
        };
        _state = st;
        root.addEventListener('mousedown', function (e) { if (e.target === root) close(); });
        d.addEventListener('keydown', st.onKey, true);
        d.body.appendChild(root);
        paint();
        if (!st.source && payload.resolveSource) {
            try { st.source = await payload.resolveSource(); } catch (_) { st.source = null; }
            if (_state !== st) return st;
        }
        await run(st);
        return st;
    }

    async function run(st) {
        var a = api();
        st.busy = true; st.located = null; st.view = null; st.hash = null; st.hitIndex = 0;
        paint();
        if (!a || !a.sourceLocate) { st.busy = false; st.located = { ok: false, error: 'Source checking is not available in this window.' }; paint(); return; }
        if (!st.source || !st.source.path) {
            st.busy = false;
            st.located = { ok: false, missing: true, error: 'VIPER has no record of where the original file is for this item.' };
            paint();
            return;
        }
        var src = srcArg(st.source);
        var hashP = a.sourceHash ? a.sourceHash({ source: src, expected: st.payload.expected || null }).catch(function (e) { return { ok: false, error: String(e && e.message || e) }; }) : Promise.resolve(null);
        var loc;
        try {
            loc = await a.sourceLocate({ source: src, values: st.payload.values, memberHints: st.payload.memberHints || [], record: st.payload.record || undefined });
        } catch (e) { loc = { ok: false, error: String(e && e.message || e) }; }
        if (_state !== st) return;
        st.located = loc;
        st.busy = false;
        paint();
        if (loc && loc.ok && loc.found) await showHit(st, 0);
        hashP.then(function (h) { if (_state !== st) return; st.hash = h; paintFooter(); });
    }

    function srcArg(s) {
        var o = { path: s.path };
        if (s.entry) o.entry = s.entry;
        if (s.inZip) o.inZip = s.inZip;
        if (s.extraPaths && s.extraPaths.length) o.extraPaths = s.extraPaths.slice();
        if (s.hashOnly && s.hashOnly.length) o.hashOnly = s.hashOnly.slice();
        return o;
    }

    async function showHit(st, i) {
        var a = api();
        var loc = st.located;
        if (!loc || !loc.hits || !loc.hits[i]) return;
        st.hitIndex = i;
        st.view = { loading: true };
        paint();
        var v;
        try { v = await a.sourceView({ source: srcArg(st.source), hit: loc.hits[i], values: st.payload.values }); }
        catch (e) { v = { ok: false, error: String(e && e.message || e) }; }
        if (_state !== st || st.hitIndex !== i) return;
        st.view = v;
        if (v && v.format === 'html' && !v.marked) st.viewTab = 'raw';
        paint();
    }

    // ── painting ───────────────────────────────────────────────────────────

    function q(sel) { return _state ? _state.root.querySelector(sel) : null; }

    function valueLabel(st, idx) {
        var l = st.payload.valueLabels && st.payload.valueLabels[idx];
        return l || (idx === 0 ? (st.payload.title || 'value') : 'related value');
    }

    function headerHtml(st) {
        var p = st.payload;
        var shown = p.shown != null ? p.shown : (p.values && p.values[0]);
        var loc = st.located;
        var hit = loc && loc.hits && loc.hits[st.hitIndex];
        var h = '<div class="sv-head">' +
            '<div class="sv-title">Source check <span class="sv-dim">\u2014 ' + esc(p.title || 'value') + '</span></div>' +
            '<button type="button" class="sv-x" data-sv="close" title="Close (Esc)">\u2715</button></div>';
        h += '<div class="sv-compare">' +
            '<div class="sv-cmp-col"><div class="sv-cmp-label">VIPER shows</div><div class="sv-cmp-val">' + esc(shown) + '</div></div>' +
            '<div class="sv-cmp-col"><div class="sv-cmp-label">The original reads</div><div class="sv-cmp-val' + (hit ? '' : ' sv-dim') + '">' +
            (hit ? esc(hit.matched) : (st.busy ? 'searching\u2026' : '\u2014')) + '</div></div>';
        if (hit && loc.primaryFound === false) {
            // Never a green tick for a value that was not itself found.
            h += '<div class="sv-cmp-badge sv-warn" title="The value VIPER shows was not found word-for-word; this is a related record">\u2248 Related record only</div>';
        } else if (hit) {
            var k = KIND_TEXT[hit.matchKind] || KIND_TEXT.exact;
            h += '<div class="sv-cmp-badge ' + k.cls + '" title="' + esc(k.note) + '">' + (k.cls === 'sv-ok' ? '\u2713 ' : '\u2248 ') + esc(k.label) + '</div>';
        }
        h += '</div>';
        if (p.context && p.context.length) {
            h += '<div class="sv-context">' + p.context.filter(function (c) { return c && c[1] != null && String(c[1]).trim(); })
                .map(function (c) { return '<span><b>' + esc(c[0]) + ':</b> ' + esc(c[1]) + '</span>'; }).join('') + '</div>';
        }
        if (hit && loc.primaryFound === false) {
            var used = (loc.values || []).find(function (v) { return v.index === loc.usedValueIndex; });
            h += '<div class="sv-banner sv-banner-warn">VIPER could not find <b>' + esc(p.values[0]) + '</b> itself in the original. ' +
                'It found the ' + esc(valueLabel(st, loc.usedValueIndex)) + ' <b>' + esc(used ? used.text : '') + '</b> instead. ' +
                'Check the record below by eye before relying on it.</div>';
        }
        if (hit && hit.valueTruncated) {
            h += '<div class="sv-banner">This is long text \u2014 VIPER searched for its opening words. Read the rest in the original below.</div>';
        }
        return h;
    }

    function hitListHtml(st) {
        var loc = st.located;
        if (!loc || !loc.found) return '';
        var items = loc.hits.map(function (h, i) {
            var where = hitWhere(h);
            var cor = h.corroboratedBy && h.corroboratedBy.length
                ? '<span class="sv-cor" title="Other details of this record were found right next to it">\u2605 ' + h.corroboratedBy.length + ' detail' + (h.corroboratedBy.length > 1 ? 's' : '') + ' agree</span>'
                : '';
            var kind = h.matchKind !== 'exact' ? '<span class="sv-kind">\u2248 ' + esc(h.matchKind) + '</span>' : '';
            return '<button type="button" class="sv-hit' + (i === st.hitIndex ? ' sv-hit-on' : '') + '" data-sv="hit" data-i="' + i + '">' +
                '<div class="sv-hit-where">' + esc(baseName(h.member)) + ' \u00B7 ' + esc(where) + '</div>' +
                '<div class="sv-hit-prev">' + esc(h.preview) + '</div>' +
                '<div class="sv-hit-meta">' + cor + kind + '</div></button>';
        }).join('');
        var more = loc.totalHits > loc.hits.length ? '<div class="sv-dim sv-small">Showing the best ' + loc.hits.length + ' of ' + loc.totalHits + '.</div>' : '';
        var head = loc.totalHits === 1 ? 'Found once' : 'Found ' + loc.totalHits + ' times';
        var note = loc.totalHits > 1
            ? '<div class="sv-dim sv-small">Best match first: the one where the other details of this record sit beside it.</div>' : '';
        return '<div class="sv-hits-head">' + head + '</div>' + note + items + more;
    }

    function linesHtml(lines, header) {
        var h = '<div class="sv-lines">';
        // Near the top of the file the heading row is already in the window:
        // tag it in place rather than printing it twice.
        var hdrInline = !!(header && (lines || []).some(function (l) { return l.n === header.n; }));
        if (header && !hdrInline) {
            h += '<div class="sv-line sv-line-header"><span class="sv-ln">' + esc(header.n) + '</span><span class="sv-lt">' + esc(header.text) + '</span><span class="sv-tag">column headings</span></div>' +
                '<div class="sv-line sv-gap"><span class="sv-ln">\u22EE</span><span class="sv-lt"></span></div>';
        }
        (lines || []).forEach(function (l) {
            var t = String(l.text || '');
            var body;
            if (l.target && l.hlStart != null && l.hlStart >= 0 && l.hlEnd > l.hlStart) {
                body = esc(t.slice(0, l.hlStart)) + '<mark class="sv-mark">' + esc(t.slice(l.hlStart, l.hlEnd)) + '</mark>' + esc(t.slice(l.hlEnd));
            } else body = esc(t);
            var isHdr = hdrInline && l.n === header.n;
            h += '<div class="sv-line' + (l.target ? ' sv-line-target' : '') + (isHdr ? ' sv-line-header' : '') + '"' + (l.target ? ' data-sv-target="1"' : '') + '>' +
                '<span class="sv-ln">' + esc(l.n) + '</span><span class="sv-lt">' + (l.cutLeft ? '<span class="sv-cut">\u2026</span>' : '') + body + (l.cutRight ? '<span class="sv-cut">\u2026</span>' : '') + '</span>' +
                (isHdr ? '<span class="sv-tag">column headings</span>' : '') + '</div>';
        });
        return h + '</div>';
    }

    // A database record: every column of the one row, the matching value marked.
    function recordHtml(v, member) {
        var cols = v.columns || [];
        return '<div class="sv-rec-head">' + esc(baseName(member || '')) + ' \u203A table <b>' + esc(v.table) + '</b> \u203A row <b>' + esc(v.rowid) + '</b></div>' +
            '<div class="sv-dim sv-small">The record exactly as it is stored in the original database. Nothing below has been reformatted.</div>' +
            '<table class="sv-rec"><tbody>' + cols.map(function (c) {
                var t = c.value;
                var body;
                if (t === null || t === undefined) body = '<span class="sv-dim">(empty)</span>';
                else if (c.binary) body = '<span class="sv-dim">' + esc(t) + '</span>';
                else {
                    t = String(t);
                    if (c.target && c.hlStart != null && c.hlStart >= 0 && c.hlEnd > c.hlStart) {
                        body = esc(t.slice(0, c.hlStart)) + '<mark class="sv-mark">' + esc(t.slice(c.hlStart, c.hlEnd)) + '</mark>' + esc(t.slice(c.hlEnd));
                    } else body = esc(t);
                    body = (c.cutLeft ? '<span class="sv-cut">\u2026</span>' : '') + body + (c.cutRight ? '<span class="sv-cut">\u2026</span>' : '');
                }
                var tag = c.target ? '<span class="sv-tag">match</span>' : c.corroborate ? '<span class="sv-tag sv-tag-cor">agrees</span>' : '';
                return '<tr class="' + (c.target ? 'sv-rec-target' : c.corroborate ? 'sv-rec-cor' : '') + '"' + (c.target ? ' data-sv-target="1"' : '') + '>' +
                    '<th>' + esc(c.name) + '</th><td>' + body + '</td><td class="sv-rec-tag">' + tag + '</td></tr>';
            }).join('') + '</tbody></table>';
    }

    function hitWhere(h) {
        if (h.table) return 'table ' + h.table + ' \u00B7 row ' + h.rowid;
        return h.page ? 'page ' + h.page + (h.pageCount ? ' of ' + h.pageCount : '') : 'line ' + h.line;
    }

    function cellsHtml(cells) {
        if (!cells || !cells.length) return '';
        return '<div class="sv-cells-head">This row, read under its column headings</div><table class="sv-cells"><tbody>' +
            cells.map(function (c) {
                return '<tr' + (c.hit ? ' class="sv-cell-hit"' : '') + '><th>' + esc(c.name) + '</th><td>' + esc(c.value) + '</td></tr>';
            }).join('') + '</tbody></table>';
    }

    function viewHtml(st) {
        var v = st.view;
        if (!v) return '';
        if (v.loading) return '<div class="sv-loading"><span class="sv-spin"></span> Opening the original\u2026</div>';
        if (!v.ok) return '<div class="sv-banner sv-banner-bad">' + esc(v.error || 'The original could not be shown.') + '</div>';
        if (v.format === 'pdf') {
            var rects = (v.rects || []).map(function (r) {
                return '<div class="sv-rect sv-rect-' + esc(r.role) + '"' + (r.role === 'hit' ? ' data-sv-target="1"' : '') +
                    ' style="left:' + r.x.toFixed(1) + 'px;top:' + r.y.toFixed(1) + 'px;width:' + r.w.toFixed(1) + 'px;height:' + r.h.toFixed(1) + 'px"></div>';
            }).join('');
            var note = v.highlightDrawn ? '' :
                '<div class="sv-banner">The text is on this page, but VIPER could not place a box over it. It is shown in the text below.</div>';
            return note + '<div class="sv-pdf-wrap"><div class="sv-pdf" style="width:' + v.width + 'px;height:' + v.height + 'px">' +
                '<img alt="Page ' + esc(v.page) + ' of the original PDF" src="data:image/png;base64,' + v.png + '" width="' + v.width + '" height="' + v.height + '">' +
                rects + '</div></div>' +
                '<details class="sv-pdf-text"><summary>Text on this page (page ' + esc(v.page) + ' of ' + esc(v.pageCount) + ')</summary>' + linesHtml(v.lines) + '</details>';
        }
        if (v.format === 'record') {
            var rh = st.located && st.located.hits && st.located.hits[st.hitIndex];
            return recordHtml(v, (rh && rh.member) || v.member);
        }
        if (v.format === 'html') {
            var tabs = '<div class="sv-tabs">' +
                '<button type="button" data-sv="tab" data-tab="provider" class="' + (st.viewTab === 'provider' ? 'sv-tab-on' : '') + '">As the provider\u2019s page shows it</button>' +
                '<button type="button" data-sv="tab" data-tab="raw" class="' + (st.viewTab === 'raw' ? 'sv-tab-on' : '') + '">Raw text (line ' + esc(v.line) + ')</button></div>';
            if (st.viewTab === 'raw') return tabs + linesHtml(v.raw);
            var warn = v.marked ? '' : '<div class="sv-banner">The value sits inside the page\u2019s markup, not its visible text \u2014 see Raw text.</div>';
            return tabs + warn + '<iframe class="sv-frame" sandbox="allow-same-origin" referrerpolicy="no-referrer" title="Original page"></iframe>';
        }
        return linesHtml(v.lines, v.header) + cellsHtml(v.cells);
    }

    function bodyHtml(st) {
        var loc = st.located;
        if (st.busy || !loc) {
            return '<div class="sv-loading"><span class="sv-spin"></span> Searching the original' +
                (st.source && st.source.path ? ' (' + esc(baseName(st.source.path)) + ')' : '') + '\u2026</div>';
        }
        if (!loc.ok) {
            if (loc.locked) return '<div class="sv-banner sv-banner-bad">\uD83D\uDD12 ' + esc(loc.error) + '</div>';
            return '<div class="sv-banner sv-banner-bad">' + esc(loc.error || 'The original could not be searched.') + '</div>' +
                (loc.missing ? '<p class="sv-p">If the return was moved or renamed, use <b>Locate original\u2026</b> below to point VIPER at it.</p>' : '');
        }
        if (!loc.found) {
            var searched = (loc.searchedMembers || []);
            var skipped = (loc.skippedMembers || []);
            return '<div class="sv-banner sv-banner-bad"><b>Not found.</b> VIPER searched the original for \u201C' + esc(st.payload.values[0]) + '\u201D' +
                (st.payload.values.length > 1 ? ' and ' + (st.payload.values.length - 1) + ' related detail' + (st.payload.values.length > 2 ? 's' : '') : '') +
                (loc.relatedOnly
                    ? ' and did not find it. Some of the related details do appear in the original, but never together on one record, so VIPER will not point at a line.</div>'
                    : ' and did not find ' + (st.payload.values.length > 1 ? 'any of them' : 'it') + '.</div>') +
                (loc.incomplete ? '<div class="sv-banner sv-banner-warn">The search stopped early because the return is very large. Not every file was searched.</div>' : '') +
                (loc.note ? '<p class="sv-p">' + esc(loc.note) + '</p>' : '') +
                '<p class="sv-p">Possible reasons: the original on disk is not the file this was imported from (check the SHA-256 below), ' +
                'or the PDF is a scan whose text VIPER read with OCR.</p>' +
                (searched.length ? '<details class="sv-searched" open><summary>Files searched (' + searched.length + ')</summary><ul>' +
                    searched.slice(0, 200).map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') +
                    (searched.length > 200 ? '<li>\u2026 and ' + (searched.length - 200) + ' more</li>' : '') + '</ul></details>' : '') +
                (skipped.length ? '<details class="sv-searched"><summary>Files that could not be read (' + skipped.length + ')</summary><ul>' +
                    skipped.map(function (s) { return '<li>' + esc(s.member) + ' \u2014 ' + esc(s.error) + '</li>'; }).join('') + '</ul></details>' : '');
        }
        return '<div class="sv-split"><div class="sv-side">' + hitListHtml(st) + '</div><div class="sv-main">' + viewHtml(st) + '</div></div>';
    }

    function shortHash(h) { return h ? h.slice(0, 16) + '\u2026' + h.slice(-8) : ''; }

    function integrityHtml(st) {
        var h = st.hash;
        var exp = st.payload.expected;
        if (!st.source || !st.source.path) return '';
        if (!h) return '<div class="sv-int sv-dim"><span class="sv-spin sv-spin-sm"></span> Computing SHA-256 of the original\u2026</div>';
        if (!h.ok) return '<div class="sv-int sv-dim">SHA-256: ' + esc(h.error || 'not available') + '</div>';
        var mainHash = h.folder ? h.folder.manifestSha256 : (h.contentSha256 || (h.container && h.container.sha256));
        var label = h.folder
            ? (h.folder.selected
                ? 'SHA-256 (the ' + h.folder.fileCount + ' file' + (h.folder.fileCount === 1 ? '' : 's') + ' VIPER reads from this folder)'
                : 'SHA-256 (all ' + h.folder.fileCount + ' files in the folder)')
            : 'SHA-256 of the original';
        var line;
        if (h.status === 'match') {
            line = '<span class="sv-ok">\u2713 Unchanged since import</span> \u2014 matches the fingerprint VIPER took' +
                (exp && exp.recordedAt ? ' on ' + esc(fmtDate(exp.recordedAt)) : '') + '.';
        } else if (h.status === 'mismatch') {
            line = '<span class="sv-bad">\u2717 Does NOT match the fingerprint taken at import</span>' +
                (exp && exp.recordedAt ? ' (' + esc(fmtDate(exp.recordedAt)) + ')' : '') +
                '. This file has changed, or it is a different file from the one imported.';
        } else if (!exp) {
            line = '<span class="sv-dim">\u25CB No fingerprint was taken when this was imported</span> (it was imported before this version of VIPER). ' +
                'Today\u2019s SHA-256 is shown so it can be compared with the provider\u2019s.';
        } else if (h.container && h.container.contentNote === 'locked') {
            line = '<span class="sv-dim">\uD83D\uDD12 Unlock VIPER to check this encrypted original against its fingerprint.</span>';
        } else {
            line = '<span class="sv-dim">\u25CB The fingerprint could not be compared.</span>';
        }
        var full = mainHash ? '<code class="sv-hash" title="' + esc(mainHash) + '">' + esc(shortHash(mainHash)) + '</code>' +
            '<button type="button" class="sv-mini" data-sv="copyhash">Copy</button>' : '';
        var extra = '';
        if (h.container && h.container.encryptedAtRest) {
            extra += '<div class="sv-dim sv-small">Stored encrypted by Field Security. The hash above is of the original (decrypted) bytes; ' +
                'the encrypted file on disk is ' + esc(shortHash(h.container.sha256)) + '.</div>';
        }
        if (h.member && h.member.sha256) {
            extra += '<div class="sv-dim sv-small">' + esc(baseName(h.member.name)) + ' inside the ZIP: <code>' + esc(shortHash(h.member.sha256)) + '</code></div>';
        }
        if (exp && Array.isArray(exp.indexFiles) && exp.indexFiles.length) {
            // e.g. a Cellebrite report's .ufdx/.ufd, hashed at import — shown
            // so they can be checked against the extraction report.
            extra += '<div class="sv-dim sv-small">Recorded at import: ' + exp.indexFiles.slice(0, 6).map(function (f) {
                return esc(f.name) + ' <code title="' + esc(f.sha256) + '">' + esc(shortHash(f.sha256)) + '</code>';
            }).join(' \u00B7 ') + '</div>';
        }
        return '<div class="sv-int ' + (h.status === 'mismatch' ? 'sv-int-bad' : '') + '"><div>' + line + '</div>' +
            '<div class="sv-int-row">' + esc(label) + ': ' + full + '</div>' + extra + '</div>';
    }

    function whereText(st) {
        var loc = st.located;
        var hit = loc && loc.hits && loc.hits[st.hitIndex];
        if (!hit) return st.source && st.source.path ? baseName(st.source.path) : '';
        if (hit.table) return hit.member + ' \u203A table ' + hit.table + ' \u203A row ' + hit.rowid;
        return hit.member + ' \u203A ' + (hit.page ? 'page ' + hit.page + (hit.pageCount ? ' of ' + hit.pageCount : '') : 'line ' + hit.line);
    }

    function footerHtml(st) {
        var src = st.source;
        var hit = st.located && st.located.hits && st.located.hits[st.hitIndex];
        var p = src && src.path ? String(src.path) : '';
        var canOpenExternal = p && !src.entry && /\.(pdf|csv|txt|html?|json|xml)$/i.test(p);
        var b = '';
        if (p) b += '<button type="button" class="sv-act" data-sv="reveal" title="' + esc(p) + '">\uD83D\uDCC2 Show in folder</button>';
        if (hit) b += '<button type="button" class="sv-act" data-sv="save" title="Save the original ' + esc(baseName(hit.member)) + ' to open in another tool">\uD83D\uDCBE Save a copy of ' + esc(baseName(hit.member)) + '</button>';
        if (canOpenExternal) b += '<button type="button" class="sv-act" data-sv="external">\u2197 Open in its own program</button>';
        b += '<button type="button" class="sv-act" data-sv="relocate">Locate original\u2026</button>';
        if (hit) b += '<button type="button" class="sv-act sv-act-primary" data-sv="cite">\uD83D\uDCCB Copy citation</button>';
        return '<div class="sv-where">' + esc(whereText(st)) + '</div>' +
            '<div class="sv-int-slot">' + integrityHtml(st) + '</div>' +
            '<div class="sv-actions">' + b + '<span class="sv-flash" aria-live="polite"></span></div>';
    }

    function paint() {
        var st = _state;
        if (!st) return;
        st.root.innerHTML = '<div class="sv-modal">' + headerHtml(st) +
            '<div class="sv-body">' + bodyHtml(st) + '</div>' +
            '<div class="sv-foot">' + footerHtml(st) + '</div></div>';
        wire(st);
        afterPaint(st);
    }

    function paintFooter() {
        var st = _state;
        if (!st) return;
        var slot = q('.sv-int-slot');
        if (slot) { slot.innerHTML = integrityHtml(st); wire(st, slot); }
    }

    function afterPaint(st) {
        var v = st.view;
        if (v && v.ok && v.format === 'html' && st.viewTab === 'provider') {
            var fr = q('.sv-frame');
            if (fr) {
                fr.addEventListener('load', function () {
                    try {
                        var m = fr.contentDocument && fr.contentDocument.getElementById('viper-src-hit');
                        if (m && m.scrollIntoView) m.scrollIntoView({ block: 'center' });
                    } catch (_) {}
                });
                fr.srcdoc = v.html;
            }
            return;
        }
        var t = q('[data-sv-target="1"]');
        if (t && t.scrollIntoView) { try { t.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {} }
    }

    function flash(msg) {
        var f = q('.sv-flash');
        if (f) { f.textContent = msg; setTimeout(function () { if (f) f.textContent = ''; }, 4000); }
    }

    function wire(st, scope) {
        var els = (scope || st.root).querySelectorAll('[data-sv]');
        for (var i = 0; i < els.length; i++) {
            (function (el) {
                el.addEventListener('click', function (e) { e.preventDefault(); act(st, el); });
            })(els[i]);
        }
    }

    function copyText(text) {
        try {
            if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
                return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return false; });
            }
        } catch (_) {}
        return Promise.resolve(false);
    }

    function fmtDate(iso) {
        var d = new Date(iso);
        if (isNaN(d.getTime())) return String(iso || '');
        var pad = function (n) { return (n < 10 ? '0' : '') + n; };
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    /** Plain-text citation for a report or an email to a prosecutor. */
    function citation(st) {
        var p = st.payload, loc = st.located, h = st.hash;
        var hit = loc && loc.hits && loc.hits[st.hitIndex];
        if (!hit) return '';
        var k = KIND_TEXT[hit.matchKind] || KIND_TEXT.exact;
        var lines = [
            'VIPER source check \u2014 ' + fmtDate(new Date().toISOString()),
            (p.title || 'Value') + ': ' + (p.shown != null ? p.shown : p.values[0]),
        ];
        if (loc.primaryFound === false) {
            lines.push('NOTE: this value itself was not found; the ' + valueLabel(st, loc.usedValueIndex) + ' was found instead.');
        }
        lines.push('Original reads: ' + hit.matched + ' (' + k.label.toLowerCase() + ')');
        lines.push('Location: ' + whereText(st));
        if (loc.totalHits > 1) lines.push('Occurrences in the original: ' + loc.totalHits + (hit.corroboratedBy.length ? '; ' + hit.corroboratedBy.length + ' other detail(s) of this record found beside this one' : ''));
        if (st.source && st.source.path) lines.push('Original file: ' + st.source.path);
        if (h && h.ok) {
            var mh = h.folder ? h.folder.manifestSha256 : (h.contentSha256 || (h.container && h.container.sha256));
            if (mh) lines.push('SHA-256' + (h.folder ? ' (folder manifest)' : '') + ': ' + mh);
            if (h.member && h.member.sha256) lines.push('SHA-256 of ' + baseName(h.member.name) + ': ' + h.member.sha256);
            if (h.status === 'match') lines.push('Unchanged since import (fingerprint recorded ' + fmtDate(p.expected && p.expected.recordedAt) + ').');
            else if (h.status === 'mismatch') lines.push('WARNING: does NOT match the fingerprint recorded at import.');
            else if (!p.expected) lines.push('No fingerprint was recorded at import.');
        }
        if (p.expected && Array.isArray(p.expected.indexFiles)) {
            p.expected.indexFiles.forEach(function (f) { if (f && f.sha256) lines.push('SHA-256 of ' + f.name + ' (recorded at import): ' + f.sha256); });
        }
        return lines.join('\n');
    }

    async function act(st, el) {
        var a = api();
        var what = el.getAttribute('data-sv');
        var src = st.source;
        if (what === 'close') return close();
        if (what === 'hit') return showHit(st, parseInt(el.getAttribute('data-i'), 10) || 0);
        if (what === 'tab') { st.viewTab = el.getAttribute('data-tab') === 'raw' ? 'raw' : 'provider'; return paint(); }
        if (what === 'copyhash') {
            var h = st.hash;
            var mh = h && (h.folder ? h.folder.manifestSha256 : (h.contentSha256 || (h.container && h.container.sha256)));
            if (mh) flash((await copyText(mh)) ? 'SHA-256 copied.' : mh);
            return;
        }
        if (what === 'cite') { flash((await copyText(citation(st))) ? 'Citation copied.' : 'Could not copy.'); return; }
        if (!a) return;
        if (what === 'reveal' && src) {
            var r = await a.sourceReveal({ path: src.path });
            if (r && !r.ok) flash(r.error);
            return;
        }
        if (what === 'external' && src) {
            var r2 = await a.sourceOpenExternal({ path: src.path });
            if (r2 && !r2.ok) flash(r2.error);
            return;
        }
        if (what === 'save' && src) {
            var hit = st.located && st.located.hits && st.located.hits[st.hitIndex];
            if (!hit) return;
            var r3 = await a.sourceSaveCopy({ source: srcArg(src), memberKey: hit.memberKey });
            if (r3 && r3.ok) flash('Saved. SHA-256 ' + shortHash(r3.sha256));
            else if (r3 && !r3.canceled) flash(r3.error || 'Not saved.');
            return;
        }
        if (what === 'relocate') {
            var picked = await a.sourcePickOriginal({ folder: !!st.payload.relocateFolder, defaultPath: src && src.path ? src.path : undefined });
            if (!picked) return;
            var next = { path: picked, label: baseName(picked) };
            if (src && src.entry && /\.zip$/i.test(picked)) { next.entry = src.entry; if (src.inZip) next.inZip = src.inZip; }
            // A moved folder still holds the same files to fingerprint.
            if (src && src.hashOnly && src.hashOnly.length && st.payload.relocateFolder) next.hashOnly = src.hashOnly.slice();
            if (typeof st.payload.onRelocate === 'function') {
                try { var ret = await st.payload.onRelocate(picked, next); if (ret && ret.path) next = ret; } catch (_) {}
            }
            st.source = next;
            st.payload.source = next;
            return run(st);
        }
    }

    return {
        open: open,
        close: close,
        register: register,
        buttonHtml: buttonHtml,
        openToken: openToken,
        // tests
        _setApi: function (a) { _api = a; },
        _setDocument: function (d) { _doc = d; },
        _state: function () { return _state; },
        _citation: function () { return _state ? citation(_state) : ''; },
        _esc: esc,
    };
}));

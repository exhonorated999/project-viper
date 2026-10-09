/*
 * provenance.js — showing which work on a case came from somebody else.
 *
 * When a detective imports a supplemental package, every record that
 * arrives is stamped with a `_prov` block by modules/case-merge/case-merge.js
 * (see makeProv there for the shape). This module is the single place that
 * decides how that stamp is PRESENTED, so the suspects tab, the notes tab,
 * the evidence tab and the Contributions panel cannot drift into describing
 * the same record three different ways.
 *
 * Three rules this module exists to enforce:
 *
 * 1. Display only. Nothing here writes. `markEdited` returns a COPY —
 *    the caller is usually still rendering the original.
 *
 * 2. Everything that reaches HTML is escaped. The officer name, badge and
 *    agency in a `_prov` block were typed on SOMEBODY ELSE'S machine and
 *    arrived in a file. They are untrusted input, and they land in
 *    innerHTML on every card.
 *
 * 3. Colour identifies the DETECTIVE, never a status. Red and amber are
 *    held out of the palette entirely, because a case screen already uses
 *    those for overdue, unverified and not-discoverable. A colour that
 *    merely means "Alvarez sent this" must never be readable as an alert.
 *    This mirrors the reasoning in the Supervisor Edition's task board.
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    /* Assign to BOTH. In VIPER's renderer `module` is defined, so a plain
     * else-branch here would leave window.Provenance undefined and every
     * `if (window.Provenance)` host branch would silently never fire. */
    if (root) root.Provenance = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    /* ────────────────────────────────────────────────────────────────
       reading the stamp
       ──────────────────────────────────────────────────────────────── */

    /** The stamp, or null. Accepts anything — renderers call this on rows
     *  that may be null, strings, or half-built objects. */
    function provOf(rec) {
        if (!rec || typeof rec !== 'object') return null;
        var p = rec._prov;
        if (!p || typeof p !== 'object') return null;
        return p;
    }

    /** True when this record came from another detective's package. */
    function isImported(rec) {
        return !!provOf(rec);
    }

    /** True when the officer at this machine created it. The negation is
     *  spelled out rather than left implicit because "mine" is a filter the
     *  officer picks by name. */
    function isMine(rec) {
        return !provOf(rec);
    }

    /** True when an imported record has since been changed here. */
    function isEditedHere(rec) {
        var p = provOf(rec);
        return !!(p && p.editedHere);
    }

    /** "Det. M. Alvarez 4471" — what to put on the chip. Falls back to the
     *  same wording case-merge.js uses when the package named nobody, so the
     *  chip and the import summary agree. */
    function sourceName(rec) {
        var p = provOf(rec);
        if (!p) return '';
        return formatWho(p.by, p.badge);
    }

    /**
     * "Det. M. Alvarez #4471". The ONE place a name and badge are joined,
     * so the chip, the Contributions panel and an export cover page never
     * disagree about how an officer is written. The hash is added only when
     * the sender did not already type one.
     */
    function formatWho(name, badge) {
        var n = String(name == null ? '' : name).trim() || 'Unknown officer';
        var b = formatBadge(badge);
        return b ? (n + ' ' + b) : n;
    }

    /** The badge on its own, for a layout that colours it separately. */
    function formatBadge(badge) {
        var b = String(badge == null ? '' : badge).trim();
        if (!b) return '';
        return b.charAt(0) === '#' ? b : '#' + b;
    }

    /** The grouping key for the Contributions panel and the colour. Badge is
     *  included because two detectives can share a surname, and the name
     *  alone is what the sender typed into their own settings. */
    function sourceKey(rec) {
        var p = provOf(rec);
        if (!p) return '';
        return (String(p.by || '').trim().toLowerCase() + '|' + String(p.badge || '').trim().toLowerCase());
    }

    /** Which import batch a record arrived in. Undo works per batch. */
    function batchId(rec) {
        var p = provOf(rec);
        return (p && p.pkg) ? String(p.pkg) : '';
    }

    /* ────────────────────────────────────────────────────────────────
       colour
       ──────────────────────────────────────────────────────────────── */

    /*
     * A fixed palette, walked by a hash of the detective. Stable means the
     * same detective is the same colour on every machine and in every tab,
     * and that adding a seventh contributor does not re-colour the other
     * six — which would quietly invalidate whatever the officer had already
     * learned to read.
     *
     * No red, no amber, no green: those three are already load-bearing on a
     * case screen (overdue, unverified, cleared).
     */
    var PALETTE = [
        '139, 92, 246',   /* violet */
        ' 56,189, 248',   /* sky    */
        '244,114,182',    /* pink   */
        '129,140,248',    /* indigo */
        ' 45,212,191',    /* teal   */
        '192,132,252',    /* purple */
        ' 96,165,250',    /* blue   */
        '251,146, 60'     /* orange — distinct from amber/red in hue and only
                             reached by the eighth contributor */
    ];

    /** FNV-1a. Small, stable, and does not depend on the JS engine's string
     *  hashing, so two machines agree. */
    function _hash(str) {
        var h = 0x811c9dc5;
        var s = String(str || '');
        for (var i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
        }
        return h >>> 0;
    }

    /** "139, 92, 246" for a record, or '' when it is the officer's own work. */
    function colorOf(rec) {
        var k = sourceKey(rec);
        if (!k) return '';
        return PALETTE[_hash(k) % PALETTE.length];
    }

    /** Same, keyed directly by a name/badge pair, for the legend and the
     *  Contributions panel where there is no record to hand. */
    function colorFor(name, badge) {
        var k = String(name || '').trim().toLowerCase() + '|' + String(badge || '').trim().toLowerCase();
        if (k === '|') return '';
        return PALETTE[_hash(k) % PALETTE.length];
    }

    /* ────────────────────────────────────────────────────────────────
       html
       ──────────────────────────────────────────────────────────────── */

    function esc(s) {
        return String(s === null || s === undefined ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /** A date the way the rest of the case screen writes them. Returns ''
     *  rather than "Invalid Date" for a stamp we cannot read. */
    function _when(iso) {
        if (!iso) return '';
        var d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        var mm = String(d.getMonth() + 1).padStart(2, '0');
        var dd = String(d.getDate()).padStart(2, '0');
        return mm + '/' + dd + '/' + d.getFullYear();
    }

    /**
     * The full sentence, for a title= tooltip and for the detail pages.
     * Everything the officer would need to go back to the source: who, what
     * agency, their case number, and when it landed here.
     */
    function sourceLine(rec) {
        var p = provOf(rec);
        if (!p) return '';
        var bits = ['Imported from ' + sourceName(rec)];
        if (p.agency) bits.push(String(p.agency).trim());
        if (p.case) bits.push('their case ' + String(p.case).trim());
        var w = _when(p.at);
        if (w) bits.push('received ' + w);
        var line = bits.join(' · ');
        if (p.editedHere) line += ' · edited on this machine since';
        return line;
    }

    /**
     * The small chip that sits on a card.
     *
     * Deliberately carries the detective's NAME and not just the word
     * "Imported". On a case with three contributors, "imported" alone
     * answers the less useful half of the question.
     *
     * opts.compact — drop the wrapper margin, for table rows and list items.
     */
    function chipHtml(rec, opts) {
        var p = provOf(rec);
        if (!p) return '';
        var o = opts || {};
        var rgb = colorOf(rec);
        var label = esc(sourceName(rec));
        var title = esc(sourceLine(rec));
        var edited = p.editedHere
            ? '<span style="opacity:.75;"> · edited here</span>'
            : '';
        var chip =
            '<span class="vp-prov-chip" data-prov-source="' + esc(sourceKey(rec)) + '"' +
            ' title="' + title + '"' +
            ' style="display:inline-block;font-size:11px;line-height:1.4;padding:1px 7px;border-radius:9999px;' +
            'background:rgba(' + rgb + ',0.16);color:rgb(' + rgb + ');border:1px solid rgba(' + rgb + ',0.45);' +
            'white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis;vertical-align:middle;">' +
            'From ' + label + edited +
            '</span>';
        if (o.compact) return chip;
        return '<div class="mb-2">' + chip + '</div>';
    }

    /**
     * The left accent for a card. Returned as a style STRING to be dropped
     * into an existing style="" attribute, because every card on the case
     * screen already carries one and appending is the only edit that cannot
     * disturb the layout already there.
     */
    function accentStyle(rec) {
        var rgb = colorOf(rec);
        if (!rgb) return '';
        return 'border-left:3px solid rgb(' + rgb + ');';
    }

    /** The legend / filter swatch. */
    function swatchHtml(name, badge) {
        var rgb = colorFor(name, badge);
        if (!rgb) return '';
        return '<span style="display:inline-block;width:9px;height:9px;border-radius:9999px;' +
            'background:rgb(' + rgb + ');margin-right:6px;vertical-align:middle;"></span>';
    }

    /* ────────────────────────────────────────────────────────────────
       editing an imported record
       ──────────────────────────────────────────────────────────────── */

    /**
     * Note that the officer here has changed an imported record.
     *
     * The stamp is KEPT, not cleared. Where a record originally came from
     * stays true no matter how much it is subsequently edited, and losing
     * that would quietly break the audit trail that is the whole point of
     * this feature. `editedHere` is additive, and `editedAt` records when.
     *
     * Returns a copy; the caller may still be rendering the original. A
     * record with no stamp is returned unchanged — the officer's own work
     * does not need to be told it was edited by its own author.
     *
     * `editedAt` is set ONCE and then left alone. The chip says "edited
     * here", not "edited two minutes ago", so the useful date is the one
     * where the record stopped being purely the other detective's — the
     * last of many small corrections is the less interesting fact.
     */
    function markEdited(rec, when) {
        var p = provOf(rec);
        if (!p) return rec;
        var out = Object.assign({}, rec);
        out._prov = Object.assign({}, p, {
            editedHere: true,
            editedAt: p.editedAt || when || new Date().toISOString()
        });
        return out;
    }

    /* ────────────────────────────────────────────────────────────────
       filtering and grouping
       ──────────────────────────────────────────────────────────────── */

    /**
     * 'all' | 'mine' | 'imported' | a sourceKey.
     * An unrecognised filter shows everything rather than nothing: a typo in
     * a filter value must never look like an empty case.
     */
    function matchesFilter(rec, filter) {
        var f = String(filter || 'all');
        if (f === 'all' || !f) return true;
        if (f === 'mine') return isMine(rec);
        if (f === 'imported') return isImported(rec);
        if (f.indexOf('src:') === 0) return sourceKey(rec) === f.slice(4);
        return true;
    }

    /**
     * Group imported records for the Contributions panel.
     *
     * `rows` is a flat list of { store, label, record } so the panel can say
     * "4 suspects, 2 notes" rather than an undifferentiated count. Grouped
     * by detective, then by import batch, because Undo works per batch.
     *
     * Returns [] when nothing was imported — the caller renders no panel at
     * all in that case, the same way the supervisor board hides itself.
     */
    function contributions(rows) {
        var bySource = {};
        (rows || []).forEach(function (row) {
            if (!row) return;
            var rec = row.record;
            var p = provOf(rec);
            if (!p) return;
            var sk = sourceKey(rec);
            if (!bySource[sk]) {
                bySource[sk] = {
                    sourceKey: sk,
                    name: String(p.by || '').trim() || 'Unknown officer',
                    badge: p.badge ? String(p.badge).trim() : '',
                    agency: p.agency ? String(p.agency).trim() : '',
                    color: colorOf(rec),
                    total: 0,
                    batches: {}
                };
            }
            var g = bySource[sk];
            g.total++;
            var bid = batchId(rec) || '(unknown)';
            if (!g.batches[bid]) {
                g.batches[bid] = { batchId: bid, at: p.at || '', total: 0, byStore: {}, theirCase: p.case || '' };
            }
            var b = g.batches[bid];
            b.total++;
            var lbl = row.label || row.store || 'records';
            b.byStore[lbl] = (b.byStore[lbl] || 0) + 1;
            /* Keep the EARLIEST timestamp in the batch. Every record in one
             * import is stamped within milliseconds, but a sort that is not
             * pinned would reorder the panel between repaints. */
            if (p.at && (!b.at || p.at < b.at)) b.at = p.at;
        });

        return Object.keys(bySource).map(function (k) {
            var g = bySource[k];
            g.batches = Object.keys(g.batches).map(function (b) { return g.batches[b]; })
                .sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); });
            return g;
        }).sort(function (a, b) {
            if (b.total !== a.total) return b.total - a.total;
            return a.name.localeCompare(b.name);
        });
    }

    /**
     * Every distinct contributor on the case, for the filter dropdown.
     */
    function sources(rows) {
        return contributions(rows).map(function (g) {
            return { key: g.sourceKey, name: g.name, badge: g.badge, agency: g.agency, color: g.color, count: g.total };
        });
    }

    /* ────────────────────────────────────────────────────────────────
       keeping the stamp out of exports
       ──────────────────────────────────────────────────────────────── */

    /**
     * The generic field dumpers in the DA report and the Assist Package walk
     * Object.entries(record) and print whatever they find. Without this they
     * print `_prov {"by":"M. Alvarez",...}` as raw JSON into a document that
     * goes to a prosecutor.
     *
     * Underscore-prefixed keys are internal across this codebase, so the
     * rule is the prefix rather than a list of names that would need
     * maintaining every time one is added.
     */
    function isInternalKey(key) {
        return String(key || '').charAt(0) === '_';
    }

    /** Record minus its internal keys, for a dumper that cannot be changed. */
    function forExport(rec) {
        if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return rec;
        var out = {};
        Object.keys(rec).forEach(function (k) {
            if (!isInternalKey(k)) out[k] = rec[k];
        });
        return out;
    }

    /**
     * One plain-language line per contributor, for an export cover page.
     * No chips, no colour — this is read on paper.
     */
    function coverLines(rows) {
        return contributions(rows).map(function (g) {
            var who = formatWho(g.name, g.badge);
            var where = g.agency ? ', ' + g.agency : '';
            var counts = {};
            g.batches.forEach(function (b) {
                Object.keys(b.byStore).forEach(function (s) { counts[s] = (counts[s] || 0) + b.byStore[s]; });
            });
            var parts = Object.keys(counts).sort().map(function (s) { return counts[s] + ' ' + s; });
            return who + where + ' — ' + parts.join(', ');
        });
    }

    return {
        provOf: provOf,
        isImported: isImported,
        isMine: isMine,
        isEditedHere: isEditedHere,
        sourceName: sourceName,
        formatWho: formatWho,
        formatBadge: formatBadge,
        sourceKey: sourceKey,
        batchId: batchId,
        colorOf: colorOf,
        colorFor: colorFor,
        chipHtml: chipHtml,
        accentStyle: accentStyle,
        swatchHtml: swatchHtml,
        sourceLine: sourceLine,
        markEdited: markEdited,
        matchesFilter: matchesFilter,
        contributions: contributions,
        sources: sources,
        isInternalKey: isInternalKey,
        forExport: forExport,
        coverLines: coverLines,
        esc: esc,
        PALETTE: PALETTE
    };
}));

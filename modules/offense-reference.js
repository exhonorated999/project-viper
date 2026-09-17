/**
 * Offense Reference — shared schema + import/export core.
 *
 * The reference library started life as a flat list of state offense codes.
 * It now holds three kinds of legal reference, which look nothing like each
 * other on paper:
 *
 *   state    PC 211 / Robbery / Felony / "2, 3, or 5 years"
 *   federal  18 U.S.C. § 2252A / Class B Felony / "5-20 years"
 *   caselaw  Riley v. California, 573 U.S. 373 (2014) / SCOTUS / holding
 *
 * They live in ONE localStorage array ('viperOffenseReference') discriminated
 * by `kind`, rather than three keys, for two reasons:
 *   1. Every record already written by every officer in the field has no
 *      `kind` field at all. One array + a default means those files and those
 *      localStorage blobs keep working untouched. Three keys would mean a
 *      migration, and migrations on evidence-adjacent data are where data
 *      goes to die.
 *   2. Export/import stays a single file. An officer sends one .voffenses to
 *      the squad and everyone gets the statutes AND the case law.
 *
 * THE CRITICAL INVARIANT: case law is NOT chargeable. You do not charge a
 * suspect with Riley v. California. Three separate dropdowns elsewhere in
 * VIPER build "Primary Offense" pickers out of this array, and every one of
 * them must go through chargeable() rather than reading the raw array.
 * See the consumers listed at the bottom of this file.
 *
 * Node-testable on purpose (UMD, no DOM, no localStorage at module scope) so
 * the normalize/import/dedupe logic can be tested without Electron.
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.OffenseReference = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    var STORAGE_KEY = 'viperOffenseReference';
    var EXPORT_TYPE = 'viper-offense-reference';
    var EXPORT_VERSION = 2;

    var KIND_STATE = 'state';
    var KIND_FEDERAL = 'federal';
    var KIND_CASELAW = 'caselaw';
    var KINDS = [KIND_STATE, KIND_FEDERAL, KIND_CASELAW];

    // Display metadata for the three tabs. `noun` is used in buttons and
    // confirmation prompts so the UI never says "Add Offense" on the case
    // law tab.
    var KIND_META = {
        state:   { id: KIND_STATE,   label: 'Offenses',          noun: 'Offense',          short: 'State'   },
        federal: { id: KIND_FEDERAL, label: 'Federal Statutes',  noun: 'Federal Statute',  short: 'Federal' },
        caselaw: { id: KIND_CASELAW, label: 'Case Law',          noun: 'Case Law Entry',   short: 'Case Law'}
    };

    // State classification. Unchanged from v1 — these strings are already
    // persisted in thousands of case records as the per-charge `type`, and
    // the Case Overview offense editor has its own copy of this list.
    var STATE_TYPES = ['Felony', 'Misdemeanor', 'Wobbler', 'Infraction', 'Non-Criminal'];

    // Federal classification per 18 U.S.C. § 3559. Federal offenses are
    // graded by letter class, which drives the sentencing table — "Felony"
    // alone is not useful to a federal prosecutor.
    var FEDERAL_TYPES = [
        'Class A Felony', 'Class B Felony', 'Class C Felony',
        'Class D Felony', 'Class E Felony',
        'Class A Misdemeanor', 'Class B Misdemeanor', 'Class C Misdemeanor',
        'Infraction'
    ];

    // THE CATEGORY *IS* THE KIND. There is no second vocabulary.
    //
    // An earlier cut of this feature shipped two fixed taxonomies (16 offense
    // categories, 14 case-law categories). That was rejected as over-built:
    // an officer maintaining a reference library does not want to make a
    // taxonomy decision on every row, and a category column whose value is
    // identical for every visible row is pure noise. The three tabs are the
    // categorization.
    //
    // `category` survives as a DERIVED field so that an exported .voffenses
    // file is readable by a human and so free-text search still matches the
    // word "federal". It is never user-editable and never stored from input.
    var CATEGORIES = ['State', 'Federal', 'Case Law'];

    function categoryLabel(kind) {
        return (KIND_META[kind] || KIND_META[KIND_STATE]).short;
    }

    function typesFor(kind) {
        if (kind === KIND_FEDERAL) return FEDERAL_TYPES.slice();
        if (kind === KIND_CASELAW) return [];
        return STATE_TYPES.slice();
    }

    function str(v) { return v == null ? '' : String(v).trim(); }

    function isKind(k) { return KINDS.indexOf(k) !== -1; }

    /**
     * Coerce any record — v1 legacy, v2, or half-built form input — into the
     * canonical shape.
     *
     * The single most important line here is the `kind` default. A record
     * written before this feature existed has no `kind`, and it is always a
     * state offense. Defaulting to state (not to '' or 'unknown') is what
     * makes every pre-existing library keep rendering on the first tab.
     *
     * For case law we ALSO synthesize `code` and `description` mirrors of the
     * citation and case name. Nothing should be reading those fields on a
     * caselaw record — but four call sites across three files do
     * `o.code.toLowerCase()` on the raw array, and a synthesized string is the
     * difference between a wrong-looking dropdown entry and a TypeError that
     * blanks the whole Create Case screen. Defence in depth: filter by kind
     * AND make the unfiltered path survive.
     */
    function normalize(rec, opts) {
        if (!rec || typeof rec !== 'object') return null;
        opts = opts || {};

        var kind = str(rec.kind).toLowerCase();
        if (!isKind(kind)) kind = opts.defaultKind && isKind(opts.defaultKind) ? opts.defaultKind : KIND_STATE;

        var out = {
            id: rec.id != null ? rec.id : null,
            kind: kind,
            // Derived, never taken from input — see the CATEGORIES comment.
            category: categoryLabel(kind),
            notes: str(rec.notes),
            createdAt: str(rec.createdAt) || new Date().toISOString()
        };

        if (kind === KIND_CASELAW) {
            out.caseName = str(rec.caseName) || str(rec.description);
            out.citation = str(rec.citation) || str(rec.code);
            out.court = str(rec.court);
            out.year = str(rec.year);
            out.holding = str(rec.holding);
            // Mirrors — see the doc comment above.
            out.code = out.citation;
            out.description = out.caseName;
        } else {
            out.code = str(rec.code);
            out.description = str(rec.description);
            out.type = str(rec.type);
            out.sentencing = str(rec.sentencing);
        }

        return out;
    }

    /** True when the record is something a person can actually be charged with. */
    function isChargeable(rec) {
        return !!rec && rec.kind !== KIND_CASELAW;
    }

    /** The subset of a library usable in a "Primary Offense" picker. */
    function chargeable(list) {
        return (list || []).filter(isChargeable);
    }

    function ofKind(list, kind) {
        return (list || []).filter(function (r) { return r && r.kind === kind; });
    }

    /**
     * Identity for de-duplication on import.
     *
     * Kind is part of the key. A state "18-2-101" and a federal "18 U.S.C.
     * § 2101" both lower-case down to something an officer might reasonably
     * have in both tabs, and silently overwriting one with the other during a
     * squad-wide import would be a quiet data loss.
     */
    function dedupeKey(rec) {
        if (!rec) return '';
        var ident = rec.kind === KIND_CASELAW
            ? (rec.citation || rec.caseName || '')
            : (rec.code || '');
        return rec.kind + '|' + String(ident).toLowerCase().replace(/\s+/g, ' ').trim();
    }

    /** The label a record shows in a list, regardless of kind. */
    function displayLabel(rec) {
        if (!rec) return '';
        if (rec.kind === KIND_CASELAW) {
            return rec.caseName + (rec.citation ? ', ' + rec.citation : '');
        }
        return rec.code + (rec.description ? ' — ' + rec.description : '');
    }

    /** The exact string written into a case's offense field when picked. */
    function chargeValue(rec) {
        if (!rec) return '';
        return rec.code + ' - ' + rec.description;
    }

    /** Free-text search across every field that matters for the given kind. */
    function matchesSearch(rec, term) {
        if (!term) return true;
        var t = String(term).toLowerCase();
        var hay = rec.kind === KIND_CASELAW
            ? [rec.caseName, rec.citation, rec.court, rec.year, rec.holding, rec.category, rec.notes]
            : [rec.code, rec.description, rec.type, rec.sentencing, rec.category, rec.notes];
        for (var i = 0; i < hay.length; i++) {
            if (hay[i] && String(hay[i]).toLowerCase().indexOf(t) !== -1) return true;
        }
        return false;
    }

    // ---- persistence -------------------------------------------------------
    // Takes the storage object as an argument so tests can drive it without a
    // DOM and so a caller in a sandboxed context can pass its own.

    function loadAll(storage) {
        var s = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
        if (!s) return [];
        var raw;
        try { raw = s.getItem(STORAGE_KEY); } catch (_e) { return []; }
        if (!raw) return [];
        var parsed;
        try { parsed = JSON.parse(raw); } catch (_e) { return []; }
        if (!Array.isArray(parsed)) return [];
        var out = [];
        for (var i = 0; i < parsed.length; i++) {
            var n = normalize(parsed[i]);
            if (n) out.push(n);
        }
        return out;
    }

    function saveAll(list, storage) {
        var s = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
        if (!s) return false;
        try {
            s.setItem(STORAGE_KEY, JSON.stringify(list || []));
            return true;
        } catch (_e) {
            // Quota or a locked profile. The caller decides how loud to be;
            // this must not throw, because the in-memory list is still good
            // and losing the exception here would be worse than a failed save.
            return false;
        }
    }

    // ---- export / import ---------------------------------------------------

    function buildExport(list) {
        var recs = (list || []).map(function (r) { return normalize(r); }).filter(Boolean);
        return {
            type: EXPORT_TYPE,
            version: EXPORT_VERSION,
            exportedAt: new Date().toISOString(),
            count: recs.length,
            counts: {
                state: ofKind(recs, KIND_STATE).length,
                federal: ofKind(recs, KIND_FEDERAL).length,
                caselaw: ofKind(recs, KIND_CASELAW).length
            },
            // v1 readers looked for `offenses`. Keep that name so an older
            // VIPER can still open a file exported by a newer one and at
            // least get the statutes.
            offenses: recs
        };
    }

    /**
     * Parse a .voffenses payload.
     *
     * Accepts:
     *   v2  { type, version:2, offenses:[ {kind, ...} ] }
     *   v1  { type, version:1, offenses:[ {code, description, type, ...} ] }
     *   bare array (hand-rolled files seen in the wild)
     *
     * Returns { ok, error, records, version }.
     */
    function parseImport(raw) {
        var parsed;
        if (typeof raw === 'string') {
            try { parsed = JSON.parse(raw); }
            catch (e) { return { ok: false, error: 'Not valid JSON: ' + e.message, records: [], version: 0 }; }
        } else {
            parsed = raw;
        }
        if (!parsed) return { ok: false, error: 'Empty file.', records: [], version: 0 };

        var arr = null;
        var version = 0;
        if (Array.isArray(parsed)) {
            arr = parsed;
            version = 1;
        } else if (Array.isArray(parsed.offenses)) {
            arr = parsed.offenses;
            version = Number(parsed.version) || 1;
        } else if (Array.isArray(parsed.records)) {
            arr = parsed.records;
            version = Number(parsed.version) || 1;
        }
        if (!arr) return { ok: false, error: 'No offense list found in file.', records: [], version: 0 };

        var records = [];
        for (var i = 0; i < arr.length; i++) {
            // A v1 file predates `kind` entirely, so everything in it is a
            // state offense. Passing defaultKind explicitly (rather than
            // relying on normalize's own default) documents the intent.
            var n = normalize(arr[i], { defaultKind: KIND_STATE });
            if (!n) continue;
            // Drop records with no identity at all — an empty row in a
            // hand-edited file should not become an empty library entry.
            if (!n.code && !n.description && !n.caseName && !n.citation) continue;
            records.push(n);
        }
        return { ok: true, error: '', records: records, version: version };
    }

    /**
     * Merge incoming records into an existing library.
     *
     * mode:
     *   'all'          overwrite on collision
     *   'skip_dupes'   keep existing on collision
     *   'core_only'    overwrite the substantive fields but preserve the
     *                  examiner's own notes (v1 called this 'charges_only')
     *
     * Returns { list, added, updated, skipped }.
     */
    function mergeImport(existing, incoming, mode, idSeed) {
        var list = (existing || []).map(function (r) { return normalize(r); }).filter(Boolean);
        var index = {};
        list.forEach(function (r, i) { index[dedupeKey(r)] = i; });

        var added = 0, updated = 0, skipped = 0;
        var seed = idSeed || Date.now();

        (incoming || []).forEach(function (raw) {
            var rec = normalize(raw, { defaultKind: KIND_STATE });
            if (!rec) return;
            var key = dedupeKey(rec);
            var at = index[key];

            if (at === undefined) {
                rec.id = rec.id != null ? rec.id : (seed + added);
                list.push(rec);
                index[key] = list.length - 1;
                added++;
                return;
            }

            if (mode === 'skip_dupes') { skipped++; return; }

            var prev = list[at];
            if (mode === 'core_only') {
                // Preserve the local examiner's notes — those are their own
                // work product, not the sender's.
                rec.notes = prev.notes;
            }
            rec.id = prev.id;
            rec.createdAt = prev.createdAt;
            list[at] = rec;
            updated++;
        });

        return { list: list, added: added, updated: updated, skipped: skipped };
    }

    return {
        STORAGE_KEY: STORAGE_KEY,
        EXPORT_TYPE: EXPORT_TYPE,
        EXPORT_VERSION: EXPORT_VERSION,
        KIND_STATE: KIND_STATE,
        KIND_FEDERAL: KIND_FEDERAL,
        KIND_CASELAW: KIND_CASELAW,
        KINDS: KINDS,
        KIND_META: KIND_META,
        STATE_TYPES: STATE_TYPES,
        FEDERAL_TYPES: FEDERAL_TYPES,
        CATEGORIES: CATEGORIES,
        categoryLabel: categoryLabel,
        typesFor: typesFor,
        isKind: isKind,
        normalize: normalize,
        isChargeable: isChargeable,
        chargeable: chargeable,
        ofKind: ofKind,
        dedupeKey: dedupeKey,
        displayLabel: displayLabel,
        chargeValue: chargeValue,
        matchesSearch: matchesSearch,
        loadAll: loadAll,
        saveAll: saveAll,
        buildExport: buildExport,
        parseImport: parseImport,
        mergeImport: mergeImport
    };
}));

/*
 * CONSUMERS — every place that reads localStorage['viperOffenseReference'].
 * If you add a fourth kind, check all of these:
 *
 *   index.html  ncOffenseLibraryOptionsHtml / ncOffenseRowHtml
 *       Create Case "Primary Offense" picker.        → chargeable() only
 *   case-detail-with-analytics.html  _offenseLibraryOptionsHtml /
 *       _offenseRowHtml / _offenseInLibrary
 *       Case Overview offense editor.                → chargeable() only
 *   modules/warrant-author/warrant-author-ui.js  (~L3619)
 *       Warrant offense-description picker.          → chargeable() only
 *   index.html  Offense Reference page itself.       → all kinds
 */

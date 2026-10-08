/*
 * case-stores.js — the one authoritative list of where a case's data lives.
 *
 * WHY THIS EXISTS
 * ---------------
 * Before this file the same list of storage keys was written out by hand in
 * five places: the .vcase exporter, the .vcase importer, the backup restore,
 * the delete-case cleanup, and case-snapshot.js. They had already drifted:
 *
 *   - `flock_<caseId>` was snapshotted but NEVER exported, so a Flock ALPR
 *     analysis did not survive a .vcase handoff.
 *   - `cellebriteImport`, `datapilot`, `discordWarrant`, `snapchatWarrant`
 *     and `xWarrant` were exported but NOT snapshotted, so they were not
 *     protected by crash recovery.
 *   - `warrantAuthor_<caseId>` (every warrant draft) and
 *     `casePcNarrative_<caseId>` (the case probable cause) were in NO list at
 *     all — not exported, not snapshotted, not cleaned up on delete.
 *   - `viperCaseForensicDevices` exported but was not snapshotted.
 *
 * Every consumer now reads this table instead of carrying its own copy.
 *
 * TWO STORAGE PATTERNS
 * --------------------
 *   pattern 2 — localStorage[`<key>_<case.id>`]        (the modern one)
 *   pattern 1 — localStorage[<key>][case.caseNumber]   (the older shared maps)
 *
 * Six of the pattern-1 stores are LEGACY MIRRORS: nothing has written them
 * for several versions, they are only read once at case load to rescue data
 * from very old installs. They still travel in an export so that old data is
 * not stranded, but they are never merge targets — merging into a store
 * nothing writes would be invisible to the user. They carry `legacy: true`.
 *
 * IDENTITY IS CONTENT, NOT `id`
 * -----------------------------
 * Record `id`s in VIPER are `Date.now()`-based. Two detectives working the
 * same case on two machines WILL mint colliding ids, so an id is useless for
 * deciding "is this the same real-world thing". Every identity function here
 * is built from content the two officers would have typed the same way — a
 * name and a date of birth, a plate, an evidence tag. `id` is used only where
 * a record has no distinguishing content, and stores whose ids are referenced
 * from elsewhere are flagged `reid: true` so the merge re-mints them.
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root) root.CaseStores = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    /* ── normalisation helpers ──────────────────────────────────────────
     * Two officers type the same fact differently. "Smith, John" vs
     * "SMITH, JOHN  ", "817-555-0133" vs "(817) 555-0133". Identity has to
     * see through that or "only add what's new" adds everything twice.
     */
    function _s(v) { return v == null ? '' : String(v); }
    function _n(v) { return _s(v).trim().toLowerCase().replace(/\s+/g, ' '); }
    function _digits(v) { return _s(v).replace(/\D+/g, ''); }
    function _date(v) {
        // Accept ISO, MM/DD/YYYY and Date objects; compare as YYYYMMDD.
        var s = _s(v).trim();
        if (!s) return '';
        var iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (iso) return iso[1] + iso[2] + iso[3];
        var us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (us) return us[3] + ('0' + us[1]).slice(-2) + ('0' + us[2]).slice(-2);
        return _digits(s).slice(0, 8);
    }
    /** Join parts, returning '' if every part is empty — '' means "no stable
     *  identity", and the merge engine falls back to a content hash. */
    function _id() {
        var parts = Array.prototype.slice.call(arguments).map(_s);
        return parts.some(function (p) { return p !== ''; }) ? parts.join('|') : '';
    }

    /* ── identity builders ──────────────────────────────────────────── */
    function person(r) {
        if (!r) return '';
        return _id(_n(r.name), _date(r.dob));
    }
    function byId(r) { return r && r.id != null ? _id('id', _s(r.id)) : ''; }

    /*
     * STORES — the table. Field meanings:
     *
     *   key       localStorage key (pattern 2) or key prefix (pattern 1)
     *   pattern   2 = `<key>_<case.id>`, 1 = localStorage[key][caseNumber]
     *   label     what a human calls it, used in the merge summary
     *   shape     'array'   a plain array of records
     *             'wrapped' an object whose `list` property holds the records
     *             'object'  a single object, not a list
     *   list      for shape 'wrapped', the property holding the array
     *   identity  record -> stable string, or '' for "no stable identity"
     *   merge     'list'    mergeable record by record
     *             'replace' whole-value; kept local unless Overwrite
     *             'skip'    never merged (derived or local-only UI state)
     *   people    this list participates in the person index remap
     *   reid      records carry an `id` other data points at; re-mint on
     *             import so two machines' Date.now() ids cannot collide
     *   files     case-folder subdirectory this store's records reference
     *   legacy    a pattern-1 mirror nothing writes any more
     */
    var STORES = [
        /* ── parties ─────────────────────────────────────────────────── */
        { key: 'suspects', pattern: 2, label: 'Suspects', shape: 'array',
          identity: person, merge: 'list', people: true },
        { key: 'victims', pattern: 2, label: 'Victims', shape: 'array',
          identity: person, merge: 'list', people: true },
        { key: 'witnesses', pattern: 2, label: 'Witnesses', shape: 'array',
          identity: person, merge: 'list', people: true },
        { key: 'involvedPersons', pattern: 2, label: 'Involved Persons', shape: 'array',
          identity: person, merge: 'list', people: true },
        { key: 'missingpersons', pattern: 2, label: 'Missing Persons', shape: 'array',
          identity: person, merge: 'list', people: true },
        { key: 'victimBusinesses', pattern: 2, label: 'Victim Businesses', shape: 'array',
          identity: function (r) { return r ? _id(_n(r.businessName || r.name)) : ''; },
          merge: 'list' },

        /* ── property ────────────────────────────────────────────────── */
        { key: 'recoveredVehicles', pattern: 2, label: 'Recovered Vehicles', shape: 'array',
          identity: function (r) {
              if (!r) return '';
              // A VIN alone is decisive. A plate needs its state — plates
              // repeat across states.
              return _id(_n(r.vin), _n(r.plate || r.licensePlate), _n(r.plateState || r.state));
          }, merge: 'list' },
        { key: 'firearms', pattern: 2, label: 'Firearms', shape: 'array',
          identity: function (r) {
              return r ? _id(_n(r.serialNumber || r.serial), _n(r.make), _n(r.model)) : '';
          }, merge: 'list' },
        { key: 'narcotics', pattern: 2, label: 'Narcotics', shape: 'array',
          identity: function (r) {
              return r ? _id(_n(r.substance || r.type), _n(r.quantity), _n(r.location)) : '';
          }, merge: 'list' },
        { key: 'money', pattern: 2, label: 'Money', shape: 'array',
          identity: function (r) {
              return r ? _id(_n(r.amount), _n(r.location), _date(r.seizedDate || r.date)) : '';
          }, merge: 'list' },
        { key: 'cargo', pattern: 2, label: 'Cargo', shape: 'array',
          identity: function (r) {
              return r ? _id(_n(r.description), _n(r.trackingNumber || r.billOfLading)) : '';
          }, merge: 'list' },

        /* ── field work ──────────────────────────────────────────────── */
        { key: 'areacanvas', pattern: 2, label: 'Area Canvas', shape: 'array',
          identity: function (r) {
              return r ? _id(_n(r.address), _s(r.timestamp || r.occurredAt)) : '';
          }, merge: 'list', files: 'Canvas Media' },
        { key: 'canvasForms', pattern: 2, label: 'Area Canvas Forms', shape: 'array',
          identity: function (r) { return r ? _id(_s(r.formId || r.id)) : ''; },
          merge: 'list' },
        { key: 'fieldwork', pattern: 2, label: 'Field Work', shape: 'array',
          identity: function (r) {
              // Field Work entries are already uniquely stamped at creation,
              // and two officers CAN legitimately log the same address at the
              // same minute, so the entry id is the right identity here.
              return r ? _id(_s(r.id), _n(r.address), _s(r.timestamp)) : '';
          }, merge: 'list', files: 'Field Work Media' },
        { key: 'fieldworkForms', pattern: 2, label: 'Field Work Forms', shape: 'array',
          identity: function (r) { return r ? _id(_s(r.formId || r.id)) : ''; },
          merge: 'list' },

        /* ── investigation ───────────────────────────────────────────── */
        { key: 'timelineEvents', pattern: 2, label: 'Timeline', shape: 'array',
          identity: function (r) {
              return r ? _id(_s(r.date || r.timestamp), _n(r.title || r.description)) : '';
          }, merge: 'list' },
        { key: 'consentSearches', pattern: 2, label: 'Consent Searches', shape: 'array',
          identity: function (r) {
              return r ? _id(_n(r.personName || r.name), _date(r.date), _n(r.location)) : '';
          }, merge: 'list', files: 'Consent Forms' },
        { key: 'cyberTips', pattern: 2, label: 'CyberTips', shape: 'array',
          identity: function (r) { return r ? _id(_s(r.tipNumber || r.reportId || r.id)) : ''; },
          merge: 'list' },
        { key: 'prosecution', pattern: 2, label: 'Prosecution', shape: 'object',
          identity: null, merge: 'replace' },
        { key: 'opsplan', pattern: 2, label: 'Operations Plan', shape: 'object',
          identity: null, merge: 'replace' },

        /* ── warrant author ──────────────────────────────────────────────
         * NOT in any previous list. A .vcase handoff silently dropped every
         * warrant draft, which is the user's own first example of what a
         * supplemental detective contributes.
         */
        { key: 'warrantAuthor', pattern: 2, label: 'Warrant Author Drafts',
          shape: 'wrapped', list: 'drafts',
          identity: function (r) {
              return r ? _id(_n(r.title || r.draftName), _n(r.provider), _s(r.createdAt)) : '';
          }, merge: 'list', reid: true },
        { key: 'casePcNarrative', pattern: 2, label: 'Probable Cause',
          shape: 'object', identity: null, merge: 'replace' },

        /* ── warrant returns ─────────────────────────────────────────────
         * All of these share the `{ imports: [...] }` envelope.
         */
        { key: 'googleWarrant', pattern: 2, label: 'Google Returns', shape: 'wrapped', list: 'imports',
          identity: warrantImport, merge: 'list', reid: true },
        { key: 'metaWarrant', pattern: 2, label: 'Meta Returns', shape: 'wrapped', list: 'imports',
          identity: warrantImport, merge: 'list', reid: true },
        { key: 'kikWarrant', pattern: 2, label: 'Kik Returns', shape: 'wrapped', list: 'imports',
          identity: warrantImport, merge: 'list', reid: true },
        { key: 'snapchatWarrant', pattern: 2, label: 'Snapchat Returns', shape: 'wrapped', list: 'imports',
          identity: warrantImport, merge: 'list', reid: true },
        { key: 'xWarrant', pattern: 2, label: 'X Returns', shape: 'wrapped', list: 'imports',
          identity: warrantImport, merge: 'list', reid: true },
        { key: 'discordWarrant', pattern: 2, label: 'Discord Returns', shape: 'wrapped', list: 'imports',
          identity: warrantImport, merge: 'list', reid: true },

        /* ── forensic imports ────────────────────────────────────────────
         * The parsed payloads for these live on disk, not in localStorage,
         * and do not travel. The importer marks them `orphaned` so the UI
         * shows a re-import banner instead of empty panes.
         */
        { key: 'datapilot', pattern: 2, label: 'DataPilot', shape: 'wrapped', list: 'imports',
          identity: warrantImport, merge: 'list', reid: true, orphanOnTransfer: true },
        { key: 'cellebriteImport', pattern: 2, label: 'Cellebrite', shape: 'wrapped', list: 'imports',
          identity: warrantImport, merge: 'list', reid: true, orphanOnTransfer: true },
        { key: 'flock', pattern: 2, label: 'Flock ALPR', shape: 'wrapped', list: 'imports',
          identity: warrantImport, merge: 'list', reid: true },

        /* ── RMS / external reports ──────────────────────────────────── */
        { key: 'rmsImports', pattern: 2, label: 'RMS Imports', shape: 'array',
          identity: function (r) { return r ? _id(_n(r.fileName), _s(r.importedAt)) : ''; },
          merge: 'list' },
        { key: 'oversightImport', pattern: 2, label: 'Oversight Imports', shape: 'array',
          identity: function (r) { return r ? _id(_n(r.fileName), _s(r.importedAt)) : ''; },
          merge: 'list' },

        /* ── derived / local-only ────────────────────────────────────────
         * These are a view over data that is itself merged, or they are this
         * machine's own working state. Merging them would either duplicate
         * work the real merge already did, or import someone else's UI.
         */
        { key: 'connectionBoard', pattern: 2, label: 'Connection Board', shape: 'object',
          identity: null, merge: 'skip', rebuildAfterMerge: true },
        { key: 'caseMetrics', pattern: 2, label: 'Case Metrics', shape: 'object',
          identity: null, merge: 'replace' },
        { key: 'apertureFlags', pattern: 2, label: 'Aperture Flags', shape: 'object',
          identity: null, merge: 'skip' },
        { key: 'apertureImport', pattern: 2, label: 'Aperture Import', shape: 'object',
          identity: null, merge: 'replace' },
        { key: 'snapchatWarrantFlags', pattern: 2, label: 'Snapchat Flags', shape: 'object',
          identity: null, merge: 'skip' },

        /* ── pattern 1: live shared maps ─────────────────────────────── */
        { key: 'viperCaseNotes', pattern: 1, label: 'Case Notes', shape: 'array',
          identity: function (r) {
              return r ? _id(_s(r.createdAt || r.timestamp), _n(_s(r.text || r.body).slice(0, 120))) : '';
          }, merge: 'list', reid: true },
        { key: 'viperCaseEvidence', pattern: 1, label: 'Evidence', shape: 'array',
          identity: function (r) {
              // The tag IS the on-disk folder name, so it is the one field
              // two officers cannot disagree about for the same item.
              return r ? _id(_n(r.tag), _n(r.description)) : '';
          }, merge: 'list', reid: true, files: 'Evidence' },
        { key: 'viperCaseWarrants', pattern: 1, label: 'Warrants', shape: 'array',
          identity: function (r) {
              return r ? _id(_n(r.provider || r.type), _n(r.warrantNumber || r.number), _date(r.dateSigned)) : '';
          }, merge: 'list', reid: true, files: 'Warrants' },
        { key: 'viperCaseReports', pattern: 1, label: 'Reports', shape: 'array',
          identity: function (r) { return r ? _id(_n(r.title || r.fileName), _s(r.createdAt)) : ''; },
          merge: 'list', reid: true },
        { key: 'viperCaseForensicDevices', pattern: 1, label: 'Forensic Devices', shape: 'array',
          identity: function (r) {
              return r ? _id(_n(r.make), _n(r.model), _n(r.serialNumber || r.imei)) : '';
          }, merge: 'list' },
        { key: 'viperTraceImports', pattern: 1, label: 'Trace Imports', shape: 'array',
          identity: function (r) { return r ? _id(_n(r.fileName), _s(r.importedAt)) : ''; },
          merge: 'list' },
        /* firearms / narcotics / money / prosecution are dual-written: the
         * pattern-2 key is what the tab reads, these are kept in step. The
         * merge writes BOTH or the tab shows stale counts. */
        { key: 'viperCaseFirearms', pattern: 1, label: 'Firearms (shared)', shape: 'array',
          identity: null, merge: 'mirror', mirrorOf: 'firearms' },
        { key: 'viperCaseNarcotics', pattern: 1, label: 'Narcotics (shared)', shape: 'array',
          identity: null, merge: 'mirror', mirrorOf: 'narcotics' },
        { key: 'viperCaseMoney', pattern: 1, label: 'Money (shared)', shape: 'array',
          identity: null, merge: 'mirror', mirrorOf: 'money' },
        { key: 'viperCaseProsecution', pattern: 1, label: 'Prosecution (shared)', shape: 'array',
          identity: null, merge: 'mirror', mirrorOf: 'prosecution' },

        /* ── pattern 1: legacy mirrors ───────────────────────────────────
         * Measured: zero writes anywhere in the codebase, one read each at
         * case load. They still travel so data from an old install is not
         * stranded, but they are never merge targets.
         */
        { key: 'viperCaseSuspects', pattern: 1, label: 'Suspects (legacy)', shape: 'array',
          identity: null, merge: 'skip', legacy: true },
        { key: 'viperCaseVictims', pattern: 1, label: 'Victims (legacy)', shape: 'array',
          identity: null, merge: 'skip', legacy: true },
        { key: 'viperCaseWitnesses', pattern: 1, label: 'Witnesses (legacy)', shape: 'array',
          identity: null, merge: 'skip', legacy: true },
        { key: 'viperCaseVehicles', pattern: 1, label: 'Vehicles (legacy)', shape: 'array',
          identity: null, merge: 'skip', legacy: true },
        { key: 'viperCaseMissingPersons', pattern: 1, label: 'Missing Persons (legacy)', shape: 'array',
          identity: null, merge: 'skip', legacy: true },
        { key: 'viperCaseCanvas', pattern: 1, label: 'Canvas (legacy)', shape: 'array',
          identity: null, merge: 'skip', legacy: true },
        { key: 'viperCaseOPSPlans', pattern: 1, label: 'Ops Plans (legacy)', shape: 'array',
          identity: null, merge: 'skip', legacy: true },

        /* ── pattern 1: transcripts ──────────────────────────────────────
         * Interview transcripts produced by the Whisper engine. Measured:
         * live (written on every transcription) and in NO export or
         * snapshot list — a .vcase handoff dropped every transcript, and a
         * localStorage wipe lost them with no recovery.
         *
         * Shape is a MAP, not a list: { "<evidenceId>:<index>": entry }.
         * The keys point at evidence ids, and evidence is `reid: true`, so
         * a merge has to rewrite these keys alongside the evidence records
         * or the transcripts detach from their audio. `remapWith` names the
         * store whose id remap this one follows.
         */
        { key: 'viperTranscripts', pattern: 1, label: 'Transcripts', shape: 'map',
          identity: null, merge: 'map', remapWith: 'viperCaseEvidence' },

        /* ── pattern 1: host-local, never travels ────────────────────────
         * These are keyed by case number, so a case-number RENAME has to
         * move them, but they are this machine's own state. Sending another
         * officer your nag-timer setting or which evidence pane you had
         * open is noise at best. `transient` keeps them out of the export,
         * the snapshot and the merge while keeping them in the rename.
         */
        { key: 'viperCaseActivityTimers', pattern: 1, label: 'Activity Timer', shape: 'object',
          identity: null, merge: 'skip', transient: true },
        { key: 'viperOpenEvidence', pattern: 1, label: 'Open Evidence (view state)', shape: 'object',
          identity: null, merge: 'skip', transient: true }
    ];

    /** Shared identity for the `{ imports: [...] }` family. Declared as a
     *  function so it is hoisted above the STORES literal that uses it. */
    function warrantImport(r) {
        if (!r) return '';
        return _id(_n(r.fileName || r.sourceName), _s(r.importedAt || r.createdAt), _n(r.account || r.target));
    }

    /* ── lookups ────────────────────────────────────────────────────── */
    var BY_KEY = {};
    STORES.forEach(function (s) { BY_KEY[s.key] = s; });

    function byKey(k) { return BY_KEY[k] || null; }
    function all() { return STORES.slice(); }
    function pattern(n) { return STORES.filter(function (s) { return s.pattern === n; }); }

    /* The key lists below all EXCLUDE transient stores. Transient means
     * "keyed by case, but it is this machine's own state" — it must not be
     * exported to another officer, and snapshotting it is pointless. The
     * rename path wants them anyway; it calls caseNumberKeyed(). */
    function _durable(n) {
        return STORES.filter(function (s) { return s.pattern === n && !s.transient; });
    }

    /** Pattern-2 keys, as the exporter wants them (no trailing underscore). */
    function keys2() { return _durable(2).map(function (s) { return s.key; }); }
    /** Pattern-2 prefixes, as case-snapshot.js and the delete path want them. */
    function prefixes2() { return _durable(2).map(function (s) { return s.key + '_'; }); }
    /** Pattern-1 store names. */
    function keys1() { return _durable(1).map(function (s) { return s.key; }); }

    /** EVERY store keyed by case number, transient included. A rename moves
     *  the whole case; leaving a host-local store behind under the old
     *  number is how orphaned entries get resurrected as duplicate cases. */
    function caseNumberKeyed() { return pattern(1).map(function (s) { return s.key; }); }

    /** Stores a merge may touch, in a stable order for the summary screen. */
    function mergeable() {
        return STORES.filter(function (s) {
            return !s.transient &&
                (s.merge === 'list' || s.merge === 'replace' || s.merge === 'map');
        });
    }

    function identityFor(key, record) {
        var s = BY_KEY[key];
        if (!s || typeof s.identity !== 'function') return '';
        try { return s.identity(record) || ''; } catch (_) { return ''; }
    }

    /** The array inside a store value, whatever its shape. */
    function listOf(store, value) {
        if (!store || value == null) return [];
        if (store.shape === 'array') return Array.isArray(value) ? value : [];
        if (store.shape === 'wrapped') {
            var a = value[store.list];
            return Array.isArray(a) ? a : [];
        }
        return [];
    }

    /** Put `list` back into the store's envelope, preserving sibling fields. */
    function withList(store, value, list) {
        if (!store) return list;
        if (store.shape === 'array') return list;
        if (store.shape === 'wrapped') {
            var out = (value && typeof value === 'object') ? Object.assign({}, value) : {};
            out[store.list] = list;
            return out;
        }
        return value;
    }

    /** Case-folder subdirectories referenced by any store. */
    function fileDirs() {
        var seen = {};
        STORES.forEach(function (s) { if (s.files) seen[s.files] = true; });
        return Object.keys(seen);
    }

    return {
        STORES: STORES,
        all: all,
        byKey: byKey,
        pattern: pattern,
        keys2: keys2,
        prefixes2: prefixes2,
        keys1: keys1,
        caseNumberKeyed: caseNumberKeyed,
        mergeable: mergeable,
        identityFor: identityFor,
        listOf: listOf,
        withList: withList,
        fileDirs: fileDirs,
        // exported for tests and for the merge engine's fallback hashing
        _norm: _n,
        _digits: _digits,
        _date: _date
    };
}));

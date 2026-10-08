/*
 * case-merge.js — folding one detective's supplemental report into another
 * detective's copy of the same case.
 *
 * THE SITUATION THIS EXISTS FOR
 * ----------------------------
 * Four officers work one case. One writes the search warrants, one interviews
 * a witness and writes the narrative, one logs a phone extraction, one runs an
 * area canvass. Three of them export; the primary detective imports all three
 * into the case already sitting in their VIPER. Nothing may be lost, nothing
 * may be silently overwritten, and afterwards it must still be possible to say
 * who produced what.
 *
 * THE THREE MODES, which are the ones the Offense Reference import already
 * uses, because the user already knows how those behave:
 *
 *   MODE_NEW        add only what I do not already have      (the default)
 *   MODE_ALL        add everything, duplicates included
 *   MODE_OVERWRITE  where we both have it, theirs wins       (hazardous)
 *
 * WHY `id` IS NOT IDENTITY
 * ------------------------
 * Record ids in VIPER are minted from Date.now(). Two detectives entering the
 * same suspect on two machines produce two different ids, and two detectives
 * entering different things at the same instant can produce the SAME id. So
 * "is this the same real-world thing" is answered from content the two
 * officers would have typed the same way — a name and a date of birth, a VIN,
 * an evidence tag. Those identity functions live in case-stores.js, which is
 * the single list of where a case's data lives.
 *
 * When a store has no identity function, or the function returns '' for a
 * particular record because the officer left the identifying fields blank, we
 * fall back to a content key: the whole record minus its id, its provenance
 * stamp and its timestamps. Two byte-identical records are the same record.
 * That is a weaker claim than an identity match, and it is recorded as such.
 *
 * THE DRY RUN AND THE WRITE ARE THE SAME COMPUTATION
 * --------------------------------------------------
 * planMerge() produces both the counts shown on the summary screen AND the
 * exact store values that will be written. applyMerge() hands those values
 * back; it does not recompute anything. A summary that was produced by
 * different code from the write is a summary that can be wrong, and the whole
 * point of showing the officer a count before touching their case is that the
 * count is true.
 *
 * WHAT GETS REWRITTEN ON THE WAY IN
 * ---------------------------------
 *   people   notes point at people by a durable uid. If an incoming person
 *            merges into one the host already has, the host's uid wins and
 *            every incoming note pointing at the sender's uid is repointed.
 *   ids      stores flagged `reid` carry ids that other data references. An
 *            incoming id is re-minted ONLY if it collides with one already
 *            present — re-minting unnecessarily is how references go dangling.
 *   files    Phase 2's extractor never overwrites a file; a same-named,
 *            different file lands beside it with a "(2)" suffix. The records
 *            that referenced it are repointed here, or they would point at the
 *            host detective's file instead of the sender's.
 *
 * Pure. No DOM, no localStorage, no Node built-ins — the caller reads and
 * writes, this decides.
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root) root.CaseMerge = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    var MODE_NEW = 'new';
    var MODE_ALL = 'all';
    var MODE_OVERWRITE = 'overwrite';
    var MODES = [MODE_NEW, MODE_ALL, MODE_OVERWRITE];

    /* Why a record matched something already present. Carried through to the
     * summary so "skipped 4" can say WHY those four were skipped. */
    var MATCH_IDENTITY = 'identity';   // the identity function agreed
    var MATCH_CONTENT = 'content';     // byte-for-byte the same record

    /* Fields that say nothing about whether two records describe the same
     * thing. Dropped before content hashing. */
    var VOLATILE = {
        id: 1, _prov: 1, noteUid: 1,
        createdAt: 1, updatedAt: 1, modifiedAt: 1, lastModified: 1,
        savedAt: 1, importedAt: 1, timestamp: 1, _dirty: 1, _localOnly: 1
    };

    /* case-stores.js may not be on the global yet when this factory runs —
     * script order in the renderer is not something this module controls. So
     * it is resolved on every entry point instead of captured once. */
    function registry(explicit) {
        if (explicit) return explicit;
        if (typeof module === 'object' && module && module.exports) {
            try { return require('../_shared/case-stores.js'); } catch (_) { /* fall through */ }
        }
        var g = (typeof globalThis !== 'undefined') ? globalThis : null;
        return (g && g.CaseStores) || null;
    }

    /* ────────────────────────────────────────────────────────────────
       content keys
       ──────────────────────────────────────────────────────────────── */

    /** Deterministic JSON: object keys sorted, so two records built in a
     *  different field order still hash the same. */
    function stableString(v) {
        if (v === null || v === undefined) return 'null';
        var t = typeof v;
        if (t === 'number') return isFinite(v) ? String(v) : 'null';
        if (t === 'boolean') return v ? 'true' : 'false';
        if (t === 'string') return JSON.stringify(v);
        if (Array.isArray(v)) {
            var parts = [];
            for (var i = 0; i < v.length; i++) parts.push(stableString(v[i]));
            return '[' + parts.join(',') + ']';
        }
        if (t !== 'object') return 'null';
        var keys = Object.keys(v).sort();
        var out = [];
        for (var k = 0; k < keys.length; k++) {
            if (VOLATILE[keys[k]]) continue;
            out.push(JSON.stringify(keys[k]) + ':' + stableString(v[keys[k]]));
        }
        return '{' + out.join(',') + '}';
    }

    /** The fallback answer to "is this the same record". Exact, not fuzzy. */
    function contentKey(record) {
        return 'c:' + stableString(record);
    }

    /** The preferred answer, when the store knows how to recognise its own
     *  records and the officer filled in enough to use it. */
    function keyFor(reg, storeKey, record) {
        var ident = '';
        try { ident = reg.identityFor(storeKey, record) || ''; } catch (_) { ident = ''; }
        if (ident) return { key: 'i:' + ident, how: MATCH_IDENTITY };
        return { key: contentKey(record), how: MATCH_CONTENT };
    }

    /* ────────────────────────────────────────────────────────────────
       provenance
       ──────────────────────────────────────────────────────────────── */

    /**
     * The stamp every imported record carries. Deliberately small — it is
     * written once per record into localStorage, and a verbose stamp on ten
     * thousand messages is how a quota gets filled.
     *
     *   by      what to show the officer: "Det. M. Alvarez 4471"
     *   agency  the sending agency, when the sender filled one in
     *   case    the case number on the SENDER's machine, which is not
     *           necessarily the one it just landed in
     *   at      when it was imported here
     *   pkg     which import it arrived in, so one import can be undone
     */
    function makeProv(officer, packageId, when) {
        var o = officer || {};
        var by = String(o.who || o.officerName || '').trim();
        var p = { by: by || 'Unknown officer', at: when || new Date().toISOString() };
        if (o.officerBadge) p.badge = String(o.officerBadge);
        if (o.agencyName) p.agency = String(o.agencyName);
        if (o.caseNumber) p.case = String(o.caseNumber);
        if (packageId) p.pkg = String(packageId);
        return p;
    }

    /** A copy of `record` wearing `prov`. The original is never touched —
     *  the caller may still be showing it on screen. */
    function stamp(record, prov) {
        if (!record || typeof record !== 'object') return record;
        var out = Array.isArray(record) ? record.slice() : Object.assign({}, record);
        /* A record that has already been imported once keeps the stamp it
         * arrived with. Otherwise a case passed A -> B -> C would credit B
         * with everything A wrote. */
        if (!out._prov) out._prov = prov;
        return out;
    }

    function isImported(record) {
        return !!(record && typeof record === 'object' && record._prov);
    }

    /* ────────────────────────────────────────────────────────────────
       file repointing
       ──────────────────────────────────────────────────────────────── */

    function baseName(p) {
        var s = String(p || '').replace(/\\/g, '/');
        var i = s.lastIndexOf('/');
        return i < 0 ? s : s.slice(i + 1);
    }

    /**
     * Turn Phase 2's [{from:'Evidence/TAG/a.jpg', to:'Evidence/TAG/a (2).jpg'}]
     * into a basename lookup. Records address their files by name, not by
     * path — canvas media especially — so the match has to be on the last
     * segment.
     */
    function buildRenameIndex(renamed) {
        var idx = {};
        (renamed || []).forEach(function (r) {
            if (!r || !r.from || !r.to) return;
            var from = baseName(r.from), to = baseName(r.to);
            if (from && to && from !== to) idx[from] = to;
        });
        return idx;
    }

    var FILE_FIELDS = { name: 1, fileName: 1, file: 1, path: 1, filename: 1 };

    /**
     * Rewrite every reference to a file that was renamed on extraction.
     *
     * Only a value that LOOKS like a file name and whose basename is one we
     * actually renamed is touched. A person's `name` is never a file name we
     * just wrote, so it cannot be caught by accident — but the extension test
     * is there so that a record whose `name` happened to equal a renamed file
     * still has to look like a file before anything is rewritten.
     */
    function repointFiles(value, renameIndex, depth) {
        if (!value || typeof value !== 'object') return value;
        if (depth > 8) return value;
        var changed = false, out;
        if (Array.isArray(value)) {
            out = value.slice();
            for (var i = 0; i < out.length; i++) {
                var r = repointFiles(out[i], renameIndex, depth + 1);
                if (r !== out[i]) { out[i] = r; changed = true; }
            }
            return changed ? out : value;
        }
        out = Object.assign({}, value);
        Object.keys(out).forEach(function (k) {
            var v = out[k];
            if (typeof v === 'string') {
                if (!FILE_FIELDS[k]) return;
                var b = baseName(v);
                if (!/\.[A-Za-z0-9]{1,8}$/.test(b)) return;
                var to = renameIndex[b];
                if (!to) return;
                out[k] = v.slice(0, v.length - b.length) + to;
                changed = true;
            } else if (v && typeof v === 'object') {
                var rr = repointFiles(v, renameIndex, depth + 1);
                if (rr !== v) { out[k] = rr; changed = true; }
            }
        });
        return changed ? out : value;
    }

    /* ────────────────────────────────────────────────────────────────
       list merging
       ──────────────────────────────────────────────────────────────── */

    function indexLocal(reg, storeKey, list) {
        var byKey = {};
        for (var i = 0; i < list.length; i++) {
            var k = keyFor(reg, storeKey, list[i]).key;
            /* First one wins. If the host detective already has the same
             * person twice, their first copy is the one we merge into. */
            if (!(k in byKey)) byKey[k] = i;
        }
        return byKey;
    }

    function describe(store, record) {
        if (!record || typeof record !== 'object') return String(record);
        var fields = ['name', 'fullName', 'title', 'tag', 'description', 'address',
            'plate', 'vin', 'serialNumber', 'businessName', 'fileName', 'label'];
        for (var i = 0; i < fields.length; i++) {
            var v = record[fields[i]];
            if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 80);
        }
        var first = (record.firstName || '') + ' ' + (record.lastName || '');
        if (first.trim()) return first.trim().slice(0, 80);
        return (store && store.label) ? ('one ' + store.label.replace(/s$/, '')) : 'one record';
    }

    function mergeList(ctx, store, localList, incomingList) {
        var reg = ctx.reg;
        var mode = ctx.mode;
        var out = localList.slice();
        var byKey = indexLocal(reg, store.key, out);
        var usedIds = {};
        if (store.reid) {
            out.forEach(function (r) { if (r && r.id !== undefined) usedIds[String(r.id)] = 1; });
        }
        var res = { added: 0, updated: 0, skipped: 0, collisions: [] };

        for (var i = 0; i < incomingList.length; i++) {
            var raw = incomingList[i];
            if (raw === null || raw === undefined) continue;

            var rec = ctx.prepare(raw, store);
            var m = keyFor(reg, store.key, rec);
            var at = byKey[m.key];
            var has = (at !== undefined);

            if (has && mode === MODE_NEW) {
                res.skipped++;
                res.collisions.push({ what: describe(store, rec), how: m.how, action: 'kept yours' });
                continue;
            }
            if (has && mode === MODE_OVERWRITE) {
                /* Theirs wins, but the host's durable person uid does not go
                 * anywhere — notes on BOTH sides point at it. */
                var replacement = stamp(rec, ctx.prov);
                var mine = out[at];
                if (store.people && mine && mine.noteUid) replacement.noteUid = mine.noteUid;
                if (store.reid && mine && mine.id !== undefined) replacement.id = mine.id;
                out[at] = replacement;
                res.updated++;
                res.collisions.push({ what: describe(store, rec), how: m.how, action: 'replaced with theirs' });
                continue;
            }

            /* Appending: either nothing matched, or the officer asked for
             * everything including duplicates. */
            var add = stamp(rec, ctx.prov);
            if (store.reid) {
                var id = (add.id === undefined || add.id === null) ? '' : String(add.id);
                if (!id || usedIds[id]) {
                    var fresh = ctx.mintId();
                    ctx.remap.ids[store.key] = ctx.remap.ids[store.key] || {};
                    if (id) ctx.remap.ids[store.key][id] = fresh;
                    add.id = fresh;
                    id = String(fresh);
                }
                usedIds[id] = 1;
            }
            out.push(add);
            if (!(m.key in byKey)) byKey[m.key] = out.length - 1;
            res.added++;
            if (has) {
                res.collisions.push({ what: describe(store, rec), how: m.how, action: 'added anyway' });
            }
        }
        return { list: out, res: res };
    }

    /* ────────────────────────────────────────────────────────────────
       people and their durable uids
       ──────────────────────────────────────────────────────────────── */

    /**
     * Notes do not point at "suspect number 3" — they point at a uid minted
     * once and carried for the life of the record, because after a merge the
     * list order is different on the two machines. Phase 2's export mints one
     * for every person before the package leaves, so by the time we get here
     * both sides have them.
     *
     * When an incoming person merges into one the host already has, the host's
     * uid is the survivor and the sender's uid is recorded as an alias.
     */
    function planPeople(ctx, local, incoming) {
        var reg = ctx.reg;
        var stores = reg.all().filter(function (s) { return s.people && !s.transient; });
        var perStore = [];

        stores.forEach(function (store) {
            var localVal = local[store.key];
            var inVal = incoming[store.key];
            var localList = reg.listOf(store, localVal);
            var inList = reg.listOf(store, inVal);
            if (!inList.length) {
                if (localList.length) perStore.push(emptyRow(store, localList.length));
                return;
            }

            /* Which of theirs lands on which of ours — worked out BEFORE the
             * merge runs, because the merge is what discards the duplicates.
             *
             * Only when the duplicate is actually going to be collapsed. In
             * "add everything, duplicates included" BOTH copies of the person
             * survive, so the sender's notes must stay attached to the
             * sender's copy. Repointing them at the host's copy there would
             * leave their person record sitting in the list with nothing
             * referring to it, and would credit the host's record with
             * observations made about the sender's. */
            if (ctx.mode !== MODE_ALL) {
                var byKey = indexLocal(reg, store.key, localList);
                inList.forEach(function (p) {
                    if (!p || !p.noteUid) return;
                    var k = keyFor(reg, store.key, p).key;
                    var at = byKey[k];
                    if (at === undefined) return;
                    var mine = localList[at];
                    if (mine && mine.noteUid && mine.noteUid !== p.noteUid) {
                        ctx.remap.people[p.noteUid] = mine.noteUid;
                    }
                });
            }

            var m = mergeList(ctx, store, localList, inList);

            /* Two machines minting random uids can collide. Vanishingly
             * unlikely, catastrophic if it happens — a note would attach to
             * the wrong person. So it is checked rather than assumed. */
            var seen = {};
            m.list.forEach(function (p, i) {
                if (!p || !p.noteUid) return;
                var u = String(p.noteUid);
                if (seen[u] !== undefined && i !== seen[u]) {
                    var fresh = ctx.mintUid();
                    ctx.remap.people[u] = fresh;
                    m.list[i] = Object.assign({}, p, { noteUid: fresh });
                } else {
                    seen[u] = i;
                }
            });

            ctx.writes[store.key] = reg.withList(store, localVal, m.list);
            ctx.before[store.key] = localVal;
            perStore.push(row(store, m.res, m.list.length));
        });

        return perStore;
    }

    /** Repoint an incoming note at the people it is actually about. */
    function remapAssignments(record, peopleRemap) {
        if (!record || !Array.isArray(record.assignedTo)) return record;
        var changed = false;
        var next = record.assignedTo.map(function (a) {
            if (!a || !a.uid) return a;
            var to = peopleRemap[a.uid];
            if (!to) return a;
            changed = true;
            return Object.assign({}, a, { uid: to });
        });
        if (!changed) return record;
        return Object.assign({}, record, { assignedTo: next });
    }

    /* ────────────────────────────────────────────────────────────────
       the plan
       ──────────────────────────────────────────────────────────────── */

    function row(store, res, total) {
        return {
            key: store.key, label: store.label,
            added: res.added, updated: res.updated, skipped: res.skipped,
            total: total, collisions: res.collisions
        };
    }
    function emptyRow(store, total) {
        return { key: store.key, label: store.label, added: 0, updated: 0, skipped: 0, total: total, collisions: [] };
    }

    function hasContent(v) {
        if (v === null || v === undefined || v === '') return false;
        if (Array.isArray(v)) return v.length > 0;
        if (typeof v === 'object') return Object.keys(v).length > 0;
        return true;
    }

    /**
     * planMerge(local, incoming, mode, opts)
     *
     *   local     { storeKey: value }  the host's data for this case
     *   incoming  { storeKey: value }  the sender's, out of the package
     *   mode      'new' | 'all' | 'overwrite'
     *   opts      { registry, officer, packageId, now, renamed, mintId, mintUid }
     *
     * Returns a plan carrying both the summary and the exact values to write.
     */
    function planMerge(local, incoming, mode, opts) {
        opts = opts || {};
        var reg = registry(opts.registry);
        if (!reg) throw new Error('case-merge: case-stores.js is not loaded');
        if (MODES.indexOf(mode) < 0) throw new Error('case-merge: unknown mode "' + mode + '"');

        local = local || {};
        incoming = incoming || {};

        var now = opts.now || new Date().toISOString();
        var packageId = opts.packageId || ('imp' + Date.now().toString(36));
        var prov = makeProv(opts.officer, packageId, now);
        var renameIndex = buildRenameIndex(opts.renamed);

        var seq = 0;
        var mintId = opts.mintId || function () { return Date.now() + (++seq); };
        var uidSeq = 0;
        var mintUid = opts.mintUid || function () {
            return 'p' + Date.now().toString(36) + (++uidSeq) + Math.random().toString(36).slice(2, 6);
        };

        var ctx = {
            reg: reg, mode: mode, prov: prov,
            writes: {}, before: {},
            remap: { people: {}, ids: {}, files: renameIndex },
            mintId: mintId, mintUid: mintUid,
            prepare: null
        };

        /* Pass A — people first, because the uid map it produces is what
         * every note in pass B is rewritten through. */
        ctx.prepare = function (rec) { return repointFiles(rec, renameIndex, 0); };
        var perStore = planPeople(ctx, local, incoming);

        /* Pass B — everything else. */
        ctx.prepare = function (rec) {
            var r = repointFiles(rec, renameIndex, 0);
            return remapAssignments(r, ctx.remap.people);
        };

        var mirrors = [];
        var deferred = [];
        reg.all().forEach(function (store) {
            if (store.people) return;                 // done in pass A
            if (store.transient) return;              // this machine's own state
            if (store.merge === 'skip') return;
            if (store.merge === 'mirror') { mirrors.push(store); return; }
            /* A store whose KEYS are ids belonging to another store cannot be
             * processed until that store has been merged and we know which
             * ids were re-minted. Transcripts are filed under evidence id. */
            if (store.remapWith) { deferred.push(store); return; }
            mergeOne(store);
        });
        deferred.forEach(mergeOne);

        function mergeOne(store) {
            var localVal = local[store.key];
            var inVal = incoming[store.key];

            if (store.merge === 'list') {
                var localList = reg.listOf(store, localVal);
                var inList = reg.listOf(store, inVal);
                if (!inList.length) {
                    if (localList.length) perStore.push(emptyRow(store, localList.length));
                    return;
                }
                var m = mergeList(ctx, store, localList, inList);
                ctx.writes[store.key] = reg.withList(store, localVal, m.list);
                ctx.before[store.key] = localVal;
                perStore.push(row(store, m.res, m.list.length));
                return;
            }

            if (store.merge === 'replace') {
                /* One object for the whole case — a prosecution record, an ops
                 * plan, the case probable cause. There is no sensible way to
                 * interleave two of them, so the host's own work is kept
                 * unless it is empty or they explicitly asked to be overruled. */
                if (!hasContent(inVal)) return;
                var takeTheirs = !hasContent(localVal) || mode === MODE_OVERWRITE;
                if (!takeTheirs) {
                    perStore.push({
                        key: store.key, label: store.label, added: 0, updated: 0, skipped: 1,
                        total: 1, whole: true,
                        collisions: [{ what: store.label, how: MATCH_IDENTITY, action: 'kept yours' }]
                    });
                    return;
                }
                ctx.writes[store.key] = stamp(ctx.prepare(inVal, store), prov);
                ctx.before[store.key] = localVal;
                perStore.push({
                    key: store.key, label: store.label,
                    added: hasContent(localVal) ? 0 : 1,
                    updated: hasContent(localVal) ? 1 : 0,
                    skipped: 0, total: 1, whole: true,
                    collisions: hasContent(localVal)
                        ? [{ what: store.label, how: MATCH_IDENTITY, action: 'replaced with theirs' }]
                        : []
                });
                return;
            }

            if (store.merge === 'map') {
                if (!inVal || typeof inVal !== 'object') return;
                var idRemap = (store.remapWith && ctx.remap.ids[store.remapWith]) || {};
                var base = (localVal && typeof localVal === 'object') ? Object.assign({}, localVal) : {};
                var r2 = { added: 0, updated: 0, skipped: 0, collisions: [] };
                Object.keys(inVal).forEach(function (k) {
                    /* The key is an evidence id on the SENDER's machine. If
                     * that id collided with one here it was re-minted, and
                     * filing the transcript under the old number would attach
                     * it to the host detective's unrelated exhibit. */
                    var target = Object.prototype.hasOwnProperty.call(idRemap, k) ? String(idRemap[k]) : k;
                    var mineHas = Object.prototype.hasOwnProperty.call(base, target);
                    if (mineHas && mode !== MODE_OVERWRITE) {
                        /* MODE_ALL cannot duplicate a key, so "add everything"
                         * behaves as "add what I do not have" here. Saying so
                         * in the summary is better than a silent difference. */
                        r2.skipped++;
                        r2.collisions.push({ what: target, how: MATCH_IDENTITY, action: 'kept yours' });
                        return;
                    }
                    base[target] = stamp(ctx.prepare(inVal[k], store), prov);
                    if (mineHas) {
                        r2.updated++;
                        r2.collisions.push({ what: target, how: MATCH_IDENTITY, action: 'replaced with theirs' });
                    } else {
                        r2.added++;
                    }
                });
                if (r2.added || r2.updated) {
                    ctx.writes[store.key] = base;
                    ctx.before[store.key] = localVal;
                }
                perStore.push(row(store, r2, Object.keys(base).length));
            }
        }

        /* Pass C — the dual-written mirrors. These are not merged on their own
         * account; they are a second copy of a pattern-2 store that the
         * dashboard reads by case number. Merging them independently would let
         * the two copies disagree, and the tab would show a count that does
         * not match what is in it. */
        mirrors.forEach(function (store) {
            var src = reg.byKey(store.mirrorOf);
            if (!src) return;
            var merged = Object.prototype.hasOwnProperty.call(ctx.writes, src.key)
                ? ctx.writes[src.key]
                : local[src.key];
            if (merged === undefined) return;
            if (!Object.prototype.hasOwnProperty.call(ctx.writes, src.key)) return; // nothing changed
            ctx.before[store.key] = local[store.key];
            ctx.writes[store.key] = merged;
            perStore.push({
                key: store.key, label: store.label, added: 0, updated: 0, skipped: 0,
                total: reg.listOf(src, merged).length, mirrored: src.key, collisions: []
            });
        });

        var totals = { added: 0, updated: 0, skipped: 0, stores: 0 };
        perStore.forEach(function (p) {
            totals.added += p.added; totals.updated += p.updated; totals.skipped += p.skipped;
            if (p.added || p.updated) totals.stores++;
        });

        return {
            mode: mode,
            prov: prov,
            packageId: packageId,
            perStore: perStore,
            /* Only the rows that will actually change something — the summary
             * screen should not make the officer read 40 lines of zeroes. */
            changed: perStore.filter(function (p) { return p.added || p.updated; }),
            remap: ctx.remap,
            totals: totals,
            before: ctx.before,
            _writes: ctx.writes
        };
    }

    /**
     * The values to write, exactly as planMerge computed them for the summary.
     * The caller does the writing, through the save-honesty path, because a
     * quota failure has to be reported rather than swallowed.
     */
    function applyMerge(plan) {
        if (!plan || !plan._writes) throw new Error('case-merge: not a plan');
        return Object.assign({}, plan._writes);
    }

    /** What to restore to put the case back exactly as it was. `undefined`
     *  for a store means it had no value and the key should be removed. */
    function undoOf(plan) {
        if (!plan || !plan.before) throw new Error('case-merge: not a plan');
        return Object.assign({}, plan.before);
    }

    return {
        MODE_NEW: MODE_NEW,
        MODE_ALL: MODE_ALL,
        MODE_OVERWRITE: MODE_OVERWRITE,
        MODES: MODES,
        MATCH_IDENTITY: MATCH_IDENTITY,
        MATCH_CONTENT: MATCH_CONTENT,
        VOLATILE: VOLATILE,
        planMerge: planMerge,
        applyMerge: applyMerge,
        undoOf: undoOf,
        makeProv: makeProv,
        stamp: stamp,
        isImported: isImported,
        contentKey: contentKey,
        stableString: stableString,
        buildRenameIndex: buildRenameIndex,
        repointFiles: function (v, idx) { return repointFiles(v, idx, 0); },
        remapAssignments: remapAssignments,
        describe: describe
    };
}));
